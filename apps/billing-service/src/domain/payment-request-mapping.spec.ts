import { describe, expect, it } from 'vitest';
import { PAYMENT_MAPPING_VERSION, PaymentMappingError, buildPaymentRequestBody, type InvoiceForMapping, type RequestForMapping } from './payment-request-mapping.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const invoice: InvoiceForMapping = { id: '11111111-1111-4111-8111-111111111111', number: '7', payerType: 'user', payerId: 'user-1', sellerType: 'organization', sellerId: ORG, organizationId: ORG, currency: 'TND', description: null };
const request: RequestForMapping = { id: '22222222-2222-4222-8222-222222222222', amount: 4500n, expiresAt: null };

describe('invoice -> Payment request mapping (pure, pinned by mappingVersion)', () => {
  it('builds the body from immutable facts: source is the invoice, reference is its number, amount is a JSON integer', () => {
    expect(buildPaymentRequestBody(invoice, request)).toEqual({
      paymentRequestId: request.id, sourceType: 'invoice', sourceId: invoice.id, payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: ORG },
      organizationId: ORG, amount: 4500, currency: 'TND', reference: '7',
    });
  });

  it('is deterministic: two builds are byte-identical, so a retry after a crash replays at Payment', () => {
    expect(JSON.stringify(buildPaymentRequestBody(invoice, request))).toBe(JSON.stringify(buildPaymentRequestBody({ ...invoice }, { ...request })));
  });

  it('omits optional fields when absent and includes them when present', () => {
    const b = buildPaymentRequestBody({ ...invoice, sellerType: 'company', sellerId: 'acme', organizationId: null, description: 'Fee' }, { ...request, expiresAt: new Date('2030-01-01T00:00:00Z') });
    expect(b).not.toHaveProperty('organizationId');
    expect(b).toMatchObject({ description: 'Fee', expiresAt: '2030-01-01T00:00:00.000Z' });
    expect(buildPaymentRequestBody(invoice, request)).not.toHaveProperty('expiresAt');
  });

  it.each<[string, Partial<InvoiceForMapping>]>([
    ['an unissued invoice', { number: null }],
    ['a number over 64 characters', { number: '1'.repeat(65) }],
    ['a description over 140', { description: 'x'.repeat(141) }],
    ['an unknown payer type', { payerType: 'robot' }],
    ['an empty seller id', { sellerType: 'company', sellerId: '', organizationId: null }],
    ['payer equal to seller', { payerType: 'organization', payerId: ORG }],
    ['an organization seller with a non-uuid id', { sellerId: 'acme', organizationId: 'acme' }],
    ['an upper-case uuid seller', { sellerId: ORG.toUpperCase(), organizationId: ORG.toUpperCase() }],
    ['an organization seller naming another organization', { organizationId: '00000000-0000-4000-8000-0000000000b2' }],
    ['a bad currency', { currency: 'tnd' }],
  ])('refuses %s', (_n, over) => {
    expect(() => buildPaymentRequestBody({ ...invoice, ...over }, request)).toThrow(PaymentMappingError);
  });

  it('refuses an amount outside 1..2^53-1 and an unknown mapping version', () => {
    expect(() => buildPaymentRequestBody(invoice, { ...request, amount: 0n })).toThrow(PaymentMappingError);
    expect(() => buildPaymentRequestBody(invoice, { ...request, amount: 9007199254740992n })).toThrow(PaymentMappingError);
    expect(() => buildPaymentRequestBody(invoice, request, PAYMENT_MAPPING_VERSION + 1)).toThrow(PaymentMappingError);
  });
});

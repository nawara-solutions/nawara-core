import { describe, expect, it } from 'vitest';
import { normaliseCreateInvoiceInput } from './invoice-input.js';

const ORG = '00000000-0000-4000-8000-0000000000A1';
const PRICE = '5a1c2d3e-0000-4000-8000-000000000001';
const valid = () => ({
  invoiceRequestId: '9F2C0000-0000-4000-8000-000000000001', seller: { type: 'organization', id: ORG }, payer: { type: 'user', id: 'user-1' },
  sourceType: 'contract', sourceId: 'c-1', issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId: PRICE, quantity: 2 }],
});
const bad = (over: Record<string, unknown>) => expect(() => normaliseCreateInvoiceInput({ ...valid(), ...over })).toThrow(expect.objectContaining({ status: 400, response: expect.objectContaining({ code: 'invalid_invoice_request' }) }));

describe('create-invoice input: strict, normalised, no client money (SDD endpoint 7)', () => {
  it('normalises identifiers to canonical lower case and derives the organization from an organization seller', () => {
    const n = normaliseCreateInvoiceInput(valid());
    expect(n.invoiceRequestId).toBe('9f2c0000-0000-4000-8000-000000000001');
    expect(n.seller.id).toBe(ORG.toLowerCase());
    expect(n.organizationId).toBe(ORG.toLowerCase());
    expect(n.lines[0]).toEqual({ priceId: PRICE, quantity: 2, description: null, sourceType: null, sourceId: null });
    expect(n.dueAt).toBeNull();
  });

  it.each(['amount', 'total', 'subtotal', 'taxTotal', 'currency', 'status', 'number', 'id', 'producer', 'presentation', 'requestHash', 'issuedAt', '__proto__x'])('mass assignment: an unknown top-level field %s is a 400', (field) => {
    bad({ [field]: 1 });
  });

  it.each(['unitAmount', 'lineTotal', 'amount', 'currency', 'taxAmount', 'productCode'])('mass assignment: an unknown LINE field %s is a 400', (field) => {
    bad({ lines: [{ priceId: PRICE, quantity: 1, [field]: 1 }] });
  });

  it.each<[string, Record<string, unknown>]>([
    ['a non-uuid invoiceRequestId', { invoiceRequestId: 'nope' }],
    ['payer equal to seller', { seller: { type: 'user', id: 'a' }, payer: { type: 'user', id: 'a' } }],
    ['an unknown party type', { payer: { type: 'robot', id: 'x' } }],
    ['an empty party id', { payer: { type: 'user', id: '' } }],
    ['a 129-char party id', { payer: { type: 'user', id: 'x'.repeat(129) } }],
    ['an extra party field', { payer: { type: 'user', id: 'x', name: 'y' } }],
    ['an organization seller that is not a uuid', { seller: { type: 'organization', id: 'acme' } }],
    ['an organizationId that differs from the organization seller', { organizationId: '00000000-0000-4000-8000-0000000000b2' }],
    ['a bad sourceType', { sourceType: 'Contract!' }],
    ['an empty sourceId', { sourceId: '' }],
    ['a description over 140', { description: 'x'.repeat(141) }],
    ['a blank description', { description: '  ' }],
    ['a due date without an offset', { dueAt: '2030-01-01T00:00:00' }],
    ['a due date that is not a date', { dueAt: 'tomorrow' }],
    ['a numeric due date', { dueAt: 1893456000000 }],
    ['a snapshot without schemaVersion', { issuerSnapshot: { name: 'x' } }],
    ['a snapshot with a numeric leaf', { billToSnapshot: { schemaVersion: 1, total: 5 } }],
    ['no lines', { lines: [] }],
    ['101 lines', { lines: Array.from({ length: 101 }, () => ({ priceId: PRICE, quantity: 1 })) }],
    ['a fractional quantity', { lines: [{ priceId: PRICE, quantity: 1.5 }] }],
    ['a zero quantity', { lines: [{ priceId: PRICE, quantity: 0 }] }],
    ['a string quantity', { lines: [{ priceId: PRICE, quantity: '2' }] }],
    ['a huge quantity', { lines: [{ priceId: PRICE, quantity: 2 ** 31 }] }],
    ['a non-uuid priceId', { lines: [{ priceId: 'p', quantity: 1 }] }],
    ['a line source type without an id', { lines: [{ priceId: PRICE, quantity: 1, sourceType: 'x_y' }] }],
    ['lines that are not an array', { lines: { priceId: PRICE } }],
  ])('refuses %s', (_n, over) => bad(over));

  it('refuses a body that is not an object', () => {
    for (const v of [null, 'x', 1, []]) expect(() => normaliseCreateInvoiceInput(v)).toThrow();
  });

  it('accepts an explicit due date with an offset as an instant, and optional descriptions and line sources', () => {
    const n = normaliseCreateInvoiceInput({ ...valid(), description: 'Fee', dueAt: '2030-01-01T02:00:00+01:00', lines: [{ priceId: PRICE, quantity: 1, description: 'One', sourceType: 'order_item', sourceId: 'oi-1' }] });
    expect(n.dueAt?.toISOString()).toBe('2030-01-01T01:00:00.000Z');
    expect(n.description).toBe('Fee');
    expect(n.lines[0]).toMatchObject({ description: 'One', sourceType: 'order_item', sourceId: 'oi-1' });
  });
});

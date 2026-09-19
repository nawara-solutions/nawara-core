import { describe, expect, it } from 'vitest';
import { decidePaymentEvent, type InvoiceFacts, type PaymentEventFacts, type RequestFacts } from './payment-event-decision.js';

const PAYMENT_ID = '33333333-3333-4333-8333-333333333333';
const invoice: InvoiceFacts = { id: 'inv-1', status: 'open', payerType: 'user', payerId: 'user-1', sellerType: 'organization', sellerId: 'org-1', organizationId: 'org-1', currency: 'TND', total: 4500n };
const request: RequestFacts = { id: 'req-1', status: 'requested', paymentId: PAYMENT_ID, amount: 4500n, currency: 'TND' };
const event: PaymentEventFacts = {
  name: 'payment.succeeded', source: 'payment-service', paymentId: PAYMENT_ID, producer: 'billing-service', paymentRequestId: 'req-1', sourceType: 'invoice', sourceId: 'inv-1',
  payer: { type: 'user', id: 'user-1' }, seller: { type: 'organization', id: 'org-1' }, organizationId: 'org-1', amount: 4500, currency: 'TND', revision: 2,
};

describe('payment event decision (SDD 21.4): a pure function', () => {
  it('success on a requested request of an open invoice settles both', () => {
    expect(decidePaymentEvent(event, request, invoice)).toEqual({ outcome: 'applied', requestTo: 'paid', invoiceTo: 'paid' });
  });

  it.each([['payment.failed', 'failed'], ['payment.expired', 'expired'], ['payment.cancelled', 'cancelled']] as const)('%s closes only the request and leaves the invoice alone', (name, to) => {
    expect(decidePaymentEvent({ ...event, name }, request, invoice)).toEqual({ outcome: 'applied', requestTo: to, invoiceTo: null });
  });

  it('an unknown request is ignored (never an alert); a request with no invoice is a conflict', () => {
    expect(decidePaymentEvent(event, null, null)).toEqual({ outcome: 'ignored', detail: 'unknown_payment_request' });
    expect(decidePaymentEvent(event, request, null)).toEqual({ outcome: 'conflict', detail: 'invoice_missing' });
  });

  it('a request with no paymentId defers, whatever the event claims: the id is never bound from an event', () => {
    expect(decidePaymentEvent(event, { ...request, status: 'sending', paymentId: null }, invoice)).toEqual({ outcome: 'deferred', detail: 'payment_id_not_recorded' });
    expect(decidePaymentEvent({ ...event, source: 'evil' }, { ...request, paymentId: null }, invoice)).toEqual({ outcome: 'deferred', detail: 'payment_id_not_recorded' });
    expect(decidePaymentEvent({ ...event, producer: 'evil' }, { ...request, paymentId: null }, invoice)).toEqual({ outcome: 'deferred', detail: 'payment_id_not_recorded' });
  });

  it.each<[string, Partial<PaymentEventFacts>, string]>([
    ['another source', { source: 'other-service' }, 'wrong_source'],
    ['another producer (Stage 4: checked before paymentId, as cheap additional evidence)', { producer: 'other-producer' }, 'producer_mismatch'],
    ['another paymentId', { paymentId: '44444444-4444-4444-8444-444444444444' }, 'payment_id_mismatch'],
    ['a string amount', { amount: '4500' }, 'invalid_amount'],
    ['a fractional amount', { amount: 4500.5 }, 'invalid_amount'],
    ['a zero amount', { amount: 0 }, 'invalid_amount'],
    ['a different amount', { amount: 4501 }, 'amount_mismatch'],
    ['a different currency', { currency: 'EUR' }, 'amount_mismatch'],
    ['another source type', { sourceType: 'order' }, 'snapshot_mismatch'],
    ['another source id', { sourceId: 'inv-2' }, 'snapshot_mismatch'],
    ['another payer', { payer: { type: 'user', id: 'user-2' } }, 'snapshot_mismatch'],
    ['another seller', { seller: { type: 'organization', id: 'org-2' } }, 'snapshot_mismatch'],
    ['another organization', { organizationId: 'org-2' }, 'snapshot_mismatch'],
  ])('%s is a conflict', (_n, over, detail) => {
    expect(decidePaymentEvent({ ...event, ...over } as PaymentEventFacts, request, invoice)).toEqual({ outcome: 'conflict', detail });
  });

  it('a redelivery or a reconciler that got there first is ignored as already applied', () => {
    expect(decidePaymentEvent(event, { ...request, status: 'paid' }, { ...invoice, status: 'paid' })).toEqual({ outcome: 'ignored', detail: 'already_applied' });
  });

  it('an outcome that contradicts a terminal request (fail after success, success after fail) is a conflict, never a transition', () => {
    expect(decidePaymentEvent({ ...event, name: 'payment.failed' }, { ...request, status: 'paid' }, invoice)).toEqual({ outcome: 'conflict', detail: 'request_already_terminal' });
    expect(decidePaymentEvent(event, { ...request, status: 'failed' }, invoice)).toEqual({ outcome: 'conflict', detail: 'request_already_terminal' });
    expect(decidePaymentEvent(event, { ...request, status: 'cancelled' }, invoice)).toEqual({ outcome: 'conflict', detail: 'request_already_terminal' });
  });

  it('success for an invoice that is not open is a conflict, whatever its state', () => {
    for (const status of ['draft', 'paid', 'void'] as const) expect(decidePaymentEvent(event, request, { ...invoice, status })).toEqual({ outcome: 'conflict', detail: 'invoice_not_open' });
  });

  it('never reads the clock or anything else: the same facts give the same decision', () => {
    expect(decidePaymentEvent(event, request, invoice)).toEqual(decidePaymentEvent(event, request, invoice));
  });
});

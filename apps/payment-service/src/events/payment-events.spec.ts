import { describe, expect, it } from 'vitest';
import type { PaymentRow } from '../payments/payment.types.js';
import { jobContext, paymentEvent, requestContext, webhookContext } from './payment-events.js';

const row: PaymentRow = {
  id: '11111111-1111-4111-8111-111111111111',
  producer: 'billing-service',
  paymentRequestId: '22222222-2222-4222-8222-222222222222',
  sourceType: 'invoice',
  sourceId: 'inv-1',
  payerType: 'user',
  payerId: 'user-1',
  sellerType: 'organization',
  sellerId: '33333333-3333-4333-8333-333333333333',
  organizationId: '33333333-3333-4333-8333-333333333333',
  amount: '9007199254740991',
  currency: 'TND',
  description: 'a statement line that must never travel in an event',
  reference: 'INV-1',
  expiresAt: null,
  status: 'succeeded',
  statusReason: null,
  settledMethod: 'gateway',
  succeededAttemptId: '44444444-4444-4444-8444-444444444444',
  revision: 2,
  createdAt: new Date(),
  updatedAt: new Date(),
  closedAt: new Date(),
};

describe('paymentEvent (SDD section 11)', () => {
  const ev = paymentEvent('payment.succeeded', row, webhookContext('test', 'evt-row-1'), { settledMethod: 'gateway' });

  it('carries the full common payload with opaque ids, the status and the revision the event announces', () => {
    expect(ev.name).toBe('payment.succeeded');
    expect(ev.payload).toMatchObject({
      paymentId: row.id,
      producer: 'billing-service',
      paymentRequestId: row.paymentRequestId,
      sourceType: 'invoice',
      sourceId: 'inv-1',
      organizationId: row.organizationId,
      payer: { type: 'user', id: 'user-1' },
      seller: { type: 'organization', id: row.sellerId },
      currency: 'TND',
      status: 'succeeded',
      revision: 2,
      settledMethod: 'gateway',
      actor: { type: 'provider', id: 'test' },
      cause: { type: 'webhook_event', id: 'evt-row-1' },
    });
  });

  it('carries the amount as a JSON integer, exactly, at the largest safe value (FI-15: no float arithmetic)', () => {
    expect(ev.payload.amount).toBe(9007199254740991);
    expect(Number.isSafeInteger(ev.payload.amount)).toBe(true);
  });

  it('never carries descriptive fields, provider data, secrets or the raw webhook body', () => {
    const json = JSON.stringify(ev.payload);
    for (const forbidden of ['description', 'reference', 'providerData', 'rawBody', 'secret', 'token', 'signature', 'statement line']) {
      expect(json).not.toContain(forbidden);
    }
  });

  it('every payment lifecycle event carries producer, sourced only from PaymentRow.producer, never from ctx or extra', () => {
    for (const name of ['payment.created', 'payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired'] as const) {
      const e = paymentEvent(name, row, requestContext({ type: 'user', id: 'u' }), { producer: 'someone-else' }); // extra cannot override it
      expect(e.payload.producer).toBe('billing-service');
    }
    const otherRow: PaymentRow = { ...row, producer: 'other-producer' };
    expect(paymentEvent('payment.succeeded', otherRow, requestContext({ type: 'user', id: 'u' })).payload.producer).toBe('other-producer');
  });

  it('derives its id from (payment, event name) only, so a retried transition cannot enqueue a second event', () => {
    expect(paymentEvent('payment.succeeded', row, requestContext({ type: 'user', id: 'u' })).id).toBe(ev.id);
    expect(paymentEvent('payment.failed', row, requestContext({ type: 'user', id: 'u' })).id).not.toBe(ev.id);
  });

  it('system-initiated work always has a correlation id: the webhook event id, or a fresh id per job run', () => {
    expect(ev.correlationId).toBe('evt-row-1');
    const a = jobContext('expiry_sweep');
    const b = jobContext('expiry_sweep');
    expect(a.correlationId).toBeTruthy();
    expect(a.correlationId).not.toBe(b.correlationId);
    expect(a.cause.id).toBe(a.correlationId);
    expect(a.actor).toEqual({ type: 'system', id: null });
  });
});

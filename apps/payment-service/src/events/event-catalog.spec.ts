import { describe, expect, it } from 'vitest';
import type { PaymentRow } from '../payments/payment.types.js';
import { PRODUCED_EVENTS, renderEventContract, type EventField, type PaymentEventName } from './event-catalog.js';
import { jobContext, paymentEvent, requestContext, webhookContext } from './payment-events.js';

/** What a payload value must look like for its catalog field (V2 A3M.2). Returns the problems, empty when it conforms. */
function conformance(payload: Record<string, unknown>, declared: Readonly<Record<string, EventField>>): string[] {
  const problems: string[] = [];
  for (const k of Object.keys(payload)) if (!(k in declared)) problems.push(`${k}: not in the catalog`);
  for (const [k, f] of Object.entries(declared)) {
    if (!(k in payload) || payload[k] === undefined) {
      if (!f.optional) problems.push(`${k}: missing`);
      continue;
    }
    const v = payload[k];
    if (v === null) {
      if (!f.nullable) problems.push(`${k}: null but not nullable`);
      continue;
    }
    const ok = {
      id: () => typeof v === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(v),
      uuid: () => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
      string: () => typeof v === 'string',
      datetime: () => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && v.endsWith('Z'),
      integer: () => Number.isSafeInteger(v),
      object: () => typeof v === 'object' && !Array.isArray(v),
      array: () => Array.isArray(v),
      enum: () => typeof v === 'string' && (f.values ?? []).includes(v),
    }[f.type]();
    if (!ok) problems.push(`${k}: not a ${f.type}`);
  }
  return problems;
}

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
  organizationId: null,
  amount: '1500',
  currency: 'TND',
  description: null,
  reference: null,
  expiresAt: new Date('2026-01-02T00:00:00Z'),
  status: 'succeeded',
  statusReason: null,
  settledMethod: 'gateway',
  succeededAttemptId: null,
  revision: 3,
  createdAt: new Date(),
  updatedAt: new Date(),
  closedAt: new Date('2026-01-01T12:00:00Z'),
};

describe('payment-service event catalog (V2 A3M.2)', () => {
  it('contracts/events.json is exactly this catalog (regenerate with `vitest -u` after a deliberate contract change)', async () => {
    await expect(renderEventContract()).toMatchFileSnapshot('../../contracts/events.json');
  });

  it('every event the builder produces matches its catalog entry, with the extras each call site passes', () => {
    // The extras exactly as the call sites pass them: attempt.service (succeeded, failed), expiry-sweeper (expired).
    const extras: Record<PaymentEventName, Array<Record<string, unknown>>> = {
      'payment.created': [{}],
      'payment.succeeded': [{ settledMethod: 'gateway', succeededAt: row.closedAt?.toISOString() }, { settledMethod: 'gateway', succeededAt: undefined }],
      'payment.failed': [{ failureCode: 'card_declined' }, { failureCode: null }],
      'payment.cancelled': [{}],
      'payment.expired': [{ expiresAt: row.expiresAt?.toISOString() }],
    };
    const contexts = [requestContext({ type: 'user', id: 'u-1' }), jobContext('expiry_sweep'), webhookContext('test', 'evt-1')];
    for (const name of Object.keys(PRODUCED_EVENTS) as PaymentEventName[]) {
      for (const extra of extras[name]) {
        for (const ctx of contexts) {
          const ev = paymentEvent(name, { ...row, organizationId: ctx === contexts[0] ? '33333333-3333-4333-8333-333333333333' : null }, ctx, extra);
          expect(ev.name).toBe(name);
          expect(conformance(JSON.parse(JSON.stringify(ev.payload)) as Record<string, unknown>, PRODUCED_EVENTS[name].payload), name).toEqual([]);
        }
      }
    }
  });

  it('the conformance check itself refuses a missing field, an undeclared field and a wrong type', () => {
    const ev = paymentEvent('payment.cancelled', row, requestContext({ type: 'user', id: 'u-1' }));
    const payload = JSON.parse(JSON.stringify(ev.payload)) as Record<string, unknown>;
    const fields = PRODUCED_EVENTS['payment.cancelled'].payload;
    expect(conformance({ ...payload, paymentId: undefined }, fields)).toEqual(['paymentId: missing']);
    expect(conformance({ ...payload, extra: 1 }, fields)).toEqual(['extra: not in the catalog']);
    expect(conformance({ ...payload, amount: '1500' }, fields)).toEqual(['amount: not a integer']);
  });

  it('every event is version 1 and the outbox writes it as such (no version passed: the outbox default)', () => {
    for (const e of Object.values(PRODUCED_EVENTS)) expect(e.version).toBe(1);
    expect(paymentEvent('payment.created', row, requestContext({ type: 'user', id: 'u-1' })).version).toBeUndefined();
  });
});

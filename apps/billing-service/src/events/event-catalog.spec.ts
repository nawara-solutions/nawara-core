import { describe, expect, it } from 'vitest';
import type { PaymentEventName } from '../domain/payment-event-decision.js';
import { invoiceCreatedEvent } from '../invoices/billing-events.js';
import type { InvoiceRecord } from '../invoices/invoice.types.js';
import { CONSUMED_EVENTS, PRODUCED_EVENTS, renderEventContract, type EventField } from './event-catalog.js';

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

const at = new Date('2026-01-01T00:00:00Z');
const invoice = (over: Partial<InvoiceRecord> = {}): InvoiceRecord => ({
  id: '11111111-1111-4111-8111-111111111111', producer: 'billing-service', invoiceRequestId: 'req-1', requestHash: 'h',
  sellerType: 'organization', sellerId: 'org-1', payerType: 'user', payerId: 'user-1', organizationId: '22222222-2222-4222-8222-222222222222',
  sourceType: 'order', sourceId: 'ord-1', currency: 'TND', subtotal: '1000', taxTotal: '190', total: '1190', taxTreatment: 'exclusive',
  description: 'never in an event', dueAt: at, number: 'INV-0001', status: 'open', revision: 1, createdAt: at, issuedAt: at, paidAt: null,
  voidedAt: null, overdueAt: null, updatedAt: at, voidReasonCode: null, issuerSnapshot: {}, billToSnapshot: {}, presentation: null, isOverdue: false,
  lines: [{
    id: 'l-1', invoiceId: '11111111-1111-4111-8111-111111111111', currency: 'TND', lineNumber: 1, priceId: 'price-1', productId: 'prod-1',
    productCode: 'P1', description: 'line text', quantity: 1, unitAmount: '1000', lineTotal: '1000', taxAmount: '190', entitlementKind: 'none',
    interval: 'one_time', intervalUnit: null, intervalCount: null, sourceType: null, sourceId: null, createdAt: at,
  }],
  ...over,
});

describe('billing-service event catalog (V2 A3M.2)', () => {
  it('contracts/events.json is exactly this catalog (regenerate with `vitest -u` after a deliberate contract change)', async () => {
    await expect(renderEventContract()).toMatchFileSnapshot('../../contracts/events.json');
  });

  it('invoice.created as the builder produces it matches its catalog entry, with and without the nullable fields', () => {
    const ctx = { actor: { type: 'service' as const, id: 'svc' }, cause: { type: 'request' as const, id: 'r-1' }, correlationId: 'c-1' };
    for (const inv of [invoice(), invoice({ organizationId: null, dueAt: null })]) {
      const ev = invoiceCreatedEvent(inv, ctx);
      expect(ev.name).toBe('invoice.created');
      expect(conformance(JSON.parse(JSON.stringify(ev.payload)) as Record<string, unknown>, PRODUCED_EVENTS['invoice.created'].payload)).toEqual([]);
    }
  });

  it('the consumed payment outcomes are exactly the names the consumer binds, each at version 1', () => {
    const names: readonly PaymentEventName[] = CONSUMED_EVENTS.map((c) => c.name);
    expect([...names].sort()).toEqual(['payment.cancelled', 'payment.expired', 'payment.failed', 'payment.succeeded']);
    for (const c of CONSUMED_EVENTS) {
      expect(c.source).toBe('payment-service');
      expect(c.version).toBe(1);
    }
  });
});

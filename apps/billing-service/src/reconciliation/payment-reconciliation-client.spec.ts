import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpPaymentReconciliationClient } from './payment-reconciliation-client.js';

const PAYMENT = '11111111-1111-4111-8111-111111111111';
const FACT = '44444444-4444-4444-8444-444444444444';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/**
 * Core V2 S0-C12 item 9: Billing's production PAY-12 reader. An item that states a kind other than the one requested is returned marked
 * (`otherKind`), never as the requested kind's evidence; it keeps its place so keyset paging moves past it. Malformed items still fail the page.
 */
describe('HttpPaymentReconciliationClient (Core V2 S0-C12 item 9)', () => {
  let server: Server;
  let url = '';
  let body: unknown = { items: [] };
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const read = (items: unknown[]) => {
    body = { items };
    return new HttpPaymentReconciliationClient({ baseUrl: url, serviceToken: 'billing-token', timeoutMs: 500 }).items('late_success', undefined, 100);
  };
  const late = { id: id(1), paymentId: PAYMENT, factId: FACT, amount: 6100, currency: 'TND', detail: { paymentStatus: 'failed' }, at: '2026-11-04T10:00:00.000Z' };

  it('an item of the requested kind (or stating no kind) is its evidence, unmarked', async () => {
    const [a, b] = await read([{ ...late, kind: 'late_success' }, { ...late, id: id(2) }]);
    expect(a).toMatchObject({ kind: 'late_success', id: id(1), factId: FACT, amount: 6100, currency: 'TND' });
    expect(a!.otherKind).toBeUndefined();
    expect(b!.otherKind).toBeUndefined();
  });

  it('an item stating another kind is marked, carries no figures, and keeps its place in the page', async () => {
    const page = await read([{ ...late, id: id(1) }, { ...late, id: id(2), kind: 'capture_mismatch', detail: { reason: 'amount_mismatch' } }, { ...late, id: id(3) }]);
    expect(page.map((i) => [i.id, i.otherKind ?? null])).toEqual([[id(1), null], [id(2), 'capture_mismatch'], [id(3), null]]);
    expect(page[1]).toMatchObject({ factId: null, amount: null, currency: null, detail: {} });
  });

  it('a malformed item still fails the whole page (Billing never reads a gap as "no evidence")', async () => {
    await expect(read([{ ...late, id: 'not-a-uuid', kind: 'capture_mismatch' }])).rejects.toThrow(/malformed item/);
  });
  it('Core V2 S0-C15B (B-D1): a dispute conflict presence keeps identity, payment and time only, whatever else an answer carries', async () => {
    body = { items: [{ kind: 'dispute_conflict_presence', id: id(9), paymentId: PAYMENT, factId: FACT, amount: 7000, currency: 'TND',
      detail: { reason: 'terminal_contradiction', chargeback: { reference: 'simcb_x', amount: 7000 } }, at: '2026-11-08T10:00:00.000Z' }] };
    const [p] = await new HttpPaymentReconciliationClient({ baseUrl: url, serviceToken: 'billing-token', timeoutMs: 500 }).items('dispute_conflict_presence', undefined, 100);
    expect(p).toEqual({ kind: 'dispute_conflict_presence', id: id(9), paymentId: PAYMENT, factId: null, amount: null, currency: null, detail: {}, at: '2026-11-08T10:00:00.000Z' });
  });
  it('Core V2 DO-73 (U-4): a blocked fact whose currency is not three capital letters is kept without figures; the page is not refused; a usable one keeps its figures', async () => {
    body = { items: ['EURO', 'eur', 'EUR'].map((currency, i) => ({ kind: 'allocation_blocked', id: id(20 + i), paymentId: PAYMENT, factId: id(20 + i), amount: 900, currency,
      detail: { reason: 'currency_mismatch' }, at: '2026-11-09T10:00:00.000Z' })) };
    const page = await new HttpPaymentReconciliationClient({ baseUrl: url, serviceToken: 'billing-token', timeoutMs: 500 }).items('allocation_blocked', undefined, 100);
    expect(page.map((i) => [i.factId, i.amount, i.currency, i.detail])).toEqual([[id(20), null, null, { reason: 'currency_mismatch' }], [id(21), null, null, { reason: 'currency_mismatch' }],
      [id(22), 900, 'EUR', { reason: 'currency_mismatch' }]]);
    // an unusable currency on another kind (no DO-73 rule) still refuses the page, as before
    body = { items: [{ ...late, currency: 'EURO' }] };
    await expect(new HttpPaymentReconciliationClient({ baseUrl: url, serviceToken: 'billing-token', timeoutMs: 500 }).items('late_success', undefined, 100)).rejects.toThrow(/malformed item/);
  });
});

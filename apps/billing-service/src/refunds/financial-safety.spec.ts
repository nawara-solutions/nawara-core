import { describe, expect, it } from 'vitest';
import type { DbService } from '@nawara/service-kit';
import type { PaymentDisputeClient, PaymentDisputeLoss } from './payment-dispute-client.js';
import type { PaymentRefundClient, PaymentRefunds } from './payment-refund-client.js';
import { FinancialSafetyCheck, FinancialWorkerGate, compareRefunds, paymentNotBehind } from './financial-safety.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const P = id(1);
const empty = (): PaymentRefunds => ({ attempts: [], refusals: [], authorizations: [], unallocatedFacts: [] });

/** Core V2 S0-C14 item 14: the financial reconciliation safety check (a consistency check, never proof of no restore) and the workers' gate. */
describe('financial reconciliation safety check (Core V2 S0-C14 item 14)', () => {
  it('compares in ONE direction: Payment at or ahead of Billing\'s mirror is normal; Billing ahead is a mismatch', () => {
    expect(paymentNotBehind('authorized', 'authorized')).toBe(true);
    expect(paymentNotBehind('authorized', 'succeeded')).toBe(true);
    expect(paymentNotBehind('failed', 'discrepancy')).toBe(true);
    expect(paymentNotBehind('succeeded', 'authorized')).toBe(false);
    expect(paymentNotBehind('failed', 'submitted')).toBe(false);
    expect(paymentNotBehind('authorization_expired', 'authorized')).toBe(false);
  });

  it('per payment: an attempt without a relay, a confirmed relay Payment lacks or is behind on, and a completion Payment never completed are mismatches', () => {
    const relays = [{ id: id(10), refundCaseId: id(20), attemptStatus: 'succeeded' as const }, { id: id(11), refundCaseId: id(21), attemptStatus: null },
      { id: id(12), refundCaseId: id(22), attemptStatus: 'rejected' as const }];
    const consistent: PaymentRefunds = { ...empty(), attempts: [{ refundAttemptId: id(10), status: 'succeeded', approvedBy: null }],
      refusals: [{ refundAttemptId: id(12), code: 'refund_dispute_open' }],
      authorizations: [{ refundAuthorizationId: id(30), refundAttemptId: id(10), refundCaseId: id(20), approvedAmount: 1, currency: 'TND', completedAt: '2026-11-06T10:00:00.000Z', allocations: [] }] };
    expect(compareRefunds(P, consistent, relays, [id(20)])).toEqual([]);
    expect(compareRefunds(P, { ...consistent, attempts: [...consistent.attempts, { refundAttemptId: id(13), status: 'failed', approvedBy: null }] }, relays, [id(20)]))
      .toEqual([`attempt_without_relay payment=${P} attempt=${id(13)}`]);
    expect(compareRefunds(P, { ...consistent, attempts: [{ refundAttemptId: id(10), status: 'authorized', approvedBy: null }] }, relays, [id(20)]))
      .toEqual([`relay_ahead_of_payment payment=${P} relay=${id(10)} billing=succeeded payment=authorized`]);
    expect(compareRefunds(P, { ...consistent, attempts: [], refusals: [] }, relays, [id(20)]))
      .toEqual([`relay_unknown_to_payment payment=${P} relay=${id(10)}`, `rejected_relay_unknown_to_payment payment=${P} relay=${id(12)}`]);
    expect(compareRefunds(P, { ...consistent, authorizations: [] }, relays, [id(20)])).toEqual([`completion_unknown_to_payment payment=${P} case=${id(20)}`]);
    expect(compareRefunds(P, null, relays, [])).toEqual([`payment_unknown payment=${P}`]);
  });

  /** A DbService stand-in: each keyset query answers from in-memory rows, ordered and paged exactly as the SQL asks. */
  const fakeDb = (tables: { losses?: { disputeId: string; paymentId: string }[]; relays?: { id: string; paymentId: string; refundCaseId: string; attemptStatus: string | null }[];
    completed?: { id: string; paymentId: string }[] }) => ({
    query: async (sql: string, params: unknown[]) => {
      const after = params[0] as string | null;
      const limit = Number(/LIMIT (\d+)/.exec(sql)![1]);
      const src = sql.includes('payment_dispute_loss') ? (tables.losses ?? []).map((r) => ({ key: r.disputeId, ...r }))
        : sql.includes('refund_authorization_relay') ? (tables.relays ?? []).map((r) => ({ key: r.id, ...r }))
          : (tables.completed ?? []).map((r) => ({ key: r.id, ...r }));
      const rows = src.filter((r) => after === null || r.key > after).sort((a, b) => a.key.localeCompare(b.key)).slice(0, limit);
      return { rows };
    },
  }) as unknown as DbService;
  const disputes = (all: string[], fail = false): PaymentDisputeClient & { pages: number } => {
    const c = {
      pages: 0,
      losses: async (after: string | undefined, limit: number) => {
        c.pages++;
        if (fail) throw new Error('down');
        return all.filter((d) => after === undefined || d > after).sort().slice(0, limit).map((d) => ({ disputeId: d }) as PaymentDisputeLoss);
      },
    };
    return c;
  };
  const refunds = (answer: (paymentId: string) => PaymentRefunds | null | Error): PaymentRefundClient => ({
    refunds: async (paymentId: string) => {
      const a = answer(paymentId);
      if (a instanceof Error) throw a;
      return a;
    },
  }) as unknown as PaymentRefundClient;

  it('pages every loss (200 a page, until a short page) and every Billing row; a Payment loss not yet at Billing is in transit, not a mismatch', async () => {
    const many = Array.from({ length: 450 }, (_, i) => id(1000 + i));
    const d = disputes(many);
    const billingLosses = many.slice(0, 401).map((x) => ({ disputeId: x, paymentId: P }));
    const check = new FinancialSafetyCheck(fakeDb({ losses: billingLosses }), d, refunds(() => empty()));
    expect(await check.scan()).toEqual({ kind: 'passed' });
    expect(d.pages).toBe(3);
  });

  it('a Billing loss Payment does not list is a mismatch; a failing page or PAY-08 read, or an exhausted budget, is unavailable, never a partial pass', async () => {
    const check = (o: { db?: DbService; d?: PaymentDisputeClient; r?: PaymentRefundClient }) =>
      new FinancialSafetyCheck(o.db ?? fakeDb({ losses: [{ disputeId: id(5), paymentId: P }] }), o.d ?? disputes([]), o.r ?? refunds(() => empty()));
    expect(await check({}).scan()).toEqual({ kind: 'mismatch', findings: [`billing_loss_unknown_to_payment dispute=${id(5)}`] });
    expect(await check({ d: disputes([], true) }).scan()).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/^payment_losses_unavailable/) });
    expect(await check({ d: disputes([id(5)]), r: refunds(() => new Error('down')) }).scan()).toMatchObject({ kind: 'unavailable', reason: expect.stringMatching(/^payment_refunds_unavailable/) });
    expect(await check({ d: disputes([id(5)]) }).scan(-1)).toMatchObject({ kind: 'unavailable', reason: 'scan_budget_exceeded' });
  });

  it('the gate opens only on a pass; a mismatch keeps it closed for good (no automatic override)', async () => {
    const g = new FinancialWorkerGate();
    let started = false;
    void g.whenPassed().then(() => { started = true; });
    g.mismatch();
    g.open();
    await new Promise((r) => setTimeout(r, 10));
    expect([g.status, started]).toEqual(['mismatch', false]);
    const h = new FinancialWorkerGate();
    h.open();
    h.mismatch();
    await h.whenPassed();
    expect(h.status).toBe('passed');
  });
});

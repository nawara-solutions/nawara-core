import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingConfig } from '../config/billing-config.js';
import { PaymentDispatcher } from './payment-dispatcher.js';
import { PaymentReconciler } from './payment-reconciler.js';

/**
 * Audit finding M-01 for Billing's two polling jobs: a failure of the pass's first repository call (the dispatcher's claim
 * query, the reconciler's scan) must be logged as a machine-readable event and must not escape as an unhandled rejection.
 */
const config = { dispatch: { intervalMs: 5, batchSize: 5, staleSendingMs: 1000 }, reconcile: { intervalMs: 5, staleRequestedMs: 1000 } } as unknown as BillingConfig;

interface Job {
  start(intervalMs: number): void;
  stop(): Promise<unknown>;
  run(): Promise<unknown>;
}
const jobs: Array<{ name: string; event: string; make: (fail: unknown) => { job: Job; firstCall: ReturnType<typeof vi.fn> } }> = [
  {
    name: 'PaymentDispatcher', event: 'payment_dispatch_pass_failure',
    make: (fail) => {
      const firstCall = vi.fn().mockRejectedValueOnce(fail).mockResolvedValue([]);
      const j = new PaymentDispatcher({ claimForDispatch: firstCall } as never, {} as never, config);
      return { firstCall, job: { start: (i) => j.start(i), stop: () => j.stop(), run: () => j.dispatchOnce() } };
    },
  },
  {
    name: 'PaymentReconciler', event: 'payment_reconcile_pass_failure',
    make: (fail) => {
      const firstCall = vi.fn().mockRejectedValueOnce(fail).mockResolvedValue([]);
      const j = new PaymentReconciler({ findStaleRequested: firstCall } as never, {} as never, config);
      return { firstCall, job: { start: (i) => j.start(i), stop: () => j.stop(), run: () => j.reconcileOnce() } };
    },
  },
];

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe.each(jobs)('$name background job error boundary', ({ event, make }) => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => void unhandled.push(e);
  let logged: string[];
  beforeEach(() => {
    unhandled.length = 0;
    logged = [];
    process.on('unhandledRejection', onUnhandled);
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void logged.push(String(m)));
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    vi.restoreAllMocks();
  });

  it('first repository call fails: logged, nothing escapes, and the NEXT tick runs', async () => {
    const { job, firstCall } = make(new Error('connection terminated: password=hunter2'));
    job.start(5);
    await until(() => firstCall.mock.calls.length >= 3 && logged.length >= 1);
    await job.stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(event);
    expect(logged[0]).toContain('error=Error');
    expect(logged[0]).not.toContain('hunter2');
  });

  it('the pass itself still reports the failure (never a false success), non-Errors are classified unknown, and the overlap guard is released', async () => {
    const { job, firstCall } = make('boom');
    await expect(job.run()).rejects.toBe('boom');
    await expect(job.run()).resolves.toBeDefined(); // `running` was reset by `finally`: the next pass is not blocked as "in flight"
    expect(firstCall).toHaveBeenCalledTimes(2);
    const { job: job2, firstCall: call2 } = make({ code: 'ECONNREFUSED' });
    job2.start(5);
    await until(() => logged.length >= 1 && call2.mock.calls.length >= 2);
    await job2.stop();
    expect(logged[0]).toContain('error=unknown');
    expect(unhandled).toEqual([]);
  });

  it('after stop() no timer remains', async () => {
    const { job, firstCall } = make(new Error('x'));
    job.start(5);
    await until(() => firstCall.mock.calls.length >= 2);
    await job.stop();
    const calls = firstCall.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(firstCall.mock.calls.length).toBe(calls);
  });
});

/**
 * Core V1 refactor R2: a failure of ONE request inside a pass (the Payment call or the repository write) is logged with the kit's
 * `describeFailure` facts (class, code, kind), never the raw message, which can carry hosts, URLs, credentials or SQL values.
 */
describe('per-request failures are logged without the raw error text', () => {
  const SENTINELS = ['password=DO_NOT_LEAK', 'db.internal.example', '/srv/private/payment-secret', 'Bearer FAKE_SECRET'];
  const raw = (code: string) =>
    Object.assign(new Error(`connect ${code} db.internal.example:5432 password=DO_NOT_LEAK /srv/private/payment-secret Bearer FAKE_SECRET`), { code });
  const ORG = '00000000-0000-4000-8000-0000000000a1';
  const REQUEST = '22222222-2222-4222-8222-222222222222';
  const CORRELATION = 'corr-r2-0001';
  const claim = {
    request: { id: REQUEST, amount: 4500n, expiresAt: null },
    invoice: { id: '11111111-1111-4111-8111-111111111111', number: '7', payerType: 'user', payerId: 'user-1', sellerType: 'organization', sellerId: ORG, organizationId: ORG, currency: 'TND', description: null },
    correlationId: CORRELATION,
    wasStale: false,
  };
  const accepted = { kind: 'accepted', snapshot: { paymentId: 'pay-1' } };

  let warned: string[];
  beforeEach(() => {
    warned = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void warned.push(String(m)));
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const expectSafe = (line: string | undefined, event: string, facts: string) => {
    expect(line).toBeDefined();
    expect(line).toContain(`${event} request=${REQUEST} correlationId=${CORRELATION} reason=exception ${facts}`);
    for (const s of SENTINELS) expect(line).not.toContain(s);
  };

  it.each([
    ['the Payment call', () => ({ createPayment: vi.fn().mockRejectedValue(raw('ECONNREFUSED')) }), () => ({}), 'error=Error code=ECONNREFUSED kind=network_unreachable'],
    ['the repository write', () => ({ createPayment: vi.fn().mockResolvedValue(accepted) }), () => ({ markRequested: vi.fn().mockRejectedValue(raw('57P01')) }), 'error=Error code=57P01 kind=db_connection_lost'],
    ['a non-Error throw', () => ({ createPayment: vi.fn().mockRejectedValue('password=DO_NOT_LEAK') }), () => ({}), 'error=unknown'],
  ])('dispatcher: %s fails', async (_name, client, repo, facts) => {
    const requests = { claimForDispatch: vi.fn().mockResolvedValue([claim]), ...repo() };
    const dispatcher = new PaymentDispatcher(requests as never, client() as never, config);
    await expect(dispatcher.dispatchOnce()).resolves.toEqual({ dispatched: 0 }); // one bad request never fails the pass
    expectSafe(warned.find((l) => l.startsWith('payment_dispatch_failure')), 'payment_dispatch_failure', facts);
  });

  it.each([
    ['the Payment call', () => ({ getPayment: vi.fn().mockRejectedValue(raw('ENOTFOUND')) }), () => ({}), 'error=Error code=ENOTFOUND kind=network_unreachable'],
    ['the repository write', () => ({ getPayment: vi.fn().mockResolvedValue({ paymentId: 'pay-1' }) }), () => ({ applyReconciledSnapshot: vi.fn().mockRejectedValue(raw('57P01')) }), 'error=Error code=57P01 kind=db_connection_lost'],
  ])('reconciler: %s fails', async (_name, client, repo, facts) => {
    const requests = { findStaleRequested: vi.fn().mockResolvedValue([{ id: REQUEST, paymentId: 'pay-1', correlationId: CORRELATION, position: {} }]), ...repo() };
    const reconciler = new PaymentReconciler(requests as never, client() as never, config);
    await expect(reconciler.reconcileOnce()).resolves.toEqual({ checked: 1, settled: 0 });
    expectSafe(warned.find((l) => l.startsWith('payment_reconcile_failure')), 'payment_reconcile_failure', facts);
  });
});

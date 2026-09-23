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

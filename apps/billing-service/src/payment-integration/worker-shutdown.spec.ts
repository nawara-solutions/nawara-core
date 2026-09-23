import { describe, expect, it } from 'vitest';
import { PaymentDispatcher, PaymentDispatcherService } from './payment-dispatcher.js';
import { PaymentReconciler, PaymentReconcilerService } from './payment-reconciler.js';

/**
 * Stage 14.6 (F6): each Billing poller, driven through its Nest lifecycle wrapper, drains the pass in flight when shutdown begins
 * (`beforeApplicationShutdown`, which Nest runs before any `onApplicationShutdown` closes the pool) and starts no pass afterwards.
 * Deterministic: the pass blocks on a latch the test opens.
 */
const config = { dispatch: { intervalMs: 5, batchSize: 1, staleSendingMs: 1000 }, reconcile: { intervalMs: 5, staleRequestedMs: 1000 } } as never;
const latch = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
};

const workers = [
  { name: 'PaymentDispatcher', make: () => { const w = new PaymentDispatcher({} as never, {} as never, config); return { w, pass: 'dispatchOnce' as const, svc: new PaymentDispatcherService(w) }; } },
  { name: 'PaymentReconciler', make: () => { const w = new PaymentReconciler({} as never, {} as never, config); return { w, pass: 'reconcileOnce' as const, svc: new PaymentReconcilerService(w) }; } },
];

describe.each(workers)('$name shutdown', ({ make }) => {
  it('beforeApplicationShutdown waits for the pass in flight, then no new pass starts', async () => {
    const { w, pass, svc } = make();
    const gate = latch();
    const entered = latch();
    let passes = 0;
    (w as unknown as Record<string, () => Promise<unknown>>)[pass] = async () => {
      passes++;
      entered.open();
      await gate.opened;
      return {};
    };
    w.start(5);
    await entered.opened;
    let done = false;
    const shutdown = svc.beforeApplicationShutdown().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(done).toBe(false);
    gate.open();
    await shutdown;
    await new Promise((r) => setTimeout(r, 50));
    expect(passes).toBe(1);
    await svc.onApplicationShutdown(); // idempotent
  });
});

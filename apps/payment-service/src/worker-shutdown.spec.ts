import { describe, expect, it } from 'vitest';
import { AttemptResolver, AttemptResolverService } from './attempts/attempt-resolver.js';
import { ExpirySweeper, ExpirySweeperService } from './payments/expiry-sweeper.js';
import { WebhookRetrierService, WebhookRetriever } from './webhooks/webhook-retrier.js';

/**
 * Stage 14.6 (F6): each Payment poller, driven through its Nest lifecycle wrapper, drains the pass in flight when shutdown begins
 * (`beforeApplicationShutdown`, which Nest runs before any `onApplicationShutdown` closes the pool) and starts no pass afterwards.
 * Deterministic: the pass blocks on a latch the test opens.
 */
const latch = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
};

const workers = [
  { name: 'ExpirySweeper', make: () => { const w = new ExpirySweeper({} as never, {} as never, {} as never); return { w, pass: 'sweepOnce', svc: new ExpirySweeperService(w) }; } },
  { name: 'AttemptResolver', make: () => { const w = new AttemptResolver({} as never, {} as never, {} as never); return { w, pass: 'drainOnce', svc: new AttemptResolverService(w) }; } },
  { name: 'WebhookRetriever', make: () => { const w = new WebhookRetriever({} as never, {} as never, {} as never); return { w, pass: 'drainOnce', svc: new WebhookRetrierService(w) }; } },
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

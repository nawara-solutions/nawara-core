import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttemptResolver } from './attempts/attempt-resolver.js';
import { ExpirySweeper } from './payments/expiry-sweeper.js';
import { WebhookRetriever } from './webhooks/webhook-retrier.js';

/**
 * Audit finding M-01: every polling job runs `setInterval(() => void job(), ms)`. If the job's first database call rejects,
 * that used to escape as an unhandled promise rejection, which terminates a Node process. Each job must instead log the
 * failure (a machine-readable event name and the error CLASS only) and run again on the next tick.
 */
interface Job {
  start(intervalMs?: number): void;
  stop(): Promise<void>;
  run(): Promise<unknown>;
}

/** A database whose first `query` rejects and every later one returns no rows. */
const flakyDb = (firstError: unknown) => {
  const query = vi.fn().mockRejectedValueOnce(firstError).mockResolvedValue({ rows: [] });
  return { db: { query, tx: vi.fn() }, query };
};

const jobs: Array<{ name: string; event: string; make: (db: unknown) => Job }> = [
  {
    name: 'ExpirySweeper', event: 'expiry_sweep_pass_failure',
    make: (db) => { const j = new ExpirySweeper(db as never, {} as never); return { start: (i) => j.start(i), stop: () => j.stop(), run: () => j.sweepOnce() }; },
  },
  {
    name: 'AttemptResolver', event: 'attempt_resolver_pass_failure',
    make: (db) => { const j = new AttemptResolver(db as never, {} as never, {} as never); return { start: (i) => j.start(i), stop: () => j.stop(), run: () => j.drainOnce() }; },
  },
  {
    name: 'WebhookRetriever', event: 'webhook_retrier_pass_failure',
    make: (db) => { const j = new WebhookRetriever(db as never, {} as never, {} as never); return { start: (i) => j.start(i), stop: () => j.stop(), run: () => j.drainOnce() }; },
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

  it('normal run: the timer drives the job and nothing is logged as a failure', async () => {
    const { db, query } = flakyDb(new Error('unused'));
    query.mockReset().mockResolvedValue({ rows: [] });
    const job = make(db);
    job.start(5);
    await until(() => query.mock.calls.length >= 2);
    await job.stop();
    expect(logged).toEqual([]);
    expect(unhandled).toEqual([]);
  });

  it('first database call fails: the failure is logged, no rejection escapes, and the NEXT tick runs', async () => {
    const { db, query } = flakyDb(new Error('connection terminated: password=hunter2'));
    const job = make(db);
    job.start(5);
    await until(() => query.mock.calls.length >= 3 && logged.length >= 1);
    await job.stop();
    await new Promise((r) => setTimeout(r, 20)); // let any stray rejection surface
    expect(unhandled).toEqual([]);
    expect(logged).toHaveLength(1); // only the first pass failed
    expect(logged[0]).toContain(event);
    expect(logged[0]).toContain('error=Error'); // the class, never the message
    expect(logged[0]).not.toContain('hunter2');
  });

  it('a non-Error throw is classified as unknown and is still not a success', async () => {
    const { db } = flakyDb('boom');
    const job = make(db);
    await expect(job.run()).rejects.toBe('boom'); // the pass itself still reports failure: nothing turns it into a success
    const { db: db2, query } = flakyDb({ code: 'ECONNREFUSED' });
    const job2 = make(db2);
    job2.start(5);
    await until(() => logged.length >= 1 && query.mock.calls.length >= 2);
    await job2.stop();
    expect(logged[0]).toContain('error=unknown');
    expect(unhandled).toEqual([]);
  });

  it('after stop() no timer remains: the job is never run again', async () => {
    const { db, query } = flakyDb(new Error('x'));
    const job = make(db);
    job.start(5);
    await until(() => query.mock.calls.length >= 2);
    await job.stop();
    const calls = query.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(query.mock.calls.length).toBe(calls);
  });
});

import { describe, expect, it } from 'vitest';
import { BoundedObservationBuffer, type ObservationSinkResult } from '../src/index.js';

/** Core V2 DO-43b (D43-1, safety requirement 6): the bounded, non-blocking buffer: overflow, sink failure, rejection, stop, no growth. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('BoundedObservationBuffer', () => {
  it('validates its bounds (the Owner\'s development defaults are 1000 and 1000 ms)', () => {
    const sink = async (): Promise<ObservationSinkResult> => ({ stored: 0 });
    expect(() => new BoundedObservationBuffer({ capacity: 0, flushIntervalMs: 1000, sink })).toThrow();
    expect(() => new BoundedObservationBuffer({ capacity: 1.5, flushIntervalMs: 1000, sink })).toThrow();
    expect(() => new BoundedObservationBuffer({ capacity: 1000, flushIntervalMs: 1, sink })).toThrow();
    expect(() => new BoundedObservationBuffer({ capacity: 1000, flushIntervalMs: 1000, batchMax: 0, sink })).toThrow();
    expect(() => new BoundedObservationBuffer({ capacity: 1000, flushIntervalMs: 1000, sink })).not.toThrow();
  });

  it('offer is synchronous and bounded: beyond capacity it drops and counts, never throws or grows', () => {
    const b = new BoundedObservationBuffer<number>({ capacity: 3, flushIntervalMs: 1000, sink: async () => ({ stored: 0 }) });
    const accepted = [1, 2, 3, 4, 5].map((n) => b.offer(n));
    expect(accepted).toEqual([true, true, true, false, false]);
    expect(b.stats()).toEqual({ observedTotal: 3, persistedTotal: 0, droppedOverflow: 2, droppedSink: 0, rejectedTotal: 0, buffered: 3 });
  });

  it('flushes in order, one flush at a time, at most batchMax per flush; stored and duplicate rows both count as persisted', async () => {
    const batches: number[][] = [];
    const b = new BoundedObservationBuffer<number>({ capacity: 10, flushIntervalMs: 1000, batchMax: 2, sink: async (x) => { batches.push([...x]); await sleep(5); return { stored: x.length - 1, duplicate: 1 }; } });
    for (const n of [1, 2, 3]) b.offer(n);
    const first = b.flush();
    const concurrent = b.flush(); // joins the running flush, does not start a second one
    await Promise.all([first, concurrent]);
    expect(batches).toEqual([[1, 2]]);
    await b.flush();
    expect(batches).toEqual([[1, 2], [3]]);
    expect(b.stats()).toMatchObject({ observedTotal: 3, persistedTotal: 3, buffered: 0 });
  });

  it('a failing sink (database outage) loses the batch and counts it; nothing is requeued, so an outage never grows the buffer', async () => {
    const failures: number[] = [];
    const b = new BoundedObservationBuffer<number>({ capacity: 5, flushIntervalMs: 1000, sink: async () => { throw new Error('connection refused'); }, onSinkFailure: (lost) => failures.push(lost) });
    for (const n of [1, 2, 3]) b.offer(n);
    await b.flush();
    expect(b.stats()).toEqual({ observedTotal: 3, persistedTotal: 0, droppedOverflow: 0, droppedSink: 3, rejectedTotal: 0, buffered: 0 });
    expect(failures).toEqual([3]);
  });

  it('a throwing failure reporter changes nothing; a sink that rejects rows counts them apart from persisted ones', async () => {
    const b = new BoundedObservationBuffer<number>({ capacity: 5, flushIntervalMs: 1000, sink: async () => { throw new Error('x'); }, onSinkFailure: () => { throw new Error('reporter'); } });
    b.offer(1);
    await expect(b.flush()).resolves.toBeUndefined();
    const r = new BoundedObservationBuffer<number>({ capacity: 5, flushIntervalMs: 1000, sink: async () => ({ stored: 1, rejected: 2 }) });
    for (const n of [1, 2, 3]) r.offer(n);
    await r.flush();
    expect(r.stats()).toMatchObject({ persistedTotal: 1, rejectedTotal: 2 });
  });

  it('the timer flushes in the background and is unref\'d; stop() flushes what is left once, then refuses and counts everything', async () => {
    const stored: number[] = [];
    const b = new BoundedObservationBuffer<number>({ capacity: 100, flushIntervalMs: 20, batchMax: 3, sink: async (x) => { stored.push(...x); return { stored: x.length }; } });
    b.start();
    for (const n of [1, 2]) b.offer(n);
    await sleep(80);
    expect(stored).toEqual([1, 2]);
    for (const n of [3, 4, 5, 6, 7]) b.offer(n);
    const final = await b.stop();
    expect(stored).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(final).toMatchObject({ observedTotal: 7, persistedTotal: 7, buffered: 0 });
    expect(b.offer(8)).toBe(false);
    expect(b.stats()).toMatchObject({ observedTotal: 7, droppedOverflow: 1 });
  });

  it('a sink that never answers stalls only the buffer: offers keep returning at once and overflow is counted', async () => {
    const b = new BoundedObservationBuffer<number>({ capacity: 2, flushIntervalMs: 1000, sink: () => new Promise(() => undefined) });
    b.offer(1);
    void b.flush(); // hangs forever
    const started = Date.now();
    const results = [2, 3, 4].map((n) => b.offer(n));
    expect(Date.now() - started).toBeLessThan(50);
    expect(results).toEqual([true, true, false]);
    expect(b.stats()).toMatchObject({ observedTotal: 3, droppedOverflow: 1, buffered: 2 });
  });
});

import { describe, expect, it } from 'vitest';
import { PollLoop } from '../src/index.js';

/** Stage 14.6: deterministic (latches, not sleeps-as-assertions) proofs of the shared poll loop's scheduling and bounded drain. */
const latch = () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
};
const tick = () => new Promise((r) => setTimeout(r, 30));

describe('PollLoop', () => {
  it('never runs two passes at once: the next pass is scheduled only after the previous one ends', async () => {
    let active = 0;
    let maxActive = 0;
    let passes = 0;
    const loop = new PollLoop(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      passes++;
      await new Promise((r) => setTimeout(r, 15)); // longer than the interval
      active--;
    });
    loop.start(1, 0);
    while (passes < 5) await tick();
    await loop.stop();
    expect(maxActive).toBe(1);
  });

  it('stop() waits for the pass in flight ("drained") and no pass starts after it', async () => {
    const gate = latch();
    const entered = latch();
    let passes = 0;
    const loop = new PollLoop(async () => {
      passes++;
      entered.open();
      await gate.opened;
    });
    loop.start(1, 0);
    await entered.opened;
    let settled = false;
    const stopping = loop.stop(10_000).then((o) => ((settled = true), o));
    await tick();
    expect(settled).toBe(false); // still waiting for the in-flight pass
    gate.open();
    expect(await stopping).toBe('drained');
    await tick();
    expect(passes).toBe(1);
    expect(loop.running).toBe(false);
  });

  it('the drain is bounded: a pass that never ends lets stop() return "timeout" at the deadline', async () => {
    const entered = latch();
    const loop = new PollLoop(async () => {
      entered.open();
      await new Promise(() => undefined); // never settles
    });
    loop.start(1, 0);
    await entered.opened;
    const started = Date.now();
    expect(await loop.stop(200)).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('stop() on an idle loop returns "idle" at once and cancels the scheduled pass', async () => {
    let passes = 0;
    const loop = new PollLoop(async () => void passes++);
    loop.start(10_000);
    expect(await loop.stop()).toBe('idle');
    expect(passes).toBe(0);
  });

  it('a failing pass is reported and the next pass still runs', async () => {
    const errors: unknown[] = [];
    let passes = 0;
    const loop = new PollLoop(async () => {
      passes++;
      if (passes === 1) throw new Error('boom');
    }, (e) => errors.push(e));
    loop.start(1, 0);
    while (passes < 2) await tick();
    await loop.stop();
    expect(errors).toHaveLength(1);
    expect(passes).toBeGreaterThanOrEqual(2);
  });

  it('stop() is idempotent (Stage 15.5, F-D): a hung pass gets ONE drain budget, however many times or ways stop() is called', async () => {
    const timeouts: number[] = [];
    const loop = new PollLoop(() => new Promise(() => undefined), () => undefined, (ms) => timeouts.push(ms));
    loop.start(10, 0);
    await new Promise((r) => setTimeout(r, 30));
    let t = Date.now();
    const [a, b] = await Promise.all([loop.stop(200), loop.stop(200)]);
    expect([a, b]).toEqual(['timeout', 'timeout']);
    expect(Date.now() - t).toBeLessThan(400);
    t = Date.now();
    expect(await loop.stop(200)).toBe('timeout'); // the same drain's outcome, at once: no second budget for the same hung pass
    expect(Date.now() - t).toBeLessThan(50);
    expect(timeouts).toEqual([200]); // reported once
  });

  it('a loop started again after a stop gets a fresh stop', async () => {
    const loop = new PollLoop(async () => undefined);
    loop.start(10, 0);
    expect(await loop.stop()).not.toBe('timeout');
    loop.start(10, 0);
    await new Promise((r) => setTimeout(r, 30));
    expect(loop.running).toBe(true);
    await loop.stop();
    expect(loop.running).toBe(false);
  });
});

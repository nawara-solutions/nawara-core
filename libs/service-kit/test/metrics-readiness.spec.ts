import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ReadinessRegistry, ShutdownState, type ReadinessObservation } from '../src/index.js';
import { createTestApp, type TestApp } from './support/app.js';
import { METRICS_ON, scrape, seriesOf } from './support/metrics.js';

/**
 * V2 A12.2: the readiness observer is additive. With and without it, a run returns the same result, writes the same log lines,
 * runs each check exactly once, keeps its timeout and its drain answer; an observer that throws changes nothing; and the metrics
 * never run a check.
 */
type Scenario = Record<string, () => Promise<void>>;
const never = () => new Promise<void>(() => undefined);
const fail = async () => {
  throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'), { code: 'ECONNREFUSED' });
};

function pair(checks: Scenario, opts: { draining?: boolean; observer?: (o: ReadinessObservation) => void } = {}) {
  const make = () => {
    const logs: string[] = [];
    const calls: Record<string, number> = {};
    const r = new ReadinessRegistry(50, (level, message) => logs.push(`${level} ${message}`), () => opts.draining ?? false);
    for (const [name, check] of Object.entries(checks)) {
      calls[name] = 0;
      r.register(name, () => {
        calls[name]!++;
        return check();
      });
    }
    return { r, logs, calls };
  };
  const plain = make();
  const observed = make();
  const seen: ReadinessObservation[] = [];
  observed.r.setObserver(opts.observer ?? ((o) => seen.push(o)));
  return { plain, observed, seen };
}

describe('readiness observer non-regression (V2 A12.2)', () => {
  const scenarios: Record<string, Scenario> = {
    healthy: { database: async () => undefined, migrations: async () => undefined },
    failing: { database: fail, migrations: async () => undefined },
    timeout: { database: never, rabbitmq: async () => undefined },
  };

  for (const [label, checks] of Object.entries(scenarios)) {
    it(`${label}: same result, same log lines, each check run exactly once per run`, async () => {
      const { plain, observed, seen } = pair(checks);
      for (let i = 0; i < 3; i++) expect(await observed.r.run()).toEqual(await plain.r.run());
      expect(observed.logs).toEqual(plain.logs);
      expect(observed.calls).toEqual(plain.calls);
      for (const n of Object.keys(checks)) expect(observed.calls[n]).toBe(3);
      expect(seen).toHaveLength(3);
      expect(seen[0]!.checks.map((c) => c.name).sort()).toEqual(Object.keys(checks).sort());
    });
  }

  it('the observation matches the result it follows', async () => {
    const { observed, seen } = pair(scenarios.timeout!);
    const r = await observed.r.run();
    expect(r).toEqual({ ok: false, failed: ['database'] });
    expect(seen[0]).toMatchObject({ ready: false, draining: false });
    const db = seen[0]!.checks.find((c) => c.name === 'database')!;
    expect(db.ok).toBe(false);
    expect(db.durationMs).toBeGreaterThanOrEqual(45); // the 50 ms timeout, unchanged
  });

  it('a throwing observer changes nothing', async () => {
    const { plain, observed } = pair(scenarios.failing!, {
      observer: () => {
        throw new Error('observer failure');
      },
    });
    expect(await observed.r.run()).toEqual(await plain.r.run());
    expect(observed.logs).toEqual(plain.logs);
  });

  it('draining: the same answer, no check runs, and the observer is told', async () => {
    const { plain, observed, seen } = pair(scenarios.healthy!, { draining: true });
    expect(await observed.r.run()).toEqual({ ok: false, failed: ['shutting_down'] });
    expect(await plain.r.run()).toEqual({ ok: false, failed: ['shutting_down'] });
    expect(observed.calls).toEqual({ database: 0, migrations: 0 });
    expect(seen).toEqual([{ ready: false, draining: true, checks: [] }]);
  });

  it('a second observer is refused', () => {
    const r = new ReadinessRegistry();
    r.setObserver(() => undefined);
    expect(() => r.setObserver(() => undefined)).toThrow(/already set/);
  });
});

describe('readiness through HTTP and metrics', () => {
  let on: TestApp;
  let off: TestApp;
  let calls = 0;
  let healthy = true;
  beforeAll(async () => {
    on = await createTestApp({ env: METRICS_ON });
    off = await createTestApp();
    for (const t of [on, off]) {
      t.registry.register('database', async () => {
        if (t === on) calls++;
        if (!healthy) throw new Error('down');
      });
    }
  });
  afterAll(async () => {
    await on.app.close();
    await off.app.close();
  });

  it('/ready answers the same body and status with metrics on and off (ready, not ready, draining)', async () => {
    for (const state of [true, false]) {
      healthy = state;
      const a = await request(on.app.getHttpServer()).get('/ready');
      const b = await request(off.app.getHttpServer()).get('/ready');
      expect({ status: a.status, body: a.body }).toEqual({ status: b.status, body: b.body });
    }
    healthy = true;
  });

  it('metrics are SET by /ready and never run a check themselves', async () => {
    const before = calls;
    await request(on.app.getHttpServer()).get('/ready').expect(200);
    expect(calls).toBe(before + 1);
    for (let i = 0; i < 5; i++) await scrape(on.app);
    expect(calls).toBe(before + 1);
    const body = await scrape(on.app);
    expect(body).toMatch(/^nawara_readiness_ready 1$/m);
    expect(seriesOf(body, 'nawara_readiness_check_up')).toEqual([{ check: 'database' }]);
    expect(body).toMatch(/^nawara_readiness_check_up\{check="database"\} 1$/m);
    expect(body).toMatch(/^nawara_readiness_last_run_timestamp_seconds \d/m);
    healthy = false;
    await request(on.app.getHttpServer()).get('/ready').expect(503);
    expect(await scrape(on.app)).toMatch(/^nawara_readiness_check_up\{check="database"\} 0$/m);
    healthy = true;
  });

  it('while draining, /ready keeps its answer and the metrics listener still serves', async () => {
    const state = on.app.get(ShutdownState);
    state.draining = true;
    try {
      const r = await request(on.app.getHttpServer()).get('/ready');
      expect(r.status).toBe(503);
      expect(await scrape(on.app)).toMatch(/^nawara_readiness_ready 0$/m);
      const app = await request(on.app.getHttpServer()).get('/probe/ok');
      expect(app.status).toBe(503); // shutdown admission, unchanged
    } finally {
      state.draining = false;
    }
  });
});

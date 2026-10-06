import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { DbService, InMemoryEventBus, OutboxRelay, kitMigrationsDir, runMigrations, type EventEnvelope, type RelayObservation } from '../src/index.js';
import { OUTBOX_STATS_MIN_INTERVAL_MS, OUTBOX_STATS_SQL } from '../src/events/outbox-relay.js';
import { BoundedMetrics } from '../src/metrics/metrics.js';
import { outboxMetrics } from '../src/metrics/outbox-metrics.js';
import { createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

/**
 * V2 A12.3, against REAL PostgreSQL: the outbox gauges read the same aggregate as `nawara-check-outbox-lag` (G4 evidence, unchanged),
 * from the relay's own loop, at most every 15 s; and a failing metrics read changes NOTHING the relay does.
 */
const cli = fileURLToPath(new URL('../dist/cli/check-outbox-lag.js', import.meta.url));
function lagCheck(databaseUrl: string): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, '--max-age-seconds', '60'], { env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
const value = (body: string, name: string) => Number(new RegExp(`^${name} (\\S+)$`, 'm').exec(body)?.[1]);
const cliValue = (out: string, label: string) => Number(new RegExp(`^${label}: (\\d+)`, 'm').exec(out)?.[1]);

describeWithEnv('outbox metrics (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const dbs: TestDatabase[] = [];
  const services: DbService[] = [];
  const fresh = async () => {
    const t = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'a12outbox');
    dbs.push(t);
    await runMigrations(t.url, [kitMigrationsDir]);
    const d = new DbService({ url: t.url, max: 4 });
    services.push(d);
    return { t, d };
  };
  afterAll(async () => {
    for (const d of services) await d.onApplicationShutdown();
    for (const t of dbs) await t.drop();
  });

  /** Reads the gauges through the relay's own stats path (the private refresh the loop runs), into a fresh registry. */
  async function gauges(d: DbService) {
    const m = new BoundedMetrics();
    const relay = new OutboxRelay(d, new InMemoryEventBus(), { source: 'test' });
    relay.setObserver(outboxMetrics(m));
    await (relay as unknown as { refreshStats(): Promise<void> }).refreshStats();
    return (await m.render()).body;
  }

  it('equals the nawara-check-outbox-lag aggregate: healthy, aging, retrying (and the CLI is unchanged)', async () => {
    const { t, d } = await fresh();
    const compare = async (expectedStatus: number) => {
      const body = await gauges(d);
      const r = await lagCheck(t.url);
      expect(r.status).toBe(expectedStatus);
      expect(value(body, 'nawara_outbox_pending_events')).toBe(cliValue(r.stdout, 'pending'));
      expect(value(body, 'nawara_outbox_retrying_events')).toBe(cliValue(r.stdout, 'retrying'));
      expect(Math.abs(value(body, 'nawara_outbox_oldest_pending_age_seconds') - cliValue(r.stdout, 'oldest pending age'))).toBeLessThanOrEqual(1);
      expect(value(body, 'nawara_outbox_stats_timestamp_seconds')).toBeGreaterThan(Date.now() / 1000 - 5);
      return r;
    };
    // healthy: nothing pending
    let r = await compare(0);
    expect(r.stdout).toContain('pending: 0');
    // aging: one row ten minutes old, never attempted
    await d.query(`INSERT INTO outbox(id, name, payload, "occurredAt") VALUES ($1, 'probe.aging', '{}', now() - interval '10 minutes')`, [randomUUID()]);
    r = await compare(1);
    expect(r.stderr).toMatch(/needs manual review/);
    // retrying: another row with failed attempts
    await d.query(`INSERT INTO outbox(id, name, payload, "occurredAt", attempts, "lastError") VALUES ($1, 'probe.retrying', '{}', now() - interval '2 minutes', 3, 'Error: x')`, [randomUUID()]);
    r = await compare(1);
    expect(cliValue(r.stdout, 'retrying')).toBe(1);
    expect(cliValue(r.stdout, 'pending')).toBe(2);
  });

  it('a FAILING metrics read changes nothing the relay does: claims, publishes, stamps, attempts, backoff, notices', async () => {
    const seed = async (d: DbService) => {
      for (let i = 0; i < 6; i++) {
        await d.query(`INSERT INTO outbox(id, name, payload, "occurredAt") VALUES ($1, 'probe.ev', '{"i":${i}}', now() - ($2 || ' seconds')::interval)`, [`00000000-0000-4000-8000-00000000000${i}`, String(60 - i)]);
      }
    };
    const ids = Array.from({ length: 6 }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);
    /**
     * The first publish of rows 0 and 1 fails, once each: attempts, lastError and backoff are exercised, and WHICH rows fail does not
     * depend on scheduling (a "next two publishes" failure could hit row 0 twice if a pass ran after its backoff had elapsed).
     */
    class FirstPublishFails extends InMemoryEventBus {
      private readonly failOnce = new Set([ids[0], ids[1]]);
      override async publish(event: EventEnvelope): Promise<void> {
        if (this.failOnce.delete(event.id)) throw new Error('broker unavailable');
        return super.publish(event);
      }
    }
    const run = async (withFailingMetrics: boolean) => {
      const { d } = await fresh();
      await seed(d);
      const bus = new FirstPublishFails();
      const notices: string[] = [];
      let statsQueries = 0;
      const observed: RelayObservation[] = [];
      const db = withFailingMetrics
        ? {
            tx: d.tx.bind(d),
            query: (sql: string, params?: unknown[]) => {
              if (sql === OUTBOX_STATS_SQL) {
                statsQueries++;
                return Promise.reject(new Error('metrics read failed'));
              }
              return d.query(sql, params);
            },
          }
        : d;
      const relay = new OutboxRelay(db as DbService, bus, { source: 'test', baseBackoffMs: 30 }, (m) => notices.push(m));
      if (withFailingMetrics) relay.setObserver((o) => observed.push(o));
      relay.start(10);
      const end = Date.now() + 10_000;
      while (bus.published.length < 6 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      await relay.stop();
      const rows = (await d.query(`SELECT id, attempts, "lastError", ("publishedAt" IS NOT NULL) AS published FROM outbox ORDER BY id`)).rows;
      return { published: bus.published.map((e) => e.id), rows, notices: notices.map((n) => n.replace(/ageSeconds=\d+/, 'ageSeconds=N')), statsQueries, observed };
    };
    const control = await run(false);
    const failing = await run(true);
    // The same six events, each published exactly once. Membership, not sequence: a row in backoff is overtaken by the rows behind it
    // (by design), so the order across a backoff depends on when a pass runs, which is not part of the relay's contract.
    for (const r of [control, failing]) {
      expect(r.published).toHaveLength(6);
      expect(new Set(r.published).size).toBe(6);
    }
    expect([...failing.published].sort()).toEqual([...control.published].sort());
    expect([...control.published].sort()).toEqual(ids);
    expect(failing.rows).toEqual(control.rows);
    expect(control.rows.map((r: { attempts: number; lastError: string | null; published: boolean }) => [r.attempts, r.lastError, r.published])).toEqual([
      [2, null, true],
      [2, null, true],
      [1, null, true],
      [1, null, true],
      [1, null, true],
      [1, null, true],
    ]);
    expect(failing.notices).toEqual(control.notices);
    // exactly two publish failures, row 0's then row 1's, each a first attempt with the base backoff
    const failures = control.notices.filter((n) => n.startsWith('outbox_publish_failure'));
    expect(failures.map((n) => [/eventId=(\S+)/.exec(n)?.[1], /attempt=(\d+)/.exec(n)?.[1], /retryInMs=(\d+)/.exec(n)?.[1]])).toEqual([
      [ids[0], '1', '30'],
      [ids[1], '1', '30'],
    ]);
    // the metrics read WAS attempted (once: throttled), failed, and was swallowed: no stats observation, nothing else changed
    expect(failing.statsQueries).toBe(1);
    expect(failing.observed.filter((o) => o.type === 'stats')).toEqual([]);
  });

  it('runs inside the relay loop only with an observer, at most once per interval, and never without one', async () => {
    const { d } = await fresh();
    let statsQueries = 0;
    const counting = { tx: d.tx.bind(d), query: (sql: string, p?: unknown[]) => (sql === OUTBOX_STATS_SQL && statsQueries++, d.query(sql, p)) };
    const plain = new OutboxRelay(counting as DbService, new InMemoryEventBus(), { source: 'test' });
    plain.start(5);
    await new Promise((r) => setTimeout(r, 300));
    await plain.stop();
    expect(statsQueries).toBe(0); // no observer: no metrics query at all
    const observed: RelayObservation[] = [];
    const relay = new OutboxRelay(counting as DbService, new InMemoryEventBus(), { source: 'test' });
    relay.setObserver((o) => observed.push(o));
    relay.start(5);
    await new Promise((r) => setTimeout(r, 400)); // ~80 passes
    await relay.stop();
    expect(statsQueries).toBe(1);
    expect(observed.filter((o) => o.type === 'stats')).toHaveLength(1);
    expect(OUTBOX_STATS_MIN_INTERVAL_MS).toBe(15_000);
    expect(() => relay.setObserver(() => undefined)).toThrow(/already set/);
  });

  it('a pass failure is reported by its bounded kind, after the existing notice, and a throwing observer changes nothing', async () => {
    const { t } = await fresh();
    const unreachable = new URL(t.url);
    unreachable.port = '1';
    const broken = new DbService({ url: unreachable.toString(), max: 1, connectionTimeoutMs: 500 });
    services.push(broken);
    const notices: string[] = [];
    const kinds: unknown[] = [];
    const relay = new OutboxRelay(broken, new InMemoryEventBus(), { source: 'test' }, (m) => notices.push(m));
    relay.setObserver((o) => {
      if (o.type === 'pass_failure') kinds.push(o.kind);
      throw new Error('observer failure');
    });
    relay.start(10);
    const end = Date.now() + 8000;
    while (notices.length < 2 && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    await relay.stop();
    expect(notices[0]).toMatch(/^outbox_relay_pass_failure error=\S+ code=ECONNREFUSED kind=network_unreachable — the next pass retries$/);
    expect(kinds[0]).toBe('network_unreachable');
    expect(notices.length).toBeGreaterThanOrEqual(2); // the loop continued despite the throwing observer
  });
});

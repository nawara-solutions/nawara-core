import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Logger } from '@nestjs/common';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import {
  DbService, OutboxRelay, OutboxService, PermanentEventFailure, PublisherConfirmTimeoutError, RabbitMqEventBus, ReadinessRegistry, describeFailure,
  kitMigrationsDir, runMigrations, type EventBus, type EventEnvelope, type NoticeLevel,
} from '../src/index.js';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 14.7, against REAL PostgreSQL and RabbitMQ: each Stage 14.4-14.6 failure produces an operational signal that names the
 * failing layer and the affected item, and never a credential or a payload. The failures themselves are proven by the
 * db-resilience / async-resilience suites; this suite proves what an operator SEES when they happen.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(25);
  }
};
const failureOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    return describeFailure(e);
  }
  throw new Error('expected a failure');
};

const cli = fileURLToPath(new URL('../dist/cli/check-outbox-lag.js', import.meta.url));
function runLagCheck(databaseUrl: string, args: string[] = []): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

describeWithEnv('operational observability (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let testDb: TestDatabase;
  let password: string;
  const closers: (() => Promise<unknown>)[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'observ');
    await runMigrations(testDb.url, [kitMigrationsDir]);
    password = decodeURIComponent(new URL(testDb.url).password);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    for (const c of closers.reverse()) await c().catch(() => undefined);
    await testDb.drop();
  });
  const db = (opts: Partial<ConstructorParameters<typeof DbService>[0]> = {}) => {
    const d = new DbService({ url: testDb.url, ...opts });
    closers.push(() => d.onApplicationShutdown());
    return d;
  };

  it('each Stage 14.4 database failure is named by its kind, without its message or a credential', async () => {
    const lines: string[] = [];

    lines.push(await failureOf(db({ statementTimeoutMs: 1000 }).query('SELECT pg_sleep(3)')));
    expect(lines.at(-1)).toBe('error=DatabaseError code=57014 kind=db_statement_timeout');

    const small = db({ max: 1, connectionTimeoutMs: 300 });
    let release!: () => void;
    const held = small.tx(() => new Promise<void>((r) => (release = r)));
    await sleep(100);
    lines.push(await failureOf(small.query('SELECT 1')));
    expect(lines.at(-1)).toBe('error=Error kind=db_connect_timeout'); // the pool is exhausted: acquisition gave up at the bound
    release();
    await held;

    lines.push(
      await failureOf(
        db({ idleInTransactionTimeoutMs: 1000 }).tx(async (q) => {
          await q.query('SELECT 1');
          await sleep(1800); // PostgreSQL ends the idle-in-transaction session meanwhile (25P03)
          await q.query('SELECT 1');
        }),
      ),
    );
    expect(lines.at(-1)).toMatch(/^error=\w+( code=\w+)? kind=db_(idle_in_transaction_timeout|connection_lost)$/);

    const unreachable = new URL(testDb.url);
    unreachable.port = '1';
    const down = new DbService({ url: unreachable.toString(), connectionTimeoutMs: 1000 });
    closers.push(() => down.onApplicationShutdown());
    lines.push(await failureOf(down.query('SELECT 1')));
    expect(lines.at(-1)).toBe('error=Error code=ECONNREFUSED kind=network_unreachable');

    expect(lines.join('\n')).not.toContain(password);
  });

  it('readiness: a database that is down is logged ONCE with its kind, however often /ready is probed', async () => {
    const logged: string[] = [];
    const registry = new ReadinessRegistry(2000, (_level, m) => logged.push(m));
    const unreachable = new URL(testDb.url);
    unreachable.port = '1';
    const down = new DbService({ url: unreachable.toString(), connectionTimeoutMs: 500 }, registry);
    closers.push(() => down.onApplicationShutdown());
    down.onModuleInit(); // registers `database` (no migrations dirs here)
    for (let i = 0; i < 4; i++) expect((await registry.run()).failed).toEqual(['database']);
    expect(logged).toEqual(['readiness_check_failed check=database error=Error code=ECONNREFUSED kind=network_unreachable — /ready answers 503 until it recovers']);
  });

  it('an idle pooled connection the server terminates is reported (it was silently swallowed in the kit before)', async () => {
    const warned: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void warned.push(String(m)));
    const app = `observ_idle_${randomBytes(3).toString('hex')}`;
    const d = db({ applicationName: app });
    await d.query('SELECT 1'); // one idle client now sits in the pool
    const admin = new pg.Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
    await admin.connect();
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1', [app]);
    await admin.end();
    await waitFor(() => warned.some((w) => w.startsWith('db_pool_idle_client_error')));
    expect(warned.find((w) => w.startsWith('db_pool_idle_client_error'))).toBe(
      'db_pool_idle_client_error error=DatabaseError code=57P01 kind=db_connection_lost — the pool discards the client and reconnects on demand',
    );
    await d.query('SELECT 1'); // and the pool recovered
  });

  it('outbox: a failed publish names the event, its attempt, age and next retry; the row stays pending; no payload is logged', async () => {
    const d = db();
    const outbox = new OutboxService();
    const id = await d.tx((q) => outbox.enqueue(q, { name: 'probe.observed', payload: { card: 'payload-secret-4242' }, correlationId: 'corr-observ-0001' }));
    const failing: EventBus = {
      publish: async () => {
        throw new PublisherConfirmTimeoutError(5000);
      },
      subscribe: async () => ({ close: async () => undefined }),
      close: async () => undefined,
    };
    const messages: string[] = [];
    const relay = new OutboxRelay(d, failing, { source: 'test' }, (m) => messages.push(m));
    expect(await relay.drainOnce()).toEqual({ published: 0, failed: 1 });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(
      new RegExp(
        `^outbox_publish_failure eventId=${id} name=probe\\.observed correlationId=corr-observ-0001 attempt=1 ageSeconds=\\d+ retryInMs=1000 ` +
          'error=PublisherConfirmTimeoutError kind=broker_confirm_timeout — the event stays pending and is published again \\(at least once\\)$',
      ),
    );
    expect(messages[0]).not.toContain('payload-secret-4242');
    const { rows } = await d.query('SELECT "publishedAt", attempts FROM outbox WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ publishedAt: null, attempts: 1 });
    await d.query(`UPDATE outbox SET "publishedAt" = now() WHERE id = $1`, [id]); // leave the outbox clean for the lag-check proof
  });

  it('nawara-check-outbox-lag: healthy -> aging, retrying backlog (exit 1, actionable) -> healthy again once delivered', async () => {
    const d = db();
    let r = await runLagCheck(testDb.url, ['--max-age-seconds', '60']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pending: 0');

    const id = randomUUID();
    await d.query(
      `INSERT INTO outbox(id, name, payload, "occurredAt", attempts, "lastError") VALUES ($1, 'probe.stuck', '{"card":"payload-secret-4242"}', now() - interval '10 minutes', 7, $2)`,
      [id, 'PublisherConfirmTimeoutError: publisher confirm not received within 5000 ms'],
    );
    r = await runLagCheck(testDb.url, ['--max-age-seconds', '60']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('pending: 1');
    expect(r.stdout).toMatch(/oldest pending age: (599|6\d\d)s/);
    expect(r.stdout).toContain('retrying: 1');
    expect(r.stdout).toContain('max attempts: 7');
    expect(r.stdout).toContain(`oldest pending event: id=${id} name=probe.stuck attempts=7 nextAttemptAt=`);
    expect(r.stdout).toContain('oldest pending last error: PublisherConfirmTimeoutError: publisher confirm not received within 5000 ms');
    expect(r.stderr).toMatch(/oldest pending outbox row is \d+s old \(> 60s\) — needs manual review/);
    expect(r.stdout + r.stderr).not.toContain('payload-secret-4242');
    expect(r.stdout + r.stderr).not.toContain(password);

    await d.query(`UPDATE outbox SET "publishedAt" = now(), "lastError" = NULL WHERE id = $1`, [id]);
    r = await runLagCheck(testDb.url, ['--max-age-seconds', '60']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pending: 0');

    const unreachable = new URL(testDb.url);
    unreachable.port = '1';
    r = await runLagCheck(unreachable.toString());
    expect(r.status).toBe(1); // the check itself failing is actionable too, and never prints the connection string
    expect(r.stderr).toMatch(/^outbox lag check failed:/);
    expect(r.stdout + r.stderr).not.toContain(password);
  });

  it('migrations: a runner blocked behind another runner says so, then proceeds unchanged once the lock is free', async () => {
    const other = new pg.Client({ connectionString: testDb.url });
    await other.connect();
    await other.query('SELECT pg_advisory_lock(747501)');
    let waited = 0;
    let done = false;
    const run = runMigrations(testDb.url, [kitMigrationsDir], { onLockWait: () => void waited++ }).then((r) => ((done = true), r));
    await waitFor(() => waited === 1);
    await sleep(300);
    expect(done).toBe(false); // still waiting: the lock is not bypassed
    await other.query('SELECT pg_advisory_unlock(747501)');
    await other.end();
    const result = await run;
    expect(waited).toBe(1);
    expect(result.applied).toEqual([]);
  });
});

describeWithEnv('operational observability (real RabbitMQ)', ['TEST_RABBITMQ_URL'], (env) => {
  const target = new URL(env.TEST_RABBITMQ_URL);
  let proxy: BrokerProxy;
  const closers: (() => Promise<unknown>)[] = [];
  const uniq = () => randomBytes(4).toString('hex');
  const envelope = (name: string): EventEnvelope => {
    const id = randomUUID();
    return { id, name, payload: { card: 'payload-secret-4242' }, headers: { eventId: id, occurredAt: new Date().toISOString(), correlationId: 'corr-observ-0002', source: 'test', version: 1 } };
  };

  beforeAll(async () => {
    proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
  });
  afterAll(async () => {
    proxy.thaw();
    for (const c of closers.reverse()) await c().catch(() => undefined);
    await proxy.sever();
  });

  it('a stalled confirm is reported with the event identity and "unconfirmed" (not "failed") wording, at warn', async () => {
    const notices: Array<[NoticeLevel, string]> = [];
    const bus = new RabbitMqEventBus({ url: proxy.url, exchange: `nawara.events.obs${uniq()}`, confirmTimeoutMs: 500, connectTimeoutMs: 1500, onNotice: (m, l) => notices.push([l, m]) });
    closers.push(() => bus.close());
    await bus.publish(envelope('probe.warmup'));
    proxy.freeze();
    const stalled = envelope('probe.stalled');
    await expect(bus.publish(stalled)).rejects.toBeInstanceOf(PublisherConfirmTimeoutError);
    proxy.thaw();
    expect(notices).toEqual([
      ['warn', `rabbitmq_confirm_timeout eventId=${stalled.id} name=probe.stalled timeoutMs=500 outcome=unconfirmed — delivery state unknown (the broker may have stored it); not treated as sent, so it is sent again (at least once)`],
    ]);
    expect(JSON.stringify(notices)).not.toMatch(/guest|payload-secret-4242/);
  });

  it('a lost consumer is a warn, its recovery an info, and a dead-letter an error', async () => {
    const notices: Array<[NoticeLevel, string]> = [];
    const exchange = `nawara.events.obs${uniq()}`;
    const queue = `observ.q${uniq()}`;
    const bus = new RabbitMqEventBus({ url: proxy.url, exchange, connectTimeoutMs: 500, consumerReconnect: { baseDelayMs: 50, maxDelayMs: 200 }, onNotice: (m, l) => notices.push([l, m]) });
    closers.push(() => bus.close());
    const handled: string[] = [];
    await bus.subscribe({
      queue,
      bindings: ['probe.#'],
      handler: async (e) => {
        handled.push(e.id);
        throw new PermanentEventFailure('invalid_payload');
      },
    });
    await proxy.sever();
    await waitFor(() => notices.some(([, m]) => m.startsWith('rabbitmq_consumer_lost')));
    await proxy.start();
    await waitFor(() => notices.some(([, m]) => m.startsWith('rabbitmq_consumer_recovered')));

    const publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange });
    closers.push(() => publisher.close());
    const poison = envelope('probe.poison');
    await publisher.publish(poison);
    await waitFor(() => notices.some(([, m]) => m.startsWith('event_dead_lettered')));

    const level = (prefix: string) => notices.find(([, m]) => m.startsWith(prefix))?.[0];
    expect(level('rabbitmq_consumer_lost')).toBe('warn');
    expect(level('rabbitmq_consumer_recovered')).toBe('info');
    expect(level('event_dead_lettered')).toBe('error');
    expect(notices.find(([, m]) => m.startsWith('event_dead_lettered'))?.[1]).toBe(
      `event_dead_lettered queue=${queue} event=${poison.id} correlationId=corr-observ-0002 classification=permanent reason=invalid_payload retries=0 error=PermanentEventFailure`,
    );
    expect(JSON.stringify(notices)).not.toMatch(/guest|payload-secret-4242/);
  });
});

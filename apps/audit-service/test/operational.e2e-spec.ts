import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { RabbitMqEventBus, generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { BrokerNotices } from '../src/ingestion/broker-notices.js';
import { AUDIT_EXCHANGE, AUDIT_QUEUE } from '../src/ingestion/ingestion.constants.js';
import { ALL_LOGS, createTestApp, type TestApp } from './support/app.js';
import { brokerManagement } from './support/broker-mgmt.js';
import { DEAD_QUEUE, RETRY_QUEUE, auditEnvelope, deleteAuditQueues, depth, publishRaw } from './support/broker.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

const SECRET = 'STAGE18_SECRET_MARKER';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** Measurements for the Stage 18.9 record (environment-specific; written only when STAGE189_MEASURE_FILE is set). */
const measured: Record<string, unknown> = {};

/**
 * Stage 18.9 — operational hardening, on a REAL PostgreSQL 16 and a REAL RabbitMQ 3.13 (faults injected through the broker's own
 * management API and PostgreSQL's own connection controls; nothing mocked where the guarantee depends on their semantics).
 */
describeWithEnv('audit operational hardening (real PostgreSQL 16, real RabbitMQ 3.13)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_MGMT_URL'], (env) => {
  let d: ProvisionedDatabase;
  let conn: ChannelModel;
  let ch: Channel;
  let mgmt: ReturnType<typeof brokerManagement>;
  const apps: TestApp[] = [];
  const reader = generateServiceToken();

  const until = (cond: () => Promise<boolean> | boolean, timeout = 30_000) => vi.waitFor(async () => expect(await cond()).toBe(true), { timeout, interval: 100 });
  const start = async (o: { delayMs?: number; notices?: BrokerNotices; logs?: string[] } = {}) => {
    const notices = o.notices ?? new BrokerNotices();
    const bus = new RabbitMqEventBus({
      url: env.TEST_RABBITMQ_URL, exchange: AUDIT_EXCHANGE, prefetch: 5, connectTimeoutMs: 1500, retry: { maxRetries: 1, delayMs: o.delayMs ?? 300 },
      onNotice: (m, l) => {
        o.logs?.push(m);
        notices.observe(m, l);
      },
    });
    const t = await createTestApp({ databaseUrl: d.appUrl, rabbitmqUrl: env.TEST_RABBITMQ_URL, bus, brokerNotices: notices, tokens: [{ caller: 'reader', digest: reader.digest }] });
    apps.push(t);
    await until(async () => (await request(t.app.getHttpServer()).get('/ready')).status === 200);
    return { t, notices };
  };
  const close = async (t: TestApp) => {
    apps.splice(apps.indexOf(t), 1);
    const began = Date.now();
    await t.app.close();
    return Date.now() - began;
  };
  const rows = async (where = 'TRUE', params: unknown[] = []) => (await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_record WHERE ${where}`, params))[0]!.n;

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'aops');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    await sql(d.migratorUrl, `SELECT audit_grant_retention($1::regrole)`, [d.retention]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    ch = await conn.createChannel();
    ch.on('error', () => undefined);
    await deleteAuditQueues(ch);
    mgmt = brokerManagement(env.TEST_RABBITMQ_MGMT_URL, conn);
  });
  afterEach(async () => {
    await mgmt.acceptPublishes().catch(() => undefined);
    for (const t of apps.splice(0)) await t.app.close();
    for (const q of [AUDIT_QUEUE, RETRY_QUEUE, DEAD_QUEUE]) await ch.purgeQueue(q).catch(() => undefined);
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS true`).catch(() => undefined);
  });
  afterAll(async () => {
    if (process.env.STAGE189_MEASURE_FILE) writeFileSync(process.env.STAGE189_MEASURE_FILE, JSON.stringify(measured, null, 2));
    await deleteAuditQueues(ch).catch(() => undefined);
    await conn?.close().catch(() => undefined);
    await d?.drop();
  });

  // ────────────────────────────────────────────────────────────────────────── O1: the sanitized dead-letter copy cannot be confirmed

  it('O1: the broker REFUSES the sanitized DLQ copy → the raw original is never dead-lettered, never acked, held and requeued at a bounded rate; shutdown stays bounded; once the DLQ accepts, exactly one REDACTED copy lands', async () => {
    const logs: string[] = [];
    const { t } = await start({ delayMs: 400, logs });
    await mgmt.rejectPublishes(DEAD_QUEUE);
    const e = auditEnvelope('membership.revoked', { payload: { ...auditEnvelope('membership.revoked').payload, changes: { password: SECRET } } });
    await publishRaw(ch, { routingKey: e.name, type: e.name, messageId: e.id, body: JSON.stringify(e.payload), headers: { ...e.headers, 'x-debug': SECRET } });

    await until(() => logs.filter((m) => m.startsWith('event_dead_letter_deferred')).length >= 2);
    const window = 4000;
    const before = logs.filter((m) => m.startsWith('event_dead_letter_deferred')).length;
    await new Promise((r) => setTimeout(r, window));
    const deferrals = logs.filter((m) => m.startsWith('event_dead_letter_deferred')).length - before;
    // Held 400 ms per attempt (plus the refusal round trip): ~10 in 4 s. A tight requeue loop would be hundreds or thousands.
    expect(deferrals).toBeGreaterThanOrEqual(3);
    expect(deferrals).toBeLessThanOrEqual(Math.ceil(window / 400) + 2);
    measured.o1_deferrals_per_4s = deferrals;
    expect(await depth(ch, DEAD_QUEUE)).toBe(0); // nothing — above all not the raw original — reached the DLQ
    expect(await rows()).toBe(0);
    // Not lost is proven AUTHORITATIVELY below (Stage 18.10): after shutdown the message is back in the work queue — an acknowledged or
    // dead-lettered message could not be. (18.9 read the management API's sampled statistics here; they lag and are not evidence.)

    // SHUTDOWN during the fault: bounded (the hold ends at once), the message stays in the work queue for the next instance.
    const shutdownMs = await close(t);
    measured.o1_shutdown_ms_during_fault = shutdownMs;
    expect(shutdownMs).toBeLessThan(5000);
    expect(await depth(ch, AUDIT_QUEUE)).toBe(1); // authoritative: never acknowledged, never dead-lettered, not lost
    expect(await depth(ch, DEAD_QUEUE)).toBe(0);

    // Recovery: a new instance, the DLQ accepts again → sanitized again, confirmed, only then the original is acknowledged.
    const { notices } = await start({ delayMs: 400 });
    await mgmt.acceptPublishes();
    await until(async () => (await depth(ch, DEAD_QUEUE)) === 1 && (await depth(ch, AUDIT_QUEUE)) === 0);
    const m = await ch.get(DEAD_QUEUE, { noAck: true });
    if (!m) throw new Error('no dead letter');
    expect(m.properties.headers?.['x-nawara-body-redacted']).toBe('true');
    expect(m.content.toString('latin1') + JSON.stringify(m.properties.headers)).not.toContain(SECRET);
    expect(notices.drain().counts).toMatchObject({ dead_lettered: 1, dead_letter_redacted: 1, dead_lettered_permanent: 1 });
    expect(ALL_LOGS.map((l) => JSON.stringify(l)).join('\n')).not.toContain(SECRET);
  }, 90_000);

  // ────────────────────────────────────────────────────────────────────────────────────────────── floods, counters, log budget

  it('a FLOOD of malformed and refused messages: every one dead-lettered and counted exactly; per-event log lines stay within the budget; the snapshot says what was suppressed', async () => {
    const logs: string[] = [];
    const firstLine = ALL_LOGS.length; // the suite shares one log capture: count this test's lines only
    const { t } = await start({ logs });
    const n = 150;
    for (let i = 0; i < n; i++) await publishRaw(ch, { toQueue: true, messageId: randomUUID(), type: 'audit.membership.revoked', body: `garbage ${i}` });
    for (let i = 0; i < n; i++) {
      const e = auditEnvelope('membership.revoked', { payload: { ...auditEnvelope('membership.revoked').payload, note: `x${i}` } });
      await publishRaw(ch, { routingKey: e.name, type: e.name, messageId: e.id, body: JSON.stringify(e.payload), headers: { ...e.headers } });
    }
    await until(async () => (await depth(ch, DEAD_QUEUE)) === 2 * n, 60_000);
    const since = ALL_LOGS.length;
    await close(t); // the shutdown snapshot carries the interval's counters
    const snap = ALL_LOGS.slice(since).map((l) => String(l.msg)).find((m) => m.startsWith('audit_ops_snapshot'))!;
    expect(snap).toMatch(new RegExp(`\\brefused=${n}\\b`));
    expect(snap).toMatch(new RegExp(`\\brefused_unknown_field=${n}\\b`));
    expect(snap).toMatch(new RegExp(`\\bdead_lettered=${2 * n}\\b`));
    expect(snap).toMatch(new RegExp(`\\bdead_letter_redacted=${2 * n}\\b`));
    expect(snap).toMatch(new RegExp(`\\bdead_lettered_malformed=${n}\\b`));
    const suppressed = Number(/logs_suppressed=(\d+)/.exec(snap)![1]);
    expect(suppressed).toBeGreaterThan(0);
    const written = ALL_LOGS.slice(firstLine).map((l) => String(l.msg));
    expect(written.filter((m) => m.startsWith('event_dead_lettered')).length).toBeLessThanOrEqual(20);
    expect(written.filter((m) => m.startsWith('audit_event_refused reason=unknown_field')).length).toBeLessThanOrEqual(20);
    expect(logs).toHaveLength(2 * n); // every notice was still emitted and counted; only the writing is budgeted
    measured.flood = { messages: 2 * n, logLinesSuppressed: suppressed };
    // No label in the snapshot is an id: every key=value key is from a closed set.
    for (const kv of snap.split(' ').slice(1)) expect(kv).toMatch(/^[a-z_]+=[a-z0-9_-]+$/);
  }, 120_000);

  // ────────────────────────────────────────────────────────────────────────────────────────────── query with the database gone

  it('a QUERY while PostgreSQL refuses connections fails closed (5xx, never an empty 200); it answers again once the database returns', async () => {
    const { t } = await start();
    const org = randomUUID();
    const url = `/audit/organizations/${org}/records?from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date().toISOString()}`;
    expect((await request(t.app.getHttpServer()).get(url).set('authorization', `Bearer ${reader.token}`)).status).toBe(200);
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS false`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [d.name]);
    const down = await request(t.app.getHttpServer()).get(url).set('authorization', `Bearer ${reader.token}`);
    expect(down.status).toBeGreaterThanOrEqual(500);
    expect(down.body.items).toBeUndefined();
    expect((await request(t.app.getHttpServer()).get('/ready')).status).toBe(503);
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${d.name}" WITH ALLOW_CONNECTIONS true`);
    await until(async () => (await request(t.app.getHttpServer()).get(url).set('authorization', `Bearer ${reader.token}`)).status === 200);
    await until(async () => (await request(t.app.getHttpServer()).get('/ready')).status === 200);
  }, 60_000);

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────── backlog recovery

  it('BACKLOG: 3 000 events published while Audit is down are drained once it starts — every one stored once, nothing dead-lettered, bounded memory', async () => {
    const { t } = await start();
    await close(t); // the topology exists; Audit is now down
    const publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: AUDIT_EXCHANGE });
    const n = 3000;
    const ids: string[] = [];
    try {
      for (let i = 0; i < n; i++) {
        const e = auditEnvelope((['membership.revoked', 'invoice.issued', 'file.deleted', 'payment.created'] as const)[i % 4]);
        ids.push(e.id);
        await publisher.publish(e);
      }
    } finally {
      await publisher.close();
    }
    expect(await depth(ch, AUDIT_QUEUE)).toBe(n);
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const began = Date.now();
    const curve: Array<[number, number]> = [];
    await start();
    await until(async () => {
      const left = await depth(ch, AUDIT_QUEUE);
      curve.push([Date.now() - began, left]);
      return (await rows(`"eventId" = ANY($1::uuid[])`, [ids])) === n;
    }, 180_000);
    const ms = Date.now() - began;
    const heapGrowthMb = Math.round((process.memoryUsage().heapUsed - heapBefore) / 1e5) / 10;
    expect(await depth(ch, DEAD_QUEUE)).toBe(0);
    expect(await rows(`"eventId" = ANY($1::uuid[])`, [ids])).toBe(n);
    measured.backlog = { events: n, drainMs: ms, perSecond: Math.round((n * 1000) / ms), heapGrowthMb, depthCurve: curve.filter((_, i) => i % 5 === 0).slice(0, 20) };
  }, 240_000);

  // ────────────────────────────────────────────────────────────────────────────────────────────── retention: killed, disconnected

  const DAY = 24 * 60;
  const seedAged = async (category: string, count: number, ageMinutes: number) => {
    await sql(d.adminUrl, `ALTER TABLE audit_record DISABLE TRIGGER audit_record_stamp`);
    try {
      await sql(d.adminUrl,
        `INSERT INTO audit_record ("eventId", "sourceService", action, category, "schemaVersion", "actorType", "actorId", "resourceType", "resourceId", outcome, "occurredAt", "recordedAt")
         SELECT gen_random_uuid(), 'billing-service', 'test.retention_case', $1, 1, 'service', 'billing-service', 'invoice', gen_random_uuid()::text, 'succeeded',
                now() - make_interval(mins => $3 + g), now() - make_interval(mins => $3 + g)
           FROM generate_series(1, $2) g`, [category, count, ageMinutes]);
    } finally {
      await sql(d.adminUrl, `ALTER TABLE audit_record ENABLE TRIGGER audit_record_stamp`);
    }
  };
  const retentionCli = (...args: string[]) =>
    spawn('node', ['dist/cli/retention.js', ...args], { cwd: ROOT, env: { ...process.env, RETENTION_DATABASE_URL: d.retentionUrl }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = (p: ReturnType<typeof spawn>) => new Promise<number | null>((r) => p.on('exit', (code) => r(code)));
  const ledgerSum = async () => (await sql<{ s: number }>(d.adminUrl, `SELECT COALESCE(sum(deleted), 0)::int AS s FROM audit_retention_run WHERE category = 'administrative'`))[0]!.s;
  const resetRetention = async () => {
    await sql(d.adminUrl, `DELETE FROM audit_retention_policy`);
    await sql(d.adminUrl, `ALTER TABLE audit_record DISABLE TRIGGER audit_record_no_update_delete`);
    await sql(d.adminUrl, `DELETE FROM audit_record WHERE action = 'test.retention_case'`);
    await sql(d.adminUrl, `ALTER TABLE audit_record ENABLE TRIGGER audit_record_no_update_delete`);
    await sql(d.adminUrl, `ALTER TABLE audit_retention_run DISABLE TRIGGER audit_retention_run_no_update_delete`);
    await sql(d.adminUrl, `DELETE FROM audit_retention_run`);
    await sql(d.adminUrl, `ALTER TABLE audit_retention_run ENABLE TRIGGER audit_retention_run_no_update_delete`);
  };

  it.each([
    ['SIGKILL (the process dies mid-run)', async (p: ReturnType<typeof spawn>) => void p.kill('SIGKILL')],
    ['its database connection is terminated mid-run', async () => void (await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'audit-service-retention'`))],
  ])('RETENTION interrupted — %s: committed batches stay deleted AND ledgered (deleted rows = ledger sum), nothing inside the horizon is touched, a rerun finishes', async (_label, interrupt) => {
    await resetRetention();
    await sql(d.migratorUrl, `INSERT INTO audit_retention_policy(category, "retainDays") VALUES ('administrative', 30)`);
    const old = 60_000;
    await seedAged('administrative', old, 40 * DAY);
    await seedAged('administrative', 500, 29 * DAY); // inside the horizon
    const total = async () => rows(`action = 'test.retention_case'`);
    const p = retentionCli('--batch-size', '500');
    const exit = exited(p);
    await until(async () => (await ledgerSum()) >= 1500, 60_000);
    await interrupt(p);
    await exit;
    const left = await total();
    expect(old + 500 - left).toBe(await ledgerSum()); // every deletion is ledgered, no ledger row without its deletion
    expect(await ledgerSum()).toBeLessThan(old); // it really was interrupted
    const rerun = retentionCli('--batch-size', '5000');
    expect(await exited(rerun)).toBe(0);
    expect(await total()).toBe(500); // exactly the rows inside the horizon remain
    expect(await ledgerSum()).toBe(old);
  }, 180_000);

  it('RETENTION alongside live ingestion and queries: the purge completes, every new event is stored, every query answers', async () => {
    await resetRetention();
    await sql(d.migratorUrl, `INSERT INTO audit_retention_policy(category, "retainDays") VALUES ('administrative', 30)`);
    await seedAged('administrative', 30_000, 40 * DAY);
    const { t } = await start();
    const publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: AUDIT_EXCHANGE });
    const ids: string[] = [];
    const cli = retentionCli('--batch-size', '1000');
    const exit = exited(cli);
    const org = randomUUID();
    const from = new Date(Date.now() - 3_600_000).toISOString();
    let queries = 0;
    try {
      for (let i = 0; i < 300; i++) {
        const e = auditEnvelope('file.deleted');
        ids.push(e.id);
        await publisher.publish(e);
        if (i % 30 === 0) {
          const r = await request(t.app.getHttpServer()).get(`/audit/organizations/${org}/records?from=${from}&to=${new Date().toISOString()}`).set('authorization', `Bearer ${reader.token}`);
          expect(r.status).toBe(200);
          queries += 1;
        }
      }
    } finally {
      await publisher.close();
    }
    expect(await exit).toBe(0);
    await until(async () => (await rows(`"eventId" = ANY($1::uuid[])`, [ids])) === 300);
    expect(await rows(`action = 'test.retention_case'`)).toBe(0);
    expect(queries).toBe(10);
  }, 180_000);
});

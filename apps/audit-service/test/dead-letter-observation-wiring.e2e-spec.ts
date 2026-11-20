import amqp, { type Channel, type ChannelModel } from 'amqplib';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { DEAD_LETTER_HEADER, RabbitMqEventBus, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { DeadLetterObservationService } from '../src/diagnostics/dead-letter-observation.service.js';
import { AUDIT_EXCHANGE, AUDIT_QUEUE } from '../src/ingestion/ingestion.constants.js';
import { createTestApp, type TestApp } from './support/app.js';
import { DEAD_QUEUE, RETRY_QUEUE, auditEnvelope, deleteAuditQueues, depth, publishRaw } from './support/broker.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Core V2 DO-43c (the Owner's D43-1 to D43-3, D43-8 and safety requirements 3, 6, 8, 9; DEVELOPMENT AND SIMULATION DIAGNOSTICS ONLY) over a
 * REAL RabbitMQ and a REAL PostgreSQL 16, through the real module graph, as the runtime role: Audit observes its own dead-letter transfers
 * only with AUDIT_DEAD_LETTER_OBSERVATION=enabled; the copy and the settlement are the same with and without it; an Audit database that
 * refuses the observations loses them (counted), never the dead letter; each process start is a new coverage instance.
 */
type Copy = { headers: Record<string, unknown>; messageId: unknown };

describeWithEnv('DO-43c Audit dead-letter observation wiring (real RabbitMQ, real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let d: ProvisionedDatabase;
  let conn: ChannelModel;
  let ch: Channel;
  const apps: TestApp[] = [];

  const start = async (enabled: boolean) => {
    const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: AUDIT_EXCHANGE, prefetch: 5, retry: { maxRetries: 1, delayMs: 200 }, connectTimeoutMs: 1500 });
    const t = await createTestApp({ databaseUrl: d.appUrl, rabbitmqUrl: env.TEST_RABBITMQ_URL, bus, env: enabled ? { AUDIT_DEAD_LETTER_OBSERVATION: 'enabled' } : {} });
    apps.push(t);
    await vi.waitFor(async () => expect((await request(t.app.getHttpServer()).get('/ready')).body).toEqual({ status: 'ready' }), { timeout: 20_000, interval: 100 });
    return t;
  };
  const until = (cond: () => Promise<boolean> | boolean, timeout = 20_000) => vi.waitFor(async () => expect(await cond()).toBe(true), { timeout, interval: 100 });
  /** An admitted-shape envelope with an unknown field: refused at admission → dead-lettered at once (permanent). */
  const refused = async (): Promise<EventEnvelope> => {
    const e = auditEnvelope('membership.revoked');
    await publishRaw(ch, { routingKey: e.name, type: e.name, messageId: e.id, body: JSON.stringify({ ...e.payload, note: 'x' }), headers: { ...e.headers } });
    return e;
  };
  const takeDead = async (): Promise<Copy> => {
    let got: Copy | undefined;
    await until(async () => {
      const m = await ch.get(DEAD_QUEUE, { noAck: true });
      if (m) got = { headers: m.properties.headers ?? {}, messageId: m.properties.messageId };
      return got !== undefined;
    });
    return got!;
  };
  const transitions = (eventId: string) =>
    sql<{ attemptId: string; transition: string; instanceId: string }>(d.adminUrl, `SELECT "attemptId", transition, "instanceId" FROM audit_dead_letter_transition WHERE "eventId" = $1 ORDER BY transition`, [eventId]);
  const coverage = (instanceId: string) =>
    sql<{ kind: string; seq: number; persistedTotal: number; droppedSink: number }>(d.adminUrl,
      `SELECT kind, seq::int AS seq, "persistedTotal"::int AS "persistedTotal", "droppedSink"::int AS "droppedSink" FROM audit_dead_letter_coverage WHERE "instanceId" = $1 ORDER BY seq`, [instanceId]);

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'adlwire');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    ch = await conn.createChannel();
    ch.on('error', () => undefined);
    await deleteAuditQueues(ch);
  });
  afterEach(async () => {
    for (const t of apps.splice(0)) await t.app.close();
    for (const q of [AUDIT_QUEUE, RETRY_QUEUE, DEAD_QUEUE]) await ch.purgeQueue(q).catch(() => undefined);
    await sql(d.adminUrl, `GRANT INSERT ON audit_dead_letter_transition TO ${d.app}`).catch(() => undefined);
  });
  afterAll(async () => {
    await deleteAuditQueues(ch).catch(() => undefined);
    await conn?.close().catch(() => undefined);
    await d?.drop();
  });

  it('enabled: attempted → transfer_confirmed for exactly the attempt id on the copy; started at boot, stopped after the final flush', async () => {
    const t = await start(true);
    const obs = t.app.get(DeadLetterObservationService);
    const e = await refused();
    const copy = await takeDead();
    expect(copy.messageId).toBe(e.id);
    const attemptId = copy.headers[DEAD_LETTER_HEADER.deadLetterAttempt];
    expect(attemptId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    await obs.flush();
    expect(await transitions(e.id)).toEqual([
      { attemptId, transition: 'attempted', instanceId: obs.instanceId },
      { attemptId, transition: 'transfer_confirmed', instanceId: obs.instanceId },
    ]);
    await obs.heartbeat();
    await t.app.close();
    apps.splice(0);
    const facts = await coverage(obs.instanceId);
    expect(facts.map((f) => [f.kind, f.seq])).toEqual([['started', 0], ['heartbeat', 1], ['stopped', 2]]);
    expect(facts.at(-1)!.persistedTotal).toBe(2);
    expect(await depth(ch, AUDIT_QUEUE)).toBe(0);
  });

  it('disabled (the default): no observer, no attempt header, no row; the copy and the settlement are the same as enabled', async () => {
    const run = async (enabled: boolean) => {
      await start(enabled);
      const e = await refused();
      const copy = await takeDead();
      await until(async () => (await depth(ch, AUDIT_QUEUE)) === 0);
      for (const t of apps.splice(0)) await t.app.close();
      const { [DEAD_LETTER_HEADER.failedAt]: _t, [DEAD_LETTER_HEADER.deadLetterAttempt]: attempt, ...headers } = copy.headers;
      return { attempt, headers: Object.keys(headers).sort(), failure: headers[DEAD_LETTER_HEADER.failure], reason: headers[DEAD_LETTER_HEADER.failureReason], rows: (await transitions(e.id)).length };
    };
    const off = await run(false);
    const on = await run(true);
    expect(off.attempt).toBeUndefined();
    expect(off.rows).toBe(0);
    expect(on.attempt).toEqual(expect.any(String));
    expect({ headers: on.headers, failure: on.failure, reason: on.reason }).toEqual({ headers: off.headers, failure: off.failure, reason: off.reason });
  });

  it('an Audit database that refuses the observations: the dead letter still happens; the batch is lost and COUNTED in coverage', async () => {
    const t = await start(true);
    const obs = t.app.get(DeadLetterObservationService);
    await sql(d.adminUrl, `REVOKE INSERT ON audit_dead_letter_transition FROM ${d.app}`);
    const e = await refused();
    const copy = await takeDead();
    expect(copy.headers[DEAD_LETTER_HEADER.deadLetterAttempt]).toEqual(expect.any(String));
    await until(async () => (await depth(ch, AUDIT_QUEUE)) === 0);
    await obs.flush();
    expect(obs.stats()).toMatchObject({ droppedSink: 2, persistedTotal: 0, buffered: 0 });
    expect(await transitions(e.id)).toEqual([]); // a missing observation, never a false outcome
    await obs.heartbeat();
    const facts = await coverage(obs.instanceId);
    expect(facts.at(-1)).toMatchObject({ kind: 'heartbeat', droppedSink: 2 });
  });

  it('every process start is a new coverage instance (a restart never continues or resets another instance\'s counters)', async () => {
    const first = (await start(true)).app.get(DeadLetterObservationService).instanceId;
    for (const t of apps.splice(0)) await t.app.close();
    const second = (await start(true)).app.get(DeadLetterObservationService).instanceId;
    expect(second).not.toBe(first);
    await until(async () => (await coverage(second)).length >= 1);
    expect((await coverage(second))[0]).toMatchObject({ kind: 'started', seq: 0 });
    expect((await coverage(first)).at(-1)).toMatchObject({ kind: 'stopped' });
  });
});

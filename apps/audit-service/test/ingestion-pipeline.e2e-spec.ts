import amqp, { type Channel, type ChannelModel } from 'amqplib';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { AuditEventWriter } from '@nawara/audit-contract';
import { SAMPLE_IDS, sampleAuditPayload } from '@nawara/audit-contract/testing';
import { OutboxRelay, OutboxService, RabbitMqEventBus, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { auditMigrationsDir } from '../src/app.module.js';
import { AUDIT_EXCHANGE } from '../src/ingestion/ingestion.constants.js';
import { createTestApp, type TestApp } from './support/app.js';
import { DEAD_QUEUE, deleteAuditQueues, depth } from './support/broker.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * Stage 18.5 §48–§50: the WHOLE asynchronous path, every piece real and unmodified. A test producer (its own database with the kit
 * outbox and a stand-in business table — no real Core producer is touched) writes a business row and its audit intent with
 * `AuditEventWriter` in ONE transaction; the kit `OutboxRelay` publishes through the kit RabbitMQ bus (source = the producer's configured
 * name); audit-service, built exactly as `main.ts` builds it (its production bus: default retry, prefetch from the pool), consumes and
 * stores. No HTTP request ever reaches audit-service.
 */
describeWithEnv('producer transaction → outbox → relay → RabbitMQ → audit-service → audit_record (all real)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let producerDb: TestDatabase;
  let auditDb: ProvisionedDatabase;
  let producerPool: pg.Pool;
  let relayBus: RabbitMqEventBus;
  let relay: OutboxRelay;
  let audit: TestApp;
  let conn: ChannelModel;
  let ch: Channel;
  let httpRequests = 0;
  const writer = new AuditEventWriter({ sourceService: 'billing-service', outbox: new OutboxService() });

  async function inTransaction<T>(fn: (c: pg.PoolClient) => Promise<T>, end: 'COMMIT' | 'ROLLBACK'): Promise<T> {
    const c = await producerPool.connect();
    try {
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query(end);
      return r;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  const auditRows = (eventId: string) => sql<Record<string, unknown>>(auditDb.adminUrl, `SELECT * FROM audit_record WHERE "eventId" = $1`, [eventId]);

  beforeAll(async () => {
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    ch = await conn.createChannel();
    ch.on('error', () => undefined);
    await deleteAuditQueues(ch);
    producerDb = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'auprod');
    await runMigrations(producerDb.url, [kitMigrationsDir]);
    producerPool = new pg.Pool({ connectionString: producerDb.url, max: 4 });
    await producerPool.query(`CREATE TABLE invoice_stand_in (id uuid PRIMARY KEY, "organizationId" uuid NOT NULL, status text NOT NULL)`);
    relayBus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: AUDIT_EXCHANGE });
    relay = new OutboxRelay({ tx: (fn) => inTransaction(fn, 'COMMIT') }, relayBus, { source: 'billing-service' });

    auditDb = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'aupipe');
    await runMigrations(auditDb.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    audit = await createTestApp({ databaseUrl: auditDb.appUrl, rabbitmqUrl: env.TEST_RABBITMQ_URL }); // the production bus, no override
    audit.app.getHttpServer().on('request', () => void (httpRequests += 1));
    await vi.waitFor(async () => expect((await request(audit.app.getHttpServer()).get('/ready')).body).toEqual({ status: 'ready' }), { timeout: 20_000, interval: 200 });
    httpRequests = 0; // the readiness polls above are the test's, not the pipeline's
  });
  afterAll(async () => {
    await audit?.app.close();
    await relayBus?.close();
    await producerPool?.end();
    await producerDb?.drop();
    await auditDb?.drop();
    await deleteAuditQueues(ch).catch(() => undefined);
    await conn?.close().catch(() => undefined);
  });

  it('COMMIT: the business row and the audit intent commit together; the relay publishes; audit-service stores the record, field for field', async () => {
    const invoiceId = SAMPLE_IDS.resource;
    const input = { ...sampleAuditPayload('invoice.issued', 'minimal'), resource: { type: 'invoice', id: invoiceId } };
    const { eventId, txNow } = await inTransaction(async (c) => {
      await c.query(`INSERT INTO invoice_stand_in VALUES ($1, $2, 'open')`, [invoiceId, SAMPLE_IDS.organization]);
      const { rows } = await c.query<{ now: Date }>('SELECT now()');
      const r = await writer.write(c, input as never, { correlationId: 'pipeline-corr-0001' });
      return { eventId: r.eventId, txNow: rows[0]!.now };
    }, 'COMMIT');

    expect((await producerPool.query(`SELECT count(*)::int AS n FROM invoice_stand_in`)).rows[0].n).toBe(1);
    expect((await producerPool.query(`SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NULL`)).rows[0].n).toBe(1);
    expect(await relay.drainOnce()).toEqual({ published: 1, failed: 0 });
    expect((await producerPool.query(`SELECT count(*)::int AS n FROM outbox WHERE "publishedAt" IS NOT NULL`)).rows[0].n).toBe(1);

    await vi.waitFor(async () => expect(await auditRows(eventId)).toHaveLength(1), { timeout: 20_000, interval: 100 });
    const [r] = await auditRows(eventId);
    expect(r).toMatchObject({
      eventId, sourceService: 'billing-service', action: 'invoice.issued', category: 'commercial', schemaVersion: 1,
      actorType: input.actor.type, actorId: input.actor.id, userKind: input.actor.type === 'user' ? input.actor.userKind : null,
      organizationId: SAMPLE_IDS.organization, resourceType: 'invoice', resourceId: invoiceId, subjectType: null, subjectId: null,
      outcome: 'succeeded', changes: null, correlationId: 'pipeline-corr-0001', causationId: null,
    });
    // occurredAt is the producer's business-transaction time (the relay carries it at millisecond precision).
    expect((r!.occurredAt as Date).getTime()).toBe(Math.floor(txNow.getTime()));
    expect((r!.recordedAt as Date).getTime()).toBeGreaterThanOrEqual((r!.occurredAt as Date).getTime());
    expect(await depth(ch, DEAD_QUEUE)).toBe(0);
    expect(httpRequests).toBe(0); // no synchronous call to audit-service at any point
  }, 60_000);

  it('ROLLBACK: no business row, no outbox event, nothing published, no audit record', async () => {
    const before = await sql<{ n: number }>(auditDb.adminUrl, 'SELECT count(*)::int AS n FROM audit_record');
    const invoiceId = SAMPLE_IDS.uuidA;
    let eventId = '';
    await inTransaction(async (c) => {
      await c.query(`INSERT INTO invoice_stand_in VALUES ($1, $2, 'open')`, [invoiceId, SAMPLE_IDS.organization]);
      eventId = (await writer.write(c, { ...sampleAuditPayload('invoice.discarded', 'minimal'), resource: { type: 'invoice', id: invoiceId } } as never)).eventId;
    }, 'ROLLBACK');
    expect((await producerPool.query(`SELECT count(*)::int AS n FROM invoice_stand_in WHERE id = $1`, [invoiceId])).rows[0].n).toBe(0);
    expect((await producerPool.query(`SELECT count(*)::int AS n FROM outbox WHERE id = $1`, [eventId])).rows[0].n).toBe(0);
    expect(await relay.drainOnce()).toEqual({ published: 0, failed: 0 });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await auditRows(eventId)).toHaveLength(0);
    expect(await sql<{ n: number }>(auditDb.adminUrl, 'SELECT count(*)::int AS n FROM audit_record')).toEqual(before);
    expect(httpRequests).toBe(0);
  }, 30_000);

  it('a relay re-publish of the same outbox row (at least once) is absorbed: still one record', async () => {
    const id = SAMPLE_IDS.uuidB;
    const { eventId } = await inTransaction(
      (c) => writer.write(c, { ...sampleAuditPayload('payment_request.created', 'minimal'), resource: { type: 'payment_request', id } } as never),
      'COMMIT',
    );
    expect(await relay.drainOnce()).toEqual({ published: 1, failed: 0 });
    // The relay crashed between publish and stamp: the row is unpublished again and relayed a second time.
    await producerPool.query(`ALTER TABLE outbox DISABLE TRIGGER outbox_immutable`);
    await producerPool.query(`UPDATE outbox SET "publishedAt" = NULL WHERE id = $1`, [eventId]);
    await producerPool.query(`ALTER TABLE outbox ENABLE TRIGGER outbox_immutable`);
    expect(await relay.drainOnce()).toEqual({ published: 1, failed: 0 });
    await vi.waitFor(async () => expect(audit.logs.some((l) => String(l.msg).startsWith(`audit_event_duplicate eventId=${eventId}`))).toBe(true), { timeout: 20_000, interval: 100 });
    expect(await auditRows(eventId)).toHaveLength(1);
    expect(await depth(ch, DEAD_QUEUE)).toBe(0);
  }, 40_000);
});

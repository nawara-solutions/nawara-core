import { randomUUID } from 'node:crypto';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MetricsHost, RabbitMqEventBus, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { auditMigrationsDir } from '../src/app.module.js';
import { AUDIT_EXCHANGE, AUDIT_QUEUE } from '../src/ingestion/ingestion.constants.js';
import { createTestApp, type TestApp } from './support/app.js';
import { auditEnvelope, deleteAuditQueues, publishRaw } from './support/broker.js';
import { describeWithEnv } from './support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from './support/roles.js';

/**
 * V2 A12.3: audit-service's ingestion bus (its own token, wired explicitly in main.ts and the test helper) feeds the kit messaging
 * metrics. The audit binding is the wildcard `audit.#`, so incoming names are attacker-influenced: the metrics label only the consumer's
 * own queue and a closed outcome, never an event name, id, header or payload. Off by default.
 */
describeWithEnv('audit-service messaging metrics (real RabbitMQ, real PostgreSQL 16)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let d: ProvisionedDatabase;
  let conn: ChannelModel;
  let ch: Channel;
  let t: TestApp;
  let publisher: RabbitMqEventBus;
  const hostile = { name: `audit.x${randomUUID().replace(/-/g, '')}`, id: `mid-HOSTILE-${randomUUID()}`, org: `org-${randomUUID()}`, email: 'hostile.audit@example.org' };

  beforeAll(async () => {
    d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'amet');
    await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    ch = await conn.createChannel();
    ch.on('error', () => undefined);
    await deleteAuditQueues(ch);
    const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: AUDIT_EXCHANGE, retry: { maxRetries: 0, delayMs: 50 }, connectTimeoutMs: 1500 });
    t = await createTestApp({ databaseUrl: d.appUrl, rabbitmqUrl: env.TEST_RABBITMQ_URL, bus, env: { METRICS_ENABLED: 'true', METRICS_PORT: '0' } });
    await vi.waitFor(async () => expect((await request(t.app.getHttpServer()).get('/ready')).body).toEqual({ status: 'ready' }), { timeout: 20_000, interval: 100 });
    publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: AUDIT_EXCHANGE });
  });
  afterAll(async () => {
    await t?.app.close();
    await publisher?.close();
    await deleteAuditQueues(ch).catch(() => undefined);
    await conn?.close().catch(() => undefined);
    await d?.drop();
  });

  const scrape = async () => {
    const addr = await t.app.get(MetricsHost).address();
    return (await fetch(`http://127.0.0.1:${addr!.port}/metrics`)).text();
  };
  const consumed = (body: string, outcome: string) =>
    Number(new RegExp(`^nawara_events_consumed_total\\{queue="${AUDIT_QUEUE.replace(/\./g, '\\.')}",outcome="${outcome}"\\} (\\d+)$`, 'm').exec(body)?.[1] ?? 0);

  it('counts processed and dead-lettered deliveries by the audit queue only; hostile names and values never become labels', async () => {
    await publisher.publish(auditEnvelope('membership.approved'));
    await publisher.publish({ ...auditEnvelope('membership.approved', { name: hostile.name, payload: { organizationId: hostile.org, email: hostile.email } }), id: hostile.id });
    await publishRaw(ch, { routingKey: 'audit.raw', type: 'NOT A NAME', messageId: hostile.id, body: `{"email":"${hostile.email}"` });
    await vi.waitFor(async () => {
      const body = await scrape();
      expect(consumed(body, 'processed')).toBeGreaterThanOrEqual(1);
      expect(consumed(body, 'dead_lettered_permanent') + consumed(body, 'dead_lettered_malformed')).toBeGreaterThanOrEqual(2);
    }, { timeout: 20_000, interval: 200 });
    const body = await scrape();
    expect(body).toMatch(new RegExp(`^nawara_event_consumer_up\\{queue="${AUDIT_QUEUE.replace(/\./g, '\\.')}"\\} 1$`, 'm'));
    expect(body).toContain('nawara_service_info{service="audit-service"} 1');
    for (const v of Object.values(hostile)) expect(body).not.toContain(v);
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    const queues = new Set([...body.matchAll(/queue="([^"]*)"/g)].map((m) => m[1]));
    expect([...queues]).toEqual([AUDIT_QUEUE]);
    expect(body).toMatch(/^nawara_db_pool_max_connections\{pool="main"\} \d+$/m); // the kit DbService pool, auto-discovered
  });
});

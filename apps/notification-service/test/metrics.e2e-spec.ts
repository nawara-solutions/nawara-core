import { randomUUID } from 'node:crypto';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { MetricsHost, RabbitMqEventBus, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { INTAKE_QUEUE } from '../src/intake/event-map.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

/**
 * V2 A12.3: notification-service's intake bus (its own token, wired explicitly in main.ts and the test helper) feeds the kit messaging
 * metrics: labelled by the intake queue and a closed outcome only. The destination, code, ids and payload never reach the exposition.
 */
describeWithEnv('notification-service messaging metrics (real RabbitMQ)', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let db: TestDatabase;
  let conn: ChannelModel;
  let ch: Channel;
  let t: TestApp;
  let publisher: RabbitMqEventBus;
  const PHONE = '+21620000123';
  const CODE = '917402';
  const deleteQueues = async () => {
    for (const q of [INTAKE_QUEUE, `${INTAKE_QUEUE}.retry`, `${INTAKE_QUEUE}.dead`]) await ch.deleteQueue(q).catch(() => undefined);
  };
  const event = (name: string, payload: Record<string, unknown>): EventEnvelope => {
    const id = randomUUID();
    return { id, name, payload, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'auth-service', version: 1, correlationId: `corr-HOSTILE-${id.slice(0, 8)}` } };
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifmet');
    await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    ch = await conn.createChannel();
    ch.on('error', () => undefined);
    await deleteQueues();
    t = await createTestApp({ databaseUrl: db.url, bus: 'rabbitmq', env: { RABBITMQ_URL: env.TEST_RABBITMQ_URL, METRICS_ENABLED: 'true', METRICS_PORT: '0' } });
    await vi.waitFor(async () => expect((await request(t.app.getHttpServer()).get('/ready')).status).toBe(200), { timeout: 20_000, interval: 100 });
    publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL });
  });
  afterAll(async () => {
    await t?.app.close();
    await publisher?.close();
    await deleteQueues().catch(() => undefined);
    await conn?.close().catch(() => undefined);
    await db?.drop();
  });

  const scrape = async () => {
    const addr = await t.app.get(MetricsHost).address();
    return (await fetch(`http://127.0.0.1:${addr!.port}/metrics`)).text();
  };

  it('counts intake deliveries by the intake queue and a closed outcome; no destination, code, id or header in the exposition', async () => {
    const ok = event('member.contact_verification_requested', { userId: `user-${randomUUID()}`, channel: 'phone', destination: PHONE, code: CODE, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    const bad = event('member.contact_verification_requested', { userId: 'HOSTILE-USER', channel: 'phone', destination: 'not-a-phone', code: CODE });
    await publisher.publish(ok);
    await publisher.publish(bad);
    const q = INTAKE_QUEUE.replace(/\./g, '\\.');
    await vi.waitFor(async () => {
      const body = await scrape();
      expect(body).toMatch(new RegExp(`^nawara_events_consumed_total\\{queue="${q}",outcome="processed"\\} [1-9]`, 'm'));
    }, { timeout: 20_000, interval: 200 });
    const body = await scrape();
    expect(body).toMatch(new RegExp(`^nawara_event_consumer_up\\{queue="${q}"\\} 1$`, 'm'));
    for (const v of [PHONE, CODE, ok.id, bad.id, 'HOSTILE', 'not-a-phone', ok.headers.correlationId!]) expect(body).not.toContain(v);
    const queues = new Set([...body.matchAll(/queue="([^"]*)"/g)].map((m) => m[1]));
    expect([...queues]).toEqual([INTAKE_QUEUE]);
    expect(body).toContain('nawara_service_info{service="notification-service"} 1');
  });
});

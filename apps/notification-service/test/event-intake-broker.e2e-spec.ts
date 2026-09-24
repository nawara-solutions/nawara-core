import { randomUUID } from 'node:crypto';
import amqp, { type Channel, type ChannelModel } from 'amqplib';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RabbitMqEventBus, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { BrokerProxy, createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { notificationMigrationsDir } from '../src/app.module.js';
import { INTAKE_QUEUE } from '../src/intake/event-map.js';
import { createTestApp, type TestApp } from './support/app.js';
import { sql } from './support/db.js';
import { describeWithEnv } from './support/env.js';

/**
 * Stage 16.5: the intake over a REAL RabbitMQ: the kit consumer on the durable queue `notification.events` bound to the mapped routing
 * keys of `nawara.events`, fed by a kit publisher exactly as Auth publishes (Stage 16.2). Proves routing, ACK after commit, DLQ,
 * idempotency across copies, crashes and restarts, the broker and database failure paths, readiness and the shutdown drain.
 * The queue name is the production one, so its three queues are deleted before and after (a local dev broker only).
 */
const EXCHANGE = 'nawara.events';
const DEAD = `${INTAKE_QUEUE}.dead`;
const CODE = '591730';
const PHONE = '+21620000007';

describeWithEnv('event intake over a real RabbitMQ', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  let db: TestDatabase;
  let conn: ChannelModel;
  let ch: Channel;
  let publisher: RabbitMqEventBus;
  const apps: TestApp[] = [];
  const dbName = () => new URL(db.url).pathname.slice(1);

  const count = async (where = 'true', params: unknown[] = []) => (await sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM notification WHERE ${where}`, params))[0].n;
  const depth = async (q: string) => (await ch.checkQueue(q)).messageCount;
  const deleteQueues = async () => {
    for (const q of [INTAKE_QUEUE, `${INTAKE_QUEUE}.retry`, DEAD]) await ch.deleteQueue(q).catch(() => undefined);
  };
  const event = (name = 'member.contact_verification_requested', over: Partial<EventEnvelope['headers']> = {}, payload?: Record<string, unknown>): EventEnvelope => {
    const id = randomUUID();
    return {
      id, name,
      payload: payload ?? { userId: `user-${id.slice(0, 6)}`, channel: 'phone', destination: PHONE, code: CODE, expiresAt: new Date(Date.now() + 600_000).toISOString() },
      headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'auth-service', version: 1, correlationId: `corr-${id.slice(0, 8)}`, ...over },
    };
  };
  const start = async (over: Parameters<typeof createTestApp>[0] = {}) => {
    const t = await createTestApp({ databaseUrl: db.url, bus: 'rabbitmq', ...over });
    apps.push(t);
    return t;
  };
  const ready = (t: TestApp, timeout = 20_000) =>
    vi.waitFor(async () => expect((await request(t.app.getHttpServer()).get('/ready')).status).toBe(200), { timeout, interval: 100 });
  const until = (cond: () => Promise<boolean>, timeout = 20_000) => vi.waitFor(async () => expect(await cond()).toBe(true), { timeout, interval: 100 });

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'notifbroker');
    await runMigrations(db.url, [kitMigrationsDir, notificationMigrationsDir]);
    conn = await amqp.connect(env.TEST_RABBITMQ_URL);
    ch = await conn.createChannel();
    ch.on('error', () => undefined);
    await deleteQueues();
    publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL });
  });
  afterEach(async () => {
    for (const t of apps.splice(0)) await t.app.close();
  });
  afterAll(async () => {
    await publisher?.close();
    await deleteQueues();
    await conn?.close().catch(() => undefined);
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${dbName()}" WITH ALLOW_CONNECTIONS true`).catch(() => undefined);
    await db.drop();
  });

  it('consumes from the durable queue notification.events, bound only to the mapped events; ACKs after the commit; nothing dead-lettered', async () => {
    const t = await start();
    await ready(t);
    const q = await ch.checkQueue(INTAKE_QUEUE);
    expect(q.consumerCount).toBe(1);
    const e = event();
    await publisher.publish(e);
    await until(async () => (await count('"sourceEventId" = $1', [e.id])) === 1);
    await until(async () => (await depth(INTAKE_QUEUE)) === 0); // acknowledged
    const [d] = await sql<Record<string, any>>(db.url, `SELECT d.status, d.channel, d.destination FROM notification_delivery d JOIN notification n ON n.id = d."notificationId" WHERE n."sourceEventId" = $1`, [e.id]);
    expect(d).toMatchObject({ status: 'PENDING', channel: 'SMS', destination: PHONE });
    // an Auth event Notification does not consume is not even routed to its queue
    const before = await count();
    await publisher.publish(event('user.registered', {}, { userId: 'u-1', role: 'x', organizationId: randomUUID(), timestamp: new Date().toISOString() }));
    await new Promise((r) => setTimeout(r, 500));
    expect(await depth(INTAKE_QUEUE)).toBe(0);
    expect(await count()).toBe(before);
    expect(await depth(DEAD)).toBe(0);
    expect(t.logs.some((l) => l.correlationId === e.headers.correlationId && String(l.msg).startsWith('notification_accepted'))).toBe(true);
  });

  it('10 copies of one event on the broker: one intent, one delivery', async () => {
    const t = await start();
    await ready(t);
    const e = event();
    await Promise.all(Array.from({ length: 10 }, () => publisher.publish(e)));
    await until(async () => (await depth(INTAKE_QUEUE)) === 0 && t.logs.filter((l) => String(l.msg).startsWith('notification_duplicate')).length === 9);
    expect(await count('"sourceEventId" = $1', [e.id])).toBe(1);
    expect((await sql<{ n: number }>(db.url, `SELECT count(*)::int AS n FROM notification_delivery d JOIN notification n ON n.id = d."notificationId" WHERE n."sourceEventId" = $1`, [e.id]))[0].n).toBe(1);
  });

  it('poison messages go to notification.events.dead ONCE, without retries or writes: malformed envelope, unsupported version, malformed payload', async () => {
    const t = await start();
    await ready(t);
    const before = await count();
    const deadBefore = await depth(DEAD);
    ch.publish(EXCHANGE, 'membership.approved', Buffer.from(JSON.stringify({ userId: 'legacy' }))); // pre-16.2: no messageId, no type
    await publisher.publish(event('membership.approved', { version: 2 }, { userId: 'u-1', channel: 'email', destination: 'p@example.test', organizationId: randomUUID(), timestamp: new Date().toISOString() }));
    await publisher.publish(event('member.contact_verification_requested', {}, { userId: 'u-1', channel: 'phone', destination: PHONE, code: CODE })); // no expiresAt
    await until(async () => (await depth(DEAD)) === deadBefore + 3);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await depth(DEAD)).toBe(deadBefore + 3); // no loop: each was dead-lettered exactly once
    expect(await depth(INTAKE_QUEUE)).toBe(0);
    expect(await depth(`${INTAKE_QUEUE}.retry`)).toBe(0); // permanent: never retried
    expect(await count()).toBe(before);
    const reasons: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = await ch.get(DEAD, { noAck: true });
      if (m) reasons.push(String(m.properties.headers?.['x-nawara-failure-reason'] ?? m.properties.headers?.['x-nawara-failure']));
    }
    expect(reasons.sort()).toEqual(['malformed_envelope', 'malformed_payload', 'unsupported_version']);
    expect(JSON.stringify(t.logs)).not.toContain(CODE);
  });

  it('CRASH WINDOW: committed but not acknowledged (the handler fails after the commit) → redelivered → recognized as a duplicate → still one intent', async () => {
    const t = await start();
    await ready(t);
    const original = t.intake.handle.bind(t.intake);
    let crashed = false;
    vi.spyOn(t.intake, 'handle').mockImplementation(async (e) => {
      const outcome = await original(e); // the transaction has COMMITTED here
      if (!crashed) {
        crashed = true;
        throw new Error('simulated crash between the commit and the acknowledgement');
      }
      return outcome;
    });
    const e = event();
    await publisher.publish(e);
    await until(async () => t.logs.some((l) => String(l.msg).startsWith('notification_duplicate') && l.correlationId === e.headers.correlationId), 20_000);
    await until(async () => (await depth(INTAKE_QUEUE)) === 0 && (await depth(`${INTAKE_QUEUE}.retry`)) === 0);
    expect(await count('"sourceEventId" = $1', [e.id])).toBe(1);
    expect(t.logs.some((l) => String(l.msg).startsWith('event_retry_scheduled'))).toBe(true);
  }, 40_000);

  it('the database lost while consuming: nothing is acknowledged or written; the kit retries; when it returns, exactly one intent', async () => {
    const t = await start();
    await ready(t);
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${dbName()}" WITH ALLOW_CONNECTIONS false`);
    await sql(env.TEST_DATABASE_ADMIN_URL, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND application_name = 'notification-service'`, [dbName()]);
    const e = event();
    await publisher.publish(e);
    await until(async () => t.logs.some((l) => String(l.msg).startsWith('event_retry_scheduled')), 15_000);
    await request(t.app.getHttpServer()).get('/ready').expect(503);
    await sql(env.TEST_DATABASE_ADMIN_URL, `ALTER DATABASE "${dbName()}" WITH ALLOW_CONNECTIONS true`);
    await until(async () => (await count('"sourceEventId" = $1', [e.id])) === 1, 25_000);
    await until(async () => (await depth(INTAKE_QUEUE)) === 0 && (await depth(`${INTAKE_QUEUE}.retry`)) === 0);
    expect(await depth(DEAD)).toBe(0);
    await ready(t);
  }, 60_000);

  it('the broker lost after startup: /ready 503, then the consumer reconnects by itself and consumes again (no restart)', async () => {
    const target = new URL(env.TEST_RABBITMQ_URL);
    const proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
    try {
      const t = await start({ rabbitmqUrl: proxy.url });
      await ready(t);
      await proxy.sever();
      await vi.waitFor(async () => expect((await request(t.app.getHttpServer()).get('/ready')).status).toBe(503), { timeout: 10_000, interval: 100 });
      await proxy.start();
      await ready(t, 40_000);
      const e = event();
      await publisher.publish(e);
      await until(async () => (await count('"sourceEventId" = $1', [e.id])) === 1);
      expect(t.logs.some((l) => String(l.msg).startsWith('rabbitmq_consumer_recovered'))).toBe(true);
    } finally {
      await proxy.sever();
    }
  }, 70_000);

  it('the broker down at startup: the process stays up, not ready, retrying; the intake starts once the broker answers', async () => {
    const target = new URL(env.TEST_RABBITMQ_URL);
    const proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
    await proxy.sever(); // the port is known, nothing listens
    try {
      const t = await start({ rabbitmqUrl: proxy.url });
      await new Promise((r) => setTimeout(r, 1500));
      const r = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(r.body.failed).toEqual(['event-intake', 'rabbitmq']);
      await request(t.app.getHttpServer()).get('/health').expect(200);
      expect(t.consumer.started).toBe(false);
      expect(t.logs.some((l) => String(l.msg).startsWith('event_intake_waiting reason=broker_unavailable'))).toBe(true);
      await proxy.start();
      await ready(t, 20_000);
      expect(t.consumer.started).toBe(true);
    } finally {
      await proxy.sever();
    }
  }, 40_000);

  it('RESTART replay: an event consumed before a restart is a duplicate after it', async () => {
    const e = event();
    const first = await start();
    await ready(first);
    await publisher.publish(e);
    await until(async () => (await count('"sourceEventId" = $1', [e.id])) === 1);
    await first.app.close();
    apps.splice(apps.indexOf(first), 1);
    const second = await start();
    await ready(second);
    await publisher.publish(e);
    await until(async () => second.logs.some((l) => String(l.msg).startsWith('notification_duplicate')) && (await depth(INTAKE_QUEUE)) === 0);
    expect(await count('"sourceEventId" = $1', [e.id])).toBe(1);
  });

  it('SHUTDOWN with a delivery in flight: no new delivery, the in-flight one commits and is acknowledged, the close is bounded', async () => {
    const t = await start();
    await ready(t);
    const original = t.intake.handle.bind(t.intake);
    let inFlight = false;
    vi.spyOn(t.intake, 'handle').mockImplementation(async (e) => {
      inFlight = true;
      await new Promise((r) => setTimeout(r, 1500));
      return original(e);
    });
    const e = event();
    await publisher.publish(e);
    await until(async () => inFlight);
    const t0 = Date.now();
    await t.app.close();
    apps.splice(apps.indexOf(t), 1);
    const took = Date.now() - t0;
    expect(took).toBeLessThan(8_000); // the kit's consumer drain bound (5 s) + closing
    expect(await count('"sourceEventId" = $1', [e.id])).toBe(1);
    expect(await depth(INTAKE_QUEUE)).toBe(0); // acknowledged before the channel closed: no redelivery
    const lines = t.logs.map((l) => String(l.msg));
    expect(lines.indexOf(lines.find((m) => m.startsWith('notification_accepted'))!)).toBeLessThan(lines.findIndex((m) => m.startsWith('service_shutdown_complete')));
  }, 30_000);
});

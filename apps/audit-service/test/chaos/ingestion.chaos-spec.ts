import { execFileSync } from 'node:child_process';
import amqp from 'amqplib';
import request from 'supertest';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { RabbitMqEventBus, kitMigrationsDir, runMigrations, type EventEnvelope } from '@nawara/service-kit';
import { auditMigrationsDir } from '../../src/app.module.js';
import { AUDIT_EXCHANGE, AUDIT_QUEUE } from '../../src/ingestion/ingestion.constants.js';
import { createTestApp, type TestApp } from '../support/app.js';
import { DEAD_QUEUE, auditEnvelope, deleteAuditQueues } from '../support/broker.js';
import { sql } from '../support/db.js';
import { describeWithEnv } from '../support/env.js';
import { provisionServiceDatabase, type ProvisionedDatabase } from '../support/roles.js';

/**
 * Stage 18.5 §37–§39, §64, §75: the real containers fail underneath a running ingestion. audit-service runs with its PRODUCTION bus
 * (kit defaults: 3 retries × 5 s, prefetch from the pool). Every broker operation of the test opens a fresh connection (the broker is
 * restarted between them).
 */
describeWithEnv(
  'ingestion under real container failures (docker restart / stop)',
  ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL', 'TEST_RABBITMQ_CONTAINER', 'TEST_POSTGRES_CONTAINER'],
  (env) => {
    let d: ProvisionedDatabase;
    const docker = (...args: string[]) => execFileSync('docker', args, { stdio: 'pipe' }).toString();
    const until = (cond: () => Promise<boolean>, timeout = 60_000) => vi.waitFor(async () => expect(await cond()).toBe(true), { timeout, interval: 250 });
    const brokerUp = () =>
      until(async () => {
        try {
          const c = await amqp.connect(env.TEST_RABBITMQ_URL);
          await c.close();
          return true;
        } catch {
          return false;
        }
      }, 90_000);
    const withChannel = async <T>(fn: (ch: amqp.Channel) => Promise<T>): Promise<T> => {
      const c = await amqp.connect(env.TEST_RABBITMQ_URL);
      try {
        const ch = await c.createChannel();
        return await fn(ch);
      } finally {
        await c.close().catch(() => undefined);
      }
    };
    const depthOf = (q: string) => withChannel(async (ch) => (await ch.checkQueue(q)).messageCount);
    const publish = async (events: EventEnvelope[]) => {
      const bus = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange: AUDIT_EXCHANGE });
      try {
        for (const e of events) await bus.publish(e);
      } finally {
        await bus.close();
      }
    };
    const stored = async (ids: string[]) =>
      (await sql<{ n: number }>(d.adminUrl, `SELECT count(*)::int AS n FROM audit_record WHERE "eventId" = ANY($1::uuid[])`, [ids]))[0]!.n;
    const readyState = async (t: TestApp) => (await request(t.app.getHttpServer()).get('/ready')).status;
    const start = async () => {
      const t = await createTestApp({ databaseUrl: d.appUrl, rabbitmqUrl: env.TEST_RABBITMQ_URL });
      await until(async () => (await readyState(t)) === 200);
      return t;
    };

    beforeAll(async () => {
      d = await provisionServiceDatabase(env.TEST_DATABASE_ADMIN_URL, 'achaos');
      await runMigrations(d.migratorUrl, [kitMigrationsDir, auditMigrationsDir]);
      await withChannel(deleteAuditQueues);
    });
    afterAll(async () => {
      await withChannel(deleteAuditQueues).catch(() => undefined);
      await d?.drop();
    });

    it('RABBITMQ RESTART: pending and dead-lettered messages survive (durable queues, persistent messages); a running consumer recovers by itself; one row per event', async () => {
      let a = await start();
      const spoofed = auditEnvelope('membership.revoked', { headers: { source: 'billing-service' } });
      await publish([spoofed]);
      await until(async () => (await depthOf(DEAD_QUEUE)) === 1);
      await a.app.close();

      const pending = Array.from({ length: 5 }, () => auditEnvelope('file.deleted'));
      await publish(pending);
      expect(await depthOf(AUDIT_QUEUE)).toBe(5);
      docker('restart', env.TEST_RABBITMQ_CONTAINER);
      await brokerUp();
      expect(await depthOf(AUDIT_QUEUE)).toBe(5); // durable queue, persistent messages: nothing lost across the restart
      expect(await depthOf(DEAD_QUEUE)).toBe(1); // the dead letter survives too

      a = await start();
      await until(async () => (await stored(pending.map((e) => e.id))) === 5);
      expect(await depthOf(AUDIT_QUEUE)).toBe(0);

      // Restart the broker UNDER the running consumer: readiness drops, then recovers with no process restart.
      docker('restart', env.TEST_RABBITMQ_CONTAINER);
      await until(async () => (await readyState(a)) === 503, 30_000);
      await request(a.app.getHttpServer()).get('/health').expect(200);
      await brokerUp();
      await until(async () => (await readyState(a)) === 200, 120_000);
      const after = auditEnvelope('file.integrity_incident');
      await publish([after]);
      await until(async () => (await stored([after.id])) === 1);
      expect(await stored([...pending.map((e) => e.id), after.id])).toBe(6); // exactly one row per event
      expect(await stored([spoofed.id])).toBe(0);
      expect(a.logs.some((l) => String(l.msg).startsWith('rabbitmq_consumer_recovered'))).toBe(true);
      await a.app.close();
    }, 300_000);

    it('POSTGRESQL STOPPED AND STARTED (the real container): nothing acknowledged while it is down; the kit retry carries the event over the outage; exactly one row', async () => {
      const a = await start();
      const deadBefore = await depthOf(DEAD_QUEUE);
      docker('stop', '-t', '1', env.TEST_POSTGRES_CONTAINER);
      try {
        const e = auditEnvelope('subscription.renewed');
        await publish([e]);
        await until(async () => a.logs.some((l) => String(l.msg).startsWith(`audit_ingest_transient_failure eventId=${e.id}`)), 30_000);
        await until(async () => (await readyState(a)) === 503);
        docker('start', env.TEST_POSTGRES_CONTAINER);
        await until(async () => {
          try {
            return (await stored([e.id])) === 1;
          } catch {
            return false; // the database is still starting
          }
        }, 90_000);
        await until(async () => (await readyState(a)) === 200);
        expect(await depthOf(DEAD_QUEUE)).toBe(deadBefore); // recovered inside the retry budget: never dead-lettered
        expect(await stored([e.id])).toBe(1);
      } finally {
        docker('start', env.TEST_POSTGRES_CONTAINER);
        await a.app.close();
      }
    }, 300_000);
  },
);

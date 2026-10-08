import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { createEventBus } from '../src/events/event-bus.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

describeWithEnv('service foundation (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentfound');
  });
  afterAll(() => db.drop());

  it('/health stays 200 even while migrations are pending; /ready is 503 until they are applied', async () => {
    const t: TestApp = await createTestApp({ databaseUrl: db.url });
    try {
      await request(t.app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
      const pending = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(pending.body).toEqual({ status: 'unavailable', failed: ['migrations'] });

      await runMigrations(db.url, [kitMigrationsDir]);
      await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
    } finally {
      await t.app.close();
    }
  });

  it('V2 A3M.3 (S21-5): with the broker unreachable, Payment stays ready and still accepts a payment, whose event waits in the outbox', async () => {
    const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    const billing = generateServiceToken();
    // the real RabbitMQ bus, pointed at a closed local port: every publish fails, exactly as during a broker outage
    const bus = createEventBus({ rabbitmqUrl: 'amqp://guest:guest@127.0.0.1:1', isProduction: false, rabbitmqConfirmTimeoutMs: 500 });
    const t: TestApp = await createTestApp({ databaseUrl: db.url, bus, tokens: [{ caller: 'billing-service', digest: billing.digest }], migrationsDirs: [kitMigrationsDir, paymentMigrationsDir] });
    try {
      await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
      const organizationId = crypto.randomUUID();
      const created = await request(t.app.getHttpServer()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send({
        paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: 'inv-s21-5', payer: { type: 'user', id: 'user-1' },
        seller: { type: 'organization', id: organizationId }, organizationId, amount: 1000, currency: 'TND',
      }).expect(201);
      const pending = await t.app.get(DbService).query<{ n: number }>(
        `SELECT count(*)::int AS n FROM outbox WHERE name = 'payment.created' AND "publishedAt" IS NULL AND payload->>'paymentId' = $1`, [created.body.id]);
      expect(pending.rows[0].n).toBe(1); // durable locally; the relay publishes it once the broker is back
      await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' }); // still ready after a failed publish
    } finally {
      await t.app.close();
      await bus.close();
    }
    // and the service bootstrap registers no broker readiness check
    expect(readFileSync(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8')).not.toMatch(/ReadinessRegistry|amqplib|rabbitmq-readiness/);
  });

  it('fails closed with a 503 when the database itself is unreachable', async () => {
    const t: TestApp = await createTestApp({ databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    try {
      await request(t.app.getHttpServer()).get('/health').expect(200);
      const r = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(r.body.failed).toContain('database');
    } finally {
      await t.app.close();
    }
  });

  it('captures the exact raw request bytes alongside the parsed body (needed for webhook signature verification)', async () => {
    const t: TestApp = await createTestApp({ databaseUrl: db.url });
    try {
      const payload = '{"eventId":"evt_1","amount":1000}';
      const r = await request(t.app.getHttpServer()).post('/probe/raw-body').set('content-type', 'application/json').send(payload).expect(201);
      expect(Buffer.from(r.body.rawBodyBase64, 'base64').toString('utf8')).toBe(payload);
      expect(r.body.parsedBody).toEqual({ eventId: 'evt_1', amount: 1000 });
    } finally {
      await t.app.close();
    }
  });
});

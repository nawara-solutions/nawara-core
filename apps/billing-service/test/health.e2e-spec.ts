import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { registerRabbitmqReadiness } from '../src/health/rabbitmq-readiness.js';
import { billingMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

describeWithEnv('health and readiness (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billinghealth');
  });
  afterAll(() => db.drop());

  it('/health is 200 while migrations are pending; /ready is 503 naming only the failing check, and 200 once they are applied', async () => {
    const t: TestApp = await createTestApp({ databaseUrl: db.url });
    try {
      await request(t.app.getHttpServer()).get('/health').expect(200, { status: 'ok' });
      const pending = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(pending.body).toEqual({ status: 'unavailable', failed: ['migrations'] });

      await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
      await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
    } finally {
      await t.app.close();
    }
  });

  it('/ready fails closed with 503 when the database is unreachable, while /health stays 200 (a database outage must not restart a healthy process)', async () => {
    const t: TestApp = await createTestApp({ databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none' });
    try {
      await request(t.app.getHttpServer()).get('/health').expect(200);
      const r = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(r.body.failed).toContain('database');
      expect(JSON.stringify(r.body)).not.toMatch(/nobody|nothing|127\.0\.0\.1|ECONNREFUSED/); // no host, credential or error text
    } finally {
      await t.app.close();
    }
  });

  it('/ready reflects the broker when one is configured: an unreachable broker is reported as `rabbitmq`', async () => {
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    const t: TestApp = await createTestApp({ databaseUrl: db.url });
    try {
      await request(t.app.getHttpServer()).get('/ready').expect(200);
      registerRabbitmqReadiness(t.registry, 'amqp://guest:guest@127.0.0.1:1');
      const r = await request(t.app.getHttpServer()).get('/ready').expect(503);
      expect(r.body).toEqual({ status: 'unavailable', failed: ['rabbitmq'] });
    } finally {
      await t.app.close();
    }
  });

  it('exposes the Stage 3 domain routes (authenticated), and no route for what is still deferred (entitlement is Stage 8)', async () => {
    const t: TestApp = await createTestApp({ databaseUrl: db.url });
    try {
      // Real routes now exist: unauthenticated is 401 (the guard runs before any handler), never 404.
      await request(t.app.getHttpServer()).get('/billing/invoices').expect(401); // list (endpoint 9)
      for (const path of ['/billing/invoices', '/billing/products', '/billing/prices']) {
        await request(t.app.getHttpServer()).post(path).send({}).expect(401);
      }
      // There is deliberately no list route for products or prices (SDD 18.1: only create/get/archive, create/get/retire).
      for (const path of ['/billing/products', '/billing/prices']) {
        await request(t.app.getHttpServer()).get(path).expect(404);
      }
      // Entitlement (endpoints 17, 18) is Stage 8: still no route, so still a 404 regardless of authentication.
      for (const path of ['/billing/licenses/x/status', '/billing']) {
        await request(t.app.getHttpServer()).get(path).expect(404);
      }
    } finally {
      await t.app.close();
    }
  });
});

describeWithEnv('readiness against a real broker', ['TEST_DATABASE_ADMIN_URL', 'TEST_RABBITMQ_URL'], (env) => {
  it('is ready when the broker answers', async () => {
    const db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingbroker');
    try {
      await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
      const t: TestApp = await createTestApp({ databaseUrl: db.url });
      try {
        registerRabbitmqReadiness(t.registry, env.TEST_RABBITMQ_URL);
        await request(t.app.getHttpServer()).get('/ready').expect(200, { status: 'ready' });
      } finally {
        await t.app.close();
      }
    } finally {
      await db.drop();
    }
  });
});

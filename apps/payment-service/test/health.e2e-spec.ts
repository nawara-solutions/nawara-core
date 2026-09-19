import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
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

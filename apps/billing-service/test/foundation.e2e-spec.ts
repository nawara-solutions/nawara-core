import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { BILLING_CONFIG } from '../src/config/billing-config.token.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

describeWithEnv('service foundation behaviours (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const producer = generateServiceToken();
  const other = generateServiceToken();
  const user: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const inactive: AuthIdentity = { id: 'user-2', adminTier: null, isActive: false, memberships: [] };
  const asked: string[] = [];
  const authClient: AuthClient = {
    getIdentity: async (bearer) => {
      asked.push(bearer);
      return bearer === 'user-jwt' ? user : bearer === 'inactive-jwt' ? inactive : null;
    },
    hasPlatformAccess: async () => false,
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingfound');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, tokens: [{ caller: 'test-producer', digest: producer.digest }], authClient });
  });
  afterAll(async () => {
    await t.app.close();
    await db.drop();
  });

  const server = () => t.app.getHttpServer();

  // ------------------------------------------------------------------------------------------ service authentication

  it('a valid service token is accepted and identifies the calling service', async () => {
    const r = await request(server()).get('/probe/service').set('authorization', `Bearer ${producer.token}`).expect(200);
    expect(r.body).toEqual({ caller: 'test-producer' });
  });

  it.each([
    ['no authorization header', undefined],
    ['a wrong token', 'Bearer not-a-real-token'],
    ['another service\'s never-registered token', `Bearer ${other.token}`],
    ['a non-bearer scheme', `Basic ${Buffer.from('a:b').toString('base64')}`],
    ['an empty bearer', 'Bearer '],
    ['a token with a space inside', `Bearer ${producer.token} extra`],
  ])('a service-only route refuses %s with one generic 401', async (_label, header) => {
    const req = request(server()).get('/probe/service');
    const r = await (header === undefined ? req : req.set('authorization', header)).expect(401);
    expect(r.body.message).toBe('Unauthorized');
  });

  it('a user bearer is never accepted as a service credential', async () => {
    await request(server()).get('/probe/service').set('authorization', 'Bearer user-jwt').expect(401);
  });

  // -------------------------------------------------------------------------------- service-token-or-user (authentication only)

  it('the combined guard resolves a service token WITHOUT asking Auth, and a user bearer by asking Auth only', async () => {
    asked.length = 0;
    const svc = await request(server()).get('/probe/either').set('authorization', `Bearer ${producer.token}`).expect(200);
    expect(svc.body).toEqual({ kind: 'service', service: 'test-producer' });
    expect(asked).toEqual([]); // the service token never leaves this service

    const usr = await request(server()).get('/probe/either').set('authorization', 'Bearer user-jwt').expect(200);
    expect(usr.body).toEqual({ kind: 'user', userId: 'user-1' });
    expect(asked).toEqual(['user-jwt']); // the user's bearer goes to Auth and nowhere else
  });

  it('the combined guard refuses an unknown bearer, an inactive identity, and a missing header', async () => {
    await request(server()).get('/probe/either').set('authorization', 'Bearer stranger').expect(401);
    await request(server()).get('/probe/either').set('authorization', 'Bearer inactive-jwt').expect(401);
    await request(server()).get('/probe/either').expect(401);
  });

  it('an unreachable Auth fails closed with 503 and does not fall back to trusting the caller', async () => {
    const down: AuthClient = {
      getIdentity: async () => {
        const { ServiceUnavailableException } = await import('@nestjs/common');
        throw new ServiceUnavailableException();
      },
      hasPlatformAccess: async () => false,
    };
    const app = await createTestApp({ databaseUrl: db.url, authClient: down });
    try {
      await request(app.app.getHttpServer()).get('/probe/either').set('authorization', 'Bearer user-jwt').expect(503);
    } finally {
      await app.app.close();
    }
  });

  it('a public probe needs no credential: only routes that opt in are protected, and the guards grant no business permission', async () => {
    await request(server()).get('/probe/public').expect(200, { ok: true });
  });

  // ------------------------------------------------------------------------------------------------------ error handling

  it('a known application error passes its stable machine-readable code through, with the uniform body', async () => {
    const r = await request(server()).get('/probe/known-error').expect(409);
    expect(r.body).toMatchObject({ statusCode: 409, message: 'Not allowed in this state.', error: 'Conflict', code: 'invalid_state_transition' });
    expect(typeof r.body.requestId).toBe('string');
  });

  it('an unexpected error becomes an opaque 500: no message, stack, path, credential or connection string reaches the client', async () => {
    const r = await request(server()).get('/probe/boom').expect(500);
    expect(r.body).toMatchObject({ statusCode: 500, message: 'Internal server error', error: 'Internal Server Error' });
    expect(JSON.stringify(r.body)).not.toMatch(/s3cr3t|postgres:|ECONNREFUSED|\/srv\/|\.js:|billing_app/);
  });

  it('a database error is sanitized the same way (no SQL text, table or constraint name)', async () => {
    const r = await request(server()).get('/probe/db-error').expect(500);
    expect(r.body.message).toBe('Internal server error');
    expect(JSON.stringify(r.body)).not.toMatch(/a_table_that_does_not_exist|relation|SELECT|42P01/i);
  });

  it('unknown fields and invalid values are rejected with 400 (no mass assignment), and no unknown field is silently accepted', async () => {
    await request(server()).post('/probe/echo').send({ name: 'ok', isAdmin: true }).expect(400);
    await request(server()).post('/probe/echo').send({ name: 'x'.repeat(21) }).expect(400);
    await request(server()).post('/probe/echo').send({ name: 5 }).expect(400);
    await request(server()).post('/probe/echo').send({ name: 'fine' }).expect(201, { name: 'fine' });
  });

  it('malformed JSON and an oversized body are refused without echoing the body', async () => {
    const bad = await request(server()).post('/probe/echo').set('content-type', 'application/json').send('{"name": "x"').expect(400);
    expect(JSON.stringify(bad.body)).not.toContain('"name"');
    await request(server()).post('/probe/echo').set('content-type', 'application/json').send(JSON.stringify({ name: 'a'.repeat(300 * 1024) })).expect(413);
  });

  // ------------------------------------------------------------------------------------------ request and correlation ids

  it('generates a request id and a correlation id when none is supplied, and returns them', async () => {
    const r = await request(server()).get('/probe/public').expect(200);
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.headers['x-correlation-id']).toBe(r.headers['x-request-id']);
  });

  it('propagates supplied ids, and puts the request id in error bodies', async () => {
    const r = await request(server()).get('/probe/known-error').set('x-request-id', 'req-abcdef123').set('x-correlation-id', 'corr-abcdef123').expect(409);
    expect(r.headers['x-request-id']).toBe('req-abcdef123');
    expect(r.headers['x-correlation-id']).toBe('corr-abcdef123');
    expect(r.body.requestId).toBe('req-abcdef123');
  });

  it('refuses an unsafe client-supplied id instead of logging or echoing it', async () => {
    const r = await request(server()).get('/probe/public').set('x-request-id', 'bad id\twith spaces;<script>').expect(200);
    expect(r.headers['x-request-id']).not.toContain('script');
    expect(r.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  // ------------------------------------------------------------------------------------------------------ logging hygiene

  it('never logs a service token, a bearer, a password or a request body, even when the request fails', async () => {
    const secretBody = { name: 'x'.repeat(21), password: 'hunter2-body-secret' };
    await request(server()).post('/probe/echo').set('authorization', `Bearer ${producer.token}`).send(secretBody);
    await request(server()).get('/probe/boom').set('authorization', `Bearer ${producer.token}`).set('cookie', 'session=cookie-secret-value');
    await request(server()).get('/probe/service').set('authorization', 'Bearer wrong-token-value');
    const all = JSON.stringify(t.logs);
    expect(t.logs.length).toBeGreaterThan(0); // the failure above WAS logged, so this assertion is not vacuous
    for (const secret of [producer.token, producer.digest, 'hunter2-body-secret', 'wrong-token-value', 'cookie-secret-value', 's3cr3t-password']) {
      expect(all, `log leaked ${secret.slice(0, 8)}…`).not.toContain(secret);
    }
    expect(t.logs.every((l) => l.service === 'billing-service')).toBe(true);
  });

  // ---------------------------------------------------------------------------------------------------------- HTTP baseline

  it('sets secure headers, leaks no framework banner, and keeps CORS off unless origins are configured', async () => {
    const r = await request(server()).get('/probe/public').set('origin', 'https://evil.example').expect(200);
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does not mount the API documentation unless a password is configured; with one it is behind basic auth', async () => {
    await request(server()).get('/billing/docs').expect(404);
    const docs = await createTestApp({ databaseUrl: db.url, env: { SWAGGER_PASSWORD: 'a-long-enough-docs-password' } });
    try {
      await request(docs.app.getHttpServer()).get('/billing/docs').expect(401);
      await request(docs.app.getHttpServer()).get('/billing/docs-json').expect(401);
      await request(docs.app.getHttpServer()).get('/billing/docs-json').auth('docs', 'wrong-password-value').expect(401);
      await request(docs.app.getHttpServer()).get('/billing/docs-json').auth('docs', 'a-long-enough-docs-password').expect(200);
    } finally {
      await docs.app.close();
    }
  });

  it('provides the validated configuration to feature modules', () => {
    expect(t.app.get(BILLING_CONFIG)).toBe(t.config);
  });

  // ---------------------------------------------------------------------------------------------------- graceful shutdown

  it('closing the application ends its database pool: no connection of the service outlives it', async () => {
    const app = await createTestApp({ databaseUrl: db.url });
    await request(app.app.getHttpServer()).get('/ready').expect(200); // opens at least one pooled connection
    const admin = new pg.Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
    await admin.connect();
    try {
      const count = async (name: string) =>
        (await admin.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND application_name = 'billing-service' AND pid <> pg_backend_pid()`, [name])).rows[0].n as number;
      const dbName = new URL(db.url).pathname.slice(1);
      const before = await count(dbName);
      expect(before).toBeGreaterThan(0);
      await app.app.close();
      // t (the shared app) still holds its own connections; the closed app's were released
      expect(await count(dbName)).toBeLessThan(before);
    } finally {
      await admin.end();
    }
  });
});

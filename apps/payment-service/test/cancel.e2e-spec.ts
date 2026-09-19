import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));

const validBody = (over: Partial<Record<string, unknown>> = {}) => {
  const organizationId = crypto.randomUUID();
  return {
    paymentRequestId: crypto.randomUUID(),
    sourceType: 'invoice',
    sourceId: 'inv-1',
    payer: { type: 'user', id: 'user-1' },
    seller: { type: 'organization', id: organizationId },
    organizationId,
    amount: 1000,
    currency: 'TND',
    ...over,
  };
};

/**
 * Stage 4: the cancel HTTP route (SDD endpoint 9) and the producer field on every payment event. Domain logic
 * (state machine, idempotency mechanics) is Phase 1, already tested in payments.e2e-spec.ts; this file proves the
 * NEW HTTP surface and the new event payload field.
 */
describeWithEnv('payment cancel API and event producer field (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const billing = generateServiceToken();
  const otherProducer = generateServiceToken();
  const userIdentity: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const authClient: AuthClient = { getIdentity: async () => userIdentity, hasPlatformAccess: async () => false };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentcancel');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [
        { caller: 'billing-service', digest: billing.digest },
        { caller: 'other-producer', digest: otherProducer.digest },
      ],
      authClient,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      env: { PAYMENT_TEST_PROVIDER: 'true' },
    });
  });
  afterAll(async () => {
    await t.app.close();
    await db.drop();
  });

  const create = (body: Record<string, unknown>) => request(t.app.getHttpServer()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(body);
  const cancel = (id: string, token: string, idempotencyKey?: string) => {
    const req = request(t.app.getHttpServer()).post(`/payment/payments/${id}/cancel`).set('authorization', `Bearer ${token}`);
    return idempotencyKey ? req.set('idempotency-key', idempotencyKey) : req;
  };

  it('every event a created payment can produce carries producer, sourced from the payment row', async () => {
    const r = await create(validBody()).expect(201);
    const dbService = t.app.get(DbService);
    const { rows } = await dbService.query<{ payload: { producer: string } }>(`SELECT payload FROM outbox WHERE name = 'payment.created' AND payload->>'paymentId' = $1`, [r.body.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.producer).toBe('billing-service');
  });

  it('cancels a created payment (200), emits payment.cancelled with producer, and moves it to cancelled', async () => {
    const created = await create(validBody()).expect(201);
    const r = await cancel(created.body.id, billing.token, 'cancel-key-1').expect(200);
    expect(r.body.status).toBe('cancelled');

    const dbService = t.app.get(DbService);
    const { rows } = await dbService.query<{ payload: { producer: string; paymentId: string } }>(
      `SELECT payload FROM outbox WHERE name = 'payment.cancelled' AND payload->>'paymentId' = $1`,
      [created.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.producer).toBe('billing-service');
  });

  it('requires a valid Idempotency-Key (400 idempotency_key_required)', async () => {
    const created = await create(validBody()).expect(201);
    const r = await cancel(created.body.id, billing.token).expect(400);
    expect(r.body.code).toBe('idempotency_key_required');
  });

  it('repeated cancellation with the SAME idempotency key replays the original result, no second effect', async () => {
    const created = await create(validBody()).expect(201);
    const first = await cancel(created.body.id, billing.token, 'replay-key').expect(200);
    const second = await cancel(created.body.id, billing.token, 'replay-key').expect(200);
    expect(second.body).toEqual(first.body);

    const dbService = t.app.get(DbService);
    const { rows } = await dbService.query(`SELECT id FROM outbox WHERE name = 'payment.cancelled' AND payload->>'paymentId' = $1`, [created.body.id]);
    expect(rows).toHaveLength(1); // one event, not two
  });

  it('the same idempotency key with a different resource is a distinct reservation (different operation path), never cross-applied', async () => {
    const a = await create(validBody()).expect(201);
    const b = await create(validBody()).expect(201);
    await cancel(a.body.id, billing.token, 'shared-key').expect(200);
    // b is a DIFFERENT payment id, so this is a different requestHash under the same key -> 422, never silently
    // applied to a different resource.
    const r = await cancel(b.body.id, billing.token, 'shared-key').expect(422);
    expect(r.body.code).toBe('idempotency_key_reused');
  });

  it('concurrent cancellation attempts with DIFFERENT keys serialize: exactly one succeeds, the second sees the terminal state', async () => {
    const created = await create(validBody()).expect(201);
    const [a, b] = await Promise.all([cancel(created.body.id, billing.token, 'race-key-1'), cancel(created.body.id, billing.token, 'race-key-2')]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses).toEqual([200, 409]);
    const dbService = t.app.get(DbService);
    const { rows } = await dbService.query(`SELECT id FROM outbox WHERE name = 'payment.cancelled' AND payload->>'paymentId' = $1`, [created.body.id]);
    expect(rows).toHaveLength(1); // only the winner's cancellation produced an event
  });

  it('refuses to cancel a payment already in a terminal state (409 invalid_state_transition)', async () => {
    const created = await create(validBody()).expect(201);
    await cancel(created.body.id, billing.token, 'first-cancel').expect(200);
    const r = await cancel(created.body.id, billing.token, 'second-cancel').expect(409);
    expect(r.body.code).toBe('invalid_state_transition');
  });

  it('producer isolation: a different producer cannot cancel another producer\'s payment (404, collapsed, never 403)', async () => {
    const created = await create(validBody()).expect(201);
    const r = await cancel(created.body.id, otherProducer.token, 'wrong-producer-key').expect(404);
    expect(r.body.code).toBe('not_found');
  });

  it('refuses to cancel a pending payment with an open attempt (409 payment_has_open_attempt) — money may be in flight', async () => {
    const created = await create(validBody()).expect(201);
    await request(t.app.getHttpServer())
      .post(`/payment/payments/${created.body.id}/attempts`)
      .set('authorization', 'Bearer user-1-jwt')
      .set('idempotency-key', 'attempt-key-1')
      .send({ provider: 'test', providerOptions: { scenario: 'timeout_after_accept' } })
      .expect(201);
    const r = await cancel(created.body.id, billing.token, 'cancel-with-open-attempt').expect(409);
    expect(r.body.code).toBe('payment_has_open_attempt');
  });

  it('unknown payment id is 404', async () => {
    const r = await cancel(crypto.randomUUID(), billing.token, 'unknown-key').expect(404);
    expect(r.body.code).toBe('not_found');
  });

  it('a user bearer cannot cancel (service-token only route; 401, not 403 — wrong credential type)', async () => {
    const created = await create(validBody()).expect(201);
    await request(t.app.getHttpServer()).post(`/payment/payments/${created.body.id}/cancel`).set('authorization', 'Bearer user-1-jwt').set('idempotency-key', 'user-attempt').expect(401);
  });
});

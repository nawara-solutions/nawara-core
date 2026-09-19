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

describeWithEnv('payments API (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const billing = generateServiceToken();
  const other = generateServiceToken();
  const userIdentity: AuthIdentity = { id: 'user-1', adminTier: null, isActive: true, memberships: [] };
  const identities: Record<string, AuthIdentity> = {
    'user-1-jwt': userIdentity,
    'inactive-jwt': { ...userIdentity, isActive: false },
    'someone-elses-jwt': { id: 'someone-else', adminTier: null, isActive: true, memberships: [] },
  };
  const authClient: AuthClient = {
    getIdentity: async (bearer: string) => identities[bearer] ?? null,
    hasPlatformAccess: async () => false,
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentsapi');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    t = await createTestApp({
      databaseUrl: db.url,
      tokens: [
        { caller: 'billing-service', digest: billing.digest },
        { caller: 'other-service', digest: other.digest },
      ],
      authClient,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
    });
  });
  afterAll(async () => {
    await t.app.close();
    await db.drop();
  });

  const post = (token: string, body: Record<string, unknown>) =>
    request(t.app.getHttpServer()).post('/payment/payments').set('authorization', `Bearer ${token}`).send(body);
  const get = (token: string, path: string) =>
    request(t.app.getHttpServer()).get(path).set('authorization', `Bearer ${token}`);
  const asBilling = (body: Record<string, unknown>) => post(billing.token, body);

  it('creates a payment (201) and its representation matches the request', async () => {
    const body = validBody();
    const r = await asBilling(body).expect(201);
    expect(r.body).toMatchObject({
      paymentRequestId: body.paymentRequestId,
      sourceType: 'invoice',
      sourceId: 'inv-1',
      payer: { type: 'user', id: 'user-1' },
      seller: { type: 'organization', id: body.organizationId },
      amount: 1000,
      currency: 'TND',
      status: 'created',
      settledMethod: null,
      refundedAmount: 0,
      refundableAmount: 0,
      attempts: [],
      cash: null,
    });
    expect(r.body.id).toBeTypeOf('string');

    // FI-16 (positive case): the state change and its outbox event commit together, exactly once.
    const dbService = t.app.get(DbService);
    const { rows } = await dbService.query<{ payload: { paymentId: string } }>(`SELECT payload FROM outbox WHERE name = 'payment.created' AND payload->>'paymentId' = $1`, [r.body.id]);
    expect(rows).toHaveLength(1);
  });

  it('replays an identical request as 200 with Idempotent-Replayed: true and does not create a second row', async () => {
    const body = validBody();
    const first = await asBilling(body).expect(201);
    const second = await asBilling(body).expect(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.id).toBe(first.body.id);
  });

  it('refuses the same paymentRequestId with a different snapshot as 409 payment_request_conflict', async () => {
    const body = validBody();
    await asBilling(body).expect(201);
    const r = await asBilling({ ...body, amount: 2000 }).expect(409);
    expect(r.body.code).toBe('payment_request_conflict');
  });

  it('rejects an unsupported currency with 422', async () => {
    const r = await asBilling(validBody({ currency: 'XYZ' })).expect(422);
    expect(r.body.code).toBe('unsupported_currency');
  });

  it('rejects payer == seller with 400', async () => {
    const r = await asBilling(validBody({ payer: { type: 'user', id: 'same' }, seller: { type: 'user', id: 'same' } })).expect(400);
    expect(r.body.code).toBe('invalid_payment_request');
  });

  it('rejects an unknown field and a malformed amount with 400', async () => {
    await asBilling(validBody({ extraField: 'nope' })).expect(400);
    await asBilling(validBody({ amount: -5 })).expect(400);
    await asBilling(validBody({ amount: 0 })).expect(400);
  });

  it('refuses creation without a valid service token (401), and a wrong-service token is not a producer relation', async () => {
    await request(t.app.getHttpServer()).post('/payment/payments').send(validBody()).expect(401);
  });

  it('lets the producer read its own payment, and a payer read it too, but refuses an unrelated user or service (collapsed 404)', async () => {
    const created = await asBilling(validBody()).expect(201);
    const id = created.body.id;

    await get(billing.token, `/payment/payments/${id}`).expect(200);
    await get('user-1-jwt', `/payment/payments/${id}`).expect(200);

    // 'other-service' IS a configured caller but is not this payment's producer: same 404 as a non-existent id.
    await get(other.token, `/payment/payments/${id}`).expect(404);
    await get('someone-elses-jwt', `/payment/payments/${id}`).expect(404);
    await get(billing.token, '/payment/payments/00000000-0000-0000-0000-000000000000').expect(404);
  });

  it('refuses an inactive identity even if it matches the payer', async () => {
    const created = await asBilling(validBody()).expect(201);
    await get('inactive-jwt', `/payment/payments/${created.body.id}`).expect(401);
  });

  it('gives exactly one payment row for concurrent identical creates over HTTP', async () => {
    const body = validBody();
    const responses = await Promise.all(Array.from({ length: 6 }, () => asBilling(body)));
    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 201]);
    const ids = new Set(responses.map((r) => r.body.id));
    expect(ids.size).toBe(1);
  });
});

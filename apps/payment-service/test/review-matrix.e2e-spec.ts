import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { ExpirySweeper } from '../src/payments/expiry-sweeper.js';
import { AttemptService } from '../src/attempts/attempt.service.js';
import { ATTEMPT_STATUSES, canTransitionAttempt } from '../src/attempts/attempt-state-machine.js';
import { PAYMENT_STATUSES, canTransitionPayment } from '../src/payments/payment-state-machine.js';
import { ProviderRegistry } from '../src/providers/provider-registry.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const paymentBody = (over: Record<string, unknown> = {}) => {
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

const identity = (id: string, over: Partial<AuthIdentity> = {}): AuthIdentity => ({ id, adminTier: null, isActive: true, memberships: [], ...over });

/** Phase 1 acceptance review: agreement between the code and the database, idempotency scope, authorization, rate limits. */
describeWithEnv('phase 1 acceptance review: matrices and boundaries (real PostgreSQL)', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let tLimited: TestApp;
  const billing = generateServiceToken();
  const other = generateServiceToken();
  const limited = generateServiceToken();
  const third = generateServiceToken();
  const fourth = generateServiceToken();
  let authCalls: string[] = [];
  const users: Record<string, AuthIdentity> = {
    'user-1-jwt': identity('user-1'),
    'user-2-jwt': identity('user-2'),
    'inactive-jwt': identity('user-1', { isActive: false }),
    'limited-user-jwt': identity('limited-user'),
    'limited-user-2-jwt': identity('limited-user-2'),
  };
  const authClient: AuthClient = {
    getIdentity: async (bearer) => {
      authCalls.push(bearer);
      return users[bearer] ?? null;
    },
    hasPlatformAccess: async () => false,
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'reviewmatrix');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    const tokens = [
      { caller: 'billing-service', digest: billing.digest },
      { caller: 'other-service', digest: other.digest },
      { caller: 'limited-service', digest: limited.digest },
      { caller: 'third-service', digest: third.digest },
      { caller: 'fourth-service', digest: fourth.digest },
    ];
    const common = { databaseUrl: db.url, tokens, authClient, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir] };
    t = await createTestApp({ ...common, env: { PAYMENT_TEST_PROVIDER: 'true' } });
    tLimited = await createTestApp({
      ...common,
      env: { PAYMENT_TEST_PROVIDER: 'true', PAYMENT_RATE_LIMIT_CREATE_PER_MINUTE: '3', PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE: '2' },
    });
  });
  afterAll(async () => {
    await t.app.close();
    await tLimited.app.close();
    await db.drop();
  });

  const server = (app: TestApp = t) => app.app.getHttpServer();
  const asBilling = (r: request.Test) => r.set('authorization', `Bearer ${billing.token}`);
  const create = async (over: Record<string, unknown> = {}) => (await asBilling(request(server()).post('/payment/payments')).send(paymentBody(over)).expect(201)).body;
  const start = (paymentId: string, key: string, jwt = 'user-1-jwt', body: Record<string, unknown> = { providerOptions: { scenario: 'success' } }, app: TestApp = t) =>
    request(server(app)).post(`/payment/payments/${paymentId}/attempts`).set('authorization', `Bearer ${jwt}`).set('idempotency-key', key).send(body);
  const get = (paymentId: string, jwt = 'user-1-jwt') => request(server()).get(`/payment/payments/${paymentId}`).set('authorization', `Bearer ${jwt}`);
  const sql = <R extends pg.QueryResultRow = any>(text: string, params?: unknown[]) => t.app.get(DbService).query<R>(text, params);
  const sign = (body: Buffer) => createHmac('sha256', 'test-provider-webhook-secret').update(body).digest('hex');
  const signedFor = (reference: string, eventId: string) => {
    const body = Buffer.from(JSON.stringify({ eventId, type: 'payment.succeeded', reference, amount: 1000, currency: 'TND' }), 'utf8');
    return { body, signature: sign(body) };
  };
  const webhook = (body: Buffer, signature: string) =>
    request(server()).post('/payment/webhooks/test').set('content-type', 'application/json').set('x-test-provider-signature', signature).send(body.toString('utf8'));

  // ---------------------------------------------------------------- code <-> database agreement (SDD 5)

  it('M-01 the payment transition matrix in TypeScript and the database trigger agree on every (from, to) pair', async () => {
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      for (const from of PAYMENT_STATUSES) {
        for (const to of PAYMENT_STATUSES) {
          if (from === to) continue;
          const id = crypto.randomUUID();
          const org = crypto.randomUUID();
          await client.query(
            `INSERT INTO payment(id, producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency, status, "settledMethod")
             VALUES ($1, 'billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'organization', $2::text, $2::uuid, 100, 'TND', $3, $4)`,
            [id, org, from, from === 'succeeded' ? 'cash' : null],
          );
          let accepted = true;
          try {
            await client.query(`UPDATE payment SET status = $2, "settledMethod" = $3 WHERE id = $1`, [id, to, to === 'succeeded' ? 'cash' : null]);
          } catch (e) {
            expect((e as { code?: string }).code, `${from}->${to}`).toBe('23514');
            accepted = false;
          }
          // created -> succeeded is the one edge with a precondition (a succeeded, inferred-failed attempt): a bare UPDATE never meets it.
          const expected = from === 'created' && to === 'succeeded' ? false : canTransitionPayment(from, to);
          expect(accepted, `payment ${from} -> ${to}`).toBe(expected);
        }
      }
    } finally {
      await client.end();
    }
  });

  it('M-02 the attempt transition matrix in TypeScript and the database trigger agree, for both values of failureInferred', async () => {
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    try {
      for (const failureInferred of [false, true]) {
        for (const from of ATTEMPT_STATUSES) {
          for (const to of ATTEMPT_STATUSES) {
            if (from === to) continue;
            const paymentId = crypto.randomUUID();
            const org = crypto.randomUUID();
            await client.query(
              `INSERT INTO payment(id, producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", "organizationId", amount, currency)
               VALUES ($1, 'billing-service', gen_random_uuid(), 'invoice', 'i', 'user', 'u', 'organization', $2::text, $2::uuid, 100, 'TND')`,
              [paymentId, org],
            );
            const attemptId = crypto.randomUUID();
            await client.query(`INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider, status, "failureInferred") VALUES ($1, $2, 1, 'test', $3, $4)`, [attemptId, paymentId, from, failureInferred]);
            let accepted = true;
            try {
              await client.query(`UPDATE payment_attempt SET status = $2 WHERE id = $1`, [attemptId, to]);
            } catch (e) {
              expect((e as { code?: string }).code, `${from}->${to}`).toBe('23514');
              accepted = false;
            }
            expect(accepted, `attempt ${from} -> ${to} (failureInferred=${failureInferred})`).toBe(canTransitionAttempt(from, to, { failureInferred }));
          }
        }
      }
    } finally {
      await client.end();
    }
  });

  // ------------------------------------------------------------------------------- FI-12: trusted success only

  it('M-03 a client cannot assert success: unknown body fields are rejected, no mutating route exists, and a sync claim is ignored', async () => {
    await asBilling(request(server()).post('/payment/payments')).send(paymentBody({ status: 'succeeded' })).expect(400);
    await asBilling(request(server()).post('/payment/payments')).send(paymentBody({ settledMethod: 'cash' })).expect(400);
    const p = await create();
    await start(p.id, 'm03-key-aaaa', 'user-1-jwt', { status: 'succeeded' }).expect(400);
    for (const method of ['patch', 'put', 'delete'] as const) {
      await request(server())[method](`/payment/payments/${p.id}`).set('authorization', 'Bearer user-1-jwt').send({ status: 'succeeded' }).expect(404);
    }
    const a = (await start(p.id, 'm03-key-bbbb', 'user-1-jwt', { providerOptions: { scenario: 'timeout_before_accept' } }).expect(201)).body;
    await request(server()).post(`/payment/payments/${p.id}/attempts/${a.id}/sync`).set('authorization', 'Bearer user-1-jwt').send({ status: 'succeeded', amount: 1000 }).expect(200);
    expect((await get(p.id).expect(200)).body.status).not.toBe('succeeded'); // the provider said "no record"; the claim counted for nothing
    expect((await sql(`SELECT count(*)::int AS n FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [p.id])).rows[0].n).toBe(0);
  });

  it('M-04 the only code path that sets payment.status = succeeded is AttemptService.applyStatus (source scan)', async () => {
    const root = fileURLToPath(new URL('../src/', import.meta.url));
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.spec.ts') && /UPDATE payment SET[^`]*status = 'succeeded'/.test(readFileSync(full, 'utf8'))) hits.push(full.slice(root.length));
      }
    };
    walk(root);
    expect(hits).toEqual(['attempts/attempt.service.ts']);
  });

  // -------------------------------------------------------------------------------------------- idempotency

  it('M-05 start-attempt idempotency: same key+request replays the original 201 and attempt; changed body or another payment is 422; nothing runs twice', async () => {
    const p = await create();
    const first = await start(p.id, 'm05-key-aaaa').expect(201);
    const replay = await start(p.id, 'm05-key-aaaa').expect(201);
    expect(replay.body.id).toBe(first.body.id);
    expect((await sql('SELECT count(*)::int AS n FROM payment_attempt WHERE "paymentId" = $1', [p.id])).rows[0].n).toBe(1);
    const changed = await start(p.id, 'm05-key-aaaa', 'user-1-jwt', { providerOptions: { scenario: 'failure' } });
    expect(changed.status).toBe(422);
    expect(changed.body.code).toBe('idempotency_key_reused');
    const p2 = await create();
    const otherPayment = await start(p2.id, 'm05-key-aaaa'); // same key, same body, ANOTHER payment: different request (the path is hashed), never a replay of p's attempt
    expect(otherPayment.status).toBe(422);
    expect(otherPayment.body.code).toBe('idempotency_key_reused');
    expect((await sql('SELECT count(*)::int AS n FROM payment_attempt WHERE "paymentId" = $1', [p2.id])).rows[0].n).toBe(0);
  });

  it('M-06 idempotency is scoped by caller: two users may use the same key on their own payments', async () => {
    const p1 = await create();
    const p2 = await create({ payer: { type: 'user', id: 'user-2' } });
    const a1 = await start(p1.id, 'm06-shared-key', 'user-1-jwt').expect(201);
    const a2 = await start(p2.id, 'm06-shared-key', 'user-2-jwt').expect(201);
    expect(a1.body.id).not.toBe(a2.body.id);
  });

  it('M-07 concurrent same-key requests give one attempt and the same answer', async () => {
    const p = await create();
    const rs = await Promise.all(Array.from({ length: 6 }, () => start(p.id, 'm07-key-aaaa')));
    expect(rs.map((r) => r.status)).toEqual(Array(6).fill(201));
    expect(new Set(rs.map((r) => r.body.id)).size).toBe(1);
    expect((await sql('SELECT count(*)::int AS n FROM payment_attempt WHERE "paymentId" = $1', [p.id])).rows[0].n).toBe(1);
  });

  it('M-08 replay after a process restart (a brand-new application instance on the same database) returns the original attempt', async () => {
    const p = await create();
    const first = await start(p.id, 'm08-key-aaaa').expect(201);
    const restarted = await createTestApp({
      databaseUrl: db.url,
      tokens: [{ caller: 'billing-service', digest: billing.digest }],
      authClient,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir],
      env: { PAYMENT_TEST_PROVIDER: 'true' },
    });
    try {
      const replay = await start(p.id, 'm08-key-aaaa', 'user-1-jwt', { providerOptions: { scenario: 'success' } }, restarted).expect(201);
      expect(replay.body.id).toBe(first.body.id);
    } finally {
      await restarted.app.close();
    }
  });

  it('M-09 payment creation: natural key beyond any header expiry, per producer scope, and a changed expiresAt/description is a conflict', async () => {
    const body = paymentBody({ description: 'a', expiresAt: '2030-01-01T00:00:00Z' });
    await asBilling(request(server()).post('/payment/payments')).send(body).expect(201);
    const replay = await asBilling(request(server()).post('/payment/payments')).send(body).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect((await asBilling(request(server()).post('/payment/payments')).send({ ...body, description: 'b' })).status).toBe(409);
    expect((await asBilling(request(server()).post('/payment/payments')).send({ ...body, expiresAt: '2031-01-01T00:00:00Z' })).status).toBe(409);
    // The same paymentRequestId from ANOTHER producer is a different payment (the natural key is (producer, paymentRequestId)).
    await request(server()).post('/payment/payments').set('authorization', `Bearer ${other.token}`).send(body).expect(201);
  });

  // -------------------------------------------------------------------------------------------- authorization

  it('M-10 a user bearer is never a service credential, a service token is never a payer, and a service token is never forwarded to Auth', async () => {
    authCalls = [];
    await request(server()).post('/payment/payments').set('authorization', 'Bearer user-1-jwt').send(paymentBody()).expect(401);
    const p = await create();
    expect((await start(p.id, 'm10-key-aaaa', billing.token)).status).toBe(403); // the producer sees the payment but is not its payer
    await request(server()).get(`/payment/payments/${p.id}`).set('authorization', `Bearer ${billing.token}`).expect(200);
    expect(authCalls).not.toContain(billing.token);
    expect(authCalls).not.toContain('Bearer user-1-jwt');
  });

  it('M-11 an unrelated user, another producer, and an inactive payer all get the collapsed answer; no relation reveals existence', async () => {
    const p = await create();
    const missing = await get(crypto.randomUUID()).expect(404);
    const unrelated = await get(p.id, 'user-2-jwt').expect(404);
    expect(unrelated.body.message).toBe(missing.body.message);
    await request(server()).get(`/payment/payments/${p.id}`).set('authorization', `Bearer ${other.token}`).expect(404);
    await get(p.id, 'inactive-jwt').expect(401);
    await start(p.id, 'm11-key-aaaa', 'user-2-jwt').expect(404);
    await start(p.id, 'm11-key-bbbb', 'inactive-jwt').expect(401);
  });

  it('M-12 organization payers and organization members get NO access (O-18/O-20 are not invented): fails closed', async () => {
    const orgId = crypto.randomUUID();
    users['member-jwt'] = identity('member-1', {
      memberships: [{ id: 'm1', organization: { id: orgId }, platform: { id: 'p1' }, status: 'active', isOrganizationAdmin: true }],
    });
    const p = await create({ payer: { type: 'organization', id: orgId } });
    await get(p.id, 'member-jwt').expect(404);
    await start(p.id, 'm12-key-aaaa', 'member-jwt').expect(404);
    const asSeller = await create({ seller: { type: 'organization', id: orgId }, organizationId: orgId });
    await get(asSeller.id, 'member-jwt').expect(404); // the seller organization's members cannot read either (O-20)
  });

  it('M-13 a service token cannot impersonate a user through any header', async () => {
    const p = await create();
    const res = await request(server()).get(`/payment/payments/${p.id}`).set('authorization', `Bearer ${other.token}`).set('x-user-id', 'user-1').set('x-forwarded-user', 'user-1');
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------- terminal states / late-success cases

  it('M-14 case D: a second success callback (different event id) for an attempt that already succeeded is idempotent — no second effect', async () => {
    const p = await create();
    const a = (await start(p.id, 'm14-key-aaaa').expect(201)).body;
    const one = signedFor(a.providerTransactionId ?? `ptx_${a.id}`, `evt_${a.id}_1`);
    await webhook(one.body, one.signature).expect(200);
    const two = signedFor(`ptx_${a.id}`, `evt_${a.id}_2`);
    await webhook(two.body, two.signature).expect(200);
    const events = await sql(`SELECT state FROM webhook_event WHERE "providerEventId" LIKE $1 ORDER BY "providerEventId"`, [`evt_${a.id}%`]);
    expect(events.rows.map((r) => r.state)).toEqual(['processed', 'processed']);
    expect((await sql(`SELECT count(*)::int AS n FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [p.id])).rows[0].n).toBe(1);
    // FI-06: a settled payment accepts no further collection.
    expect((await start(p.id, 'm14-key-bbbb')).status).toBe(409);
  });

  it('M-15 case E: a payment that EXPIRED after an inferred failure, then gets a provider success, records a conflict and stays expired', async () => {
    const soon = new Date(Date.now() + 400).toISOString();
    const p = await create({ expiresAt: soon });
    const a = (await start(p.id, 'm15-key-aaaa', 'user-1-jwt', { providerOptions: { scenario: 'timeout_after_accept' } }).expect(201)).body;
    const provider = t.app.get(ProviderRegistry).get('test');
    await t.app.get(AttemptService).applyStatus(a.id, { kind: 'notFound' }, provider); // inferred failure; payment back to created
    await sleep(600);
    await t.app.get(ExpirySweeper).sweepOnce();
    expect((await get(p.id).expect(200)).body.status).toBe('expired');
    const late = signedFor(a.id, `evt_${a.id}`);
    await webhook(late.body, late.signature).expect(200);
    expect((await sql('SELECT state FROM webhook_event WHERE "providerEventId" = $1', [`evt_${a.id}`])).rows[0].state).toBe('conflict');
    expect((await get(p.id).expect(200)).body.status).toBe('expired');
  });

  it('M-16 terminal payments refuse new attempts with the SDD codes (failed/expired/succeeded -> 409)', async () => {
    const soon = await create({ expiresAt: new Date(Date.now() + 300).toISOString() });
    await sleep(500);
    const expiredNow = await start(soon.id, 'm16-key-aaaa');
    expect(expiredNow.status).toBe(409);
    expect(expiredNow.body.code).toBe('payment_expired'); // refused even before the sweeper has run
    await t.app.get(ExpirySweeper).sweepOnce();
    const afterSweep = await start(soon.id, 'm16-key-bbbb');
    expect(afterSweep.status).toBe(409);
  });

  // ---------------------------------------------------------------------------------------------- rate limit

  it('M-17 payment creation is rate limited per authenticated producer (429 rate_limited); unauthenticated calls cost no budget', async () => {
    const post = () => request(server(tLimited)).post('/payment/payments').set('authorization', `Bearer ${limited.token}`).send(paymentBody());
    for (let i = 0; i < 5; i++) await request(server(tLimited)).post('/payment/payments').send(paymentBody()).expect(401); // no token: never counted
    for (let i = 0; i < 3; i++) await post().expect(201);
    const blocked = await post();
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
    await request(server(tLimited)).post('/payment/payments').set('authorization', `Bearer ${third.token}`).send(paymentBody()).expect(201); // another producer is unaffected
  });

  it('M-18 attempts are rate limited per payer; a replay of an idempotent request still counts, and another payer is unaffected', async () => {
    users['limited-user-jwt'] = identity('limited-user');
    const p = await request(server(tLimited)).post('/payment/payments').set('authorization', `Bearer ${fourth.token}`).send(paymentBody({ payer: { type: 'user', id: 'limited-user' } })).expect(201);
    const s = (key: string) => start(p.body.id, key, 'limited-user-jwt', { providerOptions: { scenario: 'success' } }, tLimited);
    await s('m18-key-aaaa').expect(201);
    await s('m18-key-aaaa').expect(201);
    expect((await s('m18-key-aaaa')).status).toBe(429);
    const other1 = await request(server(tLimited)).post('/payment/payments').set('authorization', `Bearer ${fourth.token}`).send(paymentBody({ payer: { type: 'user', id: 'limited-user-2' } })).expect(201);
    await start(other1.body.id, 'm18-key-bbbb', 'limited-user-2-jwt', undefined, tLimited).expect(201); // a different payer has their own budget
  });

  // ------------------------------------------------------------------------------------------------ DB concurrency

  it('M-19 FI-09 race: two attempts on different payments claiming the same (provider, providerTransactionId) — exactly one wins', async () => {
    const mk = async () => {
      const p = await create();
      const id = crypto.randomUUID();
      await sql(`INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider) VALUES ($1, $2, 1, 'test')`, [id, p.id]);
      return id;
    };
    const [a, b] = [await mk(), await mk()];
    const claim = (id: string) => sql(`UPDATE payment_attempt SET status = 'submitted', "providerTransactionId" = 'same-txn' WHERE id = $1`, [id]);
    const results = await Promise.allSettled([claim(a), claim(b)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as { code: string }).code).toBe('23505');
    // A different provider may legitimately reuse the same transaction id; null ids never collide.
    const c = await mk();
    await sql(`UPDATE payment_attempt SET status = 'submitted' WHERE id = $1`, [c]);
    const d = crypto.randomUUID();
    const pd = await create();
    await sql(`INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider, status, "providerTransactionId") VALUES ($1, $2, 1, 'other', 'submitted', 'same-txn')`, [d, pd.id]);
  });

  it('M-20 webhook body larger than the configured limit is refused (413) and persists nothing', async () => {
    const big = Buffer.from(JSON.stringify({ eventId: 'evt_big', type: 'payment.succeeded', reference: 'x', pad: 'a'.repeat(200 * 1024) }), 'utf8');
    const res = await webhook(big, sign(big));
    expect(res.status).toBe(413);
    expect((await sql(`SELECT 1 FROM webhook_event WHERE "providerEventId" = 'evt_big'`)).rows).toHaveLength(0);
  });
});

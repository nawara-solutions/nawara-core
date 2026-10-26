import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { TestPaymentProvider } from '../src/providers/test-provider.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '1e0a7c5b-3d2f-4a6b-9c8d-7e6f5a4b3c21';
type Row = Record<string, any>;

const body = (over: Row = {}) => ({
  paymentRequestId: crypto.randomUUID(), sourceType: 'invoice', sourceId: `inv-${crypto.randomUUID().slice(0, 8)}`,
  payer: { type: 'user', id: BUYER }, seller: { type: 'company', id: 'nawara-company-reference' },
  amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER, ...over,
});

/**
 * Core V2 S4d (register PAY-05, I-6; S0 FC-1, V-2; ADR-0035 C2): immutable provider transaction facts through the REAL application on real
 * PostgreSQL 16 with the deterministic test provider (simulation only). Every observation arrives through an authenticated channel — a
 * signature-verified webhook or the provider status read — and nothing here fabricates provider data or marks anything successful by hand.
 */
describeWithEnv('provider transaction facts (Core V2 S4d) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const billing = generateServiceToken();
  const identities: Record<string, AuthIdentity> = { 'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] } };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const server = () => t.app.getHttpServer();
  const create = async (over: Row = {}) => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send(body(over)).expect(201)).body;
  const read = (id: string) => request(server()).get(`/payment/payments/${id}`).set('authorization', `Bearer ${billing.token}`);
  const start = async (id: string, scenario: string) =>
    (await request(server()).post(`/payment/payments/${id}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', `k-${crypto.randomUUID()}`)
      .send({ providerOptions: { scenario } }).expect(201)).body;
  const sync = (pid: string, aid: string) => request(server()).post(`/payment/payments/${pid}/attempts/${aid}/sync`).set('authorization', 'Bearer buyer-jwt').send({});
  const cancel = (id: string) => request(server()).post(`/payment/payments/${id}/cancel`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', `c-${crypto.randomUUID()}`).send({});
  const provider = () => t.app.get(TestPaymentProvider);
  const post = (raw: Buffer, signature: string, path = 'test') =>
    request(server()).post(`/payment/webhooks/${path}`).set('content-type', 'application/json').set('x-test-provider-signature', signature).send(raw.toString('utf8'));
  /** A notification signed with the test provider's secret (the provider's own messages come from `signSuccessCallback`). */
  const signed = (payload: Row) => {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    return { raw, signature: createHmac('sha256', 'test-provider-webhook-secret').update(raw).digest('hex') };
  };
  const facts = async (aid: string) => (await admin.query(
    `SELECT provider, "providerTxnId", kind, "paymentId", amount::int, currency, "liveMode", source, "webhookEventId" IS NOT NULL AS webhook FROM provider_transaction_fact WHERE "attemptId" = $1`, [aid])).rows;
  const conflicts = async (aid: string) => (await admin.query(`SELECT amount::int, source FROM provider_transaction_fact_conflict WHERE "attemptId" = $1`, [aid])).rows;
  const succeededEvents = async (pid: string) => Number((await admin.query(`SELECT count(*) FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [pid])).rows[0].count);

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentfacts');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    t = await createTestApp({
      databaseUrl: db.url, tokens: [{ caller: 'billing-service', digest: billing.digest }], authClient,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], env: { PAYMENT_TEST_PROVIDER: 'true', PAYMENT_MAX_ATTEMPTS: '1' },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  describe('verified evidence', () => {
    it('a verified webhook capture is ONE fact (simulation, bound to its payment and attempt), committed and then applied once', async () => {
      const p = await create();
      const a = await start(p.id, 'success');
      const cb = provider().signSuccessCallback(a.id);
      await post(cb.body, cb.signature).expect(200);
      expect(await facts(a.id)).toEqual([{ provider: 'test', providerTxnId: `ptx_${a.id}`, kind: 'capture', paymentId: p.id, amount: 9000, currency: 'TND', liveMode: false, source: 'webhook', webhook: true }]);
      expect((await read(p.id).expect(200)).body.status).toBe('succeeded');
      expect(await succeededEvents(p.id)).toBe(1);
    });

    it('the same capture through the status read and then the webhook (and both again, concurrently) is still one fact', async () => {
      const p = await create();
      const a = await start(p.id, 'success');
      const cb = provider().signSuccessCallback(a.id);
      await sync(p.id, a.id).expect(200); // the provider status read sees it first
      await Promise.all([post(cb.body, cb.signature), post(cb.body, cb.signature), sync(p.id, a.id), sync(p.id, a.id)]);
      const f = await facts(a.id);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ source: 'status_check', webhook: false, providerTxnId: `ptx_${a.id}` });
      expect(await conflicts(a.id)).toEqual([]);
      expect(await succeededEvents(p.id)).toBe(1);
    });

    it('failures, expiries, unknown and pending answers are not money movements: no fact', async () => {
      const failed = await create();
      const fa = await start(failed.id, 'failure'); // the provider's own rejection
      const unknown = await create();
      const ua = await start(unknown.id, 'timeout_before_accept'); // ambiguous, then "no record" (an inferred failure)
      await sync(unknown.id, ua.id);
      const fail = signed({ eventId: `evt_fail_${ua.id}`, type: 'payment.failed', reference: ua.id, data: { failureCode: 'card_declined' } });
      await post(fail.raw, fail.signature).expect(200); // provider-confirmed failure
      expect([...(await facts(fa.id)), ...(await facts(ua.id))]).toEqual([]);
    });

    it('an unauthenticated message never becomes a fact: a bad signature is 401 and stores nothing; an unknown provider is 404', async () => {
      const p = await create();
      const a = await start(p.id, 'success');
      const cb = provider().signSuccessCallback(a.id);
      await post(cb.body, 'ab'.repeat(32)).expect(401);
      await post(cb.body, cb.signature, 'other').expect(404);
      expect(await facts(a.id)).toEqual([]);
      expect((await read(p.id).expect(200)).body.status).toBe('pending');
    });

    it('FI-13: a capture of another amount is recorded as the provider reported it, and is never applied', async () => {
      const p = await create();
      const a = await start(p.id, 'success_amount_mismatch');
      expect((await sync(p.id, a.id)).status).toBe(502);
      expect(await facts(a.id)).toEqual([expect.objectContaining({ amount: 9001, source: 'status_check' })]); // never refused, never edited
      expect((await read(p.id).expect(200)).body.status).toBe('pending');
      expect(await succeededEvents(p.id)).toBe(0);
    });

    it('a contradicting observation of the same provider transaction is kept, once, as a conflict; the fact never changes', async () => {
      const p = await create();
      const a = await start(p.id, 'success');
      await sync(p.id, a.id).expect(200); // fact: 9000
      const other = signed({ eventId: `evt_other_${a.id}`, type: 'payment.succeeded', reference: `ptx_${a.id}`, amount: 4500, currency: 'TND' });
      await post(other.raw, other.signature).expect(200);
      await post(other.raw, other.signature).expect(200); // the provider retries its contradiction
      expect(await facts(a.id)).toEqual([expect.objectContaining({ amount: 9000 })]);
      expect(await conflicts(a.id)).toEqual([{ amount: 4500, source: 'webhook' }]);
      expect(await succeededEvents(p.id)).toBe(1);
    });
  });

  describe('S4c compatibility', () => {
    it('a capture during closing is a fact and settles the payment (one payment.succeeded)', async () => {
      const p = await create();
      const a = await start(p.id, 'timeout_after_accept'); // the provider DID record it
      await cancel(p.id).expect(202);
      // the attempt never learned the provider's transaction id (ambiguous answer), so the notification names it by merchant reference
      const cb = signed({ eventId: `evt_ok_${a.id}`, type: 'payment.succeeded', reference: a.id, amount: 9000, currency: 'TND' });
      await post(cb.raw, cb.signature).expect(200);
      expect(await facts(a.id)).toHaveLength(1);
      expect((await read(p.id).expect(200)).body.status).toBe('succeeded');
      expect(await succeededEvents(p.id)).toBe(1);
    });

    it('a capture after the workflow ended is a fact AND a late success that references it; the payment is never reopened or announced', async () => {
      const p = await create();
      const a = await start(p.id, 'timeout_after_accept');
      const fail = signed({ eventId: `evt_fail_${a.id}`, type: 'payment.failed', reference: a.id, data: { failureCode: 'card_declined' } });
      await post(fail.raw, fail.signature).expect(200); // a provider-confirmed failure: the payment fails (limit 1)
      expect((await read(p.id).expect(200)).body.status).toBe('failed');
      expect((await sync(p.id, a.id)).status).toBe(409); // ...and yet the provider reports the capture
      const cb = signed({ eventId: `evt_ok_${a.id}`, type: 'payment.succeeded', reference: a.id, amount: 9000, currency: 'TND' });
      await post(cb.raw, cb.signature).expect(200);
      const [fact] = await admin.query(`SELECT id FROM provider_transaction_fact WHERE "attemptId" = $1`, [a.id]).then((r) => r.rows);
      expect(fact).toBeDefined();
      const lateRows = (await admin.query(`SELECT source, "factId" FROM payment_late_success WHERE "attemptId" = $1 ORDER BY "recordedAt"`, [a.id])).rows;
      expect(lateRows).toEqual([{ source: 'status_check', factId: fact.id }, { source: 'webhook', factId: fact.id }]); // one fact, two observations
      expect((await read(p.id).expect(200)).body.status).toBe('failed');
      expect(await succeededEvents(p.id)).toBe(0); // no automatic purchase downstream
    });
  });

  describe('immutability', () => {
    it('raw SQL can neither edit nor delete a fact or a conflict', async () => {
      const p = await create();
      const a = await start(p.id, 'success');
      await sync(p.id, a.id).expect(200);
      for (const sql of ['UPDATE provider_transaction_fact SET amount = 1', 'DELETE FROM provider_transaction_fact', 'UPDATE provider_transaction_fact_conflict SET amount = 1']) {
        await expect(admin.query(sql)).rejects.toMatchObject({ code: '23514' });
      }
      expect(await facts(a.id)).toHaveLength(1);
    });
  });
});

import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
 * Core V2 S0-C11 (register PAY-02 G, PAY-05 I; findings F-27, F-28): capture evidence for commercial effect, through the REAL application on real
 * PostgreSQL 16 with the deterministic test provider (simulation only). Every observation is signed or comes from the provider status read.
 * `9001` is what the `success_amount_mismatch` scenario reports for a payment of 9000.
 */
describeWithEnv('capture evidence (Core V2 S0-C11) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
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

  const status = async (id: string) => (await read(id).expect(200)).body.status as string;
  const lateSuccesses = async (pid: string) => (await admin.query(`SELECT amount::int, "factId", "paymentStatus" FROM payment_late_success WHERE "paymentId" = $1 ORDER BY "recordedAt"`, [pid])).rows;
  const lateEvents = async (pid: string) => Number((await admin.query(`SELECT count(*) FROM outbox WHERE name = 'payment.late_success.recorded' AND payload->>'paymentId' = $1`, [pid])).rows[0].count);
  const conflictAudits = async (aid: string) => (await admin.query(`SELECT payload FROM outbox WHERE name = 'audit.provider_fact_conflict.recorded' AND payload->'changes'->>'attempt_id' = $1`, [aid])).rows.map((r) => r.payload);
  const webhookState = async (eventId: string) => (await admin.query(`SELECT state, outcome FROM webhook_event WHERE "providerEventId" = $1`, [eventId])).rows[0];
  /** A signed capture notification naming this attempt, under an explicit provider reference, or none (the parser below honours what it states). */
  const capture = (aid: string, amount: number, txn?: string, currency = 'TND') => {
    const eventId = `evt_${crypto.randomUUID()}`;
    const n = signed({ eventId, type: 'payment.succeeded', reference: aid, amount, currency, providerTransactionId: txn ?? null });
    return { eventId, send: () => post(n.raw, n.signature) };
  };
  const noCommercialEffect = async (pid: string) => {
    expect(await succeededEvents(pid)).toBe(0);
    expect(await lateSuccesses(pid)).toEqual([]);
    expect(await lateEvents(pid)).toBe(0);
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentcapture');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    t = await createTestApp({
      databaseUrl: db.url, tokens: [{ caller: 'billing-service', digest: billing.digest }], authClient,
      migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], env: { PAYMENT_TEST_PROVIDER: 'true', PAYMENT_MAX_ATTEMPTS: '2' },
    });
    // The test provider derives its reference from the attempt. These scenarios need what a real adapter can report: another reference, or none (the
    // simulation adapter's parser does the same). Applied to the parsing only: the signature check and everything after it are the application's own.
    const parse = provider().parseStoredBody.bind(provider());
    vi.spyOn(provider(), 'parseStoredBody').mockImplementation((raw) => {
      const parsed = parse(raw);
      if (!parsed) return parsed;
      const stated = JSON.parse(raw.toString('utf8')) as Row;
      return 'providerTransactionId' in stated ? { ...parsed, providerTransactionId: stated.providerTransactionId ?? undefined } : parsed;
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  describe('F-27: a wrong amount followed by a corrected observation', () => {
    it('webhook then webhook: the first fact stands, the correction is one contested observation; no settlement, purchase or late success', async () => {
      const p = await create();
      const a = await start(p.id, 'success');
      const txn = `ptx_${a.id}`;
      await capture(a.id, 9001, txn).send().expect(200);
      const correction = capture(a.id, 9000, txn);
      await correction.send().expect(200);
      expect((await facts(a.id)).map((f) => f.amount)).toEqual([9001]);
      expect(await conflicts(a.id)).toEqual([{ amount: 9000, source: 'webhook' }]);
      expect(await webhookState(correction.eventId)).toMatchObject({ state: 'conflict', outcome: 'provider_error' });
      expect(await status(p.id)).toBe('pending');
      await noCommercialEffect(p.id);
    });

    it('status read then webhook: the same; and a later matching status read settles nothing either', async () => {
      const p = await create();
      const a = await start(p.id, 'success_amount_mismatch');
      expect((await sync(p.id, a.id)).status).toBe(502); // the provider's status read: 9001
      await capture(a.id, 9000, `ptx_${a.id}`).send().expect(200);
      expect((await sync(p.id, a.id)).status).toBe(502);
      expect((await facts(a.id)).map((f) => [f.amount, f.source])).toEqual([[9001, 'status_check']]);
      expect(await conflicts(a.id)).toEqual([{ amount: 9000, source: 'webhook' }]);
      expect(await status(p.id)).toBe('pending');
      await noCommercialEffect(p.id);
    });

    it('webhook then a corrected status read: the status read contradicts the fact and settles nothing; the response names no provider value', async () => {
      const p = await create();
      const a = await start(p.id, 'success'); // the status read will say 9000
      await capture(a.id, 8000, `ptx_${a.id}`).send().expect(200);
      const res = await sync(p.id, a.id);
      expect([res.status, res.body.code]).toEqual([502, 'provider_error']);
      expect(JSON.stringify(res.body)).not.toContain('8000');
      expect((await facts(a.id)).map((f) => f.amount)).toEqual([8000]);
      expect(await conflicts(a.id)).toEqual([{ amount: 9000, source: 'status_check' }]);
      expect(await status(p.id)).toBe('pending');
      expect((await conflictAudits(a.id))[0]).toMatchObject({ actor: { type: 'system', id: 'payment_status_read' }, changes: { source: 'status_check', observed_amount: 9000 } });
      await noCommercialEffect(p.id);
    });

    it('a repeat of the corrected amount, once contested, still settles nothing, and each contradicting observation is kept and audited once', async () => {
      const p = await create();
      const a = await start(p.id, 'success');
      const txn = `ptx_${a.id}`;
      await capture(a.id, 9001, txn).send().expect(200);
      await capture(a.id, 9000, txn).send().expect(200);
      await capture(a.id, 9000, txn).send().expect(200);
      expect(await conflicts(a.id)).toHaveLength(2); // one per notification: kept, never overwriting the fact or each other
      const audits = await conflictAudits(a.id);
      expect(audits).toHaveLength((await conflicts(a.id)).length);
      const [fact] = (await admin.query(`SELECT id FROM provider_transaction_fact WHERE "attemptId" = $1`, [a.id])).rows;
      expect(audits[0]).toMatchObject({ action: 'provider_fact_conflict.recorded', outcome: 'succeeded', resource: { type: 'provider_transaction_fact', id: fact.id },
        actor: { type: 'system', id: 'payment_webhook' }, changes: { payment_id: p.id, attempt_id: a.id, source: 'webhook', observed_amount: 9000 } });
      expect(await status(p.id)).toBe('pending');
      await noCommercialEffect(p.id);
    });

    it('a forged correction is refused before it counts: 401, nothing stored, the capture stays as it was', async () => {
      const p = await create();
      const a = await start(p.id, 'success');
      const n = signed({ eventId: `evt_${crypto.randomUUID()}`, type: 'payment.succeeded', reference: a.id, amount: 9000, currency: 'TND', providerTransactionId: `ptx_${a.id}` });
      await post(n.raw, 'ab'.repeat(32)).expect(401);
      expect(await facts(a.id)).toEqual([]);
      expect(await conflicts(a.id)).toEqual([]);
      expect(await conflictAudits(a.id)).toEqual([]);
      expect(await status(p.id)).toBe('pending');
    });

    it('a reference recorded under another payment contradicts it: the other fact never changes and nothing settles here', async () => {
      const first = await create();
      const fa = await start(first.id, 'success');
      await sync(first.id, fa.id).expect(200);
      const second = await create();
      const sa = await start(second.id, 'success');
      await capture(sa.id, 9000, `ptx_${fa.id}`).send().expect(200);
      expect((await facts(fa.id))[0]).toMatchObject({ paymentId: first.id, amount: 9000 });
      expect(await conflicts(sa.id)).toEqual([{ amount: 9000, source: 'webhook' }]);
      expect(await status(second.id)).toBe('pending');
      await noCommercialEffect(second.id);
      expect(await status(first.id)).toBe('succeeded');
    });
  });

  describe('F-28: a capture with no provider reference', () => {
    it('webhook: no fact, no settlement, no late success; the notification stays stored and visible', async () => {
      const p = await create();
      const a = await start(p.id, 'timeout_before_accept'); // the attempt learned no provider reference
      const n = capture(a.id, 9000);
      await n.send().expect(200);
      expect(await facts(a.id)).toEqual([]);
      expect(await webhookState(n.eventId)).toMatchObject({ state: 'conflict', outcome: 'provider_error' });
      expect(await status(p.id)).not.toBe('succeeded');
      await noCommercialEffect(p.id);
    });

    it('status read: refused the same way', async () => {
      const p = await create();
      const a = await start(p.id, 'timeout_before_accept');
      const spy = vi.spyOn(provider(), 'fetchStatus').mockResolvedValueOnce({ kind: 'succeeded', amount: 9000, currency: 'TND' });
      expect((await sync(p.id, a.id)).status).toBe(502);
      spy.mockRestore();
      expect(await facts(a.id)).toEqual([]);
      expect(await status(p.id)).not.toBe('succeeded');
      await noCommercialEffect(p.id);
    });

    it('on a final payment: no late success', async () => {
      const p = await create();
      const a = await start(p.id, 'failure');
      await cancel(p.id).expect(200);
      await capture(a.id, 9000).send().expect(200);
      expect(await facts(a.id)).toEqual([]);
      expect(await status(p.id)).toBe('cancelled');
      await noCommercialEffect(p.id);
    });
  });

  describe('several capture references on one attempt', () => {
    it('neither settles, in either order, and both stay distinct facts with no merging', async () => {
      const p = await create();
      const a = await start(p.id, 'success');
      await capture(a.id, 9001, `ref_a_${a.id}`).send().expect(200);
      await capture(a.id, 9000, `ref_b_${a.id}`).send().expect(200); // equal to the payment, but not the attempt's single capture
      expect((await facts(a.id)).map((f) => [f.providerTxnId, f.amount]).sort()).toEqual([[`ref_a_${a.id}`, 9001], [`ref_b_${a.id}`, 9000]]);
      expect(await conflicts(a.id)).toEqual([]);
      expect(await status(p.id)).toBe('pending');
      await noCommercialEffect(p.id);
    });

    it('two equal captures under different references settle on the first only: the second stays its own fact (R6H-5, unchanged)', async () => {
      const p = await create();
      const a = await start(p.id, 'success');
      await capture(a.id, 9000, `ref_a_${a.id}`).send().expect(200);
      await capture(a.id, 9000, `ref_b_${a.id}`).send().expect(200);
      expect(await facts(a.id)).toHaveLength(2);
      expect(await status(p.id)).toBe('succeeded');
      expect(await succeededEvents(p.id)).toBe(1);
    });
  });

  describe('a contradiction after a commercial effect', () => {
    it('after settlement: the payment stays succeeded, nothing is reversed or re-emitted, and it is visible and audited', async () => {
      const p = await create();
      const a = await start(p.id, 'success');
      await sync(p.id, a.id).expect(200);
      await capture(a.id, 4500, `ptx_${a.id}`).send().expect(200);
      expect((await facts(a.id)).map((f) => f.amount)).toEqual([9000]);
      expect(await conflicts(a.id)).toEqual([{ amount: 4500, source: 'webhook' }]);
      expect(await status(p.id)).toBe('succeeded');
      expect(await succeededEvents(p.id)).toBe(1);
      expect(await lateSuccesses(p.id)).toEqual([]);
      expect(await conflictAudits(a.id)).toHaveLength(1);
    });

    it('after finality: a contradiction records no new late success; the earlier one stands, equal to its fact', async () => {
      const p = await create();
      const a = await start(p.id, 'failure');
      await cancel(p.id).expect(200);
      const txn = `ptx_late_${a.id}`;
      await capture(a.id, 9000, txn).send().expect(200);
      expect((await lateSuccesses(p.id)).map((l) => [l.amount, l.paymentStatus])).toEqual([[9000, 'cancelled']]);
      await capture(a.id, 4500, txn).send().expect(200);
      await capture(a.id, 9000, txn).send().expect(200); // equal to the fact, but the fact is now contested
      expect(await lateSuccesses(p.id)).toHaveLength(1);
      expect(await lateEvents(p.id)).toBe(1);
      expect(await status(p.id)).toBe('cancelled');
    });

    it('a wrong amount then a correction on a final payment: never a late success naming the first fact with the corrected figure', async () => {
      const p = await create();
      const a = await start(p.id, 'failure');
      await cancel(p.id).expect(200);
      const txn = `ptx_late_${a.id}`;
      await capture(a.id, 9001, txn).send().expect(200);
      await capture(a.id, 9000, txn).send().expect(200);
      expect((await facts(a.id)).map((f) => f.amount)).toEqual([9001]);
      // Core V2 S0-C12 item 2 (A1, adopted #467; supersedes this test's earlier FI-13 expectation of no late success at all): the first, uncontested
      // observation of a final payment is ONE refund-only late success with ITS OWN figures (9001). The correction (9000) is a contradiction: it
      // never settles, never names that fact with the corrected figure, and records no second late success
      const factId = (await admin.query(`SELECT id FROM provider_transaction_fact WHERE "attemptId" = $1`, [a.id])).rows[0].id as string;
      expect(await lateSuccesses(p.id)).toEqual([{ amount: 9001, factId, paymentStatus: 'cancelled' }]);
      expect((await lateSuccesses(p.id)).some((l) => l.amount === 9000)).toBe(false);
      expect(await lateEvents(p.id)).toBe(1);
      expect(await conflicts(a.id)).toEqual([expect.objectContaining({ amount: 9000 })]);
      expect(await succeededEvents(p.id)).toBe(0);
      expect(await status(p.id)).toBe('cancelled');
    });
  });

  describe('matching and mismatching provider status reads', () => {
    it('a matching read settles once; a mismatching one never does', async () => {
      const good = await create();
      const ga = await start(good.id, 'success');
      await sync(good.id, ga.id).expect(200);
      expect(await status(good.id)).toBe('succeeded');
      const bad = await create();
      const ba = await start(bad.id, 'success_amount_mismatch');
      expect((await sync(bad.id, ba.id)).status).toBe(502);
      expect((await facts(ba.id)).map((f) => f.amount)).toEqual([9001]);
      expect(await status(bad.id)).toBe('pending');
      await noCommercialEffect(bad.id);
    });
  });

  describe('F-4 is preserved', () => {
    it('a verified capture during closing settles; a verified matching capture after the workflow ended is recorded and changes nothing', async () => {
      const p = await create();
      const a = await start(p.id, 'timeout_after_accept');
      await cancel(p.id).expect(202);
      expect(await status(p.id)).toBe('closing');
      await sync(p.id, a.id).expect(200);
      expect(await status(p.id)).toBe('succeeded');
      expect(await succeededEvents(p.id)).toBe(1);
      const ended = await create();
      const ea = await start(ended.id, 'failure');
      await cancel(ended.id).expect(200);
      await capture(ea.id, 9000, `ptx_late_${ea.id}`).send().expect(200);
      expect(await lateSuccesses(ended.id)).toMatchObject([{ amount: 9000, paymentStatus: 'cancelled' }]);
      expect(await status(ended.id)).toBe('cancelled');
      expect(await succeededEvents(ended.id)).toBe(0);
    });

    it('a verified capture against a confirmed failure on an open payment is recorded as a fact, changes nothing and emits no settlement or late success (FN-2); the payment\'s own finality then records its late success', async () => {
      const p = await create();
      const a = await start(p.id, 'failure'); // a provider-confirmed failure; one attempt of two: the payment stays open
      expect(await status(p.id)).toBe('created');
      await capture(a.id, 9000, `ptx_late_${a.id}`).send().expect(200);
      expect(await facts(a.id)).toHaveLength(1);
      expect(await lateSuccesses(p.id)).toEqual([]); // S0-C12 FN-2: until 0026 this recorded a late success stating `created`, which Billing could never hold
      expect(await lateEvents(p.id)).toBe(0);
      expect(await status(p.id)).toBe('created');
      expect(await succeededEvents(p.id)).toBe(0);
      await start(p.id, 'failure');
      expect(await status(p.id)).toBe('failed');
      expect(await lateSuccesses(p.id)).toMatchObject([{ amount: 9000, paymentStatus: 'failed' }]);
      expect(await lateEvents(p.id)).toBe(1);
    });

    it('a verified capture after an inferred failure settles', async () => {
      const p = await create();
      const a = await start(p.id, 'timeout_before_accept');
      await sync(p.id, a.id); // "no record": an inferred failure
      await capture(a.id, 9000, `ptx_${a.id}`).send().expect(200);
      expect(await status(p.id)).toBe('succeeded');
      expect(await succeededEvents(p.id)).toBe(1);
    });
  });

  describe('direct SQL cannot bypass the guards', () => {
    /** An open attempt marked succeeded by hand, as a bypass would have to: the payment's own move is what must be refused. */
    const rigged = async () => {
      const p = await create();
      const a = (await admin.query(`INSERT INTO payment_attempt (id, "paymentId", "attemptNumber", provider) VALUES (gen_random_uuid(), $1, 1, 'test') RETURNING id`, [p.id])).rows[0] as Row;
      await admin.query(`UPDATE payment SET status = 'pending' WHERE id = $1`, [p.id]);
      await admin.query(`UPDATE payment_attempt SET status = 'submitted' WHERE id = $1`, [a.id]);
      await admin.query(`UPDATE payment_attempt SET status = 'succeeded', "completedAt" = now() WHERE id = $1`, [a.id]);
      return { p, a };
    };
    const fact = async (a: Row, p: Row, amount = 9000, currency = 'TND', txn = `sql_${crypto.randomUUID()}`) => (await admin.query(
      `INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", amount, currency, "liveMode", source)
       VALUES ('test', $1, 'capture', $2, $3, $4, $5, false, 'status_check') RETURNING id`, [txn, p.id, a.id, amount, currency])).rows[0].id as string;
    const contest = (factId: string, a: Row, p: Row) => admin.query(
      `INSERT INTO provider_transaction_fact_conflict ("factId", "paymentId", "attemptId", provider, amount, currency, source) VALUES ($1, $2, $3, 'test', 1, 'TND', 'status_check')`, [factId, p.id, a.id]);
    const settle = (p: Row, a: Row) => admin.query(`UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway', "succeededAttemptId" = $2, "closedAt" = now() WHERE id = $1`, [p.id, a.id]);
    const refused = { constraint: 'payment_settlement_capture_evidence' };

    it('a raw INSERT of an already settled gateway payment needs the same evidence', async () => {
      const b = body();
      await expect(admin.query(
        `INSERT INTO payment (id, "paymentRequestId", producer, "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency, status, "settledMethod", "succeededAttemptId", purpose, "beneficiaryUserId", "liveMode")
         VALUES (gen_random_uuid(), $1, 'billing-service', 'invoice', $2, 'user', $3, 'company', 'nawara-company-reference', 9000, 'TND', 'succeeded', 'gateway', gen_random_uuid(), 'direct_purchase', $3, false)`,
        [b.paymentRequestId, b.sourceId, BUYER])).rejects.toMatchObject({ code: '23514' });
    });

    it('settlement is refused with no fact, a wrong amount, a wrong currency, a contested fact and two facts; a single equal fact is admitted', async () => {
      const none = await rigged();
      await expect(settle(none.p, none.a)).rejects.toMatchObject(refused);
      const wrong = await rigged();
      await fact(wrong.a, wrong.p, 9001);
      await expect(settle(wrong.p, wrong.a)).rejects.toMatchObject(refused);
      const other = await rigged();
      await fact(other.a, other.p, 9000, 'EUR');
      await expect(settle(other.p, other.a)).rejects.toMatchObject(refused);
      const contested = await rigged();
      await contest(await fact(contested.a, contested.p), contested.a, contested.p);
      await expect(settle(contested.p, contested.a)).rejects.toMatchObject(refused);
      const two = await rigged();
      await fact(two.a, two.p);
      await fact(two.a, two.p);
      await expect(settle(two.p, two.a)).rejects.toMatchObject(refused);
      for (const r of [none, wrong, other, contested, two]) expect(await status(r.p.id)).not.toBe('succeeded');
      const good = await rigged();
      await fact(good.a, good.p);
      await settle(good.p, good.a);
      expect(await status(good.p.id)).toBe('succeeded');
      // a contradiction after settlement is still recorded: nothing rechecks a settled row
      const [f] = (await admin.query(`SELECT id FROM provider_transaction_fact WHERE "attemptId" = $1`, [good.a.id])).rows;
      await contest(f.id, good.a, good.p);
      expect(await status(good.p.id)).toBe('succeeded');
    });

    it('a late success is refused with no fact, another attempt\'s fact, another amount or currency, and a contested fact; an equal one is admitted', async () => {
      const lateRow = (p: Row, a: Row, factId: string | null, amount = 9000, currency = 'TND') => admin.query(
        `INSERT INTO payment_late_success ("paymentId", "attemptId", source, amount, currency, "paymentStatus", "factId") VALUES ($1, $2, 'status_check', $3, $4, 'cancelled', $5)`, [p.id, a.id, amount, currency, factId]);
      const lateRefused = { constraint: 'payment_late_success_fact_binding' };
      const { p, a } = await rigged();
      const { p: p2, a: a2 } = await rigged();
      const mine = await fact(a, p);
      const others = await fact(a2, p2);
      await expect(lateRow(p, a, null)).rejects.toMatchObject(lateRefused);
      await expect(lateRow(p, a, others)).rejects.toMatchObject(lateRefused);
      await expect(lateRow(p, a, mine, 4500)).rejects.toMatchObject(lateRefused);
      await expect(lateRow(p, a, mine, 9000, 'EUR')).rejects.toMatchObject(lateRefused);
      await expect(lateRow(p, a, mine), 'S0-C12 FN-2: the payment is not final').rejects.toMatchObject({ constraint: 'payment_late_success_not_final' });
      await admin.query(`UPDATE payment SET status = 'cancelled', "closedAt" = now() WHERE id = $1`, [p.id]);
      await lateRow(p, a, mine);
      const { p: p3, a: a3 } = await rigged();
      const contested = await fact(a3, p3);
      await contest(contested, a3, p3);
      await expect(lateRow(p3, a3, contested)).rejects.toMatchObject(lateRefused);
    });

    it('a fact and a contradiction stay append-only', async () => {
      const { p, a } = await rigged();
      const f = await fact(a, p);
      await contest(f, a, p);
      await expect(admin.query(`UPDATE provider_transaction_fact SET amount = 1 WHERE id = $1`, [f])).rejects.toThrow();
      await expect(admin.query(`DELETE FROM provider_transaction_fact_conflict WHERE "factId" = $1`, [f])).rejects.toThrow();
    });
  });
});

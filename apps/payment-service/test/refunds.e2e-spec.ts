import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { RefundWorker } from '../src/refunds/refund-worker.js';
import { TEST_PLATFORM, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { startFakeReceiptServer, type FakeReceiptServer } from './support/fake-receipts.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '2f1b8d6c-4e3a-4b7c-8d9e-0f1a2b3c4d5e';
const COMPANY = '5b0c2f4e-1d3a-4c6b-8e9f-0a1b2c3d4e5f';
const OWNER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const SECRET = randomBytes(32).toString('hex');
type Row = Record<string, any>;

/**
 * Core V2 S6b refund attempts (register PAY-07, PAY-08, PAY-05; ADR-0067 decisions 3 to 7; S0 FC-1, FC-5, FC-7, FC-10; the Owner's R6B-1 to
 * R6B-10) through the REAL application on real PostgreSQL 16, on the simulation provider, with Auth's receipt routes served over real HTTP by
 * a contract-faithful stand-in (Payment's own HTTP client is exercised). Development and simulation only.
 */
describeWithEnv('refund attempts (Core V2 S6b) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let auth: FakeReceiptServer;
  let worker: RefundWorker;
  const billing = generateServiceToken();
  const other = generateServiceToken();
  const harness = generateServiceToken();
  const identities: Record<string, AuthIdentity> = { 'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] } };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const server = () => t.app.getHttpServer();
  const cmd = () => `cmd-${randomUUID()}`;
  const key = () => `k-${randomUUID()}`;

  const createPayment = async (over: Row = {}) => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send({
    paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
    seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER, ...over,
  }).expect(201)).body;
  const startAttempt = async (pid: string) => (await request(server()).post(`/payment/payments/${pid}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({}).expect(201)).body;
  const sim = (path: string, send: Row, token = harness.token) => request(server()).post(`/payment/simulation/${path}`).set('authorization', `Bearer ${token}`).send(send);
  /** A captured, Company-sold payment: the verified capture fact exists (S4d). */
  const captured = async (over: Row = {}) => {
    const p = await createPayment(over);
    const a = await startAttempt(p.id);
    await sim(`payments/${p.id}/attempts/${a.id}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
    return { payment: p, attempt: a };
  };
  const binding = (paymentId: string, caseId: string, over: Row = {}) => ({
    operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, ...over,
  });
  const body = (caseId: string, secret: string, over: Row = {}) => ({
    refundAttemptId: randomUUID(), refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: secret, ...over,
  });
  const refund = (pid: string, send: Row, k = key(), token = billing.token) =>
    request(server()).post(`/payment/payments/${pid}/refunds`).set('authorization', `Bearer ${token}`).set('idempotency-key', k).send(send);
  /** An Owner receipt for exactly this refund, issued by the stand-in Auth. */
  const receiptFor = (pid: string, caseId: string, over: Row = {}) => auth.issue(binding(pid, caseId, over), OWNER);
  const attemptRow = async (id: string) => (await admin.query(`SELECT * FROM refund_attempt WHERE id = $1`, [id])).rows[0];
  const refundFacts = async (pid: string) => (await admin.query(`SELECT "providerTxnId", amount::int, currency, source, "refundAttemptId" FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'refund' ORDER BY "observedAt"`, [pid])).rows;
  const audits = async (id: string) => (await admin.query(`SELECT name, payload->>'action' AS action, payload->'actor' AS actor, payload->'changes' AS changes FROM outbox WHERE name LIKE 'audit.refund_attempt.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", name`, [id])).rows;
  const authorized = async (pid: string) => {
    const caseId = randomUUID();
    const r = receiptFor(pid, caseId);
    const b = body(caseId, r.secret);
    const res = await refund(pid, b).expect(201);
    return { caseId, receipt: r, body: b, attempt: res.body };
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentrefund');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 16 });
    auth = await startFakeReceiptServer();
    t = await createTestApp({
      databaseUrl: db.url, authClient, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], refundWorker: false,
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'other-producer', digest: other.digest }, { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token, PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET,
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create'], allowedPlatforms: [TEST_PLATFORM] },
          'other-producer': { operations: ['payment.create', 'payment.read'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
      },
    });
    worker = t.app.get(RefundWorker);
    worker.recoveryAfterMs = 0; // the request path is never concurrent with a drain here
  });
  afterAll(async () => {
    await t?.app.close();
    await auth?.close();
    await admin?.end();
    await db?.drop();
  });
  beforeEach(() => {
    auth.revoked.clear();
    auth.unavailable.consume = 0;
    auth.unavailable.lookup = 0;
    auth.loseResponse.consume = 0;
  });
  /** The worker's passes, with the leases and the recovery window aged out so each pass sees every attempt. */
  const drain = async () => {
    await admin.query(`UPDATE refund_attempt SET "workAfter" = NULL WHERE "workAfter" IS NOT NULL AND status NOT IN ('authorization_expired', 'authorization_refused', 'succeeded', 'discrepancy')`);
    return worker.drainOnce();
  };

  describe('authorization (R6B-1, R6B-2, ADR-0067 decision 5)', () => {
    it('a valid Owner receipt: the intent is committed, the receipt consumed under the attempt id, and the attempt authorized with Auth\'s approver', async () => {
      const { payment } = await captured();
      const caseId = randomUUID();
      const r = receiptFor(payment.id, caseId);
      const b = body(caseId, r.secret);
      const res = await refund(payment.id, b).expect(201);
      expect(res.body).toMatchObject({ refundAttemptId: b.refundAttemptId, paymentId: payment.id, refundCaseId: caseId, amount: 9000, currency: 'TND', status: 'authorized', approvedBy: { userId: OWNER }, receiptId: r.id });
      expect(JSON.stringify(res.body)).not.toContain(r.secret);
      expect(r).toMatchObject({ status: 'consumed', consumeRef: b.refundAttemptId }); // consumeRef = the attempt id (F-13)
      const row = await attemptRow(b.refundAttemptId);
      expect(row).toMatchObject({ status: 'authorized', approvedByUserId: OWNER, receiptId: r.id, companyId: COMPANY, producer: 'billing-service' });
      expect(JSON.stringify(row)).not.toContain(r.secret); // the secret is never stored (only its digest)
      expect((await audits(b.refundAttemptId)).map((x) => [x.action, x.actor])).toEqual([['refund_attempt.authorized', { type: 'service', id: 'billing-service' }]]);
      // nothing financial happened yet: no provider call, no refund fact, the payment unchanged, no domain event
      expect(await refundFacts(payment.id)).toEqual([]);
      expect((await request(server()).get(`/payment/payments/${payment.id}`).set('authorization', `Bearer ${billing.token}`).expect(200)).body.status).toBe('succeeded');
      expect(Number((await admin.query(`SELECT count(*) FROM outbox WHERE name LIKE 'refund.%'`)).rows[0].count)).toBe(0);
    });

    it('a replay (same key, same receipt) resumes the same attempt: no second consumption; another key for the same attempt does too', async () => {
      const { payment } = await captured();
      const caseId = randomUUID();
      const r = receiptFor(payment.id, caseId);
      const b = body(caseId, r.secret);
      const k = key();
      await refund(payment.id, b, k).expect(201);
      const consumed = auth.calls.consume;
      const again = await refund(payment.id, b, k).expect(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toMatchObject({ refundAttemptId: b.refundAttemptId, status: 'authorized' });
      await refund(payment.id, b).expect(200);
      expect(auth.calls.consume).toBe(consumed); // an authorized attempt never calls Auth again
      expect(Number((await admin.query(`SELECT count(*) FROM refund_attempt WHERE "paymentId" = $1`, [payment.id])).rows[0].count)).toBe(1);
    });

    it('the same key with another request is refused; the same attempt id with other content or another receipt is a conflict', async () => {
      const { payment } = await captured();
      const caseId = randomUUID();
      const r = receiptFor(payment.id, caseId);
      const b = body(caseId, r.secret);
      const k = key();
      auth.unavailable.consume = 1; // leave it pending, so the receipt check is reached
      auth.unavailable.lookup = 1;
      expect((await refund(payment.id, b, k).expect(503)).body.code).toBe('refund_authorization_unresolved');
      expect((await refund(payment.id, { ...b, reason: 'duplicate_charge' }, k).expect(422)).body.code).toBe('idempotency_key_reused');
      expect((await refund(payment.id, { ...b, reason: 'duplicate_charge' }).expect(409)).body.code).toBe('refund_attempt_conflict');
      const other = receiptFor(payment.id, caseId); // a second receipt for the very same binding is still ANOTHER receipt (R6B-9)
      expect((await refund(payment.id, { ...b, receiptSecret: other.secret }, k).expect(409)).body.code).toBe('refund_attempt_conflict');
      expect(other.status).toBe('issued'); // never consumed for this attempt
      await refund(payment.id, b, k).expect(200); // the original receipt still resumes it
      expect((await attemptRow(b.refundAttemptId)).status).toBe('authorized');
    });

    it('only the payment\'s producer, holding payment.refund.create, may relay; a user bearer never can', async () => {
      const { payment } = await captured();
      const caseId = randomUUID();
      const b = body(caseId, receiptFor(payment.id, caseId).secret);
      await refund(payment.id, b, key(), other.token).expect(403);
      await request(server()).post(`/payment/payments/${payment.id}/refunds`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send(b).expect(401);
      const foreign = (await request(server()).post('/payment/payments').set('authorization', `Bearer ${other.token}`).send({
        paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: 'inv-x', payer: { type: 'user', id: BUYER }, seller: { type: 'company', id: COMPANY },
        amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER }).expect(201)).body;
      expect((await refund(foreign.id, b).expect(404)).body.code).toBe('not_found');
      expect((await refund(payment.id, b, 'bad').expect(400)).body.code).toBe('idempotency_key_required');
      for (const bad of [{ ...b, companyId: COMPANY }, { ...b, amount: 0 }, { ...b, receiptSecret: 'short' }, { ...b, reason: 'free text' }, { ...b, outcome: 'succeeded' }]) {
        expect((await refund(payment.id, bad).expect(400)).body.code).toBe('invalid_refund_request');
      }
    });
  });

  describe('Payment\'s own verification (R6B-2): every refusal is permanent for its attempt id', () => {
    it('a partial amount or another currency: refund_amount_not_full, recorded, and the same id never becomes an attempt', async () => {
      const { payment } = await captured();
      const caseId = randomUUID();
      const r = receiptFor(payment.id, caseId, { amount: 8999 });
      const b = body(caseId, r.secret, { amount: 8999 });
      expect((await refund(payment.id, b).expect(422)).body.code).toBe('refund_amount_not_full');
      const full = receiptFor(payment.id, caseId);
      // the refused id keeps its refusal whatever is presented with it: it never becomes an attempt
      expect((await refund(payment.id, { ...b, amount: 9000, receiptSecret: full.secret }).expect(422)).body.code).toBe('refund_amount_not_full');
      expect(await attemptRow(b.refundAttemptId)).toBeUndefined();
      expect((await refund(payment.id, { ...body(caseId, full.secret), currency: 'EUR' }).expect(422)).body.code).toBe('refund_amount_not_full');
      expect(r.status).toBe('issued'); // Auth was never asked: the receipt is untouched
      const read = (await request(server()).get(`/payment/payments/${payment.id}/refunds`).set('authorization', `Bearer ${billing.token}`).expect(200)).body;
      expect(read.attempts).toEqual([]);
      expect(read.refusals.map((x: Row) => x.code)).toEqual(['refund_amount_not_full', 'refund_amount_not_full']);
      await refund(payment.id, body(caseId, full.secret)).expect(201); // a new id with the full amount works
    });

    it('not refundable: not succeeded, an Organization subscription, an Organization seller; a contested capture is unverified', async () => {
      const open = await createPayment();
      const c1 = randomUUID();
      expect((await refund(open.id, body(c1, receiptFor(open.id, c1).secret)).expect(409)).body.code).toBe('payment_not_refundable');
      const { payment: sub } = await captured({ purpose: 'organization_subscription', beneficiaryUserId: undefined });
      const c2 = randomUUID();
      expect((await refund(sub.id, body(c2, receiptFor(sub.id, c2).secret)).expect(409)).body.code).toBe('payment_not_refundable');
      const orgSeller = randomUUID();
      const { payment: os } = await captured({ seller: { type: 'organization', id: orgSeller }, organizationId: orgSeller, purpose: 'non_entitlement', beneficiaryUserId: undefined });
      const c3 = randomUUID();
      expect((await refund(os.id, body(c3, receiptFor(os.id, c3).secret)).expect(409)).body.code).toBe('payment_not_refundable');
      // a capture contradicted by another observation (S4d conflict) is not verified refundable evidence
      const { payment: contested, attempt } = await captured();
      await sim(`payments/${contested.id}/attempts/${attempt.id}/outcomes`, { commandId: cmd(), outcome: 'amount_mismatch' }).expect(201);
      const c4 = randomUUID();
      expect((await refund(contested.id, body(c4, receiptFor(contested.id, c4).secret)).expect(409)).body.code).toBe('refund_capture_unverified');
    });

    it("dispute exposure (R6B-8; S6e-D R6E-4): Payment's own disputes; unresolved writes nothing; an attempt in flight is not affected", async () => {
      const dispute = (pid: string, send: Row) => sim(`payments/${pid}/disputes`, { commandId: cmd(), ...send }).expect(201);
      // a loss the provider reported WITHOUT its chargeback: the exposure cannot be established, so nothing is written (not a refusal)
      const unfunded = (await captured()).payment;
      await dispute(unfunded.id, { disputeRef: `u-${randomUUID()}`, event: 'lost', chargeback: 'none' });
      const caseId = randomUUID();
      const b = body(caseId, receiptFor(unfunded.id, caseId).secret);
      expect((await refund(unfunded.id, b).expect(503)).body.code).toBe('refund_dispute_unavailable');
      expect(await attemptRow(b.refundAttemptId)).toBeUndefined();
      expect((await admin.query(`SELECT 1 FROM refund_attempt_refusal WHERE id = $1`, [b.refundAttemptId])).rows).toEqual([]);
      // an open dispute (a partial exposure) refuses a new full refund: a permanent refusal of that attempt id
      const open = (await captured()).payment;
      await dispute(open.id, { disputeRef: `o-${randomUUID()}`, event: 'opened', amount: 100 });
      const c2 = randomUUID();
      const b2 = body(c2, receiptFor(open.id, c2).secret);
      expect((await refund(open.id, b2).expect(409)).body.code).toBe('refund_dispute_open');
      expect((await refund(open.id, b2).expect(409)).body.code).toBe('refund_dispute_open');
      // a dispute won: nothing is exposed any more; a new attempt is admitted
      const won = (await captured()).payment;
      const ref = `w-${randomUUID()}`;
      await dispute(won.id, { disputeRef: ref, event: 'opened' });
      await dispute(won.id, { disputeRef: ref, event: 'won' });
      await authorized(won.id);
      // an attempt already in flight when a dispute arrives keeps its own state
      const flight = (await captured()).payment;
      const ok = await authorized(flight.id);
      await dispute(flight.id, { disputeRef: `f-${randomUUID()}`, event: 'opened' });
      expect((await refund(flight.id, ok.body).expect(200)).body).toMatchObject({ refundAttemptId: ok.body.refundAttemptId, status: 'authorized' });
    });
  });

  describe('Auth\'s answers (R6B-9): only a definitive answer ends an authorization', () => {
    it('receipt_invalid (another case\'s receipt) and receipt_expired end the intent; the payment is free for a new attempt', async () => {
      const { payment } = await captured();
      const caseId = randomUUID();
      const wrong = receiptFor(payment.id, randomUUID()); // issued for another case: the binding differs
      const b1 = body(caseId, wrong.secret);
      expect((await refund(payment.id, b1).expect(409)).body.code).toBe('refund_authorization_invalid');
      expect(await attemptRow(b1.refundAttemptId)).toMatchObject({ status: 'authorization_refused', authorizationRefusal: 'receipt_invalid' });
      expect(wrong.status).toBe('issued');
      const late = receiptFor(payment.id, caseId);
      late.expired = true;
      const b2 = body(caseId, late.secret);
      expect((await refund(payment.id, b2).expect(409)).body.code).toBe('refund_authorization_expired');
      expect(await attemptRow(b2.refundAttemptId)).toMatchObject({ status: 'authorization_expired', authorizationRefusal: 'receipt_expired' });
      expect((await refund(payment.id, b2).expect(409)).body.code).toBe('refund_authorization_expired'); // terminal on every replay
      const { attempt } = await authorized(payment.id);
      expect(attempt.status).toBe('authorized');
      expect(await audits(b1.refundAttemptId)).toEqual([]);
    });

    it('authority_revoked, an outage or an unknown outcome leave the intent pending (503); the same receipt later decides it', async () => {
      const { payment } = await captured();
      const caseId = randomUUID();
      const r = receiptFor(payment.id, caseId);
      const b = body(caseId, r.secret);
      const k = key();
      auth.revoked.add(OWNER);
      expect((await refund(payment.id, b, k).expect(503)).body.code).toBe('refund_authorization_unresolved');
      expect(await attemptRow(b.refundAttemptId)).toMatchObject({ status: 'authorization_pending', receiptId: null });
      expect(r.status).toBe('issued');
      // a second relay for the same payment cannot start while this one is unresolved
      const c2 = randomUUID();
      expect((await refund(payment.id, body(c2, receiptFor(payment.id, c2).secret)).expect(409)).body.code).toBe('refund_in_progress');
      auth.revoked.clear();
      auth.unavailable.consume = 1;
      auth.unavailable.lookup = 1;
      expect((await refund(payment.id, b, k).expect(503)).body.code).toBe('refund_authorization_unresolved');
      expect((await refund(payment.id, b, k).expect(200)).body).toMatchObject({ status: 'authorized', approvedBy: { userId: OWNER } });
    });

    it('a lost consumption response: the request answers 503, the recovery lookup finds the consumption and authorizes exactly this attempt', async () => {
      const { payment } = await captured();
      const caseId = randomUUID();
      const r = receiptFor(payment.id, caseId);
      const b = body(caseId, r.secret);
      auth.loseResponse.consume = 1;
      auth.unavailable.lookup = 1; // the request's own lookup fails too
      expect((await refund(payment.id, b).expect(503)).body.code).toBe('refund_authorization_unresolved');
      expect(r.status).toBe('consumed');
      expect((await attemptRow(b.refundAttemptId)).status).toBe('authorization_pending');
      await drain();
      expect(await attemptRow(b.refundAttemptId)).toMatchObject({ status: 'authorized', receiptId: r.id, approvedByUserId: OWNER });
      expect((await audits(b.refundAttemptId)).map((x) => [x.action, x.actor])).toEqual([['refund_attempt.authorized', { type: 'system', id: 'payment_refund_worker' }]]);
    });

    it('a recovery lookup that finds nothing proves nothing: the intent stays pending (no invented expiry)', async () => {
      const { payment } = await captured();
      const caseId = randomUUID();
      const r = receiptFor(payment.id, caseId);
      const b = body(caseId, r.secret);
      auth.unavailable.consume = 1;
      auth.unavailable.lookup = 1;
      await refund(payment.id, b).expect(503);
      r.expired = true; // Auth would now refuse it, but Payment cannot know that without the secret
      await drain();
      expect((await attemptRow(b.refundAttemptId)).status).toBe('authorization_pending');
      expect((await refund(payment.id, b).expect(409)).body.code).toBe('refund_authorization_expired'); // the same receipt, presented again, decides
    });

    it('concurrent relays: one effective attempt per payment and one consumption, whatever the race', async () => {
      const { payment } = await captured();
      const caseId = randomUUID();
      const r = receiptFor(payment.id, caseId);
      const same = body(caseId, r.secret);
      const results = await Promise.all([
        ...Array.from({ length: 6 }, () => refund(payment.id, same)),
        ...Array.from({ length: 6 }, () => { const c = randomUUID(); return refund(payment.id, body(c, receiptFor(payment.id, c).secret)); }),
      ]);
      const ok = results.filter((x) => x.status === 200 || x.status === 201);
      expect(ok.every((x) => x.body.refundAttemptId === ok[0]!.body.refundAttemptId)).toBe(true);
      expect(results.every((x) => [200, 201, 409].includes(x.status))).toBe(true);
      const { rows } = await admin.query(`SELECT status FROM refund_attempt WHERE "paymentId" = $1 AND status NOT IN ('authorization_expired', 'authorization_refused', 'failed')`, [payment.id]);
      expect(rows).toHaveLength(1);
      expect([...auth.receipts.values()].filter((x) => x.binding.paymentId === payment.id && x.status === 'consumed')).toHaveLength(1);
    });
  });

  describe('provider processing in simulation (R6B-3 to R6B-6)', () => {
    it('dispatch with the stable key, verified success: one refund fact, succeeded once, audited; no case completion or payment change', async () => {
      const { payment } = await captured();
      const { body: b } = await authorized(payment.id);
      await drain();
      expect(await attemptRow(b.refundAttemptId)).toMatchObject({ status: 'submitted', providerRefundId: `simr_${b.refundAttemptId}` });
      const out = (await sim(`refunds/${b.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded', delivery: 'held' }).expect(201)).body;
      expect(out.delivered).toBeNull();
      expect(await refundFacts(payment.id)).toEqual([]); // a harness instruction is never itself a fact
      await sim(`refund-commands/${out.commandId}/deliver`, {}).expect(200);
      await sim(`refund-commands/${out.commandId}/deliver`, {}).expect(200); // a duplicate notification
      expect(await refundFacts(payment.id)).toEqual([{ providerTxnId: `simr_${b.refundAttemptId}`, amount: 9000, currency: 'TND', source: 'webhook', refundAttemptId: b.refundAttemptId }]);
      const row = await attemptRow(b.refundAttemptId);
      expect(row.status).toBe('succeeded');
      expect((await audits(b.refundAttemptId)).map((x) => x.action)).toEqual(['refund_attempt.authorized', 'refund_attempt.succeeded']);
      expect((await audits(b.refundAttemptId))[1].changes).toEqual({ payment_id: payment.id, refund_case_id: b.refundCaseId, fact_id: row.succeededFactId });
      expect((await admin.query(`SELECT received FROM simulation_refund_dispatch WHERE "idempotencyKey" = $1`, [b.refundAttemptId])).rows[0].received).toBe(1);
      // S6d stays out: the payment is untouched, no payment.* event follows; Core V2 S6c: the full verified refund completes the case, once
      expect((await admin.query(`SELECT status FROM payment WHERE id = $1`, [payment.id])).rows[0].status).toBe('succeeded');
      expect((await admin.query(`SELECT name FROM outbox WHERE name NOT LIKE 'audit.%' AND payload->>'paymentId' = $1 AND name <> 'payment.created' AND name <> 'payment.succeeded'`, [payment.id])).rows.map((r) => r.name))
        .toEqual(['refund.case_completed']);
      const c = randomUUID();
      expect((await refund(payment.id, body(c, receiptFor(payment.id, c).secret)).expect(409)).body.code).toBe('refund_case_completed');
    });

    it('ambiguous dispatch and no record: only ever resent with the SAME key, never failed by inference, never a second refund', async () => {
      const { payment } = await captured();
      await sim(`payments/${payment.id}/refund-dispatch-plan`, { commandId: cmd(), mode: 'ambiguous' }).expect(201);
      const { body: b } = await authorized(payment.id);
      await drain();
      expect((await attemptRow(b.refundAttemptId)).status).toBe('unknown');
      await drain(); // the provider holds it: pending, nothing changes, nothing resent
      expect((await attemptRow(b.refundAttemptId)).status).toBe('unknown');
      await sim(`refunds/${b.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'no_record' }).expect(201);
      await sim(`payments/${payment.id}/refund-dispatch-plan`, { commandId: cmd(), mode: 'accepted' }).expect(201);
      await drain(); // no record is not a failure: the same attempt is resent with the same key
      expect(await attemptRow(b.refundAttemptId)).toMatchObject({ status: 'submitted', failureCode: null });
      expect((await admin.query(`SELECT "idempotencyKey", received FROM simulation_refund_dispatch WHERE "idempotencyKey" = $1`, [b.refundAttemptId])).rows)
        .toEqual([{ idempotencyKey: b.refundAttemptId, received: 2 }]);
      const c = randomUUID();
      expect((await refund(payment.id, body(c, receiptFor(payment.id, c).secret)).expect(409)).body.code).toBe('refund_in_progress');
      await sim(`refunds/${b.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      expect((await attemptRow(b.refundAttemptId)).status).toBe('succeeded');
      expect(await refundFacts(payment.id)).toHaveLength(1);
    });

    it('provider-confirmed failure ends the attempt (audited); a new attempt needs a new receipt; a declined dispatch fails it too', async () => {
      const { payment } = await captured();
      const first = await authorized(payment.id);
      await drain();
      await sim(`refunds/${first.body.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'failed', failureCode: 'card_closed' }).expect(201);
      expect(await attemptRow(first.body.refundAttemptId)).toMatchObject({ status: 'failed', failureCode: 'card_closed' });
      expect((await audits(first.body.refundAttemptId)).map((x) => [x.action, x.actor])).toEqual([
        ['refund_attempt.authorized', { type: 'service', id: 'billing-service' }], ['refund_attempt.failed', { type: 'system', id: 'payment_webhook' }]]);
      expect((await refund(payment.id, first.body).expect(200)).body.status).toBe('failed'); // the old receipt authorizes nothing more
      await sim(`payments/${payment.id}/refund-dispatch-plan`, { commandId: cmd(), mode: 'rejected', failureCode: 'refund_declined' }).expect(201);
      const second = await authorized(payment.id);
      await drain();
      expect(await attemptRow(second.body.refundAttemptId)).toMatchObject({ status: 'failed', failureCode: 'refund_declined' });
      expect(await refundFacts(payment.id)).toEqual([]);
    });

    it('amount mismatch and contradictory evidence are kept; neither silently becomes a successful full refund', async () => {
      const { payment } = await captured();
      const { body: b } = await authorized(payment.id);
      await drain();
      await sim(`refunds/${b.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'amount_mismatch' }).expect(201);
      expect(await attemptRow(b.refundAttemptId)).toMatchObject({ status: 'discrepancy', succeededFactId: null });
      expect(await refundFacts(payment.id)).toEqual([expect.objectContaining({ amount: 8999, refundAttemptId: b.refundAttemptId })]);
      await sim(`refunds/${b.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201); // contradicts the stored fact
      expect((await attemptRow(b.refundAttemptId)).status).toBe('discrepancy');
      expect((await admin.query(`SELECT amount::int FROM provider_transaction_fact_conflict WHERE "refundAttemptId" = $1`, [b.refundAttemptId])).rows).toEqual([{ amount: 9000 }]);
      expect((await audits(b.refundAttemptId)).map((x) => x.action)).toEqual(['refund_attempt.authorized']);
      // a success after a verified full success contradicted by a smaller amount: the attempt keeps its success, the contradiction is kept
      const { payment: p2 } = await captured();
      const { body: b2 } = await authorized(p2.id);
      await drain();
      await sim(`refunds/${b2.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      await sim(`refunds/${b2.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'amount_mismatch' }).expect(201);
      expect((await attemptRow(b2.refundAttemptId)).status).toBe('succeeded');
      expect((await admin.query(`SELECT amount::int FROM provider_transaction_fact_conflict WHERE "refundAttemptId" = $1`, [b2.refundAttemptId])).rows).toEqual([{ amount: 8999 }]);
      // verified money after a provider-confirmed failure: a discrepancy, never silently left failed
      const { payment: p3 } = await captured();
      const { body: b3 } = await authorized(p3.id);
      await drain();
      await sim(`refunds/${b3.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'failed', failureCode: 'card_closed' }).expect(201);
      await sim(`refunds/${b3.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      expect((await attemptRow(b3.refundAttemptId)).status).toBe('discrepancy');
      const c = randomUUID();
      // Core V2 S6c (R6C-4): the verified full refund is allocated even on a discrepancy attempt, so the case is complete (FC-3)
      expect((await refund(p3.id, body(c, receiptFor(p3.id, c).secret)).expect(409)).body.code).toBe('refund_case_completed');
    });

    it('the status read is an authenticated channel too: a submitted refund resolves through it, and the late notification is the same fact', async () => {
      const { payment } = await captured();
      const { body: b } = await authorized(payment.id);
      await drain();
      const out = (await sim(`refunds/${b.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded', delivery: 'held' }).expect(201)).body;
      worker.submittedCheckAfterMs = 0;
      try {
        await drain();
      } finally {
        worker.submittedCheckAfterMs = 60_000;
      }
      expect((await attemptRow(b.refundAttemptId)).status).toBe('succeeded');
      await sim(`refund-commands/${out.commandId}/deliver`, {}).expect(200);
      expect((await refundFacts(payment.id)).map((f) => f.source)).toEqual(['status_check']);
      expect((await audits(b.refundAttemptId)).filter((x) => x.action === 'refund_attempt.succeeded')).toHaveLength(1);
    });

    it('outcomes are the harness\'s alone: Billing and the payer cannot choose one, and a refund the provider never received has none', async () => {
      const { payment } = await captured();
      const { body: b } = await authorized(payment.id);
      await sim(`refunds/${b.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(404); // not dispatched yet
      await drain();
      await sim(`refunds/${b.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }, billing.token).expect(403);
      await request(server()).post(`/payment/simulation/refunds/${b.refundAttemptId}/outcomes`).set('authorization', 'Bearer buyer-jwt').send({ commandId: cmd(), outcome: 'succeeded' }).expect(401);
      expect((await sim(`refunds/${b.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded', amount: 1 }).expect(400)).body.code).toBe('validation_error');
      expect((await attemptRow(b.refundAttemptId)).status).toBe('submitted');
    });
  });

  describe('PAY-08 reads', () => {
    it('the producer reads attempts and refusals; the payer reads attempts only; anyone else gets the collapsed 404', async () => {
      const { payment } = await captured();
      const caseId = randomUUID();
      await refund(payment.id, body(caseId, receiptFor(payment.id, caseId, { amount: 1 }).secret, { amount: 1 })).expect(422);
      const { body: b } = await authorized(payment.id);
      const producer = (await request(server()).get(`/payment/payments/${payment.id}/refunds`).set('authorization', `Bearer ${billing.token}`).expect(200)).body;
      expect(producer.attempts.map((a: Row) => [a.refundAttemptId, a.status])).toEqual([[b.refundAttemptId, 'authorized']]);
      expect(producer.refusals).toHaveLength(1);
      const payer = (await request(server()).get(`/payment/payments/${payment.id}/refunds`).set('authorization', 'Bearer buyer-jwt').expect(200)).body;
      expect(payer.attempts).toHaveLength(1);
      expect(payer.refusals).toBeUndefined();
      await request(server()).get(`/payment/payments/${payment.id}/refunds`).set('authorization', `Bearer ${other.token}`).expect(404);
    });
  });

  describe('database invariants (migration 0017)', () => {
    it('transitions, terminal states, immutability, uniqueness and append-only evidence are enforced by PostgreSQL itself', async () => {
      const { payment } = await captured();
      const { body: b } = await authorized(payment.id);
      const fail = async (sql: string, params: unknown[] = []) => expect(admin.query(sql, params)).rejects.toThrow();
      await fail(`UPDATE refund_attempt SET status = 'succeeded' WHERE id = $1`, [b.refundAttemptId]); // no skipping, no success without its fact
      await fail(`UPDATE refund_attempt SET status = 'authorization_pending' WHERE id = $1`, [b.refundAttemptId]);
      await fail(`UPDATE refund_attempt SET amount = 1 WHERE id = $1`, [b.refundAttemptId]);
      await fail(`UPDATE refund_attempt SET "approvedByUserId" = gen_random_uuid() WHERE id = $1`, [b.refundAttemptId]);
      await fail(`DELETE FROM refund_attempt WHERE id = $1`, [b.refundAttemptId]);
      const a = await attemptRow(b.refundAttemptId);
      // a second potentially effective attempt for the payment
      await fail(`INSERT INTO refund_attempt (id, "paymentId", producer, "refundCaseId", "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId", provider, "liveMode", "receiptDigest")
        VALUES (gen_random_uuid(), $1, 'billing-service', gen_random_uuid(), $2, 9000, 'TND', 'customer_request', false, $3, $4, 'simulation', false, repeat('a', 64))`, [payment.id, COMPANY, a.captureFactId, a.capturedAttemptId]);
      await fail(`DELETE FROM refund_attempt_refusal`);
      await fail(`UPDATE simulation_refund_command SET instruction = 'succeeded'`);
      // a refusal id never becomes an attempt, and an attempt id never becomes a refusal
      await fail(`INSERT INTO refund_attempt_refusal (id, "paymentId", producer, "refundCaseId", code) VALUES ($1, $2, 'billing-service', gen_random_uuid(), 'refund_in_progress')`, [b.refundAttemptId, payment.id]);
      // a not-refundable payment, even by direct SQL
      const open = await createPayment();
      await fail(`INSERT INTO refund_attempt (id, "paymentId", producer, "refundCaseId", "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId", provider, "liveMode", "receiptDigest")
        VALUES (gen_random_uuid(), $1, 'billing-service', gen_random_uuid(), $2, 9000, 'TND', 'customer_request', false, $3, $4, 'simulation', false, repeat('a', 64))`, [open.id, COMPANY, a.captureFactId, a.capturedAttemptId]);
    });
  });
});

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import type { OwnerCompanyAuthority, VerifiedOwner } from '../src/disputes/owner-company.authority.js';
import type { RefundDispatch } from '../src/providers/provider.port.js';
import { ProviderRegistry } from '../src/providers/provider-registry.js';
import { RefundWorker } from '../src/refunds/refund-worker.js';
import { UNMATCHED_FACT_GRACE_MS } from '../src/webhooks/webhook.service.js';
import { TEST_PLATFORM, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { startFakeReceiptServer, type FakeReceiptServer } from './support/fake-receipts.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '2f1b8d6c-4e3a-4b7c-8d9e-0f1a2b3c4d5e';
const COMPANY = '5b0c2f4e-1d3a-4c6b-8e9f-0a1b2c3d4e5f';
const COMPANY2 = '6c1d3e5f-2a4b-4d7c-9e0f-1a2b3c4d5e6f';
const OWNER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const SECRET = randomBytes(32).toString('hex');
type Row = Record<string, any>;

/**
 * Core V2 R6H-5 (the Owner's decision, 2026-10-30; register PAY-07 H, PAY-13 G; Auth receipt contract §17f) through the REAL application on
 * real PostgreSQL 16, on the simulation provider: a CAPTURE-SPECIFIC refund returns, in full, exactly one verified captured money movement
 * under an Owner receipt that names it, through the same intent → Auth consumption → dispatch → verified refund fact → FC-2 allocation →
 * completion pipeline as an ordinary refund, which stays exactly as it was. Auth's receipt routes are the contract-faithful stand-in (exact
 * binding equality). Development and simulation only.
 */
describeWithEnv('capture-specific refunds (Core V2 R6H-5) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let auth: FakeReceiptServer;
  let worker: RefundWorker;
  const dispatches: RefundDispatch[] = [];
  const billing = generateServiceToken();
  const other = generateServiceToken();
  const harness = generateServiceToken();
  const identities: Record<string, AuthIdentity> = {
    'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] },
    'owner-jwt': { id: OWNER, adminTier: 'owner', isActive: true, memberships: [] },
  };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const owners: Record<string, VerifiedOwner> = { 'owner-jwt': { userId: OWNER, companyId: COMPANY } };
  const ownerAuthority: OwnerCompanyAuthority = { owner: async (bearer) => owners[bearer] ?? null };
  const server = () => t.app.getHttpServer();
  const cmd = () => `cmd-${randomUUID()}`;
  const key = () => `k-${randomUUID()}`;
  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n);

  const createPayment = async (over: Row = {}) => {
    const r = await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send({
      paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
      seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER, ...over,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body as Row;
  };
  const startAttempt = async (pid: string) => (await request(server()).post(`/payment/payments/${pid}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({}).expect(201)).body;
  const sim = (path: string, send: Row) => request(server()).post(`/payment/simulation/${path}`).set('authorization', `Bearer ${harness.token}`).send(send);
  const outcome = async (pid: string, aid: string, send: Row) => (await sim(`payments/${pid}/attempts/${aid}/outcomes`, { commandId: cmd(), ...send }).expect(201)).body;
  const signed = (body: Row) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    return request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json')
      .set('x-simulation-signature', createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw.toString('utf8'));
  };
  const captures = async (pid: string) => (await admin.query(`SELECT * FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture' ORDER BY "observedAt", id`, [pid])).rows;
  /** A succeeded payment and its one verified capture. */
  const captured = async (over: Row = {}) => {
    const p = await createPayment(over);
    const a = await startAttempt(p.id);
    await outcome(p.id, a.id, { outcome: 'succeeded' });
    return { payment: p, attempt: a, capture: (await captures(p.id))[0]! };
  };
  /** A payment that ENDED (its attempt expired, the producer cancelled it), then a verified success of that attempt: a late capture. */
  const lateCaptured = async () => {
    const p = await createPayment();
    const a = await startAttempt(p.id);
    await outcome(p.id, a.id, { outcome: 'expired' });
    await request(server()).post(`/payment/payments/${p.id}/cancel`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key()).send({}).expect(200);
    await outcome(p.id, a.id, { outcome: 'succeeded' });
    return { payment: p, attempt: a, capture: (await captures(p.id))[0]! };
  };
  /** A further, DISTINCT verified capture of the same attempt (another provider transaction): a duplicate charge. */
  const duplicate = async (attemptId: string, amount = 9000) => {
    const txn = `sim_dup_${randomUUID()}`;
    await signed({ eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: attemptId, providerTransactionId: txn, amount, currency: 'TND' }).expect(200);
    return one(`SELECT * FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [txn]);
  };
  const binding = (pid: string, caseId: string, over: Row = {}) => ({
    operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId: pid, amount: 9000, currency: 'TND', reason: 'duplicate_charge',
    legalOverride: false, ...over,
  });
  /** PAY-07, capture-specific when `captureFactId` is given; the receipt's binding is `receipt` (default: exactly the request's). */
  const refund = (pid: string, o: { captureFactId?: string; caseId?: string; attemptId?: string; amount?: number; currency?: string; receipt?: Row; secret?: string; k?: string } = {}) => {
    const caseId = o.caseId ?? randomUUID();
    const body: Row = { refundAttemptId: o.attemptId ?? randomUUID(), refundCaseId: caseId, amount: o.amount ?? 9000, currency: o.currency ?? 'TND', reason: 'duplicate_charge', legalOverride: false };
    if (o.captureFactId) body.captureFactId = o.captureFactId;
    const secret = o.secret ?? auth.issue(o.receipt ?? binding(pid, caseId, { amount: body.amount, currency: body.currency, ...(o.captureFactId ? { captureFactId: o.captureFactId } : {}) }), OWNER).secret;
    return request(server()).post(`/payment/payments/${pid}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', o.k ?? key()).send({ ...body, receiptSecret: secret });
  };
  const captureRead = (pid: string, factId: string, token = billing.token) => request(server()).get(`/payment/payments/${pid}/captures/${factId}`).set('authorization', `Bearer ${token}`);
  const drain = async () => {
    await admin.query(`UPDATE refund_attempt SET "workAfter" = NULL WHERE "workAfter" IS NOT NULL AND status NOT IN ('authorization_expired', 'authorization_refused', 'succeeded', 'discrepancy')`);
    await admin.query(`UPDATE refund_fact_allocation_lease SET "workAfter" = NULL`);
    return worker.drainOnce();
  };
  /** Dispatch the authorized attempt, then the provider confirms the full refund (signed): the verified refund fact, allocated and completed. */
  const complete = async (attemptId: string) => {
    await drain();
    expect((await one(`SELECT status FROM refund_attempt WHERE id = $1`, [attemptId])).status).toBe('submitted');
    await sim(`refunds/${attemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
    await drain();
  };
  const completions = async (caseId: string) => count(`SELECT count(*) AS n FROM outbox WHERE name = 'refund.case_completed' AND payload->>'refundCaseId' = $1`, [caseId]);

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentcapture');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 16 });
    auth = await startFakeReceiptServer();
    t = await createTestApp({
      databaseUrl: db.url, authClient, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], refundWorker: false, ownerAuthority,
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
    worker.recoveryAfterMs = 0;
    const provider = t.app.get(ProviderRegistry).tryGet('simulation')!;
    const original = provider.refund!.bind(provider);
    provider.refund = async (d: RefundDispatch) => {
      dispatches.push(d);
      return original(d);
    };
  });
  afterAll(async () => {
    await t?.app.close();
    await auth?.close();
    await admin?.end();
    await db?.drop();
  });
  beforeEach(() => {
    auth.unavailable.consume = 0;
    auth.unavailable.lookup = 0;
    auth.loseResponse.consume = 0;
  });

  it('1. ordinary refund regression: the S6b binding (no captureFactId), the sale capture, one completion; a capture-specific receipt never authorizes it', async () => {
    const { payment, capture } = await captured();
    const refused = await refund(payment.id, { receipt: binding(payment.id, randomUUID(), { captureFactId: capture.id }) });
    expect(refused.body.code).toBe('refund_authorization_invalid'); // Auth's digest differs: the attempt ends authorization_refused
    const caseId = randomUUID();
    const res = await refund(payment.id, { caseId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'authorized', captureFactId: capture.id, captureSpecific: false });
    await complete(res.body.refundAttemptId);
    expect(await completions(caseId)).toBe(1);
    expect(dispatches.find((d) => d.refundAttemptId === res.body.refundAttemptId)!.capturedTransactionId).toBe(capture.providerTxnId);
    expect((await refund(payment.id)).body.code).toBe('refund_case_completed');
    expect((await refund(payment.id, { captureFactId: capture.id })).body.code).toBe('refund_case_completed'); // the same money, never again
  });

  it('2, 15, 17. a late capture after the payment ended: refunded in full under its own receipt, completed once; the payment and its late success never change', async () => {
    const { payment, attempt, capture } = await lateCaptured();
    const read = (await captureRead(payment.id, capture.id).expect(200)).body;
    expect(read).toMatchObject({ factId: capture.id, paymentId: payment.id, amount: 9000, currency: 'TND', paymentStatus: 'cancelled', basis: 'late_capture', conflicted: false, refund: 'none' });
    expect((await refund(payment.id)).body.code).toBe('payment_not_refundable'); // the ordinary, success-based path cannot return it
    const caseId = randomUUID();
    const res = await refund(payment.id, { captureFactId: capture.id, caseId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ status: 'authorized', captureFactId: capture.id, captureSpecific: true });
    expect(await one(`SELECT "capturedAttemptId", provider FROM refund_attempt WHERE id = $1`, [res.body.refundAttemptId])).toEqual({ capturedAttemptId: attempt.id, provider: 'simulation' });
    expect(await one(`SELECT "captureFactId", "captureSpecific" FROM refund_authorization WHERE "refundAttemptId" = $1`, [res.body.refundAttemptId]))
      .toEqual({ captureFactId: capture.id, captureSpecific: true });
    await complete(res.body.refundAttemptId);
    expect(await completions(caseId)).toBe(1);
    expect(await one(`SELECT a.intended::int, a.excess::int FROM refund_allocation a WHERE a."refundAttemptId" = $1`, [res.body.refundAttemptId])).toEqual({ intended: 9000, excess: 0 });
    expect((await one(`SELECT status FROM payment WHERE id = $1`, [payment.id])).status).toBe('cancelled');
    expect(await count(`SELECT count(*) AS n FROM payment_late_success WHERE "paymentId" = $1`, [payment.id])).toBe(1);
    expect(await count(`SELECT count(*) AS n FROM outbox WHERE payload->>'paymentId' = $1 AND name = 'payment.succeeded'`, [payment.id])).toBe(0);
    expect((await captureRead(payment.id, capture.id).expect(200)).body.refund).toBe('refunded');
    expect((await refund(payment.id, { captureFactId: capture.id })).body.code).toBe('refund_case_completed');
  });

  it('3, 5, 18. distinct duplicate captures: each is its own money; one is refunded on its own, the LAST one backing the sale never is; the ordinary refund stays refused', async () => {
    const { payment, attempt, capture } = await captured();
    const dup = await duplicate(attempt.id);
    expect(dup).toMatchObject({ paymentId: payment.id, attemptId: attempt.id, kind: 'capture' });
    expect((await captureRead(payment.id, dup.id).expect(200)).body.basis).toBe('duplicate_capture');
    expect((await refund(payment.id)).body.code).toBe('refund_capture_unverified'); // ambiguous: the ordinary path never picks one
    const res = await refund(payment.id, { captureFactId: dup.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await complete(res.body.refundAttemptId);
    expect(dispatches.find((d) => d.refundAttemptId === res.body.refundAttemptId)!.capturedTransactionId).toBe(dup.providerTxnId); // exactly that movement
    expect((await refund(payment.id, { captureFactId: capture.id })).body.code).toBe('refund_capture_not_eligible');
    expect(await count(`SELECT count(*) AS n FROM refund_attempt_refusal WHERE "paymentId" = $1 AND code = 'refund_capture_not_eligible'`, [payment.id])).toBe(1);
    const bal = (await request(server()).get(`/payment/admin/payments/${payment.id}/balance`).set('authorization', 'Bearer owner-jwt').expect(200)).body;
    expect(bal.currencies).toEqual([{ currency: 'TND', captured: 18000, refundedNet: 9000, chargebackNet: 0, netRetained: 9000 }]);
    // the provider's notification of the same refund, delivered again, is the same fact: no second movement
    await sim(`refunds/${res.body.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' });
    expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact WHERE "refundAttemptId" = $1`, [res.body.refundAttemptId])).toBe(1);
    expect(dispatches.filter((d) => d.refundAttemptId === res.body.refundAttemptId).every((d) => d.idempotencyKey === res.body.refundAttemptId)).toBe(true);
  });

  it('5. two valid captures of one payment (another attempt\'s late capture): the sale\'s ordinary refund and the other capture\'s refund run independently', async () => {
    const p = await createPayment();
    const a1 = await startAttempt(p.id);
    await outcome(p.id, a1.id, { outcome: 'failed', failureCode: 'declined' });
    const a2 = await startAttempt(p.id);
    await outcome(p.id, a2.id, { outcome: 'succeeded' });
    await signed({ eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: a1.id, providerTransactionId: `sim_a1_${randomUUID()}`, amount: 9000, currency: 'TND' }).expect(200);
    const facts = await captures(p.id);
    const otherCapture = facts.find((f) => f.attemptId === a1.id);
    expect(otherCapture, JSON.stringify(facts)).toBeDefined();
    if (!otherCapture) return;
    expect((await captureRead(p.id, otherCapture.id).expect(200)).body.basis).toBe('other_attempt_capture');
    const ordinary = await refund(p.id);
    const specific = await refund(p.id, { captureFactId: otherCapture.id });
    expect([ordinary.status, specific.status]).toEqual([201, 201]);
  });

  it('6, 12. the same capture: two concurrent capture-specific requests (two cases): exactly one attempt; the other is refused definitively', async () => {
    const { payment } = await lateCaptured();
    const capture = (await captures(payment.id))[0]!;
    const outs = await Promise.all([0, 1, 2, 3].map(() => refund(payment.id, { captureFactId: capture.id })));
    expect(outs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(outs.filter((r) => r.status !== 201).map((r) => r.body.code)).toEqual(['refund_in_progress', 'refund_in_progress', 'refund_in_progress']);
    expect(await count(`SELECT count(*) AS n FROM refund_attempt WHERE "captureFactId" = $1`, [capture.id])).toBe(1);
  });

  it('7. ordinary vs capture-specific race on the settling capture (the same money): exactly one wins', async () => {
    const { payment, capture } = await captured();
    expect((await captureRead(payment.id, capture.id).expect(200)).body.basis).toBe('settling_capture');
    const outs = await Promise.all([refund(payment.id), refund(payment.id, { captureFactId: capture.id }), refund(payment.id), refund(payment.id, { captureFactId: capture.id })]);
    expect(outs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(outs.filter((r) => r.status !== 201).every((r) => r.body.code === 'refund_in_progress')).toBe(true);
    expect((await captureRead(payment.id, capture.id).expect(200)).body.refund).toBe('in_progress');
  });

  it('8, 9, 11. wrong capture, wrong receipt, another payment\'s capture, another producer, amount or currency not the capture\'s', async () => {
    const { payment, capture } = await lateCaptured();
    const elsewhere = await lateCaptured();
    // a receipt for another capture, an ordinary receipt, a receipt without the capture: Auth refuses each (exact binding)
    expect((await refund(payment.id, { captureFactId: capture.id, receipt: binding(payment.id, randomUUID(), { captureFactId: elsewhere.capture.id }) })).body.code).toBe('refund_authorization_invalid');
    const caseId = randomUUID();
    expect((await refund(payment.id, { captureFactId: capture.id, caseId, receipt: binding(payment.id, caseId) })).body.code).toBe('refund_authorization_invalid');
    // another payment's capture, a malformed id
    expect((await refund(payment.id, { captureFactId: elsewhere.capture.id })).body.code).toBe('refund_capture_unverified');
    expect((await refund(payment.id, { captureFactId: capture.id.toUpperCase() })).body.code).toBe('invalid_refund_request');
    expect((await captureRead(payment.id, elsewhere.capture.id)).body.code).toBe('capture_not_found');
    expect((await captureRead(payment.id, capture.id, other.token)).status).toBe(404); // not its producer
    // the amount and currency are the capture's own, in full
    expect((await refund(payment.id, { captureFactId: capture.id, amount: 8999 })).body.code).toBe('refund_amount_not_full');
    expect((await refund(payment.id, { captureFactId: capture.id, currency: 'EUR' })).body.code).toBe('refund_amount_not_full');
    // a refused attempt id stays refused for ever, and its id never becomes another kind of attempt
    const attemptId = randomUUID();
    expect((await refund(payment.id, { captureFactId: elsewhere.capture.id, attemptId })).body.code).toBe('refund_capture_unverified');
    expect((await refund(payment.id, { captureFactId: capture.id, attemptId })).status).toBe(409);
  });

  it('9, 10. wrong Company: the receipt\'s Company is the payment\'s seller, never the request\'s; another seller\'s payment is never refunded by this Company\'s receipt', async () => {
    const p = await createPayment({ seller: { type: 'company', id: COMPANY2 } });
    const a = await startAttempt(p.id);
    await outcome(p.id, a.id, { outcome: 'expired' });
    await request(server()).post(`/payment/payments/${p.id}/cancel`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key()).send({}).expect(200);
    await outcome(p.id, a.id, { outcome: 'succeeded' });
    const capture = (await captures(p.id))[0]!;
    // the Owner of COMPANY approved it: Payment presents COMPANY2 (the seller), so Auth's digest never matches
    expect((await refund(p.id, { captureFactId: capture.id })).body.code).toBe('refund_authorization_invalid');
    const caseId = randomUUID();
    const ok = await refund(p.id, { captureFactId: capture.id, caseId, receipt: binding(p.id, caseId, { companyId: COMPANY2, captureFactId: capture.id }) });
    expect(ok.status).toBe(201);
  });

  it('12. uncertain consumption: Auth unanswerable leaves the intent pending; the same request and receipt resume it; another receipt never does', async () => {
    const { payment, capture } = await lateCaptured();
    const caseId = randomUUID();
    const attemptId = randomUUID();
    const r = auth.issue(binding(payment.id, caseId, { captureFactId: capture.id }), OWNER);
    const k = key();
    auth.unavailable.consume = 1;
    auth.unavailable.lookup = 1;
    expect((await refund(payment.id, { captureFactId: capture.id, caseId, attemptId, secret: r.secret, k })).body.code).toBe('refund_authorization_unresolved');
    expect((await one(`SELECT status FROM refund_attempt WHERE id = $1`, [attemptId])).status).toBe('authorization_pending');
    expect((await refund(payment.id, { captureFactId: capture.id, caseId, attemptId, k })).status).toBe(409); // another receipt for this attempt: refund_attempt_conflict
    const resumed = await refund(payment.id, { captureFactId: capture.id, caseId, attemptId, secret: r.secret, k });
    expect([resumed.status, resumed.body.status]).toEqual([200, 'authorized']);
    expect((await refund(payment.id, { captureFactId: capture.id, caseId, attemptId, secret: r.secret, k })).status).toBe(200); // replay: the same attempt
  });

  it('13. ambiguous provider dispatch: the attempt is unknown, re-sent only with the SAME key; never completed without the verified refund fact', async () => {
    const { payment, capture } = await lateCaptured();
    await sim(`payments/${payment.id}/refund-dispatch-plan`, { commandId: cmd(), mode: 'ambiguous' }).expect(201);
    const caseId = randomUUID();
    const res = await refund(payment.id, { captureFactId: capture.id, caseId });
    await drain();
    expect((await one(`SELECT status FROM refund_attempt WHERE id = $1`, [res.body.refundAttemptId])).status).toBe('unknown');
    expect(await completions(caseId)).toBe(0);
    // the provider holds the refund (pending): the worker asks, never re-sends under another key, and nothing is inferred from silence
    await drain();
    await drain();
    expect((await one(`SELECT status FROM refund_attempt WHERE id = $1`, [res.body.refundAttemptId])).status).toBe('unknown');
    expect(new Set(dispatches.filter((d) => d.refundAttemptId === res.body.refundAttemptId).map((d) => d.idempotencyKey))).toEqual(new Set([res.body.refundAttemptId]));
    expect((await one(`SELECT count(*)::int AS n FROM simulation_refund_dispatch WHERE "idempotencyKey" = $1`, [res.body.refundAttemptId])).n).toBe(1);
    expect(await completions(caseId)).toBe(0); // dispatch alone never completes anything
    expect((await captureRead(payment.id, capture.id).expect(200)).body.refund).toBe('in_progress');
    await sim(`refunds/${res.body.refundAttemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
    await drain();
    expect(await completions(caseId)).toBe(1);
  });

  it('16. an unmatched capture associated with an ended payment is refunded on its own: the provider transaction of THAT capture is the one returned', async () => {
    const { payment } = await lateCaptured(); // an ended payment with an attempt of the simulation provider
    const body = { eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: randomUUID(), providerTransactionId: `sim_x_${randomUUID()}`, amount: 9000, currency: 'TND' };
    await signed(body).expect(200);
    const cl = await admin.connect();
    try {
      await cl.query(`SET session_replication_role = replica`);
      await cl.query(`UPDATE webhook_event SET "receivedAt" = now() - make_interval(secs => $2) WHERE "providerEventId" = $1`, [body.eventId, UNMATCHED_FACT_GRACE_MS / 1000 + 1]);
    } finally {
      await cl.query(`SET session_replication_role = origin`);
      cl.release();
    }
    await signed(body).expect(200);
    const fact = await one(`SELECT * FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [body.providerTransactionId]);
    expect(fact.paymentId).toBeNull();
    expect((await refund(payment.id, { captureFactId: fact.id })).body.code).toBe('refund_capture_unverified'); // not associated yet
    const r = auth.issue({ operation: 'provider_fact_associate', audience: 'payment-service', companyId: COMPANY, factId: fact.id, kind: 'capture', amount: 9000,
      currency: 'TND', targetType: 'payment', targetId: payment.id }, OWNER);
    await request(server()).post(`/payment/admin/provider-facts/${fact.id}/associations`).set('authorization', 'Bearer owner-jwt').set('idempotency-key', key())
      .send({ targetType: 'payment', targetId: payment.id, receiptSecret: r.secret }).expect(201);
    expect((await captureRead(payment.id, fact.id).expect(200)).body.basis).toBe('associated_capture');
    const caseId = randomUUID();
    const res = await refund(payment.id, { captureFactId: fact.id, caseId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await complete(res.body.refundAttemptId);
    expect(dispatches.find((d) => d.refundAttemptId === res.body.refundAttemptId)!.capturedTransactionId).toBe(body.providerTransactionId);
    expect(await completions(caseId)).toBe(1);
    expect(await one(`SELECT "paymentId", "attemptId" FROM provider_transaction_fact WHERE id = $1`, [fact.id])).toEqual({ paymentId: null, attemptId: null }); // never rewritten
  });

  it('18, 19. immutable evidence: the capture flag, the authorization\'s capture and the facts never change; a completed capture is never refundable again', async () => {
    const { payment, capture } = await lateCaptured();
    const res = await refund(payment.id, { captureFactId: capture.id });
    await expect(admin.query(`UPDATE refund_attempt SET "captureSpecific" = false WHERE id = $1`, [res.body.refundAttemptId])).rejects.toThrow();
    await expect(admin.query(`UPDATE refund_authorization SET "captureFactId" = $2 WHERE "refundAttemptId" = $1`, [res.body.refundAttemptId, randomUUID()])).rejects.toThrow();
    await expect(admin.query(`UPDATE provider_transaction_fact SET amount = 1 WHERE id = $1`, [capture.id])).rejects.toThrow();
    // the database refuses a second potentially effective attempt on the same capture, whatever writes it
    await expect(admin.query(
      `INSERT INTO refund_attempt (id, "paymentId", producer, "refundCaseId", "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId",
         provider, "liveMode", "receiptDigest", "captureSpecific")
       SELECT gen_random_uuid(), "paymentId", producer, gen_random_uuid(), "companyId", amount, currency, reason, false, "captureFactId", "capturedAttemptId", provider, false,
         repeat('b', 64), true FROM refund_attempt WHERE id = $1`, [res.body.refundAttemptId])).rejects.toMatchObject({ code: '23505' });
  });
});

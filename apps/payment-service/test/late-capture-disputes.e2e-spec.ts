import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { disputeExposure } from '../src/disputes/dispute.types.js';
import { WEBHOOK_RETRY_MAX_ATTEMPTS, WebhookRetriever } from '../src/webhooks/webhook-retrier.js';
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
 * Core V2 S0-C9 (register PAY-09 G, EVT-03 M, PAY-14 H; S0 FC-1, FC-4, FC-5; the Owner's CB-1, CB-2, CB-5, CB-6) through the REAL application
 * on real PostgreSQL 16, on the simulation provider: a provider dispute of a verified LATE capture (a verified success of an attempt of a
 * payment that already ended failed / cancelled / expired), every notification signed and verified by the webhook pipeline; Auth's receipt
 * routes over real HTTP (a contract-faithful stand-in) for the capture-specific refund interaction. Development and simulation only.
 */
describeWithEnv('late-capture disputes (Core V2 S0-C9) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let auth: FakeReceiptServer;
  const billing = generateServiceToken();
  const harness = generateServiceToken();
  const identities: Record<string, AuthIdentity> = { 'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] } };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const server = () => t.app.getHttpServer();
  const cmd = () => `cmd-${randomUUID()}`;
  const key = () => `k-${randomUUID()}`;
  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0];
  const count = async (sql: string, params: unknown[] = []) => Number((await admin.query(sql, params)).rows[0].n);

  const createPayment = async () => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send({
    paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
    seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER,
  }).expect(201)).body;
  const startAttempt = async (pid: string) => (await request(server()).post(`/payment/payments/${pid}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({}).expect(201)).body;
  const sim = (path: string, send: Row) => request(server()).post(`/payment/simulation/${path}`).set('authorization', `Bearer ${harness.token}`).send(send);
  const outcome = async (pid: string, aid: string, send: Row) => (await sim(`payments/${pid}/attempts/${aid}/outcomes`, { commandId: cmd(), ...send }).expect(201)).body;
  const cancel = (pid: string) => request(server()).post(`/payment/payments/${pid}/cancel`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key()).send({}).expect(200);
  const signed = (body: Row, secret = SECRET) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    return request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json')
      .set('x-simulation-signature', createHmac('sha256', secret).update(raw).digest('hex')).send(raw.toString('utf8'));
  };
  const captures = async (pid: string) => (await admin.query(`SELECT * FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture' ORDER BY "observedAt", id`, [pid])).rows;
  /** A succeeded payment and its one verified (settling) capture. */
  const captured = async () => {
    const p = await createPayment();
    const a = await startAttempt(p.id);
    await outcome(p.id, a.id, { outcome: 'succeeded' });
    return { payment: p, attempt: a, capture: (await captures(p.id))[0]! };
  };
  /** A payment that ENDED cancelled (its attempt expired, the producer cancelled it), before any capture was reported. */
  const ended = async () => {
    const p = await createPayment();
    const a = await startAttempt(p.id);
    await outcome(p.id, a.id, { outcome: 'expired' });
    await cancel(p.id);
    return { payment: p, attempt: a };
  };
  /** ... then the provider reports a verified success of that attempt: a late capture, recorded with its late success (never applied). */
  const reportLateCapture = async (pid: string, aid: string) => {
    await outcome(pid, aid, { outcome: 'succeeded' });
    const capture = (await captures(pid))[0]!;
    expect(await one(`SELECT "factId" FROM payment_late_success WHERE "attemptId" = $1`, [aid])).toEqual({ factId: capture.id });
    return capture;
  };
  const lateCaptured = async () => {
    const e = await ended();
    return { ...e, capture: await reportLateCapture(e.payment.id, e.attempt.id) };
  };
  /** The simulated provider reports a dispute event about one attempt (delivered now unless held). */
  const report = async (pid: string, send: Row) => (await sim(`payments/${pid}/disputes`, { commandId: cmd(), ...send }).expect(201)).body;
  const redeliver = (commandId: string) => sim(`dispute-commands/${commandId}/deliver`, {}).expect(200);
  const disputeOf = async (providerDisputeId: string) => (await admin.query(`SELECT * FROM payment_dispute WHERE "providerDisputeId" = $1`, [providerDisputeId])).rows[0];
  const observations = async (providerDisputeId: string) =>
    (await admin.query(`SELECT kind, disposition, reason FROM payment_dispute_observation WHERE "providerDisputeId" = $1 ORDER BY "observedAt", id`, [providerDisputeId])).rows;
  const events = async (disputeId: string) =>
    (await admin.query(`SELECT id, name, payload FROM outbox WHERE name LIKE 'payment.dispute.%' AND payload->>'disputeId' = $1 ORDER BY "occurredAt", name`, [disputeId])).rows;
  const webhookOf = async (providerDisputeId: string) =>
    (await admin.query(`SELECT id, state, outcome, attempts, "matchedAttemptId" FROM webhook_event WHERE "eventType" LIKE 'payment.dispute.%' AND convert_from("rawBody", 'UTF8')::jsonb->'data'->>'disputeId' = $1 ORDER BY "receivedAt"`,
      [providerDisputeId])).rows;
  const exposure = async (pid: string) => (await request(server()).get(`/payment/payments/${pid}/dispute-exposure`).set('authorization', `Bearer ${billing.token}`).expect(200)).body;
  const losses = async () => {
    const all: Row[] = [];
    let after: string | undefined;
    for (;;) {
      const page = (await request(server()).get(`/payment/disputes/losses?limit=200${after ? `&after=${after}` : ''}`).set('authorization', `Bearer ${billing.token}`).expect(200)).body.items as Row[];
      all.push(...page);
      if (page.length < 200) return all;
      after = page.at(-1)!.disputeId;
    }
  };
  /** The payment, its attempts and its facts as Payment recorded them: what a dispute must never change (finality, FC-1). */
  const snapshot = async (pid: string) => ({
    payment: await one(`SELECT status, "succeededAttemptId", "settledMethod", "closedAt" FROM payment WHERE id = $1`, [pid]),
    attempts: (await admin.query(`SELECT id, status, "completedAt" FROM payment_attempt WHERE "paymentId" = $1 ORDER BY id`, [pid])).rows,
    captures: (await admin.query(`SELECT id, amount, currency, "attemptId" FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture' ORDER BY id`, [pid])).rows,
    lateSuccesses: await count(`SELECT count(*) AS n FROM payment_late_success WHERE "paymentId" = $1`, [pid]),
    succeededEvents: await count(`SELECT count(*) AS n FROM outbox WHERE name = 'payment.succeeded' AND payload->>'paymentId' = $1`, [pid]),
  });
  /**
   * A VERIFIED dispute notification as the pipeline stored it (its signature checked at receipt; `receivedAt` is immutable), received long
   * ago so that every retry the bound permits is due now: the retrier's own input, as in the retrier-resilience suite.
   */
  const storedDispute = async (attemptId: string, kind: 'opened' | 'lost', providerDisputeId: string, data: Row = {}) => {
    const eventId = `old_${randomUUID()}`;
    const body = Buffer.from(JSON.stringify({ eventId, type: `payment.dispute.${kind}`, reference: attemptId, amount: 9000, currency: 'TND', data: { disputeId: providerDisputeId, ...data } }));
    return (await one(`INSERT INTO webhook_event(provider, "providerEventId", "eventType", "rawBody", "receivedAt") VALUES ('simulation', $1, $2, $3, now() - interval '30 days') RETURNING id`,
      [eventId, `payment.dispute.${kind}`, body])).id as string;
  };
  /** Leaves a stored notification exactly its final permitted processing (its attempt counter is bookkeeping, not evidence). */
  const atLastChance = (webhookEventId: string) => admin.query(`UPDATE webhook_event SET attempts = $2 WHERE id = $1`, [webhookEventId, WEBHOOK_RETRY_MAX_ATTEMPTS - 1]);
  const webhook = async (id: string) => one(`SELECT state, outcome, attempts, "matchedAttemptId" FROM webhook_event WHERE id = $1`, [id]);
  const retrier = () => t.app.get(WebhookRetriever);
  const binding = (pid: string, caseId: string, captureFactId: string) => ({
    operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId: pid, amount: 9000, currency: 'TND', reason: 'duplicate_charge',
    legalOverride: false, captureFactId,
  });
  /** PAY-07 H: a capture-specific refund of the late capture, under its own receipt. */
  const refundCapture = (pid: string, captureFactId: string) => {
    const caseId = randomUUID();
    return request(server()).post(`/payment/payments/${pid}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key()).send({
      refundAttemptId: randomUUID(), refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'duplicate_charge', legalOverride: false, captureFactId,
      receiptSecret: auth.issue(binding(pid, caseId, captureFactId), OWNER).secret,
    });
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentlatedispute');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 8 });
    auth = await startFakeReceiptServer();
    t = await createTestApp({
      databaseUrl: db.url, authClient, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], refundWorker: false,
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token, PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET,
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
      },
    });
    await retrier().stop(); // the tests drive the retrier's passes themselves
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

  describe('attribution to a verified late capture (CB-1, CB-2)', () => {
    it('a dispute of a late capture is bound to that capture as late_capture; its events name it; the payment, its attempts and facts never change', async () => {
      const { payment, attempt, capture } = await lateCaptured();
      const before = await snapshot(payment.id);
      expect(before.payment).toMatchObject({ status: 'cancelled', succeededAttemptId: null });
      const ref = `l-${randomUUID()}`;
      await report(payment.id, { disputeRef: ref, event: 'opened', attemptId: attempt.id, amount: 4000, reason: 'fraudulent' });
      const d = await disputeOf(`simd_${ref}`);
      expect(d).toMatchObject({ paymentId: payment.id, attemptId: attempt.id, captureFactId: capture.id, captureBasis: 'late_capture', amount: '4000', currency: 'TND', status: 'open', liveMode: false });
      expect(await observations(`simd_${ref}`)).toEqual([{ kind: 'opened', disposition: 'applied', reason: null }]);
      const opened = await events(d.id);
      expect(opened.map((e) => e.name)).toEqual(['payment.dispute.opened']);
      expect(opened[0].payload).toMatchObject({ disputeId: d.id, paymentId: payment.id, amount: 4000, currency: 'TND', captureFactId: capture.id, captureBasis: 'late_capture', liveMode: false });
      expect(await exposure(payment.id)).toMatchObject({ state: 'exposed', openDisputes: 1, disputeExposure: 4000, chargedBack: 0, conflicts: 0 });

      await report(payment.id, { disputeRef: ref, event: 'lost', attemptId: attempt.id, amount: 4000, chargebackAmount: 4000 });
      const lost = await disputeOf(`simd_${ref}`);
      expect(lost).toMatchObject({ status: 'lost', captureBasis: 'late_capture' });
      const cb = await one(`SELECT kind, amount::int, currency, "attemptId", "paymentId", "disputeId" FROM provider_transaction_fact WHERE id = $1`, [lost.chargebackFactId]);
      expect(cb).toEqual({ kind: 'chargeback', amount: 4000, currency: 'TND', attemptId: attempt.id, paymentId: payment.id, disputeId: d.id });
      const lostEvent = (await events(d.id)).find((e) => e.name === 'payment.dispute.lost')!;
      expect(lostEvent.payload).toMatchObject({ captureFactId: capture.id, captureBasis: 'late_capture', chargeback: { factId: lost.chargebackFactId, amount: 4000, currency: 'TND' } });
      expect((await losses()).find((x) => x.disputeId === d.id)).toMatchObject({ captureFactId: capture.id, captureBasis: 'late_capture', chargeback: { factId: lost.chargebackFactId, amount: 4000 } });
      expect(await exposure(payment.id)).toMatchObject({ state: 'exposed', openDisputes: 0, chargedBack: 4000, lostWithoutChargeback: 0 });
      // finality and FC-1: nothing about the payment, its attempts or its capture changed; no payment.succeeded
      expect(await snapshot(payment.id)).toEqual(before);
    });

    it('a late capture of a FAILED payment, and a won dispute: the exposure returns to clear; no chargeback, no lost event', async () => {
      const p = await createPayment();
      const tried: Row[] = [];
      for (let i = 0; i < 3; i++) { // the attempt limit (3): the payment fails with its last provider-confirmed failure
        const x = await startAttempt(p.id);
        await outcome(p.id, x.id, { outcome: 'failed', failureCode: 'card_declined' });
        tried.push(x);
      }
      expect((await one(`SELECT status FROM payment WHERE id = $1`, [p.id])).status).toBe('failed');
      const a = tried[1]!; // a late capture of an earlier attempt of the failed payment
      const capture = await reportLateCapture(p.id, a.id);
      const ref = `w-${randomUUID()}`;
      await report(p.id, { disputeRef: ref, event: 'opened', attemptId: a.id });
      expect(await disputeOf(`simd_${ref}`)).toMatchObject({ captureFactId: capture.id, captureBasis: 'late_capture', amount: '9000' });
      expect((await exposure(p.id)).state).toBe('exposed');
      await report(p.id, { disputeRef: ref, event: 'won', attemptId: a.id });
      const d = await disputeOf(`simd_${ref}`);
      expect(d).toMatchObject({ status: 'won', chargebackFactId: null });
      expect((await events(d.id)).map((e) => e.name)).toEqual(['payment.dispute.opened']);
      expect(await exposure(p.id)).toMatchObject({ state: 'clear', openDisputes: 0, disputeExposure: 0, chargedBack: 0 });
    });

    it('ordinary regression: a dispute of a succeeded payment is its settling capture, named on its events and in the losses read', async () => {
      const { payment, capture } = await captured();
      const ref = `s-${randomUUID()}`;
      await report(payment.id, { disputeRef: ref, event: 'lost', chargebackAmount: 9000 }); // no attemptId: the succeeded attempt, unchanged
      const d = await disputeOf(`simd_${ref}`);
      expect(d).toMatchObject({ captureFactId: capture.id, captureBasis: 'settling_capture', status: 'lost' });
      for (const e of await events(d.id)) expect(e.payload).toMatchObject({ captureFactId: capture.id, captureBasis: 'settling_capture' });
      expect((await losses()).find((x) => x.disputeId === d.id)).toMatchObject({ captureFactId: capture.id, captureBasis: 'settling_capture' });
      // the succeeded attempt named explicitly is the same command target
      const ref2 = `s2-${randomUUID()}`;
      const c = await report(payment.id, { disputeRef: ref2, event: 'opened', attemptId: d.attemptId, amount: 10 });
      expect(c.attemptId).toBe(d.attemptId);
      expect(await disputeOf(`simd_${ref2}`)).toMatchObject({ captureBasis: 'settling_capture' });
    });
  });

  describe('ambiguous or wrong evidence stays a conflict (CB-1)', () => {
    it('two captures of the late attempt, or a contested capture: an immediate conflict, never held, never a dispute', async () => {
      const { payment, attempt } = await lateCaptured();
      const txn = `sim_dup_${randomUUID()}`;
      await signed({ eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: attempt.id, providerTransactionId: txn, amount: 9000, currency: 'TND' }).expect(200);
      expect(await captures(payment.id)).toHaveLength(2);
      const ref = `dup-${randomUUID()}`;
      await report(payment.id, { disputeRef: ref, event: 'opened', attemptId: attempt.id });
      expect(await disputeOf(`simd_${ref}`)).toBeUndefined();
      expect(await observations(`simd_${ref}`)).toEqual([{ kind: 'opened', disposition: 'conflict', reason: 'capture_unverified' }]);
      expect((await webhookOf(`simd_${ref}`))[0]).toMatchObject({ state: 'conflict', outcome: 'dispute_capture_unverified' });
      expect(await exposure(payment.id)).toMatchObject({ state: 'unresolved', conflicts: 1 });

      const contested = await lateCaptured();
      await admin.query(`INSERT INTO provider_transaction_fact_conflict ("factId", "paymentId", "attemptId", provider, amount, currency, source) VALUES ($1, $2, $3, 'simulation', 9100, 'TND', 'status_check')`,
        [contested.capture.id, contested.payment.id, contested.attempt.id]);
      const ref2 = `con-${randomUUID()}`;
      await report(contested.payment.id, { disputeRef: ref2, event: 'opened', attemptId: contested.attempt.id });
      expect(await observations(`simd_${ref2}`)).toEqual([{ kind: 'opened', disposition: 'conflict', reason: 'capture_unverified' }]);
      expect(await disputeOf(`simd_${ref2}`)).toBeUndefined();
    });

    it('an exposure above the late capture or in another currency is an exposure_mismatch; a known dispute restated differently is a conflict', async () => {
      const { payment, attempt } = await lateCaptured();
      const above = `a-${randomUUID()}`;
      await report(payment.id, { disputeRef: above, event: 'opened', attemptId: attempt.id, amount: 9001 });
      expect(await observations(`simd_${above}`)).toEqual([{ kind: 'opened', disposition: 'conflict', reason: 'exposure_mismatch' }]);
      const eur = `simd_e-${randomUUID()}`;
      await signed({ eventId: `raw_${randomUUID()}`, type: 'payment.dispute.opened', reference: attempt.id, amount: 100, currency: 'EUR', data: { disputeId: eur } }).expect(200);
      expect(await observations(eur)).toEqual([{ kind: 'opened', disposition: 'conflict', reason: 'exposure_mismatch' }]);
      expect(await disputeOf(eur)).toBeUndefined();
      const ok = `k-${randomUUID()}`;
      await report(payment.id, { disputeRef: ok, event: 'opened', attemptId: attempt.id, amount: 3000 });
      await report(payment.id, { disputeRef: ok, event: 'lost', attemptId: attempt.id, amount: 5000 }); // the same dispute, another exposure
      expect((await observations(`simd_${ok}`)).at(-1)).toEqual({ kind: 'lost', disposition: 'conflict', reason: 'exposure_mismatch' });
      expect(await disputeOf(`simd_${ok}`)).toMatchObject({ status: 'open', amount: '3000', chargebackFactId: null });
    });

    it('never another capture of the same payment: an attempt of a SUCCEEDED payment other than its succeeded one is a conflict, even with a capture', async () => {
      const p = await createPayment();
      const a1 = await startAttempt(p.id);
      await outcome(p.id, a1.id, { outcome: 'failed', failureCode: 'card_declined' });
      expect((await one(`SELECT status FROM payment WHERE id = $1`, [p.id])).status).toBe('created'); // within the attempt limit: the payer retries
      const a2 = await startAttempt(p.id);
      await outcome(p.id, a2.id, { outcome: 'succeeded' });
      const settling = (await captures(p.id))[0]!;
      // the provider later reports a capture of the FIRST attempt too (a late success of a succeeded payment: out of scope for CB-1)
      await signed({ eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: a1.id, providerTransactionId: `sim_a1_${randomUUID()}`, amount: 9000, currency: 'TND' }).expect(200);
      expect(await captures(p.id)).toHaveLength(2);
      // the harness refuses the target; a signed notification about it is a conflict, never bound to the settling capture
      expect((await sim(`payments/${p.id}/disputes`, { commandId: cmd(), disputeRef: 'abcd', event: 'opened', attemptId: a1.id }).expect(409)).body.code).toBe('simulation_nothing_to_dispute');
      const ref = `simd_o-${randomUUID()}`;
      await signed({ eventId: `raw_${randomUUID()}`, type: 'payment.dispute.lost', reference: a1.id, amount: 9000, currency: 'TND', data: { disputeId: ref, chargeback: { id: `cb_${randomUUID()}`, amount: 9000, currency: 'TND' } } }).expect(200);
      expect(await observations(ref)).toEqual([{ kind: 'lost', disposition: 'conflict', reason: 'capture_unverified' }]);
      expect(await count(`SELECT count(*) AS n FROM payment_dispute WHERE "paymentId" = $1`, [p.id])).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'chargeback'`, [p.id])).toBe(0);
      expect(settling.attemptId).toBe(a2.id);
    });
  });

  describe('out of order: the dispute before its capture is verified (CB-5)', () => {
    it('held while the late capture is unreported (exposure unresolved, nothing recorded); applied exactly once when the provider redelivers after it', async () => {
      const { payment, attempt } = await ended();
      const ref = `h-${randomUUID()}`;
      const c = await report(payment.id, { disputeRef: ref, event: 'opened', attemptId: attempt.id, amount: 6000 });
      expect(c.delivered).toEqual({ status: 200 });
      expect(await disputeOf(`simd_${ref}`)).toBeUndefined();
      expect(await observations(`simd_${ref}`)).toEqual([]); // held is not a conflict
      expect((await webhookOf(`simd_${ref}`))[0]).toMatchObject({ state: 'unmatched', outcome: 'dispute_held:capture_pending', matchedAttemptId: attempt.id });
      expect(await exposure(payment.id)).toMatchObject({ state: 'unresolved', openDisputes: 0, conflicts: 0, lostWithoutChargeback: 0 });
      await redeliver(c.commandId); // still no capture: held again, nothing recorded
      expect(await observations(`simd_${ref}`)).toEqual([]);

      const capture = await reportLateCapture(payment.id, attempt.id);
      await redeliver(c.commandId); // the provider's redelivery once the capture is verified
      const d = await disputeOf(`simd_${ref}`);
      expect(d).toMatchObject({ captureFactId: capture.id, captureBasis: 'late_capture', amount: '6000', status: 'open' });
      expect(await observations(`simd_${ref}`)).toEqual([{ kind: 'opened', disposition: 'applied', reason: null }]);
      expect((await webhookOf(`simd_${ref}`))[0]).toMatchObject({ state: 'processed' });
      await redeliver(c.commandId); // processed: a further redelivery is a no-op
      expect((await events(d.id)).map((e) => e.name)).toEqual(['payment.dispute.opened']);
      expect(await observations(`simd_${ref}`)).toHaveLength(1);
      expect(await exposure(payment.id)).toMatchObject({ state: 'exposed', openDisputes: 1, disputeExposure: 6000 });
    });

    it("the retrier applies a held loss once the late success is recorded: one dispute, one chargeback fact, one payment.dispute.lost", async () => {
      const { payment, attempt } = await ended();
      const ref = `simd_r-${randomUUID()}`;
      const w = await storedDispute(attempt.id, 'lost', ref, { chargeback: { id: `cb_${randomUUID()}`, amount: 9000, currency: 'TND' } });
      await retrier().drainOnce();
      expect(await webhook(w)).toMatchObject({ state: 'unmatched', outcome: 'dispute_held:capture_pending', attempts: 1, matchedAttemptId: attempt.id });
      expect(await exposure(payment.id)).toMatchObject({ state: 'unresolved', conflicts: 0 });
      const capture = await reportLateCapture(payment.id, attempt.id);
      await retrier().drainOnce();
      const d = await disputeOf(ref);
      expect(d).toMatchObject({ status: 'lost', captureFactId: capture.id, captureBasis: 'late_capture' });
      expect(d.chargebackFactId).not.toBeNull();
      expect(await webhook(w)).toMatchObject({ state: 'processed', attempts: 2 });
      await retrier().drainOnce(); // nothing left to retry
      expect(await webhook(w)).toMatchObject({ state: 'processed', attempts: 2 });
      expect(await observations(ref)).toEqual([{ kind: 'lost', disposition: 'applied', reason: null }]);
      expect((await events(d.id)).map((e) => e.name).sort((x, y) => x.localeCompare(y))).toEqual(['payment.dispute.lost', 'payment.dispute.opened']);
      expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact WHERE "disputeId" = $1`, [d.id])).toBe(1);
      expect(await exposure(payment.id)).toMatchObject({ state: 'exposed', chargedBack: 9000 });
    });

    it('a capture fact without its late success is held too; on its last permitted processing it becomes the capture_unverified conflict, never a dispute', async () => {
      const { payment, attempt } = await ended();
      // the capture fact is committed in its own transaction before the late success: the window between them, held open here
      await admin.query(`INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", amount, currency, "liveMode", source)
        VALUES ('simulation', $1, 'capture', $2, $3, 9000, 'TND', false, 'status_check')`, [`sim_w_${randomUUID()}`, payment.id, attempt.id]);
      const ref = `simd_x-${randomUUID()}`;
      const w = await storedDispute(attempt.id, 'opened', ref);
      await retrier().drainOnce(); // an ordinary retry: held
      await retrier().drainOnce(); // and again, within the bound: still held
      expect(await webhook(w)).toMatchObject({ state: 'unmatched', outcome: 'dispute_held:capture_pending', attempts: 2 });
      expect(await observations(ref)).toEqual([]);
      await atLastChance(w); // the bound: its final permitted processing
      await retrier().drainOnce();
      expect(await webhook(w)).toMatchObject({ state: 'conflict', outcome: 'dispute_capture_unverified', attempts: WEBHOOK_RETRY_MAX_ATTEMPTS });
      expect(await observations(ref)).toEqual([{ kind: 'opened', disposition: 'conflict', reason: 'capture_unverified' }]);
      expect(await disputeOf(ref)).toBeUndefined();
      expect(await count(`SELECT count(*) AS n FROM outbox WHERE name LIKE 'payment.dispute.%' AND payload->>'paymentId' = $1`, [payment.id])).toBe(0);
      expect(await exposure(payment.id)).toMatchObject({ state: 'unresolved', conflicts: 1 });
      // the conflict is preserved: evidence arriving later never rewrites it, and a redelivery is a no-op
      await admin.query(`INSERT INTO payment_late_success ("paymentId", "attemptId", source, amount, currency, "paymentStatus", "factId")
        SELECT "paymentId", "attemptId", 'status_check', amount, currency, 'cancelled', id FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture'`, [payment.id]);
      await signed(JSON.parse((await one(`SELECT convert_from("rawBody", 'UTF8') AS b FROM webhook_event WHERE id = $1`, [w])).b)).expect(200); // the provider redelivers it
      await retrier().drainOnce();
      expect(await webhook(w)).toMatchObject({ state: 'conflict' });
      expect(await observations(ref)).toHaveLength(1);
      expect(await disputeOf(ref)).toBeUndefined();
      expect((await exposure(payment.id)).state).toBe('unresolved');
    });

    it('a payment still open (no capture yet) holds the notification; a lost notification held with its opening: one outcome, each applied once', async () => {
      const { payment, attempt } = await ended();
      const ref = `b-${randomUUID()}`;
      const opened = await report(payment.id, { disputeRef: ref, event: 'opened', attemptId: attempt.id });
      const lost = await report(payment.id, { disputeRef: ref, event: 'lost', attemptId: attempt.id, chargebackAmount: 9000 });
      expect((await webhookOf(`simd_${ref}`)).map((w) => w.state)).toEqual(['unmatched', 'unmatched']);
      await reportLateCapture(payment.id, attempt.id);
      await redeliver(lost.commandId); // the loss first (out of order), then the opening
      await redeliver(opened.commandId);
      const d = await disputeOf(`simd_${ref}`);
      expect(d).toMatchObject({ status: 'lost', captureBasis: 'late_capture' });
      expect(await observations(`simd_${ref}`)).toEqual([{ kind: 'lost', disposition: 'applied', reason: null }, { kind: 'opened', disposition: 'duplicate', reason: 'after_terminal' }]);
      expect((await events(d.id)).map((e) => e.name).sort((x, y) => x.localeCompare(y))).toEqual(['payment.dispute.lost', 'payment.dispute.opened']);
    });
  });

  describe('authenticity and replay (unchanged safeguards)', () => {
    it('a forged notification is refused and records nothing; the same notification redelivered and a replayed statement apply nothing twice', async () => {
      const { payment, attempt } = await lateCaptured();
      const pid = `simd_f-${randomUUID()}`;
      const body = { eventId: `raw_${randomUUID()}`, type: 'payment.dispute.lost', reference: attempt.id, amount: 9000, currency: 'TND', data: { disputeId: pid, chargeback: { id: `cb_${randomUUID()}`, amount: 9000, currency: 'TND' } } };
      await signed(body, randomBytes(32).toString('hex')).expect(401);
      expect(await count(`SELECT count(*) AS n FROM webhook_event WHERE "providerEventId" = $1`, [body.eventId])).toBe(0);
      expect(await disputeOf(pid)).toBeUndefined();
      await signed(body).expect(200);
      await signed(body).expect(200); // the same event: its permanent key
      const replay = { ...body, eventId: `raw_${randomUUID()}` }; // the same statement in a new notification
      await signed(replay).expect(200);
      const d = await disputeOf(pid);
      expect(d).toMatchObject({ status: 'lost', captureBasis: 'late_capture' });
      expect(await observations(pid)).toEqual([{ kind: 'lost', disposition: 'applied', reason: null }, { kind: 'lost', disposition: 'duplicate', reason: null }]);
      expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact WHERE "disputeId" = $1`, [d.id])).toBe(1);
      const ev = await events(d.id);
      expect(ev.filter((e) => e.name === 'payment.dispute.lost')).toHaveLength(1);
      expect(new Set(ev.map((e) => e.id)).size).toBe(ev.length);
      expect((await exposure(payment.id)).chargedBack).toBe(9000);
    });
  });

  describe('capture-specific refunds and chargebacks (FC-5, PAY-07 H; S0-C9 item 6)', () => {
    it('an open dispute of the late capture refuses its refund; a held one is unverifiable (503); after a won dispute the capture is refundable once', async () => {
      const { payment, attempt } = await ended();
      const ref = `f-${randomUUID()}`;
      const held = await report(payment.id, { disputeRef: ref, event: 'opened', attemptId: attempt.id });
      const capture = await reportLateCapture(payment.id, attempt.id);
      const unverifiable = await refundCapture(payment.id, capture.id); // the held notification: the exposure cannot be established
      expect([unverifiable.status, unverifiable.body.code]).toEqual([503, 'refund_dispute_unavailable']);
      await redeliver(held.commandId);
      const r1 = await refundCapture(payment.id, capture.id);
      expect([r1.status, r1.body.code]).toEqual([409, 'refund_dispute_open']);
      await report(payment.id, { disputeRef: ref, event: 'won', attemptId: attempt.id });
      expect((await exposure(payment.id)).state).toBe('clear');
      const ok = await refundCapture(payment.id, capture.id);
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(ok.body).toMatchObject({ status: 'authorized', captureFactId: capture.id, captureSpecific: true });
      expect((await one(`SELECT status FROM payment WHERE id = $1`, [payment.id])).status).toBe('cancelled');
    });

    it('a chargeback of the late capture leaves less than the capture: its refund is refused; the chargeback is linked once', async () => {
      const { payment, attempt, capture } = await lateCaptured();
      const ref = `g-${randomUUID()}`;
      await report(payment.id, { disputeRef: ref, event: 'lost', attemptId: attempt.id, amount: 2000, chargebackAmount: 2000 });
      expect(await exposure(payment.id)).toMatchObject({ state: 'exposed', chargedBack: 2000 });
      const r = await refundCapture(payment.id, capture.id);
      expect([r.status, r.body.code]).toEqual([409, 'refund_dispute_open']);
      expect(await count(`SELECT count(*) AS n FROM refund_authorization WHERE "paymentId" = $1`, [payment.id])).toBe(0);
    });
  });

  describe('the harness (PAY-14 H)', () => {
    it("targets an attempt only of this payment, its succeeded one or one of a final payment; a conflicting replay is refused", async () => {
      const open = await createPayment();
      const oa = await startAttempt(open.id);
      expect((await sim(`payments/${open.id}/disputes`, { commandId: cmd(), disputeRef: 'abcd', event: 'opened', attemptId: oa.id }).expect(409)).body.code).toBe('simulation_nothing_to_dispute');
      const { payment, attempt } = await ended();
      expect((await sim(`payments/${payment.id}/disputes`, { commandId: cmd(), disputeRef: 'abcd', event: 'opened', attemptId: oa.id })).status).toBe(404); // another payment's attempt
      expect((await sim(`payments/${payment.id}/disputes`, { commandId: cmd(), disputeRef: 'abcd', event: 'opened' }).expect(409)).body.code).toBe('simulation_nothing_to_dispute');
      expect((await sim(`payments/${payment.id}/disputes`, { commandId: cmd(), disputeRef: 'abcd', event: 'opened', attemptId: 'nope' })).status).toBe(400);
      const c = cmd();
      const first = { commandId: c, disputeRef: `q-${randomUUID()}`, event: 'opened', attemptId: attempt.id, delivery: 'held' };
      await sim(`payments/${payment.id}/disputes`, first).expect(201);
      expect((await sim(`payments/${payment.id}/disputes`, first).expect(200)).headers['idempotent-replayed']).toBe('true');
      expect((await sim(`payments/${payment.id}/disputes`, { ...first, attemptId: undefined }).expect(409)).body.code).toBe('simulation_nothing_to_dispute');
      const other = await ended();
      const sameRefOther = await sim(`payments/${other.payment.id}/disputes`, { ...first, attemptId: other.attempt.id });
      expect([sameRefOther.status, sameRefOther.body.code]).toEqual([409, 'simulation_command_conflict']); // another target under the same command
      expect(await count(`SELECT count(*) AS n FROM simulation_dispute_command WHERE "commandId" = $1`, [c])).toBe(1);
    });
  });

  describe('existing evidence (CB-6)', () => {
    it('0023 rewrites no row: an existing dispute becomes a settling capture in place; a preserved conflict still keeps the exposure unresolved', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'pay-0022-'));
      const legacy = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentcb6');
      const pool = new pg.Pool({ connectionString: legacy.url, max: 2 });
      try {
        for (const f of readdirSync(paymentMigrationsDir).filter((n) => n.endsWith('.sql') && n < '0023')) cpSync(join(paymentMigrationsDir, f), join(dir, f));
        await runMigrations(legacy.url, [kitMigrationsDir, dir]);
        const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
        const p = (await q(`INSERT INTO payment(producer, "paymentRequestId", "sourceType", "sourceId", "payerType", "payerId", "sellerType", "sellerId", amount, currency, purpose, "liveMode")
          VALUES ('billing-service', gen_random_uuid(), 'invoice', 'inv-cb6', 'user', 'u', 'company', $1, 1000, 'TND', 'non_entitlement', false) RETURNING id`, [COMPANY])).id;
        const a = (await q(`INSERT INTO payment_attempt(id, "paymentId", "attemptNumber", provider, "liveMode") VALUES (gen_random_uuid(), $1, 1, 'test', false) RETURNING id`, [p])).id;
        await pool.query(`UPDATE payment SET status = 'pending' WHERE id = $1`, [p]);
        await pool.query(`UPDATE payment_attempt SET status = 'submitted', "providerTransactionId" = 'ptx-cb6', "submittedAt" = now() WHERE id = $1`, [a]);
        await pool.query(`UPDATE payment_attempt SET status = 'succeeded', "completedAt" = now() WHERE id = $1`, [a]);
        const f = (await q(`INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", amount, currency, "liveMode", source)
          VALUES ('test', 'ptx-cb6', 'capture', $1, $2, 1000, 'TND', false, 'status_check') RETURNING id`, [p, a])).id;
        await pool.query(`UPDATE payment SET status = 'succeeded', "settledMethod" = 'gateway', "succeededAttemptId" = $2, "closedAt" = now() WHERE id = $1`, [p, a]);
        const d = (await q(`INSERT INTO payment_dispute (provider, "providerDisputeId", "paymentId", "attemptId", "captureFactId", amount, currency, status)
          VALUES ('test', 'd-cb6', $1, $2, $3, 400, 'TND', 'won') RETURNING id`, [p, a, f])).id;
        const w = (await q(`INSERT INTO webhook_event(provider, "providerEventId", "eventType", "rawBody", state, outcome, "matchedAttemptId")
          VALUES ('test', 'evt-cb6', 'payment.dispute.opened', '\\x7b7d', 'conflict', 'dispute_capture_unverified', $1) RETURNING id`, [a])).id;
        await pool.query(`INSERT INTO payment_dispute_observation ("webhookEventId", provider, "providerDisputeId", kind, "paymentId", "attemptId", amount, currency, disposition, reason)
          VALUES ($1, 'test', 'd-cb6-x', 'opened', $2, $3, 100, 'TND', 'conflict', 'capture_unverified')`, [w, p, a]);
        const rowsOf = async () => ({
          dispute: await q(`SELECT xmin::text, ctid::text FROM payment_dispute WHERE id = $1`, [d]),
          observation: await q(`SELECT xmin::text, ctid::text FROM payment_dispute_observation WHERE "webhookEventId" = $1`, [w]),
          webhook: await q(`SELECT xmin::text, ctid::text, state, outcome FROM webhook_event WHERE id = $1`, [w]),
        });
        const before = await rowsOf();
        await runMigrations(legacy.url, [kitMigrationsDir, paymentMigrationsDir]); // 0023 on top
        expect(await rowsOf()).toEqual(before); // no row rewritten
        expect(await q(`SELECT "captureBasis" FROM payment_dispute WHERE id = $1`, [d])).toEqual({ captureBasis: 'settling_capture' });
        expect(await disputeExposure(pool, p)).toMatchObject({ state: 'unresolved', conflicts: 1 }); // resolved only by explicit reconciliation
      } finally {
        await pool.end();
        await legacy.drop();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

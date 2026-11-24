import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { Logger } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import type { OwnerCompanyAuthority, VerifiedOwner } from '../src/disputes/owner-company.authority.js';
import { jobContext } from '../src/events/payment-events.js';
import type { ProviderCapabilities } from '../src/providers/provider.port.js';
import { SimulationPaymentProvider } from '../src/providers/simulation-provider.js';
import { RefundEvidenceService } from '../src/refunds/refund-evidence.service.js';
import { RefundWorker } from '../src/refunds/refund-worker.js';
import { TEST_PLATFORM, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { startFakeReceiptServer, type FakeReceiptServer } from './support/fake-receipts.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '2f1b8d6c-4e3a-4b7c-8d9e-0f1a2b3c4d5e';
const COMPANY = '5b0c2f4e-1d3a-4c6b-8e9f-0a1b2c3d4e5f';
const COMPANY2 = '6c1d3a5f-2e4b-4d7c-9f0a-1b2c3d4e5f60';
const OWNER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const OWNER2 = '8e7d6c5b-4a3f-4e2d-9c1b-0a9f8e7d6c5b';
const SECRET = 'dr1a-capabilities-simulation-webhook-secret-000000000000';
type Row = Record<string, any>;

/**
 * Core V2 D-R1A (the Owner's D-R1 direction of 2026-11-23, Q1-Q6; migration 0036): the foundation of fail-closed refund finality.
 *   * Q4: a provider FAILURE reported for an attempt that already has its own verified refund fact keeps BOTH observations (one
 *     `failure_after_refund_evidence` escalation, audited, Owner-visible); the fact, the attempt's approved transition and allocation are unchanged.
 *   * Q5: a same-key resend happens only under a certified idempotency-retention guarantee; without one nothing is sent, the attempt stays
 *     unresolved and one `idempotency_retention_unproven` escalation is kept. The simulation's certified contract keeps R6B-4 unchanged.
 *   * Since D-R1B (0037): an uncertified failure permits no replacement, and an attempt with its own verified refund fact never becomes `failed` (OD-DR1-1).
 * Real application (two instances), PostgreSQL 16, the simulation provider and the fake Auth receipt server. LABELLED FIXTURES: the crash window
 * between a fact's commit and its decision is reproduced by calling the evidence service's own fact step; an uncertified provider is the simulation
 * adapter with its certificate references removed on the running instances (the registry is untouched).
 */
describeWithEnv('Core V2 D-R1A: refund capability foundation — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let t2: TestApp;
  let admin: pg.Pool;
  let auth: FakeReceiptServer;
  let worker: RefundWorker;
  let worker2: RefundWorker;
  const billing = generateServiceToken();
  const harness = generateServiceToken();
  const identities: Record<string, AuthIdentity> = {
    'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] },
    'owner-jwt': { id: OWNER, adminTier: 'owner', isActive: true, memberships: [] },
    'owner2-jwt': { id: OWNER2, adminTier: 'owner', isActive: true, memberships: [] },
  };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const owners: Record<string, VerifiedOwner> = { 'owner-jwt': { userId: OWNER, companyId: COMPANY }, 'owner2-jwt': { userId: OWNER2, companyId: COMPANY2 } };
  const ownerAuthority: OwnerCompanyAuthority = { owner: async (bearer) => owners[bearer] ?? null };
  const server = () => t.app.getHttpServer();
  const cmd = () => `cmd-${randomUUID()}`;
  const key = () => `k-${randomUUID()}`;
  const sim = (path: string, send: Row) => request(server()).post(`/payment/simulation/${path}`).set('authorization', `Bearer ${harness.token}`).send(send);

  const capturedPayment = async (): Promise<string> => {
    const p = (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send({
      paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
      seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER,
    }).expect(201)).body;
    const a = (await request(server()).post(`/payment/payments/${p.id}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({}).expect(201)).body;
    await sim(`payments/${p.id}/attempts/${a.id}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
    return p.id as string;
  };
  /** One refund attempt through the real request path, under a fresh Owner receipt; returns the HTTP answer. */
  const requestRefund = async (paymentId: string, caseId: string) => {
    const r = auth.issue({ operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId, amount: 9000, currency: 'TND', reason: 'customer_request' }, OWNER);
    const attemptId = randomUUID();
    const res = await request(server()).post(`/payment/payments/${paymentId}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
      .send({ refundAttemptId: attemptId, refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: r.secret });
    return { res, attemptId };
  };
  const authorizedAttempt = async (): Promise<{ paymentId: string; attemptId: string; caseId: string }> => {
    const paymentId = await capturedPayment();
    const caseId = randomUUID();
    const { res, attemptId } = await requestRefund(paymentId, caseId);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('authorized');
    return { paymentId, attemptId, caseId };
  };
  const drain = async (attemptId: string, w: RefundWorker = worker) => {
    await admin.query(`UPDATE refund_attempt SET "workAfter" = NULL WHERE id = $1`, [attemptId]);
    await w.drainOnce();
  };
  /** Authorized, then dispatched by the worker (the provider accepts): `submitted`. */
  const submittedAttempt = async () => {
    const x = await authorizedAttempt();
    await drain(x.attemptId);
    expect((await attemptRow(x.attemptId)).status).toBe('submitted');
    return x;
  };
  /** Authorized, dispatched with an ambiguous answer (`unknown`), then the provider has no record of it. */
  const unknownNoRecordAttempt = async () => {
    const x = await authorizedAttempt();
    await sim(`payments/${x.paymentId}/refund-dispatch-plan`, { commandId: cmd(), mode: 'ambiguous' }).expect(201);
    await drain(x.attemptId);
    expect((await attemptRow(x.attemptId)).status).toBe('unknown');
    await sim(`refunds/${x.attemptId}/outcomes`, { commandId: cmd(), outcome: 'no_record' }).expect(201);
    return x;
  };
  const outcome = (attemptId: string, send: Row) => sim(`refunds/${attemptId}/outcomes`, { commandId: cmd(), ...send }).expect(201);
  const attemptRow = async (id: string) => (await admin.query(`SELECT * FROM refund_attempt WHERE id = $1`, [id])).rows[0];
  const escalationsOf = async (attemptId: string, kind: string) => (await admin.query(
    `SELECT * FROM refund_safety_escalation WHERE "refundAttemptId" = $1 AND kind = $2 ORDER BY "escalatedAt"`, [attemptId, kind])).rows;
  const factsOf = async (attemptId: string) => (await admin.query(`SELECT * FROM provider_transaction_fact WHERE "refundAttemptId" = $1 AND kind = 'refund' ORDER BY id`, [attemptId])).rows;
  const allocationsOf = async (paymentId: string) => (await admin.query(`SELECT * FROM refund_allocation WHERE "paymentId" = $1 ORDER BY id`, [paymentId])).rows;
  const auditsOf = async (attemptId: string) => (await admin.query(
    `SELECT name, payload FROM outbox WHERE name = 'audit.refund_safety.escalated' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt"`, [attemptId])).rows;
  const received = async (attemptId: string) => (await admin.query(`SELECT received FROM simulation_refund_dispatch WHERE "idempotencyKey" = $1`, [attemptId])).rows[0]?.received ?? 0;
  const itemsOf = async (bearer: string) => (await request(server()).get('/payment/admin/reconciliation-items?kind=refund_safety_escalation&limit=200')
    .set('authorization', `Bearer ${bearer}`).expect(200)).body.items as Row[];

  /** LABELLED FIXTURE: the simulation adapter on BOTH running instances referencing no certificate (an uncertified provider), restored after. */
  const uncertified = async <T>(fn: () => Promise<T>, refs: ProviderCapabilities['refundCapabilityCertificates'] = []): Promise<T> => {
    const sims = [t.app.get(SimulationPaymentProvider), t2.app.get(SimulationPaymentProvider)];
    const saved = sims.map((s) => s.capabilities);
    sims.forEach((s, i) => Object.defineProperty(s, 'capabilities', { value: Object.freeze({ ...saved[i]!, refundCapabilityCertificates: refs }), configurable: true, writable: true }));
    try {
      return await fn();
    } finally {
      sims.forEach((s, i) => Object.defineProperty(s, 'capabilities', { value: saved[i], configurable: true, writable: true }));
    }
  };

  /** LABELLED FIXTURE: the simulation adapter on both instances declaring its modelled failure finality (the opt-in), for `fn` only. */
  const certifiedFinality = <T>(fn: () => Promise<T>): Promise<T> => uncertified(fn, [{ id: 'simulation-refund-contract', version: 1 }, { id: 'simulation-refund-failure-finality', version: 1 }]);

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentdr1a');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    auth = await startFakeReceiptServer();
    const appOpts = () => ({
      databaseUrl: db.url, authClient, ownerAuthority, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], refundWorker: false,
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token, PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET,
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create', 'payment.reconciliation.read'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
      },
    });
    t = await createTestApp(appOpts());
    t2 = await createTestApp(appOpts()); // a second Payment instance on the same database
    worker = t.app.get(RefundWorker);
    worker2 = t2.app.get(RefundWorker);
  });
  afterAll(async () => {
    await t?.app.close();
    await t2?.app.close();
    await auth?.close();
    await admin?.end();
    await db?.drop();
  });

  describe('Q4: a failure after verified refund evidence keeps both observations', () => {
    it('C1 succeeded, then a provider failure: one escalation (twice reported, two channels), the attempt, fact and allocation unchanged', async () => {
      const x = await submittedAttempt();
      await outcome(x.attemptId, { outcome: 'succeeded' });
      const before = { attempt: await attemptRow(x.attemptId), facts: await factsOf(x.attemptId), allocations: await allocationsOf(x.paymentId) };
      expect(before.attempt.status).toBe('succeeded');
      expect(before.facts).toHaveLength(1);

      await outcome(x.attemptId, { outcome: 'failed', failureCode: 'insufficient_funds' }); // the webhook
      await outcome(x.attemptId, { outcome: 'failed', failureCode: 'insufficient_funds' }); // a redelivery under another command
      const rows = await escalationsOf(x.attemptId, 'failure_after_refund_evidence');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ factId: before.facts[0].id, attemptStatus: 'succeeded', observedFailureCode: 'insufficient_funds', paymentId: x.paymentId, companyId: COMPANY });
      expect(await attemptRow(x.attemptId)).toEqual(before.attempt); // never displaced
      expect(await factsOf(x.attemptId)).toEqual(before.facts);
      expect(await allocationsOf(x.paymentId)).toEqual(before.allocations); // no allocation change
      const audits = await auditsOf(x.attemptId);
      expect(audits).toHaveLength(1);
      expect(audits[0].payload.changes).toEqual({ escalation_id: rows[0].id, kind: 'failure_after_refund_evidence', payment_id: x.paymentId, fact_id: before.facts[0].id, attempt_status: 'succeeded' });
      expect(audits[0].payload.actor).toEqual({ type: 'system', id: 'payment_webhook' });
    });

    it('C2 crash window: the own fact committed, its decision not; OD-DR1-1: the failure is preserved and the attempt never becomes failed', async () => {
      const x = await submittedAttempt();
      // LABELLED FIXTURE: only the evidence service's FC-1 fact step runs (a crash before its decision)
      const evidence = t.app.get(RefundEvidenceService) as unknown as { recordRefundFact: (id: string, s: Row, ctx: unknown) => Promise<{ id: string }> };
      const fact = await evidence.recordRefundFact(x.attemptId, { kind: 'succeeded', amount: 9000, currency: 'TND', providerRefundId: `simr_${x.attemptId}` }, jobContext('refund_worker'));
      expect((await attemptRow(x.attemptId)).status).toBe('submitted');
      await outcome(x.attemptId, { outcome: 'failed', failureCode: 'declined' });
      const rows = await escalationsOf(x.attemptId, 'failure_after_refund_evidence');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ factId: fact.id, attemptStatus: 'submitted', observedFailureCode: 'declined' });
      expect((await attemptRow(x.attemptId)).status).toBe('submitted'); // OD-DR1-1 (D-R1B): in flight, so it still blocks a replacement
      await outcome(x.attemptId, { outcome: 'failed', failureCode: 'declined' }); // reported again
      await drain(x.attemptId);
      expect((await attemptRow(x.attemptId)).status).toBe('submitted');
      expect(await escalationsOf(x.attemptId, 'failure_after_refund_evidence')).toHaveLength(1);
      expect((await requestRefund(x.paymentId, x.caseId)).res.status).toBe(409);
      expect((await factsOf(x.attemptId)).map((f) => f.id)).toEqual([fact.id]);
    });

    it('C3 discrepancy, then a failure: preserved with its status; a failure with no own fact (negative control) records nothing', async () => {
      const d = await submittedAttempt();
      await outcome(d.attemptId, { outcome: 'amount_mismatch' });
      expect((await attemptRow(d.attemptId)).status).toBe('discrepancy');
      await outcome(d.attemptId, { outcome: 'failed', failureCode: 'reversed' });
      expect(await escalationsOf(d.attemptId, 'failure_after_refund_evidence')).toMatchObject([{ attemptStatus: 'discrepancy', observedFailureCode: 'reversed' }]);
      expect((await attemptRow(d.attemptId)).status).toBe('discrepancy');

      const n = await submittedAttempt();
      await outcome(n.attemptId, { outcome: 'failed', failureCode: 'declined' });
      expect((await attemptRow(n.attemptId)).status).toBe('failed'); // the approved S6b transition
      expect(await escalationsOf(n.attemptId, 'failure_after_refund_evidence')).toEqual([]);
      expect(await auditsOf(n.attemptId)).toEqual([]);
    });

    /** LABELLED FIXTURE: while the worker's dispatch call is in flight, `during` runs (a success arriving concurrently); then the provider answers. */
    const duringDispatch = async (during: () => Promise<void>, fn: () => Promise<void>) => {
      const s = t.app.get(SimulationPaymentProvider);
      const original = s.refund.bind(s);
      Object.defineProperty(s, 'refund', { value: async (d: Parameters<typeof original>[0]) => { const r = await original(d); await during(); return r; }, configurable: true, writable: true });
      try {
        await fn();
      } finally {
        delete (s as unknown as Record<string, unknown>).refund;
      }
    };
    const evidenceSteps = () => t.app.get(RefundEvidenceService) as unknown as {
      recordRefundFact: (id: string, s: Row, ctx: unknown) => Promise<{ id: string }>;
      apply: (id: string, s: Row, ctx: unknown) => Promise<Row>;
    };

    it('C5 a definitive dispatch refusal racing a verified success: both kept; the success stands', async () => {
      const x = await authorizedAttempt();
      await sim(`payments/${x.paymentId}/refund-dispatch-plan`, { commandId: cmd(), mode: 'rejected', failureCode: 'declined' }).expect(201);
      const success = { kind: 'succeeded', amount: 9000, currency: 'TND', providerRefundId: `simr_${x.attemptId}` };
      await duringDispatch(async () => { await evidenceSteps().apply(x.attemptId, success, jobContext('refund_worker')); }, () => drain(x.attemptId));
      const attempt = await attemptRow(x.attemptId);
      expect(attempt.status).toBe('succeeded');
      const rows = await escalationsOf(x.attemptId, 'failure_after_refund_evidence');
      expect(rows).toMatchObject([{ attemptStatus: 'succeeded', observedFailureCode: 'declined', factId: attempt.succeededFactId }]);
      expect(await auditsOf(x.attemptId)).toHaveLength(1);
      expect((await auditsOf(x.attemptId))[0].payload.actor).toEqual({ type: 'system', id: 'payment_refund_worker' });
    });

    it('C6 a definitive dispatch refusal after only the own fact committed: kept, never failed (OD-DR1-1), its key never sent again', async () => {
      const x = await authorizedAttempt();
      await sim(`payments/${x.paymentId}/refund-dispatch-plan`, { commandId: cmd(), mode: 'rejected', failureCode: 'declined' }).expect(201);
      let factId = '';
      await duringDispatch(async () => {
        factId = (await evidenceSteps().recordRefundFact(x.attemptId, { kind: 'succeeded', amount: 9000, currency: 'TND', providerRefundId: `simr_${x.attemptId}` }, jobContext('refund_worker'))).id;
      }, () => drain(x.attemptId));
      expect(await escalationsOf(x.attemptId, 'failure_after_refund_evidence')).toMatchObject([{ attemptStatus: 'dispatching', observedFailureCode: 'declined', factId }]);
      expect((await admin.query(`SELECT count(*)::int AS n FROM outbox WHERE name = 'audit.refund_attempt.failed' AND payload->'resource'->>'id' = $1`, [x.attemptId])).rows[0].n).toBe(0);
      expect((await attemptRow(x.attemptId)).status).toBe('dispatching');
      await drain(x.attemptId);
      await drain(x.attemptId, worker2);
      expect(await received(x.attemptId)).toBe(1); // it was refunded: its key is not sent again, its status is only read
      await evidenceSteps().apply(x.attemptId, { kind: 'succeeded', amount: 9000, currency: 'TND', providerRefundId: `simr_${x.attemptId}` }, jobContext('refund_worker'));
      expect(await attemptRow(x.attemptId)).toMatchObject({ status: 'succeeded', succeededFactId: factId }); // the success report still decides it
    });

    it('C7 a definitive dispatch refusal with no fact records nothing (negative control)', async () => {
      const x = await authorizedAttempt();
      await sim(`payments/${x.paymentId}/refund-dispatch-plan`, { commandId: cmd(), mode: 'rejected', failureCode: 'declined' }).expect(201);
      await drain(x.attemptId);
      expect((await attemptRow(x.attemptId)).status).toBe('failed');
      expect(await escalationsOf(x.attemptId, 'failure_after_refund_evidence')).toEqual([]);
    });

    it('C9 LIMIT (OD-DR1-6, characterization): a dispatch refusal whose decision transaction fails after a concurrent success is not recovered', async () => {
      const x = await authorizedAttempt();
      await sim(`payments/${x.paymentId}/refund-dispatch-plan`, { commandId: cmd(), mode: 'rejected', failureCode: 'declined' }).expect(201);
      const success = { kind: 'succeeded', amount: 9000, currency: 'TND', providerRefundId: `simr_${x.attemptId}` };
      await admin.query(`CREATE FUNCTION dr1a_fail_audit9() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.name = 'audit.refund_safety.escalated' THEN RAISE EXCEPTION 'injected outbox failure'; END IF; RETURN NEW; END $$`);
      const errors = vi.spyOn(Logger.prototype, 'error');
      try {
        await duringDispatch(async () => {
          await evidenceSteps().apply(x.attemptId, success, jobContext('refund_worker'));
          await admin.query(`CREATE TRIGGER zz_dr1a_fail_audit9 BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION dr1a_fail_audit9()`);
        }, () => drain(x.attemptId));
      } finally {
        await admin.query(`DROP TRIGGER IF EXISTS zz_dr1a_fail_audit9 ON outbox`);
        await admin.query(`DROP FUNCTION dr1a_fail_audit9()`);
      }
      expect(errors.mock.calls.some(([m]) => typeof m === 'string' && m.startsWith(`refund_dispatch_refusal_unrecorded refundAttempt=${x.attemptId}`) && m.includes('code=declined'))).toBe(true);
      errors.mockRestore();
      await worker.drainOnce(); // a later pass: the terminal attempt is never scanned again
      expect((await attemptRow(x.attemptId)).status).toBe('succeeded'); // the success stands
      expect(await escalationsOf(x.attemptId, 'failure_after_refund_evidence')).toEqual([]); // the refusal survives only in the error log
    });

    it('C8 failed, replacement authorized, late success kept by RLSC-1, then another failure: preserved; RLSC-1 row and the attempt unchanged', async () => {
      const x = await submittedAttempt();
      await certifiedFinality(async () => {
        await outcome(x.attemptId, { outcome: 'failed', failureCode: 'declined' });
        const { res } = await requestRefund(x.paymentId, x.caseId); // the replacement: simulation-certified finality only (D-R1B)
        expect(res.body.status).toBe('authorized');
      });
      await outcome(x.attemptId, { outcome: 'succeeded' });
      const rlsc = (await admin.query(`SELECT * FROM refund_safety_escalation WHERE "refundAttemptId" = $1 AND kind = 'failed_attempt_refund_evidence'`, [x.attemptId])).rows;
      expect(rlsc).toHaveLength(1);
      expect((await attemptRow(x.attemptId)).status).toBe('failed');
      await outcome(x.attemptId, { outcome: 'failed', failureCode: 'reversed' });
      expect(await escalationsOf(x.attemptId, 'failure_after_refund_evidence')).toMatchObject([{ attemptStatus: 'failed', observedFailureCode: 'reversed', factId: rlsc[0].factId }]);
      expect((await admin.query(`SELECT * FROM refund_safety_escalation WHERE "refundAttemptId" = $1 AND kind = 'failed_attempt_refund_evidence'`, [x.attemptId])).rows).toEqual(rlsc);
      expect((await attemptRow(x.attemptId)).status).toBe('failed');
    });

    it('C4 the escalation\'s audit intent failing rolls the failure report back whole; the redelivery records it once', async () => {
      const x = await submittedAttempt();
      await outcome(x.attemptId, { outcome: 'succeeded' });
      await admin.query(`CREATE FUNCTION dr1a_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.name = 'audit.refund_safety.escalated' THEN RAISE EXCEPTION 'injected outbox failure'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER zz_dr1a_fail_audit BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION dr1a_fail_audit()`);
      try {
        const r = await outcome(x.attemptId, { outcome: 'failed', failureCode: 'declined' });
        expect(r.body.delivered.status).not.toBe(200);
        expect(await escalationsOf(x.attemptId, 'failure_after_refund_evidence')).toEqual([]);
      } finally {
        await admin.query(`DROP TRIGGER zz_dr1a_fail_audit ON outbox`);
        await admin.query(`DROP FUNCTION dr1a_fail_audit()`);
      }
      await outcome(x.attemptId, { outcome: 'failed', failureCode: 'declined' }); // the provider reports it again
      expect(await escalationsOf(x.attemptId, 'failure_after_refund_evidence')).toHaveLength(1);
      expect(await auditsOf(x.attemptId)).toHaveLength(1);
      expect((await attemptRow(x.attemptId)).status).toBe('succeeded');
    });
  });

  describe('Q5: a same-key resend needs a certified idempotency guarantee', () => {
    it('R1 the simulation contract (certified, unbounded) keeps R6B-4: unknown + no record is sent again with the same key, nothing escalated', async () => {
      const x = await unknownNoRecordAttempt();
      expect(await received(x.attemptId)).toBe(1);
      await drain(x.attemptId);
      expect(await received(x.attemptId)).toBe(2);
      expect(await escalationsOf(x.attemptId, 'idempotency_retention_unproven')).toEqual([]);
    });

    it('R2 uncertified: nothing is sent, the attempt stays unknown, ONE escalation from two instances and repeated passes; never a new key, never failed', async () => {
      const x = await unknownNoRecordAttempt();
      const before = await attemptRow(x.attemptId);
      await uncertified(async () => {
        await admin.query(`UPDATE refund_attempt SET "workAfter" = NULL WHERE id = $1`, [x.attemptId]);
        await Promise.all([worker.drainOnce(), worker2.drainOnce()]);
        await drain(x.attemptId);
        await drain(x.attemptId, worker2);
      });
      expect(await received(x.attemptId)).toBe(1);
      const after = await attemptRow(x.attemptId);
      expect({ ...after, workAfter: null }).toEqual({ ...before, workAfter: null });
      const rows = await escalationsOf(x.attemptId, 'idempotency_retention_unproven');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ factId: null, attemptStatus: 'unknown', observedFailureCode: null });
      const audits = await auditsOf(x.attemptId);
      expect(audits).toHaveLength(1);
      expect(audits[0].payload.changes).toEqual({ escalation_id: rows[0].id, kind: 'idempotency_retention_unproven', payment_id: x.paymentId, attempt_status: 'unknown' });
      expect(audits[0].payload.actor).toEqual({ type: 'system', id: 'payment_refund_worker' });
      expect((await admin.query(`SELECT count(*)::int AS n FROM refund_attempt WHERE "paymentId" = $1`, [x.paymentId])).rows[0].n).toBe(1); // no new attempt or key

      // the escalation holds nothing: once the guarantee is certified again, the same key is sent (R6B-4)
      await drain(x.attemptId);
      expect(await received(x.attemptId)).toBe(2);
      expect(await escalationsOf(x.attemptId, 'idempotency_retention_unproven')).toHaveLength(1);
    });

    it('R3 a reference to an unregistered certificate certifies nothing (adapter self-certification refused)', async () => {
      const x = await unknownNoRecordAttempt();
      await uncertified(() => drain(x.attemptId), [{ id: 'self-declared-retention', version: 1 }]);
      expect(await received(x.attemptId)).toBe(1);
      expect(await escalationsOf(x.attemptId, 'idempotency_retention_unproven')).toHaveLength(1);
    });

    it('R4 a crash after `dispatching` with no certified guarantee: not resent; the provider status is still read and a definitive answer applied', async () => {
      const x = await authorizedAttempt();
      await admin.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1`, [x.attemptId]); // the guarded move; the send never happened
      await uncertified(() => drain(x.attemptId));
      expect(await received(x.attemptId)).toBe(0);
      expect((await attemptRow(x.attemptId)).status).toBe('dispatching');
      expect(await escalationsOf(x.attemptId, 'idempotency_retention_unproven')).toMatchObject([{ attemptStatus: 'dispatching' }]);
      // the certified simulation then sends it with the same key, as before D-R1A
      await drain(x.attemptId);
      expect(await received(x.attemptId)).toBe(1);
      expect((await attemptRow(x.attemptId)).status).toBe('submitted');
    });

    it('R5 the first send (authorized) is unchanged without any certificate', async () => {
      const x = await authorizedAttempt();
      await uncertified(() => drain(x.attemptId));
      expect(await received(x.attemptId)).toBe(1);
      expect((await attemptRow(x.attemptId)).status).toBe('submitted');
      expect(await escalationsOf(x.attemptId, 'idempotency_retention_unproven')).toEqual([]);
    });

    it('R6 notFound never fails or replaces an attempt, certified or not (Rule 3)', async () => {
      const x = await unknownNoRecordAttempt();
      await uncertified(() => drain(x.attemptId));
      await drain(x.attemptId);
      expect((await attemptRow(x.attemptId)).status).not.toBe('failed');
      expect((await admin.query(`SELECT count(*)::int AS n FROM refund_attempt WHERE "paymentId" = $1`, [x.paymentId])).rows[0].n).toBe(1);
    });
  });

  describe('replacement eligibility (D-R1B; the whole matrix is in dr1b-replacement-guard)', () => {
    it('E1 NEGATIVE CONTROL: after an uncertified provider failure a new receipt authorizes no replacement', async () => {
      const x = await submittedAttempt();
      await outcome(x.attemptId, { outcome: 'failed', failureCode: 'declined' });
      expect((await attemptRow(x.attemptId)).status).toBe('failed');
      const { res } = await requestRefund(x.paymentId, x.caseId);
      expect([res.status, res.body.code]).toEqual([409, 'refund_in_progress']);
    });
  });

  describe('database guards (0036)', () => {
    it('G1 refuses a forged or foreign fact, a wrong state, a missing or malformed code, a code on another kind; derives the rest; append-only', async () => {
      const ins = (kind: string, attemptId: string, factId: string | null, code: string | null) => admin.query(
        `INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "factId", "paymentId", "companyId", "captureFactId", "attemptStatus", "observedFailureCode")
         SELECT $1, a.id, $3, a."paymentId", $5, a."captureFactId", 'forged', $4 FROM refund_attempt a WHERE a.id = $2 RETURNING *`, [kind, attemptId, factId, code, COMPANY2]);
      const s = await submittedAttempt();
      await outcome(s.attemptId, { outcome: 'succeeded' });
      const own = (await factsOf(s.attemptId))[0].id;
      const other = await submittedAttempt();
      await outcome(other.attemptId, { outcome: 'succeeded' });
      const foreign = (await factsOf(other.attemptId))[0].id;
      await expect(ins('failure_after_refund_evidence', s.attemptId, foreign, 'declined')).rejects.toMatchObject({ code: '23514', constraint: 'refund_safety_escalation_evidence' });
      await expect(ins('failure_after_refund_evidence', s.attemptId, own, null)).rejects.toMatchObject({ code: '23514', constraint: 'refund_safety_escalation_observed_failure_shape' });
      await expect(ins('failure_after_refund_evidence', s.attemptId, own, 'Not A Code')).rejects.toMatchObject({ code: '23514', constraint: 'refund_safety_escalation_observed_failure_shape' });
      await expect(ins('failure_after_refund_evidence', s.attemptId, null, 'declined')).rejects.toMatchObject({ code: '23514' });
      const row = (await ins('failure_after_refund_evidence', s.attemptId, own, 'declined')).rows[0];
      expect(row).toMatchObject({ attemptStatus: 'succeeded', companyId: COMPANY, paymentId: s.paymentId }); // derived, never the caller's
      await expect(ins('failure_after_refund_evidence', s.attemptId, own, 'declined')).rejects.toMatchObject({ code: '23505' }); // once per attempt
      // an attempt never sent (`authorized`) is not a state a provider failure can contradict: LABELLED FIXTURE, an own fact recorded for it
      const h = await authorizedAttempt();
      const evidence = t.app.get(RefundEvidenceService) as unknown as { recordRefundFact: (id: string, s: Row, ctx: unknown) => Promise<{ id: string }> };
      const hFact = await evidence.recordRefundFact(h.attemptId, { kind: 'succeeded', amount: 9000, currency: 'TND', providerRefundId: `simr_${h.attemptId}` }, jobContext('refund_worker'));
      expect((await attemptRow(h.attemptId)).status).toBe('authorized');
      await expect(ins('failure_after_refund_evidence', h.attemptId, hFact.id, 'declined')).rejects.toMatchObject({ constraint: 'refund_safety_escalation_evidence' });

      // idempotency_retention_unproven: only dispatching / unknown; its fact is nulled; the code shape belongs to the other kind
      await expect(ins('idempotency_retention_unproven', s.attemptId, null, null)).rejects.toMatchObject({ constraint: 'refund_safety_escalation_evidence' });
      const u = await unknownNoRecordAttempt();
      await expect(ins('idempotency_retention_unproven', u.attemptId, null, 'declined')).rejects.toMatchObject({ constraint: 'refund_safety_escalation_observed_failure_shape' });
      const r = (await ins('idempotency_retention_unproven', u.attemptId, own, null)).rows[0];
      expect(r).toMatchObject({ factId: null, attemptStatus: 'unknown' });
      // the existing kinds keep their shape: a code on them is refused, their fact still required
      await expect(ins('dispatch_held', s.attemptId, own, 'declined')).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE refund_safety_escalation SET "observedFailureCode" = 'other' WHERE id = $1`, [row.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`DELETE FROM refund_safety_escalation WHERE id = $1`, [r.id])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('Owner visibility (PAY-12, Owner only, Company-scoped)', () => {
    it('V1 both kinds are listed for the seller Company\'s Owner with their detail; never for another Company\'s Owner', async () => {
      const x = await submittedAttempt();
      await outcome(x.attemptId, { outcome: 'succeeded' });
      await outcome(x.attemptId, { outcome: 'failed', failureCode: 'insufficient_funds' });
      const u = await unknownNoRecordAttempt();
      await uncertified(() => drain(u.attemptId));
      const [fe] = await escalationsOf(x.attemptId, 'failure_after_refund_evidence');
      const [re] = await escalationsOf(u.attemptId, 'idempotency_retention_unproven');
      const mine = await itemsOf('owner-jwt');
      expect(Number(mine.find((i) => i.id === fe.id)!.amount)).toBe(9000);
      expect(mine.find((i) => i.id === fe.id)).toMatchObject({ currency: 'TND',
        detail: { kind: 'failure_after_refund_evidence', refundAttemptId: x.attemptId, attemptStatus: 'succeeded', observedFailureCode: 'insufficient_funds' } });
      const item = mine.find((i) => i.id === re.id);
      expect(item).toMatchObject({ amount: null, currency: null, detail: { kind: 'idempotency_retention_unproven', refundAttemptId: u.attemptId, attemptStatus: 'unknown' } });
      expect(item!.detail.authorizedAt).toBeTruthy();
      const theirs = await itemsOf('owner2-jwt');
      expect(theirs.some((i) => i.id === fe.id || i.id === re.id)).toBe(false);
    });
  });
});

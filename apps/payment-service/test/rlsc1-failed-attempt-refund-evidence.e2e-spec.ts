import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import type { OwnerCompanyAuthority, VerifiedOwner } from '../src/disputes/owner-company.authority.js';
import { RefundWorker } from '../src/refunds/refund-worker.js';
import { WebhookRetriever } from '../src/webhooks/webhook-retrier.js';
import { TEST_PLATFORM, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { startFakeReceiptServer, type FakeReceiptServer } from './support/fake-receipts.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '2f1b8d6c-4e3a-4b7c-8d9e-0f1a2b3c4d5e';
const COMPANY = '5b0c2f4e-1d3a-4c6b-8e9f-0a1b2c3d4e5f';
const COMPANY2 = '6c1d3a5f-2e4b-4d7c-9f0a-1b2c3d4e5f60';
const OWNER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const OWNER2 = '8e7d6c5b-4a3f-4e2d-9c1b-0a9f8e7d6c5b';
const SECRET = randomBytes(32).toString('hex');

type Row = Record<string, any>;

/**
 * Core V2 RLSC-1 (the Owner's RLSC-1 GO, Phase A, 2026-11-17; migration 0033): a verified refund success for a FAILED attempt while another attempt of
 * the same payment and capture is effective. `refund_attempt_one_effective` / `refund_attempt_one_effective_capture` make `discrepancy` impossible; before
 * RLSC-1 the notification failed forever (500 until `retries_exhausted`) although its fact was durable. Now the attempt stays `failed`, the observation
 * is one append-only `failed_attempt_refund_evidence` escalation with one audit intent, and the webhook answers 200 only after both commit.
 * Allocation (S6c / R6C-4), case completion and balances are UNCHANGED; the overlap they produce is pinned below as an UNRESOLVED risk (OD-RLSC-1 open),
 * never as approved behaviour. Development and simulation only; real application, PostgreSQL 16, simulation provider, fake Auth.
 */
describeWithEnv('Core V2 RLSC-1: a failed attempt\'s refund evidence while another attempt is effective — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let t2: TestApp;
  let admin: pg.Pool;
  let auth: FakeReceiptServer;
  let worker: RefundWorker;
  let retrier: WebhookRetriever;
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
  const server = (app: TestApp = t) => app.app.getHttpServer();
  const cmd = () => `cmd-${randomUUID()}`;
  const key = () => `k-${randomUUID()}`;
  const sim = (path: string, send: Row) => request(server()).post(`/payment/simulation/${path}`).set('authorization', `Bearer ${harness.token}`).send(send);
  const q = async (sql: string, args: unknown[] = []) => (await admin.query(sql, args)).rows;

  /** A captured direct purchase of 9000 TND sold by `company`. */
  const captured = async (company = COMPANY) => {
    const p = (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send({
      paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
      seller: { type: 'company', id: company }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER,
    }).expect(201)).body;
    const a = (await request(server()).post(`/payment/payments/${p.id}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({}).expect(201)).body;
    await sim(`payments/${p.id}/attempts/${a.id}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
    return p.id as string;
  };
  /** Billing's relay of an Owner receipt (PAY-07) for the given refund case: authorized at once. */
  const authorizedAttempt = async (paymentId: string, caseId: string, company = COMPANY, owner = OWNER) => {
    const r = auth.issue({ operation: 'refund', audience: 'payment-service', companyId: company, refundCaseId: caseId, paymentId, amount: 9000, currency: 'TND', reason: 'customer_request' }, owner);
    const attemptId = randomUUID();
    const res = await request(server()).post(`/payment/payments/${paymentId}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
      .send({ refundAttemptId: attemptId, refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: r.secret });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe('authorized');
    return attemptId;
  };
  /** A signed provider refund notification naming `attemptId`, delivered to `app`. */
  const deliver = (attemptId: string, txn: string, o: { eventId?: string; app?: TestApp; amount?: number; signature?: string; body?: Row } = {}) => {
    const raw = Buffer.from(JSON.stringify(o.body ?? { eventId: o.eventId ?? `t_${randomUUID()}`, type: 'refund.succeeded', reference: attemptId, providerTransactionId: txn, amount: o.amount ?? 9000, currency: 'TND' }));
    return request(server(o.app)).post('/payment/webhooks/simulation').set('content-type', 'application/json')
      .set('x-simulation-signature', o.signature ?? createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw.toString('utf8'));
  };
  const reset = async () => {
    await admin.query(`UPDATE refund_attempt SET "workAfter" = NULL WHERE "workAfter" IS NOT NULL AND status NOT IN ('authorization_expired', 'authorization_refused', 'succeeded', 'discrepancy')`);
    await admin.query(`UPDATE refund_fact_allocation_lease SET "workAfter" = NULL`);
  };
  const drain = async () => {
    await reset();
    return worker.drainOnce();
  };
  /** TEST-ONLY time travel on a disposable database (`receivedAt` is immutable by trigger): the stored notification becomes due, then one retrier pass. */
  const retryPass = async (eventId: string) => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE webhook_event SET "receivedAt" = now() - interval '30 days' WHERE "providerEventId" = $1`, [eventId]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    return retrier.drainOnce();
  };
  const status = async (id: string) => (await q(`SELECT status FROM refund_attempt WHERE id = $1`, [id]))[0]!.status as string;
  const dispatches = async (id: string) => Number((await q(`SELECT count(*) FROM simulation_refund_dispatch WHERE "idempotencyKey" = $1`, [id]))[0]!.count);
  const factsOf = async (txn: string) => q(`SELECT id, "refundAttemptId" FROM provider_transaction_fact WHERE "providerTxnId" = $1 AND kind = 'refund'`, [txn]);
  const exceptionsOf = async (attemptId: string) => q(
    `SELECT id, kind, "factId", "paymentId", "companyId", "captureFactId", "attemptStatus", "competingAttemptId", "competingAttemptStatus"
       FROM refund_safety_escalation WHERE "refundAttemptId" = $1 ORDER BY "escalatedAt", id`, [attemptId]);
  const auditsOf = async (attemptId: string) => (await q(
    `SELECT payload FROM outbox WHERE name = 'audit.refund_safety.escalated' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", id`, [attemptId])).map((r) => r.payload);
  const webhookOf = async (eventId: string) => (await q(`SELECT state, outcome, attempts FROM webhook_event WHERE "providerEventId" = $1`, [eventId]))[0];
  const outboxOf = async (paymentId: string) => Object.fromEntries((await q(
    `SELECT name, count(*)::int AS n FROM outbox WHERE payload::text LIKE '%' || $1 || '%' GROUP BY name`, [paymentId])).map((r) => [r.name, r.n]));
  const authorizationsOf = async (paymentId: string) => q(
    `SELECT "refundAttemptId", "allocatedIntended"::int AS allocated, "completedAt" IS NOT NULL AS completed FROM refund_authorization WHERE "paymentId" = $1 ORDER BY "createdAt"`, [paymentId]);
  const itemsFor = async (who: 'billing' | 'owner-jwt' | 'owner2-jwt', kind: string) => {
    const r = who === 'billing'
      ? await request(server()).get(`/payment/reconciliation/items?kind=${kind}&limit=200`).set('authorization', `Bearer ${billing.token}`)
      : await request(server()).get(`/payment/admin/reconciliation-items?kind=${kind}&limit=200`).set('authorization', `Bearer ${who}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.items as Row[];
  };
  const balanceOf = async (paymentId: string) => (await request(server()).get(`/payment/admin/payments/${paymentId}/balance`).set('authorization', 'Bearer owner-jwt').expect(200)).body;

  /** The first attempt dispatched and provider-confirmed `failed`; a second attempt of the SAME refund case brought to `second`. */
  const scenario = async (second: 'none' | 'authorized' | 'submitted' | 'succeeded', company = COMPANY, owner = OWNER) => {
    const p = await captured(company);
    const caseId = randomUUID();
    const first = await authorizedAttempt(p, caseId, company, owner);
    await drain();
    await sim(`refunds/${first}/outcomes`, { commandId: cmd(), outcome: 'failed', failureCode: 'card_closed' }).expect(201);
    expect(await status(first)).toBe('failed');
    let competing: string | null = null;
    if (second !== 'none') {
      competing = await authorizedAttempt(p, caseId, company, owner);
      if (second !== 'authorized') {
        await drain();
        expect(await status(competing)).toBe('submitted');
        if (second === 'succeeded') await sim(`refunds/${competing}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      }
    }
    return { p, caseId, first, competing, txn: `late-${first}` };
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentrlsc1');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    auth = await startFakeReceiptServer();
    const appOpts = () => ({
      databaseUrl: db.url, authClient, ownerAuthority, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], refundWorker: false,
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        // Core V2 D-R1B: these scenarios replace a FAILED attempt, so the simulation explicitly models certified failure finality (never a real provider)
        AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token, PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET, PAYMENT_SIMULATION_REFUND_FAILURE_FINALITY: 'true',
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create', 'payment.reconciliation.read'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
      },
    });
    t = await createTestApp(appOpts());
    t2 = await createTestApp(appOpts()); // a second Payment instance on the same database
    worker = t.app.get(RefundWorker);
    worker.recoveryAfterMs = 0;
    retrier = t.app.get(WebhookRetriever);
    await retrier.stop(); // retries are driven by hand below
    await t2.app.get(WebhookRetriever).stop();
  });
  afterAll(async () => {
    await t?.app.close();
    await t2?.app.close();
    await auth?.close();
    await admin?.end();
    await db?.drop();
  });

  describe('the exception: durable evidence, the attempt stays failed, acknowledged after commit', () => {
    it('L1 competing attempt in flight (submitted): 200 only with one exception row and one audit intent; the attempt stays failed; nothing is sent', async () => {
      const s = await scenario('submitted');
      const ev = `t_${randomUUID()}`;
      const before = await outboxOf(s.p);
      await deliver(s.first, s.txn, { eventId: ev }).expect(200);
      expect(await status(s.first)).toBe('failed');
      expect(await status(s.competing!)).toBe('submitted'); // the competing attempt is untouched
      const [fact] = await factsOf(s.txn);
      expect(fact.refundAttemptId).toBe(s.first);
      const rows = await exceptionsOf(s.first);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'failed_attempt_refund_evidence', factId: fact.id, paymentId: s.p, companyId: COMPANY, attemptStatus: 'failed',
        competingAttemptId: s.competing, competingAttemptStatus: 'submitted' });
      expect(rows[0].captureFactId).toBe((await q(`SELECT "captureFactId" FROM refund_attempt WHERE id = $1`, [s.first]))[0]!.captureFactId);
      const audits = await auditsOf(s.first);
      expect(audits.map((a) => [a.changes.kind, a.changes.attempt_status, a.changes.fact_id, a.changes.escalation_id, a.changes.payment_id]))
        .toEqual([['failed_attempt_refund_evidence', 'failed', fact.id, rows[0].id, s.p]]);
      expect(audits[0].action).toBe('refund_safety.escalated'); // the existing action (catalog category commercial, unchanged)
      expect(await webhookOf(ev)).toMatchObject({ state: 'processed', outcome: `failed_attempt_refund_evidence:${rows[0].id}` });
      expect(await dispatches(s.first)).toBe(1); // its own original dispatch only
      expect(await dispatches(s.competing!)).toBe(1);
      expect((await outboxOf(s.p))['audit.refund_safety.escalated']).toBe(1);
      expect(before['audit.refund_safety.escalated']).toBeUndefined();
      // never a refund_discrepancy: the attempt is failed
      expect((await itemsFor('billing', 'refund_discrepancy')).filter((i) => i.paymentId === s.p)).toEqual([]);
    });

    it('L2 competing attempt already succeeded: the same exception (competing status succeeded), 200', async () => {
      const s = await scenario('succeeded');
      await deliver(s.first, s.txn).expect(200);
      expect(await status(s.first)).toBe('failed');
      const rows = await exceptionsOf(s.first);
      expect(rows.map((r) => [r.kind, r.competingAttemptId, r.competingAttemptStatus])).toEqual([['failed_attempt_refund_evidence', s.competing, 'succeeded']]);
      expect(await auditsOf(s.first)).toHaveLength(1);
    });

    it('L3 competing attempt authorized: the exception is recorded, and DO-76 S1 still holds the competing attempt (nothing sent)', async () => {
      const s = await scenario('authorized');
      await deliver(s.first, s.txn).expect(200);
      expect((await exceptionsOf(s.first)).map((r) => [r.kind, r.competingAttemptStatus])).toEqual([['failed_attempt_refund_evidence', 'authorized']]);
      await drain();
      await drain();
      expect(await status(s.competing!)).toBe('authorized');
      expect(await dispatches(s.competing!)).toBe(0);
      expect((await exceptionsOf(s.competing!)).map((r) => r.kind)).toEqual(['dispatch_held']);
    });

    it('L4 NEGATIVE CONTROL, no competing attempt: the unchanged S6b path (discrepancy, refund_discrepancy item), no exception row', async () => {
      const s = await scenario('none');
      const ev = `t_${randomUUID()}`;
      await deliver(s.first, s.txn, { eventId: ev }).expect(200);
      expect(await status(s.first)).toBe('discrepancy');
      expect(await exceptionsOf(s.first)).toEqual([]);
      expect(await auditsOf(s.first)).toEqual([]);
      expect(await webhookOf(ev)).toMatchObject({ state: 'processed', outcome: `refund_attempt:${s.first}` });
      expect((await itemsFor('billing', 'refund_discrepancy')).filter((i) => i.paymentId === s.p)).toHaveLength(1);
      expect((await itemsFor('billing', 'refund_failed_attempt_evidence')).filter((i) => i.paymentId === s.p)).toEqual([]);
    });
  });

  describe('idempotency: redelivery, retries, two instances', () => {
    it('L5 the same notification redelivered, a new provider event for the same fact and further retrier passes: one row, one audit intent, always 200', async () => {
      const s = await scenario('submitted');
      const ev = `t_${randomUUID()}`;
      await deliver(s.first, s.txn, { eventId: ev }).expect(200);
      const snapshot = await outboxOf(s.p);
      await deliver(s.first, s.txn, { eventId: ev }).expect(200);
      await deliver(s.first, s.txn).expect(200);
      await deliver(s.first, s.txn, { app: t2 }).expect(200);
      for (let i = 0; i < 3; i++) await retryPass(ev); // a processed notification is not retried
      expect(await exceptionsOf(s.first)).toHaveLength(1);
      expect(await auditsOf(s.first)).toHaveLength(1);
      expect(await factsOf(s.txn)).toHaveLength(1);
      expect(await outboxOf(s.p)).toEqual(snapshot);
      expect(await status(s.first)).toBe('failed');
      expect(await dispatches(s.competing!)).toBe(1);
      expect(Number((await q(`SELECT count(*) FROM provider_transaction_fact_conflict c JOIN provider_transaction_fact f ON f.id = c."factId" WHERE f."providerTxnId" = $1`, [s.txn]))[0]!.count)).toBe(0);
    });

    it('L6 two Payment instances, concurrent deliveries of the same evidence: exactly one row and one audit intent; every answer 200', async () => {
      const s = await scenario('submitted');
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => deliver(s.first, s.txn, { app: i % 2 === 0 ? t : t2 })));
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(await exceptionsOf(s.first)).toHaveLength(1);
      expect(await auditsOf(s.first)).toHaveLength(1);
      expect(await factsOf(s.txn)).toHaveLength(1);
      expect(await status(s.first)).toBe('failed');
    });
  });

  describe('failures stay failures: savepoint and transaction boundaries, crash recovery', () => {
    it('L7 the exception transaction fails (its audit write): 500, the fact is kept, no row and no audit intent; a retry then records exactly once', async () => {
      const s = await scenario('submitted');
      const ev = `t_${randomUUID()}`;
      await admin.query(`CREATE FUNCTION rlsc1_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.name = 'audit.refund_safety.escalated' THEN RAISE EXCEPTION 'injected outbox failure'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER zz_rlsc1_fail_audit BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION rlsc1_fail_audit()`);
      try {
        await deliver(s.first, s.txn, { eventId: ev }).expect(500); // never a success acknowledgement without the durable row and audit intent
        expect(await factsOf(s.txn)).toHaveLength(1); // FC-1: the fact committed first, in its own transaction
        expect(await exceptionsOf(s.first)).toEqual([]); // the row rolled back with its audit intent
        expect(await auditsOf(s.first)).toEqual([]);
        expect(await status(s.first)).toBe('failed');
        expect(await webhookOf(ev)).toMatchObject({ state: 'failed', outcome: 'transient_error' }); // retryable
      } finally {
        await admin.query(`DROP TRIGGER zz_rlsc1_fail_audit ON outbox`);
        await admin.query(`DROP FUNCTION rlsc1_fail_audit()`);
      }
      expect((await retryPass(ev)).retried).toBe(1); // the retrier, as after a crash
      expect(await webhookOf(ev)).toMatchObject({ state: 'processed' });
      expect(await exceptionsOf(s.first)).toHaveLength(1);
      expect(await auditsOf(s.first)).toHaveLength(1);
    });

    it('L8 the exception row write fails: 500, nothing half-written, retryable', async () => {
      const s = await scenario('submitted');
      const ev = `t_${randomUUID()}`;
      await admin.query(`CREATE FUNCTION rlsc1_fail_row() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.kind = 'failed_attempt_refund_evidence' THEN RAISE EXCEPTION 'injected escalation failure'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER zz_rlsc1_fail_row BEFORE INSERT ON refund_safety_escalation FOR EACH ROW EXECUTE FUNCTION rlsc1_fail_row()`);
      try {
        await deliver(s.first, s.txn, { eventId: ev }).expect(500);
        expect(await exceptionsOf(s.first)).toEqual([]);
        expect(await auditsOf(s.first)).toEqual([]);
        expect(await webhookOf(ev)).toMatchObject({ state: 'failed', outcome: 'transient_error' });
      } finally {
        await admin.query(`DROP TRIGGER zz_rlsc1_fail_row ON refund_safety_escalation`);
        await admin.query(`DROP FUNCTION rlsc1_fail_row()`);
      }
      await deliver(s.first, s.txn, { eventId: ev }).expect(200); // the provider's redelivery
      expect(await exceptionsOf(s.first)).toHaveLength(1);
      expect(await auditsOf(s.first)).toHaveLength(1);
    });

    /** A test-only trigger making `failed` -> `discrepancy` of one attempt raise 23505 under a chosen constraint name (no competing attempt exists). */
    const injectUnique = async (attemptId: string, constraint: string) => {
      await admin.query(`CREATE FUNCTION rlsc1_inject_unique() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.id = '${attemptId}'::uuid AND OLD.status = 'failed' AND NEW.status = 'discrepancy' THEN
          RAISE EXCEPTION 'injected unique violation' USING ERRCODE = '23505', CONSTRAINT = '${constraint}'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER zz_rlsc1_inject_unique BEFORE UPDATE ON refund_attempt FOR EACH ROW EXECUTE FUNCTION rlsc1_inject_unique()`);
    };
    const removeUnique = async () => {
      await admin.query(`DROP TRIGGER zz_rlsc1_inject_unique ON refund_attempt`);
      await admin.query(`DROP FUNCTION rlsc1_inject_unique()`);
    };

    it('L9 another 23505 from the same transition (not a one_effective index) propagates: 500, no exception, retryable; then the unchanged path', async () => {
      const s = await scenario('none');
      const ev = `t_${randomUUID()}`;
      await injectUnique(s.first, 'refund_attempt_provider_refund_unique');
      try {
        await deliver(s.first, s.txn, { eventId: ev }).expect(500);
        expect(await status(s.first)).toBe('failed');
        expect(await exceptionsOf(s.first)).toEqual([]);
        expect(await webhookOf(ev)).toMatchObject({ state: 'failed', outcome: 'transient_error' });
      } finally {
        await removeUnique();
      }
      await deliver(s.first, s.txn, { eventId: ev }).expect(200);
      expect(await status(s.first)).toBe('discrepancy');
      expect(await exceptionsOf(s.first)).toEqual([]);
    });

    it('L10 the named index collision without a competing attempt the database accepts propagates too (the backstop never invents a competitor)', async () => {
      const s = await scenario('none');
      await injectUnique(s.first, 'refund_attempt_one_effective');
      try {
        await deliver(s.first, s.txn).expect(500);
        expect(await status(s.first)).toBe('failed');
        expect(await exceptionsOf(s.first)).toEqual([]);
        expect(await auditsOf(s.first)).toEqual([]);
      } finally {
        await removeUnique();
      }
    });
  });

  describe('malformed, forged and foreign evidence', () => {
    it('L11 a forged signature and a malformed refund report write nothing: no fact, no exception', async () => {
      const s = await scenario('submitted');
      expect((await deliver(s.first, s.txn, { signature: 'f'.repeat(64) })).status).toBe(401);
      await deliver(s.first, s.txn, { body: { eventId: `t_${randomUUID()}`, type: 'refund.succeeded', reference: s.first, providerTransactionId: s.txn, currency: 'TND' } }).expect(200);
      expect(await factsOf(s.txn)).toEqual([]);
      expect(await exceptionsOf(s.first)).toEqual([]);
      expect(await status(s.first)).toBe('failed');
    });

    it('L12 foreign evidence: a provider reference already recorded for the competing attempt, reported against the failed one, is no exception (unchanged failure)', async () => {
      const s = await scenario('succeeded');
      const competingTxn = (await q(`SELECT "providerTxnId" FROM provider_transaction_fact WHERE "refundAttemptId" = $1 AND kind = 'refund'`, [s.competing]))[0]!.providerTxnId;
      const res = await deliver(s.first, competingTxn);
      expect(res.status).toBe(500); // as before RLSC-1: the observation is a recorded conflict of ANOTHER attempt's fact, not this attempt's own refund
      expect(await exceptionsOf(s.first)).toEqual([]);
      expect(await status(s.first)).toBe('failed');
    });
  });

  describe('database guards (0033)', () => {
    it('L13 the insert guard, the shape check, per-fact uniqueness and append-only', async () => {
      const s = await scenario('submitted');
      await deliver(s.first, s.txn).expect(200);
      const [fact] = await factsOf(s.txn);
      const other = await scenario('submitted'); // another payment
      const ins = (kind: string, attempt: string, factId: string, competing: string | null, extra = '') => admin.query(
        `INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "factId", "paymentId", "companyId", "captureFactId", "attemptStatus", "competingAttemptId"${extra ? ', "competingAttemptStatus"' : ''})
         SELECT $1, $2, $3, a."paymentId", a."companyId", a."captureFactId", a.status, $4::uuid${extra ? `, '${extra}'` : ''} FROM refund_attempt a WHERE a.id = $2`, [kind, attempt, factId, competing]);
      const refused = async (p: Promise<unknown>, constraint: string) => {
        const e = await p.then(() => null, (err) => err);
        expect(e, 'expected a refusal').not.toBeNull();
        expect(e.constraint).toBe(constraint);
      };
      await refused(ins('failed_attempt_refund_evidence', s.first, fact.id, s.competing), 'refund_safety_escalation_failed_evidence_once');
      // a competing attempt that is not effective (the failed attempt itself), of ANOTHER payment, or missing
      const ownFact = async (attemptId: string) => {
        await admin.query(`INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", "refundAttemptId", amount, currency, "liveMode", source)
          SELECT 'simulation', 'guard-' || a.id, 'refund', a."paymentId", a."capturedAttemptId", a.id, 9000, 'TND', false, 'status_check' FROM refund_attempt a WHERE a.id = $1`, [attemptId]);
        return (await factsOf(`guard-${attemptId}`))[0]!;
      };
      const fresh = await scenario('submitted');
      // Core V2 D-R3: a scenario drains the refund worker, which now decides a stored failed-attempt fact itself; so the last scenario runs
      // BEFORE this test's raw facts exist (nothing drains after them)
      const held = await scenario('authorized');
      const guardFact = await ownFact(fresh.first);
      await refused(ins('failed_attempt_refund_evidence', fresh.first, guardFact.id, fresh.first), 'refund_safety_escalation_evidence');
      await refused(ins('failed_attempt_refund_evidence', fresh.first, guardFact.id, other.competing), 'refund_safety_escalation_evidence');
      await refused(ins('failed_attempt_refund_evidence', fresh.first, guardFact.id, null), 'refund_safety_escalation_evidence');
      // a fact that is not the failed attempt's own; an attempt that is not failed
      await refused(ins('failed_attempt_refund_evidence', fresh.first, fact.id, fresh.competing), 'refund_safety_escalation_evidence');
      await refused(ins('failed_attempt_refund_evidence', fresh.competing!, guardFact.id, fresh.first), 'refund_safety_escalation_evidence');
      // the competing attempt belongs to this kind only: a dispatch hold the guard accepts is still refused with one
      const heldFact = await ownFact(held.first);
      await refused(ins('dispatch_held', held.competing!, heldFact.id, held.first), 'refund_safety_escalation_competing_shape');
      await ins('dispatch_held', held.competing!, heldFact.id, null); // the same hold without it: accepted (0032 unchanged)
      // an accepted row derives Company, payment, capture and both statuses, whatever the caller supplied
      await admin.query(
        `INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "factId", "paymentId", "companyId", "captureFactId", "attemptStatus", "competingAttemptId", "competingAttemptStatus")
         VALUES ('failed_attempt_refund_evidence', $1, $2, $3, $4, $5, 'succeeded', $6, 'failed')`,
        [fresh.first, guardFact.id, other.p, COMPANY2, guardFact.id, fresh.competing]);
      const [row] = await exceptionsOf(fresh.first);
      expect(row).toMatchObject({ paymentId: fresh.p, companyId: COMPANY, attemptStatus: 'failed', competingAttemptId: fresh.competing, competingAttemptStatus: 'submitted' });
      expect(row.captureFactId).toBe((await q(`SELECT "captureFactId" FROM refund_attempt WHERE id = $1`, [fresh.first]))[0]!.captureFactId);
      // append-only
      await expect(admin.query(`UPDATE refund_safety_escalation SET "competingAttemptStatus" = 'failed' WHERE id = $1`, [row.id])).rejects.toThrow();
      await expect(admin.query(`DELETE FROM refund_safety_escalation WHERE id = $1`, [row.id])).rejects.toThrow();
    });
  });

  describe('visibility: Billing (additive) and the Owner, isolated', () => {
    it('L14 Billing reads refund_failed_attempt_evidence for its own payments; each Owner sees only its Company; nothing else changes for Billing', async () => {
      const a = await scenario('submitted', COMPANY, OWNER);
      const b = await scenario('submitted', COMPANY2, OWNER2);
      await deliver(a.first, a.txn).expect(200);
      await deliver(b.first, b.txn).expect(200);
      const [ea] = await exceptionsOf(a.first);
      const [eb] = await exceptionsOf(b.first);
      const billingItems = (await itemsFor('billing', 'refund_failed_attempt_evidence')).filter((i) => [a.p, b.p].includes(i.paymentId));
      expect(billingItems.map((i) => [i.id, i.paymentId, i.amount, i.currency, i.detail.refundAttemptId, i.detail.refundCaseId, i.detail.attemptStatus, i.detail.competingAttemptId]).sort())
        .toEqual([[ea.id, a.p, 9000, 'TND', a.first, a.caseId, 'failed', a.competing], [eb.id, b.p, 9000, 'TND', b.first, b.caseId, 'failed', b.competing]].sort());
      const own1 = await itemsFor('owner-jwt', 'refund_failed_attempt_evidence');
      const own2 = await itemsFor('owner2-jwt', 'refund_failed_attempt_evidence');
      expect(own1.map((i) => i.id)).toContain(ea.id);
      expect(own1.map((i) => i.id)).not.toContain(eb.id);
      expect(own2.map((i) => i.id)).toEqual([eb.id]);
      // the Owner's refund-safety queue lists it too, with the competing attempt
      expect((await itemsFor('owner-jwt', 'refund_safety_escalation')).find((i) => i.id === ea.id)?.detail).toMatchObject({
        kind: 'failed_attempt_refund_evidence', attemptStatus: 'failed', competingAttemptId: a.competing, competingAttemptStatus: 'submitted' });
      expect((await itemsFor('owner2-jwt', 'refund_safety_escalation')).map((i) => i.id)).not.toContain(ea.id);
      // the Owner-only kind is still refused to Billing
      await request(server()).get('/payment/reconciliation/items?kind=refund_safety_escalation').set('authorization', `Bearer ${billing.token}`).expect(400);
    });
  });

  describe('UNRESOLVED financial-safety risk, preserved and NOT approved (OD-RLSC-1 open)', () => {
    it('L15 S6c / R6C-4 allocation unchanged: the failed attempt\'s late fact completes the case while the competing refund is in flight; the competing success then over-returns', async () => {
      const s = await scenario('submitted');
      await deliver(s.first, s.txn).expect(200);
      await drain();
      // unchanged allocation: the late fact is allocated to the FAILED attempt's authorization and completes the refund case (one refund.case_completed)
      expect(await authorizationsOf(s.p)).toEqual([
        { refundAttemptId: s.first, allocated: 9000, completed: true }, { refundAttemptId: s.competing, allocated: 0, completed: false }]);
      expect((await outboxOf(s.p))['refund.case_completed']).toBe(1);
      expect(await status(s.competing!)).toBe('submitted'); // already sent to the provider: nothing in Core can stop it (the external race)
      await sim(`refunds/${s.competing}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      await drain();
      expect((await outboxOf(s.p))['refund.case_completed']).toBe(1); // no second completion
      const over = (await itemsFor('billing', 'over_return')).filter((i) => i.paymentId === s.p);
      expect(over.map((i) => i.amount)).toEqual([9000]);
      const balance = await balanceOf(s.p);
      expect(balance.currencies).toEqual([{ currency: 'TND', captured: 9000, refundedNet: 18000, chargebackNet: 0, netRetained: -9000 }]);
      // the exception stays listed: nothing resolves, releases or compensates it
      expect((await itemsFor('billing', 'refund_failed_attempt_evidence')).filter((i) => i.paymentId === s.p)).toHaveLength(1);
      expect(await status(s.first)).toBe('failed');
    });
  });
});

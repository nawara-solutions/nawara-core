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
 * Core V2 D-R3 (the Owner's D-R3 GO, 2026-11-23; migration 0035): a DIRECT refund fact whose own attempt is `failed` is never allocated before its
 * RLSC-1 evidence decision (the `failed_attempt_refund_evidence` escalation, or the move to `discrepancy`) is durably committed. Before D-R3 the
 * refund worker could allocate it (and complete the refund case) while the escalation transaction had failed or not yet run (OD-RLSC-1 probe P2).
 * The fact stays pending (never blocked, discarded or resolved), is retried with the lease's backoff, and is the Owner's
 * `refund_failed_attempt_evidence_pending` item meanwhile. Once the evidence commits, allocation, case completion, excess and balances are the
 * UNCHANGED S6c / R6C-4 ones (OD-RLSC-1, D-R1, D-R2 stay open: the overlap pinned below is NOT approved). Development and simulation only.
 */
describeWithEnv('Core V2 D-R3: a failed attempt\'s refund fact is allocated only after its RLSC-1 evidence is committed — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
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
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentdr3');
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

  // ---------------- D-R3 helpers ----------------
  const allocationsOf = async (paymentId: string) => q(
    `SELECT r."factId", r."refundAttemptId", r.intended::int, r.excess::int, r."allocatedAt", r.xmin::text::bigint AS xid
       FROM refund_allocation r WHERE r."paymentId" = $1 ORDER BY r."allocatedAt", r."factId"`, [paymentId]);
  const escalationOf = async (factId: string) => (await q(
    `SELECT id, "escalatedAt", xmin::text::bigint AS xid FROM refund_safety_escalation WHERE "factId" = $1 AND kind = 'failed_attempt_refund_evidence'`, [factId]))[0];
  const leaseOf = async (factId: string) => (await q(`SELECT attempts, "lastFailure", "workAfter" FROM refund_fact_allocation_lease WHERE "factId" = $1`, [factId]))[0];
  const pendingItems = async (who: 'owner-jwt' | 'owner2-jwt', paymentId: string) =>
    (await itemsFor(who, 'refund_failed_attempt_evidence_pending')).filter((i) => i.paymentId === paymentId);
  const injectEscalationFailure = async () => {
    await admin.query(`CREATE OR REPLACE FUNCTION dr3_fail_escalation() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind = 'failed_attempt_refund_evidence' THEN RAISE EXCEPTION 'injected escalation failure'; END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER zz_dr3_fail_escalation BEFORE INSERT ON refund_safety_escalation FOR EACH ROW EXECUTE FUNCTION dr3_fail_escalation()`);
  };
  const removeEscalationFailure = async () => {
    await admin.query(`DROP TRIGGER IF EXISTS zz_dr3_fail_escalation ON refund_safety_escalation`);
    await admin.query(`DROP FUNCTION IF EXISTS dr3_fail_escalation()`);
  };
  /** The late success of the failed first attempt, its escalation made to fail: the webhook answers 500 and the fact is durable, undecided. */
  const undecided = async (second: 'submitted' | 'succeeded' = 'submitted') => {
    const s = await scenario(second);
    if (second === 'succeeded') await drain();
    const ev = `t_${randomUUID()}`;
    await injectEscalationFailure();
    try {
      await deliver(s.first, s.txn, { eventId: ev }).expect(500);
    } finally {
      await removeEscalationFailure();
    }
    const fact = (await factsOf(s.txn))[0]!.id as string;
    return { ...s, ev, fact };
  };

  describe('the prerequisite: no allocation before the committed evidence', () => {
    it('R1 (P2) the escalation transaction rolls back: the fact is kept pending, the worker defers it (no allocation, no completion), the Owner sees it', async () => {
      const s = await undecided();
      expect(await escalationOf(s.fact)).toBeUndefined();
      expect(await status(s.first)).toBe('failed');
      for (let i = 0; i < 3; i++) await drain(); // two-instance-safe sweeps of the pending set, again and again
      await t2.app.get(RefundWorker).drainOnce();
      expect(await allocationsOf(s.p)).toEqual([]);
      expect((await outboxOf(s.p))['refund.case_completed']).toBeUndefined();
      expect(await authorizationsOf(s.p)).toEqual([
        { refundAttemptId: s.first, allocated: 0, completed: false }, { refundAttemptId: s.competing, allocated: 0, completed: false }]);
      expect(await leaseOf(s.fact)).toMatchObject({ lastFailure: 'failed_attempt_evidence_pending' });
      expect((await leaseOf(s.fact))!.attempts).toBe(3); // one per sweep whose backoff had passed
      // never blocked, discarded or resolved: the fact is unchanged and still pending; its money is in the balance as before
      expect(await q(`SELECT 1 FROM refund_fact_allocation_block WHERE "factId" = $1`, [s.fact])).toEqual([]);
      expect(await factsOf(s.txn)).toHaveLength(1);
      expect((await balanceOf(s.p)).currencies).toEqual([{ currency: 'TND', captured: 9000, refundedNet: 9000, chargebackNet: 0, netRetained: 0 }]);
      // visible and durable for the Owner of the payment's Company only
      const items = await pendingItems('owner-jwt', s.p);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: 'refund_failed_attempt_evidence_pending', factId: s.fact, amount: 9000, currency: 'TND',
        detail: { refundAttemptId: s.first, refundCaseId: s.caseId, attemptStatus: 'failed' } });
      expect(items[0]!.detail.allocationDeferrals).toBe(3);
      expect(await pendingItems('owner2-jwt', s.p)).toEqual([]);
      const producer = await request(server()).get('/payment/reconciliation/items?kind=refund_failed_attempt_evidence_pending&limit=200')
        .set('authorization', `Bearer ${billing.token}`);
      expect(producer.status).toBe(400); // an Owner-only kind is no producer kind (the same answer as a kind that does not exist)
    });

    it('R2 the evidence then commits (the retrier): the unchanged allocation follows in that request, strictly after the evidence; the item disappears', async () => {
      const s = await undecided();
      await drain();
      expect(await allocationsOf(s.p)).toEqual([]);
      expect((await retryPass(s.ev)).retried).toBe(1);
      expect(await webhookOf(s.ev)).toMatchObject({ state: 'processed', outcome: `failed_attempt_refund_evidence:${(await escalationOf(s.fact))!.id}` });
      const es = (await escalationOf(s.fact))!;
      const al = await allocationsOf(s.p);
      expect(al).toHaveLength(1);
      expect(al[0]).toMatchObject({ factId: s.fact, refundAttemptId: s.first, intended: 9000, excess: 0 });
      expect(Number(al[0]!.xid)).toBeGreaterThan(Number(es.xid));
      expect(new Date(al[0]!.allocatedAt).getTime()).toBeGreaterThanOrEqual(new Date(es.escalatedAt).getTime());
      expect((await outboxOf(s.p))['refund.case_completed']).toBe(1);
      expect(await pendingItems('owner-jwt', s.p)).toEqual([]);
      expect((await itemsFor('owner-jwt', 'refund_failed_attempt_evidence')).filter((i) => i.paymentId === s.p)).toHaveLength(1);
    });

    it('R3 restart: a new process (the other instance) never allocates the undecided fact on its own; the evidence still has to commit first', async () => {
      const s = await undecided();
      const w2 = t2.app.get(RefundWorker);
      w2.recoveryAfterMs = 0;
      await reset();
      await w2.drainOnce();
      expect(await allocationsOf(s.p)).toEqual([]);
      expect(await escalationOf(s.fact)).toBeUndefined();
      // the stored notification is the durable record of the decision still to make: the other instance's retrier completes it
      await q(`UPDATE refund_fact_allocation_lease SET "workAfter" = NULL WHERE "factId" = $1`, [s.fact]);
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL session_replication_role = replica');
        await c.query(`UPDATE webhook_event SET "receivedAt" = now() - interval '30 days' WHERE "providerEventId" = $1`, [s.ev]);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      expect((await t2.app.get(WebhookRetriever).drainOnce()).retried).toBe(1);
      expect(await escalationOf(s.fact)).toBeDefined();
      expect(await allocationsOf(s.p)).toHaveLength(1);
      expect((await outboxOf(s.p))['refund.case_completed']).toBe(1);
    });

    it('R4 no permanent starvation: after many deferrals (the lease at its one-hour backoff) the committed evidence is allocated at once', async () => {
      const s = await undecided();
      await q(`UPDATE refund_fact_allocation_lease SET attempts = 40, "workAfter" = now() + interval '1 hour' WHERE "factId" = $1`, [s.fact]);
      expect((await retryPass(s.ev)).retried).toBe(1);
      expect(await allocationsOf(s.p)).toHaveLength(1);
      expect((await outboxOf(s.p))['refund.case_completed']).toBe(1);
      expect(await pendingItems('owner-jwt', s.p)).toEqual([]);
    });

    it('R5 the database backstop (0035): an allocation insert that skips the application check is refused (23514) until the evidence exists', async () => {
      const s = await undecided();
      const z = (await q(`SELECT id FROM refund_authorization WHERE "refundAttemptId" = $1`, [s.first]))[0]!.id;
      const insert = () => admin.query(
        `INSERT INTO refund_allocation ("factId", "refundAuthorizationId", "paymentId", "refundAttemptId", amount, currency, intended, excess)
         VALUES ($1, $2, $3, $4, 9000, 'TND', 9000, 0)`, [s.fact, z, s.p, s.first]);
      await expect(insert()).rejects.toMatchObject({ code: '23514', constraint: 'refund_allocation_failed_attempt_evidence' });
      expect(await allocationsOf(s.p)).toEqual([]);
      expect((await retryPass(s.ev)).retried).toBe(1); // the evidence commits; the application then allocates exactly once
      expect(await allocationsOf(s.p)).toHaveLength(1);
    });

    it('R6 NEGATIVE CONTROL, the application check alone: with the 0035 trigger dropped, the worker still defers the undecided fact', async () => {
      const s = await undecided();
      await admin.query(`DROP TRIGGER refund_allocation_06_failed_attempt_evidence ON refund_allocation`);
      try {
        await drain();
        expect(await allocationsOf(s.p)).toEqual([]);
        expect(await leaseOf(s.fact)).toMatchObject({ lastFailure: 'failed_attempt_evidence_pending' });
      } finally {
        await admin.query(`CREATE TRIGGER refund_allocation_06_failed_attempt_evidence BEFORE INSERT ON refund_allocation
          FOR EACH ROW EXECUTE FUNCTION refund_allocation_failed_attempt_evidence_guard()`);
      }
      expect((await retryPass(s.ev)).retried).toBe(1);
      expect(await allocationsOf(s.p)).toHaveLength(1);
    });
  });

  describe('unchanged once the evidence is committed: ledgers, excess, balances (OD-RLSC-1, D-R2 open: NOT approved behaviour)', () => {
    it('R7 (P5) competitor in flight: the late fact is allocated to the failed attempt\'s authorization after its evidence; the competitor\'s success is excess', async () => {
      const s = await scenario('submitted');
      await deliver(s.first, s.txn).expect(200);
      await drain();
      const fact = (await factsOf(s.txn))[0]!.id as string;
      const es = (await escalationOf(fact))!;
      const first = await allocationsOf(s.p);
      expect(first).toMatchObject([{ factId: fact, refundAttemptId: s.first, intended: 9000, excess: 0 }]);
      expect(Number(first[0]!.xid)).toBeGreaterThan(Number(es.xid));
      expect((await outboxOf(s.p))['refund.case_completed']).toBe(1);
      await sim(`refunds/${s.competing}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      await drain();
      expect((await allocationsOf(s.p)).map((r) => ({ to: r.refundAttemptId === s.first ? 'first' : 'competing', intended: r.intended, excess: r.excess })))
        .toEqual([{ to: 'first', intended: 9000, excess: 0 }, { to: 'competing', intended: 0, excess: 9000 }]);
      expect((await outboxOf(s.p))['refund.case_completed']).toBe(1);
      expect((await itemsFor('billing', 'over_return')).filter((i) => i.paymentId === s.p).map((i) => i.amount)).toEqual([9000]);
      expect((await balanceOf(s.p)).currencies).toEqual([{ currency: 'TND', captured: 9000, refundedNet: 18000, chargebackNet: 0, netRetained: -9000 }]);
      expect([await dispatches(s.first), await dispatches(s.competing!)]).toEqual([1, 1]);
    });

    it('R8 (P6) competitor already succeeded: the late fact waits for its evidence, then is all excess on the failed attempt\'s authorization', async () => {
      const s = await undecided('succeeded');
      await drain();
      expect((await allocationsOf(s.p)).map((r) => r.refundAttemptId)).toEqual([s.competing]); // only the competitor's own fact
      expect((await retryPass(s.ev)).retried).toBe(1);
      expect((await allocationsOf(s.p)).map((r) => ({ to: r.refundAttemptId === s.first ? 'first' : 'competing', intended: r.intended, excess: r.excess })))
        .toEqual([{ to: 'competing', intended: 9000, excess: 0 }, { to: 'first', intended: 0, excess: 9000 }]);
      expect((await outboxOf(s.p))['refund.case_completed']).toBe(1);
      expect((await itemsFor('billing', 'over_return')).filter((i) => i.paymentId === s.p).map((i) => i.amount)).toEqual([9000]);
      expect((await balanceOf(s.p)).currencies).toEqual([{ currency: 'TND', captured: 9000, refundedNet: 18000, chargebackNet: 0, netRetained: -9000 }]);
    });

    it('R9 NEGATIVE CONTROL, no competing attempt: the unchanged S6b path (discrepancy) allocates as before; nothing is pending', async () => {
      const s = await scenario('none');
      await deliver(s.first, s.txn).expect(200);
      expect(await status(s.first)).toBe('discrepancy');
      expect(await allocationsOf(s.p)).toHaveLength(1);
      expect(await pendingItems('owner-jwt', s.p)).toEqual([]);
    });

    it('R10 an in-flight attempt\'s own success is unchanged (not a failed attempt): allocated and completed at once', async () => {
      const p = await captured();
      const attempt = await authorizedAttempt(p, randomUUID());
      await drain();
      expect(await status(attempt)).toBe('submitted');
      await sim(`refunds/${attempt}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      expect(await status(attempt)).toBe('succeeded');
      expect(await allocationsOf(p)).toMatchObject([{ refundAttemptId: attempt, intended: 9000, excess: 0 }]);
      expect((await outboxOf(p))['refund.case_completed']).toBe(1);
    });
  });

  describe('duplicates and interleavings', () => {
    it('R11 duplicate deliveries (the same event, a new event for the same fact, two instances) while undecided, then decided: one fact, one escalation, one allocation', async () => {
      const s = await undecided();
      await injectEscalationFailure();
      try {
        await deliver(s.first, s.txn, { eventId: s.ev }).expect(500);
        await deliver(s.first, s.txn, { app: t2 }).expect(500);
      } finally {
        await removeEscalationFailure();
      }
      await drain();
      expect(await allocationsOf(s.p)).toEqual([]);
      const results = await Promise.all([deliver(s.first, s.txn), deliver(s.first, s.txn, { app: t2 }), deliver(s.first, s.txn, { eventId: s.ev })]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      await drain();
      expect(await factsOf(s.txn)).toHaveLength(1);
      expect(await exceptionsOf(s.first)).toHaveLength(1);
      expect(await allocationsOf(s.p)).toHaveLength(1);
      expect((await outboxOf(s.p))['refund.case_completed']).toBe(1);
    });

    it('R12 race: deliveries on two instances against both instances\' worker sweeps, 8 rounds: never an allocation before the evidence, one of each', async () => {
      const w2 = t2.app.get(RefundWorker);
      w2.recoveryAfterMs = 0;
      for (let i = 0; i < 8; i++) {
        const s = await scenario('submitted');
        await reset();
        const results = await Promise.allSettled([deliver(s.first, s.txn), deliver(s.first, s.txn, { app: t2 }), worker.drainOnce(), w2.drainOnce(),
          (async () => { await new Promise((r) => setTimeout(r, 3)); return worker.drainOnce(); })(),
          (async () => { await new Promise((r) => setTimeout(r, 7)); return w2.drainOnce(); })()]);
        expect(results.slice(0, 2).map((r) => (r.status === 'fulfilled' ? (r.value as { status: number }).status : 'rejected'))).toEqual([200, 200]);
        await drain();
        const fact = (await factsOf(s.txn))[0]!.id as string;
        const es = (await escalationOf(fact))!;
        const al = await allocationsOf(s.p);
        expect(al).toHaveLength(1);
        expect(Number(al[0]!.xid)).toBeGreaterThan(Number(es.xid)); // the allocation's transaction is later than the evidence's, every round
        expect(await exceptionsOf(s.first)).toHaveLength(1);
        expect((await outboxOf(s.p))['refund.case_completed']).toBe(1);
      }
    });

    it('R13 replacement eligibility is unchanged: while the fact is undecided the failed attempt stays failed, the in-flight competitor is untouched', async () => {
      const s = await undecided('submitted');
      await drain();
      expect(await status(s.first)).toBe('failed');
      expect(await status(s.competing!)).toBe('submitted');
      expect([await dispatches(s.first), await dispatches(s.competing!)]).toEqual([1, 1]); // nothing more is sent, released or retried
      expect((await q(`SELECT kind FROM refund_safety_escalation WHERE "paymentId" = $1`, [s.p]))).toEqual([]);
    });
  });
});

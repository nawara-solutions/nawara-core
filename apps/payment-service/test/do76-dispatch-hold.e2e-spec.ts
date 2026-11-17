import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import type { OwnerCompanyAuthority, VerifiedOwner } from '../src/disputes/owner-company.authority.js';
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
const SECRET = randomBytes(32).toString('hex');
type Row = Record<string, any>;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Core V2 DO-76 S1 (the Owner's D-76-1, D-76-2, D-76-4; migration 0032): no Core-originated refund is sent while refund evidence of the same capture
 * already exists, and each such case is escalated once, durably, Owner-visible and audited. Development and simulation only; real application,
 * PostgreSQL 16, the simulation provider and the fake Auth receipt server.
 *
 * The transactional boundary under test: `authorized` -> `dispatching` (the one step after which the provider can learn the attempt id) runs under the
 * payment's refund-dispatch advisory lock (exclusive) and its row lock; a refund fact writer holds the advisory lock shared, an association the row lock. The database
 * guard repeats the check under the same lock on its own. Evidence that arrives after `dispatching` keeps the S6b semantics (the external race).
 */
describeWithEnv('Core V2 DO-76 S1: refund dispatch hold and safety escalation — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
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

  /** A captured direct purchase of 9000 TND sold by COMPANY. */
  const captured = async () => {
    const p = (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send({
      paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
      seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER,
    }).expect(201)).body;
    const a = (await request(server()).post(`/payment/payments/${p.id}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({}).expect(201)).body;
    await sim(`payments/${p.id}/attempts/${a.id}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
    return p.id as string;
  };
  /** Billing's relay of an Owner receipt (PAY-07): the response promise and the attempt id. */
  const relay = (paymentId: string) => {
    const caseId = randomUUID();
    const r = auth.issue({ operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId, amount: 9000, currency: 'TND', reason: 'customer_request' }, OWNER);
    const attemptId = randomUUID();
    const res = request(server()).post(`/payment/payments/${paymentId}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
      .send({ refundAttemptId: attemptId, refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: r.secret });
    return { attemptId, caseId, res };
  };
  /** An attempt authorized by the request path (Auth consumed and answered), not yet seen by the worker. */
  const authorizedAttempt = async (paymentId: string) => {
    const { attemptId, res } = relay(paymentId);
    expect((await res.expect(201)).body.status).toBe('authorized');
    return attemptId;
  };
  /** A verified provider refund notification naming the attempt by its id (the idempotency key), through the real signed webhook. */
  const notify = (attemptId: string, txn: string, amount = 9000) => {
    const raw = Buffer.from(JSON.stringify({ eventId: `t_${randomUUID()}`, type: 'refund.succeeded', reference: attemptId, providerTransactionId: txn, amount, currency: 'TND' }));
    return request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json')
      .set('x-simulation-signature', createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw.toString('utf8')).expect(200);
  };
  const attempt = async (id: string) => (await admin.query(`SELECT status, "paymentId", "captureFactId", "capturedAttemptId", "providerRefundId" FROM refund_attempt WHERE id = $1`, [id])).rows[0];
  const dispatches = async (id: string) => Number((await admin.query(`SELECT count(*) FROM simulation_refund_dispatch WHERE "idempotencyKey" = $1`, [id])).rows[0].count);
  const escalations = async (id: string) => (await admin.query(
    `SELECT id, kind, "factId", "paymentId", "companyId", "captureFactId", "attemptStatus" FROM refund_safety_escalation WHERE "refundAttemptId" = $1 ORDER BY "escalatedAt", id`, [id])).rows;
  const escalationAudits = async (id: string) => (await admin.query(
    `SELECT payload FROM outbox WHERE name = 'audit.refund_safety.escalated' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", id`, [id])).rows.map((r) => r.payload);
  const factOf = async (txn: string) => (await admin.query(`SELECT id, "refundAttemptId" FROM provider_transaction_fact WHERE "providerTxnId" = $1 AND kind = 'refund'`, [txn])).rows;
  const authorizationOf = async (id: string) => (await admin.query(`SELECT "allocatedIntended"::int AS allocated, "completedAt" FROM refund_authorization WHERE "refundAttemptId" = $1`, [id])).rows[0];
  const reset = async () => {
    await admin.query(`UPDATE refund_attempt SET "workAfter" = NULL WHERE "workAfter" IS NOT NULL AND status NOT IN ('authorization_expired', 'authorization_refused', 'succeeded', 'discrepancy')`);
    await admin.query(`UPDATE refund_fact_allocation_lease SET "workAfter" = NULL`);
  };
  const drain = async (w: RefundWorker = worker) => {
    await reset();
    return w.drainOnce();
  };
  /** What `recordRefundFact` writes, by hand, inside a caller's open transaction (to hold it uncommitted at a chosen point). */
  const strayFactSql = `INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", "refundAttemptId", amount, currency, "liveMode", source)
    SELECT 'simulation', $2, 'refund', a."paymentId", a."capturedAttemptId", a.id, 9000, 'TND', false, 'status_check' FROM refund_attempt a WHERE a.id = $1 RETURNING id`;
  const itemsOf = async (bearer: string) => (await request(server()).get('/payment/admin/reconciliation-items?kind=refund_safety_escalation&limit=200')
    .set('authorization', `Bearer ${bearer}`).expect(200)).body.items as Row[];

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentdo76s1');
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
    t2 = await createTestApp(appOpts()); // a second Payment instance on the same database (multiple workers)
    worker = t.app.get(RefundWorker);
    worker2 = t2.app.get(RefundWorker);
    worker.recoveryAfterMs = 0;
    worker2.recoveryAfterMs = 0;
  });
  afterAll(async () => {
    await t?.app.close();
    await t2?.app.close();
    await auth?.close();
    await admin?.end();
    await db?.drop();
  });

  describe('the DO-76 sequence and its variants: no second Core-originated refund', () => {
    it('H1 the reproduced DO-76 sequence (stray evidence on a pending attempt, then a late authorization): never dispatched; both escalations once; audited', async () => {
      const p = await captured();
      auth.loseResponse.consume = 1; // Auth consumes, the answer is lost, and the lookup is unreachable during the request
      auth.unavailable.lookup = 10;
      const { attemptId, res } = relay(p);
      expect((await res.expect(503)).body.code).toBe('refund_authorization_unresolved');
      auth.unavailable.lookup = 0;
      const txn = `stray-${attemptId}`;
      await notify(attemptId, txn);
      const [stray] = await factOf(txn);
      // D-76-4: the no_authorization block is escalated at once, in its transaction
      expect((await escalations(attemptId)).map((e) => [e.kind, e.factId, e.attemptStatus])).toEqual([['refund_fact_without_authorization', stray.id, 'authorization_pending']]);

      await drain(); // AUTH-03 recovery: authorized now, with its authorization row (S2)
      expect((await attempt(attemptId)).status).toBe('authorized');
      expect(await authorizationOf(attemptId)).toMatchObject({ allocated: 0, completedAt: null });
      await drain(); // BEFORE S1 this pass dispatched the refund (simr_<id>): the second refund of DO-76
      expect((await attempt(attemptId)).status).toBe('authorized');
      expect(await dispatches(attemptId)).toBe(0);
      const all = await escalations(attemptId);
      expect(all.map((e) => [e.kind, e.factId, e.attemptStatus])).toEqual([
        ['refund_fact_without_authorization', stray.id, 'authorization_pending'], ['dispatch_held', stray.id, 'authorized']]);
      expect(all.every((e) => e.paymentId === p && e.companyId === COMPANY)).toBe(true);
      expect((await escalationAudits(attemptId)).map((x) => [x.changes.kind, x.changes.fact_id, x.changes.attempt_status, x.changes.escalation_id])).toEqual([
        ['refund_fact_without_authorization', stray.id, 'authorization_pending', all[0].id], ['dispatch_held', stray.id, 'authorized', all[1].id]]);

      // D-76-2: nothing releases it: further passes (leases expired), a redelivery of the stray evidence, and the other instance change nothing
      for (let i = 0; i < 3; i++) await drain();
      await drain(worker2);
      await notify(attemptId, txn);
      expect((await attempt(attemptId)).status).toBe('authorized');
      expect(await dispatches(attemptId)).toBe(0);
      expect(await escalations(attemptId)).toHaveLength(2);
      expect(await escalationAudits(attemptId)).toHaveLength(2);
      expect(await factOf(txn)).toHaveLength(1); // the original provider evidence, preserved once
      expect((await admin.query(`SELECT reason FROM refund_fact_allocation_block WHERE "factId" = $1`, [stray.id])).rows.map((r) => r.reason)).toEqual(['no_authorization']);
      expect(Number((await admin.query(`SELECT count(*) FROM refund_allocation WHERE "factId" = $1`, [stray.id])).rows[0].count)).toBe(0); // never allocated
    });

    it('H2 stray evidence on an AUTHORIZED attempt before its dispatch: allocated as today (fact-based), the attempt held, nothing sent', async () => {
      const p = await captured();
      const attemptId = await authorizedAttempt(p);
      const txn = `stray-auth-${attemptId}`;
      await notify(attemptId, txn);
      expect((await attempt(attemptId)).status).toBe('authorized'); // evidence only on an attempt not in flight (S6b, unchanged)
      expect(await authorizationOf(attemptId)).toMatchObject({ allocated: 9000 }); // allocation unchanged by S1 (R6C-4)
      await drain();
      await drain();
      expect((await attempt(attemptId)).status).toBe('authorized');
      expect(await dispatches(attemptId)).toBe(0);
      const [stray] = await factOf(txn);
      expect((await escalations(attemptId)).map((e) => [e.kind, e.factId])).toEqual([['dispatch_held', stray.id]]);
      expect(await escalationAudits(attemptId)).toHaveLength(1);
    });

    it('H3 negative control, the normal flow: an authorized refund with no prior evidence is dispatched once and succeeds; no escalation', async () => {
      const p = await captured();
      const attemptId = await authorizedAttempt(p);
      await drain();
      expect(await attempt(attemptId)).toMatchObject({ status: 'submitted', providerRefundId: `simr_${attemptId}` });
      await sim(`refunds/${attemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      expect((await attempt(attemptId)).status).toBe('succeeded');
      expect(await dispatches(attemptId)).toBe(1);
      expect(await escalations(attemptId)).toEqual([]);
      expect(await authorizationOf(attemptId)).toMatchObject({ allocated: 9000 });
    });

    it('H4 evidence of ANOTHER attempt on the same capture (a late success of a failed attempt) holds the next attempt: per capture, the frozen 0022 rule', async () => {
      const p = await captured();
      const first = await authorizedAttempt(p);
      await drain();
      await sim(`refunds/${first}/outcomes`, { commandId: cmd(), outcome: 'failed', failureCode: 'card_closed' }).expect(201);
      expect((await attempt(first)).status).toBe('failed');
      const second = await authorizedAttempt(p); // no evidence yet: admitted
      // the failed attempt's refund turns out to have happened. The fact is recorded first, in its own transaction (FC-1). `discrepancy` is impossible while
      // the second attempt is effective (`refund_attempt_one_effective`): since Core V2 RLSC-1 (0033) the failed attempt stays `failed`, the evidence is kept
      // as a `failed_attempt_refund_evidence` escalation and the webhook answers 200 (before RLSC-1: 500, retried until exhausted)
      const raw = Buffer.from(JSON.stringify({ eventId: `t_${randomUUID()}`, type: 'refund.succeeded', reference: first, providerTransactionId: `late-${first}`, amount: 9000, currency: 'TND' }));
      await request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json')
        .set('x-simulation-signature', createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw.toString('utf8')).expect(200);
      expect(await factOf(`late-${first}`)).toHaveLength(1);
      expect((await attempt(first)).status).toBe('failed');
      expect((await escalations(first)).map((e) => [e.kind, e.attemptStatus])).toEqual([['failed_attempt_refund_evidence', 'failed']]);
      await drain();
      expect((await attempt(second)).status).toBe('authorized');
      expect(await dispatches(second)).toBe(0);
      const [late] = await factOf(`late-${first}`);
      expect((await escalations(second)).map((e) => [e.kind, e.factId])).toEqual([['dispatch_held', late.id]]);
    });
  });

  describe('the transactional boundary: concurrency, multiple instances, failure and retry', () => {
    it('H5a evidence first: an uncommitted refund fact holding the refund-dispatch lock SHARED (as recordRefundFact does) makes the dispatch wait, then hold', async () => {
      const p = await captured();
      const attemptId = await authorizedAttempt(p);
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock_shared(refund_dispatch_lock_key($1))', [p]);
        await c.query(strayFactSql, [attemptId, `race-a-${attemptId}`]);
        await reset();
        const pass = worker.drainOnce();
        await pause(400);
        expect((await attempt(attemptId)).status).toBe('authorized'); // waiting on the lock, not dispatched on a stale read
        await c.query('COMMIT');
        await pass;
      } finally {
        c.release();
      }
      expect((await attempt(attemptId)).status).toBe('authorized');
      expect(await dispatches(attemptId)).toBe(0);
      expect((await escalations(attemptId)).map((e) => e.kind)).toEqual(['dispatch_held']);
    });

    it('H5b dispatch first: a refund notification arriving while the dispatch transition holds the refund-dispatch lock waits, and is then applied as today (the external race)', async () => {
      const p = await captured();
      const attemptId = await authorizedAttempt(p);
      const txn = `race-b-${attemptId}`;
      const c = await admin.connect();
      let delivered: Promise<unknown>;
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock(refund_dispatch_lock_key($1))', [p]); // what RefundWorker.startDispatch holds first
        await c.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1`, [attemptId]); // the 0032 guard: no evidence yet
        delivered = Promise.resolve(notify(attemptId, txn));
        await pause(400);
        expect(await factOf(txn)).toEqual([]); // the evidence writer waits for the dispatch transaction
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      await delivered!;
      // S6b, unchanged: an exact refund on an attempt in flight with no provider reference yet is its success. Whether the provider ALSO returns money
      // for the dispatch that follows is the provider's idempotency (the same key): the recorded external race, never visible to Payment beforehand
      expect((await attempt(attemptId)).status).toBe('succeeded');
      expect(await escalations(attemptId)).toEqual([]);
    });

    it('H5c the database guard alone closes the race: a raw dispatch waiting on an uncommitted refund fact is refused once the fact commits', async () => {
      const p = await captured();
      const attemptId = await authorizedAttempt(p);
      const c = await admin.connect();
      const d = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT pg_advisory_xact_lock_shared(refund_dispatch_lock_key($1))', [p]);
        await c.query(strayFactSql, [attemptId, `race-c-${attemptId}`]);
        const raw = d.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1`, [attemptId]).then(() => 'committed', (e) => e);
        await pause(400);
        await c.query('COMMIT');
        expect(await raw).toMatchObject({ code: '23514', constraint: 'refund_attempt_dispatch_hold' });
      } finally {
        c.release();
        d.release();
      }
      expect((await attempt(attemptId)).status).toBe('authorized');
      // and with the evidence already committed, a raw dispatch is refused at once
      await expect(admin.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1`, [attemptId])).rejects.toMatchObject({ constraint: 'refund_attempt_dispatch_hold' });
    });

    it('H5d negative control: a payment row lock held by other processing (allocation, disputes) never delays a refund fact; only a dispatch transition does', async () => {
      const p = await captured();
      const attemptId = await authorizedAttempt(p);
      const txn = `barrier-${attemptId}`;
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        await c.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [p]); // e.g. an allocation in progress (the certifications' order barrier)
        const delivered = Promise.resolve(notify(attemptId, txn)).then(() => 'delivered', () => 'delivered');
        const deadline = Date.now() + 10_000;
        while ((await factOf(txn)).length === 0 && Date.now() < deadline) await pause(100);
        expect(await factOf(txn)).toHaveLength(1); // FC-1: committed first, while the row lock is still held
        await c.query('ROLLBACK');
        await delivered;
      } finally {
        c.release();
      }
    });

    it('H6 two Payment instances race the same attempts: one dispatch for a normal refund; one hold and one audit intent for a held one', async () => {
      const normal = await authorizedAttempt(await captured());
      const heldP = await captured();
      const held = await authorizedAttempt(heldP);
      await notify(held, `two-${held}`);
      for (let i = 0; i < 3; i++) {
        await reset();
        await Promise.all([worker.drainOnce(), worker2.drainOnce()]);
      }
      expect((await attempt(normal)).status).toBe('submitted');
      expect(await dispatches(normal)).toBe(1);
      expect(await escalations(normal)).toEqual([]);
      expect((await attempt(held)).status).toBe('authorized');
      expect(await dispatches(held)).toBe(0);
      expect((await escalations(held)).map((e) => e.kind)).toEqual(['dispatch_held']);
      expect(await escalationAudits(held)).toHaveLength(1);
    });

    it('H7 a failure while holding (the audit write) rolls the whole hold back: nothing sent, nothing half-written; the next pass holds once', async () => {
      const p = await captured();
      const attemptId = await authorizedAttempt(p);
      await notify(attemptId, `fail-${attemptId}`);
      await admin.query(`CREATE FUNCTION do76_fail_escalation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.name = 'audit.refund_safety.escalated' THEN RAISE EXCEPTION 'injected outbox failure'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER zz_fail_escalation_audit BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION do76_fail_escalation_audit()`);
      try {
        await drain();
        expect((await attempt(attemptId)).status).toBe('authorized');
        expect(await dispatches(attemptId)).toBe(0);
        expect(await escalations(attemptId)).toEqual([]);
      } finally {
        await admin.query(`DROP TRIGGER zz_fail_escalation_audit ON outbox`);
        await admin.query(`DROP FUNCTION do76_fail_escalation_audit()`);
      }
      await drain();
      await drain();
      expect((await attempt(attemptId)).status).toBe('authorized');
      expect(await dispatches(attemptId)).toBe(0);
      expect((await escalations(attemptId)).map((e) => e.kind)).toEqual(['dispatch_held']);
      expect(await escalationAudits(attemptId)).toHaveLength(1);
    });
  });

  describe('the escalation record: database guards and Owner visibility', () => {
    it('H8 an escalation is only ever the evidence it names, derived from the attempt, append-only', async () => {
      const p = await captured();
      const attemptId = await authorizedAttempt(p); // no evidence
      const { captureFactId } = await attempt(attemptId);
      await expect(admin.query(`INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "factId", "paymentId", "companyId", "captureFactId", "attemptStatus")
        VALUES ('dispatch_held', $1, $2, $3, $4, $2, 'authorized')`, [attemptId, captureFactId, p, COMPANY])).rejects.toMatchObject({ constraint: 'refund_safety_escalation_evidence' });
      await expect(admin.query(`INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "factId", "paymentId", "companyId", "captureFactId", "attemptStatus")
        VALUES ('refund_fact_without_authorization', $1, $2, $3, $4, $2, 'authorized')`, [attemptId, captureFactId, p, COMPANY])).rejects.toMatchObject({ constraint: 'refund_safety_escalation_evidence' });
      // a hold is never made for an attempt already sent, even with evidence
      const sent = await authorizedAttempt(await captured());
      await drain();
      await notify(sent, `after-${sent}`);
      const [after] = await factOf(`after-${sent}`);
      await expect(admin.query(`INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "factId", "paymentId", "companyId", "captureFactId", "attemptStatus")
        VALUES ('dispatch_held', $1, $2, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'authorized')`, [sent, after.id])).rejects.toMatchObject({ constraint: 'refund_safety_escalation_evidence' });
      // append-only
      const [any] = (await admin.query(`SELECT id FROM refund_safety_escalation LIMIT 1`)).rows;
      await expect(admin.query(`UPDATE refund_safety_escalation SET kind = kind WHERE id = $1`, [any.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`DELETE FROM refund_safety_escalation WHERE id = $1`, [any.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`TRUNCATE refund_safety_escalation`)).rejects.toMatchObject({ code: '23514' });
    });

    it('H9 the Owner sees their own Company\'s escalations (PAY-12 `refund_safety_escalation`); another Owner none; the producer never', async () => {
      const mine = await itemsOf('owner-jwt');
      const rows = (await admin.query(`SELECT id FROM refund_safety_escalation`)).rows.map((r) => r.id).sort();
      expect(mine.map((i) => i.id).sort()).toEqual(rows);
      const held = mine.find((i) => i.detail.kind === 'dispatch_held')!;
      expect(held).toMatchObject({ kind: 'refund_safety_escalation', producer: 'billing-service', amount: 9000, currency: 'TND' });
      expect(held.detail).toMatchObject({ kind: 'dispatch_held', attemptStatus: 'authorized' });
      expect(await itemsOf('owner2-jwt')).toEqual([]);
      await request(server()).get('/payment/reconciliation/items?kind=refund_safety_escalation').set('authorization', `Bearer ${billing.token}`).expect(400);
    });
  });
});

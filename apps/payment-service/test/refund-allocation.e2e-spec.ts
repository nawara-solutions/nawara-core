import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { RefundAllocationService } from '../src/refunds/refund-allocation.service.js';
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
 * Core V2 S6c refund allocation and financial completion (register PAY-07, PAY-08, EVT-02; S0 FC-1, FC-2, FC-3, DB-17, V-2, V-3; the Owner's
 * R6C-1 to R6C-12) through the REAL application on real PostgreSQL 16, on the simulation provider. Provider refund evidence reaches Payment
 * only through the signed webhook pipeline (the harness's notifications, or notifications signed here with the operator's secret for the
 * shapes the harness does not produce: several distinct refund transactions for one attempt, another currency). Development and simulation only.
 */
describeWithEnv('refund allocation and completion (Core V2 S6c) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
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

  const createPayment = async () => (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send({
    paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
    seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER,
  }).expect(201)).body;
  const sim = (path: string, send: Row, token = harness.token) => request(server()).post(`/payment/simulation/${path}`).set('authorization', `Bearer ${token}`).send(send);
  /** A captured payment, an authorized refund attempt for it, dispatched to the simulated provider (submitted). */
  const dispatched = async () => {
    const p = await createPayment();
    const a = (await request(server()).post(`/payment/payments/${p.id}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({}).expect(201)).body;
    await sim(`payments/${p.id}/attempts/${a.id}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
    const caseId = randomUUID();
    const r = auth.issue({ operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId: p.id, amount: 9000, currency: 'TND', reason: 'customer_request' }, OWNER);
    const attemptId = randomUUID();
    await request(server()).post(`/payment/payments/${p.id}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
      .send({ refundAttemptId: attemptId, refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: r.secret }).expect(201);
    await drain();
    expect((await admin.query(`SELECT status FROM refund_attempt WHERE id = $1`, [attemptId])).rows[0].status).toBe('submitted');
    return { paymentId: p.id as string, caseId, attemptId };
  };
  /** A refund notification signed with the operator's secret, through the real webhook pipeline. */
  const notify = async (attemptId: string, o: { txn: string; amount: number; currency?: string; type?: 'refund.succeeded' | 'refund.failed' }) => {
    const raw = Buffer.from(JSON.stringify({ eventId: `t_${randomUUID()}`, type: o.type ?? 'refund.succeeded', reference: attemptId, providerTransactionId: o.txn, amount: o.amount, currency: o.currency ?? 'TND' }));
    return request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json')
      .set('x-simulation-signature', createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw.toString('utf8')).expect(200);
  };
  const authorization = async (attemptId: string) => (await admin.query(`SELECT * FROM refund_authorization WHERE "refundAttemptId" = $1`, [attemptId])).rows[0];
  const allocations = async (attemptId: string) => (await admin.query(
    `SELECT a.amount::int, a.intended::int, a.excess::int, f."providerTxnId" FROM refund_allocation a JOIN provider_transaction_fact f ON f.id = a."factId" WHERE a."refundAttemptId" = $1 ORDER BY a."allocatedAt", a.id`,
    [attemptId])).rows;
  const completions = async (caseId: string) => (await admin.query(`SELECT id, payload FROM outbox WHERE name = 'refund.case_completed' AND payload->>'refundCaseId' = $1`, [caseId])).rows;
  const audits = async (resourceId: string) => (await admin.query(`SELECT payload FROM outbox WHERE name = 'audit.refund_authorization.completed' AND payload->'resource'->>'id' = $1`, [resourceId])).rows;
  const read = async (paymentId: string, token = billing.token) => (await request(server()).get(`/payment/payments/${paymentId}/refunds`).set('authorization', `Bearer ${token}`).expect(200)).body;
  const newAttempt = (paymentId: string, caseId: string) => {
    const r = auth.issue({ operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId, amount: 9000, currency: 'TND', reason: 'customer_request' }, OWNER);
    return request(server()).post(`/payment/payments/${paymentId}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
      .send({ refundAttemptId: randomUUID(), refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: r.secret });
  };
  const drain = async () => {
    await admin.query(`UPDATE refund_attempt SET "workAfter" = NULL WHERE "workAfter" IS NOT NULL AND status NOT IN ('authorization_expired', 'authorization_refused', 'succeeded', 'discrepancy')`);
    await admin.query(`UPDATE refund_fact_allocation_lease SET "workAfter" = NULL`);
    return worker.drainOnce();
  };
  /** A test-only technical failure of every allocation (SQLSTATE 40001), installed and removed by the superuser fixture. */
  const breakAllocation = () => admin.query(`CREATE FUNCTION pg_temp_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '40001'; END $$;
    CREATE TRIGGER zz_injected_failure BEFORE INSERT ON refund_allocation FOR EACH ROW EXECUTE FUNCTION pg_temp_fail();`);
  const repairAllocation = () => admin.query(`DROP TRIGGER zz_injected_failure ON refund_allocation; DROP FUNCTION pg_temp_fail();`);

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentalloc');
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
    worker.recoveryAfterMs = 0;
  });
  afterAll(async () => {
    await t?.app.close();
    await auth?.close();
    await admin?.end();
    await db?.drop();
  });

  describe('allocation and completion (FC-2, FC-3, R6C-2 Option A, R6C-7, R6C-8)', () => {
    it('a verified full refund: one allocation, the authorization completed once, one refund.case_completed and its audit intent', async () => {
      const { paymentId, caseId, attemptId } = await dispatched();
      await sim(`refunds/${attemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      expect(await allocations(attemptId)).toEqual([{ amount: 9000, intended: 9000, excess: 0, providerTxnId: `simr_${attemptId}` }]);
      const z = await authorization(attemptId);
      expect(z).toMatchObject({ refundCaseId: caseId, paymentId, approvedAmount: '9000', allocatedIntended: '9000', receiptId: expect.any(String), approvedByUserId: OWNER });
      expect(z.completedAt).toBeInstanceOf(Date);
      const [ev] = await completions(caseId);
      expect(ev.payload).toMatchObject({ refundCaseId: caseId, refundAuthorizationId: z.id, refundAttemptId: attemptId, paymentId, producer: 'billing-service', approvedAmount: 9000,
        currency: 'TND', completedAt: z.completedAt.toISOString(), liveMode: false, purpose: 'direct_purchase' });
      expect(await audits(z.id)).toHaveLength(1);
      expect((await audits(z.id))[0].payload.changes).toEqual({ payment_id: paymentId, refund_case_id: caseId, refund_attempt_id: attemptId });
      // FC-3 / V-3: every new attempt for the case, or for the payment under another case, is refused
      expect((await newAttempt(paymentId, caseId).expect(409)).body.code).toBe('refund_case_completed');
      expect((await newAttempt(paymentId, randomUUID()).expect(409)).body.code).toBe('refund_case_completed');
      // a redelivered notification and a repeated worker pass change nothing
      await drain();
      expect(await allocations(attemptId)).toHaveLength(1);
      expect(await completions(caseId)).toHaveLength(1);
    });

    it('two distinct verified partial refunds reach the full amount cumulatively and complete once; the partial evidence stays a discrepancy', async () => {
      const { paymentId, caseId, attemptId } = await dispatched();
      await notify(attemptId, { txn: `part1-${attemptId}`, amount: 4000 });
      expect((await admin.query(`SELECT status FROM refund_attempt WHERE id = $1`, [attemptId])).rows[0].status).toBe('discrepancy'); // never a silent full refund
      expect(await allocations(attemptId)).toEqual([{ amount: 4000, intended: 4000, excess: 0, providerTxnId: `part1-${attemptId}` }]);
      expect((await authorization(attemptId)).completedAt).toBeNull();
      expect(await completions(caseId)).toEqual([]);
      await notify(attemptId, { txn: `part2-${attemptId}`, amount: 5000 });
      expect((await allocations(attemptId)).map((a) => [a.intended, a.excess])).toEqual([[4000, 0], [5000, 0]]);
      expect(await authorization(attemptId)).toMatchObject({ allocatedIntended: '9000' });
      expect(await completions(caseId)).toHaveLength(1);
      const r = await read(paymentId);
      expect(r.authorizations).toEqual([expect.objectContaining({ refundAttemptId: attemptId, approvedAmount: 9000, allocatedIntended: 9000, completedAt: expect.any(String),
        allocations: [expect.objectContaining({ amount: 4000, intended: 4000, excess: 0 }), expect.objectContaining({ amount: 5000, intended: 5000, excess: 0 })] })]);
      expect(r.attempts[0].status).toBe('discrepancy'); // still visible for reconciliation
    });

    it('an unexpected partial refund alone never completes the case; no new attempt is admissible for the payment', async () => {
      const { paymentId, caseId, attemptId } = await dispatched();
      await sim(`refunds/${attemptId}/outcomes`, { commandId: cmd(), outcome: 'amount_mismatch' }).expect(201);
      expect(await allocations(attemptId)).toEqual([{ amount: 8999, intended: 8999, excess: 0, providerTxnId: `simr_${attemptId}` }]);
      expect(await authorization(attemptId)).toMatchObject({ allocatedIntended: '8999', completedAt: null });
      expect(await completions(caseId)).toEqual([]);
      expect((await newAttempt(paymentId, caseId).expect(409)).body.code).toBe('refund_already_recorded');
    });

    it('excess (R6C-5): a distinct verified refund after completion is all excess; no second completion or event', async () => {
      const { caseId, attemptId } = await dispatched();
      await notify(attemptId, { txn: `full-${attemptId}`, amount: 9000 });
      const completedAt = (await authorization(attemptId)).completedAt;
      await notify(attemptId, { txn: `extra-${attemptId}`, amount: 1500 });
      await notify(attemptId, { txn: `over-${attemptId}`, amount: 9000 });
      expect((await allocations(attemptId)).map((a) => [a.amount, a.intended, a.excess])).toEqual([[9000, 9000, 0], [1500, 0, 1500], [9000, 0, 9000]]);
      expect((await authorization(attemptId)).completedAt).toEqual(completedAt); // set once
      expect(await completions(caseId)).toHaveLength(1);
      // one fact larger than the approved amount: the intended part completes, the rest is excess
      const second = await dispatched();
      await notify(second.attemptId, { txn: `big-${second.attemptId}`, amount: 12000 });
      expect((await allocations(second.attemptId)).map((a) => [a.amount, a.intended, a.excess])).toEqual([[12000, 9000, 3000]]);
      expect(await completions(second.caseId)).toHaveLength(1);
    });

    it('duplicate delivery of one fact (the same notification, the status read) is one allocation', async () => {
      const { caseId, attemptId } = await dispatched();
      const out = (await sim(`refunds/${attemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded', delivery: 'held' }).expect(201)).body;
      await Promise.all([sim(`refund-commands/${out.commandId}/deliver`, {}).expect(200), sim(`refund-commands/${out.commandId}/deliver`, {}).expect(200)]);
      worker.submittedCheckAfterMs = 0;
      try {
        await drain(); // the status read sees the same refund
      } finally {
        worker.submittedCheckAfterMs = 60_000;
      }
      expect(await allocations(attemptId)).toHaveLength(1);
      expect(await completions(caseId)).toHaveLength(1);
    });
  });

  describe('eligibility and recovery (R6C-2, R6C-6)', () => {
    it('a contested fact and a fact in another currency are blocked, never allocated; the facts themselves are unchanged', async () => {
      const a = await dispatched();
      await notify(a.attemptId, { txn: `c-${a.attemptId}`, amount: 4000 });
      await notify(a.attemptId, { txn: `c-${a.attemptId}`, amount: 3999 }); // the same provider refund, contradicted
      const b = await dispatched();
      await notify(b.attemptId, { txn: `eur-${b.attemptId}`, amount: 9000, currency: 'EUR' });
      expect((await admin.query(`SELECT reason FROM refund_fact_allocation_block bl JOIN provider_transaction_fact f ON f.id = bl."factId" WHERE f."refundAttemptId" = $1`, [b.attemptId])).rows)
        .toEqual([{ reason: 'currency_mismatch' }]);
      expect(await allocations(b.attemptId)).toEqual([]);
      expect((await read(b.paymentId)).unallocatedFacts).toEqual([expect.objectContaining({ amount: 9000, currency: 'EUR', state: 'blocked', blockedReason: 'currency_mismatch' })]);
      expect((await admin.query(`SELECT amount::int, currency FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [`eur-${b.attemptId}`])).rows).toEqual([{ amount: 9000, currency: 'EUR' }]);
      // the first observation was allocated before it was contested: the allocation stands, unchanged (immutable evidence)
      expect(await allocations(a.attemptId)).toEqual([{ amount: 4000, intended: 4000, excess: 0, providerTxnId: `c-${a.attemptId}` }]);
      // a fact contested BEFORE allocation is blocked: allocation broken, fact recorded, then contradicted, then the worker runs
      const c = await dispatched();
      await breakAllocation();
      try {
        await notify(c.attemptId, { txn: `k-${c.attemptId}`, amount: 9000 });
        await notify(c.attemptId, { txn: `k-${c.attemptId}`, amount: 8000 });
      } finally {
        await repairAllocation();
      }
      await drain();
      expect(await allocations(c.attemptId)).toEqual([]);
      expect((await read(c.paymentId)).unallocatedFacts).toEqual([expect.objectContaining({ state: 'blocked', blockedReason: 'contested' })]);
      expect(await completions(c.caseId)).toEqual([]);
    });

    it('a technical allocation failure keeps the fact pending with a bounded backoff; the worker completes it later, exactly once', async () => {
      const { paymentId, caseId, attemptId } = await dispatched();
      await breakAllocation();
      try {
        await sim(`refunds/${attemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
        expect((await admin.query(`SELECT status FROM refund_attempt WHERE id = $1`, [attemptId])).rows[0].status).toBe('succeeded'); // the fact and the attempt stand
        expect(await allocations(attemptId)).toEqual([]);
        const lease = (await admin.query(`SELECT attempts, "lastFailure", "workAfter" > now() AS later FROM refund_fact_allocation_lease l JOIN provider_transaction_fact f ON f.id = l."factId" WHERE f."refundAttemptId" = $1`, [attemptId])).rows[0];
        expect(lease).toEqual({ attempts: 1, lastFailure: 'pg_40001', later: true });
        await worker.drainOnce(); // inside the backoff: not retried
        expect((await admin.query(`SELECT attempts FROM refund_fact_allocation_lease l JOIN provider_transaction_fact f ON f.id = l."factId" WHERE f."refundAttemptId" = $1`, [attemptId])).rows[0].attempts).toBe(1);
        expect((await read(paymentId)).unallocatedFacts).toEqual([expect.objectContaining({ state: 'pending', blockedReason: null })]);
      } finally {
        await repairAllocation();
      }
      await drain();
      expect(await allocations(attemptId)).toHaveLength(1);
      expect(await completions(caseId)).toHaveLength(1);
    });

    it('concurrent allocation of one pending fact: exactly one allocation, the counter equals the sum, one completion', async () => {
      const { caseId, attemptId } = await dispatched();
      await breakAllocation();
      try {
        await sim(`refunds/${attemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      } finally {
        await repairAllocation();
      }
      const factId = (await admin.query(`SELECT id FROM provider_transaction_fact WHERE "refundAttemptId" = $1`, [attemptId])).rows[0].id;
      const svc = t.app.get(RefundAllocationService);
      const ctx = { actor: { type: 'system' as const, id: null }, cause: { type: 'refund_worker' as const, id: randomUUID() } };
      const results = await Promise.all(Array.from({ length: 8 }, () => svc.allocate(factId, ctx)));
      expect(results.filter((r) => r.kind === 'allocated')).toHaveLength(1);
      expect(results.filter((r) => r.kind === 'already_allocated')).toHaveLength(7);
      expect(await allocations(attemptId)).toHaveLength(1);
      expect(await completions(caseId)).toHaveLength(1);
      const z = await authorization(attemptId);
      expect(Number(z.allocatedIntended)).toBe(Number((await admin.query(`SELECT sum(intended) AS s FROM refund_allocation WHERE "refundAuthorizationId" = $1`, [z.id])).rows[0].s));
    });
  });

  describe('reads and database invariants', () => {
    it('PAY-08: the producer sees allocations and unallocated facts; the payer sees authorizations only; another producer gets the collapsed 404', async () => {
      const { paymentId, attemptId } = await dispatched();
      await sim(`refunds/${attemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      const producer = await read(paymentId);
      expect(producer.authorizations).toHaveLength(1);
      expect(producer.unallocatedFacts).toEqual([]);
      expect(JSON.stringify(producer)).not.toMatch(/receiptDigest|secret/);
      const payer = await read(paymentId, 'buyer-jwt');
      expect(payer.authorizations).toHaveLength(1);
      expect(payer.unallocatedFacts).toBeUndefined();
      await request(server()).get(`/payment/payments/${paymentId}/refunds`).set('authorization', `Bearer ${other.token}`).expect(404);
    });

    it('allocations are append-only; the counter equals their sum at commit; completedAt is set once; one completed authorization per case', async () => {
      const { paymentId, caseId, attemptId } = await dispatched();
      await notify(attemptId, { txn: `p-${attemptId}`, amount: 4000 });
      const z = await authorization(attemptId);
      const fail = (sql: string, params: unknown[] = []) => expect(admin.query(sql, params)).rejects.toThrow();
      await fail(`UPDATE refund_allocation SET intended = 1`);
      await fail(`DELETE FROM refund_allocation`);
      await fail(`UPDATE refund_authorization SET "allocatedIntended" = 5000 WHERE id = $1`, [z.id]); // the sum check, at commit
      await fail(`UPDATE refund_authorization SET "allocatedIntended" = 3000 WHERE id = $1`, [z.id]); // never decreases
      await fail(`UPDATE refund_authorization SET "approvedAmount" = 4000 WHERE id = $1`, [z.id]);
      await fail(`UPDATE refund_authorization SET "completedAt" = now() WHERE id = $1`, [z.id]); // only with the full amount
      await fail(`DELETE FROM refund_authorization WHERE id = $1`, [z.id]);
      await notify(attemptId, { txn: `q-${attemptId}`, amount: 5000 });
      await fail(`UPDATE refund_authorization SET "completedAt" = now() - interval '1 day' WHERE id = $1`, [z.id]);
      expect(await completions(caseId)).toHaveLength(1);
      // a completed case refuses a new attempt at the database too
      const zz = await authorization(attemptId);
      await fail(`INSERT INTO refund_attempt (id, "paymentId", producer, "refundCaseId", "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId", provider, "liveMode", "receiptDigest")
        SELECT gen_random_uuid(), "paymentId", producer, $2, "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId", provider, false, repeat('b', 64) FROM refund_attempt WHERE id = $1`,
        [attemptId, zz.refundCaseId]);
      expect(paymentId).toBe(zz.paymentId);
    });
  });
});

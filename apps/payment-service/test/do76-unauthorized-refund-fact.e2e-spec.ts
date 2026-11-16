import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
 * Core V2 DO-76 (register §7.2.6; OPEN, no solution approved): CHARACTERIZATION ONLY of a matched refund fact whose refund attempt has no
 * `refund_authorization` (`refund_fact_unallocated` / `no_authorization` at Billing). Nothing here changes Payment; it states, under the
 * approved behaviour, the invariant and every path that reaches the block, and how its cause is derived from rows that never change.
 *
 *   * I-76: a `refund_authorization` row exists for an attempt exactly when the attempt holds Auth's consumption (`receiptId`), written by
 *     `commitAuthorized` in the authorizing transition's own transaction (and by the 0018 backfill for earlier attempts); the attempt shape
 *     CHECK ties `receiptId` to every state from `authorized` on, and the worker dispatches only `authorized` (then `dispatching`) attempts.
 *     So Payment never sends a refund without an authorization, and a `no_authorization` block is ALWAYS verified provider evidence of a
 *     refund Payment did not send, naming an attempt that was not authorized at `blockedAt`.
 *   * The cause, derived (no new record): the attempt's state at `blockedAt`: `authorization_refused`, `authorization_expired`, still
 *     `authorization_pending`, or authorized only LATER (its authorization row created after `blockedAt`).
 *
 * Development and simulation only. F-29 is not involved (these are matched facts) and stays locked; no allocation or liability changes.
 */
describeWithEnv('DO-76 provider refund evidence on a never-authorized refund attempt (characterization) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let auth: FakeReceiptServer;
  let worker: RefundWorker;
  const billing = generateServiceToken();
  const harness = generateServiceToken();
  const identities: Record<string, AuthIdentity> = { 'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] } };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const server = () => t.app.getHttpServer();
  const cmd = () => `cmd-${randomUUID()}`;
  const key = () => `k-${randomUUID()}`;
  const sim = (path: string, send: Row) => request(server()).post(`/payment/simulation/${path}`).set('authorization', `Bearer ${harness.token}`).send(send);

  /** A captured direct purchase of 9000 TND. */
  const captured = async () => {
    const p = (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send({
      paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
      seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER,
    }).expect(201)).body;
    const a = (await request(server()).post(`/payment/payments/${p.id}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({}).expect(201)).body;
    await sim(`payments/${p.id}/attempts/${a.id}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
    return p.id as string;
  };
  /** Billing's relay of an Owner receipt (PAY-07), returning the response; the receipt is adjustable before the call. */
  const relay = (paymentId: string, prepare: (r: { expired: boolean }) => void = () => {}) => {
    const caseId = randomUUID();
    const r = auth.issue({ operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId, amount: 9000, currency: 'TND', reason: 'customer_request' }, OWNER);
    prepare(r);
    const attemptId = randomUUID();
    const res = request(server()).post(`/payment/payments/${paymentId}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
      .send({ refundAttemptId: attemptId, refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: r.secret });
    return { attemptId, caseId, res };
  };
  /** A verified provider refund notification naming the attempt by its id (the idempotency key), through the real signed webhook. */
  const notify = (attemptId: string, txn: string, amount = 9000) => {
    const raw = Buffer.from(JSON.stringify({ eventId: `t_${randomUUID()}`, type: 'refund.succeeded', reference: attemptId, providerTransactionId: txn, amount, currency: 'TND' }));
    return request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json')
      .set('x-simulation-signature', createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw.toString('utf8')).expect(200);
  };
  const attempt = async (id: string) => (await admin.query(`SELECT status, "receiptId", "authorizationRefusal" FROM refund_attempt WHERE id = $1`, [id])).rows[0];
  const authorizationOf = async (id: string) => (await admin.query(`SELECT id, "createdAt", "allocatedIntended"::int AS allocated, "completedAt" FROM refund_authorization WHERE "refundAttemptId" = $1`, [id])).rows;
  const factOf = async (txn: string) => (await admin.query(`SELECT id, "paymentId", "refundAttemptId", amount::int FROM provider_transaction_fact WHERE "providerTxnId" = $1 AND kind = 'refund'`, [txn])).rows;
  const blockOf = async (factId: string) => (await admin.query(`SELECT reason, "blockedAt" FROM refund_fact_allocation_block WHERE "factId" = $1`, [factId])).rows;
  const blockAudits = async (factId: string) => (await admin.query(`SELECT payload FROM outbox WHERE name = 'audit.refund_fact.allocation_blocked' AND payload->'resource'->>'id' = $1`, [factId])).rows;
  const allocations = async (factId: string) => Number((await admin.query(`SELECT count(*) FROM refund_allocation WHERE "factId" = $1`, [factId])).rows[0].count);
  const drain = async () => {
    await admin.query(`UPDATE refund_attempt SET "workAfter" = NULL WHERE "workAfter" IS NOT NULL AND status NOT IN ('authorization_expired', 'authorization_refused', 'succeeded', 'discrepancy')`);
    await admin.query(`UPDATE refund_fact_allocation_lease SET "workAfter" = NULL`);
    return worker.drainOnce();
  };
  /**
   * The derived cause of a `no_authorization` block (DO-76), from immutable rows only: the attempt's authorization row (created once, never
   * changed) compared with `blockedAt` (append-only), else the attempt's terminal refusal or its still-pending state.
   */
  const derivedCause = async (factId: string) => (await admin.query<{ cause: string }>(
    `SELECT CASE WHEN z.id IS NOT NULL AND z."createdAt" > b."blockedAt" THEN 'authorized_after_evidence'
                 WHEN z.id IS NOT NULL THEN 'authorized_before_evidence'
                 ELSE a.status END AS cause
       FROM refund_fact_allocation_block b JOIN provider_transaction_fact f ON f.id = b."factId" JOIN refund_attempt a ON a.id = f."refundAttemptId"
       LEFT JOIN refund_authorization z ON z."refundAttemptId" = a.id
      WHERE b."factId" = $1 AND b.reason = 'no_authorization'`, [factId])).rows[0]?.cause;
  /** Every observable consequence of one stray notification: one matched fact, one block, one intent, nothing allocated, the attempt unchanged. */
  const expectBlockedOnce = async (attemptId: string, paymentId: string, txn: string, status: string) => {
    const [f] = await factOf(txn);
    expect(f).toMatchObject({ paymentId, refundAttemptId: attemptId, amount: 9000 }); // a MATCHED fact: never F-29's unmatched-fact path
    expect((await blockOf(f.id)).map((b) => b.reason)).toEqual(['no_authorization']);
    expect((await blockAudits(f.id)).map((x) => x.payload.changes)).toEqual([{ payment_id: paymentId, refund_attempt_id: attemptId, reason: 'no_authorization', amount: 9000 }]);
    expect(await allocations(f.id)).toBe(0);
    expect((await attempt(attemptId)).status).toBe(status); // evidence only: an attempt not in flight never moves on refund evidence
    return f.id as string;
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentdo76');
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
    worker = t.app.get(RefundWorker);
    worker.recoveryAfterMs = 0;
  });
  afterAll(async () => {
    await t?.app.close();
    await auth?.close();
    await admin?.end();
    await db?.drop();
  });

  describe('every path that reaches the block, and its derived cause', () => {
    it('C1 authorization_expired: Auth answered receipt_expired; a later verified refund naming the attempt is one blocked fact, cause `authorization_expired`', async () => {
      const p = await captured();
      const { attemptId, res } = relay(p, (r) => (r.expired = true));
      expect((await res.expect(409)).body.code).toBe('refund_authorization_expired');
      expect(await attempt(attemptId)).toMatchObject({ status: 'authorization_expired', receiptId: null, authorizationRefusal: 'receipt_expired' });
      expect(await authorizationOf(attemptId)).toEqual([]);
      const txn = `do76-exp-${attemptId}`;
      await notify(attemptId, txn);
      const factId = await expectBlockedOnce(attemptId, p, txn, 'authorization_expired');
      expect(await derivedCause(factId)).toBe('authorization_expired');
    });

    it('C2 authorization_refused: an invalid receipt; same single block, cause `authorization_refused`', async () => {
      const p = await captured();
      const caseId = randomUUID();
      const r = auth.issue({ operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId: p, amount: 9000, currency: 'TND', reason: 'duplicate_charge' }, OWNER);
      const attemptId = randomUUID();
      await request(server()).post(`/payment/payments/${p}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
        .send({ refundAttemptId: attemptId, refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: r.secret }).expect(409);
      expect((await attempt(attemptId)).status).toBe('authorization_refused');
      const txn = `do76-ref-${attemptId}`;
      await notify(attemptId, txn);
      expect(await derivedCause(await expectBlockedOnce(attemptId, p, txn, 'authorization_refused'))).toBe('authorization_refused');
    });

    it('C3 still authorization_pending, then authorized LATER: the early fact stays blocked for good; cause `authorized_after_evidence`', async () => {
      const p = await captured();
      // Auth consumes but the answer is lost, and Auth's lookup is unreachable during the request: Payment keeps the intent pending
      auth.loseResponse.consume = 1;
      auth.unavailable.lookup = 10;
      const { attemptId, res } = relay(p);
      expect((await res.expect(503)).body.code).toBe('refund_authorization_unresolved');
      auth.unavailable.lookup = 0;
      expect(await attempt(attemptId)).toMatchObject({ status: 'authorization_pending', receiptId: null });
      const txn = `do76-early-${attemptId}`;
      await notify(attemptId, txn);
      const factId = await expectBlockedOnce(attemptId, p, txn, 'authorization_pending');
      expect(await derivedCause(factId)).toBe('authorization_pending');

      // the worker's AUTH-03 recovery finds Auth's consumption: the attempt is authorized now, with its authorization row
      await drain();
      expect((await attempt(attemptId)).receiptId).not.toBeNull();
      const [z] = await authorizationOf(attemptId);
      expect(z).toMatchObject({ allocated: 0, completedAt: null });
      // the block is append-only and permanent: a further allocation pass answers `blocked`, nothing is allocated against the new row.
      // The now-authorized attempt IS dispatched by the next pass (approved behaviour): the provider is asked for the refund with the same key,
      // so a stray refund and the real one may both exist for this payment (recorded, never netted; DO-76 stays OPEN).
      await drain();
      expect((await attempt(attemptId)).status).toBe('submitted');
      // a redelivery of the stray evidence is the same fact; on the now in-flight attempt it is a verified refund that is not this attempt's own
      // refund reference, so the attempt becomes `discrepancy` (S6b: never a silent full refund)
      await notify(attemptId, txn);
      expect((await attempt(attemptId)).status).toBe('discrepancy');
      expect(await factOf(txn)).toHaveLength(1);
      expect((await blockOf(factId)).map((b) => b.reason)).toEqual(['no_authorization']);
      expect(await blockAudits(factId)).toHaveLength(1);
      expect(await allocations(factId)).toBe(0);
      expect((await authorizationOf(attemptId))[0]).toMatchObject({ allocated: 0, completedAt: null });
      expect(await derivedCause(factId)).toBe('authorized_after_evidence');
    });

    it('C4 the stray fact also bars every later refund attempt for that payment (refund_attempt_no_refund_fact, by design): nothing is dispatched', async () => {
      const p = await captured();
      const { attemptId, res } = relay(p, (r) => (r.expired = true));
      await res.expect(409);
      await notify(attemptId, `do76-bar-${attemptId}`);
      const next = relay(p);
      const answer = await next.res;
      expect(answer.status).toBe(409);
      expect((await admin.query(`SELECT count(*)::int AS n FROM refund_attempt WHERE "paymentId" = $1 AND status NOT IN ('authorization_expired', 'authorization_refused')`, [p])).rows[0].n).toBe(0);
    });
  });

  describe('the invariant over this suite, and its negative controls', () => {
    it('I-76: an authorization row exists exactly for the attempts holding Auth\'s consumption; no dispatched state lacks one', async () => {
      expect((await admin.query(`SELECT count(*)::int AS n FROM refund_attempt a LEFT JOIN refund_authorization z ON z."refundAttemptId" = a.id
        WHERE (a."receiptId" IS NOT NULL) <> (z.id IS NOT NULL)`)).rows[0].n).toBe(0);
      expect((await admin.query(`SELECT count(*)::int AS n FROM refund_attempt a WHERE a.status IN ('dispatching', 'submitted', 'unknown', 'succeeded', 'failed', 'discrepancy')
        AND NOT EXISTS (SELECT 1 FROM refund_authorization z WHERE z."refundAttemptId" = a.id)`)).rows[0].n).toBe(0);
      // and every no_authorization block of this suite is a matched fact whose attempt was not authorized at blockedAt
      const blocks = (await admin.query(`SELECT b."factId" FROM refund_fact_allocation_block b WHERE b.reason = 'no_authorization'`)).rows;
      expect(blocks.length).toBe(4);
      for (const b of blocks) expect(['authorization_expired', 'authorization_refused', 'authorization_pending', 'authorized_after_evidence']).toContain(await derivedCause(b.factId));
    });

    it('NC: the database refuses an unauthorized attempt\'s skip to dispatch, and an `authorized` state without Auth\'s consumption', async () => {
      const p = await captured();
      auth.unavailable.consume = 1;
      const { attemptId, res } = relay(p);
      await res.expect(503);
      expect((await attempt(attemptId)).status).toBe('authorization_pending');
      await expect(admin.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1`, [attemptId])).rejects.toMatchObject({ code: '23514', constraint: 'refund_attempt_transition' });
      await expect(admin.query(`UPDATE refund_attempt SET status = 'authorized' WHERE id = $1`, [attemptId])).rejects.toMatchObject({ code: '23514', constraint: 'refund_attempt_authorization_shape' });
    });

    it('LIMITATION (recorded, not changed): the authorization row is coupled to `authorized` by the application\'s one transaction only; the database does not require it', async () => {
      const p = await captured();
      auth.unavailable.consume = 1;
      const { attemptId, res } = relay(p);
      await res.expect(503);
      const c = await admin.connect();
      try {
        await c.query('BEGIN');
        // a superuser fixture writing what no Payment code path writes: the consumption without its authorization row
        await c.query(`UPDATE refund_attempt SET status = 'authorized', "receiptId" = gen_random_uuid(), "approvedByUserId" = $2, "consumedAt" = now(), "authorizedAt" = now() WHERE id = $1`, [attemptId, OWNER]);
        expect((await c.query(`SELECT count(*)::int AS n FROM refund_authorization WHERE "refundAttemptId" = $1`, [attemptId])).rows[0].n).toBe(0);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
      expect((await attempt(attemptId)).status).toBe('authorization_pending');
    });
  });
});

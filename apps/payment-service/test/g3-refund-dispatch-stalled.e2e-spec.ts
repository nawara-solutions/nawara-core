import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { AUDIT_CATALOG } from '@nawara/audit-contract';
import type { OwnerCompanyAuthority, VerifiedOwner } from '../src/disputes/owner-company.authority.js';
import { RefundStalledDispatchSweep } from '../src/refunds/refund-stalled-dispatch.sweep.js';
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
const SECRET = 'g3-stalled-simulation-webhook-secret-0000000000000000';
const HOUR = 3600;
type Row = Record<string, any>;

/**
 * Core V2 G3 (DO-44; the Owner's G3 + G2 GO, package B; migration 0034): a refund attempt whose dispatch outcome stays unknown (`dispatching` or
 * `unknown`, never submitted) 72 hours after its authorization gets ONE escalation-only review item, Owner-visible (PAY-12) and audited, and one exit
 * observation once it leaves that state. It never holds the attempt, never stops the worker's same-key retry, and changes nothing else.
 * Real application, PostgreSQL 16, the simulation provider and the fake Auth receipt server. LABELLED FIXTURE: an attempt's immutable `authorizedAt`
 * is moved back with triggers off (session_replication_role) so the 72-hour threshold can be reached; its status moves are the real, guarded ones.
 */
describeWithEnv('Core V2 G3 (DO-44): stalled refund dispatch review — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let t2: TestApp;
  let admin: pg.Pool;
  let auth: FakeReceiptServer;
  let sweep: RefundStalledDispatchSweep;
  let sweep2: RefundStalledDispatchSweep;
  let worker: RefundWorker;
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

  /** A captured direct purchase of 9000 TND sold by COMPANY, and an attempt on it authorized through the real request path. */
  const authorizedAttempt = async (): Promise<{ paymentId: string; attemptId: string }> => {
    const p = (await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send({
      paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
      seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER,
    }).expect(201)).body;
    const a = (await request(server()).post(`/payment/payments/${p.id}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({}).expect(201)).body;
    await sim(`payments/${p.id}/attempts/${a.id}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
    const caseId = randomUUID();
    const r = auth.issue({ operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId: p.id, amount: 9000, currency: 'TND', reason: 'customer_request' }, OWNER);
    const attemptId = randomUUID();
    const res = await request(server()).post(`/payment/payments/${p.id}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
      .send({ refundAttemptId: attemptId, refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: r.secret });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('authorized');
    return { paymentId: p.id as string, attemptId };
  };
  /** The real, guarded status moves (no provider involved); then the labelled fixture: the authorization `ageH` hours ago. */
  const stuck = async (attemptId: string, status: 'dispatching' | 'unknown', ageH: number) => {
    await admin.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1`, [attemptId]);
    if (status === 'unknown') await admin.query(`UPDATE refund_attempt SET status = 'unknown' WHERE id = $1`, [attemptId]);
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(`UPDATE refund_attempt SET "authorizedAt" = now() - make_interval(secs => $2), "consumedAt" = now() - make_interval(secs => $2) WHERE id = $1`, [attemptId, ageH * HOUR]);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
  };
  const escalationsOf = async (attemptId: string) => (await admin.query(
    `SELECT * FROM refund_safety_escalation WHERE "refundAttemptId" = $1 AND kind = 'dispatch_stalled' ORDER BY "escalatedAt"`, [attemptId])).rows;
  const auditsOf = async (attemptId: string) => (await admin.query(
    `SELECT name, payload FROM outbox WHERE name LIKE 'audit.refund_safety.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", name`, [attemptId])).rows;
  const attemptRow = async (id: string) => (await admin.query(`SELECT * FROM refund_attempt WHERE id = $1`, [id])).rows[0];
  const itemsOf = async (bearer: string) => (await request(server()).get('/payment/admin/reconciliation-items?kind=refund_safety_escalation&limit=200')
    .set('authorization', `Bearer ${bearer}`).expect(200)).body.items as Row[];

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentg3stalled');
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
    sweep = t.app.get(RefundStalledDispatchSweep);
    sweep2 = t2.app.get(RefundStalledDispatchSweep);
    worker = t.app.get(RefundWorker);
  });
  afterAll(async () => {
    await t?.app.close();
    await t2?.app.close();
    await auth?.close();
    await admin?.end();
    await db?.drop();
  });

  describe('threshold, episode and idempotency', () => {
    it('escalates a dispatch stuck 72 hours after authorization, once, from two instances; never before, never once submitted, never authorization_pending', async () => {
      const due = await authorizedAttempt();
      await stuck(due.attemptId, 'dispatching', 73);
      const early = await authorizedAttempt();
      await stuck(early.attemptId, 'unknown', 71);
      const before = await attemptRow(due.attemptId);

      const [a, b] = await Promise.all([sweep.sweepOnce(), sweep2.sweepOnce()]);
      expect(a.escalated + b.escalated).toBe(1);
      await sweep.sweepOnce();
      const rows = await escalationsOf(due.attemptId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'dispatch_stalled', factId: null, attemptStatus: 'dispatching', companyId: COMPANY, paymentId: due.paymentId });
      expect(await escalationsOf(early.attemptId)).toEqual([]);
      expect(await attemptRow(due.attemptId)).toEqual(before); // the attempt is untouched

      const audits = await auditsOf(due.attemptId);
      expect(audits.map((x) => x.name)).toEqual(['audit.refund_safety.escalated']);
      expect(audits[0].payload.changes).toEqual({ escalation_id: rows[0].id, kind: 'dispatch_stalled', payment_id: due.paymentId, attempt_status: 'dispatching' }); // no fact_id
      expect(audits[0].payload.actor).toEqual({ type: 'system', id: 'payment_refund_worker' });
      expect(AUDIT_CATALOG.get('refund_safety.escalated')!.category).toBe('commercial');

      // an attempt still waiting for Auth (authorization_pending) is S6h's 15-minute item, never a dispatch_stalled escalation
      const pending = (await admin.query(`SELECT id FROM refund_attempt WHERE status = 'authorization_pending'`)).rows.map((r) => r.id);
      for (const id of pending) expect(await escalationsOf(id)).toEqual([]);
    });

    it('an unknown attempt is escalated, and the worker\'s same-key retry is NOT held; its exit is observed once, the escalation unchanged', async () => {
      const u = await authorizedAttempt();
      await stuck(u.attemptId, 'unknown', 80);
      await sweep.sweepOnce();
      const [esc] = await escalationsOf(u.attemptId);
      expect(esc).toMatchObject({ attemptStatus: 'unknown' });
      await sweep.sweepOnce();
      expect((await admin.query(`SELECT count(*)::int AS n FROM refund_safety_escalation_exit WHERE "escalationId" = $1`, [esc.id])).rows[0].n).toBe(0); // still stuck

      // the worker keeps its R6B-4 behaviour: it reads the provider and sends again with the same key; nothing here holds it
      const dispatchesBefore = Number((await admin.query(`SELECT count(*) FROM simulation_refund_dispatch WHERE "idempotencyKey" = $1`, [u.attemptId])).rows[0].count);
      await admin.query(`UPDATE refund_attempt SET "workAfter" = NULL WHERE id = $1`, [u.attemptId]);
      await worker.drainOnce();
      const after = await attemptRow(u.attemptId);
      const dispatchesAfter = Number((await admin.query(`SELECT count(*) FROM simulation_refund_dispatch WHERE "idempotencyKey" = $1`, [u.attemptId])).rows[0].count);
      expect(dispatchesAfter).toBe(dispatchesBefore + 1);
      expect(after.status).not.toBe('unknown');

      const escBefore = (await admin.query(`SELECT * FROM refund_safety_escalation WHERE id = $1`, [esc.id])).rows;
      await Promise.all([sweep.sweepOnce(), sweep2.sweepOnce()]);
      await sweep.sweepOnce();
      expect((await admin.query(`SELECT "exitedStatus" FROM refund_safety_escalation_exit WHERE "escalationId" = $1`, [esc.id])).rows).toEqual([{ exitedStatus: after.status }]);
      expect((await admin.query(`SELECT * FROM refund_safety_escalation WHERE id = $1`, [esc.id])).rows).toEqual(escBefore);
      expect((await auditsOf(u.attemptId)).map((x) => x.name)).toEqual(['audit.refund_safety.escalated', 'audit.refund_safety.state_exited']);
      expect((await auditsOf(u.attemptId))[1].payload.changes).toEqual({ escalation_id: esc.id, kind: 'dispatch_stalled', payment_id: u.paymentId, exited_status: after.status });
    });
  });

  describe('database guards', () => {
    it('refuses an escalation that is not due, nulls a forged fact, keeps the existing kinds\' fact required, refuses an early exit, stays append-only', async () => {
      const x = await authorizedAttempt();
      await stuck(x.attemptId, 'dispatching', 10);
      await expect(admin.query(`INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "paymentId", "companyId", "captureFactId", "attemptStatus")
        SELECT 'dispatch_stalled', a.id, a."paymentId", a."companyId", a."captureFactId", a.status FROM refund_attempt a WHERE a.id = $1`, [x.attemptId]))
        .rejects.toMatchObject({ code: '23514', constraint: 'refund_safety_escalation_not_due' });
      await stuck(x.attemptId, 'dispatching', 90);
      const anyFact = (await admin.query(`SELECT id FROM provider_transaction_fact LIMIT 1`)).rows[0].id;
      const row = (await admin.query(`INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "factId", "paymentId", "companyId", "captureFactId", "attemptStatus")
        SELECT 'dispatch_stalled', a.id, $2, a."paymentId", $3, a."captureFactId", 'succeeded' FROM refund_attempt a WHERE a.id = $1 RETURNING *`, [x.attemptId, anyFact, COMPANY2])).rows[0];
      expect(row).toMatchObject({ factId: null, companyId: COMPANY, attemptStatus: 'dispatching' }); // derived, never the caller's
      // the three existing kinds still need their evidence fact
      await expect(admin.query(`INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "paymentId", "companyId", "captureFactId", "attemptStatus")
        SELECT 'dispatch_held', a.id, a."paymentId", a."companyId", a."captureFactId", a.status FROM refund_attempt a WHERE a.id = $1`, [x.attemptId]))
        .rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`INSERT INTO refund_safety_escalation_exit ("escalationId", "exitedStatus") VALUES ($1, 'failed')`, [row.id]))
        .rejects.toMatchObject({ constraint: 'refund_safety_escalation_exit_not_exited' });
      await expect(admin.query(`UPDATE refund_safety_escalation SET "attemptStatus" = 'unknown' WHERE id = $1`, [row.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`DELETE FROM refund_safety_escalation WHERE id = $1`, [row.id])).rejects.toMatchObject({ code: '23514' });
      await admin.query(`UPDATE refund_attempt SET status = 'submitted', "providerRefundId" = $2, "submittedAt" = now() WHERE id = $1`, [x.attemptId, `sim-${randomUUID()}`]);
      const exit = (await admin.query(`INSERT INTO refund_safety_escalation_exit ("escalationId", "exitedStatus") VALUES ($1, 'forged') RETURNING *`, [row.id])).rows[0];
      expect(exit.exitedStatus).toBe('submitted');
      await expect(admin.query(`UPDATE refund_safety_escalation_exit SET "exitedStatus" = 'failed' WHERE "escalationId" = $1`, [row.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`DELETE FROM refund_safety_escalation_exit WHERE "escalationId" = $1`, [row.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`TRUNCATE refund_safety_escalation_exit`)).rejects.toMatchObject({ code: '23514' });
    });

    it('a failed audit intent writes no escalation; the next pass writes it once', async () => {
      const f = await authorizedAttempt();
      await stuck(f.attemptId, 'unknown', 75);
      await admin.query(`CREATE FUNCTION g3_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.name = 'audit.refund_safety.escalated' THEN RAISE EXCEPTION 'injected outbox failure'; END IF; RETURN NEW; END $$`);
      await admin.query(`CREATE TRIGGER zz_g3_fail_audit BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION g3_fail_audit()`);
      try {
        await sweep.sweepOnce();
        expect(await escalationsOf(f.attemptId)).toEqual([]);
      } finally {
        await admin.query(`DROP TRIGGER zz_g3_fail_audit ON outbox`);
        await admin.query(`DROP FUNCTION g3_fail_audit()`);
      }
      await sweep.sweepOnce();
      expect(await escalationsOf(f.attemptId)).toHaveLength(1);
      expect((await auditsOf(f.attemptId)).map((x) => x.name)).toEqual(['audit.refund_safety.escalated']);
    });
  });

  describe('Owner visibility (PAY-12, Owner only, Company-scoped)', () => {
    it('the seller Company\'s Owner sees the item with no figures and its authorization time and exit; another Company\'s Owner and Billing do not', async () => {
      const v = await authorizedAttempt();
      await stuck(v.attemptId, 'dispatching', 100);
      await sweep.sweepOnce();
      const [esc] = await escalationsOf(v.attemptId);
      const mine = (await itemsOf('owner-jwt')).filter((i) => i.id === esc.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ amount: null, currency: null, detail: { kind: 'dispatch_stalled', refundAttemptId: v.attemptId, attemptStatus: 'dispatching', exit: null } });
      expect(mine[0].detail.authorizedAt).toBeTruthy();
      expect((await itemsOf('owner2-jwt')).some((i) => i.id === esc.id)).toBe(false);
      // the producer (Billing) never reads this Owner-only kind
      const producer = await request(server()).get('/payment/reconciliation/items?kind=refund_safety_escalation').set('authorization', `Bearer ${billing.token}`);
      expect([400, 403, 404]).toContain(producer.status);
    });
  });
});

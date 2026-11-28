import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import type { ProviderCapabilities } from '../src/providers/provider.port.js';
import { SimulationPaymentProvider } from '../src/providers/simulation-provider.js';
import { RefundWorker } from '../src/refunds/refund-worker.js';
import { RefundStalledDispatchSweep } from '../src/refunds/refund-stalled-dispatch.sweep.js';
import type { OwnerCompanyAuthority, VerifiedOwner } from '../src/disputes/owner-company.authority.js';
import { TEST_PLATFORM, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { startFakeReceiptServer, type FakeReceiptServer } from './support/fake-receipts.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '2f1b8d6c-4e3a-4b7c-8d9e-0f1a2b3c4d5e';
const COMPANY = '5b0c2f4e-1d3a-4c6b-8e9f-0a1b2c3d4e5f';
const OWNER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const SECRET = 'dr1b-replacement-guard-simulation-webhook-secret-00000000';
const FINALITY_REF = { id: 'simulation-refund-failure-finality', version: 1 };
const CONTRACT_REF = { id: 'simulation-refund-contract', version: 1 };
type Row = Record<string, any>;

/**
 * Core V2 D-R1C (the Owner's GO of 2026-11-24, Q5, Q6; migration 0038): when D-R1B refuses to dispatch an already-authorized attempt, ONE Owner-visible
 * `dispatch_blocked` escalation per attempt and cause, written in the refusing transaction with its audit intent; its exit observed once. ESCALATION ONLY:
 * nothing is sent, released, certified or reallocated. The D-R1B harness: two Payment instances as the RUNTIME database role, PostgreSQL 16, the
 * simulation provider, the fake Auth receipt server, Owner authority stand-ins for PAY-12. DEVELOPMENT AND SIMULATION ONLY. LABELLED FIXTURES as in D-R1B
 * (declarations switched on the running instances; `fixture` edits with triggers off, superuser only).
 */
describeWithEnv('Core V2 D-R1C: the dispatch-blocked escalation — real PostgreSQL, runtime role', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const suffix = randomBytes(4).toString('hex');
  const migRole = `dr1c_mig_${suffix}`;
  const appRole = `dr1c_app_${suffix}`;
  const dbName = `dr1c_payment_${suffix}`;
  const migPw = randomBytes(12).toString('hex');
  const appPw = randomBytes(12).toString('hex');
  const urlAs = (user?: string, pw?: string) => {
    const u = new URL(env.TEST_DATABASE_ADMIN_URL);
    u.pathname = `/${dbName}`;
    if (user) { u.username = user; u.password = pw!; }
    return u.toString();
  };
  let t: TestApp;
  let t2: TestApp;
  let admin: pg.Pool; // superuser: assertions and labelled fixtures
  let mig: pg.Pool; // the migrator (schema owner)
  let app: pg.Pool; // the runtime role, for direct SQL
  let auth: FakeReceiptServer;
  let worker: RefundWorker;
  let worker2: RefundWorker;
  const billing = generateServiceToken();
  const harness = generateServiceToken();
  const OWNER2 = '8e7d6c5b-4a3f-4e2d-9c1b-0a9f8e7d6c5b';
  const COMPANY2 = '6c1d3a5f-2e4b-4d7c-9f0a-1b2c3d4e5f60';
  const identities: Record<string, AuthIdentity> = {
    'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] },
    'owner-jwt': { id: OWNER, adminTier: 'owner', isActive: true, memberships: [] },
    'owner2-jwt': { id: OWNER2, adminTier: 'owner', isActive: true, memberships: [] },
  };
  const owners: Record<string, VerifiedOwner> = { 'owner-jwt': { userId: OWNER, companyId: COMPANY }, 'owner2-jwt': { userId: OWNER2, companyId: COMPANY2 } };
  const ownerAuthority: OwnerCompanyAuthority = { owner: async (bearer) => owners[bearer] ?? null };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const cmd = () => `cmd-${randomUUID()}`;
  const key = () => `k-${randomUUID()}`;
  const post = (x: TestApp, path: string, bearer: string, send: Row = {}) => request(x.app.getHttpServer()).post(path).set('authorization', `Bearer ${bearer}`).set('idempotency-key', key()).send(send);
  const sim = (path: string, send: Row) => post(t, `/payment/simulation/${path}`, harness.token, send);
  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
  const signed = (body: Row) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    return request(t.app.getHttpServer()).post('/payment/webhooks/simulation').set('content-type', 'application/json')
      .set('x-simulation-signature', createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw.toString('utf8'));
  };

  const captured = async (): Promise<{ paymentId: string; attemptId: string }> => {
    const p = (await post(t, '/payment/payments', billing.token, {
      paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
      seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER,
    }).expect(201)).body;
    const a = (await post(t, `/payment/payments/${p.id}/attempts`, 'buyer-jwt').expect(201)).body;
    await sim(`payments/${p.id}/attempts/${a.id}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
    return { paymentId: p.id, attemptId: a.id };
  };
  const requestRefund = async (paymentId: string, caseId: string, o: { x?: TestApp; captureFactId?: string } = {}) => {
    const body: Row = { refundAttemptId: randomUUID(), refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false };
    if (o.captureFactId) body.captureFactId = o.captureFactId;
    const r = auth.issue({ operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId, amount: 9000, currency: 'TND', reason: 'customer_request',
      legalOverride: false, ...(o.captureFactId ? { captureFactId: o.captureFactId } : {}) }, OWNER);
    const res = await post(o.x ?? t, `/payment/payments/${paymentId}/refunds`, billing.token, { ...body, receiptSecret: r.secret });
    return { res, attemptId: body.refundAttemptId as string };
  };
  const authorized = async () => {
    const { paymentId, attemptId: payAttempt } = await captured();
    const caseId = randomUUID();
    const { res, attemptId } = await requestRefund(paymentId, caseId);
    expect([res.status, res.body.status], JSON.stringify(res.body)).toEqual([201, 'authorized']);
    return { paymentId, payAttempt, attemptId, caseId };
  };
  const drain = async (attemptId: string, w: RefundWorker = worker) => {
    await admin.query(`UPDATE refund_attempt SET "workAfter" = NULL WHERE id = $1 AND status NOT IN ('authorization_expired', 'authorization_refused', 'succeeded', 'discrepancy')`, [attemptId]);
    await w.drainOnce();
  };
  const submitted = async () => {
    const x = await authorized();
    await drain(x.attemptId);
    expect((await row(x.attemptId)).status).toBe('submitted');
    return x;
  };
  const outcome = (attemptId: string, send: Row) => sim(`refunds/${attemptId}/outcomes`, { commandId: cmd(), ...send }).expect(201);
  const fail = (attemptId: string, failureCode = 'declined') => outcome(attemptId, { outcome: 'failed', failureCode });
  const row = (id: string) => one(`SELECT * FROM refund_attempt WHERE id = $1`, [id]);
  const finalityOf = async (id: string) => (await admin.query(`SELECT * FROM refund_attempt_failure_finality WHERE "refundAttemptId" = $1`, [id])).rows;
  const factsOf = async (id: string) => (await admin.query(`SELECT * FROM provider_transaction_fact WHERE "refundAttemptId" = $1 AND kind = 'refund' ORDER BY id`, [id])).rows;
  const received = async (id: string) => (await one(`SELECT received FROM simulation_refund_dispatch WHERE "idempotencyKey" = $1`, [id]))?.received ?? 0;
  /** How many DISTINCT refunds of the payment ever reached the provider. */
  const providerRefunds = async (paymentId: string) => Number((await one(`SELECT count(*) AS n FROM simulation_refund_dispatch d JOIN refund_attempt a ON a.id = d."idempotencyKey" WHERE a."paymentId" = $1`, [paymentId])).n);
  const mayStillPay = async (id: string) => (await one(`SELECT refund_attempt_may_still_pay($1, clock_timestamp()) AS v`, [id])).v as boolean;
  const declare = async <T>(refs: ProviderCapabilities['refundCapabilityCertificates'], fn: () => Promise<T>): Promise<T> => {
    const sims = [t.app.get(SimulationPaymentProvider), t2.app.get(SimulationPaymentProvider)];
    const saved = sims.map((s) => s.capabilities);
    sims.forEach((s, i) => Object.defineProperty(s, 'capabilities', { value: Object.freeze({ ...saved[i]!, refundCapabilityCertificates: refs }), configurable: true, writable: true }));
    try {
      return await fn();
    } finally {
      sims.forEach((s, i) => Object.defineProperty(s, 'capabilities', { value: saved[i], configurable: true, writable: true }));
    }
  };
  const certified = <T>(fn: () => Promise<T>): Promise<T> => declare([CONTRACT_REF, FINALITY_REF], fn);
  /** A submitted attempt failed under the simulation's declared certificate: it holds finality evidence. */
  const certifiedFailure = async () => {
    const x = await submitted();
    await certified(() => fail(x.attemptId));
    expect(await row(x.attemptId)).toMatchObject({ status: 'failed', failureCode: 'declined' });
    expect(await finalityOf(x.attemptId)).toHaveLength(1);
    return x;
  };
  /** LABELLED FIXTURE (superuser, triggers off): history or a tampered row. */
  const fixture = async (sql: string, params: unknown[] = []) => {
    const c = await admin.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL session_replication_role = replica');
      await c.query(sql, params);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  };
  const revoke = (q: { query: (s: string, p?: unknown[]) => Promise<pg.QueryResult> } = mig, ref = FINALITY_REF) => q.query(
    `INSERT INTO refund_capability_revocation ("certificateId", "certificateVersion", reason, "approvalRef") VALUES ($1, $2, 'test', 'test')`, [ref.id, ref.version]);
  const unrevoke = () => fixture('DELETE FROM refund_capability_revocation'); // LABELLED FIXTURE: a revocation is permanent
  /** A transaction left open by `fn`; `end` finishes it. */
  const opened = new Set<pg.PoolClient>();
  const closeAll = async () => { // a failed test never leaves a lock behind
    for (const c of opened) c.release(true);
    opened.clear();
    await unrevoke();
  };
  beforeAll(async () => {
    const root = new pg.Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
    await root.connect();
    try {
      await root.query(`CREATE ROLE ${migRole} LOGIN PASSWORD '${migPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
      await root.query(`CREATE ROLE ${appRole} LOGIN PASSWORD '${appPw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
      await root.query(`CREATE DATABASE ${dbName} OWNER ${migRole}`);
      await root.query(`REVOKE ALL ON DATABASE ${dbName} FROM PUBLIC`);
      await root.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${appRole}`);
    } finally {
      await root.end();
    }
    admin = new pg.Pool({ connectionString: urlAs(), max: 12 });
    admin.on('error', () => undefined);
    for (const s of ['REVOKE ALL ON SCHEMA public FROM PUBLIC', `ALTER SCHEMA public OWNER TO ${migRole}`, `GRANT USAGE ON SCHEMA public TO ${appRole}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migRole} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${migRole} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${appRole}`]) await admin.query(s);
    await runMigrations(urlAs(migRole, migPw), [kitMigrationsDir, paymentMigrationsDir]);
    mig = new pg.Pool({ connectionString: urlAs(migRole, migPw), max: 6 });
    app = new pg.Pool({ connectionString: urlAs(appRole, appPw), max: 8 });
    auth = await startFakeReceiptServer();
    const opts = () => ({
      databaseUrl: urlAs(appRole, appPw), authClient, ownerAuthority, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], refundWorker: false,
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token, PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET,
        PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE: '100000', PAYMENT_RATE_LIMIT_CREATE_PER_MINUTE: '100000', // one buyer, many payments; this file asserts no rate limit
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create', 'payment.reconciliation.read'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
      },
    });
    t = await createTestApp(opts());
    t2 = await createTestApp(opts());
    worker = t.app.get(RefundWorker);
    worker2 = t2.app.get(RefundWorker);
  });
  afterEach(() => closeAll());
  afterAll(async () => {
    await t?.app.close();
    await t2?.app.close();
    await auth?.close();
    await app?.end();
    await mig?.end();
    await admin?.end();
    const root = new pg.Client({ connectionString: env.TEST_DATABASE_ADMIN_URL });
    await root.connect();
    try {
      await root.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [dbName]);
      await root.query(`DROP DATABASE IF EXISTS ${dbName}`);
      await root.query(`DROP ROLE IF EXISTS ${appRole}`);
      await root.query(`DROP ROLE IF EXISTS ${migRole}`);
    } finally {
      await root.end();
    }
  });


  // ─────────────────────────────────────────────── D-R1C helpers
  const blockedOf = async (id: string) => (await admin.query(`SELECT * FROM refund_safety_escalation WHERE "refundAttemptId" = $1 AND kind = 'dispatch_blocked' ORDER BY "escalatedAt", id`, [id])).rows;
  const auditsOf = async (id: string, name = 'audit.refund_safety.escalated') => (await admin.query(
    `SELECT payload FROM outbox WHERE name = $2 AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt"`, [id, name])).rows.map((r) => r.payload);
  const exitsOf = async (escalationId: string) => (await admin.query(`SELECT * FROM refund_safety_escalation_exit WHERE "escalationId" = $1`, [escalationId])).rows;
  const sweep = (x: TestApp = t) => x.app.get(RefundStalledDispatchSweep).sweepOnce();
  const items = async (bearer: string) => (await request(t.app.getHttpServer()).get('/payment/admin/reconciliation-items?kind=refund_safety_escalation&limit=200')
    .set('authorization', `Bearer ${bearer}`).expect(200)).body.items as Row[];
  /** A certified failure and its replacement, authorized (permitted), not yet sent. */
  const replacementReady = async () => {
    const x = await certifiedFailure();
    const r = await certified(() => requestRefund(x.paymentId, x.caseId));
    expect([r.res.status, r.res.body.status]).toEqual([201, 'authorized']);
    return { ...x, replacement: r.attemptId };
  };
  /** The settling attempt captured twice; a capture-specific refund of the first capture failed under certified finality; the second capture's refund authorized. */
  const lastCaptureReady = async () => {
    const c = await captured();
    const txn = `sim_dup_${randomUUID()}`;
    await signed({ eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: c.attemptId, providerTransactionId: txn, amount: 9000, currency: 'TND' }).expect(200);
    const facts = (await admin.query(`SELECT id FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture' ORDER BY "observedAt", id`, [c.paymentId])).rows.map((f) => f.id as string);
    const first = await requestRefund(c.paymentId, randomUUID(), { captureFactId: facts[0]! });
    expect(first.res.status, JSON.stringify(first.res.body)).toBe(201);
    await drain(first.attemptId);
    await certified(() => fail(first.attemptId));
    const second = await certified(() => requestRefund(c.paymentId, randomUUID(), { captureFactId: facts[1]! }));
    expect([second.res.status, second.res.body.status], JSON.stringify(second.res.body)).toEqual([201, 'authorized']);
    return { paymentId: c.paymentId, first: first.attemptId, replacement: second.attemptId, facts };
  };
  /** A first notification under the failed attempt's exact provider reference naming no attempt (not aged: no fact): R3 `notification_pending`. */
  const pendingNotice = async (failedId: string) => {
    const reference = (await row(failedId)).providerRefundId as string;
    await signed({ eventId: `p_${randomUUID()}`, type: 'refund.succeeded', reference: `unknown-${randomUUID()}`, providerTransactionId: reference, amount: 9000, currency: 'TND' }).expect(200);
  };
  /** Each blocked pass: the escalation(s), nothing sent, the attempt still authorized. */
  const blockedPass = async (id: string, w: RefundWorker = worker) => {
    await drain(id, w);
    expect([(await row(id)).status, await received(id)]).toEqual(['authorized', 0]);
  };
  const expectEscalation = async (id: string, want: Row) => {
    const rows = await blockedOf(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'dispatch_blocked', factId: null, attemptStatus: 'authorized', ...want });
    const audits = await auditsOf(id);
    expect(audits).toHaveLength(1);
    expect(audits[0].changes).toEqual({ escalation_id: rows[0].id, kind: 'dispatch_blocked', payment_id: rows[0].paymentId, attempt_status: 'authorized' });
    expect(audits[0].actor).toEqual({ type: 'system', id: 'payment_refund_worker' });
    return rows[0];
  };
  /** A direct escalation insert as the runtime role, everything named by the caller (forgery attempts). */
  const forge = (attemptId: string, competing: string, cause: string, over: Row = {}) => app.query(
    `INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "factId", "paymentId", "companyId", "captureFactId", "attemptStatus", "competingAttemptId", "competingAttemptStatus",
       "blockingCause", "causeBasis", "blockingReason")
     SELECT 'dispatch_blocked', a.id, NULL, a."paymentId", $4, a."captureFactId", 'forged', $2, 'forged', $3, $5, 'forged' FROM refund_attempt a WHERE a.id = $1 RETURNING *`,
    [attemptId, competing, cause, over.companyId ?? COMPANY, over.causeBasis ?? 'producer_derived']);
  const BLOCKED = { code: '23514', constraint: 'refund_safety_escalation_dispatch_blocked' };

  describe('the six causes, each mapped from the D-R1B decision that refused the dispatch', () => {
    it('C1 prior_may_still_pay (database_verified): the blocker\'s certificate revoked after the replacement was authorized', async () => {
      const x = await replacementReady();
      await revoke();
      await certified(() => blockedPass(x.replacement));
      await expectEscalation(x.replacement, { blockingCause: 'prior_may_still_pay', causeBasis: 'database_verified', blockingReason: 'database_refused', // code still final; the database's mirror revoked it
        competingAttemptId: x.attemptId, competingAttemptStatus: 'failed', paymentId: x.paymentId, companyId: COMPANY });
    });

    it('C2 prior_registry_not_final (producer_derived): the adapter no longer declares the finality the database still holds', async () => {
      const x = await replacementReady();
      expect(await mayStillPay(x.attemptId)).toBe(false); // the database alone would allow it
      const errors = vi.spyOn(Logger.prototype, 'error');
      try {
        await blockedPass(x.replacement); // default: the modelled finality is not declared
        const lines = errors.mock.calls.map(([m]) => String(m)).filter((m) => m.includes(x.replacement));
        expect(lines.some((m) => m.startsWith('refund_dispatch_blocked ') && m.includes('basis=producer_derived'))).toBe(true);
        expect(lines.some((m) => m.startsWith('refund_dispatch_held '))).toBe(false); // Codex round 2: never reported as a DO-76 hold
      } finally {
        errors.mockRestore();
      }
      await expectEscalation(x.replacement, { blockingCause: 'prior_registry_not_final', causeBasis: 'producer_derived', blockingReason: 'not_granted',
        competingAttemptId: x.attemptId, competingAttemptStatus: 'failed' });
    });

    it('C3 prior_evidence_unresolved (producer_derived): a notification under the blocker\'s exact provider reference, not yet a fact', async () => {
      const x = await replacementReady();
      await pendingNotice(x.attemptId);
      expect(await mayStillPay(x.attemptId)).toBe(false);
      await certified(() => blockedPass(x.replacement));
      await expectEscalation(x.replacement, { blockingCause: 'prior_evidence_unresolved', causeBasis: 'producer_derived', blockingReason: 'evidence_notification_pending',
        competingAttemptId: x.attemptId });
    });

    it('C4 last_capture_may_still_pay (database_verified): the sibling capture\'s failed refund certificate revoked', async () => {
      const y = await lastCaptureReady();
      await revoke();
      await certified(() => blockedPass(y.replacement));
      await expectEscalation(y.replacement, { blockingCause: 'last_capture_may_still_pay', causeBasis: 'database_verified', competingAttemptId: y.first, competingAttemptStatus: 'failed' });
    });

    it('C5 last_capture_registry_not_final (producer_derived): the sibling\'s finality no longer declared', async () => {
      const y = await lastCaptureReady();
      await blockedPass(y.replacement);
      await expectEscalation(y.replacement, { blockingCause: 'last_capture_registry_not_final', causeBasis: 'producer_derived', blockingReason: 'not_granted', competingAttemptId: y.first });
    });

    it('C6 last_capture_evidence_unresolved (producer_derived): a pending notification under the sibling\'s reference', async () => {
      const y = await lastCaptureReady();
      await pendingNotice(y.first);
      await certified(() => blockedPass(y.replacement));
      await expectEscalation(y.replacement, { blockingCause: 'last_capture_evidence_unresolved', causeBasis: 'producer_derived', competingAttemptId: y.first });
    });

    it('C7 an attempt blocked first by a producer cause and later by a database cause holds one row per cause, never more', async () => {
      const x = await replacementReady();
      await blockedPass(x.replacement); // registry
      await revoke();
      await certified(() => blockedPass(x.replacement)); // database
      await blockedPass(x.replacement);
      await certified(() => blockedPass(x.replacement, worker2));
      expect((await blockedOf(x.replacement)).map((e) => e.blockingCause as string).sort((a, b) => a.localeCompare(b))).toEqual(['prior_may_still_pay', 'prior_registry_not_final']);
      expect(await auditsOf(x.replacement)).toHaveLength(2);
    });
  });

  describe('idempotence, concurrency and recovery', () => {
    it('I1 two workers race and repeated passes on both instances: one logical escalation and one audit intent; nothing ever sent', async () => {
      const x = await replacementReady();
      for (let i = 0; i < 4; i++) {
        await admin.query(`UPDATE refund_attempt SET "workAfter" = NULL WHERE id = $1`, [x.replacement]);
        await Promise.all([worker.drainOnce(), worker2.drainOnce()]);
      }
      await expectEscalation(x.replacement, { blockingCause: 'prior_registry_not_final' });
      expect(await received(x.replacement)).toBe(0);
      expect(await providerRefunds(x.paymentId)).toBe(1);
    });

    it('I2 the audit intent failing rolls the escalation back: still never sent, still authorized; the next pass records it once', async () => {
      const x = await replacementReady();
      await admin.query(`CREATE FUNCTION dr1c_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.name = 'audit.refund_safety.escalated' THEN RAISE EXCEPTION 'injected outbox failure'; END IF; RETURN NEW; END $$`);
      await admin.query(`GRANT EXECUTE ON FUNCTION dr1c_fail_audit() TO PUBLIC`);
      await admin.query(`CREATE TRIGGER zz_dr1c_fail BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION dr1c_fail_audit()`);
      try {
        await blockedPass(x.replacement);
        await blockedPass(x.replacement, worker2);
        expect(await blockedOf(x.replacement)).toEqual([]);
        // the 60-second recheck backoff rolled back with it: only the 5-second claim lease remains, so the next pass decides again soon
        expect(new Date((await row(x.replacement)).workAfter).getTime() - Date.now()).toBeLessThan(10_000);
      } finally {
        await admin.query(`DROP TRIGGER zz_dr1c_fail ON outbox`);
        await admin.query(`DROP FUNCTION dr1c_fail_audit()`);
      }
      await blockedPass(x.replacement, worker2); // the transient failure is over: recovered on the next safe pass
      await expectEscalation(x.replacement, { blockingCause: 'prior_registry_not_final' });
    });

    it('I3 a dispatch that is NOT refused writes no escalation (negative control); nor does an attempt whose replacement is simply in flight', async () => {
      const x = await replacementReady();
      await certified(() => drain(x.replacement));
      expect(await received(x.replacement)).toBe(1);
      expect(await blockedOf(x.replacement)).toEqual([]);
      const plain = await authorized();
      await drain(plain.attemptId);
      expect(await blockedOf(plain.attemptId)).toEqual([]);
    });

    it('I4 a held attempt keeps DO-76 exactly: dispatch_held only, never dispatch_blocked, never sent', async () => {
      const x = await replacementReady();
      await outcome(x.attemptId, { outcome: 'succeeded' }); // the failed attempt's refund turns out to have happened: evidence of the capture
      await certified(async () => {
        await drain(x.replacement);
        await drain(x.replacement, worker2);
      });
      const kinds = (await admin.query(`SELECT kind FROM refund_safety_escalation WHERE "refundAttemptId" = $1 ORDER BY kind`, [x.replacement])).rows.map((r) => r.kind);
      expect(kinds).toEqual(['dispatch_held']);
      expect(await received(x.replacement)).toBe(0);
      const [first] = await factsOf(x.attemptId);
      await expect(forge(x.replacement, x.attemptId, 'prior_may_still_pay')).rejects.toMatchObject(BLOCKED); // the guard refuses a held attempt too
      expect(first).toBeTruthy();
    });
  });

  describe('the database guard (forgery, scope, derivation)', () => {
    it('G1 forged causes, attempts, payments and blockers are refused; the database cause must be the database\'s own', async () => {
      const other = await certifiedFailure(); // made first: every drain processes every due attempt
      const live = await submitted();
      const x = await replacementReady(); // the database allows it (finality in force): only producer causes can hold
      await expect(forge(x.replacement, x.attemptId, 'prior_may_still_pay', { causeBasis: 'database_verified' })).rejects.toMatchObject(BLOCKED); // the database does not refuse
      await expect(forge(x.replacement, x.attemptId, 'last_capture_may_still_pay')).rejects.toMatchObject(BLOCKED);
      await expect(forge(x.replacement, x.attemptId, 'last_capture_registry_not_final')).rejects.toMatchObject(BLOCKED); // an ordinary attempt has no last-capture scope
      await expect(forge(x.replacement, x.replacement, 'prior_registry_not_final')).rejects.toMatchObject(BLOCKED); // itself
      await expect(forge(x.replacement, other.attemptId, 'prior_registry_not_final')).rejects.toMatchObject(BLOCKED); // another payment's attempt
      await expect(forge(x.replacement, live.attemptId, 'prior_evidence_unresolved')).rejects.toMatchObject(BLOCKED);
      await expect(forge(x.attemptId, x.replacement, 'prior_registry_not_final')).rejects.toMatchObject(BLOCKED); // the failed attempt is not authorized
      await expect(forge(x.replacement, x.attemptId, 'some_other_cause')).rejects.toMatchObject({ code: '23514' });
      await expect(app.query(`INSERT INTO refund_safety_escalation (kind, "refundAttemptId", "factId", "paymentId", "companyId", "captureFactId", "attemptStatus", "competingAttemptId", "competingAttemptStatus", "blockingCause", "causeBasis", "blockingReason")
        SELECT 'dispatch_blocked', a.id, NULL, a."paymentId", a."companyId", a."captureFactId", 'x', $2, 'x', 'prior_registry_not_final', 'producer_derived', 'Not A Code' FROM refund_attempt a WHERE a.id = $1`,
        [x.replacement, x.attemptId])).rejects.toMatchObject({ code: '23514', constraint: 'refund_safety_escalation_blocking_shape' });
      expect(await blockedOf(x.replacement)).toEqual([]);
      // a producer cause in scope is accepted, and everything the caller named is DERIVED again (Company, statuses, basis)
      const [e] = (await forge(x.replacement, x.attemptId, 'prior_registry_not_final', { companyId: COMPANY2, causeBasis: 'database_verified' })).rows;
      expect(e).toMatchObject({ companyId: COMPANY, attemptStatus: 'authorized', competingAttemptStatus: 'failed', causeBasis: 'producer_derived', paymentId: x.paymentId });
      await expect(forge(x.replacement, x.attemptId, 'prior_registry_not_final')).rejects.toMatchObject({ code: '23505' }); // once per attempt and cause
      for (const q of [app, mig]) {
        await expect(q.query(`UPDATE refund_safety_escalation SET "blockingReason" = 'x' WHERE id = $1`, [e.id])).rejects.toMatchObject({ code: '23514' });
        await expect(q.query(`DELETE FROM refund_safety_escalation WHERE id = $1`, [e.id])).rejects.toMatchObject({ code: expect.stringMatching(/^(23514|42501)$/) });
      }
    });

    it('G2 the database cause is checked exactly: accepted only while 0037 refuses with that cause and the blocker may still pay', async () => {
      const y = await lastCaptureReady();
      const x = await replacementReady();
      await revoke(); // in force for both: 0037 refuses x as prior and y as LAST CAPTURE, never as prior
      const [e] = (await forge(x.replacement, x.attemptId, 'prior_may_still_pay')).rows;
      expect(e).toMatchObject({ causeBasis: 'database_verified', competingAttemptStatus: 'failed' });
      await expect(forge(y.replacement, y.first, 'prior_may_still_pay')).rejects.toMatchObject(BLOCKED);
      expect((await forge(y.replacement, y.first, 'last_capture_may_still_pay')).rows[0]).toMatchObject({ causeBasis: 'database_verified' });
    });
    it('G3 each guard condition refuses on its own (mutation isolation): state, prior scope, exact database cause, the blocker\'s may-still-pay, the producer blocker\'s status', async () => {
      // state alone: a dispatched replacement (no longer authorized) with an in-scope failed blocker
      const s1 = await replacementReady();
      await certified(() => drain(s1.replacement));
      expect((await row(s1.replacement)).status).toBe('submitted');
      await expect(forge(s1.replacement, s1.attemptId, 'prior_registry_not_final')).rejects.toMatchObject(BLOCKED);
      // LABELLED FIXTURE (superuser, triggers off): on the second capture, B failed without finality, D refused, R authorized (as before 0037)
      const y = await lastCaptureReady();
      await revoke(); // A (the first capture's failed attempt) may still pay again
      const [B, D, R] = [randomUUID(), randomUUID(), randomUUID()];
      const raw = (id: string, status: string) => fixture(
        `INSERT INTO refund_attempt (id, "paymentId", producer, "refundCaseId", "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId", provider, "liveMode",
           "receiptDigest", "captureSpecific", status, "receiptId", "approvedByUserId", "consumedAt", "authorizedAt", "failureCode", "completedAt", "authorizationRefusal")
         SELECT $2, "paymentId", producer, gen_random_uuid(), "companyId", amount, currency, reason, "legalOverride", $3, "capturedAttemptId", provider, "liveMode", repeat('e', 64), true, $4,
           CASE WHEN $4 <> 'authorization_refused' THEN gen_random_uuid() END, CASE WHEN $4 <> 'authorization_refused' THEN $5::uuid END,
           CASE WHEN $4 <> 'authorization_refused' THEN now() END, CASE WHEN $4 <> 'authorization_refused' THEN now() END,
           CASE WHEN $4 = 'failed' THEN 'declined' END, CASE WHEN $4 <> 'authorized' THEN now() END, CASE WHEN $4 = 'authorization_refused' THEN 'receipt_invalid' END
           FROM refund_attempt WHERE id = $1`, [y.first, id, y.facts[1], status, OWNER]);
      await raw(B, 'failed');
      await raw(D, 'authorization_refused');
      await fixture(`UPDATE refund_attempt SET status = 'failed', "failureCode" = 'declined', "completedAt" = now() WHERE id = $1`, [y.replacement]); // out of the way
      await raw(R, 'authorized');
      expect(await mayStillPay(B)).toBe(true);
      expect(await mayStillPay(D)).toBe(false);
      expect((await one(`SELECT refund_attempt_replacement_refusal($1, "paymentId", "captureFactId", "captureSpecific", clock_timestamp()) AS r FROM refund_attempt WHERE id = $1`, [R])).r)
        .toBe('refund_attempt_prior_may_still_pay');
      await expect(forge(R, y.first, 'prior_registry_not_final')).rejects.toMatchObject(BLOCKED); // prior scope alone: A is on the OTHER capture
      await expect(forge(R, y.first, 'last_capture_may_still_pay')).rejects.toMatchObject(BLOCKED); // exact cause alone: A in scope and may pay, but 0037 says prior
      await expect(forge(R, D, 'prior_may_still_pay')).rejects.toMatchObject(BLOCKED); // the blocker's may-still-pay alone: D in scope, the refusal is prior, D cannot pay
      await expect(forge(R, D, 'prior_registry_not_final')).rejects.toMatchObject(BLOCKED); // the producer blocker's status alone: D in scope, not failed
      expect((await forge(R, B, 'prior_may_still_pay')).rows[0]).toMatchObject({ causeBasis: 'database_verified', competingAttemptStatus: 'failed' });
      expect((await forge(R, y.first, 'last_capture_registry_not_final')).rows[0]).toMatchObject({ causeBasis: 'producer_derived' });
    });
  });

  describe('the last-capture database cause names the failed blocker (Codex round 1)', () => {
    it('G4 an EFFECTIVE refund on the sibling capture is never accepted as the last-capture blocker; the failed one is', async () => {
      const y = await lastCaptureReady();
      await revoke(); // the first capture's failed refund may still pay: 0037 refuses y.replacement as LAST CAPTURE
      const S = randomUUID(); // LABELLED FIXTURE (superuser, triggers off): a submitted refund of the same sibling capture
      await fixture(
        `INSERT INTO refund_attempt (id, "paymentId", producer, "refundCaseId", "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId", provider, "liveMode",
           "receiptDigest", "captureSpecific", status, "receiptId", "approvedByUserId", "consumedAt", "authorizedAt", "providerRefundId", "submittedAt")
         SELECT $2::uuid, "paymentId", producer, gen_random_uuid(), "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId", provider, "liveMode", repeat('f', 64), true,
           'submitted', gen_random_uuid(), $3::uuid, now(), now(), 'sim-fixture-' || $2::text, now() FROM refund_attempt WHERE id = $1`, [y.first, S, OWNER]);
      expect(await mayStillPay(S)).toBe(true);
      expect((await one(`SELECT refund_attempt_replacement_refusal($1, "paymentId", "captureFactId", "captureSpecific", clock_timestamp()) AS r FROM refund_attempt WHERE id = $1`, [y.replacement])).r)
        .toBe('refund_attempt_last_capture_may_still_pay');
      await expect(forge(y.replacement, S, 'last_capture_may_still_pay')).rejects.toMatchObject(BLOCKED);
      expect((await forge(y.replacement, y.first, 'last_capture_may_still_pay')).rows[0]).toMatchObject({ causeBasis: 'database_verified', competingAttemptStatus: 'failed' });
    });
  });

  describe('Owner visibility and the exit', () => {
    it('V1 the seller Company\'s Owner sees the item with its cause, basis, reason and blocker; another Company\'s Owner never does; no resolution is claimed', async () => {
      const x = await replacementReady();
      await blockedPass(x.replacement);
      const [e] = await blockedOf(x.replacement);
      const mine = (await items('owner-jwt')).find((i) => i.id === e.id);
      expect(mine).toMatchObject({ amount: null, currency: null, detail: { kind: 'dispatch_blocked', refundAttemptId: x.replacement, attemptStatus: 'authorized',
        competingAttemptId: x.attemptId, competingAttemptStatus: 'failed', blockingCause: 'prior_registry_not_final', causeBasis: 'producer_derived', blockingReason: 'not_granted', exit: null } });
      expect(Object.keys(mine!.detail).sort()).toEqual(['attemptStatus', 'blockingCause', 'blockingReason', 'captureFactId', 'causeBasis', 'competingAttemptId', 'competingAttemptStatus',
        'exit', 'kind', 'refundAttemptId']);
      expect((await items('owner2-jwt')).some((i) => i.id === e.id)).toBe(false);
      await request(t.app.getHttpServer()).get('/payment/admin/reconciliation-items?kind=refund_safety_escalation').set('authorization', 'Bearer buyer-jwt').expect((r) => expect(r.status).not.toBe(200));
    });

    it('V2 the exit is observed once when the attempt leaves authorized, never while it is blocked; it claims no finality, settlement or release', async () => {
      const x = await replacementReady();
      await blockedPass(x.replacement);
      const [e] = await blockedOf(x.replacement);
      await sweep();
      expect(await exitsOf(e.id)).toEqual([]); // still authorized: no exit
      await expect(app.query(`INSERT INTO refund_safety_escalation_exit ("escalationId", "exitedStatus") VALUES ($1, '')`, [e.id])).rejects.toMatchObject({ constraint: 'refund_safety_escalation_exit_not_exited' });
      await certified(() => drain(x.replacement)); // the declaration is back: D-R1B permits it (nothing here released it)
      expect(await received(x.replacement)).toBe(1);
      await Promise.all([sweep(), sweep(t2)]);
      await sweep();
      const exits = await exitsOf(e.id);
      expect(exits).toHaveLength(1);
      expect(exits[0].exitedStatus).toBe('submitted');
      const audits = await auditsOf(x.replacement, 'audit.refund_safety.state_exited');
      expect(audits).toHaveLength(1);
      expect(audits[0].changes).toEqual({ escalation_id: e.id, kind: 'dispatch_blocked', payment_id: x.paymentId, exited_status: 'submitted' });
      expect((await items('owner-jwt')).find((i) => i.id === e.id)!.detail.exit).toMatchObject({ status: 'submitted' });
      expect(await blockedOf(x.replacement)).toEqual([e]); // the escalation itself never changes
    });
  });
});

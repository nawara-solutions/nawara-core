import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import type { ProviderCapabilities } from '../src/providers/provider.port.js';
import { SimulationPaymentProvider } from '../src/providers/simulation-provider.js';
import { RefundWorker } from '../src/refunds/refund-worker.js';
import { RefundDispatchResponseService } from '../src/refunds/refund-dispatch-response.service.js';
import type { OwnerCompanyAuthority, VerifiedOwner } from '../src/disputes/owner-company.authority.js';
import { TEST_PLATFORM, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { startFakeReceiptServer, type FakeReceiptServer } from './support/fake-receipts.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '2f1b8d6c-4e3a-4b7c-8d9e-0f1a2b3c4d5e';
const COMPANY = '5b0c2f4e-1d3a-4c6b-8e9f-0a1b2c3d4e5f';
const OWNER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const SECRET = 'dr1d-durable-dispatch-responses-simulation-secret-00000';
const FINALITY_REF = { id: 'simulation-refund-failure-finality', version: 1 };
const CONTRACT_REF = { id: 'simulation-refund-contract', version: 1 };
type Row = Record<string, any>;

/**
 * Core V2 D-R1D (OD-DR1-6; the Owner's conditional GO of 2026-11-28, Q1, Q2; migration 0039): every refund send is durable BEFORE the provider call,
 * the provider's answer is durable in its own transaction BEFORE the decision, and each answer is applied exactly once under the attempt lock. An
 * answer no decision applied is applied by recovery, which never calls the provider and never records finality. EVIDENCE ONLY: no new send, no
 * replacement eligibility, no release, no reallocation. The D-R1B/D-R1C harness: two Payment instances as the RUNTIME database role, the simulation
 * provider, the fake Auth receipt server, Owner authority stand-ins for PAY-12. DEVELOPMENT AND SIMULATION ONLY. LABELLED FIXTURES: injected database
 * failures (superuser triggers, always dropped), backdated times (superuser, triggers off) and adapter declarations switched on the running instances.
 */
describeWithEnv('Core V2 D-R1D: durable refund dispatch responses — real PostgreSQL, runtime role', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const suffix = randomBytes(4).toString('hex');
  const migRole = `dr1d_mig_${suffix}`;
  const appRole = `dr1d_app_${suffix}`;
  const dbName = `dr1d_payment_${suffix}`;
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
  const received = async (id: string) => (await one(`SELECT received FROM simulation_refund_dispatch WHERE "idempotencyKey" = $1`, [id]))?.received ?? 0;
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


  // ─────────────────────────────────────────────── D-R1D helpers
  const sendsOf = async (id: string) => (await admin.query(`SELECT * FROM refund_dispatch_send WHERE "refundAttemptId" = $1 ORDER BY "sendNumber"`, [id])).rows;
  const observationsOf = async (id: string) => (await admin.query(
    `SELECT o.*, s."sendNumber" FROM refund_dispatch_observation o JOIN refund_dispatch_send s ON s.id = o."sendId" WHERE o."refundAttemptId" = $1 ORDER BY s."sendNumber"`, [id])).rows;
  const applicationsOf = async (id: string) => (await admin.query(
    `SELECT p.* FROM refund_dispatch_application p JOIN refund_dispatch_observation o ON o.id = p."observationId" JOIN refund_dispatch_send s ON s.id = o."sendId"
      WHERE p."refundAttemptId" = $1 ORDER BY s."sendNumber"`, [id])).rows;
  const failedAudits = async (id: string) => Number((await one(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.refund_attempt.failed' AND payload->'resource'->>'id' = $1`, [id])).n);
  const plan = (paymentId: string, mode: 'accepted' | 'rejected' | 'ambiguous', failureCode?: string) =>
    sim(`payments/${paymentId}/refund-dispatch-plan`, { commandId: cmd(), mode, ...(failureCode ? { failureCode } : {}) }).expect(201);
  /** LABELLED FIXTURE: an injected database failure on one table (superuser trigger), always dropped. */
  const injected = async <T>(table: string, fn: () => Promise<T>, when = 'true'): Promise<T> => {
    const name = `dr1d_inject_${randomBytes(3).toString('hex')}`;
    await admin.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${when} THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$`);
    await admin.query(`CREATE TRIGGER zz_${name} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
    try {
      return await fn();
    } finally {
      await admin.query(`DROP TRIGGER IF EXISTS zz_${name} ON ${table}`);
      await admin.query(`DROP FUNCTION ${name}()`);
    }
  };
  /** Both workers' recovery window shortened (the compared times are immutable database times), restored after. */
  const recoveryWindow = async <T>(ms: number, fn: () => Promise<T>): Promise<T> => {
    const saved = [worker.responseRecoveryAfterMs, worker2.responseRecoveryAfterMs];
    worker.responseRecoveryAfterMs = ms;
    worker2.responseRecoveryAfterMs = ms;
    try {
      await new Promise((r) => setTimeout(r, ms + 20));
      return await fn();
    } finally {
      [worker.responseRecoveryAfterMs, worker2.responseRecoveryAfterMs] = saved;
    }
  };
  /** Every provider call on both instances counted (dispatches and status reads). */
  const providerCalls = async <T>(fn: () => Promise<T>): Promise<{ result: T; refunds: number; statusReads: number }> => {
    const sims = [t.app.get(SimulationPaymentProvider), t2.app.get(SimulationPaymentProvider)];
    const spies = sims.flatMap((s) => [vi.spyOn(s, 'refund'), vi.spyOn(s, 'fetchRefundStatus')]);
    try {
      const result = await fn();
      return { result, refunds: spies[0]!.mock.calls.length + spies[2]!.mock.calls.length, statusReads: spies[1]!.mock.calls.length + spies[3]!.mock.calls.length };
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  };
  /** An authorized attempt dispatched once whose decision transaction failed: its answer stored, not applied. */
  const storedUnapplied = async (mode: 'accepted' | 'rejected' | 'ambiguous' = 'accepted', wrap: <T>(fn: () => Promise<T>) => Promise<T> = (fn) => fn()) => {
    const x = await authorized();
    await plan(x.paymentId, mode, mode === 'rejected' ? 'declined' : undefined);
    await wrap(() => injected('refund_dispatch_application', () => drain(x.attemptId)));
    expect((await row(x.attemptId)).status).toBe('dispatching');
    expect(await observationsOf(x.attemptId)).toHaveLength(1);
    expect(await applicationsOf(x.attemptId)).toEqual([]);
    return x;
  };
  const ownerItems = async (bearer: string, kind: string) => (await request(t.app.getHttpServer()).get(`/payment/admin/reconciliation-items?kind=${kind}&limit=200`)
    .set('authorization', `Bearer ${bearer}`).expect(200)).body.items as Row[];
  /** LABELLED FIXTURE (superuser, triggers off): evidence times moved back past the Owner-visibility window. */
  const age = (table: 'refund_dispatch_send' | 'refund_dispatch_observation', column: 'createdAt' | 'observedAt', attemptId: string, minutes = 16) =>
    fixture(`UPDATE ${table} SET "${column}" = "${column}" - make_interval(mins => $2) WHERE "refundAttemptId" = $1`, [attemptId, minutes]);
  const rt = async (sql: string, params: unknown[] = []) => app.query(sql, params); // the runtime role
  const sqlState = (e: unknown) => ({ code: (e as { code?: string }).code, constraint: (e as { constraint?: string }).constraint });
  const refusedWith = async (p: Promise<unknown>) => { try { await p; } catch (e) { return sqlState(e); } return { code: 'accepted' }; };
  /** A runtime-role transaction: `fn` runs inside it; committed (and its deferred checks run) unless it throws. */
  const rtTx = async (fn: (c: pg.PoolClient) => Promise<void>) => {
    const c = await app.connect();
    try {
      await c.query('BEGIN');
      await fn(c);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };
  const finalityCert = async () => one(`SELECT id, version, fingerprint FROM refund_capability_certificate WHERE id = $1 AND version = $2`, [FINALITY_REF.id, FINALITY_REF.version]);
  /** A raw `dispatch_response` finality as the runtime role, the attempt failed with `code` and (optionally) the observation's application, in one transaction. */
  const rawFinality = async (attemptId: string, observationId: string | null, code: string, appliedBy: 'dispatch' | 'recovery' | null) => {
    const c = await finalityCert();
    return refusedWith(rtTx(async (q) => {
      await q.query(`INSERT INTO refund_attempt_failure_finality ("refundAttemptId", "paymentId", "captureFactId", provider, "idempotencyKey", observation, "observationSource",
          "failureCode", "certificateId", "certificateVersion", "certificateFingerprint", "recordedAt", "dispatchObservationId")
        SELECT a.id, a."paymentId", a."captureFactId", a.provider, a.id::text, 'dispatch_rejected', 'dispatch_response', $2, $3, $4, $5, now(), $6::uuid FROM refund_attempt a WHERE a.id = $1`,
        [attemptId, code, c.id, c.version, c.fingerprint, observationId]);
      const before = (await q.query(`SELECT status FROM refund_attempt WHERE id = $1`, [attemptId])).rows[0].status;
      await q.query(`UPDATE refund_attempt SET status = 'failed', "failureCode" = $2, "completedAt" = now() WHERE id = $1`, [attemptId, code]);
      if (appliedBy) {
        await q.query(`INSERT INTO refund_dispatch_application ("observationId", "refundAttemptId", effect, "attemptStatusBefore", "attemptStatusAfter", "appliedBy", "appliedAt")
          VALUES ($1, $2, 'transitioned', $3, 'failed', $4, now())`, [observationId, attemptId, before, appliedBy]);
      }
    }));
  };

  /** A certified failure and its replacement, authorized (permitted), not yet sent. */
  const replacementReady = async () => {
    const x = await certifiedFailure();
    const r = await certified(() => requestRefund(x.paymentId, x.caseId));
    expect([r.res.status, r.res.body.status]).toEqual([201, 'authorized']);
    return { ...x, replacement: r.attemptId };
  };

  describe('R: every answer stored before its decision, applied once', () => {
    it('R1 accepted: first send recorded before the call, its answer, one application by the dispatch', async () => {
      const x = await authorized();
      await drain(x.attemptId);
      const a = await row(x.attemptId);
      expect(a.status).toBe('submitted');
      const [s] = await sendsOf(x.attemptId);
      expect(s).toMatchObject({ purpose: 'first_send', sendNumber: 1, paymentId: x.paymentId, provider: 'simulation', idempotencyKey: x.attemptId });
      const [o] = await observationsOf(x.attemptId);
      expect(o).toMatchObject({ sendId: s.id, classification: 'accepted', providerRefundId: a.providerRefundId, providerCode: null, source: 'dispatch_response' });
      const digest = (await one(`SELECT encode(sha256(convert_to(jsonb_build_object('classification', 'accepted', 'providerRefundId', $1::text, 'providerCode', NULL::text)::text, 'UTF8')), 'hex') AS d`,
        [a.providerRefundId])).d;
      expect(o.responseDigest).toBe(digest); // derived by the database from the stored answer, never the caller's value
      expect(new Date(o.observedAt).getTime()).toBeGreaterThanOrEqual(new Date(s.createdAt).getTime());
      expect(await applicationsOf(x.attemptId)).toMatchObject([{ observationId: o.id, effect: 'transitioned', attemptStatusBefore: 'dispatching', attemptStatusAfter: 'submitted', appliedBy: 'dispatch' }]);
      expect(await received(x.attemptId)).toBe(1);
    });

    it('R2 rejected, uncertified: stored with its bounded code, failed by the dispatch, no finality', async () => {
      const x = await authorized();
      await plan(x.paymentId, 'rejected', 'declined');
      await drain(x.attemptId);
      expect(await row(x.attemptId)).toMatchObject({ status: 'failed', failureCode: 'declined' });
      expect(await observationsOf(x.attemptId)).toMatchObject([{ classification: 'rejected', providerCode: 'declined', providerRefundId: null }]);
      expect(await applicationsOf(x.attemptId)).toMatchObject([{ effect: 'transitioned', attemptStatusAfter: 'failed', appliedBy: 'dispatch' }]);
      expect(await finalityOf(x.attemptId)).toEqual([]);
      expect(await mayStillPay(x.attemptId)).toBe(true);
    });

    it('R3 rejected under certified finality: the dispatch\'s finality names its own stored rejection', async () => {
      const x = await authorized();
      await plan(x.paymentId, 'rejected', 'declined');
      await certified(() => drain(x.attemptId));
      const [o] = await observationsOf(x.attemptId);
      expect(await finalityOf(x.attemptId)).toMatchObject([{ observation: 'dispatch_rejected', observationSource: 'dispatch_response', failureCode: 'declined', dispatchObservationId: o.id }]);
      expect(await mayStillPay(x.attemptId)).toBe(false);
    });

    it('R4 ambiguous: stored, the attempt unknown; R5 transport error: stored as transport_error, unknown', async () => {
      const x = await authorized();
      await plan(x.paymentId, 'ambiguous');
      await drain(x.attemptId);
      expect((await row(x.attemptId)).status).toBe('unknown');
      expect(await observationsOf(x.attemptId)).toMatchObject([{ classification: 'ambiguous', providerRefundId: null, providerCode: null }]);
      expect(await applicationsOf(x.attemptId)).toMatchObject([{ effect: 'transitioned', attemptStatusBefore: 'dispatching', attemptStatusAfter: 'unknown' }]);

      const y = await authorized();
      const s = t.app.get(SimulationPaymentProvider);
      const throwing = vi.spyOn(s, 'refund').mockRejectedValueOnce(new Error('socket hang up'));
      try {
        await drain(y.attemptId);
      } finally {
        throwing.mockRestore();
      }
      expect((await row(y.attemptId)).status).toBe('unknown');
      expect(await observationsOf(y.attemptId)).toMatchObject([{ classification: 'transport_error', providerRefundId: null, providerCode: null }]);
    });
  });

  describe('K: crash points and recovery', () => {
    it('K1 crash before the send commits: nothing sent, nothing recorded; the next pass sends once', async () => {
      const x = await authorized();
      await injected('refund_dispatch_send', () => drain(x.attemptId));
      expect([(await row(x.attemptId)).status, await received(x.attemptId), (await sendsOf(x.attemptId)).length]).toEqual(['authorized', 0, 0]);
      await drain(x.attemptId);
      expect([(await row(x.attemptId)).status, await received(x.attemptId), (await sendsOf(x.attemptId)).length]).toEqual(['submitted', 1, 1]);
    });

    it('K2 crash after the send, before the call: a send with no answer stays UNKNOWN; only the existing same-key rules resend', async () => {
      const x = await authorized();
      // LABELLED FIXTURE: exactly the state T0 commits (the runtime role, every trigger on): dispatching and its first send, then the process died
      await rtTx(async (q) => {
        await q.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1`, [x.attemptId]);
        await q.query(`INSERT INTO refund_dispatch_send (id, "refundAttemptId", "paymentId", provider, "idempotencyKey", "sendNumber", purpose, "createdAt")
          VALUES ($1, $2::uuid, $3, 'simulation', $2::text, 0, 'first_send', now())`, [randomUUID(), x.attemptId, x.paymentId]);
      });
      expect(await received(x.attemptId)).toBe(0);
      await age('refund_dispatch_send', 'createdAt', x.attemptId);
      expect((await ownerItems('owner-jwt', 'refund_dispatch_send_unobserved')).filter((i) => i.detail.refundAttemptId === x.attemptId))
        .toMatchObject([{ paymentId: x.paymentId, detail: { sendNumber: 1, purpose: 'first_send', attemptStatus: 'dispatching', outcome: 'unknown' } }]);
      await drain(x.attemptId); // dispatching: resent with the same key under the simulation's certified retention (D-R1A Q5), recorded first
      expect((await sendsOf(x.attemptId)).map((s) => s.purpose)).toEqual(['first_send', 'same_key_resend']);
      expect((await observationsOf(x.attemptId)).map((o) => [o.sendNumber, o.classification])).toEqual([[2, 'accepted']]);
      expect([(await row(x.attemptId)).status, await received(x.attemptId)]).toEqual(['submitted', 1]);
    });

    it('K3 database failure after the call, before the answer is stored: UNKNOWN, nothing decided; status reads still resolve it', async () => {
      const x = await authorized();
      const errors = vi.spyOn(Logger.prototype, 'error');
      try {
        await injected('refund_dispatch_observation', () => drain(x.attemptId));
        expect(errors.mock.calls.some(([m]) => String(m).startsWith(`refund_dispatch_response_unrecorded refundAttempt=${x.attemptId}`) && String(m).includes('answer=accepted'))).toBe(true);
      } finally {
        errors.mockRestore();
      }
      expect([(await row(x.attemptId)).status, await received(x.attemptId)]).toEqual(['dispatching', 1]); // the provider HAS it; Payment cannot know
      expect(await observationsOf(x.attemptId)).toEqual([]);
      expect(await applicationsOf(x.attemptId)).toEqual([]);
      await outcome(x.attemptId, { outcome: 'succeeded' }); // a later verified report
      expect((await row(x.attemptId)).status).toBe('succeeded');
      await age('refund_dispatch_send', 'createdAt', x.attemptId);
      expect((await ownerItems('owner-jwt', 'refund_dispatch_send_unobserved')).filter((i) => i.detail.refundAttemptId === x.attemptId))
        .toMatchObject([{ detail: { attemptStatus: 'succeeded', outcome: 'unknown' } }]); // the send's own answer stays unknown: never inferred
    });

    it('K4 crash after the answer is stored, before its application: nothing else happens to the attempt; recovery applies it once, no provider call', async () => {
      const x = await storedUnapplied('accepted');
      const inWindow = await providerCalls(async () => { await drain(x.attemptId); await drain(x.attemptId, worker2); });
      expect([inWindow.refunds, inWindow.statusReads]).toEqual([0, 0]); // excluded: no resend, no status read over a stored answer
      expect((await row(x.attemptId)).status).toBe('dispatching');
      const recovered = await providerCalls(() => recoveryWindow(1, () => worker.drainOnce()));
      expect([recovered.refunds, recovered.statusReads]).toEqual([0, 0]); // recovery never calls the provider
      const a = await row(x.attemptId);
      expect(a).toMatchObject({ status: 'submitted', providerRefundId: `simr_${x.attemptId}` });
      expect(await applicationsOf(x.attemptId)).toMatchObject([{ effect: 'transitioned', attemptStatusBefore: 'dispatching', attemptStatusAfter: 'submitted', appliedBy: 'recovery' }]);
      expect(await received(x.attemptId)).toBe(1);
    });

    it('K5 a failed decision of a certified rejection, then recovery: failed WITHOUT finality; no replacement is permitted', async () => {
      const x = await storedUnapplied('rejected', (fn) => certified(fn));
      expect(await finalityOf(x.attemptId)).toEqual([]); // the rolled-back decision left none
      await certified(() => recoveryWindow(1, () => worker.drainOnce()));
      expect(await row(x.attemptId)).toMatchObject({ status: 'failed', failureCode: 'declined' });
      expect(await applicationsOf(x.attemptId)).toMatchObject([{ effect: 'transitioned', attemptStatusAfter: 'failed', appliedBy: 'recovery' }]);
      expect(await finalityOf(x.attemptId)).toEqual([]); // Q1: recovery never grants finality
      expect(await mayStillPay(x.attemptId)).toBe(true);
      expect(await failedAudits(x.attemptId)).toBe(1);
      const r = await certified(() => requestRefund(x.paymentId, x.caseId));
      expect([r.res.status, r.res.body.code]).toEqual([409, 'refund_in_progress']); // D-R1B: an uncertified failure may still pay
    });

    it('K6 restart and retry: a recovery that fails rolls back whole and is retried by another instance; applied once', async () => {
      const x = await storedUnapplied('rejected');
      await recoveryWindow(1, () => injected('outbox', () => worker.drainOnce(), `NEW.name = 'audit.refund_attempt.failed'`));
      expect([(await row(x.attemptId)).status, (await applicationsOf(x.attemptId)).length, await failedAudits(x.attemptId)]).toEqual(['dispatching', 0, 0]);
      await recoveryWindow(1, () => worker2.drainOnce()); // the other instance (a restarted process): the same stored answer
      expect([(await row(x.attemptId)).status, (await applicationsOf(x.attemptId)).length, await failedAudits(x.attemptId)]).toEqual(['failed', 1, 1]);
      await recoveryWindow(1, async () => { await worker.drainOnce(); await worker2.drainOnce(); });
      expect([(await applicationsOf(x.attemptId)).length, await failedAudits(x.attemptId), await received(x.attemptId)]).toEqual([1, 1, 1]);
    });

    it('K7 two instances recover the same answer concurrently: one application, one transition, one audit', async () => {
      const x = await storedUnapplied('rejected');
      await recoveryWindow(1, () => Promise.all([worker.drainOnce(), worker2.drainOnce(), worker.drainOnce()]));
      expect(await applicationsOf(x.attemptId)).toHaveLength(1);
      expect([(await row(x.attemptId)).status, await failedAudits(x.attemptId), await received(x.attemptId)]).toEqual(['failed', 1, 1]);
    });
  });

  describe('D: duplicates and contradictions', () => {
    it('D1 the same answer written twice is one observation; a different answer for the same send never overwrites it', async () => {
      const x = await authorized();
      await drain(x.attemptId);
      const [s] = await sendsOf(x.attemptId);
      const [o] = await observationsOf(x.attemptId);
      const responses = t.app.get(RefundDispatchResponseService);
      const again = await responses.observe(s.id, x.attemptId, { classification: 'accepted', providerRefundId: o.providerRefundId, providerCode: null });
      expect(again.id).toBe(o.id);
      const errors = vi.spyOn(Logger.prototype, 'error');
      try {
        const other = await responses.observe(s.id, x.attemptId, { classification: 'rejected', providerRefundId: null, providerCode: 'declined' });
        expect(other).toMatchObject({ id: o.id, classification: 'accepted' });
        expect(errors.mock.calls.some(([m]) => String(m).startsWith(`refund_dispatch_observation_mismatch send=${s.id}`))).toBe(true);
      } finally {
        errors.mockRestore();
      }
      expect(await observationsOf(x.attemptId)).toEqual([o]);
    });

    it('D2 two sends with different answers: both kept, applied in order', async () => {
      const x = await authorized();
      await plan(x.paymentId, 'ambiguous');
      await drain(x.attemptId);
      await outcome(x.attemptId, { outcome: 'no_record' });
      await plan(x.paymentId, 'accepted');
      await drain(x.attemptId); // unknown + no record: the same key again (R6B-4) under the certified retention
      expect((await observationsOf(x.attemptId)).map((o) => [o.sendNumber, o.classification])).toEqual([[1, 'ambiguous'], [2, 'accepted']]);
      expect((await applicationsOf(x.attemptId)).map((p) => [p.attemptStatusBefore, p.attemptStatusAfter, p.effect]))
        .toEqual([['dispatching', 'unknown', 'transitioned'], ['unknown', 'submitted', 'transitioned']]);
    });

    it('D3 a verified success racing a stored rejection: the contradiction is preserved, the success stands', async () => {
      const x = await authorized();
      await plan(x.paymentId, 'rejected', 'declined');
      const s = t.app.get(SimulationPaymentProvider);
      const original = s.refund.bind(s);
      const race = vi.spyOn(s, 'refund').mockImplementationOnce(async (d) => {
        const r = await original(d);
        await outcome(x.attemptId, { outcome: 'succeeded' });
        return r;
      });
      try {
        await drain(x.attemptId);
      } finally {
        race.mockRestore();
      }
      expect((await row(x.attemptId)).status).toBe('succeeded');
      expect(await applicationsOf(x.attemptId)).toMatchObject([{ effect: 'preserved_contradiction', attemptStatusBefore: 'succeeded', attemptStatusAfter: 'succeeded', appliedBy: 'dispatch' }]);
      expect((await admin.query(`SELECT * FROM refund_safety_escalation WHERE "refundAttemptId" = $1 AND kind = 'failure_after_refund_evidence'`, [x.attemptId])).rows)
        .toMatchObject([{ observedFailureCode: 'declined' }]);
    });
  });

  describe('G: the database refuses what the rules do not permit', () => {
    it('G1 sends: wrong provider, payment or key; an attempt not in flight; a second first send', async () => {
      const x = await submitted();
      const y = await authorized();
      const send = (attempt: string, payment: string, provider: string, k: string, purpose = 'same_key_resend') => refusedWith(rt(
        `INSERT INTO refund_dispatch_send (id, "refundAttemptId", "paymentId", provider, "idempotencyKey", "sendNumber", purpose, "createdAt") VALUES ($1, $2, $3, $4, $5, 0, $6, now())`,
        [randomUUID(), attempt, payment, provider, k, purpose]));
      await fixture(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1`, [x.attemptId]); // LABELLED FIXTURE: back in flight
      expect(await send(x.attemptId, x.paymentId, 'test', x.attemptId)).toMatchObject({ code: '23514', constraint: 'refund_dispatch_send_binding' });
      expect(await send(x.attemptId, y.paymentId, 'simulation', x.attemptId)).toMatchObject({ code: '23514', constraint: 'refund_dispatch_send_binding' });
      expect(await send(x.attemptId, x.paymentId, 'simulation', y.attemptId)).toMatchObject({ code: '23514', constraint: 'refund_dispatch_send_binding' });
      expect(await send(x.attemptId, x.paymentId, 'simulation', x.attemptId, 'first_send')).toMatchObject({ code: '23514', constraint: 'refund_dispatch_send_state' });
      expect(await send(y.attemptId, y.paymentId, 'simulation', y.attemptId, 'first_send')).toMatchObject({ code: '23514', constraint: 'refund_dispatch_send_state' }); // authorized
      expect(await send(x.attemptId, x.paymentId, 'simulation', x.attemptId)).toEqual({ code: 'accepted' }); // positive control: the derived number
      expect((await sendsOf(x.attemptId)).map((s) => s.sendNumber)).toEqual([1, 2]);
    });

    it('G2 observations and applications: another attempt\'s send, a malformed answer, a wrong status, a second application', async () => {
      const x = await submitted();
      const y = await submitted();
      const [sx] = await sendsOf(x.attemptId);
      const [ox] = await observationsOf(x.attemptId);
      const [oy] = await observationsOf(y.attemptId);
      const observe = (send: string, attempt: string, c: string, ref: string | null, code: string | null) => refusedWith(rt(
        `INSERT INTO refund_dispatch_observation ("sendId", "refundAttemptId", classification, "providerRefundId", "providerCode", "responseDigest", "observedAt")
         VALUES ($1, $2, $3, $4, $5, repeat('0', 64), now())`, [send, attempt, c, ref, code]));
      expect((await observe(sx.id, x.attemptId, 'ambiguous', null, null)).code).toBe('23505'); // a second answer to one send
      const k = await authorized();
      await injected('refund_dispatch_observation', () => drain(k.attemptId)); // a send with no answer
      const [sk] = await sendsOf(k.attemptId);
      expect((await observe(sk.id, y.attemptId, 'ambiguous', null, null)).code).toBe('23503'); // k's send as y's
      expect(await observe(randomUUID(), x.attemptId, 'accepted', null, null)).toMatchObject({ code: '23514', constraint: 'refund_dispatch_observation_shape' });
      expect(await observe(randomUUID(), x.attemptId, 'rejected', null, null)).toMatchObject({ code: '23514', constraint: 'refund_dispatch_observation_shape' });
      expect(await observe(randomUUID(), x.attemptId, 'rejected', null, 'Not-Bounded')).toMatchObject({ code: '23514', constraint: 'refund_dispatch_observation_code' });
      const apply = (o: string, attempt: string, effect: string, before: string, after: string) => refusedWith(rt(
        `INSERT INTO refund_dispatch_application ("observationId", "refundAttemptId", effect, "attemptStatusBefore", "attemptStatusAfter", "appliedBy", "appliedAt")
         VALUES ($1, $2, $3, $4, $5, 'recovery', now())`, [o, attempt, effect, before, after]));
      expect((await apply(ox.id, x.attemptId, 'no_effect', 'submitted', 'submitted')).code).toBe('23505'); // a second application
      expect(await apply(oy.id, x.attemptId, 'no_effect', 'submitted', 'submitted')).toMatchObject({ code: '23514', constraint: 'refund_dispatch_application_state' }); // y's as x's
      // a fresh stored answer (decision failed) cannot be applied as another attempt's, to a status the attempt is not in, nor as a transition its
      // classification does not name
      const z = await storedUnapplied('accepted');
      const [oz] = await observationsOf(z.attemptId);
      expect(await apply(oz.id, x.attemptId, 'no_effect', 'submitted', 'submitted')).toMatchObject({ code: '23514', constraint: 'refund_dispatch_application_state' });
      expect(await apply(oz.id, z.attemptId, 'no_effect', 'submitted', 'submitted')).toMatchObject({ code: '23514', constraint: 'refund_dispatch_application_state' });
      expect(await apply(oz.id, z.attemptId, 'transitioned', 'unknown', 'dispatching')).toMatchObject({ code: '23514', constraint: 'refund_dispatch_application_state' });
      expect(await apply(oz.id, z.attemptId, 'no_effect', 'unknown', 'dispatching')).toMatchObject({ code: '23514', constraint: 'refund_dispatch_application_shape' });
    });

    it('G3 finality from a dispatch response: refused for no, an accepted, another attempt\'s or a code-mismatched observation, or a recovery application', async () => {
      const z = await storedUnapplied('rejected');
      const [oz] = await observationsOf(z.attemptId);
      const acc = await storedUnapplied('accepted');
      const [oacc] = await observationsOf(acc.attemptId);
      const other = await storedUnapplied('rejected');
      const [oother] = await observationsOf(other.attemptId);
      expect(await rawFinality(z.attemptId, null, 'declined', 'dispatch')).toMatchObject({ code: '23514', constraint: 'refund_failure_finality_dispatch_observation' });
      expect(await rawFinality(acc.attemptId, oacc.id, 'declined', null)).toMatchObject({ code: '23514', constraint: 'refund_failure_finality_dispatch_observation' });
      expect(await rawFinality(z.attemptId, oother.id, 'declined', null)).toMatchObject({ code: '23514', constraint: 'refund_failure_finality_dispatch_observation' });
      expect(await rawFinality(z.attemptId, oz.id, 'expired', null)).toMatchObject({ code: '23514', constraint: 'refund_failure_finality_dispatch_observation' });
      expect(await rawFinality(z.attemptId, oz.id, 'declined', null)).toMatchObject({ code: '23514', constraint: 'refund_failure_finality_dispatch_application' }); // not applied
      expect(await rawFinality(z.attemptId, oz.id, 'declined', 'recovery')).toMatchObject({ code: '23514', constraint: 'refund_failure_finality_dispatch_application' }); // Q1
      expect(await finalityOf(z.attemptId)).toEqual([]);
      expect(await rawFinality(z.attemptId, oz.id, 'declined', 'dispatch')).toEqual({ code: 'accepted' }); // positive control: the harness is sound
      expect(await finalityOf(z.attemptId)).toMatchObject([{ dispatchObservationId: oz.id }]);
    });

    it('G4 immutable evidence: the runtime role may only insert and read; nobody rewrites it', async () => {
      const x = await submitted();
      for (const table of ['refund_dispatch_send', 'refund_dispatch_observation', 'refund_dispatch_application']) {
        const p = (await one(`SELECT ${['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'].map((v) => `has_table_privilege($1, $2, '${v}') AS "${v}"`).join(', ')}`, [appRole, table]));
        expect(p).toEqual({ SELECT: true, INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false, REFERENCES: false, TRIGGER: false });
        expect((await refusedWith(rt(`UPDATE ${table} SET "refundAttemptId" = "refundAttemptId" WHERE "refundAttemptId" = $1`, [x.attemptId]))).code).toBe('42501');
        expect((await refusedWith(rt(`DELETE FROM ${table} WHERE "refundAttemptId" = $1`, [x.attemptId]))).code).toBe('42501');
        expect((await refusedWith(rt(`TRUNCATE ${table} CASCADE`))).code).toBe('42501');
        expect((await refusedWith(mig.query(`UPDATE ${table} SET "refundAttemptId" = "refundAttemptId" WHERE "refundAttemptId" = $1`, [x.attemptId]))).code).not.toBe('accepted'); // the owner: append-only
        expect((await refusedWith(mig.query(`DELETE FROM ${table} WHERE "refundAttemptId" = $1`, [x.attemptId]))).code).not.toBe('accepted');
      }
      expect(await sendsOf(x.attemptId)).toHaveLength(1);
    });
  });

  describe('V: Owner visibility and Company isolation', () => {
    it('V1 both items appear after the window, Owner only, with exact detail; another Company\'s Owner and the producer see nothing', async () => {
      const k = await authorized();
      await injected('refund_dispatch_observation', () => drain(k.attemptId)); // a send with no answer
      const u = await storedUnapplied('rejected'); // an answer not applied
      const mine = async (kind: string, id: string) => (await ownerItems('owner-jwt', kind)).filter((i) => i.detail.refundAttemptId === id);
      expect(await mine('refund_dispatch_send_unobserved', k.attemptId)).toEqual([]); // inside the window: nothing yet
      expect(await mine('refund_dispatch_response_unapplied', u.attemptId)).toEqual([]);
      await age('refund_dispatch_send', 'createdAt', k.attemptId);
      await age('refund_dispatch_observation', 'observedAt', u.attemptId);
      const [s] = await sendsOf(k.attemptId);
      const [o] = await observationsOf(u.attemptId);
      const [unobserved] = await mine('refund_dispatch_send_unobserved', k.attemptId);
      expect(unobserved).toMatchObject({ kind: 'refund_dispatch_send_unobserved', id: s.id, paymentId: k.paymentId, factId: null, amount: 9000, currency: 'TND' });
      expect(Object.keys(unobserved!.detail).sort()).toEqual(['attemptStatus', 'outcome', 'provider', 'purpose', 'refundAttemptId', 'sendNumber']);
      const [unapplied] = await mine('refund_dispatch_response_unapplied', u.attemptId);
      expect(unapplied).toMatchObject({ id: o.id, paymentId: u.paymentId, detail: { sendId: o.sendId, classification: 'rejected', providerCode: 'declined', providerRefundId: null, attemptStatus: 'dispatching' } });
      expect(Object.keys(unapplied!.detail).sort()).toEqual(['attemptStatus', 'classification', 'providerCode', 'providerRefundId', 'refundAttemptId', 'sendId']);
      for (const kind of ['refund_dispatch_send_unobserved', 'refund_dispatch_response_unapplied']) {
        expect(await ownerItems('owner2-jwt', kind)).toEqual([]); // another Company's Owner
        await request(t.app.getHttpServer()).get(`/payment/reconciliation/items?kind=${kind}&limit=200`).set('authorization', `Bearer ${billing.token}`).expect(400); // no producer kind
      }
      await recoveryWindow(1, () => worker.drainOnce()); // applied: the unapplied item is gone; the send without an answer stays (never inferred)
      expect(await mine('refund_dispatch_response_unapplied', u.attemptId)).toEqual([]);
      expect(await mine('refund_dispatch_send_unobserved', k.attemptId)).toHaveLength(1);
    });
  });

  describe('U: existing safeguards unchanged — no new send', () => {
    it('U1 a D-R1C blocked and a DO-76 held attempt record no send; a withheld same-key resend records none', async () => {
      const b = await replacementReady();
      await revoke();
      await certified(() => drain(b.replacement));
      expect([(await row(b.replacement)).status, await received(b.replacement), (await sendsOf(b.replacement)).length]).toEqual(['authorized', 0, 0]);
      await unrevoke();
      const h = await replacementReady();
      await outcome(h.attemptId, { outcome: 'succeeded' });
      await certified(() => drain(h.replacement));
      expect([(await row(h.replacement)).status, await received(h.replacement), (await sendsOf(h.replacement)).length]).toEqual(['authorized', 0, 0]);
      // a same-key resend without a certified retention (D-R1A Q5): withheld, no send recorded
      const w = await authorized();
      await plan(w.paymentId, 'ambiguous');
      await drain(w.attemptId);
      await outcome(w.attemptId, { outcome: 'no_record' });
      await declare([], () => drain(w.attemptId));
      expect([(await row(w.attemptId)).status, await received(w.attemptId), (await sendsOf(w.attemptId)).length]).toEqual(['unknown', 1, 1]);
    });
  });
});

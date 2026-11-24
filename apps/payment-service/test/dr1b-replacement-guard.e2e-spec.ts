import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { jobContext } from '../src/events/payment-events.js';
import type { ProviderCapabilities } from '../src/providers/provider.port.js';
import { SimulationPaymentProvider } from '../src/providers/simulation-provider.js';
import { REFUND_CAPABILITY_CERTIFICATES, REFUND_CAPABILITY_REVOCATIONS, certificateContent, certificateFingerprint } from '../src/providers/refund-capabilities.js';
import { RefundAttemptService } from '../src/refunds/refund-attempt.service.js';
import { RefundEvidenceService } from '../src/refunds/refund-evidence.service.js';
import { RefundFinalityService } from '../src/refunds/refund-finality.service.js';
import { RefundWorker } from '../src/refunds/refund-worker.js';
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
const FINALITY = REFUND_CAPABILITY_CERTIFICATES.find((c) => c.id === FINALITY_REF.id)!;
type Row = Record<string, any>;

/**
 * Core V2 D-R1B (the Owner's GO of 2026-11-24; migration 0037): no refund replacement is created or sent while an earlier attempt of the same money may
 * still pay. Two real Payment instances running as the RUNTIME database role (DML only, provisioned as `infra/postgres/init` does), PostgreSQL 16, the
 * simulation provider and the fake Auth receipt server. Migrator-role connections write the certificate mirror, as a reviewed migration would.
 * DEVELOPMENT AND SIMULATION ONLY. LABELLED FIXTURES: the simulation adapter's declarations are switched on the running instances (default: the modelled
 * failure finality is NOT declared, as for every real provider); `fixture` edits guarded rows with triggers off, as a superuser only, to reproduce
 * history or a tampered row.
 */
describeWithEnv('Core V2 D-R1B: no replacement while an earlier refund attempt may still pay — real PostgreSQL, runtime role', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  const suffix = randomBytes(4).toString('hex');
  const migRole = `dr1b_mig_${suffix}`;
  const appRole = `dr1b_app_${suffix}`;
  const dbName = `dr1b_payment_${suffix}`;
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
  const identities: Record<string, AuthIdentity> = { 'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] } };
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
  const escalationsOf = async (id: string, kind = 'failure_after_refund_evidence') => (await admin.query(`SELECT * FROM refund_safety_escalation WHERE "refundAttemptId" = $1 AND kind = $2`, [id, kind])).rows;
  const received = async (id: string) => (await one(`SELECT received FROM simulation_refund_dispatch WHERE "idempotencyKey" = $1`, [id]))?.received ?? 0;
  /** How many DISTINCT refunds of the payment ever reached the provider. */
  const providerRefunds = async (paymentId: string) => Number((await one(`SELECT count(*) AS n FROM simulation_refund_dispatch d JOIN refund_attempt a ON a.id = d."idempotencyKey" WHERE a."paymentId" = $1`, [paymentId])).n);
  const mayStillPay = async (id: string) => (await one(`SELECT refund_attempt_may_still_pay($1, clock_timestamp()) AS v`, [id])).v as boolean;
  const refusedIn = (r: { res: { status: number; body: Row } }) => [r.res.status, r.res.body.code];
  const REFUSED = [409, 'refund_in_progress'];
  /** A replacement attempt inserted directly (the application's checks skipped), copied from `from`. */
  const insertAttempt = (q: { query: (s: string, p?: unknown[]) => Promise<pg.QueryResult> }, from: string, id = randomUUID()) => q.query(
    `INSERT INTO refund_attempt (id, "paymentId", producer, "refundCaseId", "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId", provider, "liveMode",
       "receiptDigest", "captureSpecific")
     SELECT $2::uuid, "paymentId", producer, "refundCaseId", "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId", provider, "liveMode", repeat('b', 64), "captureSpecific"
       FROM refund_attempt WHERE id = $1`, [from, id]);
  const PRIOR = { code: '23514', constraint: 'refund_attempt_prior_may_still_pay' };

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
  const open = async (pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<unknown>) => {
    const c = await pool.connect();
    opened.add(c);
    await c.query('BEGIN');
    await fn(c);
    return { c, end: async (how: 'COMMIT' | 'ROLLBACK' = 'COMMIT') => { opened.delete(c); try { await c.query(how); } finally { c.release(); } } };
  };
  const closeAll = async () => { // a failed test never leaves a lock behind
    for (const c of opened) c.release(true);
    opened.clear();
    await unrevoke();
  };
  const waitsForAdvisoryLock = async () => {
    for (let i = 0; i < 200; i++) {
      if (Number((await one(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND wait_event = 'advisory'`, [dbName])).n) > 0) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('nothing waits for an advisory lock');
  };
  /** The application's own finality decisions switched off on both instances: the database alone decides. */
  const databaseAlone = async <T>(fn: () => Promise<T>): Promise<T> => {
    const services = [t.app.get(RefundFinalityService), t2.app.get(RefundFinalityService)];
    for (const s of services) {
      Object.defineProperty(s, 'blocker', { value: async () => null, configurable: true });
      Object.defineProperty(s, 'dispatchRefusal', { value: async () => null, configurable: true });
      Object.defineProperty(s, 'anotherCaptureRemains', { value: async () => true, configurable: true });
    }
    try {
      return await fn();
    } finally {
      for (const s of services) for (const k of ['blocker', 'dispatchRefusal', 'anotherCaptureRemains']) delete (s as unknown as Row)[k];
    }
  };
  const evidence = (x: TestApp = t) => x.app.get(RefundEvidenceService) as unknown as {
    recordRefundFact: (id: string, s: Row, ctx: unknown) => Promise<{ id: string }>;
    apply: (id: string, s: Row, ctx: unknown) => Promise<Row>;
  };
  const success = (id: string) => ({ kind: 'succeeded', amount: 9000, currency: 'TND', providerRefundId: `simr_${id}` });
  const inTx = async (pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<unknown>, level = 'READ COMMITTED') => {
    const c = await pool.connect();
    try {
      await c.query(`BEGIN ISOLATION LEVEL ${level}`);
      await fn(c);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  };
  const insertFinality = (q: { query: (s: string, p?: unknown[]) => Promise<pg.QueryResult> }, id: string, over: Row = {}) => {
    const v = { observation: 'provider_failed', source: 'status_check', webhook: null, code: 'declined', cert: FINALITY_REF.id, version: 1, fingerprint: certificateFingerprint(FINALITY), ...over };
    return q.query(
      `INSERT INTO refund_attempt_failure_finality ("refundAttemptId", "paymentId", "captureFactId", provider, "idempotencyKey", observation, "observationSource", "webhookEventId", "failureCode",
         "certificateId", "certificateVersion", "certificateFingerprint", "recordedAt")
       VALUES ($1::uuid, $2, $3, 'forged', 'forged', $4, $5, $6, $7, $8, $9, $10, '2000-01-01')`,
      [id, randomUUID(), randomUUID(), v.observation, v.source, v.webhook, v.code, v.cert, v.version, v.fingerprint]);
  };
  const failSql = (q: { query: (s: string, p?: unknown[]) => Promise<pg.QueryResult> }, id: string, code = 'declined') =>
    q.query(`UPDATE refund_attempt SET status = 'failed', "failureCode" = $2, "completedAt" = now(), "workAfter" = NULL WHERE id = $1`, [id, code]);
  /** A synthetic simulation certificate written to the mirror by the migrator (the code registry does not know it: the database alone decides). */
  const seed = async (over: Row = {}) => {
    const c = { id: `synthetic-${randomUUID().slice(0, 8)}`, version: 1, providerId: 'simulation', scope: 'simulation', issuedAt: '2026-11-24T00:00:00.000Z', expiresAt: null as string | null,
      grants: { terminalFailureFinality: { observations: ['dispatch_rejected', 'provider_failed'] } }, ...over };
    const content = JSON.stringify(c);
    const fingerprint = createHash('sha256').update(content).digest('hex');
    await mig.query(
      `INSERT INTO refund_capability_certificate (id, version, fingerprint, "providerId", scope, "issuedAt", "expiresAt", "failureObservations", content, "approvalRef")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'SYNTHETIC TEST FIXTURE')`,
      [c.id, c.version, fingerprint, c.providerId, c.scope, c.issuedAt, c.expiresAt, c.grants.terminalFailureFinality?.observations ?? [], content]);
    return { cert: c.id, version: c.version, fingerprint };
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
      databaseUrl: urlAs(appRole, appPw), authClient, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], refundWorker: false,
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token, PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET,
        PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE: '100000', PAYMENT_RATE_LIMIT_CREATE_PER_MINUTE: '100000', // one buyer, many payments; this file asserts no rate limit
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create'], allowedPlatforms: [TEST_PLATFORM] },
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

  describe('uncertified failures: one provider refund, never a replacement (RLSC-1 P5, P6)', () => {
    it('P5 the failed attempt later pays: the replacement is refused under a fresh Owner receipt, one refund reaches the provider, the success is kept', async () => {
      const x = await submitted();
      await fail(x.attemptId);
      expect((await row(x.attemptId)).status).toBe('failed');
      expect(await finalityOf(x.attemptId)).toEqual([]);
      const r = await requestRefund(x.paymentId, x.caseId);
      expect(refusedIn(r)).toEqual(REFUSED);
      expect(await row(r.attemptId)).toBeUndefined();
      expect(await one(`SELECT code FROM refund_attempt_refusal WHERE id = $1`, [r.attemptId])).toEqual({ code: 'refund_in_progress' });
      await worker.drainOnce();
      await worker2.drainOnce();
      expect(await providerRefunds(x.paymentId)).toBe(1);
      await outcome(x.attemptId, { outcome: 'succeeded' }); // the first refund turns out to have paid
      expect(await factsOf(x.attemptId)).toHaveLength(1);
      expect(await row(x.attemptId)).toMatchObject({ status: 'discrepancy', failureCode: 'declined' }); // failure, then late success: both observations stay
      expect(refusedIn(await requestRefund(x.paymentId, randomUUID()))[0]).toBe(409);
      expect(await providerRefunds(x.paymentId)).toBe(1);
      expect((await one(`SELECT COALESCE(sum(amount), 0)::int AS n FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'refund'`, [x.paymentId])).n).toBe(9000); // once
    });

    it('P6 replacements requested concurrently on two instances, for the same and another case: every one refused; one refund reaches the provider', async () => {
      const x = await submitted();
      await fail(x.attemptId);
      const rs = await Promise.all([requestRefund(x.paymentId, x.caseId, { x: t }), requestRefund(x.paymentId, x.caseId, { x: t2 }), requestRefund(x.paymentId, randomUUID(), { x: t2 })]);
      expect(rs.map(refusedIn)).toEqual([REFUSED, REFUSED, REFUSED]);
      await Promise.all([worker.drainOnce(), worker2.drainOnce()]);
      expect(await providerRefunds(x.paymentId)).toBe(1);
      expect((await one(`SELECT count(*)::int AS n FROM refund_attempt WHERE "paymentId" = $1`, [x.paymentId])).n).toBe(1);
    });

    it('P7 a definitive dispatch refusal, uncertified: refused too; waiting and status reads release nothing (Q2)', async () => {
      const x = await authorized();
      await sim(`payments/${x.paymentId}/refund-dispatch-plan`, { commandId: cmd(), mode: 'rejected', failureCode: 'declined' }).expect(201);
      await drain(x.attemptId);
      expect((await row(x.attemptId)).status).toBe('failed');
      await fixture(`UPDATE refund_attempt SET "completedAt" = now() - interval '10 years' WHERE id = $1`, [x.attemptId]);
      await evidence().apply(x.attemptId, { kind: 'failed', failureCode: 'declined' }, jobContext('refund_worker'));
      await certified(async () => expect(refusedIn(await requestRefund(x.paymentId, x.caseId))).toEqual(REFUSED));
    });

    it('P8 the database alone refuses it, for the runtime role and the schema owner', async () => {
      const x = await submitted();
      await fail(x.attemptId);
      await expect(insertAttempt(app, x.attemptId)).rejects.toMatchObject(PRIOR);
      await expect(insertAttempt(mig, x.attemptId)).rejects.toMatchObject(PRIOR);
      await databaseAlone(async () => expect((await requestRefund(x.paymentId, x.caseId)).res.status).toBe(500));
      expect((await one(`SELECT count(*)::int AS n FROM refund_attempt WHERE "paymentId" = $1`, [x.paymentId])).n).toBe(1);
    });

    it('P9 the capture read tells Billing the money is still in doubt', async () => {
      const x = await submitted();
      await fail(x.attemptId);
      const capture = (await row(x.attemptId)).captureFactId;
      const read = await request(t.app.getHttpServer()).get(`/payment/payments/${x.paymentId}/captures/${capture}`).set('authorization', `Bearer ${billing.token}`).expect(200);
      expect(read.body.refund).toBe('in_progress');
    });
  });

  describe('history', () => {
    it('H1 an attempt that failed before 0037 (LABELLED FIXTURE) blocks even when the provider is certified now; nothing can give it finality afterwards', async () => {
      const x = await submitted();
      await fixture(`UPDATE refund_attempt SET status = 'failed', "failureCode" = 'declined', "completedAt" = now(), "workAfter" = NULL WHERE id = $1`, [x.attemptId]);
      await certified(async () => {
        expect(refusedIn(await requestRefund(x.paymentId, x.caseId))).toEqual(REFUSED);
        await fail(x.attemptId); // reported again: never recorded as finality
      });
      expect(await finalityOf(x.attemptId)).toEqual([]);
      for (const q of [app, mig, admin]) await expect(insertFinality(q, x.attemptId)).rejects.toMatchObject({ constraint: 'refund_failure_finality_state' });
      // touching the row first (the runtime may write its lease) makes it no newer
      await expect(inTx(app, async (c) => {
        await c.query(`UPDATE refund_attempt SET "workAfter" = now() WHERE id = $1`, [x.attemptId]);
        await insertFinality(c, x.attemptId);
      })).rejects.toMatchObject({ constraint: 'refund_failure_finality_state' });
      expect(await mayStillPay(x.attemptId)).toBe(true);
    });

    it('H2 a replacement authorized before 0037 (LABELLED FIXTURE: no finality behind it) is never sent, on either instance or after a restart of the pass', async () => {
      const x = await certifiedFailure();
      const r = await certified(() => requestRefund(x.paymentId, x.caseId));
      expect(r.res.body.status).toBe('authorized');
      await fixture(`DELETE FROM refund_attempt_failure_finality WHERE "refundAttemptId" = $1`, [x.attemptId]);
      await certified(async () => {
        await drain(r.attemptId);
        await drain(r.attemptId, worker2);
        await databaseAlone(() => drain(r.attemptId));
      });
      expect((await row(r.attemptId)).status).toBe('authorized');
      expect(await received(r.attemptId)).toBe(0);
      for (const q of [app, mig]) await expect(q.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1`, [r.attemptId])).rejects.toMatchObject(PRIOR);
      expect(await providerRefunds(x.paymentId)).toBe(1);
    });
  });

  describe('POSITIVE CONTROL: terminal failure certified in the isolated simulation', () => {
    it('S1 a verified failure webhook: exact evidence; a fresh Owner receipt authorizes the replacement; sent once; the ledgers are the approved ones', async () => {
      const x = await certifiedFailure();
      const a = await row(x.attemptId);
      const [n] = await finalityOf(x.attemptId);
      expect(n).toMatchObject({ refundAttemptId: x.attemptId, paymentId: x.paymentId, captureFactId: a.captureFactId, provider: 'simulation', idempotencyKey: x.attemptId, observation: 'provider_failed',
        observationSource: 'webhook', failureCode: 'declined', certificateId: FINALITY_REF.id, certificateVersion: 1, certificateFingerprint: certificateFingerprint(FINALITY) });
      expect(await one(`SELECT provider, "eventType" FROM webhook_event WHERE id = $1`, [n.webhookEventId])).toEqual({ provider: 'simulation', eventType: 'refund.failed' });
      const r = await certified(() => requestRefund(x.paymentId, x.caseId));
      expect([r.res.status, r.res.body.status]).toEqual([201, 'authorized']);
      await certified(() => drain(r.attemptId));
      expect(await received(r.attemptId)).toBe(1);
      await outcome(r.attemptId, { outcome: 'succeeded' });
      expect((await row(r.attemptId)).status).toBe('succeeded');
      expect((await admin.query(`SELECT amount::int, intended::int, excess::int FROM refund_allocation WHERE "paymentId" = $1`, [x.paymentId])).rows).toEqual([{ amount: 9000, intended: 9000, excess: 0 }]);
      expect(await finalityOf(x.attemptId)).toEqual([n]); // never changed
    });

    it('S2 a definitive dispatch refusal and a status-read failure: their own observation and source', async () => {
      const d = await authorized();
      await sim(`payments/${d.paymentId}/refund-dispatch-plan`, { commandId: cmd(), mode: 'rejected', failureCode: 'refund_declined' }).expect(201);
      await certified(() => drain(d.attemptId));
      expect(await finalityOf(d.attemptId)).toMatchObject([{ observation: 'dispatch_rejected', observationSource: 'dispatch_response', webhookEventId: null, failureCode: 'refund_declined' }]);
      const s = await submitted();
      await certified(() => evidence().apply(s.attemptId, { kind: 'failed', failureCode: 'closed' }, jobContext('refund_worker')));
      expect(await finalityOf(s.attemptId)).toMatchObject([{ observation: 'provider_failed', observationSource: 'status_check', webhookEventId: null, failureCode: 'closed' }]);
      for (const x of [d, s]) await certified(async () => expect((await requestRefund(x.paymentId, x.caseId)).res.status).toBe(201));
    });

    it('S3 concurrent replacements on two instances after a certified failure: exactly one is created, one is sent', async () => {
      const x = await certifiedFailure();
      await certified(async () => {
        const rs = await Promise.all([t, t2, t, t2].map((i) => requestRefund(x.paymentId, randomUUID(), { x: i })));
        expect(rs.map((r) => r.res.status).sort((a, b) => a - b)).toEqual([201, 409, 409, 409]);
        await Promise.all([worker.drainOnce(), worker2.drainOnce()]);
      });
      expect(await providerRefunds(x.paymentId)).toBe(2); // the failed one and its one replacement
      // direct SQL from several sessions, the application out of the way: the guard and the index let one through
      const y = await certifiedFailure();
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => insertAttempt(app, y.attemptId)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    });

    it('S4 a later success of the certified failure (a MODELLED provider contract violation) is kept, reallocates nothing and permits no further replacement', async () => {
      const x = await certifiedFailure();
      const r = await certified(() => requestRefund(x.paymentId, x.caseId));
      await outcome(x.attemptId, { outcome: 'succeeded' });
      expect((await row(x.attemptId)).status).toBe('failed');
      expect(await escalationsOf(x.attemptId, 'failed_attempt_refund_evidence')).toHaveLength(1);
      expect(await mayStillPay(x.attemptId)).toBe(true); // its own refund fact: no longer out of the way
      await certified(() => drain(r.attemptId));
      expect(await received(r.attemptId)).toBe(0); // held (DO-76)
    });

    it('S4b its own refund fact under ANOTHER provider reference ends its finality too (the database alone)', async () => {
      const x = await certifiedFailure();
      await evidence().recordRefundFact(x.attemptId, { ...success(x.attemptId), providerRefundId: `other-${randomUUID()}` }, jobContext('refund_worker'));
      expect(await mayStillPay(x.attemptId)).toBe(true);
    });

    it('S5 both layers must agree: declared by neither, or revoked in code only by withdrawing the declaration, the application refuses what the database would allow', async () => {
      const x = await certifiedFailure();
      expect(await mayStillPay(x.attemptId)).toBe(false);
      expect(refusedIn(await requestRefund(x.paymentId, x.caseId))).toEqual(REFUSED); // the adapter declares no finality now
      await declare([CONTRACT_REF, FINALITY_REF, FINALITY_REF], async () => expect(refusedIn(await requestRefund(x.paymentId, x.caseId))).toEqual(REFUSED)); // ambiguous
      await declare([{ id: 'self-certified', version: 1 }], async () => expect(refusedIn(await requestRefund(x.paymentId, x.caseId))).toEqual(REFUSED));
      const r = await certified(() => requestRefund(x.paymentId, x.caseId));
      expect(r.res.status).toBe(201);
      await drain(r.attemptId); // the declaration was withdrawn between creation and dispatch
      expect([(await row(r.attemptId)).status, await received(r.attemptId)]).toEqual(['authorized', 0]);
    });
  });

  describe('certificate and evidence trust (the database alone)', () => {
    it('T1 the mirror is exactly the code registry, both ways, and certifies no real provider', async () => {
      const rows = (await admin.query(`SELECT id, version, fingerprint, "providerId", scope, "issuedAt", "expiresAt", "failureObservations", content FROM refund_capability_certificate WHERE "approvalRef" <> 'SYNTHETIC TEST FIXTURE' ORDER BY id`)).rows;
      const expected = [...REFUND_CAPABILITY_CERTIFICATES].sort((a, b) => a.id.localeCompare(b.id)).map((c) => ({ id: c.id, version: c.version, fingerprint: certificateFingerprint(c), providerId: c.providerId,
        scope: c.scope, issuedAt: new Date(c.issuedAt), expiresAt: c.expiresAt === null ? null : new Date(c.expiresAt), failureObservations: [...(c.grants.terminalFailureFinality?.observations ?? [])], content: certificateContent(c) }));
      expect(rows).toEqual(expected);
      expect((await admin.query(`SELECT "certificateId", "certificateVersion" FROM refund_capability_revocation`)).rows).toEqual(REFUND_CAPABILITY_REVOCATIONS.map((r) => ({ certificateId: r.id, certificateVersion: r.version })));
      expect(rows.every((r) => r.providerId === 'simulation')).toBe(true);
    });

    it('T2 the mirror refuses a real provider, a tampered content, column or fingerprint, and any change, for the schema owner too', async () => {
      await expect(seed({ providerId: 'flouci', scope: 'provider' })).rejects.toMatchObject({ code: '23514', constraint: 'refund_capability_certificate_simulation_only' });
      await expect(seed({ scope: 'provider' })).rejects.toMatchObject({ code: '23514' });
      const good = certificateContent(FINALITY);
      const ins = (over: Row) => {
        const v = { id: FINALITY.id, version: 2, fingerprint: createHash('sha256').update(good).digest('hex'), obs: ['provider_failed'], content: good, ...over };
        return mig.query(`INSERT INTO refund_capability_certificate (id, version, fingerprint, "providerId", scope, "issuedAt", "expiresAt", "failureObservations", content, "approvalRef")
          VALUES ($1, $2, $3, 'simulation', 'simulation', '2026-11-23T00:00:00Z', NULL, $4, $5, 'x')`, [v.id, v.version, v.fingerprint, v.obs, v.content]);
      };
      await expect(ins({})).rejects.toMatchObject({ constraint: 'refund_capability_certificate_content' }); // version 2 over version 1's content
      await expect(ins({ fingerprint: 'f'.repeat(64) })).rejects.toMatchObject({ code: '23514' });
      await expect(ins({ version: 1 })).rejects.toMatchObject({ code: '23514' }); // version 1 again with fewer observations
      for (const table of ['refund_capability_certificate', 'refund_capability_revocation', 'refund_attempt_failure_finality']) {
        for (const q of [mig, admin]) await expect(q.query(`TRUNCATE ${table} CASCADE`), table).rejects.toMatchObject({ code: '23514' });
      }
      await expect(mig.query(`UPDATE refund_capability_certificate SET "expiresAt" = now()`)).rejects.toMatchObject({ code: '23514' });
      await expect(mig.query(`DELETE FROM refund_capability_certificate`)).rejects.toMatchObject({ code: '23514' });
      const x = await certifiedFailure();
      await expect(mig.query(`UPDATE refund_attempt_failure_finality SET "failureCode" = 'x' WHERE "refundAttemptId" = $1`, [x.attemptId])).rejects.toMatchObject({ code: '23514' });
      await expect(mig.query(`DELETE FROM refund_attempt_failure_finality WHERE "refundAttemptId" = $1`, [x.attemptId])).rejects.toMatchObject({ code: '23514' });
    });

    it('T3 the runtime role reads them and inserts finality evidence; nothing else (42501), and no guard can be switched off or shadowed', async () => {
      for (const table of ['refund_capability_certificate', 'refund_capability_revocation']) {
        for (const s of [`INSERT INTO ${table} SELECT * FROM ${table}`, `UPDATE ${table} SET "approvalRef" = 'x'`, `DELETE FROM ${table}`, `TRUNCATE ${table}`, `ALTER TABLE ${table} DISABLE TRIGGER ALL`]) {
          await expect(app.query(s), s).rejects.toMatchObject({ code: '42501' });
        }
        await app.query(`SELECT 1 FROM ${table}`);
      }
      for (const s of [`UPDATE refund_attempt_failure_finality SET "failureCode" = 'x'`, 'DELETE FROM refund_attempt_failure_finality', 'TRUNCATE refund_attempt_failure_finality',
        'ALTER TABLE refund_attempt DISABLE TRIGGER refund_attempt_22_prior_may_still_pay', 'DROP TRIGGER refund_attempt_09b_prior_may_still_pay ON refund_attempt',
        `CREATE OR REPLACE FUNCTION refund_attempt_may_still_pay(p_attempt uuid, p_at timestamptz) RETURNS boolean LANGUAGE sql AS 'SELECT false'`,
        'CREATE TEMP TABLE refund_capability_revocation (x int)', 'SET session_replication_role = replica']) {
        await expect(app.query(s), s).rejects.toMatchObject({ code: '42501' });
      }
      const fns = (await admin.query(`SELECT p.proname, p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p
        WHERE p.proname IN ('refund_capability_lock_key', 'refund_require_read_committed', 'refund_capability_writer_lock', 'refund_capability_certificate_in_force', 'refund_failure_finality_insert_guard',
          'refund_failure_finality_commit_check', 'refund_attempt_may_still_pay', 'refund_attempt_replacement_refusal', 'refund_attempt_replacement_guard', 'refund_attempt_failed_after_fact_guard')`)).rows;
      expect(fns).toHaveLength(10);
      for (const f of fns) expect(f, f.proname).toMatchObject({ prosecdef: false, owner: migRole, proconfig: ['search_path=pg_catalog, public, pg_temp'] });
    });

    it('T4 a finality claim is checked, never taken: unknown, other version, changed fingerprint, uncovered or malformed observation, another provider', async () => {
      const x = await submitted();
      const contract = REFUND_CAPABILITY_CERTIFICATES.find((c) => c.id === CONTRACT_REF.id)!;
      const CERT = { constraint: 'refund_failure_finality_certificate' };
      for (const over of [{ cert: 'unknown-certificate' }, { version: 2 }, { fingerprint: 'f'.repeat(64) }, { cert: contract.id, fingerprint: certificateFingerprint(contract) }]) {
        await expect(insertFinality(app, x.attemptId, over), JSON.stringify(over)).rejects.toMatchObject(CERT);
      }
      const narrow = await seed({ grants: { terminalFailureFinality: { observations: ['dispatch_rejected'] } } });
      await expect(insertFinality(app, x.attemptId, narrow)).rejects.toMatchObject(CERT);
      await expect(insertFinality(app, x.attemptId, { observation: 'timeout' })).rejects.toMatchObject({ code: '23514' });
      await expect(insertFinality(app, x.attemptId, { observation: 'dispatch_rejected' })).rejects.toMatchObject({ constraint: 'refund_failure_finality_observation' }); // not a dispatch answer
      await expect(insertFinality(app, x.attemptId, { code: 'Not A Code' })).rejects.toMatchObject({ code: '23514' });
      await expect(insertFinality(app, x.attemptId, { source: 'webhook', webhook: randomUUID() })).rejects.toMatchObject({ constraint: 'refund_failure_finality_webhook' });
      const other = (await one(`SELECT id FROM webhook_event WHERE "eventType" <> 'refund.failed' LIMIT 1`)).id;
      await expect(insertFinality(app, x.attemptId, { source: 'webhook', webhook: other })).rejects.toMatchObject({ constraint: 'refund_failure_finality_webhook' });
      // LABELLED FIXTURE: the same attempt under another provider id: the simulation's certificate certifies nothing for it
      await fixture(`UPDATE refund_attempt SET provider = 'test' WHERE id = $1`, [x.attemptId]);
      await expect(insertFinality(app, x.attemptId)).rejects.toMatchObject(CERT);
      await fixture(`UPDATE refund_attempt SET provider = 'simulation' WHERE id = $1`, [x.attemptId]);
      expect(await finalityOf(x.attemptId)).toEqual([]);
    });

    it('T5 the evidence exists only with the failure it describes: same transaction, same code; derived values; the caller\'s forged ones are ignored', async () => {
      const x = await submitted();
      await expect(inTx(app, (c) => insertFinality(c, x.attemptId))).rejects.toMatchObject({ constraint: 'refund_failure_finality_transition' });
      await expect(inTx(app, async (c) => { await insertFinality(c, x.attemptId); await failSql(c, x.attemptId, 'other'); })).rejects.toMatchObject({ constraint: 'refund_failure_finality_transition' });
      await expect(inTx(app, async (c) => { await failSql(c, x.attemptId); await insertFinality(c, x.attemptId); })).rejects.toMatchObject({ constraint: 'refund_failure_finality_state' });
      expect((await row(x.attemptId)).status).toBe('submitted');
      const before = new Date();
      await inTx(app, async (c) => { await insertFinality(c, x.attemptId); await failSql(c, x.attemptId); });
      const [n] = await finalityOf(x.attemptId);
      expect(n).toMatchObject({ paymentId: x.paymentId, provider: 'simulation', idempotencyKey: x.attemptId });
      expect(n.recordedAt.getTime()).toBeGreaterThan(before.getTime() - 60_000);
      await expect(insertFinality(app, x.attemptId)).rejects.toMatchObject({ code: '23514' }); // once, and no longer in flight
    });

    it('T6 expiry: not yet valid and expired certify nothing; evidence recorded in time stays, unchanged, but permits nothing once its certificate expired', async () => {
      const x = await submitted();
      const future = await seed({ issuedAt: '2099-01-01T00:00:00.000Z' });
      await expect(insertFinality(app, x.attemptId, future)).rejects.toMatchObject({ constraint: 'refund_failure_finality_certificate' });
      const past = await seed({ issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-02-01T00:00:00.000Z' });
      await expect(insertFinality(app, x.attemptId, past)).rejects.toMatchObject({ constraint: 'refund_failure_finality_certificate' });
      const expiresAt = new Date((await one('SELECT clock_timestamp() AS now')).now.getTime() + 2500);
      const soon = await seed({ expiresAt: expiresAt.toISOString() });
      await inTx(app, async (c) => { await insertFinality(c, x.attemptId, soon); await failSql(c, x.attemptId); });
      expect(await mayStillPay(x.attemptId)).toBe(false); // valid at the observation, and still now
      const evidenceRow = await finalityOf(x.attemptId);
      // a transaction that began before the expiry decides at the clock after its locks, not at its start
      const late = await open(app, (c) => c.query('SELECT now()'));
      await new Promise((r) => setTimeout(r, Math.max(0, expiresAt.getTime() - Date.now()) + 600));
      await expect(insertAttempt(late.c, x.attemptId)).rejects.toMatchObject(PRIOR);
      await late.end('ROLLBACK');
      expect(await mayStillPay(x.attemptId)).toBe(true);
      expect(await finalityOf(x.attemptId)).toEqual(evidenceRow);
    });

    it('T7 tampered or superseded evidence: a changed fingerprint permits nothing in either layer; a NEWER version neither ends nor rescues older evidence', async () => {
      const x = await certifiedFailure();
      await fixture(`UPDATE refund_attempt_failure_finality SET "certificateFingerprint" = repeat('f', 64) WHERE "refundAttemptId" = $1`, [x.attemptId]);
      expect(await mayStillPay(x.attemptId)).toBe(true);
      await certified(async () => expect(refusedIn(await requestRefund(x.paymentId, x.caseId))).toEqual(REFUSED));
      const v1 = await seed();
      const y = await submitted();
      await inTx(app, async (c) => { await insertFinality(c, y.attemptId, v1); await failSql(c, y.attemptId); });
      await seed({ id: v1.cert, version: 2 });
      expect(await mayStillPay(y.attemptId)).toBe(false); // explicit supersession only
      await revoke(mig, { id: v1.cert, version: 1 });
      expect(await mayStillPay(y.attemptId)).toBe(true); // version 2 does not stand in for it
      await fixture(`DELETE FROM refund_capability_revocation WHERE "certificateId" = $1`, [v1.cert]);
    });

    it('T8 a fixed snapshot is refused: REPEATABLE READ and SERIALIZABLE decide nothing', async () => {
      const x = await certifiedFailure();
      for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
        await expect(inTx(app, (c) => insertAttempt(c, x.attemptId), level)).rejects.toMatchObject({ constraint: 'refund_finality_isolation' });
        const y = await submitted();
        await expect(inTx(app, (c) => insertFinality(c, y.attemptId), level)).rejects.toMatchObject({ constraint: 'refund_finality_isolation' });
        await expect(inTx(app, (c) => failSql(c, y.attemptId), level)).rejects.toMatchObject({ constraint: 'refund_finality_isolation' });
      }
    });

    it('T9 ambiguous evidence under the failed attempt\'s exact provider reference (an unmatched refund fact) is not final: no replacement; it is attributed to nothing', async () => {
      const x = await certifiedFailure();
      const reference = (await row(x.attemptId)).providerRefundId as string;
      expect(reference).toBeTruthy();
      const body = { eventId: `u_${randomUUID()}`, type: 'refund.succeeded', reference: `unknown-${randomUUID()}`, providerTransactionId: reference, amount: 9000, currency: 'TND' };
      await signed(body);
      await certified(async () => expect(refusedIn(await requestRefund(x.paymentId, x.caseId))).toEqual(REFUSED)); // the notification alone (application layer)
      await fixture(`UPDATE webhook_event SET "receivedAt" = now() - interval '301 seconds' WHERE "providerEventId" = $1`, [body.eventId]); // LABELLED FIXTURE: its age
      await signed(body);
      expect(await mayStillPay(x.attemptId)).toBe(true); // the verified fact (database layer)
      await expect(insertAttempt(app, x.attemptId)).rejects.toMatchObject(PRIOR);
      expect((await one(`SELECT "refundAttemptId" FROM provider_transaction_fact WHERE "providerTxnId" = $1 AND kind = 'refund'`, [reference])).refundAttemptId).toBeNull();
    });
  });

  describe('revocation races (lock order: payment, attempt, capability last)', () => {
    it('R1 a revocation in progress, then a replacement: the replacement waits and is refused; the evidence is unchanged', async () => {
      const x = await certifiedFailure();
      const evidenceRow = await finalityOf(x.attemptId);
      const rev = await open(mig, (c) => revoke(c));
      const pending = certified(() => requestRefund(x.paymentId, x.caseId, { x: t2 }));
      await waitsForAdvisoryLock();
      await rev.end();
      expect(refusedIn(await pending)).toEqual(REFUSED);
      expect(await finalityOf(x.attemptId)).toEqual(evidenceRow);
      await unrevoke();
    });

    it('R1b the same race at the database alone: a direct insert waits for the revocation and is refused', async () => {
      const x = await certifiedFailure();
      const rev = await open(mig, (c) => revoke(c));
      const pending = insertAttempt(app, x.attemptId).then(() => null, (e: Row) => e);
      await waitsForAdvisoryLock();
      await rev.end();
      expect(await pending).toMatchObject(PRIOR);
      await unrevoke();
    });

    it('R2 a replacement in progress, then a revocation: the revocation waits for it; the created attempt is then never sent (re-evaluated at dispatch)', async () => {
      const x = await certifiedFailure();
      const id = randomUUID();
      const ins = await open(app, (c) => insertAttempt(c, x.attemptId, id));
      const rev = revoke();
      await waitsForAdvisoryLock();
      await ins.end();
      await rev;
      await fixture(`UPDATE refund_attempt SET status = 'authorized', "receiptId" = gen_random_uuid(), "approvedByUserId" = $2, "consumedAt" = now(), "authorizedAt" = now() WHERE id = $1`, [id, OWNER]); // LABELLED FIXTURE: its receipt
      await certified(async () => {
        await drain(id);
        await drain(id, worker2);
        await databaseAlone(() => drain(id));
      });
      expect([(await row(id)).status, await received(id)]).toEqual(['authorized', 0]);
      expect(await providerRefunds(x.paymentId)).toBe(1);
      await unrevoke();
    });

    it('R3 a revocation in progress, then a dispatch: the worker waits and sends nothing', async () => {
      const x = await certifiedFailure();
      const r = await certified(() => requestRefund(x.paymentId, x.caseId));
      const rev = await open(mig, (c) => revoke(c));
      const pass = certified(() => drain(r.attemptId));
      await waitsForAdvisoryLock();
      await rev.end();
      await pass;
      expect([(await row(r.attemptId)).status, await received(r.attemptId)]).toEqual(['authorized', 0]);
      await unrevoke();
    });

    it('R4 BOUNDARY: a revocation after `dispatching` committed cannot recall that send, but a resend of its key is withheld', async () => {
      const x = await certifiedFailure();
      const r = await certified(() => requestRefund(x.paymentId, x.caseId));
      const dispatching = await open(app, (c) => c.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1`, [r.attemptId])); // crashed before the provider call
      const rev = revoke();
      await waitsForAdvisoryLock(); // the revocation waits for the transaction that used the certificate
      await dispatching.end();
      await rev;
      await certified(async () => {
        await drain(r.attemptId);
        await drain(r.attemptId, worker2);
      });
      expect([(await row(r.attemptId)).status, await received(r.attemptId)]).toEqual(['dispatching', 0]);
      await unrevoke();
      await certified(() => drain(r.attemptId));
      expect(await received(r.attemptId)).toBe(1); // the same key, once
    });

    it('R5 a revocation in progress while a failure is recorded: the failure is kept, uncertified; never lost, never final', async () => {
      const x = await submitted();
      const rev = await open(mig, (c) => revoke(c));
      const pending = certified(() => fail(x.attemptId));
      await waitsForAdvisoryLock();
      await rev.end();
      await pending;
      expect((await row(x.attemptId)).status).toBe('failed');
      expect(await finalityOf(x.attemptId)).toEqual([]);
      await unrevoke();
      await certified(async () => expect(refusedIn(await requestRefund(x.paymentId, x.caseId))).toEqual(REFUSED)); // not backfilled
    });

    it('R6 many rounds of revocation against replacements on two instances: after a committed revocation nothing is ever created or sent', async () => {
      for (let i = 0; i < 6; i++) {
        const x = await certifiedFailure();
        const [created] = await Promise.all([certified(() => requestRefund(x.paymentId, x.caseId, { x: i % 2 ? t : t2 })), revoke()]);
        await certified(async () => {
          expect((await requestRefund(x.paymentId, randomUUID())).res.status).toBe(409);
          if (created.res.status === 201) await drain(created.attemptId, i % 2 ? worker : worker2);
        });
        expect(await providerRefunds(x.paymentId)).toBe(1);
        await unrevoke();
      }
    });
  });

  describe('OD-DR1-1: an attempt with its own verified refund fact never becomes failed', () => {
    const neverFailed = async (x: { attemptId: string; paymentId: string; caseId: string }, status: string) => {
      expect((await row(x.attemptId)).status).toBe(status);
      expect(await escalationsOf(x.attemptId)).toHaveLength(1);
      expect(await finalityOf(x.attemptId)).toEqual([]);
      expect(await factsOf(x.attemptId)).toHaveLength(1);
      expect((await requestRefund(x.paymentId, x.caseId)).res.status).toBe(409);
    };
    it('O1 webhook and status-read failures, duplicated, on two instances, under certified finality: kept once, still in flight, then decided by its success', async () => {
      const x = await submitted();
      const fact = await evidence().recordRefundFact(x.attemptId, success(x.attemptId), jobContext('refund_worker')); // LABELLED FIXTURE: a crash after the fact
      await certified(async () => {
        await fail(x.attemptId);
        await fail(x.attemptId, 'insufficient_funds');
        await Promise.all([t, t2].map((i) => evidence(i).apply(x.attemptId, { kind: 'failed', failureCode: 'declined' }, jobContext('refund_worker'))));
      });
      await neverFailed(x, 'submitted');
      await evidence(t2).apply(x.attemptId, success(x.attemptId), jobContext('refund_worker')); // after a restart
      expect(await row(x.attemptId)).toMatchObject({ status: 'succeeded', succeededFactId: fact.id });
    });

    it('O2 a certified dispatch refusal after its own fact: kept, still dispatching, no finality, its key never sent again', async () => {
      const x = await authorized();
      await sim(`payments/${x.paymentId}/refund-dispatch-plan`, { commandId: cmd(), mode: 'rejected', failureCode: 'declined' }).expect(201);
      const s = t.app.get(SimulationPaymentProvider);
      const original = s.refund.bind(s);
      Object.defineProperty(s, 'refund', { configurable: true, writable: true, value: async (d: Parameters<typeof original>[0]) => {
        const r = await original(d);
        await evidence().recordRefundFact(x.attemptId, success(x.attemptId), jobContext('refund_worker'));
        return r;
      } });
      try {
        await certified(() => drain(x.attemptId));
      } finally {
        delete (s as unknown as Row).refund;
      }
      await certified(async () => {
        await drain(x.attemptId);
        await drain(x.attemptId, worker2);
      });
      await neverFailed(x, 'dispatching');
      expect(await received(x.attemptId)).toBe(1);
    });

    it('O3 success and failure reported concurrently on two instances, many rounds: never failed once the fact exists first; every fact kept; nothing replaceable', async () => {
      for (let i = 0; i < 8; i++) {
        const x = await submitted();
        await certified(() => Promise.allSettled([
          evidence(t).apply(x.attemptId, success(x.attemptId), jobContext('refund_worker')),
          evidence(t2).apply(x.attemptId, { kind: 'failed', failureCode: 'declined' }, jobContext('refund_worker')),
        ]));
        const a = await row(x.attemptId);
        expect(await factsOf(x.attemptId)).toHaveLength(1);
        expect(['succeeded', 'discrepancy']).toContain(a.status); // failure first, then the success: discrepancy (S6b); success first: it stands
        if (a.status === 'succeeded') expect(await escalationsOf(x.attemptId)).toHaveLength(1);
        expect(await mayStillPay(x.attemptId)).toBe(true);
        await certified(async () => expect((await requestRefund(x.paymentId, randomUUID())).res.status).toBe(409));
      }
    });

    it('O4 the database refuses the move itself, and waits for a fact still being written', async () => {
      const x = await submitted();
      await evidence().recordRefundFact(x.attemptId, success(x.attemptId), jobContext('refund_worker'));
      for (const q of [app, mig]) await expect(failSql(q, x.attemptId)).rejects.toMatchObject({ code: '23514', constraint: 'refund_attempt_failed_after_refund_fact' });
      const y = await submitted();
      const a = await row(y.attemptId);
      const writing = await open(app, (c) => c.query(
        `INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", "refundAttemptId", amount, currency, "liveMode", source)
         VALUES ('simulation', $1, 'refund', $2, $3, $4, 9000, 'TND', false, 'status_check')`, [`simr_${y.attemptId}`, a.paymentId, a.capturedAttemptId, a.id]));
      const moving = failSql(app, y.attemptId).then(() => null, (e: Row) => e);
      await new Promise((r) => setTimeout(r, 200));
      await writing.end();
      expect(await moving).toMatchObject({ constraint: 'refund_attempt_failed_after_refund_fact' });
      // and no finality on a capture that has evidence
      await expect(insertFinality(app, y.attemptId)).rejects.toMatchObject({ constraint: 'refund_failure_finality_evidence' });
    });
  });

  describe('atomicity, restart and the rest of the guard', () => {
    it('A0 no lock inversion: a direct move to failed never waits for the payment row, so it cannot deadlock with a holder of payment then attempt', async () => {
      const x = await submitted();
      const holder = await open(app, (c) => c.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [x.paymentId])); // `lockAttempt`, its first lock
      const direct = await open(app, (c) => c.query(`SET LOCAL lock_timeout = '3s'`));
      await failSql(direct.c, x.attemptId); // returns at once: it needs only the attempt row
      const then = holder.c.query('SELECT 1 FROM refund_attempt WHERE id = $1 FOR UPDATE', [x.attemptId]); // `lockAttempt`, its second lock
      await direct.end();
      await then;
      await holder.end();
      expect((await row(x.attemptId)).status).toBe('failed');
      await expect(insertAttempt(app, x.attemptId)).rejects.toMatchObject(PRIOR);
    });

    it('A0b a replacement racing an uncommitted move to failed waits for it, then is refused (uncertified) or admitted (certified in the same transaction)', async () => {
      for (const cert of [false, true]) {
        const x = await submitted();
        const moving = await open(app, async (c) => {
          if (cert) await insertFinality(c, x.attemptId);
          await failSql(c, x.attemptId);
        });
        const racing = insertAttempt(app, x.attemptId).then((r) => r.rowCount, (e: Row) => e.constraint);
        await new Promise((r) => setTimeout(r, 150));
        await moving.end();
        expect(await racing).toBe(cert ? 1 : PRIOR.constraint);
      }
    });

    it('A1 the failure and its finality commit together or not at all; the redelivery records both', async () => {
      const x = await submitted();
      await admin.query(`CREATE FUNCTION dr1b_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.name = 'audit.refund_attempt.failed' THEN RAISE EXCEPTION 'injected outbox failure'; END IF; RETURN NEW; END $$`);
      await admin.query(`GRANT EXECUTE ON FUNCTION dr1b_fail_audit() TO PUBLIC`);
      await admin.query(`CREATE TRIGGER zz_dr1b_fail BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION dr1b_fail_audit()`);
      try {
        await certified(() => evidence().apply(x.attemptId, { kind: 'failed', failureCode: 'declined' }, jobContext('refund_worker')).then(() => { throw new Error('committed'); }, () => undefined));
        expect((await row(x.attemptId)).status).toBe('submitted');
        expect(await finalityOf(x.attemptId)).toEqual([]);
      } finally {
        await admin.query(`DROP TRIGGER zz_dr1b_fail ON outbox`);
        await admin.query(`DROP FUNCTION dr1b_fail_audit()`);
      }
      await certified(() => evidence(t2).apply(x.attemptId, { kind: 'failed', failureCode: 'declined' }, jobContext('refund_worker'))); // another instance, after the crash
      expect((await row(x.attemptId)).status).toBe('failed');
      expect(await finalityOf(x.attemptId)).toHaveLength(1);
    });

    it('A2 in-flight, unknown and authorization outcomes keep their rules: effective ones block by the same indexes, refused and expired ones never block', async () => {
      const x = await submitted();
      await expect(insertAttempt(app, x.attemptId)).rejects.toMatchObject({ code: '23505' }); // the one-effective index, first and unchanged
      const u = await authorized();
      await sim(`payments/${u.paymentId}/refund-dispatch-plan`, { commandId: cmd(), mode: 'ambiguous' }).expect(201);
      await drain(u.attemptId);
      expect((await row(u.attemptId)).status).toBe('unknown');
      await certified(async () => expect(refusedIn(await requestRefund(u.paymentId, u.caseId))).toEqual(REFUSED));
      const { paymentId } = await captured();
      const caseId = randomUUID();
      const bad = auth.issue({ operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId, amount: 9000, currency: 'TND', reason: 'duplicate_charge', legalOverride: false }, OWNER);
      const refused = await post(t, `/payment/payments/${paymentId}/refunds`, billing.token, { refundAttemptId: randomUUID(), refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: bad.secret });
      expect(refused.status).toBe(409);
      expect((await requestRefund(paymentId, caseId)).res.status).toBe(201); // authorization_refused was never sent
    });

    it('A3 no caller, Owner receipt or internal call bypasses it: commitAuthorized of a blocked id has no attempt to authorize (OD-DR1-5)', async () => {
      const x = await submitted();
      await fail(x.attemptId);
      const r = await requestRefund(x.paymentId, x.caseId);
      const service = t.app.get(RefundAttemptService);
      await expect(service.commitAuthorized(r.attemptId, { receiptId: randomUUID(), approvedByUserId: OWNER, consumedAt: new Date() } as never, jobContext('refund_worker'))).rejects.toBeTruthy();
      expect(await row(r.attemptId)).toBeUndefined();
    });

    it('A4 the LAST capture of the settling attempt: a capture whose failed refund may still pay does not count as kept; certified, it does', async () => {
      const setup = async () => {
        const c = await captured();
        const txn = `sim_dup_${randomUUID()}`;
        await signed({ eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: c.attemptId, providerTransactionId: txn, amount: 9000, currency: 'TND' }).expect(200);
        const facts = (await admin.query(`SELECT id FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture' ORDER BY "observedAt", id`, [c.paymentId])).rows.map((f) => f.id as string);
        const first = await requestRefund(c.paymentId, randomUUID(), { captureFactId: facts[0]! });
        expect(first.res.status, JSON.stringify(first.res.body)).toBe(201);
        await drain(first.attemptId);
        return { ...c, facts, first: first.attemptId };
      };
      const u = await setup();
      await fail(u.first);
      const second = await requestRefund(u.paymentId, randomUUID(), { captureFactId: u.facts[1]! });
      expect(refusedIn(second)).toEqual([409, 'refund_capture_not_eligible']);
      const direct = (q: pg.Pool) => q.query(
        `INSERT INTO refund_attempt (id, "paymentId", producer, "refundCaseId", "companyId", amount, currency, reason, "legalOverride", "captureFactId", "capturedAttemptId", provider, "liveMode", "receiptDigest", "captureSpecific")
         SELECT gen_random_uuid(), "paymentId", producer, gen_random_uuid(), "companyId", amount, currency, reason, "legalOverride", $2, "capturedAttemptId", provider, "liveMode", repeat('c', 64), true FROM refund_attempt WHERE id = $1`, [u.first, u.facts[1]]);
      await expect(direct(app)).rejects.toMatchObject({ code: '23514', constraint: 'refund_attempt_last_capture_may_still_pay' });

      const k = await setup();
      await certified(() => fail(k.first));
      const ok = await certified(() => requestRefund(k.paymentId, randomUUID(), { captureFactId: k.facts[1]! }));
      expect([ok.res.status, ok.res.body.status], JSON.stringify(ok.res.body)).toEqual([201, 'authorized']);
      await revoke(); // between creation and dispatch
      await certified(async () => {
        await drain(ok.attemptId);
        await databaseAlone(() => drain(ok.attemptId));
      });
      expect(await received(ok.attemptId)).toBe(0);
      await expect(app.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1`, [ok.attemptId])).rejects.toMatchObject({ constraint: 'refund_attempt_last_capture_may_still_pay' });
      await unrevoke();
      await certified(() => drain(ok.attemptId));
      expect(await received(ok.attemptId)).toBe(1);
    });

    it('A5 refunds of different captures stay isolated: an uncertified failure on one payment never blocks another payment', async () => {
      const x = await submitted();
      await fail(x.attemptId);
      const y = await submitted();
      await outcome(y.attemptId, { outcome: 'succeeded' });
      expect((await row(y.attemptId)).status).toBe('succeeded');
    });

    it('M1 MUTATION CONTROLS: each database guard, dropped in a rolled-back transaction, is what refuses', async () => {
      const x = await submitted();
      await fail(x.attemptId);
      const mutated = async (drop: string, then: (c: pg.PoolClient) => Promise<unknown>) => {
        const m = await open(admin, async (c) => { await c.query(drop); });
        try {
          return await then(m.c);
        } finally {
          await m.end('ROLLBACK');
        }
      };
      expect(((await mutated('DROP TRIGGER refund_attempt_22_prior_may_still_pay ON refund_attempt', (c) => insertAttempt(c, x.attemptId))) as pg.QueryResult).rowCount).toBe(1);
      await expect(insertAttempt(admin, x.attemptId)).rejects.toMatchObject(PRIOR);

      const y = await certifiedFailure();
      const r = await certified(() => requestRefund(y.paymentId, y.caseId));
      await fixture(`DELETE FROM refund_attempt_failure_finality WHERE "refundAttemptId" = $1`, [y.attemptId]);
      const dispatch = `UPDATE refund_attempt SET status = 'dispatching' WHERE id = '${r.attemptId}'`;
      expect(((await mutated('DROP TRIGGER refund_attempt_09b_prior_may_still_pay ON refund_attempt', (c) => c.query(dispatch))) as pg.QueryResult).rowCount).toBe(1);
      await expect(admin.query(dispatch)).rejects.toMatchObject(PRIOR);

      const z = await submitted();
      await evidence().recordRefundFact(z.attemptId, success(z.attemptId), jobContext('refund_worker'));
      expect(((await mutated('DROP TRIGGER refund_attempt_07b_failed_after_fact ON refund_attempt', (c) => failSql(c, z.attemptId))) as pg.QueryResult).rowCount).toBe(1);

      const h = await submitted();
      await mutated('DROP TRIGGER refund_attempt_failure_finality_05_insert_guard ON refund_attempt_failure_finality', async (c) => {
        await expect(insertFinality(c, h.attemptId, { fingerprint: 'f'.repeat(64) })).rejects.toMatchObject({ code: expect.stringMatching(/^23/) }); // the keys and checks remain
      });
      // without the writer's lock (triggers off) a revocation no longer waits for the decision that is using the certificate: the lock is what orders them
      const w = await certifiedFailure();
      const using = await open(app, (q) => insertAttempt(q, w.attemptId));
      const unlocked = await open(admin, async (c) => {
        await c.query('SET LOCAL session_replication_role = replica');
        await revoke(c);
      });
      await unlocked.end('ROLLBACK');
      await using.end('ROLLBACK');
    });
  });
});

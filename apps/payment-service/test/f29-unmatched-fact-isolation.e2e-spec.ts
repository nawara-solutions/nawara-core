import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import type { OwnerCompanyAuthority, VerifiedOwner } from '../src/disputes/owner-company.authority.js';
import { NO_UNMATCHED_FACT_AUTHORITY } from '../src/reconciliation/unmatched-fact-authority.js';
import { receiptDigest } from '../src/refunds/refund.types.js';
import { UNMATCHED_FACT_GRACE_MS } from '../src/webhooks/webhook.service.js';
import { TEST_PLATFORM, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { startFakeReceiptServer, type FakeReceiptServer } from './support/fake-receipts.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '2f1b8d6c-4e3a-4b7c-8d9e-0f1a2b3c4d5e';
const COMPANY_A = '5b0c2f4e-1d3a-4c6b-8e9f-0a1b2c3d4e5f';
const COMPANY_B = '6c1d3e5f-2a4b-4d7c-9e0f-1a2b3c4d5e6f';
const OWNER_A = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const OWNER_B = '8e7d6c5b-4a3f-4e2d-9c1b-0a9f8e7d6c5b';
const MEMBER = '9f8e7d6c-5b4a-4f3e-8d2c-1b0a9f8e7d6c';
const SECRET = randomBytes(32).toString('hex');
type Row = Record<string, any>;

/**
 * Finding F-29 (register PAY-12 G, PAY-13 H; Accepted ADR-0050): through the APPLICATION'S OWN WIRING, on real PostgreSQL 16 and the signed webhook
 * pipeline: no Owner of any Company may observe, appropriate, associate or refund an unscoped provider fact. Two Companies, each with its Owner.
 */
describeWithEnv('F-29 unmatched fact tenant isolation — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let auth: FakeReceiptServer;
  const billing = generateServiceToken();
  const harness = generateServiceToken();
  const identities: Record<string, AuthIdentity> = {
    'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] },
    'owner-a-jwt': { id: OWNER_A, adminTier: 'owner', isActive: true, memberships: [] },
    'owner-b-jwt': { id: OWNER_B, adminTier: 'owner', isActive: true, memberships: [] },
    'member-jwt': { id: MEMBER, adminTier: null, isActive: true, memberships: [] },
  };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const owners: Record<string, VerifiedOwner> = { 'owner-a-jwt': { userId: OWNER_A, companyId: COMPANY_A }, 'owner-b-jwt': { userId: OWNER_B, companyId: COMPANY_B } };
  const ownerAuthority: OwnerCompanyAuthority = { owner: async (bearer) => owners[bearer] ?? null };
  const server = () => t.app.getHttpServer();
  const key = () => `k-${randomUUID()}`;
  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n);

  const createPayment = async (company: string, over: Row = {}) => {
    const r = await request(server()).post('/payment/payments').set('authorization', `Bearer ${billing.token}`).send({
      paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
      seller: { type: 'company', id: company }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER, ...over,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const startAttempt = async (pid: string) => (await request(server()).post(`/payment/payments/${pid}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({ provider: 'simulation' }).expect(201)).body;
  const captured = async (company: string) => {
    const payment = await createPayment(company);
    const attempt = await startAttempt(payment.id);
    await request(server()).post(`/payment/simulation/payments/${payment.id}/attempts/${attempt.id}/outcomes`).set('authorization', `Bearer ${harness.token}`)
      .send({ commandId: `cmd-${randomUUID()}`, outcome: 'succeeded' }).expect(201);
    return { payment, attempt, fact: await one(`SELECT * FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture'`, [payment.id]) };
  };
  const signed = (body: Row) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    return request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json')
      .set('x-simulation-signature', createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw.toString('utf8'));
  };
  const ageWebhook = async (providerEventId: string) => {
    const cl = await admin.connect();
    try {
      await cl.query(`SET session_replication_role = replica`);
      await cl.query(`UPDATE webhook_event SET "receivedAt" = now() - make_interval(secs => $2) WHERE "providerEventId" = $1`, [providerEventId, UNMATCHED_FACT_GRACE_MS / 1000 + 1]);
    } finally {
      await cl.query(`SET session_replication_role = origin`);
      cl.release();
    }
  };
  /** A signed provider movement naming no attempt, kept as an unmatched fact. `extra` is whatever the provider chooses to assert. */
  const unmatched = async (o: { type?: string; reference?: string; extra?: Row } = {}) => {
    const body = { eventId: `x_${randomUUID()}`, type: o.type ?? 'payment.succeeded', reference: o.reference ?? randomUUID(), providerTransactionId: `sim_x_${randomUUID()}`,
      amount: 9000, currency: 'TND', ...o.extra };
    await signed(body).expect(200);
    await ageWebhook(body.eventId);
    await signed(body).expect(200);
    const fact = await one(`SELECT * FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [body.providerTransactionId]);
    expect(fact).toMatchObject({ paymentId: null, attemptId: null });
    return { body, fact };
  };
  const items = (kind: string, bearer: string, query = '') => request(server()).get(`/payment/admin/reconciliation-items?kind=${kind}${query}`).set('authorization', `Bearer ${bearer}`);
  const binding = (fact: Row, targetType: string, targetId: string, companyId: string) => ({
    operation: 'provider_fact_associate', audience: 'payment-service', companyId, factId: fact.id, kind: fact.kind, amount: Number(fact.amount), currency: fact.currency.trim(), targetType, targetId,
  });
  const associate = (factId: string, send: Row, bearer: string, k = key()) =>
    request(server()).post(`/payment/admin/provider-facts/${factId}/associations`).set('authorization', `Bearer ${bearer}`).set('idempotency-key', k).send(send);
  /** The refusal, with its per-request identifiers removed: what a caller could compare to learn anything. */
  const refusal = (res: { status: number; body: Row }) => ({ status: res.status, code: res.body.code, message: res.body.message });
  const expectIndistinguishableFromUnknown = async (res: { status: number; body: Row }, send: Row, bearer: string, secrets: string[]) => {
    const unknown = await associate(randomUUID(), send, bearer);
    expect(refusal(res)).toEqual(refusal(unknown));
    expect(res.status).toBe(404);
    for (const s of secrets) expect(JSON.stringify(res.body)).not.toContain(s);
  };
  const noFinancialEffect = async (fact: Row) => {
    expect(await one(`SELECT * FROM provider_transaction_fact WHERE id = $1`, [fact.id])).toEqual(fact); // FC-1: the same row, byte for byte
    expect(await count(`SELECT count(*) AS n FROM provider_fact_association WHERE "factId" = $1`, [fact.id])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM refund_attempt WHERE "captureFactId" = $1`, [fact.id])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.provider_fact.associated' AND payload->'resource'->>'id' = $1`, [fact.id])).toBe(0);
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentf29');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 8 });
    auth = await startFakeReceiptServer();
    t = await createTestApp({ // no `unmatchedFactAuthority`: the application's own wiring
      databaseUrl: db.url, authClient, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], refundWorker: false, ownerAuthority,
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token, PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SUPPORTED_CURRENCIES: 'TND,EUR', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET,
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create', 'payment.reconciliation.read'], allowedPlatforms: [TEST_PLATFORM] },
          'simulation-harness': { operations: ['payment.simulation.resolve'], allowedPlatforms: [] },
        } }),
      },
    });
  });
  afterAll(async () => {
    await t?.app.close();
    await auth?.close();
    await admin?.end();
    await db?.drop();
  });

  describe('the read', () => {
    it('no Owner of either Company reads an unmatched fact, and nothing about it appears in the answer', async () => {
      const { fact, body } = await unmatched();
      for (const bearer of ['owner-a-jwt', 'owner-b-jwt']) {
        for (const query of ['', '&limit=200', `&after=${randomUUID()}`]) {
          const res = await items('unmatched_fact', bearer, query);
          expect([res.status, res.body.code]).toEqual([400, 'invalid_reconciliation_request']);
          for (const s of [fact.id, body.providerTransactionId]) expect(JSON.stringify(res.body)).not.toContain(s);
        }
      }
      expect((await items('unmatched_fact', 'member-jwt')).status).toBe(403);
      expect((await request(server()).get('/payment/reconciliation/items?kind=unmatched_fact').set('authorization', `Bearer ${billing.token}`)).body.code).toBe('invalid_reconciliation_request');
      await noFinancialEffect(fact);
    });

    it('no other kind or balance carries an unassociated unmatched fact, for either Owner', async () => {
      const { fact } = await unmatched();
      for (const bearer of ['owner-a-jwt', 'owner-b-jwt']) {
        for (const kind of ['fact_conflict', 'late_success', 'allocation_blocked', 'over_return', 'refund_discrepancy', 'authorization_pending', 'chargeback', 'association', 'capture_refund_unavailable']) {
          const res = await items(kind, bearer, '&limit=200').expect(200);
          expect(JSON.stringify(res.body), kind).not.toContain(fact.id);
        }
        const before = (await request(server()).get('/payment/admin/balances').set('authorization', `Bearer ${bearer}`).expect(200)).body;
        await unmatched();
        expect((await request(server()).get('/payment/admin/balances').set('authorization', `Bearer ${bearer}`).expect(200)).body).toEqual(before);
      }
    });
  });

  describe('the association', () => {
    it('another Company\'s or any fact id, guessed or known, to a payment of the caller\'s own Company: 404 as an unknown id, nothing written, no receipt spent', async () => {
      const { fact, body } = await unmatched();
      const mine = await createPayment(COMPANY_B);
      await startAttempt(mine.id);
      const r = auth.issue(binding(fact, 'payment', mine.id, COMPANY_B), OWNER_B);
      const send = { targetType: 'payment', targetId: mine.id, receiptSecret: r.secret };
      const consumed = auth.calls.consume;
      const res = await associate(fact.id, send, 'owner-b-jwt');
      await expectIndistinguishableFromUnknown(res, send, 'owner-b-jwt', [String(fact.amount), body.providerTransactionId, r.secret]);
      expect(auth.calls.consume).toBe(consumed); // Auth was never asked
      expect(r.status).toBe('issued');
      await noFinancialEffect(fact);
    });

    it('to another Company\'s payment: the same refusal', async () => {
      const { fact } = await unmatched();
      const theirs = await createPayment(COMPANY_A);
      await startAttempt(theirs.id);
      const r = auth.issue(binding(fact, 'payment', theirs.id, COMPANY_B), OWNER_B);
      const send = { targetType: 'payment', targetId: theirs.id, receiptSecret: r.secret };
      await expectIndistinguishableFromUnknown(await associate(fact.id, send, 'owner-b-jwt'), send, 'owner-b-jwt', [r.secret]);
      expect(r.status).toBe('issued');
      await noFinancialEffect(fact);
    });

    it('a refund fact to a refund authorization target: the same refusal', async () => {
      const { fact } = await unmatched({ type: 'refund.succeeded' });
      const target = randomUUID();
      const r = auth.issue(binding(fact, 'refund_authorization', target, COMPANY_A), OWNER_A);
      const send = { targetType: 'refund_authorization', targetId: target, receiptSecret: r.secret };
      await expectIndistinguishableFromUnknown(await associate(fact.id, send, 'owner-a-jwt'), send, 'owner-a-jwt', [r.secret]);
      expect(r.status).toBe('issued');
      await noFinancialEffect(fact);
    });

    it('forged provider metadata creates no scope: a Company, Organization or seller claim, or a reference naming the caller\'s own payment', async () => {
      const mine = await createPayment(COMPANY_A);
      await startAttempt(mine.id);
      const { fact } = await unmatched({
        reference: mine.id,
        extra: { companyId: COMPANY_A, organizationId: randomUUID(), seller: { type: 'company', id: COMPANY_A }, metadata: { companyId: COMPANY_A, paymentId: mine.id } },
      });
      expect(fact).toMatchObject({ paymentId: null }); // a payment id is no attempt reference: still unmatched
      const r = auth.issue(binding(fact, 'payment', mine.id, COMPANY_A), OWNER_A);
      const send = { targetType: 'payment', targetId: mine.id, receiptSecret: r.secret };
      await expectIndistinguishableFromUnknown(await associate(fact.id, send, 'owner-a-jwt'), send, 'owner-a-jwt', [r.secret]);
      expect((await items('unmatched_fact', 'owner-a-jwt')).status).toBe(400);
      expect(r.status).toBe('issued');
      await noFinancialEffect(fact);
    });

    it('a valid Owner receipt and every replay of it establish nothing: the same key, the same receipt, concurrently', async () => {
      const { fact } = await unmatched();
      const mine = await createPayment(COMPANY_A);
      await startAttempt(mine.id);
      const r = auth.issue(binding(fact, 'payment', mine.id, COMPANY_A), OWNER_A);
      const send = { targetType: 'payment', targetId: mine.id, receiptSecret: r.secret };
      const k = key();
      for (let i = 0; i < 3; i++) expect((await associate(fact.id, send, 'owner-a-jwt', k)).status).toBe(404);
      const outs = await Promise.all(Array.from({ length: 6 }, () => associate(fact.id, send, 'owner-a-jwt')));
      expect(outs.every((o) => o.status === 404)).toBe(true);
      expect(r.status).toBe('issued');
      await noFinancialEffect(fact);
    });

    it('an intent or association recorded before this correction is never resumed or answered: the same key is refused, and the rows stay as they were', async () => {
      const { fact: pending } = await unmatched();
      const { fact: done } = await unmatched();
      const mine = await createPayment(COMPANY_A);
      const attempt = await startAttempt(mine.id);
      const seed = async (factId: string, k: string, secret: string) => (await one(
        `INSERT INTO provider_fact_association (id, "factId", "targetType", "paymentId", "companyId", "requestedByUserId", "idempotencyKey", "receiptDigest")
         VALUES ($1, $2, 'payment', $3, $4, $5, $6, $7) RETURNING *`, [randomUUID(), factId, mine.id, COMPANY_A, OWNER_A, k, receiptDigest(secret)]));
      const pk = key(); const dk = key();
      const pr = auth.issue(binding(pending, 'payment', mine.id, COMPANY_A), OWNER_A);
      const dr = auth.issue(binding(done, 'payment', mine.id, COMPANY_A), OWNER_A);
      const pendingRow = await seed(pending.id, pk, pr.secret);
      const doneRow = await seed(done.id, dk, dr.secret);
      const recorded = await one(`UPDATE provider_fact_association SET status = 'associated', "receiptId" = $2, "approvedByUserId" = $3, "associatedAt" = now() WHERE id = $1 RETURNING *`, [doneRow.id, randomUUID(), OWNER_A]);
      expect((await associate(pending.id, { targetType: 'payment', targetId: mine.id, receiptSecret: pr.secret }, 'owner-a-jwt', pk)).status).toBe(404);
      expect((await associate(done.id, { targetType: 'payment', targetId: mine.id, receiptSecret: dr.secret }, 'owner-a-jwt', dk)).status).toBe(404);
      expect(pr.status).toBe('issued');
      expect(await one(`SELECT * FROM provider_fact_association WHERE id = $1`, [pendingRow.id])).toEqual(pendingRow);
      expect(await one(`SELECT * FROM provider_fact_association WHERE id = $1`, [doneRow.id])).toEqual(recorded);
      // such a row is kept as evidence, but no refund returns that money
      await request(server()).post(`/payment/simulation/payments/${mine.id}/attempts/${attempt.id}/outcomes`).set('authorization', `Bearer ${harness.token}`)
        .send({ commandId: `cmd-${randomUUID()}`, outcome: 'expired' }).expect(201);
      await request(server()).post(`/payment/payments/${mine.id}/cancel`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key()).send({}).expect(200);
      const res = await request(server()).post(`/payment/payments/${mine.id}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
        .send({ refundAttemptId: randomUUID(), refundCaseId: randomUUID(), captureFactId: done.id, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: randomBytes(32).toString('base64url') });
      expect(res.body.code, JSON.stringify(res.body)).toBe('refund_capture_unverified');
      expect(await count(`SELECT count(*) AS n FROM refund_attempt WHERE "captureFactId" = $1`, [done.id])).toBe(0);
    });

    it('a matched fact: 409 to its own Company\'s Owner (unchanged); to another Company\'s Owner, 404 as an unknown id', async () => {
      const { payment, fact } = await captured(COMPANY_A);
      const r = auth.issue(binding(fact, 'payment', payment.id, COMPANY_A), OWNER_A);
      const send = { targetType: 'payment', targetId: payment.id, receiptSecret: r.secret };
      expect((await associate(fact.id, send, 'owner-a-jwt')).body.code).toBe('provider_fact_matched');
      await expectIndistinguishableFromUnknown(await associate(fact.id, send, 'owner-b-jwt'), send, 'owner-b-jwt', [fact.providerTxnId]);
    });

    it('a member and an unauthenticated caller stay refused before any of this', async () => {
      const { fact } = await unmatched();
      const send = { targetType: 'payment', targetId: randomUUID(), receiptSecret: 'x'.repeat(43) };
      expect((await associate(fact.id, send, 'member-jwt')).status).toBe(403);
      expect((await request(server()).post(`/payment/admin/provider-facts/${fact.id}/associations`).set('idempotency-key', key()).send(send)).status).toBe(401);
      await noFinancialEffect(fact);
    });
  });

  describe('no refund of an unscoped capture', () => {
    it('the capture read and a refund naming an unmatched fact are refused, with no attempt and no effect', async () => {
      const { fact } = await unmatched();
      const mine = await createPayment(COMPANY_A);
      await startAttempt(mine.id);
      expect((await request(server()).get(`/payment/payments/${mine.id}/captures/${fact.id}`).set('authorization', `Bearer ${billing.token}`)).status).toBe(404);
      await noFinancialEffect(fact);
    });
  });

  describe('properly scoped reconciliation is unchanged', () => {
    it('each Owner keeps their own Company\'s items and balances, and never the other\'s', async () => {
      const a = await captured(COMPANY_A);
      const b = await captured(COMPANY_B);
      const balance = (id: string, bearer: string) => request(server()).get(`/payment/admin/payments/${id}/balance`).set('authorization', `Bearer ${bearer}`);
      expect((await balance(a.payment.id, 'owner-a-jwt').expect(200)).body.currencies).toEqual([{ currency: 'TND', captured: 9000, refundedNet: 0, chargebackNet: 0, netRetained: 9000 }]);
      expect((await balance(a.payment.id, 'owner-b-jwt')).status).toBe(404);
      expect((await balance(b.payment.id, 'owner-b-jwt')).status).toBe(200);
      expect((await balance(b.payment.id, 'owner-a-jwt')).status).toBe(404);
      const conflict = signedConflict(a);
      await signed(conflict).expect(200);
      const seenA = (await items('fact_conflict', 'owner-a-jwt', '&limit=200').expect(200)).body.items as Row[];
      expect(seenA.some((i) => i.factId === a.fact.id)).toBe(true);
      const seenB = (await items('fact_conflict', 'owner-b-jwt', '&limit=200').expect(200)).body.items as Row[];
      expect(seenB.some((i) => i.factId === a.fact.id)).toBe(false);
    });
  });

  const signedConflict = (s: { attempt: Row; fact: Row }) => ({ eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: s.attempt.id, providerTransactionId: s.fact.providerTxnId, amount: 4500, currency: 'TND' });

  describe('the application\'s wiring', () => {
    it('provides only the refusing authority: no application code passes another', () => {
      expect(NO_UNMATCHED_FACT_AUTHORITY.authorizes({ userId: OWNER_A, companyId: COMPANY_A }, { id: randomUUID(), kind: 'capture', amount: '9000', currency: 'TND' })).toBe(false);
      const appModule = readFileSync(fileURLToPath(new URL('../src/app.module.ts', import.meta.url)), 'utf8');
      expect(appModule).toContain('ReconciliationModule.register(config),');
      expect(appModule).not.toContain('unmatchedFactAuthority');
    });
  });
});

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import type { PaymentConfig } from '../src/config/payment-config.js';
import { ownerAuthorityUnavailable, type OwnerCompanyAuthority, type VerifiedOwner } from '../src/disputes/owner-company.authority.js';
import { ReconciliationModule } from '../src/reconciliation/reconciliation.module.js';
import { AUTHORIZATION_PENDING_ITEM_AFTER_MINUTES } from '../src/reconciliation/reconciliation.service.js';
import { RefundWorker } from '../src/refunds/refund-worker.js';
import { UNMATCHED_FACT_GRACE_MS } from '../src/webhooks/webhook.service.js';
import { TEST_PLATFORM, createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { startFakeReceiptServer, type FakeReceiptServer } from './support/fake-receipts.js';

const paymentMigrationsDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
const BUYER = '2f1b8d6c-4e3a-4b7c-8d9e-0f1a2b3c4d5e';
const COMPANY = '5b0c2f4e-1d3a-4c6b-8e9f-0a1b2c3d4e5f';
const COMPANY2 = '6c1d3e5f-2a4b-4d7c-9e0f-1a2b3c4d5e6f';
const OWNER = '7d6c5b4a-3f2e-4d1c-8b0a-9f8e7d6c5b4a';
const OWNER2 = '8e7d6c5b-4a3f-4e2d-9c1b-0a9f8e7d6c5b';
const MEMBER = '9f8e7d6c-5b4a-4f3e-8d2c-1b0a9f8e7d6c';
const SECRET = randomBytes(32).toString('hex');
type Row = Record<string, any>;

/**
 * Core V2 S6h-P (register PAY-12, PAY-13, EVT-10; S0 FC-1, FC-2, FC-5; the Owner's R6H-1 to R6H-12) through the REAL application on real
 * PostgreSQL 16, on the simulation provider: provider money notifications are SIGNED and go through the webhook pipeline (verification, the
 * permanent event key, the evidence rules); Auth's receipt routes over real HTTP (the contract-faithful stand-in) and the live Owner check as a
 * test port. Development and simulation only.
 */
describeWithEnv('payment reconciliation (Core V2 S6h-P) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  let auth: FakeReceiptServer;
  const billing = generateServiceToken();
  const other = generateServiceToken();
  const harness = generateServiceToken();
  const identities: Record<string, AuthIdentity> = {
    'buyer-jwt': { id: BUYER, adminTier: null, isActive: true, memberships: [] },
    'owner-jwt': { id: OWNER, adminTier: 'owner', isActive: true, memberships: [] },
    'owner2-jwt': { id: OWNER2, adminTier: 'owner', isActive: true, memberships: [] },
    'member-jwt': { id: MEMBER, adminTier: null, isActive: true, memberships: [] },
  };
  const authClient: AuthClient = { getIdentity: async (bearer) => identities[bearer] ?? null, hasPlatformAccess: async () => false };
  const owners: Record<string, VerifiedOwner> = { 'owner-jwt': { userId: OWNER, companyId: COMPANY }, 'owner2-jwt': { userId: OWNER2, companyId: COMPANY2 } };
  const ownerState = { down: false };
  const ownerAuthority: OwnerCompanyAuthority = {
    owner: async (bearer) => {
      if (ownerState.down) throw ownerAuthorityUnavailable();
      return owners[bearer] ?? null;
    },
  };
  const server = () => t.app.getHttpServer();
  const cmd = () => `cmd-${randomUUID()}`;
  const key = () => `k-${randomUUID()}`;
  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n);

  const createPayment = async (over: Row = {}, token = billing.token) => {
    const r = await request(server()).post('/payment/payments').set('authorization', `Bearer ${token}`).send({
      paymentRequestId: randomUUID(), sourceType: 'invoice', sourceId: `inv-${randomUUID().slice(0, 8)}`, payer: { type: 'user', id: BUYER },
      seller: { type: 'company', id: COMPANY }, amount: 9000, currency: 'TND', purpose: 'direct_purchase', beneficiaryUserId: BUYER, ...over,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const startAttempt = async (pid: string) => (await request(server()).post(`/payment/payments/${pid}/attempts`).set('authorization', 'Bearer buyer-jwt').set('idempotency-key', key()).send({}).expect(201)).body;
  const sim = (path: string, send: Row) => request(server()).post(`/payment/simulation/${path}`).set('authorization', `Bearer ${harness.token}`).send(send);
  const outcome = async (pid: string, aid: string, send: Row) => (await sim(`payments/${pid}/attempts/${aid}/outcomes`, { commandId: cmd(), ...send }).expect(201)).body;
  const captured = async (over: Row = {}) => {
    const p = await createPayment(over);
    const a = await startAttempt(p.id);
    await outcome(p.id, a.id, { outcome: 'succeeded' });
    return { payment: p, attempt: a };
  };
  /** A provider notification built and SIGNED by hand: what a provider could send that the harness never would (an unknown reference...). */
  const signed = (body: Row, signature?: string) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    return request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json')
      .set('x-simulation-signature', signature ?? createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw.toString('utf8'));
  };
  /** A test-only bypass of webhook_event's immutability (as a superuser): the notification was received `secs` ago. */
  const ageWebhook = async (providerEventId: string, secs: number) => {
    const cl = await admin.connect();
    try {
      await cl.query(`SET session_replication_role = replica`);
      await cl.query(`UPDATE webhook_event SET "receivedAt" = now() - make_interval(secs => $2) WHERE "providerEventId" = $1`, [providerEventId, secs]);
    } finally {
      await cl.query(`SET session_replication_role = origin`);
      cl.release();
    }
  };
  /** A verified movement that names no attempt, delivered, aged past the grace window and delivered again (the same event). */
  const unmatched = async (o: { type?: 'payment.succeeded' | 'refund.succeeded'; amount?: number; currency?: string; txn?: string } = {}) => {
    const body = { eventId: `x_${randomUUID()}`, type: o.type ?? 'payment.succeeded', reference: randomUUID(), providerTransactionId: o.txn ?? `sim_x_${randomUUID()}`,
      amount: o.amount ?? 9000, currency: o.currency ?? 'TND' };
    await signed(body).expect(200);
    await ageWebhook(body.eventId, UNMATCHED_FACT_GRACE_MS / 1000 + 1);
    const second = await signed(body);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const f = await one(`SELECT * FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [body.providerTransactionId]);
    return { body, fact: f };
  };
  const ownerGet = (path: string, bearer = 'owner-jwt') => request(server()).get(`/payment/admin${path}`).set('authorization', `Bearer ${bearer}`);
  const itemsOf = async (kind: string, bearer = 'owner-jwt') => (await ownerGet(`/reconciliation-items?kind=${kind}&limit=200`, bearer).expect(200)).body.items as Row[];
  const serviceItems = (kind: string, token = billing.token) => request(server()).get(`/payment/reconciliation/items?kind=${kind}&limit=200`).set('authorization', `Bearer ${token}`);
  const assocBinding = (f: Row, targetType: string, targetId: string, over: Row = {}) => ({
    operation: 'provider_fact_associate', audience: 'payment-service', companyId: COMPANY, factId: f.id, kind: f.kind, amount: Number(f.amount), currency: f.currency.trim(),
    targetType, targetId, ...over,
  });
  const associate = (factId: string, send: Row, k = key(), bearer = 'owner-jwt') =>
    request(server()).post(`/payment/admin/provider-facts/${factId}/associations`).set('authorization', `Bearer ${bearer}`).set('idempotency-key', k).send(send);
  const refundBinding = (pid: string, caseId: string) => ({
    operation: 'refund', audience: 'payment-service', companyId: COMPANY, refundCaseId: caseId, paymentId: pid, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false,
  });
  /** An authorized refund of a captured payment (S6b), never dispatched here: the authorization the provider's refund will be allocated to. */
  const authorizedRefund = async () => {
    const { payment } = await captured();
    const caseId = randomUUID();
    const r = auth.issue(refundBinding(payment.id, caseId), OWNER);
    const res = await request(server()).post(`/payment/payments/${payment.id}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
      .send({ refundAttemptId: randomUUID(), refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: r.secret }).expect(201);
    const z = await one(`SELECT * FROM refund_authorization WHERE "refundAttemptId" = $1`, [res.body.refundAttemptId]);
    return { payment, caseId, attemptId: res.body.refundAttemptId as string, authorization: z };
  };
  const drainRefunds = async () => {
    await admin.query(`UPDATE refund_fact_allocation_lease SET "workAfter" = NULL`);
    return t.app.get(RefundWorker).drainOnce();
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'paymentrecon');
    await runMigrations(db.url, [kitMigrationsDir, paymentMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 16 });
    auth = await startFakeReceiptServer();
    t = await createTestApp({
      databaseUrl: db.url, authClient, migrationsDirs: [kitMigrationsDir, paymentMigrationsDir], refundWorker: false, ownerAuthority,
      // F-29: this suite certifies the dormant PAY-13 mechanism and its database guards, behind a stand-in no application wiring provides.
      // `f29-unmatched-fact-isolation.e2e-spec.ts` certifies the application's own wiring, which refuses every Owner.
      unmatchedFactAuthority: { authorizes: () => true },
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'other-producer', digest: other.digest }, { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token, PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SUPPORTED_CURRENCIES: 'TND,EUR', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET,
        PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE: '100000', // DO-74 adds attempts for one buyer; the file asserts no rate limit (as disputes/wrong-amount suites)
        PAYMENT_SERVICE_POLICY: JSON.stringify({ callers: {
          'billing-service': { operations: ['payment.create', 'payment.read', 'payment.cancel', 'payment.refund.create', 'payment.reconciliation.read'], allowedPlatforms: [TEST_PLATFORM] },
          'other-producer': { operations: ['payment.create', 'payment.read'], allowedPlatforms: [TEST_PLATFORM] },
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
  beforeEach(() => {
    ownerState.down = false;
    auth.unavailable.consume = 0;
    auth.unavailable.lookup = 0;
    auth.loseResponse.consume = 0;
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── late success (R6H-4)

  describe('late success after finality (R6H-4, EVT-10)', () => {
    it('a verified success after the payment ended is recorded once with its fact and ONE payment.late_success.recorded; the payment is never reopened', async () => {
      const p = await createPayment({ purpose: 'direct_purchase' });
      const a = await startAttempt(p.id);
      await outcome(p.id, a.id, { outcome: 'expired' });
      await request(server()).post(`/payment/payments/${p.id}/cancel`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key()).send({}).expect(200);
      expect((await one(`SELECT status FROM payment WHERE id = $1`, [p.id])).status).toBe('cancelled');
      const lateCommand = cmd();
      const late = await outcome(p.id, a.id, { commandId: lateCommand, outcome: 'succeeded' });
      expect(late.delivered).toEqual({ status: 200 });
      await sim(`commands/${lateCommand}/deliver`, {}).expect(200); // the provider redelivers: the same event
      const l = await one(`SELECT * FROM payment_late_success WHERE "paymentId" = $1`, [p.id]);
      expect(l).toMatchObject({ paymentStatus: 'cancelled', amount: '9000', factId: expect.any(String) });
      expect(await count(`SELECT count(*) AS n FROM payment_late_success WHERE "paymentId" = $1`, [p.id])).toBe(1);
      expect((await one(`SELECT status FROM payment WHERE id = $1`, [p.id])).status).toBe('cancelled');
      const events = (await admin.query(`SELECT name, payload FROM outbox WHERE payload->>'paymentId' = $1 AND name LIKE 'payment.%' ORDER BY "occurredAt", name`, [p.id])).rows;
      expect(events.filter((e) => e.name === 'payment.succeeded')).toEqual([]);
      const le = events.filter((e) => e.name === 'payment.late_success.recorded');
      expect(le).toHaveLength(1);
      expect(le[0]!.payload).toMatchObject({ lateSuccessId: l.id, paymentId: p.id, paymentRequestId: p.paymentRequestId, producer: 'billing-service', purpose: 'direct_purchase',
        attemptId: a.id, factId: l.factId, amount: 9000, currency: 'TND', paymentStatus: 'cancelled', liveMode: false });
      // event-loss recovery: the producer's read; never another producer's; never without the operation
      const items = (await serviceItems('late_success').expect(200)).body.items as Row[];
      expect(items.find((i) => i.id === l.id)).toMatchObject({ kind: 'late_success', paymentId: p.id, factId: l.factId, amount: 9000, detail: { paymentStatus: 'cancelled' } });
      expect((await serviceItems('late_success', other.token)).status).toBe(403);
      expect((await serviceItems('unmatched_fact')).body.code).toBe('invalid_reconciliation_request'); // no producer owns an unmatched fact
      expect((await itemsOf('late_success')).some((i) => i.id === l.id)).toBe(true);
      expect((await itemsOf('late_success', 'owner2-jwt')).some((i) => i.id === l.id)).toBe(false); // another Company
      expect((await itemsOf('capture_refund_unavailable')).find((i) => i.factId === l.factId)).toMatchObject({ detail: { reason: 'late_capture' } });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── unmatched facts (R6H-3, FC-1)

  describe('unmatched verified facts (R6H-3, FC-1)', () => {
    it('only a signature-verified movement, only past the grace window, once; an unsigned or unkeyable one never becomes a fact', async () => {
      const body = { eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: randomUUID(), providerTransactionId: `sim_x_${randomUUID()}`, amount: 9000, currency: 'TND' };
      expect((await signed(body, 'f'.repeat(64))).status).toBe(401); // forged: not even stored
      expect(await count(`SELECT count(*) AS n FROM webhook_event WHERE "providerEventId" = $1`, [body.eventId])).toBe(0);
      await signed(body).expect(200);
      expect((await one(`SELECT state FROM webhook_event WHERE "providerEventId" = $1`, [body.eventId])).state).toBe('unmatched');
      expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [body.providerTransactionId])).toBe(0); // within grace: an ordinary race
      const { fact } = await unmatched({ txn: `sim_x_${randomUUID()}` });
      expect(fact).toMatchObject({ kind: 'capture', paymentId: null, attemptId: null, amount: '9000', currency: 'TND', source: 'webhook', liveMode: false });
      const again = await unmatched({ txn: fact.providerTxnId }); // the same movement through another verified notification: the same fact
      expect(again.fact.id).toBe(fact.id);
      expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [fact.providerTxnId])).toBe(1);
      // a verified notification without a provider reference cannot be keyed: kept as an unmatched notification only
      const noRef = { eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: randomUUID(), amount: 9000, currency: 'TND' };
      await signed(noRef).expect(200);
      await ageWebhook(noRef.eventId, 3600);
      await signed(noRef).expect(200);
      expect((await one(`SELECT state, outcome FROM webhook_event WHERE "providerEventId" = $1`, [noRef.eventId]))).toEqual({ state: 'unmatched', outcome: null });
      expect((await ownerGet('/reconciliation-items?kind=unmatched_fact&limit=200')).body.code).toBe('invalid_reconciliation_request'); // F-29: no Owner reads it
      // immutable
      await expect(admin.query(`UPDATE provider_transaction_fact SET amount = 1 WHERE id = $1`, [fact.id])).rejects.toThrow();
      await expect(admin.query(`DELETE FROM provider_transaction_fact WHERE id = $1`, [fact.id])).rejects.toThrow();
      // the database: an unmatched fact only from a stored webhook claiming that movement; never a chargeback, never a status read
      await expect(admin.query(`INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, amount, currency, "liveMode", source) VALUES ('simulation', 'zz', 'capture', 1, 'TND', false, 'status_check')`))
        .rejects.toMatchObject({ constraint: 'provider_transaction_fact_unmatched_webhook' }); // the guard runs before the shape CHECK
      const wh = await one(`SELECT id FROM webhook_event WHERE "providerEventId" = $1`, [noRef.eventId]);
      await expect(admin.query(`INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, amount, currency, "liveMode", source, "webhookEventId") VALUES ('simulation', 'zz', 'refund', 1, 'TND', false, 'webhook', $1)`, [wh.id]))
        .rejects.toMatchObject({ constraint: 'provider_transaction_fact_unmatched_webhook' });
    });

    it('a movement matched only AFTER its unmatched fact was kept: the fact is never rewritten; the match is a fact conflict, visible', async () => {
      const { fact } = await unmatched();
      const p = await createPayment();
      const a = await startAttempt(p.id);
      await signed({ eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: a.id, providerTransactionId: fact.providerTxnId, amount: 9000, currency: 'TND' }).expect(200);
      expect(await one(`SELECT "paymentId", "attemptId" FROM provider_transaction_fact WHERE id = $1`, [fact.id])).toEqual({ paymentId: null, attemptId: null });
      expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact_conflict WHERE "factId" = $1 AND "paymentId" = $2`, [fact.id, p.id])).toBe(1);
      expect((await itemsOf('fact_conflict')).some((i) => i.factId === fact.id)).toBe(true);
      expect((await ownerGet(`/payments/${p.id}/balance`).expect(200)).body.currencies).toEqual([]); // counted only once the Owner associates it
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── association (PAY-13)

  describe('association (R6H-3, PAY-13)', () => {
    it('a capture with an Owner receipt to a payment of the Company: recorded once, audited, counted in its balance; the fact never changes', async () => {
      const { fact } = await unmatched();
      const p = await createPayment();
      await startAttempt(p.id); // a provider this payment has used
      const k = key();
      const r = auth.issue(assocBinding(fact, 'payment', p.id), OWNER);
      const res = await associate(fact.id, { targetType: 'payment', targetId: p.id, receiptSecret: r.secret }, k);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body).toMatchObject({ factId: fact.id, targetType: 'payment', paymentId: p.id, status: 'associated', approvedBy: { userId: OWNER }, receiptId: r.id });
      expect(JSON.stringify(res.body)).not.toContain(r.secret);
      expect((await associate(fact.id, { targetType: 'payment', targetId: p.id, receiptSecret: r.secret }, k)).status).toBe(200); // the same request: answered
      const r2 = auth.issue(assocBinding(fact, 'payment', p.id), OWNER);
      expect((await associate(fact.id, { targetType: 'payment', targetId: p.id, receiptSecret: r2.secret })).body.code).toBe('fact_already_associated'); // never twice
      expect(await one(`SELECT "paymentId", "attemptId" FROM provider_transaction_fact WHERE id = $1`, [fact.id])).toEqual({ paymentId: null, attemptId: null }); // unchanged
      const audit = (await admin.query(`SELECT payload FROM outbox WHERE name = 'audit.provider_fact.associated' AND payload->'resource'->>'id' = $1`, [fact.id])).rows;
      expect(audit.map((x) => [x.payload.actor, x.payload.changes])).toEqual([[{ type: 'user', id: OWNER, userKind: 'owner' }, { target_type: 'payment', target_id: p.id, payment_id: p.id, association_id: res.body.associationId }]]);
      const bal = (await ownerGet(`/payments/${p.id}/balance`).expect(200)).body;
      expect(bal.currencies).toEqual([{ currency: 'TND', captured: 9000, refundedNet: 0, chargebackNet: 0, netRetained: 9000 }]);
      expect((await itemsOf('association')).some((i) => i.factId === fact.id)).toBe(true);
      expect((await itemsOf('capture_refund_unavailable')).find((i) => i.factId === fact.id)).toMatchObject({ paymentId: p.id, detail: { reason: 'associated_capture' } });
      await expect(admin.query(`UPDATE provider_fact_association SET "paymentId" = $2 WHERE id = $1`, [res.body.associationId, randomUUID()])).rejects.toThrow();
      await expect(admin.query(`DELETE FROM provider_fact_association WHERE id = $1`, [res.body.associationId])).rejects.toThrow();
    });

    it('refused: another Company, a member, a mismatched kind, amount or currency, a receipt for another destination or Owner; Auth unresolved is repeated', async () => {
      const { fact } = await unmatched();
      const mine = await createPayment();
      await startAttempt(mine.id);
      const theirs = await createPayment({ seller: { type: 'company', id: COMPANY2 } });
      const send = (targetId: string, secret: string) => ({ targetType: 'payment', targetId, receiptSecret: secret });
      expect((await associate(fact.id, send(theirs.id, auth.issue(assocBinding(fact, 'payment', theirs.id), OWNER).secret))).status).toBe(404);
      expect((await associate(fact.id, send(mine.id, auth.issue(assocBinding(fact, 'payment', mine.id), OWNER2).secret), key(), 'owner2-jwt')).status).toBe(404);
      expect((await associate(fact.id, send(mine.id, 'x'.repeat(43)), key(), 'member-jwt')).status).toBe(403);
      const smaller = await createPayment({ amount: 8000 });
      await startAttempt(smaller.id);
      expect((await associate(fact.id, send(smaller.id, auth.issue(assocBinding(fact, 'payment', smaller.id), OWNER).secret))).body.code).toBe('provider_fact_association_invalid');
      const eur = await createPayment({ currency: 'EUR' });
      await startAttempt(eur.id);
      expect((await associate(fact.id, send(eur.id, auth.issue(assocBinding(fact, 'payment', eur.id), OWNER).secret))).body.code).toBe('provider_fact_association_invalid');
      const z = await authorizedRefund();
      expect((await associate(fact.id, { targetType: 'refund_authorization', targetId: z.authorization.id, receiptSecret: auth.issue(assocBinding(fact, 'refund_authorization', z.authorization.id), OWNER).secret })).body.code)
        .toBe('provider_fact_association_invalid'); // a capture is never a refund
      // receipts: another destination's, another Owner's (issuer), an amount the fact does not have
      expect((await associate(fact.id, send(mine.id, auth.issue(assocBinding(fact, 'payment', smaller.id), OWNER).secret))).body.code).toBe('provider_fact_association_refused');
      expect((await associate(fact.id, send(mine.id, auth.issue(assocBinding(fact, 'payment', mine.id), OWNER2).secret))).body.code).toBe('provider_fact_association_refused');
      expect((await associate(fact.id, send(mine.id, auth.issue(assocBinding(fact, 'payment', mine.id, { amount: 1 }), OWNER).secret))).body.code).toBe('provider_fact_association_refused');
      expect(await count(`SELECT count(*) AS n FROM provider_fact_association WHERE "factId" = $1 AND status = 'associated'`, [fact.id])).toBe(0);
      // every refusal is kept (never rolled back), so it never holds the fact's one live slot
      expect((await admin.query(`SELECT refusal FROM provider_fact_association WHERE "factId" = $1 ORDER BY "requestedAt", id`, [fact.id])).rows.map((r) => r.refusal))
        .toEqual(['receipt_invalid', 'approver_mismatch', 'receipt_invalid']);
      // Auth unanswerable: pending; the same request resumes it
      auth.unavailable.consume = 1;
      auth.unavailable.lookup = 1;
      const r = auth.issue(assocBinding(fact, 'payment', mine.id), OWNER);
      const k = key();
      expect((await associate(fact.id, send(mine.id, r.secret), k)).body.code).toBe('provider_fact_association_unresolved');
      const resumed = await associate(fact.id, send(mine.id, r.secret), k);
      expect([resumed.status, resumed.body.status]).toEqual([200, 'associated']); // the same key resumes its pending intent (the S6e-D convention)
      // a matched fact is never associated
      const { payment } = await captured();
      const matched = await one(`SELECT * FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture'`, [payment.id]);
      expect((await associate(matched.id, send(payment.id, auth.issue(assocBinding(matched, 'payment', payment.id), OWNER).secret))).body.code).toBe('provider_fact_matched');
    });

    it('concurrent associations of one fact: exactly one is recorded', async () => {
      const { fact } = await unmatched();
      const p = await createPayment();
      await startAttempt(p.id);
      const outs = await Promise.all(Array.from({ length: 6 }, () =>
        associate(fact.id, { targetType: 'payment', targetId: p.id, receiptSecret: auth.issue(assocBinding(fact, 'payment', p.id), OWNER).secret })));
      expect(outs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(outs.filter((r) => r.status === 409).every((r) => r.body.code === 'fact_already_associated')).toBe(true);
      expect(await count(`SELECT count(*) AS n FROM provider_fact_association WHERE "factId" = $1 AND status IN ('associated', 'authorization_pending')`, [fact.id])).toBe(1);
    });

    it('a refund fact associated with an authorization is allocated by the worker (FC-2): completion, then any further money is an over-return; balances go negative, never clamped', async () => {
      const z = await authorizedRefund();
      const { fact } = await unmatched({ type: 'refund.succeeded', amount: 9000 });
      expect(fact).toMatchObject({ kind: 'refund', paymentId: null, refundAttemptId: null });
      await drainRefunds();
      expect(await count(`SELECT count(*) AS n FROM refund_allocation WHERE "factId" = $1`, [fact.id])).toBe(0); // unassociated: waits, never retried blindly
      const res = await associate(fact.id, { targetType: 'refund_authorization', targetId: z.authorization.id,
        receiptSecret: auth.issue(assocBinding(fact, 'refund_authorization', z.authorization.id), OWNER).secret });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      await drainRefunds();
      expect(await one(`SELECT intended::int, excess::int FROM refund_allocation WHERE "factId" = $1`, [fact.id])).toEqual({ intended: 9000, excess: 0 });
      expect((await one(`SELECT "completedAt" FROM refund_authorization WHERE id = $1`, [z.authorization.id])).completedAt).not.toBeNull();
      expect(await count(`SELECT count(*) AS n FROM outbox WHERE name = 'refund.case_completed' AND payload->>'refundCaseId' = $1`, [z.caseId])).toBe(1);
      // the original-payment refund now sees the returned money
      const c2 = randomUUID();
      const again = await request(server()).post(`/payment/payments/${z.payment.id}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
        .send({ refundAttemptId: randomUUID(), refundCaseId: c2, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: auth.issue(refundBinding(z.payment.id, c2), OWNER).secret });
      expect(again.status).toBe(409);
      // a second returned movement, associated too: all excess (FC-2), an over-return item for Billing; the balance is negative
      const { fact: extra } = await unmatched({ type: 'refund.succeeded', amount: 500 });
      await associate(extra.id, { targetType: 'refund_authorization', targetId: z.authorization.id,
        receiptSecret: auth.issue(assocBinding(extra, 'refund_authorization', z.authorization.id), OWNER).secret }).expect(201);
      await drainRefunds();
      expect(await one(`SELECT intended::int, excess::int FROM refund_allocation WHERE "factId" = $1`, [extra.id])).toEqual({ intended: 0, excess: 500 });
      expect(((await serviceItems('over_return').expect(200)).body.items as Row[]).find((i) => i.factId === extra.id)).toMatchObject({ paymentId: z.payment.id, amount: 500 });
      const bal = (await ownerGet(`/payments/${z.payment.id}/balance`).expect(200)).body;
      expect(bal.currencies).toEqual([{ currency: 'TND', captured: 9000, refundedNet: 9500, chargebackNet: 0, netRetained: -500 }]);
      // the database: an unassociated unmatched refund fact is never allocated
      const { fact: loose } = await unmatched({ type: 'refund.succeeded', amount: 100 });
      await expect(admin.query(`INSERT INTO refund_allocation ("factId", "refundAuthorizationId", "paymentId", "refundAttemptId", amount, currency, intended, excess)
        VALUES ($1, $2, $3, $4, 100, 'TND', 100, 0)`, [loose.id, z.authorization.id, z.payment.id, z.attemptId])).rejects.toMatchObject({ constraint: 'refund_allocation_binding' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── Core V2 DO-73 U-5 (associated facts)
  describe('Core V2 DO-73 U-5: an associated refund fact is never blocked for currency_mismatch or no_authorization (PAY-08 unchanged)', () => {
    const blocked = async () => (await serviceItems('allocation_blocked').expect(200)).body.items as Row[];
    it('U-5 test 1: an unmatched EUR refund fact cannot be associated with a TND authorization; no block, no item, no allocation', async () => {
      const z = await authorizedRefund();
      const { fact } = await unmatched({ type: 'refund.succeeded', amount: 9000, currency: 'EUR' });
      const res = await associate(fact.id, { targetType: 'refund_authorization', targetId: z.authorization.id,
        receiptSecret: auth.issue(assocBinding(fact, 'refund_authorization', z.authorization.id), OWNER).secret });
      expect(res.body.code).toBe('provider_fact_association_invalid');
      await drainRefunds();
      expect(await count(`SELECT count(*) AS n FROM refund_fact_allocation_block WHERE "factId" = $1`, [fact.id])).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM refund_allocation WHERE "factId" = $1`, [fact.id])).toBe(0);
      expect((await blocked()).some((i) => i.factId === fact.id)).toBe(false);
      // the database refuses the association itself (the guard, not only the service)
      await expect(admin.query(`INSERT INTO provider_fact_association (id, "factId", "targetType", "paymentId", "refundAuthorizationId", "companyId", "requestedByUserId", "idempotencyKey", "receiptDigest")
        VALUES (gen_random_uuid(), $1, 'refund_authorization', $2, $3, $4, $5, 'k-do73', repeat('a', 64))`, [fact.id, z.payment.id, z.authorization.id, COMPANY, OWNER]))
        .rejects.toMatchObject({ constraint: 'provider_fact_association_match' });
    });

    it('U-5 test 2: an associated TND refund fact is absent from PAY-08 while pending (the DO-74 observation, unchanged here), then allocated normally; never blocked', async () => {
      const z = await authorizedRefund();
      const { fact } = await unmatched({ type: 'refund.succeeded', amount: 9000 });
      await associate(fact.id, { targetType: 'refund_authorization', targetId: z.authorization.id,
        receiptSecret: auth.issue(assocBinding(fact, 'refund_authorization', z.authorization.id), OWNER).secret }).expect(201);
      const pending = (await request(server()).get(`/payment/payments/${z.payment.id}/refunds`).set('authorization', `Bearer ${billing.token}`).expect(200)).body;
      expect((pending.unallocatedFacts as Row[]).some((f) => f.factId === fact.id)).toBe(false); // PAY-08 states only matched unallocated facts (U-5: unchanged)
      await drainRefunds();
      const after = (await request(server()).get(`/payment/payments/${z.payment.id}/refunds`).set('authorization', `Bearer ${billing.token}`).expect(200)).body;
      expect((after.authorizations as Row[]).flatMap((a) => a.allocations as Row[]).some((a) => a.factId === fact.id)).toBe(true);
      expect(await count(`SELECT count(*) AS n FROM refund_fact_allocation_block WHERE "factId" = $1`, [fact.id])).toBe(0);
    });

    it('U-5 test 3: an unmatched refund fact never associated is never blocked nor allocated, is no allocation_blocked item, and is in no PAY-08 answer', async () => {
      const { fact } = await unmatched({ type: 'refund.succeeded', amount: 700, currency: 'EUR' });
      await drainRefunds();
      await drainRefunds();
      expect(await count(`SELECT count(*) AS n FROM refund_fact_allocation_block WHERE "factId" = $1`, [fact.id])).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM refund_allocation WHERE "factId" = $1`, [fact.id])).toBe(0);
      expect((await blocked()).some((i) => i.factId === fact.id)).toBe(false);
    });

    it('U-5 test 4 (invariant over this suite\'s data): no currency_mismatch or no_authorization block exists on an unmatched (associated) fact', async () => {
      expect(await count(`SELECT count(*) AS n FROM refund_fact_allocation_block b JOIN provider_transaction_fact f ON f.id = b."factId"
        WHERE b.reason IN ('currency_mismatch', 'no_authorization') AND f."paymentId" IS NULL`)).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── captures, items, balances

  describe('captures without a refund path, Q8 items and balances (R6H-5, R6H-9, R6H-12)', () => {
    it('S0-C12 item 14(f): multiple_captures is the Owner\'s alone, Company-scoped, read-only and derived: stable by fact, no row added by a replay, paged, no service read, nothing it can authorize', async () => {
      const { payment, attempt } = await captured();
      const txn = `sim_dup_${randomUUID()}`;
      const note = { eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: attempt.id, providerTransactionId: txn, amount: 9000, currency: 'TND' };
      await signed(note).expect(200);
      const mine = async (bearer = 'owner-jwt') => (await itemsOf('multiple_captures', bearer)).filter((i) => i.paymentId === payment.id);
      const rows = await mine();
      expect(rows).toHaveLength(2);
      const facts = (await admin.query(`SELECT id FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture'`, [payment.id])).rows.map((r) => r.id as string).sort();
      expect(rows.map((r) => r.id).sort(), 'keyed by the fact').toEqual(facts);
      expect(rows[0]).toMatchObject({ kind: 'multiple_captures', amount: 9000, currency: 'TND', detail: { attemptId: attempt.id, attemptCaptures: 2, contested: false, lateSuccessId: null, inReview: true, potentiallyEquivalent: true } });
      await signed(note).expect(200); // a replay
      await signed({ ...note, eventId: `x_${randomUUID()}` }).expect(200); // the same capture under a new notification id
      expect((await mine()).map((r) => r.id).sort(), 'no row added').toEqual(facts);
      expect(await mine('owner2-jwt'), 'another Company\'s Owner sees nothing').toEqual([]);
      for (const k of ['multiple_captures', 'capture_recovery_exhausted']) {
        const service = await serviceItems(k);
        expect([service.status, service.body.code], 'a service read never reaches it').toEqual([400, 'invalid_reconciliation_request']);
      }
      expect((await serviceItems('late_success')).status, 'its other kinds are unchanged').toBe(200);
      const first = (await ownerGet('/reconciliation-items?kind=multiple_captures&limit=1').expect(200)).body.items as Row[];
      const next = (await ownerGet(`/reconciliation-items?kind=multiple_captures&limit=1&after=${first[0]!.id}`).expect(200)).body.items as Row[];
      expect(first).toHaveLength(1);
      if (next[0]) expect(next[0].id > first[0]!.id, 'keyset by id').toBe(true);
      expect((await request(server()).post('/payment/admin/reconciliation-items').set('authorization', 'Bearer owner-jwt').send({})).status, 'read-only').toBe(404);
      expect((await one(`SELECT status FROM payment WHERE id = $1`, [payment.id])).status).toBe('succeeded');
    });

    it('S0-C12 final acceptance, capture_recovery_exhausted through the Owner route, LABELLED FIXTURE (fact and state by SQL; the real transitions are in wrong-amount-captures): visible to its Company only, with its history; gone when a late success names the fact', async () => {
      const p = await createPayment();
      const a = await startAttempt(p.id);
      await outcome(p.id, a.id, { outcome: 'expired' });
      await request(server()).post(`/payment/payments/${p.id}/cancel`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key()).send({}).expect(200);
      // LABELLED FIXTURE: the fact and its state; the transitions to this state are proven in wrong-amount-captures
      const f = await one(`INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", amount, currency, "liveMode", source) VALUES ('simulation', $1, 'capture', $2, $3, 9000, 'TND', false, 'status_check') RETURNING id`, [`sim_ex_${randomUUID()}`, p.id, a.id]);
      await admin.query(`INSERT INTO capture_recovery_state ("factId", attempts, "workAfter", "lastFailure", status, "endedAt") VALUES ($1, 12, NULL, 'transient_failure', 'exhausted', now())`, [f.id]);
      const mine = async (bearer = 'owner-jwt') => (await itemsOf('capture_recovery_exhausted', bearer)).filter((i) => i.paymentId === p.id);
      expect(await mine()).toEqual([expect.objectContaining({ id: f.id, factId: f.id, amount: 9000, currency: 'TND', detail: expect.objectContaining({ status: 'exhausted', attempts: 12, lastFailure: 'transient_failure', attemptId: a.id }) })]);
      expect(await mine('owner2-jwt'), 'another Company').toEqual([]);
      await admin.query(`INSERT INTO payment_late_success ("paymentId", "attemptId", source, amount, currency, "paymentStatus", "factId") VALUES ($1, $2, 'status_check', 9000, 'TND', 'cancelled', $3)`, [p.id, a.id, f.id]);
      expect(await mine(), 'resolved by a late success').toEqual([]);
    });

    it('a distinct second capture of a succeeded attempt is kept as its own fact; neither capture is refundable by the original path; both are visible', async () => {
      const { payment, attempt } = await captured();
      await signed({ eventId: `x_${randomUUID()}`, type: 'payment.succeeded', reference: attempt.id, providerTransactionId: `sim_dup_${randomUUID()}`, amount: 9000, currency: 'TND' }).expect(200);
      expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact WHERE "paymentId" = $1 AND kind = 'capture'`, [payment.id])).toBe(2);
      const caseId = randomUUID();
      const refused = await request(server()).post(`/payment/payments/${payment.id}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
        .send({ refundAttemptId: randomUUID(), refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: auth.issue(refundBinding(payment.id, caseId), OWNER).secret });
      expect(refused.body.code).toBe('refund_capture_unverified'); // fail closed: which capture the original refund returns is ambiguous
      const items = (await itemsOf('capture_refund_unavailable')).filter((i) => i.paymentId === payment.id);
      expect(items.map((i) => i.detail.reason)).toEqual(['duplicate_capture', 'duplicate_capture']);
      expect((await ownerGet(`/payments/${payment.id}/balance`).expect(200)).body.currencies[0]).toMatchObject({ captured: 18000, netRetained: 18000 });
    });

    it('Q8 (fail closed): an authorization intent Auth never answered stays pending and becomes a visible item; it is never released', async () => {
      const { payment } = await captured();
      const caseId = randomUUID();
      auth.unavailable.consume = 1;
      auth.unavailable.lookup = 1;
      const res = await request(server()).post(`/payment/payments/${payment.id}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
        .send({ refundAttemptId: randomUUID(), refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: 'y'.repeat(43) });
      expect(res.status).toBe(503);
      const id = (await one(`SELECT id FROM refund_attempt WHERE "paymentId" = $1`, [payment.id])).id;
      expect((await itemsOf('authorization_pending')).some((i) => i.id === id)).toBe(false); // not yet
      const cl = await admin.connect();
      try {
        await cl.query(`SET session_replication_role = replica`);
        await cl.query(`UPDATE refund_attempt SET "requestedAt" = now() - make_interval(mins => $2) WHERE id = $1`, [id, AUTHORIZATION_PENDING_ITEM_AFTER_MINUTES + 1]);
      } finally {
        await cl.query(`SET session_replication_role = origin`);
        cl.release();
      }
      expect((await itemsOf('authorization_pending')).find((i) => i.id === id)).toMatchObject({ paymentId: payment.id, detail: { operation: 'refund' } });
      expect((await one(`SELECT status FROM refund_attempt WHERE id = $1`, [id])).status).toBe('authorization_pending');
    });

    it('balances are per currency, never summed across currencies, and only for the Owner\'s Company', async () => {
      const tnd = await captured();
      const eur = await captured({ currency: 'EUR', amount: 1200 });
      const company = (await ownerGet('/balances').expect(200)).body;
      const tndRow = company.currencies.find((c: Row) => c.currency === 'TND');
      const eurRow = company.currencies.find((c: Row) => c.currency === 'EUR');
      expect(eurRow.captured).toBeGreaterThanOrEqual(1200);
      expect(tndRow.captured).toBeGreaterThanOrEqual(9000);
      expect(company.currencies.every((c: Row) => c.netRetained === c.captured - c.refundedNet - c.chargebackNet)).toBe(true);
      expect((await ownerGet(`/payments/${eur.payment.id}/balance`).expect(200)).body.currencies).toEqual([{ currency: 'EUR', captured: 1200, refundedNet: 0, chargebackNet: 0, netRetained: 1200 }]);
      expect((await ownerGet(`/payments/${tnd.payment.id}/balance`, 'owner2-jwt')).status).toBe(404);
      expect((await ownerGet('/balances', 'owner2-jwt').expect(200)).body.currencies).toEqual([]);
      expect((await ownerGet('/balances', 'member-jwt')).status).toBe(403);
      expect((await request(server()).get('/payment/admin/balances').set('authorization', `Bearer ${billing.token}`)).status).toBe(403);
      ownerState.down = true;
      expect((await ownerGet('/balances')).status).toBe(503);
    });
  });

  it('production mounts no reconciliation route', () => {
    expect(ReconciliationModule.register({ isProduction: true, refunds: {} } as unknown as PaymentConfig)).toEqual({ module: ReconciliationModule });
  });
  // Core V2 S0-C15B (B-D1, B-D5, B-D7): the redacted producer-only presence of a dispute conflict, the refund-conflict audit and the separate balance count
  describe('Core V2 S0-C15B: dispute conflict presence, refund fact conflict audit, unresolved.disputeConflicts', () => {
    /** A preserved dispute conflict (terminal contradiction: won, then lost with a chargeback) on a captured payment, through the signed pipeline. */
    const disputeConflict = async () => {
      const c = await captured();
      const ref = `c15b-${randomUUID().slice(0, 8)}`;
      for (const send of [{ event: 'opened', amount: 7000 }, { event: 'won', amount: 7000 }, { event: 'lost', amount: 7000, chargebackAmount: 7000 }]) {
        await sim(`payments/${c.payment.id}/disputes`, { commandId: cmd(), disputeRef: ref, ...send }).expect(201);
      }
      const o = await one(`SELECT id FROM payment_dispute_observation WHERE "paymentId" = $1 AND disposition = 'conflict'`, [c.payment.id]);
      expect(o, 'the conflict').toBeDefined();
      return { ...c, observationId: o.id as string };
    };

    it('B-D1: the producer reads the redacted presence (identity, payment, time; no figure, reason, dispute or chargeback); its id is the Owner item\'s', async () => {
      const c = await disputeConflict();
      const res = await serviceItems('dispute_conflict_presence').expect(200);
      const mine = (res.body.items as Row[]).filter((i) => i.paymentId === c.payment.id);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toEqual({ kind: 'dispute_conflict_presence', id: c.observationId, paymentId: c.payment.id, paymentRequestId: c.payment.paymentRequestId, producer: 'billing-service',
        organizationId: null, purpose: 'direct_purchase', factId: null, amount: null, currency: null, detail: {}, at: expect.any(String) });
      const raw = JSON.stringify(mine[0]);
      for (const secret of ['terminal_contradiction', 'simd_', 'simcb_', '7000', 'lost', 'reason', 'chargeback', 'disputeId']) expect(raw).not.toContain(secret);
      const owner = (await itemsOf('dispute_conflict')).filter((i) => i.paymentId === c.payment.id);
      expect(owner.map((i) => i.id)).toEqual([c.observationId]); // the Owner cross-references the same id, with the full Owner-only detail
      expect(owner[0]!.detail).toMatchObject({ reason: 'terminal_contradiction', chargeback: { amount: 7000 } });
    });

    it('B-D1: the presence is no Owner kind, no ordinary Owner or member reads it, and the producer still cannot read the Owner-only dispute_conflict', async () => {
      await disputeConflict();
      expect((await ownerGet('/reconciliation-items?kind=dispute_conflict_presence&limit=200')).body.code).toBe('invalid_reconciliation_request');
      expect((await ownerGet('/reconciliation-items?kind=dispute_conflict_presence&limit=200', 'member-jwt')).status).toBe(403);
      expect((await serviceItems('dispute_conflict').expect(400)).body.code).toBe('invalid_reconciliation_request');
      expect((await serviceItems('dispute_conflict_presence', other.token)).status).toBe(403); // no payment.reconciliation.read
      // another producer's payments are never listed to Billing: the read is scoped through the payment's producer
      expect(((await serviceItems('dispute_conflict_presence').expect(200)).body.items as Row[]).every((i) => i.producer === 'billing-service')).toBe(true);
    });

    it('T19 (cross-Company): Company A\'s notification naming Company B\'s dispute is a conflict of A\'s payment only; neither the producer presence nor A\'s Owner item names B; B\'s Owner reads nothing of A', async () => {
      const b = await captured({ seller: { type: 'company', id: COMPANY2 } });
      const a = await captured();
      const ref = `c15b-x-${randomUUID().slice(0, 8)}`;
      await sim(`payments/${b.payment.id}/disputes`, { commandId: cmd(), disputeRef: ref, event: 'opened', amount: 5000 }).expect(201);
      const bDispute = await one(`SELECT id FROM payment_dispute WHERE "paymentId" = $1`, [b.payment.id]);
      await sim(`payments/${a.payment.id}/disputes`, { commandId: cmd(), disputeRef: ref, event: 'opened', amount: 5000 }).expect(201);
      const obs = await one(`SELECT id, reason FROM payment_dispute_observation WHERE "paymentId" = $1 AND disposition = 'conflict'`, [a.payment.id]);
      expect(obs.reason).toBe('payment_mismatch');
      const presence = ((await serviceItems('dispute_conflict_presence').expect(200)).body.items as Row[]).filter((i) => i.id === obs.id);
      expect(presence).toEqual([expect.objectContaining({ paymentId: a.payment.id, detail: {}, amount: null })]);
      const leaks = JSON.stringify(presence) + JSON.stringify(await itemsOf('dispute_conflict'));
      for (const other of [b.payment.id, bDispute.id, COMPANY2]) expect(leaks).not.toContain(other);
      expect((await itemsOf('dispute_conflict', 'owner2-jwt')).some((i) => i.id === obs.id)).toBe(false);
      expect((await ownerGet(`/payments/${a.payment.id}/balance`, 'owner2-jwt')).status).toBe(404);
      expect((await ownerGet(`/payments/${b.payment.id}/balance`, 'owner2-jwt').expect(200)).body.unresolved.disputeConflicts).toBe(0); // B's own exposure gains nothing
    });

    it('B-D7: unresolved.disputeConflicts counts dispute conflicts; unresolved.conflicts (provider fact conflicts) is unchanged', async () => {
      const c = await disputeConflict();
      const bal = (await ownerGet(`/payments/${c.payment.id}/balance`).expect(200)).body;
      expect(bal.unresolved).toEqual({ conflicts: 0, disputeConflicts: 1, blocked: 0, discrepancies: 0, late: 0 });
      expect(bal.currencies).toEqual([{ currency: 'TND', captured: 9000, refundedNet: 0, chargebackNet: 0, netRetained: 9000 }]); // the stated chargeback is in no figure
    });

    it('B-D5: a refund fact contradiction is audited once per recorded observation, with the existing action; a replay of the same notification adds nothing', async () => {
      const z = await authorizedRefund();
      const txn = `simr_c15b_${randomUUID()}`;
      const refund = (amount: number, eventId = `c15b_${randomUUID()}`) => ({ eventId, type: 'refund.succeeded', reference: z.attemptId, providerTransactionId: txn, amount, currency: 'TND' });
      await signed(refund(9000)).expect(200);
      const contradiction = refund(15000);
      await signed(contradiction).expect(200);
      await signed(contradiction).expect(200); // the SAME notification again: the webhook key makes it a no-op
      const fact = await one(`SELECT id, amount FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [txn]);
      expect(Number(fact.amount)).toBe(9000); // the verified fact stays as first reported
      const rows = (await admin.query(`SELECT id FROM provider_transaction_fact_conflict WHERE "factId" = $1`, [fact.id])).rows;
      expect(rows).toHaveLength(1);
      const audits = (await admin.query(`SELECT payload, id FROM outbox WHERE name = 'audit.provider_fact_conflict.recorded' AND payload->'resource'->>'id' = $1`, [fact.id])).rows;
      expect(audits).toHaveLength(1);
      const capturedAttempt = (await one(`SELECT "capturedAttemptId" FROM refund_attempt WHERE id = $1`, [z.attemptId])).capturedAttemptId;
      expect(audits[0].payload).toMatchObject({ action: 'provider_fact_conflict.recorded', outcome: 'succeeded', resource: { type: 'provider_transaction_fact', id: fact.id },
        actor: { type: 'system', id: 'payment_webhook' } });
      expect(audits[0].payload.changes).toEqual({ conflict_id: rows[0].id, payment_id: z.payment.id, attempt_id: capturedAttempt, refund_attempt_id: z.attemptId, source: 'webhook',
        observed_amount: 15000 }); // no currency, no provider reference, no body
      // another, distinct contradicting notification is another recorded observation: one more row, one more event, never a rewrite
      await signed(refund(4000)).expect(200);
      expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact_conflict WHERE "factId" = $1`, [fact.id])).toBe(2);
      expect(await count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.provider_fact_conflict.recorded' AND payload->'resource'->>'id' = $1`, [fact.id])).toBe(2);
      expect((await one(`SELECT amount FROM provider_transaction_fact WHERE id = $1`, [fact.id])).amount).toBe(fact.amount);
    });
  });

  describe('Core V2 DO-74 (observer side): PAY-08 observationConflicts, the producer\'s own observations of a fact that is not its payment\'s', () => {
    /** A refund relayed by the producer (S6b) and dispatched; optionally failed. Seller `company` (its Owner `ownerId`). */
    const refundOf = async (o: { fail?: boolean; company?: string; ownerId?: string } = {}) => {
      const company = o.company ?? COMPANY;
      const { payment } = await captured({ seller: { type: 'company', id: company } });
      const caseId = randomUUID();
      const r = auth.issue({ ...refundBinding(payment.id, caseId), companyId: company }, o.ownerId ?? OWNER);
      const res = await request(server()).post(`/payment/payments/${payment.id}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
        .send({ refundAttemptId: randomUUID(), refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: r.secret });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const attemptId = res.body.refundAttemptId as string;
      await drainRefunds();
      expect((await one(`SELECT status FROM refund_attempt WHERE id = $1`, [attemptId])).status).toBe('submitted');
      if (o.fail) await sim(`refunds/${attemptId}/outcomes`, { commandId: cmd(), outcome: 'failed', failureCode: 'card_closed' }).expect(201);
      const z = await one(`SELECT * FROM refund_authorization WHERE "refundAttemptId" = $1`, [attemptId]);
      return { payment, attemptId, z };
    };
    const ownRef = async (attemptId: string) => (await one(`SELECT "providerRefundId" FROM refund_attempt WHERE id = $1`, [attemptId])).providerRefundId as string;
    /** The provider reports, for `attemptId` (its own reference), a refund under provider id `txn`: a signed notification with a new id each time. */
    const observe = async (attemptId: string, txn: string, amount = 9000, eventId = `do74_${randomUUID()}`) =>
      (await signed({ eventId, type: 'refund.succeeded', reference: attemptId, providerTransactionId: txn, amount, currency: 'TND' })).status;
    const pay08 = (pid: string, token = billing.token) => request(server()).get(`/payment/payments/${pid}/refunds`).set('authorization', `Bearer ${token}`);
    const conflictIds = async (pid: string) => (await admin.query(`SELECT id FROM provider_transaction_fact_conflict WHERE "paymentId" = $1 ORDER BY id`, [pid])).rows.map((r) => r.id as string);
    const money = async (pid: string) => ({
      allocations: await count(`SELECT count(*) AS n FROM refund_allocation WHERE "paymentId" = $1`, [pid]),
      authorizations: (await admin.query(`SELECT "allocatedIntended"::int AS i, "completedAt" IS NOT NULL AS c FROM refund_authorization WHERE "paymentId" = $1`, [pid])).rows,
      associations: await count(`SELECT count(*) AS n FROM provider_fact_association WHERE "paymentId" = $1`, [pid]),
      facts: (await admin.query(`SELECT id, "paymentId", amount::int FROM provider_transaction_fact WHERE "paymentId" = $1 ORDER BY id`, [pid])).rows,
    });

    it('R1: the attempt\'s own refund first reported under an unknown reference, then by the attempt: ONE entry of the attempt\'s own rows; repeated notifications only add ids; nothing financial changes', async () => {
      const r = await refundOf();
      const txn = await ownRef(r.attemptId);
      const { fact } = await unmatched({ type: 'refund.succeeded', amount: 9000, txn });
      expect(fact.paymentId).toBeNull();
      const before = await money(r.payment.id);
      expect((await pay08(r.payment.id).expect(200)).body.observationConflicts).toEqual([]);
      const eventId = `do74_${randomUUID()}`;
      expect(await observe(r.attemptId, txn, 9000, eventId)).toBe(200);
      expect((await one(`SELECT status FROM refund_attempt WHERE id = $1`, [r.attemptId])).status).toBe('discrepancy');
      const first = await pay08(r.payment.id).expect(200);
      const ids1 = await conflictIds(r.payment.id);
      expect(ids1).toHaveLength(1);
      expect(first.body.observationConflicts).toEqual([{ refundAttemptId: r.attemptId, conflictIds: ids1, observations: 1, firstObservedAt: expect.any(String) }]);
      expect(Object.keys(first.body.observationConflicts[0]).sort()).toEqual(['conflictIds', 'firstObservedAt', 'observations', 'refundAttemptId']);
      expect(JSON.stringify(first.body)).not.toContain(fact.id); // never the fact's id
      // here the provider reference IS the attempt's own (it was dispatched under it): it appears only as that attempt's own providerRefundId
      expect(JSON.stringify({ ...first.body, attempts: first.body.attempts.map((x: Row) => ({ ...x, providerRefundId: null })) })).not.toContain(txn);
      expect(first.body.unallocatedFacts).toEqual([]); // S0-C14's evidence field is unchanged: the fact is not this payment's
      // the same notification again: nothing; a new notification id of the same report: one more own observation in the SAME entry
      expect(await observe(r.attemptId, txn, 9000, eventId)).toBe(200);
      expect(await conflictIds(r.payment.id)).toEqual(ids1);
      expect(await observe(r.attemptId, txn)).toBe(200);
      expect(await observe(r.attemptId, txn, 4000)).toBe(200);
      const ids3 = await conflictIds(r.payment.id);
      expect(ids3).toHaveLength(3);
      const later = (await pay08(r.payment.id).expect(200)).body.observationConflicts;
      expect(later).toEqual([{ refundAttemptId: r.attemptId, conflictIds: ids3, observations: 3, firstObservedAt: first.body.observationConflicts[0].firstObservedAt }]);
      expect(await money(r.payment.id)).toEqual(before); // nothing associated, allocated, completed or changed
      expect((await one(`SELECT "paymentId", "refundAttemptId", amount::int FROM provider_transaction_fact WHERE id = $1`, [fact.id]))).toEqual({ paymentId: null, refundAttemptId: null, amount: 9000 });
    });

    it('R2 (control): a contradiction of the payment\'s OWN fact is S0-C15B\'s path and is never listed', async () => {
      const r = await refundOf();
      const txn = await ownRef(r.attemptId);
      await sim(`refunds/${r.attemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      expect(await observe(r.attemptId, txn, 15000)).toBe(200);
      expect(await conflictIds(r.payment.id)).toHaveLength(1);
      expect((await pay08(r.payment.id).expect(200)).body.observationConflicts).toEqual([]);
    });

    it('cross-payment, same Company: B\'s attempt reports A\'s refund: B sees only its own rows; A\'s view and money are unchanged; nothing of either crosses', async () => {
      const a = await refundOf();
      const aTxn = await ownRef(a.attemptId);
      await sim(`refunds/${a.attemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      const aFact = await one(`SELECT id FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [aTxn]);
      const b = await refundOf();
      const aBefore = { view: (await pay08(a.payment.id).expect(200)).body, money: await money(a.payment.id) };
      const bBefore = await money(b.payment.id);
      expect(await observe(b.attemptId, aTxn)).toBe(200);
      const bView = (await pay08(b.payment.id).expect(200)).body;
      expect(bView.observationConflicts).toEqual([{ refundAttemptId: b.attemptId, conflictIds: await conflictIds(b.payment.id), observations: 1, firstObservedAt: expect.any(String) }]);
      for (const foreign of [aFact.id, aTxn, a.payment.id, a.attemptId, a.z.id]) expect(JSON.stringify(bView), foreign).not.toContain(foreign);
      const aAfter = (await pay08(a.payment.id).expect(200)).body;
      expect(aAfter).toEqual(aBefore.view); // A's PAY-08 gains nothing (O-2 stays open: A's own visibility is not this package's)
      for (const foreign of [b.payment.id, b.attemptId]) expect(JSON.stringify(aAfter)).not.toContain(foreign);
      expect(await money(a.payment.id)).toEqual(aBefore.money);
      expect(await money(b.payment.id)).toEqual(bBefore);
    });

    it('cross-Company: Company B\'s attempt reports Company A\'s refund: B\'s producer view names nothing of A; another producer and a non-producer read no field', async () => {
      const a = await refundOf();
      const aTxn = await ownRef(a.attemptId);
      await sim(`refunds/${a.attemptId}/outcomes`, { commandId: cmd(), outcome: 'succeeded' }).expect(201);
      const aFact = await one(`SELECT id FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [aTxn]);
      const b = await refundOf({ company: COMPANY2, ownerId: OWNER2 });
      expect(await observe(b.attemptId, aTxn)).toBe(200);
      const bView = (await pay08(b.payment.id).expect(200)).body;
      expect(bView.observationConflicts).toHaveLength(1);
      for (const foreign of [aFact.id, aTxn, a.payment.id, a.attemptId, a.z.id, COMPANY]) expect(JSON.stringify(bView), foreign).not.toContain(foreign);
      // only the producer: another producer gets the collapsed 404 (unchanged), and the field is never part of any other caller's answer
      expect((await pay08(b.payment.id, other.token)).status).toBe(404);
      const buyer = await request(server()).get(`/payment/payments/${b.payment.id}/refunds`).set('authorization', 'Bearer buyer-jwt');
      if (buyer.status === 200) expect(buyer.body.observationConflicts).toBeUndefined();
      // DISCLOSED, PRE-EXISTING (not widened here): Payment's existing fact_conflict item for B (Owner B and Billing's producer read) carries the contradicted
      // fact's opaque id; it carries B's own observed figures, never A's figures, reference, payment or Company
      const bItems = (await itemsOf('fact_conflict', 'owner2-jwt')).filter((i) => i.paymentId === b.payment.id);
      expect(bItems).toHaveLength(1);
      expect(bItems[0]!.factId).toBe(aFact.id);
      for (const foreign of [aTxn, a.payment.id, a.attemptId, COMPANY]) expect(JSON.stringify(bItems), foreign).not.toContain(foreign);
      expect((await itemsOf('fact_conflict', 'owner-jwt')).some((i) => i.paymentId === b.payment.id)).toBe(false); // A's Owner sees nothing of B
    });

    it('LATENT (F-29 stand-in): a fact associated to THIS payment is its own, so its contradiction is never listed', async () => {
      const r = await refundOf({ fail: true });
      const txn = await ownRef(r.attemptId);
      const { fact } = await unmatched({ type: 'refund.succeeded', amount: 9000, txn });
      const res = await associate(fact.id, { targetType: 'refund_authorization', targetId: r.z.id, receiptSecret: auth.issue(assocBinding(fact, 'refund_authorization', r.z.id), OWNER).secret });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await observe(r.attemptId, txn)).toBe(200);
      expect(await conflictIds(r.payment.id)).toHaveLength(1);
      expect((await pay08(r.payment.id).expect(200)).body.observationConflicts).toEqual([]);
    });

    it('two attempts of one payment, each with its own observation: one entry per attempt, in a stable order, each with only its own ids', async () => {
      const r1 = await refundOf({ fail: true });
      const t1 = await ownRef(r1.attemptId);
      await unmatched({ type: 'refund.succeeded', amount: 9000, txn: t1 });
      // a second authorized attempt of the same payment, admitted after the first failed (S6b), before the first one's observation
      const caseId = randomUUID();
      const sec = auth.issue(refundBinding(r1.payment.id, caseId), OWNER);
      const res = await request(server()).post(`/payment/payments/${r1.payment.id}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
        .send({ refundAttemptId: randomUUID(), refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: sec.secret });
      expect(res.status, JSON.stringify(res.body)).toBe(201); // the first attempt FAILED at the provider before its observation: a new authorized attempt is admitted
      const a2 = res.body.refundAttemptId as string;
      await drainRefunds();
      const t2 = await ownRef(a2);
      await unmatched({ type: 'refund.succeeded', amount: 9000, txn: t2 });
      // PRE-EXISTING, REPORTED (not DO-74's, unchanged here): a report on the FAILED first attempt while the second is live cannot move it to `discrepancy`
      // (refund_attempt_one_effective) and the webhook answers 500 for the provider to retry; the fact and the observation committed first and stay
      expect(await observe(r1.attemptId, t1)).toBe(500);
      expect((await one(`SELECT status FROM refund_attempt WHERE id = $1`, [r1.attemptId])).status).toBe('failed');
      expect(await observe(a2, t2)).toBe(200);
      const v = (await pay08(r1.payment.id).expect(200)).body.observationConflicts as Row[];
      expect(v.map((e) => e.refundAttemptId as string).sort((x, y) => x.localeCompare(y))).toEqual([r1.attemptId, a2].sort((x, y) => x.localeCompare(y)));
      for (const e of v) expect(e.conflictIds).toHaveLength(1);
    });

    // ═════════════════════════════════════════════════════════════ Core V2 O-2 (PAY-12 M): the FACT OWNER's contested refund fact
    const ITEM_KEYS = ['amount', 'at', 'currency', 'detail', 'factId', 'id', 'kind', 'organizationId', 'paymentId', 'paymentRequestId', 'producer', 'purpose'];
    const contested = async (token = billing.token) => (await serviceItems('refund_fact_contested', token).expect(200)).body.items as Row[];
    const ownerContested = async (bearer = 'owner-jwt') => itemsOf('refund_fact_contested', bearer);
    /** P1: a refund the attempt reports itself: P1's matched, allocated fact */
    const ownFact = async () => {
      const p1 = await refundOf();
      const txn = await ownRef(p1.attemptId);
      expect(await observe(p1.attemptId, txn)).toBe(200);
      const fact = await one(`SELECT id, "observedAt" FROM provider_transaction_fact WHERE "providerTxnId" = $1 AND kind = 'refund'`, [txn]);
      expect(await count(`SELECT count(*) AS n FROM refund_allocation WHERE "factId" = $1`, [fact.id])).toBe(1);
      return { p1, txn, factId: fact.id as string, observedAt: new Date(fact.observedAt).toISOString() };
    };

    it('O2-P1: one owner item per contested fact (three observations, two observers, two Companies); only the owner\'s own fact, figures and attempt; never an observer, a count or the reference', async () => {
      const f = await ownFact();
      expect((await contested()).some((i) => i.id === f.factId), 'not contested yet: no item').toBe(false);
      const p2 = await refundOf(); // same Company
      expect(await observe(p2.attemptId, f.txn)).toBe(200);
      expect(await observe(p2.attemptId, f.txn)).toBe(200); // repeated (a new notification id)
      const p3 = await refundOf({ company: COMPANY2, ownerId: OWNER2 }); // another Company
      expect(await observe(p3.attemptId, f.txn)).toBe(200);
      const observations = await count(`SELECT count(*) AS n FROM provider_transaction_fact_conflict WHERE "factId" = $1`, [f.factId]);
      expect(observations).toBeGreaterThanOrEqual(2);
      const mine = (await contested()).filter((i) => i.id === f.factId);
      expect(mine, 'exactly one row: EXISTS, never one per observer').toHaveLength(1);
      expect(mine[0]).toEqual({ kind: 'refund_fact_contested', id: f.factId, paymentId: f.p1.payment.id, paymentRequestId: f.p1.payment.paymentRequestId, producer: 'billing-service',
        organizationId: (await one(`SELECT "organizationId" FROM payment WHERE id = $1`, [f.p1.payment.id])).organizationId, purpose: expect.any(String), factId: f.factId, amount: 9000, currency: 'TND', detail: { refundAttemptId: f.p1.attemptId }, at: f.observedAt });
      expect(Object.keys(mine[0]!).sort()).toEqual(ITEM_KEYS);
      const observerIds = [p2.payment.id, p2.attemptId, p3.payment.id, p3.attemptId, COMPANY2, f.txn, ...(await admin.query(`SELECT id FROM provider_transaction_fact_conflict WHERE "factId" = $1`, [f.factId])).rows.map((r) => r.id as string)];
      for (const x of observerIds) expect(JSON.stringify(mine[0]), `no observer evidence (${x})`).not.toContain(x);
      expect(JSON.stringify(mine[0])).not.toMatch(/observation|count/i);
      // the observers' payments never carry the owner's item
      expect((await contested()).filter((i) => i.factId === f.factId).map((i) => i.paymentId)).toEqual([f.p1.payment.id]);
      // Owner scope: the owner's Company sees it; the other Company does not
      expect((await ownerContested('owner-jwt')).filter((i) => i.id === f.factId)).toHaveLength(1);
      expect((await ownerContested('owner2-jwt')).some((i) => i.id === f.factId)).toBe(false);
      expect((await ownerContested('owner2-jwt')).some((i) => i.paymentId === f.p1.payment.id)).toBe(false);
    });

    it('O2-P2: ownership is only the fact\'s own payment: an unmatched and an ASSOCIATED contested fact have no owner item; an uncontested fact has none either', async () => {
      // unmatched, contested (DO-74 R1 shape): no item for anyone
      const r = await refundOf();
      const txn = await ownRef(r.attemptId);
      const { fact: unmatchedFact } = await unmatched({ type: 'refund.succeeded', amount: 9000, txn });
      expect(await observe(r.attemptId, txn)).toBe(200);
      expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact_conflict WHERE "factId" = $1`, [unmatchedFact.id])).toBeGreaterThan(0);
      // associated (F-29 path in this suite), then contested by an attempt naming its reference
      const z = await authorizedRefund();
      const { fact: assoc } = await unmatched({ type: 'refund.succeeded', amount: 9000 });
      await associate(assoc.id, { targetType: 'refund_authorization', targetId: z.authorization.id,
        receiptSecret: auth.issue(assocBinding(assoc, 'refund_authorization', z.authorization.id), OWNER).secret }).expect(201);
      const x = await refundOf();
      expect(await observe(x.attemptId, assoc.providerTxnId)).toBe(200);
      expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact_conflict WHERE "factId" = $1`, [assoc.id])).toBeGreaterThan(0);
      // an uncontested own fact
      const plain = await ownFact();
      for (const items of [await contested(), await ownerContested('owner-jwt'), await ownerContested('owner2-jwt')]) {
        for (const id of [unmatchedFact.id, assoc.id, plain.factId]) expect(items.some((i) => i.id === id || i.factId === id), id).toBe(false);
      }
    });

    it('O2-P3: per-kind keyset paging returns every item exactly once (no skip, no duplicate), and the kind is the producer\'s and the Owner\'s', async () => {
      for (let k = 0; k < 2; k++) {
        const f = await ownFact();
        const o = await refundOf();
        expect(await observe(o.attemptId, f.txn)).toBe(200);
      }
      const all = (await contested()).map((i) => i.id as string);
      expect(new Set(all).size).toBe(all.length);
      const paged: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = (await request(server()).get(`/payment/reconciliation/items?kind=refund_fact_contested&limit=1${after ? `&after=${after}` : ''}`)
          .set('authorization', `Bearer ${billing.token}`).expect(200)).body.items as Row[];
        if (page.length === 0) break;
        paged.push(page[0]!.id as string);
        after = page[0]!.id as string;
      }
      expect(paged).toEqual([...all].sort());
      expect((await ownerGet('/reconciliation-items?kind=refund_fact_contested&limit=200')).status).toBe(200);
    });
  });

  describe('Core V2 R3 (PAY-08 I): failedAttemptEvidence, the refund evidence left after a FAILED attempt\'s own provider refund reference', () => {
    const refundOf = async (o: { fail?: boolean } = {}) => {
      const { payment } = await captured({ seller: { type: 'company', id: COMPANY } });
      const caseId = randomUUID();
      const r = auth.issue({ ...refundBinding(payment.id, caseId), companyId: COMPANY }, OWNER);
      const res = await request(server()).post(`/payment/payments/${payment.id}/refunds`).set('authorization', `Bearer ${billing.token}`).set('idempotency-key', key())
        .send({ refundAttemptId: randomUUID(), refundCaseId: caseId, amount: 9000, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: r.secret });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const attemptId = res.body.refundAttemptId as string;
      await drainRefunds();
      if (o.fail ?? true) await sim(`refunds/${attemptId}/outcomes`, { commandId: cmd(), outcome: 'failed', failureCode: 'card_closed' }).expect(201);
      const ref = (await one(`SELECT "providerRefundId" FROM refund_attempt WHERE id = $1`, [attemptId])).providerRefundId as string;
      return { payment, attemptId, ref };
    };
    const pay08 = async (pid: string) => (await request(server()).get(`/payment/payments/${pid}/refunds`).set('authorization', `Bearer ${billing.token}`).expect(200)).body;
    const stateOf = async (pid: string, attemptId: string) => ((await pay08(pid)).failedAttemptEvidence as { refundAttemptId: string; state: string }[]).find((e) => e.refundAttemptId === attemptId)?.state;
    const notice = (txn: string, o: { amount?: unknown; reference?: string; eventId?: string } = {}) =>
      ({ eventId: o.eventId ?? `r3_${randomUUID()}`, type: 'refund.succeeded', reference: o.reference ?? randomUUID(), providerTransactionId: txn, amount: o.amount ?? 9000, currency: 'TND' });
    const indexOf = async (eventId: string) => one(`SELECT "evidenceIndex", "providerTransactionId", "rawBody" FROM webhook_event WHERE "providerEventId" = $1`, [eventId]);
    const pendingRefundRows = () => count(`SELECT count(*) AS n FROM webhook_event WHERE "eventType" = 'refund.succeeded' AND "evidenceIndex" = 'pending'`);

    it('a failed attempt with nothing after it is `none`; only failed attempts are listed; only the producer sees the field; nothing else crosses', async () => {
      const r = await refundOf();
      const live = await refundOf({ fail: false });
      const body = await pay08(r.payment.id);
      expect(body.failedAttemptEvidence).toEqual([{ refundAttemptId: r.attemptId, state: 'none' }]);
      expect((await pay08(live.payment.id)).failedAttemptEvidence).toEqual([]); // a submitted attempt is not listed
      // the payer reads PAY-08 too (200), never the producer's field
      const payer = await request(server()).get(`/payment/payments/${r.payment.id}/refunds`).set('authorization', 'Bearer buyer-jwt');
      expect(payer.status, JSON.stringify(payer.body)).toBe(200);
      expect(payer.body.attempts).toHaveLength(1);
      expect(payer.body.failedAttemptEvidence).toBeUndefined();
      expect((await request(server()).get(`/payment/payments/${r.payment.id}/refunds`).set('authorization', `Bearer ${other.token}`)).body.failedAttemptEvidence).toBeUndefined();
    });

    it('R3: an unmatched refund under the failed attempt\'s own reference is `unmatched_fact`; the field never carries the fact, its id, figures or reference', async () => {
      const r = await refundOf();
      const { fact } = await unmatched({ type: 'refund.succeeded', amount: 9000, txn: r.ref });
      expect(fact.paymentId).toBeNull();
      const body = await pay08(r.payment.id);
      expect(body.failedAttemptEvidence).toEqual([{ refundAttemptId: r.attemptId, state: 'unmatched_fact' }]);
      for (const leak of [fact.id, r.ref]) expect(JSON.stringify(body.failedAttemptEvidence), leak).not.toContain(leak);
      expect(body.unallocatedFacts).toEqual([]); // the fact is still not this payment's: nothing is associated or allocated
      expect(await count(`SELECT count(*) AS n FROM provider_fact_association WHERE "factId" = $1`, [fact.id])).toBe(0);
    });

    it('grace window, replay and contradiction: a signed notification not yet a fact is `notification_pending`; then `unmatched_fact`; replays and a contradicting amount change nothing', async () => {
      const r = await refundOf();
      const n1 = notice(r.ref);
      await signed(n1).expect(200);
      expect(await indexOf(n1.eventId)).toMatchObject({ evidenceIndex: 'reference', providerTransactionId: r.ref });
      expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [r.ref])).toBe(0);
      expect(await stateOf(r.payment.id, r.attemptId)).toBe('notification_pending');
      await ageWebhook(n1.eventId, UNMATCHED_FACT_GRACE_MS / 1000 + 1);
      await signed(n1).expect(200); // the retrier's redelivery: now the unmatched fact
      expect(await stateOf(r.payment.id, r.attemptId)).toBe('unmatched_fact');
      await signed(n1).expect(200); // replay of the same notification
      const n2 = notice(r.ref, { amount: 4000 }); // the same refund, another notification, another amount
      await signed(n2).expect(200);
      expect(await count(`SELECT count(*) AS n FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [r.ref])).toBe(1);
      expect(await stateOf(r.payment.id, r.attemptId)).toBe('unmatched_fact');
    });

    it('a signed notification naming the reference with an unusable amount makes the attempt `unknown` (fail-closed), never `none`', async () => {
      const r = await refundOf();
      const bad = notice(r.ref, { amount: 'ninety' });
      await signed(bad).expect(200);
      expect(await indexOf(bad.eventId)).toMatchObject({ evidenceIndex: 'reference_malformed', providerTransactionId: r.ref });
      expect(await stateOf(r.payment.id, r.attemptId)).toBe('unknown');
    });

    it('B-1 option A: unparseable signed evidence, or a refund with no transaction reference, is kept as received and attributed to nobody; other attempts stay `none`', async () => {
      const r = await refundOf();
      const raw = `{"not":"a notification","n":"${randomUUID()}"}`; // valid JSON, signed, but no notification the adapter can read
      const status = (await request(server()).post('/payment/webhooks/simulation').set('content-type', 'application/json')
        .set('x-simulation-signature', createHmac('sha256', SECRET).update(raw).digest('hex')).send(raw)).status;
      expect(status).toBe(200);
      const unparseable = await one(`SELECT "evidenceIndex", "providerTransactionId", "rawBody" FROM webhook_event WHERE "rawBody" = $1`, [Buffer.from(raw)]);
      expect(unparseable).toMatchObject({ evidenceIndex: 'unparseable', providerTransactionId: null });
      expect(Buffer.from(unparseable.rawBody).toString()).toBe(raw); // the signed evidence, exactly as received
      const noRef = { eventId: `r3_${randomUUID()}`, type: 'refund.succeeded', reference: randomUUID(), amount: 9000, currency: 'TND' };
      await signed(noRef).expect(200);
      expect(await indexOf(noRef.eventId)).toMatchObject({ evidenceIndex: 'no_reference', providerTransactionId: null });
      expect(await stateOf(r.payment.id, r.attemptId)).toBe('none'); // no provider-wide hold
    });

    it('the index is written once and the signed evidence never changes (database guard)', async () => {
      const r = await refundOf();
      const n1 = notice(r.ref);
      await signed(n1).expect(200);
      await expect(admin.query(`UPDATE webhook_event SET "evidenceIndex" = 'no_reference', "providerTransactionId" = NULL WHERE "providerEventId" = $1`, [n1.eventId]))
        .rejects.toMatchObject({ constraint: 'webhook_event_evidence_index_once' });
      await expect(admin.query(`UPDATE webhook_event SET "evidenceIndex" = 'pending', "providerTransactionId" = NULL WHERE "providerEventId" = $1`, [n1.eventId]))
        .rejects.toMatchObject({ constraint: 'webhook_event_evidence_index_once' });
      await expect(admin.query(`UPDATE webhook_event SET "rawBody" = 'x' WHERE "providerEventId" = $1`, [n1.eventId])).rejects.toThrow();
    });

    it('historical backfill: any unindexed refund notification makes failed attempts `unknown`; bounded batches resume; an interrupted batch writes nothing; an unknown provider stays pending', async () => {
      const r = await refundOf();
      const o2 = await refundOf();
      // LABELLED FIXTURE: notifications stored BEFORE 0028 (pending), inserted as the receipt path did then: one naming r's reference, one unparseable
      const stored = async (body: string) => (await admin.query(`INSERT INTO webhook_event (provider, "providerEventId", "eventType", "rawBody") VALUES ('simulation', $1, 'refund.succeeded', $2) RETURNING id`,
        [`hist_${randomUUID()}`, Buffer.from(body)])).rows[0].id as string;
      const h1 = await stored(JSON.stringify(notice(r.ref)));
      const h2 = await stored('{"broken"');
      const ghost = (await admin.query(`INSERT INTO webhook_event (provider, "providerEventId", "eventType", "rawBody") VALUES ('ghost', $1, 'refund.succeeded', $2) RETURNING id`,
        [`hist_${randomUUID()}`, Buffer.from('{}')])).rows[0].id as string;
      expect(await stateOf(r.payment.id, r.attemptId)).toBe('unknown');
      expect(await stateOf(o2.payment.id, o2.attemptId)).toBe('unknown'); // partial indexing is never absence
      const { backfillEvidenceIndex, WebhookEvidenceBackfill } = await import('../src/webhooks/evidence-backfill.js');
      const { DbService } = await import('@nawara/service-kit');
      const db = t.app.get(DbService);
      // an interruption mid-batch (the parser fails outside the row's own handling): the transaction rolls back, nothing is written
      await expect(backfillEvidenceIndex(db, () => { throw new Error('interrupted'); }, 10)).rejects.toThrow('interrupted');
      expect(await pendingRefundRows()).toBe(3);
      const backfill = t.app.get(WebhookEvidenceBackfill);
      const b1 = await backfill.batch(1);
      expect(b1).toMatchObject({ indexed: 1 });
      expect(await stateOf(o2.payment.id, o2.attemptId)).toBe('unknown'); // still incomplete for this provider
      const b2 = await backfill.batch(10);
      expect(b2.indexed + b1.indexed).toBe(2);
      expect(b2.skipped).toBe(1); // the ghost provider's row: not parseable here, left pending
      expect((await one(`SELECT "evidenceIndex" FROM webhook_event WHERE id = $1`, [ghost])).evidenceIndex).toBe('pending');
      expect((await one(`SELECT "evidenceIndex", "providerTransactionId" FROM webhook_event WHERE id = $1`, [h1]))).toEqual({ evidenceIndex: 'reference', providerTransactionId: r.ref });
      expect((await one(`SELECT "evidenceIndex" FROM webhook_event WHERE id = $1`, [h2])).evidenceIndex).toBe('unparseable');
      expect(await stateOf(r.payment.id, r.attemptId)).toBe('notification_pending');
      expect(await stateOf(o2.payment.id, o2.attemptId)).toBe('none');
      expect((await backfill.batch(10)).indexed).toBe(0); // idempotent: nothing left to index here
    });

    it('a fact under the reference that is bound to ANOTHER payment makes the attempt `unknown`; that payment\'s own answer names nothing of this one', async () => {
      const a = await refundOf();
      const b = await refundOf({ fail: false });
      // B's attempt reports a refund under A's failed attempt's reference: the fact is B's
      const n = notice(a.ref, { reference: b.attemptId });
      await signed(n).expect(200);
      expect((await one(`SELECT "paymentId" FROM provider_transaction_fact WHERE "providerTxnId" = $1`, [a.ref])).paymentId).toBe(b.payment.id);
      expect(await stateOf(a.payment.id, a.attemptId)).toBe('unknown');
      expect(JSON.stringify(await pay08(b.payment.id))).not.toContain(a.attemptId);
    });
  });
});

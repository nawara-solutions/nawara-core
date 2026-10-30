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
      tokens: [{ caller: 'billing-service', digest: billing.digest }, { caller: 'other-producer', digest: other.digest }, { caller: 'simulation-harness', digest: harness.digest }],
      env: {
        AUTH_SERVICE_URL: auth.url, AUTH_SERVICE_TOKEN: auth.token, PAYMENT_SIMULATION_PROVIDER: 'true', PAYMENT_SUPPORTED_CURRENCIES: 'TND,EUR', PAYMENT_SIMULATION_WEBHOOK_SECRET: SECRET,
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
      expect((await itemsOf('unmatched_fact')).find((i) => i.id === fact.id)).toMatchObject({ amount: 9000, currency: 'TND', detail: { movement: 'capture', association: null } });
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

  // ─────────────────────────────────────────────────────────────────────────────────────────────── captures, items, balances

  describe('captures without a refund path, Q8 items and balances (R6H-5, R6H-9, R6H-12)', () => {
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
});

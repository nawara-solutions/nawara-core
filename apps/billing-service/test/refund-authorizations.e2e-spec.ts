import { randomBytes, randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type OrganizationReferenceResolver } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { BILLING_OPERATIONS } from '../src/admission/caller-admission.policy.js';
import { billingMigrationsDir } from '../src/app.module.js';
import type { Caller, TransitionContext } from '../src/domain/actors.js';
import { normaliseCreateInvoiceInput } from '../src/domain/invoice-input.js';
import { recordTransition } from '../src/domain/transitions.js';
import { InvoiceRepository } from '../src/invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../src/invoices/payment-request.repository.js';
import { HttpOwnerAuthority } from '../src/platforms/owner-authority.client.js';
import type { DisputeExposure } from '../src/refunds/dispute-exposure.js';
import type { PaymentRefundClient, PaymentRefunds, RefundRelayBody, RefundRelayOutcome } from '../src/refunds/payment-refund-client.js';
import { RefundRelayReconciler } from '../src/refunds/refund-relay-reconciler.js';
import { createTestApp, type TestApp } from './support/app.js';
import { FakeAuth } from './support/fake-auth.js';
import { paymentPurposeOf } from './support/settlement.js';
import { describeWithEnv } from './support/env.js';

type Row = Record<string, any>;

/** Payment's refund port under test control: a scripted answer per relay call (default: authorized), and its PAY-08 records. */
class ScriptedPaymentRefunds implements PaymentRefundClient {
  readonly calls: { paymentId: string; key: string; body: RefundRelayBody }[] = [];
  next: RefundRelayOutcome[] = [];
  readonly records = new Map<string, PaymentRefunds>();
  readDown = false;
  async relay(paymentId: string, key: string, body: RefundRelayBody): Promise<RefundRelayOutcome> {
    this.calls.push({ paymentId, key, body });
    return this.next.shift() ?? { kind: 'attempt', attempt: { refundAttemptId: body.refundAttemptId, status: 'authorized', approvedBy: { userId: OWNER } } };
  }
  async refunds(paymentId: string): Promise<PaymentRefunds | null> {
    if (this.readDown) throw new Error('payment unavailable');
    return this.records.get(paymentId) ?? { attempts: [], refusals: [] };
  }
}

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const PLATFORM = randomUUID();
const OWNER = randomUUID();
const ORG = randomUUID();

/**
 * Core V2 S6b refund authorization relay (register BIL-24, BIL-25; ADR-0067 decision 5; S0 FC-3, V-3; the Owner's R6B-7, R6B-10), for
 * DEVELOPMENT AND SIMULATION ONLY: the real application on real PostgreSQL 16, cases opened through the real S6a route on a verified capture,
 * the Owner verified through Billing's real Auth client against a fake Auth, and Payment's refund port scripted (the cross-service path, with
 * real Payment and real Auth, is certified in test/e2e-real-broker).
 */
describeWithEnv('refund authorization relay (Core V2 S6b, simulation) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const payment = new ScriptedPaymentRefunds();
  const auth = new FakeAuth();
  const disputes = { open: new Set<string>(), down: false };
  const disputeExposure: DisputeExposure = {
    status: async (paymentId) => {
      if (disputes.down) throw new ServiceUnavailableException();
      return disputes.open.has(paymentId) ? 'open' : 'none';
    },
  };
  const producer = generateServiceToken();
  const authClient: AuthClient = { getIdentity: async () => null, hasPlatformAccess: async () => false };
  const reference: OrganizationReferenceResolver = { resolve: async (organizationId) => (organizationId === ORG ? { organizationId, platformId: PLATFORM, companyId: COMPANY } : null) };
  const server = () => t.app.getHttpServer();
  const secret = () => randomBytes(32).toString('base64url');
  let seq = 0;
  const key = () => `s6b-${++seq}-${randomUUID().slice(0, 8)}`;
  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;

  /** A verified captured non-entitlement payment sold by the Company, through Billing's real invoice and payment-event paths. */
  const capturedPayment = async () => {
    const seller = { type: 'company', id: COMPANY };
    const productId = (await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
      VALUES ('test-producer', 'company', $1, $2, 'Item', 'active', 'none', $3) RETURNING id`, [COMPANY, `item-${++seq}`, PLATFORM])).rows[0].id as string;
    const priceId = (await admin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "effectiveFrom")
      VALUES ($1, $2, 'TND', 2500, 'one_time', '2020-01-01') RETURNING id`, [productId, `r-${++seq}`])).rows[0].id as string;
    const ctx: TransitionContext = { actor: { type: 'service', id: 'test-producer' }, cause: { type: 'request', id: randomUUID() }, correlationId: 'refund-fixture' };
    const caller: Caller = { kind: 'service', service: 'test-producer' };
    const payer = { type: 'user', id: `payer-${++seq}` };
    const input = normaliseCreateInvoiceInput({
      invoiceRequestId: randomUUID(), seller, payer, organizationId: null, sourceType: 'contract', sourceId: `s-${seq}`,
      issuerSnapshot: { schemaVersion: 1 }, billToSnapshot: { schemaVersion: 1 }, lines: [{ priceId, quantity: 1 }],
    });
    const invoices = t.app.get(InvoiceRepository);
    const requests = t.app.get(PaymentRequestRepository);
    const { invoice } = await invoices.createDraft('test-producer', input, ['TND'], ctx);
    const open = (await invoices.issue(invoice.id, caller, { template: 'system:1', locale: 'fr' }, ctx, { callerPlatforms: new Set([PLATFORM]), organizationPlatformId: PLATFORM })).invoice;
    const { request: pr } = await requests.createForInvoice(open.id, caller, ctx);
    const paymentId = randomUUID();
    await t.app.get(DbService).tx(async (q) => {
      for (const [from, to, extra] of [['created', 'sending', ''], ['sending', 'requested', `, "paymentId" = '${paymentId}'`]] as const) {
        const { rows } = await q.query<{ revision: number }>(`UPDATE payment_request SET status = '${to}'${extra} WHERE id = $1 RETURNING revision`, [pr.id]);
        await recordTransition(q, { entityType: 'payment_request', entityId: pr.id, from, to, revision: rows[0]!.revision, ctx });
      }
    });
    const eventId = randomUUID();
    await requests.applyPaymentEvent(eventId, {
      name: 'payment.succeeded', source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId: pr.id, sourceType: 'invoice', sourceId: open.id,
      payer, seller, organizationId: null, amount: Number(open.total), currency: open.currency, revision: 1, ...(await paymentPurposeOf(admin, open.id)),
    } as never, { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: eventId }, correlationId: 'refund-fixture' }, new Date());
    return { paymentId, amount: Number(open.total) };
  };
  const send = (r: request.Test, bearer: string | null, idem: string | null) => {
    if (bearer) r = r.set('authorization', `Bearer ${bearer}`);
    if (idem) r = r.set('idempotency-key', idem);
    return r;
  };
  const openCase = async () => {
    const { paymentId, amount } = await capturedPayment();
    const r = await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId, reason: 'customer_request' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { caseId: r.body.id as string, paymentId, amount };
  };
  const authorize = (caseId: string, body: unknown, o: { bearer?: string | null; idem?: string } = {}) =>
    send(request(server()).post(`/billing/admin/refund-cases/${caseId}/authorizations`), o.bearer === undefined ? 'owner-tok' : o.bearer, o.idem ?? key()).send(body as object);
  const cancel = (caseId: string) => send(request(server()).post(`/billing/admin/refund-cases/${caseId}/cancel`), 'owner-tok', key()).send();
  const readCase = async (caseId: string) => (await send(request(server()).get(`/billing/admin/refund-cases/${caseId}`), 'owner-tok', null).expect(200)).body;
  const relays = async (caseId: string) => (await admin.query(`SELECT * FROM refund_authorization_relay WHERE "refundCaseId" = $1 ORDER BY "requestedAt"`, [caseId])).rows as Row[];
  const reconcile = async () => {
    await admin.query(`UPDATE refund_authorization_relay SET "checkAfter" = NULL`);
    return t.app.get(RefundRelayReconciler).reconcileOnce();
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings6b');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    await admin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [PLATFORM, COMPANY, randomUUID()]);
    await auth.start();
    auth.identities.set('owner-tok', { userId: OWNER, kind: 'owner', companyId: COMPANY });
    auth.identities.set('foreign-owner-tok', { userId: randomUUID(), kind: 'owner', companyId: OTHER_COMPANY });
    auth.identities.set('operator-tok', { userId: randomUUID(), kind: 'operator', companyId: null });
    auth.platforms.set(PLATFORM, COMPANY);
    t = await createTestApp({
      databaseUrl: db.url, authClient, organizationReference: reference, disputeExposure, paymentRefundClient: payment, ownerAuthority: new HttpOwnerAuthority({ baseUrl: auth.url }),
      tokens: [{ caller: 'test-producer', digest: producer.digest }],
      env: { BILLING_SERVICE_POLICY: JSON.stringify({ callers: { 'test-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: [PLATFORM] } } }) },
    });
  });
  beforeEach(() => {
    payment.next = [];
    payment.calls.length = 0;
    payment.readDown = false;
    disputes.open.clear();
    disputes.down = false;
  });
  afterAll(async () => {
    await t?.app.close();
    await auth.stop();
    await admin?.end();
    await db?.drop();
  });

  describe('the relay (BIL-24, R6B-10)', () => {
    it('the Owner relays the receipt: a durable relay first, then PAY-07 with the case\'s own binding; the secret is never stored', async () => {
      const { caseId, paymentId, amount } = await openCase();
      const s = secret();
      const r = await authorize(caseId, { receiptSecret: s }).expect(201);
      const [relay] = await relays(caseId);
      expect(relay).toMatchObject({ paymentId, requestedBy: OWNER, attemptStatus: 'authorized' });
      expect(payment.calls).toEqual([{ paymentId, key: `refund-relay:${relay!.id}`, body: {
        refundAttemptId: relay!.id, refundCaseId: caseId, amount, currency: 'TND', reason: 'customer_request', legalOverride: false, receiptSecret: s } }]);
      expect(r.body.attempts).toEqual([expect.objectContaining({ refundAttemptId: relay!.id, status: 'authorized', refusal: null })]);
      expect(r.body.status).toBe('open'); // never completed here (S6c)
      const audit = (await admin.query(`SELECT name, payload FROM outbox WHERE name = 'audit.refund_case.authorization_relayed' AND payload->'resource'->>'id' = $1`, [caseId])).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].payload.actor).toEqual({ type: 'user', id: OWNER, userKind: 'owner' });
      expect(audit[0].payload.changes).toEqual({ payment_id: paymentId, refund_attempt_id: relay!.id, company_id: COMPANY, platform_id: PLATFORM });
      // F-12: the secret is nowhere in Billing's database (relays, idempotency, outbox, transitions)
      const dump = (await admin.query(`SELECT string_agg(t::text, ' ') AS all FROM (SELECT row_to_json(r)::text AS t FROM refund_authorization_relay r UNION ALL SELECT payload::text FROM outbox
        UNION ALL SELECT row_to_json(i)::text FROM refund_command_idempotency i UNION ALL SELECT row_to_json(b)::text FROM billing_transition b) x`)).rows[0].all as string;
      expect(dump).not.toContain(s);
      expect(JSON.stringify(r.body)).not.toContain(s);
    });

    it('only the Owner of the case\'s Company: another Company\'s Owner 404, an operator 403, a service token 401, Auth down 503', async () => {
      const { caseId } = await openCase();
      await authorize(caseId, { receiptSecret: secret() }, { bearer: 'foreign-owner-tok' }).expect(404);
      await authorize(caseId, { receiptSecret: secret() }, { bearer: 'operator-tok' }).expect(403);
      await authorize(caseId, { receiptSecret: secret() }, { bearer: producer.token }).expect(401);
      await authorize(caseId, { receiptSecret: secret() }, { bearer: null }).expect(401);
      expect(await relays(caseId)).toEqual([]);
      expect(payment.calls).toEqual([]);
      for (const bad of [{}, { receiptSecret: 'short' }, { receiptSecret: secret(), expiresAt: new Date().toISOString() }, { receiptSecret: secret(), amount: 1 }]) {
        expect((await authorize(caseId, bad).expect(400)).body.code).toBe('invalid_refund_request');
      }
    });

    it('an open dispute refuses a new relay and an unanswerable source writes nothing', async () => {
      const { caseId, paymentId } = await openCase();
      disputes.open.add(paymentId);
      expect((await authorize(caseId, { receiptSecret: secret() }).expect(409)).body.code).toBe('refund_dispute_open');
      disputes.open.clear();
      disputes.down = true;
      await authorize(caseId, { receiptSecret: secret() }).expect(503);
      expect(await relays(caseId)).toEqual([]);
      expect(payment.calls).toEqual([]);
    });

    it('a lost Payment answer: the relay stays unconfirmed (never a refusal), cancellation is refused, the same key resumes the same attempt', async () => {
      const { caseId } = await openCase();
      const s = secret();
      const idem = key();
      payment.next = [{ kind: 'unknown', reason: 'status_0' }];
      expect((await authorize(caseId, { receiptSecret: s }, { idem }).expect(503)).body.code).toBe('refund_payment_unavailable');
      const [relay] = await relays(caseId);
      expect(relay!.attemptStatus).toBeNull();
      expect((await readCase(caseId)).attempts).toEqual([expect.objectContaining({ refundAttemptId: relay!.id, status: 'unconfirmed' })]);
      expect((await cancel(caseId).expect(409)).body.code).toBe('refund_processing_started');
      // Payment holds nothing yet: still unconfirmed (an absent record proves nothing)
      await reconcile();
      expect((await relays(caseId))[0]!.attemptStatus).toBeNull();
      // a second relay cannot start while this one is unconfirmed
      expect((await authorize(caseId, { receiptSecret: secret() }).expect(409)).body.code).toBe('refund_authorization_in_progress');
      // the Owner retries the same key: the SAME refund attempt id is relayed again
      const r = await authorize(caseId, { receiptSecret: s }, { idem }).expect(200);
      expect(r.headers['idempotent-replayed']).toBe('true');
      expect(payment.calls.map((c) => c.body.refundAttemptId)).toEqual([relay!.id, relay!.id]);
      expect((await relays(caseId))[0]!.attemptStatus).toBe('authorized');
      expect((await cancel(caseId).expect(409)).body.code).toBe('refund_processing_started');
    });

    it('the reconciler mirrors Payment\'s authoritative state: authorized, then succeeded; never completes the case or reverses anything', async () => {
      const { caseId, paymentId } = await openCase();
      payment.next = [{ kind: 'unknown', reason: 'status_504' }];
      await authorize(caseId, { receiptSecret: secret() }).expect(503);
      const [relay] = await relays(caseId);
      payment.records.set(paymentId, { attempts: [{ refundAttemptId: relay!.id, status: 'authorized', approvedBy: { userId: OWNER } }], refusals: [] });
      expect(await reconcile()).toMatchObject({ changed: 1 });
      expect((await relays(caseId))[0]!.attemptStatus).toBe('authorized');
      payment.records.set(paymentId, { attempts: [{ refundAttemptId: relay!.id, status: 'succeeded', approvedBy: { userId: OWNER } }], refusals: [] });
      await reconcile();
      const c = await readCase(caseId);
      expect(c.attempts[0].status).toBe('succeeded');
      expect(c).toMatchObject({ status: 'open', completedAt: null }); // S6c completes, not S6b
      expect(Number((await one(`SELECT count(*) AS n FROM subscription_purchase_reversal`)).n)).toBe(0);
      // a backwards report is refused by the database and the mirror stays
      payment.records.set(paymentId, { attempts: [{ refundAttemptId: relay!.id, status: 'authorized', approvedBy: { userId: OWNER } }], refusals: [] });
      await reconcile();
      expect((await relays(caseId))[0]!.attemptStatus).toBe('succeeded');
      payment.readDown = true;
      await reconcile(); // isolated per relay; nothing changes
      expect((await relays(caseId))[0]!.attemptStatus).toBe('succeeded');
    });

    it('Payment\'s definitive refusals free the case: refused or expired authorization, or a permanent pre-attempt refusal; then cancellation is allowed', async () => {
      const { caseId } = await openCase();
      payment.next = [{ kind: 'terminal', status: 'authorization_refused' }];
      expect((await authorize(caseId, { receiptSecret: secret() }).expect(409)).body.code).toBe('refund_authorization_invalid');
      payment.next = [{ kind: 'terminal', status: 'authorization_expired' }];
      expect((await authorize(caseId, { receiptSecret: secret() }).expect(409)).body.code).toBe('refund_authorization_expired');
      payment.next = [{ kind: 'refused', code: 'refund_capture_unverified' }];
      const r = await authorize(caseId, { receiptSecret: secret() }).expect(409);
      expect(r.body).toMatchObject({ code: 'refund_rejected_by_payment', message: expect.stringContaining('refund_capture_unverified') });
      expect((await relays(caseId)).map((x) => [x.attemptStatus, x.refusal])).toEqual([['authorization_refused', null], ['authorization_expired', null], ['rejected', 'refund_capture_unverified']]);
      await cancel(caseId).expect(200);
    });

    it('a pending authorization and a failed attempt: pending blocks a new relay and cancellation; failed frees a new relay but never cancellation', async () => {
      const { caseId, paymentId } = await openCase();
      payment.next = [{ kind: 'pending' }];
      expect((await authorize(caseId, { receiptSecret: secret() }).expect(503)).body.code).toBe('refund_authorization_unresolved');
      expect((await relays(caseId))[0]!.attemptStatus).toBe('authorization_pending');
      expect((await authorize(caseId, { receiptSecret: secret() }).expect(409)).body.code).toBe('refund_authorization_in_progress');
      const [relay] = await relays(caseId);
      payment.records.set(paymentId, { attempts: [{ refundAttemptId: relay!.id, status: 'failed', approvedBy: { userId: OWNER } }], refusals: [] });
      await reconcile();
      expect((await cancel(caseId).expect(409)).body.code).toBe('refund_processing_started'); // a consumed receipt and a dispatched refund
      await authorize(caseId, { receiptSecret: secret() }).expect(201); // a new receipt, a new attempt id
      const all = await relays(caseId);
      expect(all.map((x) => x.attemptStatus)).toEqual(['failed', 'authorized']);
      expect(new Set(all.map((x) => x.id)).size).toBe(2);
    });

    it('the same key is bound to its case; another receipt under it reaches Payment, which refuses it (one receipt per attempt)', async () => {
      const { caseId } = await openCase();
      const { caseId: other } = await openCase();
      const idem = key();
      payment.next = [{ kind: 'pending' }];
      await authorize(caseId, { receiptSecret: secret() }, { idem }).expect(503);
      expect((await authorize(other, { receiptSecret: secret() }, { idem }).expect(409)).body.code).toBe('idempotency_key_conflict');
      payment.next = [{ kind: 'conflict' }];
      expect((await authorize(caseId, { receiptSecret: secret() }, { idem }).expect(409)).body.code).toBe('refund_authorization_conflict');
      expect((await relays(caseId))[0]!.attemptStatus).toBe('authorization_pending');
    });

    it('cancellation races a relay: exactly one wins, never both', async () => {
      for (let i = 0; i < 5; i++) {
        const { caseId } = await openCase();
        const [rel, can] = await Promise.all([authorize(caseId, { receiptSecret: secret() }), cancel(caseId)]);
        const c = await one(`SELECT status FROM refund_case WHERE id = $1`, [caseId]);
        const rs = await relays(caseId);
        if (c.status === 'cancelled') {
          expect(can.status).toBe(200);
          expect(rs).toEqual([]);
          expect([404, 409]).toContain(rel.status);
        } else {
          expect(rel.status).toBe(201);
          expect(can.status).toBe(409);
          expect(rs).toHaveLength(1);
        }
      }
    });
  });

  describe('database invariants (migration 0034)', () => {
    it('a relay only for an open case; the mirror never moves backwards; an unconfirmed relay blocks cancellation; no deletion', async () => {
      const { caseId, paymentId } = await openCase();
      await authorize(caseId, { receiptSecret: secret() }).expect(201);
      const [relay] = await relays(caseId);
      const fail = (sql: string, params: unknown[] = []) => expect(admin.query(sql, params)).rejects.toThrow();
      await fail(`UPDATE refund_authorization_relay SET "attemptStatus" = 'authorization_pending' WHERE id = $1`, [relay!.id]);
      await fail(`UPDATE refund_authorization_relay SET "attemptStatus" = 'rejected', refusal = 'refund_in_progress' WHERE id = $1`, [relay!.id]);
      await fail(`UPDATE refund_authorization_relay SET "paymentId" = gen_random_uuid() WHERE id = $1`, [relay!.id]);
      await fail(`DELETE FROM refund_authorization_relay WHERE id = $1`, [relay!.id]);
      await fail(`UPDATE refund_case SET status = 'cancelled', "cancelledBy" = gen_random_uuid() WHERE id = $1`, [caseId]);
      await fail(`INSERT INTO refund_authorization_relay (id, "refundCaseId", "paymentId", "requestedBy", "idempotencyKey", "requestHash") VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'k-12345678', repeat('a', 64))`, [caseId, paymentId]);
      const { caseId: c2, paymentId: p2 } = await openCase();
      await cancel(c2).expect(200);
      await fail(`INSERT INTO refund_authorization_relay (id, "refundCaseId", "paymentId", "requestedBy", "idempotencyKey", "requestHash") VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), 'k-12345678', repeat('a', 64))`, [c2, p2]);
    });
  });
});

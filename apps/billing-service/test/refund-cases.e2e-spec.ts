import { randomBytes, randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DbService, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity, type AuthMembership, type EventEnvelope, type OrganizationReferenceResolver,
} from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { BILLING_OPERATIONS } from '../src/admission/caller-admission.policy.js';
import { billingMigrationsDir } from '../src/app.module.js';
import type { BillingConfig } from '../src/config/billing-config.js';
import type { PaymentEventFacts, PaymentEventName } from '../src/domain/payment-event-decision.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import type { CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import type { TransitionContext, Caller } from '../src/domain/actors.js';
import { normaliseCreateInvoiceInput } from '../src/domain/invoice-input.js';
import { recordTransition } from '../src/domain/transitions.js';
import { InvoiceRepository } from '../src/invoices/invoice.repository.js';
import { PaymentRequestRepository } from '../src/invoices/payment-request.repository.js';
import { HttpOwnerAuthority } from '../src/platforms/owner-authority.client.js';
import type { DisputeExposure } from '../src/refunds/dispute-exposure.js';
import { RefundModule } from '../src/refunds/refund.module.js';
import { RefundEffectService } from '../src/refunds/refund-effect.service.js';
import type { PaymentRefundClient } from '../src/refunds/payment-refund-client.js';
import { createTestApp, type TestApp } from './support/app.js';
import { FakeAuth } from './support/fake-auth.js';
import { paymentPurposeOf } from './support/settlement.js';
import { describeWithEnv } from './support/env.js';

type Row = Record<string, any>;

/** Payment, as the dispatcher sees it: a scripted outcome per payment request (default: transient, i.e. Payment did not answer). */
class FakePaymentClient implements PaymentClient {
  readonly outcomes = new Map<string, CreatePaymentOutcome>();
  readonly calls: PaymentCreateBody[] = [];
  async createPayment(body: PaymentCreateBody): Promise<CreatePaymentOutcome> {
    this.calls.push(body);
    return this.outcomes.get(body.paymentRequestId) ?? { kind: 'transient' };
  }
  async getPayment(): Promise<PaymentSnapshot | null> {
    return null;
  }
  async cancelPayment(): Promise<CancelPaymentOutcome> {
    return { kind: 'cancelled' };
  }
}

/** Core V2 S6d: Payment's refund port, authorizing every relayed attempt (the S6b/S6c Payment behaviour is certified in its own suites). */
const refundsAtPayment: PaymentRefundClient = {
  relay: async (_paymentId, _key, body) => ({ kind: 'attempt', attempt: { refundAttemptId: body.refundAttemptId, status: 'authorized', approvedBy: { userId: randomUUID() } } }),
  refunds: async () => ({ attempts: [], refusals: [], authorizations: [] }),
};

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const PLATFORM = randomUUID();
// Core V2 S5d: a fresh Organization per test (beforeEach). T1/T2 (S5D-1, S5D-2) restrict an Organization's NEW requests, so one test's
// overdue or unconfirmed fixtures must never restrict the next one's; restrictions are derived and never cleared by a test.
let ORG = randomUUID();
let ORG2 = randomUUID();
const U = { b1: randomUUID(), b2: randomUUID(), a1: randomUUID(), a2: randomUUID(), adminBeneficiary: randomUUID(), m1: randomUUID(), owner: randomUUID() };
const membership = (organizationId: string, o: { admin?: boolean; status?: AuthMembership['status'] } = {}): AuthMembership => ({
  id: randomUUID(), organization: { id: organizationId }, platform: { id: PLATFORM }, status: o.status ?? 'active', isOrganizationAdmin: o.admin ?? false,
});

/**
 * Core V2 S6a refund cases and eligibility (register BIL-23, BIL-25; ADR-0067 decision 6; S0 D3, D4, FC-3; the Owner's R6A-1 to R6A-9), for
 * DEVELOPMENT AND SIMULATION ONLY: the real application on real PostgreSQL 16; purchases and captures through Billing's real settlement
 * paths (checkout, the assisted channel, Payment's verified events); the Owner's `/auth/grants` and `/auth/platform-access` through Billing's
 * real client against a fake Auth; the dispute boundary under test control.
 */
describeWithEnv('refund cases (Core V2 S6a, simulation) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const payment = new FakePaymentClient();
  const auth = new FakeAuth();
  /** The dispute-exposure boundary under test control (R6A-3): an open dispute per payment, or the source unavailable. */
  const disputes = { open: new Set<string>(), down: false };
  const disputeExposure: DisputeExposure = {
    status: async (paymentId) => {
      if (disputes.down) throw new ServiceUnavailableException();
      return disputes.open.has(paymentId) ? 'open' : 'none';
    },
  };
  const producer = generateServiceToken();
  const identities = new Map<string, AuthIdentity>();
  const resetIdentities = () => {
    identities.clear();
    identities.set('b1', { id: U.b1, adminTier: null, isActive: true, memberships: [membership(ORG), membership(ORG2)] });
    identities.set('b2', { id: U.b2, adminTier: null, isActive: true, memberships: [membership(ORG)] });
    identities.set('a1', { id: U.a1, adminTier: null, isActive: true, memberships: [membership(ORG, { admin: true })] });
    identities.set('a2', { id: U.a2, adminTier: null, isActive: true, memberships: [membership(ORG2, { admin: true })] });
    identities.set('admin-beneficiary', { id: U.adminBeneficiary, adminTier: null, isActive: true, memberships: [membership(ORG, { admin: true })] });
    identities.set('m1', { id: U.m1, adminTier: null, isActive: true, memberships: [membership(ORG)] });
    identities.set('owner', { id: U.owner, adminTier: 'owner', isActive: true, memberships: [membership(ORG, { admin: true })] });
  };
  const authClient: AuthClient = {
    getIdentity: async (bearer) => {
      if (bearer === 'auth-down') throw new ServiceUnavailableException();
      return identities.get(bearer) ?? null;
    },
    hasPlatformAccess: async () => false,
  };
  const reference: OrganizationReferenceResolver = {
    resolve: async (organizationId) => (([ORG, ORG2] as string[]).includes(organizationId) ? { organizationId, platformId: PLATFORM, companyId: COMPANY } : null),
  };
  const server = () => t.app.getHttpServer();

  // ── fixtures
  let seq = 0;
  const productOf = async () =>
    (await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId") VALUES ('billing-owner', 'company', $1, $2, 'Personal plan', 'active', 'personal', $3) RETURNING id`,
      [COMPANY, `plan-${++seq}`, PLATFORM])).rows[0].id as string;
  const priceOf = async (productId: string, unit = 9000) =>
    (await admin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom") VALUES ($1, $2, 'TND', $3, 'recurring', 'month', 1, '2020-01-01T00:00:00Z') RETURNING id`,
      [productId, `r-${++seq}`, unit])).rows[0].id as string;
  const setCap = async (amount: number) => (await admin.query(`INSERT INTO fee_cap ("platformId", amount, currency, "setBy") VALUES ($1, $2, 'TND', $3) RETURNING version`, [PLATFORM, amount, randomUUID()])).rows[0].version as number;
  const operator = randomUUID();
  let delegation: string;
  const approveFee = async (organizationId: string, productId: string, amount: number) => {
    const id = (await admin.query(`INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES ($1, $2, $3, $4, 'TND', $5, $6) RETURNING id`,
      [PLATFORM, organizationId, productId, amount, delegation, operator])).rows[0].id as string;
    await admin.query(`UPDATE fee_proposal SET status = 'approved', "decidedBy" = $2 WHERE id = $1`, [id, randomUUID()]);
    return id;
  };
  /** A test-only bypass of the immutability triggers (as a superuser): moves a request's consent, collection and deadline into the past. */
  const backdate = async (id: string, sql: string, params: unknown[] = []) => {
    const cl = await admin.connect();
    try {
      await cl.query(`SET session_replication_role = replica`);
      await cl.query(sql, [id, ...params]);
    } finally {
      await cl.query(`SET session_replication_role = origin`);
      cl.release();
    }
  };
  const backdateConsent = (id: string) => backdate(id, `UPDATE assistance_request SET "consentAt" = now() - interval '200 hours' WHERE id = $1`);
  /** The deadline is now past: collected 73 hours ago, reported then, settleBy one hour ago. */
  const expireDeadline = (id: string) => backdate(id, `UPDATE assistance_request SET "cashCollectedAt" = now() - interval '73 hours', "reportedAt" = now() - interval '73 hours',
    "settleBy" = now() - interval '1 hour' WHERE id = $1`);

  // ── HTTP
  let k = 0;
  const key = () => `s6a-${++k}-${randomUUID().slice(0, 8)}`;
  const send = (r: request.Test, bearer: string | null, idem: string | null) => {
    if (bearer) r = r.set('authorization', `Bearer ${bearer}`);
    if (idem) r = r.set('idempotency-key', idem);
    return r;
  };
  const create = (body: unknown, bearer = 'b1') => send(request(server()).post('/billing/assistance-requests'), bearer, key()).send(body as object);
  const reportCash = (id: string, at: string, bearer = 'a1') => send(request(server()).post(`/billing/assistance-requests/${id}/cash-collection`), bearer, key()).send({ cashCollectedAt: at });
  const settle = (id: string, bearer: string | null = 'a1', idem: string | null = key(), body?: unknown) => {
    const r = send(request(server()).post(`/billing/assistance-requests/${id}/settlement`), bearer, idem);
    return body === undefined ? r.send() : r.send(body as object);
  };
  const entitlement = (userId: string, productId: string) =>
    request(server()).get(`/billing/users/${userId}/platforms/${PLATFORM}/products/${productId}/entitlement`).set('authorization', `Bearer ${producer.token}`);

  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n);
  const audit = async (resourceId: string) =>
    (await admin.query(`SELECT name, payload FROM outbox WHERE name LIKE 'audit.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", name`, [resourceId])).rows as Row[];
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const dispatch = () => t.app.get(PaymentDispatcher).dispatchOnce(0, 100);

  /** A request consented by `beneficiary` in `organizationId`, whose cash the Organization actor collected ten minutes ago. */
  const collected = async (o: { beneficiary?: string; organizationId?: string; unit?: number; fee?: number } = {}) => {
    const productId = await productOf();
    const priceId = await priceOf(productId, o.unit);
    if (o.fee !== undefined) await approveFee(o.organizationId ?? ORG, productId, o.fee);
    const c = await create({ organizationId: o.organizationId ?? ORG, productId, priceId, consent: true }, o.beneficiary ?? 'b1');
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await backdateConsent(c.body.id);
    const r = await reportCash(c.body.id, ago(10 * 60_000), (o.organizationId ?? ORG) === ORG ? 'a1' : 'a2');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { id: c.body.id as string, productId, priceId, terms: c.body as Row };
  };
  /** Payment accepted the request (the dispatcher records its paymentId): the channel's payment is now requested at Payment. */
  const accepted = async (paymentRequestId: string) => {
    const inv = await one(`SELECT i.* FROM invoice i JOIN payment_request r ON r."invoiceId" = i.id WHERE r.id = $1`, [paymentRequestId]);
    const paymentId = randomUUID();
    payment.outcomes.set(paymentRequestId, { kind: 'accepted', snapshot: {
      paymentId, paymentRequestId, status: 'pending', amount: Number(inv.total), currency: inv.currency, sourceType: 'invoice', sourceId: inv.id,
      payer: { type: 'organization', id: inv.payerId }, seller: { type: 'company', id: COMPANY }, organizationId: inv.organizationId, closedAt: null,
    } as PaymentSnapshot });
    await dispatch();
    return { inv, paymentId };
  };
  const paymentEvent = (name: PaymentEventName, inv: Row, paymentRequestId: string, paymentId: string, beneficiaryUserId: string): EventEnvelope => {
    const id = randomUUID();
    const facts: PaymentEventFacts = {
      name, source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId, sourceType: 'invoice', sourceId: inv.id,
      payer: { type: 'organization', id: inv.payerId }, seller: { type: 'company', id: COMPANY }, organizationId: inv.organizationId, amount: Number(inv.total), currency: inv.currency,
      revision: 1, purpose: 'assisted_settlement', beneficiaryUserId, liveMode: false,
    };
    const { name: n, source, ...payload } = facts;
    return { id, name: n, payload: payload as Record<string, unknown>, headers: { eventId: id, occurredAt: new Date().toISOString(), source, version: 1 } };
  };
  /** Starts a settlement and has Payment accept it. */
  const started = async (requestId: string, beneficiaryUserId = U.b1) => {
    const s = await settle(requestId);
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    const { inv, paymentId } = await accepted(s.body.paymentRequestId);
    const ev = (name: PaymentEventName) => paymentEvent(name, inv, s.body.paymentRequestId, paymentId, beneficiaryUserId);
    return { ...s.body, inv, paymentId, ev } as { invoiceId: string; paymentRequestId: string; inv: Row; paymentId: string; ev: (n: PaymentEventName) => EventEnvelope };
  };
  const statusOf = async (id: string) => (await one(`SELECT status FROM assistance_request WHERE id = $1`, [id])).status as string;
  const purchases = (id: string) => count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [id]);
  const obligations = (id: string) => count(`SELECT count(*) AS n FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [id]);

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings6a');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    await admin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [PLATFORM, COMPANY, randomUUID()]);
    delegation = (await admin.query(`INSERT INTO fee_delegation ("platformId", "operatorUserId", "grantedBy") VALUES ($1, $2, $3) RETURNING id`, [PLATFORM, operator, randomUUID()])).rows[0].id;
    await setCap(5000);
    await auth.start();
    auth.identities.set('owner-tok', { userId: U.owner, kind: 'owner', companyId: COMPANY });
    auth.identities.set('foreign-owner-tok', { userId: randomUUID(), kind: 'owner', companyId: OTHER_COMPANY });
    auth.identities.set('operator-tok', { userId: randomUUID(), kind: 'operator', companyId: null });
    auth.identities.set('member-tok', { userId: U.a1, kind: 'member', companyId: null });
    auth.platforms.set(PLATFORM, COMPANY);
    t = await createTestApp({
      databaseUrl: db.url, authClient, organizationReference: reference, paymentClient: payment, disputeExposure, ownerAuthority: new HttpOwnerAuthority({ baseUrl: auth.url }),
      paymentRefundClient: refundsAtPayment, // Core V2 S6d: Payment authorizes every relay (S6b's own behaviour is certified elsewhere)
      tokens: [{ caller: 'test-producer', digest: producer.digest }],
      env: { BILLING_SERVICE_POLICY: JSON.stringify({ callers: { 'test-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: [PLATFORM] } } }) },
    });
  });
  beforeEach(() => {
    ORG = randomUUID();
    ORG2 = randomUUID();
    resetIdentities();
    auth.reset();
    disputes.open.clear();
    disputes.down = false;
  });
  afterAll(async () => {
    await t?.app.close();
    await auth.stop();
    await admin?.end();
    await db?.drop();
  });

  // ── S6a fixtures: verified captures through Billing's real paths
  /** A direct purchase through the real checkout route, accepted by Payment, then Payment's verified success. */
  const directPurchase = async (buyer = 'b1', given?: { productId: string; priceId: string }) => {
    const productId = given?.productId ?? await productOf();
    const priceId = given?.priceId ?? await priceOf(productId, 4900);
    const c = await send(request(server()).post('/billing/checkout/direct'), buyer, key()).send({ platformId: PLATFORM, productId, priceId });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const inv = await one(`SELECT * FROM invoice WHERE id = $1`, [c.body.invoiceId]);
    const paymentId = randomUUID();
    payment.outcomes.set(c.body.paymentRequestId, { kind: 'accepted', snapshot: {
      paymentId, paymentRequestId: c.body.paymentRequestId, status: 'pending', amount: Number(inv.total), currency: inv.currency, sourceType: 'invoice', sourceId: inv.id,
      payer: { type: 'user', id: inv.payerId }, seller: { type: 'company', id: COMPANY }, organizationId: null, closedAt: null,
    } as PaymentSnapshot });
    await dispatch();
    const id = randomUUID();
    const facts = {
      paymentId, producer: 'billing-service', paymentRequestId: c.body.paymentRequestId, sourceType: 'invoice', sourceId: inv.id,
      payer: { type: 'user', id: inv.payerId }, seller: { type: 'company', id: COMPANY }, organizationId: null, amount: Number(inv.total), currency: inv.currency,
      revision: 1, ...(await paymentPurposeOf(admin, inv.id)), liveMode: false,
    };
    await t.bus.deliver({ id, name: 'payment.succeeded', payload: facts as Record<string, unknown>, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
    expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "invoiceId" = $1`, [inv.id])).toBe(1);
    return { paymentId, invoiceId: inv.id as string, paymentRequestId: c.body.paymentRequestId as string, amount: Number(inv.total), productId };
  };
  /** An assisted purchase: the Organization's verified electronic settlement of collected cash (S5b). */
  const assistedPurchase = async () => {
    const r = await collected({ unit: 6100, fee: 400 });
    const s = await started(r.id);
    await t.bus.deliver(s.ev('payment.succeeded'));
    expect(await purchases(r.id)).toBe(1);
    return { paymentId: s.paymentId, invoiceId: s.invoiceId, amount: Number(s.inv.total), requestId: r.id };
  };
  /** A late assisted settlement held for reconciliation (E-7): the obligation existed when Payment's verified success arrived. */
  const lateSettlement = async () => {
    const r = await collected({ unit: 5300 });
    const s = await started(r.id);
    await expireDeadline(r.id);
    await backdate(r.id, `INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt")
      SELECT id, "organizationId", "beneficiaryUserId", "totalAmount", currency, "cashCollectedAt" FROM assistance_request WHERE id = $1`);
    await t.bus.deliver(s.ev('payment.succeeded'));
    expect(await count(`SELECT count(*) AS n FROM assistance_late_settlement WHERE "invoiceId" = $1`, [s.invoiceId])).toBe(1);
    return { paymentId: s.paymentId, invoiceId: s.invoiceId, amount: Number(s.inv.total), requestId: r.id };
  };
  /**
   * A producer invoice of the given target (non_entitlement for `none`, organization_subscription for `organization`), sold by `seller`, its
   * payment request acknowledged by Payment and Payment's verified success applied through the real path (the S3b `settle` helper, with a
   * real Company seller). `paid: false` stops before the success (no verified capture).
   */
  const producerPayment = async (o: { target: 'none' | 'organization'; seller?: { type: string; id: string }; paid?: boolean }) => {
    const seller = o.seller ?? { type: 'company', id: COMPANY };
    const productId = (await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId")
      VALUES ('test-producer', $1, $2, $3, 'Item', 'active', $4, $5) RETURNING id`, [seller.type, seller.id, `item-${++seq}`, o.target, PLATFORM])).rows[0].id as string;
    const priceId = (await admin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom")
      VALUES ($1, $2, 'TND', 2500, $3, $4, $5, '2020-01-01') RETURNING id`,
      [productId, `r-${++seq}`, o.target === 'organization' ? 'recurring' : 'one_time', o.target === 'organization' ? 'month' : null, o.target === 'organization' ? 1 : null])).rows[0].id as string;
    const ctx: TransitionContext = { actor: { type: 'service', id: 'test-producer' }, cause: { type: 'request', id: randomUUID() }, correlationId: 'refund-fixture' };
    const caller: Caller = { kind: 'service', service: 'test-producer' };
    const payer = { type: 'user', id: `payer-${++seq}` };
    const organizationId = o.target === 'organization' ? ORG : null;
    const input = normaliseCreateInvoiceInput({
      invoiceRequestId: randomUUID(), seller, payer, organizationId, sourceType: 'contract', sourceId: `s-${seq}`,
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
    if (o.paid !== false) {
      const eventId = randomUUID();
      await requests.applyPaymentEvent(eventId, {
        name: 'payment.succeeded', source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId: pr.id, sourceType: 'invoice', sourceId: open.id,
        payer, seller, organizationId, amount: Number(open.total), currency: open.currency, revision: 1, ...(await paymentPurposeOf(admin, open.id)),
      } as never, { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: eventId }, correlationId: 'refund-fixture' }, new Date());
    }
    return { paymentId, invoiceId: open.id as string, amount: Number(open.total) };
  };

  // ── S6a HTTP
  const openCase = (body: unknown, o: { bearer?: string | null; idem?: string | null } = {}) =>
    send(request(server()).post('/billing/admin/refund-cases'), o.bearer === undefined ? 'owner-tok' : o.bearer, o.idem === undefined ? key() : o.idem).send(body as object);
  const cancelCase = (id: string, bearer = 'owner-tok', idem: string = key()) => send(request(server()).post(`/billing/admin/refund-cases/${id}/cancel`), bearer, idem).send();
  const readCase = (id: string, bearer = 'owner-tok') => send(request(server()).get(`/billing/admin/refund-cases/${id}`), bearer, null);
  /** Everything a refund case must never touch (R6A-6, R6A-8): purchases, reversals, invoices, payment requests, obligations, events. */
  const untouched = async () => one(`SELECT
    (SELECT count(*) FROM subscription_purchase) AS purchases, (SELECT count(*) FROM subscription_purchase_reversal) AS reversals,
    (SELECT string_agg(status, ',' ORDER BY id) FROM invoice) AS invoices, (SELECT string_agg(status, ',' ORDER BY id) FROM payment_request) AS requests,
    (SELECT count(*) FROM cash_return_obligation) AS obligations, (SELECT count(*) FROM outbox WHERE name NOT LIKE 'audit.%') AS events`);

  // ─────────────────────────────────────────────────────────────────────────────────────────────── eligibility (R6A-1)

  describe('eligible payments (R6A-1)', () => {
    it('a verified direct purchase: the full amount computed by Billing; nothing refunded, nothing mutated; audited with the Company and Platform', async () => {
      const p = await directPurchase();
      const before = await untouched();
      const calls = payment.calls.length;
      const r = await openCase({ paymentId: p.paymentId, reason: 'customer_request' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ paymentId: p.paymentId, companyId: COMPANY, platformId: PLATFORM, organizationId: null, amount: p.amount, currency: 'TND',
        status: 'open', eligibility: 'personal_purchase', reason: 'customer_request', legalOverride: false, cancelledAt: null, completedAt: null, attempts: [] });
      expect(await untouched()).toEqual(before);
      expect(payment.calls.length).toBe(calls); // no refund execution: Payment is never contacted
      expect((await entitlement(U.b1, p.productId).expect(200)).body.valid).toBe(true); // the purchase and its entitlement stand
      const ev = (await audit(r.body.id)).find((e) => e.name === 'audit.refund_case.opened')!;
      expect(ev.payload).toMatchObject({ actor: { type: 'user', id: U.owner, userKind: 'owner' },
        changes: { payment_id: p.paymentId, company_id: COMPANY, platform_id: PLATFORM, amount: p.amount, eligibility: 'personal_purchase', reason: 'customer_request', legal_override: false } });
      expect((await readCase(r.body.id)).body).toEqual(r.body);
    });

    it('a verified assisted purchase: the Organization\'s captured base, refundable to the payer; no cash-return obligation is created (R6A-8)', async () => {
      const p = await assistedPurchase();
      const r = await openCase({ paymentId: p.paymentId, reason: 'service_not_provided' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ eligibility: 'personal_purchase', amount: 6100, organizationId: ORG }); // the base only, never the fee
      expect(await obligations(p.requestId)).toBe(0);
      expect(await statusOf(p.requestId)).toBe('settled');
    });

    it('a late assisted settlement held for reconciliation, and a verified non-entitlement payment', async () => {
      const late = await lateSettlement();
      const l = await openCase({ paymentId: late.paymentId, reason: 'late_settlement_unapplied' });
      expect(l.status, JSON.stringify(l.body)).toBe(201);
      expect(l.body).toMatchObject({ eligibility: 'late_assisted_settlement', amount: late.amount });
      expect((await one(`SELECT status FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [late.requestId])).status).toBe('open'); // unchanged
      const ne = await producerPayment({ target: 'none' });
      const n = await openCase({ paymentId: ne.paymentId, reason: 'duplicate_charge' });
      expect(n.status, JSON.stringify(n.body)).toBe(201);
      expect(n.body).toMatchObject({ eligibility: 'non_entitlement', amount: ne.amount });
    });

    it('refused: an Organization-subscription payment, an uncaptured payment, an unknown payment; legalOverride grants nothing', async () => {
      const org = await producerPayment({ target: 'organization' });
      expect((await openCase({ paymentId: org.paymentId, reason: 'customer_request' })).body.code).toBe('refund_not_eligible');
      expect((await openCase({ paymentId: org.paymentId, reason: 'legal_requirement', legalOverride: true })).body.code).toBe('refund_not_eligible');
      const unpaid = await producerPayment({ target: 'none', paid: false });
      expect((await openCase({ paymentId: unpaid.paymentId, reason: 'customer_request' })).body.code).toBe('refund_not_eligible'); // no verified capture
      expect((await openCase({ paymentId: randomUUID(), reason: 'customer_request' })).status).toBe(404);
      expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "paymentId" IN ($1, $2)`, [org.paymentId, unpaid.paymentId])).toBe(0);
    });

    it('no partial refund and no caller-chosen amount: amount, currency and any other field are refused; reasons are a closed list', async () => {
      const p = await producerPayment({ target: 'none' });
      for (const bad of [{ paymentId: p.paymentId, reason: 'customer_request', amount: 1 }, { paymentId: p.paymentId, reason: 'customer_request', currency: 'EUR' },
        { paymentId: p.paymentId, reason: 'because' }, { paymentId: p.paymentId }, { paymentId: 'nope', reason: 'customer_request' },
        { paymentId: p.paymentId, reason: 'customer_request', legalOverride: 'yes' }]) {
        const r = await openCase(bad);
        expect([r.status, r.body.code], JSON.stringify(bad)).toEqual([400, 'invalid_refund_request']);
      }
      expect((await openCase({ paymentId: p.paymentId, reason: 'customer_request' }, { idem: null })).status).toBe(400);
    });

    it('a purchase already reversed is not eligible', async () => {
      const p = await directPurchase();
      const purchase = await one(`SELECT id FROM subscription_purchase WHERE "invoiceId" = $1`, [p.invoiceId]);
      await admin.query(`INSERT INTO subscription_purchase_reversal ("purchaseId", cause) VALUES ($1, 'final_lost_chargeback')`, [purchase.id]);
      expect((await openCase({ paymentId: p.paymentId, reason: 'customer_request' })).body.code).toBe('refund_not_eligible');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── authority (R6A-2, R6A-7)

  describe('authority (R6A-2)', () => {
    it('only the Owner of the seller Company: another Company\'s Owner and an Organization-sold payment are 404; operators and members 403; services 401; Auth down 503', async () => {
      const p = await producerPayment({ target: 'none' });
      const foreign = await producerPayment({ target: 'none', seller: { type: 'company', id: OTHER_COMPANY } });
      const orgSold = await producerPayment({ target: 'none', seller: { type: 'organization', id: ORG } });
      const body = { paymentId: p.paymentId, reason: 'customer_request' };
      expect((await openCase(body, { bearer: 'foreign-owner-tok' })).status).toBe(404);
      expect((await openCase({ ...body, paymentId: foreign.paymentId })).status).toBe(404);
      expect((await openCase({ ...body, paymentId: orgSold.paymentId })).status).toBe(404);
      expect([(await openCase(body, { bearer: 'operator-tok' })).status, (await openCase(body, { bearer: 'operator-tok' })).body.code]).toEqual([403, 'operation_not_permitted']);
      expect((await openCase(body, { bearer: 'member-tok' })).status).toBe(403);
      expect((await openCase(body, { bearer: producer.token })).status).toBe(401);
      expect((await openCase(body, { bearer: null })).status).toBe(401);
      auth.mode = 'down';
      expect((await openCase(body)).status).toBe(503);
      auth.target = 'access';
      expect((await openCase(body)).status).toBe(503);
      auth.reset();
      auth.platforms.delete(PLATFORM); // Auth no longer says the Platform is in the Owner's Company
      expect((await openCase(body)).status).toBe(404);
      auth.platforms.set(PLATFORM, COMPANY);
      expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "paymentId" = $1`, [p.paymentId])).toBe(0);
      expect(auth.received.some((r) => r.path.includes('step-up'))).toBe(false); // R6A-7: no step-up is asked or consumed
      const ok = await openCase(body);
      expect(ok.status).toBe(201);
      expect((await readCase(ok.body.id, 'foreign-owner-tok')).status).toBe(404);
      expect((await cancelCase(ok.body.id, 'foreign-owner-tok')).status).toBe(404);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── disputes (R6A-3)

  it('an open dispute blocks the case; an unavailable dispute source fails closed (503); nothing is written', async () => {
    const p = await directPurchase();
    disputes.open.add(p.paymentId);
    expect([(await openCase({ paymentId: p.paymentId, reason: 'customer_request', legalOverride: true })).status,
      (await openCase({ paymentId: p.paymentId, reason: 'customer_request' })).body.code]).toEqual([409, 'refund_dispute_open']);
    disputes.open.clear();
    disputes.down = true;
    expect((await openCase({ paymentId: p.paymentId, reason: 'customer_request' })).status).toBe(503);
    expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "paymentId" = $1`, [p.paymentId])).toBe(0);
    disputes.down = false;
    expect((await openCase({ paymentId: p.paymentId, reason: 'customer_request' })).status).toBe(201);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── uniqueness, lifecycle, idempotency (R6A-6, FC-3)

  describe('lifecycle and uniqueness (R6A-6, FC-3)', () => {
    it('one live case per payment; its key replays; cancellation frees it; a cancelled case is terminal', async () => {
      const p = await directPurchase();
      const k1 = key();
      const first = await openCase({ paymentId: p.paymentId, reason: 'customer_request' }, { idem: k1 });
      const replay = await openCase({ paymentId: p.paymentId, reason: 'customer_request' }, { idem: k1 });
      expect([replay.status, replay.headers['idempotent-replayed'], replay.body]).toEqual([201, 'true', first.body]);
      expect((await openCase({ paymentId: p.paymentId, reason: 'duplicate_charge' }, { idem: k1 })).body.code).toBe('idempotency_key_conflict');
      expect((await openCase({ paymentId: p.paymentId, reason: 'duplicate_charge' })).body.code).toBe('refund_case_exists');
      const c = await cancelCase(first.body.id);
      expect(c.status).toBe(200);
      expect(c.body).toMatchObject({ status: 'cancelled', cancelledAt: expect.any(String) });
      expect((await cancelCase(first.body.id)).body.code).toBe('refund_case_not_open');
      expect((await send(request(server()).post(`/billing/admin/refund-cases/${first.body.id}/cancel`), 'owner-tok', key()).send({ status: 'open' })).status).toBe(400);
      const again = await openCase({ paymentId: p.paymentId, reason: 'duplicate_charge' });
      expect(again.status).toBe(201);
      expect(again.body.id).not.toBe(first.body.id);
      expect((await audit(first.body.id)).map((e) => e.name)).toEqual(['audit.refund_case.opened', 'audit.refund_case.cancelled']);
    });

    it('a completed case is terminal: it keeps the payment forever, cannot be cancelled, and completion needs Payment\'s recorded completion (S6c)', async () => {
      const p = await directPurchase();
      const c = (await openCase({ paymentId: p.paymentId, reason: 'customer_request' })).body;
      await expect(admin.query(`UPDATE refund_case SET status = 'completed', "completedAt" = now() WHERE id = $1`, [c.id])).rejects.toMatchObject({ constraint: 'refund_case_completion_evidence' }); // Core V2 S6c: only with Payment's recorded completion
      await backdate(c.id, `UPDATE refund_case SET status = 'completed', "completedAt" = now() WHERE id = $1`); // a test-only stand-in for S6c's completion
      expect((await cancelCase(c.id)).body.code).toBe('refund_case_not_open');
      expect((await openCase({ paymentId: p.paymentId, reason: 'customer_request' })).body.code).toBe('refund_case_exists');
      await expect(admin.query(`UPDATE refund_case SET status = 'open', "completedAt" = NULL WHERE id = $1`, [c.id])).rejects.toMatchObject({ constraint: 'refund_case_not_open' });
      await expect(admin.query(`DELETE FROM refund_case WHERE id = $1`, [c.id])).rejects.toThrow();
    });

    it('concurrent opens with different keys create exactly one case', async () => {
      const p = await directPurchase();
      const rs = await Promise.all(Array.from({ length: 6 }, () => openCase({ paymentId: p.paymentId, reason: 'customer_request' })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409).every((r) => r.body.code === 'refund_case_exists')).toBe(true);
      expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "paymentId" = $1`, [p.paymentId])).toBe(1);
      const id = rs.find((r) => r.status === 201)!.body.id;
      const cs = await Promise.all(Array.from({ length: 4 }, () => cancelCase(id)));
      expect(cs.filter((r) => r.status === 200)).toHaveLength(1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the database (migration 0033)

  it('the database refuses a case that does not match the verified capture, its full amount, the seller or an eligible basis', async () => {
    const p = await directPurchase();
    const ref = await one(`SELECT pr.id AS "paymentRequestId", s.id AS "purchaseId", s."receiptId" FROM payment_request pr JOIN subscription_purchase s ON s."paymentRequestId" = pr.id WHERE pr."paymentId" = $1`, [p.paymentId]);
    const ins = (o: Row) => admin.query(`INSERT INTO refund_case ("paymentId", "paymentRequestId", "invoiceId", "receiptId", eligibility, "purchaseId", "companyId", "platformId", amount, currency, reason, "openedBy")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'customer_request', $11)`,
      [o.paymentId ?? p.paymentId, ref.paymentRequestId, p.invoiceId, o.receiptId ?? ref.receiptId, o.eligibility ?? 'personal_purchase', o.purchaseId === undefined ? ref.purchaseId : o.purchaseId,
        o.companyId ?? COMPANY, o.platformId ?? PLATFORM, o.amount ?? p.amount, o.currency ?? 'TND', U.owner]);
    await expect(ins({ amount: p.amount - 1 })).rejects.toMatchObject({ constraint: 'refund_case_full_amount' }); // no partial refund
    await expect(ins({ currency: 'EUR' })).rejects.toMatchObject({ code: expect.any(String) });
    await expect(ins({ companyId: OTHER_COMPANY })).rejects.toMatchObject({ constraint: 'refund_case_seller' });
    await expect(ins({ platformId: randomUUID() })).rejects.toMatchObject({ constraint: 'refund_case_seller' });
    await expect(ins({ paymentId: randomUUID() })).rejects.toMatchObject({ constraint: 'refund_case_capture_unverified' });
    await expect(ins({ eligibility: 'non_entitlement', purchaseId: null })).rejects.toMatchObject({ constraint: 'refund_case_not_eligible' });
    await expect(ins({ eligibility: 'late_assisted_settlement', purchaseId: null })).rejects.toMatchObject({ code: '23514' });
    expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "paymentId" = $1`, [p.paymentId])).toBe(0);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── Core V2 S6d: commercial effects

  describe('Core V2 S6d: commercial effects of a completed refund (R6D-1 to R6D-6)', () => {
    const effects = () => t.app.get(RefundEffectService);
    /** S6c: the Owner relays a receipt, then Payment's verified `refund.case_completed` completes the case. */
    const completeRefund = async (caseId: string) => {
      const r = await send(request(server()).post(`/billing/admin/refund-cases/${caseId}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const c = await one(`SELECT c.id, c."paymentId", c.amount::int, trim(c.currency) AS currency, r.id AS "attemptId" FROM refund_case c JOIN refund_authorization_relay r ON r."refundCaseId" = c.id WHERE c.id = $1`, [caseId]);
      const id = randomUUID();
      await t.bus.deliver({ id, name: 'refund.case_completed', payload: {
        refundCaseId: c.id, refundAuthorizationId: randomUUID(), refundAttemptId: c.attemptId, paymentId: c.paymentId, paymentRequestId: randomUUID(), producer: 'billing-service',
        approvedAmount: c.amount, currency: c.currency, completedAt: new Date().toISOString(), liveMode: false, organizationId: null, purpose: 'direct_purchase',
      }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
      expect((await one(`SELECT status FROM refund_case WHERE id = $1`, [caseId])).status).toBe('completed');
    };
    const caseFor = async (paymentId: string) => (await openCase({ paymentId, reason: 'customer_request' })).body.id as string;
    const effect = (caseId: string) => one(`SELECT outcome, "purchaseId", "obligationId", reason FROM refund_case_effect WHERE "refundCaseId" = $1`, [caseId]);
    const purchaseOf = (paymentId: string) => one(`SELECT s.* FROM subscription_purchase s JOIN payment_request pr ON pr.id = s."paymentRequestId" WHERE pr."paymentId" = $1`, [paymentId]);
    const spans = async (personalSubscriptionId: string) => (await admin.query(`SELECT "purchaseId", "effectiveStart", "effectiveEnd" FROM billing_personal_spans($1)`, [personalSubscriptionId])).rows as Row[];
    const reversals = (purchaseId: string) => count(`SELECT count(*) AS n FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [purchaseId]);
    const obligationsOf = async (requestId: string) => (await admin.query(`SELECT id, origin, amount::int, status, "refundCaseId" FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [requestId])).rows as Row[];

    it('a completed direct-purchase refund reverses that purchase once; the entitlement ends; the purchase record is kept; audited', async () => {
      const p = await directPurchase('b2');
      const caseId = await caseFor(p.paymentId);
      const purchase = await purchaseOf(p.paymentId);
      expect((await entitlement(U.b2, p.productId).expect(200)).body.valid).toBe(true);
      // no effect before the authoritative completion: an open case with an authorized relay changes nothing
      await send(request(server()).post(`/billing/admin/refund-cases/${caseId}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') }).expect(201);
      await effects().drainOnce();
      expect(await reversals(purchase.id)).toBe(0);
      expect((await entitlement(U.b2, p.productId).expect(200)).body.valid).toBe(true);
      // now the completion
      const c = await one(`SELECT c."paymentId", c.amount::int, r.id AS "attemptId" FROM refund_case c JOIN refund_authorization_relay r ON r."refundCaseId" = c.id WHERE c.id = $1`, [caseId]);
      const id = randomUUID();
      await t.bus.deliver({ id, name: 'refund.case_completed', payload: { refundCaseId: caseId, refundAuthorizationId: randomUUID(), refundAttemptId: c.attemptId, paymentId: c.paymentId,
        paymentRequestId: randomUUID(), producer: 'billing-service', approvedAmount: c.amount, currency: 'TND', completedAt: new Date().toISOString(), liveMode: false, organizationId: null,
        purpose: 'direct_purchase' }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
      expect(await effects().drainOnce()).toMatchObject({ applied: 1 });
      expect(await effect(caseId)).toEqual({ outcome: 'reversed_purchase', purchaseId: purchase.id, obligationId: null, reason: null });
      expect(await reversals(purchase.id)).toBe(1);
      expect((await one(`SELECT cause FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [purchase.id])).cause).toBe('refund_completion');
      expect((await one(`SELECT "refundCaseId" FROM subscription_purchase_reversal_cause WHERE "purchaseId" = $1`, [purchase.id])).refundCaseId).toBe(caseId);
      expect(await purchaseOf(p.paymentId)).toEqual(purchase); // the original purchase is untouched
      expect((await entitlement(U.b2, p.productId).expect(200)).body.valid).toBe(false);
      const a = (await audit(purchase.id)).find((e) => e.name === 'audit.subscription_purchase.reversed')!;
      expect(a.payload.actor).toEqual({ type: 'system', id: 'refund_effect_worker' });
      expect(a.payload.changes).toEqual({ refund_case_id: caseId, cause: 'refund_completion' });
      expect((await readCase(caseId)).body.commercialEffect).toMatchObject({ outcome: 'reversed_purchase', purchaseId: purchase.id });
      // a repeated pass, a duplicate completion delivery: nothing more
      await t.bus.deliver({ id, name: 'refund.case_completed', payload: {}, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
      expect(await effects().drainOnce()).toMatchObject({ applied: 0 });
      expect(await reversals(purchase.id)).toBe(1);
    });

    it('K-3 Option D: reversing an earlier purchase re-lays the later paid periods at full duration, with no gap; other products and users are untouched', async () => {
      const productId = await productOf();
      const priceId = await priceOf(productId, 4900);
      const first = await directPurchase('b1', { productId, priceId });
      const second = await directPurchase('b1', { productId, priceId });
      const third = await directPurchase('b1', { productId, priceId });
      const other = await directPurchase('b2', { productId, priceId }); // another user, the same product
      const unrelated = await directPurchase('b1'); // the same user, another product
      const sub = (await purchaseOf(first.paymentId)).personalSubscriptionId;
      const before = await spans(sub);
      expect(before).toHaveLength(3);
      const caseId = await caseFor(first.paymentId);
      await completeRefund(caseId);
      await effects().drainOnce();
      const after = await spans(sub);
      expect(after.map((s) => s.purchaseId)).toEqual([before[1]!.purchaseId, before[2]!.purchaseId]);
      // the second period now starts at its own settlement (nothing before it), the third continues it with no gap, each a full month
      const p2 = await purchaseOf(second.paymentId);
      expect(after[0]!.effectiveStart).toEqual(p2.settledAt);
      expect(after[1]!.effectiveStart).toEqual(after[0]!.effectiveEnd);
      expect(after[1]!.effectiveEnd < before[2]!.effectiveEnd).toBe(true);
      expect((await entitlement(U.b1, productId).expect(200)).body).toMatchObject({ valid: true, expiresAt: new Date(after[1]!.effectiveEnd).toISOString() });
      expect((await entitlement(U.b2, productId).expect(200)).body.valid).toBe(true);
      expect((await entitlement(U.b1, unrelated.productId).expect(200)).body.valid).toBe(true);
      expect(await reversals((await purchaseOf(other.paymentId)).id)).toBe(0);
      expect(third.paymentId).toBeDefined();
    });

    it('a completed assisted-purchase refund reverses the purchase AND opens the Organization\'s full-cash obligation (base + fee), in one effect', async () => {
      const a = await assistedPurchase();
      const caseId = await caseFor(a.paymentId);
      const purchase = await purchaseOf(a.paymentId);
      const terms = await one(`SELECT "baseAmount"::int AS base, "feeAmount"::int AS fee, "totalAmount"::int AS total, status FROM assistance_request WHERE id = $1`, [a.requestId]);
      expect(terms).toMatchObject({ base: 6100, fee: 400, total: 6500, status: 'settled' });
      await completeRefund(caseId);
      await effects().drainOnce();
      const e = await effect(caseId);
      expect(e).toMatchObject({ outcome: 'reversed_purchase_and_obligation_opened', purchaseId: purchase.id, reason: null });
      expect(await reversals(purchase.id)).toBe(1);
      // the electronic refund (Payment) returned the base; the Organization owes the beneficiary the FULL frozen cash total: never netted
      expect(await obligationsOf(a.requestId)).toEqual([{ id: e.obligationId, origin: 'refund_completion', amount: 6500, status: 'open', refundCaseId: caseId }]);
      expect(Number((await one(`SELECT amount FROM refund_case WHERE id = $1`, [caseId])).amount)).toBe(6100);
      const opened = (await audit(e.obligationId)).find((x) => x.name === 'audit.cash_return_obligation.opened')!;
      expect(opened.payload.actor).toEqual({ type: 'system', id: 'refund_effect_worker' });
      expect(opened.payload.changes).toEqual({ assistance_request_id: a.requestId, amount: 6500, origin: 'refund_completion' });
      expect((await entitlement(U.b1, purchase.productId).expect(200)).body.valid).toBe(false);
      // R6D-2 T2: the unresolved refund-origin obligation restricts NEW assistance requests of the Organization (no deadline is manufactured)
      expect((await admin.query(`SELECT kind, "sourceId" FROM billing_assistance_restrictions($1, now())`, [ORG])).rows).toEqual([{ kind: 'T2', sourceId: e.obligationId }]);
      const productId = await productOf();
      const priceId = await priceOf(productId, 3000);
      expect((await create({ organizationId: ORG, productId, priceId, consent: true }, 'b2')).body.code).toBe('assistance_restricted');
      // discharge stays open: a dispute blocks confirmation; the Organization reports the return; the beneficiary confirms; the request is returned
      const dispute = await send(request(server()).post(`/billing/assistance-requests/${a.requestId}/disputes`), 'b1', key()).send({ reasonCode: 'cash_not_returned' });
      expect(dispute.status, JSON.stringify(dispute.body)).toBe(201);
      const reported = await send(request(server()).post(`/billing/cash-return-obligations/${e.obligationId}/return`), 'a1', key()).send({ returnedAt: new Date(Date.now() - 1000).toISOString() });
      expect(reported.status, JSON.stringify(reported.body)).toBe(200);
      expect((await send(request(server()).post(`/billing/cash-return-obligations/${e.obligationId}/confirm`), 'b1', key()).send()).body.code).toBe('assistance_dispute_open');
      expect((await admin.query(`SELECT kind FROM billing_assistance_restrictions($1, now())`, [ORG])).rows).toEqual([{ kind: 'T2' }]); // a report is not a confirmation
      expect(dispute.body.id).toBeDefined();
    });

    it('the beneficiary\'s confirmation discharges a refund-origin obligation, returns the settled request and clears T2', async () => {
      const a = await assistedPurchase();
      const caseId = await caseFor(a.paymentId);
      await completeRefund(caseId);
      await effects().drainOnce();
      const o = (await obligationsOf(a.requestId))[0]!;
      await send(request(server()).post(`/billing/cash-return-obligations/${o.id}/return`), 'a1', key()).send({ returnedAt: new Date(Date.now() - 1000).toISOString() }).expect(200);
      const confirmed = await send(request(server()).post(`/billing/cash-return-obligations/${o.id}/confirm`), 'b1', key()).send();
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      expect((await obligationsOf(a.requestId))[0]).toMatchObject({ status: 'confirmed_returned', origin: 'refund_completion' });
      expect((await one(`SELECT status FROM assistance_request WHERE id = $1`, [a.requestId])).status).toBe('returned');
      expect((await admin.query(`SELECT 1 FROM billing_assistance_restrictions($1, now())`, [ORG])).rows).toEqual([]);
      // the settled -> returned edge exists only for a confirmed refund-origin obligation
      const other = await assistedPurchase();
      await expect(admin.query(`UPDATE assistance_request SET status = 'returned' WHERE id = $1`, [other.requestId])).rejects.toMatchObject({ constraint: 'assistance_request_returned_by_confirmation' });
    });

    it('a late assisted settlement keeps its deadline obligation and gets nothing new; a non-entitlement refund has no effect', async () => {
      const late = await lateSettlement();
      const lateCase = await caseFor(late.paymentId);
      await completeRefund(lateCase);
      const np = await producerPayment({ target: 'none' });
      const npCase = await caseFor(np.paymentId);
      await completeRefund(npCase);
      await effects().drainOnce();
      expect(await effect(lateCase)).toEqual({ outcome: 'none', purchaseId: null, obligationId: null, reason: 'late_assisted_settlement' });
      expect((await obligationsOf(late.requestId)).map((x) => [x.origin, x.refundCaseId])).toEqual([['deadline', null]]);
      expect(await effect(npCase)).toEqual({ outcome: 'none', purchaseId: null, obligationId: null, reason: 'no_entitlement_basis' });
      expect(await count(`SELECT count(*) AS n FROM subscription WHERE "organizationId" = $1`, [ORG])).toBe(0); // no Organization subscription touched
    });

    it('R6D-4: a purchase already reversed by another cause gets no second reversal; this refund cause is appended for S6h', async () => {
      const p = await directPurchase('b2');
      const caseId = await caseFor(p.paymentId);
      await completeRefund(caseId);
      const purchase = await purchaseOf(p.paymentId);
      await admin.query(`INSERT INTO subscription_purchase_reversal ("purchaseId", cause) VALUES ($1, 'final_lost_chargeback')`, [purchase.id]); // a prior cause (S6e's, simulated)
      await effects().drainOnce();
      expect(await effect(caseId)).toEqual({ outcome: 'none', purchaseId: purchase.id, obligationId: null, reason: 'already_reversed' });
      expect((await admin.query(`SELECT cause FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [purchase.id])).rows).toEqual([{ cause: 'final_lost_chargeback' }]);
      expect((await admin.query(`SELECT cause, "refundCaseId" FROM subscription_purchase_reversal_cause WHERE "purchaseId" = $1`, [purchase.id])).rows).toEqual([{ cause: 'refund_completion', refundCaseId: caseId }]);
      expect((await audit(purchase.id)).filter((e) => e.name === 'audit.subscription_purchase.reversed')).toEqual([]);
    });

    it('concurrent workers apply one effect: one reversal and one obligation', async () => {
      const a = await assistedPurchase();
      const caseId = await caseFor(a.paymentId);
      await completeRefund(caseId);
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => effects().apply(caseId)));
      expect(outcomes.filter((o) => o.kind === 'applied')).toHaveLength(1);
      expect(outcomes.filter((o) => o.kind === 'already_applied')).toHaveLength(7);
      expect(await reversals((await purchaseOf(a.paymentId)).id)).toBe(1);
      expect(await obligationsOf(a.requestId)).toHaveLength(1);
    });

    it('a failure between the reversal and the obligation rolls both back; the effect is retried with backoff and applied once (also for a completion recorded earlier)', async () => {
      const a = await assistedPurchase();
      const caseId = await caseFor(a.paymentId);
      await completeRefund(caseId); // recorded while the effect worker could not succeed: a historical completion for the next pass
      await admin.query(`CREATE FUNCTION pg_temp_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '40001'; END $$;
        CREATE TRIGGER zz_injected BEFORE INSERT ON cash_return_obligation FOR EACH ROW EXECUTE FUNCTION pg_temp_fail();`);
      try {
        expect(await effects().drainOnce()).toMatchObject({ failed: 1 });
      } finally {
        await admin.query(`DROP TRIGGER zz_injected ON cash_return_obligation; DROP FUNCTION pg_temp_fail();`);
      }
      expect(await reversals((await purchaseOf(a.paymentId)).id)).toBe(0); // the reversal did not survive without its obligation
      expect(await obligationsOf(a.requestId)).toEqual([]);
      expect(await one(`SELECT state, reason, attempts FROM refund_case_effect_attempt WHERE "refundCaseId" = $1`, [caseId])).toEqual({ state: 'retry', reason: 'technical_failure', attempts: 1 });
      expect((await readCase(caseId)).body.commercialEffectPending).toMatchObject({ state: 'retry' });
      await admin.query(`UPDATE refund_case_effect_attempt SET "workAfter" = now() WHERE "refundCaseId" = $1`, [caseId]);
      await effects().drainOnce();
      expect(await effect(caseId)).toMatchObject({ outcome: 'reversed_purchase_and_obligation_opened' });
      expect((await readCase(caseId)).body).toMatchObject({ commercialEffect: { outcome: 'reversed_purchase_and_obligation_opened' }, commercialEffectPending: null });
    });

    it('R6D-6: contradictory evidence applies nothing, stays visible and non-terminal, and is applied once reconciled', async () => {
      const a = await assistedPurchase();
      const caseId = await caseFor(a.paymentId);
      await completeRefund(caseId);
      await backdate(a.requestId, `UPDATE assistance_request SET status = 'cash_collected' WHERE id = $1`); // a contradiction (test-only bypass)
      expect(await effects().drainOnce()).toMatchObject({ review: 1 });
      expect(await effect(caseId)).toBeUndefined();
      expect(await reversals((await purchaseOf(a.paymentId)).id)).toBe(0);
      expect((await readCase(caseId)).body.commercialEffectPending).toMatchObject({ state: 'review', reason: 'request_not_settled' });
      await backdate(a.requestId, `UPDATE assistance_request SET status = 'settled' WHERE id = $1`); // reconciled
      await admin.query(`UPDATE refund_case_effect_attempt SET "workAfter" = now() WHERE "refundCaseId" = $1`, [caseId]);
      await effects().drainOnce();
      expect(await effect(caseId)).toMatchObject({ outcome: 'reversed_purchase_and_obligation_opened' });
    });

    it('the database: one effect per case, append-only; a refund-origin obligation needs the case\'s reversed assisted purchase; a refund reversal needs its cause', async () => {
      const a = await assistedPurchase();
      const caseId = await caseFor(a.paymentId);
      await completeRefund(caseId);
      const purchase = await purchaseOf(a.paymentId);
      const r = await one(`SELECT * FROM assistance_request WHERE id = $1`, [a.requestId]);
      const ins = () => admin.query(`INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt", origin, "refundCaseId")
        VALUES ($1, $2, $3, $4, $5, $6, 'refund_completion', $7)`, [r.id, r.organizationId, r.beneficiaryUserId, r.totalAmount, r.currency, r.cashCollectedAt, caseId]);
      await expect(ins()).rejects.toMatchObject({ constraint: 'cash_return_obligation_refund_not_due' }); // the purchase is not reversed yet
      await expect(admin.query(`INSERT INTO refund_case_effect ("refundCaseId", outcome, "purchaseId") VALUES ($1, 'reversed_purchase', $2)`, [caseId, purchase.id])).rejects.toMatchObject({ constraint: 'refund_case_effect_purchase' });
      await effects().drainOnce();
      await expect(admin.query(`UPDATE refund_case_effect SET reason = 'x'`)).rejects.toThrow();
      await expect(admin.query(`DELETE FROM subscription_purchase_reversal_cause`)).rejects.toThrow();
      await expect(admin.query(`INSERT INTO refund_case_effect ("refundCaseId", outcome, reason) VALUES ($1, 'none', 'no_entitlement_basis')`, [caseId])).rejects.toThrow(); // one per case
      await expect(ins()).rejects.toThrow(); // one obligation per request
      await expect(admin.query(`UPDATE cash_return_obligation SET origin = 'deadline' WHERE "refundCaseId" = $1`, [caseId])).rejects.toThrow(); // the origin is immutable
    });
  });

  it('production mounts no refund route', () => {
    expect(RefundModule.register({ isProduction: true } as BillingConfig)).toEqual({ module: RefundModule });
  });
});

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
import type { TransitionContext } from '../src/domain/actors.js';
import { HttpOwnerAuthority } from '../src/platforms/owner-authority.client.js';
import type { DisputeExposure } from '../src/refunds/dispute-exposure.js';
import { RefundEffectService } from '../src/refunds/refund-effect.service.js';
import { DisputeLossService } from '../src/refunds/dispute-loss.service.js';
import type { PaymentDisputeClient, PaymentDisputeLoss } from '../src/refunds/payment-dispute-client.js';
import type { FraudEvidenceFiles, FraudHoldReceipts, GrantedFraudEvidence } from '../src/fraud-holds/fraud-hold-clients.js';
import type { PaymentRefundClient } from '../src/refunds/payment-refund-client.js';
import { BillingAudit } from '../src/audit/billing-audit.js';
import { applyRecoveryPayment } from '../src/recovery/recovery-ledger.js';
import { RecoveryModule } from '../src/recovery/recovery.module.js';
import { RecoveryService } from '../src/recovery/recovery.service.js';
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

/** Core V2 S6e-D: Payment's losses read under test control (a page of verified losses, or Payment unavailable). */
const lossesAtPayment = { items: [] as PaymentDisputeLoss[], down: false };
const paymentDisputes: PaymentDisputeClient = {
  losses: async (after, limit) => {
    if (lossesAtPayment.down) throw new Error('payment-service unavailable');
    return lossesAtPayment.items.filter((l) => !after || l.disputeId > after).sort((a, b) => (a.disputeId < b.disputeId ? -1 : 1)).slice(0, limit);
  },
};

/** Core V2 S6e-H: Auth's fraud-hold receipts (AUTH-02 / AUTH-03 semantics) and File's fraud_evidence grants, under test control. */
type IssuedReceipt = { id: string; binding: Record<string, unknown>; issuer: string; consumeRef?: string };
const canon = (b: Record<string, unknown>) => JSON.stringify(Object.keys(b).sort().map((k) => [k, b[k]]));
const fraudAuth = { issued: new Map<string, IssuedReceipt>(), down: false };
const fraudHoldReceipts: FraudHoldReceipts = {
  consume: async ({ secret, binding, consumeRef }) => {
    if (fraudAuth.down) return { kind: 'unresolved', reason: 'receipt_unavailable' };
    const r = fraudAuth.issued.get(secret);
    if (!r || canon(r.binding) !== canon(binding as never)) return { kind: 'refused', code: 'receipt_invalid' };
    if (r.consumeRef && r.consumeRef !== consumeRef) return { kind: 'unresolved', reason: 'consume_ref_conflict' };
    r.consumeRef = consumeRef;
    return { kind: 'consumed', consumption: { receiptId: r.id, approvedByUserId: r.issuer } };
  },
  lookup: async ({ binding, consumeRef }) => {
    for (const r of fraudAuth.issued.values()) if (r.consumeRef === consumeRef && canon(r.binding) === canon(binding as never)) return { receiptId: r.id, approvedByUserId: r.issuer };
    return null;
  },
};
const fraudFiles = { grants: new Map<string, GrantedFraudEvidence>(), down: false };
const fraudEvidenceFiles: FraudEvidenceFiles = {
  granted: async (grantId, fileId) => {
    if (fraudFiles.down) throw new Error('file-service unavailable');
    const g = fraudFiles.grants.get(grantId);
    return g && g.fileId === fileId ? g : null;
  },
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
 * Core V2 S6f Organization recovery (register BIL-26 T3, BIL-28 to BIL-31; ADR-0044 B8, B10; S0 §3.5, FC-9; the Owner's R6F-1 to R6F-8), for
 * DEVELOPMENT AND SIMULATION ONLY: the real application on real PostgreSQL 16; assisted purchases, verified losses (S6e-D), recovery
 * settlements and refunds through Billing's real paths and Payment's verified events; Auth (Owner, receipts) and File (evidence) under test
 * control. Surplus exists only through S6h's late successes, which S6f does not implement: those tests use a labelled fixture.
 */
describeWithEnv('organization recovery (Core V2 S6f, simulation) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
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
  const key = () => `s6f-${++k}-${randomUUID().slice(0, 8)}`;
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

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings6f');
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
      paymentDisputeClient: paymentDisputes, // Core V2 S6e-D: Payment's losses read
      fraudHoldReceipts, fraudEvidenceFiles, // Core V2 S6e-H
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
  // ── S6f fixtures
  const recovery = () => t.app.get(RecoveryService);
  const losses = () => t.app.get(DisputeLossService);
  const purchaseOf = (paymentId: string) => one(`SELECT s.* FROM subscription_purchase s JOIN payment_request pr ON pr.id = s."paymentRequestId" WHERE pr."paymentId" = $1`, [paymentId]);
  const restrictions = async (organizationId = ORG) => (await admin.query(`SELECT kind, "sourceId" FROM billing_assistance_restrictions($1, now())`, [organizationId])).rows as Row[];
  const obligationOf = (disputeId: string) => one(`SELECT id, status, "baseAmount"::int AS base, "organizationId", "recoveredAt" FROM recovery_obligation WHERE "disputeId" = $1`, [disputeId]);
  const reviewOf = (disputeId: string) => one(`SELECT reason FROM recovery_review WHERE "disputeId" = $1`, [disputeId]);
  const auditNames = async (resourceId: string) => (await audit(resourceId)).map((x) => x.name as string);
  const domainEvents = () => count(`SELECT count(*) AS n FROM outbox WHERE name NOT LIKE 'audit.%' AND name ~* 'recovery|surplus'`);
  /** Payment's verified final lost chargeback (S6e-D), applied by the dispute loss worker. */
  const lose = async (paymentId: string, amount: number, chargeback = amount) => {
    const id = randomUUID();
    const disputeId = randomUUID();
    await t.bus.deliver({ id, name: 'payment.dispute.lost', payload: {
      disputeId, paymentId, paymentRequestId: randomUUID(), producer: 'billing-service', organizationId: null, purpose: 'assisted_settlement', amount, currency: 'TND',
      lostAt: new Date().toISOString(), chargeback: { factId: randomUUID(), amount: chargeback, currency: 'TND' }, liveMode: false,
    }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } } as never);
    await losses().drainOnce();
    expect(await one(`SELECT reason FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId])).toMatchObject({ reason: expect.any(String) });
    return disputeId;
  };
  /** An assisted purchase (base 6100, Organization fee 400) whose payment is lost at final stage; the obligation is NOT opened yet. */
  const assistedLoss = async (o: { beneficiary?: string; partial?: boolean } = {}) => {
    const beneficiary = o.beneficiary ?? 'b1';
    const r = await collected({ unit: 6100, fee: 400, beneficiary });
    const s = await started(r.id, identities.get(beneficiary)!.id as ReturnType<typeof randomUUID>);
    await t.bus.deliver(s.ev('payment.succeeded'));
    const purchase = await purchaseOf(s.paymentId);
    const amount = Number(s.inv.total);
    const disputeId = await lose(s.paymentId, amount, o.partial ? amount - 100 : amount);
    return { requestId: r.id, productId: r.productId, paymentId: s.paymentId, paymentRequestId: s.paymentRequestId, amount, purchaseId: purchase.id as string, disputeId };
  };
  /** The loss, then the worker: the open obligation. */
  const opened = async (o: { beneficiary?: string } = {}) => {
    const l = await assistedLoss(o);
    expect(await recovery().visit(l.disputeId)).toBe('opened');
    return { ...l, obligationId: (await obligationOf(l.disputeId)).id as string };
  };

  // ── S6f HTTP
  const settleRecovery = (id: string, bearer: string | null = 'a1', idem: string | null = key(), body?: unknown) => {
    const r = send(request(server()).post(`/billing/recovery-obligations/${id}/settlement`), bearer, idem);
    return body === undefined ? r.send() : r.send(body as object);
  };
  const readRecovery = (id: string, bearer = 'a1') => send(request(server()).get(`/billing/recovery-obligations/${id}`), bearer, null);
  const ownerRead = (id: string, bearer = 'owner-tok') => send(request(server()).get(`/billing/admin/recovery-obligations/${id}`), bearer, null);
  const confirmSurplus = (id: string, bearer = 'a1', idem: string = key()) => send(request(server()).post(`/billing/recovery-surpluses/${id}/recipient-confirmation`), bearer, idem).send();
  const recordExternal = (id: string, body: unknown, bearer = 'owner-tok') => send(request(server()).post(`/billing/admin/recovery-surpluses/${id}/resolution`), bearer, null).send(body as object);
  /** Payment's verified outcome of a recovery channel's payment request (after Payment accepted it). */
  const recoveryEvent = async (paymentRequestId: string, name: PaymentEventName = 'payment.succeeded') => {
    const { inv, paymentId } = await accepted(paymentRequestId);
    const id = randomUUID();
    const facts = {
      paymentId, producer: 'billing-service', paymentRequestId, sourceType: 'invoice', sourceId: inv.id, payer: { type: 'organization', id: inv.payerId },
      seller: { type: 'company', id: COMPANY }, organizationId: inv.organizationId, amount: Number(inv.total), currency: inv.currency, revision: 1, ...(await paymentPurposeOf(admin, inv.id)),
    };
    const envelope: EventEnvelope = { id, name, payload: facts as Record<string, unknown>, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } };
    await t.bus.deliver(envelope);
    return { paymentId, envelope, inv };
  };
  /**
   * TEST FIXTURE — SIMULATES S6h, WHICH S6f DOES NOT IMPLEMENT. With one channel at a time for exactly the outstanding amount, no runtime path of
   * S6f produces a surplus: only a LATE verified success of an earlier, already-failed channel does, and applying late successes is S6h's
   * reconciliation (S4c F-4: Payment emits no later success after finality). This fixture plays that S6h step: as a superuser it records the
   * failed request as verified paid (a receipt of an applied `payment.succeeded`), then applies it through S6f's one ledger entry point.
   */
  const s6hLateSuccess = async (paymentRequestId: string, paymentId: string) => {
    const cl = await admin.connect();
    let receiptId: string;
    try {
      await cl.query(`SET session_replication_role = replica`);
      await cl.query(`UPDATE payment_request SET status = 'paid' WHERE id = $1`, [paymentRequestId]);
      receiptId = (await cl.query(`INSERT INTO payment_event_receipt ("eventId", "eventName", "paymentRequestId", "paymentId", outcome, "paymentRevision", "causeType")
        VALUES (gen_random_uuid(), 'payment.succeeded', $1, $2, 'applied', 2, 'payment_event') RETURNING id`, [paymentRequestId, paymentId])).rows[0].id;
    } finally {
      await cl.query(`SET session_replication_role = origin`);
      cl.release();
    }
    const pr = await one(`SELECT pr."invoiceId", pr.amount, pr.currency, e."recoveryObligationId" FROM payment_request pr JOIN invoice_entitlement e ON e."invoiceId" = pr."invoiceId" WHERE pr.id = $1`, [paymentRequestId]);
    const ctx: TransitionContext = { actor: { type: 'system', id: null }, cause: { type: 'reconciliation', id: randomUUID() }, correlationId: 's6h-fixture' };
    return t.app.get(DbService).tx((q) => applyRecoveryPayment(q, t.app.get(BillingAudit), {
      obligationId: pr.recoveryObligationId, invoiceId: pr.invoiceId, paymentRequestId, receiptId: receiptId!, amount: pr.amount, currency: pr.currency,
    }, ctx));
  };
  /** An obligation recovered by channel 2 while channel 1's failed payment later succeeds (S6h fixture): an entirely-surplus payment. */
  const surplusFixture = async () => {
    const o = await opened();
    const c1 = (await settleRecovery(o.obligationId)).body;
    const failed = await recoveryEvent(c1.paymentRequestId, 'payment.failed');
    const c2 = (await settleRecovery(o.obligationId)).body;
    await recoveryEvent(c2.paymentRequestId);
    expect((await obligationOf(o.disputeId)).status).toBe('recovered');
    expect(await s6hLateSuccess(c1.paymentRequestId, failed.paymentId)).toBe('recovery');
    const s = await one(`SELECT su.id, su.amount::int AS amount FROM recovery_surplus su JOIN recovery_payment p ON p.id = su."recoveryPaymentId" WHERE p."paymentRequestId" = $1`, [c1.paymentRequestId]);
    return { ...o, surplusId: s.id as string, surplusAmount: s.amount as number, surplusPaymentId: failed.paymentId, surplusPaymentRequestId: c1.paymentRequestId as string };
  };
  /** Auth's `recovery_surplus_external` receipt issued to `issuer` for exactly `binding` (AUTH-01), and File's `surplus_evidence` grant. */
  const externalProof = (s: { surplusId: string; surplusAmount: number }, o: { issuer?: string; binding?: Record<string, unknown>; grant?: Partial<GrantedFraudEvidence> } = {}) => {
    const secret = randomBytes(32).toString('base64url');
    const grantId = randomUUID();
    const fileId = randomUUID();
    fraudAuth.issued.set(secret, { id: randomUUID(), issuer: o.issuer ?? U.owner, binding: {
      operation: 'recovery_surplus_external', audience: 'billing-service', companyId: COMPANY, surplusId: s.surplusId, organizationId: ORG, amount: s.surplusAmount, currency: 'TND', ...o.binding,
    } });
    fraudFiles.grants.set(grantId, { grantId, fileId, purpose: 'surplus_evidence', caseRef: s.surplusId, companyId: COMPANY, subjectUserId: null, ...o.grant });
    return { kind: 'external_execution_evidenced', grantId, fileId, receiptSecret: secret };
  };

  beforeEach(() => {
    lossesAtPayment.items = [];
    lossesAtPayment.down = false;
    fraudAuth.down = false;
    fraudFiles.down = false;
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── obligations (R6F-3, R6F-4, R6F-8)

  describe('recovery obligations from verified assisted losses (R6F-3, R6F-4, R6F-8)', () => {
    it('a full assisted chargeback opens the Organization\'s base-only obligation and T3; the beneficiary keeps the entitlement; audited by the worker', async () => {
      const l = await assistedLoss();
      expect(await restrictions()).toEqual([]); // nothing before the worker
      expect(await recovery().drainOnce()).toMatchObject({ opened: 1, review: 0, failed: 0 });
      const o = await obligationOf(l.disputeId);
      expect(o).toMatchObject({ status: 'open', base: 6100, organizationId: ORG, recoveredAt: null }); // the base only: never the fee (400), never a chargeback fee
      expect(await restrictions()).toEqual([{ kind: 'T3', sourceId: o.id }]);
      expect((await entitlement(U.b1, l.productId).expect(200)).body.valid).toBe(true);
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [l.purchaseId])).toBe(0);
      const a = (await audit(o.id)).filter((x) => x.name === 'audit.recovery_obligation.opened');
      expect(a.map((x) => [x.payload.actor, x.payload.changes])).toEqual([[{ type: 'system', id: 'recovery_worker' },
        { dispute_id: l.disputeId, assistance_request_id: l.requestId, base_amount: 6100 }]]);
      // T3 blocks NEW assistance requests only (409 with every kind)
      const p = await productOf();
      const refused = await create({ organizationId: ORG, productId: p, priceId: await priceOf(p), consent: true }, 'b2');
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'assistance_restricted', restriction: 'T3', restrictions: ['T3'] });
      // another Organization of the same Platform is not restricted
      expect(await restrictions(ORG2)).toEqual([]);
      expect(await domainEvents()).toBe(0); // R6F-7: no billing.recovery events
    });

    it('historical losses (recorded before S6f) are visited exactly once; repeated passes open nothing more', async () => {
      const a = await assistedLoss();
      const b = await assistedLoss({ beneficiary: 'b2' });
      expect(await recovery().drainOnce()).toMatchObject({ opened: 2 });
      expect(await recovery().drainOnce()).toMatchObject({ opened: 0, review: 0 });
      expect(await recovery().visit(a.disputeId)).toBe('already');
      for (const d of [a.disputeId, b.disputeId]) expect(await count(`SELECT count(*) AS n FROM recovery_obligation WHERE "disputeId" = $1`, [d])).toBe(1);
      expect((await restrictions()).map((r) => r.kind)).toEqual(['T3', 'T3']);
    });

    it('concurrent visits of one loss open one obligation and audit it once', async () => {
      const c = await assistedLoss();
      const outs = await Promise.all([...Array.from({ length: 8 }, () => recovery().visit(c.disputeId)), recovery().drainOnce()]);
      expect(outs.filter((x) => x === 'opened').length + (outs[8] as { opened: number }).opened).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM recovery_obligation WHERE "disputeId" = $1`, [c.disputeId])).toBe(1);
      expect((await admin.query(`SELECT name FROM outbox WHERE name = 'audit.recovery_obligation.opened' AND payload->'changes'->>'dispute_id' = $1`, [c.disputeId])).rows).toHaveLength(1);
    });

    it('exclusions: a partial assisted chargeback (R6F-3 Option A) and a refunded payment (R6F-4) go to review with no debt and no T3; direct purchases are never visited', async () => {
      const partial = await assistedLoss({ partial: true });
      expect(await recovery().visit(partial.disputeId)).toBe('review');
      expect(await reviewOf(partial.disputeId)).toEqual({ reason: 'partial_chargeback' });
      // R6F-4: an assisted payment refunded in full (S6c) and then charged back
      const r = await collected({ unit: 6100, fee: 400 });
      const s = await started(r.id);
      await t.bus.deliver(s.ev('payment.succeeded'));
      const caseId = (await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: s.paymentId, reason: 'customer_request' })).body.id as string;
      await send(request(server()).post(`/billing/admin/refund-cases/${caseId}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') }).expect(201);
      const att = await one(`SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [caseId]);
      const ev = randomUUID();
      await t.bus.deliver({ id: ev, name: 'refund.case_completed', payload: { refundCaseId: caseId, refundAuthorizationId: randomUUID(), refundAttemptId: att.id, paymentId: s.paymentId,
        paymentRequestId: s.paymentRequestId, producer: 'billing-service', approvedAmount: Number(s.inv.total), currency: 'TND', completedAt: new Date().toISOString(), liveMode: false,
        organizationId: ORG, purpose: 'assisted_settlement' }, headers: { eventId: ev, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
      expect((await one(`SELECT status FROM refund_case WHERE id = $1`, [caseId])).status).toBe('completed');
      const refunded = await lose(s.paymentId, Number(s.inv.total));
      expect(await recovery().visit(refunded)).toBe('review');
      expect(await reviewOf(refunded)).toEqual({ reason: 'refund_completed' });
      // a direct purchase lost in full: reversed by S6e-D, never a recovery obligation or review
      const d = await directPurchase('b2');
      const id = randomUUID();
      const dd = randomUUID();
      await t.bus.deliver({ id, name: 'payment.dispute.lost', payload: { disputeId: dd, paymentId: d.paymentId, paymentRequestId: randomUUID(), producer: 'billing-service', organizationId: null,
        purpose: 'direct_purchase', amount: d.amount, currency: 'TND', lostAt: new Date().toISOString(), chargeback: { factId: randomUUID(), amount: d.amount, currency: 'TND' }, liveMode: false,
      }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } } as never);
      await losses().drainOnce();
      await recovery().drainOnce();
      expect(await count(`SELECT count(*) AS n FROM recovery_obligation WHERE "disputeId" = $1`, [dd])).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM recovery_review WHERE "disputeId" = $1`, [dd])).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM recovery_obligation WHERE "disputeId" IN ($1, $2)`, [partial.disputeId, refunded])).toBe(0);
      expect((await restrictions()).filter((x) => x.kind === 'T3')).toEqual([]);
      expect(await recovery().visit(partial.disputeId)).toBe('already'); // once
    });

    it('the database: only the full verified loss of this Organization\'s assisted purchase, for its base; one per loss; immutable except its recovery', async () => {
      const partial = await assistedLoss({ partial: true });
      const f = await one(`SELECT e."purchaseId", s."assistanceRequestId", a."organizationId", a."platformId", a."baseAmount", a.currency FROM dispute_loss_effect e
        JOIN subscription_purchase s ON s.id = e."purchaseId" JOIN assistance_request a ON a.id = s."assistanceRequestId" WHERE e."disputeId" = $1`, [partial.disputeId]);
      const insert = (disputeId: string, base: number, organizationId = f.organizationId) => admin.query(`INSERT INTO recovery_obligation ("disputeId", "assistanceRequestId", "purchaseId", "organizationId", "companyId", "platformId", "baseAmount", currency)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'TND')`, [disputeId, f.assistanceRequestId, f.purchaseId, organizationId, COMPANY, f.platformId, base]);
      await expect(insert(partial.disputeId, 6100)).rejects.toMatchObject({ constraint: 'recovery_obligation_full_loss' });
      const full = await assistedLoss();
      const g = await one(`SELECT e."purchaseId" FROM dispute_loss_effect e WHERE e."disputeId" = $1`, [full.disputeId]);
      const insertFull = (base: number, organizationId: string) => admin.query(`INSERT INTO recovery_obligation ("disputeId", "assistanceRequestId", "purchaseId", "organizationId", "companyId", "platformId", "baseAmount", currency)
        SELECT $1, s."assistanceRequestId", s.id, $3, $4, a."platformId", $2, 'TND' FROM subscription_purchase s JOIN assistance_request a ON a.id = s."assistanceRequestId" WHERE s.id = $5`,
      [full.disputeId, base, organizationId, COMPANY, g.purchaseId]);
      await expect(insertFull(6500, ORG)).rejects.toMatchObject({ constraint: 'recovery_obligation_base' }); // base + fee refused
      await expect(insertFull(6100, ORG2)).rejects.toMatchObject({ constraint: 'recovery_obligation_basis' });
      expect(await recovery().visit(full.disputeId)).toBe('opened');
      await expect(insertFull(6100, ORG)).rejects.toThrow(); // one per loss
      const o = await obligationOf(full.disputeId);
      await expect(admin.query(`UPDATE recovery_obligation SET "baseAmount" = 1 WHERE id = $1`, [o.id])).rejects.toMatchObject({ constraint: 'recovery_obligation_immutable' });
      await expect(admin.query(`UPDATE recovery_obligation SET status = 'recovered' WHERE id = $1`, [o.id])).rejects.toMatchObject({ constraint: 'recovery_obligation_recovered' });
      await expect(admin.query(`DELETE FROM recovery_obligation WHERE id = $1`, [o.id])).rejects.toThrow();
      expect(await recovery().visit(partial.disputeId)).toBe('review');
      await expect(admin.query(`DELETE FROM recovery_review WHERE "disputeId" = $1`, [partial.disputeId])).rejects.toThrow();
      await expect(admin.query(`UPDATE recovery_review SET reason = 'refund_completed' WHERE "disputeId" = $1`, [partial.disputeId])).rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── authority (R6F-1)

  describe('authority (R6F-1)', () => {
    it('the Organization\'s administrator reads and settles; the beneficiary, a member, another Organization and the Owner\'s user identity cannot; revocation is live', async () => {
      const o = await opened();
      expect((await readRecovery(o.obligationId)).status).toBe(200);
      expect((await readRecovery(o.obligationId, 'b1')).status).toBe(403); // the beneficiary (the S5b rule: operation_not_permitted)
      expect((await readRecovery(o.obligationId, 'm1')).status).toBe(404);
      expect((await readRecovery(o.obligationId, 'a2')).status).toBe(404); // another Organization's administrator
      expect((await readRecovery(o.obligationId, 'owner')).status).toBe(404); // an Owner tier is never an Organization actor
      expect((await settleRecovery(o.obligationId, 'owner')).status).toBe(404);
      expect((await settleRecovery(o.obligationId, null)).status).toBe(401);
      expect((await settleRecovery(o.obligationId, producer.token)).status).toBe(401); // a service token is never a human
      expect((await readRecovery(randomUUID())).status).toBe(404);
      identities.set('a1', { id: U.a1, adminTier: null, isActive: true, memberships: [membership(ORG)] }); // revoked
      expect((await settleRecovery(o.obligationId)).status).toBe(404);
      expect(await count(`SELECT count(*) AS n FROM recovery_settlement_channel WHERE "obligationId" = $1`, [o.obligationId])).toBe(0);
    });

    it('an administrator who is the beneficiary of the assisted purchase is refused (403); the Owner reads but never settles or confirms', async () => {
      const o = await opened({ beneficiary: 'admin-beneficiary' });
      expect((await settleRecovery(o.obligationId, 'admin-beneficiary')).status).toBe(403);
      expect((await readRecovery(o.obligationId, 'admin-beneficiary')).status).toBe(403);
      const r = await ownerRead(o.obligationId);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ id: o.obligationId, baseAmount: 6100, recovered: 0, outstanding: 6100, currency: 'TND', status: 'open', payments: [], channels: [], surpluses: [] });
      expect((await ownerRead(o.obligationId, 'foreign-owner-tok')).status).toBe(404);
      expect((await ownerRead(o.obligationId, 'operator-tok')).status).toBe(403);
      expect((await ownerRead(o.obligationId, 'member-tok')).status).toBe(403);
      expect((await send(request(server()).post(`/billing/admin/recovery-obligations/${o.obligationId}/settlement`), 'owner-tok', key()).send()).status).toBe(404); // no Owner route
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── settlement (R6F-2)

  describe('settlement (BIL-29; R6F-2)', () => {
    it('one invoice for the outstanding principal, routed recovery_settlement with no entitlement; one open or uncertain channel; replays; T3 never blocks it', async () => {
      const overdue = await collected({ beneficiary: 'b2' }); // before T3 exists (T3 refuses new requests)
      const o = await opened();
      // T1 composes with T3: the other request of the same Organization is now overdue
      await expireDeadline(overdue.id);
      expect((await restrictions()).map((r) => r.kind)).toEqual(['T1', 'T3']);
      const idem = key();
      const s = await settleRecovery(o.obligationId, 'a1', idem);
      expect(s.status, JSON.stringify(s.body)).toBe(201);
      expect(s.body).toEqual({ invoiceId: expect.any(String), paymentRequestId: expect.any(String), paymentId: null, amount: 6100 });
      const replay = await settleRecovery(o.obligationId, 'a1', idem);
      expect([replay.status, replay.headers['idempotent-replayed'], replay.body]).toEqual([201, 'true', s.body]);
      const inv = await one(`SELECT i.producer, i."payerType", i."payerId", i."organizationId", i.total::int, i.currency, i.status, e.purpose, e.target, e."recoveryObligationId", e."productId", e."beneficiaryUserId"
        FROM invoice i JOIN invoice_entitlement e ON e."invoiceId" = i.id WHERE i.id = $1`, [s.body.invoiceId]);
      expect(inv).toEqual({ producer: 'billing-recovery', payerType: 'organization', payerId: ORG, organizationId: ORG, total: 6100, currency: 'TND', status: 'open',
        purpose: 'recovery_settlement', target: 'none', recoveryObligationId: o.obligationId, productId: null, beneficiaryUserId: null });
      expect((await settleRecovery(o.obligationId)).body).toMatchObject({ code: 'settlement_channel_open' });
      expect((await settleRecovery(o.obligationId, 'a1', key(), { amount: 1 })).body).toMatchObject({ code: 'invalid_recovery_request' });
      // Payment's acceptance is not a recovery: the request is requested, nothing recorded, T3 stays
      await accepted(s.body.paymentRequestId);
      expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "obligationId" = $1`, [o.obligationId])).toBe(0);
      expect((await restrictions()).map((r) => r.kind)).toEqual(['T1', 'T3']);
      expect((await settleRecovery(o.obligationId)).status).toBe(409); // still uncertain
    });

    it('Payment\'s failure frees the channel (no recovery); its verified success recovers the base once, clears T3 exactly once; no entitlement effect, no event', async () => {
      const o = await opened();
      const purchasesBefore = await count(`SELECT count(*) AS n FROM subscription_purchase`);
      const c1 = (await settleRecovery(o.obligationId)).body;
      expect(c1.paymentRequestId, JSON.stringify(c1)).toBeDefined();
      await recoveryEvent(c1.paymentRequestId, 'payment.failed');
      expect((await readRecovery(o.obligationId)).body).toMatchObject({ outstanding: 6100, status: 'open', payments: [] });
      const c2 = await settleRecovery(o.obligationId);
      expect(c2.status).toBe(201);
      const ok = await recoveryEvent(c2.body.paymentRequestId);
      const r = (await readRecovery(o.obligationId)).body;
      expect(r).toMatchObject({ baseAmount: 6100, recovered: 6100, outstanding: 0, status: 'recovered', surpluses: [] });
      expect(r.payments).toEqual([expect.objectContaining({ paymentRequestId: c2.body.paymentRequestId, amount: 6100, principalAmount: 6100, surplusAmount: 0 })]);
      expect(r.channels.map((c: Row) => [c.paymentRequestStatus, c.active])).toEqual([['failed', false], ['paid', false]]);
      expect(await restrictions()).toEqual([]);
      expect((await auditNames(o.obligationId)).sort()).toEqual(['audit.recovery_obligation.opened', 'audit.recovery_obligation.recovered', 'audit.recovery_payment.recorded']); // one transaction: one timestamp
      const rec = (await audit(o.obligationId)).find((x) => x.name === 'audit.recovery_payment.recorded')!;
      expect([rec.payload.actor, rec.payload.changes]).toEqual([{ type: 'system', id: 'payment_event_consumer' }, { payment_request_id: c2.body.paymentRequestId, recovered_amount: 6100, surplus_amount: 0 }]);
      // redelivery: nothing more
      const inv = await one(`SELECT * FROM invoice WHERE id = $1`, [c2.body.invoiceId]);
      await t.bus.deliver(ok.envelope);
      expect(inv.status).toBe('paid');
      expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "obligationId" = $1`, [o.obligationId])).toBe(1);
      expect((await settleRecovery(o.obligationId)).body).toMatchObject({ code: 'recovery_obligation_closed' });
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase`)).toBe(purchasesBefore); // no entitlement effect
      expect((await entitlement(U.b1, o.productId).expect(200)).body.valid).toBe(true);
      expect(await domainEvents()).toBe(0);
    });

    it('concurrent settlements open one channel; the database refuses a second channel, another amount, another invoice, and a recovery payment without a verified success', async () => {
      const l2 = await assistedLoss({ beneficiary: 'b2' }); // before T3 exists
      const o = await opened();
      const outs = await Promise.all(Array.from({ length: 6 }, () => settleRecovery(o.obligationId)));
      expect(outs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(outs.filter((r) => r.status === 409).every((r) => r.body.code === 'settlement_channel_open')).toBe(true);
      const c = await one(`SELECT * FROM recovery_settlement_channel WHERE "obligationId" = $1`, [o.obligationId]);
      await expect(admin.query(`INSERT INTO recovery_settlement_channel ("obligationId", "invoiceId", amount, "startedBy") VALUES ($1, $2, 6100, $3)`, [o.obligationId, c.invoiceId, U.a1]))
        .rejects.toMatchObject({ constraint: 'settlement_channel_open' });
      await expect(admin.query(`UPDATE recovery_settlement_channel SET amount = 1 WHERE id = $1`, [c.id])).rejects.toMatchObject({ constraint: 'recovery_channel_immutable' });
      await expect(admin.query(`INSERT INTO recovery_payment ("obligationId", "invoiceId", "paymentRequestId", "receiptId", amount, currency, "principalAmount", "surplusAmount")
        SELECT $1, $2, $3, (SELECT id FROM payment_event_receipt LIMIT 1), 6100, 'TND', 0, 0`, [o.obligationId, c.invoiceId, c.paymentRequestId])).rejects.toMatchObject({ constraint: 'recovery_payment_verified' });
      // a recovery invoice can never route a Personal entitlement or become a recovery for another obligation
      expect(await recovery().visit(l2.disputeId)).toBe('opened');
      const other = { obligationId: (await obligationOf(l2.disputeId)).id as string };
      await expect(admin.query(`INSERT INTO recovery_settlement_channel ("obligationId", "invoiceId", amount, "startedBy") VALUES ($1, $2, 6100, $3)`, [other.obligationId, c.invoiceId, U.a1]))
        .rejects.toThrow();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── surplus (R6F-5)

  describe('surplus (R6F-5; S6h late success simulated by a labelled fixture)', () => {
    it('a late verified success after recovery is entirely surplus owed to the Organization: never revenue, never offset, never re-opens T3', async () => {
      const s = await surplusFixture();
      expect(s.surplusAmount).toBe(6100);
      const r = (await readRecovery(s.obligationId)).body;
      expect(r).toMatchObject({ recovered: 6100, outstanding: 0, status: 'recovered' });
      expect(r.surpluses).toEqual([expect.objectContaining({ id: s.surplusId, amount: 6100, status: 'owed_to_organization' })]);
      expect(r.payments.map((p: Row) => [p.principalAmount, p.surplusAmount])).toEqual([[6100, 0], [0, 6100]]);
      expect(await restrictions()).toEqual([]); // R-5
      expect(await auditNames(s.surplusId)).toEqual(['audit.recovery_surplus.recorded']);
      expect(await domainEvents()).toBe(0);
    });

    it('Path A: the Owner refunds an entirely-surplus payment through the refund machinery; the completed refund resolves the surplus once', async () => {
      const s = await surplusFixture();
      expect((await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: s.surplusPaymentId, reason: 'customer_request' })).body)
        .toMatchObject({ code: 'refund_not_eligible' }); // its reason is recovery_surplus
      const open = await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: s.surplusPaymentId, reason: 'recovery_surplus' });
      expect(open.status, JSON.stringify(open.body)).toBe(201);
      expect(open.body).toMatchObject({ eligibility: 'recovery_surplus', amount: 6100, organizationId: ORG });
      // Path B is closed while Path A is in progress
      expect((await recordExternal(s.surplusId, externalProof(s))).body).toMatchObject({ code: 'surplus_not_owed' });
      await send(request(server()).post(`/billing/admin/refund-cases/${open.body.id}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') }).expect(201);
      const att = await one(`SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [open.body.id]);
      const ev = randomUUID();
      await t.bus.deliver({ id: ev, name: 'refund.case_completed', payload: { refundCaseId: open.body.id, refundAuthorizationId: randomUUID(), refundAttemptId: att.id, paymentId: s.surplusPaymentId,
        paymentRequestId: s.surplusPaymentRequestId, producer: 'billing-service', approvedAmount: 6100, currency: 'TND', completedAt: new Date().toISOString(), liveMode: false,
        organizationId: ORG, purpose: 'recovery_settlement' }, headers: { eventId: ev, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
      await t.app.get(RefundEffectService).drainOnce();
      expect(await one(`SELECT outcome, reason FROM refund_case_effect WHERE "refundCaseId" = $1`, [open.body.id])).toEqual({ outcome: 'none', reason: 'recovery_surplus_refunded' });
      expect((await readRecovery(s.obligationId)).body.surpluses).toEqual([expect.objectContaining({ id: s.surplusId, status: 'resolved', refundCaseId: open.body.id })]);
      const resolved = (await audit(s.surplusId)).filter((x) => x.name === 'audit.recovery_surplus.resolved');
      expect(resolved.map((x) => [x.payload.actor, x.payload.changes])).toEqual([[{ type: 'system', id: 'refund_effect_worker' }, { method: 'full_refund', refund_case_id: open.body.id }]]);
      await t.app.get(RefundEffectService).drainOnce();
      expect(await count(`SELECT count(*) AS n FROM recovery_surplus_refund WHERE "surplusId" = $1`, [s.surplusId])).toBe(1);
      expect((await recordExternal(s.surplusId, externalProof(s))).body).toMatchObject({ code: 'surplus_not_owed' });
    });

    it('Path A refuses a mixed payment (principal and surplus) and a payment that recovered principal; the database agrees', async () => {
      const s = await surplusFixture();
      const principal = await one(`SELECT pr."paymentId", pr.id FROM recovery_payment p JOIN payment_request pr ON pr.id = p."paymentRequestId" WHERE p."obligationId" = $1 AND p."principalAmount" > 0`, [s.obligationId]);
      expect((await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: principal.paymentId, reason: 'recovery_surplus' })).body)
        .toMatchObject({ code: 'refund_not_eligible' });
      expect((await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: principal.paymentId, reason: 'customer_request' })).body)
        .toMatchObject({ code: 'refund_not_eligible' });
      // TEST FIXTURE: a mixed recovery payment (no S6f path produces one) is never refundable as surplus
      await backdate(s.surplusPaymentRequestId, `UPDATE recovery_payment SET "principalAmount" = 100, "surplusAmount" = 6000 WHERE "paymentRequestId" = $1`);
      expect((await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: s.surplusPaymentId, reason: 'recovery_surplus' })).body)
        .toMatchObject({ code: 'refund_not_eligible' });
      await backdate(s.surplusPaymentRequestId, `UPDATE recovery_payment SET "principalAmount" = 0, "surplusAmount" = 6100 WHERE "paymentRequestId" = $1`);
    });

    it('Path B: the Owner records an external repayment (File evidence, a dedicated receipt); only the receiving Organization\'s administrator resolves it', async () => {
      const s = await surplusFixture();
      expect((await confirmSurplus(s.surplusId)).body).toMatchObject({ code: 'surplus_not_evidenced' }); // Owner assertion is required first, and never enough
      const proof = externalProof(s);
      const r = await recordExternal(s.surplusId, proof);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toEqual({ surplusId: s.surplusId, status: 'external_execution_evidenced' });
      expect((await recordExternal(s.surplusId, proof)).status).toBe(200); // the same record: answered, not consumed again
      expect((await readRecovery(s.obligationId)).body.surpluses[0]).toMatchObject({ status: 'external_execution_evidenced' });
      // never a provider fact; never Path A after Path B
      expect((await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: s.surplusPaymentId, reason: 'recovery_surplus' })).body)
        .toMatchObject({ code: 'refund_not_eligible' });
      // the Owner (user identity) and the beneficiary cannot confirm; the administrator does, once
      expect((await confirmSurplus(s.surplusId, 'owner')).status).toBe(404);
      expect((await confirmSurplus(s.surplusId, 'b1')).status).toBe(403); // the beneficiary
      expect((await confirmSurplus(s.surplusId, 'a2')).status).toBe(404);
      const idem = key();
      const c = await confirmSurplus(s.surplusId, 'a1', idem);
      expect([c.status, c.body]).toEqual([200, { surplusId: s.surplusId, status: 'resolved' }]);
      expect((await confirmSurplus(s.surplusId, 'a1', idem)).headers['idempotent-replayed']).toBe('true');
      expect((await confirmSurplus(s.surplusId, 'a1')).status).toBe(200); // a new key: already confirmed, nothing more
      expect(await auditNames(s.surplusId)).toEqual(['audit.recovery_surplus.recorded', 'audit.recovery_surplus.resolved', 'audit.recovery_surplus.recipient_confirmed']);
      const resolved = (await audit(s.surplusId)).find((x) => x.name === 'audit.recovery_surplus.resolved')!;
      expect([resolved.payload.actor.type, resolved.payload.actor.id, resolved.payload.changes]).toEqual(['user', U.owner, { method: 'external_execution_evidenced', file_id: proof.fileId }]);
      expect((await readRecovery(s.obligationId)).body.surpluses[0]).toMatchObject({ status: 'resolved' });
      expect(JSON.stringify(await admin.query(`SELECT * FROM recovery_surplus_external`).then((x) => x.rows))).not.toContain(proof.receiptSecret); // never stored
    });

    it('Path B refuses: wrong evidence, a receipt for another amount, Organization or Owner, a non-Owner, File or Auth unavailable; nothing is written', async () => {
      const s = await surplusFixture();
      const none = async () => expect(await count(`SELECT count(*) AS n FROM recovery_surplus_external WHERE "surplusId" = $1`, [s.surplusId])).toBe(0);
      expect((await recordExternal(s.surplusId, externalProof(s, { grant: { purpose: 'fraud_evidence' } }))).body).toMatchObject({ code: 'surplus_evidence_invalid' });
      expect((await recordExternal(s.surplusId, externalProof(s, { grant: { caseRef: randomUUID() } }))).body).toMatchObject({ code: 'surplus_evidence_invalid' });
      expect((await recordExternal(s.surplusId, externalProof(s, { binding: { amount: 6000 } }))).body).toMatchObject({ code: 'recovery_authorization_refused' });
      expect((await recordExternal(s.surplusId, externalProof(s, { binding: { organizationId: ORG2 } }))).body).toMatchObject({ code: 'recovery_authorization_refused' });
      expect((await recordExternal(s.surplusId, externalProof(s, { issuer: randomUUID() }))).body).toMatchObject({ code: 'recovery_authorization_refused' });
      expect((await recordExternal(s.surplusId, { ...externalProof(s), receiptSecret: 'short' })).body).toMatchObject({ code: 'invalid_recovery_request' });
      expect((await recordExternal(s.surplusId, { ...externalProof(s), kind: 'full_refund' })).body).toMatchObject({ code: 'invalid_recovery_request' });
      expect((await recordExternal(s.surplusId, externalProof(s), 'foreign-owner-tok')).status).toBe(404);
      expect((await recordExternal(s.surplusId, externalProof(s), 'operator-tok')).status).toBe(403);
      expect((await recordExternal(s.surplusId, externalProof(s), 'member-tok')).status).toBe(403);
      fraudFiles.down = true;
      expect((await recordExternal(s.surplusId, externalProof(s))).body).toMatchObject({ code: 'surplus_evidence_unavailable' });
      fraudFiles.down = false;
      fraudAuth.down = true;
      const pending = externalProof(s);
      expect((await recordExternal(s.surplusId, pending)).body).toMatchObject({ code: 'recovery_authorization_unresolved' });
      await none();
      fraudAuth.down = false;
      expect((await recordExternal(s.surplusId, pending)).status).toBe(201); // the same request, repeated
    });

    it('concurrent records consume once; the database refuses self-confirmation, a second path, and keeps every surplus row append-only', async () => {
      const s = await surplusFixture();
      const proof = externalProof(s);
      const outs = await Promise.all(Array.from({ length: 12 }, () => recordExternal(s.surplusId, proof)));
      expect(outs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(outs.map((r) => r.status).sort((a, b) => a - b), JSON.stringify(outs.map((r) => r.body))).toEqual([...Array.from({ length: 11 }, () => 200), 201]);
      expect((await auditNames(s.surplusId)).filter((n) => n === 'audit.recovery_surplus.resolved')).toHaveLength(1);
      await expect(admin.query(`INSERT INTO recovery_surplus_confirmation ("surplusId", "confirmedByUserId") VALUES ($1, $2)`, [s.surplusId, U.owner]))
        .rejects.toMatchObject({ constraint: 'recovery_surplus_self_confirmation' });
      await expect(admin.query(`UPDATE recovery_surplus SET amount = 1 WHERE id = $1`, [s.surplusId])).rejects.toThrow();
      await expect(admin.query(`DELETE FROM recovery_surplus_external WHERE "surplusId" = $1`, [s.surplusId])).rejects.toThrow();
      await expect(admin.query(`UPDATE recovery_payment SET amount = 1 WHERE "obligationId" = $1`, [s.obligationId])).rejects.toThrow();
    });
  });

  it('no FinancialLoss, no write-off, no expiry or offset: no such table or column exists', async () => {
    expect(await count(`SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(financial_loss|write_off|writeoff)'`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name ~ '^recovery_' AND column_name ~* '(expir|offset|revenue)'`)).toBe(0);
  });

  it('production mounts no recovery route and no worker', () => {
    expect(RecoveryModule.register({ isProduction: true } as BillingConfig)).toEqual({ module: RecoveryModule });
  });
});

import { randomBytes, randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity, type AuthMembership, type EventEnvelope, type OrganizationReferenceResolver,
} from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { BILLING_OPERATIONS } from '../src/admission/caller-admission.policy.js';
import { billingMigrationsDir } from '../src/app.module.js';
import type { BillingConfig } from '../src/config/billing-config.js';
import type { PaymentEventFacts, PaymentEventName } from '../src/domain/payment-event-decision.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import type { CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import { HttpOwnerAuthority } from '../src/platforms/owner-authority.client.js';
import type { DisputeExposure } from '../src/refunds/dispute-exposure.js';
import { RefundEffectService } from '../src/refunds/refund-effect.service.js';
import type { PaymentDisputeClient, PaymentDisputeLoss } from '../src/refunds/payment-dispute-client.js';
import type { FraudEvidenceFiles, FraudHoldReceipts, GrantedFraudEvidence } from '../src/fraud-holds/fraud-hold-clients.js';
import type { PaymentRefundClient } from '../src/refunds/payment-refund-client.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { LateSettlementModule } from '../src/late-settlements/late-settlement.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { FakeAuth } from './support/fake-auth.js';
import { anchorOccurrence } from './support/billing-calendar.js';
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
  capture: async () => ({ kind: 'not_found' as const }), // Core V2 R6H-5: no capture-specific case in this suite
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
 * Core V2 S6g late assisted settlement application (register BIL-32; S0 §3.4 L-1 to L-6; ADR-0044 B14; the Owner's R6G-1 to R6G-9 and Option A),
 * for DEVELOPMENT AND SIMULATION ONLY: the real application on real PostgreSQL 16; assisted requests, settlements, refunds and discharges through
 * Billing's real paths and Payment's verified events; the Owner through Billing's real Auth client against a fake Auth; Auth's receipts and File's
 * evidence grants under test control. The late settlement itself uses the S6a fixture (its deadline obligation inserted as the sweep would).
 */
describeWithEnv('late assisted settlement application (Core V2 S6g, simulation) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
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
  // ── HTTP
  let k = 0;
  const key = () => `s6g-${++k}-${randomUUID().slice(0, 8)}`;
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
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings6g');
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
  // ── S6g fixtures
  const restrictions = async (organizationId = ORG) => (await admin.query(`SELECT kind, "sourceId" FROM billing_assistance_restrictions($1, now())`, [organizationId])).rows as Row[];
  const obligationsOf = async (requestId: string) =>
    (await admin.query(`SELECT id, origin, status, "supersededByApplicationId" FROM cash_return_obligation WHERE "assistanceRequestId" = $1 ORDER BY "openedAt", id`, [requestId])).rows as Row[];
  const auditNames = async (resourceId: string) => (await audit(resourceId)).map((x) => x.name as string);
  /**
   * A verified late assisted settlement (L-1): the Organization collected the cash, its deadline passed with its channel still in flight, its
   * deadline obligation opened (the S6a fixture: inserted as the sweep would once the channel closes), and Payment's verified success then
   * arrived: recorded, no purchase (L-2). `cash_return_obligation_exists`.
   */
  const lateFixtures = async (...beneficiaries: string[]) => {
    // phase 1 for every request first: T1 / T2 (correctly) refuse NEW requests of the Organization once the first deadline has passed
    const started_ = [];
    for (const beneficiary of beneficiaries) {
      const r = await collected({ unit: 5300, fee: 300, beneficiary });
      started_.push({ beneficiary, r, s: await started(r.id, identities.get(beneficiary)!.id as ReturnType<typeof randomUUID>) });
    }
    const out = [];
    for (const { beneficiary, r, s } of started_) {
      // the deadline passed (as expireDeadline, at millisecond precision: a reported collection time is an RFC 3339 instant in milliseconds)
      await backdate(r.id, `UPDATE assistance_request SET "cashCollectedAt" = date_trunc('milliseconds', now() - interval '73 hours'),
        "reportedAt" = date_trunc('milliseconds', now() - interval '73 hours'), "settleBy" = date_trunc('milliseconds', now() - interval '1 hour') WHERE id = $1`);
      await backdate(r.id, `INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt")
        SELECT id, "organizationId", "beneficiaryUserId", "totalAmount", currency, "cashCollectedAt" FROM assistance_request WHERE id = $1`);
      const ev = s.ev('payment.succeeded');
      await t.bus.deliver(ev);
      const late = await one(`SELECT id, "settledAt" FROM assistance_late_settlement WHERE "invoiceId" = $1`, [s.invoiceId]);
      expect(late, 'late settlement recorded').toBeDefined();
      const obligation = (await obligationsOf(r.id))[0]!;
      out.push({ requestId: r.id, productId: r.productId, priceId: r.priceId, lateId: late.id as string, settledAt: late.settledAt as Date, occurredAt: ev.headers.occurredAt as string,
        obligationId: obligation.id as string, paymentId: s.paymentId, paymentRequestId: s.paymentRequestId, invoiceId: s.invoiceId, beneficiaryUserId: identities.get(beneficiary)!.id });
    }
    return out;
  };
  const lateFixture = async (o: { beneficiary?: string } = {}) => (await lateFixtures(o.beneficiary ?? 'b1'))[0]!;
  type Late = Awaited<ReturnType<typeof lateFixture>>;

  // ── S6g HTTP
  const attest = (lateId: string, statement: string, bearer = 'b1', idem: string = key()) =>
    send(request(server()).post(`/billing/assistance-late-settlements/${lateId}/attestation`), bearer, idem).send({ statement });
  const listLate = (requestId: string, bearer = 'b1') => send(request(server()).get(`/billing/assistance-requests/${requestId}/late-settlements`), bearer, null);
  const readLate = (lateId: string, bearer = 'owner-tok') => send(request(server()).get(`/billing/admin/late-settlements/${lateId}`), bearer, null);
  const applyLate = (lateId: string, body: unknown, bearer = 'owner-tok', idem: string = key()) =>
    send(request(server()).post(`/billing/admin/late-settlements/${lateId}/application`), bearer, idem).send(body as object);
  /** Auth's `late_settlement_apply` receipt, issued to `issuer` for exactly this binding (AUTH-01 semantics, #398). */
  const receiptFor = (l: Late, reasonCode: string, o: { issuer?: string; binding?: Record<string, unknown> } = {}) => {
    const secret = randomBytes(32).toString('base64url');
    fraudAuth.issued.set(secret, { id: randomUUID(), issuer: o.issuer ?? U.owner, binding: {
      operation: 'late_settlement_apply', audience: 'billing-service', companyId: COMPANY, lateSettlementId: l.lateId, assistanceRequestId: l.requestId,
      beneficiaryUserId: l.beneficiaryUserId, reasonCode, ...o.binding,
    } });
    return secret;
  };
  const attested = (l: Late, o: { issuer?: string; binding?: Record<string, unknown> } = {}) => ({ reasonCode: 'cash_not_returned_attested', receiptSecret: receiptFor(l, 'cash_not_returned_attested', o) });
  /** File's `settlement_evidence` grant to Billing for this late settlement. */
  const grant = (l: Late, over: Partial<GrantedFraudEvidence> = {}) => {
    const g = { grantId: randomUUID(), fileId: randomUUID(), purpose: 'settlement_evidence', caseRef: l.lateId, companyId: null, subjectUserId: null, ...over } as GrantedFraudEvidence;
    fraudFiles.grants.set(g.grantId, g);
    return { grantId: g.grantId, fileId: g.fileId };
  };
  const evidenced = (l: Late, refs = [grant(l)]) => ({ reasonCode: 'cash_not_returned_evidenced', receiptSecret: receiptFor(l, 'cash_not_returned_evidenced'), evidence: refs, ownerDetermination: 'cash_not_returned' });
  const refusal = (r: request.Response) => [r.status, r.body.code, r.body.reason];

  beforeEach(() => {
    fraudAuth.down = false;
    fraudFiles.down = false;
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── recognition (L-1, L-2) and the read

  describe('late settlements are recorded and never applied automatically (L-1, L-2)', () => {
    it('Payment\'s original instant is kept on the record; no purchase, no entitlement; the participants and the Owner see it unapplied', async () => {
      const l = await lateFixture();
      expect(new Date(l.settledAt).toISOString()).toBe(l.occurredAt); // the trusted envelope instant, never the recording time
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [l.requestId])).toBe(0);
      expect((await entitlement(U.b1, l.productId).expect(200)).body.valid).toBe(false);
      const list = await listLate(l.requestId);
      expect(list.status).toBe(200);
      expect(list.body.lateSettlements).toEqual([expect.objectContaining({ id: l.lateId, lateReason: 'cash_return_obligation_exists', status: 'unapplied', settledAt: l.occurredAt, attestation: null, application: null })]);
      expect((await listLate(l.requestId, 'a1')).status).toBe(200);
      expect((await listLate(l.requestId, 'a2')).status).toBe(404); // another Organization's administrator
      expect((await listLate(l.requestId, 'm1')).status).toBe(404);
      const r = await readLate(l.lateId);
      expect(r.body).toMatchObject({ id: l.lateId, status: 'unapplied', settledAt: l.occurredAt, application: null, evidence: [], refundCases: [] });
      expect((await readLate(l.lateId, 'foreign-owner-tok')).status).toBe(404);
      expect((await readLate(l.lateId, 'operator-tok')).status).toBe(403);
      // the restrictions stand: T1 is gone only by settlement, so the request's T2 holds
      expect((await restrictions()).map((x) => [x.kind, x.sourceId])).toEqual([['T1', l.requestId], ['T2', l.obligationId]]); // S5d: T1 kept while unresolved
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── R6G-2 Path A

  describe('beneficiary attestation (R6G-2 Path A)', () => {
    it('only the live beneficiary, once; append-only; it changes nothing financial', async () => {
      const [l, l2] = await lateFixtures('b1', 'b2');
      expect((await attest(l.lateId, 'cash_not_returned', 'a1')).status).toBe(403); // the Organization's administrator
      expect((await attest(l.lateId, 'cash_not_returned', 'b2')).status).toBe(404); // another member
      expect((await attest(l.lateId, 'maybe')).body.code).toBe('invalid_late_settlement_request');
      const idem = key();
      const a = await attest(l.lateId, 'cash_not_returned', 'b1', idem);
      expect([a.status, a.body.statement]).toEqual([201, 'cash_not_returned']);
      expect((await attest(l.lateId, 'cash_not_returned', 'b1', idem)).headers['idempotent-replayed']).toBe('true');
      expect((await attest(l.lateId, 'cash_returned')).body.code).toBe('late_settlement_already_attested');
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [l.requestId])).toBe(0);
      expect((await obligationsOf(l.requestId)).map((o) => o.status)).toEqual(['open']);
      const audited = (await audit(l.lateId)).filter((x) => x.name === 'audit.assistance_late_settlement.attested');
      expect(audited.map((x) => [x.payload.actor, x.payload.changes])).toEqual([[{ type: 'user', id: U.b1, userKind: 'member' }, { assistance_request_id: l.requestId, statement: 'cash_not_returned' }]]);
      await expect(admin.query(`UPDATE late_settlement_attestation SET statement = 'cash_returned' WHERE "lateSettlementId" = $1`, [l.lateId])).rejects.toThrow();
      await expect(admin.query(`INSERT INTO late_settlement_attestation ("lateSettlementId", "assistanceRequestId", "beneficiaryUserId", statement) SELECT id, "assistanceRequestId", $2, 'cash_returned' FROM assistance_late_settlement WHERE id = $1`,
        [l2!.lateId, U.b1])).rejects.toMatchObject({ constraint: 'late_settlement_attestation_beneficiary' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── L-4 application

  describe('the Owner\'s L-4 application (R6G-1, R6G-3 to R6G-7)', () => {
    it('attested: one transaction supersedes the deadline obligation, records the purchase (original instant kept, full period from now) and settles the request; T1/T2 end for it only', async () => {
      const [other, l_] = await lateFixtures('b2', 'b1'); // another request of the same Organization: untouched
      const l = l_!;
      await attest(l.lateId, 'cash_not_returned').expect(201);
      const idem = key();
      const body = attested(l);
      const before = Date.now();
      const r = await applyLate(l.lateId, body, 'owner-tok', idem);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ id: l.lateId, status: 'applied', settledAt: l.occurredAt, application: { reasonCode: 'cash_not_returned_attested', appliedBy: { userId: U.owner }, supersededObligationId: l.obligationId } });
      const p = await one(`SELECT id, "settledAt", "appliedAt", "originalStart", "originalEnd", purpose FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [l.requestId]);
      expect(new Date(p.settledAt).toISOString()).toBe(l.occurredAt); // Payment's instant: never rewritten
      expect(new Date(p.appliedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(p.originalStart).toEqual(p.appliedAt); // R6G-5: the period starts at the application, never backdated
      const month = await one(`SELECT ($1::timestamptz + interval '1 month') AS e`, [p.originalStart]);
      expect(p.originalEnd).toEqual(month.e); // the full authorized duration
      expect((await entitlement(U.b1, l.productId).expect(200)).body.valid).toBe(true);
      expect(await obligationsOf(l.requestId)).toEqual([{ id: l.obligationId, origin: 'deadline', status: 'superseded_by_settlement', supersededByApplicationId: expect.any(String) }]);
      expect((await one(`SELECT status FROM assistance_request WHERE id = $1`, [l.requestId])).status).toBe('settled');
      expect((await one(`SELECT status FROM assistance_settlement_channel WHERE "invoiceId" = $1`, [l.invoiceId])).status).toBe('settled');
      expect((await restrictions()).map((x) => [x.kind, x.sourceId])).toEqual([['T1', other!.requestId], ['T2', other!.obligationId]]); // only the other request's T1 / T2 remain
      expect(fraudAuth.issued.get(body.receiptSecret)!.consumeRef).toEqual(expect.any(String));
      // replay: the stored answer; nothing consumed again
      const again = await applyLate(l.lateId, body, 'owner-tok', idem);
      expect([again.status, again.headers['idempotent-replayed']]).toEqual([201, 'true']);
      expect(refusal(await applyLate(l.lateId, attested(l)))).toEqual([409, 'late_settlement_refused', 'already_applied']);
      expect(await auditNames(l.lateId)).toEqual(['audit.assistance_late_settlement.attested', 'audit.assistance_late_settlement.applied']);
      const applied = (await audit(l.lateId)).find((x) => x.name === 'audit.assistance_late_settlement.applied')!;
      expect([applied.payload.actor, applied.payload.changes]).toEqual([{ type: 'user', id: U.owner, userKind: 'owner' },
        { assistance_request_id: l.requestId, reason_code: 'cash_not_returned_attested', purchase_id: p.id, superseded_obligation_id: l.obligationId, evidence_count: 0 }]);
      expect((await audit(l.obligationId)).filter((x) => x.name === 'audit.cash_return_obligation.superseded').map((x) => x.payload.changes)).toEqual([{ assistance_request_id: l.requestId, late_settlement_id: l.lateId }]);
      expect(await count(`SELECT count(*) AS n FROM outbox WHERE name NOT LIKE 'audit.%' AND name ~* 'late|settlement'`)).toBe(0); // no billing.* events
      // the request view: the current obligation is none, the history keeps the superseded one
      const view = (await send(request(server()).get(`/billing/assistance-requests/${l.requestId}`), 'b1', null)).body;
      expect(view.cashReturnObligation).toBeNull();
      expect(view.cashReturnObligations).toEqual([expect.objectContaining({ id: l.obligationId, status: 'superseded_by_settlement', supersededAt: expect.any(String) })]);
    });

    it('R6G-5 within K-3: an existing paid period of the same product is never overlapped; the applied period continues it at full duration', async () => {
      const l = await lateFixture();
      const direct = await directPurchase('b1', { productId: l.productId, priceId: l.priceId }); // the beneficiary already pays for this product
      await attest(l.lateId, 'cash_not_returned').expect(201);
      await applyLate(l.lateId, attested(l)).expect(201);
      const spans = (await admin.query(`SELECT "purchaseId", "effectiveStart", "effectiveEnd" FROM billing_personal_spans(
        (SELECT "personalSubscriptionId" FROM subscription_purchase WHERE "assistanceRequestId" = $1))`, [l.requestId])).rows as Row[];
      const applied = await one(`SELECT id FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [l.requestId]);
      const directId = (await one(`SELECT s.id FROM subscription_purchase s JOIN payment_request pr ON pr.id = s."paymentRequestId" WHERE pr."paymentId" = $1`, [direct.paymentId])).id;
      expect(spans.map((x) => x.purchaseId)).toEqual([directId, applied.id]);
      expect(spans[1].effectiveStart).toEqual(spans[0].effectiveEnd); // chained after the paid period: no overlap, nothing lost
      // the full duration on the calendar of ADR-0044 B-025 (amendment 2026-09-29): a continuing monthly period keeps the chain's persistent
      // billing anchor (the first settlement) and ends on the anchor's next occurrence, day clamped. Never "previous end + 1 month": from a
      // month-end anchor that drifts (Oct 31 -> Nov 30 -> Dec 30) where the anchored calendar recovers (Oct 31 -> Nov 30 -> Dec 31).
      const anchor = spans[0].effectiveStart as Date;
      expect(spans[0].effectiveEnd).toEqual(anchorOccurrence(anchor, 1));
      expect(spans[1].effectiveEnd).toEqual(anchorOccurrence(anchor, 2));
    });

    it('R6G-5 / B-025 month-end chains, independent of today: each continuing period ends on the ORIGINAL anchor\'s occurrence', async () => {
      const periodEnd = async (start: Date, anchor: Date, unit: 'month' | 'year') =>
        (await one(`SELECT billing_subscription_period_end($1, $2, $3, 1) AS e`, [start, anchor, unit])).e as Date;
      const chains: [string, 'month' | 'year', number][] = [
        ['2027-01-31T10:00:00Z', 'month', 4], // February (28 days), then March 31, April 30, May 31
        ['2028-01-31T10:00:00Z', 'month', 2], // a leap February (29 days), then March 31
        ['2026-10-31T00:03:14.921Z', 'month', 4], // November 30, December 31, January 31, February 28
        ['2026-12-31T23:59:59.000Z', 'month', 3], // across the year: January 31, February 28, March 31
        ['2027-08-31T12:00:00Z', 'month', 4], // September 30, October 31, November 30, December 31
        ['2028-02-29T08:00:00Z', 'year', 4], // a yearly Feb 29 anchor: Feb 28 three times, Feb 29 again in 2032
      ];
      for (const [iso, unit, n] of chains) {
        const anchor = new Date(iso);
        let start = anchor;
        for (let k = 1; k <= n; k++) {
          const end = await periodEnd(start, anchor, unit); // each period starts where the previous one ended
          expect(end, `${iso} ${unit} #${k}`).toEqual(anchorOccurrence(anchor, k * (unit === 'year' ? 12 : 1)));
          start = end;
        }
      }
      // the drift the former assertion encoded: from Nov 30 "+ 1 month" is Dec 30; the anchored period from an Oct 31 anchor ends Dec 31
      const octAnchor = new Date('2026-10-31T00:03:14.921Z');
      const nov30 = await periodEnd(octAnchor, octAnchor, 'month');
      expect((await one(`SELECT ($1::timestamptz + interval '1 month') AS e`, [nov30])).e).toEqual(new Date('2026-12-30T00:03:14.921Z'));
      expect(await periodEnd(nov30, octAnchor, 'month')).toEqual(new Date('2026-12-31T00:03:14.921Z'));
    });

    it('evidenced (Path B): live settlement_evidence grants plus the Owner\'s explicit determination; a file reference alone proves nothing', async () => {
      const l = await lateFixture();
      const { ownerDetermination: _d, ...noDetermination } = evidenced(l);
      expect((await applyLate(l.lateId, noDetermination)).body.code).toBe('invalid_late_settlement_request');
      expect((await applyLate(l.lateId, { ...evidenced(l), evidence: [] })).body.code).toBe('invalid_late_settlement_request');
      expect((await applyLate(l.lateId, { ...attested(l), evidence: [grant(l)] })).body.code).toBe('invalid_late_settlement_request');
      expect((await applyLate(l.lateId, { ...evidenced(l), legalOverride: true })).body.code).toBe('invalid_late_settlement_request');
      for (const bad of [{ purpose: 'fraud_evidence' }, { caseRef: randomUUID() }, { companyId: OTHER_COMPANY }, { subjectUserId: U.b2 }]) {
        expect((await applyLate(l.lateId, evidenced(l, [grant(l, bad as never)]))).body.code, JSON.stringify(bad)).toBe('late_settlement_evidence_invalid');
      }
      fraudFiles.down = true;
      expect((await applyLate(l.lateId, evidenced(l))).body.code).toBe('late_settlement_evidence_unavailable');
      fraudFiles.down = false;
      expect(await count(`SELECT count(*) AS n FROM late_settlement_application WHERE "lateSettlementId" = $1`, [l.lateId])).toBe(0);
      const refs = [grant(l), grant(l, { companyId: COMPANY, subjectUserId: U.b1 })];
      const r = await applyLate(l.lateId, evidenced(l, refs));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.evidence.map((e: Row) => e.grantId).sort()).toEqual(refs.map((x) => x.grantId).sort());
      expect((await audit(l.lateId)).find((x) => x.name === 'audit.assistance_late_settlement.applied')!.payload.changes.evidence_count).toBe(2);
    });

    it('authority and receipts: another Company\'s Owner, an operator, a member; a receipt of another Owner, reason or late settlement; Auth unresolved is repeated', async () => {
      const l = await lateFixture();
      await attest(l.lateId, 'cash_not_returned').expect(201);
      expect((await applyLate(l.lateId, attested(l), 'foreign-owner-tok')).status).toBe(404);
      expect((await applyLate(l.lateId, attested(l), 'operator-tok')).status).toBe(403);
      expect((await applyLate(l.lateId, attested(l), 'member-tok')).status).toBe(403);
      expect((await applyLate(l.lateId, attested(l), 'b1')).status).toBe(401); // a member's own bearer is not an Owner's (Auth's /grants)
      expect((await applyLate(l.lateId, attested(l, { issuer: randomUUID() }))).body.code).toBe('late_settlement_authorization_refused');
      expect((await applyLate(l.lateId, attested(l, { binding: { reasonCode: 'cash_not_returned_evidenced' } }))).body.code).toBe('late_settlement_authorization_refused');
      expect((await applyLate(l.lateId, attested(l, { binding: { lateSettlementId: randomUUID() } }))).body.code).toBe('late_settlement_authorization_refused');
      fraudAuth.down = true;
      const body = attested(l);
      const idem = key();
      expect((await applyLate(l.lateId, body, 'owner-tok', idem)).body.code).toBe('late_settlement_authorization_unresolved');
      expect(await count(`SELECT count(*) AS n FROM late_settlement_application WHERE "lateSettlementId" = $1`, [l.lateId])).toBe(0);
      fraudAuth.down = false;
      expect((await applyLate(l.lateId, body, 'owner-tok', idem)).status).toBe(201); // the same request, repeated
    });

    it('L-6 and the contradiction rules refuse before any receipt is spent; nothing changes', async () => {
      // no attestation, or a contrary one (which refuses both paths)
      const [a, b, c] = (await lateFixtures('b1', 'b2', 'admin-beneficiary')) as [Late, Late, Late];
      const body = attested(a);
      expect(refusal(await applyLate(a.lateId, body))).toEqual([409, 'late_settlement_refused', 'evidence_insufficient']);
      expect(fraudAuth.issued.get(body.receiptSecret)!.consumeRef).toBeUndefined(); // not spent
      await attest(a.lateId, 'cash_returned').expect(201);
      expect(refusal(await applyLate(a.lateId, attested(a)))).toEqual([409, 'late_settlement_refused', 'evidence_contradictory']);
      expect(refusal(await applyLate(a.lateId, evidenced(a)))).toEqual([409, 'late_settlement_refused', 'evidence_contradictory']);
      // the Organization reported the return; then the beneficiary confirmed it (L-6)
      await attest(b.lateId, 'cash_not_returned', 'b2').expect(201);
      await send(request(server()).post(`/billing/cash-return-obligations/${b.obligationId}/return`), 'a1', key()).send({ returnedAt: ago(60_000) }).expect(200);
      expect(refusal(await applyLate(b.lateId, attested(b)))).toEqual([409, 'late_settlement_refused', 'cash_return_reported']);
      await send(request(server()).post(`/billing/cash-return-obligations/${b.obligationId}/confirm`), 'b2', key()).send().expect(200);
      expect(refusal(await applyLate(b.lateId, attested(b)))).toEqual([409, 'late_settlement_refused', 'cash_return_confirmed']);
      // an open dispute
      await attest(c.lateId, 'cash_not_returned', 'admin-beneficiary').expect(201);
      await send(request(server()).post(`/billing/assistance-requests/${c.requestId}/disputes`), 'admin-beneficiary', key()).send({ reasonCode: 'cash_not_returned' }).expect(201);
      expect(refusal(await applyLate(c.lateId, attested(c)))).toEqual([409, 'late_settlement_refused', 'dispute_open']);
      expect(await count(`SELECT count(*) AS n FROM late_settlement_application WHERE "lateSettlementId" IN ($1, $2, $3)`, [a.lateId, b.lateId, c.lateId])).toBe(0);
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" IN ($1, $2, $3)`, [a.requestId, b.requestId, c.requestId])).toBe(0);
    });

    it('R6G-7: a refund case on the late payment refuses the application; a cancelled case that never relayed does not', async () => {
      const [l, m] = (await lateFixtures('b1', 'b2')) as [Late, Late];
      await attest(l.lateId, 'cash_not_returned').expect(201);
      const open = await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: l.paymentId, reason: 'late_settlement_unapplied' });
      expect([open.status, open.body.eligibility]).toEqual([201, 'late_assisted_settlement']);
      expect(refusal(await applyLate(l.lateId, attested(l)))).toEqual([409, 'late_settlement_refused', 'refund_exists']);
      await send(request(server()).post(`/billing/admin/refund-cases/${open.body.id}/cancel`), 'owner-tok', key()).send().expect(200);
      expect((await applyLate(l.lateId, attested(l))).status).toBe(201);
      // a relayed authorization, even on a cancelled-looking case, is never treated as proof that no refund is unresolved
      await attest(m.lateId, 'cash_not_returned', 'b2').expect(201);
      const c2 = (await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: m.paymentId, reason: 'late_settlement_unapplied' })).body.id;
      await send(request(server()).post(`/billing/admin/refund-cases/${c2}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') }).expect(201);
      expect(refusal(await applyLate(m.lateId, attested(m)))).toEqual([409, 'late_settlement_refused', 'refund_exists']);
    });

    it('historical late records: Payment\'s trusted envelope supplies the instant; without any trusted instant the application is refused, never invented', async () => {
      const [l, u] = (await lateFixtures('b1', 'b2')) as [Late, Late];
      await attest(l.lateId, 'cash_not_returned').expect(201);
      await backdate(l.lateId, `UPDATE assistance_late_settlement SET "settledAt" = NULL WHERE id = $1`); // as recorded before S6g
      expect((await readLate(l.lateId)).body.settledAt).toBe(l.occurredAt); // from payment_event_origin
      const r = await applyLate(l.lateId, attested(l));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(new Date((await one(`SELECT "settledAt" FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [l.requestId])).settledAt).toISOString()).toBe(l.occurredAt);
      await attest(u.lateId, 'cash_not_returned', 'b2').expect(201);
      await backdate(u.lateId, `UPDATE assistance_late_settlement SET "settledAt" = NULL WHERE id = $1`);
      await backdate(u.lateId, `DELETE FROM payment_event_origin WHERE "eventId" = (SELECT r."eventId" FROM payment_event_receipt r JOIN assistance_late_settlement l ON l."receiptId" = r.id WHERE l.id = $1)`);
      expect(refusal(await applyLate(u.lateId, attested(u)))).toEqual([409, 'late_settlement_refused', 'settlement_time_unavailable']);
    });

    it('concurrency: duplicate applications and two late successes of one request give one purchase; a racing return report and application never both win', async () => {
      const [l, ...racers] = (await lateFixtures('b1', 'b2', 'm1', 'admin-beneficiary')) as Late[];
      await attest(l!.lateId, 'cash_not_returned').expect(201);
      const outs = await Promise.all(Array.from({ length: 6 }, () => applyLate(l!.lateId, attested(l!))));
      expect(outs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(outs.filter((r) => r.status === 409).every((r) => ['late_settlement_refused'].includes(r.body.code))).toBe(true);
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [l!.requestId])).toBe(1);
      // return report vs application
      const who: Record<string, string> = { [U.b2]: 'b2', [U.m1]: 'm1', [U.adminBeneficiary]: 'admin-beneficiary' };
      for (const x of racers) {
        await attest(x.lateId, 'cash_not_returned', who[x.beneficiaryUserId]!).expect(201);
        const [rep, app] = await Promise.all([
          send(request(server()).post(`/billing/cash-return-obligations/${x.obligationId}/return`), 'a1', key()).send({ returnedAt: ago(60_000) }),
          applyLate(x.lateId, attested(x)),
        ]);
        expect([rep.status === 200, app.status === 201].filter(Boolean), `${rep.status} ${JSON.stringify(rep.body)} / ${app.status} ${JSON.stringify(app.body)}`).toHaveLength(1);
        const o = (await obligationsOf(x.requestId))[0]!;
        expect(o.status).toBe(app.status === 201 ? 'superseded_by_settlement' : 'return_reported');
        expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [x.requestId])).toBe(app.status === 201 ? 1 : 0);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── Option A: refund after application

  describe('obligation history (Option A): a refund after the application', () => {
    it('the refund reverses the applied purchase once and opens a NEW refund-origin obligation; the superseded one is kept; T2 returns; discharge works', async () => {
      const l = await lateFixture();
      await attest(l.lateId, 'cash_not_returned').expect(201);
      await applyLate(l.lateId, attested(l)).expect(201);
      expect((await restrictions()).filter((x) => x.sourceId === l.obligationId)).toEqual([]);
      // no CURRENT obligation now: a cash_not_returned dispute concerns nothing (the superseded one is history)
      expect((await send(request(server()).post(`/billing/assistance-requests/${l.requestId}/disputes`), 'b1', key()).send({ reasonCode: 'cash_not_returned' })).body.code).toBe('dispute_not_permitted');
      expect((await one(`SELECT billing_assistance_current_obligation($1) AS id`, [l.requestId])).id).toBeNull();
      const open = await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: l.paymentId, reason: 'customer_request' });
      expect([open.status, open.body.eligibility]).toEqual([201, 'personal_purchase']); // now a Personal purchase, refundable only as such
      await send(request(server()).post(`/billing/admin/refund-cases/${open.body.id}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') }).expect(201);
      const att = await one(`SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [open.body.id]);
      const ev = randomUUID();
      const completion = { id: ev, name: 'refund.case_completed', payload: { refundCaseId: open.body.id, refundAuthorizationId: randomUUID(), refundAttemptId: att.id, paymentId: l.paymentId,
        paymentRequestId: l.paymentRequestId, producer: 'billing-service', approvedAmount: open.body.amount, currency: 'TND', completedAt: new Date().toISOString(), liveMode: false,
        organizationId: ORG, purpose: 'assisted_settlement' }, headers: { eventId: ev, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } };
      await t.bus.deliver(completion);
      await t.bus.deliver(completion); // a duplicate delivery
      await t.app.get(RefundEffectService).drainOnce();
      await t.app.get(RefundEffectService).drainOnce(); // a worker retry
      const purchase = await one(`SELECT id FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [l.requestId]);
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [purchase.id])).toBe(1);
      const hist = await obligationsOf(l.requestId);
      expect(hist.map((o) => [o.origin, o.status])).toEqual([['deadline', 'superseded_by_settlement'], ['refund_completion', 'open']]);
      expect(hist[0]!.id).toBe(l.obligationId); // the original keeps its identity
      expect((await restrictions()).map((x) => [x.kind, x.sourceId])).toEqual([['T2', hist[1]!.id]]);
      expect((await entitlement(U.b1, l.productId).expect(200)).body.valid).toBe(false);
      // only one live obligation per request
      await expect(admin.query(`INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt", origin, "refundCaseId")
        SELECT "assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt", 'refund_completion', "refundCaseId" FROM cash_return_obligation WHERE id = $1`, [hist[1]!.id]))
        .rejects.toThrow();
      // discharge: the Organization reports, the beneficiary confirms; the request is returned; T2 clears
      expect((await one(`SELECT billing_assistance_current_obligation($1) AS id`, [l.requestId])).id).toBe(hist[1]!.id);
      const returnedAt = ago(60_000);
      await send(request(server()).post(`/billing/cash-return-obligations/${hist[1]!.id}/return`), 'a1', key()).send({ returnedAt }).expect(200);
      // corrections and their effective time read the CURRENT (refund-origin) obligation, never the superseded one
      expect(new Date((await one(`SELECT billing_assistance_effective_time($1, 'returnedAt') AS v`, [l.requestId])).v).toISOString()).toBe(returnedAt);
      await send(request(server()).post(`/billing/cash-return-obligations/${hist[1]!.id}/confirm`), 'b1', key()).send().expect(200);
      expect((await one(`SELECT status FROM assistance_request WHERE id = $1`, [l.requestId])).status).toBe('returned');
      expect(await restrictions()).toEqual([]);
      expect((await obligationsOf(l.requestId)).map((o) => o.status)).toEqual(['superseded_by_settlement', 'confirmed_returned']);
      const view = (await send(request(server()).get(`/billing/assistance-requests/${l.requestId}`), 'b1', null)).body;
      expect(view.cashReturnObligation).toMatchObject({ id: hist[1]!.id, status: 'confirmed_returned', origin: 'refund_completion' });
      expect(view.cashReturnObligations.map((o: Row) => o.id)).toEqual([l.obligationId, hist[1]!.id]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the database

  describe('the database (migration 0040)', () => {
    it('supersession only by an application; superseded is terminal; an application commits with its purchase, settled request and superseded obligation', async () => {
      const l = await lateFixture();
      await expect(admin.query(`UPDATE cash_return_obligation SET status = 'superseded_by_settlement', "supersededByApplicationId" = gen_random_uuid() WHERE id = $1`, [l.obligationId]))
        .rejects.toThrow();
      await attest(l.lateId, 'cash_not_returned').expect(201);
      // an application without its purchase never commits (deferred check): the transaction rolls back as a whole
      const cl = await admin.connect();
      try {
        await cl.query('BEGIN');
        await cl.query(`INSERT INTO late_settlement_application ("lateSettlementId", "assistanceRequestId", "companyId", "platformId", "organizationId", "beneficiaryUserId",
            "reasonCode", "attestationId", "obligationId", "appliedByUserId", "receiptId", "settledAt")
          SELECT l.id, l."assistanceRequestId", $2, a."platformId", a."organizationId", a."beneficiaryUserId", 'cash_not_returned_attested',
                 (SELECT t.id FROM late_settlement_attestation t WHERE t."lateSettlementId" = l.id), $3, $4, gen_random_uuid(), billing_late_settlement_settled_at(l.id)
            FROM assistance_late_settlement l JOIN assistance_request a ON a.id = l."assistanceRequestId" WHERE l.id = $1`, [l.lateId, COMPANY, l.obligationId, U.owner]);
        await expect(cl.query('COMMIT')).rejects.toMatchObject({ constraint: 'late_settlement_application_atomic' });
      } finally {
        cl.release();
      }
      expect(await count(`SELECT count(*) AS n FROM late_settlement_application WHERE "lateSettlementId" = $1`, [l.lateId])).toBe(0);
      expect((await obligationsOf(l.requestId))[0]!.status).toBe('open');
      // an applied-purchase marker without its application is refused; a direct purchase can never carry one
      await expect(admin.query(`UPDATE subscription_purchase SET "appliedAt" = now() WHERE id = (SELECT id FROM subscription_purchase LIMIT 1)`)).rejects.toThrow();
      await applyLate(l.lateId, attested(l)).expect(201);
      for (const sql of [`UPDATE cash_return_obligation SET status = 'open', "supersededAt" = NULL, "supersededByApplicationId" = NULL WHERE id = $1`,
        `UPDATE cash_return_obligation SET "supersededAt" = now() WHERE id = $1`, `DELETE FROM cash_return_obligation WHERE id = $1`]) {
        await expect(admin.query(sql, [l.obligationId]), sql).rejects.toThrow();
      }
      await expect(admin.query(`UPDATE late_settlement_application SET "reasonCode" = 'cash_not_returned_evidenced'`)).rejects.toThrow();
      // one application per request and per late settlement (L-5): a second verified late success of the request can never become a purchase
      const app = await one(`SELECT * FROM late_settlement_application WHERE "lateSettlementId" = $1`, [l.lateId]);
      await expect(admin.query(`INSERT INTO late_settlement_application ("lateSettlementId", "assistanceRequestId", "companyId", "platformId", "organizationId", "beneficiaryUserId",
          "reasonCode", "attestationId", "obligationId", "appliedByUserId", "receiptId", "settledAt") VALUES ($1, $2, $3, $4, $5, $6, 'cash_not_returned_attested', $7, NULL, $8, gen_random_uuid(), $9)`,
        [app.lateSettlementId, app.assistanceRequestId, app.companyId, app.platformId, app.organizationId, app.beneficiaryUserId, app.attestationId, U.owner, app.settledAt])).rejects.toThrow();
      await expect(admin.query(`DELETE FROM late_settlement_evidence`)).rejects.toThrow();
    });
  });

  it('Core V2 S6h-B (L-2, R6H-1): an unapplied late settlement is a reconciliation case, found again by every pass; the L-4 application resolves it, once', async () => {
    const l = await lateFixture({ beneficiary: 'b2' });
    const reconcile = () => t.app.get(ReconciliationService).drainOnce();
    const caseOf = () => one(`SELECT c.id, c."companyId", c."organizationId", r.kind FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
      WHERE c."caseType" = 'late_assisted_settlement' AND c."evidenceKey" = $1`, [l.lateId]);
    await Promise.all([reconcile(), reconcile()]);
    await reconcile();
    expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "evidenceKey" = $1`, [l.lateId])).toBe(1);
    expect(await caseOf()).toMatchObject({ companyId: COMPANY, organizationId: ORG, kind: null });
    await attest(l.lateId, 'cash_not_returned', 'b2').expect(201);
    expect((await applyLate(l.lateId, attested(l))).status).toBe(201);
    await reconcile();
    expect(await caseOf()).toMatchObject({ kind: 'late_settlement_applied' });
    expect(await count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.resolved' AND payload->'resource'->>'id' = $1`, [(await caseOf()).id])).toBe(1);
  });

  it('production mounts no late-settlement route', () => {
    expect(LateSettlementModule.register({ isProduction: true } as BillingConfig)).toEqual({ module: LateSettlementModule });
  });
});

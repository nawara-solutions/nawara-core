import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
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
import type { PaymentEventFacts, PaymentEventName } from '../src/domain/payment-event-decision.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import type { CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import { HttpOwnerAuthority } from '../src/platforms/owner-authority.client.js';
import type { DisputeExposure } from '../src/refunds/dispute-exposure.js';
import { RefundEffectService } from '../src/refunds/refund-effect.service.js';
import type { PaymentDisputeClient, PaymentDisputeLoss } from '../src/refunds/payment-dispute-client.js';
import type { FraudEvidenceFiles, FraudHoldReceipts, GrantedFraudEvidence } from '../src/fraud-holds/fraud-hold-clients.js';
import { HttpPaymentRefundClient, type CaptureReadOutcome, type PaymentRefundClient } from '../src/refunds/payment-refund-client.js';
import { ReconciliationService, captureContradictionKey } from '../src/reconciliation/reconciliation.service.js';
import type { PaymentItem, PaymentItemKind, PaymentReconciliationClient } from '../src/reconciliation/payment-reconciliation-client.js';
import { CashReturnSweep } from '../src/assistance/cash-return-sweep.js';
import { createTestApp, type TestApp } from './support/app.js';
import { FakeAuth } from './support/fake-auth.js';
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

/** Core V2 S0-C11: Payment's capture read under test control (the default is the R6H-5 answer below); every call is kept. */
const captureAt = { answer: null as null | ((paymentId: string, factId: string) => Promise<CaptureReadOutcome>), calls: [] as Array<[string, string]> };
/** Payment's refund port, authorizing every relayed attempt; each relayed body is kept (BIL-23 H: the attempt names its capture). */
const relayed: Array<Record<string, unknown>> = [];
const refundsAtPayment: PaymentRefundClient = {
  relay: async (_paymentId, _key, body) => {
    relayed.push(body as unknown as Record<string, unknown>);
    return { kind: 'attempt', attempt: { refundAttemptId: body.refundAttemptId, status: 'authorized', approvedBy: { userId: randomUUID() } } };
  },
  refunds: async () => ({ attempts: [], refusals: [], authorizations: [] }),
  // R6H-5: Payment's evidence of a late capture, refundable on its own (the capture-specific route must still refuse it, S0-C8)
  capture: async (paymentId, factId) => {
    captureAt.calls.push([paymentId, factId]);
    if (captureAt.answer) return captureAt.answer(paymentId, factId);
    // the capture as Payment states it: the fixtures' late captures are of the channel invoice's total (5300; the Organization's fee is not captured)
    return { kind: 'capture' as const, capture: { factId, paymentId, amount: 5300, currency: 'TND', basis: 'late_capture' as const, paymentStatus: 'expired',
      conflicted: false, refundableOnItsOwn: true, attemptCaptures: 1, refund: 'none' as const } };
  },
  settlingCapture: async () => ({ kind: 'unknown' as const, reason: 'not_used_in_this_suite' }), // Core V2 S0-C11 7c: no E-7 application here
};

/** Core V2 S6h-B: Payment's reconciliation read (PAY-12) under test control. */
const paymentItems = { items: new Map<PaymentItemKind, PaymentItem[]>(), down: false };
const paymentReconciliation: PaymentReconciliationClient = {
  items: async (kind, after, limit) => {
    if (paymentItems.down) throw new Error('payment-service unavailable');
    return (paymentItems.items.get(kind) ?? []).filter((i) => !after || i.id > after).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);
  },
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
 * Core V2 S0-C8 PR-2a (S0 §1.5 S0-C8 items 1 to 4, 6, 7, 9; register BIL-23 H, BIL-32 G input, BIL-33 G, EVT-10; the Owner's LS-1 to LS-6 and
 * LS-8), for DEVELOPMENT AND SIMULATION ONLY, on real PostgreSQL 16: Payment's verified LATE success of an assisted settlement whose payment
 * and request ended unsuccessfully on a closed channel becomes a late assisted settlement (the L-4 input) with its reconciliation case, refunded
 * in full by default as exactly its captured movement (L-3). Everything through Billing's real paths and Payment's verified events; NO
 * fixture places an obligation, and nothing here may create a purchase (PR-2b).
 */
describeWithEnv('late assisted settlement from Payment\'s late success (Core V2 S0-C8 PR-2a, simulation) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
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
  const key = () => `s0c8-${++k}-${randomUUID().slice(0, 8)}`;
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
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings0c8');
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
      paymentReconciliationClient: paymentReconciliation, // Core V2 S6h-B: PAY-12
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

  const attest = (lateId: string, statement: string, bearer = 'b1', idem: string = key()) =>
    send(request(server()).post(`/billing/assistance-late-settlements/${lateId}/attestation`), bearer, idem).send({ statement });
  const listLate = (requestId: string, bearer = 'b1') => send(request(server()).get(`/billing/assistance-requests/${requestId}/late-settlements`), bearer, null);

  const restrictions = async (organizationId = ORG) => (await admin.query(`SELECT kind, "sourceId" FROM billing_assistance_restrictions($1, now())`, [organizationId])).rows as Row[];
  const obligationsOf = async (requestId: string) =>
    (await admin.query(`SELECT id, origin, status, "supersededByApplicationId" FROM cash_return_obligation WHERE "assistanceRequestId" = $1 ORDER BY "openedAt", id`, [requestId])).rows as Row[];
  const auditNames = async (resourceId: string) => (await audit(resourceId)).map((x) => x.name as string);

  // ── S0-C8 fixtures: an assisted channel ended by Payment's verified final outcome, then Payment's verified LATE success
  const reconcile = () => t.app.get(ReconciliationService).drainOnce();
  /** A collected request whose channel Payment accepted and then definitively ended (`payment.failed` / `.cancelled` / `.expired`). */
  const ended = async (outcome: 'payment.failed' | 'payment.cancelled' | 'payment.expired' = 'payment.expired', o: { beneficiary?: string } = {}) => {
    const r = await collected({ unit: 5300, fee: 300, beneficiary: o.beneficiary });
    const s = await started(r.id, identities.get(o.beneficiary ?? 'b1')!.id as ReturnType<typeof randomUUID>);
    await t.bus.deliver(s.ev(outcome));
    expect(await one(`SELECT status FROM assistance_settlement_channel WHERE "invoiceId" = $1`, [s.invoiceId])).toEqual({ status: 'closed' });
    return { r, s, status: outcome.slice('payment.'.length) };
  };
  /** Payment's `payment.late_success.recorded` (EVT-10 v1), as Payment emits it, through the verified consumer. */
  const lateEnvelope = (s: { paymentRequestId: string; paymentId: string; inv: Row }, o: { factId?: string | null; lateSuccessId?: string; status?: string; amount?: number;
    currency?: string; recordedAt?: string } = {}) => {
    const id = randomUUID();
    const lateSuccessId = o.lateSuccessId ?? randomUUID();
    const factId = o.factId === undefined ? randomUUID() : o.factId;
    const recordedAt = o.recordedAt ?? new Date(Date.now() - 5_000).toISOString();
    const envelope: EventEnvelope = { id, name: 'payment.late_success.recorded', payload: {
      lateSuccessId, paymentId: s.paymentId, paymentRequestId: s.paymentRequestId, producer: 'billing-service', organizationId: s.inv.organizationId, purpose: 'assisted_settlement',
      attemptId: randomUUID(), factId, amount: o.amount ?? Number(s.inv.total), currency: o.currency ?? s.inv.currency.trim(), paymentStatus: o.status ?? 'expired', recordedAt, liveMode: false,
    }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } };
    return { lateSuccessId, factId, recordedAt, envelope };
  };
  const late = async (s: Parameters<typeof lateEnvelope>[0], o: Parameters<typeof lateEnvelope>[1] = {}) => {
    const l = lateEnvelope(s, o);
    await t.bus.deliver(l.envelope);
    return l;
  };
  const lateSettlementOf = (invoiceId: string) => one(`SELECT * FROM assistance_late_settlement WHERE "invoiceId" = $1`, [invoiceId]);
  const caseOf = (type: string, evidence: string) => one(`SELECT c.*, r.kind AS resolution FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
    WHERE c."caseType" = $1 AND c."evidenceKey" = $2`, [type, evidence]);
  const casesOfPayment = (paymentId: string) => admin.query(`SELECT "caseType", "evidenceKey" FROM reconciliation_case WHERE "paymentId" = $1 ORDER BY "caseType"`, [paymentId]).then((x) => x.rows as Row[]);
  /** L-2: nothing purchased, no entitlement, no obligation change; Payment's and Billing's final states untouched. */
  const nothingSold = async (r: { id: string; productId: string }, s: { paymentRequestId: string; invoiceId: string }, status: string) => {
    expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [r.id])).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM personal_subscription WHERE "userId" = $1 AND "productId" = $2`, [U.b1, r.productId])).toBe(0);
    expect(await one(`SELECT a.status AS request, pr.status AS "paymentRequest", c.status AS channel, i.status AS invoice
      FROM assistance_request a JOIN assistance_settlement_channel c ON c."assistanceRequestId" = a.id JOIN payment_request pr ON pr.id = c."paymentRequestId"
      JOIN invoice i ON i.id = c."invoiceId" WHERE c."invoiceId" = $1`, [s.invoiceId])).toEqual({ request: 'cash_collected', paymentRequest: status, channel: 'closed', invoice: 'open' });
    expect(await count(`SELECT count(*) AS n FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [r.id])).toBe(0);
  };
  const asItem = (i: Partial<PaymentItem> & { id: string; paymentId: string }): PaymentItem =>
    ({ kind: 'late_success', factId: null, amount: null, currency: null, detail: {}, at: new Date().toISOString(), ...i });
  beforeEach(() => {
    paymentItems.items.clear();
    paymentItems.down = false;
    relayed.length = 0;
    captureAt.answer = null;
    captureAt.calls.length = 0;
  });

  describe('an eligible late success is the L-4 input, never a purchase (S0-C8 item 1 b, L-1, L-2; LS-2, LS-4)', () => {
    it('after a failed, a cancelled and an expired payment: one late settlement (channel_closed, Payment\'s instant) and its late_assisted_settlement case', async () => {
      for (const outcome of ['payment.failed', 'payment.cancelled', 'payment.expired'] as const) {
        const { r, s, status } = await ended(outcome);
        const calls = payment.calls.length;
        const l = await late(s, { status });
        const row = await lateSettlementOf(s.invoiceId);
        expect(row, outcome).toMatchObject({ assistanceRequestId: r.id, paymentRequestId: s.paymentRequestId, lateSuccessId: l.lateSuccessId, receiptId: null, reason: 'channel_closed' });
        expect(new Date(row.settledAt).toISOString(), 'LS-2: Payment\'s recordedAt, never Billing\'s clock').toBe(l.recordedAt);
        const c = await caseOf('late_assisted_settlement', row.id);
        expect(c).toMatchObject({ paymentId: s.paymentId, paymentRequestId: s.paymentRequestId, captureFactId: l.factId, amount: String(s.inv.total), resolution: null });
        expect(await casesOfPayment(s.paymentId), 'one provider fact, one case').toEqual([{ caseType: 'late_assisted_settlement', evidenceKey: row.id }]);
        await nothingSold(r, s, status);
        expect(payment.calls.length, 'Payment is never asked to change anything').toBe(calls);
        // the beneficiary and the Owner see it unapplied (BIL-32 reads)
        const list = await listLate(r.id);
        expect(list.status).toBe(200);
        expect(list.body.lateSettlements).toEqual([expect.objectContaining({ id: row.id, status: 'unapplied', lateReason: 'channel_closed' })]);
      }
    });

    it('ineligible late successes stay refund-only late_success cases: amount, currency, no capture fact, another terminal state, a second capture of the invoice', async () => {
      const variants: Array<[string, (s: Parameters<typeof lateEnvelope>[0]) => Parameters<typeof lateEnvelope>[1]]> = [
        ['amount', (s) => ({ amount: Number(s.inv.total) + 1 })],
        ['currency', () => ({ currency: 'EUR' })],
        ['no capture fact', () => ({ factId: null })],
        ['state mismatch (request expired, payment failed)', () => ({ status: 'failed' })],
      ];
      for (const [name, over] of variants) {
        const { r, s, status } = await ended('payment.expired');
        const l = await late(s, over(s));
        expect(await lateSettlementOf(s.invoiceId), name).toBeUndefined();
        expect(await caseOf('late_success', l.lateSuccessId), name).toMatchObject({ detail: 'assisted_settlement', resolution: null });
        await nothingSold(r, s, status);
      }
      // the first eligible capture of the invoice is its late settlement; a second, distinct capture is refund-only
      const { r, s, status } = await ended('payment.expired');
      const first = await late(s);
      const second = await late(s);
      expect((await lateSettlementOf(s.invoiceId)).lateSuccessId).toBe(first.lateSuccessId);
      expect(await caseOf('late_success', second.lateSuccessId)).toMatchObject({ captureFactId: second.factId });
      expect(await caseOf('late_success', first.lateSuccessId)).toBeUndefined();
      await nothingSold(r, s, status);
    });

    it('a later capture of a SUCCEEDED assisted payment stays a late_success case (the sale keeps its own purchase)', async () => {
      const r = await collected({ unit: 5300, fee: 300 });
      const s = await started(r.id);
      await t.bus.deliver(s.ev('payment.succeeded'));
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [r.id])).toBe(1);
      const l = await late(s, { status: 'succeeded' });
      expect(await lateSettlementOf(s.invoiceId)).toBeUndefined();
      expect(await caseOf('late_success', l.lateSuccessId)).toBeDefined();
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [r.id])).toBe(1);
    });
  });

  describe('ordering, duplicates, replays and forgery (LS-5; S0-C6; DB-14)', () => {
    it('a late success before Billing holds the final outcome is recorded and deferred; the worker classifies it only after the outcome, never inferring it', async () => {
      const r = await collected({ unit: 5300, fee: 300 });
      const s = await started(r.id);
      const l = await late(s);
      expect(await count(`SELECT count(*) AS n FROM payment_late_success WHERE "lateSuccessId" = $1`, [l.lateSuccessId])).toBe(1); // L-1
      expect(await lateSettlementOf(s.invoiceId)).toBeUndefined();
      expect(await casesOfPayment(s.paymentId)).toEqual([]);
      await reconcile();
      await reconcile();
      expect(await lateSettlementOf(s.invoiceId), 'still deferred: the request is not final').toBeUndefined();
      expect(await casesOfPayment(s.paymentId)).toEqual([]);
      expect(await one(`SELECT status FROM assistance_settlement_channel WHERE "invoiceId" = $1`, [s.invoiceId])).toEqual({ status: 'open' });
      await t.bus.deliver(s.ev('payment.expired'));
      expect(await lateSettlementOf(s.invoiceId), 'the outcome itself classifies nothing').toBeUndefined();
      await reconcile();
      const row = await lateSettlementOf(s.invoiceId);
      expect(row).toMatchObject({ lateSuccessId: l.lateSuccessId, reason: 'channel_closed' });
      expect(await casesOfPayment(s.paymentId)).toEqual([{ caseType: 'late_assisted_settlement', evidenceKey: row.id }]);
      await nothingSold(r, s, 'expired');
    });

    it('the same late success redelivered, replayed and read from Payment is recorded and classified once; another statement of it changes nothing', async () => {
      const { r, s, status } = await ended('payment.expired');
      const l = lateEnvelope(s);
      await t.bus.deliver(l.envelope);
      await t.bus.deliver(l.envelope, 'verified_duplicate');
      await t.bus.deliver(l.envelope, 'verified_replay');
      paymentItems.items.set('late_success', [asItem({ id: l.lateSuccessId, paymentId: s.paymentId, factId: l.factId, amount: Number(s.inv.total), currency: 'TND',
        detail: { paymentStatus: 'expired' }, at: l.recordedAt })]);
      await reconcile();
      await reconcile();
      expect(await count(`SELECT count(*) AS n FROM payment_late_success WHERE "lateSuccessId" = $1`, [l.lateSuccessId])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM assistance_late_settlement WHERE "invoiceId" = $1`, [s.invoiceId])).toBe(1);
      const row = await lateSettlementOf(s.invoiceId);
      expect(await casesOfPayment(s.paymentId)).toEqual([{ caseType: 'late_assisted_settlement', evidenceKey: row.id }]);
      // another statement of the same late success: a conflict, never applied
      const conflicting = lateEnvelope(s, { lateSuccessId: l.lateSuccessId, factId: l.factId, amount: Number(s.inv.total) + 100 });
      await t.bus.deliver(conflicting.envelope);
      expect(await one(`SELECT amount::int AS amount FROM payment_late_success WHERE "lateSuccessId" = $1`, [l.lateSuccessId])).toEqual({ amount: Number(s.inv.total) });
      expect(await count(`SELECT count(*) AS n FROM assistance_late_settlement WHERE "invoiceId" = $1`, [s.invoiceId])).toBe(1);
      await nothingSold(r, s, status);
    });

    it('a lost event is recovered from Payment\'s read (Payment\'s instant kept); the event arriving afterwards changes nothing', async () => {
      const { s } = await ended('payment.expired');
      const l = lateEnvelope(s);
      paymentItems.items.set('late_success', [asItem({ id: l.lateSuccessId, paymentId: s.paymentId, factId: l.factId, amount: Number(s.inv.total), currency: 'TND',
        detail: { paymentStatus: 'expired' }, at: l.recordedAt })]);
      await reconcile();
      const row = await lateSettlementOf(s.invoiceId);
      expect(row).toMatchObject({ lateSuccessId: l.lateSuccessId });
      expect(new Date(row.settledAt).toISOString()).toBe(l.recordedAt);
      expect(await one(`SELECT source FROM payment_late_success WHERE "lateSuccessId" = $1`, [l.lateSuccessId])).toEqual({ source: 'reconciliation' });
      await t.bus.deliver(l.envelope);
      expect(await count(`SELECT count(*) AS n FROM assistance_late_settlement WHERE "invoiceId" = $1`, [s.invoiceId])).toBe(1);
      expect((await casesOfPayment(s.paymentId)).length).toBe(1);
    });

    it('forged or unbound late successes record nothing: a refused (unverified) delivery, an unknown payment, another request\'s payment', async () => {
      const { r, s, status } = await ended('payment.expired');
      const forged = lateEnvelope(s);
      await t.bus.deliver(forged.envelope, { refuse: 'untrusted_unverified_original' });
      const unknown = lateEnvelope({ ...s, paymentId: randomUUID() });
      await t.bus.deliver(unknown.envelope);
      const other = await ended('payment.expired');
      const crossed = lateEnvelope({ ...s, paymentId: other.s.paymentId });
      await t.bus.deliver(crossed.envelope);
      for (const x of [forged, unknown]) expect(await count(`SELECT count(*) AS n FROM payment_late_success WHERE "lateSuccessId" = $1`, [x.lateSuccessId])).toBe(0);
      expect(await lateSettlementOf(s.invoiceId), 'never this request\'s late settlement').toBeUndefined();
      await nothingSold(r, s, status);
    });

    it('concurrent deliveries, reads and worker passes classify exactly once', async () => {
      const { s } = await ended('payment.expired');
      const l = lateEnvelope(s);
      paymentItems.items.set('late_success', [asItem({ id: l.lateSuccessId, paymentId: s.paymentId, factId: l.factId, amount: Number(s.inv.total), currency: 'TND',
        detail: { paymentStatus: 'expired' }, at: l.recordedAt })]);
      await Promise.all([t.bus.deliver(l.envelope), t.bus.deliver(l.envelope, 'verified_duplicate'), reconcile(), reconcile(), t.bus.deliver(l.envelope, 'verified_replay')]);
      await reconcile();
      expect(await count(`SELECT count(*) AS n FROM payment_late_success WHERE "lateSuccessId" = $1`, [l.lateSuccessId])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM assistance_late_settlement WHERE "invoiceId" = $1`, [s.invoiceId])).toBe(1);
      expect((await casesOfPayment(s.paymentId)).length).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.opened' AND payload->'changes'->>'evidence_id' = $1`,
        [(await lateSettlementOf(s.invoiceId)).id])).toBe(1);
      // two distinct captures of one invoice racing: one late settlement, the other refund-only
      const two = await ended('payment.expired');
      const a = lateEnvelope(two.s);
      const b = lateEnvelope(two.s);
      await Promise.all([t.bus.deliver(a.envelope), t.bus.deliver(b.envelope), reconcile()]);
      await reconcile();
      expect(await count(`SELECT count(*) AS n FROM assistance_late_settlement WHERE "invoiceId" = $1`, [two.s.invoiceId])).toBe(1);
      const winner = (await lateSettlementOf(two.s.invoiceId)).lateSuccessId as string;
      const loser = winner === a.lateSuccessId ? b : a;
      expect(await caseOf('late_success', loser.lateSuccessId)).toBeDefined();
      expect((await casesOfPayment(two.s.paymentId)).map((c) => c.caseType as string).sort((x, y) => x.localeCompare(y))).toEqual(['late_assisted_settlement', 'late_success']);
    });
  });

  describe('the default: the full refund of exactly that capture (L-3, LS-6, BIL-23 H)', () => {
    const openRefund = (body: Record<string, unknown>) => send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send(body);

    it('a late_assisted_settlement case naming the capture; Payment refunds that capture; completion keeps the request as it is and resolves the case once', async () => {
      const { r, s, status } = await ended('payment.expired');
      const l = await late(s);
      const row = await lateSettlementOf(s.invoiceId);
      // the capture-specific route never refunds the capture that evidences a late settlement
      const viaCapture = await openRefund({ paymentId: s.paymentId, captureFactId: l.factId, reason: 'late_settlement_unapplied' });
      expect([viaCapture.status, viaCapture.body.code]).toEqual([409, 'refund_not_eligible']);
      const c = await openRefund({ paymentId: s.paymentId, reason: 'late_settlement_unapplied' });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      expect(await one(`SELECT eligibility, "lateSettlementId", "captureFactId", "captureBasis", "receiptId", amount::int AS amount FROM refund_case WHERE id = $1`, [c.body.id]))
        .toEqual({ eligibility: 'late_assisted_settlement', lateSettlementId: row.id, captureFactId: l.factId, captureBasis: 'late_capture', receiptId: null, amount: Number(s.inv.total) });
      const again = await openRefund({ paymentId: s.paymentId, reason: 'late_settlement_unapplied' });
      expect([again.status, again.body.code], 'one live case per captured movement').toEqual([409, 'refund_case_exists']);
      await send(request(server()).post(`/billing/admin/refund-cases/${c.body.id}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') }).expect(201);
      expect(relayed.at(-1), 'the attempt names its capture (the receipt binding names the same one)').toMatchObject({ captureFactId: l.factId, refundCaseId: c.body.id });
      const att = await one(`SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [c.body.id]);
      const ev = randomUUID();
      await t.bus.deliver({ id: ev, name: 'refund.case_completed', payload: { refundCaseId: c.body.id, refundAuthorizationId: randomUUID(), refundAttemptId: att.id, paymentId: s.paymentId,
        paymentRequestId: s.paymentRequestId, producer: 'billing-service', approvedAmount: Number(s.inv.total), currency: 'TND', completedAt: new Date().toISOString(), liveMode: false,
        organizationId: ORG, purpose: 'assisted_settlement' }, headers: { eventId: ev, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
      await t.app.get(RefundEffectService).drainOnce();
      expect(await one(`SELECT outcome, reason FROM refund_case_effect WHERE "refundCaseId" = $1`, [c.body.id])).toEqual({ outcome: 'none', reason: 'late_assisted_settlement' });
      await reconcile();
      await reconcile();
      expect(await caseOf('late_assisted_settlement', row.id)).toMatchObject({ resolution: 'refund_completed' });
      expect(await count(`SELECT count(*) AS n FROM reconciliation_case_resolution x JOIN reconciliation_case k ON k.id = x."caseId" WHERE k."evidenceKey" = $1`, [row.id])).toBe(1);
      await nothingSold(r, s, status);
    });
  });

  describe('the L-4 application from a late success (S0-C8 items 5 to 8; BIL-32 G; LS-2, LS-3, LS-7, LS-9)', () => {
    const sweep = () => t.app.get(CashReturnSweep).sweepOnce();
    const receipt = (l: { id: string }, r: { id: string }, o: { reasonCode?: string; issuer?: string; binding?: Record<string, unknown> } = {}) => {
      const secret = randomBytes(32).toString('base64url');
      fraudAuth.issued.set(secret, { id: randomUUID(), issuer: o.issuer ?? U.owner, binding: { operation: 'late_settlement_apply', audience: 'billing-service', companyId: COMPANY,
        lateSettlementId: l.id, assistanceRequestId: r.id, beneficiaryUserId: U.b1, reasonCode: o.reasonCode ?? 'cash_not_returned_attested', ...o.binding } });
      return secret;
    };
    const apply = (lateId: string, secret: string, bearer = 'owner-tok', idem: string = key()) =>
      send(request(server()).post(`/billing/admin/late-settlements/${lateId}/application`), bearer, idem).send({ reasonCode: 'cash_not_returned_attested', receiptSecret: secret });
    const refusal = (res: request.Response) => [res.status, res.body.code, res.body.reason];
    /** An eligible late settlement from Payment's late success, attested by its beneficiary (Path A). */
    const ready = async () => {
      const e = await ended('payment.expired');
      const l = await late(e.s);
      const row = await lateSettlementOf(e.s.invoiceId);
      await attest(row.id, 'cash_not_returned').expect(201);
      return { ...e, l, row: row as Row & { id: string } };
    };
    /** After a refusal or a failure: nothing at all changed (the request, its invoice, payment request, channel and obligations). */
    const unchanged = async (x: Awaited<ReturnType<typeof ready>>, obligations: Row[] = []) => {
      expect(await count(`SELECT count(*) AS n FROM late_settlement_application WHERE "lateSettlementId" = $1`, [x.row.id])).toBe(0);
      expect(await one(`SELECT a.status AS request, pr.status AS "paymentRequest", c.status AS channel, i.status AS invoice
        FROM assistance_request a JOIN assistance_settlement_channel c ON c."assistanceRequestId" = a.id JOIN payment_request pr ON pr.id = c."paymentRequestId"
        JOIN invoice i ON i.id = c."invoiceId" WHERE c."invoiceId" = $1`, [x.s.invoiceId])).toEqual({ request: 'cash_collected', paymentRequest: x.status, channel: 'closed', invoice: 'open' });
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [x.r.id])).toBe(0);
      expect(await obligationsOf(x.r.id)).toEqual(obligations);
    };

    it('before settleBy, with no obligation (LS-9): one purchase evidenced by the late success, the invoice paid at Payment\'s instant, the request settled; Payment, its request and the channel stay final', async () => {
      const x = await ready();
      const secret = receipt(x.row, x.r);
      const idem = key();
      const res = await apply(x.row.id, secret, 'owner-tok', idem);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const p = await one(`SELECT * FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [x.r.id]);
      expect(p).toMatchObject({ lateSuccessId: x.l.lateSuccessId, receiptId: null, invoiceId: x.s.invoiceId, paymentRequestId: x.s.paymentRequestId, purpose: 'assisted_settlement' });
      expect(new Date(p.settledAt).toISOString(), 'LS-2').toBe(x.l.recordedAt);
      expect(p.appliedAt).not.toBeNull();
      const inv = await one(`SELECT status, "paidAt" FROM invoice WHERE id = $1`, [x.s.invoiceId]);
      expect([inv.status, new Date(inv.paidAt).toISOString()]).toEqual(['paid', x.l.recordedAt]);
      expect(await one(`SELECT a.status AS request, pr.status AS "paymentRequest", c.status AS channel FROM assistance_request a
        JOIN assistance_settlement_channel c ON c."assistanceRequestId" = a.id JOIN payment_request pr ON pr.id = c."paymentRequestId" WHERE a.id = $1`, [x.r.id]))
        .toEqual({ request: 'settled', paymentRequest: 'expired', channel: 'closed' });
      expect(await obligationsOf(x.r.id), 'none needed, none opened later').toEqual([]);
      await sweep();
      expect(await obligationsOf(x.r.id)).toEqual([]);
      expect((await entitlement(U.b1, x.r.productId).expect(200)).body.valid, 'through the established purchase ledger').toBe(true);
      expect(await count(`SELECT count(*) AS n FROM billing_transition WHERE "entityId" = $1 AND "fromStatus" = 'open' AND "toStatus" = 'paid'`, [x.s.invoiceId])).toBe(1);
      expect(await auditNames(x.row.id)).toContain('audit.assistance_late_settlement.applied');
      // the replay answers the stored application without spending the receipt again; another application is refused
      const consumeRef = fraudAuth.issued.get(secret)!.consumeRef;
      const replay = await apply(x.row.id, secret, 'owner-tok', idem);
      expect(replay.status).toBe(201);
      expect(fraudAuth.issued.get(secret)!.consumeRef).toBe(consumeRef);
      expect(refusal(await apply(x.row.id, receipt(x.row, x.r)))).toEqual([409, 'late_settlement_refused', 'already_applied']);
      await reconcile();
      expect(await caseOf('late_assisted_settlement', x.row.id)).toMatchObject({ resolution: 'late_settlement_applied' });
      // EVT-10 redelivered, replayed and read again after the application: nothing more
      await t.bus.deliver(x.l.envelope, 'verified_duplicate');
      await t.bus.deliver(x.l.envelope, 'verified_replay');
      paymentItems.items.set('late_success', [asItem({ id: x.l.lateSuccessId, paymentId: x.s.paymentId, factId: x.l.factId, amount: Number(x.s.inv.total), currency: 'TND',
        detail: { paymentStatus: 'expired' }, at: x.l.recordedAt })]);
      await reconcile();
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [x.r.id])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM assistance_late_settlement WHERE "invoiceId" = $1`, [x.s.invoiceId])).toBe(1);
      expect((await casesOfPayment(x.s.paymentId)).length).toBe(1);
    });

    it('after settleBy (a labelled clock shift once the channel is closed, never an inserted obligation): the real sweep opens the deadline obligation; the application supersedes it; T1/T2 end for that request', async () => {
      const x = await ready();
      // LABELLED CLOCK SHIFT (S0-C8 item 11): all of the request's times move back together, exactly what 73 hours of waiting produce
      await backdate(x.r.id, `UPDATE assistance_request SET "consentAt" = "consentAt" - interval '73 hours', "cashCollectedAt" = "cashCollectedAt" - interval '73 hours',
        "reportedAt" = "reportedAt" - interval '73 hours', "settleBy" = "settleBy" - interval '73 hours' WHERE id = $1`);
      await sweep();
      const [o] = await obligationsOf(x.r.id);
      expect(o, 'the REAL sweep opened it').toMatchObject({ origin: 'deadline', status: 'open' });
      expect((await restrictions()).map((v) => v.kind as string), 'T2: the overdue cash return restricts the Organization').toEqual(expect.arrayContaining(['T2']));
      const res = await apply(x.row.id, receipt(x.row, x.r));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(await obligationsOf(x.r.id)).toEqual([expect.objectContaining({ id: o!.id, status: 'superseded_by_settlement', supersededByApplicationId: res.body.application.id })]);
      expect(await restrictions(), 'T1 and T2 end for that request only').toEqual([]);
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "lateSuccessId" = $1`, [x.l.lateSuccessId])).toBe(1);
      expect(await one(`SELECT status FROM payment_request WHERE id = $1`, [x.s.paymentRequestId])).toEqual({ status: 'expired' });
    });

    it('simultaneous applications, with one receipt or several: exactly one purchase; every other is refused; the invoice is paid once', async () => {
      const x = await ready();
      const secret = receipt(x.row, x.r);
      const all = await Promise.all([...Array.from({ length: 4 }, () => apply(x.row.id, secret)), ...Array.from({ length: 3 }, () => apply(x.row.id, receipt(x.row, x.r)))]);
      expect(all.filter((v) => v.status === 201)).toHaveLength(1);
      for (const v of all.filter((w) => w.status !== 201)) expect([409, 503], JSON.stringify(v.body)).toContain(v.status);
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [x.r.id])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM late_settlement_application WHERE "lateSettlementId" = $1`, [x.row.id])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM billing_transition WHERE "entityId" = $1 AND "toStatus" = 'paid'`, [x.s.invoiceId])).toBe(1);
    });

    it('an application racing the capture\'s refund: never both a purchase and a refund of the unsold capture', async () => {
      for (let i = 0; i < 3; i++) {
        const x = await ready();
        const [a, c] = await Promise.all([apply(x.row.id, receipt(x.row, x.r)),
          send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: x.s.paymentId, reason: 'late_settlement_unapplied' })]);
        const purchased = await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [x.r.id]);
        const lateRefund = await count(`SELECT count(*) AS n FROM refund_case WHERE "paymentId" = $1 AND eligibility = 'late_assisted_settlement'`, [x.s.paymentId]);
        expect(purchased + lateRefund, `${a.status} ${c.status} ${JSON.stringify(c.body)}`).toBe(1);
        if (lateRefund === 1) expect(refusal(a)).toEqual([409, 'late_settlement_refused', 'refund_exists']);
        // a refund opened after the application is the purchase's own (Personal purchase of that capture, S6d), never the unsold capture's
        if (purchased === 1 && c.status === 201) expect(c.body.eligibility).toBe('personal_purchase');
      }
    });

    it('LS-7 (an Owner-approved policy addition): a verified chargeback of the payment refuses L-4 before the receipt is spent; the database agrees', async () => {
      const x = await ready();
      const id = randomUUID();
      await t.bus.deliver({ id, name: 'payment.dispute.lost', payload: {
        disputeId: randomUUID(), paymentId: x.s.paymentId, paymentRequestId: x.s.paymentRequestId, producer: 'billing-service', organizationId: ORG, purpose: 'assisted_settlement',
        amount: Number(x.s.inv.total), currency: 'TND', lostAt: new Date().toISOString(), chargeback: { factId: randomUUID(), amount: Number(x.s.inv.total), currency: 'TND' }, liveMode: false,
      }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } } as EventEnvelope);
      expect(await count(`SELECT count(*) AS n FROM payment_dispute_loss WHERE "paymentRequestId" = $1`, [x.s.paymentRequestId])).toBe(1);
      const secret = receipt(x.row, x.r);
      expect(refusal(await apply(x.row.id, secret))).toEqual([409, 'late_settlement_refused', 'chargeback_recorded']);
      expect(fraudAuth.issued.get(secret)!.consumeRef, 'not spent').toBeUndefined();
      await unchanged(x);
      const e = await admin.query(`INSERT INTO late_settlement_application ("lateSettlementId", "assistanceRequestId", "companyId", "platformId", "organizationId", "beneficiaryUserId",
          "reasonCode", "attestationId", "appliedByUserId", "receiptId", "settledAt")
        SELECT l.id, l."assistanceRequestId", $2, a."platformId", a."organizationId", a."beneficiaryUserId", 'cash_not_returned_attested', t.id, $3, $4, l."settledAt"
          FROM assistance_late_settlement l JOIN assistance_request a ON a.id = l."assistanceRequestId" JOIN late_settlement_attestation t ON t."lateSettlementId" = l.id WHERE l.id = $1`,
        [x.row.id, COMPANY, U.owner, randomUUID()]).then(() => null, (v: { constraint?: string }) => v);
      expect(e?.constraint).toBe('late_settlement_chargeback_recorded');
    });

    it('Owner authority and receipts: another Company\'s Owner, an operator, a member; a receipt of another Owner, reason or late settlement; Auth unresolved writes nothing and is repeated', async () => {
      const x = await ready();
      expect((await apply(x.row.id, receipt(x.row, x.r), 'foreign-owner-tok')).status).toBe(404);
      expect((await apply(x.row.id, receipt(x.row, x.r), 'operator-tok')).status).toBe(403);
      expect((await apply(x.row.id, receipt(x.row, x.r), 'member-tok')).status).toBe(403);
      expect((await apply(x.row.id, receipt(x.row, x.r), 'b1')).status).toBe(401);
      expect((await apply(x.row.id, receipt(x.row, x.r, { issuer: randomUUID() }))).body.code).toBe('late_settlement_authorization_refused');
      expect((await apply(x.row.id, receipt(x.row, x.r, { binding: { reasonCode: 'cash_not_returned_evidenced' } }))).body.code).toBe('late_settlement_authorization_refused');
      expect((await apply(x.row.id, receipt(x.row, x.r, { binding: { lateSettlementId: randomUUID() } }))).body.code).toBe('late_settlement_authorization_refused');
      fraudAuth.down = true;
      const secret = receipt(x.row, x.r);
      const idem = key();
      expect((await apply(x.row.id, secret, 'owner-tok', idem)).body.code).toBe('late_settlement_authorization_unresolved');
      await unchanged(x);
      fraudAuth.down = false;
      expect((await apply(x.row.id, secret, 'owner-tok', idem)).status).toBe(201);
    });

    it('evidence: no purchase without its application, from another invoice\'s late success, or twice from one late success; the evidence is immutable; the invoice is never paid otherwise; a reused capture fact is one record', async () => {
      const x = await ready();
      const y = await ready();
      const failsWith = async (sql: string, params: unknown[], constraint: string | RegExp) => {
        const e = await admin.query(sql, params).then(() => null, (v: { constraint?: string; message?: string }) => v);
        if (typeof constraint === 'string') expect(e?.constraint, sql).toBe(constraint);
        else expect(e?.message, sql).toMatch(constraint);
      };
      // the invoice becomes paid only through a paid request or this application (BI-14 as extended)
      await failsWith(`UPDATE invoice SET status = 'paid', "paidAt" = $2 WHERE id = $1`, [x.s.invoiceId, x.l.recordedAt], /can become paid only/);
      const purchase = (lateSuccessId: string, invoiceId: string, prId: string) => admin.query(
        `INSERT INTO personal_subscription ("userId", "platformId", "productId") VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [U.b1, PLATFORM, x.r.productId])
        .then(() => admin.query(`INSERT INTO subscription_purchase ("personalSubscriptionId", "invoiceId", purpose, "beneficiaryUserId", "productId", "priceId", "paymentRequestId",
            "lateSuccessId", "settledAt", "originalStart", "originalEnd", "transactionId", "assistanceRequestId", "appliedAt")
          SELECT ps.id, $2, 'assisted_settlement', $3, $4, $5, $6, $1, s."recordedAt", now(), now() + interval '1 second', pg_current_xact_id(), $7, now()
            FROM personal_subscription ps, payment_late_success s WHERE ps."userId" = $3 AND ps."productId" = $4 AND s."lateSuccessId" = $1`,
          [lateSuccessId, invoiceId, U.b1, x.r.productId, x.r.priceId, prId, x.r.id]));
      await purchase(x.l.lateSuccessId, x.s.invoiceId, x.s.paymentRequestId).then(() => expect.fail('purchase without application'), (e: { constraint?: string }) =>
        expect(['subscription_purchase_verified', 'subscription_purchase_assisted_applicable']).toContain(e.constraint));
      await purchase(y.l.lateSuccessId, x.s.invoiceId, x.s.paymentRequestId).then(() => expect.fail('another invoice\'s late success'), (e: { constraint?: string }) =>
        expect(['subscription_purchase_verified', 'subscription_purchase_assisted_applicable']).toContain(e.constraint));
      // the real application, then a second purchase from the same late success (DB-12, unique evidence)
      expect((await apply(x.row.id, receipt(x.row, x.r))).status).toBe(201);
      await purchase(x.l.lateSuccessId, x.s.invoiceId, x.s.paymentRequestId).then(() => expect.fail('second purchase'), (e: { constraint?: string }) =>
        expect(e.constraint).toMatch(/subscription_purchase|lateSuccessId_key|invoiceId/));
      await failsWith(`UPDATE subscription_purchase SET "receiptId" = $2 WHERE "lateSuccessId" = $1`, [x.l.lateSuccessId, randomUUID()], /immutable|refused|cannot/);
      // a different late success naming the SAME capture fact is the same captured movement: never a second record or effect
      const reused = lateEnvelope(y.s, { factId: y.l.factId });
      await t.bus.deliver(reused.envelope);
      expect(await count(`SELECT count(*) AS n FROM payment_late_success WHERE "factId" = $1`, [y.l.factId])).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM payment_late_success WHERE "lateSuccessId" = $1`, [reused.lateSuccessId])).toBe(0);
    });

    it('fraud and entitlement rules: the applied purchase is in the ledger like any other (a fraud hold suspends it); its refund is a Personal purchase of that capture (S6d: one reversal, a new obligation)', async () => {
      const x = await ready();
      expect((await apply(x.row.id, receipt(x.row, x.r))).status).toBe(201);
      expect((await entitlement(U.b1, x.r.productId).expect(200)).body.valid).toBe(true);
      // a fraud hold (S6e-H) on the beneficiary's product suspends the entitlement; nothing special for an L-4 purchase
      const holdId = randomUUID();
      const g: GrantedFraudEvidence = { grantId: randomUUID(), fileId: randomUUID(), purpose: 'fraud_evidence', caseRef: holdId, companyId: COMPANY, subjectUserId: U.b1 };
      fraudFiles.grants.set(g.grantId, g);
      const h = { holdId, beneficiaryUserId: U.b1, productId: x.r.productId, reason: 'account_takeover' };
      const holdSecret = randomBytes(32).toString('base64url');
      fraudAuth.issued.set(holdSecret, { id: randomUUID(), issuer: U.owner, binding: { operation: 'fraud_hold_place', audience: 'billing-service', companyId: COMPANY, ...h } });
      const placed = await send(request(server()).post('/billing/admin/fraud-holds'), 'owner-tok', null).send({ ...h, evidence: [{ grantId: g.grantId, fileId: g.fileId }], receiptSecret: holdSecret });
      expect(placed.status, JSON.stringify(placed.body)).toBe(201);
      expect((await entitlement(U.b1, x.r.productId).expect(200)).body.valid).toBe(false);
      // its refund: a personal_purchase case naming the capture; completion reverses it once and opens a refund_completion obligation
      const c = await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: x.s.paymentId, reason: 'customer_request' });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      expect(await one(`SELECT eligibility, "captureFactId", "captureBasis", "receiptId" FROM refund_case WHERE id = $1`, [c.body.id]))
        .toEqual({ eligibility: 'personal_purchase', captureFactId: x.l.factId, captureBasis: 'late_capture', receiptId: null });
      await send(request(server()).post(`/billing/admin/refund-cases/${c.body.id}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') }).expect(201);
      expect(relayed.at(-1)).toMatchObject({ captureFactId: x.l.factId });
      const att = await one(`SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [c.body.id]);
      const ev = randomUUID();
      await t.bus.deliver({ id: ev, name: 'refund.case_completed', payload: { refundCaseId: c.body.id, refundAuthorizationId: randomUUID(), refundAttemptId: att.id, paymentId: x.s.paymentId,
        paymentRequestId: x.s.paymentRequestId, producer: 'billing-service', approvedAmount: Number(x.s.inv.total), currency: 'TND', completedAt: new Date().toISOString(), liveMode: false,
        organizationId: ORG, purpose: 'assisted_settlement' }, headers: { eventId: ev, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
      await t.app.get(RefundEffectService).drainOnce();
      expect(await one(`SELECT outcome FROM refund_case_effect WHERE "refundCaseId" = $1`, [c.body.id])).toEqual({ outcome: 'reversed_purchase_and_obligation_opened' });
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase_reversal v JOIN subscription_purchase p ON p.id = v."purchaseId" WHERE p."lateSuccessId" = $1`, [x.l.lateSuccessId])).toBe(1);
      expect((await obligationsOf(x.r.id)).map((o) => [o.origin, o.status])).toEqual([['refund_completion', 'open']]);
    });

    describe('S0-C11 capture evidence before the receipt (item 7; BIL-32 I)', () => {
      const capture = (o: Partial<{ amount: number; currency: string; conflicted: boolean; factId: string; paymentId: string; attemptCaptures: number }> = {}) =>
        async (paymentId: string, factId: string): Promise<CaptureReadOutcome> => ({ kind: 'capture', capture: { factId: o.factId ?? factId, paymentId: o.paymentId ?? paymentId,
          amount: o.amount ?? 5300, currency: o.currency ?? 'TND', basis: 'late_capture', paymentStatus: 'expired', conflicted: o.conflicted ?? false,
          refundableOnItsOwn: true, attemptCaptures: o.attemptCaptures ?? 1, refund: 'none' } });

      it('reads exactly the late success\'s capture, after the exposure read; contested refuses 409 capture_contested; nothing is spent or written', async () => {
        const x = await ready();
        captureAt.answer = capture({ conflicted: true });
        const secret = receipt(x.row, x.r);
        expect(refusal(await apply(x.row.id, secret))).toEqual([409, 'late_settlement_refused', 'capture_contested']);
        expect(captureAt.calls).toEqual([[x.s.paymentId, x.l.factId]]);
        expect(fraudAuth.issued.get(secret)!.consumeRef, 'the receipt is not spent').toBeUndefined();
        await unchanged(x);
        // an exposure refusal comes first: the capture is not even read
        captureAt.calls.length = 0;
        disputes.open.add(x.s.paymentId);
        expect(refusal(await apply(x.row.id, secret))[2]).toBe('payment_dispute_open');
        expect(captureAt.calls).toEqual([]);
      });

      it('S0-C12 item 14(c), input (b): an ambiguous attempt refuses 409 capture_unverified after the existing refusals, no receipt spent, nothing written; inconsistent or absent evidence is 503; a single capture then applies', async () => {
        const x = await ready();
        const secret = receipt(x.row, x.r);
        for (const [label, answer, expected] of [
          ['two capture facts', capture({ attemptCaptures: 2 }), [409, 'late_settlement_refused', 'capture_unverified']],
          ['three, the amount equal', capture({ attemptCaptures: 3, amount: 5300 }), [409, 'late_settlement_refused', 'capture_unverified']],
          ['contested stays first', capture({ attemptCaptures: 2, conflicted: true }), [409, 'late_settlement_refused', 'capture_contested']],
          ['a non-ISO answer about an ISO late success is inconsistent', async (): Promise<CaptureReadOutcome> => ({ kind: 'ineligible_currency' }), [503, 'late_settlement_capture_unavailable', undefined]],
          ['an inconsistent count', async (): Promise<CaptureReadOutcome> => ({ kind: 'unknown', reason: 'inconsistent_capture_count' }), [503, 'late_settlement_capture_unavailable', undefined]],
          ['Payment unavailable', async (): Promise<CaptureReadOutcome> => { throw new Error('payment-service unavailable'); }, [503, 'late_settlement_capture_unavailable', undefined]],
        ] as const) {
          captureAt.answer = answer;
          expect(refusal(await apply(x.row.id, secret)), label).toEqual(expected);
          expect(fraudAuth.issued.get(secret)!.consumeRef, `${label}: the receipt is not spent`).toBeUndefined();
          await unchanged(x);
        }
        // S0-C9 item 4's exposure refusal stays first: the capture is not even read
        captureAt.answer = capture({ attemptCaptures: 2 });
        captureAt.calls.length = 0;
        disputes.open.add(x.s.paymentId);
        expect(refusal(await apply(x.row.id, secret))[2]).toBe('payment_dispute_open');
        expect(captureAt.calls).toEqual([]);
        disputes.open.delete(x.s.paymentId);
        // another Company's Owner reaches nothing: no read of Payment, no refusal that says anything about the capture
        const foreign = await apply(x.row.id, secret, 'foreign-owner-tok');
        expect(foreign.status).toBe(404);
        expect(captureAt.calls).toEqual([]);
        captureAt.answer = null;
        expect((await apply(x.row.id, secret)).status).toBe(201);
      });

      it('S0-C12 item 14(a), input (b): a committed application stands: a sibling arriving later changes nothing, and its replay answers the stored result without reading Payment or spending again', async () => {
        const x = await ready();
        const secret = receipt(x.row, x.r);
        const idem = key();
        const first = await apply(x.row.id, secret, 'owner-tok', idem);
        expect(first.status).toBe(201);
        const consumeRef = fraudAuth.issued.get(secret)!.consumeRef;
        captureAt.answer = capture({ attemptCaptures: 2 });
        captureAt.calls.length = 0;
        const replay = await apply(x.row.id, secret, 'owner-tok', idem);
        expect(replay.status).toBe(201);
        expect(replay.body.application.id).toBe(first.body.application.id);
        expect(captureAt.calls, 'a replay reads nothing').toEqual([]);
        expect(fraudAuth.issued.get(secret)!.consumeRef).toBe(consumeRef);
        expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [x.r.id])).toBe(1);
        expect(await count(`SELECT count(*) AS n FROM late_settlement_application WHERE "lateSettlementId" = $1`, [x.row.id])).toBe(1);
      });

      it('provenance (BIL-32 J): the application records the late success\'s own capture fact, once and immutably; the database refuses any other or none', async () => {
        const x = await ready();
        const res = await apply(x.row.id, receipt(x.row, x.r));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        expect(res.body.application.captureFactId).toBe(x.l.factId);
        expect(await one(`SELECT "captureFactId" FROM late_settlement_application WHERE "lateSettlementId" = $1`, [x.row.id])).toEqual({ captureFactId: x.l.factId });
        await expect(admin.query(`UPDATE late_settlement_application SET "captureFactId" = $2 WHERE "lateSettlementId" = $1`, [x.row.id, randomUUID()])).rejects.toThrow();
        // the database, for a second eligible late settlement: no capture, or a capture other than its late success's, is refused before anything else commits
        const y = await ready();
        const insert = (captureFactId: string | null) => admin.query(`INSERT INTO late_settlement_application ("lateSettlementId", "assistanceRequestId", "companyId", "platformId",
            "organizationId", "beneficiaryUserId", "reasonCode", "attestationId", "appliedByUserId", "receiptId", "settledAt", "captureFactId")
          SELECT l.id, l."assistanceRequestId", $2, a."platformId", a."organizationId", a."beneficiaryUserId", 'cash_not_returned_attested',
                 (SELECT t.id FROM late_settlement_attestation t WHERE t."lateSettlementId" = l.id), $3, gen_random_uuid(), billing_late_settlement_settled_at(l.id), $4
            FROM assistance_late_settlement l JOIN assistance_request a ON a.id = l."assistanceRequestId" WHERE l.id = $1`,
          [y.row.id, COMPANY, U.owner, captureFactId]).then(() => null, (e: { constraint?: string }) => e.constraint);
        expect(await insert(null)).toBe('late_settlement_application_capture_required');
        expect(await insert(randomUUID())).toBe('late_settlement_application_capture_mismatch');
        expect(await insert(x.l.factId), 'another late settlement\'s capture').toBe('late_settlement_application_capture_mismatch');
        await unchanged(y);
      });

      it('missing or unequal evidence refuses 409 capture_unverified: no such capture, another amount, another currency, an invoice the late success does not equal', async () => {
        for (const answer of [async (): Promise<CaptureReadOutcome> => ({ kind: 'not_found' }), capture({ amount: 5301 }), capture({ currency: 'EUR' })]) {
          const x = await ready();
          captureAt.answer = answer;
          const secret = receipt(x.row, x.r);
          expect(refusal(await apply(x.row.id, secret))).toEqual([409, 'late_settlement_refused', 'capture_unverified']);
          expect(fraudAuth.issued.get(secret)!.consumeRef).toBeUndefined();
          await unchanged(x);
        }
      });

      it('Payment unanswerable, or an answer proving nothing, is 503 late_settlement_capture_unavailable; nothing is spent or written; it applies once Payment answers', async () => {
        const x = await ready();
        const secret = receipt(x.row, x.r);
        for (const answer of [
          async (): Promise<CaptureReadOutcome> => { throw new Error('payment-service unavailable'); },
          async (): Promise<CaptureReadOutcome> => ({ kind: 'unknown', reason: 'status_500' }),
          capture({ factId: randomUUID() }), // an answer about another capture
          capture({ paymentId: randomUUID() }),
        ]) {
          captureAt.answer = answer;
          expect(refusal(await apply(x.row.id, secret))).toEqual([503, 'late_settlement_capture_unavailable', undefined]);
          expect(fraudAuth.issued.get(secret)!.consumeRef).toBeUndefined();
          await unchanged(x);
        }
        captureAt.answer = null;
        expect((await apply(x.row.id, secret)).status).toBe(201);
      });

      it('a contradiction recorded after the read (not a lock, item 7a): the application commits; the purchase stands; the contradiction becomes one visible case recording the L-4 purchase (7b)', async () => {
        const x = await ready();
        const conflictItem = asItem({ kind: 'fact_conflict', id: randomUUID(), paymentId: x.s.paymentId, factId: x.l.factId, amount: 5301, currency: 'TND', detail: { source: 'webhook' } });
        // the client double answers "uncontested" (the state when it read) and, in the same moment, Payment records the contradiction
        captureAt.answer = async (paymentId, factId) => {
          paymentItems.items.set('fact_conflict', [conflictItem]);
          return capture()(paymentId, factId);
        };
        const res = await apply(x.row.id, receipt(x.row, x.r));
        expect(res.status, JSON.stringify(res.body)).toBe(201);
        captureAt.answer = capture({ conflicted: true }); // Payment's state from now on
        await reconcile();
        const caseKey = captureContradictionKey(x.l.factId!, x.s.paymentId);
        expect(await caseOf('capture_contradiction', caseKey)).toMatchObject({ paymentId: x.s.paymentId, captureFactId: x.l.factId, amount: '5300', detail: 'own_capture_contested', resolution: null });
        const listed = (await send(request(server()).get('/billing/admin/reconciliation-cases?type=capture_contradiction'), 'owner-tok', null).expect(200)).body.items as Row[];
        expect(listed.find((c) => c.evidenceId === caseKey)).toMatchObject({ l4Purchase: true, reviewOnly: false, status: 'open', captureFactId: x.l.factId });
        // FC-4: nothing reversed; the purchase and the entitlement stand
        expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "lateSuccessId" = $1`, [x.l.lateSuccessId])).toBe(1);
        expect(await count(`SELECT count(*) AS n FROM subscription_purchase_reversal r JOIN subscription_purchase p ON p.id = r."purchaseId" WHERE p."lateSuccessId" = $1`, [x.l.lateSuccessId])).toBe(0);
        expect((await entitlement(U.b1, x.r.productId).expect(200)).body.valid).toBe(true);
      });

      it('a contradiction after an already committed L-4 purchase: the same visible case; no refund of that capture is opened', async () => {
        const x = await ready();
        expect((await apply(x.row.id, receipt(x.row, x.r))).status).toBe(201);
        captureAt.answer = capture({ conflicted: true });
        paymentItems.items.set('fact_conflict', [asItem({ kind: 'fact_conflict', id: randomUUID(), paymentId: x.s.paymentId, factId: x.l.factId, amount: 4500, currency: 'TND', detail: {} })]);
        await reconcile();
        expect(await caseOf('capture_contradiction', captureContradictionKey(x.l.factId!, x.s.paymentId))).toMatchObject({ captureFactId: x.l.factId, resolution: null });
        const refundTry = await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: x.s.paymentId, captureFactId: x.l.factId, reason: 'customer_request' });
        expect(refundTry.status, JSON.stringify(refundTry.body)).toBeGreaterThanOrEqual(400);
        expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "paymentId" = $1`, [x.s.paymentId])).toBe(0);
        expect(relayed).toEqual([]);
      });
    });

    /**
     * Core V2 S0-C11 BIL-32 M, through Billing's PRODUCTION client (`HttpPaymentRefundClient.capture`) over real HTTP, against a local server
     * answering exactly as Payment's R6H-5 capture read does (`paymentError` / `notFound` bodies). L-4 input (b) only: `capture_not_found` stays
     * `409 capture_unverified`; the collapsed `not_found` and any other answer that proves nothing are `503`; the receipt is never spent. The
     * capture-specific refund case and the item 8 contradiction cases keep their own meaning of `not_found`, unchanged.
     */
    describe('BIL-32 M: input (b) failure semantics through Billing\'s real client', () => {
      let stub: Server;
      let base = '';
      const hits: string[] = [];
      let reply: (paymentId: string, factId: string) => { status: number; body?: unknown } = () => ({ status: 500, body: { code: 'unset' } });
      beforeAll(async () => {
        stub = createServer((req, res) => {
          hits.push(req.url ?? '');
          const m = /^\/payment\/payments\/([^/]+)\/captures\/([^/]+)$/.exec(req.url ?? '');
          const a = m ? reply(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!)) : { status: 404, body: { statusCode: 404, message: 'Cannot GET', error: 'Not Found' } };
          res.writeHead(a.status, { 'content-type': 'application/json' });
          res.end(a.body === undefined ? 'not json' : JSON.stringify(a.body));
        });
        await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
        base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
      });
      afterAll(() => new Promise<void>((r) => stub.close(() => r())));
      beforeEach(() => {
        hits.length = 0;
        const client = new HttpPaymentRefundClient({ baseUrl: base, serviceToken: 'billing-to-payment-token', timeoutMs: 2000 });
        captureAt.answer = (paymentId, factId) => client.capture(paymentId, factId);
      });
      const captureNotFound = { status: 404, body: { message: 'No verified capture of this payment has this identifier.', code: 'capture_not_found' } };
      const collapsed = { status: 404, body: { message: 'Not found.', code: 'not_found' } };
      const conflictOf = (paymentId: string, factId: string, o: Partial<PaymentItem> = {}) =>
        asItem({ kind: 'fact_conflict', id: randomUUID(), paymentId, factId, amount: 4500, currency: 'TND', detail: { source: 'webhook' }, ...o });
      const contradictionCases = (paymentId: string) => admin.query(`SELECT * FROM reconciliation_case WHERE "caseType" = 'capture_contradiction' AND "paymentId" = $1`, [paymentId])
        .then((r) => r.rows as Row[]);
      const verified = (paymentId: string, factId: string) => ({ status: 200, body: { factId, paymentId, provider: 'simulation', amount: 5300, currency: 'TND',
        paymentStatus: 'expired', basis: 'late_capture', conflicted: false, refund: 'none', refundableOnItsOwn: true, attemptCaptures: 1, observedAt: new Date().toISOString() } });

      it('404 capture_not_found stays 409 capture_unverified; the receipt is unspent and nothing changes', async () => {
        const x = await ready();
        reply = () => captureNotFound;
        const secret = receipt(x.row, x.r);
        expect(refusal(await apply(x.row.id, secret))).toEqual([409, 'late_settlement_refused', 'capture_unverified']);
        expect(hits).toEqual([`/payment/payments/${x.s.paymentId}/captures/${x.l.factId}`]);
        expect(fraudAuth.issued.get(secret)!.consumeRef, 'the receipt is not spent').toBeUndefined();
        await unchanged(x);
      });

      it('the collapsed 404 not_found is 503 late_settlement_capture_unavailable, never ordinary missing evidence; the receipt is unspent and nothing changes', async () => {
        const x = await ready();
        reply = () => collapsed;
        const secret = receipt(x.row, x.r);
        const r = await apply(x.row.id, secret);
        expect(refusal(r)).toEqual([503, 'late_settlement_capture_unavailable', undefined]);
        expect(refusal(r)).not.toEqual([409, 'late_settlement_refused', 'capture_unverified']);
        expect(fraudAuth.issued.get(secret)!.consumeRef).toBeUndefined();
        await unchanged(x);
      });

      it('403, another 404, 5xx and a malformed or foreign 200 are 503; retried with the SAME receipt and key, the application commits once and records the late success\'s fact', async () => {
        const x = await ready();
        const secret = receipt(x.row, x.r);
        const idem = key();
        for (const a of [{ status: 403, body: { message: 'You may not perform this operation.', code: 'operation_not_permitted' } },
          { status: 404, body: { statusCode: 404, message: 'Cannot GET', error: 'Not Found' } }, { status: 503, body: { code: 'unavailable' } },
          { ...verified(x.s.paymentId, x.l.factId!), body: { ...verified(x.s.paymentId, x.l.factId!).body, amount: '5300' } }, verified(x.s.paymentId, randomUUID()), collapsed]) {
          reply = () => a;
          expect(refusal(await apply(x.row.id, secret, 'owner-tok', idem)), JSON.stringify(a)).toEqual([503, 'late_settlement_capture_unavailable', undefined]);
          expect(fraudAuth.issued.get(secret)!.consumeRef).toBeUndefined();
          await unchanged(x);
        }
        reply = verified;
        const ok = await apply(x.row.id, secret, 'owner-tok', idem);
        expect(ok.status, JSON.stringify(ok.body)).toBe(201);
        expect(ok.body.application.captureFactId).toBe(x.l.factId);
        const n = hits.length;
        expect((await apply(x.row.id, secret, 'owner-tok', idem)).status, 'the replay answers the stored application').toBe(201);
        expect(hits.length, 'the replay reads nothing').toBe(n);
        expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [x.r.id])).toBe(1);
      });

      it('unchanged consumers: with either 404 the capture-specific refund case is refused not eligible, and an item 8 contradiction is the observing payment\'s case without the fact', async () => {
        for (const answer of [captureNotFound, collapsed]) {
          const e = await ended('payment.expired');
          const elsewhere = randomUUID();
          reply = () => answer;
          const opened = await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: e.s.paymentId, captureFactId: elsewhere, reason: 'customer_request' });
          expect(opened.status, JSON.stringify(opened.body)).toBeGreaterThanOrEqual(400);
          expect(opened.status, 'not eligible, never a 503').not.toBe(503);
          expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "captureFactId" = $1`, [elsewhere])).toBe(0);
          paymentItems.items.set('fact_conflict', [conflictOf(e.s.paymentId, elsewhere, { amount: 4500 })]);
          await reconcile();
          const [c] = await contradictionCases(e.s.paymentId);
          expect(c, JSON.stringify(answer.body)).toMatchObject({ evidenceKey: captureContradictionKey(elsewhere, e.s.paymentId), captureFactId: null, detail: 'contradicts_capture_elsewhere' });
          paymentItems.items.delete('fact_conflict');
        }
      });
    });

    describe('S0-C11 capture_contradiction cases (item 8 with the tenant-isolation clarification; BIL-33 I)', () => {
      const ownConflicted = async (paymentId: string, factId: string): Promise<CaptureReadOutcome> => ({ kind: 'capture', capture: { factId, paymentId, amount: 5300, currency: 'TND',
        basis: 'late_capture', paymentStatus: 'expired', conflicted: true, refundableOnItsOwn: true, attemptCaptures: 1, refund: 'none' } });
      const conflictOf = (paymentId: string, factId: string, o: Partial<PaymentItem> = {}) =>
        asItem({ kind: 'fact_conflict', id: randomUUID(), paymentId, factId, amount: 4500, currency: 'TND', detail: { source: 'webhook' }, ...o });
      const contradictionCases = (paymentId: string) => admin.query(`SELECT * FROM reconciliation_case WHERE "caseType" = 'capture_contradiction' AND "paymentId" = $1`, [paymentId])
        .then((r) => r.rows as Row[]);

      it('one case per contested fact and observing payment, whatever the replays: several observations, redelivered pages, repeated and concurrent passes; one audit record', async () => {
        const e = await ended('payment.expired');
        const l = await late(e.s);
        captureAt.answer = ownConflicted;
        paymentItems.items.set('fact_conflict', [conflictOf(e.s.paymentId, l.factId!), conflictOf(e.s.paymentId, l.factId!, { amount: 4400 }), conflictOf(e.s.paymentId, l.factId!)]);
        await Promise.all([reconcile(), reconcile()]);
        await reconcile();
        const cases = await contradictionCases(e.s.paymentId);
        expect(cases).toHaveLength(1);
        expect(cases[0]).toMatchObject({ evidenceKey: captureContradictionKey(l.factId!, e.s.paymentId), companyId: COMPANY, captureFactId: l.factId, detail: 'own_capture_contested' });
        expect((await audit(cases[0]!.id)).map((v) => v.name)).toEqual(['audit.reconciliation_case.opened']);
      });

      it('S0-C12 item 17: a contradiction of a fact Payment reads as a non-ISO currency opens nothing, as any read that proves nothing; the next pass reads again', async () => {
        const e = await ended('payment.expired');
        const l = await late(e.s);
        captureAt.answer = async () => ({ kind: 'ineligible_currency' });
        paymentItems.items.set('fact_conflict', [conflictOf(e.s.paymentId, l.factId!)]);
        await reconcile();
        expect(await contradictionCases(e.s.paymentId)).toEqual([]);
        captureAt.answer = ownConflicted;
        await reconcile();
        expect(await contradictionCases(e.s.paymentId)).toHaveLength(1);
        paymentItems.items.delete('fact_conflict');
      });

      it('a contradiction of a fact recorded elsewhere: the observing payment\'s own case, its Company from Billing\'s records, never the other fact\'s id, figures or owner; no authority over it', async () => {
        const e = await ended('payment.expired');
        const elsewhere = randomUUID(); // a capture fact of another payment, possibly another Company's: Payment's capture read answers 404 for this payment
        captureAt.answer = async () => ({ kind: 'not_found' });
        paymentItems.items.set('fact_conflict', [conflictOf(e.s.paymentId, elsewhere, { amount: 4500 })]);
        await reconcile();
        const [c] = await contradictionCases(e.s.paymentId);
        const caseKey = captureContradictionKey(elsewhere, e.s.paymentId);
        expect(c).toMatchObject({ evidenceKey: caseKey, companyId: COMPANY, captureFactId: null, amount: '4500', currency: 'TND', detail: 'contradicts_capture_elsewhere' });
        expect(caseKey).not.toBe(elsewhere);
        const mine = (await send(request(server()).get('/billing/admin/reconciliation-cases?type=capture_contradiction'), 'owner-tok', null).expect(200)).body;
        const shown = (mine.items as Row[]).find((v) => v.evidenceId === caseKey);
        expect(shown).toMatchObject({ captureFactId: null, l4Purchase: null, amount: 4500 });
        expect(JSON.stringify(mine)).not.toContain(elsewhere);
        // another Company's Owner sees nothing of it
        const theirs = await send(request(server()).get('/billing/admin/reconciliation-cases?type=capture_contradiction'), 'foreign-owner-tok', null);
        expect(JSON.stringify(theirs.body)).not.toContain(caseKey);
        expect(JSON.stringify(theirs.body)).not.toContain(e.s.paymentId);
        // a capture-specific refund naming that fact is refused for this payment
        expect((await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: e.s.paymentId, captureFactId: elsewhere,
          reason: 'customer_request' })).status).toBeGreaterThanOrEqual(400);
        expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "captureFactId" = $1`, [elsewhere])).toBe(0);
      });

      it('nothing is invented: refund contradictions, a payment Billing does not hold, and an unanswerable Payment open no case (the next pass reads again)', async () => {
        const e = await ended('payment.expired');
        const l = await late(e.s);
        captureAt.answer = ownConflicted;
        paymentItems.items.set('fact_conflict', [conflictOf(e.s.paymentId, l.factId!, { detail: { refundAttemptId: randomUUID() } }), conflictOf(randomUUID(), randomUUID())]);
        await reconcile();
        expect(await contradictionCases(e.s.paymentId)).toEqual([]);
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'capture_contradiction'`, [])).toBeGreaterThanOrEqual(0);
        captureAt.answer = async () => { throw new Error('payment-service unavailable'); };
        paymentItems.items.set('fact_conflict', [conflictOf(e.s.paymentId, l.factId!)]);
        await reconcile();
        expect(await contradictionCases(e.s.paymentId)).toEqual([]);
        captureAt.answer = ownConflicted;
        await reconcile();
        expect(await contradictionCases(e.s.paymentId)).toHaveLength(1);
      });

      it('visibility only: the Owner cannot acknowledge it, the database admits no resolution of it, and it reverses, refunds or sells nothing', async () => {
        const e = await ended('payment.expired');
        const l = await late(e.s);
        captureAt.answer = ownConflicted;
        paymentItems.items.set('fact_conflict', [conflictOf(e.s.paymentId, l.factId!)]);
        await reconcile();
        const [c] = await contradictionCases(e.s.paymentId);
        const ack = await send(request(server()).post(`/billing/admin/reconciliation-cases/${c!.id}/acknowledgement`), 'owner-tok', key()).send({ reason: 'reviewed_no_financial_effect' });
        expect([ack.status, ack.body.code]).toEqual([409, 'reconciliation_case_not_acknowledgeable']);
        for (const kind of ['acknowledged', 'refund_completed', 'late_settlement_applied', 'effect_applied', 'chargeback_returned']) {
          await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, $2, $3, $4)`,
            [c!.id, kind, kind === 'acknowledged' ? U.owner : null, kind === 'acknowledged' ? 'reviewed_no_financial_effect' : null]), kind).rejects.toThrow();
        }
        await expect(admin.query(`UPDATE reconciliation_case SET detail = NULL WHERE id = $1`, [c!.id])).rejects.toThrow();
        expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "paymentRequestId" = $1`, [e.s.paymentRequestId])).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "paymentId" = $1`, [e.s.paymentId])).toBe(0);
      });
    });
  });

  describe('the database (migration 0043): eligibility, one effect per late success, refund shapes', () => {
    it('refuses an ineligible late settlement, a second effect of the same late success, and a capture-specific refund of its capture', async () => {
      const { s } = await ended('payment.expired');
      const l = await late(s);
      const row = await lateSettlementOf(s.invoiceId);
      const failsWith = async (sql: string, params: unknown[], constraint: string) => {
        const e = await admin.query(sql, params).then(() => null, (x: { constraint?: string }) => x);
        expect(e?.constraint, sql).toBe(constraint);
      };
      // one effect per late success: never also a late_success case or a recovery payment
      await failsWith(`INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId") VALUES ('late_success', $1, $2)`, [l.lateSuccessId, COMPANY], 'late_success_one_effect');
      await failsWith(`INSERT INTO recovery_payment ("obligationId", "invoiceId", "paymentRequestId", "lateSuccessId", amount, currency) VALUES ($1, $2, $3, $4, 1, 'TND')`,
        [randomUUID(), s.invoiceId, s.paymentRequestId, l.lateSuccessId], 'late_success_one_effect');
      // a capture-specific refund of the capture that evidences the late settlement
      await failsWith(`INSERT INTO refund_case ("paymentId", "paymentRequestId", "invoiceId", eligibility, "companyId", "platformId", "organizationId", amount, currency, reason,
          "openedBy", "captureFactId", "captureBasis") VALUES ($1, $2, $3, 'capture_specific', $4, $5, $6, $7, 'TND', 'late_settlement_unapplied', $8, $9, 'late_capture')`,
        [s.paymentId, s.paymentRequestId, s.invoiceId, COMPANY, PLATFORM, ORG, Number(s.inv.total), U.owner, l.factId], 'refund_case_not_eligible');
      // no evidence at all (neither an applied receipt nor a late success): refused by the guard before the evidence CHECK
      await failsWith(`INSERT INTO assistance_late_settlement ("assistanceRequestId", "invoiceId", "paymentRequestId", reason, "settledAt") SELECT "assistanceRequestId", $1, "paymentRequestId", 'channel_closed', now() FROM assistance_late_settlement WHERE id = $2`,
        [randomUUID(), row.id], 'assistance_late_settlement_verified');
      // an ineligible late success (another request's open channel) is refused as a late settlement
      const r2 = await collected({ unit: 5300, fee: 300 });
      const open = await started(r2.id);
      const l2 = await late(open); // deferred: recorded, not classified
      await failsWith(`INSERT INTO assistance_late_settlement ("assistanceRequestId", "invoiceId", "paymentRequestId", "lateSuccessId", reason, "settledAt")
          SELECT $1, $2, $3, $4, 'channel_closed', "recordedAt" FROM payment_late_success WHERE "lateSuccessId" = $4`,
        [r2.id, open.invoiceId, open.paymentRequestId, l2.lateSuccessId], 'assistance_late_settlement_late_success');
      // and the late settlement stays append-only
      await expect(admin.query(`UPDATE assistance_late_settlement SET reason = 'purchase_exists' WHERE id = $1`, [row.id])).rejects.toThrow(/append-only/);
    });
  });
});

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
import type { PaymentItem, PaymentItemKind, PaymentReconciliationClient } from '../src/reconciliation/payment-reconciliation-client.js';
import { LateSettlementModule } from '../src/late-settlements/late-settlement.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { FakeAuth } from './support/fake-auth.js';
import { anchorOccurrence } from './support/billing-calendar.js';
import { paymentPurposeOf } from './support/settlement.js';
import { describeWithEnv } from './support/env.js';
import { expectHttpMemberReadMatchesB6 } from './support/member-read.js';

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

/** Payment's refund port, authorizing every relayed attempt; each relayed body is kept (BIL-23 H: the attempt names its capture). */
const relayed: Array<Record<string, unknown>> = [];
const refundsAtPayment: PaymentRefundClient = {
  relay: async (_paymentId, _key, body) => {
    relayed.push(body as unknown as Record<string, unknown>);
    return { kind: 'attempt', attempt: { refundAttemptId: body.refundAttemptId, status: 'authorized', approvedBy: { userId: randomUUID() } } };
  },
  refunds: async () => ({ attempts: [], refusals: [], authorizations: [] }),
  // R6H-5: Payment's evidence of a late capture, refundable on its own (the capture-specific route must still refuse it, S0-C8)
  capture: async (paymentId, factId) => ({ kind: 'capture' as const, capture: { factId, paymentId, amount: 5600, currency: 'TND', basis: 'late_capture' as const, paymentStatus: 'expired',
    conflicted: false, refundableOnItsOwn: true, refund: 'none' as const } }),
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

  describe('PR-2a boundary: no purchase can come from a late success yet (BIL-32 G is PR-2b)', () => {
    it('the beneficiary may attest; the Owner\'s application is refused before the receipt is spent; nothing is sold', async () => {
      const { r, s, status } = await ended('payment.expired');
      await late(s);
      const row = await lateSettlementOf(s.invoiceId);
      expect((await attest(row.id, 'cash_not_returned')).status).toBe(201);
      const secret = randomBytes(32).toString('base64url');
      fraudAuth.issued.set(secret, { id: randomUUID(), issuer: U.owner, binding: { operation: 'late_settlement_apply', audience: 'billing-service', companyId: COMPANY,
        lateSettlementId: row.id, assistanceRequestId: r.id, beneficiaryUserId: U.b1, reasonCode: 'cash_not_returned_attested' } });
      const res = await send(request(server()).post(`/billing/admin/late-settlements/${row.id}/application`), 'owner-tok', key())
        .send({ reasonCode: 'cash_not_returned_attested', receiptSecret: secret });
      expect([res.status, res.body.code, res.body.reason]).toEqual([409, 'late_settlement_refused', 'late_success_application_pending']);
      expect(fraudAuth.issued.get(secret)!.consumeRef, 'the Owner\'s step-up is never consumed').toBeUndefined();
      expect(await count(`SELECT count(*) AS n FROM late_settlement_application WHERE "lateSettlementId" = $1`, [row.id])).toBe(0);
      await nothingSold(r, s, status);
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

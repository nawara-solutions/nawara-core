import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { DisputeExposure, LateSettlementExposureState } from '../src/refunds/dispute-exposure.js';
import { DisputeLossService } from '../src/refunds/dispute-loss.service.js';
import { RecoveryService } from '../src/recovery/recovery.service.js';
import { RefundEffectService } from '../src/refunds/refund-effect.service.js';
import type { PaymentDisputeClient, PaymentDisputeLoss } from '../src/refunds/payment-dispute-client.js';
import type { FraudEvidenceFiles, FraudHoldReceipts, GrantedFraudEvidence } from '../src/fraud-holds/fraud-hold-clients.js';
import type { PaymentRefundClient } from '../src/refunds/payment-refund-client.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import type { PaymentItem, PaymentItemKind, PaymentReconciliationClient } from '../src/reconciliation/payment-reconciliation-client.js';
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

/** Payment's refund port, authorizing every relayed attempt; each relayed body is kept (BIL-23 H: the attempt names its capture). */
const relayed: Array<Record<string, unknown>> = [];
const refundsAtPayment: PaymentRefundClient = {
  relay: async (_paymentId, _key, body) => {
    relayed.push(body as unknown as Record<string, unknown>);
    return { kind: 'attempt', attempt: { refundAttemptId: body.refundAttemptId, status: 'authorized', approvedBy: { userId: randomUUID() } } };
  },
  refunds: async () => ({ attempts: [], refusals: [], authorizations: [] }),
  // R6H-5: Payment's evidence of a late capture, refundable on its own (the capture-specific route must still refuse it, S0-C8)
  // the capture as Payment states it: these fixtures' late captures are of the channel invoice's total (5300; the Organization's fee is not captured)
  capture: async (paymentId, factId) => ({ kind: 'capture' as const, capture: { factId, paymentId, amount: 5300, currency: 'TND', basis: 'late_capture' as const, paymentStatus: 'expired',
    conflicted: false, refundableOnItsOwn: true, attemptCaptures: 1, refund: 'none' as const } }),
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
 * Core V2 S0-C9 Billing (finding F-SINT-2; S0 §1.5 S0-C9 items 2 and 4 to 8; register EVT-03 CB-2, BIL-32 H CB-3, BIL-33 H CB-4; the Owner's
 * CB-1 to CB-6, 2026-11-01), DEVELOPMENT AND SIMULATION ONLY, on real PostgreSQL 16, through Billing's real consumer, workers and routes:
 * a dispute loss binds the captured movement it names. Payment's side (attribution, the new event fields) is NOT implemented yet (Billing
 * first): its verified events are stated here exactly as the approved EVT-03 contract defines them, through the trusted delivery bus.
 */
describeWithEnv('late-capture dispute attribution, Billing consumer (Core V2 S0-C9, simulation) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
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
  /** Core V2 S0-C9 (CB-3): Payment's exposure read for L-4, per payment (default clear), or a scripted state; every read is counted. */
  const exposure = { state: new Map<string, LateSettlementExposureState | 'throw'>(), reads: [] as string[] };
  const lateSettlementExposure = {
    lateSettlement: async (paymentId: string): Promise<LateSettlementExposureState> => {
      exposure.reads.push(paymentId);
      const s = exposure.state.get(paymentId) ?? 'clear';
      if (s === 'throw') throw new Error('payment-service unavailable');
      return s;
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
  const key = () => `s0c9-${++k}-${randomUUID().slice(0, 8)}`;
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
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings0c9');
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
      lateSettlementExposure, // Core V2 S0-C9 (CB-3)
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
    exposure.state.clear();
    exposure.reads.length = 0;
    lossesAtPayment.items = [];
    lossesAtPayment.down = false;
  });
  afterAll(async () => {
    await t?.app.close();
    await auth.stop();
    await admin?.end();
    await db?.drop();
  });

  const attest = (lateId: string, statement: string, bearer = 'b1', idem: string = key()) =>
    send(request(server()).post(`/billing/assistance-late-settlements/${lateId}/attestation`), bearer, idem).send({ statement });

  const restrictions = async (organizationId = ORG) => (await admin.query(`SELECT kind, "sourceId" FROM billing_assistance_restrictions($1, now())`, [organizationId])).rows as Row[];

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


  // ── S0-C9 fixtures
  const losses = () => t.app.get(DisputeLossService);
  const recovery = () => t.app.get(RecoveryService);
  const receipt = (l: { id: string }, r: { id: string }) => {
    const secret = randomBytes(32).toString('base64url');
    fraudAuth.issued.set(secret, { id: randomUUID(), issuer: U.owner, binding: { operation: 'late_settlement_apply', audience: 'billing-service', companyId: COMPANY,
      lateSettlementId: l.id, assistanceRequestId: r.id, beneficiaryUserId: U.b1, reasonCode: 'cash_not_returned_attested' } });
    return secret;
  };
  const apply = (lateId: string, secret: string, bearer = 'owner-tok', idem: string = key()) =>
    send(request(server()).post(`/billing/admin/late-settlements/${lateId}/application`), bearer, idem).send({ reasonCode: 'cash_not_returned_attested', receiptSecret: secret });
  const refusal = (res: request.Response) => [res.status, res.body.code, res.body.reason];
  const openRefund = (body: Record<string, unknown>) => send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send(body);
  /** An eligible late settlement from Payment's late success (an unsold late capture), attested by its beneficiary (Path A). */
  const ready = async () => {
    const e = await ended('payment.expired');
    const l = await late(e.s);
    const row = await lateSettlementOf(e.s.invoiceId);
    await attest(row.id, 'cash_not_returned').expect(201);
    return { ...e, l, row: row as Row & { id: string } };
  };
  /** An assisted request settled by Payment's verified `payment.succeeded`: its purchase is evidenced by the SETTLING capture. */
  const paid = async () => {
    const r = await collected({ unit: 5300, fee: 300 });
    const s = await started(r.id);
    await t.bus.deliver(s.ev('payment.succeeded'));
    const p = await one(`SELECT id, "receiptId", "lateSuccessId" FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [r.id]);
    expect(p.receiptId).not.toBeNull();
    return { r, s, p };
  };
  /** After a refusal or a 503: nothing at all changed (no application, the invoice, request, payment request, channel and obligations). */
  const unchanged = async (x: Awaited<ReturnType<typeof ready>>) => {
    expect(await count(`SELECT count(*) AS n FROM late_settlement_application WHERE "lateSettlementId" = $1`, [x.row.id])).toBe(0);
    await nothingSold(x.r, x.s, x.status);
  };
  /**
   * Payment's `payment.dispute.lost` (EVT-03 version 1) as Payment emits it; `capture` carries S0-C9's additive fields (CB-2) and is ABSENT in
   * a legacy event. The chargeback is the payment's full captured amount unless stated.
   */
  const lostEnvelope = (s: { paymentId: string; paymentRequestId: string; inv: Row }, o: { disputeId?: string; chargeback?: number; chargebackFactId?: string; amount?: number;
    capture?: Record<string, unknown> } = {}) => {
    const id = randomUUID();
    const disputeId = o.disputeId ?? randomUUID();
    const total = Number(s.inv.total);
    const chargebackFactId = o.chargebackFactId ?? randomUUID();
    const envelope: EventEnvelope = { id, name: 'payment.dispute.lost', payload: {
      disputeId, paymentId: s.paymentId, paymentRequestId: s.paymentRequestId, producer: 'billing-service', organizationId: s.inv.organizationId, purpose: 'assisted_settlement',
      amount: o.amount ?? total, currency: 'TND', lostAt: new Date().toISOString(), chargeback: { factId: chargebackFactId, amount: o.chargeback ?? total, currency: 'TND' },
      liveMode: false, ...o.capture,
    }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } };
    return { disputeId, chargebackFactId, envelope };
  };
  const lost = async (...a: Parameters<typeof lostEnvelope>) => {
    const x = lostEnvelope(...a);
    await t.bus.deliver(x.envelope);
    return x;
  };
  const lateCapture = (factId: string | null) => ({ captureFactId: factId, captureBasis: 'late_capture' });
  const lossOf = (disputeId: string) => one(`SELECT "captureBasis", "captureFactId", "chargebackFactId" FROM payment_dispute_loss WHERE "disputeId" = $1`, [disputeId]);
  const effectOf = (disputeId: string) => one(`SELECT outcome, reason, "purchaseId" FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId]);
  const lossCount = (paymentId: string) => count(`SELECT count(*) AS n FROM payment_dispute_loss WHERE "paymentId" = $1`, [paymentId]);
  const resolutionOf = async (type: string, evidence: string) => (await caseOf(type, evidence))?.resolution ?? null;
  const deadLettered = (envelope: EventEnvelope) => t.bus.deadLettered.some((e) => e.id === envelope.id);

  describe('EVT-03 capture fields: legacy compatibility and refusal of malformed statements (CB-2)', () => {
    it('a legacy loss (no capture fields) is the settling capture: an assisted sale keeps its entitlement and S6f opens the base-only recovery, exactly as before', async () => {
      const { r, s, p } = await paid();
      const d = await lost(s);
      expect(await lossOf(d.disputeId)).toMatchObject({ captureBasis: 'settling_capture', captureFactId: null });
      expect(await losses().apply(d.disputeId)).toEqual({ kind: 'applied', outcome: 'none', reason: 'assisted_purchase_preserved' });
      expect(await effectOf(d.disputeId)).toMatchObject({ purchaseId: p.id });
      expect(await recovery().visit(d.disputeId)).toBe('opened');
      expect((await restrictions()).map((v) => v.kind)).toEqual(['T3']);
      expect((await entitlement(U.b1, r.productId).expect(200)).body.valid).toBe(true);
    });

    it('the new statement of a settling capture (both fields) behaves exactly as the legacy one', async () => {
      const { s, p } = await paid();
      const d = await lost(s, { capture: { captureFactId: randomUUID(), captureBasis: 'settling_capture' } });
      expect(await lossOf(d.disputeId)).toMatchObject({ captureBasis: 'settling_capture' });
      expect(await losses().apply(d.disputeId)).toMatchObject({ reason: 'assisted_purchase_preserved' });
      expect(await effectOf(d.disputeId)).toMatchObject({ purchaseId: p.id });
    });

    it('a basis without a fact, a fact without a basis, an unknown basis, a null or malformed fact: binding_mismatch, refused and dead-lettered, nothing recorded', async () => {
      const x = await ready();
      for (const capture of [{ captureBasis: 'late_capture' }, { captureFactId: x.l.factId }, { captureBasis: 'refund_capture', captureFactId: x.l.factId },
        { captureBasis: 'late_capture', captureFactId: null }, { captureBasis: 'late_capture', captureFactId: 'not-a-uuid' }, { captureBasis: null, captureFactId: x.l.factId }]) {
        const d = lostEnvelope(x.s, { capture });
        await t.bus.deliver(d.envelope);
        expect(deadLettered(d.envelope), JSON.stringify(capture)).toBe(true);
      }
      expect(await lossCount(x.s.paymentId)).toBe(0);
      // the same malformed statement through Payment's losses read is refused too, per loss (the rest of the page still records)
      const ok = lostEnvelope(x.s, { capture: lateCapture(x.l.factId) });
      const bad = lostEnvelope(x.s, { capture: { captureBasis: 'late_capture' } });
      lossesAtPayment.items = [ok, bad].map((v) => ({ ...(v.envelope.payload as Record<string, unknown>), paymentRequestId: x.s.paymentRequestId }) as unknown as PaymentDisputeLoss);
      await losses().drainOnce();
      expect(await lossCount(x.s.paymentId)).toBe(1);
      expect(await lossOf(ok.disputeId)).toMatchObject({ captureBasis: 'late_capture', captureFactId: x.l.factId });
      await unchanged(x);
    });
  });

  describe('an UNSOLD late capture charged back (before any L-4): no purchase effect; L-4 refused; chargeback_returned only when full (CB-2, CB-4)', () => {
    it('a FULL chargeback: no purchase effect; L-4 refused chargeback_recorded with the receipt unspent; the case resolves chargeback_returned once, with no refund; the capture is never refunded afterwards', async () => {
      const x = await ready();
      const d = await lost(x.s, { capture: lateCapture(x.l.factId) });
      expect(await lossOf(d.disputeId)).toMatchObject({ captureBasis: 'late_capture', captureFactId: x.l.factId });
      expect(await losses().apply(d.disputeId)).toEqual({ kind: 'applied', outcome: 'none', reason: 'late_capture_unsold' });
      const secret = receipt(x.row, x.r);
      expect(refusal(await apply(x.row.id, secret))).toEqual([409, 'late_settlement_refused', 'chargeback_recorded']);
      expect(fraudAuth.issued.get(secret)!.consumeRef, 'not spent').toBeUndefined();
      await unchanged(x);
      await reconcile();
      await reconcile();
      const c = await caseOf('late_assisted_settlement', x.row.id);
      expect(c.resolution).toBe('chargeback_returned');
      expect(await one(`SELECT "disputeId", "refundCaseId" FROM reconciliation_case_resolution WHERE "caseId" = $1`, [c.id])).toEqual({ disputeId: d.disputeId, refundCaseId: null });
      expect(await count(`SELECT count(*) AS n FROM reconciliation_case_resolution WHERE "caseId" = $1`, [c.id])).toBe(1);
      expect((await audit(c.id)).filter((a) => a.name === 'audit.reconciliation_case.resolved').map((a) => a.payload.changes.resolution)).toEqual(['chargeback_returned']);
      // no refund case, no provider refund, no purchase, no entitlement, no obligation change
      expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "paymentId" = $1`, [x.s.paymentId])).toBe(0);
      expect(relayed).toEqual([]);
      await unchanged(x);
      // the capture is never refunded afterwards: Payment's exposure refuses the route, and so does Billing itself if Payment answered clear
      disputes.open.add(x.s.paymentId);
      expect([(await openRefund({ paymentId: x.s.paymentId, reason: 'late_settlement_unapplied' })).body.code]).toEqual(['refund_dispute_open']);
      disputes.open.clear();
      const again = await openRefund({ paymentId: x.s.paymentId, reason: 'late_settlement_unapplied' });
      expect([again.status, again.body.code]).toEqual([409, 'refund_dispute_open']);
      const e = await admin.query(`INSERT INTO refund_case ("paymentId", "paymentRequestId", "invoiceId", eligibility, "lateSettlementId", "companyId", "platformId", "organizationId",
          amount, currency, reason, "openedBy", "captureFactId", "captureBasis") VALUES ($1, $2, $3, 'late_assisted_settlement', $4, $5, $6, $7, $8, 'TND', 'late_settlement_unapplied', $9, $10, 'late_capture')`,
        [x.s.paymentId, x.s.paymentRequestId, x.s.invoiceId, x.row.id, COMPANY, PLATFORM, ORG, Number(x.s.inv.total), U.owner, x.l.factId]).then(() => null, (v: { constraint?: string }) => v);
      expect(e?.constraint).toBe('refund_case_exposure');
    });

    it('a PARTIAL chargeback never resolves the case: it stays open, a partial_chargeback review case opens, nothing is refunded or sold', async () => {
      const x = await ready();
      const d = await lost(x.s, { chargeback: Number(x.s.inv.total) - 1000, capture: lateCapture(x.l.factId) });
      expect(await losses().apply(d.disputeId)).toMatchObject({ reason: 'late_capture_unsold' });
      await reconcile();
      await reconcile();
      expect(await resolutionOf('late_assisted_settlement', x.row.id)).toBeNull();
      expect(await caseOf('partial_chargeback', d.disputeId)).toMatchObject({ detail: 'partial_chargeback', resolution: null });
      expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "paymentId" = $1`, [x.s.paymentId])).toBe(0);
      expect(refusal(await apply(x.row.id, receipt(x.row, x.r)))).toEqual([409, 'late_settlement_refused', 'chargeback_recorded']);
      await unchanged(x);
    });

    it('a chargeback above the capture, or in another currency, applies nothing: kept for review (contradictory_effect), never chargeback_returned', async () => {
      const x = await ready();
      const d = await lost(x.s, { chargeback: Number(x.s.inv.total) + 1, capture: lateCapture(x.l.factId) });
      expect(await losses().apply(d.disputeId)).toEqual({ kind: 'review', reason: 'chargeback_exceeds_capture' });
      await reconcile();
      expect(await caseOf('contradictory_effect', d.disputeId)).toMatchObject({ detail: 'dispute_effect_review' });
      expect(await resolutionOf('late_assisted_settlement', x.row.id)).toBeNull();
      expect(await effectOf(d.disputeId)).toBeUndefined();
    });

    it('the late_success case of a further capture of the invoice resolves chargeback_returned on its own capture; the first capture\'s case is untouched', async () => {
      const x = await ready();
      const second = await late(x.s); // a second capture of the invoice: refund-only (a late_success case)
      await reconcile();
      expect(await caseOf('late_success', second.lateSuccessId)).toMatchObject({ captureFactId: second.factId, resolution: null });
      const d = await lost(x.s, { capture: lateCapture(second.factId) });
      expect(await losses().apply(d.disputeId)).toMatchObject({ reason: 'late_capture_unsold' });
      await reconcile();
      expect(await resolutionOf('late_success', second.lateSuccessId)).toBe('chargeback_returned');
      expect(await resolutionOf('late_assisted_settlement', x.row.id), 'another captured movement').toBeNull();
    });
  });

  describe('L-4 refused on Payment\'s dispute exposure, before the receipt (CB-3, an Owner-approved policy addition)', () => {
    it('open dispute → payment_dispute_open; chargeback at Payment → chargeback_recorded; unresolved, unavailable or unverifiable → 503; none spends the receipt or writes anything; clear applies', async () => {
      const x = await ready();
      const secret = receipt(x.row, x.r);
      const idem = key();
      const cases: Array<[LateSettlementExposureState | 'throw', unknown[]]> = [
        ['dispute_open', [409, 'late_settlement_refused', 'payment_dispute_open']],
        ['chargeback_recorded', [409, 'late_settlement_refused', 'chargeback_recorded']],
        ['unavailable', [503, 'late_settlement_dispute_unavailable', undefined]],
        ['throw', [503, 'late_settlement_dispute_unavailable', undefined]],
      ];
      for (const [state, expected] of cases) {
        exposure.state.set(x.s.paymentId, state);
        expect(refusal(await apply(x.row.id, secret, 'owner-tok', idem)), state).toEqual(expected);
        expect(fraudAuth.issued.get(secret)!.consumeRef, `${state}: the receipt is not spent`).toBeUndefined();
        await unchanged(x);
      }
      expect(exposure.reads).toEqual(Array(4).fill(x.s.paymentId));
      exposure.state.delete(x.s.paymentId);
      expect((await apply(x.row.id, secret, 'owner-tok', idem)).status).toBe(201);
      expect(fraudAuth.issued.get(secret)!.consumeRef).toBeDefined();
    });

    it('Auth and Payment failures: the exposure is read BEFORE the receipt (Auth is not even asked when Payment refuses); Auth unresolved after a clear read writes nothing and is repeated', async () => {
      const x = await ready();
      const secret = receipt(x.row, x.r);
      fraudAuth.down = true;
      exposure.state.set(x.s.paymentId, 'dispute_open');
      expect(refusal(await apply(x.row.id, secret))).toEqual([409, 'late_settlement_refused', 'payment_dispute_open']);
      exposure.state.delete(x.s.paymentId);
      const idem = key();
      expect((await apply(x.row.id, secret, 'owner-tok', idem)).body.code).toBe('late_settlement_authorization_unresolved');
      await unchanged(x);
      fraudAuth.down = false;
      expect((await apply(x.row.id, secret, 'owner-tok', idem)).status).toBe(201);
    });

    it('an idempotent replay of an applied application answers the stored result without reading Payment again', async () => {
      const x = await ready();
      const secret = receipt(x.row, x.r);
      const idem = key();
      expect((await apply(x.row.id, secret, 'owner-tok', idem)).status).toBe(201);
      const reads = exposure.reads.length;
      exposure.state.set(x.s.paymentId, 'dispute_open');
      expect((await apply(x.row.id, secret, 'owner-tok', idem)).status).toBe(201);
      expect(exposure.reads.length).toBe(reads);
    });
  });

  describe('a late-capture loss AFTER L-4 (a dispute recorded after the read): B10 / FC-4 / S6f for exactly that purchase (S0-C9 items 2, 7)', () => {
    const applied = async () => {
      const x = await ready();
      expect((await apply(x.row.id, receipt(x.row, x.r))).status).toBe(201);
      const p = await one(`SELECT id FROM subscription_purchase WHERE "lateSuccessId" = $1`, [x.l.lateSuccessId]);
      return { ...x, p };
    };

    it('a FULL loss: the L-4 purchase keeps its entitlement (never reversed); one base-only recovery obligation and T3; the case stays late_settlement_applied', async () => {
      const x = await applied();
      const d = await lost(x.s, { capture: lateCapture(x.l.factId) });
      expect(await losses().apply(d.disputeId)).toEqual({ kind: 'applied', outcome: 'none', reason: 'assisted_purchase_preserved' });
      expect(await effectOf(d.disputeId)).toMatchObject({ purchaseId: x.p.id });
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase_reversal WHERE "purchaseId" = $1`, [x.p.id])).toBe(0);
      expect((await entitlement(U.b1, x.r.productId).expect(200)).body.valid).toBe(true);
      expect(await recovery().visit(d.disputeId)).toBe('opened');
      const o = await one(`SELECT o."purchaseId", o.status, o."baseAmount", a."baseAmount" AS "requestBase" FROM recovery_obligation o
        JOIN assistance_request a ON a.id = o."assistanceRequestId" WHERE o."disputeId" = $1`, [d.disputeId]);
      expect(o).toMatchObject({ purchaseId: x.p.id, status: 'open' });
      expect(Number(o.baseAmount), 'D5: the request\'s frozen base only').toBe(Number(o.requestBase));
      expect((await restrictions()).map((v) => v.kind)).toEqual(['T3']);
      expect(await recovery().visit(d.disputeId)).toBe('already');
      await reconcile();
      expect(await resolutionOf('late_assisted_settlement', x.row.id)).toBe('late_settlement_applied');
      expect((await entitlement(U.b1, x.r.productId).expect(200)).body.valid).toBe(true);
    });

    it('Core V2 S0-C10 item 6 (O-2): a loss of the L-4 capture ABOVE it is the recovery worker\'s review (chargeback_exceeds_capture), listed as chargeback_loss_review at its whole amount; no obligation, no T3, no contradictory_effect', async () => {
      const x = await applied();
      const total = Number(x.s.inv.total);
      const d = await lost(x.s, { chargeback: total + 1, capture: lateCapture(x.l.factId) });
      expect(await losses().apply(d.disputeId)).toEqual({ kind: 'applied', outcome: 'none', reason: 'assisted_purchase_preserved' });
      expect(await one(`SELECT "captureKey", gross::int AS gross, "chargebackAmount"::int AS cb, "withinCap" FROM capture_loss_cap WHERE "disputeId" = $1`, [d.disputeId]))
        .toEqual({ captureKey: `late:${x.l.factId}`, gross: total, cb: total + 1, withinCap: false });
      expect(await recovery().visit(d.disputeId)).toBe('review');
      expect(await one(`SELECT reason FROM recovery_review WHERE "disputeId" = $1`, [d.disputeId])).toEqual({ reason: 'chargeback_exceeds_capture' });
      expect(await count(`SELECT count(*) AS n FROM recovery_obligation WHERE "purchaseId" = $1`, [x.p.id])).toBe(0);
      expect(await restrictions()).toEqual([]);
      await reconcile();
      expect(await caseOf('chargeback_loss_review', d.disputeId)).toMatchObject({ amount: String(total + 1), detail: 'chargeback_exceeds_capture', resolution: null });
      expect(await caseOf('contradictory_effect', d.disputeId)).toBeUndefined();
      expect(await resolutionOf('late_assisted_settlement', x.row.id)).toBe('late_settlement_applied');
      expect((await entitlement(U.b1, x.r.productId).expect(200)).body.valid).toBe(true);
    });

    it('Core V2 S0-C10 item 5: a SECOND full loss of the L-4 capture opens no second obligation (repeated_loss)', async () => {
      const x = await applied();
      const d1 = await lost(x.s, { capture: lateCapture(x.l.factId) });
      await losses().apply(d1.disputeId);
      expect(await recovery().visit(d1.disputeId)).toBe('opened');
      const d2 = await lost(x.s, { capture: lateCapture(x.l.factId) });
      expect(await losses().apply(d2.disputeId)).toMatchObject({ reason: 'assisted_purchase_preserved' });
      expect(await recovery().visit(d2.disputeId)).toBe('review');
      expect(await one(`SELECT reason FROM recovery_review WHERE "disputeId" = $1`, [d2.disputeId])).toEqual({ reason: 'repeated_loss' });
      expect(await count(`SELECT count(*) AS n FROM recovery_obligation WHERE "purchaseId" = $1`, [x.p.id])).toBe(1);
      expect((await restrictions()).map((v) => v.kind)).toEqual(['T3']);
    });

    it('Core V2 S0-C10 (O-2): an excess L-4 loss reviewed BEFORE 0049 keeps its contradictory_effect review and case exactly; nothing new is derived from it', async () => {
      const x = await applied();
      const total = Number(x.s.inv.total);
      const d = lostEnvelope(x.s, { chargeback: total + 1, capture: lateCapture(x.l.factId) });
      await t.bus.deliver(d.envelope);
      // LABELLED FIXTURE: the loss as migration 0049 marks a pre-existing one (append-only trigger bypassed), and the review the pre-0049
      // worker recorded for it (an effect-stage chargeback_exceeds_capture, with no cap row)
      const cl = await admin.connect();
      try {
        await cl.query(`SET session_replication_role = replica`);
        await cl.query(`UPDATE payment_dispute_loss SET "beforeS0c10" = true WHERE "disputeId" = $1`, [d.disputeId]);
      } finally {
        await cl.query(`SET session_replication_role = origin`);
        cl.release();
      }
      await admin.query(`INSERT INTO dispute_loss_effect_attempt ("disputeId", state, reason, "workAfter") VALUES ($1, 'review', 'chargeback_exceeds_capture', now())`, [d.disputeId]);
      await reconcile();
      const before = await caseOf('contradictory_effect', d.disputeId);
      expect(before).toMatchObject({ detail: 'dispute_effect_review', resolution: null });
      await losses().drainOnce();
      expect(await losses().apply(d.disputeId)).toEqual({ kind: 'review', reason: 'chargeback_exceeds_capture' });
      expect(await effectOf(d.disputeId)).toBeUndefined();
      expect(await count(`SELECT count(*) AS n FROM capture_loss_cap WHERE "disputeId" = $1`, [d.disputeId])).toBe(0);
      expect(await recovery().visit(d.disputeId)).toBe('already');
      await reconcile();
      expect(await caseOf('contradictory_effect', d.disputeId)).toMatchObject({ id: before.id, resolution: null });
      expect(await caseOf('chargeback_loss_review', d.disputeId)).toBeUndefined();
    });

    it('a PARTIAL loss: the purchase is kept; recovery review (no debt, no T3); a partial_chargeback case', async () => {
      const x = await applied();
      const d = await lost(x.s, { chargeback: Number(x.s.inv.total) - 1000, capture: lateCapture(x.l.factId) });
      expect(await losses().apply(d.disputeId)).toMatchObject({ reason: 'assisted_purchase_preserved' });
      expect(await recovery().visit(d.disputeId)).toBe('review');
      expect(await restrictions()).toEqual([]);
      await reconcile();
      expect(await caseOf('partial_chargeback', d.disputeId)).toMatchObject({ resolution: null });
    });

    it('wrong-purchase protection: a loss of ANOTHER capture of the invoice never touches the L-4 purchase (no recovery); a legacy loss on that request is a capture mismatch, kept for review', async () => {
      const x = await applied();
      const second = await late(x.s);
      const d = await lost(x.s, { capture: lateCapture(second.factId) });
      expect(await losses().apply(d.disputeId)).toEqual({ kind: 'applied', outcome: 'none', reason: 'late_capture_unsold' });
      expect(await recovery().visit(d.disputeId), 'not an assisted purchase\'s loss: never visited').toBe('already');
      expect(await count(`SELECT count(*) AS n FROM recovery_obligation WHERE "disputeId" = $1`, [d.disputeId])).toBe(0);
      await reconcile();
      expect(await resolutionOf('late_success', second.lateSuccessId)).toBe('chargeback_returned');
      // a legacy (settling) statement on a request that never settled names no movement of the L-4 purchase
      const legacy = await lost(x.s);
      expect(await losses().apply(legacy.disputeId)).toEqual({ kind: 'review', reason: 'capture_mismatch' });
      expect(await effectOf(legacy.disputeId)).toBeUndefined();
      await reconcile();
      expect(await caseOf('contradictory_effect', legacy.disputeId)).toBeDefined();
      expect(await count(`SELECT count(*) AS n FROM recovery_obligation o JOIN subscription_purchase p ON p.id = o."purchaseId" WHERE p.id = $1`, [x.p.id])).toBe(0);
      expect((await entitlement(U.b1, x.r.productId).expect(200)).body.valid).toBe(true);
      expect(await restrictions()).toEqual([]);
    });

    it('a refunded L-4 purchase then charged back: no recovery (R6F-4), a chargeback_refund_overlap case, never chargeback_returned', async () => {
      const x = await applied();
      const c = await openRefund({ paymentId: x.s.paymentId, reason: 'customer_request' });
      expect(c.status, JSON.stringify(c.body)).toBe(201);
      await send(request(server()).post(`/billing/admin/refund-cases/${c.body.id}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') }).expect(201);
      const att = await one(`SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [c.body.id]);
      const ev = randomUUID();
      await t.bus.deliver({ id: ev, name: 'refund.case_completed', payload: { refundCaseId: c.body.id, refundAuthorizationId: randomUUID(), refundAttemptId: att.id, paymentId: x.s.paymentId,
        paymentRequestId: x.s.paymentRequestId, producer: 'billing-service', approvedAmount: Number(x.s.inv.total), currency: 'TND', completedAt: new Date().toISOString(), liveMode: false,
        organizationId: ORG, purpose: 'assisted_settlement' }, headers: { eventId: ev, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
      await t.app.get(RefundEffectService).drainOnce();
      const d = await lost(x.s, { capture: lateCapture(x.l.factId) });
      expect(await losses().apply(d.disputeId)).toMatchObject({ reason: 'assisted_purchase_preserved' });
      expect(await recovery().visit(d.disputeId)).toBe('review');
      await reconcile();
      expect(await caseOf('chargeback_refund_overlap', d.disputeId)).toMatchObject({ detail: 'refund_and_chargeback', resolution: null });
      expect(await count(`SELECT count(*) AS n FROM reconciliation_case_resolution WHERE kind = 'chargeback_returned' AND "disputeId" = $1`, [d.disputeId])).toBe(0);
    });
  });

  describe('ordering: a late-capture loss before Billing holds the late success is HELD (S0-C9 items 2, 7)', () => {
    for (const via of ['event', 'payment_read'] as const) {
      it(`held, never applied to a purchase; once the late success arrives (${via}) it is unsold, L-4 is refused and the case resolves chargeback_returned`, async () => {
        const e = await ended('payment.expired');
        const factId = randomUUID();
        const d = await lost(e.s, { capture: lateCapture(factId) });
        expect(await lossOf(d.disputeId)).toMatchObject({ captureBasis: 'late_capture', captureFactId: factId });
        expect(await losses().apply(d.disputeId)).toEqual({ kind: 'held', reason: 'late_success_not_recorded' });
        expect(await losses().apply(d.disputeId)).toEqual({ kind: 'held', reason: 'late_success_not_recorded' });
        expect(await one(`SELECT state, reason FROM dispute_loss_effect_attempt WHERE "disputeId" = $1`, [d.disputeId])).toEqual({ state: 'held', reason: 'late_success_not_recorded' });
        expect(await effectOf(d.disputeId)).toBeUndefined();
        await reconcile();
        expect(await caseOf('contradictory_effect', d.disputeId), 'a held loss is not a review').toBeUndefined();
        let lateSuccessId: string;
        if (via === 'event') {
          lateSuccessId = (await late(e.s, { factId })).lateSuccessId;
        } else {
          lateSuccessId = randomUUID();
          paymentItems.items.set('late_success', [asItem({ id: lateSuccessId, paymentId: e.s.paymentId, factId, amount: Number(e.s.inv.total), currency: 'TND',
            detail: { paymentStatus: 'expired' }, at: new Date(Date.now() - 5_000).toISOString() })]);
          await reconcile();
        }
        const row = await lateSettlementOf(e.s.invoiceId);
        expect(row.lateSuccessId).toBe(lateSuccessId);
        await attest(row.id, 'cash_not_returned').expect(201);
        const secret = receipt(row as { id: string }, e.r);
        expect(refusal(await apply(row.id as string, secret))).toEqual([409, 'late_settlement_refused', 'chargeback_recorded']);
        expect(fraudAuth.issued.get(secret)!.consumeRef).toBeUndefined();
        expect(await losses().apply(d.disputeId)).toEqual({ kind: 'applied', outcome: 'none', reason: 'late_capture_unsold' });
        await reconcile();
        expect(await resolutionOf('late_assisted_settlement', row.id)).toBe('chargeback_returned');
        await nothingSold(e.r, e.s, e.status);
      });
    }

    it('a late-capture loss naming a capture Billing holds for ANOTHER payment is refused (binding_mismatch); the database agrees', async () => {
      const a = await ready();
      const b = await ended('payment.expired');
      const d = lostEnvelope(b.s, { capture: lateCapture(a.l.factId) });
      await t.bus.deliver(d.envelope);
      expect(deadLettered(d.envelope)).toBe(true);
      expect(await lossCount(b.s.paymentId)).toBe(0);
      const e = await admin.query(`INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackFactId", "chargebackAmount",
          "chargebackCurrency", "lostAt", source, "captureBasis", "captureFactId") VALUES ($1, $2, $3, 5600, 'TND', $4, 5600, 'TND', now(), 'reconciliation', 'late_capture', $5)`,
        [randomUUID(), b.s.paymentId, b.s.paymentRequestId, randomUUID(), a.l.factId]).then(() => null, (v: { constraint?: string }) => v);
      expect(e?.constraint).toBe('payment_dispute_loss_capture_binding');
    });
  });

  describe('duplicates, replays, forgery and concurrency: exactly once (S0-C9 item 7; S0-C6)', () => {
    it('the same loss redelivered, replayed and read from Payment, and applied concurrently: one loss, one effect; another statement of it changes nothing; a forged one records nothing', async () => {
      const x = await ready();
      const d = lostEnvelope(x.s, { capture: lateCapture(x.l.factId) });
      await t.bus.deliver(d.envelope);
      await t.bus.deliver(d.envelope, 'verified_duplicate');
      await t.bus.deliver(d.envelope, 'verified_replay');
      lossesAtPayment.items = [{ ...(d.envelope.payload as Record<string, unknown>), paymentRequestId: x.s.paymentRequestId } as unknown as PaymentDisputeLoss];
      const [tally, ...outs] = await Promise.all([losses().drainOnce(), ...Array.from({ length: 8 }, () => losses().apply(d.disputeId))]);
      expect(tally.recorded, 'the read found it recorded').toBe(0);
      expect(outs.filter((o) => o.kind === 'applied').length + tally.applied, 'one effect').toBe(1);
      expect(outs.filter((o) => o.kind !== 'applied' && o.kind !== 'already_applied')).toEqual([]);
      expect(await lossCount(x.s.paymentId)).toBe(1);
      expect(await count(`SELECT count(*) AS n FROM dispute_loss_effect WHERE "disputeId" = $1`, [d.disputeId])).toBe(1);
      // the same dispute stated with another capture, or as legacy: a conflict, never applied
      for (const capture of [lateCapture(randomUUID()), {}]) {
        const other = lostEnvelope(x.s, { disputeId: d.disputeId, chargebackFactId: d.chargebackFactId, capture });
        await t.bus.deliver(other.envelope);
        expect(deadLettered(other.envelope)).toBe(true);
      }
      expect(await lossOf(d.disputeId)).toMatchObject({ captureBasis: 'late_capture', captureFactId: x.l.factId });
      // forged: a refused (unverified) delivery never reaches Billing's state
      const forged = lostEnvelope(x.s, { capture: lateCapture(x.l.factId) });
      await t.bus.deliver(forged.envelope, { refuse: 'untrusted_unverified_original' });
      expect(await lossOf(forged.disputeId)).toBeUndefined();
      await reconcile();
      expect(await count(`SELECT count(*) AS n FROM reconciliation_case_resolution x JOIN reconciliation_case c ON c.id = x."caseId" WHERE c."paymentId" = $1`, [x.s.paymentId])).toBe(1);
    });

    it('a loss recorded while L-4 commits (the read is not a lock): either L-4 is refused and the loss has no purchase effect, or L-4 applied and the loss preserves that purchase with recovery; never both, never neither', async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 5; i++) {
        if (i > 0) {
          // each round in its own Organization (as each test is): an 'applied' round opens a recovery obligation, whose T3 would correctly refuse
          // the next round's new assistance request in the same Organization, whichever way the race went
          ORG = randomUUID();
          ORG2 = randomUUID();
          resetIdentities();
          auth.reset();
        }
        const x = await ready();
        const d = lostEnvelope(x.s, { capture: lateCapture(x.l.factId) });
        const [a] = await Promise.all([apply(x.row.id, receipt(x.row, x.r)), t.bus.deliver(d.envelope)]);
        expect(await lossCount(x.s.paymentId)).toBe(1);
        const eff = await losses().apply(d.disputeId);
        const purchases = await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [x.r.id]);
        if (a.status === 201) {
          seen.add('applied');
          expect([purchases, eff]).toEqual([1, { kind: 'applied', outcome: 'none', reason: 'assisted_purchase_preserved' }]);
          expect(await recovery().visit(d.disputeId)).toBe('opened');
        } else {
          seen.add('refused');
          expect(refusal(a)).toEqual([409, 'late_settlement_refused', 'chargeback_recorded']);
          expect([purchases, eff]).toEqual([0, { kind: 'applied', outcome: 'none', reason: 'late_capture_unsold' }]);
        }
      }
      expect(seen.size).toBeGreaterThan(0);
    });

    it('chargeback_returned racing the capture\'s refund (Payment answering clear): never both a refund case and chargeback_returned', async () => {
      for (let i = 0; i < 3; i++) {
        const x = await ready();
        const d = await lost(x.s, { capture: lateCapture(x.l.factId) });
        await losses().apply(d.disputeId);
        const [, c] = await Promise.all([reconcile(), openRefund({ paymentId: x.s.paymentId, reason: 'late_settlement_unapplied' })]);
        await reconcile();
        const returned = (await resolutionOf('late_assisted_settlement', x.row.id)) === 'chargeback_returned' ? 1 : 0;
        const refunds = await count(`SELECT count(*) AS n FROM refund_case WHERE "paymentId" = $1`, [x.s.paymentId]);
        expect(returned + refunds, `${c.status} ${JSON.stringify(c.body)}`).toBe(1);
        if (returned) expect([c.status, c.body.code]).toEqual([409, 'refund_dispute_open']);
      }
    });
  });

  describe('the database (migration 0045): capture shape and binding, effect and recovery binding, chargeback_returned evidence', () => {
    const failsWith = async (sql: string, params: unknown[], constraint: string) => {
      const e = await admin.query(sql, params).then(() => null, (v: { constraint?: string }) => v);
      expect(e?.constraint, sql).toBe(constraint);
    };
    const insertLoss = (s: { paymentId: string; paymentRequestId: string; inv: Row }, basis: string, factId: string | null, amount = Number(s.inv.total)) => admin.query(
      `INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackFactId", "chargebackAmount", "chargebackCurrency",
         "lostAt", source, "captureBasis", "captureFactId") VALUES ($1, $2, $3, $4, 'TND', $5, $4, 'TND', now(), 'reconciliation', $6, $7) RETURNING "disputeId"`,
      [randomUUID(), s.paymentId, s.paymentRequestId, amount, randomUUID(), basis, factId]).then((r) => r.rows[0].disputeId as string);

    it('refuses a late capture without its fact, an unknown basis, an effect or a recovery obligation on a purchase the capture does not evidence, and an unsupported chargeback_returned', async () => {
      const x = await ready();
      await failsWith(`INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackFactId", "chargebackAmount", "chargebackCurrency",
          "lostAt", source, "captureBasis", "captureFactId") VALUES ($1, $2, $3, 5600, 'TND', $4, 5600, 'TND', now(), 'reconciliation', 'late_capture', NULL)`,
        [randomUUID(), x.s.paymentId, x.s.paymentRequestId, randomUUID()], 'payment_dispute_loss_capture');
      await failsWith(`INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackFactId", "chargebackAmount", "chargebackCurrency",
          "lostAt", source, "captureBasis") VALUES ($1, $2, $3, 5600, 'TND', $4, 5600, 'TND', now(), 'reconciliation', 'refund_capture')`,
        [randomUUID(), x.s.paymentId, x.s.paymentRequestId, randomUUID()], 'payment_dispute_loss_capture');
      // an unsold late capture: chargeback_returned without the loss, with a partial one, or for the wrong capture is refused
      const c = await caseOf('late_assisted_settlement', x.row.id);
      const resolve = (disputeId: string | null) => `INSERT INTO reconciliation_case_resolution ("caseId", kind, "disputeId") VALUES ('${c.id}', 'chargeback_returned', ${disputeId ? `'${disputeId}'` : 'NULL'})`;
      await failsWith(resolve(null), [], 'reconciliation_case_resolution_evidence');
      await failsWith(resolve(await insertLoss(x.s, 'late_capture', x.l.factId, Number(x.s.inv.total) - 1)), [], 'reconciliation_case_resolution_evidence');
      await failsWith(resolve(await insertLoss(x.s, 'settling_capture', null)), [], 'reconciliation_case_resolution_evidence');
      await failsWith(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "disputeId", "refundCaseId") VALUES ($1, 'late_settlement_applied', $2, NULL)`,
        [c.id, await insertLoss(x.s, 'late_capture', x.l.factId)], 'reconciliation_case_resolution_evidence');
      // `late_capture_unsold` for a capture Billing has no late success for, and a `not_a_personal_purchase` for a late capture
      const unknown = await insertLoss(x.s, 'late_capture', randomUUID());
      await failsWith(`INSERT INTO dispute_loss_effect ("disputeId", outcome, reason) VALUES ($1, 'none', 'late_capture_unsold')`, [unknown], 'dispute_loss_effect_purchase');
      await failsWith(`INSERT INTO dispute_loss_effect ("disputeId", outcome, reason) VALUES ($1, 'none', 'not_a_personal_purchase')`, [unknown], 'dispute_loss_effect_purchase');
      // after L-4 (another request): a settling (legacy) loss can neither preserve nor open recovery on the L-4 purchase; a sold late capture is
      // never `late_capture_unsold` and never resolves chargeback_returned
      const y = await ready();
      expect((await apply(y.row.id, receipt(y.row, y.r))).status).toBe(201);
      const p = await one(`SELECT id FROM subscription_purchase WHERE "lateSuccessId" = $1`, [y.l.lateSuccessId]);
      const settling = await insertLoss(y.s, 'settling_capture', null);
      await failsWith(`INSERT INTO dispute_loss_effect ("disputeId", outcome, "purchaseId", reason) VALUES ($1, 'none', $2, 'assisted_purchase_preserved')`, [settling, p.id], 'dispute_loss_effect_purchase');
      const sold = await insertLoss(y.s, 'late_capture', y.l.factId);
      await failsWith(`INSERT INTO dispute_loss_effect ("disputeId", outcome, reason) VALUES ($1, 'none', 'late_capture_unsold')`, [sold], 'dispute_loss_effect_purchase');
      await failsWith(`INSERT INTO recovery_obligation ("disputeId", "assistanceRequestId", "purchaseId", "organizationId", "companyId", "platformId", "baseAmount", currency)
          SELECT $1, a.id, $2, a."organizationId", $3, a."platformId", a."baseAmount", a.currency FROM assistance_request a WHERE a.id = $4`,
        [settling, p.id, COMPANY, y.r.id], 'recovery_obligation_basis');
      await reconcile();
      const cy = await caseOf('late_assisted_settlement', y.row.id);
      await failsWith(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "disputeId") VALUES ($1, 'chargeback_returned', $2)`, [cy.id, sold], 'reconciliation_case_resolution_evidence');
      // the loss stays append-only
      await expect(admin.query(`UPDATE payment_dispute_loss SET "captureBasis" = 'settling_capture' WHERE "disputeId" = $1`, [sold])).rejects.toThrow(/append-only/);
    });

    it('CB-6: a loss recorded before this migration reads as the legacy settling capture, and no existing row is rewritten', async () => {
      const pre = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings0c9pre');
      const dir = mkdtempSync(join(tmpdir(), 'billing-pre-0045-'));
      try {
        for (const f of readdirSync(billingMigrationsDir)) if (f < '0045') copyFileSync(join(billingMigrationsDir, f), join(dir, f));
        await runMigrations(pre.url, [kitMigrationsDir, dir]);
        const c = new pg.Client({ connectionString: pre.url });
        await c.connect();
        const id = randomUUID();
        let before: Row;
        try {
          // a pre-S0-C9 row, without its referenced fixtures (replica role: test-only, bypasses the FK and guard triggers)
          await c.query(`SET session_replication_role = replica`);
          await c.query(`INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackFactId", "chargebackAmount", "chargebackCurrency",
              "lostAt", source) VALUES ($1, $2, $3, 5600, 'TND', $4, 5600, 'TND', now(), 'reconciliation')`, [id, randomUUID(), randomUUID(), randomUUID()]);
          await c.query(`SET session_replication_role = origin`);
          before = (await c.query(`SELECT xmin::text AS xmin, ctid::text AS ctid FROM payment_dispute_loss WHERE "disputeId" = $1`, [id])).rows[0] as Row;
        } finally {
          await c.end();
        }
        await runMigrations(pre.url, [kitMigrationsDir, billingMigrationsDir]);
        const p2 = new pg.Client({ connectionString: pre.url });
        await p2.connect();
        try {
          const after = (await p2.query(`SELECT "captureBasis", "captureFactId", xmin::text AS xmin, ctid::text AS ctid FROM payment_dispute_loss WHERE "disputeId" = $1`, [id])).rows[0];
          expect(after).toEqual({ captureBasis: 'settling_capture', captureFactId: null, xmin: before.xmin, ctid: before.ctid });
          // a new row must state its basis (no default survives the migration)
          const e = await p2.query(`SET session_replication_role = replica; INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency,
              "chargebackFactId", "chargebackAmount", "chargebackCurrency", "lostAt", source) VALUES ('${randomUUID()}', '${randomUUID()}', '${randomUUID()}', 1, 'TND', '${randomUUID()}', 1, 'TND', now(), 'reconciliation')`)
            .then(() => null, (v: { column?: string; code?: string }) => v);
          expect(e?.code, 'not null violation').toBe('23502');
        } finally {
          await p2.end();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
        await pre.drop();
      }
    });
  });
});

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
import type { BillingConfig } from '../src/config/billing-config.js';
import type { PaymentEventFacts, PaymentEventName } from '../src/domain/payment-event-decision.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import type { CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import { HttpOwnerAuthority } from '../src/platforms/owner-authority.client.js';
import type { DisputeExposure } from '../src/refunds/dispute-exposure.js';
import { RefundEffectService } from '../src/refunds/refund-effect.service.js';
import { DisputeLossService } from '../src/refunds/dispute-loss.service.js';
import type { PaymentDisputeClient, PaymentDisputeLoss } from '../src/refunds/payment-dispute-client.js';
import type { FraudEvidenceFiles, FraudHoldReceipts, GrantedFraudEvidence } from '../src/fraud-holds/fraud-hold-clients.js';
import type { CaptureReadOutcome, PaymentRefundClient } from '../src/refunds/payment-refund-client.js';
import { RecoveryModule } from '../src/recovery/recovery.module.js';
import { RecoveryService } from '../src/recovery/recovery.service.js';
import type { PaymentItem, PaymentItemKind, PaymentReconciliationClient } from '../src/reconciliation/payment-reconciliation-client.js';
import { ReconciliationModule } from '../src/reconciliation/reconciliation.module.js';
import { ReconciliationService } from '../src/reconciliation/reconciliation.service.js';
import { RefundAuthorizationService } from '../src/refunds/refund-authorization.service.js';
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

/**
 * Core V2 S0-C12 D-1: Payment's R6H-5 capture read, as Payment answers it for the facts this suite's late successes name (each is a recorded,
 * uncontested capture of its payment, of exactly the late success's figures); any other fact is `404 capture_not_found`. `captureAt.answer`
 * overrides it per test (contested, unavailable). Every read is kept.
 */
const captureAt = { answer: null as null | ((paymentId: string, factId: string) => Promise<CaptureReadOutcome>), calls: [] as Array<[string, string]> };
/** Payment's own capture facts, as this suite's late successes state them (registered where each late success is produced). */
const paymentFacts = new Map<string, { paymentId: string; amount: number; currency: string; paymentStatus: string }>();
const captureAsPayment = async (paymentId: string, factId: string): Promise<CaptureReadOutcome> => {
  const l = paymentFacts.get(factId);
  if (!l || l.paymentId !== paymentId) return { kind: 'not_found', reason: 'capture_not_found' };
  return { kind: 'capture', capture: { factId, paymentId, amount: Number(l.amount), currency: l.currency, paymentStatus: l.paymentStatus, basis: 'late_capture',
    conflicted: false, refund: 'none', refundableOnItsOwn: true, attemptCaptures: 1 } };
};

/** Core V2 S6d: Payment's refund port, authorizing every relayed attempt (the S6b/S6c Payment behaviour is certified in its own suites). */
const relayAnswer = { unknown: false, bodies: [] as Record<string, unknown>[] };
const refundsAtPayment: PaymentRefundClient = {
  relay: async (_paymentId, _key, body) => {
    relayAnswer.bodies.push({ ...body, receiptSecret: undefined });
    if (relayAnswer.unknown) return { kind: 'unknown', reason: 'status_0' }; // Core V2 S6h-B: Payment's answer lost (Q8 tests)
    return { kind: 'attempt', attempt: { refundAttemptId: body.refundAttemptId, status: 'authorized', approvedBy: { userId: randomUUID() } } };
  },
  refunds: async () => ({ attempts: [], refusals: [], authorizations: [] }),
  capture: async (paymentId, factId) => {
    captureAt.calls.push([paymentId, factId]);
    return captureAt.answer ? captureAt.answer(paymentId, factId) : captureAsPayment(paymentId, factId);
  },
  settlingCapture: async () => ({ kind: 'unknown' as const, reason: 'not_used_in_this_suite' }), // Core V2 S0-C11 7c: no E-7 application here
};

/** Core V2 S6h-B: Payment's reconciliation read (PAY-12) under test control: items per kind, or Payment unavailable. */
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
      paymentReconciliationClient: paymentReconciliation, // Core V2 S6h-B
      tokens: [{ caller: 'test-producer', digest: producer.digest }],
      env: { BILLING_SERVICE_POLICY: JSON.stringify({ callers: { 'test-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: [PLATFORM] } } }) },
    });
  });
  beforeEach(() => {
    captureAt.answer = null;
    captureAt.calls.length = 0;
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
   * Core V2 S6h-B (R6H-4): Payment's VERIFIED late success of an already-failed recovery channel, delivered as Payment emits it
   * (`payment.late_success.recorded`, through the verified consumer). The request keeps its terminal state; Billing counts the captured money
   * once, as principal still outstanding or (here, the base already recovered) as surplus owed to the Organization. It replaces S6f's labelled
   * fixture, which simulated this step before S6h existed.
   */
  const s6hLateSuccess = async (paymentRequestId: string, paymentId: string, factId: string = randomUUID()) => {
    const pr = await one(`SELECT pr.amount, trim(pr.currency) AS currency, pr.status, i."organizationId" FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" WHERE pr.id = $1`, [paymentRequestId]);
    const id = randomUUID();
    const lateSuccessId = randomUUID();
    paymentFacts.set(factId, { paymentId, amount: Number(pr.amount), currency: pr.currency, paymentStatus: pr.status === 'expired' ? 'expired' : 'failed' });
    await t.bus.deliver({ id, name: 'payment.late_success.recorded', payload: {
      lateSuccessId, paymentId, paymentRequestId, producer: 'billing-service', organizationId: pr.organizationId, purpose: 'recovery_settlement', attemptId: randomUUID(),
      factId, amount: Number(pr.amount), currency: pr.currency, paymentStatus: pr.status === 'expired' ? 'expired' : 'failed', recordedAt: new Date().toISOString(), liveMode: false,
    }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } } as never);
    const rp = await one(`SELECT "surplusAmount"::int AS surplus FROM recovery_payment WHERE "lateSuccessId" = $1`, [lateSuccessId]);
    return rp ? 'recovery' : 'none';
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
    paymentItems.items = new Map();
    paymentItems.down = false;
    relayAnswer.unknown = false;
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

  describe('surplus (R6F-5; the late success is Payment\'s real event since S6h-B)', () => {
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

  // ─────────────────────────────────────────────────────────────────────────────────────────────── Core V2 S6h-B

  describe('Core V2 S6h-B: late successes, real surplus, FinancialLoss, write-off and reconciliation cases (R6H-1 to R6H-12)', () => {
    const reconcile = () => t.app.get(ReconciliationService).drainOnce();
    /** Payment's verified final loss of a DIRECT purchase (its effect, a reversal, has no reason code), applied by the dispute-loss worker. */
    const loseDirect = async (paymentId: string, amount: number, chargeback = amount) => {
      const id = randomUUID();
      const disputeId = randomUUID();
      await t.bus.deliver({ id, name: 'payment.dispute.lost', payload: {
        disputeId, paymentId, paymentRequestId: randomUUID(), producer: 'billing-service', organizationId: null, purpose: 'direct_purchase', amount, currency: 'TND',
        lostAt: new Date().toISOString(), chargeback: { factId: randomUUID(), amount: chargeback, currency: 'TND' }, liveMode: false,
      }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } } as never);
      await losses().drainOnce();
      return disputeId;
    };
    /** Payment's `payment.late_success.recorded` for one of Billing's payment requests, as Payment emits it (verified consumer). */
    const lateEvent = async (paymentRequestId: string, paymentId: string, o: { factId?: string; lateSuccessId?: string; status?: string; amount?: number; purpose?: string; currency?: string } = {}) => {
      const pr = await one(`SELECT pr.amount::int AS amount, trim(pr.currency) AS currency, i."organizationId" FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" WHERE pr.id = $1`, [paymentRequestId]);
      const lateSuccessId = o.lateSuccessId ?? randomUUID();
      const factId = o.factId ?? randomUUID();
      const id = randomUUID();
      paymentFacts.set(factId, { paymentId, amount: o.amount ?? pr.amount, currency: o.currency ?? pr.currency, paymentStatus: o.status ?? 'failed' });
      const envelope = { id, name: 'payment.late_success.recorded', payload: {
        lateSuccessId, paymentId, paymentRequestId, producer: 'billing-service', organizationId: pr.organizationId, purpose: o.purpose ?? 'recovery_settlement', attemptId: randomUUID(),
        factId, amount: o.amount ?? pr.amount, currency: o.currency ?? pr.currency, paymentStatus: o.status ?? 'failed', recordedAt: new Date().toISOString(), liveMode: false,
      }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } } as EventEnvelope;
      await t.bus.deliver(envelope);
      return { lateSuccessId, factId, envelope };
    };
    const asItem = (kind: PaymentItemKind, i: Partial<PaymentItem> & { paymentId: string }): PaymentItem =>
      ({ kind, id: randomUUID(), factId: null, amount: null, currency: null, detail: {}, at: new Date().toISOString(), ...i });
    const put = (i: PaymentItem) => {
      // a late success Payment states is of its own recorded capture fact (S0-C11 item 6)
      if (i.kind === 'late_success' && i.factId && i.amount !== null && i.currency !== null) {
        paymentFacts.set(i.factId, { paymentId: i.paymentId, amount: i.amount, currency: i.currency, paymentStatus: typeof i.detail.paymentStatus === 'string' ? i.detail.paymentStatus : 'failed' });
      }
      return paymentItems.items.set(i.kind, [...(paymentItems.items.get(i.kind) ?? []), i]);
    };
    const cases = (q = '', bearer = 'owner-tok') => send(request(server()).get(`/billing/admin/reconciliation-cases${q}`), bearer, null);
    const caseOf = (type: string, evidence: string) => one(`SELECT c.*, r.kind AS resolution FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
      WHERE c."caseType" = $1 AND c."evidenceKey" = $2`, [type, evidence]);
    const recoveredAudits = (obligationId: string) => count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.recovery_obligation.recovered' AND payload->'resource'->>'id' = $1`, [obligationId]);
    const writeOffReceipt = (o: { obligationId: string }, over: Record<string, unknown> = {}, issuer: string = U.owner) => {
      const secret = randomBytes(32).toString('base64url');
      fraudAuth.issued.set(secret, { id: randomUUID(), issuer, binding: { operation: 'recovery_write_off', audience: 'billing-service', companyId: COMPANY, obligationId: o.obligationId,
        organizationId: ORG, amount: 6100, currency: 'TND', ...over } });
      return secret;
    };
    const writeOff = (obligationId: string, secret: string, bearer = 'owner-tok') =>
      send(request(server()).post(`/billing/admin/recovery-obligations/${obligationId}/write-off`), bearer, null).send({ receiptSecret: secret });
    /** An ordinary refund of a direct purchase, completed by Payment's verified completion (S6a to S6c), and its S6d effect. */
    const completeRefund = async (paymentId: string) => {
      const c = (await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId, reason: 'customer_request' })).body;
      await send(request(server()).post(`/billing/admin/refund-cases/${c.id}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') }).expect(201);
      const att = await one(`SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [c.id]);
      const ev = randomUUID();
      await t.bus.deliver({ id: ev, name: 'refund.case_completed', payload: { refundCaseId: c.id, refundAuthorizationId: randomUUID(), refundAttemptId: att.id, paymentId,
        paymentRequestId: randomUUID(), producer: 'billing-service', approvedAmount: c.amount, currency: 'TND', completedAt: new Date().toISOString(), liveMode: false,
        organizationId: null, purpose: 'direct_purchase' }, headers: { eventId: ev, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
      await t.app.get(RefundEffectService).drainOnce();
      return c.id as string;
    };

    it('Core V2 S0-C9: a late-capture loss of a late success counted as a RECOVERY payment has no purchase effect and is kept for review, never silently closed', async () => {
      const o = await opened();
      const c1 = (await settleRecovery(o.obligationId)).body;
      const failed = await recoveryEvent(c1.paymentRequestId, 'payment.failed');
      const factId = randomUUID();
      expect(await s6hLateSuccess(c1.paymentRequestId, failed.paymentId, factId)).toBe('recovery');
      const amount = Number((await one(`SELECT amount FROM payment_request WHERE id = $1`, [c1.paymentRequestId])).amount);
      const id = randomUUID();
      const disputeId = randomUUID();
      await t.bus.deliver({ id, name: 'payment.dispute.lost', payload: {
        disputeId, paymentId: failed.paymentId, paymentRequestId: c1.paymentRequestId, producer: 'billing-service', organizationId: ORG, purpose: 'recovery_settlement', amount,
        currency: 'TND', lostAt: new Date().toISOString(), chargeback: { factId: randomUUID(), amount, currency: 'TND' }, liveMode: false, captureFactId: factId, captureBasis: 'late_capture',
      }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } } as never);
      expect(await losses().apply(disputeId)).toEqual({ kind: 'review', reason: 'recovery_payment_capture' });
      expect(await one(`SELECT 1 AS x FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId])).toBeUndefined();
      expect(await recovery().visit(disputeId)).toBe('already');
    });

    it('CERTIFICATION: A undecided blocks a second attempt; A fails, B recovers the base (T3 clears once); A\'s verified LATE success is counted once, as surplus', async () => {
      const o = await opened();
      expect(await restrictions()).toEqual([{ kind: 'T3', sourceId: o.obligationId }]);
      const cA = (await settleRecovery(o.obligationId)).body;
      // A is undecided: the frozen one-open-or-uncertain-channel rule refuses any second attempt (never bypassed to build this test)
      expect((await settleRecovery(o.obligationId)).body).toMatchObject({ code: 'settlement_channel_open' });
      const failedA = await recoveryEvent(cA.paymentRequestId, 'payment.failed'); // A definitively closed (Payment's verified failure)
      const cB = (await settleRecovery(o.obligationId)).body;
      expect(cB.amount ?? 6100).toBe(6100);
      await recoveryEvent(cB.paymentRequestId);
      expect((await obligationOf(o.disputeId)).status).toBe('recovered');
      expect(await restrictions()).toEqual([]);
      // Payment later verifies A's success after A's finality: never a payment.succeeded; the request stays failed; counted once, as surplus
      const late = await lateEvent(cA.paymentRequestId, failedA.paymentId);
      expect((await one(`SELECT status FROM payment_request WHERE id = $1`, [cA.paymentRequestId])).status).toBe('failed');
      expect(await one(`SELECT "principalAmount"::int AS p, "surplusAmount"::int AS s FROM recovery_payment WHERE "lateSuccessId" = $1`, [late.lateSuccessId])).toEqual({ p: 0, s: 6100 });
      // the same verified success again, by every channel: the event redelivered, Payment's read, another statement of the same provider fact
      await t.bus.deliver(late.envelope);
      put(asItem('late_success', { id: late.lateSuccessId, paymentId: failedA.paymentId, factId: late.factId, amount: 6100, currency: 'TND', detail: { paymentStatus: 'failed' } }));
      await reconcile();
      await lateEvent(cA.paymentRequestId, failedA.paymentId, { factId: late.factId });
      expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "obligationId" = $1`, [o.obligationId])).toBe(2);
      expect((await readRecovery(o.obligationId)).body).toMatchObject({ recovered: 6100, outstanding: 0, status: 'recovered' });
      expect(await recoveredAudits(o.obligationId)).toBe(1); // T3 cleared exactly once
      expect(await restrictions()).toEqual([]); // R-5: a surplus never re-opens T3
      // the surplus is owed to the Organization until resolved: a case, never revenue, never offset, never expiring
      expect((await caseOf('recovery_surplus', (await one(`SELECT id FROM recovery_surplus WHERE "obligationId" = $1`, [o.obligationId])).id))).toMatchObject({ resolution: null });
      expect(await count(`SELECT count(*) AS n FROM payment_event_receipt WHERE "paymentRequestId" = $1 AND "eventName" = 'payment.succeeded'`, [cA.paymentRequestId])).toBe(0);
    });

    it('a late success BEFORE the second channel succeeds recovers the principal (T3 clears there, once); the second success is then entirely surplus', async () => {
      const o = await opened();
      const cA = (await settleRecovery(o.obligationId)).body;
      const failedA = await recoveryEvent(cA.paymentRequestId, 'payment.failed');
      const cB = (await settleRecovery(o.obligationId)).body;
      await lateEvent(cA.paymentRequestId, failedA.paymentId);
      expect((await obligationOf(o.disputeId)).status).toBe('recovered');
      expect(await restrictions()).toEqual([]);
      await recoveryEvent(cB.paymentRequestId);
      const pays = (await admin.query(`SELECT "principalAmount"::int AS p, "surplusAmount"::int AS s FROM recovery_payment WHERE "obligationId" = $1 ORDER BY "recordedAt"`, [o.obligationId])).rows;
      expect(pays).toEqual([{ p: 6100, s: 0 }, { p: 0, s: 6100 }]);
      expect(await recoveredAudits(o.obligationId)).toBe(1);
    });

    it('a LOST late-success event is recovered from Payment\'s read; the event arriving afterwards changes nothing; Payment unavailable infers nothing', async () => {
      const o = await opened();
      const cA = (await settleRecovery(o.obligationId)).body;
      const failedA = await recoveryEvent(cA.paymentRequestId, 'payment.failed');
      paymentItems.down = true;
      expect(await reconcile()).toMatchObject({ read: false });
      expect((await obligationOf(o.disputeId)).status).toBe('open');
      paymentItems.down = false;
      const lateSuccessId = randomUUID();
      const factId = randomUUID();
      put(asItem('late_success', { id: lateSuccessId, paymentId: failedA.paymentId, factId, amount: 6100, currency: 'TND', detail: { paymentStatus: 'failed' } }));
      await reconcile();
      expect(await one(`SELECT source FROM payment_late_success WHERE "lateSuccessId" = $1`, [lateSuccessId])).toEqual({ source: 'reconciliation' });
      expect((await obligationOf(o.disputeId)).status).toBe('recovered');
      await lateEvent(cA.paymentRequestId, failedA.paymentId, { lateSuccessId, factId });
      expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "obligationId" = $1`, [o.obligationId])).toBe(1);
      const rec = (await audit(o.obligationId)).find((x) => x.name === 'audit.recovery_payment.recorded')!;
      expect(rec.payload.actor).toEqual({ type: 'system', id: 'payment_reconciler' });
    });

    it('the Owner writes off the outstanding principal (dedicated receipt): a loss once; the obligation and T3 STAY; a later recovery adjusts the loss append-only', async () => {
      const o = await opened();
      const secret = writeOffReceipt(o);
      const w = await writeOff(o.obligationId, secret);
      expect(w.status, JSON.stringify(w.body)).toBe(201);
      expect(w.body).toMatchObject({ obligationId: o.obligationId, amount: 6100, currency: 'TND', writtenOffBy: { userId: U.owner }, obligationStatus: 'open' });
      expect(await restrictions()).toEqual([{ kind: 'T3', sourceId: o.obligationId }]); // accounting only: never forgiveness
      expect((await writeOff(o.obligationId, secret)).status).toBe(200); // the same request: answered, consumed once
      expect((await writeOff(o.obligationId, writeOffReceipt(o))).body).toMatchObject({ code: 'write_off_not_permitted' }); // never twice
      expect(await auditNames(o.obligationId)).toContain('audit.recovery_obligation.written_off');
      // a later verified recovery: the obligation is recovered (T3 ends) and the loss is reduced by an adjustment, never edited
      const c = (await settleRecovery(o.obligationId)).body;
      await recoveryEvent(c.paymentRequestId);
      expect((await obligationOf(o.disputeId)).status).toBe('recovered');
      expect(await restrictions()).toEqual([]);
      const losses = (await send(request(server()).get('/billing/admin/financial-losses'), 'owner-tok', null).expect(200)).body.items as Row[];
      const loss = losses.find((l) => l.obligationId === o.obligationId)!;
      expect(loss).toMatchObject({ kind: 'recovery_write_off', amount: 6100, netAmount: 0 });
      expect(loss.adjustments.map((a: Row) => [a.reason, a.amount])).toEqual([['recovered_after_write_off', -6100]]);
      await expect(admin.query(`UPDATE financial_loss SET amount = 1 WHERE id = $1`, [loss.id])).rejects.toThrow();
      await expect(admin.query(`DELETE FROM financial_loss_adjustment WHERE "lossId" = $1`, [loss.id])).rejects.toThrow();
      expect((await writeOff(o.obligationId, writeOffReceipt(o))).body).toMatchObject({ code: 'write_off_not_permitted' }); // recovered: nothing to write off
    });

    it('write-off refusals: a receipt for another amount, another issuer, a non-Owner, another Company, Auth unanswerable; nothing is recorded', async () => {
      const o = await opened();
      expect((await writeOff(o.obligationId, writeOffReceipt(o, { amount: 6000 }))).body).toMatchObject({ code: 'recovery_authorization_refused' });
      expect((await writeOff(o.obligationId, writeOffReceipt(o, {}, randomUUID()))).body).toMatchObject({ code: 'recovery_authorization_refused' });
      expect((await writeOff(o.obligationId, writeOffReceipt(o), 'member-tok')).status).toBe(403);
      expect((await writeOff(o.obligationId, writeOffReceipt(o), 'foreign-owner-tok')).status).toBe(404);
      fraudAuth.down = true;
      expect((await writeOff(o.obligationId, writeOffReceipt(o))).body).toMatchObject({ code: 'recovery_authorization_unresolved' });
      fraudAuth.down = false;
      expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE "obligationId" = $1`, [o.obligationId])).toBe(0);
    });

    it('over-return: the loss is the allocation EXCESS only, recognized once (concurrent passes too); its case resolves by that loss', async () => {
      const p = await directPurchase('b2');
      const factId = randomUUID();
      put(asItem('over_return', { paymentId: p.paymentId, factId, amount: 500, currency: 'TND', detail: { factAmount: 5400, intended: 4900 } }));
      await Promise.all([reconcile(), reconcile(), t.app.get(ReconciliationService).drainOnce()]);
      await reconcile();
      expect((await admin.query(`SELECT kind, amount::int FROM financial_loss WHERE "evidenceKey" = $1`, [factId])).rows).toEqual([{ kind: 'over_return', amount: 500 }]);
      expect(await caseOf('over_return', factId)).toMatchObject({ resolution: 'loss_recognized', amount: '500' });
      expect(await count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.financial_loss.recorded' AND payload->'changes'->>'evidence_id' = $1`, [factId])).toBe(1);
    });

    it('a FULL final-lost chargeback of a direct purchase is a loss once; a partial one is review only (no effect invented); the Owner acknowledges it', async () => {
      const full = await directPurchase('b2');
      const fullDispute = await loseDirect(full.paymentId, full.amount);
      const partial = await directPurchase('b1');
      const partialDispute = await loseDirect(partial.paymentId, partial.amount, partial.amount - 100);
      await reconcile();
      await reconcile();
      expect((await admin.query(`SELECT kind, amount::int FROM financial_loss WHERE "disputeId" = $1`, [fullDispute])).rows).toEqual([{ kind: 'direct_chargeback_write_off', amount: full.amount }]);
      expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE "disputeId" = $1`, [partialDispute])).toBe(0);
      const pc = await caseOf('partial_chargeback', partialDispute);
      expect(pc).toMatchObject({ resolution: null });
      const k = key();
      const ack = await send(request(server()).post(`/billing/admin/reconciliation-cases/${pc.id}/acknowledgement`), 'owner-tok', k).send({ reason: 'provider_statement_reviewed' });
      expect([ack.status, ack.body.status, ack.body.resolution?.kind]).toEqual([200, 'resolved', 'acknowledged']);
      expect((await send(request(server()).post(`/billing/admin/reconciliation-cases/${pc.id}/acknowledgement`), 'owner-tok', k).send({ reason: 'provider_statement_reviewed' })).headers['idempotent-replayed']).toBe('true');
      expect((await send(request(server()).post(`/billing/admin/reconciliation-cases/${pc.id}/acknowledgement`), 'owner-tok', key()).send({ reason: 'provider_statement_reviewed' })).body)
        .toMatchObject({ code: 'reconciliation_case_resolved' });
      expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE "disputeId" = $1`, [partialDispute])).toBe(0); // still no financial effect
    });

    it('a refunded purchase also charged back: no loss (never double recognition) but an overlap case; the second reversal cause is a review case', async () => {
      const p = await directPurchase('b2');
      await completeRefund(p.paymentId);
      const dispute = await loseDirect(p.paymentId, p.amount);
      await reconcile();
      expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE "paymentId" = $1`, [p.paymentId])).toBe(0);
      const overlap = await caseOf('chargeback_refund_overlap', dispute);
      expect(overlap).toMatchObject({ resolution: null, detail: 'refund_and_chargeback' });
      // a financial case is never acknowledged away
      expect((await send(request(server()).post(`/billing/admin/reconciliation-cases/${overlap.id}/acknowledgement`), 'owner-tok', key()).send({ reason: 'reviewed_no_financial_effect' })).body)
        .toMatchObject({ code: 'reconciliation_case_not_acknowledgeable' });
      const purchase = await one(`SELECT s.id FROM subscription_purchase s JOIN payment_request pr ON pr.id = s."paymentRequestId" WHERE pr."paymentId" = $1`, [p.paymentId]);
      if (await count(`SELECT count(*) AS n FROM subscription_purchase_reversal_cause WHERE "purchaseId" = $1`, [purchase.id]) > 1) {
        expect(await caseOf('second_reversal_cause', purchase.id)).toMatchObject({ resolution: null });
      }
    });

    it('a late success of a purchase is a reconciliation case (no purchase, no entitlement, never acknowledgeable); a sale with no routing record is discovered', async () => {
      const p = await directPurchase('b2');
      const purchases = await count(`SELECT count(*) AS n FROM subscription_purchase`);
      const late = await lateEvent(p.paymentRequestId, p.paymentId, { status: 'succeeded', purpose: 'direct_purchase' });
      const c = await caseOf('late_success', late.lateSuccessId);
      expect(c).toMatchObject({ captureFactId: late.factId, amount: String(p.amount), resolution: null, companyId: COMPANY });
      expect(await count(`SELECT count(*) AS n FROM subscription_purchase`)).toBe(purchases);
      expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "lateSuccessId" = $1`, [late.lateSuccessId])).toBe(0);
      const listed = (await cases('?type=late_success&status=open').expect(200)).body.items as Row[];
      expect(listed.find((x) => x.id === c.id)).toMatchObject({ captureFactId: late.factId, reviewOnly: false, status: 'open' });
      expect((await send(request(server()).post(`/billing/admin/reconciliation-cases/${c.id}/acknowledgement`), 'owner-tok', key()).send({ reason: 'reviewed_no_financial_effect' })).body)
        .toMatchObject({ code: 'reconciliation_case_not_acknowledgeable' });
      // historical evidence: a paid sale with no routing record (issued before routing existed) — a test-only reproduction
      const u = await directPurchase('b1');
      const cl = await admin.connect();
      try {
        await cl.query(`SET session_replication_role = replica`);
        await cl.query(`DELETE FROM invoice_entitlement WHERE "invoiceId" = $1`, [u.invoiceId]);
      } finally {
        await cl.query(`SET session_replication_role = origin`);
        cl.release();
      }
      await reconcile();
      expect(await caseOf('unrouted_settlement', u.paymentRequestId)).toMatchObject({ resolution: null, paymentId: u.paymentId });
    });

    it('Q8: a refund authorization Auth never answered stays an open case while unresolved; only a definitive outcome resolves it', async () => {
      const p = await directPurchase('b2');
      const c = (await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: p.paymentId, reason: 'customer_request' })).body;
      relayAnswer.unknown = true;
      await send(request(server()).post(`/billing/admin/refund-cases/${c.id}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') });
      const relay = await one(`SELECT id, "attemptStatus" FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [c.id]);
      expect(relay.attemptStatus).toBeNull();
      put(asItem('authorization_pending', { id: relay.id, paymentId: p.paymentId, amount: p.amount, currency: 'TND', detail: { operation: 'refund', refundCaseId: c.id } }));
      await reconcile();
      await reconcile();
      expect(await caseOf('authorization_pending', relay.id)).toMatchObject({ resolution: null }); // never released on missing evidence
      await t.app.get(RefundAuthorizationService).mirror(relay.id, 'authorization_refused', null);
      await reconcile();
      expect(await caseOf('authorization_pending', relay.id)).toMatchObject({ resolution: 'authorization_resolved' });
    });

    it('the late surplus is refunded as exactly its capture (R6H-5): the case names the fact, the relay carries it, completion resolves the surplus and its case', async () => {
      const o = await opened();
      const cA = (await settleRecovery(o.obligationId)).body;
      const failedA = await recoveryEvent(cA.paymentRequestId, 'payment.failed');
      const cB = (await settleRecovery(o.obligationId)).body;
      await recoveryEvent(cB.paymentRequestId);
      const late = await lateEvent(cA.paymentRequestId, failedA.paymentId);
      await reconcile();
      const surplus = await one(`SELECT id FROM recovery_surplus WHERE "obligationId" = $1`, [o.obligationId]);
      const rc = (await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId: failedA.paymentId, reason: 'recovery_surplus' })).body;
      expect(rc).toMatchObject({ eligibility: 'recovery_surplus', amount: 6100, capture: { captureFactId: late.factId, basis: 'late_capture' } });
      await send(request(server()).post(`/billing/admin/refund-cases/${rc.id}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') }).expect(201);
      expect(relayAnswer.bodies.at(-1)).toMatchObject({ refundCaseId: rc.id, captureFactId: late.factId, amount: 6100 });
      const att = await one(`SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [rc.id]);
      const ev = randomUUID();
      await t.bus.deliver({ id: ev, name: 'refund.case_completed', payload: { refundCaseId: rc.id, refundAuthorizationId: randomUUID(), refundAttemptId: att.id, paymentId: failedA.paymentId,
        paymentRequestId: cA.paymentRequestId, producer: 'billing-service', approvedAmount: 6100, currency: 'TND', completedAt: new Date().toISOString(), liveMode: false,
        organizationId: ORG, purpose: 'recovery_settlement' }, headers: { eventId: ev, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
      await t.app.get(RefundEffectService).drainOnce();
      await reconcile();
      expect(await caseOf('recovery_surplus', surplus.id)).toMatchObject({ resolution: 'surplus_refunded' });
      expect(await recoveredAudits(o.obligationId)).toBe(1);
    });

    /**
     * Core V2 S0-C12 D-1 and D-B (S0 §1.5 S0-C12 items 3, 4, 9; register BIL-28 G, BIL-23 I, BIL-33 J): the controlled and database half of the
     * S0-C11 L3 obligation. Payment's late successes enter through the verified consumer (and Payment's read); Payment's R6H-5 capture read is
     * the contract-faithful double above (`captureAt.answer` overrides it).
     */
    describe('S0-C12 D-1 and D-B: recovery counts only an equal, uncontested capture; the excluded capture is refundable on its own', () => {
      const recoveryPayments = (obligationId: string) => count(`SELECT count(*) AS n FROM recovery_payment WHERE "obligationId" = $1`, [obligationId]);
      const surpluses = (obligationId: string) => count(`SELECT count(*) AS n FROM recovery_surplus WHERE "obligationId" = $1`, [obligationId]);
      const contested = (paymentId: string, factId: string, amount: number): CaptureReadOutcome => ({ kind: 'capture', capture: { factId, paymentId, amount,
        currency: 'TND', paymentStatus: 'failed', basis: 'late_capture', conflicted: true, refund: 'none', refundableOnItsOwn: true, attemptCaptures: 1 } });
      /** An open recovery obligation (T3) whose first channel Payment definitively failed. */
      const failedChannel = async () => {
        const o = await opened();
        const c = (await settleRecovery(o.obligationId)).body;
        const failed = await recoveryEvent(c.paymentRequestId, 'payment.failed');
        return { o, paymentRequestId: c.paymentRequestId as string, paymentId: failed.paymentId as string };
      };
      const unchangedRecovery = async (o: { obligationId: string }, before: { recovered: number; outstanding: number; status: string }) => {
        expect((await readRecovery(o.obligationId)).body).toMatchObject(before);
        expect(await surpluses(o.obligationId)).toBe(0);
      };

      it('D-1: a wrong amount and another currency are never counted (no principal, surplus, T3, audit or entitlement change) and become refund-only cases; an equal, uncontested capture counts once', async () => {
        const { o, paymentRequestId, paymentId } = await failedChannel();
        expect(await restrictions()).toEqual([{ kind: 'T3', sourceId: o.obligationId }]);
        const before = { recovered: 0, outstanding: 6100, status: 'open' };
        const higher = await lateEvent(paymentRequestId, paymentId, { amount: 6200 });
        const lower = await lateEvent(paymentRequestId, paymentId, { amount: 6000 });
        const otherCurrency = await lateEvent(paymentRequestId, paymentId, { currency: 'EUR' });
        for (const [label, l, amount, currency] of [['higher', higher, 6200, 'TND'], ['lower', lower, 6000, 'TND'], ['another currency', otherCurrency, 6100, 'EUR']] as const) {
          expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "lateSuccessId" = $1`, [l.lateSuccessId]), label).toBe(0);
          expect(await caseOf('late_success', l.lateSuccessId), label).toMatchObject({ detail: 'recovery_settlement', captureFactId: l.factId, amount: String(amount), currency,
            resolution: null });
        }
        expect(captureAt.calls, 'no capture is read for an unequal late success: it can never count').toEqual([]);
        await unchangedRecovery(o, before);
        expect(await restrictions()).toEqual([{ kind: 'T3', sourceId: o.obligationId }]);
        expect(await recoveredAudits(o.obligationId)).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "paymentRequestId" = $1`, [paymentRequestId])).toBe(0);
        // an equal capture Payment states uncontested counts once, as before (§3.5): principal, T3 cleared once
        const equal = await lateEvent(paymentRequestId, paymentId);
        expect(captureAt.calls).toEqual([[paymentId, equal.factId]]);
        expect(await one(`SELECT "principalAmount"::int AS p, "surplusAmount"::int AS s FROM recovery_payment WHERE "lateSuccessId" = $1`, [equal.lateSuccessId])).toEqual({ p: 6100, s: 0 });
        expect((await readRecovery(o.obligationId)).body).toMatchObject({ recovered: 6100, outstanding: 0, status: 'recovered' });
        expect(await restrictions()).toEqual([]);
        expect(await recoveredAudits(o.obligationId)).toBe(1);
        // replays: the events again and Payment's read: still one recovery payment and one case each
        for (const l of [higher, equal]) await t.bus.deliver(l.envelope);
        put(asItem('late_success', { id: higher.lateSuccessId, paymentId, factId: higher.factId, amount: 6200, currency: 'TND', detail: { paymentStatus: 'failed' } }));
        await reconcile();
        expect(await recoveryPayments(o.obligationId)).toBe(1);
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'late_success' AND "paymentId" = $1`, [paymentId])).toBe(3);
      });

      it('D-1: an equal capture Payment states contested, or not a capture of that payment, is never counted (a refund-only case); Payment unanswerable decides nothing until it answers, then counts once', async () => {
        const { o, paymentRequestId, paymentId } = await failedChannel();
        captureAt.answer = async (pid, factId) => contested(pid, factId, 6100);
        const c = await lateEvent(paymentRequestId, paymentId);
        expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "lateSuccessId" = $1`, [c.lateSuccessId])).toBe(0);
        expect(await caseOf('late_success', c.lateSuccessId)).toMatchObject({ detail: 'recovery_settlement', resolution: null });
        captureAt.answer = async () => ({ kind: 'not_found', reason: 'capture_not_found' });
        const n = await lateEvent(paymentRequestId, paymentId);
        expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "lateSuccessId" = $1`, [n.lateSuccessId])).toBe(0);
        expect(await caseOf('late_success', n.lateSuccessId)).toMatchObject({ detail: 'recovery_settlement' });
        await unchangedRecovery(o, { recovered: 0, outstanding: 6100, status: 'open' });
        expect(await restrictions()).toEqual([{ kind: 'T3', sourceId: o.obligationId }]);
        // Payment unanswerable (and an answer about another fact, or the collapsed 404): recorded, nothing decided, no case; the worker reads again
        for (const answer of [async (): Promise<CaptureReadOutcome> => { throw new Error('payment-service unavailable'); },
          async (pid: string): Promise<CaptureReadOutcome> => contested(pid, randomUUID(), 6100),
          async (): Promise<CaptureReadOutcome> => ({ kind: 'not_found', reason: 'collapsed' })]) {
          captureAt.answer = answer;
          const u = await lateEvent(paymentRequestId, paymentId);
          expect(await count(`SELECT count(*) AS n FROM payment_late_success WHERE "lateSuccessId" = $1`, [u.lateSuccessId])).toBe(1);
          expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "lateSuccessId" = $1`, [u.lateSuccessId])).toBe(0);
          expect(await caseOf('late_success', u.lateSuccessId)).toBeUndefined();
          await reconcile(); // still unanswerable: still nothing
          expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "lateSuccessId" = $1`, [u.lateSuccessId])).toBe(0);
        }
        await unchangedRecovery(o, { recovered: 0, outstanding: 6100, status: 'open' });
        // once Payment answers (uncontested, equal), the worker counts each deferred one exactly once: principal first, then surplus
        captureAt.answer = null;
        await Promise.all([reconcile(), reconcile()]);
        await reconcile();
        expect(await recoveryPayments(o.obligationId)).toBe(3);
        expect((await readRecovery(o.obligationId)).body).toMatchObject({ recovered: 6100, outstanding: 0, status: 'recovered' });
        expect(await recoveredAudits(o.obligationId)).toBe(1);
        expect(await restrictions()).toEqual([]);
        expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "lateSuccessId" IN ($1, $2)`, [c.lateSuccessId, n.lateSuccessId])).toBe(0);
      });

      /** S0-C12 item 14: Payment's answer that this capture's attempt holds `n` capture facts. */
      const onAttemptOf = (n: number) => async (pid: string, factId: string): Promise<CaptureReadOutcome> => {
        const read = await captureAsPayment(pid, factId);
        return read.kind === 'capture' ? { kind: 'capture', capture: { ...read.capture, attemptCaptures: n } } : read;
      };

      it('S0-C12 item 14(c): one capture fact counts; the same equal capture on an ambiguous attempt never does (refund-only case; no principal, surplus, T3, audit or entitlement change), and replays add nothing', async () => {
        const { o, paymentRequestId, paymentId } = await failedChannel();
        const before = { recovered: 0, outstanding: 6100, status: 'open' };
        captureAt.answer = onAttemptOf(2);
        const ambiguous = await lateEvent(paymentRequestId, paymentId);
        expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "lateSuccessId" = $1`, [ambiguous.lateSuccessId])).toBe(0);
        expect(await caseOf('late_success', ambiguous.lateSuccessId)).toMatchObject({ detail: 'recovery_settlement', captureFactId: ambiguous.factId, amount: '6100', resolution: null });
        await unchangedRecovery(o, before);
        expect(await restrictions()).toEqual([{ kind: 'T3', sourceId: o.obligationId }]);
        expect(await recoveredAudits(o.obligationId)).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM subscription_purchase WHERE "paymentRequestId" = $1`, [paymentRequestId])).toBe(0);
        await t.bus.deliver(ambiguous.envelope);
        await reconcile();
        expect(await recoveryPayments(o.obligationId)).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'late_success' AND "evidenceKey" = $1`, [ambiguous.lateSuccessId])).toBe(1);
        // the control: the same figures, one capture fact, counts exactly once
        captureAt.answer = onAttemptOf(1);
        const sole = await lateEvent(paymentRequestId, paymentId);
        expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "lateSuccessId" = $1`, [sole.lateSuccessId])).toBe(1);
        expect((await readRecovery(o.obligationId)).body).toMatchObject({ recovered: 6100, outstanding: 0, status: 'recovered' });
        expect(await recoveryPayments(o.obligationId)).toBe(1);
      });

      it('S0-C12 item 14(c): an equal capture following a wrong-amount one on its attempt is never counted, and both facts present before finality count nothing', async () => {
        const { o, paymentRequestId, paymentId } = await failedChannel();
        const before = { recovered: 0, outstanding: 6100, status: 'open' };
        const wrong = await lateEvent(paymentRequestId, paymentId, { amount: 6200 });
        expect(await caseOf('late_success', wrong.lateSuccessId)).toMatchObject({ amount: '6200' });
        captureAt.answer = onAttemptOf(2);
        const equalAfter = await lateEvent(paymentRequestId, paymentId);
        expect(await caseOf('late_success', equalAfter.lateSuccessId)).toMatchObject({ amount: '6100', resolution: null });
        // both recorded together at finality: the late successes reach Billing in either order
        const [a, b] = [await lateEvent(paymentRequestId, paymentId), await lateEvent(paymentRequestId, paymentId, { amount: 6300 })];
        for (const l of [equalAfter, a, b]) expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "lateSuccessId" = $1`, [l.lateSuccessId])).toBe(0);
        await unchangedRecovery(o, before);
        expect(await restrictions()).toEqual([{ kind: 'T3', sourceId: o.obligationId }]);
        expect(await recoveredAudits(o.obligationId)).toBe(0);
      });

      it('S0-C12 item 14(a): a recovery already counted stands when a sibling arrives: the sibling never counts, T3 stays cleared, principal and surplus unchanged, and replays add nothing', async () => {
        const { o, paymentRequestId, paymentId } = await failedChannel();
        const counted = await lateEvent(paymentRequestId, paymentId);
        const after = { recovered: 6100, outstanding: 0, status: 'recovered' };
        expect((await readRecovery(o.obligationId)).body).toMatchObject(after);
        captureAt.answer = onAttemptOf(2);
        const sibling = await lateEvent(paymentRequestId, paymentId);
        expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "lateSuccessId" = $1`, [sibling.lateSuccessId])).toBe(0);
        await t.bus.deliver(counted.envelope);
        await reconcile();
        expect((await readRecovery(o.obligationId)).body).toMatchObject(after);
        expect(await recoveryPayments(o.obligationId)).toBe(1);
        expect(await surpluses(o.obligationId)).toBe(0);
        expect(await restrictions()).toEqual([]);
        expect(await recoveredAudits(o.obligationId)).toBe(1);
      });

      it('S0-C12: Payment unavailable or a read that proves nothing decides nothing for an equal capture; once Payment states the attempt ambiguous the worker opens the refund-only case, never a recovery', async () => {
        const { o, paymentRequestId, paymentId } = await failedChannel();
        for (const answer of [async (): Promise<CaptureReadOutcome> => { throw new Error('payment-service unavailable'); },
          async (): Promise<CaptureReadOutcome> => ({ kind: 'unknown', reason: 'inconsistent_capture_count' }),
          async (): Promise<CaptureReadOutcome> => ({ kind: 'ineligible_currency' })]) {
          captureAt.answer = answer;
          const u = await lateEvent(paymentRequestId, paymentId);
          expect(await count(`SELECT count(*) AS n FROM payment_late_success WHERE "lateSuccessId" = $1`, [u.lateSuccessId])).toBe(1);
          expect(await caseOf('late_success', u.lateSuccessId)).toBeUndefined();
        }
        await reconcile();
        expect(await recoveryPayments(o.obligationId)).toBe(0);
        captureAt.answer = onAttemptOf(2);
        await reconcile();
        expect(await recoveryPayments(o.obligationId)).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'late_success' AND "paymentId" = $1`, [paymentId])).toBe(3);
        await unchangedRecovery(o, { recovered: 0, outstanding: 6100, status: 'open' });
      });

      it('S0-C12 C-2: a recovery capture with no recorded late success has no refund route, whatever Payment says of it; nothing is opened and nothing moves', async () => {
        const { o, paymentId } = await failedChannel();
        const factId = randomUUID();
        paymentFacts.set(factId, { paymentId, amount: 6200, currency: 'TND', paymentStatus: 'failed' });
        const open = await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId, captureFactId: factId, reason: 'customer_request' });
        expect([open.status, open.body.code], JSON.stringify(open.body)).toEqual([409, 'refund_not_eligible']);
        expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "captureFactId" = $1`, [factId])).toBe(0);
        await unchangedRecovery(o, { recovered: 0, outstanding: 6100, status: 'open' });
      });

      it('D-B: only the excluded wrong-amount capture is refundable through the capture-specific route, for exactly its own figures; the counted capture, a contested one and a surplus never are; completion resolves its case once and changes no recovery figure', async () => {
        const { o, paymentRequestId, paymentId } = await failedChannel();
        const wrong = await lateEvent(paymentRequestId, paymentId, { amount: 6200 });
        const equal = await lateEvent(paymentRequestId, paymentId);
        const after = { recovered: 6100, outstanding: 0, status: 'recovered' };
        expect((await readRecovery(o.obligationId)).body).toMatchObject(after);
        const open = (factId: string, idem: string = key()) => send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', idem)
          .send({ paymentId, captureFactId: factId, reason: 'customer_request' });
        // the counted (equal) capture: never through this exception
        expect((await open(equal.factId)).status).toBeGreaterThanOrEqual(400);
        // a contested wrong-amount capture: refused (S0-C11 item 9)
        const wrongContested = await lateEvent(paymentRequestId, paymentId, { amount: 6300 });
        captureAt.answer = async (pid, factId) => (factId === wrongContested.factId ? contested(pid, factId, 6300) : captureAsPayment(pid, factId));
        expect((await open(wrongContested.factId)).status).toBeGreaterThanOrEqual(400);
        captureAt.answer = null;
        // the excluded capture: one case, for exactly 6200 TND; concurrent opens with one key and with two keys give one case
        const idem = key();
        const opened2 = await Promise.all([open(wrong.factId, idem), open(wrong.factId, idem), open(wrong.factId)]);
        expect(opened2.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
        const rc = opened2.find((r) => r.status === 201)!.body;
        expect(rc).toMatchObject({ eligibility: 'capture_specific', amount: 6200, currency: 'TND', capture: { captureFactId: wrong.factId, basis: 'late_capture' } });
        expect(await count(`SELECT count(*) AS n FROM refund_case WHERE "captureFactId" = $1`, [wrong.factId])).toBe(1);
        await send(request(server()).post(`/billing/admin/refund-cases/${rc.id}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') }).expect(201);
        expect(relayAnswer.bodies.at(-1)).toMatchObject({ refundCaseId: rc.id, captureFactId: wrong.factId, amount: 6200, currency: 'TND' });
        const att = await one(`SELECT id FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [rc.id]);
        const ev = randomUUID();
        const completed = { id: ev, name: 'refund.case_completed', payload: { refundCaseId: rc.id, refundAuthorizationId: randomUUID(), refundAttemptId: att.id, paymentId,
          paymentRequestId, producer: 'billing-service', approvedAmount: 6200, currency: 'TND', completedAt: new Date().toISOString(), liveMode: false,
          organizationId: ORG, purpose: 'recovery_settlement' }, headers: { eventId: ev, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } } as EventEnvelope;
        await t.bus.deliver(completed);
        await t.bus.deliver(completed);
        await t.app.get(RefundEffectService).drainOnce();
        await reconcile();
        await reconcile();
        expect(await caseOf('late_success', wrong.lateSuccessId)).toMatchObject({ resolution: 'refund_completed' });
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case_resolution r JOIN reconciliation_case c ON c.id = r."caseId" WHERE c."evidenceKey" = $1`,
          [wrong.lateSuccessId])).toBe(1);
        // nothing about the recovery changed: the same principal, no surplus, T3 cleared once, the counted capture still counted
        expect((await readRecovery(o.obligationId)).body).toMatchObject(after);
        expect(await recoveryPayments(o.obligationId)).toBe(1);
        expect(await surpluses(o.obligationId)).toBe(0);
        expect(await recoveredAudits(o.obligationId)).toBe(1);
        expect(await restrictions()).toEqual([]);
        // the refunded capture cannot be opened again; the counted one still cannot
        expect((await open(wrong.factId)).status).toBeGreaterThanOrEqual(400);
        expect((await open(equal.factId)).status).toBeGreaterThanOrEqual(400);
      });

      it('the database: D-1 refuses a recovery payment naming an unequal late success; D-B admits only an excluded, uncounted late capture for its own figures', async () => {
        const { o, paymentRequestId, paymentId } = await failedChannel();
        const wrong = await lateEvent(paymentRequestId, paymentId, { amount: 6200 });
        const insert = await admin.query(`INSERT INTO recovery_payment ("obligationId", "invoiceId", "paymentRequestId", "lateSuccessId", amount, currency)
            SELECT $1, pr."invoiceId", pr.id, $3, 6200, 'TND' FROM payment_request pr WHERE pr.id = $2`, [o.obligationId, paymentRequestId, wrong.lateSuccessId])
          .then(() => null, (e: { constraint?: string }) => e.constraint);
        expect(insert).toBe('recovery_payment_late_success_equal');
        const refundable = async (factId: string | null, basis: string, amount: number, currency = 'TND') =>
          (await one(`SELECT billing_recovery_capture_refundable($1, $2, $3, $4, $5) AS ok`, [paymentRequestId, factId, basis, amount, currency])).ok as boolean;
        expect(await refundable(wrong.factId, 'late_capture', 6200)).toBe(true);
        expect(await refundable(wrong.factId, 'late_capture', 6100), 'another amount').toBe(false);
        expect(await refundable(wrong.factId, 'late_capture', 6200, 'EUR'), 'another currency').toBe(false);
        expect(await refundable(wrong.factId, 'duplicate_capture', 6200), 'another basis').toBe(false);
        expect(await refundable(randomUUID(), 'late_capture', 6200), 'a fact no late success names').toBe(false);
        expect(await refundable(null, 'late_capture', 6200)).toBe(false);
        const equal = await lateEvent(paymentRequestId, paymentId);
        expect(await refundable(equal.factId, 'late_capture', 6100), 'the counted capture').toBe(false);
        // a direct insert of a capture-specific case for the counted capture is refused by the database too
        const rc = await admin.query(`INSERT INTO refund_case ("paymentId", "paymentRequestId", "invoiceId", eligibility, "companyId", "platformId", "organizationId", amount, currency,
            reason, "openedBy", "captureFactId", "captureBasis") SELECT $1, pr.id, pr."invoiceId", 'capture_specific', $3, $4, $5, 6100, 'TND', 'customer_request', $6, $7, 'late_capture'
            FROM payment_request pr WHERE pr.id = $2`, [paymentId, paymentRequestId, COMPANY, PLATFORM, ORG, U.owner, equal.factId]).then(() => null, (e: { constraint?: string }) => e.constraint);
        expect(rc).toBe('refund_case_not_eligible');
      });

      it('S0-C12 item 9: a Payment item of a kind no contract names for the read opens nothing and is logged; paging moves past it', async () => {
        const { paymentId } = await failedChannel();
        const stray = { ...asItem('late_success', { paymentId, factId: randomUUID(), amount: 6200, currency: 'TND', detail: { paymentStatus: 'failed', reason: 'amount_mismatch' } }), otherKind: 'capture_mismatch' }; // otherwise a well-formed late success
        put(stray);
        await reconcile();
        expect(await count(`SELECT count(*) AS n FROM payment_late_success WHERE "lateSuccessId" = $1`, [stray.id])).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "paymentId" = $1`, [paymentId])).toBe(0);
      });
    });

    describe('Core V2 S0-C10: repeated and excess chargeback losses (Constraint A per capture, Constraint B per assisted purchase; service and database level)', () => {
      const capOf = (disputeId: string) => one(`SELECT "captureKey", "beforeS0c10", gross::int AS gross, "chargebackAmount"::int AS "chargebackAmount", "sameCurrency",
        "cumulativeBefore"::int AS "cumulativeBefore", "withinCap", "firstFull" FROM capture_loss_cap WHERE "disputeId" = $1`, [disputeId]);
      const obligations = (purchaseId: string) => count(`SELECT count(*) AS n FROM recovery_obligation WHERE "purchaseId" = $1`, [purchaseId]);
      const lossRow = (disputeId: string) => one(`SELECT "chargebackAmount"::int AS "chargebackAmount", "chargebackCurrency", "chargebackFactId", "beforeS0c10" FROM payment_dispute_loss WHERE "disputeId" = $1`, [disputeId]);
      const acknowledge = (caseId: string) => send(request(server()).post(`/billing/admin/reconciliation-cases/${caseId}/acknowledgement`), 'owner-tok', key()).send({ reason: 'provider_statement_reviewed' });
      /** Payment's verified loss of an existing payment, recorded by Billing but NOT applied yet (the worker has not run). */
      const recordLoss = async (paymentId: string, purpose: 'assisted_settlement' | 'direct_purchase', amount: number, chargeback = amount) => {
        const id = randomUUID();
        const disputeId = randomUUID();
        const envelope = { id, name: 'payment.dispute.lost', payload: {
          disputeId, paymentId, paymentRequestId: randomUUID(), producer: 'billing-service', organizationId: null, purpose, amount, currency: 'TND',
          lostAt: new Date().toISOString(), chargeback: { factId: randomUUID(), amount: chargeback, currency: 'TND' }, liveMode: false,
        }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } } as EventEnvelope;
        await t.bus.deliver(envelope);
        return { disputeId, envelope };
      };
      /**
       * LABELLED FIXTURE (O-1): marks losses as recorded BEFORE migration 0049, as the migration marks every loss that existed when it ran
       * (`beforeS0c10` true). The append-only trigger is bypassed for this test-only edit (session_replication_role = replica, superuser).
       */
      const markBeforeS0c10 = async (...disputeIds: string[]) => {
        const cl = await admin.connect();
        try {
          await cl.query(`SET session_replication_role = replica`);
          await cl.query(`UPDATE payment_dispute_loss SET "beforeS0c10" = true WHERE "disputeId" = ANY($1::uuid[])`, [disputeIds]);
        } finally {
          await cl.query(`SET session_replication_role = origin`);
          cl.release();
        }
      };

      it('items 4, 5, 7: the first full loss opens ONE obligation; a second full loss of the capture opens none, is reviewed (repeated_loss), and is listed for the Owner with its whole recorded amount, forever open', async () => {
        const o = await opened();
        expect(await capOf(o.disputeId)).toMatchObject({ captureKey: `settling:${o.paymentId}`, beforeS0c10: false, gross: o.amount, chargebackAmount: o.amount, cumulativeBefore: 0, withinCap: true, firstFull: true });
        const second = await lose(o.paymentId, o.amount);
        expect(await recovery().visit(second)).toBe('review');
        expect(await reviewOf(second)).toEqual({ reason: 'repeated_loss' });
        expect(await obligations(o.purchaseId)).toBe(1);
        expect((await restrictions()).filter((r) => r.kind === 'T3')).toHaveLength(1);
        // every authentic debit stays recorded at its own figures, and its place in the capture's cumulative loss is the database's
        expect(await lossRow(second)).toMatchObject({ chargebackAmount: o.amount, chargebackCurrency: 'TND', beforeS0c10: false });
        expect(await capOf(second)).toMatchObject({ cumulativeBefore: o.amount, withinCap: false, firstFull: false, chargebackAmount: o.amount });
        await reconcile();
        const c = await caseOf('chargeback_loss_review', second);
        expect(c).toMatchObject({ companyId: COMPANY, organizationId: ORG, paymentId: o.paymentId, amount: String(o.amount), currency: 'TND', detail: 'repeated_loss', resolution: null });
        expect(await auditNames(c.id)).toEqual(['audit.reconciliation_case.opened']);
        expect((await audit(c.id))[0]!.payload.changes).toEqual({ case_type: 'chargeback_loss_review', evidence_id: second, amount: o.amount });
        // the Owner of the Company sees it; another Company's Owner does not; a member is refused
        expect((await cases('?type=chargeback_loss_review').expect(200)).body.items.map((i: Row) => i.id)).toContain(c.id);
        expect((await cases('?type=chargeback_loss_review', 'foreign-owner-tok').expect(200)).body.items).toEqual([]);
        expect((await send(request(server()).get(`/billing/admin/reconciliation-cases/${c.id}`), 'foreign-owner-tok', null)).status).toBe(404);
        expect((await cases('?type=chargeback_loss_review', 'member-tok')).status).toBe(403);
        // never acknowledged, resolved or closed by any mechanism; no liability is assigned to anyone
        expect((await acknowledge(c.id)).body).toMatchObject({ code: 'reconciliation_case_not_acknowledgeable' });
        for (const kind of ['acknowledged', 'effect_applied', 'loss_recognized', 'refund_completed']) {
          await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, $2, $3, $4)`,
            [c.id, kind, kind === 'acknowledged' ? U.owner : null, kind === 'acknowledged' ? 'reviewed_no_financial_effect' : null])).rejects.toThrow();
        }
        await reconcile();
        await recovery().drainOnce();
        expect(await caseOf('chargeback_loss_review', second)).toMatchObject({ resolution: null });
        expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE "disputeId" = $1 OR "obligationId" = $2`, [second, o.obligationId])).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "evidenceKey" = $1`, [second])).toBe(1); // one case for one observation
      });

      it('item 5: an obligation already RECOVERED still blocks another; a later full loss is repeated_loss and T3 is not reopened', async () => {
        const o = await opened();
        const c = (await settleRecovery(o.obligationId)).body;
        await recoveryEvent(c.paymentRequestId);
        expect((await obligationOf(o.disputeId)).status).toBe('recovered');
        expect(await restrictions()).toEqual([]);
        const later = await lose(o.paymentId, o.amount);
        expect(await recovery().visit(later)).toBe('review');
        expect(await reviewOf(later)).toEqual({ reason: 'repeated_loss' });
        expect(await obligations(o.purchaseId)).toBe(1);
        expect(await restrictions()).toEqual([]);
      });

      it('item 10 (Constraint A): a partial then a full loss: the partial stays partial_chargeback (acknowledgeable as before); the full one is above the cap: no obligation, no T3', async () => {
        const l = await assistedLoss({ partial: true });
        expect(await recovery().visit(l.disputeId)).toBe('review');
        expect(await reviewOf(l.disputeId)).toEqual({ reason: 'partial_chargeback' });
        const full = await lose(l.paymentId, l.amount);
        expect(await recovery().visit(full)).toBe('review');
        expect(await reviewOf(full)).toEqual({ reason: 'chargeback_exceeds_capture' });
        expect(await capOf(full)).toMatchObject({ cumulativeBefore: l.amount - 100, withinCap: false, firstFull: false });
        expect(await obligations(l.purchaseId)).toBe(0);
        expect(await restrictions()).toEqual([]);
        await reconcile();
        expect(await caseOf('partial_chargeback', l.disputeId)).toMatchObject({ resolution: null });
        expect(await caseOf('chargeback_loss_review', full)).toMatchObject({ detail: 'chargeback_exceeds_capture', amount: String(l.amount) });
        expect(await caseOf('chargeback_loss_review', l.disputeId)).toBeUndefined();
      });

      it('item 6 (F-07): a loss above the payment is a review on the first visit, never a failing pass; its whole authenticated amount stays recorded and listed', async () => {
        const r = await collected({ unit: 6100, fee: 400 });
        const s = await started(r.id);
        await t.bus.deliver(s.ev('payment.succeeded'));
        const amount = Number(s.inv.total);
        const d = await lose(s.paymentId, amount, amount + 2500);
        expect(await recovery().drainOnce()).toMatchObject({ failed: 0 });
        expect(await reviewOf(d)).toEqual({ reason: 'chargeback_exceeds_capture' });
        expect(await lossRow(d)).toMatchObject({ chargebackAmount: amount + 2500 });
        expect(await capOf(d)).toMatchObject({ gross: amount, chargebackAmount: amount + 2500, cumulativeBefore: 0, withinCap: false, firstFull: false });
        await reconcile();
        expect(await caseOf('chargeback_loss_review', d)).toMatchObject({ amount: String(amount + 2500), detail: 'chargeback_exceeds_capture' });
        expect(await restrictions()).toEqual([]);
      });

      it('duplicate delivery: the same loss again (event and Payment\'s losses read) is one loss, one cap row, one effect and one decision', async () => {
        const r = await collected({ unit: 6100, fee: 400 });
        const s = await started(r.id);
        await t.bus.deliver(s.ev('payment.succeeded'));
        const amount = Number(s.inv.total);
        const x = await recordLoss(s.paymentId, 'assisted_settlement', amount);
        await t.bus.deliver(x.envelope);
        await t.bus.deliver({ ...x.envelope, id: randomUUID(), headers: { ...x.envelope.headers, eventId: randomUUID() } });
        const p = x.envelope.payload as Row;
        lossesAtPayment.items = [{ disputeId: x.disputeId, paymentId: s.paymentId, amount, currency: 'TND', lostAt: p.lostAt, chargeback: p.chargeback } as PaymentDisputeLoss];
        await losses().drainOnce();
        await losses().drainOnce();
        await recovery().drainOnce();
        await recovery().drainOnce();
        expect(await count(`SELECT count(*) AS n FROM payment_dispute_loss WHERE "paymentId" = $1`, [s.paymentId])).toBe(1);
        expect(await count(`SELECT count(*) AS n FROM capture_loss_cap WHERE "disputeId" = $1`, [x.disputeId])).toBe(1);
        expect(await count(`SELECT count(*) AS n FROM dispute_loss_effect WHERE "disputeId" = $1`, [x.disputeId])).toBe(1);
        expect(await count(`SELECT count(*) AS n FROM recovery_obligation WHERE "disputeId" = $1`, [x.disputeId])).toBe(1);
      });

      it('item 4 (O-4): a direct write-off waits for the committed reversal, then once per capture; a second full loss is reviewed with no second reversal or write-off', async () => {
        const p = await directPurchase('b2');
        const first = await recordLoss(p.paymentId, 'direct_purchase', p.amount);
        await reconcile(); // the reversal is not committed yet: no write-off
        expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE "paymentId" = $1`, [p.paymentId])).toBe(0);
        await losses().drainOnce();
        expect(await one(`SELECT outcome FROM dispute_loss_effect WHERE "disputeId" = $1`, [first.disputeId])).toEqual({ outcome: 'reversed_purchase' });
        await reconcile();
        await reconcile();
        expect((await admin.query(`SELECT "disputeId", amount::int AS amount FROM financial_loss WHERE "paymentId" = $1`, [p.paymentId])).rows).toEqual([{ disputeId: first.disputeId, amount: p.amount }]);
        const second = await loseDirect(p.paymentId, p.amount);
        expect(await one(`SELECT state, reason FROM dispute_loss_effect_attempt WHERE "disputeId" = $1`, [second])).toEqual({ state: 'review', reason: 'reversed_by_another_chargeback' });
        await reconcile();
        await reconcile();
        expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE "paymentId" = $1`, [p.paymentId])).toBe(1);
        expect(await count(`SELECT count(*) AS n FROM subscription_purchase_reversal r JOIN subscription_purchase s ON s.id = r."purchaseId" WHERE s."paymentRequestId" = $1`, [p.paymentRequestId])).toBe(1);
        expect(await caseOf('contradictory_effect', second)).toMatchObject({ detail: 'dispute_effect_review', resolution: null });
        expect(await lossRow(second)).toMatchObject({ chargebackAmount: p.amount });
      });

      it('item 6: direct partials whose sum exceeds the capture: the first is partial (acknowledgeable as before), the second is above the cap and never acknowledgeable; nothing is reversed or written off', async () => {
        const p = await directPurchase('b1');
        const a = await loseDirect(p.paymentId, p.amount, p.amount - 1000);
        const b = await loseDirect(p.paymentId, p.amount, p.amount - 1000);
        expect(await one(`SELECT reason FROM dispute_loss_effect_attempt WHERE "disputeId" = $1`, [a])).toEqual({ reason: 'partial_chargeback_threshold_open' });
        expect(await one(`SELECT reason FROM dispute_loss_effect_attempt WHERE "disputeId" = $1`, [b])).toEqual({ reason: 'chargeback_exceeds_capture' });
        await reconcile();
        expect(await caseOf('partial_chargeback', a)).toMatchObject({ resolution: null });
        const cb = await caseOf('contradictory_effect', b);
        expect(cb).toMatchObject({ detail: 'dispute_effect_review', resolution: null });
        expect((await acknowledge(cb.id)).body).toMatchObject({ code: 'reconciliation_case_not_acknowledgeable' });
        expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE "paymentId" = $1`, [p.paymentId])).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM dispute_loss_effect WHERE "disputeId" = ANY($1::uuid[])`, [[a, b]])).toBe(0);
      });

      it('concurrency: eight workers over two full losses of one purchase open ONE obligation (audited once) and review the other; eight concurrent cap rows of one capture sum exactly', async () => {
        const r = await collected({ unit: 6100, fee: 400 });
        const s = await started(r.id);
        await t.bus.deliver(s.ev('payment.succeeded'));
        const amount = Number(s.inv.total);
        const purchase = await purchaseOf(s.paymentId);
        const a = await recordLoss(s.paymentId, 'assisted_settlement', amount);
        const b = await recordLoss(s.paymentId, 'assisted_settlement', amount);
        await Promise.all([losses().apply(a.disputeId), losses().apply(b.disputeId)]);
        const outs = await Promise.all(Array.from({ length: 8 }, (_, i) => recovery().visit(i % 2 ? a.disputeId : b.disputeId)));
        expect(outs.filter((o) => o === 'opened')).toHaveLength(1);
        expect(await obligations(purchase.id)).toBe(1);
        const o = await one(`SELECT id, "disputeId" FROM recovery_obligation WHERE "purchaseId" = $1`, [purchase.id]);
        expect(await auditNames(o.id)).toEqual(['audit.recovery_obligation.opened']);
        const other = o.disputeId === a.disputeId ? b.disputeId : a.disputeId;
        expect(await reviewOf(other)).toEqual({ reason: 'repeated_loss' });
        expect(await capOf(o.disputeId as string)).toMatchObject({ firstFull: true });
        // eight partial losses of one direct capture, their cap rows written by eight concurrent transactions
        const p = await directPurchase('b2');
        const ds = [];
        for (let i = 0; i < 8; i++) ds.push((await recordLoss(p.paymentId, 'direct_purchase', p.amount, 700)).disputeId);
        await Promise.all(ds.map((d) => admin.query(`INSERT INTO capture_loss_cap ("disputeId") VALUES ($1)`, [d])));
        const rows = (await admin.query(`SELECT "cumulativeBefore"::int AS c, "withinCap" FROM capture_loss_cap WHERE "disputeId" = ANY($1::uuid[]) ORDER BY 1`, [ds])).rows;
        expect(rows.map((x) => x.c)).toEqual([0, 700, 1400, 2100, 2800, 3500, 4200, 4900]);
        expect(rows.map((x) => x.withinCap)).toEqual(rows.map((x) => x.c + 700 <= p.amount));
      });

      it('order of visits: the later loss visited FIRST is still repeated_loss (the evidence decides, not which worker ran first); the first then opens the one obligation', async () => {
        const r = await collected({ unit: 6100, fee: 400 });
        const s = await started(r.id);
        await t.bus.deliver(s.ev('payment.succeeded'));
        const amount = Number(s.inv.total);
        const purchase = await purchaseOf(s.paymentId);
        const a = await recordLoss(s.paymentId, 'assisted_settlement', amount);
        expect(await losses().apply(a.disputeId)).toMatchObject({ reason: 'assisted_purchase_preserved' });
        const b = await recordLoss(s.paymentId, 'assisted_settlement', amount);
        expect(await losses().apply(b.disputeId)).toMatchObject({ reason: 'assisted_purchase_preserved' });
        expect(await capOf(a.disputeId)).toMatchObject({ firstFull: true });
        expect(await capOf(b.disputeId)).toMatchObject({ firstFull: false, cumulativeBefore: amount });
        expect(await recovery().visit(b.disputeId)).toBe('review');
        expect(await reviewOf(b.disputeId)).toEqual({ reason: 'repeated_loss' });
        expect(await obligations(purchase.id)).toBe(0);
        expect(await recovery().visit(a.disputeId)).toBe('opened');
        expect(await obligations(purchase.id)).toBe(1);
      });

      it('crash and retry: a cap row written before a crash is used once; replays and repeated passes decide nothing twice', async () => {
        const r = await collected({ unit: 6100, fee: 400 });
        const s = await started(r.id);
        await t.bus.deliver(s.ev('payment.succeeded'));
        const amount = Number(s.inv.total);
        const x = await recordLoss(s.paymentId, 'assisted_settlement', amount);
        // CONTROLLED FAILURE: the cap row committed, the worker stopped before its decision (as after a crash between the two transactions)
        await admin.query(`INSERT INTO capture_loss_cap ("disputeId") VALUES ($1)`, [x.disputeId]);
        expect(await losses().apply(x.disputeId)).toEqual({ kind: 'applied', outcome: 'none', reason: 'assisted_purchase_preserved' });
        expect(await losses().apply(x.disputeId)).toEqual({ kind: 'already_applied' });
        expect(await recovery().visit(x.disputeId)).toBe('opened');
        expect(await recovery().visit(x.disputeId)).toBe('already');
        expect(await count(`SELECT count(*) AS n FROM capture_loss_cap WHERE "disputeId" = $1`, [x.disputeId])).toBe(1);
        // a direct loss: the same, through the dispute-loss worker
        const p = await directPurchase('b1');
        const y = await recordLoss(p.paymentId, 'direct_purchase', p.amount);
        await admin.query(`INSERT INTO capture_loss_cap ("disputeId") VALUES ($1)`, [y.disputeId]);
        expect(await losses().apply(y.disputeId)).toMatchObject({ kind: 'applied', outcome: 'reversed_purchase' });
        expect(await losses().apply(y.disputeId)).toEqual({ kind: 'already_applied' });
        await reconcile();
        await reconcile();
        expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE "paymentId" = $1`, [p.paymentId])).toBe(1);
      });

      it('the database alone (guards bypassed where stated): Constraint B by uniqueness, Constraint A by the obligation guard, one write-off per capture, reasons proven, the cap row derived and append-only', async () => {
        const insertObligation = (disputeId: string, purchaseId: string, b: Row) => admin.query(`INSERT INTO recovery_obligation ("disputeId", "assistanceRequestId", "purchaseId",
          "organizationId", "companyId", "platformId", "baseAmount", currency) VALUES ($1, $2, $3, $4, $5, $6, $7, 'TND')`, [disputeId, b.assistanceRequestId, purchaseId, b.organizationId, b.companyId, b.platformId, b.baseAmount]);
        // Constraint A, independently: a purchase with NO obligation, whose full loss follows a partial (above the cap)
        const l = await assistedLoss({ partial: true });
        const full = await lose(l.paymentId, l.amount);
        const lb = await one(`SELECT s."assistanceRequestId", a."organizationId", $2::uuid AS "companyId", a."platformId", a."baseAmount" FROM subscription_purchase s
          JOIN assistance_request a ON a.id = s."assistanceRequestId" WHERE s.id = $1`, [l.purchaseId, COMPANY]);
        await expect(insertObligation(full, l.purchaseId, lb)).rejects.toMatchObject({ constraint: 'recovery_obligation_loss_cap' });
        // a review reason must be proven by its evidence
        await expect(admin.query(`INSERT INTO recovery_review ("disputeId", reason) VALUES ($1, 'repeated_loss')`, [full])).rejects.toMatchObject({ constraint: 'recovery_review_evidence' });
        await expect(admin.query(`INSERT INTO recovery_review ("disputeId", reason) VALUES ($1, 'chargeback_exceeds_capture')`, [l.disputeId])).rejects.toMatchObject({ constraint: 'recovery_review_evidence' });
        // a direct write-off only for a loss that reversed its purchase; a second one for the capture refused even with every trigger disabled
        const p = await directPurchase('b2');
        const d1 = await loseDirect(p.paymentId, p.amount);
        await reconcile();
        const d2 = await loseDirect(p.paymentId, p.amount);
        const lossFor = (disputeId: string) => one(`SELECT "chargebackFactId" FROM payment_dispute_loss WHERE "disputeId" = $1`, [disputeId]);
        const directWriteOff = async (q: pg.Pool | pg.PoolClient, disputeId: string) => q.query(`INSERT INTO financial_loss (kind, "evidenceKey", "companyId", "paymentId", "disputeId", amount, currency)
          VALUES ('direct_chargeback_write_off', $1, $2, $3, $4, $5, 'TND')`, [(await lossFor(disputeId)).chargebackFactId, COMPANY, p.paymentId, disputeId, p.amount]);
        await expect(directWriteOff(admin, d2)).rejects.toMatchObject({ constraint: 'financial_loss_reversal' });
        const c2 = await admin.connect();
        try {
          await c2.query(`SET session_replication_role = replica`);
          await expect(directWriteOff(c2, d2)).rejects.toMatchObject({ constraint: 'financial_loss_direct_write_off_capture' });
        } finally {
          await c2.query(`SET session_replication_role = origin`);
          c2.release();
        }
        expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE "paymentId" = $1`, [p.paymentId])).toBe(1);
        expect(await one(`SELECT "disputeId" FROM financial_loss WHERE "paymentId" = $1`, [p.paymentId])).toEqual({ disputeId: d1 });
        // the cap row: any value a caller supplies is replaced by the database's; the row and the loss are append-only
        const r = await collected({ unit: 6100, fee: 400 });
        const s = await started(r.id);
        await t.bus.deliver(s.ev('payment.succeeded'));
        const x = await recordLoss(s.paymentId, 'assisted_settlement', Number(s.inv.total), 50);
        await admin.query(`INSERT INTO capture_loss_cap ("disputeId", "captureKey", "beforeS0c10", gross, currency, "chargebackAmount", "sameCurrency", "cumulativeBefore", "withinCap", "firstFull")
          VALUES ($1, 'forged', true, 50, 'TND', 50, true, 0, true, true)`, [x.disputeId]);
        expect(await capOf(x.disputeId)).toMatchObject({ captureKey: `settling:${s.paymentId}`, beforeS0c10: false, gross: Number(s.inv.total), chargebackAmount: 50, cumulativeBefore: 0, withinCap: true, firstFull: false });
        await expect(admin.query(`UPDATE capture_loss_cap SET "firstFull" = true WHERE "disputeId" = $1`, [x.disputeId])).rejects.toThrow(/append-only/);
        await expect(admin.query(`DELETE FROM capture_loss_cap WHERE "disputeId" = $1`, [x.disputeId])).rejects.toThrow(/append-only/);
        await expect(admin.query(`UPDATE payment_dispute_loss SET "chargebackAmount" = 1 WHERE "disputeId" = $1`, [x.disputeId])).rejects.toThrow(/append-only/);
        // a new loss can never claim to predate S0-C10
        expect(await lossRow(x.disputeId)).toMatchObject({ beforeS0c10: false });
        // Constraint B, last (its obligation restricts the Organization's new requests, T3)
        const o = await opened();
        const second = await lose(o.paymentId, o.amount);
        const base = await one(`SELECT "assistanceRequestId", "organizationId", "companyId", "platformId", "baseAmount" FROM recovery_obligation WHERE id = $1`, [o.obligationId]);
        // Constraint B holds even with every trigger disabled (the uniqueness is not application logic)
        const cl = await admin.connect();
        try {
          await cl.query(`SET session_replication_role = replica`);
          await expect(cl.query(`INSERT INTO recovery_obligation ("disputeId", "assistanceRequestId", "purchaseId", "organizationId", "companyId", "platformId", "baseAmount", currency)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'TND')`, [second, base.assistanceRequestId, o.purchaseId, base.organizationId, base.companyId, base.platformId, base.baseAmount]))
            .rejects.toMatchObject({ constraint: 'recovery_obligation_purchase' });
        } finally {
          await cl.query(`SET session_replication_role = origin`);
          cl.release();
        }
      });

      /** A database migrated up to 0048 (before S0-C10), seeded by `seed` through a superuser session with triggers off, then fully migrated. */
      const before0049 = async (name: string, seed: (c: pg.Client) => Promise<void>) => {
        const pre = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, name);
        const dir = mkdtempSync(join(tmpdir(), 'billing-pre-0049-'));
        const c = new pg.Client({ connectionString: pre.url });
        try {
          for (const f of readdirSync(billingMigrationsDir)) if (f < '0049') copyFileSync(join(billingMigrationsDir, f), join(dir, f));
          await runMigrations(pre.url, [kitMigrationsDir, dir]);
          await c.connect();
          await c.query(`SET session_replication_role = replica`);
          await seed(c);
          await c.query(`SET session_replication_role = origin`);
          const migrated = await runMigrations(pre.url, [kitMigrationsDir, billingMigrationsDir]).then(() => null, (e: Error) => e);
          return { migrated, c, pre };
        } catch (e) {
          await c.end().catch(() => undefined);
          await pre.drop();
          throw e;
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };
      const lossSql = `INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackFactId", "chargebackAmount",
        "chargebackCurrency", "lostAt", source, "captureBasis") VALUES ($1, $2, $3, 5600, 'TND', $4, 5600, 'TND', now(), 'reconciliation', 'settling_capture')`;

      it('item 13: historical duplicate obligations, or two direct write-offs of one capture, refuse migration 0049, which changes nothing', async () => {
        for (const kind of ['obligations', 'write_offs'] as const) {
          const purchaseId = randomUUID();
          const paymentId = randomUUID();
          const { migrated, c, pre } = await before0049(`billings0c10dup${kind === 'obligations' ? 'o' : 'w'}`, async (q) => {
            for (let i = 0; i < 2; i++) {
              if (kind === 'obligations') {
                await q.query(`INSERT INTO recovery_obligation ("disputeId", "assistanceRequestId", "purchaseId", "organizationId", "companyId", "platformId", "baseAmount", currency)
                  VALUES ($1, $2, $3, $4, $5, $6, 6100, 'TND')`, [randomUUID(), randomUUID(), purchaseId, randomUUID(), COMPANY, PLATFORM]);
              } else {
                await q.query(`INSERT INTO financial_loss (kind, "evidenceKey", "companyId", "paymentId", "disputeId", amount, currency)
                  VALUES ('direct_chargeback_write_off', $1, $2, $3, $4, 4900, 'TND')`, [randomUUID(), COMPANY, paymentId, randomUUID()]);
              }
            }
          });
          try {
            // the runner reports the file and the code only (never the database's text); the preflight raises P0001, so this is its refusal,
            // not a later unique constraint failing on the duplicates (23505)
            expect(migrated?.message).toMatch(/^0049_s0c10_chargeback_loss_cap\.sql failed and was rolled back: .*code=P0001$/);
            expect((await c.query(`SELECT count(*)::int AS n FROM schema_migrations WHERE name = '0049_s0c10_chargeback_loss_cap.sql'`)).rows[0].n).toBe(0);
            expect((await c.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'payment_dispute_loss' AND column_name = 'beforeS0c10'`)).rows[0].n).toBe(0);
            expect((await c.query(`SELECT to_regclass('capture_loss_cap') AS t`)).rows[0].t).toBeNull();
            expect((await c.query(kind === 'obligations' ? `SELECT count(*)::int AS n FROM recovery_obligation WHERE "purchaseId" = $1` : `SELECT count(*)::int AS n FROM financial_loss WHERE "paymentId" = $1`,
              [kind === 'obligations' ? purchaseId : paymentId])).rows[0].n).toBe(2);
          } finally {
            await c.end();
            await pre.drop();
          }
        }
      });

      it('O-1: migration 0049 marks every existing loss as recorded before S0-C10 without writing it; a later loss is never marked so', async () => {
        const id = randomUUID();
        let before: Row = {};
        const { migrated, c, pre } = await before0049('billings0c10mark', async (q) => {
          await q.query(lossSql, [id, randomUUID(), randomUUID(), randomUUID()]);
          before = (await q.query(`SELECT xmin::text AS xmin, ctid::text AS ctid FROM payment_dispute_loss WHERE "disputeId" = $1`, [id])).rows[0];
        });
        try {
          expect(migrated).toBeNull();
          expect((await c.query(`SELECT "beforeS0c10", xmin::text AS xmin, ctid::text AS ctid FROM payment_dispute_loss WHERE "disputeId" = $1`, [id])).rows[0])
            .toEqual({ beforeS0c10: true, ...before });
          expect((await c.query(`SELECT count(*)::int AS n FROM capture_loss_cap`)).rows[0].n).toBe(0); // no historical ledger row is generated
        } finally {
          await c.end();
          await pre.drop();
        }
        // in this suite's database: a loss inserted claiming to predate S0-C10 is marked as it is (the trigger decides, not the caller)
        const p = await directPurchase('b1');
        const x = await recordLoss(p.paymentId, 'direct_purchase', p.amount, 10);
        const forged = randomUUID();
        await admin.query(`INSERT INTO payment_dispute_loss ("disputeId", "paymentId", "paymentRequestId", "disputeAmount", currency, "chargebackFactId", "chargebackAmount",
          "chargebackCurrency", "lostAt", source, "captureBasis", "beforeS0c10")
          SELECT $1, "paymentId", "paymentRequestId", "disputeAmount", currency, gen_random_uuid(), 10, "chargebackCurrency", "lostAt", 'reconciliation', "captureBasis", true
            FROM payment_dispute_loss WHERE "disputeId" = $2`, [forged, x.disputeId]);
        expect(await lossRow(forged)).toMatchObject({ beforeS0c10: false });
      });

      describe('O-1 Option B: losses recorded before 0049 (LABELLED FIXTURE: marked as the migration marks them)', () => {
        it('a capture\'s ONLY historical loss, not yet visited, is provably its first: R6F-8 still opens its obligation', async () => {
          const r = await collected({ unit: 6100, fee: 400 });
          const s = await started(r.id);
          await t.bus.deliver(s.ev('payment.succeeded'));
          const x = await recordLoss(s.paymentId, 'assisted_settlement', Number(s.inv.total));
          await markBeforeS0c10(x.disputeId);
          await losses().drainOnce();
          expect(await recovery().visit(x.disputeId)).toBe('opened');
          expect(await capOf(x.disputeId)).toMatchObject({ beforeS0c10: true, cumulativeBefore: 0, withinCap: true, firstFull: true });
        });

        it('two historical full losses of one capture: their order cannot be proven, so NEITHER opens an obligation; both are kept and reviewed', async () => {
          const r = await collected({ unit: 6100, fee: 400 });
          const s = await started(r.id);
          await t.bus.deliver(s.ev('payment.succeeded'));
          const amount = Number(s.inv.total);
          const purchase = await purchaseOf(s.paymentId);
          const a = await recordLoss(s.paymentId, 'assisted_settlement', amount);
          const b = await recordLoss(s.paymentId, 'assisted_settlement', amount);
          await markBeforeS0c10(a.disputeId, b.disputeId);
          await losses().drainOnce();
          await recovery().drainOnce();
          for (const d of [a.disputeId, b.disputeId]) {
            expect(await capOf(d)).toMatchObject({ beforeS0c10: true, cumulativeBefore: null, withinCap: false, firstFull: false, chargebackAmount: amount });
            expect(await reviewOf(d)).toEqual({ reason: 'chargeback_exceeds_capture' });
          }
          expect(await obligations(purchase.id)).toBe(0);
          await reconcile();
          expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'chargeback_loss_review' AND "evidenceKey" = ANY($1::uuid[])`, [[a.disputeId, b.disputeId]])).toBe(2);
        });

        it('a loss after S0-C10 follows EVERY historical loss of its capture: a committed historical obligation makes it repeated_loss, counted after the historical amount', async () => {
          const r = await collected({ unit: 6100, fee: 400 });
          const s = await started(r.id);
          await t.bus.deliver(s.ev('payment.succeeded'));
          const amount = Number(s.inv.total);
          const old = await recordLoss(s.paymentId, 'assisted_settlement', amount);
          await markBeforeS0c10(old.disputeId);
          await losses().drainOnce();
          expect(await recovery().visit(old.disputeId)).toBe('opened');
          // LABELLED FIXTURE: an obligation committed before 0049 has no cap row (the pre-0049 worker never wrote one); its row is removed
          // here (superuser, triggers off) so the obligation alone, not a first-full cap row, is the evidence the later loss meets
          const cl = await admin.connect();
          try {
            await cl.query(`SET session_replication_role = replica`);
            await cl.query(`DELETE FROM capture_loss_cap WHERE "disputeId" = $1`, [old.disputeId]);
          } finally {
            await cl.query(`SET session_replication_role = origin`);
            cl.release();
          }
          const later = await lose(s.paymentId, amount, 300);
          expect(await capOf(later)).toMatchObject({ beforeS0c10: false, cumulativeBefore: amount, withinCap: false });
          expect(await recovery().visit(later)).toBe('review');
          expect(await reviewOf(later)).toEqual({ reason: 'repeated_loss' });
        });

        it('a historical loss already in review keeps exactly that review: no cap row, no new reason, no second case, its case still open', async () => {
          const p = await directPurchase('b2');
          // two partials whose sum exceeds the capture, both reviewed by the pre-0049 worker (LABELLED FIXTURE: its review rows, as it wrote
          // them, with no cap row); under S0-C10 the second would be chargeback_exceeds_capture, but a recorded review is never re-derived
          const a = await recordLoss(p.paymentId, 'direct_purchase', p.amount, p.amount - 1000);
          const b = await recordLoss(p.paymentId, 'direct_purchase', p.amount, p.amount - 1000);
          await markBeforeS0c10(a.disputeId, b.disputeId);
          for (const d of [a.disputeId, b.disputeId]) {
            await admin.query(`INSERT INTO dispute_loss_effect_attempt ("disputeId", state, reason, "workAfter") VALUES ($1, 'review', 'partial_chargeback_threshold_open', now())`, [d]);
          }
          await reconcile();
          const before = await caseOf('partial_chargeback', b.disputeId);
          expect(before).toMatchObject({ resolution: null });
          await losses().drainOnce();
          for (const d of [a.disputeId, b.disputeId]) {
            expect(await losses().apply(d)).toEqual({ kind: 'review', reason: 'partial_chargeback_threshold_open' });
            expect(await one(`SELECT state, reason FROM dispute_loss_effect_attempt WHERE "disputeId" = $1`, [d])).toEqual({ state: 'review', reason: 'partial_chargeback_threshold_open' });
            expect(await count(`SELECT count(*) AS n FROM capture_loss_cap WHERE "disputeId" = $1`, [d])).toBe(0);
          }
          await reconcile();
          expect(await caseOf('partial_chargeback', b.disputeId)).toMatchObject({ id: before.id, resolution: null });
          expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "evidenceKey" = $1`, [b.disputeId])).toBe(1);
          // a NEW loss of that capture still counts both historical amounts before it
          const later = await loseDirect(p.paymentId, p.amount, 100);
          expect(await capOf(later)).toMatchObject({ cumulativeBefore: 2 * (p.amount - 1000), withinCap: false });
        });
      });
    });

    it('isolation and authority: another Company sees nothing; a member is refused; the database refuses an unsupported resolution and any edit', async () => {
      const p = await directPurchase('b2');
      const factId = randomUUID();
      put(asItem('over_return', { paymentId: p.paymentId, factId, amount: 100, currency: 'TND' }));
      put(asItem('refund_discrepancy', { paymentId: p.paymentId, amount: p.amount, currency: 'TND' }));
      await reconcile();
      const c = await caseOf('over_return', factId);
      expect((await cases('', 'foreign-owner-tok').expect(200)).body.items).toEqual([]);
      expect((await send(request(server()).get(`/billing/admin/reconciliation-cases/${c.id}`), 'foreign-owner-tok', null)).status).toBe(404);
      expect((await cases('', 'member-tok')).status).toBe(403);
      expect((await cases('?status=closed')).body).toMatchObject({ code: 'invalid_reconciliation_request' });
      await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, 'acknowledged', $2, 'reviewed_no_financial_effect')`,
        [(await caseOf('late_success', randomUUID()))?.id ?? c.id, U.owner])).rejects.toThrow();
      await expect(admin.query(`UPDATE reconciliation_case SET amount = 1 WHERE id = $1`, [c.id])).rejects.toThrow();
      await expect(admin.query(`INSERT INTO financial_loss (kind, "evidenceKey", "companyId", "paymentId", amount, currency) VALUES ('over_return', $1, $2, $3, 1, 'TND')`,
        [randomUUID(), OTHER_COMPANY, p.paymentId])).rejects.toMatchObject({ constraint: 'financial_loss_evidence' });
      await expect(admin.query(`INSERT INTO financial_loss (kind, "evidenceKey", "companyId", "obligationId", amount, currency, "recordedByUserId", "receiptId", "consumeRef")
        VALUES ('recovery_write_off', gen_random_uuid(), $1, gen_random_uuid(), 1, 'TND', gen_random_uuid(), gen_random_uuid(), gen_random_uuid())`, [COMPANY])).rejects.toThrow();
    });

    it('production mounts no reconciliation route, worker or late-success handler', () => {
      expect(ReconciliationModule.register({ isProduction: true } as BillingConfig)).toEqual({ module: ReconciliationModule });
    });
  });

  it('no expiry or offset; a write-off exists only as S6h-B\'s FinancialLoss (accounting), never on the obligation itself', async () => {
    // Core V2 S6h-B (R6H-7, R6H-8): the losses are their own append-only tables; the obligation and its surplus have no write-off column
    expect((await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* '(financial_loss|write_off|writeoff)' ORDER BY 1`)).rows
      .map((r) => r.table_name)).toEqual(['financial_loss', 'financial_loss_adjustment']);
    expect(await count(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name ~ '^recovery_' AND column_name ~* '(write|forgiv)'`)).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name ~ '^recovery_' AND column_name ~* '(expir|offset|revenue)'`)).toBe(0);
  });

  it('production mounts no recovery route and no worker', () => {
    expect(RecoveryModule.register({ isProduction: true } as BillingConfig)).toEqual({ module: RecoveryModule });
  });
});

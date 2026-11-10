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
import type { CaptureReadOutcome, PaymentRefundClient, PaymentRefunds } from '../src/refunds/payment-refund-client.js';
import { RefundRelayReconciler } from '../src/refunds/refund-relay-reconciler.js';
import { FinancialSafetyCheck } from '../src/refunds/financial-safety.js';
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

/** Core V2 S0-C14: Payment's PAY-08 answers, per payment (a `null` answer is Payment's 404). */
const pay08 = { answers: new Map<string, PaymentRefunds | null | 'down'>(), down: false, calls: [] as string[] };

/** Core V2 S6d: Payment's refund port, authorizing every relayed attempt (the S6b/S6c Payment behaviour is certified in its own suites). */
const relayAnswer = { unknown: false, bodies: [] as Record<string, unknown>[], status: null as null | string }; // Core V2 DO-73: `status` overrides Payment's answer (an Auth-refused attempt)
const refundsAtPayment: PaymentRefundClient = {
  relay: async (_paymentId, _key, body) => {
    relayAnswer.bodies.push({ ...body, receiptSecret: undefined });
    if (relayAnswer.unknown) return { kind: 'unknown', reason: 'status_0' }; // Core V2 S6h-B: Payment's answer lost (Q8 tests)
    return { kind: 'attempt', attempt: { refundAttemptId: body.refundAttemptId, status: (relayAnswer.status ?? 'authorized') as never, approvedBy: relayAnswer.status ? null : { userId: randomUUID() } } };
  },
  // Core V2 S0-C14: Payment's PAY-08 answer per payment under test control (default: nothing refunded, nothing attempted); `down` makes it fail
  refunds: async (paymentId) => {
    const a = pay08.answers.get(paymentId);
    if (pay08.down || a === 'down') throw new Error('payment unavailable');
    return a === undefined ? { attempts: [], refusals: [], authorizations: [], unallocatedFacts: [] } : a;
  },
  capture: async (paymentId, factId) => {
    captureAt.calls.push([paymentId, factId]);
    return captureAt.answer ? captureAt.answer(paymentId, factId) : captureAsPayment(paymentId, factId);
  },
  settlingCapture: async () => ({ kind: 'unknown' as const, reason: 'not_used_in_this_suite' }), // Core V2 S0-C11 7c: no E-7 application here
};

/** Core V2 S6h-B: Payment's reconciliation read (PAY-12) under test control: items per kind, or Payment unavailable. */
const paymentItems = { items: new Map<PaymentItemKind, PaymentItem[]>(), down: false,
  unsupported: new Set<string>(), asked: new Set<string>() }; // Core V2 S0-C15B: a Payment older than a kind answers 400 for it; the kinds Billing asked for
const paymentReconciliation: PaymentReconciliationClient = {
  items: async (kind, after, limit) => {
    paymentItems.asked.add(kind);
    if (paymentItems.down) throw new Error('payment-service unavailable');
    if (paymentItems.unsupported.has(kind)) throw new Error('payment reconciliation read failed (status 400)');
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
    pay08.answers.clear();
    pay08.down = false;
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

      it('items 4, 5, 7: the first full loss opens ONE obligation; a second full loss of the capture opens none, is reviewed (repeated_loss), and is listed for the Owner with its whole recorded amount, unresolved and unacknowledgeable through every pass this test runs', async () => {
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

      it('C-1 (O-1): a loss recorded before 0049 that already has its cap row is counted ONCE by every later loss of its capture; the decision, the recorded debits and every committed effect follow from that', async () => {
        const capRow = (disputeId: string) => one(`SELECT xmin::text AS xmin, "cumulativeBefore"::int AS "cumulativeBefore", "withinCap", "firstFull" FROM capture_loss_cap WHERE "disputeId" = $1`, [disputeId]);
        const lossFacts = (disputeIds: string[]) => admin.query(`SELECT "disputeId", "chargebackFactId", "chargebackAmount"::int AS amount, "beforeS0c10", xmin::text AS xmin
          FROM payment_dispute_loss WHERE "disputeId" = ANY($1::uuid[]) ORDER BY "disputeId"`, [disputeIds]).then((r) => r.rows);
        // (a) assisted, partials: 3000 historical (cap row written when first visited after 0049) + 3000 later = 6000 within the gross,
        // so the later loss is partial_chargeback; counting the historical loss twice (9000) would wrongly make it chargeback_exceeds_capture
        const r = await collected({ unit: 6100, fee: 400 });
        const s = await started(r.id);
        await t.bus.deliver(s.ev('payment.succeeded'));
        const amount = Number(s.inv.total);
        expect(amount >= 6000 && amount < 9000, `the gross ${amount} must separate counting once (6000) from twice (9000)`).toBe(true);
        const h = await recordLoss(s.paymentId, 'assisted_settlement', amount, 3000);
        await markBeforeS0c10(h.disputeId);
        await losses().drainOnce();
        expect(await recovery().visit(h.disputeId)).toBe('review');
        expect(await reviewOf(h.disputeId)).toEqual({ reason: 'partial_chargeback' });
        const hRow = await capRow(h.disputeId);
        expect(hRow).toMatchObject({ cumulativeBefore: 0, withinCap: true, firstFull: false });
        const before = await lossFacts([h.disputeId]);
        const n = await recordLoss(s.paymentId, 'assisted_settlement', amount, 3000);
        await losses().drainOnce();
        expect(await capOf(n.disputeId)).toMatchObject({ beforeS0c10: false, cumulativeBefore: 3000, withinCap: true, firstFull: false, chargebackAmount: 3000 });
        expect(await recovery().visit(n.disputeId)).toBe('review');
        expect(await reviewOf(n.disputeId)).toEqual({ reason: 'partial_chargeback' });
        expect(await obligations((await purchaseOf(s.paymentId)).id)).toBe(0);
        expect(await restrictions()).toEqual([]);
        // the historical debit and its cap row are exactly as they were; both debits keep their own figures and facts
        expect(await lossFacts([h.disputeId])).toEqual(before);
        expect(await capRow(h.disputeId)).toEqual(hRow);
        expect((await lossFacts([h.disputeId, n.disputeId])).map((x) => x.amount)).toEqual([3000, 3000]);

        // (b) direct: a historical full loss that reversed the purchase and got its write-off; a later partial is counted after it ONCE
        // (cumulative 4900, never 9800), above the cap: reviewed; the reversal and the write-off stay exactly one each
        const p = await directPurchase('b2');
        const hd = await recordLoss(p.paymentId, 'direct_purchase', p.amount);
        await markBeforeS0c10(hd.disputeId);
        await losses().drainOnce();
        expect(await one(`SELECT outcome FROM dispute_loss_effect WHERE "disputeId" = $1`, [hd.disputeId])).toEqual({ outcome: 'reversed_purchase' });
        await reconcile();
        const writeOff = await one(`SELECT id, "disputeId", amount::int AS amount, xmin::text AS xmin FROM financial_loss WHERE "paymentId" = $1`, [p.paymentId]);
        expect(writeOff).toMatchObject({ disputeId: hd.disputeId, amount: p.amount });
        expect(await capOf(hd.disputeId)).toMatchObject({ beforeS0c10: true, cumulativeBefore: 0, firstFull: true });
        const nd = await loseDirect(p.paymentId, p.amount, 100);
        expect(await capOf(nd)).toMatchObject({ beforeS0c10: false, cumulativeBefore: p.amount, withinCap: false, firstFull: false });
        expect(await one(`SELECT state, reason FROM dispute_loss_effect_attempt WHERE "disputeId" = $1`, [nd])).toEqual({ state: 'review', reason: 'chargeback_exceeds_capture' });
        await reconcile();
        expect((await admin.query(`SELECT id, "disputeId", amount::int AS amount, xmin::text AS xmin FROM financial_loss WHERE "paymentId" = $1`, [p.paymentId])).rows).toEqual([writeOff]);
        expect(await count(`SELECT count(*) AS n FROM subscription_purchase_reversal r JOIN subscription_purchase x ON x.id = r."purchaseId" WHERE x."paymentRequestId" = $1`, [p.paymentRequestId])).toBe(1);

        // (c) assisted, committed obligation: a historical full loss opened the obligation; a later partial is counted after it ONCE
        // (cumulative the gross, never twice it) and is repeated_loss; the obligation is unchanged (last: its T3 restricts ORG's new requests)
        const r2 = await collected({ unit: 6100, fee: 400 });
        const s2 = await started(r2.id);
        await t.bus.deliver(s2.ev('payment.succeeded'));
        const ho = await recordLoss(s2.paymentId, 'assisted_settlement', amount);
        await markBeforeS0c10(ho.disputeId);
        await losses().drainOnce();
        expect(await recovery().visit(ho.disputeId)).toBe('opened');
        const obligation = await one(`SELECT id, status, "baseAmount"::int AS base, xmin::text AS xmin FROM recovery_obligation WHERE "disputeId" = $1`, [ho.disputeId]);
        const no = await recordLoss(s2.paymentId, 'assisted_settlement', amount, 200);
        await losses().drainOnce();
        expect(await capOf(no.disputeId)).toMatchObject({ cumulativeBefore: amount, withinCap: false, firstFull: false });
        expect(await recovery().visit(no.disputeId)).toBe('review');
        expect(await reviewOf(no.disputeId)).toEqual({ reason: 'repeated_loss' });
        expect((await admin.query(`SELECT id, status, "baseAmount"::int AS base, xmin::text AS xmin FROM recovery_obligation WHERE "purchaseId" = $1`,
          [(await purchaseOf(s2.paymentId)).id])).rows).toEqual([obligation]);
      });

      it('C-2: four distinct authentic full losses of one direct capture, applied by four concurrent transactions: one reversal, one write-off, three recorded losses in review; decided in cap-row order, not by time', async () => {
        const p = await directPurchase('b2');
        const ds: string[] = [];
        for (let i = 0; i < 4; i++) ds.push((await recordLoss(p.paymentId, 'direct_purchase', p.amount)).disputeId);
        const facts = (await admin.query(`SELECT "chargebackFactId", "chargebackAmount"::int AS amount FROM payment_dispute_loss WHERE "disputeId" = ANY($1::uuid[])`, [ds])).rows;
        expect(new Set(facts.map((f) => f.chargebackFactId)).size).toBe(4); // four distinct provider debits
        const outs = await Promise.all(ds.map((d) => losses().apply(d))); // four pool connections: independent concurrent transactions
        const reversed = ds.filter((_, i) => outs[i]!.kind === 'applied' && (outs[i] as { outcome: string }).outcome === 'reversed_purchase');
        expect(reversed).toHaveLength(1);
        const reviewed = outs.filter((o) => o.kind === 'review').map((o) => (o as { reason: string }).reason);
        expect(reviewed).toHaveLength(3);
        for (const reason of reviewed) expect(['reversed_by_another_chargeback', 'chargeback_exceeds_capture']).toContain(reason);
        // the cap rows are the decision order: exact prefix sums, and the one first full row is the loss that reversed the purchase
        const rows = (await admin.query(`SELECT "disputeId", "cumulativeBefore"::int AS c, "firstFull" FROM capture_loss_cap WHERE "disputeId" = ANY($1::uuid[]) ORDER BY 2`, [ds])).rows;
        expect(rows.map((x) => x.c)).toEqual([0, p.amount, 2 * p.amount, 3 * p.amount]);
        expect(rows.filter((x) => x.firstFull).map((x) => x.disputeId)).toEqual(reversed);
        await Promise.all([reconcile(), reconcile()]);
        await reconcile();
        expect((await admin.query(`SELECT "disputeId" FROM financial_loss WHERE "paymentId" = $1`, [p.paymentId])).rows).toEqual([{ disputeId: reversed[0] }]);
        expect(await count(`SELECT count(*) AS n FROM subscription_purchase_reversal r JOIN subscription_purchase x ON x.id = r."purchaseId" WHERE x."paymentRequestId" = $1`, [p.paymentRequestId])).toBe(1);
        expect(await count(`SELECT count(*) AS n FROM subscription_purchase_reversal_cause c JOIN subscription_purchase x ON x.id = c."purchaseId" WHERE x."paymentRequestId" = $1`, [p.paymentRequestId])).toBe(1);
        // every debit stays recorded at its own figures; each unapplied one is visible as a non-acknowledgeable review case
        expect(facts.map((f) => f.amount)).toEqual([p.amount, p.amount, p.amount, p.amount]);
        for (const d of ds.filter((x) => x !== reversed[0])) {
          expect(await caseOf('contradictory_effect', d)).toMatchObject({ detail: 'dispute_effect_review', resolution: null });
        }
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

  /**
   * Core V2 S0-C14 WP B (S0 §1.5 S0-C14 items 2 to 15; DO-50, DO-51, DO-52): refund and chargeback overlap precedence, through Billing's real paths
   * on real PostgreSQL. Payment's PAY-08 answers are under test control (`pay08`); relays are relayed through the real route and mirrored by the
   * real relay reconciler; completions are Payment's `refund.case_completed`. Cross-process and multi-instance proofs (V3, V9, V18, V19, V24,
   * V27, V32) are WP D's.
   */
  describe('Core V2 S0-C14: refund and chargeback overlap (waiting effects, overlap cases, collection freeze, acknowledgement, suspension evidence)', () => {
    const reconciliation = () => t.app.get(ReconciliationService);
    const relayReconciler = () => t.app.get(RefundRelayReconciler);
    const waitingCase = (disputeId: string) => one(`SELECT c.id, c.detail, c."organizationId", r.kind, r."refundCaseId" FROM reconciliation_case c
      LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id WHERE c."caseType" = 'chargeback_effect_waiting' AND c."evidenceKey" = $1`, [disputeId]);
    const overlapCase = (disputeId: string) => one(`SELECT c.id, c."paymentId", r.kind FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
      WHERE c."caseType" = 'chargeback_refund_overlap' AND c."evidenceKey" = $1`, [disputeId]);
    /** An assisted purchase paid (base 6100, fee 400): no loss yet. */
    const assistedPaid = async () => {
      const r = await collected({ unit: 6100, fee: 400 });
      const s = await started(r.id);
      await t.bus.deliver(s.ev('payment.succeeded'));
      return { paymentId: s.paymentId, paymentRequestId: s.paymentRequestId, amount: Number(s.inv.total), purchaseId: (await purchaseOf(s.paymentId)).id as string };
    };
    /** The Owner's refund case and its relay through the real route; Payment authorized the attempt, so the relay is LIVE (`authorized`). */
    const relayed = async (paymentId: string) => {
      const caseId = (await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId, reason: 'customer_request' })).body.id as string;
      await send(request(server()).post(`/billing/admin/refund-cases/${caseId}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') }).expect(201);
      const attemptId = (await one(`SELECT id, "attemptStatus" FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [caseId])).id as string;
      return { caseId, attemptId };
    };
    /** Payment states the attempt's status (PAY-08) and the real relay reconciler mirrors it. */
    const atPayment = async (paymentId: string, attemptId: string, status: 'failed' | 'succeeded' | 'authorized' | 'unknown' | 'discrepancy') => {
      pay08.answers.set(paymentId, { attempts: [{ refundAttemptId: attemptId, status, approvedBy: { userId: U.owner } }], refusals: [], authorizations: [], unallocatedFacts: [] });
      await admin.query(`UPDATE refund_authorization_relay SET "checkAfter" = NULL WHERE id = $1`, [attemptId]); // LABELLED TEST AID: the reconciler's lease, not a status
      await relayReconciler().reconcileOnce();
      return (await one(`SELECT "attemptStatus" FROM refund_authorization_relay WHERE id = $1`, [attemptId])).attemptStatus as string;
    };
    /** Payment's verified completion of the case (the event), as Payment emits it. */
    const completed = async (r: { caseId: string; attemptId: string }, p: { paymentId: string; paymentRequestId: string; amount: number }, purpose = 'assisted_settlement') => {
      const ev = randomUUID();
      await t.bus.deliver({ id: ev, name: 'refund.case_completed', payload: { refundCaseId: r.caseId, refundAuthorizationId: randomUUID(), refundAttemptId: r.attemptId, paymentId: p.paymentId,
        paymentRequestId: p.paymentRequestId, producer: 'billing-service', approvedAmount: p.amount, currency: 'TND', completedAt: new Date().toISOString(), liveMode: false,
        organizationId: purpose === 'assisted_settlement' ? ORG : null, purpose }, headers: { eventId: ev, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } });
      expect((await one(`SELECT status FROM refund_case WHERE id = $1`, [r.caseId])).status).toBe('completed');
    };
    /** Payment's verified final lost chargeback of any purchase (a direct one included), applied by the dispute loss worker. */
    const loseAny = async (paymentId: string, amount: number) => {
      const id = randomUUID();
      const disputeId = randomUUID();
      await t.bus.deliver({ id, name: 'payment.dispute.lost', payload: {
        disputeId, paymentId, paymentRequestId: randomUUID(), producer: 'billing-service', organizationId: null, purpose: 'direct_purchase', amount, currency: 'TND',
        lostAt: new Date().toISOString(), chargeback: { factId: randomUUID(), amount, currency: 'TND' }, liveMode: false,
      }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } } as never);
      await losses().drainOnce();
      return disputeId;
    };
    const acknowledge = (caseId: string, reason: string) =>
      send(request(server()).post(`/billing/admin/reconciliation-cases/${caseId}/acknowledgement`), 'owner-tok', key()).send({ reason });

    it('DO-52 / V1, V13: an assisted loss while a refund is LIVE waits (no obligation, no T3, nothing written); the waiting case is visible; the refund then completes: review, overlap case, waiting case resolved refund_completed', async () => {
      const p = await assistedPaid();
      const r = await relayed(p.paymentId);
      const disputeId = await lose(p.paymentId, p.amount);
      expect(await recovery().visit(disputeId)).toBe('waiting');
      expect(await obligationOf(disputeId)).toBeUndefined();
      expect(await reviewOf(disputeId)).toBeUndefined();
      expect((await restrictions()).filter((x) => x.kind === 'T3')).toEqual([]);
      await reconciliation().drainOnce();
      expect(await waitingCase(disputeId)).toMatchObject({ detail: 'relay_live', kind: null, organizationId: ORG });
      await completed(r, p);
      expect(await recovery().visit(disputeId)).toBe('review');
      expect(await reviewOf(disputeId)).toEqual({ reason: 'refund_completed' });
      await reconciliation().drainOnce();
      // never `effect_applied` when nothing was applied: the completed refund of the same captured movement
      expect(await waitingCase(disputeId)).toMatchObject({ kind: 'refund_completed', refundCaseId: r.caseId });
      expect(await overlapCase(disputeId)).toMatchObject({ paymentId: p.paymentId, kind: null }); // DO-51: an assisted settling capture's overlap is a case
      expect(await obligationOf(disputeId)).toBeUndefined();
      expect((await restrictions()).filter((x) => x.kind === 'T3')).toEqual([]);
    });

    it('V13 (fail closed, item 6): PAY-08 down, 404, without unallocated facts, with an attempt Billing never relayed, or with refund evidence: the obligation waits; a clean read then lets it proceed', async () => {
      const p = await assistedPaid();
      const disputeId = await lose(p.paymentId, p.amount);
      const unknownAttempt = randomUUID();
      const answers: Array<[PaymentRefunds | null | 'down', string]> = [
        ['down', 'payment_unavailable'],
        [null, 'payment_not_found'],
        [{ attempts: [], refusals: [], authorizations: [], unallocatedFacts: null }, 'unallocated_facts_unknown'],
        [{ attempts: [{ refundAttemptId: unknownAttempt, status: 'failed', approvedBy: null }], refusals: [], authorizations: [], unallocatedFacts: [] }, 'attempt_unknown_to_billing'], // V31
        [{ attempts: [], refusals: [], authorizations: [], unallocatedFacts: [{ factId: randomUUID(), refundAttemptId: null, amount: p.amount, currency: 'TND', state: 'pending' }] }, 'attempt_unknown_to_billing'],
      ];
      for (const [answer, reason] of answers) {
        pay08.answers.set(p.paymentId, answer);
        expect(await recovery().visit(disputeId), reason).toBe('waiting');
        expect(await obligationOf(disputeId), reason).toBeUndefined();
      }
      // the waiting case states the first reason seen by the reconciliation worker; nothing is applied meanwhile
      await reconciliation().drainOnce();
      expect(await waitingCase(disputeId)).toMatchObject({ detail: 'attempt_unknown_to_billing', kind: null });
      pay08.answers.delete(p.paymentId); // Payment: nothing attempted, nothing refunded
      expect(await recovery().visit(disputeId)).toBe('opened');
      await reconciliation().drainOnce();
      expect(await waitingCase(disputeId)).toMatchObject({ kind: 'effect_applied', refundCaseId: null });
    });

    it('V6 / V26: the refund FAILED at Payment, the obligation proceeds; then the provider reports money (the case completes): nothing is undone, the overlap case opens, collection is frozen (409), T3 stays', async () => {
      const p = await assistedPaid();
      const r = await relayed(p.paymentId);
      const disputeId = await lose(p.paymentId, p.amount);
      expect(await recovery().visit(disputeId)).toBe('waiting');
      expect(await atPayment(p.paymentId, r.attemptId, 'failed')).toBe('failed');
      expect(await recovery().visit(disputeId)).toBe('opened');
      const o = await obligationOf(disputeId);
      await completed(r, p); // the late money of a confirmed failure: the race item 6 cannot prevent
      await reconciliation().drainOnce();
      expect(await overlapCase(disputeId)).toMatchObject({ kind: null });
      expect(await obligationOf(disputeId)).toMatchObject({ id: o.id, status: 'open' }); // facts stand (item 3)
      expect((await restrictions()).map((x) => [x.kind, x.sourceId])).toContainEqual(['T3', o.id]);
      const frozenSettle = await settleRecovery(o.id);
      expect(frozenSettle.status, JSON.stringify(frozenSettle.body)).toBe(409);
      expect(frozenSettle.body).toMatchObject({ code: 'recovery_collection_frozen' });
      expect(await count(`SELECT count(*) AS n FROM recovery_settlement_channel WHERE "obligationId" = $1`, [o.id])).toBe(0);
      // V5: the database refuses a channel during the overlap even past the application
      const inv = randomUUID();
      await expect(admin.query(`INSERT INTO recovery_settlement_channel ("obligationId", "invoiceId", amount, "startedBy") VALUES ($1, $2, 6100, $3)`, [o.id, inv, randomUUID()]))
        .rejects.toMatchObject({ constraint: 'recovery_collection_frozen' });
    });

    it('V7: a channel started BEFORE the overlap continues; its verified payment is recorded and counted; a NEW channel after it is refused', async () => {
      const p = await assistedPaid();
      const r = await relayed(p.paymentId);
      const disputeId = await lose(p.paymentId, p.amount);
      await atPayment(p.paymentId, r.attemptId, 'failed');
      expect(await recovery().visit(disputeId)).toBe('opened');
      const o = await obligationOf(disputeId);
      const channel = await settleRecovery(o.id);
      expect(channel.status, JSON.stringify(channel.body)).toBe(201);
      await completed(r, p); // overlap from here on
      await recoveryEvent(channel.body.paymentRequestId); // the channel's payment succeeds: never refused, never dead-lettered
      expect(await count(`SELECT count(*) AS n FROM recovery_payment WHERE "paymentRequestId" = $1`, [channel.body.paymentRequestId])).toBe(1);
      expect(await obligationOf(disputeId)).toMatchObject({ status: 'recovered' });
      expect((await restrictions()).filter((x) => x.kind === 'T3')).toEqual([]);
    });

    it('V13: a relay mirrored `unknown` or `discrepancy` (Payment\'s own statement) keeps the obligation waiting and visible; D9 stays open (no exit is invented)', async () => {
      for (const status of ['unknown', 'discrepancy'] as const) {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        expect(await atPayment(p.paymentId, r.attemptId, status), status).toBe(status);
        const disputeId = await lose(p.paymentId, p.amount);
        expect(await recovery().visit(disputeId), status).toBe('waiting');
        await reconciliation().drainOnce();
        expect(await waitingCase(disputeId), status).toMatchObject({ detail: 'relay_live', kind: null });
        await reconciliation().drainOnce();
        expect(await obligationOf(disputeId), status).toBeUndefined();
        expect((await restrictions()).filter((x) => x.kind === 'T3'), status).toEqual([]);
      }
    });

    it('V4: past the application, the database refuses an obligation while a refund of the captured movement is live', async () => {
      const p = await assistedPaid();
      await relayed(p.paymentId);
      const disputeId = await lose(p.paymentId, p.amount);
      const a = await one(`SELECT s."assistanceRequestId", a."platformId", a."baseAmount", a.currency FROM subscription_purchase s JOIN assistance_request a ON a.id = s."assistanceRequestId" WHERE s.id = $1`, [p.purchaseId]);
      await expect(admin.query(`INSERT INTO recovery_obligation ("disputeId", "assistanceRequestId", "purchaseId", "organizationId", "companyId", "platformId", "baseAmount", currency)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [disputeId, a.assistanceRequestId, p.purchaseId, ORG, COMPANY, a.platformId, a.baseAmount, a.currency]))
        .rejects.toMatchObject({ constraint: 'recovery_obligation_refund_live' });
    });

    it('DO-50 / V2: a direct purchase lost while its refund is live: reversal as adopted, the write-off WAITS; the refund completes: no write-off ever, overlap case; acknowledging no financial effect is refused (V16)', async () => {
      const p = await directPurchase();
      const r = await relayed(p.paymentId);
      const disputeId = await loseAny(p.paymentId, p.amount);
      expect(await one(`SELECT outcome FROM dispute_loss_effect WHERE "disputeId" = $1`, [disputeId])).toEqual({ outcome: 'reversed_purchase' }); // not delayed (item 5)
      await reconciliation().drainOnce();
      expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE "disputeId" = $1`, [disputeId])).toBe(0);
      expect(await waitingCase(disputeId)).toMatchObject({ detail: 'relay_live', kind: null });
      await completed(r, { ...p }, 'direct_purchase');
      await t.app.get(RefundEffectService).drainOnce();
      await reconciliation().drainOnce();
      expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE "disputeId" = $1`, [disputeId])).toBe(0);
      expect(await overlapCase(disputeId)).toMatchObject({ kind: null });
      expect(await waitingCase(disputeId)).toMatchObject({ kind: 'refund_completed', refundCaseId: r.caseId });
      const second = await one(`SELECT id FROM reconciliation_case WHERE "caseType" = 'second_reversal_cause' AND "evidenceKey" = $1`, [(await purchaseOf(p.paymentId)).id]);
      expect(second, 'the second reversal cause is reviewed').toBeTruthy();
      const ack = await acknowledge(second.id, 'reviewed_no_financial_effect');
      expect(ack.status, JSON.stringify(ack.body)).toBe(409);
      expect(ack.body).toMatchObject({ code: 'reconciliation_case_in_overlap' });
      // the database refuses it too, past the application
      await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, 'acknowledged', $2, 'reviewed_no_financial_effect')`, [second.id, U.owner]))
        .rejects.toMatchObject({ constraint: 'reconciliation_case_overlap_acknowledgement' });
      // another reason still acknowledges the review; the overlap case stays open
      expect((await acknowledge(second.id, 'provider_statement_reviewed')).status).toBe(200);
      expect(await overlapCase(disputeId)).toMatchObject({ kind: null });
    });

    it('DO-50 order D: the write-off recorded first (refund failed at Payment), then the provider reports the refund: the write-off stands and the overlap case opens', async () => {
      const p = await directPurchase();
      const r = await relayed(p.paymentId);
      const disputeId = await loseAny(p.paymentId, p.amount);
      await atPayment(p.paymentId, r.attemptId, 'failed');
      await reconciliation().drainOnce();
      expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE kind = 'direct_chargeback_write_off' AND "disputeId" = $1`, [disputeId])).toBe(1);
      await completed(r, { ...p }, 'direct_purchase');
      await t.app.get(RefundEffectService).drainOnce();
      await reconciliation().drainOnce();
      expect(await count(`SELECT count(*) AS n FROM financial_loss WHERE kind = 'direct_chargeback_write_off' AND "disputeId" = $1`, [disputeId])).toBe(1);
      expect(await overlapCase(disputeId)).toMatchObject({ kind: null });
    });

    it('item 12: a waiting case resolves only by its evidence; effect_applied without an effect, or a refund of another movement, is refused by the database', async () => {
      const p = await assistedPaid();
      await relayed(p.paymentId);
      const disputeId = await lose(p.paymentId, p.amount);
      await reconciliation().drainOnce();
      const w = await waitingCase(disputeId);
      await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind) VALUES ($1, 'effect_applied')`, [w.id]))
        .rejects.toMatchObject({ constraint: 'reconciliation_case_resolution_evidence' });
      const other = await assistedPaid();
      const or = await relayed(other.paymentId);
      await completed(or, other);
      await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "refundCaseId") VALUES ($1, 'refund_completed', $2)`, [w.id, or.caseId]))
        .rejects.toMatchObject({ constraint: 'reconciliation_case_resolution_evidence' });
      await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, 'acknowledged', $2, 'provider_statement_reviewed')`, [w.id, U.owner]))
        .rejects.toMatchObject({ constraint: 'reconciliation_case_resolution_evidence' });
    });

    it('items 10, 11 (evidence only, no route in WP B): an Owner suspension of an obligation in overlap removes its T3 and nothing else; one active; revocation restores T3; never outside an overlap', async () => {
      const p = await assistedPaid();
      const r = await relayed(p.paymentId);
      const disputeId = await lose(p.paymentId, p.amount);
      await atPayment(p.paymentId, r.attemptId, 'failed');
      expect(await recovery().visit(disputeId)).toBe('opened');
      const o = await obligationOf(disputeId);
      const event = (kind: 'suspended' | 'revoked', suspensionId: string, over: Record<string, unknown> = {}) => {
        const v = { suspensionId, kind, obligationId: o.id, organizationId: ORG, companyId: COMPANY, disputeId, refundCaseId: r.caseId,
          reasonCode: kind === 'suspended' ? 'refund_chargeback_overlap' : 'owner_reinstated_restriction', actorUserId: U.owner, receiptId: randomUUID(), consumeRef: randomUUID(), ...over };
        return admin.query(`INSERT INTO recovery_restriction_suspension_event ("suspensionId", kind, "obligationId", "organizationId", "companyId", "disputeId", "refundCaseId", "reasonCode",
          "actorUserId", "receiptId", "consumeRef") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [v.suspensionId, v.kind, v.obligationId, v.organizationId, v.companyId, v.disputeId, v.refundCaseId, v.reasonCode, v.actorUserId, v.receiptId, v.consumeRef]);
      };
      // no overlap yet: refused (the refund case is not completed either)
      await expect(event('suspended', randomUUID())).rejects.toMatchObject({ constraint: 'recovery_restriction_suspension_evidence' });
      await completed(r, p);
      const s1 = randomUUID();
      await event('suspended', s1);
      expect((await restrictions()).filter((x) => x.kind === 'T3')).toEqual([]);
      expect(await obligationOf(disputeId)).toMatchObject({ status: 'open' }); // the debt is untouched
      await expect(event('suspended', randomUUID())).rejects.toMatchObject({ constraint: 'recovery_restriction_suspension_active' });
      await expect(event('revoked', randomUUID())).rejects.toMatchObject({ constraint: 'recovery_restriction_suspension_revocation' });
      await expect(event('suspended', randomUUID(), { companyId: OTHER_COMPANY })).rejects.toMatchObject({ constraint: 'recovery_restriction_suspension_evidence' });
      await event('revoked', s1);
      expect((await restrictions()).map((x) => [x.kind, x.sourceId])).toContainEqual(['T3', o.id]);
      await expect(event('revoked', s1)).rejects.toMatchObject({ constraint: 'recovery_restriction_suspension_event_once' });
      await expect(admin.query(`UPDATE recovery_restriction_suspension_event SET "reasonCode" = 'x' WHERE "suspensionId" = $1`, [s1])).rejects.toThrow();
      await expect(admin.query(`DELETE FROM recovery_restriction_suspension_event WHERE "suspensionId" = $1`, [s1])).rejects.toThrow();
      // a later fresh suspension is allowed
      await event('suspended', randomUUID());
      expect((await restrictions()).filter((x) => x.kind === 'T3')).toEqual([]);
    });

    // ── S0-C14 WP C: the Owner's suspension and revocation routes, and the read fields (items 10, 11, 13)
    /** An open obligation whose captured movement is in overlap: the refund failed at Payment, the obligation opened, then the refund completed. */
    const inOverlap = async () => {
      const p = await assistedPaid();
      const r = await relayed(p.paymentId);
      const disputeId = await lose(p.paymentId, p.amount);
      await atPayment(p.paymentId, r.attemptId, 'failed');
      expect(await recovery().visit(disputeId)).toBe('opened');
      await completed(r, p);
      const o = await obligationOf(disputeId);
      return { ...p, disputeId, refundCaseId: r.caseId, obligationId: o.id as string };
    };
    /** Auth's receipt for exactly this binding, issued to `issuer` (AUTH-01): a suspension or a revocation. */
    const restrictionReceipt = (o: { obligationId: string; disputeId: string; refundCaseId: string }, suspensionId: string, kind: 'suspend' | 'revoke',
      over: Record<string, unknown> = {}, issuer = U.owner) => {
      const secret = randomBytes(32).toString('base64url');
      fraudAuth.issued.set(secret, { id: randomUUID(), issuer, binding: { operation: `recovery_restriction_${kind}`, audience: 'billing-service', companyId: COMPANY, suspensionId,
        obligationId: o.obligationId, organizationId: ORG, disputeId: o.disputeId, refundCaseId: o.refundCaseId,
        reasonCode: kind === 'suspend' ? 'refund_chargeback_overlap' : 'owner_reinstated_restriction', ...over } });
      return secret;
    };
    const suspend = (obligationId: string, body: unknown, bearer = 'owner-tok') =>
      send(request(server()).post(`/billing/admin/recovery-obligations/${obligationId}/restriction-suspensions`), bearer, null).send(body as object);
    const revoke = (obligationId: string, suspensionId: string, body: unknown, bearer = 'owner-tok') =>
      send(request(server()).post(`/billing/admin/recovery-obligations/${obligationId}/restriction-suspensions/${suspensionId}/revocation`), bearer, null).send(body as object);
    const events = (obligationId: string) => admin.query(`SELECT "suspensionId", kind, "reasonCode", "actorUserId", "receiptId" FROM recovery_restriction_suspension_event
      WHERE "obligationId" = $1 ORDER BY "recordedAt", kind`, [obligationId]).then((r) => r.rows as Row[]);
    const restrictionsRead = async () => (await send(request(server()).get(`/billing/organizations/${ORG}/restrictions`), 'a1', null)).body as Row;

    it('items 10, 13: the Owner sees the overlap evidence; suspending removes T3 for that obligation only; the debt, the freeze and the overlap case stay; one audit record', async () => {
      const o = await inOverlap();
      const before = (await ownerRead(o.obligationId)).body;
      expect(before).toMatchObject({ outstanding: 6100, status: 'open', collection: 'frozen_overlap', restriction: 'active', overlap: { disputeId: o.disputeId, refundCaseId: o.refundCaseId },
        suspensions: [] });
      const suspensionId = randomUUID();
      const s = await suspend(o.obligationId, { suspensionId, receiptSecret: restrictionReceipt(o, suspensionId, 'suspend') });
      expect(s.status, JSON.stringify(s.body)).toBe(201);
      expect(s.body).toMatchObject({ obligationId: o.obligationId, suspensionId, status: 'suspended', reasonCode: 'refund_chargeback_overlap', recordedBy: { userId: U.owner } });
      expect((await ownerRead(o.obligationId)).body).toMatchObject({ outstanding: 6100, status: 'open', collection: 'frozen_overlap', restriction: 'suspended',
        suspensions: [{ suspensionId, status: 'active', suspendedBy: { userId: U.owner }, revokedBy: null }] });
      // the Organization's administrator: the derived status only, never the overlap evidence, who suspended or when
      const org = (await readRecovery(o.obligationId)).body;
      expect(org).toMatchObject({ outstanding: 6100, status: 'open', collection: 'frozen_overlap', restriction: 'suspended' });
      expect(org).not.toHaveProperty('suspensions');
      expect(org).not.toHaveProperty('overlap');
      const list = await restrictionsRead();
      expect(list.restrictions.filter((x: Row) => x.kind === 'T3' && x.sourceId === o.obligationId)).toEqual([]);
      expect(list.suspended).toEqual([{ kind: 'T3', obligationId: o.obligationId, since: expect.any(String) }]);
      expect((await settleRecovery(o.obligationId)).body).toMatchObject({ code: 'recovery_collection_frozen' }); // still frozen
      await reconciliation().drainOnce();
      expect(await overlapCase(o.disputeId)).toMatchObject({ kind: null }); // open, and no suspension resolves it
      const recorded = (await audit(o.obligationId)).filter((x) => x.name === 'audit.recovery_restriction.suspended');
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.payload).toMatchObject({ action: 'recovery_restriction.suspended', organizationId: ORG, resource: { type: 'recovery_obligation', id: o.obligationId },
        actor: { type: 'user', id: U.owner, userKind: 'owner' },
        changes: { suspension_id: suspensionId, dispute_id: o.disputeId, refund_case_id: o.refundCaseId, reason_code: 'refund_chargeback_overlap' } });
    });

    it('item 10: exact binding (suspension id, obligation, Organization, dispute, refund case, closed reason), the issuing Owner only; nothing recorded on a refusal', async () => {
      const o = await inOverlap();
      const sid = randomUUID();
      for (const over of [{ suspensionId: randomUUID() }, { obligationId: randomUUID() }, { organizationId: randomUUID() }, { disputeId: randomUUID() }, { refundCaseId: randomUUID() },
        { reasonCode: 'owner_reinstated_restriction' }]) {
        const r = await suspend(o.obligationId, { suspensionId: sid, receiptSecret: restrictionReceipt(o, sid, 'suspend', over) });
        expect([r.status, r.body.code], JSON.stringify(over)).toEqual([409, 'recovery_authorization_refused']);
      }
      const other = await suspend(o.obligationId, { suspensionId: sid, receiptSecret: restrictionReceipt(o, sid, 'suspend', {}, randomUUID()) }); // issued to another Owner
      expect([other.status, other.body.code]).toEqual([409, 'recovery_authorization_refused']);
      for (const body of [{ suspensionId: sid }, { suspensionId: 'x', receiptSecret: randomBytes(32).toString('base64url') },
        { suspensionId: sid, receiptSecret: randomBytes(32).toString('base64url'), reasonCode: 'free text' }]) {
        expect((await suspend(o.obligationId, body)).body, JSON.stringify(body)).toMatchObject({ code: 'invalid_recovery_request' });
      }
      expect(await events(o.obligationId)).toEqual([]);
    });

    it('isolation: another Company\'s Owner gets the collapsed 404, an operator or a member 403; an obligation outside an overlap is not suspendable', async () => {
      // the same obligation BEFORE its overlap: the refund failed at Payment and the obligation opened; nothing is refunded yet
      const p = await assistedPaid();
      const rl = await relayed(p.paymentId);
      const disputeId = await lose(p.paymentId, p.amount);
      await atPayment(p.paymentId, rl.attemptId, 'failed');
      expect(await recovery().visit(disputeId)).toBe('opened');
      const o = { disputeId, refundCaseId: rl.caseId, obligationId: (await obligationOf(disputeId)).id as string };
      expect((await ownerRead(o.obligationId)).body).toMatchObject({ collection: 'open', restriction: 'active', overlap: null, suspensions: [] });
      const x = randomUUID();
      const early = await suspend(o.obligationId, { suspensionId: x, receiptSecret: restrictionReceipt(o, x, 'suspend') });
      expect([early.status, early.body.code]).toEqual([409, 'recovery_restriction_not_suspendable']);
      await completed(rl, p); // the overlap from here on
      const sid = randomUUID();
      const secret = restrictionReceipt(o, sid, 'suspend');
      expect((await suspend(o.obligationId, { suspensionId: sid, receiptSecret: secret }, 'foreign-owner-tok')).status).toBe(404);
      expect((await suspend(randomUUID(), { suspensionId: sid, receiptSecret: secret })).status).toBe(404);
      for (const bearer of ['operator-tok', 'member-tok']) expect((await suspend(o.obligationId, { suspensionId: sid, receiptSecret: secret }, bearer)).status, bearer).toBe(403);
      expect((await revoke(o.obligationId, sid, { receiptSecret: secret }, 'foreign-owner-tok')).status).toBe(404);
      expect(await events(o.obligationId)).toEqual([]);
      expect((await suspend(o.obligationId, { suspensionId: sid, receiptSecret: secret })).status).toBe(201); // the receipt was never spent by a refused caller
    });

    it('item 10: one active suspension; the same request again is answered once; a retry after Auth was unavailable, or after a lost answer, records once (V10, V12)', async () => {
      const o = await inOverlap();
      const sid = randomUUID();
      const secret = restrictionReceipt(o, sid, 'suspend');
      fraudAuth.down = true;
      try {
        expect((await suspend(o.obligationId, { suspensionId: sid, receiptSecret: secret })).body).toMatchObject({ code: 'recovery_authorization_unresolved' });
      } finally {
        fraudAuth.down = false;
      }
      expect(await events(o.obligationId)).toEqual([]);
      // Auth consumed it, but Billing never recorded it (a crash after the consumption): the same request finds that consumption and records once
      await fraudHoldReceipts.consume({ secret, binding: fraudAuth.issued.get(secret)!.binding as never, consumeRef: sid });
      expect((await suspend(o.obligationId, { suspensionId: sid, receiptSecret: secret })).status).toBe(201);
      const again = await suspend(o.obligationId, { suspensionId: sid, receiptSecret: secret });
      expect(again.status).toBe(200);
      expect(await events(o.obligationId)).toHaveLength(1);
      const second = randomUUID();
      const r = await suspend(o.obligationId, { suspensionId: second, receiptSecret: restrictionReceipt(o, second, 'suspend') });
      expect([r.status, r.body.code]).toEqual([409, 'recovery_restriction_not_suspendable']);
      // the same suspension id with ANOTHER receipt: Auth refuses the second consumption under the same reference
      const other = await suspend(o.obligationId, { suspensionId: sid, receiptSecret: restrictionReceipt(o, sid, 'suspend') });
      expect(other.status).toBe(200); // already recorded for this id: answered, nothing consumed
      expect((await audit(o.obligationId)).filter((x) => x.name === 'audit.recovery_restriction.suspended')).toHaveLength(1);
    });

    it('item 11: revocation restores T3 for new requests; answered once; a second or unknown revocation is refused; a later fresh suspension is allowed', async () => {
      const o = await inOverlap();
      const sid = randomUUID();
      expect((await suspend(o.obligationId, { suspensionId: sid, receiptSecret: restrictionReceipt(o, sid, 'suspend') })).status).toBe(201);
      const wrong = await revoke(o.obligationId, sid, { receiptSecret: restrictionReceipt(o, sid, 'revoke', { reasonCode: 'refund_chargeback_overlap' }) });
      expect([wrong.status, wrong.body.code]).toEqual([409, 'recovery_authorization_refused']);
      const secret = restrictionReceipt(o, sid, 'revoke');
      const r = await revoke(o.obligationId, sid, { receiptSecret: secret });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body).toMatchObject({ suspensionId: sid, status: 'revoked', reasonCode: 'owner_reinstated_restriction' });
      expect((await revoke(o.obligationId, sid, { receiptSecret: secret })).status).toBe(200);
      expect((await revoke(o.obligationId, sid, { receiptSecret: restrictionReceipt(o, sid, 'revoke') }, 'owner-tok')).status).toBe(200); // the same Owner: answered
      expect((await revoke(o.obligationId, randomUUID(), { receiptSecret: secret })).body).toMatchObject({ code: 'recovery_suspension_not_active' });
      expect((await ownerRead(o.obligationId)).body).toMatchObject({ restriction: 'active', suspensions: [{ suspensionId: sid, status: 'revoked' }] });
      expect((await restrictions()).map((x) => [x.kind, x.sourceId])).toContainEqual(['T3', o.obligationId]);
      const revokedAudit = (await audit(o.obligationId)).filter((x) => x.name === 'audit.recovery_restriction.suspension_revoked');
      expect(revokedAudit.map((x) => x.payload.changes)).toEqual([{ suspension_id: sid, reason_code: 'owner_reinstated_restriction' }]);
      const fresh = randomUUID();
      expect((await suspend(o.obligationId, { suspensionId: fresh, receiptSecret: restrictionReceipt(o, fresh, 'suspend') })).status).toBe(201);
      expect(await events(o.obligationId)).toHaveLength(3);
      // S0-C14 WP D finding: every suspension and revocation of one obligation is its own audit record (the event id's identity is the suspension)
      const intents = (await audit(o.obligationId)).filter((x) => String(x.name).startsWith('audit.recovery_restriction.'));
      expect(intents.map((x) => [x.name, x.payload.changes.suspension_id])).toEqual([
        ['audit.recovery_restriction.suspended', sid], ['audit.recovery_restriction.suspension_revoked', sid], ['audit.recovery_restriction.suspended', fresh]]);
    });

    it('item 14 (C14): the safety check reads every page and compares one way; unavailable when Payment cannot answer; a Billing relay Payment does not hold is a mismatch', async () => {
      const check = t.app.get(FinancialSafetyCheck);
      pay08.down = true;
      expect(await check.scan()).toMatchObject({ kind: 'unavailable' });
      pay08.down = false;
      const p = await assistedPaid();
      const r = await relayed(p.paymentId); // Billing mirrors `authorized`; Payment (default answer) holds no attempt at all
      const out = await check.scan();
      expect(out.kind).toBe('mismatch');
      expect((out as { findings: string[] }).findings).toContain(`relay_unknown_to_payment payment=${p.paymentId} relay=${r.attemptId}`);
    });

    describe('Core V2 S0-C15A: unresolved refund and chargeback exposure (BIL-33 N, DO-72)', () => {
      const exposureCase = (disputeId: string) => one(`SELECT c.id, c.detail, c.amount, c."paymentId", r.kind, r."refundCaseId" FROM reconciliation_case c
        LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id WHERE c."caseType" = 'chargeback_refund_exposure' AND c."evidenceKey" = $1`, [disputeId]);
      const reviewOf2 = (type: string, evidence: string) => one(`SELECT c.id, r.kind, r.reason FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
        WHERE c."caseType" = $1 AND c."evidenceKey" = $2`, [type, evidence]);
      /** Payment's `refund_discrepancy` item for attempt `id` (PAY-12), as its reconciliation read states it. */
      const discrepancyItem = (paymentId: string, id: string) => paymentItems.items.set('refund_discrepancy', [...(paymentItems.items.get('refund_discrepancy') ?? []),
        { kind: 'refund_discrepancy', id, paymentId, factId: null, amount: 4200, currency: 'TND', detail: {}, at: new Date().toISOString() } as PaymentItem]);
      /** PAY-08 with a verified allocation on `attemptId`, or none. */
      const answer = (paymentId: string, attemptId: string, allocated: number) => pay08.answers.set(paymentId, {
        attempts: [{ refundAttemptId: attemptId, status: 'discrepancy', approvedBy: { userId: U.owner } }], refusals: [], unallocatedFacts: [],
        authorizations: [{ refundAuthorizationId: randomUUID(), refundAttemptId: attemptId, refundCaseId: randomUUID(), approvedAmount: 100, currency: 'TND', completedAt: null,
          allocations: allocated > 0 ? [{ factId: randomUUID(), amount: allocated, currency: 'TND' }] : [] }] });
      /** Char-4's shape: a refund attempt in discrepancy and a partial chargeback of the same movement, with both review cases open. */
      const exposed = async (allocated = 60) => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        expect(await atPayment(p.paymentId, r.attemptId, 'discrepancy')).toBe('discrepancy');
        const disputeId = await lose(p.paymentId, 70);
        await recovery().visit(disputeId);
        discrepancyItem(p.paymentId, r.attemptId);
        answer(p.paymentId, r.attemptId, allocated);
        await reconciliation().drainOnce();
        return { p, r, disputeId };
      };
      const count = async (sql: string, params: unknown[]) => Number((await one(sql, params)).n);
      const openedAudits = (caseId: string) => count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.opened' AND payload->'resource'->>'id' = $1`, [caseId]);

      it('item 4: the case opens once, states the chargeback amount, and claims verified money only from a verified allocation on the movement; replays add nothing', async () => {
        const e = await exposed(60);
        const c = await exposureCase(e.disputeId);
        expect(c).toMatchObject({ detail: 'refund_money_verified', amount: '70', paymentId: e.p.paymentId, kind: null });
        await reconciliation().drainOnce();
        await reconciliation().drainOnce();
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'chargeback_refund_exposure' AND "evidenceKey" = $1`, [e.disputeId])).toBe(1);
        expect(await openedAudits(c.id)).toBe(1);
        const listed = (await send(request(server()).get('/billing/admin/reconciliation-cases?status=open&type=chargeback_refund_exposure'), 'owner-tok', null)).body.items as { id: string; detail: string; reviewOnly: boolean }[];
        expect(listed.find((x) => x.id === c.id)).toMatchObject({ detail: 'refund_money_verified', reviewOnly: false });
      });

      it('evidence correction: no allocation, Payment unavailable, or an unmatched refund_discrepancy proves no money: the case still opens, as refund_evidence_unresolved', async () => {
        const none = await exposed(0);
        expect(await exposureCase(none.disputeId)).toMatchObject({ detail: 'refund_evidence_unresolved', kind: null });
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        await atPayment(p.paymentId, r.attemptId, 'discrepancy');
        const disputeId = await lose(p.paymentId, 70);
        pay08.answers.set(p.paymentId, 'down');
        await reconciliation().drainOnce();
        expect(await exposureCase(disputeId)).toMatchObject({ detail: 'refund_evidence_unresolved', kind: null });
        const u = await assistedPaid();
        const unmatched = await lose(u.paymentId, 70);
        discrepancyItem(u.paymentId, randomUUID()); // an attempt Billing holds no relay for: association uncertain, fail closed
        pay08.answers.delete(u.paymentId);
        await reconciliation().drainOnce();
        await reconciliation().drainOnce();
        expect(await exposureCase(unmatched)).toMatchObject({ detail: 'refund_evidence_unresolved', kind: null });
      });

      it('R6: under exposure the service refuses the two claiming reasons and keeps provider_statement_reviewed; the exposure case stays open', async () => {
        const e = await exposed();
        const partial = (await reviewOf2('partial_chargeback', e.disputeId))!;
        const disc = (await reviewOf2('refund_discrepancy', e.r.attemptId))!;
        for (const id of [partial.id, disc.id]) {
          for (const reason of ['reviewed_no_financial_effect', 'duplicate_evidence_reviewed']) {
            const a = await acknowledge(id, reason);
            expect([a.status, a.body.code], reason).toEqual([409, 'reconciliation_case_in_exposure']);
          }
        }
        expect((await acknowledge(partial.id, 'provider_statement_reviewed')).status).toBe(200);
        expect((await acknowledge(disc.id, 'provider_statement_reviewed')).status).toBe(200);
        expect(await exposureCase(e.disputeId)).toMatchObject({ kind: null });
      });

      it('R7: the database refuses the same two reasons past the application, through the same function', async () => {
        const e = await exposed();
        const partial = (await reviewOf2('partial_chargeback', e.disputeId))!;
        for (const reason of ['reviewed_no_financial_effect', 'duplicate_evidence_reviewed']) {
          await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, 'acknowledged', $2, $3)`, [partial.id, U.owner, reason]))
            .rejects.toMatchObject({ constraint: 'reconciliation_case_exposure_acknowledgement' });
          expect((await one(`SELECT billing_acknowledgement_refused_by_exposure($1, $2) AS r`, [partial.id, reason])).r).toBe(true);
        }
        expect((await one(`SELECT billing_acknowledgement_refused_by_exposure($1, 'provider_statement_reviewed') AS r`, [partial.id])).r).toBe(false);
        await admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, 'acknowledged', $2, 'provider_statement_reviewed')`, [partial.id, U.owner]);
      });

      it('R8: the exposure case itself is never acknowledged, by the route or by SQL, and its row is append-only', async () => {
        const e = await exposed();
        const c = (await exposureCase(e.disputeId))!;
        for (const reason of ['reviewed_no_financial_effect', 'provider_statement_reviewed', 'duplicate_evidence_reviewed']) {
          const a = await acknowledge(c.id, reason);
          expect([a.status, a.body.code], reason).toEqual([409, 'reconciliation_case_not_acknowledgeable']);
          await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, 'acknowledged', $2, $3)`, [c.id, U.owner, reason])).rejects.toThrow();
        }
        await expect(admin.query(`UPDATE reconciliation_case SET detail = 'refund_money_verified' WHERE id = $1`, [c.id])).rejects.toThrow();
        await expect(admin.query(`INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId", detail) VALUES ('chargeback_refund_exposure', $1, $2, 'made_up')`, [e.disputeId, COMPANY]))
          .rejects.toMatchObject({ constraint: 'reconciliation_case_exposure_evidence' });
      });

      it('R13: outside an exposure every reason keeps working: a partial chargeback alone, a partial refund alone, a partial chargeback beside an in-flight refund', async () => {
        const a = await assistedPaid();
        const alone = await lose(a.paymentId, 70);
        await recovery().visit(alone);
        await reconciliation().drainOnce();
        expect(await exposureCase(alone)).toBeUndefined();
        expect((await acknowledge((await reviewOf2('partial_chargeback', alone))!.id, 'reviewed_no_financial_effect')).status).toBe(200);
        const b = await assistedPaid();
        const rb = await relayed(b.paymentId);
        await atPayment(b.paymentId, rb.attemptId, 'discrepancy');
        discrepancyItem(b.paymentId, rb.attemptId);
        await reconciliation().drainOnce();
        expect((await acknowledge((await reviewOf2('refund_discrepancy', rb.attemptId))!.id, 'duplicate_evidence_reviewed')).status).toBe(200);
        const c = await assistedPaid();
        await relayed(c.paymentId); // live, no verified money yet
        const flight = await lose(c.paymentId, 70);
        await recovery().visit(flight);
        await reconciliation().drainOnce();
        expect(await exposureCase(flight)).toBeUndefined();
        expect((await acknowledge((await reviewOf2('partial_chargeback', flight))!.id, 'reviewed_no_financial_effect')).status).toBe(200);
      });

      /** A verified loss bound to ANOTHER capture of the payment (a late capture): an ordinary refund of the payment is not its movement. */
      const loseOtherCapture = async (paymentId: string, amount: number) => {
        const id = randomUUID();
        const disputeId = randomUUID();
        await t.bus.deliver({ id, name: 'payment.dispute.lost', payload: { disputeId, paymentId, paymentRequestId: randomUUID(), producer: 'billing-service', organizationId: null, purpose: 'assisted_settlement',
          amount, currency: 'TND', lostAt: new Date().toISOString(), chargeback: { factId: randomUUID(), amount, currency: 'TND' }, liveMode: false, captureFactId: randomUUID(), captureBasis: 'late_capture',
        }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } } as never);
        return disputeId;
      };

      it('R14: a relay of another capture is no exposure; an unknown relay fails closed; a refund completed on another capture closes nothing', async () => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        await atPayment(p.paymentId, r.attemptId, 'discrepancy');
        discrepancyItem(p.paymentId, r.attemptId);
        const other = await loseOtherCapture(p.paymentId, 70);
        await reconciliation().drainOnce();
        expect((await one(`SELECT billing_loss_unresolved_exposure($1) AS e`, [other])).e).toBe(false);
        expect(await exposureCase(other)).toBeUndefined();

        const q = await assistedPaid();
        const rq = await relayed(q.paymentId);
        const late = await loseOtherCapture(q.paymentId, 70);
        discrepancyItem(q.paymentId, randomUUID());
        await reconciliation().drainOnce();
        await reconciliation().drainOnce();
        const c = (await exposureCase(late))!;
        expect(c).toMatchObject({ detail: 'refund_evidence_unresolved', kind: null });
        await completed(rq, q); // the ordinary refund completes: another capture than the loss's
        await reconciliation().drainOnce();
        expect(await overlapCase(late)).toBeUndefined();
        expect(await exposureCase(late)).toMatchObject({ kind: null });
        await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "refundCaseId") VALUES ($1, 'refund_completed', $2)`, [c.id, rq.caseId]))
          .rejects.toMatchObject({ constraint: 'reconciliation_case_resolution_evidence' });
      });

      it('R15 and the exit: an earlier acknowledgement stays as recorded, the case opens from the facts; refund_completed needs the same movement AND the overlap case', async () => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        const disputeId = await lose(p.paymentId, 70);
        await recovery().visit(disputeId);
        await reconciliation().drainOnce();
        const partial = (await reviewOf2('partial_chargeback', disputeId))!;
        expect((await acknowledge(partial.id, 'reviewed_no_financial_effect')).status).toBe(200); // legitimate then: no refund evidence yet
        const before = await reviewOf2('partial_chargeback', disputeId);
        await atPayment(p.paymentId, r.attemptId, 'discrepancy');
        discrepancyItem(p.paymentId, r.attemptId);
        answer(p.paymentId, r.attemptId, 60);
        await reconciliation().drainOnce();
        const c = (await exposureCase(disputeId))!;
        expect(c).toMatchObject({ detail: 'refund_money_verified', kind: null });
        expect(await reviewOf2('partial_chargeback', disputeId)).toEqual(before);
        await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "refundCaseId") VALUES ($1, 'refund_completed', $2)`, [c.id, r.caseId])).rejects.toThrow();
        await completed(r, p);
        // the case completed, the overlap case does not exist yet: the database still refuses
        expect(await overlapCase(disputeId)).toBeUndefined();
        await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, "refundCaseId") VALUES ($1, 'refund_completed', $2)`, [c.id, r.caseId]))
          .rejects.toMatchObject({ constraint: 'reconciliation_case_resolution_evidence' });
        await reconciliation().drainOnce();
        expect(await overlapCase(disputeId)).toMatchObject({ kind: null });
        expect(await exposureCase(disputeId)).toMatchObject({ kind: 'refund_completed', refundCaseId: r.caseId });
      });

      it('S0-C14 stays as it was: with a completed refund the overlap governs; provider_statement_reviewed and duplicate_evidence_reviewed still acknowledge an overlap review (A2)', async () => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        const disputeId = await lose(p.paymentId, 70);
        await recovery().visit(disputeId);
        await completed(r, p);
        await reconciliation().drainOnce();
        expect(await overlapCase(disputeId)).toMatchObject({ kind: null });
        expect(await exposureCase(disputeId)).toBeUndefined();
        const partial = (await reviewOf2('partial_chargeback', disputeId))!;
        const a = await acknowledge(partial.id, 'reviewed_no_financial_effect');
        expect([a.status, a.body.code]).toEqual([409, 'reconciliation_case_in_overlap']);
        expect((await acknowledge(partial.id, 'duplicate_evidence_reviewed')).status).toBe(200);
      });
    });


    describe('Core V2 S0-C15B: contested refund and dispute evidence stays Owner-visible (BIL-33 O, DO-56, DO-57)', () => {
      const caseOf = (type: string, evidence: string) => one(`SELECT c.*, r.kind, r.reason FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
        WHERE c."caseType" = $1 AND c."evidenceKey" = $2`, [type, evidence]);
      const evidenceOf = (caseId: string) => one(`SELECT "paymentId", "refundFactId", "refundAttemptId", "captureFactId" FROM reconciliation_contest_evidence WHERE "caseId" = $1`, [caseId]);
      const now = () => new Date().toISOString();
      const push = (kind: PaymentItemKind, item: PaymentItem) => paymentItems.items.set(kind, [...(paymentItems.items.get(kind) ?? []), item]);
      /** Payment's producer item for a recorded contradiction of refund fact `factId` (the contested amount is the observation's, never the fact's). */
      const contradiction = (paymentId: string, factId: string, refundAttemptId: unknown, contested = 15000) => push('fact_conflict',
        { kind: 'fact_conflict', id: randomUUID(), paymentId, factId, amount: contested, currency: 'TND', detail: { attemptId: randomUUID(), refundAttemptId, source: 'webhook' }, at: now() } as PaymentItem);
      const presence = (paymentId: string, id = randomUUID()) => {
        push('dispute_conflict_presence', { kind: 'dispute_conflict_presence', id, paymentId, factId: null, amount: null, currency: null, detail: {}, at: now() } as PaymentItem);
        return id;
      };
      const discrepancy = (paymentId: string, id: string) => push('refund_discrepancy',
        { kind: 'refund_discrepancy', id, paymentId, factId: null, amount: 4200, currency: 'TND', detail: {}, at: now() } as PaymentItem);
      const partial = (paymentId: string, disputeId = randomUUID()) => {
        push('chargeback', { kind: 'chargeback', id: randomUUID(), paymentId, factId: randomUUID(), amount: 700, currency: 'TND', detail: { disputeId, partial: true }, at: now() } as PaymentItem);
        return disputeId;
      };
      /** PAY-08: refund fact `factId` VERIFIED and allocated to the authorization of `attemptId` (or, `allocated: false`, held unallocated under that attempt). */
      const pay08States = (paymentId: string, attemptId: string, factId: string, amount: number, allocated = true) => pay08.answers.set(paymentId, {
        attempts: [{ refundAttemptId: attemptId, status: 'succeeded', approvedBy: { userId: U.owner } }], refusals: [],
        authorizations: allocated ? [{ refundAuthorizationId: randomUUID(), refundAttemptId: attemptId, refundCaseId: randomUUID(), approvedAmount: amount, currency: 'TND',
          completedAt: now(), allocations: [{ factId, amount, currency: 'TND' }] }] : [],
        unallocatedFacts: allocated ? [] : [{ factId, refundAttemptId: attemptId, amount, currency: 'TND', state: 'blocked' }] });
      const buy = (kind: 'assisted' | 'direct') => (kind === 'assisted' ? assistedPaid() : directPurchase());
      const openedAudits = async (caseId: string) => count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.opened' AND payload->'resource'->>'id' = $1`, [caseId]);
      /** Every financial record and every earlier case or resolution of a payment: S0-C15B may only ADD its own cases and evidence. */
      const records = async (p: { paymentId: string; paymentRequestId: string }) => ({
        refundCases: (await admin.query(`SELECT * FROM refund_case WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
        relays: (await admin.query(`SELECT * FROM refund_authorization_relay WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
        purchases: (await admin.query(`SELECT s.*, r.cause FROM subscription_purchase s LEFT JOIN subscription_purchase_reversal r ON r."purchaseId" = s.id WHERE s."paymentRequestId" = $1 ORDER BY s.id`, [p.paymentRequestId])).rows,
        losses: (await admin.query(`SELECT * FROM financial_loss WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
        disputeLosses: (await admin.query(`SELECT * FROM payment_dispute_loss WHERE "paymentId" = $1 ORDER BY "disputeId"`, [p.paymentId])).rows,
        obligations: (await admin.query(`SELECT o.* FROM recovery_obligation o JOIN payment_dispute_loss l ON l."disputeId" = o."disputeId" WHERE l."paymentId" = $1 ORDER BY o.id`, [p.paymentId])).rows,
        earlierCases: (await admin.query(`SELECT c.*, r.kind, r.reason, r."resolvedAt", r."resolvedByUserId" FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
          WHERE (c."paymentId" = $1 OR c."paymentRequestId" = $2) AND c."caseType" NOT IN ('refund_fact_contested', 'dispute_conflict_observed') ORDER BY c.id`, [p.paymentId, p.paymentRequestId])).rows,
      });

      for (const kind of ['assisted', 'direct'] as const) {
        it(`T1, T2, T15 (${kind}): a contested refund fact opens ONE case with the VERIFIED amount (allocated, or not yet); its evidence binds Billing's own relay and capture; replays add nothing; no financial record moves`, async () => {
          for (const allocated of [true, false]) {
            const p = await buy(kind);
            const r = await relayed(p.paymentId);
            const before = await records(p);
            const factId = randomUUID();
            pay08States(p.paymentId, r.attemptId, factId, p.amount, allocated);
            contradiction(p.paymentId, factId, r.attemptId, p.amount + 5000);
            await reconciliation().drainOnce();
            await reconciliation().drainOnce();
            const c = await caseOf('refund_fact_contested', factId);
            expect(c).toMatchObject({ paymentId: p.paymentId, amount: String(p.amount), currency: 'TND', detail: allocated ? 'contested_after_allocation' : 'contested_unallocated', kind: null });
            const capture = (await one(`SELECT "captureFactId" FROM refund_case WHERE id = $1`, [r.caseId])).captureFactId;
            expect(await evidenceOf(c.id)).toEqual({ paymentId: p.paymentId, refundFactId: factId, refundAttemptId: r.attemptId, captureFactId: capture });
            expect(c.captureFactId).toBe(capture);
            expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_fact_contested' AND "evidenceKey" = $1`, [factId])).toBe(1);
            expect(await openedAudits(c.id)).toBe(1);
            expect(await records(p)).toEqual(before);
          }
        });

        it(`T4, T15 (${kind}): a dispute conflict opens ONE redacted case (no figure, capture or detail); the Owner sees it, cannot acknowledge it; replays add nothing`, async () => {
          const p = await buy(kind);
          const before = await records(p);
          const id = presence(p.paymentId);
          await reconciliation().drainOnce();
          await reconciliation().drainOnce();
          const c = await caseOf('dispute_conflict_observed', id);
          expect(c).toMatchObject({ paymentId: p.paymentId, amount: null, currency: null, captureFactId: null, detail: null, kind: null });
          expect(await openedAudits(c.id)).toBe(1);
          const listed = (await send(request(server()).get('/billing/admin/reconciliation-cases?status=open&type=dispute_conflict_observed'), 'owner-tok', null)).body.items as Record<string, unknown>[];
          expect(listed.find((x) => x.id === c.id)).toMatchObject({ evidenceId: id, amount: null, currency: null, detail: null, reviewOnly: false, status: 'open' });
          for (const reason of ['reviewed_no_financial_effect', 'provider_statement_reviewed', 'duplicate_evidence_reviewed']) {
            const a = await acknowledge(c.id, reason);
            expect([a.status, a.body.code], reason).toEqual([409, 'reconciliation_case_not_acknowledgeable']);
          }
          expect(await records(p)).toEqual(before);
        });
      }

      it('T12 (B-D6): inconsistent or unavailable Payment reads open nothing and change nothing; the same evidence opens its case once the reads agree (retry never discards it)', async () => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        const factId = randomUUID();
        contradiction(p.paymentId, factId, r.attemptId);
        const before = await records(p);
        const nothing = async () => {
          await reconciliation().drainOnce();
          expect(await caseOf('refund_fact_contested', factId)).toBeUndefined();
          expect(await records(p)).toEqual(before);
        };
        pay08.answers.set(p.paymentId, 'down'); await nothing(); // Payment unavailable
        pay08.answers.set(p.paymentId, null); await nothing(); // Payment's 404 for Billing's own payment
        pay08.answers.set(p.paymentId, { attempts: [], refusals: [], authorizations: [], unallocatedFacts: [] }); await nothing(); // the fact is not stated
        pay08States(p.paymentId, randomUUID(), factId, p.amount); await nothing(); // stated under ANOTHER refund attempt
        pay08.answers.set(p.paymentId, { attempts: [], refusals: [], authorizations: [], unallocatedFacts: null }); await nothing(); // no producer view of unallocated facts
        const odd = randomUUID();
        contradiction(p.paymentId, odd, 'not-a-uuid');
        pay08States(p.paymentId, r.attemptId, odd, p.amount);
        await reconciliation().drainOnce();
        expect(await caseOf('refund_fact_contested', odd)).toBeUndefined(); // an unreadable refund attempt: no provider fact is invented
        pay08States(p.paymentId, r.attemptId, factId, p.amount);
        await reconciliation().drainOnce();
        expect(await caseOf('refund_fact_contested', factId)).toMatchObject({ detail: 'contested_after_allocation', kind: null });
        expect(await records(p)).toEqual(before);
      });

      it('T3 (B-D8, as amended by DO-73): a fact blocked for currency_mismatch or no_authorization, or merely unallocated, opens no contest (Billing now reads allocation_blocked for DO-73 only)', async () => {
        const p = await directPurchase();
        const r = await relayed(p.paymentId);
        const blocked = randomUUID();
        push('allocation_blocked' as PaymentItemKind, { kind: 'allocation_blocked', id: blocked, paymentId: p.paymentId, factId: blocked, amount: 100, currency: 'TND',
          detail: { reason: 'currency_mismatch' }, at: now() } as unknown as PaymentItem);
        pay08States(p.paymentId, r.attemptId, blocked, 100, false);
        paymentItems.asked.clear();
        await reconciliation().drainOnce();
        expect([...paymentItems.asked]).toContain('allocation_blocked'); // Core V2 DO-73: read for refund_fact_unallocated, never for a contest
        expect([...paymentItems.asked]).toContain('dispute_conflict_presence');
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_fact_contested' AND "paymentId" = $1`, [p.paymentId])).toBe(0);
      });

      it('T5, T6, T7 (B-D4): on a contested movement no financial effect is refused; a duplicate is refused only on the contested attempt\'s own case; a provider statement stays available; an earlier acknowledgement stands', async () => {
        // the refund contest
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        expect(await atPayment(p.paymentId, r.attemptId, 'discrepancy')).toBe('discrepancy');
        discrepancy(p.paymentId, r.attemptId);
        const unrelated = randomUUID();
        discrepancy(p.paymentId, unrelated); // a genuine, unrelated review case of the same payment (no relay, no contest)
        const earlier = randomUUID();
        discrepancy(p.paymentId, earlier);
        await reconciliation().drainOnce();
        const own = (await caseOf('refund_discrepancy', r.attemptId))!;
        const other = (await caseOf('refund_discrepancy', unrelated))!;
        const before = (await caseOf('refund_discrepancy', earlier))!;
        expect((await acknowledge(before.id, 'reviewed_no_financial_effect')).status).toBe(200); // BEFORE any contest exists (T5)
        const stood = await one(`SELECT * FROM reconciliation_case_resolution WHERE "caseId" = $1`, [before.id]);
        const factId = randomUUID();
        pay08States(p.paymentId, r.attemptId, factId, p.amount);
        contradiction(p.paymentId, factId, r.attemptId);
        await reconciliation().drainOnce();
        expect(await caseOf('refund_fact_contested', factId)).toMatchObject({ kind: null });
        for (const reason of ['reviewed_no_financial_effect', 'duplicate_evidence_reviewed']) {
          const a = await acknowledge(own.id, reason);
          expect([a.status, a.body.code], reason).toEqual([409, 'reconciliation_case_contested']);
        }
        const n1 = await acknowledge(other.id, 'reviewed_no_financial_effect');
        expect([n1.status, n1.body.code]).toEqual([409, 'reconciliation_case_contested']); // the movement is contested: no financial effect cannot be stated
        expect((await acknowledge(other.id, 'duplicate_evidence_reviewed')).status).toBe(200); // an unrelated genuine duplicate is not prohibited
        expect((await acknowledge(own.id, 'provider_statement_reviewed')).status).toBe(200);
        expect(await one(`SELECT * FROM reconciliation_case_resolution WHERE "caseId" = $1`, [before.id])).toEqual(stood); // the earlier acknowledgement stands
        // the dispute conflict
        const d = await directPurchase();
        const dispute = partial(d.paymentId);
        const dup = randomUUID();
        discrepancy(d.paymentId, dup);
        await reconciliation().drainOnce();
        const pc = (await caseOf('partial_chargeback', dispute))!;
        const dc = (await caseOf('refund_discrepancy', dup))!;
        presence(d.paymentId);
        await reconciliation().drainOnce();
        const n2 = await acknowledge(pc.id, 'reviewed_no_financial_effect');
        expect([n2.status, n2.body.code]).toEqual([409, 'reconciliation_case_contested']);
        expect((await acknowledge(dc.id, 'duplicate_evidence_reviewed')).status).toBe(200); // a dispute conflict never prohibits a duplicate review
        expect((await acknowledge(pc.id, 'provider_statement_reviewed')).status).toBe(200);
      });

      it('T8: past the application the database refuses every resolution of the new types and no financial effect on a contested movement, through the same function', async () => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        const factId = randomUUID();
        pay08States(p.paymentId, r.attemptId, factId, p.amount);
        contradiction(p.paymentId, factId, r.attemptId);
        const id = presence(p.paymentId);
        const disc = randomUUID();
        discrepancy(p.paymentId, disc);
        await reconciliation().drainOnce();
        const contest = (await caseOf('refund_fact_contested', factId))!;
        const conflict = (await caseOf('dispute_conflict_observed', id))!;
        const review = (await caseOf('refund_discrepancy', disc))!;
        const resolve = (caseId: string, kind: string, reason: string | null) => admin.query(
          `INSERT INTO reconciliation_case_resolution ("caseId", kind, "resolvedByUserId", reason) VALUES ($1, $2, $3, $4)`, [caseId, kind, kind === 'acknowledged' ? U.owner : null, reason]);
        for (const c of [contest, conflict]) {
          for (const reason of ['provider_statement_reviewed', 'duplicate_evidence_reviewed', 'reviewed_no_financial_effect']) {
            await expect(resolve(c.id, 'acknowledged', reason)).rejects.toMatchObject({ code: '23514' });
          }
          for (const k of ['effect_applied', 'authorization_resolved', 'late_settlement_applied', 'surplus_refunded', 'surplus_repaid']) {
            await expect(resolve(c.id, k, null)).rejects.toMatchObject({ constraint: 'reconciliation_case_resolution_evidence' });
          }
        }
        await expect(resolve(review.id, 'acknowledged', 'reviewed_no_financial_effect')).rejects.toMatchObject({ constraint: 'reconciliation_case_contest_acknowledgement' });
        expect(await caseOf('refund_fact_contested', factId)).toMatchObject({ kind: null });
        expect(await caseOf('dispute_conflict_observed', id)).toMatchObject({ kind: null });
      });

      it('T16: contest evidence cannot associate another payment, fact, refund attempt or capture; a case never commits without it; evidence is append-only', async () => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        const q2 = await assistedPaid();
        const r2 = await relayed(q2.paymentId);
        const capture = (await one(`SELECT "captureFactId" FROM refund_case WHERE id = $1`, [r.caseId])).captureFactId as string | null;
        const company = (await one(`SELECT i."sellerId" FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId" WHERE pr."paymentId" = $1`, [p.paymentId])).sellerId as string;
        const attempt = async (ev: (caseId: string, factId: string) => unknown[], type = 'refund_fact_contested', caseCapture: string | null = capture) => {
          const c = await admin.connect();
          try {
            await c.query('BEGIN');
            const factId = randomUUID();
            const caseId = (await c.query(`INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId", "paymentId", "captureFactId", amount, currency, detail)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`, type === 'refund_fact_contested'
              ? [type, factId, company, p.paymentId, caseCapture, 100, 'TND', 'contested_unallocated'] : [type, factId, company, p.paymentId, null, null, null, null])).rows[0].id as string;
            const v = ev(caseId, factId);
            if (v.length) await c.query(`INSERT INTO reconciliation_contest_evidence ("caseId", "paymentId", "refundFactId", "refundAttemptId", "captureFactId") VALUES ($1, $2, $3, $4, $5)`, v);
            await c.query('COMMIT');
            return 'committed';
          } catch (e) {
            await c.query('ROLLBACK');
            return (e as { constraint?: string }).constraint ?? String(e);
          } finally {
            c.release();
          }
        };
        expect(await attempt((caseId, f) => [caseId, q2.paymentId, f, null, null])).toBe('reconciliation_contest_evidence_case'); // another payment
        expect(await attempt((caseId) => [caseId, p.paymentId, randomUUID(), null, null])).toBe('reconciliation_contest_evidence_case'); // another fact
        expect(await attempt((caseId, f) => [caseId, p.paymentId, f, r2.attemptId, null])).toBe('reconciliation_contest_evidence_attempt'); // a relay of another payment
        expect(await attempt((caseId, f) => [caseId, p.paymentId, f, r.attemptId, randomUUID()])).toBe('reconciliation_contest_evidence_capture_supplied'); // a supplied capture
        expect(await attempt((caseId, f) => [caseId, p.paymentId, f, r.attemptId, null], 'refund_fact_contested', randomUUID())).toBe('reconciliation_contest_evidence_capture'); // case names another capture
        expect(await attempt((caseId, f) => [caseId, p.paymentId, f, null, null], 'dispute_conflict_observed')).toBe('reconciliation_contest_evidence_case'); // not a refund contest
        expect(await attempt(() => [])).toBe('reconciliation_case_contest_evidence_missing'); // a contest case without its evidence: refused at commit
        expect(await attempt((caseId, f) => [caseId, p.paymentId, f, r.attemptId, null])).toBe('committed'); // the one valid binding
        const ok = (await one(`SELECT e."caseId" FROM reconciliation_contest_evidence e JOIN reconciliation_case c ON c.id = e."caseId" WHERE e."paymentId" = $1`, [p.paymentId])).caseId;
        await expect(admin.query(`UPDATE reconciliation_contest_evidence SET "refundAttemptId" = NULL WHERE "caseId" = $1`, [ok])).rejects.toBeTruthy();
        await expect(admin.query(`DELETE FROM reconciliation_contest_evidence WHERE "caseId" = $1`, [ok])).rejects.toBeTruthy();
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case c WHERE c."caseType" = 'refund_fact_contested' AND NOT EXISTS (SELECT 1 FROM reconciliation_contest_evidence e WHERE e."caseId" = c.id)`, [])).toBe(0);
      });

      it('T11: S0-C14 and S0-C15A keep precedence: the overlap answers first, then the exposure, then the contest', async () => {
        // exposure (S0-C15A) and a dispute conflict on the same payment
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        expect(await atPayment(p.paymentId, r.attemptId, 'discrepancy')).toBe('discrepancy');
        const disputeId = await lose(p.paymentId, 70);
        await recovery().visit(disputeId);
        discrepancy(p.paymentId, r.attemptId);
        pay08.answers.set(p.paymentId, { attempts: [{ refundAttemptId: r.attemptId, status: 'discrepancy', approvedBy: { userId: U.owner } }], refusals: [], unallocatedFacts: [],
          authorizations: [{ refundAuthorizationId: randomUUID(), refundAttemptId: r.attemptId, refundCaseId: r.caseId, approvedAmount: 100, currency: 'TND', completedAt: null,
            allocations: [{ factId: randomUUID(), amount: 60, currency: 'TND' }] }] });
        presence(p.paymentId);
        await reconciliation().drainOnce();
        const pc = (await caseOf('partial_chargeback', disputeId))!;
        const a = await acknowledge(pc.id, 'reviewed_no_financial_effect');
        expect([a.status, a.body.code]).toEqual([409, 'reconciliation_case_in_exposure']);
        // overlap (S0-C14) and a dispute conflict on the same payment
        const o = await assistedPaid();
        const ro = await relayed(o.paymentId);
        const d2 = await lose(o.paymentId, 70);
        await recovery().visit(d2);
        await completed(ro, o);
        presence(o.paymentId);
        await reconciliation().drainOnce();
        const pc2 = (await caseOf('partial_chargeback', d2))!;
        const b = await acknowledge(pc2.id, 'reviewed_no_financial_effect');
        expect([b.status, b.body.code]).toEqual([409, 'reconciliation_case_in_overlap']);
        expect(await overlapCase(d2)).toMatchObject({ kind: null });
      });

      it('T18 (B-D11): against a Payment that does not know the presence kind, every other kind is still read; the conflict case opens once Payment does (nothing discarded)', async () => {
        const p = await directPurchase();
        const disc = randomUUID();
        discrepancy(p.paymentId, disc);
        const id = presence(p.paymentId);
        paymentItems.unsupported.add('dispute_conflict_presence');
        try {
          const tally = await reconciliation().drainOnce();
          expect(tally.read).toBe(true);
          expect(await caseOf('refund_discrepancy', disc)).toMatchObject({ kind: null });
          expect(await caseOf('dispute_conflict_observed', id)).toBeUndefined();
        } finally {
          paymentItems.unsupported.delete('dispute_conflict_presence');
        }
        await reconciliation().drainOnce();
        expect(await caseOf('dispute_conflict_observed', id)).toMatchObject({ kind: null });
      });

      it('T20 (in place): historical cases, acknowledgements and financial records are untouched when the new cases open beside them', async () => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        const disc = randomUUID();
        discrepancy(p.paymentId, disc);
        await reconciliation().drainOnce();
        expect((await acknowledge((await caseOf('refund_discrepancy', disc))!.id, 'reviewed_no_financial_effect')).status).toBe(200);
        const before = await records(p);
        const factId = randomUUID();
        pay08States(p.paymentId, r.attemptId, factId, p.amount);
        contradiction(p.paymentId, factId, r.attemptId);
        presence(p.paymentId);
        await reconciliation().drainOnce();
        await reconciliation().drainOnce();
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "paymentId" = $1 AND "caseType" IN ('refund_fact_contested', 'dispute_conflict_observed')`, [p.paymentId])).toBe(2);
        expect(await records(p)).toEqual(before);
      });
    });

    describe('Core V2 DO-73: verified refund facts Payment cannot allocate stay Owner-visible (BIL-33 P; U-1 to U-7)', () => {
      const caseOf = (type: string, evidence: string) => one(`SELECT c.*, r.kind, r.reason FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
        WHERE c."caseType" = $1 AND c."evidenceKey" = $2`, [type, evidence]);
      const evidenceOf = (caseId: string) => one(`SELECT "paymentId", "refundFactId", "refundAttemptId", "relayId", "captureFactId", "blockedReason" FROM reconciliation_unallocated_evidence WHERE "caseId" = $1`, [caseId]);
      const now = () => new Date().toISOString();
      const push = (kind: PaymentItemKind, item: PaymentItem) => paymentItems.items.set(kind, [...(paymentItems.items.get(kind) ?? []), item]);
      /** Payment's producer item `allocation_blocked` for refund fact `factId` (its id IS the fact's); no figures when its currency is unusable (as parsed). */
      const blockedItem = (paymentId: string, factId: string, reason: string, amount: number | null, currency: string | null) => push('allocation_blocked',
        { kind: 'allocation_blocked', id: factId, paymentId, factId, amount, currency, detail: { reason }, at: now() } as PaymentItem);
      /** PAY-08 states refund fact `factId` of attempt `attemptId` unallocated: blocked with `reason` (or pending), Payment's own figures. */
      const pay08Blocked = (paymentId: string, attemptId: string | null, factId: string, amount: number, currency: string, over: Record<string, unknown> = {}) => pay08.answers.set(paymentId, {
        attempts: attemptId ? [{ refundAttemptId: attemptId, status: 'discrepancy', approvedBy: { userId: U.owner } }] : [], refusals: [], authorizations: [],
        unallocatedFacts: [{ factId, refundAttemptId: attemptId, amount, currency, state: 'blocked', blockedReason: 'currency_mismatch', ...over } as never] });
      const contradiction = (paymentId: string, factId: string, refundAttemptId: string) => push('fact_conflict',
        { kind: 'fact_conflict', id: randomUUID(), paymentId, factId, amount: 15000, currency: 'TND', detail: { attemptId: randomUUID(), refundAttemptId, source: 'webhook' }, at: now() } as PaymentItem);
      const discrepancy = (paymentId: string, id: string) => push('refund_discrepancy',
        { kind: 'refund_discrepancy', id, paymentId, factId: null, amount: 4200, currency: 'TND', detail: {}, at: now() } as PaymentItem);
      const buy = (kind: 'assisted' | 'direct') => (kind === 'assisted' ? assistedPaid() : directPurchase());
      const openedAudits = async (caseId: string) => count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.opened' AND payload->'resource'->>'id' = $1`, [caseId]);
      const cancel = (caseId: string) => send(request(server()).post(`/billing/admin/refund-cases/${caseId}/cancel`), 'owner-tok', key());
      /** A relay Payment answers `authorization_refused` (Auth refused the receipt): the attempt is never authorized nor dispatched. */
      const refusedRelay = async (paymentId: string) => {
        const caseId = (await send(request(server()).post('/billing/admin/refund-cases'), 'owner-tok', key()).send({ paymentId, reason: 'customer_request' })).body.id as string;
        relayAnswer.status = 'authorization_refused';
        try {
          const r = await send(request(server()).post(`/billing/admin/refund-cases/${caseId}/authorizations`), 'owner-tok', key()).send({ receiptSecret: randomBytes(32).toString('base64url') });
          expect([r.status, r.body.code]).toEqual([409, 'refund_authorization_invalid']);
        } finally {
          relayAnswer.status = null;
        }
        const relay = await one(`SELECT id, "attemptStatus" FROM refund_authorization_relay WHERE "refundCaseId" = $1`, [caseId]);
        expect(relay.attemptStatus).toBe('authorization_refused');
        return { caseId, attemptId: relay.id as string };
      };
      /** Every financial record and every earlier case or resolution of a payment: DO-73 may only ADD its own case and evidence. */
      const records = async (p: { paymentId: string; paymentRequestId: string }) => ({
        refundCases: (await admin.query(`SELECT * FROM refund_case WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
        relays: (await admin.query(`SELECT * FROM refund_authorization_relay WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
        purchases: (await admin.query(`SELECT s.*, r.cause FROM subscription_purchase s LEFT JOIN subscription_purchase_reversal r ON r."purchaseId" = s.id WHERE s."paymentRequestId" = $1 ORDER BY s.id`, [p.paymentRequestId])).rows,
        losses: (await admin.query(`SELECT * FROM financial_loss WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
        disputeLosses: (await admin.query(`SELECT * FROM payment_dispute_loss WHERE "paymentId" = $1 ORDER BY "disputeId"`, [p.paymentId])).rows,
        obligations: (await admin.query(`SELECT o.* FROM recovery_obligation o JOIN payment_dispute_loss l ON l."disputeId" = o."disputeId" WHERE l."paymentId" = $1 ORDER BY o.id`, [p.paymentId])).rows,
        earlierCases: (await admin.query(`SELECT c.*, r.kind, r.reason, r."resolvedAt", r."resolvedByUserId" FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
          WHERE (c."paymentId" = $1 OR c."paymentRequestId" = $2) AND c."caseType" <> 'refund_fact_unallocated' ORDER BY c.id`, [p.paymentId, p.paymentRequestId])).rows,
      });

      for (const kind of ['assisted', 'direct'] as const) {
        it(`I-1 (T1, T2, T3, T7, T8; ${kind}): each verified block (currency_mismatch with its own figures, no_authorization) opens ONE case and ONE evidence row bound to Billing's relay and capture; replays add nothing; no financial record moves`, async () => {
          for (const reason of ['currency_mismatch', 'no_authorization'] as const) {
            const p = await buy(kind);
            const r = reason === 'no_authorization' ? await refusedRelay(p.paymentId) : await relayed(p.paymentId);
            const before = await records(p);
            const factId = randomUUID();
            const currency = reason === 'currency_mismatch' ? 'EUR' : 'TND';
            pay08Blocked(p.paymentId, r.attemptId, factId, p.amount, currency, { blockedReason: reason });
            blockedItem(p.paymentId, factId, reason, p.amount, currency);
            await reconciliation().drainOnce();
            await reconciliation().drainOnce(); // a second pass: nothing new
            const c = await caseOf('refund_fact_unallocated', factId);
            expect(c, reason).toMatchObject({ paymentId: p.paymentId, amount: String(p.amount), currency, detail: reason, kind: null, companyId: COMPANY });
            const capture = (await one(`SELECT "captureFactId" FROM refund_case WHERE id = $1`, [r.caseId])).captureFactId;
            expect(await evidenceOf(c.id)).toEqual({ paymentId: p.paymentId, refundFactId: factId, refundAttemptId: r.attemptId, relayId: r.attemptId, captureFactId: capture, blockedReason: reason });
            expect(c.captureFactId).toBe(capture);
            expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_fact_unallocated' AND "evidenceKey" = $1`, [factId])).toBe(1);
            expect(await openedAudits(c.id)).toBe(1);
            expect(await records(p)).toEqual(before);
            for (const ack of ['reviewed_no_financial_effect', 'provider_statement_reviewed', 'duplicate_evidence_reviewed']) {
              const a = await acknowledge(c.id, ack);
              expect([a.status, a.body.code], ack).toEqual([409, 'reconciliation_case_not_acknowledgeable']); // interim fail-closed
            }
            const listed = (await send(request(server()).get('/billing/admin/reconciliation-cases?status=open&type=refund_fact_unallocated'), 'owner-tok', null)).body.items as Record<string, unknown>[];
            expect(listed.find((x) => x.id === c.id)).toMatchObject({ evidenceId: factId, detail: reason, reviewOnly: false, status: 'open' });
          }
        });
      }

      it('I-2 (T13, U-4): a currency that is not three capital letters is never truncated or converted: a figure-less case; Payment stays authoritative', async () => {
        for (const odd of ['EURO', 'eur', 'E']) {
          const p = await directPurchase();
          const r = await relayed(p.paymentId);
          const factId = randomUUID();
          pay08Blocked(p.paymentId, r.attemptId, factId, 900, odd);
          blockedItem(p.paymentId, factId, 'currency_mismatch', null, null); // Billing's item parser keeps such an item with no figures
          await reconciliation().drainOnce();
          expect(await caseOf('refund_fact_unallocated', factId), odd).toMatchObject({ amount: null, currency: null, detail: 'currency_mismatch', kind: null });
        }
        // an item WITH figures beside a PAY-08 fact whose currency is unusable disagrees: nothing opens
        const p = await directPurchase();
        const r = await relayed(p.paymentId);
        const factId = randomUUID();
        pay08Blocked(p.paymentId, r.attemptId, factId, 900, 'EURO');
        blockedItem(p.paymentId, factId, 'currency_mismatch', 900, 'EUR');
        await reconciliation().drainOnce();
        expect(await caseOf('refund_fact_unallocated', factId)).toBeUndefined();
      });

      it('I-3 (T9, T10, U-6): Payment unavailable, 404, without unallocated facts, or disagreeing in any way opens nothing and changes nothing; once both reads agree the case opens', async () => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        const factId = randomUUID();
        blockedItem(p.paymentId, factId, 'currency_mismatch', p.amount, 'EUR');
        const before = await records(p);
        const nothing = async (why: string) => {
          await reconciliation().drainOnce();
          expect(await caseOf('refund_fact_unallocated', factId), why).toBeUndefined();
          expect(await records(p), why).toEqual(before);
        };
        pay08.answers.set(p.paymentId, 'down'); await nothing('payment unavailable');
        pay08.answers.set(p.paymentId, null); await nothing('404');
        pay08.answers.set(p.paymentId, { attempts: [], refusals: [], authorizations: [], unallocatedFacts: null }); await nothing('no producer view');
        pay08.answers.set(p.paymentId, { attempts: [], refusals: [], authorizations: [], unallocatedFacts: [] }); await nothing('fact not stated');
        pay08Blocked(p.paymentId, r.attemptId, factId, p.amount, 'EUR', { state: 'pending', blockedReason: null }); await nothing('still pending');
        pay08Blocked(p.paymentId, r.attemptId, factId, p.amount, 'EUR', { blockedReason: 'no_authorization' }); await nothing('another reason');
        pay08Blocked(p.paymentId, r.attemptId, factId, p.amount, 'EUR', { blockedReason: undefined }); await nothing('no reason stated');
        pay08Blocked(p.paymentId, r.attemptId, factId, p.amount + 1, 'EUR'); await nothing('another amount');
        pay08Blocked(p.paymentId, r.attemptId, factId, p.amount, 'USD'); await nothing('another currency');
        pay08Blocked(p.paymentId, null, factId, p.amount, 'EUR'); await nothing('no refund attempt');
        paymentItems.down = true;
        try { pay08Blocked(p.paymentId, r.attemptId, factId, p.amount, 'EUR'); await nothing('items unavailable'); } finally { paymentItems.down = false; }
        // malformed items: an unknown reason, an id that is not the fact's
        const odd = randomUUID();
        blockedItem(p.paymentId, odd, 'some_new_reason', p.amount, 'EUR');
        push('allocation_blocked', { kind: 'allocation_blocked', id: randomUUID(), paymentId: p.paymentId, factId: odd, amount: p.amount, currency: 'EUR', detail: { reason: 'currency_mismatch' }, at: now() } as PaymentItem);
        pay08Blocked(p.paymentId, r.attemptId, odd, p.amount, 'EUR');
        await reconciliation().drainOnce();
        expect(await caseOf('refund_fact_unallocated', odd)).toBeUndefined();
        // the reads agree: the case opens (U-6: eventually, from the same evidence)
        pay08Blocked(p.paymentId, r.attemptId, factId, p.amount, 'EUR');
        await reconciliation().drainOnce();
        expect(await caseOf('refund_fact_unallocated', factId)).toMatchObject({ detail: 'currency_mismatch', kind: null });
        expect(await records(p)).toEqual(before);
      });

      it('I-4 (T1, T4, T15, U-6): an acknowledgement before discovery stands; after it, no financial effect is refused on the movement, a duplicate only on the blocked attempt\'s own case, a provider statement stays', async () => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        expect(await atPayment(p.paymentId, r.attemptId, 'discrepancy')).toBe('discrepancy');
        discrepancy(p.paymentId, r.attemptId);
        const unrelated = randomUUID();
        discrepancy(p.paymentId, unrelated);
        const earlier = randomUUID();
        discrepancy(p.paymentId, earlier);
        await reconciliation().drainOnce();
        const own = (await caseOf('refund_discrepancy', r.attemptId))!;
        const other = (await caseOf('refund_discrepancy', unrelated))!;
        const historic = (await caseOf('refund_discrepancy', earlier))!;
        expect((await acknowledge(historic.id, 'reviewed_no_financial_effect')).status).toBe(200); // before discovery: Step 0 A's acknowledgement
        const factId = randomUUID();
        pay08Blocked(p.paymentId, r.attemptId, factId, p.amount, 'EUR');
        blockedItem(p.paymentId, factId, 'currency_mismatch', p.amount, 'EUR');
        await reconciliation().drainOnce();
        expect(await caseOf('refund_fact_unallocated', factId)).toMatchObject({ kind: null });
        expect(await caseOf('refund_discrepancy', earlier)).toMatchObject({ kind: 'acknowledged', reason: 'reviewed_no_financial_effect' }); // historical, unchanged
        for (const c of [own, other]) {
          const a = await acknowledge(c.id, 'reviewed_no_financial_effect');
          expect([a.status, a.body.code]).toEqual([409, 'reconciliation_case_refund_unallocated']);
        }
        const dup = await acknowledge(own.id, 'duplicate_evidence_reviewed');
        expect([dup.status, dup.body.code]).toEqual([409, 'reconciliation_case_refund_unallocated']);
        expect((await acknowledge(other.id, 'duplicate_evidence_reviewed')).status).toBe(200); // an unrelated genuine duplicate stays available
        expect((await acknowledge(own.id, 'provider_statement_reviewed')).status).toBe(200);
        // the database refuses the bypass too
        const third = randomUUID();
        discrepancy(p.paymentId, third);
        await reconciliation().drainOnce();
        await expect(admin.query(`INSERT INTO reconciliation_case_resolution ("caseId", kind, reason, "resolvedByUserId") VALUES ($1, 'acknowledged', 'reviewed_no_financial_effect', $2)`,
          [(await caseOf('refund_discrepancy', third))!.id, randomUUID()])).rejects.toMatchObject({ constraint: 'reconciliation_case_unallocated_acknowledgement' });
      });

      it('I-5 (T3, T5, U-2 O1): a refused-relay case cancelled BEFORE discovery stands, and its case still opens, linked to that relay; AFTER discovery the cancellation is refused by the service and by the database', async () => {
        // before discovery: Billing holds nothing; the cancellation commits (no cross-service atomicity is claimed)
        const a = await directPurchase();
        const ra = await refusedRelay(a.paymentId);
        expect((await cancel(ra.caseId)).status).toBe(200);
        const fa = randomUUID();
        pay08Blocked(a.paymentId, ra.attemptId, fa, a.amount, 'TND', { blockedReason: 'no_authorization' });
        blockedItem(a.paymentId, fa, 'no_authorization', a.amount, 'TND');
        await reconciliation().drainOnce();
        const ca = (await caseOf('refund_fact_unallocated', fa))!;
        expect(await evidenceOf(ca.id)).toMatchObject({ relayId: ra.attemptId, blockedReason: 'no_authorization' });
        expect((await one(`SELECT status FROM refund_case WHERE id = $1`, [ra.caseId])).status).toBe('cancelled'); // stands; durably visible beside it
        // after discovery: refused, and the database refuses the bypass
        const b = await assistedPaid();
        const rb = await refusedRelay(b.paymentId);
        const fb = randomUUID();
        pay08Blocked(b.paymentId, rb.attemptId, fb, b.amount, 'TND', { blockedReason: 'no_authorization' });
        blockedItem(b.paymentId, fb, 'no_authorization', b.amount, 'TND');
        await reconciliation().drainOnce();
        const c = await cancel(rb.caseId);
        expect([c.status, c.body.code]).toEqual([409, 'refund_case_refund_evidence']);
        await expect(admin.query(`UPDATE refund_case SET status = 'cancelled' WHERE id = $1`, [rb.caseId])).rejects.toMatchObject({ constraint: 'refund_case_refund_evidence_unallocated' });
        expect((await one(`SELECT status FROM refund_case WHERE id = $1`, [rb.caseId])).status).toBe('open');
        // a refused case of ANOTHER payment is still cancellable (the guard is per refund case)
        const d = await directPurchase();
        const rd = await refusedRelay(d.paymentId);
        expect((await cancel(rd.caseId)).status).toBe(200);
      });

      it('I-6 (T6): a cancellation in flight while the case is discovered (it waits on the case lock, the case and its evidence commit meanwhile) is refused; never cancelled beside recorded evidence', async () => {
        const p = await directPurchase();
        const rr = await refusedRelay(p.paymentId);
        const lateFact = randomUUID();
        // LABELLED TEST AID: a row lock on the refund case, held by the test, keeps the cancellation waiting inside its transaction
        const holder = await admin.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(`SELECT 1 FROM refund_case WHERE id = $1 FOR UPDATE`, [rr.caseId]);
          const pending = cancel(rr.caseId);
          await new Promise((res) => setTimeout(res, 300));
          pay08Blocked(p.paymentId, rr.attemptId, lateFact, p.amount, 'TND', { blockedReason: 'no_authorization' });
          blockedItem(p.paymentId, lateFact, 'no_authorization', p.amount, 'TND');
          await reconciliation().drainOnce();
          expect(await caseOf('refund_fact_unallocated', lateFact)).toMatchObject({ kind: null });
          await holder.query('COMMIT');
          const out = await pending;
          expect([out.status, out.body.code]).toEqual([409, 'refund_case_refund_evidence']);
        } finally {
          holder.release();
        }
        expect((await one(`SELECT status FROM refund_case WHERE id = $1`, [rr.caseId])).status).toBe('open');
      });

      it('I-7 (U-5 test 8): a failure between the case and its evidence leaves no orphan case and no audit intent; the next pass opens both', async () => {
        const p = await directPurchase();
        const r = await relayed(p.paymentId);
        const factId = randomUUID();
        pay08Blocked(p.paymentId, r.attemptId, factId, p.amount, 'EUR');
        blockedItem(p.paymentId, factId, 'currency_mismatch', p.amount, 'EUR');
        await admin.query(`CREATE FUNCTION pg_temp_do73_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected' USING ERRCODE = '40001'; END $$;
          CREATE TRIGGER zz_do73_injected BEFORE INSERT ON reconciliation_unallocated_evidence FOR EACH ROW EXECUTE FUNCTION pg_temp_do73_fail();`);
        try {
          await reconciliation().drainOnce();
          expect(await caseOf('refund_fact_unallocated', factId)).toBeUndefined();
          expect(await count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.opened' AND payload->'changes'->>'evidence_id' = $1`, [factId])).toBe(0);
        } finally {
          await admin.query(`DROP TRIGGER zz_do73_injected ON reconciliation_unallocated_evidence; DROP FUNCTION pg_temp_do73_fail();`);
        }
        await reconciliation().drainOnce();
        const c = (await caseOf('refund_fact_unallocated', factId))!;
        expect(await evidenceOf(c.id)).toMatchObject({ refundFactId: factId });
        expect(await openedAudits(c.id)).toBe(1);
      });

      it('I-8 (T16, U-1; U-5 tests 5 and 7): a contested block opens no unallocated case; a currency_mismatch block that is ALSO contested opens both cases, and the acknowledgement rules combine', async () => {
        const p = await directPurchase();
        const r = await relayed(p.paymentId);
        const contested = randomUUID();
        pay08Blocked(p.paymentId, r.attemptId, contested, p.amount, 'TND', { blockedReason: 'contested' });
        blockedItem(p.paymentId, contested, 'contested', p.amount, 'TND');
        await reconciliation().drainOnce();
        expect(await caseOf('refund_fact_unallocated', contested)).toBeUndefined();
        const q = await directPurchase();
        const rq = await relayed(q.paymentId);
        const both = randomUUID();
        pay08Blocked(q.paymentId, rq.attemptId, both, q.amount, 'EUR');
        blockedItem(q.paymentId, both, 'currency_mismatch', q.amount, 'EUR');
        contradiction(q.paymentId, both, rq.attemptId);
        await reconciliation().drainOnce();
        expect(await caseOf('refund_fact_unallocated', both)).toMatchObject({ detail: 'currency_mismatch', currency: 'EUR', kind: null });
        expect(await caseOf('refund_fact_contested', both)).toMatchObject({ detail: 'contested_unallocated', currency: 'EUR', kind: null });
      });

      it('I-9 (in place; historical cases beside the new case): historical cases, acknowledgements and financial records are untouched when the case opens beside them; nothing is written to any financial table', async () => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        const disc = randomUUID();
        discrepancy(p.paymentId, disc);
        await reconciliation().drainOnce();
        expect((await acknowledge((await caseOf('refund_discrepancy', disc))!.id, 'reviewed_no_financial_effect')).status).toBe(200);
        const before = await records(p);
        const tables = async () => Object.fromEntries(await Promise.all(['financial_loss', 'recovery_obligation', 'subscription_purchase_reversal', 'refund_case_completion', 'refund_case_effect',
          'reconciliation_case_resolution'].map(async (t2) => [t2, await count(`SELECT count(*) AS n FROM ${t2}`)])));
        const counts = await tables();
        const factId = randomUUID();
        pay08Blocked(p.paymentId, r.attemptId, factId, p.amount, 'EUR');
        blockedItem(p.paymentId, factId, 'currency_mismatch', p.amount, 'EUR');
        await reconciliation().drainOnce();
        await reconciliation().drainOnce();
        expect(await caseOf('refund_fact_unallocated', factId)).toMatchObject({ kind: null });
        expect(await records(p)).toEqual(before);
        expect(await tables()).toEqual(counts);
      });

      it('I-10 (T20, Billing side): an allocation_blocked item on a payment Billing holds no Company sale of (unknown to Billing) opens nothing: no case, no evidence, no audit intent, no failure', async () => {
        const paymentId = randomUUID();
        const factId = randomUUID();
        const attemptId = randomUUID();
        pay08Blocked(paymentId, attemptId, factId, 4900, 'EUR');
        blockedItem(paymentId, factId, 'currency_mismatch', 4900, 'EUR');
        const before = await count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.opened'`);
        await reconciliation().drainOnce();
        await reconciliation().drainOnce();
        expect(await caseOf('refund_fact_unallocated', factId)).toBeUndefined();
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "paymentId" = $1 OR "evidenceKey" = $2`, [paymentId, factId])).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM reconciliation_unallocated_evidence WHERE "paymentId" = $1`, [paymentId])).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.opened'`)).toBe(before);
      });
    });

    describe('Core V2 DO-74 (observer side): a refund attempt\'s own observation of a fact that is not its payment\'s stays Owner-visible and contested (BIL-33 Q)', () => {
      const caseOf = (type: string, evidence: string) => one(`SELECT c.*, r.kind, r.reason FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
        WHERE c."caseType" = $1 AND c."evidenceKey" = $2`, [type, evidence]);
      const evidenceOf = (caseId: string) => one(`SELECT "paymentId", "refundAttemptId", "observationId", "captureFactId" FROM reconciliation_observation_evidence WHERE "caseId" = $1`, [caseId]);
      const now = () => new Date().toISOString();
      const push = (kind: PaymentItemKind, item: PaymentItem) => paymentItems.items.set(kind, [...(paymentItems.items.get(kind) ?? []), item]);
      /** Payment's producer item: an observation of THIS payment's attempt contradicting fact `factId` (not this payment's; Billing never stores it). */
      const observation = (paymentId: string, refundAttemptId: unknown, factId = randomUUID(), id = randomUUID()) => {
        push('fact_conflict', { kind: 'fact_conflict', id, paymentId, factId, amount: 9000, currency: 'TND', detail: { attemptId: randomUUID(), refundAttemptId, source: 'webhook' }, at: now() } as PaymentItem);
        return id;
      };
      const discrepancy = (paymentId: string, id: string) => push('refund_discrepancy',
        { kind: 'refund_discrepancy', id, paymentId, factId: null, amount: 4200, currency: 'TND', detail: {}, at: now() } as PaymentItem);
      /** PAY-08 (producer view): the attempt in discrepancy, the contradicted fact NOT stated, and `observationConflicts` as given. */
      const pay08Observed = (paymentId: string, attemptId: string, observationConflicts: PaymentRefunds['observationConflicts']) => pay08.answers.set(paymentId, {
        attempts: [{ refundAttemptId: attemptId, status: 'discrepancy', approvedBy: { userId: U.owner } }], refusals: [], authorizations: [], unallocatedFacts: [], observationConflicts });
      const own = (attemptId: string, ids: string[]) => [{ refundAttemptId: attemptId, conflictIds: ids, observations: ids.length }];
      const buy = (kind: 'assisted' | 'direct') => (kind === 'assisted' ? assistedPaid() : directPurchase());
      const openedAudits = async (caseId: string) => count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.reconciliation_case.opened' AND payload->'resource'->>'id' = $1`, [caseId]);
      /** Every financial record and every earlier case or resolution of a payment: DO-74 may only ADD its own case and evidence. */
      const records = async (p: { paymentId: string; paymentRequestId: string }) => ({
        refundCases: (await admin.query(`SELECT * FROM refund_case WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
        relays: (await admin.query(`SELECT * FROM refund_authorization_relay WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
        purchases: (await admin.query(`SELECT s.*, r.cause FROM subscription_purchase s LEFT JOIN subscription_purchase_reversal r ON r."purchaseId" = s.id WHERE s."paymentRequestId" = $1 ORDER BY s.id`, [p.paymentRequestId])).rows,
        losses: (await admin.query(`SELECT * FROM financial_loss WHERE "paymentId" = $1 ORDER BY id`, [p.paymentId])).rows,
        disputeLosses: (await admin.query(`SELECT * FROM payment_dispute_loss WHERE "paymentId" = $1 ORDER BY "disputeId"`, [p.paymentId])).rows,
        obligations: (await admin.query(`SELECT o.* FROM recovery_obligation o JOIN payment_dispute_loss l ON l."disputeId" = o."disputeId" WHERE l."paymentId" = $1 ORDER BY o.id`, [p.paymentId])).rows,
        earlierCases: (await admin.query(`SELECT c.*, r.kind, r.reason, r."resolvedAt", r."resolvedByUserId" FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id
          WHERE (c."paymentId" = $1 OR c."paymentRequestId" = $2) AND c."caseType" <> 'refund_observation_conflict' ORDER BY c.id`, [p.paymentId, p.paymentRequestId])).rows,
      });

      for (const kind of ['assisted', 'direct'] as const) {
        it(`D1/D2 (${kind}): reads that agree open ONE figure-free case per observing attempt, bound to Billing's own relay and capture; repeated observations and passes add nothing; the Owner sees it and can close neither it nor the attempt's discrepancy as a duplicate or as having no financial effect; nothing financial moves`, async () => {
          const p = await buy(kind);
          const r = await relayed(p.paymentId);
          discrepancy(p.paymentId, r.attemptId);
          await reconciliation().drainOnce();
          const disc = (await caseOf('refund_discrepancy', r.attemptId))!;
          const before = await records(p);
          const factId = randomUUID();
          const first = observation(p.paymentId, r.attemptId, factId);
          pay08Observed(p.paymentId, r.attemptId, own(r.attemptId, [first]));
          await reconciliation().drainOnce();
          const c = (await caseOf('refund_observation_conflict', r.attemptId))!;
          expect(c).toMatchObject({ paymentId: p.paymentId, amount: null, currency: null, detail: null, kind: null });
          const capture = (await one(`SELECT "captureFactId" FROM refund_case WHERE id = $1`, [r.caseId])).captureFactId;
          expect(c.captureFactId).toBe(capture);
          expect(await evidenceOf(c.id)).toEqual({ paymentId: p.paymentId, refundAttemptId: r.attemptId, observationId: first, captureFactId: capture });
          expect(JSON.stringify(await one(`SELECT * FROM reconciliation_case WHERE id = $1`, [c.id]))).not.toContain(factId); // nothing of the fact is held
          expect(JSON.stringify(await evidenceOf(c.id))).not.toContain(factId);
          // repeated notifications (new observation ids of the same attempt) and further passes: the same case, nothing more
          const second = observation(p.paymentId, r.attemptId, factId);
          const third = observation(p.paymentId, r.attemptId, randomUUID());
          pay08Observed(p.paymentId, r.attemptId, own(r.attemptId, [first, second, third]));
          await reconciliation().drainOnce();
          await reconciliation().drainOnce();
          expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_observation_conflict' AND "paymentId" = $1`, [p.paymentId])).toBe(1);
          expect(await count(`SELECT count(*) AS n FROM reconciliation_observation_evidence WHERE "paymentId" = $1`, [p.paymentId])).toBe(1);
          expect(await openedAudits(c.id)).toBe(1);
          const listed = (await send(request(server()).get('/billing/admin/reconciliation-cases?status=open&type=refund_observation_conflict'), 'owner-tok', null)).body.items as Record<string, unknown>[];
          expect(listed.find((x) => x.id === c.id)).toMatchObject({ evidenceId: r.attemptId, amount: null, currency: null, detail: null, reviewOnly: false, status: 'open' });
          for (const reason of ['reviewed_no_financial_effect', 'provider_statement_reviewed', 'duplicate_evidence_reviewed']) {
            const a = await acknowledge(c.id, reason);
            expect([a.status, a.body.code], reason).toEqual([409, 'reconciliation_case_not_acknowledgeable']);
          }
          // the R1 defect, corrected: the observing attempt's own discrepancy cannot be closed as a duplicate, nor as having no financial effect
          for (const reason of ['duplicate_evidence_reviewed', 'reviewed_no_financial_effect']) {
            const a = await acknowledge(disc.id, reason);
            expect([a.status, a.body.code], reason).toEqual([409, 'reconciliation_case_contested']);
          }
          expect((await acknowledge(disc.id, 'provider_statement_reviewed')).status).toBe(200); // still available
          const after = await records(p);
          expect({ ...after, earlierCases: after.earlierCases.filter((x) => x.id !== disc.id) }).toEqual({ ...before, earlierCases: before.earlierCases.filter((x) => x.id !== disc.id) });
          expect(await caseOf('refund_fact_contested', factId)).toBeUndefined(); // never S0-C15B's case: the fact is not this payment's
        });
      }

      it('D9 (B-D6): every disagreement or unavailable read opens nothing and changes nothing; the same evidence opens its case once the reads agree (retry never discards it)', async () => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        const id = observation(p.paymentId, r.attemptId);
        const before = await records(p);
        const nothing = async (why: string) => {
          await reconciliation().drainOnce();
          expect(await caseOf('refund_observation_conflict', r.attemptId), why).toBeUndefined();
          expect(await records(p), why).toEqual(before);
        };
        pay08.answers.set(p.paymentId, 'down'); await nothing('Payment unavailable');
        pay08.answers.set(p.paymentId, null); await nothing('Payment 404 for Billing\'s own payment');
        pay08Observed(p.paymentId, r.attemptId, null); await nothing('an older Payment (field absent)');
        pay08Observed(p.paymentId, r.attemptId, 'malformed'); await nothing('a malformed field');
        pay08Observed(p.paymentId, r.attemptId, []); await nothing('no observation stated');
        pay08Observed(p.paymentId, r.attemptId, own(randomUUID(), [id])); await nothing('the observation stated under ANOTHER attempt');
        pay08Observed(p.paymentId, r.attemptId, own(r.attemptId, [randomUUID()])); await nothing('the attempt stated without THIS observation');
        const odd = observation(p.paymentId, 'not-a-uuid');
        pay08Observed(p.paymentId, r.attemptId, own(r.attemptId, [odd])); await nothing('an item with an unreadable attempt');
        pay08Observed(p.paymentId, r.attemptId, own(r.attemptId, [id]));
        await reconciliation().drainOnce();
        expect(await caseOf('refund_observation_conflict', r.attemptId)).toMatchObject({ kind: null });
        expect(await records(p)).toEqual(before);
      });

      it('D5 (control): a contradiction of the payment\'s OWN fact stays S0-C15B\'s refund_fact_contested; no observation case opens', async () => {
        const p = await directPurchase();
        const r = await relayed(p.paymentId);
        const factId = randomUUID();
        observation(p.paymentId, r.attemptId, factId);
        pay08.answers.set(p.paymentId, { attempts: [{ refundAttemptId: r.attemptId, status: 'succeeded', approvedBy: { userId: U.owner } }], refusals: [], unallocatedFacts: [],
          authorizations: [{ refundAuthorizationId: randomUUID(), refundAttemptId: r.attemptId, refundCaseId: r.caseId, approvedAmount: p.amount, currency: 'TND', completedAt: now(),
            allocations: [{ factId, amount: p.amount, currency: 'TND' }] }], observationConflicts: [] });
        await reconciliation().drainOnce();
        expect(await caseOf('refund_fact_contested', factId)).toMatchObject({ detail: 'contested_after_allocation' });
        expect(await caseOf('refund_observation_conflict', r.attemptId)).toBeUndefined();
      });

      it('an attempt Billing holds no relay of (or a relay of another payment) opens nothing, and no case without its evidence ever commits', async () => {
        const p = await assistedPaid();
        const q = await assistedPaid();
        const rq = await relayed(q.paymentId);
        const stranger = randomUUID();
        const a = observation(p.paymentId, stranger);
        const b = observation(p.paymentId, rq.attemptId); // the other payment's relay, named under p
        pay08.answers.set(p.paymentId, { attempts: [], refusals: [], authorizations: [], unallocatedFacts: [],
          observationConflicts: [...own(stranger, [a]), ...own(rq.attemptId, [b])] });
        await reconciliation().drainOnce();
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "caseType" = 'refund_observation_conflict' AND ("evidenceKey" = $1 OR "evidenceKey" = $2)`, [stranger, rq.attemptId])).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case c WHERE c."caseType" = 'refund_observation_conflict'
          AND NOT EXISTS (SELECT 1 FROM reconciliation_observation_evidence e WHERE e."caseId" = c.id)`)).toBe(0);
      });

      it('D8 (in-process): two reconciliation passes at once open ONE case, ONE evidence row and ONE audit intent', async () => {
        const p = await directPurchase();
        const r = await relayed(p.paymentId);
        const id = observation(p.paymentId, r.attemptId);
        pay08Observed(p.paymentId, r.attemptId, own(r.attemptId, [id]));
        await Promise.all([reconciliation().drainOnce(), reconciliation().drainOnce(), reconciliation().drainOnce()]);
        const c = (await caseOf('refund_observation_conflict', r.attemptId))!;
        expect(await count(`SELECT count(*) AS n FROM reconciliation_observation_evidence WHERE "refundAttemptId" = $1`, [r.attemptId])).toBe(1);
        expect(await openedAudits(c.id)).toBe(1);
      });

      it('D14 (in place): an acknowledgement recorded before the case opened stands; historical cases and financial records are untouched', async () => {
        const p = await assistedPaid();
        const r = await relayed(p.paymentId);
        discrepancy(p.paymentId, r.attemptId);
        await reconciliation().drainOnce();
        const disc = (await caseOf('refund_discrepancy', r.attemptId))!;
        expect((await acknowledge(disc.id, 'duplicate_evidence_reviewed')).status).toBe(200); // before DO-74 knew of the observation
        const before = await records(p);
        const id = observation(p.paymentId, r.attemptId);
        pay08Observed(p.paymentId, r.attemptId, own(r.attemptId, [id]));
        await reconciliation().drainOnce();
        expect(await caseOf('refund_observation_conflict', r.attemptId)).toMatchObject({ kind: null });
        expect(await records(p)).toEqual(before); // the earlier acknowledgement stands, unchanged
        expect((await caseOf('refund_discrepancy', r.attemptId))).toMatchObject({ kind: 'acknowledged', reason: 'duplicate_evidence_reviewed' });
      });

      it('a payment Billing holds no Company sale of opens nothing: no case, evidence or audit intent', async () => {
        const paymentId = randomUUID();
        const attemptId = randomUUID();
        const id = observation(paymentId, attemptId);
        pay08Observed(paymentId, attemptId, own(attemptId, [id]));
        await reconciliation().drainOnce();
        expect(await count(`SELECT count(*) AS n FROM reconciliation_case WHERE "paymentId" = $1`, [paymentId])).toBe(0);
        expect(await count(`SELECT count(*) AS n FROM reconciliation_observation_evidence WHERE "paymentId" = $1`, [paymentId])).toBe(0);
      });
    });
  });

  it('production mounts no recovery route and no worker', () => {
    expect(RecoveryModule.register({ isProduction: true } as BillingConfig)).toEqual({ module: RecoveryModule });
  });
});

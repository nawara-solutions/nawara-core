import { randomUUID } from 'node:crypto';
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
import { AssistanceModule } from '../src/assistance/assistance.module.js';
import { AssistanceSettlementService } from '../src/assistance/assistance-settlement.service.js';
import { CashReturnSweep } from '../src/assistance/cash-return-sweep.js';
import type { BillingConfig } from '../src/config/billing-config.js';
import type { PaymentEventFacts, PaymentEventName } from '../src/domain/payment-event-decision.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import type { CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import { createTestApp, type TestApp } from './support/app.js';
import { anchorOccurrence } from './support/billing-calendar.js';
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

const COMPANY = randomUUID();
const PLATFORM = randomUUID();
const ORG = randomUUID();
const ORG2 = randomUUID();
const U = { b1: randomUUID(), b2: randomUUID(), a1: randomUUID(), a2: randomUUID(), adminBeneficiary: randomUUID(), m1: randomUUID(), owner: randomUUID() };
const membership = (organizationId: string, o: { admin?: boolean; status?: AuthMembership['status'] } = {}): AuthMembership => ({
  id: randomUUID(), organization: { id: organizationId }, platform: { id: PLATFORM }, status: o.status ?? 'active', isOrganizationAdmin: o.admin ?? false,
});
const HOUR = 3_600_000;

/**
 * Core V2 S5b assisted electronic settlement and cash-return obligations (register BIL-16, BIL-17; ADR-0044 B2, B7, B14; S0 DB-5, DB-12,
 * DB-13, FC-8; the Owner's E-1 to E-13), for DEVELOPMENT AND SIMULATION ONLY: the real application on real PostgreSQL 16, Auth's `/auth/me`
 * stubbed per bearer (asked on every request), the Organization reference stubbed, Payment scripted behind the real dispatcher, and Payment's
 * verified events delivered through the real strict consumer.
 */
describeWithEnv('assisted settlement and cash return (Core V2 S5b, simulation) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const payment = new FakePaymentClient();
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
  const key = () => `s5b-${++k}-${randomUUID().slice(0, 8)}`;
  const send = (r: request.Test, bearer: string | null, idem: string | null) => {
    if (bearer) r = r.set('authorization', `Bearer ${bearer}`);
    if (idem) r = r.set('idempotency-key', idem);
    return r;
  };
  const create = (body: unknown, bearer = 'b1') => send(request(server()).post('/billing/assistance-requests'), bearer, key()).send(body as object);
  const read = (id: string, bearer = 'a1') => send(request(server()).get(`/billing/assistance-requests/${id}`), bearer, null);
  const reportCash = (id: string, at: string, bearer = 'a1') => send(request(server()).post(`/billing/assistance-requests/${id}/cash-collection`), bearer, key()).send({ cashCollectedAt: at });
  const settle = (id: string, bearer: string | null = 'a1', idem: string | null = key(), body?: unknown) => {
    const r = send(request(server()).post(`/billing/assistance-requests/${id}/settlement`), bearer, idem);
    return body === undefined ? r.send() : r.send(body as object);
  };
  const reportReturn = (id: string, returnedAt: unknown, bearer: string | null = 'a1', idem: string | null = key(), extra: Row = {}) =>
    send(request(server()).post(`/billing/cash-return-obligations/${id}/return`), bearer, idem).send({ returnedAt, ...extra });
  const entitlement = (userId: string, productId: string) =>
    request(server()).get(`/billing/users/${userId}/platforms/${PLATFORM}/products/${productId}/entitlement`).set('authorization', `Bearer ${producer.token}`);

  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n);
  const audit = async (resourceId: string) =>
    (await admin.query(`SELECT name, payload FROM outbox WHERE name LIKE 'audit.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", name`, [resourceId])).rows as Row[];
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const dispatch = () => t.app.get(PaymentDispatcher).dispatchOnce(0, 100);
  const sweep = () => t.app.get(CashReturnSweep).sweepOnce();

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
  const channelOf = async (invoiceId: string) => (await one(`SELECT status FROM assistance_settlement_channel WHERE "invoiceId" = $1`, [invoiceId])).status as string;
  const statusOf = async (id: string) => (await one(`SELECT status FROM assistance_request WHERE id = $1`, [id])).status as string;
  const purchases = (id: string) => count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [id]);
  const obligations = (id: string) => count(`SELECT count(*) AS n FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [id]);

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings5b');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    await admin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [PLATFORM, COMPANY, randomUUID()]);
    delegation = (await admin.query(`INSERT INTO fee_delegation ("platformId", "operatorUserId", "grantedBy") VALUES ($1, $2, $3) RETURNING id`, [PLATFORM, operator, randomUUID()])).rows[0].id;
    await setCap(5000);
    t = await createTestApp({
      databaseUrl: db.url, authClient, organizationReference: reference, paymentClient: payment,
      tokens: [{ caller: 'test-producer', digest: producer.digest }],
      env: { BILLING_SERVICE_POLICY: JSON.stringify({ callers: { 'test-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: [PLATFORM] } } }) },
    });
  });
  beforeEach(() => resetIdentities());
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the simulation, end to end

  it('SIMULATION: assistance → consent → cash → Organization settlement → dispatcher → verified payment.succeeded → beneficiary purchase → entitlement', async () => {
    const r = await collected({ unit: 9000, fee: 1500 });
    expect(r.terms).toMatchObject({ baseAmount: 9000, feeAmount: 1500, totalAmount: 10_500 });
    const before = Number((await one(`SELECT count(*) AS n FROM subscription_purchase`)).n);
    const s = await settle(r.id);
    expect(s.status).toBe(201);
    expect(s.body).toEqual({ invoiceId: expect.any(String), paymentRequestId: expect.any(String), paymentId: null }); // E-1: never invented

    // E-3: an Organization payer, the frozen BASE only (the fee stays outside), routed assisted_settlement to the beneficiary (DB-5)
    const inv = await one(`SELECT * FROM invoice WHERE id = $1`, [s.body.invoiceId]);
    expect(inv).toMatchObject({ producer: 'billing-assistance', status: 'open', payerType: 'organization', payerId: ORG, organizationId: ORG, sellerType: 'company', sellerId: COMPANY, currency: 'TND', total: '9000' });
    expect(inv.issuerSnapshot).toEqual({ schemaVersion: 2, partyType: 'company', companyId: COMPANY, platformId: PLATFORM, legalIdentity: 'not_determined' });
    expect((await admin.query(`SELECT "priceId", "productId", quantity, "unitAmount" FROM invoice_line WHERE "invoiceId" = $1`, [inv.id])).rows).toEqual([{ priceId: r.priceId, productId: r.productId, quantity: 1, unitAmount: '9000' }]);
    expect(await one(`SELECT purpose, target, "payerType", "payerId", "beneficiaryUserId", "organizationId", "productId", "assistanceRequestId" FROM invoice_entitlement WHERE "invoiceId" = $1`, [inv.id]))
      .toEqual({ purpose: 'assisted_settlement', target: 'personal', payerType: 'organization', payerId: ORG, beneficiaryUserId: U.b1, organizationId: ORG, productId: r.productId, assistanceRequestId: r.id });
    expect(await channelOf(inv.id)).toBe('open');
    expect((await audit(r.id)).map((e) => e.name)).toContain('audit.assistance_request.settlement_requested');
    expect((await audit(r.id)).find((e) => e.name === 'audit.assistance_request.settlement_requested')!.payload).toMatchObject({
      actor: { type: 'user', id: U.a1, userKind: 'member' }, organizationId: ORG, changes: { invoice_id: inv.id, payment_request_id: s.body.paymentRequestId },
    });

    // the dispatcher sends Payment exactly the Organization payer, the purpose and the beneficiary (mapping version 2)
    const { paymentId } = await accepted(s.body.paymentRequestId);
    expect(payment.calls.at(-1)).toMatchObject({ paymentRequestId: s.body.paymentRequestId, payer: { type: 'organization', id: ORG }, organizationId: ORG, amount: 9000, currency: 'TND', purpose: 'assisted_settlement', beneficiaryUserId: U.b1 });
    const view = (await read(r.id)).body;
    expect(view.settlementChannels).toEqual([expect.objectContaining({ status: 'open', invoiceId: inv.id, paymentRequestId: s.body.paymentRequestId, paymentId, paymentRequestStatus: 'requested' })]);
    expect((await entitlement(U.b1, r.productId).expect(200)).body).toEqual({ valid: false, expiresAt: null }); // a requested payment grants nothing

    const event = paymentEvent('payment.succeeded', inv, s.body.paymentRequestId, paymentId, U.b1);
    await t.bus.deliver(event);
    const settledAt = new Date(event.headers.occurredAt as string);
    expect(await one(`SELECT status FROM invoice WHERE id = $1`, [inv.id])).toEqual({ status: 'paid' });
    expect((await admin.query(`SELECT purpose, "beneficiaryUserId", "productId", "priceId", "assistanceRequestId" FROM subscription_purchase WHERE "invoiceId" = $1`, [inv.id])).rows)
      .toEqual([{ purpose: 'assisted_settlement', beneficiaryUserId: U.b1, productId: r.productId, priceId: r.priceId, assistanceRequestId: r.id }]);
    expect(await channelOf(inv.id)).toBe('settled');
    expect(await statusOf(r.id)).toBe('settled');
    expect((await entitlement(U.b1, r.productId).expect(200)).body).toEqual({ valid: true, expiresAt: anchorOccurrence(settledAt, 1).toISOString() });
    expect((await entitlement(U.a1, r.productId).expect(200)).body).toEqual({ valid: false, expiresAt: null }); // never the payer's administrator
    expect((await read(r.id, 'b1')).body).toMatchObject({ status: 'settled', overdue: false, cashReturnObligation: null });

    // exactly once: a redelivery, and later sweeps, change nothing; no obligation ever opens for a settled request
    await t.bus.deliver(event, 'verified_duplicate');
    await expireDeadline(r.id);
    await sweep();
    expect([await purchases(r.id), await obligations(r.id)]).toEqual([1, 0]);
    expect(Number((await one(`SELECT count(*) AS n FROM subscription_purchase`)).n)).toBe(before + 1);
    // E-10: a settled request is resolved, so the beneficiary may ask again for the same product
    expect((await create({ organizationId: ORG, productId: r.productId, priceId: r.priceId, consent: true })).status).toBe(201);
  });

  it('SIMULATION (unsuccessful): cash → settlement fails → deadline → cash-return obligation → Organization reports the return; never a purchase', async () => {
    const r = await collected({ beneficiary: 'b2', fee: 700 });
    const s = await started(r.id, U.b2);
    await t.bus.deliver(s.ev('payment.failed'));
    expect(await channelOf(s.invoiceId)).toBe('closed'); // an authoritative final unsuccessful outcome
    await sweep();
    expect(await obligations(r.id)).toBe(0); // before the deadline: the Organization may still retry
    await expireDeadline(r.id);
    const retry = await settle(r.id);
    expect([retry.status, retry.body.code]).toEqual([409, 'assistance_request_not_settleable']); // no new channel past the deadline

    await sweep();
    await sweep(); // idempotent
    expect(await obligations(r.id)).toBe(1);
    const o = await one(`SELECT * FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [r.id]);
    expect(o).toMatchObject({ status: 'open', organizationId: ORG, beneficiaryUserId: U.b2, amount: String(r.terms.totalAmount), currency: 'TND' }); // base + fee
    expect(Number(o.amount)).toBe(r.terms.baseAmount + 700);
    expect((await audit(o.id)).map((e) => [e.name, e.payload.actor])).toEqual([['audit.cash_return_obligation.opened', { type: 'system', id: 'assistance_sweep' }]]);
    expect((await audit(o.id))[0].payload).toMatchObject({ organizationId: ORG, changes: { assistance_request_id: r.id, amount: Number(o.amount) } });
    expect((await read(r.id, 'b2')).body).toMatchObject({ status: 'cash_collected', overdue: true, cashReturnObligation: { id: o.id, status: 'open', amount: Number(o.amount) } });

    const rr = await reportReturn(o.id, ago(60_000));
    expect(rr.status).toBe(200);
    expect(rr.body).toMatchObject({ id: o.id, status: 'return_reported', amount: Number(o.amount) });
    expect((await one(`SELECT "returnReportedBy" FROM cash_return_obligation WHERE id = $1`, [o.id])).returnReportedBy).toBe(U.a1);
    expect((await audit(o.id)).map((e) => e.name)).toEqual(['audit.cash_return_obligation.opened', 'audit.cash_return_obligation.return_reported']);
    // reported, not discharged: the request stays unresolved (D-7, E-10) and overdue; no purchase, no entitlement, ever
    expect((await create({ organizationId: ORG, productId: r.productId, priceId: r.priceId, consent: true }, 'b2')).body.code).toBe('assistance_request_open');
    expect((await read(r.id, 'b2')).body).toMatchObject({ status: 'cash_collected', overdue: true, cashReturnObligation: { status: 'return_reported' } });
    expect(await purchases(r.id)).toBe(0);
    expect((await entitlement(U.b2, r.productId).expect(200)).body).toEqual({ valid: false, expiresAt: null });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── authority (E-1, E-2)

  describe('settlement authority (E-1)', () => {
    it('only a live Organization actor of the request\'s Organization; the beneficiary is 403; anyone else the collapsed 404; Auth down 503', async () => {
      const r = await collected();
      expect((await settle(r.id, 'b1')).status).toBe(403);
      for (const bearer of ['b2', 'm1', 'a2', 'owner']) expect((await settle(r.id, bearer)).status, bearer).toBe(404);
      identities.get('a1')!.memberships[0].isOrganizationAdmin = false; // a revoked administrator
      expect((await settle(r.id, 'a1')).status).toBe(404);
      resetIdentities();
      identities.get('a1')!.memberships[0].status = 'revoked'; // an inactive membership
      expect((await settle(r.id, 'a1')).status).toBe(404);
      resetIdentities();
      expect((await settle(r.id, 'auth-down')).status).toBe(503);
      expect((await settle(r.id, producer.token)).status).toBe(401);
      expect((await settle(r.id, null)).status).toBe(401);
      expect((await settle(randomUUID())).status).toBe(404);
      expect(await count(`SELECT count(*) AS n FROM assistance_settlement_channel WHERE "assistanceRequestId" = $1`, [r.id])).toBe(0);
      // an administrator who is the beneficiary of their own request may never settle it for the Organization
      const own = await collected({ beneficiary: 'admin-beneficiary' });
      expect((await settle(own.id, 'admin-beneficiary')).status).toBe(403);
    });

    it('needs recorded cash collection, before the deadline, with no purchase or obligation (409 assistance_request_not_settleable)', async () => {
      const productId = await productOf();
      const priceId = await priceOf(productId);
      const pending = await create({ organizationId: ORG, productId, priceId, consent: true }, 'b2');
      expect((await settle(pending.body.id)).body.code).toBe('assistance_request_not_settleable');
      expect((await send(request(server()).post(`/billing/assistance-requests/${pending.body.id}/decline`), 'b2', key()).send()).status).toBe(200);
      expect((await settle(pending.body.id)).body.code).toBe('assistance_request_not_settleable');
      const late = await collected();
      await expireDeadline(late.id);
      expect((await settle(late.id)).body.code).toBe('assistance_request_not_settleable');
      expect((await settle(late.id, 'a1', key(), { amount: 1 })).status).toBe(400); // no body: amount and beneficiary are the server's
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── channels (E-5) and concurrency

  describe('settlement channels (E-5, DB-13)', () => {
    it('one open or uncertain channel at a time; its key replays; concurrent starts create exactly one', async () => {
      const r = await collected();
      const idem = key();
      const first = await settle(r.id, 'a1', idem);
      const replay = await settle(r.id, 'a1', idem);
      expect([replay.status, replay.headers['idempotent-replayed']]).toEqual([201, 'true']);
      expect(replay.body).toEqual(first.body);
      const second = await settle(r.id);
      expect([second.status, second.body.code]).toEqual([409, 'settlement_channel_open']);

      const c = await collected();
      const rs = await Promise.all(Array.from({ length: 6 }, () => settle(c.id)));
      expect(rs.filter((x) => x.status === 201)).toHaveLength(1);
      expect(rs.filter((x) => x.status === 409 && x.body.code === 'settlement_channel_open')).toHaveLength(5);
      expect(await count(`SELECT count(*) AS n FROM invoice i JOIN assistance_settlement_channel ch ON ch."invoiceId" = i.id WHERE ch."assistanceRequestId" = $1`, [c.id])).toBe(1);
    });

    it('a channel follows its payment request: uncertain while being sent, closed only on a final failure, cancellation or expiry; then a retry before the deadline', async () => {
      const r = await collected();
      const s = await settle(r.id);
      await dispatch(); // Payment did not answer: the request is being sent, the outcome unknown
      expect(await channelOf(s.body.invoiceId)).toBe('uncertain');
      expect((await settle(r.id)).body.code).toBe('settlement_channel_open');
      const { inv, paymentId } = await accepted(s.body.paymentRequestId);
      expect(await channelOf(s.body.invoiceId)).toBe('open');
      for (const name of ['payment.cancelled', 'payment.expired'] as const) {
        const ch = name === 'payment.cancelled' ? { inv, paymentId, prid: s.body.paymentRequestId } : await (async () => {
          const n = await settle(r.id);
          expect(n.status).toBe(201);
          const a = await accepted(n.body.paymentRequestId);
          return { inv: a.inv, paymentId: a.paymentId, prid: n.body.paymentRequestId };
        })();
        await t.bus.deliver(paymentEvent(name, ch.inv, ch.prid, ch.paymentId, U.b1));
        expect(await channelOf(ch.inv.id), name).toBe('closed');
      }
      // a final success after a final failure of the same payment is never applied (Payment emits one terminal event; S4c F-4)
      await t.bus.deliver(paymentEvent('payment.succeeded', inv, s.body.paymentRequestId, paymentId, U.b1));
      expect([await purchases(r.id), await channelOf(inv.id), await statusOf(r.id)]).toEqual([0, 'closed', 'cash_collected']);
      // retry before the deadline: a new channel, a new invoice
      const again = await started(r.id);
      expect(again.invoiceId).not.toBe(s.body.invoiceId);
      await t.bus.deliver(again.ev('payment.succeeded'));
      expect([await purchases(r.id), await statusOf(r.id)]).toEqual([1, 'settled']);
      expect((await settle(r.id)).body.code).toBe('assistance_request_not_settleable');
      const view = (await read(r.id)).body;
      expect(view.settlementChannels.map((c: Row) => c.status)).toEqual(['closed', 'closed', 'settled']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the deadline (E-6, E-7)

  describe('the deadline (E-6, E-7)', () => {
    it('an uncertain or open Payment past the deadline never opens the obligation; its later verified success still settles', async () => {
      const r = await collected();
      const s = await settle(r.id);
      await dispatch(); // uncertain
      await expireDeadline(r.id);
      expect(await channelOf(s.body.invoiceId)).toBe('uncertain');
      await sweep();
      expect(await obligations(r.id)).toBe(0);
      const { inv, paymentId } = await accepted(s.body.paymentRequestId); // open (requested at Payment)
      await sweep();
      expect(await obligations(r.id)).toBe(0);
      await t.bus.deliver(paymentEvent('payment.succeeded', inv, s.body.paymentRequestId, paymentId, U.b1));
      expect([await purchases(r.id), await statusOf(r.id), await channelOf(inv.id)]).toEqual([1, 'settled', 'settled']);
      await sweep();
      expect(await obligations(r.id)).toBe(0);
    });

    it('the sweep and a verified success never both win: a purchase or an obligation, never both', async () => {
      for (let i = 0; i < 4; i++) {
        const r = await collected();
        const s = await started(r.id);
        await expireDeadline(r.id);
        await Promise.all([t.bus.deliver(s.ev('payment.succeeded')), sweep(), sweep()]);
        expect([await purchases(r.id), await obligations(r.id)]).toEqual([1, 0]); // the open channel holds the obligation back
      }
      for (let i = 0; i < 4; i++) {
        const r = await collected();
        const s = await started(r.id);
        await expireDeadline(r.id);
        await Promise.all([t.bus.deliver(s.ev('payment.failed')), sweep(), sweep()]);
        await sweep();
        expect([await purchases(r.id), await obligations(r.id)]).toEqual([0, 1]);
      }
    });

    it('E-7: a verified success that can no longer apply is kept as evidence (invoice paid) but creates no purchase and changes no obligation', async () => {
      const r = await collected();
      const s = await started(r.id);
      await expireDeadline(r.id);
      // force the contradictory state the guards prevent in the ordinary flow (a test-only bypass): an obligation while the channel is open
      await backdate(r.id, `INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt")
        SELECT id, "organizationId", "beneficiaryUserId", "totalAmount", currency, "cashCollectedAt" FROM assistance_request WHERE id = $1`);
      await t.bus.deliver(s.ev('payment.succeeded'));
      expect(await one(`SELECT status FROM invoice WHERE id = $1`, [s.invoiceId])).toEqual({ status: 'paid' });
      expect(await purchases(r.id)).toBe(0);
      expect(await one(`SELECT reason, "paymentRequestId" FROM assistance_late_settlement WHERE "invoiceId" = $1`, [s.invoiceId])).toEqual({ reason: 'cash_return_obligation_exists', paymentRequestId: s.paymentRequestId });
      expect(await one(`SELECT status FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [r.id])).toEqual({ status: 'open' });
      expect(await statusOf(r.id)).toBe('cash_collected');
      await t.bus.deliver(s.ev('payment.succeeded'), 'verified_duplicate');
      expect(await count(`SELECT count(*) AS n FROM assistance_late_settlement WHERE "invoiceId" = $1`, [s.invoiceId])).toBe(1);
      expect((await entitlement(U.b1, r.productId).expect(200)).body.valid).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── frozen terms (E-4, E-11)

  describe('frozen terms (E-4, E-11)', () => {
    it('a price retired and a product archived after consent do not stop the consented settlement; the invoice carries the frozen terms', async () => {
      const r = await collected({ unit: 7300 });
      await admin.query(`UPDATE price SET "retiredAt" = now() WHERE id = $1`, [r.priceId]);
      await admin.query(`UPDATE product SET status = 'archived' WHERE id = $1`, [r.productId]);
      const s = await started(r.id);
      expect((await admin.query(`SELECT "priceId", "unitAmount" FROM invoice_line WHERE "invoiceId" = $1`, [s.invoiceId])).rows).toEqual([{ priceId: r.priceId, unitAmount: '7300' }]);
      await t.bus.deliver(s.ev('payment.succeeded'));
      expect(await purchases(r.id)).toBe(1);
      // and a new sale on that retired price is still refused
      expect((await create({ organizationId: ORG, productId: r.productId, priceId: r.priceId, consent: true }, 'b2')).body.code).toBe('product_not_available');
    });

    it('E-11: the fee is re-validated against the current cap when the collection is recorded; a cap lowered afterwards never blocks the settlement', async () => {
      const productId = await productOf();
      const priceId = await priceOf(productId);
      await approveFee(ORG, productId, 4000);
      const c = await create({ organizationId: ORG, productId, priceId, consent: true }, 'b2');
      expect(c.body.feeAmount).toBe(4000);
      await backdateConsent(c.body.id);
      await setCap(3000); // lowered before the collection
      const refused = await reportCash(c.body.id, ago(60_000));
      expect([refused.status, refused.body.code]).toEqual([409, 'fee_not_usable']);
      expect(await statusOf(c.body.id)).toBe('pending');
      const version = await setCap(5000);
      expect((await reportCash(c.body.id, ago(60_000))).status).toBe(200);
      expect((await read(c.body.id)).body).toMatchObject({ feeAmount: 4000, collectionFeeCapVersion: version });
      await setCap(1000); // lowered after the collection: the electronic settlement of the base still proceeds
      const s = await started(c.body.id, U.b2);
      expect(s.inv.total).toBe('9000');
      await setCap(5000);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── cash return (E-8, E-9)

  describe('cash-return reporting (E-9)', () => {
    const openObligation = async () => {
      const r = await collected();
      const s = await started(r.id);
      await t.bus.deliver(s.ev('payment.failed'));
      await expireDeadline(r.id);
      await sweep();
      return { r, o: await one(`SELECT * FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [r.id]) };
    };

    it('only a live Organization actor, never the beneficiary; idempotent; once; the time order is enforced', async () => {
      const { o } = await openObligation();
      expect((await reportReturn(o.id, ago(1000), 'b1')).status).toBe(403);
      for (const bearer of ['b2', 'm1', 'a2', 'owner']) expect((await reportReturn(o.id, ago(1000), bearer)).status, bearer).toBe(404);
      expect((await reportReturn(o.id, ago(1000), 'auth-down')).status).toBe(503);
      expect((await reportReturn(randomUUID(), ago(1000))).status).toBe(404);
      for (const at of [ago(80 * HOUR), new Date(Date.now() + 60_000).toISOString()]) {
        const r = await reportReturn(o.id, at);
        expect([r.status, r.body.code], at).toEqual([422, 'cash_return_time_invalid']);
      }
      for (const at of ['2026-02-31T10:00:00Z', 'yesterday', 1, null]) expect((await reportReturn(o.id, at)).status, String(at)).toBe(400);
      expect((await reportReturn(o.id, ago(1000), 'a1', key(), { amount: 1 })).status).toBe(400); // no partial return
      expect((await one(`SELECT status FROM cash_return_obligation WHERE id = $1`, [o.id])).status).toBe('open');
      const idem = key();
      const at = ago(5000);
      const first = await reportReturn(o.id, at, 'a1', idem);
      const replay = await reportReturn(o.id, at, 'a1', idem);
      expect([first.status, replay.status, replay.headers['idempotent-replayed']]).toEqual([200, 200, 'true']);
      expect(replay.body).toEqual(first.body);
      const again = await reportReturn(o.id, ago(4000));
      expect([again.status, again.body.code]).toEqual([409, 'cash_return_not_open']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the database on its own

  describe('the database refuses every bypass', () => {
    it('channels, obligations, purchases and the reserved producer', async () => {
      const r = await collected();
      const s = await started(r.id);
      // DB-13: a second active channel; a channel closed without a final outcome; a channel reopened or re-pointed
      await expect(admin.query(`INSERT INTO assistance_settlement_channel ("assistanceRequestId", "invoiceId", "startedBy") VALUES ($1, $2, $3)`, [r.id, s.invoiceId, U.a1])).rejects.toMatchObject({ code: '23505' });
      await expect(admin.query(`UPDATE assistance_settlement_channel SET status = 'closed' WHERE "invoiceId" = $1`, [s.invoiceId])).rejects.toMatchObject({ code: '23514', constraint: 'assistance_settlement_channel_closed_final' });
      await expect(admin.query(`UPDATE assistance_settlement_channel SET "assistanceRequestId" = $2 WHERE "invoiceId" = $1`, [s.invoiceId, randomUUID()])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE assistance_settlement_channel SET status = 'settled' WHERE "invoiceId" = $1`, [s.invoiceId])).rejects.toMatchObject({ code: '23514', constraint: 'assistance_settlement_channel_settled_purchase' });
      await expect(admin.query(`DELETE FROM assistance_settlement_channel WHERE "invoiceId" = $1`, [s.invoiceId])).rejects.toMatchObject({ code: '23514' });
      // E-6: no obligation before the deadline, nor while a channel is open
      const ins = `INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt")
        SELECT id, "organizationId", "beneficiaryUserId", "totalAmount", currency, "cashCollectedAt" FROM assistance_request WHERE id = $1`;
      await expect(admin.query(ins, [r.id])).rejects.toMatchObject({ code: '23514', constraint: 'cash_return_obligation_not_due' });
      await expireDeadline(r.id);
      await expect(admin.query(ins, [r.id])).rejects.toMatchObject({ code: '23514', constraint: 'cash_return_obligation_not_due' });
      // a request is settled only with its purchase
      await expect(admin.query(`UPDATE assistance_request SET status = 'settled' WHERE id = $1`, [r.id])).rejects.toMatchObject({ code: '23514', constraint: 'assistance_request_settled_by_purchase' });
      // after a final failure past the deadline: the obligation opens; it then refuses other terms, reports by the beneficiary and new states
      await t.bus.deliver(s.ev('payment.failed'));
      await expect(admin.query(`INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt")
        SELECT id, "organizationId", "beneficiaryUserId", "totalAmount" - 1, currency, "cashCollectedAt" FROM assistance_request WHERE id = $1`, [r.id])).rejects.toMatchObject({ code: '23514', constraint: 'cash_return_obligation_terms' });
      await sweep();
      const o = await one(`SELECT id FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [r.id]);
      await expect(admin.query(ins, [r.id])).rejects.toMatchObject({ code: '23505' });
      await expect(admin.query(`UPDATE cash_return_obligation SET status = 'return_reported', "returnedAt" = now(), "returnReportedBy" = "beneficiaryUserId" WHERE id = $1`, [o.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE cash_return_obligation SET amount = 1 WHERE id = $1`, [o.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE cash_return_obligation SET status = 'confirmed_returned' WHERE id = $1`, [o.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`DELETE FROM cash_return_obligation WHERE id = $1`, [o.id])).rejects.toMatchObject({ code: '23514' });
      // the reserved producer only commits a complete assisted settlement
      const cl = await admin.connect();
      try {
        await cl.query('BEGIN');
        await cl.query(`INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId", "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot")
          VALUES ('billing-assistance', gen_random_uuid(), repeat('a', 64), 'company', $1, 'organization', $2::text, $2::uuid, 'assistance_request', 's', 'TND', 1, 1, '{"schemaVersion":2}', '{"schemaVersion":2}')`, [COMPANY, ORG]);
        await expect(cl.query('COMMIT')).rejects.toMatchObject({ code: '23514', constraint: 'assistance_invoice_shape' });
      } finally {
        await cl.query('ROLLBACK').catch(() => undefined);
        cl.release();
      }
      // B-026 stays closed for every other Organization payer: no payment request for an ordinary Organization-payer invoice
      await expect(admin.query(`WITH i AS (INSERT INTO invoice (producer, "invoiceRequestId", "requestHash", "sellerType", "sellerId", "payerType", "payerId", "organizationId", "sourceType", "sourceId", currency, subtotal, total, "issuerSnapshot", "billToSnapshot", status)
          VALUES ('test-producer', gen_random_uuid(), repeat('a', 64), 'company', $1, 'organization', $2::text, $2::uuid, 's', 's', 'TND', 1, 1, '{"schemaVersion":1}', '{"schemaVersion":1}', 'draft') RETURNING id)
        INSERT INTO payment_request ("invoiceId", amount, currency, "createdByType") SELECT id, 1, 'TND', 'service' FROM i`, [COMPANY, ORG])).rejects.toMatchObject({ code: '23514' });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── historical S5a and production

  it('a historical S5a request (pending, declined or collected before S5b) keeps its evidence; nothing here rewrites it', async () => {
    const r = await collected();
    const before = await one(`SELECT "consentAt", "cashCollectedAt", "reportedAt", "settleBy", "baseAmount", "feeAmount", "totalAmount", "feeProposalId", "feeCapVersion" FROM assistance_request WHERE id = $1`, [r.id]);
    const s = await started(r.id);
    await t.bus.deliver(s.ev('payment.succeeded'));
    expect(await one(`SELECT "consentAt", "cashCollectedAt", "reportedAt", "settleBy", "baseAmount", "feeAmount", "totalAmount", "feeProposalId", "feeCapVersion" FROM assistance_request WHERE id = $1`, [r.id])).toEqual(before);
    await expect(admin.query(`UPDATE assistance_request SET "cashCollectedAt" = "cashCollectedAt" - interval '1 second' WHERE id = $1`, [r.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('production mounts nothing of S5b, and the settlement service and the sweep refuse even if reached', async () => {
    const prod = { isProduction: true } as BillingConfig;
    expect(AssistanceModule.register(prod)).toEqual({ module: AssistanceModule });
    const svc = new AssistanceSettlementService(null as never, null as never, null as never, null as never, null as never, null as never, prod);
    const who = identities.get('a1')!;
    await expect(svc.settle(who, 'k-12345678', ORG, 'en', null as never)).rejects.toMatchObject({ status: 404 });
    await expect(svc.reportReturn(who, 'k-12345678', ORG, { returnedAt: ago(0) }, null as never)).rejects.toMatchObject({ status: 404 });
    expect(await new CashReturnSweep(null as never, null as never, prod).sweepOnce()).toEqual({ opened: 0 });
  });
});

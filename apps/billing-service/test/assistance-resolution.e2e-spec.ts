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
import { AssistanceResolutionService } from '../src/assistance/assistance-resolution.service.js';
import { CashReturnSweep } from '../src/assistance/cash-return-sweep.js';
import type { BillingConfig } from '../src/config/billing-config.js';
import type { PaymentEventFacts, PaymentEventName } from '../src/domain/payment-event-decision.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import type { CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import { HttpOwnerAuthority } from '../src/platforms/owner-authority.client.js';
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

const COMPANY = randomUUID();
const PLATFORM = randomUUID();
// Core V2 S5d: a fresh Organization per test (beforeEach). T1/T2 (S5D-1, S5D-2) restrict an Organization's NEW requests, so one test's
// overdue or unconfirmed fixtures must never restrict the next one's; restrictions are derived and never cleared by a test.
let ORG = randomUUID();
let ORG2 = randomUUID();
const U = { b1: randomUUID(), b2: randomUUID(), a1: randomUUID(), a2: randomUUID(), adminBeneficiary: randomUUID(), m1: randomUUID(), owner: randomUUID(), foreignOwner: randomUUID(), operator: randomUUID() };
const membership = (organizationId: string, o: { admin?: boolean; status?: AuthMembership['status'] } = {}): AuthMembership => ({
  id: randomUUID(), organization: { id: organizationId }, platform: { id: PLATFORM }, status: o.status ?? 'active', isOrganizationAdmin: o.admin ?? false,
});
const HOUR = 3_600_000;

/**
 * Core V2 S5c beneficiary cash-return confirmation, assistance disputes, Organization responses and the Owner's timestamp corrections and
 * nonfinancial dispute resolutions (register BIL-18 to BIL-22; S0 FC-8, DN-1.2; the Owner's H-1 to H-7 and J-1 to J-6), for DEVELOPMENT
 * AND SIMULATION ONLY: the real application on real PostgreSQL 16; members' `/auth/me` stubbed per bearer; the Owner's `/auth/grants`,
 * `/auth/platform-access` and `/auth/step-up/verify` served by a fake Auth over real HTTP through Billing's real client.
 */
describeWithEnv('assistance resolution (Core V2 S5c, simulation) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const payment = new FakePaymentClient();
  const auth = new FakeAuth();
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
  const key = () => `s5c-${++k}-${randomUUID().slice(0, 8)}`;
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
  const statusOf = async (id: string) => (await one(`SELECT status FROM assistance_request WHERE id = $1`, [id])).status as string;
  const purchases = (id: string) => count(`SELECT count(*) AS n FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [id]);
  const obligations = (id: string) => count(`SELECT count(*) AS n FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [id]);

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings5c');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    await admin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [PLATFORM, COMPANY, randomUUID()]);
    delegation = (await admin.query(`INSERT INTO fee_delegation ("platformId", "operatorUserId", "grantedBy") VALUES ($1, $2, $3) RETURNING id`, [PLATFORM, operator, randomUUID()])).rows[0].id;
    await setCap(5000);
    await auth.start();
    auth.identities.set('owner-tok', { userId: U.owner, kind: 'owner', companyId: COMPANY });
    auth.identities.set('foreign-owner-tok', { userId: U.foreignOwner, kind: 'owner', companyId: randomUUID() });
    auth.identities.set('operator-tok', { userId: U.operator, kind: 'operator', companyId: null });
    auth.identities.set('member-tok', { userId: U.a1, kind: 'member', companyId: null });
    auth.platforms.set(PLATFORM, COMPANY);
    auth.assignments.set(U.operator, new Set([PLATFORM])); // an operator assigned to the Platform still exercises no S5c authority
    t = await createTestApp({
      databaseUrl: db.url, authClient, organizationReference: reference, paymentClient: payment, ownerAuthority: new HttpOwnerAuthority({ baseUrl: auth.url }),
      tokens: [{ caller: 'test-producer', digest: producer.digest }],
      env: { BILLING_SERVICE_POLICY: JSON.stringify({ callers: { 'test-producer': { operations: [...BILLING_OPERATIONS], allowedPlatforms: [PLATFORM] } } }) },
    });
  });
  beforeEach(() => {
    ORG = randomUUID();
    ORG2 = randomUUID();
    resetIdentities();
    auth.reset();
  });
  afterAll(async () => {
    await t?.app.close();
    await auth.stop();
    await admin?.end();
    await db?.drop();
  });


  // ── S5c HTTP and fixtures
  const confirm = (obligationId: string, bearer: string | null = 'b1', idem: string | null = key()) =>
    send(request(server()).post(`/billing/cash-return-obligations/${obligationId}/confirm`), bearer, idem).send();
  const dispute = (requestId: string, reasonCode: string, bearer: string | null = 'b1', idem: string | null = key()) =>
    send(request(server()).post(`/billing/assistance-requests/${requestId}/disputes`), bearer, idem).send({ reasonCode });
  const respondTo = (disputeId: string, position: string, bearer: string | null = 'a1', idem: string | null = key()) =>
    send(request(server()).post(`/billing/assistance-disputes/${disputeId}/responses`), bearer, idem).send({ position });
  /** Auth issued a fresh proof for `purpose`, bound to that bearer (owner and session). */
  const proof = (purpose: string, bearer = 'owner-tok', o: { expired?: boolean } = {}) => {
    const token = randomUUID();
    auth.stepUps.set(token, { bearer, purpose, consumed: false, expired: o.expired });
    return token;
  };
  const admin_ = (path: string, body: unknown, o: { bearer?: string; stepUp?: string | null; idem?: string } = {}) => {
    let r = send(request(server()).post(path), o.bearer ?? 'owner-tok', o.idem ?? key());
    if (o.stepUp) r = r.set('x-step-up-token', o.stepUp);
    return r.send(body as object);
  };
  const correct = (requestId: string, body: unknown, o: { bearer?: string; stepUp?: string | null; idem?: string } = {}) =>
    admin_(`/billing/admin/assistance-requests/${requestId}/corrections`, body, { stepUp: o.stepUp === undefined ? proof('billing.assistance.correct', o.bearer) : o.stepUp, ...o });
  const resolve = (disputeId: string, body: unknown, o: { bearer?: string; stepUp?: string | null; idem?: string } = {}) =>
    admin_(`/billing/admin/assistance-disputes/${disputeId}/resolution`, body, { stepUp: o.stepUp === undefined ? proof('billing.assistance.dispute.resolve', o.bearer) : o.stepUp, ...o });
  const verifyCalls = () => auth.received.filter((r) => r.path === '/auth/step-up/verify').length;
  const obligationOf = async (requestId: string) => one(`SELECT * FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [requestId]);
  const disputeRow = (id: string) => one(`SELECT * FROM assistance_dispute WHERE id = $1`, [id]);

  /** A collected request whose deadline passed with no settlement: the sweep opened its obligation (collected 73 hours ago). */
  const owed = async (o: { beneficiary?: string; fee?: number; organizationId?: string } = {}) => {
    const r = await collected(o);
    await expireDeadline(r.id);
    await sweep();
    const ob = await obligationOf(r.id);
    expect(ob.status).toBe('open');
    return { ...r, obligationId: ob.id as string };
  };
  /** ...and the Organization reported the full return a minute ago. */
  const reported = async (o: { beneficiary?: string; fee?: number; organizationId?: string } = {}) => {
    const r = await owed(o);
    const rr = await reportReturn(r.obligationId, ago(60_000), (o.organizationId ?? ORG) === ORG ? 'a1' : 'a2');
    expect(rr.status, JSON.stringify(rr.body)).toBe(200);
    return r;
  };
  /** Every financial record S5c must never write: compared before and after. */
  const financialSnapshot = async () => one(`SELECT
    (SELECT count(*) FROM invoice) AS invoices, (SELECT count(*) FROM payment_request) AS requests, (SELECT count(*) FROM subscription_purchase) AS purchases,
    (SELECT count(*) FROM assistance_settlement_channel) AS channels, (SELECT count(*) FROM assistance_late_settlement) AS late,
    (SELECT count(*) FROM cash_return_obligation) AS obligations, (SELECT count(*) FROM outbox WHERE name NOT LIKE 'audit.%') AS events,
    (SELECT coalesce(sum(amount), 0) FROM cash_return_obligation) AS owed`);

  // ─────────────────────────────────────────────────────────────────────────────────────────────── beneficiary confirmation (H-3, J-6)

  describe('beneficiary confirmation (BIL-18)', () => {
    it('SIMULATION: obligation → Organization reports the return → the beneficiary confirms → confirmed_returned and returned together; the slot is free; nothing financial is created', async () => {
      const r = await reported({ beneficiary: 'b2', fee: 500 });
      const before = await financialSnapshot();
      const c = await confirm(r.obligationId, 'b2');
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      expect(c.body).toMatchObject({ id: r.obligationId, status: 'confirmed_returned', confirmedAt: expect.any(String), amount: r.terms.totalAmount });
      const ob = await obligationOf(r.id);
      expect(ob).toMatchObject({ status: 'confirmed_returned', confirmedBy: U.b2 });
      expect(new Date(ob.confirmedAt).getTime()).toBeGreaterThanOrEqual(new Date(ob.returnReportedAt).getTime());
      expect(await statusOf(r.id)).toBe('returned');
      expect((await read(r.id, 'b2')).body).toMatchObject({ status: 'returned', overdue: false, cashReturnObligation: { status: 'confirmed_returned' } });
      // the report's evidence is untouched; nothing financial was created, paid or granted
      expect(ob.returnReportedBy).toBe(U.a1);
      const after = await financialSnapshot();
      expect(after).toEqual(before);
      expect((await entitlement(U.b2, r.productId).expect(200)).body).toEqual({ valid: false, expiresAt: null });
      // audit: the beneficiary, a member, in the request's Organization
      const ev = (await audit(r.obligationId)).find((e) => e.name === 'audit.cash_return_obligation.confirmed')!;
      expect(ev.payload).toMatchObject({ actor: { type: 'user', id: U.b2, userKind: 'member' }, organizationId: ORG, changes: { assistance_request_id: r.id } });
      // J-6: the one-unresolved-request slot is released
      expect((await create({ organizationId: ORG, productId: r.productId, priceId: r.priceId, consent: true }, 'b2')).status).toBe(201);
    });

    it('only the beneficiary: the Organization actor is 403; another member, another Organization\'s administrator, an Owner and a service are refused; Auth down 503; nothing changes', async () => {
      const r = await reported();
      expect((await confirm(r.obligationId, 'a1')).status).toBe(403); // the Organization never confirms its own discharge
      expect((await confirm(r.obligationId, 'b2')).status).toBe(404);
      expect((await confirm(r.obligationId, 'a2')).status).toBe(404);
      expect((await confirm(r.obligationId, 'owner')).status).toBe(404); // an Owner cannot impersonate the beneficiary's confirmation
      expect((await confirm(r.obligationId, producer.token)).status).toBe(401);
      expect((await confirm(r.obligationId, null)).status).toBe(401);
      expect((await confirm(r.obligationId, 'auth-down')).status).toBe(503);
      expect((await confirm(randomUUID())).status).toBe(404);
      identities.set('b1', { ...identities.get('b1')!, isActive: false });
      expect((await confirm(r.obligationId, 'b1')).status).toBe(404); // a deactivated beneficiary: no live relation
      expect((await obligationOf(r.id)).status).toBe('return_reported');
      // no Owner route confirms or discharges anything
      expect((await admin_(`/billing/admin/cash-return-obligations/${r.obligationId}/confirm`, {}, { stepUp: proof('billing.assistance.correct') })).status).toBe(404);
    });

    it('a report is not a confirmation: before the report 409 cash_return_not_reported; once only; its key replays; a body is refused', async () => {
      const r = await owed();
      expect([(await confirm(r.obligationId)).status, (await confirm(r.obligationId)).body.code]).toEqual([409, 'cash_return_not_reported']);
      expect(await statusOf(r.id)).toBe('cash_collected');
      await reportReturn(r.obligationId, ago(60_000));
      const k1 = key();
      const first = await confirm(r.obligationId, 'b1', k1);
      expect(first.status).toBe(200);
      const replay = await confirm(r.obligationId, 'b1', k1);
      expect([replay.status, replay.headers['idempotent-replayed'], replay.body]).toEqual([200, 'true', first.body]);
      const again = await confirm(r.obligationId);
      expect([again.status, again.body.code]).toEqual([409, 'cash_return_already_confirmed']);
      expect((await send(request(server()).post(`/billing/cash-return-obligations/${r.obligationId}/confirm`), 'b1', key()).send({ status: 'confirmed_returned' })).status).toBe(400);
      expect((await confirm(r.obligationId, 'b1', null)).status).toBe(400);
      expect(await count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.cash_return_obligation.confirmed' AND payload->'resource'->>'id' = $1`, [r.obligationId])).toBe(1);
    });

    it('the database refuses a confirmation by anyone but the beneficiary, a confirmation without the returned request, and a returned request without the confirmation', async () => {
      const r = await reported();
      const sql = async (text: string) => { try { await admin.query(text); return null; } catch (e) { return (e as { constraint?: string }).constraint ?? 'error'; } };
      expect(await sql(`UPDATE cash_return_obligation SET status = 'confirmed_returned', "confirmedBy" = '${U.owner}' WHERE id = '${r.obligationId}'`)).toBe('cash_return_obligation_confirmed_by_beneficiary');
      expect(await sql(`UPDATE cash_return_obligation SET status = 'confirmed_returned', "confirmedBy" = '${U.b1}' WHERE id = '${r.obligationId}'`)).toBe('cash_return_confirmation_returns_request');
      expect(await sql(`UPDATE assistance_request SET status = 'returned' WHERE id = '${r.id}'`)).toBe('assistance_request_returned_by_confirmation');
      expect(await sql(`UPDATE cash_return_obligation SET "returnedAt" = now() - interval '2 hours' WHERE id = '${r.obligationId}'`)).toBe('cash_return_not_open'); // the report's evidence is immutable
      expect(await sql(`DELETE FROM cash_return_obligation WHERE id = '${r.obligationId}'`)).toBe('error');
      expect((await obligationOf(r.id)).status).toBe('return_reported');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── disputes (H-4, H-5, J-1 to J-5)

  describe('disputes (BIL-20, BIL-21)', () => {
    it('an open dispute blocks the confirmation (J-4); the Organization may still report the return (J-5); the report closes nothing', async () => {
      const r = await owed();
      const d = await dispute(r.id, 'cash_not_returned');
      expect(d.status, JSON.stringify(d.body)).toBe(201);
      expect(d.body).toMatchObject({ assistanceRequestId: r.id, reasonCode: 'cash_not_returned', status: 'open', escalationDue: false, response: null, resolution: null });
      const rr = await reportReturn(r.obligationId, ago(60_000));
      expect(rr.status).toBe(200); // J-5: evidence, subject to every S5b rule
      expect((await disputeRow(d.body.id)).status).toBe('open');
      const c = await confirm(r.obligationId);
      expect([c.status, c.body.code]).toEqual([409, 'assistance_dispute_open']);
      expect((await obligationOf(r.id)).status).toBe('return_reported');
      expect(await statusOf(r.id)).toBe('cash_collected'); // unresolved: the slot stays held
      expect((await read(r.id, 'b1')).body.disputes).toEqual([expect.objectContaining({ id: d.body.id, status: 'open' })]);
      const ev = (await audit(d.body.id)).find((e) => e.name === 'audit.assistance_dispute.opened')!;
      expect(ev.payload).toMatchObject({ actor: { type: 'user', id: U.b1, userKind: 'member' }, organizationId: ORG, changes: { assistance_request_id: r.id, reason_code: 'cash_not_returned' } });
    });

    it('a dispute needs evidence of its kind (J-3): without an obligation only collection disputes; never on a pending request; beneficiary only; one open at a time', async () => {
      const r = await collected();
      expect((await dispute(r.id, 'cash_not_returned')).body.code).toBe('dispute_not_permitted');
      expect((await dispute(r.id, 'return_time_incorrect')).body.code).toBe('dispute_not_permitted');
      expect((await dispute(r.id, 'collection_time_incorrect', 'a1')).status).toBe(403);
      expect((await dispute(r.id, 'collection_time_incorrect', 'b2')).status).toBe(404);
      expect((await dispute(r.id, 'collection_time_incorrect', 'owner')).status).toBe(404);
      expect((await dispute(r.id, 'free text, please')).status).toBe(400);
      const d = await dispute(r.id, 'collection_not_made');
      expect(d.status).toBe(201); // informational and evidentiary: no obligation is created, nothing is reversed
      expect(await obligations(r.id)).toBe(0);
      expect([(await dispute(r.id, 'collection_time_incorrect')).status, (await dispute(r.id, 'collection_time_incorrect')).body.code]).toEqual([409, 'assistance_dispute_open']);
      const productId = await productOf();
      const pending = await create({ organizationId: ORG, productId, priceId: await priceOf(productId), consent: true });
      expect((await dispute(pending.body.id, 'collection_not_made')).body.code).toBe('dispute_not_permitted');
    });

    it('a dispute of a returned request is allowed without a cutoff and never re-takes the one-request slot', async () => {
      const r = await reported();
      expect((await confirm(r.obligationId)).status).toBe(200);
      const d = await dispute(r.id, 'return_time_incorrect');
      expect(d.status).toBe(201);
      expect(await statusOf(r.id)).toBe('returned');
      expect((await create({ organizationId: ORG, productId: r.productId, priceId: r.priceId, consent: true })).status).toBe(201);
      expect((await obligationOf(r.id)).status).toBe('confirmed_returned'); // a later dispute does not undo the beneficiary's own confirmation
    });

    it('seven days open is an escalation target only: escalationDue turns true, the dispute stays open and still blocks the confirmation', async () => {
      const r = await reported();
      const d = await dispute(r.id, 'cash_not_returned');
      await backdate(d.body.id, `UPDATE assistance_dispute SET "openedAt" = now() - interval '8 days' WHERE id = $1`);
      expect((await read(r.id, 'b1')).body.disputes[0]).toMatchObject({ status: 'open', escalationDue: true });
      expect((await confirm(r.obligationId)).body.code).toBe('assistance_dispute_open');
    });

    it('the Organization answers once (accepts | contests), never the beneficiary; evidence only', async () => {
      const r = await reported();
      const d = (await dispute(r.id, 'cash_not_returned')).body;
      expect((await respondTo(d.id, 'accepts', 'b1')).status).toBe(403);
      expect((await respondTo(d.id, 'accepts', 'a2')).status).toBe(404);
      expect((await respondTo(d.id, 'accepts', 'owner')).status).toBe(404);
      expect((await respondTo(d.id, 'maybe')).status).toBe(400);
      expect((await respondTo(randomUUID(), 'accepts')).status).toBe(404);
      const before = await financialSnapshot();
      const k1 = key();
      const a = await respondTo(d.id, 'accepts', 'a1', k1);
      expect(a.status, JSON.stringify(a.body)).toBe(201);
      expect(a.body).toMatchObject({ id: d.id, status: 'open', response: { position: 'accepts', respondedAt: expect.any(String) }, resolution: null });
      expect((await respondTo(d.id, 'accepts', 'a1', k1)).headers['idempotent-replayed']).toBe('true');
      expect((await respondTo(d.id, 'contests')).body.code).toBe('dispute_response_exists');
      // even an accepting answer closes nothing and discharges nothing (J-1)
      expect((await disputeRow(d.id)).status).toBe('open');
      expect((await obligationOf(r.id)).status).toBe('return_reported');
      expect(await financialSnapshot()).toEqual(before);
      expect((await confirm(r.obligationId)).body.code).toBe('assistance_dispute_open');
      const ev = (await audit(d.id)).find((e) => e.name === 'audit.assistance_dispute.responded')!;
      expect(ev.payload).toMatchObject({ actor: { type: 'user', id: U.a1, userKind: 'member' }, changes: { position: 'accepts' } });
    });

    it('J-4: a verified Payment success during an open dispute still settles; the dispute stays open; the sweep is unaffected', async () => {
      const r = await collected();
      const d = await dispute(r.id, 'collection_time_incorrect');
      expect(d.status).toBe(201);
      const s = await started(r.id);
      await t.bus.deliver(s.ev('payment.succeeded'));
      expect(await purchases(r.id)).toBe(1);
      expect(await statusOf(r.id)).toBe('settled');
      expect((await disputeRow(d.body.id)).status).toBe('open');
      await expireDeadline(r.id);
      await sweep();
      expect(await obligations(r.id)).toBe(0);
    });

    it('a late verified success after the beneficiary confirmed is kept as evidence for S6h: no purchase, the confirmation and the request unchanged', async () => {
      const r = await collected();
      const s = await started(r.id);
      await expireDeadline(r.id);
      // the contradictory state the guards prevent in the ordinary flow (test-only bypass): an obligation while the channel is open
      await backdate(r.id, `INSERT INTO cash_return_obligation ("assistanceRequestId", "organizationId", "beneficiaryUserId", amount, currency, "cashCollectedAt")
        SELECT id, "organizationId", "beneficiaryUserId", "totalAmount", currency, "cashCollectedAt" FROM assistance_request WHERE id = $1`);
      const ob = await obligationOf(r.id);
      expect((await reportReturn(ob.id, ago(60_000))).status).toBe(200);
      expect((await confirm(ob.id)).status).toBe(200);
      await t.bus.deliver(s.ev('payment.succeeded'));
      expect(await one(`SELECT status FROM invoice WHERE id = $1`, [s.invoiceId])).toEqual({ status: 'paid' }); // the provider evidence is kept
      expect(await purchases(r.id)).toBe(0);
      expect(await one(`SELECT reason FROM assistance_late_settlement WHERE "invoiceId" = $1`, [s.invoiceId])).toEqual({ reason: 'cash_return_obligation_exists' });
      expect([(await obligationOf(r.id)).status, await statusOf(r.id)]).toEqual(['confirmed_returned', 'returned']);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── Owner corrections (H-1, H-2)

  describe('Owner timestamp corrections (BIL-19)', () => {
    it('append-only: the original evidence, settleBy, overdue and the obligation never change; the effective value is the latest; history is kept', async () => {
      const r = await reported();
      const original = await one(`SELECT "cashCollectedAt", "reportedAt", "settleBy" FROM assistance_request WHERE id = $1`, [r.id]);
      const before = await financialSnapshot();
      const v1 = new Date(Date.now() - 100 * HOUR).toISOString();
      const c1 = await correct(r.id, { field: 'cashCollectedAt', value: v1, reasonCode: 'actor_entry_error' });
      expect(c1.status, JSON.stringify(c1.body)).toBe(201);
      expect(c1.body).toMatchObject({ assistanceRequestId: r.id, sequence: 1, field: 'cashCollectedAt', correctedValue: v1, supersededValue: original.cashCollectedAt.toISOString(), reasonCode: 'actor_entry_error' });
      const v2 = new Date(Date.now() - 90 * HOUR).toISOString();
      const c2 = await correct(r.id, { field: 'cashCollectedAt', value: v2, reasonCode: 'evidence_contradicts_report' });
      expect(c2.body).toMatchObject({ sequence: 2, supersededValue: v1, correctedValue: v2 });
      const rt = ago(2 * HOUR);
      const c3 = await correct(r.id, { field: 'returnedAt', value: rt, reasonCode: 'actor_entry_error' });
      expect(c3.status).toBe(201);
      expect(await one(`SELECT "cashCollectedAt", "reportedAt", "settleBy" FROM assistance_request WHERE id = $1`, [r.id])).toEqual(original);
      const view = (await read(r.id, 'b1')).body;
      expect(view).toMatchObject({ cashCollectedAt: original.cashCollectedAt.toISOString(), effectiveCashCollectedAt: v2, settleBy: original.settleBy.toISOString(), overdue: true,
        cashReturnObligation: { status: 'return_reported', effectiveReturnedAt: rt } });
      expect(view.corrections.map((c: Row) => c.sequence)).toEqual([1, 2, 3]);
      expect(await financialSnapshot()).toEqual(before);
      // audit: the Owner, with the superseded value; never the proof
      const evs = (await audit(r.id)).filter((e) => e.name === 'audit.assistance_request.corrected');
      expect(evs).toHaveLength(3);
      expect(evs[0].payload).toMatchObject({ actor: { type: 'user', id: U.owner, userKind: 'owner' }, organizationId: ORG,
        changes: { correction_id: c1.body.id, field: 'cash_collected_at', corrected_value: v1, superseded_value: original.cashCollectedAt.toISOString(), reason_code: 'actor_entry_error' } });
      expect(JSON.stringify(evs)).not.toContain('step');
      // the database keeps every correction forever
      await expect(admin.query(`UPDATE assistance_correction SET "correctedValue" = now() WHERE id = $1`, [c1.body.id])).rejects.toThrow(/append-only/);
      await expect(admin.query(`DELETE FROM assistance_correction WHERE id = $1`, [c1.body.id])).rejects.toThrow(/append-only/);
    });

    it('the dedicated step-up: missing, another purpose, another owner, expired or reused are 403 step_up_required with nothing written; a replay spends no proof', async () => {
      const r = await reported();
      const body = { field: 'cashCollectedAt', value: new Date(Date.now() - 100 * HOUR).toISOString(), reasonCode: 'actor_entry_error' };
      const calls = verifyCalls();
      expect([(await correct(r.id, body, { stepUp: null })).status, (await correct(r.id, body, { stepUp: null })).body.code]).toEqual([403, 'step_up_required']);
      expect(verifyCalls()).toBe(calls); // never asked Auth without a proof
      const wrongPurpose = proof('billing.assistance.dispute.resolve');
      expect((await correct(r.id, body, { stepUp: wrongPurpose })).body.code).toBe('step_up_required');
      expect(auth.stepUps.get(wrongPurpose)!.consumed).toBe(false); // Auth refused it without consuming it
      expect((await correct(r.id, body, { stepUp: proof('billing.assistance.correct', 'foreign-owner-tok') })).body.code).toBe('step_up_required');
      expect((await correct(r.id, body, { stepUp: proof('billing.assistance.correct', 'owner-tok', { expired: true }) })).body.code).toBe('step_up_required');
      expect(await count(`SELECT count(*) AS n FROM assistance_correction WHERE "assistanceRequestId" = $1`, [r.id])).toBe(0);

      const good = proof('billing.assistance.correct');
      const k1 = key();
      const first = await correct(r.id, body, { stepUp: good, idem: k1 });
      expect(first.status).toBe(201);
      expect(auth.stepUps.get(good)!.consumed).toBe(true);
      const afterFirst = verifyCalls();
      const replay = await correct(r.id, body, { stepUp: good, idem: k1 });
      expect([replay.status, replay.headers['idempotent-replayed'], replay.body]).toEqual([201, 'true', first.body]);
      expect(verifyCalls()).toBe(afterFirst); // the replay spent no proof
      const reused = await correct(r.id, { ...body, value: new Date(Date.now() - 95 * HOUR).toISOString() }, { stepUp: good });
      expect([reused.status, reused.body.code]).toEqual([403, 'step_up_required']); // single use
      expect((await correct(r.id, { ...body, value: new Date(Date.now() - 95 * HOUR).toISOString() }, { idem: k1 })).body.code).toBe('idempotency_key_conflict');
      expect(await count(`SELECT count(*) AS n FROM assistance_correction WHERE "assistanceRequestId" = $1`, [r.id])).toBe(1);
    });

    it('Owner only, of the request\'s Platform, live: an operator or a member is 403, another Company\'s Owner the collapsed 404, a service 401, Auth down 503', async () => {
      const r = await reported();
      const body = { field: 'cashCollectedAt', value: new Date(Date.now() - 100 * HOUR).toISOString(), reasonCode: 'actor_entry_error' };
      expect([(await correct(r.id, body, { bearer: 'operator-tok' })).status, (await correct(r.id, body, { bearer: 'operator-tok' })).body.code]).toEqual([403, 'operation_not_permitted']);
      expect((await correct(r.id, body, { bearer: 'member-tok' })).status).toBe(403);
      expect((await correct(r.id, body, { bearer: 'foreign-owner-tok' })).status).toBe(404);
      expect((await correct(randomUUID(), body)).status).toBe(404);
      expect((await correct(r.id, body, { bearer: producer.token })).status).toBe(401);
      expect((await correct(r.id, body, { bearer: 'nobody' })).status).toBe(401);
      auth.mode = 'down';
      auth.target = 'access';
      expect((await correct(r.id, body)).status).toBe(503);
      auth.target = 'step_up';
      const p = proof('billing.assistance.correct');
      expect((await correct(r.id, body, { stepUp: p })).status).toBe(503);
      expect(await count(`SELECT count(*) AS n FROM assistance_correction WHERE "assistanceRequestId" = $1`, [r.id])).toBe(0);
    });

    it('only a reported time, changed, in the recorded time order; refusals before the proof is spent; nothing monetary is correctable', async () => {
      const r = await owed();
      const tooLate = { field: 'cashCollectedAt', value: ago(10 * 60_000), reasonCode: 'actor_entry_error' }; // after reportedAt (73 h ago)
      const p1 = proof('billing.assistance.correct');
      const late = await correct(r.id, tooLate, { stepUp: p1 });
      expect([late.status, late.body.code]).toEqual([422, 'correction_time_invalid']);
      expect(auth.stepUps.get(p1)!.consumed).toBe(false);
      expect((await correct(r.id, { field: 'cashCollectedAt', value: new Date(Date.now() - 300 * HOUR).toISOString(), reasonCode: 'actor_entry_error' })).body.code).toBe('correction_time_invalid'); // before consent
      expect((await correct(r.id, { field: 'returnedAt', value: ago(HOUR), reasonCode: 'actor_entry_error' })).body.code).toBe('correction_not_permitted'); // not reported
      const v = new Date(Date.now() - 100 * HOUR).toISOString();
      expect((await correct(r.id, { field: 'cashCollectedAt', value: v, reasonCode: 'actor_entry_error' })).status).toBe(201);
      expect((await correct(r.id, { field: 'cashCollectedAt', value: v, reasonCode: 'evidence_contradicts_report' })).body.code).toBe('correction_not_permitted'); // unchanged
      await reportReturn(r.obligationId, ago(60_000));
      expect((await correct(r.id, { field: 'returnedAt', value: new Date(Date.now() - 150 * HOUR).toISOString(), reasonCode: 'actor_entry_error' })).body.code).toBe('correction_time_invalid'); // before the (corrected) collection
      for (const bad of [{ field: 'amount', value: ago(0), reasonCode: 'actor_entry_error' }, { field: 'cashCollectedAt', value: ago(0), reasonCode: 'other' },
        { field: 'cashCollectedAt', value: '2026-01-01', reasonCode: 'actor_entry_error' }, { field: 'cashCollectedAt', value: ago(0), reasonCode: 'actor_entry_error', amount: 1 }]) {
        expect((await correct(r.id, bad)).status, JSON.stringify(bad)).toBe(400);
      }
      const productId = await productOf();
      const pending = await create({ organizationId: ORG2, productId, priceId: await priceOf(productId), consent: true }); // ORG is now restricted (S5d)
      expect(pending.status).toBe(201);
      const onPending = await correct(pending.body.id, { field: 'cashCollectedAt', value: ago(HOUR), reasonCode: 'actor_entry_error' });
      expect([onPending.status, onPending.body.code], JSON.stringify(onPending.body)).toEqual([409, 'correction_not_permitted']);
      expect(await count(`SELECT count(*) AS n FROM assistance_correction WHERE "assistanceRequestId" IN ($1, $2)`, [r.id, pending.body.id])).toBe(1); // the one valid correction
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── Owner resolution (H-6, J-1, J-2)

  describe('Owner nonfinancial dispute resolution (BIL-22)', () => {
    it('a timestamp dispute closes on a correction of exactly that time appended after it opened; the obligation is untouched; the beneficiary may then confirm', async () => {
      const r = await reported();
      const d = (await dispute(r.id, 'return_time_incorrect')).body;
      const c = (await correct(r.id, { field: 'returnedAt', value: ago(2 * HOUR), reasonCode: 'evidence_contradicts_report' })).body;
      const before = await financialSnapshot();
      const k1 = key();
      const res = await resolve(d.id, { outcome: 'timestamp_corrected', correctionId: c.id }, { idem: k1 });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body).toMatchObject({ id: d.id, status: 'resolved', resolution: { outcome: 'timestamp_corrected', correctionId: c.id, resolvedAt: expect.any(String) } });
      expect((await resolve(d.id, { outcome: 'timestamp_corrected', correctionId: c.id }, { idem: k1 })).headers['idempotent-replayed']).toBe('true');
      expect((await obligationOf(r.id)).status).toBe('return_reported'); // never a discharge
      expect(await statusOf(r.id)).toBe('cash_collected');
      expect(await financialSnapshot()).toEqual(before);
      const ev = (await audit(d.id)).find((e) => e.name === 'audit.assistance_dispute.resolved')!;
      expect(ev.payload).toMatchObject({ actor: { type: 'user', id: U.owner, userKind: 'owner' }, organizationId: ORG, changes: { outcome: 'timestamp_corrected', correction_id: c.id } });
      expect((await confirm(r.obligationId)).status).toBe(200); // only the beneficiary discharges
      expect((await resolve(d.id, { outcome: 'timestamp_corrected', correctionId: c.id })).body.code).toBe('assistance_dispute_not_open');
    });

    it('J-1 / J-2: no resolution for cash_not_returned or collection_not_made, a mismatched or earlier correction, or a generic outcome; the dispute stays open; no proof is spent', async () => {
      const r = await reported();
      const early = (await correct(r.id, { field: 'cashCollectedAt', value: new Date(Date.now() - 100 * HOUR).toISOString(), reasonCode: 'actor_entry_error' })).body;
      const cnr = (await dispute(r.id, 'cash_not_returned')).body;
      const p = proof('billing.assistance.dispute.resolve');
      const refused = await resolve(cnr.id, { outcome: 'timestamp_corrected', correctionId: early.id }, { stepUp: p });
      expect([refused.status, refused.body.code]).toEqual([409, 'resolution_not_permitted']);
      expect(auth.stepUps.get(p)!.consumed).toBe(false);
      for (const outcome of ['upheld_cash_not_returned', 'rejected_return_made', 'resolved_by_owner', 'dismissed']) {
        expect((await resolve(cnr.id, { outcome, correctionId: early.id })).status, outcome).toBe(400);
      }
      expect((await disputeRow(cnr.id)).status).toBe('open');
      expect((await confirm(r.obligationId)).body.code).toBe('assistance_dispute_open'); // the debt is not released (J-2)

      // a collection-time dispute with a correction made BEFORE it opened, or of the other field: refused
      const r2 = await reported({ organizationId: ORG2 }); // a second Organization: ORG is restricted now (S5d)
      const before = (await correct(r2.id, { field: 'cashCollectedAt', value: new Date(Date.now() - 100 * HOUR).toISOString(), reasonCode: 'actor_entry_error' })).body;
      const d2 = (await dispute(r2.id, 'collection_time_incorrect', 'b1')).body;
      expect((await resolve(d2.id, { outcome: 'timestamp_corrected', correctionId: before.id })).body.code).toBe('resolution_not_permitted');
      const other = (await correct(r2.id, { field: 'returnedAt', value: ago(2 * HOUR), reasonCode: 'actor_entry_error' })).body;
      expect((await resolve(d2.id, { outcome: 'timestamp_corrected', correctionId: other.id })).body.code).toBe('resolution_not_permitted');
      expect((await resolve(d2.id, { outcome: 'timestamp_corrected', correctionId: early.id })).body.code).toBe('resolution_not_permitted'); // another request's
      // the database refuses any other resolution too
      await expect(admin.query(`UPDATE assistance_dispute SET status = 'resolved', "resolvedBy" = $2, outcome = 'timestamp_corrected', "correctionId" = $3 WHERE id = $1`, [cnr.id, U.owner, early.id]))
        .rejects.toMatchObject({ constraint: 'assistance_dispute_resolution_not_permitted' });
      expect((await disputeRow(d2.id)).status).toBe('open');
    });

    it('the dedicated purpose: a correction proof never resolves a dispute; operators and other Companies\' Owners are refused', async () => {
      const r = await reported();
      const d = (await dispute(r.id, 'return_time_incorrect')).body;
      const c = (await correct(r.id, { field: 'returnedAt', value: ago(2 * HOUR), reasonCode: 'actor_entry_error' })).body;
      const wrong = proof('billing.assistance.correct');
      expect((await resolve(d.id, { outcome: 'timestamp_corrected', correctionId: c.id }, { stepUp: wrong })).body.code).toBe('step_up_required');
      expect((await resolve(d.id, { outcome: 'timestamp_corrected', correctionId: c.id }, { bearer: 'operator-tok' })).status).toBe(403);
      expect((await resolve(d.id, { outcome: 'timestamp_corrected', correctionId: c.id }, { bearer: 'foreign-owner-tok' })).status).toBe(404);
      expect((await resolve(d.id, { outcome: 'timestamp_corrected', correctionId: c.id }, { stepUp: null })).body.code).toBe('step_up_required');
      expect((await disputeRow(d.id)).status).toBe('open');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── concurrency (H-7)

  describe('races', () => {
    it('concurrent confirmations with different keys confirm exactly once', async () => {
      const r = await reported();
      const results = await Promise.all(Array.from({ length: 6 }, () => confirm(r.obligationId)));
      expect(results.filter((x) => x.status === 200)).toHaveLength(1);
      expect(results.filter((x) => x.status === 409).map((x) => x.body.code)).toEqual(Array(5).fill('cash_return_already_confirmed'));
      expect(await count(`SELECT count(*) AS n FROM outbox WHERE name = 'audit.cash_return_obligation.confirmed' AND payload->'resource'->>'id' = $1`, [r.obligationId])).toBe(1);
    });

    it('confirmation racing a dispute: either the confirmation wins (the dispute follows a returned request) or the dispute wins (the confirmation is refused); never both against the rule', async () => {
      for (let i = 0; i < 6; i += 1) {
        ORG = randomUUID(); // Core V2 S5d: each round's obligation restricts its Organization, so every round uses a fresh one
        resetIdentities();
        const r = await reported();
        const [c, d] = await Promise.all([confirm(r.obligationId), dispute(r.id, 'cash_not_returned')]);
        expect(d.status).toBe(201); // disputes have no cutoff, so the dispute always lands
        const ob = await obligationOf(r.id);
        const dr = await disputeRow(d.body.id);
        if (c.status === 200) {
          expect(ob.status).toBe('confirmed_returned');
          expect(new Date(dr.openedAt).getTime()).toBeGreaterThanOrEqual(new Date(ob.confirmedAt).getTime()); // opened after the confirmation committed
        } else {
          expect([c.status, c.body.code]).toEqual([409, 'assistance_dispute_open']);
          expect(ob.status).toBe('return_reported');
        }
      }
    });

    it('concurrent disputes: exactly one opens; concurrent corrections chain without gaps; concurrent responses: exactly one', async () => {
      const r = await reported();
      const ds = await Promise.all(Array.from({ length: 5 }, () => dispute(r.id, 'cash_not_returned')));
      expect(ds.filter((x) => x.status === 201)).toHaveLength(1);
      expect(ds.filter((x) => x.status === 409).every((x) => x.body.code === 'assistance_dispute_open')).toBe(true);
      const d = ds.find((x) => x.status === 201)!.body;
      const rs = await Promise.all([respondTo(d.id, 'accepts'), respondTo(d.id, 'contests'), respondTo(d.id, 'accepts')]);
      expect(rs.filter((x) => x.status === 201)).toHaveLength(1);
      const values = Array.from({ length: 5 }, (_, i) => new Date(Date.now() - (100 + i) * HOUR).toISOString());
      const cs = await Promise.all(values.map((value) => correct(r.id, { field: 'cashCollectedAt', value, reasonCode: 'actor_entry_error' })));
      expect(cs.map((x) => x.status)).toEqual(Array(5).fill(201));
      const chain = (await admin.query(`SELECT sequence, "correctedValue", "supersededValue" FROM assistance_correction WHERE "assistanceRequestId" = $1 ORDER BY sequence`, [r.id])).rows;
      expect(chain.map((c) => c.sequence)).toEqual([1, 2, 3, 4, 5]);
      for (let i = 1; i < chain.length; i += 1) expect(chain[i].supersededValue).toEqual(chain[i - 1].correctedValue); // each supersedes the previous
    });

    it('a resolution racing a duplicate resolution resolves exactly once; a correction never interleaves with a confirmation inconsistently', async () => {
      const r = await reported();
      const d = (await dispute(r.id, 'return_time_incorrect')).body;
      const c = (await correct(r.id, { field: 'returnedAt', value: ago(2 * HOUR), reasonCode: 'actor_entry_error' })).body;
      const rs = await Promise.all(Array.from({ length: 4 }, () => resolve(d.id, { outcome: 'timestamp_corrected', correctionId: c.id })));
      expect(rs.filter((x) => x.status === 200)).toHaveLength(1);
      expect(rs.filter((x) => x.status === 409).every((x) => x.body.code === 'assistance_dispute_not_open')).toBe(true);
      const [conf, corr] = await Promise.all([confirm(r.obligationId), correct(r.id, { field: 'returnedAt', value: ago(3 * HOUR), reasonCode: 'actor_entry_error' })]);
      expect([conf.status, corr.status]).toEqual([200, 201]); // independent: a correction never blocks or undoes a confirmation
      expect((await obligationOf(r.id)).status).toBe('confirmed_returned');
    });
  });

  it('production mounts nothing of S5c, and the resolution service refuses even if reached', async () => {
    const prod = { isProduction: true } as BillingConfig;
    expect(AssistanceModule.register(prod)).toEqual({ module: AssistanceModule });
    const svc = new AssistanceResolutionService(null as never, null as never, null as never, null as never, null as never, prod);
    const who = identities.get('b1')!;
    const owner = { userId: U.owner, bearer: 'owner-tok' };
    await expect(svc.confirmReturn(who, 'k-12345678', ORG, null as never)).rejects.toMatchObject({ status: 404 });
    await expect(svc.openDispute(who, 'k-12345678', ORG, { reasonCode: 'cash_not_returned' }, null as never)).rejects.toMatchObject({ status: 404 });
    await expect(svc.respond(who, 'k-12345678', ORG, { position: 'accepts' }, null as never)).rejects.toMatchObject({ status: 404 });
    await expect(svc.correct(owner, 'k-12345678', ORG, { field: 'cashCollectedAt', value: ago(0), reasonCode: 'actor_entry_error' }, 'p', null as never)).rejects.toMatchObject({ status: 404 });
    await expect(svc.resolve(owner, 'k-12345678', ORG, { outcome: 'timestamp_corrected', correctionId: ORG }, 'p', null as never)).rejects.toMatchObject({ status: 404 });
  });
});

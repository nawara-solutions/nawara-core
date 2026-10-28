import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HierarchyUnavailableError, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity, type AuthMembership, type EventEnvelope, type OrganizationReferenceResolver,
} from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { BILLING_OPERATIONS } from '../src/admission/caller-admission.policy.js';
import { billingMigrationsDir } from '../src/app.module.js';
import { AssistanceModule } from '../src/assistance/assistance.module.js';
import { RESERVED_RESTRICTION_KINDS } from '../src/assistance/assistance-restrictions.js';
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

const ORG_DOWN = randomUUID(); // Organization Service cannot answer for it

/**
 * Core V2 S5d Organization financial restrictions T1 and T2 (register BIL-13 C, BIL-26; S0 FC-9, I-11; the Owner's S5D-1 to S5D-8), for
 * DEVELOPMENT AND SIMULATION ONLY: the real application on real PostgreSQL 16; members' `/auth/me` stubbed per bearer; the Owner's
 * `/auth/grants` and `/auth/platform-access` served by a fake Auth over real HTTP through Billing's real client; Payment scripted.
 */
describeWithEnv('Organization financial restrictions (Core V2 S5d, simulation) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const payment = new FakePaymentClient();
  const auth = new FakeAuth();
  const reader = generateServiceToken(); // holds restriction.read on PLATFORM
  const foreignReader = generateServiceToken(); // holds restriction.read on another Platform only
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
    // the restriction read's human callers, as Auth's /auth/me sees them (the fake Auth answers /auth/grants and /auth/platform-access)
    identities.set('owner-tok', { id: U.owner, adminTier: 'owner', isActive: true, memberships: [] });
    identities.set('foreign-owner-tok', { id: U.foreignOwner, adminTier: 'owner', isActive: true, memberships: [] });
    identities.set('operator-tok', { id: U.operator, adminTier: 'operator', isActive: true, memberships: [membership(ORG, { admin: true })] });
  };
  const authClient: AuthClient = {
    getIdentity: async (bearer) => {
      if (bearer === 'auth-down') throw new ServiceUnavailableException();
      return identities.get(bearer) ?? null;
    },
    hasPlatformAccess: async () => false,
  };
  const reference: OrganizationReferenceResolver = {
    resolve: async (organizationId) => {
      if (organizationId === ORG_DOWN) throw new HierarchyUnavailableError();
      return ([ORG, ORG2] as string[]).includes(organizationId) ? { organizationId, platformId: PLATFORM, companyId: COMPANY } : null;
    },
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
  const key = () => `s5d-${++k}-${randomUUID().slice(0, 8)}`;
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

  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
  const count = async (sql: string, params: unknown[] = []) => Number((await one(sql, params)).n);
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
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings5d');
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
      tokens: [{ caller: 'test-producer', digest: producer.digest }, { caller: 'restriction-reader', digest: reader.digest }, { caller: 'foreign-reader', digest: foreignReader.digest }],
      env: { BILLING_SERVICE_POLICY: JSON.stringify({ callers: {
        // every operation EXCEPT the named restriction read: a generic grant never reads restrictions (S5D-6)
        'test-producer': { operations: BILLING_OPERATIONS.filter((o) => o !== 'restriction.read'), allowedPlatforms: [PLATFORM] },
        'restriction-reader': { operations: ['restriction.read'], allowedPlatforms: [PLATFORM] },
        'foreign-reader': { operations: ['restriction.read'], allowedPlatforms: [randomUUID()] },
      } }) },
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

  const obligationOf = async (requestId: string) => one(`SELECT * FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [requestId]);
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

  // ── S5d HTTP and fixtures
  const restrictionsOf = (organizationId: string, bearer = 'a1') => send(request(server()).get(`/billing/organizations/${organizationId}/restrictions`), bearer, null);
  /** A new offering and a request for it in `organizationId` by `bearer` (the admission decision under test). */
  const newRequest = async (bearer = 'b2', organizationId = ORG) => {
    const productId = await productOf();
    return create({ organizationId, productId, priceId: await priceOf(productId), consent: true }, bearer);
  };
  const kinds = async (organizationId = ORG) => (await admin.query(`SELECT kind, "sourceId", since FROM billing_assistance_restrictions($1, clock_timestamp())`, [organizationId])).rows as Row[];
  const settleByOf = async (id: string) => (await one(`SELECT "settleBy" FROM assistance_request WHERE id = $1`, [id])).settleBy as Date;

  // ─────────────────────────────────────────────────────────────────────────────────────────────── T1 (S5D-1)

  describe('T1: overdue settlement (S5D-1)', () => {
    it('before the deadline: none; past it: T1 with the request as source and settleBy as since; creation refused with kinds only', async () => {
      const r = await collected();
      expect(await kinds()).toEqual([]);
      expect((await newRequest()).status).toBe(201); // an unrestricted Organization admits a new request
      await expireDeadline(r.id);
      const settleBy = await settleByOf(r.id);
      expect(await kinds()).toEqual([{ kind: 'T1', sourceId: r.id, since: settleBy }]);
      const refused = await newRequest();
      expect(refused.status).toBe(409);
      // S5D-4: kinds only — never another beneficiary's request or obligation id, amount, personal detail or payment reference
      expect(Object.keys(refused.body).sort()).toEqual(['code', 'error', 'message', 'requestId', 'restriction', 'restrictions', 'statusCode']);
      expect(refused.body).toMatchObject({ code: 'assistance_restricted', restriction: 'T1', restrictions: ['T1'] });
      expect(JSON.stringify(refused.body)).not.toContain(r.id);
      expect(await count(`SELECT count(*) AS n FROM assistance_request WHERE "organizationId" = $1`, [ORG])).toBe(2); // nothing written
    });

    it('the exact boundary: at settleBy it does not apply, one microsecond later it does (the database clock decides)', async () => {
      const r = await collected();
      const at = await settleByOf(r.id);
      const atBoundary = (await admin.query(`SELECT count(*)::int AS n FROM billing_assistance_restrictions($1, $2::timestamptz)`, [ORG, at])).rows[0].n;
      const after = (await admin.query(`SELECT count(*)::int AS n FROM billing_assistance_restrictions($1, $2::timestamptz + interval '1 microsecond')`, [ORG, at])).rows[0].n;
      expect([atBoundary, after]).toEqual([0, 1]);
    });

    it('a new request at the deadline: admitted just before it, refused just after (re-evaluated at the protected decision)', async () => {
      const r = await collected();
      await backdate(r.id, `UPDATE assistance_request SET "cashCollectedAt" = now() - interval '72 hours' + interval '1500 milliseconds', "settleBy" = now() + interval '1500 milliseconds' WHERE id = $1`);
      expect((await newRequest()).status).toBe(201);
      await new Promise((res) => setTimeout(res, 1700));
      expect((await newRequest()).body.code).toBe('assistance_restricted');
    });

    it('an uncertain or open Payment past the deadline keeps T1 (no obligation yet); its verified success clears it', async () => {
      const r = await collected();
      const s = await started(r.id);
      await expireDeadline(r.id);
      await sweep();
      expect((await kinds()).map((k) => k.kind)).toEqual(['T1']); // the open channel holds the obligation back (E-6)
      await t.bus.deliver(s.ev('payment.succeeded'));
      expect(await statusOf(r.id)).toBe('settled');
      expect(await kinds()).toEqual([]);
      expect((await newRequest()).status).toBe(201);
    });

    it('T1 stays while the obligation is open or only reported; the beneficiary\'s confirmation clears T1 and T2; the violation evidence is kept', async () => {
      const r = await owed();
      expect((await kinds()).map((k) => k.kind)).toEqual(['T1', 'T2']);
      await reportReturn(r.obligationId, ago(60_000));
      expect((await kinds()).map((k) => k.kind)).toEqual(['T1', 'T2']); // a report is not a confirmation
      expect((await confirm(r.obligationId)).status).toBe(200);
      expect(await kinds()).toEqual([]);
      // historical evidence: the missed deadline and the obligation stay on record; nothing counts violations
      const req = await one(`SELECT status, "settleBy" < now() AS missed FROM assistance_request WHERE id = $1`, [r.id]);
      expect(req).toEqual({ status: 'returned', missed: true });
      expect((await one(`SELECT status FROM cash_return_obligation WHERE id = $1`, [r.obligationId])).status).toBe('confirmed_returned');
      expect((await newRequest()).status).toBe(201);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── T2 (S5D-2) and scope (S5D-3)

  describe('T2: unresolved cash return (S5D-2) and Organization scope (S5D-3)', () => {
    it('several obligations in one Organization: each its own T1 and T2, deterministic order; each clears independently; another Organization unaffected', async () => {
      // both collected while the Organization is unrestricted; then both deadlines pass (a second request could not be created after)
      const c1 = await collected({ beneficiary: 'b1' });
      const c2 = await collected({ beneficiary: 'b2' });
      await expireDeadline(c1.id);
      await expireDeadline(c2.id);
      await sweep();
      const ob = async (id: string) => (await one(`SELECT id FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [id])).id as string;
      const r1 = { ...c1, obligationId: await ob(c1.id) };
      const r2 = { ...c2, obligationId: await ob(c2.id) };
      expect((await reportReturn(r2.obligationId, ago(60_000))).status).toBe(200);
      const list = (await restrictionsOf(ORG)).body.restrictions as Row[];
      expect(list.map((x) => x.kind)).toEqual(['T1', 'T1', 'T2', 'T2']);
      const t1 = list.filter((x) => x.kind === 'T1');
      expect(t1.map((x) => x.since)).toEqual(t1.map((x) => x.since).sort((a, b) => String(a).localeCompare(String(b)))); // within a kind: by since (then sourceId)
      expect(new Set(list.map((x) => x.sourceId))).toEqual(new Set([r1.id, r2.id, r1.obligationId, r2.obligationId]));
      expect((await confirm(r2.obligationId, 'b2')).status).toBe(200);
      expect(((await restrictionsOf(ORG)).body.restrictions as Row[]).map((x) => [x.kind, x.sourceId])).toEqual([['T1', r1.id], ['T2', r1.obligationId]]);
      // S5D-3: never another Organization, the beneficiary's account elsewhere, the Platform or the Company
      expect((await restrictionsOf(ORG2, 'a2')).body).toEqual({ restrictions: [] });
      expect((await newRequest('b1', ORG2)).status).toBe(201); // the same beneficiary, another Organization of the same Platform
    });

    it('no obligation: no T2; the read is the restrictions list only; no restriction state is ever stored', async () => {
      await collected();
      expect((await restrictionsOf(ORG)).body).toEqual({ restrictions: [] });
      const stored = await count(`SELECT count(*) AS n FROM information_schema.columns WHERE table_schema = 'public' AND (table_name ~* '(restriction|violation)' OR column_name ~* '(restrict|violation|repeat)')`);
      expect(stored).toBe(0);
      for (const kind of RESERVED_RESTRICTION_KINDS) {
        expect(await count(`SELECT count(*) AS n FROM pg_proc WHERE proname = 'billing_assistance_restrictions' AND prosrc LIKE $1`, [`%'${kind}'%`])).toBe(0); // reserved: no source exists
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── discharge stays available (FC-9, S5D-8)

  it('an Organization under both T1 and T2 can still perform every authorized discharge action, and verified Payment success still applies', async () => {
    const pending = await create({ organizationId: ORG, ...(await (async () => { const p = await productOf(); return { productId: p, priceId: await priceOf(p) }; })()), consent: true }, 'b2');
    const toDecline = await newRequest('m1');
    const live = await collected({ beneficiary: 'b1' }); // collected before the restriction, deadline ahead
    await backdateConsent(pending.body.id);
    const r = await owed({ beneficiary: 'b1' }); // T1 + T2 now
    expect((await kinds()).map((k) => k.kind)).toEqual(['T1', 'T2']);
    expect((await newRequest()).body.code).toBe('assistance_restricted');

    expect((await reportCash(pending.body.id, ago(60_000))).status).toBe(200); // S5D-8: an already-pending request continues
    expect((await send(request(server()).post(`/billing/assistance-requests/${toDecline.body.id}/decline`), 'a1', key()).send()).status).toBe(200);
    const s = await started(live.id); // electronic settlement of an existing request
    await t.bus.deliver(s.ev('payment.succeeded')); // verified success is never blocked
    expect(await statusOf(live.id)).toBe('settled');
    expect((await reportReturn(r.obligationId, ago(60_000))).status).toBe(200);
    const d = await send(request(server()).post(`/billing/assistance-requests/${r.id}/disputes`), 'b1', key()).send({ reasonCode: 'return_time_incorrect' });
    expect(d.status).toBe(201);
    expect((await send(request(server()).post(`/billing/assistance-disputes/${d.body.id}/responses`), 'a1', key()).send({ position: 'contests' })).status).toBe(201);
    const p1 = randomUUID();
    auth.stepUps.set(p1, { bearer: 'owner-tok', purpose: 'billing.assistance.correct', consumed: false });
    const c = await send(request(server()).post(`/billing/admin/assistance-requests/${r.id}/corrections`), 'owner-tok', key()).set('x-step-up-token', p1)
      .send({ field: 'returnedAt', value: ago(2 * HOUR), reasonCode: 'actor_entry_error' });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const p2 = randomUUID();
    auth.stepUps.set(p2, { bearer: 'owner-tok', purpose: 'billing.assistance.dispute.resolve', consumed: false });
    expect((await send(request(server()).post(`/billing/admin/assistance-disputes/${d.body.id}/resolution`), 'owner-tok', key()).set('x-step-up-token', p2)
      .send({ outcome: 'timestamp_corrected', correctionId: c.body.id })).status).toBe(200);
    expect((await read(r.id, 'b1')).status).toBe(200);
    expect((await confirm(r.obligationId)).status).toBe(200); // the beneficiary's confirmation, which clears both
    expect(await kinds()).toEqual([]);
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the database (S5D-5)

  it('the database refuses a request into a restricted Organization whatever path inserts it (no service, no lock)', async () => {
    await owed();
    const productId = await productOf();
    const priceId = await priceOf(productId);
    await expect(admin.query(`INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
      VALUES ($1, $2, $3, $4, $5, 'TND', 9000, 0, 9000, (SELECT version FROM billing_current_fee_cap($3)), true)`, [U.m1, ORG, PLATFORM, productId, priceId]))
      .rejects.toMatchObject({ code: '23514', constraint: 'assistance_request_restricted' });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── races (S5D-5)

  describe('races', () => {
    it('a new request racing a late cash report (born overdue): either it is admitted first or refused; never a deadlock', async () => {
      for (let i = 0; i < 5; i += 1) {
        ORG = randomUUID();
        resetIdentities();
        const productId = await productOf();
        const p = await create({ organizationId: ORG, productId, priceId: await priceOf(productId), consent: true }, 'b1');
        await backdate(p.body.id, `UPDATE assistance_request SET "consentAt" = now() - interval '100 hours' WHERE id = $1`);
        const [rep, req] = await Promise.all([reportCash(p.body.id, ago(73 * HOUR)), newRequest()]);
        expect(rep.status).toBe(200);
        expect([201, 409]).toContain(req.status);
        if (req.status === 409) expect(req.body.restrictions).toEqual(['T1']);
      }
    });

    it('a new request racing the beneficiary\'s confirmation: refused before it, admitted after it; concurrent requests and the sweep never deadlock', async () => {
      for (let i = 0; i < 5; i += 1) {
        ORG = randomUUID();
        resetIdentities();
        const r = await reported();
        const [c, a, b] = await Promise.all([confirm(r.obligationId), newRequest('b2'), newRequest('m1'), sweep()]);
        expect(c.status).toBe(200);
        for (const x of [a, b]) {
          expect([201, 409]).toContain(x.status);
          if (x.status === 409) expect(x.body.restrictions).toEqual(['T1', 'T2']);
        }
      }
    });

    it('simultaneous requests in one restricted Organization are all refused; in another Organization all admitted', async () => {
      await owed();
      const [restricted, free] = await Promise.all([
        Promise.all(['b2', 'm1', 'b2', 'm1'].map((b) => newRequest(b, ORG))),
        Promise.all([0, 1, 2, 3].map(() => newRequest('b1', ORG2))),
      ]);
      expect(restricted.map((x) => x.body.code)).toEqual(Array(4).fill('assistance_restricted'));
      expect(free.map((x) => x.status)).toEqual([201, 201, 201, 201]);
    });

    it('a new request racing the sweep that opens an obligation and a verified success: one consistent outcome, no deadlock', async () => {
      for (let i = 0; i < 4; i += 1) {
        ORG = randomUUID();
        resetIdentities();
        const r = await collected();
        const s = await started(r.id);
        await expireDeadline(r.id);
        const [, , req] = await Promise.all([t.bus.deliver(s.ev(i % 2 === 0 ? 'payment.succeeded' : 'payment.failed')), sweep(), newRequest()]);
        await sweep();
        const purchased = (await purchases(r.id)) === 1;
        expect([purchased ? 1 : 0, await obligations(r.id)]).toEqual(purchased ? [1, 0] : [0, 1]);
        expect([201, 409]).toContain(req.status);
        expect(await kinds()).toEqual(purchased ? [] : expect.arrayContaining([expect.objectContaining({ kind: 'T2' })]));
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── BIL-26 authorization (S5D-6)

  describe('restriction read (BIL-26)', () => {
    it('the Owner of the Platform, the Organization actor and a service with restriction.read on that Platform read it; read-only', async () => {
      const r = await owed();
      const expected = { restrictions: [{ kind: 'T1', sourceId: r.id, since: expect.any(String) }, { kind: 'T2', sourceId: r.obligationId, since: expect.any(String) }] };
      for (const bearer of ['owner-tok', 'a1', reader.token]) {
        const res = await restrictionsOf(ORG, bearer);
        expect([res.status, res.body], bearer).toEqual([200, expected]);
        expect(res.headers['cache-control']).toBe('no-store');
      }
      expect((await restrictionsOf(ORG)).body).toEqual(expected); // reading changed nothing
    });

    it('everyone else is refused: a beneficiary, a revoked administrator, another Organization\'s administrator, an operator, another Company\'s Owner (404); services without the exact operation (403)', async () => {
      await owed();
      for (const bearer of ['b1', 'b2', 'a2', 'operator-tok', 'foreign-owner-tok', 'admin-beneficiary-not']) {
        const res = await restrictionsOf(ORG, bearer);
        expect(res.status, bearer).toBe(bearer === 'admin-beneficiary-not' ? 401 : 404);
      }
      identities.set('a1', { ...identities.get('a1')!, memberships: [membership(ORG, { admin: false })] });
      expect((await restrictionsOf(ORG, 'a1')).status).toBe(404); // revoked administrator capability, live
      expect([(await restrictionsOf(ORG, producer.token)).status, (await restrictionsOf(ORG, producer.token)).body.code]).toEqual([403, 'operation_not_permitted']);
      expect([(await restrictionsOf(ORG, foreignReader.token)).status, (await restrictionsOf(ORG, foreignReader.token)).body.code]).toEqual([403, 'organization_not_permitted']);
      expect((await restrictionsOf(randomUUID(), 'owner-tok')).status).toBe(404); // an unknown Organization
      expect((await restrictionsOf(ORG, null as never)).status).toBe(401);
    });

    it('Auth or the Organization reference unavailable: 503, nothing read', async () => {
      expect((await restrictionsOf(ORG, 'auth-down')).status).toBe(503);
      expect((await restrictionsOf(ORG_DOWN, 'owner-tok')).status).toBe(503);
      identities.set('a-down', { id: U.a1, adminTier: null, isActive: true, memberships: [membership(ORG_DOWN, { admin: true })] });
      expect((await restrictionsOf(ORG_DOWN, 'a-down')).status).toBe(503);
      auth.mode = 'down';
      auth.target = 'access';
      expect((await restrictionsOf(ORG, 'owner-tok')).status).toBe(503);
    });
  });

  it('production mounts nothing of S5d', () => {
    expect(AssistanceModule.register({ isProduction: true } as BillingConfig)).toEqual({ module: AssistanceModule });
  });
});

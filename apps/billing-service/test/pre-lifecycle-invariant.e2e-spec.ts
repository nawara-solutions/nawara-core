import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity, type AuthMembership, type EventEnvelope, type OrganizationReferenceResolver,
} from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { RESERVED_RESTRICTION_KINDS, RESTRICTION_KINDS } from '../src/assistance/assistance-restrictions.js';
import { CashReturnSweep } from '../src/assistance/cash-return-sweep.js';
import type { PaymentEventFacts, PaymentEventName } from '../src/domain/payment-event-decision.js';
import type { PaymentCreateBody } from '../src/domain/payment-request-mapping.js';
import { PaymentDispatcher } from '../src/payment-integration/payment-dispatcher.js';
import type { CancelPaymentOutcome, CreatePaymentOutcome, PaymentClient, PaymentSnapshot } from '../src/payment-integration/payment-client.js';
import { RecoveryService } from '../src/recovery/recovery.service.js';
import { DisputeLossService } from '../src/refunds/dispute-loss.service.js';
import type { PaymentDisputeClient } from '../src/refunds/payment-dispute-client.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

type Row = Record<string, any>;

/** Payment, as the dispatcher sees it: a scripted outcome per payment request (default: transient, i.e. Payment did not answer). */
class FakePaymentClient implements PaymentClient {
  readonly outcomes = new Map<string, CreatePaymentOutcome>();
  async createPayment(body: PaymentCreateBody): Promise<CreatePaymentOutcome> {
    return this.outcomes.get(body.paymentRequestId) ?? { kind: 'transient' };
  }
  async getPayment(): Promise<PaymentSnapshot | null> {
    return null;
  }
  async cancelPayment(): Promise<CancelPaymentOutcome> {
    return { kind: 'cancelled' };
  }
}
/** Payment's losses read (R6E-6): empty here; the loss under test arrives as Payment's verified event. */
const noLossesRead: PaymentDisputeClient = { losses: async () => [] };

const COMPANY = randomUUID();
const PLATFORM = randomUUID();
const U = { b1: randomUUID(), aC: randomUUID(), aX: randomUUID(), m1: randomUUID() };

/**
 * Core V2 T-A4 (the Owner's D-1, S0-C7 item 1; DN-1.4; V5-9): Billing's pre-lifecycle assistance behaviour neither depends on nor consumes an
 * Organization lifecycle state. Two Organizations of one Platform are compared in every test:
 *   - C: the Organization reference answers the CONTRACT shape `{organizationId, platformId, companyId}` (the kit's reference read);
 *   - X: the same anchors plus UNEXPECTED, NON-CONTRACT fields (`effectiveStatus: 'SUSPENDED'`, `effectiveSince`, `lifecycleSource`). They are
 *     handed to Billing directly (the resolver port), bypassing the kit HTTP client that would drop them, so Billing ITSELF is tested.
 * `SUSPENDED` here is NOT an inactive Organization: no Core V2 path can make a scope inactive until the first lifecycle-enabled release
 * (ADR-0060 L2/L3 with V-4). This suite certifies only that Billing ignores such a field today, so creation, discharge and the T1 / T2 / T3
 * restrictions are governed by the existing actor authorization, financial state and idempotency alone. It does NOT certify behaviour
 * after V-4: that stays the S5e / D6 work and the S0 §8 inactive-scope criterion of the lifecycle release (S0-C7 items 2 and 3).
 */
describeWithEnv('Billing pre-lifecycle invariant (T-A4, S0-C7) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const payment = new FakePaymentClient();
  const producer = generateServiceToken();
  let ORG_C = randomUUID();
  let ORG_X = randomUUID();
  const orgs = () => [{ shape: 'contract', org: ORG_C, admin: 'aC' }, { shape: 'unexpected lifecycle field', org: ORG_X, admin: 'aX' }] as const;

  const membership = (organizationId: string, isOrganizationAdmin = false): AuthMembership => ({
    id: randomUUID(), organization: { id: organizationId }, platform: { id: PLATFORM }, status: 'active', isOrganizationAdmin,
  });
  const identities = new Map<string, AuthIdentity>();
  const resetIdentities = () => {
    identities.clear();
    identities.set('b1', { id: U.b1, adminTier: null, isActive: true, memberships: [membership(ORG_C), membership(ORG_X)] });
    identities.set('aC', { id: U.aC, adminTier: null, isActive: true, memberships: [membership(ORG_C, true)] });
    identities.set('aX', { id: U.aX, adminTier: null, isActive: true, memberships: [membership(ORG_X, true)] });
    identities.set('m1', { id: U.m1, adminTier: null, isActive: true, memberships: [membership(ORG_C), membership(ORG_X)] });
  };
  const authClient: AuthClient = {
    getIdentity: async (bearer) => {
      if (bearer === 'auth-down') throw new ServiceUnavailableException();
      return identities.get(bearer) ?? null;
    },
    hasPlatformAccess: async () => false,
  };
  /** Every lookup is counted; X carries fields no contract defines. */
  const lookups: string[] = [];
  const reference: OrganizationReferenceResolver = {
    resolve: async (organizationId) => {
      lookups.push(organizationId);
      if (organizationId === ORG_C) return { organizationId, platformId: PLATFORM, companyId: COMPANY };
      if (organizationId === ORG_X) {
        return { organizationId, platformId: PLATFORM, companyId: COMPANY, effectiveStatus: 'SUSPENDED', effectiveSince: '2026-10-01T00:00:00Z', lifecycleSource: 'ancestor' } as never;
      }
      return null;
    },
  };
  const server = () => t.app.getHttpServer();

  // ── fixtures
  let seq = 0;
  const offering = async (unit = 7000) => {
    const productId = (await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId") VALUES ('billing-owner', 'company', $1, $2, 'Personal plan', 'active', 'personal', $3) RETURNING id`,
      [COMPANY, `ta4-${++seq}`, PLATFORM])).rows[0].id as string;
    const priceId = (await admin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom") VALUES ($1, $2, 'TND', $3, 'recurring', 'month', 1, '2020-01-01T00:00:00Z') RETURNING id`,
      [productId, `ta4-${++seq}`, unit])).rows[0].id as string;
    return { productId, priceId };
  };
  /** A test-only bypass of the immutability triggers (as a superuser), to place consent or a deadline in the past, as the S5 suites do. */
  const backdate = async (sql: string, params: unknown[]) => {
    const cl = await admin.connect();
    try {
      await cl.query(`SET session_replication_role = replica`);
      await cl.query(sql, params);
    } finally {
      await cl.query(`SET session_replication_role = origin`);
      cl.release();
    }
  };
  let k = 0;
  const key = () => `ta4-${++k}-${randomUUID().slice(0, 8)}`;
  const send = (r: request.Test, bearer: string | null, idem: string | null) => {
    if (bearer) r = r.set('authorization', `Bearer ${bearer}`);
    if (idem) r = r.set('idempotency-key', idem);
    return r;
  };
  const post = (path: string, bearer: string, body?: unknown, idem: string | null = key()) => {
    const r = send(request(server()).post(path), bearer, idem);
    return body === undefined ? r.send() : r.send(body as object);
  };
  const create = (organizationId: string, o: { productId: string; priceId: string }, bearer = 'b1', idem = key()) =>
    post('/billing/assistance-requests', bearer, { organizationId, ...o, consent: true }, idem);
  const restrictionsOf = async (organizationId: string, bearer: string) => {
    const r = await send(request(server()).get(`/billing/organizations/${organizationId}/restrictions`), bearer, null);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.restrictions as { kind: string }[];
  };
  const kinds = async (organizationId: string, bearer: string) => (await restrictionsOf(organizationId, bearer)).map((x) => x.kind);
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const HOUR = 3_600_000;
  const pending = async (organizationId: string) => {
    const off = await offering();
    const c = await create(organizationId, off);
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    await backdate(`UPDATE assistance_request SET "consentAt" = now() - interval '200 hours' WHERE id = $1`, [c.body.id]);
    return { id: c.body.id as string, ...off, body: c.body as Row };
  };
  /** The comparable part of a response: identifiers, keys and instants removed (they differ by construction between C and X). */
  const shape = (b: Row) => {
    const drop = new Set(['id', 'organizationId', 'productId', 'priceId', 'beneficiaryUserId', 'consentAt', 'createdAt', 'updatedAt', 'reportedAt', 'cashCollectedAt',
      'settleBy', 'declinedAt', 'declinedBy', 'invoiceId', 'paymentRequestId', 'openedAt', 'returnedAt', 'returnReportedAt', 'confirmedAt', 'requestId', 'obligationId',
      'respondedAt', 'disputeId', 'respondedBy', 'confirmedBy', 'reportedBy', 'assistanceRequestId', 'feeCapVersion', 'collectionFeeCapVersion']);
    const strip = (v: unknown): unknown => (Array.isArray(v) ? v.map(strip) : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Row).filter(([kk]) => !drop.has(kk)).sort(([a], [b2]) => (a < b2 ? -1 : 1)).map(([kk, vv]) => [kk, strip(vv)])) : v);
    return strip(b) as Row;
  };
  /** Payment accepts the settlement's payment request; then Payment's verified success arrives through the real strict consumer. */
  const paid = async (paymentRequestId: string) => {
    const inv = (await admin.query(`SELECT i.* FROM invoice i JOIN payment_request r ON r."invoiceId" = i.id WHERE r.id = $1`, [paymentRequestId])).rows[0] as Row;
    const paymentId = randomUUID();
    payment.outcomes.set(paymentRequestId, { kind: 'accepted', snapshot: {
      paymentId, paymentRequestId, status: 'pending', amount: Number(inv.total), currency: inv.currency, sourceType: 'invoice', sourceId: inv.id,
      payer: { type: 'organization', id: inv.payerId }, seller: { type: 'company', id: COMPANY }, organizationId: inv.organizationId, closedAt: null,
    } as PaymentSnapshot });
    await t.app.get(PaymentDispatcher).dispatchOnce(0, 100);
    const id = randomUUID();
    const facts: PaymentEventFacts = {
      name: 'payment.succeeded' as PaymentEventName, source: 'payment-service', paymentId, producer: 'billing-service', paymentRequestId, sourceType: 'invoice', sourceId: inv.id,
      payer: { type: 'organization', id: inv.payerId }, seller: { type: 'company', id: COMPANY }, organizationId: inv.organizationId, amount: Number(inv.total), currency: inv.currency,
      revision: 1, purpose: 'assisted_settlement', beneficiaryUserId: U.b1, liveMode: false,
    };
    const { name, source, ...payload } = facts;
    await t.bus.deliver({ id, name, payload: payload as Record<string, unknown>, headers: { eventId: id, occurredAt: new Date().toISOString(), source, version: 1 } } as EventEnvelope);
    return { paymentId, amount: Number(inv.total) };
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingta4');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 8 });
    await admin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [PLATFORM, COMPANY, randomUUID()]);
    t = await createTestApp({
      databaseUrl: db.url, authClient, organizationReference: reference, paymentClient: payment, paymentDisputeClient: noLossesRead,
      tokens: [{ caller: 'test-producer', digest: producer.digest }],
    });
  });
  beforeEach(() => {
    ORG_C = randomUUID(); // a fresh pair per test: restrictions are derived from durable rows and never cleared by a test
    ORG_X = randomUUID();
    resetIdentities();
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  describe('no lifecycle source, state or port exists in Billing', () => {
    it('`inactive` stays RESERVED with no source; the produced kinds are exactly T1, T2, T3', async () => {
      expect(RESERVED_RESTRICTION_KINDS).toEqual(['inactive']);
      expect([...RESTRICTION_KINDS]).toEqual(['T1', 'T2', 'T3']);
      for (const kind of RESERVED_RESTRICTION_KINDS) {
        const src = await admin.query(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'billing_assistance_restrictions' AND prosrc LIKE $1`, [`%'${kind}'%`]);
        expect(src.rows[0].n, `${kind}: no source in the restriction function`).toBe(0);
      }
    });

    it('no lifecycle table, column, provider or reference field is part of Billing', async () => {
      const lifecycle = /(lifecycle|effective_?status|effective_?since|suspended_?at|archived_?at|organization_?status|scope_?state|inactive_?scope)/i;
      const cols = await admin.query<{ table_name: string; column_name: string }>(`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'`);
      expect(cols.rows.filter((c) => lifecycle.test(c.table_name) || lifecycle.test(c.column_name)).map((c) => `${c.table_name}.${c.column_name}`)).toEqual([]);
      const container = (t.app as unknown as { container: { getModules(): Map<string, { providers: Map<unknown, { name?: unknown }> }> } }).container;
      const providers: string[] = [];
      for (const mod of container.getModules().values()) for (const [token, w] of mod.providers) providers.push(typeof token === 'function' ? token.name : String(token), typeof w.name === 'string' ? w.name : '');
      expect(providers.length).toBeGreaterThan(20); // the enumeration is real
      expect(providers.filter((p) => /(lifecycle|effectiveStatus|organizationStatus|scopeState)/i.test(p))).toEqual([]);
    });
  });

  describe('the same rules for both reference shapes', () => {
    it('creation: identical frozen terms and outcome; no restriction; the unexpected field is never echoed', async () => {
      const results: Row[] = [];
      for (const o of orgs()) {
        const r = await create(o.org, await offering(8100));
        expect(r.status, `${o.shape}: ${JSON.stringify(r.body)}`).toBe(201);
        expect(r.body).toMatchObject({ status: 'pending', organizationId: o.org, platformId: PLATFORM, baseAmount: 8100, totalAmount: 8100, overdue: false });
        expect(JSON.stringify(r.body)).not.toMatch(/effectiveStatus|SUSPENDED|effectiveSince|lifecycle/);
        expect(await kinds(o.org, o.admin)).toEqual([]);
        results.push(shape(r.body));
      }
      expect(results[1]).toEqual(results[0]);
      expect(lookups).toEqual(expect.arrayContaining([ORG_C, ORG_X])); // Billing did consult the reference for both
    });

    it('decline: the beneficiary and the Organization actor decline in both; another member gets the collapsed 404', async () => {
      for (const o of orgs()) {
        const p1 = await pending(o.org);
        expect((await post(`/billing/assistance-requests/${p1.id}/decline`, 'm1')).status, `${o.shape}: a stranger`).toBe(404);
        const d1 = await post(`/billing/assistance-requests/${p1.id}/decline`, 'b1');
        expect([d1.status, d1.body.status], o.shape).toEqual([200, 'declined']);
        const p2 = await pending(o.org);
        const d2 = await post(`/billing/assistance-requests/${p2.id}/decline`, o.admin);
        expect([d2.status, d2.body.status, d2.body.declinedByRole], o.shape).toEqual([200, 'declined', 'organization_actor']);
      }
    });

    it('cash collection, settlement, dispute and response: the same actors, states and idempotent replays in both', async () => {
      const results: Row[] = [];
      for (const o of orgs()) {
        const p = await pending(o.org);
        expect((await post(`/billing/assistance-requests/${p.id}/cash-collection`, 'b1', { cashCollectedAt: ago(10 * 60_000) })).status, `${o.shape}: the beneficiary never reports`).toBe(403);
        const ck = key();
        const collection = { cashCollectedAt: ago(10 * 60_000) };
        const c = await post(`/billing/assistance-requests/${p.id}/cash-collection`, o.admin, collection, ck);
        expect([c.status, c.body.status], o.shape).toEqual([200, 'cash_collected']);
        expect((await post(`/billing/assistance-requests/${p.id}/cash-collection`, o.admin, collection, ck)).body).toEqual(c.body); // the same command: replayed
        expect((await post(`/billing/assistance-requests/${p.id}/settlement`, 'b1')).status, `${o.shape}: the beneficiary never settles`).toBe(403);
        const sk = key();
        const s = await post(`/billing/assistance-requests/${p.id}/settlement`, o.admin, undefined, sk);
        expect(s.status, `${o.shape}: ${JSON.stringify(s.body)}`).toBe(201);
        expect((await post(`/billing/assistance-requests/${p.id}/settlement`, o.admin, undefined, sk)).body).toEqual(s.body); // replay: one channel
        expect(Number((await admin.query(`SELECT count(*) FROM assistance_settlement_channel WHERE "assistanceRequestId" = $1`, [p.id])).rows[0].count)).toBe(1);
        const dispute = await post(`/billing/assistance-requests/${p.id}/disputes`, 'b1', { reasonCode: 'collection_time_incorrect' });
        expect([dispute.status, dispute.body.status], `${o.shape}: ${JSON.stringify(dispute.body)}`).toEqual([201, 'open']);
        const resp = await post(`/billing/assistance-disputes/${dispute.body.id}/responses`, o.admin, { position: 'accepts' });
        expect(resp.status, `${o.shape}: ${JSON.stringify(resp.body)}`).toBe(201);
        expect(await kinds(o.org, o.admin)).toEqual([]);
        results.push({ collected: shape(c.body), settlement: shape(s.body), dispute: shape(dispute.body), response: shape(resp.body) });
      }
      expect(results[1]).toEqual(results[0]);
    });

    it('T1 and T2: a late report and its cash-return obligation restrict and clear by financial state alone; `inactive` never appears', async () => {
      const trace: string[][][] = [];
      for (const o of orgs()) {
        const steps: string[][] = [];
        const p = await pending(o.org);
        const late = await post(`/billing/assistance-requests/${p.id}/cash-collection`, o.admin, { cashCollectedAt: ago(80 * HOUR) });
        expect([late.status, late.body.overdue], o.shape).toEqual([200, true]); // born overdue (S5a D-6)
        steps.push(await kinds(o.org, o.admin)); // T1
        const refused = await create(o.org, await offering());
        expect([refused.status, refused.body.code], o.shape).toEqual([409, 'assistance_restricted']);
        steps.push(refused.body.restrictions as string[]);
        await t.app.get(CashReturnSweep).sweepOnce();
        const obligation = (await admin.query(`SELECT id FROM cash_return_obligation WHERE "assistanceRequestId" = $1`, [p.id])).rows[0];
        expect(obligation, `${o.shape}: the sweep opened the obligation`).toBeDefined();
        steps.push(await kinds(o.org, o.admin)); // T1, T2
        expect((await post(`/billing/cash-return-obligations/${obligation.id}/return`, 'b1', { returnedAt: ago(HOUR) })).status, `${o.shape}: the beneficiary never reports a return`).toBe(403);
        const ret = await post(`/billing/cash-return-obligations/${obligation.id}/return`, o.admin, { returnedAt: ago(HOUR) });
        expect([ret.status, ret.body.status], o.shape).toEqual([200, 'return_reported']);
        expect((await post(`/billing/cash-return-obligations/${obligation.id}/confirm`, o.admin)).status, `${o.shape}: only the beneficiary confirms`).toBe(403);
        const ok = key();
        const conf = await post(`/billing/cash-return-obligations/${obligation.id}/confirm`, 'b1', undefined, ok);
        expect([conf.status, conf.body.status], o.shape).toEqual([200, 'confirmed_returned']);
        expect((await post(`/billing/cash-return-obligations/${obligation.id}/confirm`, 'b1', undefined, ok)).body).toEqual(conf.body); // replay
        steps.push(await kinds(o.org, o.admin)); // cleared
        expect((await create(o.org, await offering())).status, `${o.shape}: admitted again`).toBe(201);
        trace.push(steps);
      }
      expect(trace[0]).toEqual([['T1'], ['T1'], ['T1', 'T2'], []]);
      expect(trace[1]).toEqual(trace[0]);
      expect(trace.flat(2)).not.toContain('inactive');
    });

    it('T3: a verified full chargeback of an assisted purchase opens recovery and T3 in both, from the verified loss only', async () => {
      const restricted: string[][] = [];
      for (const o of orgs()) {
        const p = await pending(o.org);
        expect((await post(`/billing/assistance-requests/${p.id}/cash-collection`, o.admin, { cashCollectedAt: ago(10 * 60_000) })).status).toBe(200);
        const s = await post(`/billing/assistance-requests/${p.id}/settlement`, o.admin);
        expect(s.status, JSON.stringify(s.body)).toBe(201);
        const { paymentId, amount } = await paid(s.body.paymentRequestId);
        expect(Number((await admin.query(`SELECT count(*) FROM subscription_purchase WHERE "assistanceRequestId" = $1`, [p.id])).rows[0].count), o.shape).toBe(1);
        expect(await kinds(o.org, o.admin)).toEqual([]);
        const id = randomUUID();
        const disputeId = randomUUID();
        await t.bus.deliver({ id, name: 'payment.dispute.lost', payload: {
          disputeId, paymentId, paymentRequestId: s.body.paymentRequestId, producer: 'billing-service', organizationId: o.org, purpose: 'assisted_settlement', amount, currency: 'TND',
          lostAt: new Date().toISOString(), chargeback: { factId: randomUUID(), amount, currency: 'TND' }, liveMode: false,
        }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 } } as never);
        await t.app.get(DisputeLossService).drainOnce();
        await t.app.get(RecoveryService).drainOnce();
        restricted.push(await kinds(o.org, o.admin));
        const refused = await create(o.org, await offering());
        expect([refused.status, refused.body.code, refused.body.restrictions], o.shape).toEqual([409, 'assistance_restricted', ['T3']]);
      }
      expect(restricted).toEqual([['T3'], ['T3']]);
    });
  });
});

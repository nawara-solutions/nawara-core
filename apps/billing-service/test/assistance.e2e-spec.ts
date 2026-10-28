import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  HierarchyUnavailableError, generateServiceToken, kitMigrationsDir, runMigrations, type AuthClient, type AuthIdentity, type AuthMembership, type OrganizationReferenceResolver,
} from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { AssistanceModule } from '../src/assistance/assistance.module.js';
import { AssistanceService } from '../src/assistance/assistance.service.js';
import type { BillingConfig } from '../src/config/billing-config.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';

type Row = Record<string, any>;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const PLATFORM = randomUUID();
const OTHER_PLATFORM = randomUUID();
const UNCONFIGURED_PLATFORM = randomUUID();
// Core V2 S5d: a fresh Organization per test (beforeEach). T1/T2 (S5D-1, S5D-2) restrict an Organization's NEW requests, so one test's
// overdue or unconfirmed fixtures must never restrict the next one's; restrictions are derived and never cleared by a test.
let ORG = randomUUID(); // on PLATFORM
let ORG2 = randomUUID(); // on PLATFORM
const ORG_OTHER = randomUUID(); // on OTHER_PLATFORM
const ORG_UNCONFIGURED = randomUUID(); // on a Platform with no billing configuration
const ORG_UNKNOWN = randomUUID(); // Organization Service does not know it
const ORG_DOWN = randomUUID(); // Organization Service cannot answer for it
const ORG_MISMATCH = randomUUID(); // on PLATFORM, but the membership names OTHER_PLATFORM

const REFERENCE: Record<string, string> = { [ORG]: PLATFORM, [ORG2]: PLATFORM, [ORG_OTHER]: OTHER_PLATFORM, [ORG_UNCONFIGURED]: UNCONFIGURED_PLATFORM, [ORG_MISMATCH]: PLATFORM };
const PLATFORM_OF: Record<string, string> = { ...REFERENCE, [ORG_UNKNOWN]: PLATFORM, [ORG_DOWN]: PLATFORM, [ORG_MISMATCH]: OTHER_PLATFORM };

const U = { b1: randomUUID(), b2: randomUUID(), a1: randomUUID(), a2: randomUUID(), adminBeneficiary: randomUUID(), m1: randomUUID(), pending: randomUUID(), owner: randomUUID(), operator: randomUUID(), inactive: randomUUID() };
const membership = (organizationId: string, o: { admin?: boolean; status?: AuthMembership['status'] } = {}): AuthMembership => ({
  id: randomUUID(), organization: { id: organizationId }, platform: { id: PLATFORM_OF[organizationId] }, status: o.status ?? 'active', isOrganizationAdmin: o.admin ?? false,
});

/**
 * Core V2 S5a Organization assistance (register BIL-13, BIL-14, BIL-15 and the assistance read; FC-8; the Owner's D-1 to D-12), for
 * DEVELOPMENT AND SIMULATION ONLY: the real application on real PostgreSQL 16, Auth's `/auth/me` stubbed per bearer and asked on every
 * request (so a revocation applies at once), and the Organization reference stubbed per Organization (unknown, unavailable included).
 */
describeWithEnv('Organization assistance (Core V2 S5a, simulation) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const service = generateServiceToken();
  const identities = new Map<string, AuthIdentity>();
  const resetIdentities = () => {
    identities.clear();
    const all = [ORG, ORG2, ORG_OTHER, ORG_UNCONFIGURED, ORG_UNKNOWN, ORG_DOWN, ORG_MISMATCH];
    identities.set('b1', { id: U.b1, adminTier: null, isActive: true, memberships: all.map((o) => membership(o)) });
    identities.set('b2', { id: U.b2, adminTier: null, isActive: true, memberships: [membership(ORG)] });
    identities.set('a1', { id: U.a1, adminTier: null, isActive: true, memberships: [membership(ORG, { admin: true })] });
    identities.set('a2', { id: U.a2, adminTier: null, isActive: true, memberships: [membership(ORG2, { admin: true })] });
    identities.set('admin-beneficiary', { id: U.adminBeneficiary, adminTier: null, isActive: true, memberships: [membership(ORG, { admin: true })] });
    identities.set('m1', { id: U.m1, adminTier: null, isActive: true, memberships: [membership(ORG)] });
    identities.set('pending', { id: U.pending, adminTier: null, isActive: true, memberships: [membership(ORG, { status: 'pending' })] });
    identities.set('owner', { id: U.owner, adminTier: 'owner', isActive: true, memberships: [membership(ORG, { admin: true })] });
    identities.set('operator', { id: U.operator, adminTier: 'operator', isActive: true, memberships: [membership(ORG, { admin: true })] });
    identities.set('inactive', { id: U.inactive, adminTier: null, isActive: false, memberships: [membership(ORG, { admin: true })] });
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
      const platformId = REFERENCE[organizationId];
      return platformId ? { organizationId, platformId, companyId: platformId === PLATFORM ? COMPANY : OTHER_COMPANY } : null;
    },
  };
  const server = () => t.app.getHttpServer();

  // ── fixtures
  let seq = 0;
  const productOf = async (o: { platformId?: string; status?: string; producer?: string; sellerId?: string } = {}) => {
    const platformId = o.platformId ?? PLATFORM;
    return (await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId") VALUES ($1, 'company', $2, $3, 'Personal plan', $4, 'personal', $5) RETURNING id`,
      [o.producer ?? 'billing-owner', o.sellerId ?? (platformId === OTHER_PLATFORM ? OTHER_COMPANY : COMPANY), `plan-${++seq}`, o.status ?? 'active', platformId])).rows[0].id as string;
  };
  const priceOf = async (productId: string, o: { unit?: number; retired?: boolean } = {}) =>
    (await admin.query(`INSERT INTO price ("productId", "clientReference", currency, "unitAmount", "interval", "intervalUnit", "intervalCount", "effectiveFrom", "retiredAt") VALUES ($1, $2, 'TND', $3, 'recurring', 'month', 1, '2020-01-01T00:00:00Z', $4) RETURNING id`,
      [productId, `r-${++seq}`, o.unit ?? 9000, o.retired ? new Date() : null])).rows[0].id as string;
  const offering = async (o: { platformId?: string; unit?: number } = {}) => {
    const productId = await productOf({ platformId: o.platformId });
    return { productId, priceId: await priceOf(productId, { unit: o.unit }) };
  };
  const setCap = async (platformId: string, amount: number) =>
    (await admin.query(`INSERT INTO fee_cap ("platformId", amount, currency, "setBy") VALUES ($1, $2, 'TND', $3) RETURNING version`, [platformId, amount, randomUUID()])).rows[0].version as number;
  const operator = randomUUID();
  let delegation: string;
  const approveFee = async (organizationId: string, productId: string, amount: number) => {
    const id = (await admin.query(`INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES ($1, $2, $3, $4, 'TND', $5, $6) RETURNING id`,
      [PLATFORM, organizationId, productId, amount, delegation, operator])).rows[0].id as string;
    await admin.query(`UPDATE fee_proposal SET status = 'approved', "decidedBy" = $2 WHERE id = $1`, [id, randomUUID()]);
    return id;
  };

  // ── HTTP
  let k = 0;
  const key = () => `assist-${++k}-${randomUUID().slice(0, 8)}`;
  const send = (r: request.Test, bearer: string | null, idem: string | null) => {
    if (bearer) r = r.set('authorization', `Bearer ${bearer}`);
    if (idem) r = r.set('idempotency-key', idem);
    return r;
  };
  const create = (body: unknown, bearer: string | null = 'b1', idem: string | null = key()) => send(request(server()).post('/billing/assistance-requests'), bearer, idem).send(body as object);
  const read = (id: string, bearer: string | null = 'b1') => send(request(server()).get(`/billing/assistance-requests/${id}`), bearer, null);
  const decline = (id: string, bearer: string | null = 'b1', idem: string | null = key(), body?: unknown) => {
    const r = send(request(server()).post(`/billing/assistance-requests/${id}/decline`), bearer, idem);
    return body === undefined ? r.send() : r.send(body as object);
  };
  const report = (id: string, cashCollectedAt: unknown, bearer: string | null = 'a1', idem: string | null = key(), extra: Row = {}) =>
    send(request(server()).post(`/billing/assistance-requests/${id}/cash-collection`), bearer, idem).send({ cashCollectedAt, ...extra });

  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0] as Row;
  const count = async (table: string) => Number((await one(`SELECT count(*) AS n FROM ${table}`)).n);
  const audit = async (resourceId: string) =>
    (await admin.query(`SELECT name, payload FROM outbox WHERE name LIKE 'audit.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", name`, [resourceId])).rows as Row[];
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  const HOUR = 3_600_000;
  /** Backdates a request's consent (a test-only bypass of the immutability trigger, as a superuser), so a past collection is admissible. */
  const backdateConsent = async (id: string, ms: number) => {
    const cl = await admin.connect();
    try {
      await cl.query(`SET session_replication_role = replica`);
      await cl.query(`UPDATE assistance_request SET "consentAt" = now() - $2::interval WHERE id = $1`, [id, `${ms} milliseconds`]);
    } finally {
      await cl.query(`SET session_replication_role = origin`);
      cl.release();
    }
  };
  /**
   * A pending request by `bearer` in ORG for a new offering, its consent backdated by `consentedAgo` (default one hour) so that a cash
   * collection in the recent past is admissible; `consentedAgo: 0` keeps the real consent time.
   */
  const pendingRequest = async (bearer = 'b1', o: { organizationId?: string; consentedAgo?: number } = {}) => {
    const off = await offering();
    const r = await create({ organizationId: o.organizationId ?? ORG, ...off, consent: true }, bearer);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    if ((o.consentedAgo ?? HOUR) > 0) await backdateConsent(r.body.id, o.consentedAgo ?? HOUR);
    return { ...off, id: r.body.id as string, body: (await read(r.body.id, bearer)).body as Row };
  };

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billingassist');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 12 });
    for (const [p, c] of [[PLATFORM, COMPANY], [OTHER_PLATFORM, OTHER_COMPANY]]) {
      await admin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, 'TND', $3)`, [p, c, randomUUID()]);
    }
    delegation = (await admin.query(`INSERT INTO fee_delegation ("platformId", "operatorUserId", "grantedBy") VALUES ($1, $2, $3) RETURNING id`, [PLATFORM, operator, randomUUID()])).rows[0].id;
    t = await createTestApp({ databaseUrl: db.url, authClient, organizationReference: reference, tokens: [{ caller: 'test-producer', digest: service.digest }] });
  });
  beforeEach(() => {
    ORG = randomUUID();
    ORG2 = randomUUID();
    REFERENCE[ORG] = PLATFORM;
    REFERENCE[ORG2] = PLATFORM;
    PLATFORM_OF[ORG] = PLATFORM;
    PLATFORM_OF[ORG2] = PLATFORM;
    resetIdentities();
  });
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── BIL-13: creation, consent, frozen terms

  describe('creation (BIL-13; D-1, D-2, D-3)', () => {
    it('freezes the price and no fee when none is approved, consented at the database time, with nothing financial created', async () => {
      const off = await offering({ unit: 12_500 });
      const before = { invoices: await count('invoice'), requests: await count('payment_request'), purchases: await count('subscription_purchase'), events: Number((await one(`SELECT count(*) AS n FROM outbox WHERE name NOT LIKE 'audit.%'`)).n) };
      const r = await create({ organizationId: ORG, ...off, consent: true });
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({
        status: 'pending', beneficiaryUserId: U.b1, organizationId: ORG, platformId: PLATFORM, productId: off.productId, priceId: off.priceId, currency: 'TND',
        baseAmount: 12_500, feeAmount: 0, totalAmount: 12_500, feeProposalId: null, consent: true, declinedByRole: null, cashCollectedAt: null, reportedAt: null, settleBy: null, overdue: false,
      });
      const row = await one(`SELECT "consentAt", "createdAt", "feeCapVersion" FROM assistance_request WHERE id = $1`, [r.body.id]);
      expect(r.body.consentAt).toBe(row.consentAt.toISOString());
      expect(Math.abs(row.consentAt.getTime() - Date.now())).toBeLessThan(60_000);
      // D-11: an assistance request is not an invoice, a payment request, a purchase or a domain event
      expect({ invoices: await count('invoice'), requests: await count('payment_request'), purchases: await count('subscription_purchase'), events: Number((await one(`SELECT count(*) AS n FROM outbox WHERE name NOT LIKE 'audit.%'`)).n) }).toEqual(before);
      const events = await audit(r.body.id);
      expect(events.map((e) => e.name)).toEqual(['audit.assistance_request.created']);
      expect(events[0].payload).toMatchObject({
        action: 'assistance_request.created', actor: { type: 'user', id: U.b1, userKind: 'member' }, organizationId: ORG,
        resource: { type: 'assistance_request', id: r.body.id }, outcome: 'succeeded', changes: { product_id: off.productId, price_id: off.priceId, base_amount: 12_500, fee_amount: 0 },
      });
    });

    it("freezes the Organization's approved fee, its proposal and the current cap version; a later fee change never rewrites the consent", async () => {
      const off = await offering({ unit: 9000 });
      const version = await setCap(PLATFORM, 2000);
      const proposalId = await approveFee(ORG, off.productId, 1500);
      const r = await create({ organizationId: ORG, ...off, consent: true }, 'b2');
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ baseAmount: 9000, feeAmount: 1500, totalAmount: 10_500, feeProposalId: proposalId, feeCapVersion: version });
      expect((await audit(r.body.id))[0].payload.changes).toEqual({ product_id: off.productId, price_id: off.priceId, base_amount: 9000, fee_amount: 1500, fee_proposal_id: proposalId });
      // a later approval and a later cap change leave the frozen terms exactly as consented
      await approveFee(ORG, off.productId, 500);
      await setCap(PLATFORM, 3000);
      const later = await read(r.body.id, 'b2');
      expect(later.body).toMatchObject({ feeAmount: 1500, totalAmount: 10_500, feeProposalId: proposalId, feeCapVersion: version });
      // and the database refuses any edit of a frozen term, whatever path writes it
      for (const [col, v] of [['"feeAmount"', 0], ['"baseAmount"', 1], ['"totalAmount"', 1], ['"priceId"', randomUUID()], ['"beneficiaryUserId"', randomUUID()], ['consent', false], ['"consentAt"', new Date()]] as const) {
        await expect(admin.query(`UPDATE assistance_request SET ${col} = $2 WHERE id = $1`, [r.body.id, v]), col).rejects.toMatchObject({ code: '23514' });
      }
      await expect(admin.query(`DELETE FROM assistance_request WHERE id = $1`, [r.body.id])).rejects.toMatchObject({ code: '23514' });
    });

    it('refuses an approved fee above the current cap (409 fee_not_usable), never reducing it, and writes nothing', async () => {
      const off = await offering();
      await setCap(PLATFORM, 5000);
      await approveFee(ORG2, off.productId, 4000);
      await setCap(PLATFORM, 1000); // the cap is lowered below the approved fee
      const before = await count('assistance_request');
      const r = await create({ organizationId: ORG2, ...off, consent: true });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('fee_not_usable');
      expect(await count('assistance_request')).toBe(before);
    });

    it('requires explicit consent: absent, false or a string is 400; Billing derives every other term (unknown fields are 400)', async () => {
      const off = await offering();
      for (const body of [{ organizationId: ORG, ...off }, { organizationId: ORG, ...off, consent: false }, { organizationId: ORG, ...off, consent: 'true' }, { organizationId: ORG, ...off, consent: 1 }]) {
        const r = await create(body);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(r.body.code).toBe('invalid_assistance_request');
      }
      for (const extra of ['beneficiaryUserId', 'feeAmount', 'totalAmount', 'currency', 'status', 'consentAt', 'platformId']) {
        const r = await create({ organizationId: ORG, ...off, consent: true, [extra]: extra === 'feeAmount' ? 0 : U.b2 });
        expect(r.status, extra).toBe(400);
        expect(r.body.code).toBe('invalid_assistance_request');
      }
      expect((await create({ organizationId: 'nope', ...off, consent: true })).status).toBe(400);
      expect(await one(`SELECT count(*)::int AS n FROM assistance_request WHERE "productId" = $1`, [off.productId])).toEqual({ n: 0 });
    });

    it('D-2: only an active ordinary member with an active membership in the Organization, on its Platform (403 member_not_eligible)', async () => {
      const off = await offering();
      const refused = [
        ['m1', ORG2], // no membership there
        ['pending', ORG], // a pending membership
        ['owner', ORG], // an Owner tier, even with an administrator membership
        ['operator', ORG],
        ['inactive', ORG],
        ['b1', ORG_UNKNOWN], // Organization Service does not know it
        ['b1', ORG_MISMATCH], // the membership's Platform is not the Organization's
      ] as const;
      for (const [bearer, organizationId] of refused) {
        const r = await create({ organizationId, ...off, consent: true }, bearer);
        expect(r.status, `${bearer} ${organizationId}`).toBe(403);
        expect(r.body.code).toBe('member_not_eligible');
      }
      expect(await one(`SELECT count(*)::int AS n FROM assistance_request WHERE "productId" = $1`, [off.productId])).toEqual({ n: 0 });
    });

    it('fails closed: Auth or the Organization reference unavailable is 503; no bearer, an unknown one or a service token is 401; nothing is written', async () => {
      const off = await offering();
      const before = await count('assistance_request');
      expect((await create({ organizationId: ORG_DOWN, ...off, consent: true })).status).toBe(503);
      expect((await create({ organizationId: ORG, ...off, consent: true }, 'auth-down')).status).toBe(503);
      expect((await create({ organizationId: ORG, ...off, consent: true }, null)).status).toBe(401);
      expect((await create({ organizationId: ORG, ...off, consent: true }, 'nobody')).status).toBe(401);
      expect((await create({ organizationId: ORG, ...off, consent: true }, service.token)).status).toBe(401);
      expect(await count('assistance_request')).toBe(before);
    });

    it('the offering must be current: 409 platform_not_configured | product_not_available, 422 price_not_available', async () => {
      const unconfigured = await create({ organizationId: ORG_UNCONFIGURED, productId: randomUUID(), priceId: randomUUID(), consent: true });
      expect([unconfigured.status, unconfigured.body.code]).toEqual([409, 'platform_not_configured']);
      const otherPlatform = await offering({ platformId: OTHER_PLATFORM });
      const archived = await productOf({ status: 'archived' });
      const producers = await productOf({ producer: 'test-producer' });
      const cases = [[otherPlatform.productId, otherPlatform.priceId], [archived, await priceOf(archived)], [producers, await priceOf(producers)], [randomUUID(), randomUUID()]];
      for (const [productId, priceId] of cases) {
        const r = await create({ organizationId: ORG, productId, priceId, consent: true });
        expect([r.status, r.body.code], productId).toEqual([409, 'product_not_available']);
      }
      const productId = await productOf();
      const retired = await priceOf(productId, { retired: true });
      const foreign = (await offering()).priceId;
      for (const priceId of [retired, foreign, randomUUID()]) {
        const r = await create({ organizationId: ORG, productId, priceId, consent: true });
        expect([r.status, r.body.code], priceId).toEqual([422, 'price_not_available']);
      }
    });

    it('D-7: one unresolved request per (beneficiary, Organization, product); a decline releases it, a cash report does not', async () => {
      const p = await pendingRequest('b1');
      const again = await create({ organizationId: ORG, productId: p.productId, priceId: p.priceId, consent: true });
      expect([again.status, again.body.code]).toEqual([409, 'assistance_request_open']);
      // another Organization, or another beneficiary, is a different request
      expect((await create({ organizationId: ORG2, productId: p.productId, priceId: p.priceId, consent: true })).status).toBe(201);
      expect((await create({ organizationId: ORG, productId: p.productId, priceId: p.priceId, consent: true }, 'b2')).status).toBe(201);
      expect((await decline(p.id)).status).toBe(200);
      const fresh = await create({ organizationId: ORG, productId: p.productId, priceId: p.priceId, consent: true });
      expect(fresh.status).toBe(201);
      await backdateConsent(fresh.body.id, HOUR);
      expect((await report(fresh.body.id, ago(60_000))).status).toBe(200);
      const afterCash = await create({ organizationId: ORG, productId: p.productId, priceId: p.priceId, consent: true });
      expect([afterCash.status, afterCash.body.code]).toEqual([409, 'assistance_request_open']);
      // the database enforces it too
      await expect(admin.query(`INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
        VALUES ($1, $2, $3, $4, $5, 'TND', 9000, 0, 9000, (SELECT version FROM billing_current_fee_cap($3)), true)`, [U.b1, ORG, PLATFORM, p.productId, p.priceId])).rejects.toMatchObject({ code: '23505', constraint: 'assistance_request_unresolved_unique' });
    });

    it('D-7 under contention: eight concurrent requests with different keys create exactly one', async () => {
      const off = await offering();
      const rs = await Promise.all(Array.from({ length: 8 }, () => create({ organizationId: ORG, ...off, consent: true }, 'b2')));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.status === 409 && r.body.code === 'assistance_request_open')).toHaveLength(7);
      expect(await one(`SELECT count(*)::int AS n FROM assistance_request WHERE "productId" = $1`, [off.productId])).toEqual({ n: 1 });
    });

    it('D-10: the same key replays the original result; another command with it is 409; a key is required', async () => {
      const off = await offering();
      const idem = key();
      const first = await create({ organizationId: ORG, ...off, consent: true }, 'b1', idem);
      const replay = await create({ organizationId: ORG, ...off, consent: true }, 'b1', idem);
      expect(first.status).toBe(201);
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(replay.body).toEqual(first.body);
      const conflict = await create({ organizationId: ORG2, ...off, consent: true }, 'b1', idem);
      expect([conflict.status, conflict.body.code]).toEqual([409, 'idempotency_key_conflict']);
      // the key is bound to the actor: another beneficiary's identical key is their own
      expect((await create({ organizationId: ORG, ...off, consent: true }, 'b2', idem)).status).toBe(201);
      const missing = await create({ organizationId: ORG, ...off, consent: true }, 'b1', null);
      expect([missing.status, missing.body.code]).toEqual([400, 'idempotency_key_required']);
      expect(await one(`SELECT count(*)::int AS n FROM assistance_request WHERE "productId" = $1`, [off.productId])).toEqual({ n: 2 });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the read (D-10)

  describe('the read (D-10)', () => {
    it('the beneficiary and the Organization actor read it; every other caller is the collapsed 404', async () => {
      const p = await pendingRequest('b1');
      expect((await read(p.id, 'b1')).body).toEqual(p.body);
      expect((await read(p.id, 'a1')).body).toEqual(p.body);
      for (const bearer of ['b2', 'm1', 'a2', 'owner', 'operator', 'pending', 'inactive']) {
        const r = await read(p.id, bearer);
        expect([r.status, r.body.code], bearer).toEqual([404, 'not_found']);
      }
      expect((await read(randomUUID(), 'a1')).status).toBe(404);
      expect((await read('not-a-uuid', 'a1')).status).toBe(404);
      expect((await read(p.id, null)).status).toBe(401);
      expect((await read(p.id, service.token)).status).toBe(401);
    });

    it('authority is live: a revoked administrator flag, a revoked membership or a deactivated beneficiary loses the read at once', async () => {
      const p = await pendingRequest('b1');
      identities.get('a1')!.memberships[0].isOrganizationAdmin = false;
      expect((await read(p.id, 'a1')).status).toBe(404);
      resetIdentities();
      identities.get('a1')!.memberships[0].status = 'revoked';
      expect((await read(p.id, 'a1')).status).toBe(404);
      identities.get('b1')!.isActive = false;
      expect((await read(p.id, 'b1')).status).toBe(404);
    });

    it('an Auth or Organization reference outage is 503, never a guess', async () => {
      const p = await pendingRequest('b1');
      expect((await read(p.id, 'auth-down')).status).toBe(503);
      // a request of an Organization the reference cannot answer for (written directly: creation itself fails closed there)
      const off = await offering();
      const { id } = await one(`INSERT INTO assistance_request ("beneficiaryUserId", "organizationId", "platformId", "productId", "priceId", currency, "baseAmount", "feeAmount", "totalAmount", "feeCapVersion", consent)
        VALUES ($1, $2, $3, $4, $5, 'TND', 9000, 0, 9000, (SELECT version FROM billing_current_fee_cap($3)), true) RETURNING id`, [U.b2, ORG_DOWN, PLATFORM, off.productId, off.priceId]);
      identities.set('a-down', { id: randomUUID(), adminTier: null, isActive: true, memberships: [membership(ORG_DOWN, { admin: true })] });
      for (const call of [read(id, 'a-down'), decline(id, 'a-down'), report(id, ago(1000), 'a-down')]) expect((await call).status).toBe(503);
      expect((await one(`SELECT status FROM assistance_request WHERE id = $1`, [id])).status).toBe('pending');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── BIL-14: decline (D-4)

  describe('decline (BIL-14; D-4)', () => {
    it('the beneficiary declines a pending request: final, with the actual actor and the database time recorded', async () => {
      const p = await pendingRequest('b1');
      const r = await decline(p.id, 'b1');
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'declined', declinedByRole: 'beneficiary', cashCollectedAt: null });
      const row = await one(`SELECT "declinedBy", "declinedAt" FROM assistance_request WHERE id = $1`, [p.id]);
      expect(row.declinedBy).toBe(U.b1);
      expect(r.body.declinedAt).toBe(row.declinedAt.toISOString());
      expect((await audit(p.id)).map((e) => e.name)).toEqual(['audit.assistance_request.created', 'audit.assistance_request.declined']);
      expect((await audit(p.id))[1].payload).toMatchObject({ actor: { type: 'user', id: U.b1, userKind: 'member' }, organizationId: ORG, changes: { declined_by: 'beneficiary' } });
      const again = await decline(p.id, 'a1');
      expect([again.status, again.body.code]).toEqual([409, 'assistance_request_not_pending']);
      const cash = await report(p.id, ago(1000));
      expect([cash.status, cash.body.code]).toEqual([409, 'assistance_request_not_pending']);
    });

    it('an Organization actor declines too (recorded as organization_actor); an administrator who is the beneficiary declines as the beneficiary', async () => {
      const p = await pendingRequest('b2');
      const r = await decline(p.id, 'a1');
      expect(r.body).toMatchObject({ status: 'declined', declinedByRole: 'organization_actor' });
      expect((await one(`SELECT "declinedBy" FROM assistance_request WHERE id = $1`, [p.id])).declinedBy).toBe(U.a1);
      expect((await audit(p.id))[1].payload).toMatchObject({ actor: { id: U.a1, userKind: 'member' }, changes: { declined_by: 'organization_actor' } });
      const own = await pendingRequest('admin-beneficiary');
      expect((await decline(own.id, 'admin-beneficiary')).body.declinedByRole).toBe('beneficiary');
    });

    it('no relation is the collapsed 404 (another member, another Organization\'s administrator, an Owner, a revoked administrator); nothing changes', async () => {
      const p = await pendingRequest('b1');
      for (const bearer of ['b2', 'm1', 'a2', 'owner', 'operator', 'inactive']) expect((await decline(p.id, bearer)).status, bearer).toBe(404);
      identities.get('a1')!.memberships[0].isOrganizationAdmin = false;
      expect((await decline(p.id, 'a1')).status).toBe(404);
      expect((await one(`SELECT status FROM assistance_request WHERE id = $1`, [p.id])).status).toBe('pending');
    });

    it('replays its key; refuses a body; requires a key; is unavailable once cash is reported', async () => {
      const p = await pendingRequest('b1');
      const idem = key();
      const first = await decline(p.id, 'b1', idem);
      const replay = await decline(p.id, 'b1', idem);
      expect([replay.status, replay.headers['idempotent-replayed']]).toEqual([200, 'true']);
      expect(replay.body).toEqual(first.body);
      expect((await decline(p.id, 'b1', key(), { reason: 'x' })).status).toBe(400);
      expect((await decline(p.id, 'b1', null)).body.code).toBe('idempotency_key_required');
      const q = await pendingRequest('b1');
      expect((await report(q.id, ago(1000))).status).toBe(200);
      for (const bearer of ['b1', 'a1']) {
        const r = await decline(q.id, bearer);
        expect([r.status, r.body.code], bearer).toEqual([409, 'assistance_request_not_pending']);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── BIL-15: cash collection (D-5, D-6, D-11)

  describe('cash collection (BIL-15; D-5, D-6, D-11)', () => {
    it('the Organization actor reports it: asserted time, database report time, settleBy exactly 72 hours later; evidence only', async () => {
      const p = await pendingRequest('b1');
      await backdateConsent(p.id, 3 * HOUR);
      const collected = new Date(Date.now() - 2 * HOUR);
      collected.setUTCMilliseconds(0);
      const before = { invoices: await count('invoice'), requests: await count('payment_request'), purchases: await count('subscription_purchase'), subscriptions: await count('subscription'), events: Number((await one(`SELECT count(*) AS n FROM outbox WHERE name NOT LIKE 'audit.%'`)).n) };
      const r = await report(p.id, collected.toISOString().replace('Z', '+00:00'));
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: 'cash_collected', cashCollectedAt: collected.toISOString(), settleBy: new Date(collected.getTime() + 72 * HOUR).toISOString(), overdue: false, totalAmount: p.body.totalAmount });
      const row = await one(`SELECT "reportedAt", "reportedBy", "settleBy" - "cashCollectedAt" AS window FROM assistance_request WHERE id = $1`, [p.id]);
      expect(row.reportedBy).toBe(U.a1);
      expect(r.body.reportedAt).toBe(row.reportedAt.toISOString());
      expect(row.window).toMatchObject({ days: 3 });
      expect(Date.parse(r.body.reportedAt)).toBeGreaterThan(collected.getTime());
      const events = await audit(p.id);
      expect(events.map((e) => e.name)).toEqual(['audit.assistance_request.created', 'audit.assistance_request.cash_collection_reported']);
      expect(events[1].payload).toMatchObject({ actor: { type: 'user', id: U.a1, userKind: 'member' }, organizationId: ORG, changes: { cash_collected_at: r.body.cashCollectedAt, settle_by: r.body.settleBy } });
      // D-11: a cash declaration never invoices, pays, settles, activates or emits anything
      expect({ invoices: await count('invoice'), requests: await count('payment_request'), purchases: await count('subscription_purchase'), subscriptions: await count('subscription'), events: Number((await one(`SELECT count(*) AS n FROM outbox WHERE name NOT LIKE 'audit.%'`)).n) }).toEqual(before);
      expect((await read(p.id, 'b1')).body).toMatchObject({ status: 'cash_collected', overdue: false });
    });

    it('a late report is overdue from its first instant (derived from the database clock), and stays overdue while unresolved', async () => {
      const p = await pendingRequest('b2');
      await backdateConsent(p.id, 100 * HOUR);
      const r = await report(p.id, ago(73 * HOUR));
      expect(r.status).toBe(200);
      expect(r.body.overdue).toBe(true);
      expect((await read(p.id, 'b2')).body.overdue).toBe(true);
      expect((await read(p.id, 'a1')).body.overdue).toBe(true);
      // overdue is never stored: it is the function of the status and settleBy at the database's current time
      expect(await one(`SELECT billing_assistance_overdue(status, "settleBy") AS o, "settleBy" < now() AS past FROM assistance_request WHERE id = $1`, [p.id])).toEqual({ o: true, past: true });
    });

    it('time order (FC-8): before the consent or in the future is 422 cash_collection_time_invalid; malformed is 400; nothing changes', async () => {
      const p = await pendingRequest('b1', { consentedAgo: 0 }); // consented just now: ten minutes ago is before the consent
      for (const at of [ago(10 * 60_000), new Date(Date.now() + 10 * 60_000).toISOString()]) {
        const r = await report(p.id, at);
        expect([r.status, r.body.code], at).toEqual([422, 'cash_collection_time_invalid']);
      }
      for (const at of ['2026-02-31T10:00:00Z', '2026-01-01T10:00:00', '2026-01-01 10:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T10:00:00.1234Z', 'yesterday', 1767261600000, null]) {
        const r = await report(p.id, at);
        expect([r.status, r.body.code], String(at)).toEqual([400, 'invalid_assistance_request']);
      }
      const amount = await report(p.id, ago(1000), 'a1', key(), { amount: 9000 }); // D-11: no caller-supplied collected amount
      expect([amount.status, amount.body.code]).toEqual([400, 'invalid_assistance_request']);
      expect((await one(`SELECT status FROM assistance_request WHERE id = $1`, [p.id])).status).toBe('pending');
      // the database enforces the order and the deadline whatever path writes it
      await expect(admin.query(`UPDATE assistance_request SET status = 'cash_collected', "cashCollectedAt" = now() + interval '1 hour', "reportedBy" = $2 WHERE id = $1`, [p.id, U.a1])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE assistance_request SET status = 'cash_collected', "cashCollectedAt" = "consentAt" - interval '1 second', "reportedBy" = $2 WHERE id = $1`, [p.id, U.a1])).rejects.toMatchObject({ code: '23514' });
    });

    it('D-5: never the beneficiary of the same request (403), administrator or not; no relation is 404; a revoked administrator loses it at once', async () => {
      const own = await pendingRequest('admin-beneficiary');
      const self = await report(own.id, ago(1000), 'admin-beneficiary');
      expect([self.status, self.body.code]).toEqual([403, 'operation_not_permitted']);
      const p = await pendingRequest('b1');
      expect((await report(p.id, ago(1000), 'b1')).status).toBe(403);
      for (const bearer of ['b2', 'm1', 'a2', 'owner', 'operator', 'inactive', 'pending']) expect((await report(p.id, ago(1000), bearer)).status, bearer).toBe(404);
      identities.get('a1')!.memberships[0].isOrganizationAdmin = false;
      expect((await report(p.id, ago(1000), 'a1')).status).toBe(404);
      resetIdentities();
      expect((await report(p.id, ago(1000), 'auth-down')).status).toBe(503);
      expect((await report(p.id, ago(1000), service.token)).status).toBe(401);
      expect((await one(`SELECT status FROM assistance_request WHERE id = $1`, [p.id])).status).toBe('pending');
      // the database refuses the beneficiary as reporter too
      await expect(admin.query(`UPDATE assistance_request SET status = 'cash_collected', "cashCollectedAt" = now(), "reportedBy" = "beneficiaryUserId" WHERE id = $1`, [p.id])).rejects.toMatchObject({ code: '23514' });
    });

    it('once only (409 cash_collection_already_reported); its key replays the original result', async () => {
      const p = await pendingRequest('b1');
      const idem = key();
      const at = ago(5000);
      const first = await report(p.id, at, 'a1', idem);
      const replay = await report(p.id, at, 'a1', idem);
      expect([replay.status, replay.headers['idempotent-replayed']]).toEqual([200, 'true']);
      expect(replay.body).toEqual(first.body);
      const conflict = await report(p.id, ago(4000), 'a1', idem);
      expect([conflict.status, conflict.body.code]).toEqual([409, 'idempotency_key_conflict']);
      const again = await report(p.id, ago(3000), 'a1');
      expect([again.status, again.body.code]).toEqual([409, 'cash_collection_already_reported']);
      // the settled terms of S5a are final for this stage: the database refuses any further transition
      await expect(admin.query(`UPDATE assistance_request SET status = 'declined', "declinedBy" = $2, "declinedByRole" = 'organization_actor', "cashCollectedAt" = NULL, "reportedAt" = NULL, "reportedBy" = NULL, "settleBy" = NULL WHERE id = $1`, [p.id, U.a1]))
        .rejects.toMatchObject({ code: '23514' });
    });

    it('a decline racing a cash report: exactly one wins', async () => {
      for (let i = 0; i < 4; i++) {
        const p = await pendingRequest('b2');
        const [d, c] = await Promise.all([decline(p.id, 'b2'), report(p.id, ago(1000), 'a1')]);
        expect([d.status, c.status].filter((s) => s === 200)).toHaveLength(1);
        expect([d.status, c.status].filter((s) => s === 409)).toHaveLength(1);
        const row = await one(`SELECT status FROM assistance_request WHERE id = $1`, [p.id]);
        expect(row.status).toBe(d.status === 200 ? 'declined' : 'cash_collected');
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── production (D-8, D-12)

  describe('production refusal (D-8, D-12)', () => {
    it('production mounts no assistance route, and the service refuses even if reached', async () => {
      const prod = { isProduction: true } as BillingConfig;
      expect(AssistanceModule.register(prod)).toEqual({ module: AssistanceModule });
      const svc = new AssistanceService(null as never, null as never, null as never, null as never, prod);
      const who = identities.get('b1')!;
      await expect(svc.create(who, 'k-12345678', { organizationId: ORG, productId: ORG, priceId: ORG }, null as never)).rejects.toMatchObject({ status: 404 });
      await expect(svc.read(who, ORG)).rejects.toMatchObject({ status: 404 });
      await expect(svc.decline(who, 'k-12345678', ORG, null as never)).rejects.toMatchObject({ status: 404 });
      await expect(svc.reportCashCollection(who, 'k-12345678', ORG, { cashCollectedAt: ago(0) }, null as never)).rejects.toMatchObject({ status: 404 });
      expect(AssistanceModule.register({ isProduction: false } as BillingConfig).controllers).toHaveLength(5); // + S5b's cash-return controller, + S5c's dispute and Owner controllers, + S5d's restriction read
    });
  });
});

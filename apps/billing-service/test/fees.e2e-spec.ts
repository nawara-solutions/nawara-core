import { randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { generateServiceToken, kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { billingMigrationsDir } from '../src/app.module.js';
import { FeeRepository } from '../src/fees/fee.repository.js';
import { HttpOwnerAuthority } from '../src/platforms/owner-authority.client.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { FakeAuth } from './support/fake-auth.js';

type Row = Record<string, any>;

const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();
const OWNER = randomUUID();
const OTHER_OWNER = randomUUID();
const OP = randomUUID();
const OP2 = randomUUID();
const FOREIGN_OP = randomUUID(); // an operator of ANOTHER Company
const AUTH_TIMEOUT_MS = 800;

/**
 * Core V2 S3f (register BIL-04 to BIL-07; the Owner's decisions A1 to A5): Organization fee caps, delegations and proposals through the REAL
 * application on real PostgreSQL 16, with the REAL hardened Auth client against a stub of exactly Auth's approved routes.
 */
describeWithEnv('fee caps, delegations and proposals (Core V2 S3f) — real PostgreSQL, live Auth', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let admin: pg.Pool;
  const auth = new FakeAuth();
  const producer = generateServiceToken();
  const server = () => t.app.getHttpServer();
  const B = { owner: 'owner-1', otherOwner: 'owner-2', op: 'op-1', op2: 'op-2', foreignOp: 'op-foreign', member: 'member-1' };

  // ── fixtures
  const platform = async (o: { company?: string; currency?: string; configured?: boolean } = {}) => {
    const id = randomUUID();
    auth.platforms.set(id, o.company ?? COMPANY);
    if (o.configured !== false) {
      await admin.query(`INSERT INTO billing_platform ("platformId", "companyId", currency, "createdBy") VALUES ($1, $2, $3, $4)`, [id, o.company ?? COMPANY, o.currency ?? 'TND', o.company === OTHER_COMPANY ? OTHER_OWNER : OWNER]);
    }
    return id;
  };
  const assign = (operator: string, platformId: string) => {
    const s = auth.assignments.get(operator) ?? new Set<string>();
    s.add(platformId);
    auth.assignments.set(operator, s);
  };
  const organization = (platformId: string) => {
    const id = randomUUID();
    auth.organizations.set(id, platformId);
    return id;
  };
  // S3g (D-CAT-8): a fee is proposed on the Owner's product (provenance `billing-owner`, sold by the Platform's Company reference); a
  // shape the Owner cannot create (another target, an unconfigured Platform) or an explicit `producer` is a producer's
  const product = async (platformId: string, o: { target?: string; status?: string; producer?: string } = {}) => {
    const company = (await admin.query(`SELECT "companyId" FROM billing_platform WHERE "platformId" = $1`, [platformId])).rows[0]?.companyId as string | undefined;
    const owner = o.producer === undefined && company !== undefined && (o.target ?? 'personal') === 'personal';
    return (await admin.query(`INSERT INTO product (producer, "sellerType", "sellerId", code, name, status, "subscriptionTarget", "platformId") VALUES ($1, 'company', $2, $3, 'Plan', $4, $5, $6) RETURNING id`,
      [owner ? 'billing-owner' : (o.producer ?? 'test-producer'), owner ? company : 'nawara', `p-${randomUUID().slice(0, 12)}`, o.status ?? 'active', o.target ?? 'personal', platformId])).rows[0].id as string;
  };

  // ── HTTP
  let k = 0;
  const key = () => `key-${++k}-${randomUUID().slice(0, 8)}`;
  const call = (method: 'put' | 'post', path: string, bearer: string | null, body?: unknown, idem: string | null = key()) => {
    let r = request(server())[method](path);
    if (bearer) r = r.set('authorization', `Bearer ${bearer}`);
    if (idem) r = r.set('idempotency-key', idem);
    return r.send(body as object);
  };
  const setCap = (p: string, amount: unknown, bearer = B.owner, idem?: string | null) => call('put', `/billing/admin/platforms/${p}/fee-caps`, bearer, { amount }, idem);
  const delegate = (p: string, operatorUserId: string, bearer = B.owner, idem?: string | null) => call('post', `/billing/admin/platforms/${p}/fee-delegations`, bearer, { operatorUserId }, idem);
  const revoke = (p: string, id: string, bearer = B.owner) => call('post', `/billing/admin/platforms/${p}/fee-delegations/${id}/revoke`, bearer);
  const propose = (p: string, body: Row, bearer = B.op, idem?: string | null) => call('post', `/billing/platforms/${p}/fee-proposals`, bearer, body, idem);
  const withdraw = (p: string, id: string, bearer = B.op) => call('post', `/billing/platforms/${p}/fee-proposals/${id}/withdraw`, bearer);
  const approve = (id: string, bearer = B.owner, idem?: string | null) => call('post', `/billing/admin/fee-proposals/${id}/approve`, bearer, undefined, idem);
  const reject = (id: string, bearer = B.owner) => call('post', `/billing/admin/fee-proposals/${id}/reject`, bearer);
  const caps = async (p: string) => (await admin.query(`SELECT version, amount::int FROM fee_cap WHERE "platformId" = $1 ORDER BY version`, [p])).rows;
  const financial = async () => (await admin.query(`SELECT (SELECT count(*)::int FROM invoice) i, (SELECT count(*)::int FROM payment_request) r, (SELECT count(*)::int FROM subscription_settlement) s, (SELECT count(*)::int FROM subscription_purchase) p`)).rows[0];

  /** A ready Platform: configured, a cap, OP assigned and delegated, one Organization and one personal product. */
  async function ready(cap: number | null = 5000) {
    const p = await platform();
    assign(OP, p);
    if (cap !== null) expect((await setCap(p, cap)).status).toBe(201);
    const d = await delegate(p, OP);
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    return { p, delegationId: d.body.id as string, org: organization(p), prod: await product(p) };
  }

  beforeAll(async () => {
    await auth.start();
    auth.identities.set(B.owner, { userId: OWNER, kind: 'owner', companyId: COMPANY });
    auth.identities.set(B.otherOwner, { userId: OTHER_OWNER, kind: 'owner', companyId: OTHER_COMPANY });
    auth.identities.set(B.op, { userId: OP, kind: 'operator', companyId: null });
    auth.identities.set(B.op2, { userId: OP2, kind: 'operator', companyId: null });
    auth.identities.set(B.foreignOp, { userId: FOREIGN_OP, kind: 'operator', companyId: null });
    auth.identities.set(B.member, { userId: randomUUID(), kind: 'member', companyId: null });
    auth.operatorCompany.set(OP, COMPANY);
    auth.operatorCompany.set(OP2, COMPANY);
    auth.operatorCompany.set(FOREIGN_OP, OTHER_COMPANY);
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'billings3f');
    await runMigrations(db.url, [kitMigrationsDir, billingMigrationsDir]);
    admin = new pg.Pool({ connectionString: db.url, max: 10 });
    t = await createTestApp({ databaseUrl: db.url, tokens: [{ caller: 'test-producer', digest: producer.digest }], ownerAuthority: new HttpOwnerAuthority({ baseUrl: auth.url }), env: { AUTH_TIMEOUT_MS: String(AUTH_TIMEOUT_MS) } });
  });
  afterEach(() => auth.reset());
  afterAll(async () => {
    await t?.app.close();
    await admin?.end();
    await db?.drop();
    await auth.stop();
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── caps (BIL-04; A1, A2)

  describe('fee caps', () => {
    it('versioned and immutable: a new amount is a new version (201); the current amount again writes nothing (200)', async () => {
      const p = await platform();
      const first = await setCap(p, 5000);
      expect([first.status, first.body]).toMatchObject([201, { platformId: p, version: 1, amount: 5000, currency: 'TND' }]);
      expect((await setCap(p, 5000)).status).toBe(200);
      expect((await setCap(p, 3000)).body).toMatchObject({ version: 2, amount: 3000 });
      expect((await setCap(p, 0)).body).toMatchObject({ version: 3, amount: 0 });
      expect(await caps(p)).toEqual([{ version: 1, amount: 5000 }, { version: 2, amount: 3000 }, { version: 3, amount: 0 }]);
      await expect(admin.query(`UPDATE fee_cap SET amount = 1 WHERE "platformId" = $1`, [p])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`DELETE FROM fee_cap WHERE "platformId" = $1`, [p])).rejects.toMatchObject({ code: '23514' });
    });

    it.each([[-1], [1.5], ['100'], [9007199254740992], [null]])('amount %s is refused (400 invalid_fee_request), nothing written', async (amount) => {
      const p = await platform();
      expect([(await setCap(p, amount)).status, (await setCap(p, amount)).body.code]).toEqual([400, 'invalid_fee_request']);
      expect(await caps(p)).toEqual([]);
    });

    it('the body is exactly {amount}: a currency, percentage or version is refused; the currency is always the Platform\'s (S3d)', async () => {
      const p = await platform({ currency: 'TND' });
      for (const extra of [{ currency: 'EUR' }, { percentage: 10 }, { version: 7 }]) expect((await call('put', `/billing/admin/platforms/${p}/fee-caps`, B.owner, { amount: 1, ...extra })).body.code).toBe('invalid_fee_request');
      expect((await setCap(p, 1)).body.currency).toBe('TND');
    });

    it('authority: an operator or member is 403; another Company\'s Owner and an unknown Platform are the same 404; a service-less bearer 401', async () => {
      const p = await platform();
      expect([(await setCap(p, 1, B.op)).status, (await setCap(p, 1, B.member)).status]).toEqual([403, 403]);
      expect((await setCap(p, 1, B.otherOwner)).status).toBe(404);
      expect((await setCap(randomUUID(), 1)).status).toBe(404);
      expect((await call('put', `/billing/admin/platforms/${p}/fee-caps`, null, { amount: 1 })).status).toBe(401);
      expect(await caps(p)).toEqual([]);
    });

    it('an unconfigured Platform of the Owner is 409 platform_not_configured', async () => {
      const p = await platform({ configured: false });
      expect((await setCap(p, 1)).body.code).toBe('platform_not_configured');
    });

    it('Idempotency-Key: required; the same key and body replays (no new version); the same key with another body is 409', async () => {
      const p = await platform();
      expect((await setCap(p, 10, B.owner, null)).body.code).toBe('idempotency_key_required');
      expect((await setCap(p, 10, B.owner, 'short')).body.code).toBe('idempotency_key_required');
      const idem = key();
      const first = await setCap(p, 10, B.owner, idem);
      await setCap(p, 20); // the cap moves on in between
      const replay = await setCap(p, 10, B.owner, idem);
      expect([replay.status, replay.headers['idempotent-replayed'], replay.body]).toEqual([201, 'true', first.body]);
      expect((await setCap(p, 11, B.owner, idem)).body.code).toBe('idempotency_key_conflict');
      expect(await caps(p)).toEqual([{ version: 1, amount: 10 }, { version: 2, amount: 20 }]);
    });

    it('concurrency: 8 different amounts at once get 8 distinct, gapless versions; 8 uses of ONE key make one version', async () => {
      const p = await platform();
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => setCap(p, 100 + i)));
      expect(rs.every((r) => r.status === 201)).toBe(true);
      expect((await caps(p)).map((c) => c.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      const q = await platform();
      const idem = key();
      const same = await Promise.all(Array.from({ length: 8 }, () => setCap(q, 42, B.owner, idem)));
      expect(same.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(7);
      expect(await caps(q)).toEqual([{ version: 1, amount: 42 }]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── delegations (BIL-05; A3)

  describe('fee delegations', () => {
    it('the Owner delegates one assigned operator of their Company; a repeat answers the active delegation; revocation is final', async () => {
      const p = await platform();
      assign(OP, p);
      const d = await delegate(p, OP);
      expect([d.status, d.body]).toMatchObject([201, { platformId: p, operatorUserId: OP, revokedAt: null }]);
      expect((await delegate(p, OP)).body.id).toBe(d.body.id);
      expect(auth.received.some((r) => r.path === `/auth/admin/operators/${OP}/platform-assignments` && r.authorization === `Bearer ${B.owner}`)).toBe(true);
      const r = await revoke(p, d.body.id);
      expect(r.body.revokedAt).not.toBeNull();
      expect((await revoke(p, d.body.id)).body.revokedAt).toBe(r.body.revokedAt);
      const again = await delegate(p, OP); // a NEW delegation after a revocation
      expect([again.status, again.body.id === d.body.id]).toEqual([201, false]);
    });

    it('an operator not assigned to the Platform, another Company\'s operator, or an unknown user: the same 404, nothing written', async () => {
      const p = await platform();
      assign(FOREIGN_OP, p); // even if Auth somehow listed the Platform for them, they are not of this Company
      for (const o of [OP2, FOREIGN_OP, randomUUID()]) expect((await delegate(p, o)).status).toBe(404);
      expect((await admin.query(`SELECT count(*)::int n FROM fee_delegation WHERE "platformId" = $1`, [p])).rows[0].n).toBe(0);
    });

    it('cross-Platform and cross-Company: a delegation of one Platform never authorizes another; another Owner cannot revoke it', async () => {
      const { p, delegationId, prod } = await ready();
      const q = await platform();
      assign(OP, q);
      expect((await propose(q, { organizationId: organization(q), productId: await product(q), amount: 0 })).body.code).toBe('operation_not_permitted');
      expect((await revoke(p, delegationId, B.otherOwner)).status).toBe(404);
      expect((await revoke(q, delegationId)).status).toBe(404); // the delegation is not q's
      expect(prod).toBeTruthy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── proposals (BIL-06, BIL-07; A4)

  describe('fee proposals', () => {
    it('a delegated operator proposes within the cap (the cap itself included); above it is 422 fee_above_cap', async () => {
      const { p, org, prod } = await ready(5000);
      const r = await propose(p, { organizationId: org, productId: prod, amount: 5000 });
      expect([r.status, r.body]).toMatchObject([201, { platformId: p, organizationId: org, productId: prod, amount: 5000, currency: 'TND', status: 'pending', proposedBy: OP, capVersion: null, decidedAt: null }]);
      const o2 = organization(p);
      expect((await propose(p, { organizationId: o2, productId: prod, amount: 5001 })).body.code).toBe('fee_above_cap');
    });

    it('with no cap the permitted fee is 0: 0 is accepted, 1 is refused', async () => {
      const { p, org, prod } = await ready(null);
      expect((await propose(p, { organizationId: org, productId: prod, amount: 1 })).body.code).toBe('fee_above_cap');
      expect((await propose(p, { organizationId: org, productId: prod, amount: 0 })).status).toBe(201);
    });

    it('authority: undelegated or revoked operator 403; an Owner cannot propose; a Platform the operator may not act on is 404', async () => {
      const { p, delegationId, org, prod } = await ready();
      assign(OP2, p);
      expect((await propose(p, { organizationId: org, productId: prod, amount: 1 }, B.op2)).body.code).toBe('operation_not_permitted');
      expect((await propose(p, { organizationId: org, productId: prod, amount: 1 }, B.owner)).status).toBe(403);
      const unassigned = await platform();
      expect((await propose(unassigned, { organizationId: organization(unassigned), productId: await product(unassigned), amount: 0 })).status).toBe(404);
      await revoke(p, delegationId);
      expect((await propose(p, { organizationId: org, productId: prod, amount: 1 })).body.code).toBe('operation_not_permitted');
    });

    it('the Organization must be on this Platform for this operator (Auth, live): another Platform\'s or an unknown one is 403 organization_not_permitted', async () => {
      const { p, prod } = await ready();
      const elsewhere = await platform();
      assign(OP, elsewhere); // visible to OP, but on another Platform
      for (const organizationId of [organization(elsewhere), randomUUID()]) {
        expect((await propose(p, { organizationId, productId: prod, amount: 1 })).body.code).toBe('organization_not_permitted');
      }
    });

    it('the product must be an ACTIVE personal subscription product of this Platform, created by the Owner (S3g): otherwise 409 product_not_available', async () => {
      const { p, org } = await ready();
      const other = await platform();
      const producers = await product(p, { producer: 'test-producer' }); // S3g (D-CAT-8): a producer's personal product of this very Platform
      for (const productId of [await product(p, { target: 'organization' }), await product(p, { status: 'archived' }), await product(other), producers, randomUUID()]) {
        expect((await propose(p, { organizationId: org, productId, amount: 1 })).body.code).toBe('product_not_available');
      }
    });

    it('at most one pending proposal per Organization and product; 8 concurrent proposals (different keys) create exactly one', async () => {
      const { p, org, prod } = await ready();
      const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => propose(p, { organizationId: org, productId: prod, amount: 100 + i })));
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.filter((r) => r.body.code === 'fee_proposal_pending_exists')).toHaveLength(7);
    });

    it('withdraw: only the proposer, while delegated and pending; then a new proposal may follow', async () => {
      const { p, org, prod } = await ready();
      assign(OP2, p);
      await delegate(p, OP2);
      const r = await propose(p, { organizationId: org, productId: prod, amount: 10 });
      expect((await withdraw(p, r.body.id, B.op2)).status).toBe(404); // another operator's
      const w = await withdraw(p, r.body.id);
      expect(w.body).toMatchObject({ status: 'withdrawn' });
      expect((await withdraw(p, r.body.id)).body.code).toBe('fee_proposal_not_pending');
      expect((await approve(r.body.id)).body.code).toBe('fee_proposal_not_pending');
      expect((await propose(p, { organizationId: org, productId: prod, amount: 11 })).status).toBe(201);
    });

    it('only the Owner of its Platform decides: an operator 403; another Company\'s Owner and an unknown proposal are 404', async () => {
      const { p, org, prod } = await ready();
      const r = await propose(p, { organizationId: org, productId: prod, amount: 10 });
      expect((await approve(r.body.id, B.op)).status).toBe(403);
      expect((await approve(r.body.id, B.otherOwner)).status).toBe(404);
      expect((await approve(randomUUID())).status).toBe(404);
      expect((await admin.query(`SELECT status FROM fee_proposal WHERE id = $1`, [r.body.id])).rows[0].status).toBe('pending');
    });

    it('approve records the cap version it satisfied; the decision is once; the same key replays, a new key is 409', async () => {
      const { p, org, prod } = await ready(5000);
      const r = await propose(p, { organizationId: org, productId: prod, amount: 4000 });
      const idem = key();
      const a = await approve(r.body.id, B.owner, idem);
      expect(a.body).toMatchObject({ status: 'approved', capVersion: 1, amount: 4000 });
      expect((await approve(r.body.id, B.owner, idem)).headers['idempotent-replayed']).toBe('true');
      expect((await approve(r.body.id)).body.code).toBe('fee_proposal_not_pending');
      expect((await reject(r.body.id)).body.code).toBe('fee_proposal_not_pending');
      await expect(admin.query(`UPDATE fee_proposal SET amount = 1 WHERE id = $1`, [r.body.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE fee_proposal SET status = 'pending', "decidedBy" = NULL, "decidedAt" = NULL, "capVersion" = NULL WHERE id = $1`, [r.body.id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`DELETE FROM fee_proposal WHERE id = $1`, [r.body.id])).rejects.toMatchObject({ code: '23514' });
    });

    it('A2: the cap is re-checked at approval — a pending fee above a since-lowered cap is 422 and stays pending', async () => {
      const { p, org, prod } = await ready(5000);
      const r = await propose(p, { organizationId: org, productId: prod, amount: 4000 });
      await setCap(p, 3000);
      expect((await approve(r.body.id)).body.code).toBe('fee_above_cap');
      expect((await admin.query(`SELECT status FROM fee_proposal WHERE id = $1`, [r.body.id])).rows[0].status).toBe('pending');
      expect((await reject(r.body.id)).body).toMatchObject({ status: 'rejected' });
    });

    it('concurrent approve and reject of one proposal: exactly one decision', async () => {
      const { p, org, prod } = await ready();
      const r = await propose(p, { organizationId: org, productId: prod, amount: 1 });
      const rs = await Promise.all([approve(r.body.id), reject(r.body.id), approve(r.body.id), reject(r.body.id)]);
      expect(rs.filter((x) => x.status === 200)).toHaveLength(1);
      expect(rs.filter((x) => x.body.code === 'fee_proposal_not_pending')).toHaveLength(3);
    });

    it('a later approval supersedes prospectively; history stays; at the point of use the CURRENT cap decides (A2)', async () => {
      const { p, org, prod } = await ready(5000);
      const fees = t.app.get(FeeRepository);
      expect(await fees.feeForUse(org, prod)).toBeNull(); // no approved fee: none (0)
      const first = await propose(p, { organizationId: org, productId: prod, amount: 1000 });
      await approve(first.body.id);
      const second = await propose(p, { organizationId: org, productId: prod, amount: 2000 });
      await approve(second.body.id);
      expect(await fees.feeForUse(org, prod)).toEqual({ proposalId: second.body.id, amount: 2000, currency: 'TND', usable: true });
      expect((await admin.query(`SELECT amount::int, status FROM fee_proposal WHERE id = $1`, [first.body.id])).rows[0]).toEqual({ amount: 1000, status: 'approved' });
      await setCap(p, 1500);
      expect(await fees.feeForUse(org, prod)).toMatchObject({ proposalId: second.body.id, usable: false }); // never silently capped or rewritten
      expect(await fees.feeForUse(organization(p), prod)).toBeNull(); // another Organization: nothing inherited
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────────────────────── fail closed, isolation

  describe('fail closed and financial isolation', () => {
    it.each([
      ['grants', 'down'], ['grants', 'hang'], ['access', 'down'], ['organization', 'down'],
    ] as const)('Auth %s %s: 503, nothing written', async (target, mode) => {
      const { p, org, prod } = await ready();
      const before = (await admin.query(`SELECT count(*)::int n FROM fee_proposal`)).rows[0].n;
      auth.target = target;
      auth.mode = mode;
      const r = await propose(p, { organizationId: org, productId: prod, amount: 1 });
      expect(r.status).toBe(503);
      expect((await admin.query(`SELECT count(*)::int n FROM fee_proposal`)).rows[0].n).toBe(before);
    });

    it('a service token is never a fee actor: 401 on every fee route, never forwarded to Auth', async () => {
      const { p, org, prod } = await ready();
      auth.received.length = 0;
      expect((await setCap(p, 1, producer.token)).status).toBe(401);
      expect((await propose(p, { organizationId: org, productId: prod, amount: 1 }, producer.token)).status).toBe(401);
      expect((await approve(randomUUID(), producer.token)).status).toBe(401);
      expect(auth.received).toEqual([]);
    });

    it('the fee commands create no invoice, payment request, settlement or purchase', async () => {
      const before = await financial();
      const { p, org, prod } = await ready();
      const r = await propose(p, { organizationId: org, productId: prod, amount: 1 });
      await approve(r.body.id);
      expect(await financial()).toEqual(before);
    });

    it('the database refuses raw bypasses: above the cap, a revoked delegation, another proposer\'s delegation, a withdrawal by someone else', async () => {
      const { p, delegationId, org, prod } = await ready(100);
      const ins = (amount: number, d = delegationId, by = OP) => admin.query(
        `INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES ($1, $2, $3, $4, 'TND', $5, $6)`, [p, org, prod, amount, d, by]);
      await expect(ins(101)).rejects.toMatchObject({ constraint: 'fee_above_cap' });
      await expect(ins(1, delegationId, OP2)).rejects.toMatchObject({ constraint: 'fee_proposal_delegation_fk' });
      const id = (await admin.query(`INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES ($1, $2, $3, 1, 'TND', $4, $5) RETURNING id`, [p, org, prod, delegationId, OP])).rows[0].id;
      await expect(admin.query(`UPDATE fee_proposal SET status = 'withdrawn', "decidedBy" = $2 WHERE id = $1`, [id, OWNER])).rejects.toMatchObject({ constraint: 'fee_proposal_withdrawn_by_proposer' });
      await expect(admin.query(`UPDATE fee_proposal SET status = 'approved', "decidedBy" = $2 WHERE id = $1`, [id, OP])).rejects.toMatchObject({ constraint: 'fee_proposal_not_self_decided' });
      await admin.query(`INSERT INTO fee_delegation_revocation ("delegationId", "revokedBy") VALUES ($1, $2)`, [delegationId, OWNER]);
      await expect(admin.query(`INSERT INTO fee_proposal ("platformId", "organizationId", "productId", amount, currency, "delegationId", "proposedBy") VALUES ($1, $2, $3, 1, 'TND', $4, $5)`, [p, organization(p), prod, delegationId, OP]))
        .rejects.toMatchObject({ constraint: 'fee_proposal_delegation_active' });
    });
  });
});

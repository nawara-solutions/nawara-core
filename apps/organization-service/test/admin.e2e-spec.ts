import { randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import type { AuthGrantFacts, AuthGrantsClient } from '../src/admin/auth-grants-client.js';
import { organizationMigrationsDir } from '../src/app.module.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { client, sql } from './support/fixtures.js';

/** A fully controllable double for Auth's grant-facts/step-up-verify endpoints (ADR-0042 decision 6). */
class FakeAuthGrantsClient implements AuthGrantsClient {
  private readonly grants = new Map<string, AuthGrantFacts>();
  private readonly goodStepUps = new Set<string>();
  down = false;

  /** userId is Auth's real (uuid-shaped) identifier; tests never need to choose it, only reference the bearer. */
  asOwner(bearer: string, companyId: string) {
    this.grants.set(bearer, { userId: randomUUID(), kind: 'owner', companyId, platformAssignments: [], organizationAdminMemberships: [] });
  }
  asOperator(bearer: string, platformAssignments: string[]) {
    this.grants.set(bearer, { userId: randomUUID(), kind: 'operator', companyId: null, platformAssignments, organizationAdminMemberships: [] });
  }
  asMember(bearer: string, organizationAdminMemberships: string[] = []) {
    this.grants.set(bearer, { userId: randomUUID(), kind: 'member', companyId: null, platformAssignments: [], organizationAdminMemberships });
  }
  allowStepUp(bearer: string, purpose: string, token: string) {
    this.goodStepUps.add(`${bearer}|${purpose}|${token}`);
  }

  async grantsFor(bearer: string): Promise<AuthGrantFacts> {
    if (this.down) throw new Error('auth down'); // caller wraps network errors; here we simulate by throwing (test asserts 500/503 path separately if needed)
    const f = this.grants.get(bearer);
    if (!f) throw new UnauthorizedException();
    return f;
  }
  async verifyStepUp(bearer: string, purpose: string, token: string): Promise<boolean> {
    return this.goodStepUps.has(`${bearer}|${purpose}|${token}`);
  }
}

describeWithEnv('admin (human authorization, ADR-0042 decision 6 / Amendment 1) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  let auth: FakeAuthGrantsClient;

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgadmin');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    auth = new FakeAuthGrantsClient();
    t = await createTestApp({ databaseUrl: db.url, authGrantsClient: auth });
  });
  afterAll(async () => {
    await t?.app.close();
    await db.drop();
  });

  const bearer = (b: string) => ({ Authorization: `Bearer ${b}` });
  const seedCompany = async () => (await sql<{ id: string }>(db.url, `INSERT INTO company(name) VALUES ('Admin Co') RETURNING id`))[0]!.id;
  const seedPlatform = async (companyId: string) => (await sql<{ id: string }>(db.url, `INSERT INTO platform(id,"companyId",name) VALUES (gen_random_uuid(),$1,'P') RETURNING id`, [companyId]))[0]!.id;
  const seedOrg = async (platformId: string) => (await sql<{ id: string }>(db.url, `INSERT INTO organization(id,"platformId",name) VALUES (gen_random_uuid(),$1,'O') RETURNING id`, [platformId]))[0]!.id;
  const actorEvents = (targetId: string) => sql(db.url, `SELECT operation, outcome, reason, actor_kind FROM admin_actor_event WHERE target_id = $1 ORDER BY id`, [targetId]);

  it('rejects a request with no bearer at all', async () => {
    await t.http().post('/organization/admin/platforms').send({ companyId: 'x', name: 'x' }).expect(401);
  });

  it('rejects a bearer Auth does not recognize', async () => {
    await t.http().post('/organization/admin/platforms').set(bearer('unknown-token')).set('Idempotency-Key', 'k-unknown-1').send({ companyId: 'x', name: 'x' }).expect(401);
  });

  describe('create Platform', () => {
    it('owner of the target company + valid step-up succeeds', async () => {
      const co = await seedCompany();
      auth.asOwner('b-owner-1', co);
      auth.allowStepUp('b-owner-1', 'platform.create', 'su-1');
      const r = await t.http().post('/organization/admin/platforms').set(bearer('b-owner-1')).set('Idempotency-Key', 'k-plat-001').set('x-step-up-token', 'su-1').send({ companyId: co, name: 'New Platform' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.companyId).toBe(co);
      const events = await actorEvents(r.body.id);
      expect(events).toEqual([{ operation: 'platform.create', outcome: 'succeeded', reason: null, actor_kind: 'owner' }]);
    });

    it('owner WITHOUT a step-up is denied (403 step_up_required), and the denial is recorded', async () => {
      const co = await seedCompany();
      auth.asOwner('b-owner-2', co);
      const r = await t.http().post('/organization/admin/platforms').set(bearer('b-owner-2')).set('Idempotency-Key', 'k-plat-002').send({ companyId: co, name: 'X' });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('step_up_required');
    });

    it('owner of a DIFFERENT company is denied before step-up is even checked (403 admin_forbidden)', async () => {
      const co1 = await seedCompany();
      const co2 = await seedCompany();
      auth.asOwner('b-owner-3', co1);
      const r = await t.http().post('/organization/admin/platforms').set(bearer('b-owner-3')).set('Idempotency-Key', 'k-plat-003').set('x-step-up-token', 'irrelevant').send({ companyId: co2, name: 'X' });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('admin_forbidden');
    });

    it('an operator can never create a Platform, even with a step-up (Platform creation is owner-only)', async () => {
      const co = await seedCompany();
      auth.asOperator('b-op-1', []);
      auth.allowStepUp('b-op-1', 'platform.create', 'su-op');
      const r = await t.http().post('/organization/admin/platforms').set(bearer('b-op-1')).set('Idempotency-Key', 'k-plat-004').set('x-step-up-token', 'su-op').send({ companyId: co, name: 'X' });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('admin_forbidden');
    });

    it('an unknown companyId is 404, before authority is evaluated', async () => {
      const missingCompany = randomUUID();
      auth.asOwner('b-owner-4', missingCompany);
      const r = await t.http().post('/organization/admin/platforms').set(bearer('b-owner-4')).set('Idempotency-Key', 'k-plat-005').send({ companyId: missingCompany, name: 'X' });
      expect(r.status).toBe(404);
    });
  });

  describe('update Platform', () => {
    it('owner updates the name; NO step-up header is required (OPEN-3 default: not sensitive)', async () => {
      const co = await seedCompany();
      const platformId = await seedPlatform(co);
      auth.asOwner('b-owner-5', co);
      const r = await t.http().patch(`/organization/admin/platforms/${platformId}`).set(bearer('b-owner-5')).send({ name: 'Renamed' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.name).toBe('Renamed');
    });

    it('owner of a different company is denied', async () => {
      const co1 = await seedCompany();
      const co2 = await seedCompany();
      const platformId = await seedPlatform(co1);
      auth.asOwner('b-owner-6', co2);
      await t.http().patch(`/organization/admin/platforms/${platformId}`).set(bearer('b-owner-6')).send({ name: 'X' }).expect(403);
    });
  });

  describe('create Organization', () => {
    it('owner of the platform\'s company + step-up succeeds', async () => {
      const co = await seedCompany();
      const platformId = await seedPlatform(co);
      auth.asOwner('b-owner-7', co);
      auth.allowStepUp('b-owner-7', 'organization.create', 'su-org-1');
      const r = await t.http().post('/organization/admin/organizations').set(bearer('b-owner-7')).set('Idempotency-Key', 'k-org-001').set('x-step-up-token', 'su-org-1').send({ platformId, name: 'New Org' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const events = await actorEvents(r.body.id);
      expect(events).toEqual([{ operation: 'organization.create', outcome: 'succeeded', reason: null, actor_kind: 'owner' }]);
    });

    it('an operator ASSIGNED to that platform + step-up succeeds (the evaluator grants operator authority; org-service defers entirely to what Auth says about step-up)', async () => {
      const co = await seedCompany();
      const platformId = await seedPlatform(co);
      auth.asOperator('b-op-2', [platformId]);
      auth.allowStepUp('b-op-2', 'organization.create', 'su-org-2');
      const r = await t.http().post('/organization/admin/organizations').set(bearer('b-op-2')).set('Idempotency-Key', 'k-org-002').set('x-step-up-token', 'su-org-2').send({ platformId, name: 'Org by Operator' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    });

    it('an operator assigned to that platform but DENIED step-up by Auth gets 403 step_up_required', async () => {
      const co = await seedCompany();
      const platformId = await seedPlatform(co);
      auth.asOperator('b-op-3', [platformId]);
      // no allowStepUp call: Auth denies
      const r = await t.http().post('/organization/admin/organizations').set(bearer('b-op-3')).set('Idempotency-Key', 'k-org-003').set('x-step-up-token', 'su-not-granted').send({ platformId, name: 'X' });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('step_up_required');
    });

    it('an operator assigned to a DIFFERENT platform is denied (never reaches step-up)', async () => {
      const co = await seedCompany();
      const platformId = await seedPlatform(co);
      const otherPlatformId = await seedPlatform(co);
      auth.asOperator('b-op-4', [otherPlatformId]);
      const r = await t.http().post('/organization/admin/organizations').set(bearer('b-op-4')).set('Idempotency-Key', 'k-org-004').send({ platformId, name: 'X' });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('admin_forbidden');
    });

    it('a member can never create an Organization', async () => {
      const co = await seedCompany();
      const platformId = await seedPlatform(co);
      auth.asMember('b-mem-1');
      const r = await t.http().post('/organization/admin/organizations').set(bearer('b-mem-1')).set('Idempotency-Key', 'k-org-005').send({ platformId, name: 'X' });
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('admin_forbidden');
    });
  });

  describe('update Organization', () => {
    it('an org-admin member of THAT organization succeeds; NO step-up required (not sensitive)', async () => {
      const co = await seedCompany();
      const platformId = await seedPlatform(co);
      const orgId = await seedOrg(platformId);
      auth.asMember('b-mem-2', [orgId]);
      const r = await t.http().patch(`/organization/admin/organizations/${orgId}`).set(bearer('b-mem-2')).send({ name: 'Renamed by org-admin' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.name).toBe('Renamed by org-admin');
    });

    it('a member who is org-admin of a DIFFERENT organization is denied', async () => {
      const co = await seedCompany();
      const platformId = await seedPlatform(co);
      const orgId = await seedOrg(platformId);
      const otherOrgId = await seedOrg(platformId);
      auth.asMember('b-mem-3', [otherOrgId]);
      await t.http().patch(`/organization/admin/organizations/${orgId}`).set(bearer('b-mem-3')).send({ name: 'X' }).expect(403);
    });

    it('an operator assigned to the organization\'s platform succeeds', async () => {
      const co = await seedCompany();
      const platformId = await seedPlatform(co);
      const orgId = await seedOrg(platformId);
      auth.asOperator('b-op-5', [platformId]);
      const r = await t.http().patch(`/organization/admin/organizations/${orgId}`).set(bearer('b-op-5')).send({ name: 'Renamed by operator' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });
  });
});

describeWithEnv('admin/ boundary — no Auth dependency when unused', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  it('a non-admin route (e.g. the service-token companies API) never touches the Auth client', async () => {
    const db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgadminunused');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    const auth = new FakeAuthGrantsClient();
    let called = false;
    const spied: AuthGrantsClient = { grantsFor: async (b) => { called = true; return auth.grantsFor(b); }, verifyStepUp: (...a) => auth.verifyStepUp(...a) };
    const t = await createTestApp({ databaseUrl: db.url, authGrantsClient: spied });
    try {
      const created = await client(t).company('X');
      expect(created.name).toBe('X');
      expect(called).toBe(false);
    } finally {
      await t.app.close();
      await db.drop();
    }
  });
});

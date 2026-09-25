import { randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { validateAuditPayload } from '@nawara/audit-contract';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import type { AuthGrantFacts, AuthGrantsClient } from '../src/admin/auth-grants-client.js';
import { organizationMigrationsDir } from '../src/app.module.js';
import { bearer, createTestApp, newKey, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { client, sql } from './support/fixtures.js';

/** Auth's grant facts, controlled per bearer (the same double the admin suite uses). The userId is Auth's, never the request's. */
class FakeAuth implements AuthGrantsClient {
  readonly grants = new Map<string, AuthGrantFacts>();
  private readonly stepUps = new Set<string>();
  as(bearerToken: string, facts: Omit<AuthGrantFacts, 'userId'>): string {
    const userId = randomUUID();
    this.grants.set(bearerToken, { userId, ...facts });
    return userId;
  }
  allowStepUp(b: string, purpose: string, token: string) {
    this.stepUps.add(`${b}|${purpose}|${token}`);
  }
  async grantsFor(b: string): Promise<AuthGrantFacts> {
    const f = this.grants.get(b);
    if (!f) throw new UnauthorizedException();
    return f;
  }
  async verifyStepUp(b: string, purpose: string, token: string): Promise<boolean> {
    return this.stepUps.has(`${b}|${purpose}|${token}`);
  }
}

type Row = { id: string; name: string; payload: Record<string, any>; correlationId: string | null };

/**
 * Stage 18.7.3: Organization's catalog actions write their central audit intent into the kit outbox IN THE HIERARCHY WRITE'S TRANSACTION
 * (next to the local `admin_actor_event` on admin routes). Every row is checked against the consumer-side contract (`validateAuditPayload`, the rules audit-service applies; the real pipeline proves the consumer side)
 * exactly as audit-service will check it. Catalog correction G5 (organization.updated accepts a `member`) is pinned here from the
 * producer side: Organization's authorization decides, Audit records the real kind.
 */
describeWithEnv('organization-service audit intent (Stage 18.7.3) — real PostgreSQL', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const auth = new FakeAuth();

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgaudit');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, authGrantsClient: auth });
  });
  afterAll(async () => {
    await t?.app.close();
    await db?.drop();
  });

  const audits = (resourceId: string) =>
    sql<Row>(db.url, `SELECT id, name, payload, "correlationId" FROM outbox WHERE name LIKE 'audit.%' AND payload->'resource'->>'id' = $1 ORDER BY "occurredAt", id`, [resourceId]);
  const valid = (r: Row) => {
    expect(r.name).toBe(`audit.${r.payload.action}`);
    return validateAuditPayload(r.payload, 'organization-service');
  };
  const seedCompany = async () => (await sql<{ id: string }>(db.url, `INSERT INTO company(name) VALUES ('Audit Co') RETURNING id`))[0]!.id;
  const seedPlatform = async (c: string) => (await sql<{ id: string }>(db.url, `INSERT INTO platform(id,"companyId",name) VALUES (gen_random_uuid(),$1,'P') RETURNING id`, [c]))[0]!.id;
  const seedOrg = async (p: string) => (await sql<{ id: string }>(db.url, `INSERT INTO organization(id,"platformId",name) VALUES (gen_random_uuid(),$1,'Org Before') RETURNING id`, [p]))[0]!.id;
  const orgName = async (id: string) => (await sql<{ name: string }>(db.url, `SELECT name FROM organization WHERE id = $1`, [id]))[0]!.name;
  const member = (b: string, adminOf: string[] = []) => auth.as(b, { kind: 'member', companyId: null, platformAssignments: [], organizationAdminMemberships: adminOf });
  const admin = () => ({
    patchOrg: (b: string, id: string, body: object, headers: Record<string, string> = {}) => t.http().patch(`/organization/admin/organizations/${id}`).set(bearer(b)).set(headers).send(body),
  });

  describe('service-token routes: the authenticated caller is the actor', () => {
    it('company / platform / organization create and update: one event each, service actor, organization only for an organization (self); valid per the consumer contract', async () => {
      const c = client(t);
      const co = await c.company('Name Not In Audit');
      const pl = await c.platform(co.id);
      const org = await c.organization(pl.id);
      expect((await c.patch(`/organization/companies/${co.id}`, { name: 'Renamed Co' })).status).toBe(200);
      expect((await c.patch(`/organization/platforms/${pl.id}`, { name: 'Renamed Pl' })).status).toBe(200);
      expect((await c.patch(`/organization/organizations/${org.id}`, { name: 'Renamed Org' })).status).toBe(200);

      const expected: [string, string, string, string | null][] = [
        [co.id, 'company', 'audit.company.created', null], [co.id, 'company', 'audit.company.updated', null],
        [pl.id, 'platform', 'audit.platform.created', null], [pl.id, 'platform', 'audit.platform.updated', null],
        [org.id, 'organization', 'audit.organization.created', org.id], [org.id, 'organization', 'audit.organization.updated', org.id],
      ];
      for (const id of [co.id, pl.id, org.id]) expect(await audits(id)).toHaveLength(2);
      for (const [id, type, name, organizationId] of expected) {
        const row = (await audits(id)).find((r) => r.name === name)!;
        expect(row.payload).toMatchObject({
          action: name.slice('audit.'.length), actor: { type: 'service', id: 'billing-service' }, organizationId, resource: { type, id }, outcome: 'succeeded',
        });
        expect(() => valid(row)).not.toThrow();
        expect(JSON.stringify(row.payload)).not.toMatch(/Name Not In Audit|Renamed|Acme/); // identifiers only, never names
      }
    });

    it('an idempotent replay and a no-op update write NO second event', async () => {
      const c = client(t);
      const key = newKey();
      const first = await c.post('/organization/companies', { name: 'Replay Co' }, key);
      const replay = await c.post('/organization/companies', { name: 'Replay Co' }, key);
      expect([first.status, replay.status]).toEqual([201, 200]); // a replay answers the stored result
      expect(replay.body.id).toBe(first.body.id);
      await c.patch(`/organization/companies/${first.body.id}`, { name: 'Replay Co' }); // same value: nothing changed
      expect((await audits(first.body.id)).map((r) => r.name)).toEqual(['audit.company.created']);
    });

    it('request values cannot choose the actor or the organization: extra body fields are refused, spoof headers are ignored', async () => {
      const c = client(t);
      const co = await c.company();
      const pl = await c.platform(co.id);
      const org = await c.organization(pl.id);
      const spoofBody = await c.patch(`/organization/organizations/${org.id}`, { name: 'X', organizationId: randomUUID(), actor: { type: 'user' } });
      expect(spoofBody.status).toBe(400);
      const r = await t.http().patch(`/organization/organizations/${org.id}`).set(c.auth)
        .set({ 'x-user-id': randomUUID(), 'x-organization-id': randomUUID(), 'x-caller': 'auth-service', 'x-correlation-id': 'org-audit-corr-01' }).send({ name: 'Y' });
      expect(r.status).toBe(200);
      const upd = (await audits(org.id)).filter((x) => x.name === 'audit.organization.updated');
      expect(upd).toHaveLength(1);
      expect(upd[0]!.payload).toMatchObject({ actor: { type: 'service', id: 'billing-service' }, organizationId: org.id });
      expect(upd[0]!.correlationId).toBe('org-audit-corr-01'); // navigation only
    });
  });

  describe('admin routes: the Auth-verified human is the actor, with the kind Auth verified', () => {
    it('owner creates a platform (step-up): user actor kind owner, no organization; the local actor record and the audit event are both written', async () => {
      const co = await seedCompany();
      const userId = auth.as('b-own-1', { kind: 'owner', companyId: co, platformAssignments: [], organizationAdminMemberships: [] });
      auth.allowStepUp('b-own-1', 'platform.create', 'su-1');
      const r = await t.http().post('/organization/admin/platforms').set(bearer('b-own-1')).set('Idempotency-Key', newKey()).set('x-step-up-token', 'su-1').send({ companyId: co, name: 'P' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const [row] = await audits(r.body.id);
      expect(row!.payload).toMatchObject({ action: 'platform.created', actor: { type: 'user', id: userId, userKind: 'owner' }, organizationId: null });
      expect(() => valid(row!)).not.toThrow();
      expect(await sql(db.url, `SELECT outcome FROM admin_actor_event WHERE target_id = $1`, [r.body.id])).toEqual([{ outcome: 'succeeded' }]);
    });

    it('G5 (1, 6, 7): an org-admin MEMBER updates its organization: the event records kind member (never owner/operator), and the organization is the one modified', async () => {
      const org = await seedOrg(await seedPlatform(await seedCompany()));
      const userId = member('b-mem-1', [org]);
      const r = await admin().patchOrg('b-mem-1', org, { name: 'Renamed by member' }, { 'x-organization-id': randomUUID() });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const rows = (await audits(org)).filter((x) => x.name === 'audit.organization.updated');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.payload.actor).toEqual({ type: 'user', id: userId, userKind: 'member' });
      expect(rows[0]!.payload.organizationId).toBe(org);
      expect(() => valid(rows[0]!)).not.toThrow();
    });

    it('G5 (2, 9): Audit grants nothing: a member who is admin of ANOTHER organization is still refused, nothing changes, and only the denial is recorded', async () => {
      const pl = await seedPlatform(await seedCompany());
      const org = await seedOrg(pl);
      const other = await seedOrg(pl);
      const userId = member('b-mem-2', [other]);
      const r = await admin().patchOrg('b-mem-2', org, { name: 'Hijack' });
      expect(r.status).toBe(403);
      expect(await orgName(org)).toBe('Org Before');
      const rows = await audits(org);
      expect(rows.map((x) => x.name)).toEqual(['audit.hierarchy.admin_operation_denied']);
      expect(rows[0]!.payload).toMatchObject({
        actor: { type: 'user', id: userId, userKind: 'member' }, organizationId: org, resource: { type: 'organization', id: org }, outcome: 'denied',
        changes: { operation: 'organization.update', reason: 'no_authority' },
      });
      expect(() => valid(rows[0]!)).not.toThrow();
    });

    it('G5 (3, 4): a member still cannot create an organization or update a platform; each refusal is recorded against its target, organization only for an organization', async () => {
      const co = await seedCompany();
      const pl = await seedPlatform(co);
      member('b-mem-3', []);
      const create = await t.http().post('/organization/admin/organizations').set(bearer('b-mem-3')).set('Idempotency-Key', newKey()).send({ platformId: pl, name: 'X' });
      const upd = await t.http().patch(`/organization/admin/platforms/${pl}`).set(bearer('b-mem-3')).send({ name: 'X' });
      expect([create.status, upd.status]).toEqual([403, 403]);
      const rows = await audits(pl);
      expect(rows.map((r) => [r.payload.changes.operation, r.payload.organizationId, r.payload.actor.userKind])).toEqual([
        ['organization.create', null, 'member'], ['platform.update', null, 'member'],
      ]);
      expect(await sql(db.url, `SELECT count(*)::int AS n FROM outbox WHERE name IN ('audit.organization.created', 'audit.platform.updated') AND payload->'actor'->>'userKind' = 'member'`)).toEqual([{ n: 0 }]);
    });

    it('a missing step-up is recorded as step_up_required against the parent the operation was aimed at', async () => {
      const co = await seedCompany();
      member('b-unused', []);
      auth.as('b-own-2', { kind: 'owner', companyId: co, platformAssignments: [], organizationAdminMemberships: [] });
      const r = await t.http().post('/organization/admin/platforms').set(bearer('b-own-2')).set('Idempotency-Key', newKey()).send({ companyId: co, name: 'P' });
      expect(r.status).toBe(403);
      const [row] = await audits(co);
      expect(row!.payload).toMatchObject({ resource: { type: 'company', id: co }, organizationId: null, changes: { operation: 'platform.create', reason: 'step_up_required' } });
    });
  });

  describe('atomicity: the change, its local record and its audit intent commit or roll back together', () => {
    const refuseOutbox = (name: string) =>
      sql(db.url, `CREATE OR REPLACE FUNCTION s187_refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox refused (test)'; END $$;
                   CREATE TRIGGER s187_refuse BEFORE INSERT ON outbox FOR EACH ROW WHEN (NEW.name = '${name}') EXECUTE FUNCTION s187_refuse()`);
    afterEach(() => sql(db.url, 'DROP TRIGGER IF EXISTS s187_refuse ON outbox'));

    it('G5 (8): if the audit intent cannot be written, the member\'s organization update and its actor record roll back; a retry then writes once', async () => {
      const org = await seedOrg(await seedPlatform(await seedCompany()));
      member('b-mem-4', [org]);
      await refuseOutbox('audit.organization.updated');
      expect((await admin().patchOrg('b-mem-4', org, { name: 'Must Roll Back' })).status).toBe(500);
      expect(await orgName(org)).toBe('Org Before');
      expect(await sql(db.url, `SELECT count(*)::int AS n FROM admin_actor_event WHERE target_id = $1`, [org])).toEqual([{ n: 0 }]);
      await sql(db.url, 'DROP TRIGGER s187_refuse ON outbox');
      expect((await admin().patchOrg('b-mem-4', org, { name: 'Now Committed' })).status).toBe(200);
      expect(await orgName(org)).toBe('Now Committed');
      expect((await audits(org)).map((r) => r.name)).toEqual(['audit.organization.updated']);
    });

    it('service create: an outbox failure leaves no company and no idempotency key (the retry is a fresh create)', async () => {
      await refuseOutbox('audit.company.created');
      const key = newKey();
      expect((await client(t).post('/organization/companies', { name: 'Atomic Co' }, key)).status).toBe(500);
      expect(await sql(db.url, `SELECT count(*)::int AS n FROM company WHERE name = 'Atomic Co'`)).toEqual([{ n: 0 }]);
      expect(await sql(db.url, `SELECT count(*)::int AS n FROM idempotency_key WHERE key = $1`, [key])).toEqual([{ n: 0 }]);
    });

    it('a denial whose audit intent cannot be written fails closed: no local denial record without its central copy', async () => {
      const pl = await seedPlatform(await seedCompany());
      const org = await seedOrg(pl);
      member('b-mem-5', []);
      await refuseOutbox('audit.hierarchy.admin_operation_denied');
      expect((await admin().patchOrg('b-mem-5', org, { name: 'X' })).status).toBe(500);
      expect(await sql(db.url, `SELECT count(*)::int AS n FROM admin_actor_event WHERE target_id = $1`, [org])).toEqual([{ n: 0 }]);
      expect(await orgName(org)).toBe('Org Before');
    });
  });
});

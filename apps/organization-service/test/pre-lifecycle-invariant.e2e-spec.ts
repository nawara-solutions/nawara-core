import { randomUUID } from 'node:crypto';
import { UnauthorizedException } from '@nestjs/common';
import { kitMigrationsDir, runMigrations } from '@nawara/service-kit';
import { createTestDatabase, type TestDatabase } from '@nawara/service-kit/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { organizationMigrationsDir } from '../src/app.module.js';
import type { AuthGrantFacts, AuthGrantsClient } from '../src/admin/auth-grants-client.js';
import { createTestApp, type TestApp } from './support/app.js';
import { describeWithEnv } from './support/env.js';
import { client, sql } from './support/fixtures.js';

/**
 * Core V2 T-A2 (the Owner's D-1, S0-C7 item 1; DN-1.4): organization-service cannot represent, expose or modify a lifecycle state for a
 * Company, Platform or Organization. Until the first lifecycle-enabled release (ADR-0060 §11 L2/L3 with gate V-4) no scope can be
 * inactive; this suite is organization-service's part of the evidence that no Core V2 path can produce, store, read or act on an inactive
 * scope. It asserts ABSENCE only, on an AUTHORITATIVE test service (the state in which hierarchy writes are accepted at all): it adds no
 * lifecycle model, adapter, port or simulated provider (V5-9).
 *
 * Not lifecycle, and deliberately not refused here: the service's own authority phase (`ownership_state.phase`, ADR-0040, whose values
 * include `ACTIVE`), Auth's membership and account state, and the org-admin authority Auth's grant facts carry. A future lifecycle release
 * (ADR-0060 L2/L3) is expected to fail this suite; S0-C7 item 3 then requires it to be revised with V-4, S5e, D6, V5-2 / OD-R6a and L5.
 */
const HIERARCHY_TABLES = ['company', 'platform', 'organization'] as const;
/** Column names a lifecycle state would carry (ADR-0060 §3 local and effective state, its transitions and their instants). */
const LIFECYCLE_COLUMN = /(status|state|lifecycle|suspend|archiv|activ|deleted|disabled|enabled|closed|reactivat|restor|effective)/i;
/** The two inactive lifecycle values (ADR-0060 §3). `ACTIVE` alone is not searched: it is also an ownership phase (ADR-0040). */
const INACTIVE_VALUE = /\b(SUSPENDED|ARCHIVED)\b/;
/** The lifecycle fields a client could try to write (ADR-0060 §3, §8; V5-8). */
const LIFECYCLE_FIELDS = ['status', 'state', 'effectiveStatus', 'effectiveSince', 'suspendedAt', 'archivedAt', 'lifecycle', 'lifecycleState'] as const;
const LIFECYCLE_VALUES: Record<(typeof LIFECYCLE_FIELDS)[number], unknown> = {
  status: 'SUSPENDED', state: 'ARCHIVED', effectiveStatus: 'SUSPENDED', effectiveSince: '2026-10-30T00:00:00Z',
  suspendedAt: '2026-10-30T00:00:00Z', archivedAt: '2026-10-30T00:00:00Z', lifecycle: { local: 'SUSPENDED' }, lifecycleState: 'ARCHIVED',
};

/** Auth's grant facts for the admin routes (ADR-0042 decision 6), as the admin suite doubles them: a bearer maps to fixed facts. */
class FixedGrants implements AuthGrantsClient {
  readonly facts = new Map<string, AuthGrantFacts>();
  async grantsFor(bearer: string): Promise<AuthGrantFacts> {
    const f = this.facts.get(bearer);
    if (!f) throw new UnauthorizedException();
    return f;
  }
  async verifyStepUp(): Promise<boolean> {
    return false; // no admin route exercised here needs a step-up (metadata updates; ADR-0042 Amendment 1)
  }
}

describeWithEnv('organization-service pre-lifecycle invariant (T-A2, S0-C7) — real PostgreSQL, authoritative', ['TEST_DATABASE_ADMIN_URL'], (env) => {
  let db: TestDatabase;
  let t: TestApp;
  const grants = new FixedGrants();
  let companyId: string;
  let platformId: string;
  let organizationId: string;
  const OWNER = 'b-ta2-owner';
  const ORG_ADMIN = 'b-ta2-org-admin';

  beforeAll(async () => {
    db = await createTestDatabase(env.TEST_DATABASE_ADMIN_URL, 'orgta2');
    await runMigrations(db.url, [kitMigrationsDir, organizationMigrationsDir]);
    t = await createTestApp({ databaseUrl: db.url, authGrantsClient: grants }); // authoritative (activateOwnership)
    const c = client(t);
    companyId = (await c.company('TA2 Company')).id;
    platformId = (await c.platform(companyId, 'TA2 Platform')).id;
    organizationId = (await c.organization(platformId, { taxCode: 'TA2-TAX' })).id;
    grants.facts.set(OWNER, { userId: randomUUID(), kind: 'owner', companyId, platformAssignments: [], organizationAdminMemberships: [] });
    // an Organization administrator: authority derived from a MEMBERSHIP fact (Auth's), never a lifecycle fact
    grants.facts.set(ORG_ADMIN, { userId: randomUUID(), kind: 'member', companyId: null, platformAssignments: [], organizationAdminMemberships: [organizationId] });
  });
  afterAll(async () => {
    await t?.app.close();
    await db?.drop();
  });

  const row = async (table: (typeof HIERARCHY_TABLES)[number], id: string) => (await sql(db.url, `SELECT * FROM ${table} WHERE id = $1`, [id]))[0];
  const as = (b: string) => ({ Authorization: `Bearer ${b}` });

  describe('no hierarchy lifecycle state is stored', () => {
    it('the service is authoritative here, and its authority phase is its own table, not a hierarchy column', async () => {
      expect((await sql(db.url, `SELECT authoritative FROM ownership_state`))[0]).toEqual({ authoritative: true });
      const phase = await sql(db.url, `SELECT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'phase'`);
      expect(phase.map((r) => r.table_name)).toEqual(['ownership_state']); // ADR-0040 authority, unrelated to Organization lifecycle
    });

    it('company, platform and organization exist and carry no lifecycle column', async () => {
      const rows = await sql<{ table_name: string; column_name: string }>(db.url,
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])`, [HIERARCHY_TABLES]);
      for (const table of HIERARCHY_TABLES) expect(rows.some((r) => r.table_name === table && r.column_name === 'id'), table).toBe(true);
      expect(rows.filter((r) => LIFECYCLE_COLUMN.test(r.column_name)).map((r) => `${r.table_name}.${r.column_name}`)).toEqual([]);
    });

    it('no constraint, trigger, side table or enum of the hierarchy names an inactive lifecycle state', async () => {
      const constraints = await sql<{ def: string }>(db.url,
        `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public' AND r.relname = ANY($1::text[])`, [HIERARCHY_TABLES]);
      expect(constraints.filter((c) => INACTIVE_VALUE.test(c.def))).toEqual([]);
      const triggers = await sql<{ src: string }>(db.url,
        `SELECT p.prosrc AS src FROM pg_trigger tg JOIN pg_class r ON r.oid = tg.tgrelid JOIN pg_proc p ON p.oid = tg.tgfoid
          JOIN pg_namespace n ON n.oid = r.relnamespace WHERE NOT tg.tgisinternal AND n.nspname = 'public' AND r.relname = ANY($1::text[])`, [HIERARCHY_TABLES]);
      expect(triggers.length).toBeGreaterThan(0); // the immutability triggers exist and are inspected
      expect(triggers.filter((tr) => INACTIVE_VALUE.test(tr.src))).toEqual([]);
      const side = await sql(db.url, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* $1`,
        ['^(company|platform|organization)_?(lifecycle|status|state|suspension|archive)']);
      expect(side).toEqual([]);
      expect(await sql(db.url, `SELECT enumlabel FROM pg_enum WHERE enumlabel ~ '^(SUSPENDED|ARCHIVED)$'`)).toEqual([]);
    });
  });

  describe('no hierarchy read exposes a lifecycle state', () => {
    it('the authoritative reference read answers exactly {organizationId, platformId, companyId}', async () => {
      const r = await client(t).get(`/organization/reference/organizations/${organizationId}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({ organizationId, platformId, companyId });
      expect(Object.keys(r.body).sort()).toEqual(['companyId', 'organizationId', 'platformId']);
    });

    it('the full reads of an Organization, Platform and Company carry no lifecycle field', async () => {
      const c = client(t);
      for (const path of [`/organization/organizations/${organizationId}`, `/organization/platforms/${platformId}`, `/organization/companies/${companyId}`]) {
        const r = await c.get(path);
        expect(r.status, path).toBe(200);
        expect(Object.keys(r.body).filter((k) => LIFECYCLE_COLUMN.test(k)), path).toEqual([]);
      }
    });
  });

  describe('no hierarchy route writes a lifecycle state', () => {
    /** The existing write routes of the three entities, each with its existing validation error code. */
    const serviceWrites = () => [
      { what: 'PATCH organization (service)', table: 'organization' as const, id: organizationId, code: 'invalid_organization_request',
        send: (body: object) => client(t).patch(`/organization/organizations/${organizationId}`, body) },
      { what: 'PATCH platform (service)', table: 'platform' as const, id: platformId, code: 'invalid_platform_request',
        send: (body: object) => client(t).patch(`/organization/platforms/${platformId}`, body) },
      { what: 'PATCH company (service)', table: 'company' as const, id: companyId, code: 'invalid_company_request',
        send: (body: object) => client(t).patch(`/organization/companies/${companyId}`, body) },
      { what: 'PATCH organization (Owner)', table: 'organization' as const, id: organizationId, code: 'invalid_organization_request',
        send: (body: object) => t.http().patch(`/organization/admin/organizations/${organizationId}`).set(as(OWNER)).send(body) },
      { what: 'PATCH organization (Organization administrator)', table: 'organization' as const, id: organizationId, code: 'invalid_organization_request',
        send: (body: object) => t.http().patch(`/organization/admin/organizations/${organizationId}`).set(as(ORG_ADMIN)).send(body) },
      { what: 'PATCH platform (Owner)', table: 'platform' as const, id: platformId, code: 'invalid_platform_request',
        send: (body: object) => t.http().patch(`/organization/admin/platforms/${platformId}`).set(as(OWNER)).send(body) },
    ];

    it('every lifecycle field, alone or beside a valid metadata change, is refused with the route\'s existing 400, and nothing changes', async () => {
      for (const w of serviceWrites()) {
        const before = await row(w.table, w.id);
        for (const field of LIFECYCLE_FIELDS) {
          for (const body of [{ [field]: LIFECYCLE_VALUES[field] }, { name: 'Renamed by lifecycle', [field]: LIFECYCLE_VALUES[field] }]) {
            const r = await w.send(body);
            expect([r.status, r.body.code], `${w.what} ${JSON.stringify(body)} → ${JSON.stringify(r.body)}`).toEqual([400, w.code]);
          }
        }
        expect(await row(w.table, w.id), `${w.what}: no mutation`).toEqual(before);
      }
    });

    it('a lifecycle field is refused at creation too: no entity can be born with a lifecycle state', async () => {
      const c = client(t);
      const before = Number((await sql(db.url, `SELECT (SELECT count(*) FROM company) + (SELECT count(*) FROM platform) + (SELECT count(*) FROM organization) AS n`))[0].n);
      for (const field of LIFECYCLE_FIELDS) {
        const v = LIFECYCLE_VALUES[field];
        expect((await c.post('/organization/companies', { name: 'Born suspended', [field]: v })).body.code).toBe('invalid_company_request');
        expect((await c.post('/organization/platforms', { companyId, name: 'Born suspended', [field]: v })).body.code).toBe('invalid_platform_request');
        expect((await c.post('/organization/organizations', { platformId, name: 'Born suspended', [field]: v })).body.code).toBe('invalid_organization_request');
      }
      const after = Number((await sql(db.url, `SELECT (SELECT count(*) FROM company) + (SELECT count(*) FROM platform) + (SELECT count(*) FROM organization) AS n`))[0].n);
      expect(after).toBe(before);
    });

    it('a non-lifecycle metadata change still works on each route, and the reference read stays ids-only afterwards', async () => {
      const c = client(t);
      expect((await c.patch(`/organization/organizations/${organizationId}`, { address: '1 Pre-lifecycle Street' })).status).toBe(200);
      expect((await c.patch(`/organization/platforms/${platformId}`, { name: 'TA2 Platform, renamed' })).status).toBe(200);
      expect((await c.patch(`/organization/companies/${companyId}`, { name: 'TA2 Company, renamed' })).status).toBe(200);
      const byOwner = await t.http().patch(`/organization/admin/organizations/${organizationId}`).set(as(OWNER)).send({ phone: '+21600000000' });
      expect(byOwner.status, JSON.stringify(byOwner.body)).toBe(200);
      const byOrgAdmin = await t.http().patch(`/organization/admin/organizations/${organizationId}`).set(as(ORG_ADMIN)).send({ name: 'Renamed by its administrator' });
      expect(byOrgAdmin.status, JSON.stringify(byOrgAdmin.body)).toBe(200);
      expect(await row('organization', organizationId)).toMatchObject({ address: '1 Pre-lifecycle Street', phone: '+21600000000', name: 'Renamed by its administrator' });
      expect((await c.get(`/organization/reference/organizations/${organizationId}`)).body).toEqual({ organizationId, platformId, companyId });
    });

    it('there is no delete, suspend, archive, restore or reactivate route for any hierarchy entity', async () => {
      const c = client(t);
      for (const [method, path] of [
        ['delete', `/organization/organizations/${organizationId}`], ['delete', `/organization/platforms/${platformId}`], ['delete', `/organization/companies/${companyId}`],
        ['post', `/organization/organizations/${organizationId}/suspend`], ['post', `/organization/organizations/${organizationId}/archive`],
        ['post', `/organization/organizations/${organizationId}/restore`], ['post', `/organization/organizations/${organizationId}/reactivate`],
        ['post', `/organization/platforms/${platformId}/suspend`], ['post', `/organization/companies/${companyId}/archive`],
        ['post', `/organization/admin/organizations/${organizationId}/suspend`], ['post', `/organization/admin/platforms/${platformId}/archive`],
      ] as const) {
        const r = await t.http()[method](path).set(path.includes('/admin/') ? as(OWNER) : c.auth).send({});
        expect(r.status, `${method.toUpperCase()} ${path}`).toBe(404);
      }
      expect(await row('organization', organizationId)).toBeDefined();
    });
  });
});

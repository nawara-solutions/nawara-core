import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearer, createTestApp, type TestCtx, type Tokens } from './helpers/app.js';

/**
 * Core V2 T-A1 (the Owner's D-1, S0-C7 item 1; DN-1.4): Auth holds no lifecycle state for a Company, Platform or Organization and offers no
 * route that could change one. Until the first lifecycle-enabled release (ADR-0060 §11 L2/L3 with gate V-4) no scope can be inactive; this
 * suite is the Auth part of the evidence that no Core V2 path can produce, store, read or act on an inactive scope. It asserts ABSENCE only:
 * it adds no lifecycle concept, adapter or port (V5-9), and it never inspects unrelated state (a user's `isActive`, a membership's status).
 *
 * When the lifecycle release adds lifecycle to Auth (ADR-0060 E5), this suite is expected to fail: S0-C7 item 3 makes that release certify
 * V-4, S5e, D6, V5-2 / OD-R6a and ADR-0060 L5 together, and this suite is revised with it, never weakened on its own.
 */
const HIERARCHY_TABLES = ['company', 'platform', 'organization'] as const;
/** Column names a lifecycle state would carry (ADR-0060 §3: ACTIVE / SUSPENDED / ARCHIVED; its local and effective state). */
const LIFECYCLE_COLUMN = /(status|state|lifecycle|suspend|archiv|activ|deleted|disabled|enabled|closed|reactivat|restor)/i;
const LIFECYCLE_VALUE = /\b(ACTIVE|SUSPENDED|ARCHIVED)\b/;
const HIERARCHY_COLLECTION = '(companies|company|platforms|platform|organizations|organization)';
/** A lifecycle action on one hierarchy entity (ADR-0060 §4: suspend, reactivate, archive, restore), or a state sub-resource. */
const LIFECYCLE_VERB = '(suspend|suspension|reactivate|activate|deactivate|archive|unarchive|restore|lifecycle|status|state|close|reopen|disable|enable)';
const ENTITY_WRITE = new RegExp(`/${HIERARCHY_COLLECTION}/:[^/]+$`);
const ENTITY_LIFECYCLE = new RegExp(`/${HIERARCHY_COLLECTION}/:[^/]+/${LIFECYCLE_VERB}$`);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

describe('Auth pre-lifecycle invariant (T-A1, S0-C7)', () => {
  let t: TestCtx;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  /** Every HTTP route the running application registered, read from Nest's own controller metadata (method and full path). */
  function registeredRoutes(): { method: string; path: string }[] {
    const out: { method: string; path: string }[] = [];
    const container = (t.app as unknown as { container: { getModules(): Map<string, { controllers: Map<unknown, { metatype?: Function }> }> } }).container;
    for (const mod of container.getModules().values()) {
      for (const wrapper of mod.controllers.values()) {
        const ctrl = wrapper.metatype as (Function & { prototype: Record<string, unknown> }) | undefined;
        if (!ctrl) continue;
        const bases = ([] as string[]).concat(Reflect.getMetadata(PATH_METADATA, ctrl) ?? '');
        const names = new Set<string>();
        for (let proto = ctrl.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
          for (const n of Object.getOwnPropertyNames(proto)) if (n !== 'constructor') names.add(n);
        }
        for (const name of names) {
          const handler = (ctrl.prototype as Record<string, unknown>)[name];
          if (typeof handler !== 'function') continue;
          const paths = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
          if (paths === undefined || method === undefined) continue;
          for (const base of bases) {
            for (const p of ([] as string[]).concat(paths)) {
              out.push({ method: RequestMethod[method], path: `/${[base, p].filter(Boolean).join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1') });
            }
          }
        }
      }
    }
    return out;
  }

  describe('no hierarchy lifecycle state is stored', () => {
    it('company, platform and organization exist and carry no lifecycle column', async () => {
      const { rows } = await t.db.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
        [HIERARCHY_TABLES],
      );
      for (const table of HIERARCHY_TABLES) expect(rows.some((r) => r.table_name === table && r.column_name === 'id'), table).toBe(true);
      expect(rows.filter((r) => LIFECYCLE_COLUMN.test(r.column_name)).map((r) => `${r.table_name}.${r.column_name}`)).toEqual([]);
    });

    it('no constraint, trigger or side table of the hierarchy names a lifecycle state', async () => {
      const constraints = await t.db.query<{ def: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public' AND r.relname = ANY($1::text[])`,
        [HIERARCHY_TABLES],
      );
      expect(constraints.rows.filter((c) => LIFECYCLE_VALUE.test(c.def))).toEqual([]);
      const triggers = await t.db.query<{ src: string }>(
        `SELECT p.prosrc AS src FROM pg_trigger tg JOIN pg_class r ON r.oid = tg.tgrelid JOIN pg_proc p ON p.oid = tg.tgfoid
          JOIN pg_namespace n ON n.oid = r.relnamespace WHERE NOT tg.tgisinternal AND n.nspname = 'public' AND r.relname = ANY($1::text[])`,
        [HIERARCHY_TABLES],
      );
      expect(triggers.rows.filter((tr) => LIFECYCLE_VALUE.test(tr.src))).toEqual([]);
      const sideTables = await t.db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name ~* $1`,
        [`^${HIERARCHY_COLLECTION}_?(lifecycle|status|state|suspension|archive)`],
      );
      expect(sideTables.rows).toEqual([]);
      const enums = await t.db.query<{ label: string }>(`SELECT enumlabel AS label FROM pg_enum WHERE enumlabel ~ '^(SUSPENDED|ARCHIVED)$'`);
      expect(enums.rows).toEqual([]);
    });
  });

  describe('no route can change a hierarchy lifecycle state', () => {
    it('no registered write route acts on a Company, Platform or Organization entity or on its lifecycle', () => {
      const routes = registeredRoutes();
      // the enumeration is real, not vacuous: it sees Auth's routes, including a write on a member account and a hierarchy read
      expect(routes.length).toBeGreaterThanOrEqual(60);
      expect(routes).toContainEqual({ method: 'POST', path: '/auth/admin/members/:id/suspend' }); // an ACCOUNT, not a scope (ADR-0050 decision 5)
      expect(routes).toContainEqual({ method: 'GET', path: '/auth/admin/organizations/:id' });
      const writes = routes.filter((r) => WRITE_METHODS.has(r.method));
      expect(writes.filter((r) => ENTITY_WRITE.test(r.path) || ENTITY_LIFECYCLE.test(r.path))).toEqual([]);
    });

    it('an Owner probing lifecycle actions on their own Organization, Platform and Company finds no route (404), and nothing changes', async () => {
      const w = await t.world();
      const o = await t.readyOwner(w.companyA, `pre-lifecycle-${Date.now()}@a.test`);
      const auth = bearer(o.tokens as Tokens);
      const before = await t.db.query(`SELECT * FROM organization WHERE id = $1`, [w.orgSchool1]);
      for (const [method, path] of [
        ['post', `/auth/admin/organizations/${w.orgSchool1}/suspend`],
        ['post', `/auth/admin/organizations/${w.orgSchool1}/archive`],
        ['post', `/auth/admin/organizations/${w.orgSchool1}/reactivate`],
        ['patch', `/auth/admin/organizations/${w.orgSchool1}`],
        ['delete', `/auth/admin/organizations/${w.orgSchool1}`],
        ['post', `/auth/organizations/${w.orgSchool1}/suspend`],
        ['post', `/auth/admin/platforms/${w.platformSchool}/suspend`],
        ['post', `/auth/admin/companies/${w.companyA}/archive`],
      ] as const) {
        const r = await t.http[method](path).set(auth).send({ reasonCode: 'any', status: 'SUSPENDED' });
        expect(r.status, `${method.toUpperCase()} ${path}`).toBe(404);
      }
      expect((await t.db.query(`SELECT * FROM organization WHERE id = $1`, [w.orgSchool1])).rows).toEqual(before.rows);
    });
  });

  describe('no hierarchy read carries a lifecycle state', () => {
    it("the Organization read answers exactly {id, platformId}: no status, effective state or 'since'", async () => {
      const w = await t.world();
      const o = await t.readyOwner(w.companyA, `pre-lifecycle-read-${Date.now()}@a.test`);
      const r = await t.http.get(`/auth/admin/organizations/${w.orgSchool1}`).set(bearer(o.tokens as Tokens));
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toEqual({ id: w.orgSchool1, platformId: w.platformSchool });
    });
  });
});

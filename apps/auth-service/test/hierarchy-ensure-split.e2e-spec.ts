import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapOwner } from '../src/cli/owner-tools.js';
import { PasswordService } from '../src/crypto/password.js';
import { contentDigestNow, retireWrites } from '../src/hierarchy/hierarchy-authority.js';
import { HierarchyReference } from '../src/hierarchy/hierarchy-reference.js';
import { UsersService } from '../src/users/users.service.js';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

/**
 * A5.4-A2 (docs/architecture/core-v2-a5-4-a2-ensure-split-design.md §4, §5.2): the `ensure` resolve/place split changes nothing that
 * can be observed. Real PostgreSQL, the real routes, a stand-in Organization Service.
 *
 * With Auth's source `local` the stand-in is CONFIGURED (URL and token set), so a call would be possible: "zero calls" is evidence, not
 * an accident. The expected audit intents, outbox rows and step-up consumptions below were captured on `main` BEFORE the refactor and
 * are committed as literals; they are the existing, unrelated writes of each operation, and nothing new may join them.
 */
const TOKEN = 'auth-full-read-credential-000000000000000000';
type Entity = Record<string, unknown>;

function standIn() {
  const calls: string[] = [];
  const directory = new Map<string, Entity>();
  /** Paths answered only once TWO requests for them are waiting: proves two first touches really overlap. */
  const together = new Map<string, Array<() => void>>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '';
    calls.push(path);
    const answer = () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end(); return; }
      const a = directory.get(path);
      if (a === undefined) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a));
    };
    const waiting = together.get(path);
    if (!waiting) { answer(); return; }
    waiting.push(answer);
    if (waiting.length === 2) { together.delete(path); for (const go of waiting) go(); }
  });
  const path = (kind: 'companies' | 'platforms' | 'organizations', id: unknown) => `/organization/${kind}/${String(id)}`;
  const put = (kind: 'companies' | 'platforms' | 'organizations', e: Entity) => directory.set(path(kind, e.id), e);
  const holdForTwo = (kind: 'companies' | 'platforms' | 'organizations', id: unknown) => together.set(path(kind, id), []);
  return { calls, server, put, holdForTwo, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('A5.4-A2: with source local, the first-touch operations do exactly what they did before the split', () => {
  let t: TestCtx;
  const org = standIn();
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let owner: Awaited<ReturnType<TestCtx['readyOwner']>>;
  const su = (purpose: string) => t.stepUpToken(owner.tokens, purpose, owner.totpSecret);

  /** Everything the split must leave untouched, read from the database. */
  const state = async () => ({
    hierarchyDigest: await contentDigestNow(t.db),
    hierarchyRows: (await t.db.query(`SELECT (SELECT count(*) FROM company)::int AS c, (SELECT count(*) FROM platform)::int AS p, (SELECT count(*) FROM organization)::int AS o`)).rows[0],
    marker: (await t.db.query(`SELECT mode, frozen_at, retired_at, updated_at FROM hierarchy_authority`)).rows[0],
    markerEvents: (await t.db.query(`SELECT count(*)::int AS n FROM hierarchy_authority_event`)).rows[0].n,
  });
  const outboxNames = async () => (await t.db.query(`SELECT name, count(*)::int AS n FROM outbox GROUP BY name ORDER BY name`)).rows.map((r) => `${r.name} x${r.n}`);
  const consumed = async () => (await t.db.query(`SELECT purpose, count(*)::int AS n FROM owner_step_up WHERE "consumedAt" IS NOT NULL GROUP BY purpose ORDER BY purpose`)).rows.map((r) => `${r.purpose} x${r.n}`);

  beforeAll(async () => {
    await new Promise<void>((r) => org.server.listen(0, '127.0.0.1', r));
    // Source local, WITH a configured Organization Service: a call is possible, so none being made is real evidence.
    t = await createTestApp({ AUTH_HIERARCHY_SOURCE: 'local', ORGANIZATION_SERVICE_URL: org.url(), ORGANIZATION_SERVICE_TOKEN: TOKEN }, { realEvents: {} });
    w = await t.world();
    owner = await t.readyOwner(w.companyA, `owner${randomUUID().slice(0, 6)}@a.test`);
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => org.server.close(() => r()));
  });
  beforeEach(() => { org.calls.length = 0; });

  it('join-code creation, invitation creation and a platform-assignment grant: no call, no reference row, no marker change, and only their existing writes', async () => {
    const before = await state();
    const outboxBefore = await outboxNames();
    const consumedBefore = await consumed();

    await t.http.post(`/auth/organizations/${w.orgSchool1}/join-codes`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('join_code.create'))
      .send({ audience: 'student', requiresApproval: false, requiresSubscription: false }).expect(201);
    await t.http.post(`/auth/organizations/${w.orgSchool1}/admin-invitations`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('admin_invitation.create'))
      .send({ invitationType: 'org_admin' }).expect(201);
    const op = await t.operator(w.companyA, `op${randomUUID().slice(0, 6)}@a.test`);
    await t.http.post(`/auth/admin/operators/${op.id}/platform-assignments`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('platform_assignment.grant'))
      .send({ platformId: w.platformDrive }).expect(201);

    expect(org.calls).toEqual([]); // no Organization Service call
    expect(await state()).toEqual(before); // no reference placement, no marker or authority change
    // The outbox and the step-up consumptions grew by exactly the existing writes of the three operations (captured on main).
    const grew = (after: string[], base: string[]) => after.filter((x) => !base.includes(x)).sort();
    expect(grew(await outboxNames(), outboxBefore)).toEqual(EXPECTED_ON_MAIN.outbox);
    expect(grew(await consumed(), consumedBefore)).toEqual(EXPECTED_ON_MAIN.consumed);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM owner_step_up WHERE purpose = 'hierarchy.reference.repair'`)).rows[0].n).toBe(0);
    expect((await outboxNames()).filter((n) => /reference_repair|reference_anchor/.test(n))).toEqual([]);
  });

  it('the command line is unchanged: bootstrap-owner with a Company id calls ensure whatever the source, places that one row, then is local', async () => {
    const run = (companyId: string) => bootstrapOwner(t.dbs, t.app.get(UsersService), t.app.get(PasswordService),
      { companyName: 'Ignored', email: `own${randomUUID().slice(0, 6)}@a.test`, password: 'bootstrap-pass-123', companyId }, t.app.get(HierarchyReference));
    const company = { id: randomUUID(), name: 'Bootstrap company' };
    org.put('companies', company);
    const before = await state();
    const outboxBefore = await outboxNames();

    expect(await run(company.id)).toEqual({ created: false }); // an owner already exists: nothing is created
    expect(org.calls).toEqual([`/organization/companies/${company.id}`]);
    expect((await t.db.query(`SELECT name FROM company WHERE id = $1`, [company.id])).rows).toEqual([{ name: 'Bootstrap company' }]);
    const after = await state();
    expect(after.hierarchyRows).toEqual({ ...before.hierarchyRows, c: before.hierarchyRows.c + 1 }); // that one Company row, nothing else
    expect([after.marker, after.markerEvents]).toEqual([before.marker, before.markerEvents]);
    expect(await outboxNames()).toEqual(outboxBefore);

    org.calls.length = 0;
    expect(await run(company.id)).toEqual({ created: false }); // second run: the row is cached
    expect(org.calls).toEqual([]);
    expect((await state()).hierarchyRows).toEqual(after.hierarchyRows);
  });
});

describe('A5.4-A2: with source organization-service, concurrent first touches place one row each (design scenario 12)', () => {
  let t: TestCtx;
  const org = standIn();
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let owner: Awaited<ReturnType<TestCtx['readyOwner']>>;

  beforeAll(async () => {
    await new Promise<void>((r) => org.server.listen(0, '127.0.0.1', r));
    t = await createTestApp({ AUTH_HIERARCHY_SOURCE: 'organization-service', ORGANIZATION_SERVICE_URL: org.url(), ORGANIZATION_SERVICE_TOKEN: TOKEN });
    w = await t.world();
    owner = await t.readyOwner(w.companyA, `owner${randomUUID().slice(0, 6)}@a.test`);
    org.put('companies', { id: w.companyA, name: 'A' });
    await retireWrites(t.dbs, 'test-operator', 'test activation evidence', { fresh: true });
    await t.app.listen(0); // parallel requests
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => org.server.close(() => r()));
  });

  it('two join codes for the same never-seen Organization at once: both succeed, one Platform row and one Organization row', async () => {
    const platform = { id: randomUUID(), companyId: w.companyA, name: 'Remote platform', key: `remote-${randomUUID().slice(0, 8)}` };
    const organization = { id: randomUUID(), platformId: platform.id, name: 'Remote organization' };
    org.put('platforms', platform);
    org.put('organizations', organization);
    // Neither answer is given until both requests ask: both resolve the whole chain before either places anything.
    org.holdForTwo('organizations', organization.id);
    org.holdForTwo('platforms', platform.id);
    org.calls.length = 0;
    const s1 = await t.stepUpToken(owner.tokens, 'join_code.create', owner.totpSecret);
    const s2 = await t.stepUpToken(owner.tokens, 'join_code.create', owner.totpSecret);
    const create = (su: string) => t.http.post(`/auth/organizations/${organization.id}/join-codes`).set(bearer(owner.tokens)).set('X-Step-Up-Token', su)
      .send({ audience: 'student', requiresApproval: false, requiresSubscription: false });
    const [a, b] = await Promise.all([create(s1), create(s2)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const o = `/organization/organizations/${organization.id}`;
    const p = `/organization/platforms/${platform.id}`;
    expect(org.calls).toEqual([o, o, p, p]); // both resolved fully (the Company is cached: no call), then both placed
    expect((await t.db.query(`SELECT "companyId" FROM platform WHERE id = $1`, [platform.id])).rows).toEqual([{ companyId: w.companyA }]);
    expect((await t.db.query(`SELECT "platformId" FROM organization WHERE id = $1`, [organization.id])).rows).toEqual([{ platformId: platform.id }]);
  });
});

/** Captured on `main` (bb36ea3) before the split: what the three operations write, and nothing else. */
const EXPECTED_ON_MAIN = {
  outbox: ['audit.admin_invitation.created x1', 'audit.join_code.created x1', 'audit.platform_assignment.granted x1'],
  consumed: ['admin_invitation.create x1', 'join_code.create x1', 'platform_assignment.grant x1'],
};

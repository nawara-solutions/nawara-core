import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapOwner } from '../src/cli/owner-tools.js';
import { PasswordService } from '../src/crypto/password.js';
import { freeze, retireWrites, unfreeze } from '../src/hierarchy/hierarchy-authority.js';
import { HierarchyReference } from '../src/hierarchy/hierarchy-reference.js';
import { UsersService } from '../src/users/users.service.js';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Stage 21.C.2 WP-G (ADR-0040 decisions 1 and 2, Amendment 1 A1.2, A2.5; Stage 10.0 §4.5 R2c): Auth's reference-cache protocol against a
 * stand-in Organization Service, through the REAL administrative routes, on real PostgreSQL. No cutover is performed: the test database's
 * marker is set with the existing CLI functions, exactly as 21.x will do it for real.
 *
 * First touch = a join code or an invitation for an Organization, an assignment on a Platform, the owner bootstrap of a fresh
 * environment. Login, refresh, `/auth/me`, registration, join and consume never call Organization Service.
 */
const TOKEN = 'auth-full-read-credential-000000000000000000';
type Entity = Record<string, unknown>;

describe('Auth hierarchy reference cache (source: organization-service)', () => {
  let t: TestCtx;
  let org: Server;
  const calls: string[] = [];
  /** What the stand-in answers per path; anything absent is a 404. `status` forces a failure. */
  const directory = new Map<string, Entity | { status: number } | 'hang' | 'redirect' | 'oversized' | 'malformed'>();
  let onRequest: (path: string) => Promise<void> = async () => undefined;
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let owner: Awaited<ReturnType<TestCtx['readyOwner']>>;
  const su = (purpose: string) => t.stepUpToken(owner.tokens, purpose, owner.totpSecret);
  const rows = async (table: string, id: string) => (await t.db.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows;

  const put = (kind: 'companies' | 'platforms' | 'organizations', e: Entity) => directory.set(`/organization/${kind}/${String(e.id)}`, e);
  /** A new Company-A Platform and Organization that exist ONLY at Organization Service (not yet in Auth's cache). */
  function newRemote(companyId = w.companyA) {
    const platform = { id: randomUUID(), companyId, name: 'Remote platform', key: `remote-${randomUUID().slice(0, 8)}`, createdAt: new Date(), updatedAt: new Date() };
    const organization = { id: randomUUID(), platformId: platform.id, name: 'Remote organization', taxCode: 'TX-1', address: null, phone: null, type: null };
    put('platforms', platform);
    put('organizations', organization);
    return { platform, organization };
  }

  beforeAll(async () => {
    org = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const path = req.url ?? '';
      calls.push(path);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end(); return; }
      await onRequest(path);
      const a = directory.get(path);
      if (a === undefined) { res.writeHead(404); res.end(); return; }
      if (a === 'hang') return;
      if (a === 'redirect') { res.writeHead(302, { location: '/elsewhere' }); res.end(); return; }
      if (a === 'oversized') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ pad: 'x'.repeat(20_000) })); return; }
      if (a === 'malformed') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":'); return; }
      if ('status' in a) { res.writeHead(a.status as number); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a));
    });
    await new Promise<void>((r) => org.listen(0, '127.0.0.1', r));
    t = await createTestApp({
      AUTH_HIERARCHY_SOURCE: 'organization-service', ORGANIZATION_SERVICE_URL: `http://127.0.0.1:${(org.address() as AddressInfo).port}`,
      ORGANIZATION_SERVICE_TOKEN: TOKEN, ORGANIZATION_SERVICE_TIMEOUT_MS: '300',
    });
    // The pre-cutover world (Auth authoritative), then the switch 21.x performs: marker org_authoritative (a fresh-class retire here).
    w = await t.world();
    owner = await t.readyOwner(w.companyA, `owner${randomUUID().slice(0, 6)}@a.test`);
    put('companies', { id: w.companyA, name: 'A' });
    await retireWrites(t.dbs, 'test-operator', 'test activation evidence', { fresh: true });
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => org.close(() => r()));
  });
  beforeEach(() => {
    calls.length = 0;
    onRequest = async () => undefined;
  });

  it('a join code for an Organization Auth has never seen: placed by ensure (parents first, Auth\'s own credential), then created', async () => {
    const { platform, organization } = newRemote();
    const r = await t.http.post(`/auth/organizations/${organization.id}/join-codes`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('join_code.create'))
      .send({ audience: 'student', requiresApproval: false, requiresSubscription: false });
    expect(r.status).toBe(201);
    expect(calls).toEqual([`/organization/organizations/${organization.id}`, `/organization/platforms/${platform.id}`]); // the Company was cached
    expect(await rows('platform', platform.id)).toMatchObject([{ companyId: w.companyA, name: 'Remote platform', key: platform.key }]);
    const [o] = await rows('organization', organization.id);
    expect(o).toMatchObject({ platformId: platform.id, name: 'Remote organization', taxCode: null }); // only anchors and the name snapshot
    // a second first touch is local: no call
    calls.length = 0;
    await t.http.post(`/auth/organizations/${organization.id}/join-codes`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('join_code.create'))
      .send({ audience: 'student', requiresApproval: false, requiresSubscription: false }).expect(201);
    expect(calls).toEqual([]);
  });

  it('an admin invitation is a first touch too', async () => {
    const { organization } = newRemote();
    await t.http.post(`/auth/organizations/${organization.id}/admin-invitations`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('admin_invitation.create'))
      .send({ invitationType: 'org_admin' }).expect(201);
    expect(await rows('organization', organization.id)).toHaveLength(1);
  });

  it('the first assignment on a Platform places it; a Platform of ANOTHER Company is placed as a reference but refused (the company rule still decides)', async () => {
    const op = await t.operator(w.companyA, `op${randomUUID().slice(0, 6)}@a.test`);
    const { platform } = newRemote();
    await t.http.post(`/auth/admin/operators/${op.id}/platform-assignments`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('platform_assignment.grant'))
      .send({ platformId: platform.id }).expect(201);
    expect(await rows('platform', platform.id)).toHaveLength(1);
    put('companies', { id: w.companyB, name: 'B' });
    const foreign = newRemote(w.companyB).platform;
    await t.http.post(`/auth/admin/operators/${op.id}/platform-assignments`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await su('platform_assignment.grant'))
      .send({ platformId: foreign.id }).expect(404);
  });

  it('an Organization Organization Service does not know: the usual 404, and nothing is cached', async () => {
    const id = randomUUID();
    await t.http.post(`/auth/organizations/${id}/join-codes`).set(bearer(owner.tokens)).send({ audience: 'student', requiresApproval: false, requiresSubscription: false }).expect(404);
    expect(await rows('organization', id)).toHaveLength(0);
  });

  it('Organization Service unable to answer (409 before activation, 5xx, timeout, redirect, oversized, malformed, a refused credential): 503 hierarchy_unavailable, nothing written', async () => {
    for (const failure of [{ status: 409 }, { status: 500 }, 'hang', 'redirect', 'oversized', 'malformed', { status: 403 }] as const) {
      const id = randomUUID();
      directory.set(`/organization/organizations/${id}`, failure);
      const before = (await t.db.query('SELECT count(*)::int AS n FROM organization_join_code')).rows[0].n;
      const r = await t.http.post(`/auth/organizations/${id}/join-codes`).set(bearer(owner.tokens)).send({ audience: 'student', requiresApproval: false, requiresSubscription: false });
      expect([r.status, r.body.code]).toEqual([503, 'hierarchy_unavailable']);
      expect(JSON.stringify(r.body)).not.toMatch(/127\.0\.0\.1|auth-full-read/);
      expect(await rows('organization', id)).toHaveLength(0);
      expect((await t.db.query('SELECT count(*)::int AS n FROM organization_join_code')).rows[0].n).toBe(before);
    }
  });

  it('a parent the authority does not show is not trusted: 503, nothing placed', async () => {
    const organization = { id: randomUUID(), platformId: randomUUID(), name: 'Orphan' };
    put('organizations', organization);
    const r = await t.http.post(`/auth/organizations/${organization.id}/join-codes`).set(bearer(owner.tokens)).send({ audience: 'student', requiresApproval: false, requiresSubscription: false });
    expect(r.status).toBe(503);
    expect(await rows('organization', organization.id)).toHaveLength(0);
  });

  it('an anchor that disagrees with the authority fails closed and alerts (a concurrent reference placed with another parent)', async () => {
    const { platform, organization } = newRemote();
    const other = newRemote().platform;
    await t.app.get(HierarchyReference).ensure('platform', other.id);
    await t.app.get(HierarchyReference).ensure('platform', platform.id);
    onRequest = async (path) => {
      if (path.endsWith(organization.id)) {
        // the row appears meanwhile under ANOTHER platform (a reused id / tampering), through the reference gate itself
        await t.dbs.tx(async (q) => {
          await q.query(`SELECT set_config('nawara.reference_write', 'on', true)`);
          await q.query(`INSERT INTO organization (id, "platformId", name) VALUES ($1, $2, 'x')`, [organization.id, other.id]);
        });
      }
    };
    const r = await t.http.post(`/auth/organizations/${organization.id}/join-codes`).set(bearer(owner.tokens)).send({ audience: 'student', requiresApproval: false, requiresSubscription: false });
    expect(r.status).toBe(503);
    expect(t.logger.lines.some((l) => l.includes(`hierarchy_anchor_mismatch kind=organization id=${organization.id}`))).toBe(true);
    expect((await rows('organization', organization.id))[0].platformId).toBe(other.id); // nothing was overwritten
  });

  it('the authentication paths never call Organization Service, even while it is down', async () => {
    for (const k of directory.keys()) directory.set(k, { status: 503 });
    const jc = await t.joinCode(w.orgDrive, { requiresApproval: false });
    const email = `m${randomUUID().slice(0, 6)}@x.test`;
    await t.http.post('/auth/register').send({ email, password: 'member password 1', joinCode: jc.code }).expect(201);
    const login = await t.http.post('/auth/login').send({ email, password: 'member password 1' }).expect(200);
    await t.http.get('/auth/me').set(bearer(login.body)).expect(200);
    await t.http.post('/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    const jc2 = await t.joinCode(w.orgSchool1, { requiresApproval: false });
    await t.http.post('/auth/onboarding/join').set(bearer(login.body)).send({ joinCode: jc2.code }).expect(201);
    expect(calls).toEqual([]);
  });
});

describe('the reference write is refused while the hierarchy is frozen (AD-5: temporarily unavailable)', () => {
  let t: TestCtx;
  let org: Server;
  beforeAll(async () => {
    org = createServer((_, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    await new Promise<void>((r) => org.listen(0, '127.0.0.1', r));
    t = await createTestApp({ AUTH_HIERARCHY_SOURCE: 'organization-service', ORGANIZATION_SERVICE_URL: `http://127.0.0.1:${(org.address() as AddressInfo).port}`, ORGANIZATION_SERVICE_TOKEN: TOKEN });
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => org.close(() => r()));
  });

  it('frozen: ensure cannot place a row (503), and unfreezing leaves the local source as it was', async () => {
    const company = randomUUID();
    org.removeAllListeners('request');
    org.on('request', (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: company, name: 'C' })); });
    await freeze(t.dbs, 'op');
    await expect(t.app.get(HierarchyReference).ensure('company', company)).rejects.toMatchObject({ response: { code: 'hierarchy_unavailable' } });
    expect((await t.db.query('SELECT 1 FROM company WHERE id = $1', [company])).rowCount).toBe(0);
    await unfreeze(t.dbs, 'op');
  });
});

describe('the owner bootstrap of a fresh environment (ADR-0040 A2.5 F4; ADR-0042 AD-4): auth-service never creates a Company', () => {
  let t: TestCtx;
  let org: Server;
  const company = randomUUID();
  beforeAll(async () => {
    org = createServer((req, res) => {
      if (req.url === `/organization/companies/${company}`) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: company, name: 'Fresh Co' })); return; }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => org.listen(0, '127.0.0.1', r));
    t = await createTestApp({ AUTH_HIERARCHY_SOURCE: 'organization-service', ORGANIZATION_SERVICE_URL: `http://127.0.0.1:${(org.address() as AddressInfo).port}`, ORGANIZATION_SERVICE_TOKEN: TOKEN });
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => org.close(() => r()));
  });
  const run = (companyId?: string) => bootstrapOwner(t.dbs, t.app.get(UsersService), t.app.get(PasswordService),
    { companyName: 'Ignored', email: `own${randomUUID().slice(0, 6)}@a.test`, password: 'bootstrap-pass-123', companyId }, t.app.get(HierarchyReference));

  it('without the authoritative Company id it refuses (no local Company insert), and an unknown id creates nothing', async () => {
    await expect(run()).rejects.toThrow(/does not create a Company/);
    await expect(run(randomUUID())).rejects.toThrow(/does not know that Company/);
    expect((await t.db.query('SELECT count(*)::int AS n FROM company')).rows[0].n).toBe(0);
  });

  it('with the id: the Company reference row comes from Organization Service, then the owner references it', async () => {
    const r = await run(company);
    expect(r.created).toBe(true);
    expect((await t.db.query('SELECT name FROM company WHERE id = $1', [company])).rows).toEqual([{ name: 'Fresh Co' }]);
    expect((await t.db.query('SELECT "companyId" FROM owner WHERE "userId" = $1', [r.ownerId])).rows[0].companyId).toBe(company);
  });
});

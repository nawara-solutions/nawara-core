import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { retireWrites } from '../src/hierarchy/hierarchy-authority.js';
import { HierarchyReference, type HierarchyKind } from '../src/hierarchy/hierarchy-reference.js';
import { bearer, createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Concurrent first touches of the same Platform or Organization, on real PostgreSQL, with a stand-in Organization Service that answers
 * a path only once every caller of the round is waiting: each round's callers resolve together and then place together, the overlap
 * that made `ON CONFLICT (id) DO NOTHING` raise 23505 on `platform_id_company_uk` (CI, PR #417 at d13efee: `[201, 503]`).
 *
 * Every caller of the same authoritative row succeeds and exactly one row exists. A caller told another parent, a Platform key
 * already held by another id, and an authority that cannot answer still fail closed with 503 `hierarchy_unavailable`.
 */
const TOKEN = 'auth-full-read-credential-000000000000000000';
const ROUNDS = 15;
const CALLERS = 6;
type Entity = Record<string, unknown>;
type Answer = Entity | { status: number } | ((nth: number) => Entity);

function standIn() {
  const directory = new Map<string, Answer>();
  const asked = new Map<string, number>();
  const held = new Map<string, { size: number; waiting: Array<() => void> }>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '';
    const nth = (asked.get(path) ?? 0) + 1;
    asked.set(path, nth);
    const answer = () => {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end(); return; }
      const a = directory.get(path);
      if (a === undefined) { res.writeHead(404); res.end(); return; }
      if (typeof a === 'object' && 'status' in a) { res.writeHead(a.status as number); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(typeof a === 'function' ? a(nth) : a));
    };
    const hold = held.get(path);
    if (!hold) { answer(); return; }
    hold.waiting.push(answer);
    if (hold.waiting.length === hold.size) { held.delete(path); for (const go of hold.waiting) go(); }
  });
  const path = (kind: HierarchyKind, id: string) => `/organization/${kind === 'company' ? 'companies' : `${kind}s`}/${id}`;
  return {
    server,
    put: (kind: HierarchyKind, id: string, a: Answer) => directory.set(path(kind, id), a),
    /** The path is answered only once `size` requests for it are waiting. */
    holdFor: (kind: HierarchyKind, id: string, size: number) => held.set(path(kind, id), { size, waiting: [] }),
    url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

describe('concurrent first touches of the same hierarchy row (source organization-service, real PostgreSQL)', () => {
  let t: TestCtx;
  const org = standIn();
  let w: Awaited<ReturnType<TestCtx['world']>>;
  const ensure = (kind: HierarchyKind, id: string) => t.app.get(HierarchyReference).ensure(kind, id);
  const settle = (kind: HierarchyKind, id: string, n: number) => Promise.allSettled(Array.from({ length: n }, () => ensure(kind, id)));
  const count = async (table: 'platform' | 'organization', id: string) => (await t.db.query(`SELECT count(*)::int AS n FROM ${table} WHERE id = $1`, [id])).rows[0].n;
  const anchorOf = async (table: 'platform' | 'organization', id: string) =>
    (await t.db.query(`SELECT ${table === 'platform' ? '"companyId"' : '"platformId"'} AS a FROM ${table} WHERE id = $1`, [id])).rows.map((r) => r.a);
  const totals = async () => (await t.db.query(`SELECT (SELECT count(*)::int FROM platform) AS p, (SELECT count(*)::int FROM organization) AS o`)).rows[0];
  const isUnavailable = (r: PromiseSettledResult<boolean>) =>
    r.status === 'rejected' && (r.reason as { response?: { code?: string } }).response?.code === 'hierarchy_unavailable';
  const newPlatform = (companyId: string) => ({ id: randomUUID(), companyId, name: 'Remote platform', key: `remote-${randomUUID().slice(0, 8)}` });
  const newOrganization = (platformId: string) => ({ id: randomUUID(), platformId, name: 'Remote organization' });

  beforeAll(async () => {
    await new Promise<void>((r) => org.server.listen(0, '127.0.0.1', r));
    t = await createTestApp({ AUTH_HIERARCHY_SOURCE: 'organization-service', ORGANIZATION_SERVICE_URL: org.url(), ORGANIZATION_SERVICE_TOKEN: TOKEN });
    w = await t.world();
    org.put('company', w.companyA, { id: w.companyA, name: 'A' });
    org.put('company', w.companyB, { id: w.companyB, name: 'B' });
    await retireWrites(t.dbs, 'test-operator', 'test activation evidence', { fresh: true });
    await t.app.listen(0); // parallel HTTP requests
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => org.server.close(() => r()));
  });

  it(`the same new Platform, ${CALLERS} callers at once, ${ROUNDS} rounds, Platforms of two Companies: every caller succeeds, one row each`, async () => {
    const before = await totals();
    for (let round = 0; round < ROUNDS; round++) {
      const p = newPlatform(round % 2 === 0 ? w.companyA : w.companyB);
      org.put('platform', p.id, p);
      org.holdFor('platform', p.id, CALLERS);
      const results = await settle('platform', p.id, CALLERS);
      expect(results, `round ${round}`).toEqual(Array.from({ length: CALLERS }, () => ({ status: 'fulfilled', value: true })));
      expect(await count('platform', p.id)).toBe(1);
      expect(await anchorOf('platform', p.id)).toEqual([p.companyId]); // the authority's Company, never another
    }
    expect(await totals()).toEqual({ p: before.p + ROUNDS, o: before.o }); // nothing partial, nothing extra
  });

  it(`the same new Organization under a new Platform (both placed by the race), ${CALLERS} callers, ${ROUNDS} rounds: one row each`, async () => {
    const before = await totals();
    for (let round = 0; round < ROUNDS; round++) {
      const p = newPlatform(w.companyA);
      const o = newOrganization(p.id);
      org.put('platform', p.id, p);
      org.put('organization', o.id, o);
      org.holdFor('organization', o.id, CALLERS);
      org.holdFor('platform', p.id, CALLERS);
      const results = await settle('organization', o.id, CALLERS);
      expect(results, `round ${round}`).toEqual(Array.from({ length: CALLERS }, () => ({ status: 'fulfilled', value: true })));
      expect([await count('platform', p.id), await count('organization', o.id)]).toEqual([1, 1]);
      expect(await anchorOf('organization', o.id)).toEqual([p.id]);
      expect(await anchorOf('platform', p.id)).toEqual([w.companyA]);
    }
    expect(await totals()).toEqual({ p: before.p + ROUNDS, o: before.o + ROUNDS });
  });

  it(`the same new Organization under a CACHED Platform, ${CALLERS} callers, ${ROUNDS} rounds: one row each`, async () => {
    const before = await totals();
    for (let round = 0; round < ROUNDS; round++) {
      const o = newOrganization(w.platformDrive);
      org.put('organization', o.id, o);
      org.holdFor('organization', o.id, CALLERS);
      const results = await settle('organization', o.id, CALLERS);
      expect(results, `round ${round}`).toEqual(Array.from({ length: CALLERS }, () => ({ status: 'fulfilled', value: true })));
      expect(await count('organization', o.id)).toBe(1);
      expect(await anchorOf('organization', o.id)).toEqual([w.platformDrive]);
    }
    expect(await totals()).toEqual({ p: before.p, o: before.o + ROUNDS });
  });

  it('different new Organizations of the same new Platform at once: each placed under it, the Platform once', async () => {
    const p = newPlatform(w.companyA);
    const orgs = Array.from({ length: CALLERS }, () => newOrganization(p.id));
    org.put('platform', p.id, p);
    for (const o of orgs) org.put('organization', o.id, o);
    org.holdFor('platform', p.id, CALLERS);
    const results = await Promise.allSettled(orgs.map((o) => ensure('organization', o.id)));
    expect(results.every((r) => r.status === 'fulfilled' && r.value === true)).toBe(true);
    expect(await count('platform', p.id)).toBe(1);
    for (const o of orgs) expect(await anchorOf('organization', o.id)).toEqual([p.id]);
  });

  it(`${CALLERS - 1} join codes for the same never-seen Organization at once, through the route: all 201, one Platform row, one Organization row`, async () => {
    const owner = await t.readyOwner(w.companyA, `owner${randomUUID().slice(0, 6)}@a.test`);
    const n = CALLERS - 1;
    const p = newPlatform(w.companyA);
    const o = newOrganization(p.id);
    org.put('platform', p.id, p);
    org.put('organization', o.id, o);
    org.holdFor('organization', o.id, n);
    org.holdFor('platform', p.id, n);
    const proofs: string[] = [];
    for (let i = 0; i < n; i++) proofs.push(await t.stepUpToken(owner.tokens, 'join_code.create', owner.totpSecret));
    const responses = await Promise.all(proofs.map((su) => t.http.post(`/auth/organizations/${o.id}/join-codes`).set(bearer(owner.tokens))
      .set('X-Step-Up-Token', su).send({ audience: 'student', requiresApproval: false, requiresSubscription: false })));
    expect(responses.map((r) => r.status)).toEqual(Array.from({ length: n }, () => 201));
    expect([await count('platform', p.id), await count('organization', o.id)]).toEqual([1, 1]);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM organization_join_code WHERE "organizationId" = $1`, [o.id])).rows[0].n).toBe(n);
  });

  it('callers told DIFFERENT Companies for the same Platform at once: one Company is stored, every caller told the other fails closed', async () => {
    const id = randomUUID();
    const key = `remote-${randomUUID().slice(0, 8)}`;
    // the authority answers alternately (a tampered or inconsistent answer): half the callers hear Company A, half Company B
    org.put('platform', id, (nth) => ({ id, companyId: nth % 2 === 1 ? w.companyA : w.companyB, name: 'Remote platform', key }));
    org.holdFor('platform', id, CALLERS);
    const results = await settle('platform', id, CALLERS);
    const stored = await anchorOf('platform', id);
    expect(stored).toHaveLength(1);
    expect([w.companyA, w.companyB]).toContain(stored[0]);
    expect(results.filter((r) => r.status === 'fulfilled' && r.value === true)).toHaveLength(CALLERS / 2); // only those told the stored one
    expect(results.filter(isUnavailable)).toHaveLength(CALLERS / 2);
    expect(t.logger.lines.some((l) => l.includes(`hierarchy_anchor_mismatch kind=platform id=${id}`))).toBe(true);
  });

  it('a Platform key held by ANOTHER id is a refused write, not a race: 503, no row, the holder unchanged', async () => {
    const holder = newPlatform(w.companyA);
    org.put('platform', holder.id, holder);
    expect(await ensure('platform', holder.id)).toBe(true);
    const intruder = { ...newPlatform(w.companyA), key: holder.key };
    org.put('platform', intruder.id, intruder);
    await expect(ensure('platform', intruder.id)).rejects.toMatchObject({ response: { code: 'hierarchy_unavailable' } });
    expect(await count('platform', intruder.id)).toBe(0);
    expect((await t.db.query(`SELECT id, "companyId", key FROM platform WHERE key = $1`, [holder.key])).rows).toEqual([{ id: holder.id, companyId: holder.companyId, key: holder.key }]);
    expect(t.logger.lines.some((l) => l.includes('hierarchy_reference_unavailable reason=reference_write_refused kind=platform'))).toBe(true);
  });

  it('different new Platforms claiming the same key at once: exactly one is placed, every other caller is refused (503)', async () => {
    const key = `remote-${randomUUID().slice(0, 8)}`;
    const claims = Array.from({ length: CALLERS }, () => ({ ...newPlatform(w.companyA), key }));
    for (const p of claims) org.put('platform', p.id, p);
    const results = await Promise.allSettled(claims.map((p) => ensure('platform', p.id)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(isUnavailable)).toHaveLength(CALLERS - 1);
    expect((await t.db.query(`SELECT count(*)::int AS n FROM platform WHERE key = $1`, [key])).rows[0].n).toBe(1);
  });

  it('an authority that cannot answer, to every concurrent caller: all 503 hierarchy_unavailable, nothing written', async () => {
    const p = newPlatform(w.companyA);
    const o = newOrganization(p.id);
    org.put('organization', o.id, { status: 503 });
    org.holdFor('organization', o.id, CALLERS);
    const results = await settle('organization', o.id, CALLERS);
    expect(results.every(isUnavailable)).toBe(true);
    expect([await count('platform', p.id), await count('organization', o.id)]).toEqual([0, 0]);
  });
});

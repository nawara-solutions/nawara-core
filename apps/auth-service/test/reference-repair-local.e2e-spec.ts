import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { contentDigestNow } from '../src/hierarchy/hierarchy-authority.js';
import { bearer, createTestApp, noReqId, type TestCtx, type Tokens } from './helpers/app.js';

/**
 * A5.4-A3 slice C, the inert modes (§9.3 A.4; the A3 design §10.1, §11.5 O15, §11.6 C2; tests TL1 to TL4, TL2b, TL2c, TL2e).
 *
 * With Auth's hierarchy source `local`, and with the source `organization-service` while the authority marker is still `local`, the
 * repair route answers a non-Owner `403` and every Owner request the SAME collapsed `404`, and writes NOTHING: no proof consumed, no
 * throttle row, no reference row, no outbox row, no local or central audit record, no marker change, and no Organization Service
 * call. The stand-in Organization Service is configured (URL and token), so "zero calls" is evidence and not an accident.
 */
const TOKEN = 'auth-full-read-credential-000000000000000000';
const PURPOSE = 'hierarchy.reference.repair';
const uniq = () => randomUUID().slice(0, 8);

function standIn() {
  const calls: string[] = [];
  const directory = new Map<string, Record<string, unknown>>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    calls.push(req.url ?? '');
    const found = directory.get(req.url ?? '');
    res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    res.end(found ? JSON.stringify(found) : '');
  });
  return { calls, directory, server, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Everything the inert route must leave untouched, read from the database. */
async function footprint(t: TestCtx) {
  const n = async (sql: string) => (await t.db.query(sql)).rows[0].n as number;
  return {
    consumedProofs: await n(`SELECT count(*)::int AS n FROM owner_step_up WHERE "consumedAt" IS NOT NULL`),
    repairThrottle: await n(`SELECT count(*)::int AS n FROM auth_throttle WHERE bucket LIKE 'reference_repair%'`),
    repairOutbox: await n(`SELECT count(*)::int AS n FROM outbox WHERE name LIKE 'audit.hierarchy.reference%'`),
    repairLocal: await n(`SELECT count(*)::int AS n FROM auth_audit_event WHERE type LIKE 'hierarchy.reference_repair%'`),
    rows: (await t.db.query(`SELECT (SELECT count(*) FROM company)::int AS c, (SELECT count(*) FROM platform)::int AS p, (SELECT count(*) FROM organization)::int AS o`)).rows[0],
    digest: await contentDigestNow(t.db),
    marker: (await t.db.query(`SELECT mode, frozen_at, retired_at, updated_at FROM hierarchy_authority`)).rows[0],
    markerEvents: await n(`SELECT count(*)::int AS n FROM hierarchy_authority_event`),
  };
}

const MODES: Array<[string, Record<string, string>]> = [
  ['source local', { AUTH_HIERARCHY_SOURCE: 'local' }],
  ['source organization-service, marker local', { AUTH_HIERARCHY_SOURCE: 'organization-service' }],
];

describe.each(MODES)('A5.4-A3 slice C: the repair route is inert (%s)', (_mode, env) => {
  let t: TestCtx;
  const org = standIn();
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let owner: Awaited<ReturnType<TestCtx['readyOwner']>>;
  const repair = (tokens: Tokens | null, kind: string, id: string, proof?: string) => {
    const r = t.http.post(`/auth/admin/hierarchy-references/${kind}/${id}/repair`);
    if (tokens) r.set(bearer(tokens));
    if (proof !== undefined) r.set('x-step-up-token', proof);
    return r;
  };

  beforeAll(async () => {
    await new Promise<void>((r) => org.server.listen(0, '127.0.0.1', r));
    t = await createTestApp({ ...env, ORGANIZATION_SERVICE_URL: org.url(), ORGANIZATION_SERVICE_TOKEN: TOKEN });
    w = await t.world();
    owner = await t.readyOwner(w.companyA, `own${uniq()}@a.test`);
    org.directory.set(`/organization/platforms/${w.platformSchool}`, { id: w.platformSchool, companyId: w.companyA, name: 'School', key: null });
  });
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => org.server.close(() => r()));
  });

  it('unauthenticated: 401; a Member and an Operator: 403; nothing is written and Organization Service is never called', async () => {
    const before = await footprint(t);
    org.calls.length = 0;
    await repair(null, 'platform', w.platformSchool).expect(401);
    const member = await t.member(w.orgSchool1, `mem${uniq()}@a.test`);
    const memberTokens = (await t.http.post('/auth/login').send({ email: member.email, password: member.password }).expect(200)).body as Tokens;
    await repair(memberTokens, 'platform', w.platformSchool).expect(403);
    await repair(memberTokens, 'nonsense', 'not-a-uuid').expect(403); // 1b precedes validation
    const op = await t.operator(w.companyA, `op${uniq()}@a.test`);
    await repair(await t.operatorLogin(op.email), 'organization', w.orgSchool1).expect(403);
    expect(await footprint(t)).toEqual(before);
    expect(org.calls).toEqual([]);
  });

  it('the Owner: the same collapsed 404 whatever the proof, the kind or the id; the proof is not consumed; nothing is written', async () => {
    const proof = await t.stepUpToken(owner.tokens, PURPOSE, owner.totpSecret);
    const before = await footprint(t);
    org.calls.length = 0;
    const answers = [
      await repair(owner.tokens, 'platform', w.platformSchool, proof), // valid proof, existing id
      await repair(owner.tokens, 'organization', randomUUID(), proof), // unknown id
      await repair(owner.tokens, 'platform', w.platformClinic, proof), // another Company's id
      await repair(owner.tokens, 'platform', w.platformSchool, randomUUID()), // invalid proof
      await repair(owner.tokens, 'platform', w.platformSchool), // no proof
      await repair(owner.tokens, 'platform', 'not-a-uuid', proof), // malformed id
      await repair(owner.tokens, 'company', w.companyA, proof), // a kind the route does not repair
    ];
    for (const a of answers) {
      expect(a.status).toBe(404);
      expect(noReqId(a.body)).toEqual(noReqId(answers[0]!.body));
      expect(a.headers['content-type']).toBe(answers[0]!.headers['content-type']);
    }
    expect(await footprint(t)).toEqual(before); // no consumption, no throttle row, no record, no reference row, no marker change
    expect(org.calls).toEqual([]);
    expect((await t.db.query(`SELECT "consumedAt" FROM owner_step_up WHERE id=$1`, [proof])).rows[0].consumedAt).toBeNull();
  });

  it('existing first-touch operations are unaffected by the new route', async () => {
    await t.http.post(`/auth/organizations/${w.orgSchool2}/join-codes`).set(bearer(owner.tokens)).set('X-Step-Up-Token', await t.stepUpToken(owner.tokens, 'join_code.create', owner.totpSecret))
      .send({ audience: 'student', requiresApproval: false, requiresSubscription: false }).expect(201);
  });
});

describe('A5.4-A3 slice C: an unreadable authority marker (source organization-service)', () => {
  let t: TestCtx;
  const org = standIn();
  let w: Awaited<ReturnType<TestCtx['world']>>;
  let owner: Awaited<ReturnType<TestCtx['readyOwner']>>;
  const repair = (tokens: Tokens, kind: string, id: string, proof?: string) => {
    const r = t.http.post(`/auth/admin/hierarchy-references/${kind}/${id}/repair`).set(bearer(tokens));
    if (proof !== undefined) r.set('x-step-up-token', proof);
    return r;
  };
  /** The marker read fails (a test double on Auth's database for that one statement); every other statement is real. */
  const breakMarker = () => {
    const real = t.dbs.query.bind(t.dbs);
    return vi.spyOn(t.dbs, 'query').mockImplementation(((sql: string, params?: unknown[]) =>
      (sql === 'SELECT mode FROM hierarchy_authority' ? Promise.reject(new Error('the marker cannot be read')) : real(sql, params))) as never);
  };

  beforeAll(async () => {
    await new Promise<void>((r) => org.server.listen(0, '127.0.0.1', r));
    t = await createTestApp({ AUTH_HIERARCHY_SOURCE: 'organization-service', ORGANIZATION_SERVICE_URL: org.url(), ORGANIZATION_SERVICE_TOKEN: TOKEN });
    w = await t.world();
    owner = await t.readyOwner(w.companyA, `own${uniq()}@a.test`);
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await t?.close();
    await new Promise<void>((r) => org.server.close(() => r()));
  });

  it('the Owner: 503 hierarchy_unavailable, before validation, the proof and the rate limits; nothing is consumed, counted, looked up or written', async () => {
    const proof = await t.stepUpToken(owner.tokens, PURPOSE, owner.totpSecret);
    const before = await footprint(t);
    breakMarker();
    for (const r of [await repair(owner.tokens, 'platform', w.platformSchool, proof), await repair(owner.tokens, 'platform', 'not-a-uuid')]) {
      expect([r.status, r.body.code]).toEqual([503, 'hierarchy_unavailable']);
    }
    vi.restoreAllMocks();
    expect(await footprint(t)).toEqual(before);
    expect(org.calls).toEqual([]);
  });

  /** The marker read answers something the database itself can never hold (a test double: the table has one row and a closed set). */
  const fakeMarker = (rows: unknown[]) => {
    const real = t.dbs.query.bind(t.dbs);
    return vi.spyOn(t.dbs, 'query').mockImplementation(((sql: string, params?: unknown[]) =>
      (sql === 'SELECT mode FROM hierarchy_authority' ? Promise.resolve({ rows, rowCount: rows.length }) : real(sql, params))) as never);
  };

  it.each([
    ['a missing marker row', []],
    ['an unexpected marker value', [{ mode: 'org_authoritative_v2' }]],
    ['two marker rows', [{ mode: 'org_authoritative' }, { mode: 'org_authoritative' }]],
  ])('%s: the Owner gets 503 hierarchy_unavailable; nothing consumed, counted, placed, called or recorded', async (_name, rows) => {
    const proof = await t.stepUpToken(owner.tokens, PURPOSE, owner.totpSecret);
    const before = await footprint(t);
    org.calls.length = 0;
    fakeMarker(rows);
    const r = await repair(owner.tokens, 'platform', w.platformSchool, proof);
    vi.restoreAllMocks();
    expect([r.status, r.body.code]).toEqual([503, 'hierarchy_unavailable']);
    expect(await footprint(t)).toEqual(before);
    expect(org.calls).toEqual([]);
    expect((await t.db.query(`SELECT "consumedAt" FROM owner_step_up WHERE id=$1`, [proof])).rows[0].consumedAt).toBeNull();
  });

  it('a non-Owner: still 403, and no repair record (C2)', async () => {
    const member = await t.member(w.orgSchool1, `mem${uniq()}@a.test`);
    const tokens = (await t.http.post('/auth/login').send({ email: member.email, password: member.password }).expect(200)).body as Tokens;
    const before = await footprint(t);
    breakMarker();
    await repair(tokens, 'platform', w.platformSchool).expect(403);
    vi.restoreAllMocks();
    expect(await footprint(t)).toEqual(before);
  });
});

describe('A5.4-A3 slice C: with source local the marker is not even read', () => {
  let t: TestCtx;
  beforeAll(async () => { t = await createTestApp({ AUTH_HIERARCHY_SOURCE: 'local' }); });
  afterAll(async () => { await t?.close(); });

  it('a broken marker changes nothing: the inert 404, and no marker statement is sent', async () => {
    const w = await t.world();
    const owner = await t.readyOwner(w.companyA, `own${uniq()}@a.test`);
    const query = vi.spyOn(t.dbs, 'query');
    const r = await t.http.post(`/auth/admin/hierarchy-references/platform/${w.platformSchool}/repair`).set(bearer(owner.tokens));
    expect(r.status).toBe(404);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('hierarchy_authority'))).toBe(false);
    vi.restoreAllMocks();
  });
});

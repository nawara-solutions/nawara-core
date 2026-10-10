import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { validateAuditPayload } from '@nawara/audit-contract';
import { CentralAudit } from '../src/audit/central-audit.js';
import { freeze, retireWrites } from '../src/hierarchy/hierarchy-authority.js';
import { bearer, createTestApp, noReqId, type TestCtx, type Tokens } from './helpers/app.js';

/**
 * A5.4-A3 slice C: the hierarchy reference repair route on a real PostgreSQL, with source `organization-service` (the A3 design §3
 * to §8, §11.5, §11.6; ADR-0061 §4 and §5; ADR-0064 §4; ADR-0065 §5). Two applications, each on its own database:
 *   - ELIGIBLE: the authority marker `org_authoritative`;
 *   - FROZEN: the marker `frozen` (the frozen evidence policy of §11.6).
 * A stand-in Organization Service answers what the test puts in its directory, and can hold two requests until both are waiting.
 * Central records are read from Auth's outbox (`audit.<action>`) and validated against the audit contract; local records from
 * `auth_audit_event`. The inert modes are test/reference-repair-local.e2e-spec.ts.
 */
const TOKEN = 'auth-full-read-credential-000000000000000000';
const PURPOSE = 'hierarchy.reference.repair';
const uniq = () => randomUUID().slice(0, 8);
type Entity = Record<string, unknown>;

function standIn() {
  const calls: string[] = [];
  const directory = new Map<string, Entity | number>();
  const together = new Map<string, Array<() => void>>();
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? '';
    calls.push(path);
    const answer = () => {
      const found = directory.get(path);
      if (typeof found === 'number') { res.writeHead(found); res.end(); return; }
      res.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
      res.end(found ? JSON.stringify(found) : '');
    };
    const waiting = together.get(path);
    if (!waiting) { answer(); return; }
    waiting.push(answer);
    if (waiting.length === 2) { together.delete(path); for (const go of waiting) go(); }
  });
  const at = (kind: 'companies' | 'platforms' | 'organizations', id: unknown) => `/organization/${kind}/${String(id)}`;
  return {
    calls, server, url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    put: (kind: 'companies' | 'platforms' | 'organizations', e: Entity) => directory.set(at(kind, e.id), e),
    fail: (kind: 'companies' | 'platforms' | 'organizations', id: string, status: number) => directory.set(at(kind, id), status),
    holdForTwo: (kind: 'companies' | 'platforms' | 'organizations', id: unknown) => together.set(at(kind, id), []),
  };
}

/** One application on its own database, its world, an Owner, and the helpers the tests share. */
async function setup(org: ReturnType<typeof standIn>, extra: Record<string, string> = {}) {
  const t = await createTestApp({
    AUTH_HIERARCHY_SOURCE: 'organization-service', ORGANIZATION_SERVICE_URL: org.url(), ORGANIZATION_SERVICE_TOKEN: TOKEN,
    RATE_REFERENCE_REPAIR_OWNER_LIMIT: '100000', RATE_REFERENCE_REPAIR_IP_LIMIT: '100000', ...extra,
  });
  const w = await t.world();
  const owner = await t.readyOwner(w.companyA, `own${uniq()}@a.test`);
  const proof = () => t.stepUpToken(owner.tokens, PURPOSE, owner.totpSecret);
  const repair = (tokens: Tokens, kind: string, id: string, stepUp?: string) => {
    const r = t.http.post(`/auth/admin/hierarchy-references/${kind}/${id}/repair`).set(bearer(tokens));
    if (stepUp !== undefined) r.set('x-step-up-token', stepUp);
    return r;
  };
  const central = async (action: string, resourceId?: string) => (await t.db.query(
    `SELECT payload FROM outbox WHERE name = $1 ${resourceId ? `AND payload->'resource'->>'id' = $2` : ''} ORDER BY "occurredAt", id`,
    resourceId ? [`audit.${action}`, resourceId] : [`audit.${action}`])).rows.map((r) => r.payload as Record<string, any>);
  const local = async (type: string, targetId?: string) => (await t.db.query(
    `SELECT outcome, "actorId", "targetId", metadata FROM auth_audit_event WHERE type = $1 ${targetId ? 'AND "targetId" = $2' : ''} ORDER BY id`,
    targetId ? [type, targetId] : [type])).rows;
  const repairOutbox = async () => (await t.db.query(`SELECT count(*)::int AS n FROM outbox WHERE name LIKE 'audit.hierarchy.reference%'`)).rows[0].n as number;
  const consumed = async (id: string) => (await t.db.query(`SELECT "consumedAt" FROM owner_step_up WHERE id=$1`, [id])).rows[0].consumedAt !== null;
  const rowExists = async (table: 'platform' | 'organization' | 'company', id: string) => (await t.db.query(`SELECT 1 FROM ${table} WHERE id=$1`, [id])).rowCount === 1;
  const hierarchyCounts = async () => (await t.db.query(`SELECT (SELECT count(*) FROM company)::int AS c, (SELECT count(*) FROM platform)::int AS p, (SELECT count(*) FROM organization)::int AS o`)).rows[0];
  const memberTokens = async () => {
    const m = await t.member(w.orgSchool1, `mem${uniq()}@a.test`);
    return (await t.http.post('/auth/login').send({ email: m.email, password: m.password }).expect(200)).body as Tokens;
  };
  const valid = (payload: Record<string, any>) => expect(() => validateAuditPayload(payload as never, 'auth-service')).not.toThrow();
  return { t, w, owner, proof, repair, central, local, repairOutbox, consumed, rowExists, hierarchyCounts, memberTokens, valid };
}

describe('A5.4-A3 slice C: repair while Organization Service is the authority (marker org_authoritative)', () => {
  const org = standIn();
  let s: Awaited<ReturnType<typeof setup>>;
  const platform = () => ({ id: randomUUID(), companyId: s.w.companyA, name: 'Remote platform', key: `p-${uniq()}` });
  const organization = (platformId: string) => ({ id: randomUUID(), platformId, name: 'Remote organization' });

  beforeAll(async () => {
    await new Promise<void>((r) => org.server.listen(0, '127.0.0.1', r));
    s = await setup(org);
    org.put('companies', { id: s.w.companyA, name: 'A' });
    await retireWrites(s.t.dbs, 'test-operator', 'test activation evidence', { fresh: true });
    await s.t.app.listen(0); // parallel requests
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await s?.t.close();
    await new Promise<void>((r) => org.server.close(() => r()));
  });

  it('placement: an uncached Organization and its uncached Platform: 200 placed true; both rows; one success record in the same transaction; the proof consumed', async () => {
    const p = platform();
    const o = organization(p.id);
    org.put('platforms', p);
    org.put('organizations', o);
    const su = await s.proof();
    const r = await s.repair(s.owner.tokens, 'organization', o.id.toUpperCase(), su).expect(200);
    expect(r.body).toEqual({ kind: 'organization', id: o.id, placed: true });
    expect([await s.rowExists('platform', p.id), await s.rowExists('organization', o.id)]).toEqual([true, true]);
    expect(await s.consumed(su)).toBe(true);
    const [rec] = await s.central('hierarchy.reference_repaired', o.id);
    s.valid(rec!);
    expect(rec).toMatchObject({ actor: { type: 'user', id: s.owner.id, userKind: 'owner' }, organizationId: o.id, resource: { type: 'organization', id: o.id }, outcome: 'succeeded', changes: { placed: true } });
  });

  it('no-op: the same target again: 200 placed false; no Organization Service call; one more success record; the proof consumed', async () => {
    const p = platform();
    org.put('platforms', p);
    await s.repair(s.owner.tokens, 'platform', p.id, await s.proof()).expect(200);
    org.calls.length = 0;
    const su = await s.proof();
    const r = await s.repair(s.owner.tokens, 'platform', p.id, su).expect(200);
    expect(r.body).toEqual({ kind: 'platform', id: p.id, placed: false });
    expect(org.calls).toEqual([]);
    expect(await s.consumed(su)).toBe(true);
    const records = await s.central('hierarchy.reference_repaired', p.id);
    expect(records.map((x) => x.changes.placed)).toEqual([true, false]);
    expect(records[1]!.organizationId).toBeNull(); // a Platform: no organization (the catalog's resource rule)
  });

  it('collapsed 404: unknown, and another Company\'s (uncached and cached) ids give identical answers; nothing placed; proof consumed; one unresolved record each', async () => {
    const foreign = { id: randomUUID(), companyId: s.w.companyB, name: 'Theirs', key: null };
    const foreignOrg = organization(foreign.id);
    org.put('platforms', foreign);
    org.put('organizations', foreignOrg);
    const before = await s.hierarchyCounts();
    const ids: Array<[string, string]> = [['platform', randomUUID()], ['organization', foreignOrg.id], ['platform', s.w.platformClinic]];
    const answers = [];
    for (const [kind, id] of ids) {
      const su = await s.proof();
      answers.push(await s.repair(s.owner.tokens, kind, id, su));
      expect(await s.consumed(su)).toBe(true);
    }
    for (const a of answers) expect([a.status, noReqId(a.body)]).toEqual([404, noReqId(answers[0]!.body)]);
    expect(await s.hierarchyCounts()).toEqual(before); // not the target, not its Platform
    for (const [kind, id] of ids) {
      const recs = await s.central('hierarchy.reference_repair_unresolved', id);
      expect(recs).toHaveLength(1);
      s.valid(recs[0]!);
      expect(recs[0]).toMatchObject({ actor: { userKind: 'owner' }, organizationId: null, resource: { type: kind, id }, outcome: 'denied', changes: { reason: 'unresolved' } });
    }
  });

  it('a non-Owner (Member, Operator): 403; nothing placed; no proof touched; one central denial (no_authority)', async () => {
    const tokens = await s.memberTokens();
    await s.repair(tokens, 'platform', s.w.platformSchool).expect(403);
    const op = await s.t.operator(s.w.companyA, `op${uniq()}@a.test`);
    await s.repair(await s.t.operatorLogin(op.email), 'organization', s.w.orgSchool1).expect(403);
    const [m] = await s.central('hierarchy.reference_repair_denied', s.w.platformSchool);
    s.valid(m!);
    expect(m).toMatchObject({ actor: { userKind: 'member' }, organizationId: null, outcome: 'denied', changes: { reason: 'no_authority' } });
    expect((await s.central('hierarchy.reference_repair_denied', s.w.orgSchool1))[0]).toMatchObject({ actor: { userKind: 'operator' } });
  });

  it('a non-Owner with a malformed id or an unknown kind (O3, TA8): 403 with the local denial record only', async () => {
    const tokens = await s.memberTokens();
    const before = await s.repairOutbox();
    await s.repair(tokens, 'company', 'not-a-uuid').expect(403);
    expect(await s.repairOutbox()).toBe(before);
    expect((await s.local('hierarchy.reference_repair.denied')).at(-1)).toMatchObject({ outcome: 'denied', targetId: null, metadata: { kind: 'company', reason: 'no_authority' } });
  });

  it('the Owner with a malformed id or an unknown kind and no proof (TA8): 400; nothing consumed, counted or recorded', async () => {
    const before = await s.repairOutbox();
    expect((await s.repair(s.owner.tokens, 'platform', 'not-a-uuid')).status).toBe(400);
    expect((await s.repair(s.owner.tokens, 'company', s.w.companyA)).status).toBe(400);
    expect(await s.repairOutbox()).toBe(before);
  });

  it('rejected proofs: absent, unknown, another purpose, another session: 403 step_up_required; not consumed; no Organization call; one denial each (step_up_required)', async () => {
    const p = platform();
    org.put('platforms', p);
    org.calls.length = 0;
    const otherPurpose = await s.t.stepUpToken(s.owner.tokens, 'organization.create', s.owner.totpSecret);
    const otherSession = await s.t.ownerLogin({ email: s.owner.email, password: s.owner.password }, s.owner.totpSecret);
    const otherSessionProof = await s.t.stepUpToken(otherSession, PURPOSE, s.owner.totpSecret);
    for (const su of [undefined, randomUUID(), otherPurpose, otherSessionProof]) {
      const r = await s.repair(s.owner.tokens, 'platform', p.id, su);
      expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
    }
    expect([await s.consumed(otherPurpose), await s.consumed(otherSessionProof)]).toEqual([false, false]);
    expect(org.calls).toEqual([]);
    expect(await s.rowExists('platform', p.id)).toBe(false);
    const denials = await s.central('hierarchy.reference_repair_denied', p.id);
    expect(denials.map((d) => d.changes.reason)).toEqual(['step_up_required', 'step_up_required', 'step_up_required', 'step_up_required']);
    denials.forEach((d) => s.valid(d));
  });

  it('replay: a consumed proof is refused the second time, even after a 404', async () => {
    const su = await s.proof();
    await s.repair(s.owner.tokens, 'platform', randomUUID(), su).expect(404);
    const r = await s.repair(s.owner.tokens, 'platform', randomUUID(), su);
    expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
  });

  it('concurrent repairs of one id with two proofs, both in flight at once: both 200, one row, exactly one placed true, two success records', async () => {
    const p = platform();
    const o = organization(p.id);
    org.put('platforms', p);
    org.put('organizations', o);
    org.holdForTwo('organizations', o.id);
    org.holdForTwo('platforms', p.id);
    const [a, b] = [await s.proof(), await s.proof()];
    const [ra, rb] = await Promise.all([s.repair(s.owner.tokens, 'organization', o.id, a), s.repair(s.owner.tokens, 'organization', o.id, b)]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    expect([ra.body.placed, rb.body.placed].sort((x, y) => Number(x) - Number(y))).toEqual([false, true]);
    expect((await s.t.db.query(`SELECT count(*)::int AS n FROM organization WHERE id=$1`, [o.id])).rows[0].n).toBe(1);
    expect((await s.central('hierarchy.reference_repaired', o.id)).map((x) => x.changes.placed as boolean).sort((x, y) => Number(x) - Number(y))).toEqual([false, true]);
  });

  it('infrastructure failure (the authority answers 500): 503; nothing placed; proof consumed; a local failure record and a warning line; no central record', async () => {
    const id = randomUUID();
    org.fail('platforms', id, 500);
    const before = await s.repairOutbox();
    const su = await s.proof();
    const r = await s.repair(s.owner.tokens, 'platform', id, su);
    expect([r.status, r.body.code]).toEqual([503, 'hierarchy_unavailable']);
    expect(await s.consumed(su)).toBe(true);
    expect(await s.repairOutbox()).toBe(before);
    expect(await s.local('hierarchy.reference_repair.failed', id)).toEqual([expect.objectContaining({ outcome: 'failure', actorId: s.owner.id, metadata: { kind: 'platform', reason: 'authority_unavailable' } })]);
    expect(s.t.logger.lines.some((l) => l.includes(`hierarchy_reference_repair_failed kind=platform id=${id} reason=authority_unavailable`))).toBe(true);
  });

  it('a parent the authority does not show: 503, parent_missing, locally', async () => {
    const o = organization(randomUUID());
    org.put('organizations', o);
    const r = await s.repair(s.owner.tokens, 'organization', o.id, await s.proof());
    expect(r.status).toBe(503);
    expect(await s.local('hierarchy.reference_repair.failed', o.id)).toEqual([expect.objectContaining({ metadata: { kind: 'organization', reason: 'parent_missing' } })]);
  });

  it('anchor mismatch (a cached Platform whose Company link the authority contradicts): 503; nothing placed; the incident record with operation reference_repair; the alert log line', async () => {
    org.put('platforms', { id: s.w.platformDrive, companyId: s.w.companyB, name: 'Drive', key: null }); // the authority disagrees
    const o = organization(s.w.platformDrive);
    org.put('organizations', o);
    const su = await s.proof();
    const r = await s.repair(s.owner.tokens, 'organization', o.id, su);
    expect(r.status).toBe(503);
    expect(await s.consumed(su)).toBe(true);
    expect(await s.rowExists('organization', o.id)).toBe(false);
    const [incident] = await s.central('hierarchy.reference_anchor_mismatch_detected', s.w.platformDrive);
    s.valid(incident!);
    expect(incident).toMatchObject({ actor: { type: 'system', id: 'hierarchy_anchor_detection' }, organizationId: null, resource: { type: 'platform', id: s.w.platformDrive }, outcome: 'denied', changes: { operation: 'reference_repair' } });
    expect(s.t.logger.lines.some((l) => l.includes(`hierarchy_anchor_mismatch kind=platform id=${s.w.platformDrive}`))).toBe(true);
    expect((await s.t.db.query(`SELECT "companyId" FROM platform WHERE id=$1`, [s.w.platformDrive])).rows[0].companyId).toBe(s.w.companyA); // never overwritten
    org.put('platforms', { id: s.w.platformDrive, companyId: s.w.companyA, name: 'Drive', key: null });
  });

  /**
   * Auth's own database fails on the repair's FIRST cache read, of this target Platform (after the proof is consumed); every other
   * statement is real. The id filter pins it to that read, not to the cached-Platform read of an Organization repair, which shares the text.
   */
  const failCacheRead = (id: string, alsoLocalAudit = false) => {
    const real = s.t.dbs.query.bind(s.t.dbs);
    return vi.spyOn(s.t.dbs, 'query').mockImplementation(((sql: string, params?: unknown[]) => {
      if (sql.startsWith('SELECT "companyId" AS company FROM platform WHERE id = $1') && (params as unknown[])?.[0] === id) return Promise.reject(new Error('Connection terminated unexpectedly'));
      if (alsoLocalAudit && sql.includes('INSERT INTO auth_audit_event')) return Promise.reject(new Error('Connection terminated unexpectedly'));
      return real(sql, params);
    }) as never);
  };

  it('Auth\'s own database fails after the proof is consumed: 503; proof consumed; nothing placed; a local failure record (auth_database_unavailable) and the warning; no central record', async () => {
    const p = platform();
    org.put('platforms', p);
    const before = await s.repairOutbox();
    const su = await s.proof();
    failCacheRead(p.id);
    const r = await s.repair(s.owner.tokens, 'platform', p.id, su);
    vi.restoreAllMocks();
    expect([r.status, r.body.code]).toEqual([503, 'hierarchy_unavailable']);
    expect(await s.consumed(su)).toBe(true);
    expect(await s.rowExists('platform', p.id)).toBe(false);
    expect(await s.repairOutbox()).toBe(before); // no central denial, no invented action
    expect(await s.local('hierarchy.reference_repair.failed', p.id)).toEqual([expect.objectContaining({ outcome: 'failure', actorId: s.owner.id, metadata: { kind: 'platform', reason: 'auth_database_unavailable' } })]);
    expect(s.t.logger.lines.some((l) => l.includes(`hierarchy_reference_repair_failed kind=platform id=${p.id} reason=auth_database_unavailable`))).toBe(true);
  });

  it('...and when the local record cannot be written either: still 503, the warning is still emitted, and the failed audit write is logged', async () => {
    const p = platform();
    org.put('platforms', p);
    const su = await s.proof();
    failCacheRead(p.id, true);
    const r = await s.repair(s.owner.tokens, 'platform', p.id, su);
    vi.restoreAllMocks();
    expect(r.status).toBe(503);
    expect(await s.consumed(su)).toBe(true);
    expect(await s.local('hierarchy.reference_repair.failed', p.id)).toEqual([]);
    expect(s.t.logger.lines.some((l) => l.includes(`hierarchy_reference_repair_failed kind=platform id=${p.id} reason=auth_database_unavailable`))).toBe(true);
    expect(s.t.logger.lines.some((l) => l.includes('failed to record audit event hierarchy.reference_repair.failed'))).toBe(true);
  });

  it('a hierarchy failure keeps its own reason: an authority failure is NOT relabelled auth_database_unavailable', async () => {
    const id = randomUUID();
    org.fail('platforms', id, 503);
    await s.repair(s.owner.tokens, 'platform', id, await s.proof()).expect(503);
    expect((await s.local('hierarchy.reference_repair.failed', id)).map((x) => x.metadata.reason)).toEqual(['authority_unavailable']);
  });

  it('the success record cannot be written: 503; the placement rolls back; the proof stays consumed; a local failure record', async () => {
    const p = platform();
    org.put('platforms', p);
    const central = s.t.app.get(CentralAudit);
    const real = central.write.bind(central);
    vi.spyOn(central, 'write').mockImplementation((async (q: never, input: { action: string }) => {
      if (input.action === 'hierarchy.reference_repaired') throw new Error('the outbox is unavailable');
      return real(q, input as never);
    }) as never);
    const su = await s.proof();
    expect((await s.repair(s.owner.tokens, 'platform', p.id, su)).status).toBe(503);
    expect(await s.rowExists('platform', p.id)).toBe(false);
    expect(await s.consumed(su)).toBe(true);
    expect(await s.local('hierarchy.reference_repair.failed', p.id)).toEqual([expect.objectContaining({ metadata: { kind: 'platform', reason: 'audit_intent_unwritable' } })]);
  });

  it('a denial whose central write fails still answers 403, and leaves the local denial record (ADR-0064 D4)', async () => {
    const central = s.t.app.get(CentralAudit);
    vi.spyOn(central, 'write').mockRejectedValue(new Error('the outbox is unavailable'));
    const tokens = await s.memberTokens();
    await s.repair(tokens, 'platform', s.w.platformSchool).expect(403);
    expect((await s.local('hierarchy.reference_repair.denied', s.w.platformSchool)).at(-1)).toMatchObject({ outcome: 'denied', metadata: { kind: 'platform', reason: 'no_authority' } });
  });

  it('first-touch ensure is unchanged: a join code on a never-seen Organization still places it, and writes no repair record', async () => {
    const p = platform();
    const o = organization(p.id);
    org.put('platforms', p);
    org.put('organizations', o);
    const before = await s.repairOutbox();
    await s.t.http.post(`/auth/organizations/${o.id}/join-codes`).set(bearer(s.owner.tokens)).set('X-Step-Up-Token', await s.t.stepUpToken(s.owner.tokens, 'join_code.create', s.owner.totpSecret))
      .send({ audience: 'student', requiresApproval: false, requiresSubscription: false }).expect(201);
    expect(await s.rowExists('organization', o.id)).toBe(true);
    expect(await s.repairOutbox()).toBe(before);
  });
});

describe('A5.4-A3 slice C: the repair rate limits (O9), counted only once the repair is eligible', () => {
  const org = standIn();
  let s: Awaited<ReturnType<typeof setup>>;
  let other: Awaited<ReturnType<TestCtx['readyOwner']>>;
  beforeAll(async () => {
    await new Promise<void>((r) => org.server.listen(0, '127.0.0.1', r));
    s = await setup(org, { RATE_REFERENCE_REPAIR_OWNER_LIMIT: '2', RATE_REFERENCE_REPAIR_IP_LIMIT: '3' });
    other = await s.t.readyOwner(await s.t.newCompany(), `own${uniq()}@a.test`); // a second Company exists before the authority switch
    await retireWrites(s.t.dbs, 'test-operator', 'test activation evidence', { fresh: true });
  });
  afterAll(async () => {
    await s?.t.close();
    await new Promise<void>((r) => org.server.close(() => r()));
  });

  it('per Owner: the third attempt is 429 and its proof is not consumed; per address: the next Owner from the same address is refused too', async () => {
    for (let i = 0; i < 2; i += 1) expect((await s.repair(s.owner.tokens, 'platform', randomUUID(), await s.proof())).status).toBe(404);
    const su = await s.proof();
    const r = await s.repair(s.owner.tokens, 'platform', randomUUID(), su);
    expect([r.status, r.body.code]).toEqual([429, 'rate_limited']);
    expect(await s.consumed(su)).toBe(false);
    // the address bucket (limit 3) holds two hits so far: the Owner bucket refused the third attempt before the address was counted.
    // Another Owner from the same address gets one more attempt, then the address limit refuses it, whatever its own count.
    expect((await s.repair(other.tokens, 'platform', randomUUID(), await s.t.stepUpToken(other.tokens, PURPOSE, other.totpSecret))).status).toBe(404);
    const su2 = await s.t.stepUpToken(other.tokens, PURPOSE, other.totpSecret);
    const refused = await s.repair(other.tokens, 'platform', randomUUID(), su2);
    expect([refused.status, refused.body.code]).toEqual([429, 'rate_limited']);
    expect(await s.consumed(su2)).toBe(false);
  });
});

describe('A5.4-A3 slice C: repair while the hierarchy is frozen (marker frozen; the frozen evidence policy of §11.6)', () => {
  const org = standIn();
  let s: Awaited<ReturnType<typeof setup>>;
  beforeAll(async () => {
    await new Promise<void>((r) => org.server.listen(0, '127.0.0.1', r));
    s = await setup(org);
    await freeze(s.t.dbs, 'test-operator');
  });
  afterAll(async () => {
    await s?.t.close();
    await new Promise<void>((r) => org.server.close(() => r()));
  });

  it('a cached and authorized target: 200 placed false; the proof consumed; the success record; no hierarchy write', async () => {
    const before = await s.hierarchyCounts();
    const su = await s.proof();
    const r = await s.repair(s.owner.tokens, 'platform', s.w.platformSchool, su).expect(200);
    expect(r.body).toEqual({ kind: 'platform', id: s.w.platformSchool, placed: false });
    expect(await s.consumed(su)).toBe(true);
    expect(await s.hierarchyCounts()).toEqual(before);
    const [rec] = await s.central('hierarchy.reference_repaired', s.w.platformSchool);
    s.valid(rec!);
    expect(rec).toMatchObject({ changes: { placed: false }, outcome: 'succeeded' });
  });

  it('an uncached target: the database refuses the placement: 503; proof consumed; no row; a local failure record (placement_refused) and the warning; no central record', async () => {
    const p = { id: randomUUID(), companyId: s.w.companyA, name: 'Remote', key: null };
    org.put('platforms', p);
    const before = await s.repairOutbox();
    const su = await s.proof();
    expect((await s.repair(s.owner.tokens, 'platform', p.id, su)).status).toBe(503);
    expect(await s.consumed(su)).toBe(true);
    expect(await s.rowExists('platform', p.id)).toBe(false);
    expect(await s.repairOutbox()).toBe(before);
    expect(await s.local('hierarchy.reference_repair.failed', p.id)).toEqual([expect.objectContaining({ metadata: { kind: 'platform', reason: 'placement_refused' } })]);
    expect(s.t.logger.lines.some((l) => l.includes(`hierarchy_reference_repair_failed kind=platform id=${p.id} reason=placement_refused`))).toBe(true);
  });

  it('an unresolved target: the collapsed 404; proof consumed; the central unresolved record', async () => {
    const id = randomUUID();
    const su = await s.proof();
    await s.repair(s.owner.tokens, 'organization', id, su).expect(404);
    expect(await s.consumed(su)).toBe(true);
    expect(await s.central('hierarchy.reference_repair_unresolved', id)).toHaveLength(1);
  });

  it('a rejected proof: 403; not consumed; NO repair denial record', async () => {
    const before = await s.repairOutbox();
    const r = await s.repair(s.owner.tokens, 'platform', s.w.platformSchool, randomUUID());
    expect([r.status, r.body.code]).toEqual([403, 'step_up_required']);
    expect(await s.repairOutbox()).toBe(before);
    expect(await s.local('hierarchy.reference_repair.denied', s.w.platformSchool)).toEqual([]);
  });

  it('a non-Owner: 403; NO repair record, central or local', async () => {
    const before = await s.repairOutbox();
    const localBefore = (await s.local('hierarchy.reference_repair.denied')).length;
    await s.repair(await s.memberTokens(), 'platform', s.w.platformSchool).expect(403);
    expect(await s.repairOutbox()).toBe(before);
    expect((await s.local('hierarchy.reference_repair.denied')).length).toBe(localBefore);
  });
});

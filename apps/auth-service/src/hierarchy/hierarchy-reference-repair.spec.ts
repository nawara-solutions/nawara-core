import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger, type LoggerService } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import type { DbService, Queryable } from '../db/db.service.js';
import { HierarchyReference, OrganizationDirectoryClient, hierarchyUnavailable, type HierarchyKind, type ReferenceRepairSteps } from './hierarchy-reference.js';

/**
 * A5.4-A3 slice B (ADR-0061 §4 steps 4 to 7; the A3 design §4 and §11.1 O4, O5, §11.5 O6, O13): `HierarchyReference.repairReference`.
 *
 * The entry resolves without writing, lets its caller authorize the Company, and only then places, with the caller's record in the same
 * transaction. It has NO caller yet (the repair service is slice C), so this spec drives it with an in-memory database that keeps the
 * order of everything that happens: reads, Organization Service calls, the caller's two steps, the transaction and its outcome.
 *
 * What a fake cannot prove (real `ON CONFLICT`, real row locks, the database guard of migration 0008) is left to slice C's
 * integration tests against PostgreSQL; `ensure` itself stays covered, unchanged, by test/hierarchy-ensure-trace.spec.ts.
 */
const ID = {
  company: '11111111-1111-4111-8111-111111111111',
  platform: '22222222-2222-4222-8222-222222222222',
  organization: '33333333-3333-4333-8333-333333333333',
  otherCompany: '44444444-4444-4444-8444-444444444444',
};
const company = { id: ID.company, name: 'Company A' };
const platform = { id: ID.platform, companyId: ID.company, name: 'Platform A', key: 'platform-a' };
const organization = { id: ID.organization, platformId: ID.platform, name: 'Organization A' };
const all = { company, platform, organization };

type Row = Record<string, unknown>;
type Tables = Record<HierarchyKind, Map<string, Row>>;
type Event = string;
interface World {
  cached?: Partial<Record<HierarchyKind, Row[]>>;
  authority?: Partial<Record<HierarchyKind, Row>>;
  /** A row another transaction committed just before the placement transaction began. */
  racedIn?: Partial<Record<HierarchyKind, Row>>;
  frozen?: boolean;
  noClient?: boolean;
  source?: 'local' | 'organization-service';
  authorize?: (companyId: string) => boolean;
  recordFails?: boolean;
  /** A client that fails without a recorded cause (as a stand-in client would). */
  clientThrows?: HierarchyKind;
}

function world(w: World) {
  const events: Event[] = [];
  const tables: Tables = { company: new Map(), platform: new Map(), organization: new Map() };
  for (const kind of ['company', 'platform', 'organization'] as const) for (const r of w.cached?.[kind] ?? []) tables[kind].set(r.id as string, { ...r });
  const result = (rows: Row[], rowCount = rows.length) => ({ rows, rowCount }) as never;

  const run = (staged: Tables | null, where: 'db' | 'tx', sql: string, params: unknown[]) => {
    events.push(`${where}: ${sql.replace(/\s+/g, ' ').slice(0, 60)}`);
    const read = (kind: HierarchyKind, id: string) => staged?.[kind].get(id) ?? tables[kind].get(id);
    let m: RegExpMatchArray | null;
    if ((m = sql.match(/^SELECT 1 FROM (\w+) WHERE id = \$1$/))) return result(read(m[1] as HierarchyKind, params[0] as string) ? [{}] : []);
    if (sql === `SELECT "companyId" AS company FROM platform WHERE id = $1`) {
      const p = read('platform', params[0] as string);
      return result(p ? [{ company: p.companyId }] : []);
    }
    if (sql.startsWith('SELECT p."companyId" AS company FROM organization o JOIN platform p')) {
      const o = read('organization', params[0] as string);
      const p = o && read('platform', o.platformId as string);
      return result(p ? [{ company: p.companyId }] : []);
    }
    if (sql.startsWith(`SELECT set_config('nawara.reference_write'`)) return result([{}]);
    if ((m = sql.match(/^INSERT INTO (\w+) \(([^)]*)\) VALUES/))) {
      if (!staged) throw new Error('an INSERT outside a transaction');
      if (w.frozen) throw new Error('the hierarchy is frozen for the ownership transition');
      const kind = m[1] as HierarchyKind;
      const columns = m[2]!.split(',').map((c) => c.trim().replaceAll('"', ''));
      if (read(kind, params[0] as string)) return result([], 0); // ON CONFLICT (id) DO NOTHING
      staged[kind].set(params[0] as string, Object.fromEntries(columns.map((c, i) => [c, params[i]])));
      return result([], 1);
    }
    if ((m = sql.match(/^SELECT "(\w+)" AS anchor FROM (\w+) WHERE id = \$1$/))) {
      const row = read(m[2] as HierarchyKind, params[0] as string);
      return result(row ? [{ anchor: row[m[1]!] }] : []);
    }
    throw new Error(`unexpected SQL: ${sql}`);
  };

  const db = {
    query: async (sql: string, params: unknown[] = []) => run(null, 'db', sql, params),
    tx: async <T>(fn: (q: Queryable) => Promise<T>): Promise<T> => {
      events.push('tx begin');
      for (const kind of ['company', 'platform', 'organization'] as const) {
        const r = w.racedIn?.[kind];
        if (r && !tables[kind].has(r.id as string)) tables[kind].set(r.id as string, { ...r });
      }
      const staged: Tables = { company: new Map(), platform: new Map(), organization: new Map() };
      try {
        const out = await fn({ query: async (sql: string, params: unknown[] = []) => run(staged, 'tx', sql, params) } as unknown as Queryable);
        for (const kind of ['company', 'platform', 'organization'] as const) for (const [id, r] of staged[kind]) tables[kind].set(id, r);
        events.push('tx commit');
        return out;
      } catch (e) {
        events.push('tx rollback');
        throw e;
      }
    },
  };
  const client = w.noClient ? null : {
    get: async (kind: HierarchyKind, id: string) => {
      events.push(`call ${kind}`);
      if (w.clientThrows === kind) throw hierarchyUnavailable();
      const row = w.authority?.[kind];
      return row && row.id === id ? { ...row } : null;
    },
  };
  const steps: ReferenceRepairSteps = {
    authorize: (companyId) => {
      events.push(`authorize ${companyId}`);
      return (w.authorize ?? (() => true))(companyId);
    },
    record: async (_q, result) => {
      events.push(`record placed=${result.placed}`);
      if (w.recordFails) throw new Error('the outbox is unavailable');
    },
  };
  const logs: string[] = [];
  const recorder: LoggerService = { log: (m) => { logs.push(`log:${String(m)}`); }, warn: (m) => { logs.push(`warn:${String(m)}`); }, error: (m) => { logs.push(`error:${String(m)}`); } };
  Logger.overrideLogger(recorder);
  const cfg = { hierarchy: { source: w.source ?? 'organization-service' } } as unknown as AppConfig;
  const ref = new HierarchyReference(db as unknown as DbService, cfg, client as unknown as OrganizationDirectoryClient | null);
  const has = (kind: HierarchyKind, id: string) => tables[kind].has(id);
  const inTx = () => events.slice(events.indexOf('tx begin') + 1).filter((e) => !e.startsWith('tx '));
  return { ref, steps, events, logs, has, inTx, calls: () => events.filter((e) => e.startsWith('call ')), writes: () => events.filter((e) => e.includes('INSERT')) };
}

afterEach(() => {
  Logger.overrideLogger(false);
  vi.unstubAllGlobals();
});

describe('A5.4-A3 slice B: repairReference, a target already cached', () => {
  it('a cached Platform, authorized: repaired, placed false; no Organization Service call; the transaction holds only the caller record', async () => {
    const w = world({ cached: { company: [company], platform: [platform] }, authority: all });
    expect(await w.ref.repairReference('platform', ID.platform, w.steps)).toEqual({ outcome: 'repaired', placed: false });
    expect(w.calls()).toEqual([]);
    expect(w.events).toEqual([
      'db: SELECT "companyId" AS company FROM platform WHERE id = $1',
      `authorize ${ID.company}`,
      'tx begin', 'record placed=false', 'tx commit',
    ]);
    expect(w.writes()).toEqual([]); // no reference statement, no write gate
  });

  it('a cached Organization: its Company comes through its own links (organization -> platform -> company)', async () => {
    const w = world({ cached: { company: [company], platform: [platform], organization: [organization] }, authority: all });
    expect(await w.ref.repairReference('organization', ID.organization, w.steps)).toEqual({ outcome: 'repaired', placed: false });
    expect(w.events[1]).toBe(`authorize ${ID.company}`);
    expect(w.calls()).toEqual([]);
  });

  it('a cached target of ANOTHER Company: unresolved; no call, no transaction, no record', async () => {
    const w = world({ cached: { company: [company], platform: [platform] }, authority: all, authorize: (c) => c === ID.otherCompany });
    expect(await w.ref.repairReference('platform', ID.platform, w.steps)).toEqual({ outcome: 'unresolved' });
    expect(w.events).toEqual(['db: SELECT "companyId" AS company FROM platform WHERE id = $1', `authorize ${ID.company}`]);
  });

  it('a cached target whose record cannot be written: failed audit_intent_unwritable, rolled back', async () => {
    const w = world({ cached: { company: [company], platform: [platform] }, recordFails: true });
    expect(await w.ref.repairReference('platform', ID.platform, w.steps)).toEqual({ outcome: 'failed', reason: 'audit_intent_unwritable' });
    expect(w.events.slice(-3)).toEqual(['tx begin', 'record placed=false', 'tx rollback']);
  });
});

describe('A5.4-A3 slice B: repairReference, resolving and placing', () => {
  it('a target Organization Service does not show: unresolved; authorize is never asked and nothing is written', async () => {
    const w = world({ authority: {} });
    expect(await w.ref.repairReference('organization', ID.organization, w.steps)).toEqual({ outcome: 'unresolved' });
    expect(w.calls()).toEqual(['call organization']);
    expect(w.events.some((e) => e.startsWith('authorize') || e.startsWith('tx') || e.startsWith('record'))).toBe(false);
  });

  it('an uncached Organization, nothing cached: authorize BEFORE any write; then one transaction: gate, Company, Platform, Organization, record; placed true', async () => {
    const w = world({ authority: all });
    expect(await w.ref.repairReference('organization', ID.organization, w.steps)).toEqual({ outcome: 'repaired', placed: true });
    expect(w.calls()).toEqual(['call organization', 'call platform', 'call company']);
    const authorizedAt = w.events.indexOf(`authorize ${ID.company}`);
    expect(authorizedAt).toBeGreaterThan(-1);
    expect(w.events.slice(0, authorizedAt).some((e) => e.includes('INSERT') || e.startsWith('tx'))).toBe(false); // nothing placed before authorization
    expect(w.events.slice(authorizedAt + 1)[0]).toBe('tx begin');
    expect(w.inTx().map((e) => e.replace(/^tx: /, '').split(' ').slice(0, 3).join(' '))).toEqual([
      "SELECT set_config('nawara.reference_write', 'on',", 'INSERT INTO company', 'INSERT INTO platform', 'SELECT "companyId" AS', 'INSERT INTO organization', 'SELECT "platformId" AS', 'record placed=true',
    ]);
    expect(w.events.at(-1)).toBe('tx commit');
    expect([w.has('company', ID.company), w.has('platform', ID.platform), w.has('organization', ID.organization)]).toEqual([true, true, true]);
  });

  it('an uncached Platform whose Company is cached: one call, the Company from the authority row, the Platform placed', async () => {
    const w = world({ cached: { company: [company] }, authority: all });
    expect(await w.ref.repairReference('platform', ID.platform, w.steps)).toEqual({ outcome: 'repaired', placed: true });
    expect(w.calls()).toEqual(['call platform']);
    expect(w.events).toContain(`authorize ${ID.company}`);
    expect(w.writes()).toEqual([expect.stringMatching(/^tx: INSERT INTO platform /)]);
  });

  it('the Company is not the caller\'s: unresolved; resolved but NOTHING placed (no transaction, no parent, no record)', async () => {
    const w = world({ authority: all, authorize: () => false });
    expect(await w.ref.repairReference('organization', ID.organization, w.steps)).toEqual({ outcome: 'unresolved' });
    expect(w.events.some((e) => e.startsWith('tx') || e.startsWith('record'))).toBe(false);
    expect([w.has('company', ID.company), w.has('platform', ID.platform), w.has('organization', ID.organization)]).toEqual([false, false, false]);
  });

  it('only an explicit `true` authorizes: a truthy value that is not `true` places nothing (cached and uncached targets)', async () => {
    for (const answer of ['yes', 1, {}, [], Promise.resolve('yes')]) {
      const uncached = world({ authority: all });
      uncached.steps.authorize = () => answer as never;
      expect(await uncached.ref.repairReference('organization', ID.organization, uncached.steps)).toEqual({ outcome: 'unresolved' });
      expect(uncached.events.some((e) => e.startsWith('tx') || e.startsWith('record'))).toBe(false);
      const cached = world({ cached: { company: [company], platform: [platform] }, authority: all });
      cached.steps.authorize = () => answer as never;
      expect(await cached.ref.repairReference('platform', ID.platform, cached.steps)).toEqual({ outcome: 'unresolved' });
      expect(cached.events.some((e) => e.startsWith('tx') || e.startsWith('record'))).toBe(false);
    }
  });

  it('unknown and not-authorized give the SAME result value', async () => {
    const unknown = await world({ authority: {} }).ref.repairReference('platform', ID.platform, world({}).steps);
    const foreign = world({ authority: all, authorize: () => false });
    expect(await foreign.ref.repairReference('platform', ID.platform, foreign.steps)).toEqual(unknown);
  });
});

describe('A5.4-A3 slice B: repairReference, the cached-ancestor comparison (O5)', () => {
  it('an uncached Organization under a cached Platform: that Platform is fetched too; links agree; only the Organization is placed', async () => {
    const w = world({ cached: { company: [company], platform: [platform] }, authority: all });
    expect(await w.ref.repairReference('organization', ID.organization, w.steps)).toEqual({ outcome: 'repaired', placed: true });
    expect(w.calls()).toEqual(['call organization', 'call platform']); // one extra call, never the Company
    expect(w.events).toContain(`authorize ${ID.company}`);
    expect(w.writes()).toEqual([expect.stringMatching(/^tx: INSERT INTO organization /)]);
  });

  it('the cached Platform is NOT shown by the authority: failed parent_missing; no authorize, no transaction, no mismatch log', async () => {
    const w = world({ cached: { company: [company], platform: [platform] }, authority: { organization } });
    expect(await w.ref.repairReference('organization', ID.organization, w.steps)).toEqual({ outcome: 'failed', reason: 'parent_missing' });
    expect(w.events.some((e) => e.startsWith('authorize') || e.startsWith('tx'))).toBe(false);
    expect(w.logs.some((l) => l.includes('hierarchy_anchor_mismatch'))).toBe(false);
  });

  it('the cached Platform link DISAGREES with the authority: anchor_mismatch at that Platform; alert logged; nothing asked, nothing placed, nothing overwritten', async () => {
    const w = world({ cached: { company: [company], platform: [{ ...platform, companyId: ID.otherCompany }] }, authority: all });
    expect(await w.ref.repairReference('organization', ID.organization, w.steps)).toEqual({ outcome: 'anchor_mismatch', at: { kind: 'platform', id: ID.platform } });
    expect(w.logs).toEqual([`error:hierarchy_anchor_mismatch kind=platform id=${ID.platform} — the cached anchor disagrees with Organization Service; nothing was changed`]);
    expect(w.events.some((e) => e.startsWith('authorize') || e.startsWith('tx'))).toBe(false);
    expect(w.has('organization', ID.organization)).toBe(false);
  });

  it('`ensure` is untouched by it: with the same disagreeing cache, ensure still stops at the cached Platform and places the Organization', async () => {
    const w = world({ cached: { company: [company], platform: [{ ...platform, companyId: ID.otherCompany }] }, authority: all });
    expect(await w.ref.ensure('organization', ID.organization)).toBe(true);
    expect(w.calls()).toEqual(['call organization']); // no extra call, no comparison: exactly as before
  });
});

describe('A5.4-A3 slice B: repairReference, placement outcomes', () => {
  it('a concurrent placement of the SAME target just before the transaction: repaired, placed false (the insert outcome decides), record placed=false', async () => {
    const w = world({ cached: { company: [company] }, authority: all, racedIn: { platform } });
    expect(await w.ref.repairReference('platform', ID.platform, w.steps)).toEqual({ outcome: 'repaired', placed: false });
    expect(w.events.slice(-2)).toEqual(['record placed=false', 'tx commit']);
  });

  it('only a PARENT is inserted (the target was placed concurrently): placed false, although this call wrote a row', async () => {
    const w = world({ authority: all, racedIn: { platform } });
    expect(await w.ref.repairReference('platform', ID.platform, w.steps)).toEqual({ outcome: 'repaired', placed: false });
    expect(w.writes()).toHaveLength(2); // the Company insert took effect, the Platform insert did not
    expect(w.has('company', ID.company)).toBe(true);
    expect(w.events).toContain('record placed=false');
  });

  it('a conflicting row with ANOTHER parent appears: anchor_mismatch at that entity; rolled back; the record step never runs', async () => {
    const w = world({ cached: { company: [company] }, authority: all, racedIn: { platform: { ...platform, companyId: ID.otherCompany } } });
    expect(await w.ref.repairReference('organization', ID.organization, w.steps)).toEqual({ outcome: 'anchor_mismatch', at: { kind: 'platform', id: ID.platform } });
    expect(w.events.at(-1)).toBe('tx rollback');
    expect(w.events.some((e) => e.startsWith('record'))).toBe(false);
    expect(w.logs.filter((l) => l.startsWith('error:hierarchy_anchor_mismatch kind=platform'))).toHaveLength(1);
    expect(w.has('organization', ID.organization)).toBe(false);
  });

  it('the database refuses the reference write (frozen): failed placement_refused; rolled back; no record', async () => {
    const w = world({ authority: all, frozen: true });
    expect(await w.ref.repairReference('organization', ID.organization, w.steps)).toEqual({ outcome: 'failed', reason: 'placement_refused' });
    expect(w.events.at(-1)).toBe('tx rollback');
    expect(w.events.some((e) => e.startsWith('record'))).toBe(false);
  });

  it('the caller record cannot be written: failed audit_intent_unwritable; the placement is rolled back with it', async () => {
    const w = world({ authority: all, recordFails: true });
    expect(await w.ref.repairReference('organization', ID.organization, w.steps)).toEqual({ outcome: 'failed', reason: 'audit_intent_unwritable' });
    expect(w.events.slice(-2)).toEqual(['record placed=true', 'tx rollback']);
    expect([w.has('company', ID.company), w.has('platform', ID.platform), w.has('organization', ID.organization)]).toEqual([false, false, false]);
  });
});

describe('A5.4-A3 slice B: repairReference, failure causes (O6)', () => {
  it('a parent the authority does not show: failed parent_missing; nothing placed', async () => {
    const w = world({ authority: { organization } });
    expect(await w.ref.repairReference('organization', ID.organization, w.steps)).toEqual({ outcome: 'failed', reason: 'parent_missing' });
    expect(w.events.some((e) => e.startsWith('authorize') || e.startsWith('tx'))).toBe(false);
  });

  it('no Organization Service credential: failed credential_missing, after the local read and before any call', async () => {
    const w = world({ noClient: true });
    expect(await w.ref.repairReference('platform', ID.platform, w.steps)).toEqual({ outcome: 'failed', reason: 'credential_missing' });
    expect(w.events).toEqual(['db: SELECT "companyId" AS company FROM platform WHERE id = $1']);
  });

  it('a client failure with no recorded cause: failed authority_unavailable', async () => {
    const w = world({ authority: all, clientThrows: 'platform' });
    expect(await w.ref.repairReference('organization', ID.organization, w.steps)).toEqual({ outcome: 'failed', reason: 'authority_unavailable' });
  });

  /** The REAL hardened client, with the network replaced: its own failure words become the repair reasons. */
  const viaRealClient = async (fetchImpl: (url: string, init: { signal: AbortSignal }) => Promise<Response>) => {
    vi.stubGlobal('fetch', fetchImpl);
    const w = world({});
    const real = new OrganizationDirectoryClient({ baseUrl: 'http://organization.invalid', token: 'x'.repeat(40), timeoutMs: 50 });
    const ref = new HierarchyReference((w.ref as unknown as { db: DbService }).db, { hierarchy: { source: 'organization-service' } } as unknown as AppConfig, real);
    return { result: await ref.repairReference('platform', ID.platform, w.steps), w };
  };
  const answer = (status: number, body = '', headers: Record<string, string> = {}) => async () => new Response(status === 204 ? null : body, { status, headers });

  it.each([
    ['the network fails', async () => { throw new TypeError('fetch failed'); }, 'authority_unavailable'],
    ['the deadline passes', (_u: string, init: { signal: AbortSignal }) => new Promise<Response>((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))), 'authority_timeout'],
    ['a redirect is refused', answer(302, '', { location: 'http://elsewhere.invalid' }), 'authority_redirect'],
    ['the credential is refused (401)', answer(401), 'credential_refused'],
    ['the capability is refused (403)', answer(403), 'credential_refused'],
    ['the authority is not authoritative (409)', answer(409), 'authority_unavailable'],
    ['the authority fails (500)', answer(500), 'authority_unavailable'],
    ['the answer is malformed', answer(200, 'not json'), 'authority_response_invalid'],
    ['the answer is another entity', answer(200, JSON.stringify({ id: ID.otherCompany, name: 'x', companyId: ID.company })), 'authority_response_invalid'],
    ['the answer is oversized', answer(200, '{}', { 'content-length': String(10 * 1024 * 1024) }), 'authority_response_invalid'],
  ])('%s -> failed %s', async (_name, fetchImpl, reason) => {
    const { result, w } = await viaRealClient(fetchImpl as never);
    expect(result).toEqual({ outcome: 'failed', reason });
    expect(w.events.some((e) => e.startsWith('authorize') || e.startsWith('tx'))).toBe(false);
  });

  it('the real client says "not there" (404): unresolved', async () => {
    expect((await viaRealClient(answer(404))).result).toEqual({ outcome: 'unresolved' });
  });

  it('a failure that is not a hierarchy failure (Auth\'s own database) is not classified: it propagates', async () => {
    const w = world({ authority: all });
    const db = (w.ref as unknown as { db: { query: (sql: string, p?: unknown[]) => Promise<unknown> } }).db;
    const real = db.query.bind(db);
    db.query = async (sql: string, p?: unknown[]) => {
      if (sql.startsWith('SELECT 1 FROM platform')) throw new Error('connection refused');
      return real(sql, p);
    };
    await expect(w.ref.repairReference('organization', ID.organization, w.steps)).rejects.toThrow('connection refused');
  });
});

describe('A5.4-A3 slice B: repairReference, guards and boundaries', () => {
  it('with the configured source `local` it does nothing at all: unresolved, no read, no call, no step', async () => {
    const w = world({ source: 'local', cached: { company: [company], platform: [platform] }, authority: all });
    expect(await w.ref.repairReference('platform', ID.platform, w.steps)).toEqual({ outcome: 'unresolved' });
    expect(w.events).toEqual([]);
  });

  it('a malformed id: unresolved, no read, no call; an uppercase id is the same entity', async () => {
    const w = world({ authority: all });
    expect(await w.ref.repairReference('platform', 'not-a-uuid', w.steps)).toEqual({ outcome: 'unresolved' });
    expect(w.events).toEqual([]);
    expect(await w.ref.repairReference('platform', ID.platform.toUpperCase(), w.steps)).toEqual({ outcome: 'repaired', placed: true });
    expect(w.has('platform', ID.platform)).toBe(true);
  });

  it('it never goes through `ensure`, and resolve and placeChain stay private steps of `ensure` only', async () => {
    const w = world({ authority: all });
    const ensure = vi.spyOn(w.ref, 'ensure');
    const placeChain = vi.spyOn(w.ref as unknown as { placeChain: (...a: unknown[]) => Promise<void> }, 'placeChain');
    await w.ref.repairReference('organization', ID.organization, w.steps);
    expect(ensure).not.toHaveBeenCalled();
    expect(placeChain).not.toHaveBeenCalled(); // the repair places inside its OWN transaction, with the caller's record
  });

  const src = join(dirname(fileURLToPath(import.meta.url)), '..');
  const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });

  it('nothing calls it yet: `repairReference` is named in hierarchy-reference.ts only (no route, no service, no caller)', () => {
    const named = sources(src).filter((path) => readFileSync(path, 'utf8').includes('repairReference'));
    expect(named.map((path) => path.slice(src.length + 1))).toEqual(['hierarchy/hierarchy-reference.ts']);
  });

  it('the module writes no audit record of its own: no central writer, no local audit, no outbox', () => {
    const text = readFileSync(join(src, 'hierarchy/hierarchy-reference.ts'), 'utf8');
    for (const forbidden of ['CentralAudit', 'AuditService', 'central.write', 'outbox', 'auth_audit_event']) expect(text.includes(forbidden), forbidden).toBe(false);
    expect(/export (async )?(function|const|class) (resolve|placeChain)\b/.test(text)).toBe(false);
    expect(text).toMatch(/private async resolve\(/);
    expect(text).toMatch(/private async placeChain\(/);
  });
});

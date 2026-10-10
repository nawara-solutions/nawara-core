import { Logger, type LoggerService } from '@nestjs/common';
import type { AppConfig } from '../../src/config/app-config.js';
import type { DbService, Queryable } from '../../src/db/db.service.js';
import { HierarchyReference, hierarchyUnavailable, type HierarchyKind, type OrganizationDirectoryClient } from '../../src/hierarchy/hierarchy-reference.js';

/**
 * A5.4-A2 (docs/architecture/core-v2-a5-4-a2-ensure-split-design.md §5.1): a deterministic trace of `HierarchyReference.ensure`.
 *
 * The fake database and the fake Organization Service client record, in order, every client call, every SQL statement (text and
 * parameters), every transaction open, commit and rollback, every logger call with its LEVEL, and the final outcome. Inputs are fixed
 * (fixed UUIDs, scripted answers), so a trace is fully deterministic. The same harness runs unchanged against `main` and against the
 * refactor: the golden fixture (test/fixtures/hierarchy-ensure-trace.main.json) was recorded from `main` before `ensure` was split.
 *
 * The fake `tx` models BEGIN / COMMIT / ROLLBACK itself (the real ones live in DbService), so a trace proves ordering and statements;
 * real transaction semantics stay proven by the integration suites. No production code is changed for any of this.
 */
export type TraceEvent =
  | { t: 'call'; kind: HierarchyKind; id: string }
  | { t: 'sql'; where: 'db' | 'tx'; sql: string; params: unknown[] }
  | { t: 'tx'; event: 'begin' | 'commit' | 'rollback' }
  | { t: 'log'; level: 'log' | 'warn' | 'error'; message: string }
  | { t: 'outcome'; returned?: boolean; thrown?: { status: number; code: string } | { error: string } };

export const IDS = {
  company: '11111111-1111-4111-8111-111111111111',
  platform: '22222222-2222-4222-8222-222222222222',
  organization: '33333333-3333-4333-8333-333333333333',
  otherCompany: '44444444-4444-4444-8444-444444444444',
  otherPlatform: '55555555-5555-4555-8555-555555555555',
} as const;

type Row = Record<string, unknown>;
type Tables = Record<HierarchyKind, Map<string, Row>>;

interface Scenario {
  /** Rows already in Auth's reference cache before the call. */
  cached?: Partial<Record<HierarchyKind, Row[]>>;
  /** What Organization Service answers per kind (absent = unknown there: the client returns null). */
  authority?: Partial<Record<HierarchyKind, Row>>;
  /** The client throws its 503 for these kinds (it has already logged its own reason; that log is not `ensure`'s). */
  clientFails?: HierarchyKind[];
  /** No Organization Service credential: the client is null. */
  noClient?: boolean;
  /** The hierarchy is frozen: the database refuses every reference insert. */
  frozen?: boolean;
  /** A row another transaction placed just before this one began (a concurrent first touch with ANOTHER parent). */
  racedIn?: Partial<Record<HierarchyKind, Row>>;
  /** The call(s): each is one `ensure`. */
  calls: Array<{ kind: HierarchyKind; id: string }>;
}

const company = { id: IDS.company, name: 'Company A' };
const platform = { id: IDS.platform, companyId: IDS.company, name: 'Platform A', key: 'platform-a' };
const organization = { id: IDS.organization, platformId: IDS.platform, name: 'Organization A' };
const all = { company, platform, organization };

/** The scenarios of the design's §5.3 that a fake database can express (12, concurrent first touches, is integration only). */
export const SCENARIOS: Record<string, Scenario> = {
  '01 malformed id': { authority: all, calls: [{ kind: 'organization', id: 'not-a-uuid' }] },
  '02 target cached': { cached: { organization: [organization] }, authority: all, calls: [{ kind: 'organization', id: IDS.organization }] },
  '03 no credential': { noClient: true, calls: [{ kind: 'organization', id: IDS.organization }] },
  '04 organization, nothing cached': { authority: all, calls: [{ kind: 'organization', id: IDS.organization }] },
  '05 organization, platform cached': { cached: { company: [company], platform: [platform] }, authority: all, calls: [{ kind: 'organization', id: IDS.organization }] },
  '06 platform, company cached': { cached: { company: [company] }, authority: all, calls: [{ kind: 'platform', id: IDS.platform }] },
  '07 target unknown to the authority': { authority: {}, calls: [{ kind: 'organization', id: IDS.organization }] },
  '08 parent missing at the authority': { authority: { organization }, calls: [{ kind: 'organization', id: IDS.organization }] },
  '09a client fails on the target': { authority: all, clientFails: ['organization'], calls: [{ kind: 'organization', id: IDS.organization }] },
  '09b client fails on a parent': { authority: all, clientFails: ['company'], calls: [{ kind: 'organization', id: IDS.organization }] },
  '10 anchor mismatch': {
    cached: { company: [company] }, authority: all,
    racedIn: { platform: { ...platform, companyId: IDS.otherCompany } },
    calls: [{ kind: 'organization', id: IDS.organization }],
  },
  '11a frozen, single row (company)': { authority: all, frozen: true, calls: [{ kind: 'company', id: IDS.company }] },
  '11b frozen, multi-row chain (organization target)': { authority: all, frozen: true, calls: [{ kind: 'organization', id: IDS.organization }] },
  '13 company placed once, then cached': { authority: all, calls: [{ kind: 'company', id: IDS.company }, { kind: 'company', id: IDS.company }] },
  '14 uppercase id is lowercased': { authority: all, calls: [{ kind: 'company', id: IDS.company.toUpperCase() }] },
};

const TABLE_OF: Array<[RegExp, HierarchyKind]> = [[/\bcompany\b/, 'company'], [/\bplatform\b/, 'platform'], [/\borganization\b/, 'organization']];
const tableOf = (fragment: string): HierarchyKind => TABLE_OF.find(([re]) => re.test(fragment))![1];

function result(rows: Row[]) {
  return { rows, rowCount: rows.length } as never;
}

/** Interprets the five statements `ensure` issues. Anything else is a harness error (the trace must never silently accept new SQL). */
function execute(tables: Tables, staged: Tables | null, s: Scenario, sql: string, params: unknown[]) {
  const read = (kind: HierarchyKind, id: string) => staged?.[kind].get(id) ?? tables[kind].get(id);
  let m: RegExpMatchArray | null;
  if ((m = sql.match(/^SELECT 1 FROM (\w+) WHERE id = \$1$/))) {
    return result(read(m[1] as HierarchyKind, params[0] as string) ? [{ '?column?': 1 }] : []);
  }
  if (/^SELECT set_config\('nawara\.reference_write', 'on', true\)$/.test(sql)) return result([{ set_config: 'on' }]);
  if ((m = sql.match(/^INSERT INTO (\w+) \(([^)]*)\) VALUES \([^)]*\) ON CONFLICT \(id\) DO NOTHING$/))) {
    if (!staged) throw new Error('harness: an INSERT outside a transaction');
    if (s.frozen) throw new Error('the hierarchy is frozen for the ownership transition');
    const kind = m[1] as HierarchyKind;
    const columns = m[2]!.split(',').map((c) => c.trim().replaceAll('"', ''));
    const id = params[0] as string;
    if (!read(kind, id)) staged[kind].set(id, Object.fromEntries(columns.map((c, i) => [c, params[i]])));
    return result([]);
  }
  if ((m = sql.match(/^SELECT "(\w+)" AS anchor FROM (\w+) WHERE id = \$1$/))) {
    const row = read(tableOf(m[2]!), params[0] as string);
    return result(row ? [{ anchor: row[m[1]!] }] : []);
  }
  throw new Error(`harness: unexpected SQL: ${sql}`);
}

/**
 * Runs one scenario against the CURRENT `HierarchyReference` and returns its trace. `mutate` exists only for the mutation tests: it
 * receives the instance before the calls so a test can plant a deliberate deviation and show that the trace then differs from the golden.
 */
export async function traceScenario(name: string, mutate?: (ref: HierarchyReference) => void): Promise<TraceEvent[]> {
  const s = SCENARIOS[name];
  if (!s) throw new Error(`unknown scenario ${name}`);
  const trace: TraceEvent[] = [];
  const tables: Tables = { company: new Map(), platform: new Map(), organization: new Map() };
  for (const kind of ['company', 'platform', 'organization'] as const) for (const r of s.cached?.[kind] ?? []) tables[kind].set(r.id as string, { ...r });

  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      trace.push({ t: 'sql', where: 'db', sql, params });
      return execute(tables, null, s, sql, params);
    },
    tx: async <T>(fn: (q: Queryable) => Promise<T>): Promise<T> => {
      trace.push({ t: 'tx', event: 'begin' });
      // A row another transaction committed just before this one began.
      for (const kind of ['company', 'platform', 'organization'] as const) {
        const r = s.racedIn?.[kind];
        if (r && !tables[kind].has(r.id as string)) tables[kind].set(r.id as string, { ...r });
      }
      const staged: Tables = { company: new Map(), platform: new Map(), organization: new Map() };
      const q = {
        query: async (sql: string, params: unknown[] = []) => {
          trace.push({ t: 'sql', where: 'tx', sql, params });
          return execute(tables, staged, s, sql, params);
        },
      } as unknown as Queryable;
      try {
        const out = await fn(q);
        for (const kind of ['company', 'platform', 'organization'] as const) for (const [id, r] of staged[kind]) tables[kind].set(id, r);
        trace.push({ t: 'tx', event: 'commit' });
        return out;
      } catch (e) {
        trace.push({ t: 'tx', event: 'rollback' });
        throw e;
      }
    },
  };

  const client = s.noClient ? null : {
    get: async (kind: HierarchyKind, id: string) => {
      trace.push({ t: 'call', kind, id });
      if (s.clientFails?.includes(kind)) throw hierarchyUnavailable();
      const row = s.authority?.[kind];
      return row && row.id === id ? { ...row } : null;
    },
  };

  const recorder: LoggerService = {
    log: (message: unknown) => { trace.push({ t: 'log', level: 'log', message: String(message) }); },
    warn: (message: unknown) => { trace.push({ t: 'log', level: 'warn', message: String(message) }); },
    error: (message: unknown) => { trace.push({ t: 'log', level: 'error', message: String(message) }); },
  };
  Logger.overrideLogger(recorder);
  try {
    const cfg = { hierarchy: { source: 'organization-service' } } as unknown as AppConfig;
    const ref = new HierarchyReference(db as unknown as DbService, cfg, client as unknown as OrganizationDirectoryClient | null);
    mutate?.(ref);
    for (const call of s.calls) {
      try {
        trace.push({ t: 'outcome', returned: await ref.ensure(call.kind, call.id) });
      } catch (e) {
        const http = e as { getStatus?: () => number; getResponse?: () => { code?: string } };
        trace.push({
          t: 'outcome',
          thrown: typeof http.getStatus === 'function' ? { status: http.getStatus(), code: String(http.getResponse?.().code) } : { error: String((e as Error).message) },
        });
      }
    }
  } finally {
    Logger.overrideLogger(false);
  }
  return trace;
}

/** Every scenario's trace, keyed by name (what the golden fixture holds). */
export async function traceAll(): Promise<Record<string, TraceEvent[]>> {
  const out: Record<string, TraceEvent[]> = {};
  for (const name of Object.keys(SCENARIOS)) out[name] = await traceScenario(name);
  return out;
}

/** Builds a HierarchyReference over inert fakes, for the structural tests that spy on its private steps. */
export function inertReference(over: { cachedIds?: string[]; authority?: Partial<Record<HierarchyKind, Row>> } = {}) {
  const statements: Array<{ where: 'db' | 'tx'; sql: string }> = [];
  const calls: Array<{ kind: HierarchyKind; id: string }> = [];
  const cached = new Set(over.cachedIds ?? []);
  const answer = (sql: string, params: unknown[]) => {
    if (sql.startsWith('SELECT 1 FROM')) return result(cached.has(params[0] as string) ? [{}] : []);
    const m = sql.match(/^SELECT "(\w+)" AS anchor FROM (\w+)/);
    if (m) return result([{ anchor: over.authority?.[tableOf(m[2]!)]?.[m[1]!] }]);
    return result([]);
  };
  let transactions = 0;
  const db = {
    query: async (sql: string, params: unknown[] = []) => { statements.push({ where: 'db', sql }); return answer(sql, params); },
    tx: async <T>(fn: (q: Queryable) => Promise<T>): Promise<T> => {
      transactions += 1;
      return fn({ query: async (sql: string, params: unknown[] = []) => { statements.push({ where: 'tx', sql }); return answer(sql, params); } } as unknown as Queryable);
    },
  };
  const client = { get: async (kind: HierarchyKind, id: string) => { calls.push({ kind, id }); const r = over.authority?.[kind]; return r && r.id === id ? { ...r } : null; } };
  const cfg = { hierarchy: { source: 'organization-service' } } as unknown as AppConfig;
  const ref = new HierarchyReference(db as unknown as DbService, cfg, client as unknown as OrganizationDirectoryClient);
  return { ref, statements, calls, transactions: () => transactions, rows: all };
}

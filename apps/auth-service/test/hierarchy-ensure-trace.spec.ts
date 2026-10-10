import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HierarchyReference } from '../src/hierarchy/hierarchy-reference.js';
import { IDS, SCENARIOS, inertReference, traceScenario, type TraceEvent } from './helpers/hierarchy-trace.js';

/**
 * A5.4-A2 (docs/architecture/core-v2-a5-4-a2-ensure-split-design.md §5.1): `HierarchyReference.ensure` was split into a read-only
 * resolve step and a place step, and nothing observable may change.
 *
 * GOLDEN is the trace of every scenario recorded from `main` (bb36ea3) BEFORE the split, with this same harness: each Organization
 * Service call, each SQL statement with its parameters, each transaction open / commit / rollback, each log call with its LEVEL, and the
 * outcome. It is never regenerated from the refactored code: a difference is a regression, not a fixture to refresh.
 */
const GOLDEN: Record<string, TraceEvent[]> = JSON.parse(readFileSync(new URL('./fixtures/hierarchy-ensure-trace.main.json', import.meta.url), 'utf8'));
const names = Object.keys(SCENARIOS);

describe('A5.4-A2 golden trace: ensure behaves exactly as on main', () => {
  it('the fixture covers exactly the harness scenarios', () => {
    expect(Object.keys(GOLDEN).sort()).toEqual([...names].sort());
  });

  it.each(names)('%s', async (name) => {
    expect(await traceScenario(name)).toEqual(GOLDEN[name]);
  });

  it('the fixture pins the properties the split must keep (they are not incidental)', () => {
    const calls = (n: string) => GOLDEN[n]!.filter((e) => e.t === 'call').map((e) => (e as { kind: string }).kind);
    const logs = (n: string) => GOLDEN[n]!.filter((e) => e.t === 'log').map((e) => `${(e as { level: string }).level}:${(e as { message: string }).message}`);
    // lookup order, and the stop at the first cached ancestor (a cached Platform is neither fetched nor compared)
    expect(calls('04 organization, nothing cached')).toEqual(['organization', 'platform', 'company']);
    expect(calls('05 organization, platform cached')).toEqual(['organization']);
    expect(calls('06 platform, company cached')).toEqual(['platform']);
    // the refused write names the TARGET's kind, even when the refused row is its Company
    expect(logs('11b frozen, multi-row chain (organization target)')).toEqual(['warn:hierarchy_reference_unavailable reason=reference_write_refused kind=organization']);
    expect(logs('11a frozen, single row (company)')).toEqual(['warn:hierarchy_reference_unavailable reason=reference_write_refused kind=company']);
    // levels: a missing parent and a missing credential warn; an anchor mismatch is an error
    expect(logs('08 parent missing at the authority')).toEqual(['warn:hierarchy_reference_unavailable reason=parent_missing kind=platform']);
    expect(logs('03 no credential')).toEqual(['warn:hierarchy_reference_unavailable reason=no_credential kind=organization']);
    expect(logs('10 anchor mismatch')[0]).toMatch(/^error:hierarchy_anchor_mismatch kind=platform /);
    // one transaction, rolled back on a mismatch and on a refused write, committed otherwise
    const tx = (n: string) => GOLDEN[n]!.filter((e) => e.t === 'tx').map((e) => (e as { event: string }).event);
    expect(tx('04 organization, nothing cached')).toEqual(['begin', 'commit']);
    expect(tx('10 anchor mismatch')).toEqual(['begin', 'rollback']);
    expect(tx('11b frozen, multi-row chain (organization target)')).toEqual(['begin', 'rollback']);
    expect(tx('07 target unknown to the authority')).toEqual([]);
  });
});

describe('A5.4-A2 structure: a read-only resolve step and a place step, both private', () => {
  afterEach(() => vi.restoreAllMocks());
  const authority = {
    company: { id: IDS.company, name: 'Company A' },
    platform: { id: IDS.platform, companyId: IDS.company, name: 'Platform A', key: 'platform-a' },
    organization: { id: IDS.organization, platformId: IDS.platform, name: 'Organization A' },
  };
  const steps = (ref: unknown) => ({
    resolve: vi.spyOn(ref as { resolve: (...a: unknown[]) => Promise<unknown> }, 'resolve'),
    placeChain: vi.spyOn(ref as { placeChain: (...a: unknown[]) => Promise<unknown> }, 'placeChain'),
  });

  it('resolve only reads: SELECT statements outside any transaction, and it opens none', async () => {
    const h = inertReference({ authority });
    const s = steps(h.ref);
    s.placeChain.mockResolvedValue(undefined); // isolate the resolve step
    expect(await h.ref.ensure('organization', IDS.organization)).toBe(true);
    expect(h.transactions()).toBe(0);
    expect(h.statements.length).toBeGreaterThan(0);
    for (const st of h.statements) {
      expect(st.where).toBe('db');
      expect(st.sql).toMatch(/^SELECT 1 FROM /);
    }
    expect(h.calls.map((c) => c.kind)).toEqual(['organization', 'platform', 'company']);
  });

  it('placeChain makes no Organization Service call and opens exactly one transaction', async () => {
    const h = inertReference({ authority });
    const s = steps(h.ref);
    const chain = [{ kind: 'company', row: authority.company }, { kind: 'platform', row: authority.platform }, { kind: 'organization', row: authority.organization }];
    s.resolve.mockResolvedValue(chain); // isolate the place step
    expect(await h.ref.ensure('organization', IDS.organization)).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.transactions()).toBe(1);
    expect(h.statements.filter((st) => st.where === 'tx').map((st) => st.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'SELECT set_config(\'nawara.reference_write\', \'on\',', 'INSERT INTO company', 'INSERT INTO platform', 'SELECT "companyId" AS', 'INSERT INTO organization', 'SELECT "platformId" AS',
    ]);
  });

  it('ensure composes them: resolve once, then placeChain once with the resolved chain (the target last); never placeChain when resolve finds nothing or fails', async () => {
    const found = inertReference({ authority });
    const a = steps(found.ref);
    await found.ref.ensure('organization', IDS.organization);
    expect(a.resolve).toHaveBeenCalledTimes(1);
    expect(a.placeChain).toHaveBeenCalledTimes(1);
    expect(a.placeChain.mock.calls[0]).toHaveLength(1);
    expect((a.placeChain.mock.calls[0]![0] as Array<{ kind: string }>).map((r) => r.kind)).toEqual(['company', 'platform', 'organization']);

    const unknown = inertReference({ authority: {} });
    const b = steps(unknown.ref);
    expect(await unknown.ref.ensure('organization', IDS.organization)).toBe(false);
    expect(b.resolve).toHaveBeenCalledTimes(1);
    expect(b.placeChain).not.toHaveBeenCalled();

    const orphan = inertReference({ authority: { organization: authority.organization } }); // the parent is missing
    const c = steps(orphan.ref);
    await expect(orphan.ref.ensure('organization', IDS.organization)).rejects.toMatchObject({ status: 503 });
    expect(c.placeChain).not.toHaveBeenCalled();
    expect(orphan.transactions()).toBe(0);
  });

  it('neither step runs for a malformed id or a cached target', async () => {
    const h = inertReference({ authority, cachedIds: [IDS.organization] });
    const s = steps(h.ref);
    expect(await h.ref.ensure('organization', 'not-a-uuid')).toBe(false);
    expect(await h.ref.ensure('organization', IDS.organization)).toBe(true);
    expect(s.resolve).not.toHaveBeenCalled();
    expect(s.placeChain).not.toHaveBeenCalled();
    expect(h.calls).toEqual([]);
  });
});

/**
 * Mutation tests: the golden comparison is only evidence if it FAILS on a deviation. Each mutant plants one deliberate change on the
 * instance (the source is untouched) and the same comparison the suite above makes must then report a difference, at the expected place.
 */
describe('A5.4-A2 mutation: a deliberate deviation makes the golden comparison fail', () => {
  type Steps = {
    cached: (q: unknown, kind: string, id: string) => Promise<boolean>;
    placeChain: (chain: Array<{ kind: string }>) => Promise<void>;
    log: { warn: (message: string) => void };
  };
  const steps = (ref: HierarchyReference) => ref as unknown as Steps;
  const mismatches = async (mutate: (ref: HierarchyReference) => void) => {
    const out: string[] = [];
    for (const name of names) {
      try {
        expect(await traceScenario(name, mutate)).toEqual(GOLDEN[name]);
      } catch {
        out.push(name);
      }
    }
    return out;
  };

  it('control: planting a mutation that changes nothing leaves every scenario equal to the golden', async () => {
    expect(await mismatches((ref) => {
      const original = steps(ref).placeChain.bind(ref);
      steps(ref).placeChain = (chain) => original(chain);
    })).toEqual([]);
  });

  it('lookup order: no longer stopping at the first cached ancestor is caught', async () => {
    const mutant = (ref: HierarchyReference) => {
      const original = steps(ref).cached.bind(ref);
      let target: string | null = null;
      steps(ref).cached = async (q, kind, id) => {
        target ??= kind; // the first check of an `ensure` is its target
        const held = await original(q, kind, id); // the same statement is still issued
        return kind === target ? held : false; // but an ancestor is never seen as cached
      };
    };
    expect(await mismatches(mutant)).toEqual(['05 organization, platform cached', '06 platform, company cached', '10 anchor mismatch']);
    const calls = (await traceScenario('05 organization, platform cached', mutant)).filter((e) => e.t === 'call').map((e) => (e as { kind: string }).kind);
    expect(calls).toEqual(['organization', 'platform', 'company']); // the golden has ['organization'] only
  });

  it('refused-write target: naming the refused row instead of the target is caught, in the multi-row case only', async () => {
    const mutant = (ref: HierarchyReference) => {
      const original = steps(ref).placeChain.bind(ref);
      const warn = steps(ref).log.warn.bind(steps(ref).log);
      steps(ref).placeChain = async (chain) => {
        // the refused write is reported with the kind of the first row placed (the Company) instead of the target's
        steps(ref).log.warn = (message) => warn(message.replace(/(reason=reference_write_refused kind=)\w+/, `$1${chain[0]!.kind}`));
        try {
          await original(chain);
        } finally {
          steps(ref).log.warn = warn;
        }
      };
    };
    expect(await mismatches(mutant)).toEqual(['11b frozen, multi-row chain (organization target)']);
    const logs = (await traceScenario('11b frozen, multi-row chain (organization target)', mutant)).filter((e) => e.t === 'log').map((e) => (e as { message: string }).message);
    expect(logs).toEqual(['hierarchy_reference_unavailable reason=reference_write_refused kind=company']); // the golden says kind=organization
  });

  it('placement order: placing the target before its parents is caught', async () => {
    const mutant = (ref: HierarchyReference) => {
      const original = steps(ref).placeChain.bind(ref);
      // reversed, with the refused-write kind kept on the target, so only the ORDER deviates
      const warn = steps(ref).log.warn.bind(steps(ref).log);
      steps(ref).placeChain = async (chain) => {
        steps(ref).log.warn = (message) => warn(message.replace(/(reason=reference_write_refused kind=)\w+/, `$1${chain[chain.length - 1]!.kind}`));
        try {
          await original([...chain].reverse());
        } finally {
          steps(ref).log.warn = warn;
        }
      };
    };
    const caught = await mismatches(mutant);
    expect(caught).toContain('04 organization, nothing cached');
    expect(caught).not.toContain('13 company placed once, then cached'); // a single-row chain has no order to break
  });
});

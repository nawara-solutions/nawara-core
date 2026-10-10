import { Logger } from '@nestjs/common';
import { describeFailure, ReadinessRegistry } from '@nawara/service-kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import type { DbService, Queryable } from '../db/db.service.js';
import {
  HIERARCHY_AUTHORITY_CHECK, HierarchyAuthorityNotReady, HierarchyAuthorityReadiness, evaluate, readMarker,
  type HierarchyAuthorityReason, type HierarchySource, type MarkerObservation,
} from './authority-readiness.js';

/**
 * A5.4-A5 (the design §3 to §7; rulings R1 and R4): the decision and the strict marker reader, with controlled doubles of the query. The
 * states PostgreSQL cannot reach (an unknown value, two rows: the schema forbids both) are tested only here (T10, T11's two-row case);
 * everything else is also proven against PostgreSQL in test/hierarchy-authority-readiness.e2e-spec.ts.
 */
const rowsOf = (rows: Array<{ mode: unknown }>): Queryable => ({ query: async () => ({ rows }) as never });
const failing: Queryable = { query: async () => { throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }); } };

/** The design's §4 matrix: [source, marker observation, expected reason or null for ready]. */
const MATRIX: Array<[HierarchySource, MarkerObservation, HierarchyAuthorityReason | null]> = [
  ['local', 'local', null], // row 1
  ['local', 'frozen', 'marker_frozen'], // row 2 (R1)
  ['local', 'org_authoritative', 'marker_ahead_of_source'], // row 3
  ['organization-service', 'local', 'source_ahead_of_marker'], // row 4
  ['organization-service', 'frozen', 'marker_frozen'], // row 5 (R1)
  ['organization-service', 'org_authoritative', null], // row 6
  ['local', 'missing', 'marker_missing'], ['organization-service', 'missing', 'marker_missing'], // row 7
  ['local', 'invalid', 'marker_invalid'], ['organization-service', 'invalid', 'marker_invalid'], // row 8
  ['local', 'unreadable', 'marker_unreadable'], ['organization-service', 'unreadable', 'marker_unreadable'], // row 9
];

describe('A5.4-A5 hierarchy authority readiness: the decision', () => {
  it.each(MATRIX)('source %s, marker %s → %s', (source, marker, expected) => {
    expect(evaluate(source, marker)).toBe(expected);
  });
});

describe('A5.4-A5 hierarchy authority readiness: the strict marker reader', () => {
  it('reads each of the three values', async () => {
    for (const mode of ['local', 'frozen', 'org_authoritative'] as const) expect(await readMarker(rowsOf([{ mode }]))).toBe(mode);
  });
  it('no row is missing, never local (T7 double)', async () => {
    expect(await readMarker(rowsOf([]))).toBe('missing');
  });
  it('an unknown value is invalid, never local (T10)', async () => {
    for (const mode of ['LOCAL', 'authoritative', '', null, 1]) expect(await readMarker(rowsOf([{ mode }]))).toBe('invalid');
  });
  it('more than one row is invalid, even when the first row is frozen or local (T10; T11 precedence: invalid over frozen)', async () => {
    expect(await readMarker(rowsOf([{ mode: 'frozen' }, { mode: 'local' }]))).toBe('invalid');
    expect(await readMarker(rowsOf([{ mode: 'local' }, { mode: 'local' }]))).toBe('invalid');
    expect(evaluate('local', await readMarker(rowsOf([{ mode: 'frozen' }, { mode: 'frozen' }])))).toBe('marker_invalid');
  });
  it('a failed statement is unreadable, never local (T8 double)', async () => {
    expect(await readMarker(failing)).toBe('unreadable');
  });
  it('sends exactly one read-only statement', async () => {
    const query = vi.fn(async () => ({ rows: [{ mode: 'local' }] }));
    await readMarker({ query } as unknown as Queryable);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]).toEqual(['SELECT mode FROM hierarchy_authority']);
  });
});

describe('A5.4-A5 hierarchy authority readiness: the provider', () => {
  const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  afterEach(() => warn.mockClear());

  const provider = (source: HierarchySource, q: Queryable, registry?: ReadinessRegistry) =>
    new HierarchyAuthorityReadiness(q as unknown as DbService, { hierarchy: { source } } as AppConfig, registry);
  const reasonLines = () => warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('hierarchy_authority_not_ready'));
  const failure = async (p: Promise<void>) => {
    try {
      await p;
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it('registers one check named hierarchy_authority at module init, and reads nothing then', () => {
    const query = vi.fn();
    const register = vi.fn();
    provider('local', { query } as unknown as Queryable, { register } as unknown as ReadinessRegistry).onModuleInit();
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0]).toBe(HIERARCHY_AUTHORITY_CHECK);
    expect(query).not.toHaveBeenCalled();
  });

  it('agreement passes and logs nothing', async () => {
    await provider('local', rowsOf([{ mode: 'local' }])).check();
    await provider('organization-service', rowsOf([{ mode: 'org_authoritative' }])).check();
    expect(reasonLines()).toEqual([]);
  });

  it('a disagreement throws HierarchyAuthorityNotReady with the reason as code; the kit line names only the class and the code', async () => {
    const e = await failure(provider('organization-service', rowsOf([{ mode: 'local' }])).check());
    expect(e).toBeInstanceOf(HierarchyAuthorityNotReady);
    expect((e as HierarchyAuthorityNotReady).code).toBe('source_ahead_of_marker');
    expect(describeFailure(e)).toBe('error=HierarchyAuthorityNotReady code=source_ahead_of_marker');
  });

  it('logs the reason line once per reason, again when the reason changes, and again after a ready result (T12)', async () => {
    let mode: unknown = 'local';
    const q: Queryable = { query: async () => ({ rows: [{ mode }] }) as never };
    const p = provider('organization-service', q);
    await failure(p.check());
    await failure(p.check());
    expect(reasonLines()).toEqual(['hierarchy_authority_not_ready reason=source_ahead_of_marker source=organization-service marker=local']);
    mode = 'frozen';
    await failure(p.check());
    expect(reasonLines()).toHaveLength(2);
    expect(reasonLines()[1]).toBe('hierarchy_authority_not_ready reason=marker_frozen source=organization-service marker=frozen');
    mode = 'org_authoritative';
    await p.check();
    expect(reasonLines()).toHaveLength(2);
    mode = 'frozen';
    await failure(p.check());
    expect(reasonLines()).toHaveLength(3);
  });

  it('the reason line carries only enumerated tokens, never a raw marker value', async () => {
    await failure(provider('local', rowsOf([{ mode: "x'; DROP TABLE company; --" }])).check());
    expect(reasonLines()).toEqual(['hierarchy_authority_not_ready reason=marker_invalid source=local marker=invalid']);
  });

  it('an unreadable marker is marker_unreadable, logged with the reason line', async () => {
    const e = await failure(provider('local', failing).check());
    expect((e as HierarchyAuthorityNotReady).code).toBe('marker_unreadable');
    expect(reasonLines()).toEqual(['hierarchy_authority_not_ready reason=marker_unreadable source=local marker=unreadable']);
  });
});

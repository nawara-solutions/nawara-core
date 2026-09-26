import { describe, expect, it } from 'vitest';
import { compareVersions } from '../domain/version.js';
import type { ComponentKind } from '../domain/model.js';
import { decide, type CompatibilityState } from './decision.js';

const component = { id: 'c', kind: 'web' as const };
const state = (o: { status?: 'registered' | 'published' | 'withdrawn' | null; minimum?: string | null; latest?: string | null; kind?: ComponentKind }): CompatibilityState => ({
  component: { ...component, kind: o.kind ?? 'web' },
  release: o.status === null ? null : { id: 'r', status: o.status ?? 'published' },
  policy: o.minimum ? { policyVersion: 3, minimumVersion: o.minimum } : null,
  latest: o.latest ? { id: 'l', version: o.latest } : null,
});

describe('the compatibility decision (ADR-0051 decision 7)', () => {
  it.each([
    // client, minimum, latest, client status, expected
    ['3.0.0', '2.0.0', '3.0.0', 'published', { update: 'none' }],
    ['2.5.0', '2.0.0', '3.0.0', 'published', { update: 'available' }],
    ['1.5.0', '2.0.0', '3.0.0', 'published', { update: 'required', reason: 'below_minimum' }],
    ['2.5.0', '2.0.0', '3.0.0', 'withdrawn', { update: 'required', reason: 'withdrawn' }],
    ['3.0.0', null, '3.0.0', 'published', { update: 'none' }],
    ['2.0.0', null, '3.0.0', 'published', { update: 'available' }],
    ['2.0.0', '2.0.0', '2.0.0', 'published', { update: 'none' }], // at the minimum is supported
    ['1.0.0', '2.0.0', '3.0.0', 'withdrawn', { update: 'required', reason: 'withdrawn' }], // withdrawn wins over below_minimum
    ['4.0.0', '2.0.0', '3.0.0', 'withdrawn', { update: 'required', reason: 'withdrawn' }], // withdrawn above latest: required, no downgrade
    ['3.1.0', '2.0.0', '3.0.0', 'registered', { update: 'none' }], // a registered (unpublished) build above latest: its own decision
    ['2.9.0', '2.0.0', '3.0.0', 'registered', { update: 'available' }],
    ['2.0.0', null, null, 'registered', { update: 'none' }], // nothing published yet
    ['3.0.0-rc.1', null, '2.0.0', 'published', { update: 'none' }], // a pre-release above latest
    ['3.0.0-rc.1', null, '3.0.0', 'published', { update: 'available' }], // 3.0.0 > 3.0.0-rc.1 (SemVer §11)
    ['2.0.0-rc.1', '2.0.0', '3.0.0', 'published', { update: 'required', reason: 'below_minimum' }], // 2.0.0-rc.1 < 2.0.0
    ['1.10.0', null, '1.9.0', 'published', { update: 'none' }], // SemVer precedence, not string order
    ['1.9.0', null, '1.10.0', 'published', { update: 'available' }],
  ] as const)('client %s, minimum %s, latest %s, %s → %o', (client, minimum, latest, status, expected) => {
    const d = decide(client, state({ status, minimum, latest }));
    expect(d).toEqual({ ...expected, latestVersion: latest, minimumVersion: minimum });
  });

  it('a newer release alone NEVER requires an update (only withdrawal and the minimum do)', () => {
    for (const latest of ['2.0.1', '2.1.0', '3.0.0', '99.0.0']) expect((decide('2.0.0', state({ latest })) as { update: string }).update).toBe('available');
  });

  it('input errors are never decisions: an unknown component, a backend, an unknown release', () => {
    expect(decide('1.0.0', { component: null, release: null, policy: null, latest: null })).toBe('unknown_component');
    expect(decide('1.0.0', state({ kind: 'backend' }))).toBe('unknown_component'); // backends are traceability only
    expect(decide('1.0.0', state({ status: null, latest: '9.0.0', minimum: '5.0.0' }))).toBe('unknown_release'); // never guessed as required
  });

  it('no impossible combination, over every combination of status, minimum and latest (supported is derived: never a second field)', () => {
    const versions = ['0.9.0', '1.0.0', '1.0.0-rc.1', '1.5.0', '2.0.0', '2.0.0-beta', '3.0.0', '10.0.0'];
    const stable = versions.filter((v) => !v.includes('-'));
    let n = 0;
    for (const client of versions) for (const status of ['registered', 'published', 'withdrawn'] as const) for (const minimum of [null, ...stable]) for (const latest of [null, ...stable]) {
      if (minimum && (!latest || compareVersions(minimum, latest) > 0)) continue; // not a committable state (minimum ≤ latest)
      const d = decide(client, state({ status, minimum, latest }));
      if (typeof d === 'string') throw new Error('unexpected input error');
      n++;
      expect(Object.keys(d)).not.toContain('supported');
      if (d.update === 'required') {
        expect(['withdrawn', 'below_minimum']).toContain(d.reason);
        expect(d.reason === 'withdrawn').toBe(status === 'withdrawn');
        if (d.reason === 'below_minimum') expect(compareVersions(client, minimum!)).toBeLessThan(0);
      } else {
        expect('reason' in d).toBe(false);
        expect(status).not.toBe('withdrawn');
        if (minimum) expect(compareVersions(client, minimum)).toBeGreaterThanOrEqual(0);
        expect(d.update === 'available').toBe(!!latest && compareVersions(latest, client) > 0);
      }
    }
    expect(n).toBeGreaterThan(300);
  });
});

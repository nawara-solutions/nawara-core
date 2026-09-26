import { describe, expect, it } from 'vitest';
import { compareVersions, highestVersion, isCanonicalVersion, isStableVersion } from './version.js';

describe('canonical release versions (SemVer 2.0 core + pre-release; no build metadata)', () => {
  it.each(['0.0.0', '1.2.3', '10.20.30', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-0.3.7', '1.0.0-x.7.z.92', '1.0.0-rc-1', '999999999999999.0.0'])('accepts %s', (v) => {
    expect(isCanonicalVersion(v)).toBe(true);
  });

  it.each([
    ['v1.2.3', 'a leading v'], ['1.2', 'missing patch'], ['1.2.3.4', 'a fourth part'], ['01.2.3', 'leading zero'], ['1.02.3', 'leading zero'],
    ['1.2.3-01', 'leading zero in a numeric pre-release'], ['1.2.3+build.5', 'build metadata (native build ids live in buildId)'],
    ['1.2.3-', 'empty pre-release'], ['1.2.3-alpha..1', 'empty identifier'], [' 1.2.3', 'whitespace'], ['1.2.3 ', 'whitespace'],
    ['1.2.3-αβ', 'non-ASCII'], ['1000000000000000.0.0', 'more than 15 digits'], ['', 'empty'], ['latest', 'a word'], ['1.2.3-' + 'a'.repeat(130), 'over 128 characters'],
  ])('refuses %s (%s)', (v) => {
    expect(isCanonicalVersion(v)).toBe(false);
  });

  it('refuses non-strings', () => {
    for (const v of [null, undefined, 123, {}, ['1.0.0']]) expect(isCanonicalVersion(v)).toBe(false);
  });

  it('a stable version has no pre-release (what latest and a minimum may be)', () => {
    expect(isStableVersion('2.0.0')).toBe(true);
    expect(isStableVersion('2.0.0-beta.1')).toBe(false);
    expect(isStableVersion('2.0')).toBe(false);
  });
});

describe('precedence (SemVer 2.0 §11)', () => {
  it('orders the specification example exactly', () => {
    const spec = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    const shuffled = [...spec].reverse();
    expect(shuffled.sort(compareVersions)).toEqual(spec);
  });

  it('compares numerically, not lexically; a pre-release is below its release', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('2.0.0-beta.1', '2.0.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0-beta.1', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(highestVersion(['1.0.0', '1.1.0', '2.0.0-beta.1', '2.0.0'])).toBe('2.0.0');
  });

  it('never compares a native build identifier (throws instead of guessing)', () => {
    for (const nativeId of ['187', '10203', 'a1b2c3d', '2.4.0+187']) expect(() => compareVersions('1.0.0', nativeId)).toThrow(TypeError);
  });
});

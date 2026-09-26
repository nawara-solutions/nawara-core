import semver from 'semver';

/**
 * Canonical release versions (ADR-0051 §4): SemVer 2.0 MAJOR.MINOR.PATCH with an optional pre-release, and NO build metadata (a native
 * build identity lives in `buildId` and is never compared). No leading `v`, no leading zeros, numeric identifiers of at most 15 digits,
 * at most 128 characters. This is exactly the database's `release_semver_valid` rule, so the service and the schema accept the same set.
 * Precedence is the `semver` library's (the npm reference implementation of SemVer 2.0), never hand-written.
 */
export const CANONICAL_VERSION =
  /^(0|[1-9][0-9]{0,14})\.(0|[1-9][0-9]{0,14})\.(0|[1-9][0-9]{0,14})(-(0|[1-9][0-9]{0,14}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]{0,14}|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
export const MAX_VERSION_LENGTH = 128;

/** True only for a canonical release version (the input is returned unchanged by `semver.valid`, so nothing is normalized away). */
export function isCanonicalVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_VERSION_LENGTH && CANONICAL_VERSION.test(value) && semver.valid(value) === value;
}

/** A canonical version without a pre-release: what "latest" and a minimum version may be. */
export function isStableVersion(value: unknown): value is string {
  return isCanonicalVersion(value) && semver.prerelease(value) === null;
}

/** SemVer 2.0 precedence of two canonical versions: negative, zero or positive. Throws on a non-canonical input (never guesses). */
export function compareVersions(a: string, b: string): number {
  if (!isCanonicalVersion(a) || !isCanonicalVersion(b)) throw new TypeError('compareVersions takes canonical release versions only');
  return semver.compare(a, b);
}

/** The highest version by SemVer precedence (for tests and future decisions); undefined for an empty list. */
export function highestVersion(versions: readonly string[]): string | undefined {
  return [...versions].sort(compareVersions).at(-1);
}

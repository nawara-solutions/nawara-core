import { compareVersions } from '../domain/version.js';
import type { ComponentKind, ReleaseStatus } from '../domain/model.js';

/** ADR-0051 decision 7: exactly three values. */
export type Update = 'required' | 'available' | 'none';
/** Only with `required`: the release was withdrawn, or it is below the minimum. Withdrawal wins when both hold. */
export type RequiredReason = 'withdrawn' | 'below_minimum';

/**
 * The compatibility decision (ADR-0051 decision 7). `supported` is NOT a field: supported ⟺ `update` ≠ `required`, derived by the client
 * (ADR-0051: "It is derived, never sent as a second field"), so the two can never contradict each other. `reason` exists only with
 * `required`. `latestVersion` / `minimumVersion` are public release facts (published, stable), never a downgrade target: an installed
 * client updates only to a version greater than its own.
 */
export type Decision =
  | { update: 'required'; reason: RequiredReason; latestVersion: string | null; minimumVersion: string | null }
  | { update: 'available' | 'none'; latestVersion: string | null; minimumVersion: string | null };

/** Input errors: never a decision, never treated as compatible (ADR-0051 decision 7). */
export type InputError = 'invalid_version' | 'unknown_component' | 'unknown_release';

/** The committed Release Management state one decision needs, read in ONE statement (one snapshot). */
export interface CompatibilityState {
  component: { id: string; kind: ComponentKind } | null;
  release: { id: string; status: ReleaseStatus } | null;
  policy: { policyVersion: number; minimumVersion: string } | null;
  latest: { id: string; version: string } | null;
}

/**
 * Deterministic, in this order:
 * 1. no such component, or a backend (registered for traceability only; ADR-0051: the decision is for web, desktop, iOS and Android)
 *    → `unknown_component`;
 * 2. the exact version is not a registered release of the component → `unknown_release` (never guessed safe or unsafe);
 * 3. the release is withdrawn → `required` / `withdrawn` (whatever else holds, even when it is above the latest: no downgrade);
 * 4. a current policy exists and the version is below its minimum (SemVer precedence) → `required` / `below_minimum`;
 * 5. the latest (highest published, not withdrawn, stable) is above the version (SemVer precedence) → `available`;
 * 6. otherwise → `none`.
 * A newer release alone never yields `required`.
 */
export function decide(version: string, s: CompatibilityState): Decision | InputError {
  if (!s.component || s.component.kind === 'backend') return 'unknown_component';
  if (!s.release) return 'unknown_release';
  const facts = { latestVersion: s.latest?.version ?? null, minimumVersion: s.policy?.minimumVersion ?? null };
  if (s.release.status === 'withdrawn') return { update: 'required', reason: 'withdrawn', ...facts };
  if (s.policy && compareVersions(version, s.policy.minimumVersion) < 0) return { update: 'required', reason: 'below_minimum', ...facts };
  if (s.latest && compareVersions(s.latest.version, version) > 0) return { update: 'available', ...facts };
  return { update: 'none', ...facts };
}

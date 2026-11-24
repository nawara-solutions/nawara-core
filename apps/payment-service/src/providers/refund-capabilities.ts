import { createHash } from 'node:crypto';

/**
 * Core V2 D-R1A (the Owner's D-R1 direction of 2026-11-23, Q1, Q3, Q6): provider-specific refund capabilities, as versioned, attributable
 * certificates in ONE reviewed source: the registry below, in this repository. A change to it is a reviewed pull request the Owner merges.
 *
 *   * An adapter only REFERENCES certificates (`ProviderCapabilities.refundCapabilityCertificates`); it can never certify itself. A reference
 *     to a certificate that is not in the registry, has another version, names another provider, is malformed, not yet valid, expired or
 *     revoked certifies nothing.
 *   * Every capability fails closed: absent, unknown, unverified, expired, revoked or ambiguous is `certified: false`, with the reason.
 *   * `scope: 'simulation'` certificates model a capability of the non-production `simulation` provider only. They are honoured only for that
 *     provider id and only in a simulation environment; they are never promoted to any other provider (Q6). A simulator's behaviour is never
 *     evidence of a real provider's guarantee (Q1).
 *   * `scope: 'provider'` (a real provider) needs documentary provider guarantees, a verified adapter mapping, the Owner's explicit
 *     authorization and an expiry (Q3). NONE exists: this registry certifies no real provider.
 *
 * D-R1A uses `idempotencyKeyRetention` (the refund worker's same-key resend, Q5). D-R1B (migration 0037) uses `terminalFailureFinality`: a failure
 * of a certified observation is recorded final with the move to `failed`, and only such a failure, still valid NOW, lets a replacement be
 * created or sent. The database holds its own mirror of these certificates (`refund_capability_certificate`, seeded by reviewed migrations only)
 * and decides independently; both layers must agree. A changed certificate needs a new version HERE and a migration that mirrors it.
 *
 * Supersession (D-R1B, explicit): a newer version never ends an older one. Evidence belongs to the exact version it was recorded under, is never
 * re-read under another version, and stays usable while that version is registered, in force and unrevoked and the adapter still declares the
 * same certificate id. Ending it takes an explicit revocation of that version, here and in the database.
 */

export type RefundCapabilityName = 'terminalFailureFinality' | 'authoritativeNotFound' | 'idempotencyKeyRetention' | 'cancellation' | 'statusAuthority';
export const REFUND_CAPABILITY_NAMES: readonly RefundCapabilityName[] = [
  'terminalFailureFinality', 'authoritativeNotFound', 'idempotencyKeyRetention', 'cancellation', 'statusAuthority',
];

/** How Payment learned of a refund failure: the dispatch's definitive refusal, or a provider-confirmed failure (status read or verified webhook). */
export type RefundFailureObservation = 'dispatch_rejected' | 'provider_failed';
export const REFUND_FAILURE_OBSERVATIONS: readonly RefundFailureObservation[] = ['dispatch_rejected', 'provider_failed'];

/** What each capability guarantees when certified. */
export interface RefundCapabilityGrants {
  /**
   * The provider guarantees that, after this kind of failure observation, NO later success is possible for that attempt's key and amount. A fresh
   * status read alone never establishes this (D-R1 Part A).
   */
  terminalFailureFinality?: { observations: readonly RefundFailureObservation[] };
  /** The provider guarantees that "no record" proves the key was never processed and never will be. Refunds never act on it in D-R1A. */
  authoritativeNotFound?: { granted: true };
  /** How long the provider de-duplicates a refund idempotency key. `unbounded` is allowed for a `simulation` certificate only. */
  idempotencyKeyRetention?: { lifetimeMs: number } | { unbounded: true };
  /** The provider can cancel or reverse a submitted refund, and says so definitively. Nothing uses it yet. */
  cancellation?: { granted: true };
  /** Which authenticated channels may carry refund outcomes. Conflicting observations are always preserved, never ranked (Q4). */
  statusAuthority?: { webhook: boolean; statusRead: boolean };
}

export interface RefundCapabilityCertificate {
  /** Stable id, `^[a-z][a-z0-9-]{2,63}$`. */
  id: string;
  /** Positive integer; a changed grant or basis is a new version, never an edit. */
  version: number;
  /** The provider id the certificate applies to; never transferable. */
  providerId: string;
  scope: 'simulation' | 'provider';
  /** ISO-8601 instants. `expiresAt` null only for `simulation` scope. */
  issuedAt: string;
  expiresAt: string | null;
  /** Who authorized it, and the decision reference. Attributable, never empty. */
  authorization: string;
  /** The documentary provider guarantee (or, for simulation, the simulator code and schema that implement the modelled behaviour). */
  documentaryBasis: string;
  /** The verified adapter mapping: the code that maps the provider's answers to Payment's results. */
  adapterMapping: string;
  grants: RefundCapabilityGrants;
}

/** An adapter's reference to one certificate. */
export interface RefundCapabilityCertificateRef {
  id: string;
  version: number;
}

export interface RefundCapabilityRevocation {
  id: string;
  version: number;
  revokedAt: string;
  reason: string;
}

/** The `simulation` provider's base refund contract: its key de-duplication and its two authenticated channels. Simulation only. */
export const SIMULATION_REFUND_CONTRACT_CERTIFICATE: RefundCapabilityCertificate = Object.freeze({
  id: 'simulation-refund-contract',
  version: 1,
  providerId: 'simulation',
  scope: 'simulation',
  issuedAt: '2026-11-23T00:00:00.000Z',
  expiresAt: null,
  authorization: 'Owner D-R1 direction 2026-11-23 (Q1 capability model, Q5 idempotency expiry, Q6 simulation with isolation): models the simulator only',
  documentaryBasis:
    'payment-service migration 0017 simulation_refund_dispatch: one append-only row per idempotency key (FK to refund_attempt, no delete, no truncate), first answer kept for every repeat',
  adapterMapping: 'apps/payment-service/src/providers/simulation-provider.ts SimulationPaymentProvider.refund / fetchRefundStatus / verifyWebhook',
  grants: Object.freeze({
    idempotencyKeyRetention: Object.freeze({ unbounded: true as const }),
    statusAuthority: Object.freeze({ webhook: true, statusRead: true }),
  }),
});

/**
 * The `simulation` provider's MODELLED terminal failure finality (Q6), declared by the adapter only when the simulation environment opts in
 * (`PAYMENT_SIMULATION_REFUND_FAILURE_FINALITY=true`). A harness that later reports a success for such an attempt models a provider contract
 * violation. Simulation only; D-R1B reads it.
 */
export const SIMULATION_REFUND_FAILURE_FINALITY_CERTIFICATE: RefundCapabilityCertificate = Object.freeze({
  id: 'simulation-refund-failure-finality',
  version: 1,
  providerId: 'simulation',
  scope: 'simulation',
  issuedAt: '2026-11-23T00:00:00.000Z',
  expiresAt: null,
  authorization: 'Owner D-R1 direction 2026-11-23 (Q6): the simulation provider may explicitly model terminal failure finality; never promoted to a real provider',
  documentaryBasis: 'modelled behaviour of the simulator; not a provider guarantee',
  adapterMapping: 'apps/payment-service/src/providers/simulation-provider.ts SimulationPaymentProvider.refund (rejected) / fetchRefundStatus (failed)',
  grants: Object.freeze({
    terminalFailureFinality: Object.freeze({ observations: Object.freeze(['dispatch_rejected', 'provider_failed'] as const) }),
  }),
});

/** THE authoritative source. No real-provider certificate exists (Q3: none is certified by the D-R1 decision). */
export const REFUND_CAPABILITY_CERTIFICATES: readonly RefundCapabilityCertificate[] = Object.freeze([
  SIMULATION_REFUND_CONTRACT_CERTIFICATE,
  SIMULATION_REFUND_FAILURE_FINALITY_CERTIFICATE,
]);

/** Revoked certificates (id and version). A revocation is permanent and applies to every evaluation from then on, including historical records. */
export const REFUND_CAPABILITY_REVOCATIONS: readonly RefundCapabilityRevocation[] = Object.freeze([]);

export type RefundCapabilityRefusal =
  | 'not_declared'
  | 'unknown_certificate'
  | 'version_mismatch'
  | 'duplicate_certificate'
  | 'malformed_certificate'
  | 'provider_mismatch'
  | 'simulation_scope_outside_simulation'
  | 'not_yet_valid'
  | 'expired'
  | 'revoked'
  | 'not_granted'
  | 'ambiguous';

export type RefundCapabilityEvaluation<N extends RefundCapabilityName = RefundCapabilityName> =
  | { certified: true; capability: N; grant: NonNullable<RefundCapabilityGrants[N]>; certificate: RefundCapabilityCertificate; fingerprint: string }
  | { certified: false; capability: N; reason: RefundCapabilityRefusal; certificateId?: string };

export interface RefundCapabilityContext {
  /** The time of evaluation; the database's clock where Payment has it. */
  now: Date;
  /** True only when the simulation provider is configured in a non-production environment. */
  simulationEnvironment: boolean;
  /** Overrides for tests; production code always uses the registry constants. */
  registry?: readonly RefundCapabilityCertificate[];
  revocations?: readonly RefundCapabilityRevocation[];
}

/** The part of an adapter the evaluation needs. */
export interface RefundCapabilitySubject {
  id: string;
  capabilities: { refundCapabilityCertificates?: readonly RefundCapabilityCertificateRef[] };
}

const ID = /^[a-z][a-z0-9-]{2,63}$/;
const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const SIMULATION_PROVIDER = 'simulation';

const isText = (v: unknown, max = 512): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const instant = (v: unknown): number | null => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};
const plainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));

/** Whether one grant is well-formed for its certificate's scope. Unknown members fail the whole certificate. */
function grantValid(name: string, g: unknown, scope: RefundCapabilityCertificate['scope']): boolean {
  if (!plainObject(g)) return false;
  switch (name) {
    case 'terminalFailureFinality': {
      const obs = g.observations;
      return onlyKeys(g, ['observations']) && Array.isArray(obs) && obs.length > 0 && new Set(obs).size === obs.length
        && obs.every((o) => (REFUND_FAILURE_OBSERVATIONS as readonly unknown[]).includes(o));
    }
    case 'authoritativeNotFound':
    case 'cancellation':
      return onlyKeys(g, ['granted']) && g.granted === true;
    case 'idempotencyKeyRetention':
      if ('unbounded' in g) return onlyKeys(g, ['unbounded']) && g.unbounded === true && scope === 'simulation';
      return onlyKeys(g, ['lifetimeMs']) && Number.isSafeInteger(g.lifetimeMs) && (g.lifetimeMs as number) > 0;
    case 'statusAuthority':
      return onlyKeys(g, ['webhook', 'statusRead']) && typeof g.webhook === 'boolean' && typeof g.statusRead === 'boolean';
    default:
      return false;
  }
}

/** Structural validation of one certificate, independent of time, revocation and the subject. */
export function certificateWellFormed(c: unknown): c is RefundCapabilityCertificate {
  if (!plainObject(c)) return false;
  if (!onlyKeys(c, ['id', 'version', 'providerId', 'scope', 'issuedAt', 'expiresAt', 'authorization', 'documentaryBasis', 'adapterMapping', 'grants'])) return false;
  if (typeof c.id !== 'string' || !ID.test(c.id) || !Number.isSafeInteger(c.version) || (c.version as number) < 1) return false;
  if (!isText(c.providerId, 64) || (c.scope !== 'simulation' && c.scope !== 'provider')) return false;
  if (c.scope === 'simulation' && c.providerId !== SIMULATION_PROVIDER) return false;
  if (c.scope === 'provider' && c.providerId === SIMULATION_PROVIDER) return false;
  const issued = instant(c.issuedAt);
  if (issued === null) return false;
  if (c.expiresAt === null) {
    if (c.scope !== 'simulation') return false; // a real provider's certification always expires
  } else {
    const expires = instant(c.expiresAt);
    if (expires === null || expires <= issued) return false;
  }
  if (!isText(c.authorization) || !isText(c.documentaryBasis) || !isText(c.adapterMapping)) return false;
  if (!plainObject(c.grants) || Object.keys(c.grants).length === 0) return false;
  return Object.entries(c.grants).every(([name, g]) => grantValid(name, g, c.scope as RefundCapabilityCertificate['scope']));
}

/** Canonical JSON (sorted keys) of a value: the input of the fingerprint. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (plainObject(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The certificate's content fingerprint: what a durable record of an evaluation must name, so a changed certificate is never mistaken for it. */
export function certificateFingerprint(c: RefundCapabilityCertificate): string {
  return createHash('sha256').update(certificateContent(c)).digest('hex');
}

/** The canonical content the fingerprint covers; the database mirror stores exactly this text and re-computes the fingerprint from it (0037). */
export function certificateContent(c: RefundCapabilityCertificate): string {
  return canonical(c);
}

/**
 * Whether the registry itself is sound: every entry well-formed, no id+version twice, every revocation naming a registered certificate. A unit
 * test pins it; an unsound registry still certifies nothing it cannot validate.
 */
export function registryProblems(registry: readonly unknown[] = REFUND_CAPABILITY_CERTIFICATES, revocations: readonly RefundCapabilityRevocation[] = REFUND_CAPABILITY_REVOCATIONS): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  registry.forEach((c, i) => {
    if (!certificateWellFormed(c)) problems.push(`entry ${i} is malformed`);
    const key = plainObject(c) ? `${String(c.id)}@${String(c.version)}` : `#${i}`;
    if (seen.has(key)) problems.push(`duplicate certificate ${key}`);
    seen.add(key);
  });
  for (const r of revocations) {
    if (!seen.has(`${r.id}@${r.version}`)) problems.push(`revocation of unregistered certificate ${r.id}@${r.version}`);
    if (instant(r.revokedAt) === null || !isText(r.reason)) problems.push(`malformed revocation ${r.id}@${r.version}`);
  }
  return problems;
}

/** One reference, resolved and validated for the subject at `ctx.now`. */
function resolve(subject: RefundCapabilitySubject, ref: RefundCapabilityCertificateRef, ctx: RefundCapabilityContext):
  { ok: true; certificate: RefundCapabilityCertificate } | { ok: false; reason: RefundCapabilityRefusal } {
  const registry = ctx.registry ?? REFUND_CAPABILITY_CERTIFICATES;
  const revocations = ctx.revocations ?? REFUND_CAPABILITY_REVOCATIONS;
  if (!plainObject(ref) || typeof ref.id !== 'string' || !Number.isSafeInteger(ref.version)) return { ok: false, reason: 'unknown_certificate' };
  const sameId = registry.filter((c) => plainObject(c) && c.id === ref.id);
  if (sameId.length === 0) return { ok: false, reason: 'unknown_certificate' };
  const exact = sameId.filter((c) => c.version === ref.version);
  if (exact.length === 0) return { ok: false, reason: 'version_mismatch' };
  if (exact.length > 1) return { ok: false, reason: 'duplicate_certificate' };
  const c = exact[0]!;
  if (!certificateWellFormed(c)) return { ok: false, reason: 'malformed_certificate' };
  if (c.providerId !== subject.id) return { ok: false, reason: 'provider_mismatch' };
  if (c.scope === 'simulation' && (subject.id !== SIMULATION_PROVIDER || !ctx.simulationEnvironment)) return { ok: false, reason: 'simulation_scope_outside_simulation' };
  const now = ctx.now.getTime();
  if (!Number.isFinite(now)) return { ok: false, reason: 'not_yet_valid' };
  if (now < instant(c.issuedAt)!) return { ok: false, reason: 'not_yet_valid' };
  if (c.expiresAt !== null && now >= instant(c.expiresAt)!) return { ok: false, reason: 'expired' };
  const revoked = revocations.find((r) => r.id === c.id && r.version === c.version);
  if (revoked) {
    const at = instant(revoked.revokedAt);
    if (at === null || now >= at) return { ok: false, reason: 'revoked' }; // a malformed revocation still revokes (fail closed)
  }
  return { ok: true, certificate: c };
}

/**
 * The one evaluation every caller uses. Certified only when exactly one valid referenced certificate grants the capability; two that grant it are
 * `ambiguous` (never a choice between them). When none does, the reason is the first refusal among the references, else `not_granted`.
 */
export function evaluateRefundCapability<N extends RefundCapabilityName>(subject: RefundCapabilitySubject | undefined, capability: N, ctx: RefundCapabilityContext): RefundCapabilityEvaluation<N> {
  const refs = subject?.capabilities?.refundCapabilityCertificates;
  if (!subject || !Array.isArray(refs) || refs.length === 0) return { certified: false, capability, reason: 'not_declared' };
  const granting: RefundCapabilityCertificate[] = [];
  let firstRefusal: { reason: RefundCapabilityRefusal; certificateId?: string } | null = null;
  for (const ref of refs) {
    const r = resolve(subject, ref, ctx);
    if (!r.ok) {
      firstRefusal ??= { reason: r.reason, ...(typeof ref?.id === 'string' ? { certificateId: ref.id } : {}) };
      continue;
    }
    if (r.certificate.grants[capability] !== undefined) granting.push(r.certificate);
  }
  if (granting.length > 1) return { certified: false, capability, reason: 'ambiguous' };
  const c = granting[0];
  if (!c) return { certified: false, capability, ...(firstRefusal ?? { reason: 'not_granted' as const }) };
  return { certified: true, capability, grant: c.grants[capability] as NonNullable<RefundCapabilityGrants[N]>, certificate: c, fingerprint: certificateFingerprint(c) };
}

/**
 * Q5: whether the provider still de-duplicates a refund attempt's key `elapsedMs` after its authorization (a lower bound of its first send, so the
 * window is measured conservatively). Certified retention only; `elapsedMs` must be a known, non-negative number.
 */
export function sameKeyResendAllowed(evaluation: RefundCapabilityEvaluation<'idempotencyKeyRetention'>, elapsedMs: number | null):
  { allowed: true } | { allowed: false; reason: RefundCapabilityRefusal | 'retention_elapsed' | 'elapsed_unknown' } {
  if (!evaluation.certified) return { allowed: false, reason: evaluation.reason };
  if ('unbounded' in evaluation.grant) return { allowed: true };
  if (elapsedMs === null || !Number.isFinite(elapsedMs) || elapsedMs < 0) return { allowed: false, reason: 'elapsed_unknown' };
  return elapsedMs < evaluation.grant.lifetimeMs ? { allowed: true } : { allowed: false, reason: 'retention_elapsed' };
}

/** What a durable record of a certified failure names (D-R1B, `refund_attempt_failure_finality`). Historical attempts have none. */
export interface RefundFailureFinalityRecord {
  certificateId: string;
  certificateVersion: number;
  fingerprint: string;
  observation: RefundFailureObservation;
  failureCode: string;
}

export type RefundFailureFinality =
  | { final: true; certificate: RefundCapabilityCertificate }
  | { final: false; reason: 'no_finality_record' | 'malformed_record' | 'certificate_changed' | 'observation_not_covered' | RefundCapabilityRefusal };

/**
 * D-R1 Part A, D-R1B: whether one FAILED attempt's failure is certified final, evaluated NOW. Fails closed in every case it cannot prove:
 *   * no record (every failed row before 0037, every uncertified failure): never final; a `failed` status is never proof;
 *   * the adapter no longer declares, unambiguously and validly, the record's certificate id (provider configuration changed): not final;
 *   * the record's OWN version is not registered, not in force (expired, not yet valid) or revoked: not final, though the record stays;
 *   * that version's content changed (fingerprint), or its grant does not cover the recorded observation: not final.
 * A newer version of the same certificate, by itself, neither ends nor widens evidence recorded under an older one (explicit supersession: revoke it).
 */
export function failureFinalityOf(record: RefundFailureFinalityRecord | null, subject: RefundCapabilitySubject | undefined, ctx: RefundCapabilityContext): RefundFailureFinality {
  if (record === null) return { final: false, reason: 'no_finality_record' };
  if (!plainObject(record) || typeof record.certificateId !== 'string' || !Number.isSafeInteger(record.certificateVersion) || typeof record.fingerprint !== 'string'
    || !(REFUND_FAILURE_OBSERVATIONS as readonly unknown[]).includes(record.observation) || typeof record.failureCode !== 'string' || !FAILURE_CODE.test(record.failureCode)) {
    return { final: false, reason: 'malformed_record' };
  }
  const e = evaluateRefundCapability(subject, 'terminalFailureFinality', ctx);
  if (!e.certified) return { final: false, reason: e.reason };
  if (e.certificate.id !== record.certificateId) return { final: false, reason: 'certificate_changed' };
  const own = resolve(subject!, { id: record.certificateId, version: record.certificateVersion }, ctx);
  if (!own.ok) return { final: false, reason: own.reason };
  if (certificateFingerprint(own.certificate) !== record.fingerprint) return { final: false, reason: 'certificate_changed' };
  if (!own.certificate.grants.terminalFailureFinality?.observations.includes(record.observation)) return { final: false, reason: 'observation_not_covered' };
  return { final: true, certificate: own.certificate };
}

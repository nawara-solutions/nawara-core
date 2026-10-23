import { auditCompatibilityEnforcement, strictEnforcement, type EnforcementPolicy, type EventEnvelope, type HandlerTrust } from '@nawara/service-kit';

/**
 * Core V2 S1e-3 (ADR-0057 §13.5, "S0-C6" Audit): how audit-service applies the kit's consumer trust decision (S1e-1).
 *
 * - `compatibility` (the default, and production's until the Owner authorizes the exit): Audit's TEMPORARY compatibility phase. An
 *   admitted delivery that is merely unverified (no `user_id`, another identity, a replay matching only an unverified observation, a replay
 *   with no stored observation) is still ingested, and its original observation is stored as unverified; everything strict refuses for a
 *   POSITIVE reason (a verified delivery contradicting the stored verified observation, a replay that differs from the stored original, an
 *   unknown path) is refused, and a provenance failure is held. Nothing historical becomes verified.
 * - `strict` (`AUDIT_PROVENANCE_ENFORCEMENT=strict`, explicitly selected): only a verified original, its verified redelivery or a replay
 *   matching the stored verified observation reaches ingestion; every other delivery is refused before it (no record, so no first-writer
 *   slot for a forger).
 *
 * In both, the kit runs Audit's admission (canonical bytes, the Stage 18.8 screen, the full contract) FIRST, before any provenance digest,
 * record or decision; every refusal is permanent and dead-lettered under `auditDeadLetterPolicy` (`refusedBody: 'dead_letter_policy'`);
 * a provenance or lookup failure is held and requeued, the handler never running. The kit accepts the compatibility policy on Audit's
 * queue only (`COMPATIBILITY_QUEUES`), so no other consumer can run in it. Returning from strict to compatibility is a separately approved,
 * security-impacting exception (S0-C6), not an operational toggle.
 */
export const AUDIT_ENFORCEMENT_MODES = ['compatibility', 'strict'] as const;
export type AuditEnforcementMode = (typeof AUDIT_ENFORCEMENT_MODES)[number];

/** The refusals audit-service's handler adds behind the kit's own (defence in depth: the kit never hands these over). */
export const TRUST_REFUSALS = ['untrusted_no_decision', 'untrusted_origin_mismatch'] as const;
export type TrustRefusal = (typeof TRUST_REFUSALS)[number];

/**
 * The kit policy of a mode. Each call issues a new frozen policy: there is no switch between modes at runtime. Anything but the two modes
 * throws: an unexpected value never falls back to the compatibility phase.
 */
export function auditEnforcement(mode: AuditEnforcementMode): EnforcementPolicy {
  if (mode === 'strict') return strictEnforcement({ refusedBody: 'dead_letter_policy' });
  if (mode === 'compatibility') return auditCompatibilityEnforcement();
  throw new Error('audit enforcement: the mode must be compatibility or strict');
}

/**
 * Why `ingest` must NOT run for a delivery the bus handed over with `trust`, or undefined. The kit only ever hands an accepted decision (or,
 * in the compatibility phase, a compatibility one) to the handler; anything else here is a wiring fault, refused permanently:
 * - no decision at all, or a compatibility decision under `strict` → `untrusted_no_decision`;
 * - an accepted origin that is not this delivery's event (id, claimed source, name) → `untrusted_origin_mismatch`.
 */
export function untrustedReason(mode: AuditEnforcementMode, event: EventEnvelope, trust: HandlerTrust | undefined): TrustRefusal | undefined {
  if (trust?.decision === 'compatibility') return mode === 'compatibility' ? undefined : 'untrusted_no_decision';
  if (trust?.decision !== 'accept') return 'untrusted_no_decision';
  const o = trust.origin;
  return o.eventId === event.id && o.source === event.headers.source && o.name === event.name ? undefined : 'untrusted_origin_mismatch';
}

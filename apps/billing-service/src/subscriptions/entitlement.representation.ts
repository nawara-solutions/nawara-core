import type { EffectiveEntitlement } from '../domain/entitlement.js';

/** The frozen V1 effective-access contract (Stage 12.5, ADR-0038): nothing beyond `valid`/`expiresAt` — no Subscription internals. */
export interface EntitlementRepresentation {
  valid: boolean;
  expiresAt: string | null;
}

export function representEntitlement(entitlement: EffectiveEntitlement): EntitlementRepresentation {
  return { valid: entitlement.valid, expiresAt: entitlement.expiresAt ? entitlement.expiresAt.toISOString() : null };
}

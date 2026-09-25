/**
 * The audit categories frozen by Stage 18.1 (A52): bounded, derived from the catalog (18.4), used for retention, caller visibility and
 * filtering. A caller policy may only name these.
 */
export const AUDIT_CATEGORIES = ['security', 'business', 'commercial', 'administrative'] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

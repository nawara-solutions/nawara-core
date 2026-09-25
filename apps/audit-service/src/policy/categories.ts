/**
 * The audit categories frozen by Stage 18.1 (A52): bounded, derived from the catalog, used for retention, caller visibility and
 * filtering. A caller policy may only name these. Since Stage 18.4 the ONE definition lives in the shared contract (the catalog assigns
 * each action its category there); this module only re-exports it, so the policy and the catalog cannot disagree.
 */
export { AUDIT_CATEGORIES, type AuditCategory } from '@nawara/audit-contract';

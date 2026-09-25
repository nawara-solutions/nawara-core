// @nawara/audit-contract — the PRODUCER-facing Core audit contract (ADR-0049, Stage 18.4). Types, the catalog, the one validator and
// the transactional outbox helper. No runtime dependency; nothing here stores, publishes or queries audit records.
export {
  AUDIT_CONTRACT_VERSION, SUPPORTED_AUDIT_VERSIONS, AUDIT_CATEGORIES, ACTOR_TYPES, USER_KINDS, AUDIT_OUTCOMES,
  type AuditCategory, type ActorType, type UserKind, type AuditOutcome, type UserActor, type ServiceActor, type SystemActor,
  type AuditActor, type AuditReference, type ChangeScalar, type ChangeValue, type AuditPayload,
} from './contract.js';
export {
  AUDIT_CATALOG, AUDIT_ACTIONS, CORE_PRODUCERS, catalogEntry, actionsOwnedBy,
  type AuditAction, type CatalogEntry, type ChangeSpec, type ChangeType, type OrganizationRule, type SubjectRule, type ActorRule,
  type CoreProducer, type AuditChangesOf, type AuditResourceTypeOf, type AuditOutcomeOf, type AuditSubjectOf,
} from './catalog.js';
export { AUDIT_REFUSALS, AuditContractError, type AuditRefusal } from './errors.js';
export { validateAuditPayload } from './validate.js';
export {
  AuditEventWriter, type AuditEventInput, type AuditWriteOptions, type AuditWriteResult, type AuditQueryable, type AuditOutbox,
  type AuditOutboxEvent,
} from './writer.js';

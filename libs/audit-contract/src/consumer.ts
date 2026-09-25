// @nawara/audit-contract/consumer — the audit-service side of the contract: validation of a received kit envelope. Producers never need
// it (they use the writer). The mapping onto audit-service's own table stays inside audit-service (its persistence is its own).
export { validateAuditEvent, type AuditEnvelopeInput, type ValidatedAuditEvent } from './envelope.js';

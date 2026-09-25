/**
 * The stable, safe reasons an audit event is refused. The same codes are raised by the producer helper (a programming error in the
 * producing service) and by audit-service's ingestion (18.5 dead-letters the message with the code as its `PermanentEventFailure`
 * reason). They follow the SDD §4 reason list, extended where 18.4 split a case. A reason NEVER carries the rejected value: no key
 * name, no string, no id (a refused value may be a secret or personal data).
 */
export const AUDIT_REFUSALS = [
  /** The payload is not a plain JSON object, or holds a value no JSON document can (function, bigint, symbol, accessor, cycle). */
  'invalid_payload',
  /** The canonical payload exceeds 4 KiB. */
  'payload_too_large',
  /** A field outside the contract at any level (top level, actor, resource, subject, a change value). */
  'unknown_field',
  /** A key that names a credential, secret or personal-contact concept, at any level. Checked before anything else. */
  'sensitive_field',
  /** A string value shaped like a secret (JWT, long hex / base64). Defense in depth behind the grammars. */
  'sensitive_value',
  /** Malformed, or not in the catalog. Never stored as "unknown" (A64 of this stage: frozen). */
  'unknown_action',
  /** The action's catalog producer is not the emitting service. */
  'producer_not_admitted',
  /** The event type is not exactly `audit.<payload.action>`. */
  'event_type_mismatch',
  /** Actor type, id or user kind not allowed for the action. */
  'invalid_actor',
  /** `organizationId` missing, malformed, or against the action's organization rule. */
  'invalid_organization',
  /** Resource missing, malformed, or of a type the action does not use. */
  'invalid_resource',
  /** Subject supplied when forbidden, missing when required, malformed, or of the wrong type. */
  'invalid_subject',
  /** An outcome the action does not allow. */
  'invalid_outcome',
  /** A change key the action does not declare, a missing required change, a wrong type or shape, or over the size bounds. */
  'invalid_changes',
  /** `causationId` malformed or equal to the event's own id. */
  'invalid_causation',
  /** A correlation id outside the kit grammar. */
  'invalid_correlation',
  /** Envelope id, source, occurredAt or shape unusable (consumer side). */
  'invalid_envelope',
  /** An envelope `version` this contract does not implement. Never interpreted as another version. */
  'unsupported_version',
  /** Producer helper only: the query client is not inside an open transaction block. */
  'transaction_required',
] as const;
export type AuditRefusal = (typeof AUDIT_REFUSALS)[number];

/** Thrown for every refusal. `message` equals `code`: safe to log, never data-bearing. */
export class AuditContractError extends Error {
  constructor(readonly code: AuditRefusal) {
    super(code);
    this.name = 'AuditContractError';
  }
}

export function refuse(code: AuditRefusal): never {
  throw new AuditContractError(code);
}

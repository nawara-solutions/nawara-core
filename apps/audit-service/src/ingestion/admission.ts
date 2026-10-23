import { AuditContractError, catalogEntry } from '@nawara/audit-contract';
import { mayRetainRefusedAuditBody, validateAuditEvent } from '@nawara/audit-contract/consumer';
import { isCanonicalJsonBody, type EventAdmission, type EventEnvelope } from '@nawara/service-kit';
import { SERVICE_NAME } from '../config/audit-config.js';

const EVENT_TYPE_PREFIX = 'audit.';

/** Core V2 S1b-2: the admission refusals that are not contract refusals (closed set; counted and written on the dead-letter copy). */
export const ADMISSION_REFUSALS = ['noncanonical_body', 'confidentiality_screen', 'admission_error'] as const;
export type AdmissionRefusal = (typeof ADMISSION_REFUSALS)[number];

/**
 * Core V2 S1b-2 (ADR-0057 §13.2 "Audit admission", S0-C1): whether a delivery may reach provenance and ingestion at all. Deterministic and
 * side-effect free, run by the kit on EVERY delivery (event exchange and default exchange alike) after its envelope checks, in this order:
 *   1. the raw bytes are canonical JSON (`isCanonicalJsonBody`): the parsed value below then is all the body carries;
 *   2. the Stage 18.8 catalog-independent confidentiality screen (`mayRetainRefusedAuditBody`, the dead-letter body screen);
 *   3. the complete contract validation ingestion applies (`validateAuditEvent`, plus Stage 18.6's refusal of a delivered event claiming
 *      audit-service itself).
 * A refusal is permanent (the kit dead-letters it under `auditDeadLetterPolicy`, with no provenance row and no body digest). The contract's
 * producer admission compares the ASSERTED `source` header with the catalog: a contract rule, never authentication (provenance verifies
 * the broker `user_id` separately). The screen refuses only what the validator refuses too, so its reason is the validator's refusal.
 */
export function auditAdmission(event: EventEnvelope, body: Uint8Array): EventAdmission {
  if (!isCanonicalJsonBody(body)) return { admitted: false, reason: 'noncanonical_body' };
  if (!mayRetainRefusedAuditBody(event)) return { admitted: false, reason: contractRefusal(event) ?? 'confidentiality_screen' };
  const refusal = contractRefusal(event);
  if (refusal) return { admitted: false, reason: refusal };
  if (event.headers.source === SERVICE_NAME) return { admitted: false, reason: 'producer_not_admitted' };
  return { admitted: true };
}

/** The contract's refusal code for `event`, or undefined when the contract accepts it. Any other error propagates (fail closed). */
function contractRefusal(event: EventEnvelope): string | undefined {
  try {
    validateAuditEvent(event);
    return undefined;
  } catch (e) {
    if (e instanceof AuditContractError) return e.code;
    throw e;
  }
}

/**
 * Core V2 S1b-2 (ADR-0057 §13.1, §13.2; ADR-0069 decision 1): the trusted owner of an `audit.<action>` event, from the audit catalog
 * (never from a message): the action's catalog producer. Unknown actions, and audit-service's own action (which is never delivered over
 * the bus), have no owner, so no delivery of them can be verified.
 */
export function auditEventOwner(name: string): string | undefined {
  if (!name.startsWith(EVENT_TYPE_PREFIX)) return undefined;
  const producer = catalogEntry(name.slice(EVENT_TYPE_PREFIX.length))?.producer;
  return producer === SERVICE_NAME ? undefined : producer;
}

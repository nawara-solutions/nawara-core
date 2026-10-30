import type { HttpException } from '@nestjs/common';
import { httpError, type MessageParams, type MessageTexts } from '@nawara/service-kit';
import { PAYMENT_MESSAGES } from './messages.js';

/** The stable, machine-readable error codes of SDD section 10, carried in the kit's additive `code` field. */
export type ErrorCode =
  | 'invalid_payment_request'
  | 'idempotency_key_required'
  | 'operation_not_permitted'
  | 'not_found'
  | 'payment_request_conflict'
  | 'payer_purpose_mismatch'
  | 'payment_uncertain'
  | 'payment_not_payable'
  | 'payment_expired'
  | 'payment_has_open_attempt'
  | 'invalid_state_transition'
  | 'idempotency_key_reused'
  | 'unsupported_currency'
  | 'invalid_provider'
  | 'provider_options_not_accepted'
  | 'invalid_simulation_command'
  | 'simulation_command_conflict'
  | 'simulation_nothing_to_deliver'
  | 'provider_error'
  | 'provider_unavailable'
  | 'auth_unavailable'
  // Core V2 S6b (register PAY-07, PAY-08; R6B-1 to R6B-10)
  | 'invalid_refund_request'
  | 'payment_not_refundable'
  | 'refund_capture_unverified'
  | 'refund_amount_not_full'
  | 'refund_dispute_open'
  | 'refund_dispute_unavailable'
  | 'refund_in_progress'
  | 'refund_already_recorded'
  | 'refund_attempt_conflict'
  | 'refund_authorization_invalid'
  | 'refund_authorization_expired'
  | 'refund_authorization_unresolved'
  | 'refund_case_completed' // Core V2 S6c (FC-3, frozen)
  // Core V2 S6e-D (PAY-09 to PAY-11, R6E-3)
  | 'invalid_dispute_request'
  | 'dispute_not_open'
  | 'dispute_evidence_invalid'
  | 'dispute_evidence_unavailable'
  | 'dispute_decision_exists'
  | 'dispute_decision_refused'
  | 'dispute_decision_conflict'
  | 'dispute_decision_unresolved'
  | 'owner_authority_unavailable'
  | 'simulation_nothing_to_dispute'
  // Core V2 S6h (PAY-12, PAY-13; R6H-3)
  | 'invalid_reconciliation_request'
  | 'provider_fact_matched'
  | 'fact_already_associated'
  | 'provider_fact_association_invalid'
  | 'provider_fact_association_refused'
  | 'provider_fact_association_conflict'
  | 'provider_fact_association_unresolved';

/** `message`: a catalog entry (localized, ADR-0054), or a plain English string for the D10-deferred messages that echo a client value. */
export function paymentError(status: number, code: ErrorCode, message: string | MessageTexts, params?: MessageParams): HttpException {
  return httpError(status, code, message, params);
}

/** The caller has no relation to the resource: collapsed with "does not exist" so existence is never leaked. */
export function notFound(): HttpException {
  return paymentError(404, 'not_found', PAYMENT_MESSAGES.notFound);
}

export function operationNotPermitted(): HttpException {
  return paymentError(403, 'operation_not_permitted', PAYMENT_MESSAGES.operationNotPermitted);
}

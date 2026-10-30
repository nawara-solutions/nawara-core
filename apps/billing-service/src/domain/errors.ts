import type { HttpException } from '@nestjs/common';
import { httpError, type MessageParams, type MessageTexts } from '@nawara/service-kit';
import { BILLING_MESSAGES } from '../messages.js';

/** The stable, machine-readable error codes of SDD section 18.2, carried in the kit's additive `code` field. */
export type BillingErrorCode =
  | 'invalid_invoice_request'
  | 'invalid_product_request'
  | 'invalid_price_request'
  | 'unauthorized'
  | 'operation_not_permitted'
  | 'not_found'
  | 'invoice_request_conflict'
  | 'product_conflict'
  | 'price_conflict'
  | 'invalid_state_transition'
  | 'invoice_not_payable'
  | 'payment_request_not_supported'
  | 'invoice_has_active_payment_request'
  | 'payment_request_in_flight'
  | 'payment_unavailable'
  | 'idempotency_key_required'
  | 'unsupported_currency'
  | 'price_not_available'
  | 'ambiguous_subscription_obligation'
  | 'subscription_conflict'
  | 'invalid_subscription_transition'
  | 'invalid_subscription_period'
  | 'subscription_grace_unavailable'
  | 'subscription_price_not_recurring' // Core V2 S3a
  | 'invoice_routing_invalid' // Core V2 S3a (register BIL-08)
  | 'platform_not_configured' // Core V2 S3d (register BIL-01, BIL-02)
  | 'billing_platform_exists' // Core V2 S3d (register BIL-01)
  | 'invalid_billing_platform_request' // Core V2 S3d
  | 'invalid_fee_request' // Core V2 S3f (register BIL-04 to BIL-07)
  | 'fee_above_cap'
  | 'fee_proposal_not_pending'
  | 'fee_proposal_pending_exists'
  | 'product_not_available'
  | 'idempotency_key_conflict'
  | 'invalid_checkout_request' // Core V2 S3f direct checkout (register BIL-10)
  | 'member_not_eligible'
  | 'checkout_uncertain'
  | 'invalid_assistance_request' // Core V2 S5a Organization assistance (register BIL-13 to BIL-15)
  | 'assistance_request_open'
  | 'assistance_request_not_pending'
  | 'cash_collection_time_invalid'
  | 'cash_collection_already_reported'
  | 'fee_not_usable'
  | 'assistance_request_not_settleable' // Core V2 S5b assisted settlement and cash return (register BIL-16, BIL-17)
  | 'settlement_channel_open'
  | 'cash_return_not_open'
  | 'cash_return_time_invalid'
  | 'cash_return_not_reported' // Core V2 S5c confirmation, disputes and corrections (register BIL-18 to BIL-22)
  | 'cash_return_already_confirmed'
  | 'assistance_dispute_open'
  | 'assistance_dispute_not_open'
  | 'dispute_not_permitted'
  | 'dispute_response_exists'
  | 'correction_not_permitted'
  | 'correction_time_invalid'
  | 'resolution_not_permitted'
  | 'step_up_required'
  | 'assistance_restricted' // Core V2 S5d (register BIL-13 C; S5D-4)
  | 'invalid_refund_request' // Core V2 S6a refund cases (register BIL-23, BIL-25)
  | 'refund_not_eligible'
  | 'refund_case_exists'
  | 'refund_dispute_open'
  | 'refund_dispute_unavailable' // Core V2 S6e-D (R6E-4): Payment's exposure could not be established
  | 'refund_case_not_open'
  // Core V2 S6b refund authorization relay (register BIL-24; R6B-10)
  | 'refund_case_completed'
  | 'refund_authorization_in_progress'
  | 'refund_authorization_invalid'
  | 'refund_authorization_expired'
  | 'refund_authorization_unresolved'
  | 'refund_authorization_conflict'
  | 'refund_rejected_by_payment'
  | 'refund_payment_unavailable'
  | 'refund_processing_started'
  // Core V2 S6e-H fraud holds (register BIL-27)
  | 'invalid_fraud_hold_request'
  | 'fraud_hold_active'
  | 'fraud_hold_not_active'
  | 'fraud_hold_conflict'
  | 'fraud_evidence_invalid'
  | 'fraud_evidence_unavailable'
  | 'fraud_hold_authorization_refused'
  | 'fraud_hold_authorization_unresolved'
  | 'fraud_hold_unavailable'
  // Core V2 S6f recovery (register BIL-28 to BIL-31; R6F-1 to R6F-8)
  | 'invalid_recovery_request'
  | 'recovery_obligation_closed'
  | 'surplus_not_owed'
  | 'surplus_not_evidenced'
  | 'surplus_evidence_invalid'
  | 'surplus_evidence_unavailable'
  | 'recovery_authorization_refused'
  | 'recovery_authorization_unresolved'
  | 'recovery_authorization_unavailable'
  // Core V2 S6h-B reconciliation and losses (register BIL-33, BIL-34; R6H-1 to R6H-12)
  | 'invalid_reconciliation_request'
  | 'reconciliation_case_not_acknowledgeable'
  | 'reconciliation_case_resolved'
  | 'write_off_not_permitted'
  // Core V2 S6g late assisted settlement application (register BIL-32; R6G-1 to R6G-9)
  | 'invalid_late_settlement_request'
  | 'late_settlement_refused'
  | 'late_settlement_already_attested'
  | 'late_settlement_evidence_invalid'
  | 'late_settlement_evidence_unavailable'
  | 'late_settlement_authorization_refused'
  | 'late_settlement_authorization_unresolved'
  | 'late_settlement_authorization_unavailable';

/**
 * `message`: a catalog entry (localized, ADR-0054), or a plain English string for the D10-deferred messages that carry a client-derived
 * value (the snapshot-validation messages, the anchored-period message).
 */
export function billingError(status: number, code: BillingErrorCode, message: string | MessageTexts, params?: MessageParams): HttpException {
  return httpError(status, code, message, params);
}

/** The caller has no relation to the resource: collapsed with "does not exist" so existence is never leaked (SDD 19.2). */
export const notFound = (): HttpException => billingError(404, 'not_found', BILLING_MESSAGES.notFound);

export const operationNotPermitted = (): HttpException => billingError(403, 'operation_not_permitted', BILLING_MESSAGES.operationNotPermitted);

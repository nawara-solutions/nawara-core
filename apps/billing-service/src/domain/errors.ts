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
  | 'subscription_grace_unavailable';

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

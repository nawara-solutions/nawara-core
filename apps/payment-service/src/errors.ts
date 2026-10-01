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
  | 'payment_not_payable'
  | 'payment_expired'
  | 'payment_has_open_attempt'
  | 'invalid_state_transition'
  | 'idempotency_key_reused'
  | 'unsupported_currency'
  | 'invalid_provider'
  | 'provider_error'
  | 'provider_unavailable'
  | 'auth_unavailable';

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

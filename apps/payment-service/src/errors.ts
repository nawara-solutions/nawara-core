import { HttpException } from '@nestjs/common';

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

export function paymentError(status: number, code: ErrorCode, message: string): HttpException {
  return new HttpException({ message, code }, status);
}

/** The caller has no relation to the resource: collapsed with "does not exist" so existence is never leaked. */
export function notFound(): HttpException {
  return paymentError(404, 'not_found', 'Not found.');
}

export function operationNotPermitted(): HttpException {
  return paymentError(403, 'operation_not_permitted', 'You may not perform this operation.');
}

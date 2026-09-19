import { HttpException } from '@nestjs/common';

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
  | 'idempotency_key_required'
  | 'unsupported_currency'
  | 'price_not_available';

export function billingError(status: number, code: BillingErrorCode, message: string): HttpException {
  return new HttpException({ message, code }, status);
}

/** The caller has no relation to the resource: collapsed with "does not exist" so existence is never leaked (SDD 19.2). */
export const notFound = (): HttpException => billingError(404, 'not_found', 'Not found.');

export const operationNotPermitted = (): HttpException => billingError(403, 'operation_not_permitted', 'You may not perform this operation.');

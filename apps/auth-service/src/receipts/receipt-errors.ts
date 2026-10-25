/**
 * The authorization receipts' typed INTERNAL errors (S2-Auth.1; ADR-0067; D-A2 receipt contract §15). Codes are stable and follow the
 * register's names; S2-Auth.2 maps them to HTTP when it adds the routes. Until then nothing reaches a client: no route calls the
 * service. A message never carries a secret, a step-up proof, a binding or a digest.
 */
export type ReceiptErrorCode =
  /** The receipt pepper is not configured: every receipt operation fails closed (Auth itself keeps working). */
  | 'receipt_unavailable'
  /** A malformed request field (idempotency key, consumption reference, caller). */
  | 'validation_error'
  /** The binding is malformed, is not for this caller, or names a Company the Owner does not own (F-2). */
  | 'receipt_binding_invalid'
  /** The same idempotency key was used with a different request. */
  | 'idempotency_key_reused'
  /** A replay of an issue whose receipt was still `issued`: it is now voided; a new step-up and receipt are needed (F-5). */
  | 'receipt_issued_response_lost'
  /** A replay of an issue whose receipt was already consumed: never voided, no secret (F-6). */
  | 'receipt_already_consumed'
  /** No receipt matches the secret and binding, or it was voided: one code, so nothing is revealed about which part differed. */
  | 'receipt_invalid'
  /** The receipt is `issued` but its 10 minutes are over; nothing changes (F-8; Q6). */
  | 'receipt_expired'
  /** The issuer is no longer an active Owner of the bound Company: refused, the receipt is NOT consumed (F-11; Q7). */
  | 'authority_revoked'
  /** The receipt was consumed under another reference, or this reference already consumed another receipt (F-9, F-18). */
  | 'consume_ref_conflict'
  /** No consumption under this reference for this caller and binding (recovery lookup, F-10). */
  | 'not_found';

export class ReceiptError extends Error {
  constructor(readonly code: ReceiptErrorCode) {
    super(code);
    this.name = 'ReceiptError';
  }
}

export const receiptError = (code: ReceiptErrorCode) => new ReceiptError(code);

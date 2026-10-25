import type { HttpException } from '@nestjs/common';
import { authError, notFound, type AuthErrorCode } from '../errors.js';
import { AUTH_MESSAGES } from '../messages.js';
import { ReceiptError, type ReceiptErrorCode } from './receipt-errors.js';

/**
 * The HTTP answer of every typed receipt error (Core V2 S2-Auth.2; D-A2 receipt contract §15). Messages are generic: none names a field,
 * a value, a digest or which part of a receipt differed.
 */
const HTTP: Record<Exclude<ReceiptErrorCode, 'not_found' | 'validation_error'>, { status: number; message: keyof typeof AUTH_MESSAGES }> = {
  receipt_unavailable: { status: 503, message: 'receiptUnavailable' },
  receipt_outcome_unknown: { status: 503, message: 'receiptOutcomeUnknown' },
  receipt_binding_invalid: { status: 400, message: 'receiptBindingInvalid' },
  idempotency_key_reused: { status: 409, message: 'idempotencyKeyReused' },
  receipt_issued_response_lost: { status: 409, message: 'receiptIssuedResponseLost' },
  receipt_already_consumed: { status: 409, message: 'receiptAlreadyConsumed' },
  receipt_invalid: { status: 409, message: 'receiptInvalid' },
  receipt_expired: { status: 409, message: 'receiptExpired' },
  authority_revoked: { status: 403, message: 'authorityRevoked' },
  consume_ref_conflict: { status: 409, message: 'consumeRefConflict' },
};

export function receiptHttpError(e: ReceiptError): HttpException {
  if (e.code === 'not_found') return notFound();
  // a malformed idempotency key, consumeRef or caller: the DTOs already refuse most; the rest is Auth's generic validation answer
  if (e.code === 'validation_error') return authError(400, 'validation_error', 'Bad Request');
  const m = HTTP[e.code];
  return authError(m.status, e.code satisfies AuthErrorCode, AUTH_MESSAGES[m.message]);
}

/** Runs a receipt operation and turns its typed errors into HTTP answers; every other error passes unchanged. */
export async function asHttp<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    throw e instanceof ReceiptError ? receiptHttpError(e) : e;
  }
}

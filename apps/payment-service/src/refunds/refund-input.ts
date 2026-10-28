import { paymentError } from '../errors.js';
import { PAYMENT_MESSAGES } from '../messages.js';
import type { RefundRequestInput } from './refund-attempt.service.js';
import { REFUND_REASONS, type RefundReason } from './refund.types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURRENCY = /^[A-Z]{3}$/;
/** An Auth receipt secret: base64url of 32 random bytes (AUTH-01). */
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const FIELDS = ['refundAttemptId', 'refundCaseId', 'amount', 'currency', 'reason', 'legalOverride', 'receiptSecret'];

const invalid = () => paymentError(400, 'invalid_refund_request', PAYMENT_MESSAGES.invalidRefundRequest);

/**
 * PAY-07's body (R6B-1): exactly these fields. The refund attempt id is chosen by the producer (it is also the receipt `consumeRef` and the
 * provider key); the amount and currency must be the payment's full captured amount (checked against Payment's rows, never trusted); there is
 * no Company, payer, provider or outcome field. The answer never echoes a value, so the secret can never be reflected.
 */
export function normaliseRefundRequest(raw: unknown): RefundRequestInput {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw invalid();
  const v = raw as Record<string, unknown>;
  if (Object.keys(v).some((k) => !FIELDS.includes(k))) throw invalid();
  if (typeof v.refundAttemptId !== 'string' || !UUID.test(v.refundAttemptId)) throw invalid();
  if (typeof v.refundCaseId !== 'string' || !UUID.test(v.refundCaseId)) throw invalid();
  if (typeof v.amount !== 'number' || !Number.isSafeInteger(v.amount) || v.amount < 1) throw invalid();
  if (typeof v.currency !== 'string' || !CURRENCY.test(v.currency)) throw invalid();
  if (typeof v.reason !== 'string' || !(REFUND_REASONS as readonly string[]).includes(v.reason)) throw invalid();
  if (typeof v.legalOverride !== 'boolean') throw invalid();
  if (typeof v.receiptSecret !== 'string' || !SECRET.test(v.receiptSecret)) throw invalid();
  return {
    refundAttemptId: v.refundAttemptId, refundCaseId: v.refundCaseId, amount: v.amount, currency: v.currency, reason: v.reason as RefundReason,
    legalOverride: v.legalOverride, receiptSecret: v.receiptSecret,
  };
}

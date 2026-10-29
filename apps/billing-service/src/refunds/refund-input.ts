import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Core V2 S6a (R6A-4): the closed reason codes. Classification and audit context only: a reason bypasses no constraint. */
/** Core V2 S6f (R6F-5 Path A): `recovery_surplus`, only for a case refunding an entirely surplus recovery payment (and required for it). */
export const REFUND_REASONS = ['duplicate_charge', 'service_not_provided', 'customer_request', 'late_settlement_unapplied', 'legal_requirement', 'recovery_surplus'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export interface RefundCaseInput {
  paymentId: string;
  reason: RefundReason;
  /** R6A-5 (Q1): recorded in the case and its audit evidence; grants no permission and bypasses nothing. */
  legalOverride: boolean;
}

const bad = (message: (typeof BILLING_MESSAGES)[keyof typeof BILLING_MESSAGES], params?: Record<string, string>) =>
  billingError(400, 'invalid_refund_request', message, params);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * BIL-23 (R6A-1, R6A-4, R6A-5): `{paymentId, reason, legalOverride?}` and nothing else. The amount, currency, seller, Platform and basis are
 * never request values: Billing derives them from its own records (no partial refund, D4).
 */
export function normaliseRefundCaseInput(raw: unknown): RefundCaseInput {
  if (!isObject(raw)) throw bad(BILLING_MESSAGES.requestMustBeObject);
  for (const k of Object.keys(raw)) if (!['paymentId', 'reason', 'legalOverride'].includes(k)) throw bad(BILLING_MESSAGES.unknownField, { name: k });
  if (typeof raw.paymentId !== 'string' || !UUID.test(raw.paymentId)) throw bad(BILLING_MESSAGES.mustBeUuid, { field: 'paymentId' });
  if (typeof raw.reason !== 'string' || !(REFUND_REASONS as readonly string[]).includes(raw.reason)) {
    throw bad(BILLING_MESSAGES.valueOneOf, { field: 'reason', values: REFUND_REASONS.join(', ') });
  }
  if (raw.legalOverride !== undefined && typeof raw.legalOverride !== 'boolean') throw bad(BILLING_MESSAGES.valueOneOf, { field: 'legalOverride', values: 'true, false' });
  return { paymentId: raw.paymentId.toLowerCase(), reason: raw.reason as RefundReason, legalOverride: raw.legalOverride === true };
}

/** A cancellation carries no body (an empty object, or none). */
export function normaliseEmptyInput(raw: unknown): void {
  if (raw === undefined || raw === null || (isObject(raw) && Object.keys(raw).length === 0)) return;
  if (!isObject(raw)) throw bad(BILLING_MESSAGES.requestMustBeObject);
  throw bad(BILLING_MESSAGES.unknownField, { name: Object.keys(raw)[0]! });
}

export const isRefundId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** An Auth receipt secret: base64url of 32 random bytes (AUTH-01). */
const RECEIPT_SECRET = /^[A-Za-z0-9_-]{43}$/;

/**
 * Core V2 S6b (BIL-24): `{receiptSecret}` and nothing else. The binding (amount, currency, reason, legal override, payment, Company) is the
 * case's own; `expiresAt` is not accepted (Auth alone decides expiry, R6B-9). The secret is held in memory for this request only (F-12):
 * never stored, logged, hashed for replay or echoed (no validation message names its value).
 */
export function normaliseRefundAuthorizationInput(raw: unknown): { receiptSecret: string } {
  if (!isObject(raw)) throw bad(BILLING_MESSAGES.requestMustBeObject);
  for (const k of Object.keys(raw)) if (k !== 'receiptSecret') throw bad(BILLING_MESSAGES.unknownField, { name: k });
  if (typeof raw.receiptSecret !== 'string' || !RECEIPT_SECRET.test(raw.receiptSecret)) throw bad(BILLING_MESSAGES.valueOneOf, { field: 'receiptSecret', values: 'an authorization receipt secret' });
  return { receiptSecret: raw.receiptSecret };
}

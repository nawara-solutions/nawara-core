import { createHash } from 'node:crypto';

/** Core V2 S6b (R6B-3): the states of a refund attempt (migration 0017 enforces their transitions). */
export const REFUND_ATTEMPT_STATUSES = [
  'authorization_pending', 'authorized', 'authorization_expired', 'authorization_refused', 'dispatching', 'submitted', 'succeeded', 'failed', 'unknown',
  'discrepancy',
] as const;
export type RefundAttemptStatus = (typeof REFUND_ATTEMPT_STATUSES)[number];

/** The states that can no longer produce a refund: only these free the payment for a new attempt (R6B-3, R6B-10). */
export const NOT_EFFECTIVE: readonly RefundAttemptStatus[] = ['authorization_expired', 'authorization_refused', 'failed'];

/** Core V2 S6a (R6A-4): the closed reason codes, carried unchanged from the refund case into the receipt binding. */
export const REFUND_REASONS = ['duplicate_charge', 'service_not_provided', 'customer_request', 'late_settlement_unapplied', 'legal_requirement', 'recovery_surplus'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

/** Shape of the `refund_attempt` row (migration 0017). Column names match the database exactly. */
export interface RefundAttemptRow {
  id: string;
  paymentId: string;
  producer: string;
  refundCaseId: string;
  companyId: string;
  amount: string; // bigint arrives from `pg` as a string
  currency: string;
  reason: RefundReason;
  legalOverride: boolean;
  captureFactId: string;
  capturedAttemptId: string;
  provider: string;
  liveMode: boolean;
  receiptDigest: string;
  status: RefundAttemptStatus;
  authorizationRefusal: 'receipt_invalid' | 'receipt_binding_invalid' | 'receipt_expired' | null;
  receiptId: string | null;
  approvedByUserId: string | null;
  consumedAt: Date | null;
  providerRefundId: string | null;
  failureCode: string | null;
  workAfter: Date | null;
  requestedAt: Date;
  authorizedAt: Date | null;
  submittedAt: Date | null;
  completedAt: Date | null;
  succeededFactId: string | null;
}

/**
 * The receipt binding of ADR-0067 decision 1 (F-2), built ONLY from Payment's own durable attempt: Auth's digest proves the Owner approved
 * exactly this. `companyId` is the payment's seller Company, never a request value.
 */
export interface RefundBinding {
  operation: 'refund';
  audience: 'payment-service';
  companyId: string;
  refundCaseId: string;
  paymentId: string;
  amount: number;
  currency: string;
  reason: string;
  legalOverride: boolean;
}

/**
 * Core V2 S6e-D (the Owner's R6E-3; Auth's `dispute_decision` receipt binding, receipt contract §17a): an Owner's contest-or-accept decision on
 * one Payment dispute of their Company. Auth issues it only after the dedicated factor-only dispute-decision step-up.
 */
export interface DisputeDecisionBinding {
  operation: 'dispute_decision';
  audience: 'payment-service';
  companyId: string;
  disputeId: string;
  paymentId: string;
  decision: 'contest' | 'accept';
}

/** Every receipt binding Payment consumes. */
/** Core V2 S6h (R6H-3; Auth #400): an Owner's association of one unmatched provider fact with one destination, exactly as Auth issued it. */
export interface ProviderFactAssociateBinding {
  operation: 'provider_fact_associate';
  audience: 'payment-service';
  companyId: string;
  factId: string;
  kind: 'capture' | 'refund' | 'chargeback';
  amount: number;
  currency: string;
  targetType: 'payment' | 'refund_authorization';
  targetId: string;
}

export type ReceiptBinding = RefundBinding | DisputeDecisionBinding | ProviderFactAssociateBinding;

export function bindingOf(a: Pick<RefundAttemptRow, 'companyId' | 'refundCaseId' | 'paymentId' | 'amount' | 'currency' | 'reason' | 'legalOverride'>): RefundBinding {
  return {
    operation: 'refund', audience: 'payment-service', companyId: a.companyId, refundCaseId: a.refundCaseId, paymentId: a.paymentId,
    amount: Number(a.amount), currency: a.currency.trim(), reason: a.reason, legalOverride: a.legalOverride,
  };
}

/**
 * R6B-9: the attempt is bound to ONE receipt. A domain-separated SHA-256 of the receipt secret (256 random bits, so the digest reveals nothing
 * and cannot be brute-forced); it lets a lost response be recovered with the same receipt and refuses any other. Never a replay hash, never
 * logged, never audited; the secret itself is never stored.
 */
export function receiptDigest(secret: string): string {
  return createHash('sha256').update('nawara.payment.refund.receipt.v1\u0000').update(secret, 'utf8').digest('hex');
}

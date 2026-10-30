import { hmacHex } from '../crypto/hmac.js';
import { canonicalJson } from '../hierarchy/snapshot.js';
import { DISPUTE_DECIDE_PURPOSE, FRAUD_HOLD_PLACE_PURPOSE, FRAUD_HOLD_RELEASE_PURPOSE, LATE_SETTLEMENT_APPLY_PURPOSE, REFUND_AUTHORIZE_PURPOSE, SURPLUS_EXTERNAL_PURPOSE } from '../owner/step-up.service.js';
import { receiptError } from './receipt-errors.js';

/**
 * The binding of an authorization receipt (ADR-0067 decision 1, F-2): exactly what the Owner approved. Its field set is frozen; its
 * types follow the D-A2 contract §5.1 and the Owner's S2-Auth.1 decisions: `legalOverride` is a boolean, `false` unless given (Q1), and
 * `reason` a bounded reason code, never free text (Q2). A legal override flag confers no authority of its own: it is only part of what
 * the Owner approved, and therefore of the digest.
 */
export interface RefundBinding {
  operation: 'refund';
  audience: 'payment-service';
  companyId: string;
  refundCaseId: string;
  paymentId: string;
  /** minor units, > 0 */
  amount: number;
  /** ISO 4217, upper case */
  currency: string;
  reason: string;
  legalOverride: boolean;
}

/**
 * Core V2 S6e Auth prerequisite (the Owner's R6E-3, 2026-10-29): the binding of an Owner's decision on one Payment dispute. Exactly what the
 * Owner decided: their own Company, the dispute, its payment and the decision itself, so a receipt for one dispute or decision can never
 * authorize another. Only `payment-service` consumes it. It is issued after the dedicated factor-only dispute-decision step-up,
 * never the refund-authorization one (and a refund receipt never after this one's proof): see `RECEIPT_PURPOSES`.
 */
export interface DisputeDecisionBinding {
  operation: 'dispute_decision';
  audience: 'payment-service';
  companyId: string;
  disputeId: string;
  paymentId: string;
  decision: 'contest' | 'accept';
}

/**
 * Core V2 S6e-H Auth prerequisite (the Owner's H-2, 2026-10-29): an Owner's placement or release of ONE fraud hold on one beneficiary's
 * Personal entitlement to one product of their Company. Exactly what the Owner approved: the Company, the hold (its id chosen before
 * placement), the beneficiary, the product and, for a placement, its bounded reason code. Only `billing-service` consumes them; each is
 * issued only after its own dedicated factor-only step-up (`RECEIPT_PURPOSES`), so a placement proof never releases and the reverse.
 */
export interface FraudHoldPlaceBinding {
  operation: 'fraud_hold_place';
  audience: 'billing-service';
  companyId: string;
  holdId: string;
  beneficiaryUserId: string;
  productId: string;
  reason: string;
}

export interface FraudHoldReleaseBinding {
  operation: 'fraud_hold_release';
  audience: 'billing-service';
  companyId: string;
  holdId: string;
  beneficiaryUserId: string;
  productId: string;
}

/**
 * Core V2 S6f Auth prerequisite (the Owner's R6F-5, 2026-10-29): an Owner's record that ONE recovery surplus, owed to one Organization, was
 * repaid outside Core: the Company, the surplus, the Organization, the exact amount (minor units) and currency. Only `billing-service`
 * consumes it, after the dedicated factor-only step-up. It moves no money and is not a provider fact.
 */
export interface SurplusExternalBinding {
  operation: 'recovery_surplus_external';
  audience: 'billing-service';
  companyId: string;
  surplusId: string;
  organizationId: string;
  amount: number;
  currency: string;
}

/** Core V2 S6g (the Owner's R6G-3, 2026-10-30): the closed L-4 reason codes, each requiring its own evidence path in Billing. */
export const LATE_SETTLEMENT_REASONS = ['cash_not_returned_attested', 'cash_not_returned_evidenced'] as const;

/**
 * Core V2 S6g Auth prerequisite (the Owner's R6G-1, 2026-10-30): an Owner's exceptional application (S0 §3.4 L-4) of ONE verified late
 * assisted settlement as its assistance request's single purchase: the Company, the late settlement, the request, its beneficiary and the
 * closed reason code. Only `billing-service` consumes it, after the dedicated factor-only step-up. It moves no money and proves no
 * evidence: Billing still checks every L-4 / L-6 condition.
 */
export interface LateSettlementApplyBinding {
  operation: 'late_settlement_apply';
  audience: 'billing-service';
  companyId: string;
  lateSettlementId: string;
  assistanceRequestId: string;
  beneficiaryUserId: string;
  reasonCode: (typeof LATE_SETTLEMENT_REASONS)[number];
}

/** Every receipt binding. `operation` selects the exact field set; the canonical form (and so every digest) includes it. */
export type ReceiptBinding = RefundBinding | DisputeDecisionBinding | FraudHoldPlaceBinding | FraudHoldReleaseBinding | SurplusExternalBinding | LateSettlementApplyBinding;
export type ReceiptOperation = ReceiptBinding['operation'];

export const RECEIPT_AUDIENCE = 'payment-service';

/** The one audience each operation names (and so the only service that may consume it, F-7). */
export const RECEIPT_AUDIENCES = {
  refund: 'payment-service', dispute_decision: 'payment-service', fraud_hold_place: 'billing-service', fraud_hold_release: 'billing-service',
  recovery_surplus_external: 'billing-service', late_settlement_apply: 'billing-service',
} as const satisfies Record<ReceiptOperation, string>;

/** The one step-up purpose each operation's issuance consumes (Auth-local purposes, `step-up.service.ts`). */
export const RECEIPT_PURPOSES = {
  refund: REFUND_AUTHORIZE_PURPOSE, dispute_decision: DISPUTE_DECIDE_PURPOSE, fraud_hold_place: FRAUD_HOLD_PLACE_PURPOSE, fraud_hold_release: FRAUD_HOLD_RELEASE_PURPOSE,
  recovery_surplus_external: SURPLUS_EXTERNAL_PURPOSE, late_settlement_apply: LATE_SETTLEMENT_APPLY_PURPOSE,
} as const satisfies Record<ReceiptOperation, string>;

const FIELDS = ['operation', 'audience', 'companyId', 'refundCaseId', 'paymentId', 'amount', 'currency', 'reason', 'legalOverride'] as const;
const OPTIONAL = new Set(['legalOverride']);
const DISPUTE_FIELDS = ['operation', 'audience', 'companyId', 'disputeId', 'paymentId', 'decision'] as const;
const DECISIONS: readonly string[] = ['contest', 'accept'];
const HOLD_PLACE_FIELDS = ['operation', 'audience', 'companyId', 'holdId', 'beneficiaryUserId', 'productId', 'reason'] as const;
const HOLD_RELEASE_FIELDS = ['operation', 'audience', 'companyId', 'holdId', 'beneficiaryUserId', 'productId'] as const;
const SURPLUS_FIELDS = ['operation', 'audience', 'companyId', 'surplusId', 'organizationId', 'amount', 'currency'] as const;
const LATE_FIELDS = ['operation', 'audience', 'companyId', 'lateSettlementId', 'assistanceRequestId', 'beneficiaryUserId', 'reasonCode'] as const;
/** Canonical lower-case UUIDs only: two spellings of one id must never yield two digests. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CURRENCY = /^[A-Z]{3}$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;

/** Domain labels: one per digest, versioned, so a change of the binding is a new domain, never a reinterpretation (D-A2 §6). */
export const RECEIPT_DOMAINS = {
  binding: 'nawara.auth.receipt.binding.v1',
  secret: 'nawara.auth.receipt.secret.v1',
  request: 'nawara.auth.receipt.request.v1',
} as const;

/**
 * Parses exactly one operation's fields (F-2 for a refund; R6E-3 for a dispute decision); anything unknown, missing or of the wrong type is
 * `receipt_binding_invalid`.
 */
export function parseBinding(value: unknown): ReceiptBinding {
  const invalid = () => receiptError('receipt_binding_invalid');
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const v = value as Record<string, unknown>;
  if (v.operation === 'dispute_decision') return parseDisputeDecision(v);
  if (v.operation === 'fraud_hold_place' || v.operation === 'fraud_hold_release') return parseFraudHold(v);
  if (v.operation === 'recovery_surplus_external') return parseSurplusExternal(v);
  if (v.operation === 'late_settlement_apply') return parseLateSettlementApply(v);
  for (const k of Object.keys(v)) if (!(FIELDS as readonly string[]).includes(k)) throw invalid();
  for (const k of FIELDS) if (!OPTIONAL.has(k) && !(k in v)) throw invalid();
  const legalOverride = v.legalOverride === undefined ? false : v.legalOverride;
  if (v.operation !== 'refund' || v.audience !== RECEIPT_AUDIENCE) throw invalid();
  for (const k of ['companyId', 'refundCaseId', 'paymentId'] as const) if (typeof v[k] !== 'string' || !UUID.test(v[k] as string)) throw invalid();
  if (typeof v.amount !== 'number' || !Number.isSafeInteger(v.amount) || v.amount <= 0) throw invalid();
  if (typeof v.currency !== 'string' || !CURRENCY.test(v.currency)) throw invalid();
  if (typeof v.reason !== 'string' || !REASON.test(v.reason)) throw invalid();
  if (typeof legalOverride !== 'boolean') throw invalid();
  return {
    operation: 'refund', audience: RECEIPT_AUDIENCE, companyId: v.companyId as string, refundCaseId: v.refundCaseId as string,
    paymentId: v.paymentId as string, amount: v.amount, currency: v.currency, reason: v.reason, legalOverride,
  };
}

function parseDisputeDecision(v: Record<string, unknown>): DisputeDecisionBinding {
  const invalid = () => receiptError('receipt_binding_invalid');
  for (const k of Object.keys(v)) if (!(DISPUTE_FIELDS as readonly string[]).includes(k)) throw invalid();
  for (const k of DISPUTE_FIELDS) if (!(k in v)) throw invalid();
  if (v.audience !== RECEIPT_AUDIENCE) throw invalid();
  for (const k of ['companyId', 'disputeId', 'paymentId'] as const) if (typeof v[k] !== 'string' || !UUID.test(v[k] as string)) throw invalid();
  if (typeof v.decision !== 'string' || !DECISIONS.includes(v.decision)) throw invalid();
  return {
    operation: 'dispute_decision', audience: RECEIPT_AUDIENCE, companyId: v.companyId as string, disputeId: v.disputeId as string,
    paymentId: v.paymentId as string, decision: v.decision as 'contest' | 'accept',
  };
}

function parseFraudHold(v: Record<string, unknown>): FraudHoldPlaceBinding | FraudHoldReleaseBinding {
  const invalid = () => receiptError('receipt_binding_invalid');
  const place = v.operation === 'fraud_hold_place';
  const fields: readonly string[] = place ? HOLD_PLACE_FIELDS : HOLD_RELEASE_FIELDS;
  for (const k of Object.keys(v)) if (!fields.includes(k)) throw invalid();
  for (const k of fields) if (!(k in v)) throw invalid();
  if (v.audience !== 'billing-service') throw invalid();
  for (const k of ['companyId', 'holdId', 'beneficiaryUserId', 'productId'] as const) if (typeof v[k] !== 'string' || !UUID.test(v[k] as string)) throw invalid();
  const ids = { audience: 'billing-service' as const, companyId: v.companyId as string, holdId: v.holdId as string, beneficiaryUserId: v.beneficiaryUserId as string, productId: v.productId as string };
  if (!place) return { operation: 'fraud_hold_release', ...ids };
  if (typeof v.reason !== 'string' || !REASON.test(v.reason)) throw invalid();
  return { operation: 'fraud_hold_place', ...ids, reason: v.reason };
}

function parseSurplusExternal(v: Record<string, unknown>): SurplusExternalBinding {
  const invalid = () => receiptError('receipt_binding_invalid');
  for (const k of Object.keys(v)) if (!(SURPLUS_FIELDS as readonly string[]).includes(k)) throw invalid();
  for (const k of SURPLUS_FIELDS) if (!(k in v)) throw invalid();
  if (v.audience !== 'billing-service') throw invalid();
  for (const k of ['companyId', 'surplusId', 'organizationId'] as const) if (typeof v[k] !== 'string' || !UUID.test(v[k] as string)) throw invalid();
  if (typeof v.amount !== 'number' || !Number.isSafeInteger(v.amount) || v.amount <= 0) throw invalid();
  if (typeof v.currency !== 'string' || !CURRENCY.test(v.currency)) throw invalid();
  return {
    operation: 'recovery_surplus_external', audience: 'billing-service', companyId: v.companyId as string, surplusId: v.surplusId as string,
    organizationId: v.organizationId as string, amount: v.amount, currency: v.currency,
  };
}

function parseLateSettlementApply(v: Record<string, unknown>): LateSettlementApplyBinding {
  const invalid = () => receiptError('receipt_binding_invalid');
  for (const k of Object.keys(v)) if (!(LATE_FIELDS as readonly string[]).includes(k)) throw invalid();
  for (const k of LATE_FIELDS) if (!(k in v)) throw invalid();
  if (v.audience !== 'billing-service') throw invalid();
  for (const k of ['companyId', 'lateSettlementId', 'assistanceRequestId', 'beneficiaryUserId'] as const) if (typeof v[k] !== 'string' || !UUID.test(v[k] as string)) throw invalid();
  if (!(LATE_SETTLEMENT_REASONS as readonly unknown[]).includes(v.reasonCode)) throw invalid();
  return {
    operation: 'late_settlement_apply', audience: 'billing-service', companyId: v.companyId as string, lateSettlementId: v.lateSettlementId as string,
    assistanceRequestId: v.assistanceRequestId as string, beneficiaryUserId: v.beneficiaryUserId as string, reasonCode: v.reasonCode as LateSettlementApplyBinding['reasonCode'],
  };
}

/** `canonicalJson` (sorted keys) over exactly the fields of a parsed binding. Never logged, never stored. */
export const canonicalBinding = (b: ReceiptBinding): string => canonicalJson({ ...b });

export const bindingDigest = (pepper: Buffer, canonical: string) => hmacHex(pepper, RECEIPT_DOMAINS.binding, canonical);
export const secretDigest = (pepper: Buffer, secret: string) => hmacHex(pepper, RECEIPT_DOMAINS.secret, secret);
/** The issue replay hash covers the canonical binding only, never the step-up proof (D-A2 §12). */
export const requestHash = (pepper: Buffer, canonical: string) => hmacHex(pepper, RECEIPT_DOMAINS.request, canonical);

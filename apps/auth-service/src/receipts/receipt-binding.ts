import { hmacHex } from '../crypto/hmac.js';
import { canonicalJson } from '../hierarchy/snapshot.js';
import { DISPUTE_DECIDE_PURPOSE, REFUND_AUTHORIZE_PURPOSE } from '../owner/step-up.service.js';
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

/** Every receipt binding. `operation` selects the exact field set; the canonical form (and so every digest) includes it. */
export type ReceiptBinding = RefundBinding | DisputeDecisionBinding;
export type ReceiptOperation = ReceiptBinding['operation'];

export const RECEIPT_AUDIENCE = 'payment-service';

/** The one step-up purpose each operation's issuance consumes (Auth-local purposes, `step-up.service.ts`). */
export const RECEIPT_PURPOSES = { refund: REFUND_AUTHORIZE_PURPOSE, dispute_decision: DISPUTE_DECIDE_PURPOSE } as const satisfies Record<ReceiptOperation, string>;

const FIELDS = ['operation', 'audience', 'companyId', 'refundCaseId', 'paymentId', 'amount', 'currency', 'reason', 'legalOverride'] as const;
const OPTIONAL = new Set(['legalOverride']);
const DISPUTE_FIELDS = ['operation', 'audience', 'companyId', 'disputeId', 'paymentId', 'decision'] as const;
const DECISIONS: readonly string[] = ['contest', 'accept'];
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

/** `canonicalJson` (sorted keys) over exactly the fields of a parsed binding. Never logged, never stored. */
export const canonicalBinding = (b: ReceiptBinding): string => canonicalJson({ ...b });

export const bindingDigest = (pepper: Buffer, canonical: string) => hmacHex(pepper, RECEIPT_DOMAINS.binding, canonical);
export const secretDigest = (pepper: Buffer, secret: string) => hmacHex(pepper, RECEIPT_DOMAINS.secret, secret);
/** The issue replay hash covers the canonical binding only, never the step-up proof (D-A2 §12). */
export const requestHash = (pepper: Buffer, canonical: string) => hmacHex(pepper, RECEIPT_DOMAINS.request, canonical);

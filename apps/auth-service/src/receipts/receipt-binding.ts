import { hmacHex } from '../crypto/hmac.js';
import { canonicalJson } from '../hierarchy/snapshot.js';
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

export const RECEIPT_AUDIENCE = 'payment-service';

const FIELDS = ['operation', 'audience', 'companyId', 'refundCaseId', 'paymentId', 'amount', 'currency', 'reason', 'legalOverride'] as const;
const OPTIONAL = new Set(['legalOverride']);
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

/** Parses exactly the F-2 fields; anything unknown, missing or of the wrong type is `receipt_binding_invalid`. */
export function parseBinding(value: unknown): RefundBinding {
  const invalid = () => receiptError('receipt_binding_invalid');
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid();
  const v = value as Record<string, unknown>;
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

/** `canonicalJson` (sorted keys) over exactly the F-2 fields of a parsed binding. Never logged, never stored. */
export const canonicalBinding = (b: RefundBinding): string => canonicalJson({ ...b });

export const bindingDigest = (pepper: Buffer, canonical: string) => hmacHex(pepper, RECEIPT_DOMAINS.binding, canonical);
export const secretDigest = (pepper: Buffer, secret: string) => hmacHex(pepper, RECEIPT_DOMAINS.secret, secret);
/** The issue replay hash covers the canonical binding only, never the step-up proof (D-A2 §12). */
export const requestHash = (pepper: Buffer, canonical: string) => hmacHex(pepper, RECEIPT_DOMAINS.request, canonical);

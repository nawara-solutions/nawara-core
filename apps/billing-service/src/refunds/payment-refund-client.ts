import { correlationHeaders } from '@nawara/service-kit';

/** DI token of Billing's refund port to payment-service (Core V2 S6b; PAY-07, PAY-08). */
export const PAYMENT_REFUND_CLIENT = Symbol('BILLING_PAYMENT_REFUND_CLIENT');

/** Payment's authoritative refund attempt states (payment migration 0017). */
export const ATTEMPT_STATUSES = ['authorization_pending', 'authorized', 'authorization_expired', 'authorization_refused', 'dispatching', 'submitted', 'succeeded',
  'failed', 'unknown', 'discrepancy'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
/** Payment's permanent refusals of a refund attempt id before any attempt existed. */
export const PAYMENT_REFUSALS = ['payment_not_refundable', 'refund_capture_unverified', 'refund_amount_not_full', 'refund_dispute_open', 'refund_in_progress',
  'refund_already_recorded', 'refund_case_completed', 'refund_capture_not_eligible'] as const; // Core V2 S6c: refund_case_completed (FC-3); R6H-5
export type PaymentRefusal = (typeof PAYMENT_REFUSALS)[number];

export interface RefundAttemptSnapshot {
  refundAttemptId: string;
  status: AttemptStatus;
  approvedBy: { userId: string } | null;
}

/** PAY-07's body. The secret is relayed in memory for this call only (F-12): never stored, logged or hashed. */
export interface RefundRelayBody {
  refundAttemptId: string;
  refundCaseId: string;
  amount: number;
  currency: string;
  reason: string;
  legalOverride: boolean;
  receiptSecret: string;
  /** Core V2 R6H-5: present exactly for a capture-specific case (the Owner's receipt names the same capture) */
  captureFactId?: string;
}

/** Core V2 R6H-5: Payment's evidence of one verified capture of a payment (`GET /payment/payments/:id/captures/:factId`). */
export type CaptureBasis = 'settling_capture' | 'duplicate_capture' | 'other_attempt_capture' | 'late_capture' | 'associated_capture';
export interface PaymentCapture {
  factId: string;
  paymentId: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  basis: CaptureBasis;
  conflicted: boolean;
  refund: 'none' | 'in_progress' | 'refunded';
}
/** What Payment's capture read proves: the capture, or that this payment has no such capture (404); anything else proves nothing. */
export type CaptureReadOutcome = { kind: 'capture'; capture: PaymentCapture } | { kind: 'not_found' } | { kind: 'unknown'; reason: string };
const CAPTURE_BASES: readonly string[] = ['settling_capture', 'duplicate_capture', 'other_attempt_capture', 'late_capture', 'associated_capture'];
const CAPTURE_REFUND: readonly string[] = ['none', 'in_progress', 'refunded'];

/**
 * What Payment's answer to PAY-07 PROVES (R6B-10), classified once here:
 *   - `attempt`: the attempt exists in this authoritative state;
 *   - `terminal`: the attempt's authorization ended (Auth's definitive refusal or expiry, committed by Payment);
 *   - `refused`: Payment permanently refused this attempt id before any attempt existed;
 *   - `pending`: the attempt exists and its authorization is not confirmed yet (retry with the same key and receipt);
 *   - `conflict`: this attempt id is bound to other content or another receipt;
 *   - `unknown`: nothing is proven (a timeout, a lost connection, a 5xx, an auth fault, an unparseable answer): never read as a refusal.
 */
export type RefundRelayOutcome =
  | { kind: 'attempt'; attempt: RefundAttemptSnapshot }
  | { kind: 'terminal'; status: 'authorization_refused' | 'authorization_expired' }
  | { kind: 'refused'; code: PaymentRefusal }
  | { kind: 'pending' }
  | { kind: 'conflict' }
  | { kind: 'unknown'; reason: string };

/** Core V2 S6c (R6C-12): one of Payment's refund authorizations, with its financial completion (null until complete). */
export interface RefundAuthorizationSnapshot {
  refundAuthorizationId: string;
  refundAttemptId: string;
  refundCaseId: string;
  approvedAmount: number;
  currency: string;
  completedAt: string | null;
}

export interface PaymentRefunds {
  attempts: RefundAttemptSnapshot[];
  refusals: { refundAttemptId: string; code: PaymentRefusal }[];
  authorizations: RefundAuthorizationSnapshot[];
}

export interface PaymentRefundClient {
  relay(paymentId: string, idempotencyKey: string, body: RefundRelayBody): Promise<RefundRelayOutcome>;
  /** PAY-08: null on 404; throws when Payment cannot answer (the reconciler isolates it per relay). */
  refunds(paymentId: string): Promise<PaymentRefunds | null>;
  /** Core V2 R6H-5: one verified capture of the payment, as Payment's evidence states it */
  capture(paymentId: string, factId: string): Promise<CaptureReadOutcome>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function snapshot(v: unknown): RefundAttemptSnapshot | null {
  const a = v as { refundAttemptId?: unknown; status?: unknown; approvedBy?: { userId?: unknown } | null } | null;
  if (!a || typeof a.refundAttemptId !== 'string' || !UUID.test(a.refundAttemptId) || !(ATTEMPT_STATUSES as readonly unknown[]).includes(a.status)) return null;
  const approvedBy = typeof a.approvedBy?.userId === 'string' ? { userId: a.approvedBy.userId } : null;
  return { refundAttemptId: a.refundAttemptId, status: a.status as AttemptStatus, approvedBy };
}

/** Billing's OWN service token only (ADR-0033); an Owner's bearer is never forwarded to Payment. */
export class HttpPaymentRefundClient implements PaymentRefundClient {
  constructor(private readonly opts: { baseUrl: string; serviceToken: string; timeoutMs: number }) {}

  private async call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.opts.serviceToken}`, 'content-type': 'application/json', ...correlationHeaders(), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch {
      return { status: 0, body: null };
    }
    try {
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    } catch {
      return { status: res.status, body: null };
    }
  }

  async relay(paymentId: string, idempotencyKey: string, body: RefundRelayBody): Promise<RefundRelayOutcome> {
    const r = await this.call('POST', `/payment/payments/${encodeURIComponent(paymentId)}/refunds`, { 'idempotency-key': idempotencyKey }, body);
    const code = typeof r.body?.code === 'string' ? r.body.code : null;
    if (r.status === 200 || r.status === 201) {
      const a = snapshot(r.body);
      return a && a.refundAttemptId === body.refundAttemptId ? { kind: 'attempt', attempt: a } : { kind: 'unknown', reason: 'malformed_attempt' };
    }
    if (r.status === 409 && code === 'refund_authorization_invalid') return { kind: 'terminal', status: 'authorization_refused' };
    if (r.status === 409 && code === 'refund_authorization_expired') return { kind: 'terminal', status: 'authorization_expired' };
    if ((r.status === 409 || r.status === 422) && code && (PAYMENT_REFUSALS as readonly string[]).includes(code)) return { kind: 'refused', code: code as PaymentRefusal };
    if (r.status === 503 && code === 'refund_authorization_unresolved') return { kind: 'pending' };
    if (r.status === 409 && code === 'refund_attempt_conflict') return { kind: 'conflict' };
    return { kind: 'unknown', reason: code ?? `status_${r.status}` };
  }

  async capture(paymentId: string, factId: string): Promise<CaptureReadOutcome> {
    const r = await this.call('GET', `/payment/payments/${encodeURIComponent(paymentId)}/captures/${encodeURIComponent(factId)}`);
    if (r.status === 404) return { kind: 'not_found' };
    const b = r.body;
    if (r.status !== 200 || !b) return { kind: 'unknown', reason: `status_${r.status}` };
    if (b.factId !== factId || b.paymentId !== paymentId || typeof b.amount !== 'number' || !Number.isSafeInteger(b.amount) || b.amount < 1
      || typeof b.currency !== 'string' || !/^[A-Z]{3}$/.test(b.currency) || typeof b.paymentStatus !== 'string' || !CAPTURE_BASES.includes(b.basis as string)
      || typeof b.conflicted !== 'boolean' || !CAPTURE_REFUND.includes(b.refund as string)) {
      return { kind: 'unknown', reason: 'malformed_capture' };
    }
    return { kind: 'capture', capture: { factId, paymentId, amount: b.amount, currency: b.currency, paymentStatus: b.paymentStatus, basis: b.basis as CaptureBasis,
      conflicted: b.conflicted, refund: b.refund as PaymentCapture['refund'] } };
  }

  async refunds(paymentId: string): Promise<PaymentRefunds | null> {
    const r = await this.call('GET', `/payment/payments/${encodeURIComponent(paymentId)}/refunds`);
    if (r.status === 404) return null;
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.attempts) || !Array.isArray(r.body.refusals)) {
      throw new Error(`payment-service GET refunds failed (status ${r.status})`);
    }
    const attempts = r.body.attempts.map(snapshot);
    if (attempts.some((a) => a === null)) throw new Error('payment-service GET refunds: malformed attempt');
    const refusals = (r.body.refusals as { refundAttemptId?: unknown; code?: unknown }[]).map((x) => {
      if (typeof x.refundAttemptId !== 'string' || !(PAYMENT_REFUSALS as readonly unknown[]).includes(x.code)) throw new Error('payment-service GET refunds: malformed refusal');
      return { refundAttemptId: x.refundAttemptId, code: x.code as PaymentRefusal };
    });
    // Core V2 S6c: the authorizations (absent from a Payment older than S6c: none)
    const raw = Array.isArray(r.body.authorizations) ? (r.body.authorizations as Record<string, unknown>[]) : [];
    const authorizations = raw.map((z) => {
      if (![z.refundAuthorizationId, z.refundAttemptId, z.refundCaseId].every((v) => typeof v === 'string' && UUID.test(v)) || typeof z.approvedAmount !== 'number'
        || typeof z.currency !== 'string' || (z.completedAt !== null && typeof z.completedAt !== 'string')) throw new Error('payment-service GET refunds: malformed authorization');
      return { refundAuthorizationId: z.refundAuthorizationId as string, refundAttemptId: z.refundAttemptId as string, refundCaseId: z.refundCaseId as string,
        approvedAmount: z.approvedAmount, currency: z.currency, completedAt: (z.completedAt as string | null) ?? null };
    });
    return { attempts: attempts as RefundAttemptSnapshot[], refusals, authorizations };
  }
}

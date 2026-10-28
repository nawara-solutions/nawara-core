import { correlationHeaders } from '@nawara/service-kit';

/** DI token of Billing's refund port to payment-service (Core V2 S6b; PAY-07, PAY-08). */
export const PAYMENT_REFUND_CLIENT = Symbol('BILLING_PAYMENT_REFUND_CLIENT');

/** Payment's authoritative refund attempt states (payment migration 0017). */
export const ATTEMPT_STATUSES = ['authorization_pending', 'authorized', 'authorization_expired', 'authorization_refused', 'dispatching', 'submitted', 'succeeded',
  'failed', 'unknown', 'discrepancy'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];
/** Payment's permanent refusals of a refund attempt id before any attempt existed. */
export const PAYMENT_REFUSALS = ['payment_not_refundable', 'refund_capture_unverified', 'refund_amount_not_full', 'refund_dispute_open', 'refund_in_progress',
  'refund_already_recorded'] as const;
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
}

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

export interface PaymentRefunds {
  attempts: RefundAttemptSnapshot[];
  refusals: { refundAttemptId: string; code: PaymentRefusal }[];
}

export interface PaymentRefundClient {
  relay(paymentId: string, idempotencyKey: string, body: RefundRelayBody): Promise<RefundRelayOutcome>;
  /** PAY-08: null on 404; throws when Payment cannot answer (the reconciler isolates it per relay). */
  refunds(paymentId: string): Promise<PaymentRefunds | null>;
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
    return { attempts: attempts as RefundAttemptSnapshot[], refusals };
  }
}

import { correlationHeaders } from '@nawara/service-kit';
import type { PaymentCreateBody } from '../domain/payment-request-mapping.js';

/**
 * What Billing keeps from a Payment answer. Rich enough to reconstruct a full decision input (matching
 * `PaymentEventFacts`) for reconciliation, since Payment's `GET` and `POST` responses share one representation
 * shape (SDD 9.2). `producer` is deliberately NOT part of this: Payment's `GET`/create responses never expose it,
 * and don't need to — Payment's own authorization already restricts both calls to the caller's own payments (SDD
 * 8.4), so anything Billing's service token can read here is already known to be Billing's own by construction.
 */
export interface PaymentSnapshot {
  paymentId: string;
  paymentRequestId: string;
  status: string;
  amount: number;
  currency: string;
  sourceType: string;
  sourceId: string;
  payer: { type: string; id: string };
  seller: { type: string; id: string };
  organizationId: string | null;
  /**
   * Stage 12.4 R2: the instant Payment's own row closed (set once, in the SAME transaction as the terminal status
   * write — `payment.representation.ts`'s own field, already returned by both `GET` and `POST`). `null` for a
   * non-terminal payment (freshly created/pending); always present once `status` is terminal, which is the only case
   * `applyReconciledSnapshot` ever acts on. This is the SAME instant a live `payment.succeeded` event's
   * `occurredAt` header carries (`now()` is transaction-stable in PostgreSQL, and the outbox row recording that same
   * event is written in that same transaction) — reusing it here lets the live-event and reconciliation paths
   * converge on the identical Subscription anchor for the same settlement fact.
   */
  closedAt: Date | null;
}

/**
 * The classification of Payment's answer to a dispatch call, exactly the SDD 21.2 table: accepted is the only
 * success case; rejected is a permanent, non-retryable refusal (Billing's own defect or a genuine conflict);
 * transient covers everything a retry of the IDENTICAL request can safely recover from (429, 5xx, timeout,
 * connection lost — safe because of the natural key); auth_fault is a configuration problem (wrong/expired
 * service token, or the producer not yet authorized), never the invoice's fault, and is retried with an alert
 * rather than failed outright, since it may self-resolve once the token is fixed.
 */
export type CreatePaymentOutcome =
  | { kind: 'accepted'; snapshot: PaymentSnapshot }
  | { kind: 'rejected'; code: string | null }
  | { kind: 'transient' }
  | { kind: 'auth_fault' };

/** SDD 21.2's cancel response table. */
export type CancelPaymentOutcome =
  | { kind: 'cancelled' }
  | { kind: 'in_flight' } // 409 payment_has_open_attempt / cash_submission_exists: money may be in flight, must resolve first
  | { kind: 'already_terminal' } // 409 invalid_state_transition: Payment already reached a terminal state (settles from the terminal event/reconciler instead)
  | { kind: 'not_found' }
  | { kind: 'transient' }
  | { kind: 'auth_fault' };

/**
 * Port to payment-service (SDD section 21). Billing's domain/application layer depends on this interface, never on
 * HTTP directly — a test double implements it with no network. Only Billing's OWN service token is ever sent here
 * (ADR-0033); a user's bearer is never forwarded. The dispatch body is a pure function of two immutable rows
 * (`buildPaymentRequestBody`), so a retry is always byte-for-byte identical and safe.
 */
export interface PaymentClient {
  createPayment(body: PaymentCreateBody): Promise<CreatePaymentOutcome>;
  /** null on 404 (Payment's own producer-scoped read already refuses a foreign payment the same way). Throws on a transient failure — the caller (reconciler) isolates that per item. */
  getPayment(paymentId: string): Promise<PaymentSnapshot | null>;
  cancelPayment(paymentId: string, idempotencyKey: string): Promise<CancelPaymentOutcome>;
}

export interface HttpPaymentClientOptions {
  baseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
}

interface PaymentResponseBody {
  id?: string;
  paymentRequestId?: string;
  status?: string;
  amount?: number;
  currency?: string;
  sourceType?: string;
  sourceId?: string;
  payer?: { type?: string; id?: string };
  seller?: { type?: string; id?: string };
  organizationId?: string | null;
  closedAt?: string | null;
  code?: string;
}

function parseSnapshot(res: PaymentResponseBody | null): PaymentSnapshot | null {
  if (
    !res ||
    typeof res.id !== 'string' ||
    typeof res.paymentRequestId !== 'string' ||
    typeof res.status !== 'string' ||
    typeof res.amount !== 'number' ||
    typeof res.currency !== 'string' ||
    typeof res.sourceType !== 'string' ||
    typeof res.sourceId !== 'string' ||
    typeof res.payer?.type !== 'string' ||
    typeof res.payer?.id !== 'string' ||
    typeof res.seller?.type !== 'string' ||
    typeof res.seller?.id !== 'string' ||
    (res.closedAt !== undefined && res.closedAt !== null && typeof res.closedAt !== 'string')
  ) {
    return null;
  }
  const closedAt = typeof res.closedAt === 'string' ? new Date(res.closedAt) : null;
  if (closedAt !== null && Number.isNaN(closedAt.getTime())) return null;
  return {
    paymentId: res.id,
    paymentRequestId: res.paymentRequestId,
    status: res.status,
    amount: res.amount,
    currency: res.currency,
    sourceType: res.sourceType,
    sourceId: res.sourceId,
    payer: { type: res.payer.type, id: res.payer.id },
    seller: { type: res.seller.type, id: res.seller.id },
    organizationId: res.organizationId ?? null,
    closedAt,
  };
}

export class HttpPaymentClient implements PaymentClient {
  private readonly timeoutMs: number;
  constructor(private readonly opts: HttpPaymentClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  private async call(method: string, path: string, extraHeaders: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: PaymentResponseBody | null }> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.opts.serviceToken}`, 'content-type': 'application/json', ...correlationHeaders(), ...extraHeaders },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { status: 0, body: null }; // network error or timeout: classified as transient by the caller
    }
    let parsed: PaymentResponseBody | null = null;
    try {
      parsed = (await res.json()) as PaymentResponseBody;
    } catch {
      parsed = null; // a 200/201 with no parseable body is itself a transient anomaly, handled below by parseSnapshot
    }
    return { status: res.status, body: parsed };
  }

  async createPayment(body: PaymentCreateBody): Promise<CreatePaymentOutcome> {
    const { status, body: res } = await this.call('POST', '/payment/payments', {}, body);
    if (status === 201 || status === 200) {
      const snapshot = parseSnapshot(res);
      if (!snapshot) return { kind: 'transient' }; // malformed 2xx body: treat as a network anomaly, safe to retry (natural key)
      return { kind: 'accepted', snapshot };
    }
    if (status === 400 || status === 409 || status === 422) return { kind: 'rejected', code: res?.code ?? null };
    if (status === 401 || status === 403) return { kind: 'auth_fault' };
    return { kind: 'transient' }; // 429, 5xx, 0 (network/timeout) — safe to retry the identical request (natural key)
  }

  async getPayment(paymentId: string): Promise<PaymentSnapshot | null> {
    const { status, body: res } = await this.call('GET', `/payment/payments/${encodeURIComponent(paymentId)}`);
    if (status === 404) return null;
    const snapshot = status === 200 ? parseSnapshot(res) : null;
    if (!snapshot) throw new Error(`payment-service GET /payment/payments/${paymentId} failed (status ${status})`);
    return snapshot;
  }

  async cancelPayment(paymentId: string, idempotencyKey: string): Promise<CancelPaymentOutcome> {
    const { status, body: res } = await this.call('POST', `/payment/payments/${encodeURIComponent(paymentId)}/cancel`, { 'idempotency-key': idempotencyKey });
    if (status === 200) return { kind: 'cancelled' };
    if (status === 404) return { kind: 'not_found' };
    if (status === 401 || status === 403) return { kind: 'auth_fault' };
    if (status === 409) {
      if (res?.code === 'payment_has_open_attempt' || res?.code === 'cash_submission_exists') return { kind: 'in_flight' };
      return { kind: 'already_terminal' };
    }
    return { kind: 'transient' };
  }
}

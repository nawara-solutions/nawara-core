import { correlationHeaders } from '@nawara/service-kit';
import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import type { DisputeExposure } from './dispute-exposure.js';

/** DI token of Payment's dispute reads (Core V2 S6e-D). */
export const PAYMENT_DISPUTE_CLIENT = Symbol('BILLING_PAYMENT_DISPUTE_CLIENT');

/** One verified final loss as Payment lists it (`GET /payment/disputes/losses`): always with its verified chargeback fact. */
export interface PaymentDisputeLoss {
  disputeId: string;
  paymentId: string;
  paymentRequestId: string;
  amount: number;
  currency: string;
  lostAt: string;
  chargeback: { factId: string; amount: number; currency: string };
}

export interface PaymentDisputeClient {
  /** One page of the producer's verified losses, by dispute id. Throws when Payment cannot answer. */
  losses(after: string | undefined, limit: number): Promise<PaymentDisputeLoss[]>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/** The fail-closed answer: Payment's exposure could not be established, so no new refund case or relay is admitted (nothing written). */
export const disputeUnavailable = () => billingError(503, 'refund_dispute_unavailable', BILLING_MESSAGES.refundDisputeUnavailable);

/**
 * Core V2 S6e-D (the Owner's R6E-4, R6E-6): Payment's authoritative dispute reads, with Billing's OWN service token (`payment.read`; Payment
 * answers only for its producer's payments). It replaces the pre-S6e adapter: a payment with an open dispute or a chargeback is `open`; an
 * exposure Payment cannot establish (`unresolved`), a `404`, a timeout or any unexpected answer is never "no dispute": it throws `503`.
 */
export class HttpPaymentDisputeClient implements DisputeExposure, PaymentDisputeClient {
  constructor(private readonly opts: { baseUrl: string; serviceToken: string; timeoutMs: number }) {}

  private async get(path: string, deadline?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> | null }> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/+$/, '')}${path}`, {
        headers: { authorization: `Bearer ${this.opts.serviceToken}`, accept: 'application/json', ...correlationHeaders() },
        redirect: 'manual', signal: deadline ?? AbortSignal.timeout(this.opts.timeoutMs),
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

  async status(paymentId: string, deadline: AbortSignal): Promise<'none' | 'open'> {
    const r = await this.get(`/payment/payments/${encodeURIComponent(paymentId)}/dispute-exposure`, deadline);
    if (r.status !== 200 || !r.body || r.body.paymentId !== paymentId) throw disputeUnavailable();
    if (r.body.state === 'clear') return 'none';
    if (r.body.state === 'exposed') return 'open';
    throw disputeUnavailable(); // `unresolved` or anything else: never zero
  }

  async losses(after: string | undefined, limit: number): Promise<PaymentDisputeLoss[]> {
    const r = await this.get(`/payment/disputes/losses?limit=${limit}${after ? `&after=${encodeURIComponent(after)}` : ''}`);
    if (r.status !== 200 || !r.body || !Array.isArray(r.body.items)) throw new Error(`payment-service GET disputes/losses failed (status ${r.status})`);
    return (r.body.items as Record<string, unknown>[]).map((x) => {
      const c = x.chargeback as Record<string, unknown> | null;
      if (![x.disputeId, x.paymentId, x.paymentRequestId].every((v) => typeof v === 'string' && UUID.test(v)) || !isAmount(x.amount) || typeof x.currency !== 'string'
        || typeof x.lostAt !== 'string' || !c || typeof c.factId !== 'string' || !UUID.test(c.factId) || !isAmount(c.amount) || typeof c.currency !== 'string') {
        throw new Error('payment-service GET disputes/losses: malformed loss');
      }
      return { disputeId: x.disputeId as string, paymentId: x.paymentId as string, paymentRequestId: x.paymentRequestId as string, amount: x.amount, currency: x.currency,
        lostAt: x.lostAt, chargeback: { factId: c.factId, amount: c.amount, currency: c.currency } };
    });
  }
}

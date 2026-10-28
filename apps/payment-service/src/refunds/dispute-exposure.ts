/** DI token of Payment's dispute-exposure boundary for refund attempts (Core V2 S6b, R6B-8). */
export const REFUND_DISPUTE_EXPOSURE = Symbol('PAYMENT_REFUND_DISPUTE_EXPOSURE');

/**
 * Core V2 S6b (S0 D3, FC-5; R6B-8): whether a dispute exposes a payment, which blocks a NEW refund attempt (a full refund is no longer
 * admissible: `available = netRetained − inFlight − disputeExposure` falls below the amount). An attempt already created is governed by its
 * own immutable state. The ONE integration boundary: called outside any transaction; an implementation that cannot answer must THROW (the
 * request fails closed, `503`, nothing written), never answer `none` for lack of information.
 */
export interface RefundDisputeExposure {
  status(paymentId: string, deadline: AbortSignal): Promise<'none' | 'exposed'>;
}

/**
 * The stand-in until S6e (DEVELOPMENT AND SIMULATION ONLY; refunds are never configured in production). Payment has no dispute records at
 * all today (register PAY-09 to PAY-11, OD-11), so `none` states that no dispute CAN exist yet, not that a dispute source was consulted.
 * S6e must replace it with Payment's authoritative dispute facts, and certify Billing and Payment together, BEFORE any dispute capability is
 * activated; from then on an unavailable source fails closed and absence is never read as "no dispute".
 */
export class NoDisputeSourceBeforeS6e implements RefundDisputeExposure {
  async status(): Promise<'none'> {
    return 'none';
  }
}

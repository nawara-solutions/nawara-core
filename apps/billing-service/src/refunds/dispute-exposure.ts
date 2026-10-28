/** DI token of the dispute-exposure boundary refund cases consult (Core V2 S6a, R6A-3). */
export const PAYMENT_DISPUTE_EXPOSURE = Symbol('BILLING_PAYMENT_DISPUTE_EXPOSURE');

/**
 * Core V2 S6a (S0 D3, FC-5; ADR-0067 decision 6; R6A-3): whether a dispute on a payment is open, which blocks opening a refund case. The
 * ONE integration boundary for it: no dispute service or storage model is invented here. Called outside any database transaction. An
 * implementation that cannot answer must THROW (the request fails closed, `503`, nothing written); it never answers `none` for lack of
 * information.
 */
export interface DisputeExposure {
  status(paymentId: string, deadline: AbortSignal): Promise<'none' | 'open'>;
}

/**
 * The adapter until S6e (DEVELOPMENT AND SIMULATION ONLY; the refund module is never mounted in production). Payment has no dispute
 * records at all today: no dispute model, no provider dispute intake (register PAY-09 to PAY-11, OD-11). So `none` here states that no
 * dispute CAN exist yet, not that a dispute source was consulted. S6e must replace this adapter with Payment's authoritative dispute status
 * BEFORE any dispute functionality is activated; from then on an unavailable source fails closed and absence is never read as "no dispute".
 */
export class NoDisputeSourceBeforeS6e implements DisputeExposure {
  async status(): Promise<'none'> {
    return 'none';
  }
}

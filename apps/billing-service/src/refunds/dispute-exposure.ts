/** DI token of the dispute-exposure boundary refund cases consult (Core V2 S6a, R6A-3). */
export const PAYMENT_DISPUTE_EXPOSURE = Symbol('BILLING_PAYMENT_DISPUTE_EXPOSURE');

/**
 * Core V2 S6a (S0 D3, FC-5; ADR-0067 decision 6; R6A-3): whether a dispute exposes a payment, which blocks opening a refund case (and relaying a
 * new attempt). The ONE integration boundary for it, called outside any database transaction. Core V2 S6e-D (R6E-4): its implementation is
 * Payment's authoritative exposure (`HttpPaymentDisputeClient`). An implementation that cannot answer must THROW (the request fails closed,
 * `503`, nothing written); it never answers `none` for lack of information.
 */
export interface DisputeExposure {
  status(paymentId: string, deadline: AbortSignal): Promise<'none' | 'open'>;
}

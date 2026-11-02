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

/** DI token of the L-4 application's dispute-exposure read (Core V2 S0-C9, CB-3). */
export const PAYMENT_LATE_SETTLEMENT_EXPOSURE = Symbol('BILLING_PAYMENT_LATE_SETTLEMENT_EXPOSURE');

/**
 * Core V2 S0-C9 item 4 (CB-3, an Owner-approved POLICY ADDITION; register BIL-32 H): Payment's authoritative dispute exposure of the late
 * payment, read (R6A-3, Billing's service token) before the Owner's L-4 receipt is consumed. `clear` continues; an open dispute or open
 * exposure is `dispute_open`; a chargeback recorded at Payment is `chargeback_recorded`; `unresolved`, an unavailable Payment or any answer
 * Billing cannot verify is `unavailable` (never `clear`). The read is NOT a lock (S0-C9 item 7).
 */
export type LateSettlementExposureState = 'clear' | 'dispute_open' | 'chargeback_recorded' | 'unavailable';
export interface LateSettlementExposure {
  lateSettlement(paymentId: string, deadline: AbortSignal): Promise<LateSettlementExposureState>;
}

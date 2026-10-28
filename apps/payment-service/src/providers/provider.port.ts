import type { PaymentRow } from '../payments/payment.types.js';

export type FailureClass = 'retryable' | 'terminal' | 'ambiguous';

export type InitiateResult =
  | { kind: 'accepted'; providerTransactionId: string; nextAction?: Record<string, unknown> }
  | { kind: 'rejected'; failureClass: Exclude<FailureClass, 'ambiguous'>; failureCode: string }
  | { kind: 'ambiguous' };

export type FetchStatusResult =
  /** Core V2 S4d (FC-1): `providerTransactionId` is the provider's own reference for the captured money (the fact identity). */
  | { kind: 'succeeded'; amount: number; currency: string; providerTransactionId?: string; providerOccurredAt?: Date }
  | { kind: 'failed'; failureClass: Exclude<FailureClass, 'ambiguous'>; failureCode: string }
  | { kind: 'pending' }
  /** Core V2 S4f (PAY-14, F-S4): the provider says the attempt's session expired unpaid. Provider-confirmed, so definitive (F-3). */
  | { kind: 'expired' }
  | { kind: 'notFound' };

export interface ParsedWebhookBody {
  providerEventId: string;
  type: string;
  reference: string;
  amount?: number;
  currency?: string;
  data: unknown;
  /** Core V2 S4d (FC-1): the provider's own transaction reference and stated time, when the adapter can read them from the message. */
  providerTransactionId?: string;
  providerOccurredAt?: Date;
}

/** A verified provider notification, or how verification failed (SDD section 7's two distinct failure modes). */
export type VerifyWebhookResult =
  | { signatureValid: true; parsed: ParsedWebhookBody }
  /** Signature checks out, but the body could not be decoded into a recognizable event: SDD's "malformed body with a valid signature" case (persist, non-retryable failed), never a 401. */
  | { signatureValid: true; parsed: null }
  /** Signature does not check out: reject (401), persist nothing (an unauthenticated caller cannot write to the database). */
  | { signatureValid: false };

export interface ProviderCapabilities {
  refunds: boolean;
  partialRefunds: boolean;
  /** Whether a "no record" answer from `fetchStatus`/`fetchStatus`-after-timeout may be treated as authoritative (SDD section 5.2). */
  notFoundIsAuthoritative: boolean;
  /** How long the provider's own records lag behind a real event (the resolver must wait longer than this). */
  visibilityLagMs: number;
  timeoutMs: number;
  sessionExpiry: boolean;
  /** Failure codes that mean the PAYMENT itself is unrecoverable, not just this attempt. */
  paymentFatalCodes: string[];
}

/** Options for one attempt, opaque to payment-service and validated by the adapter (SDD section 9.1, endpoint 3). */
export interface ProviderOptions {
  [key: string]: unknown;
}

/**
 * Core V2 S6b (register PAY-07; R6B-3, R6B-4, R6B-6): what a provider answers to a refund dispatch. `accepted` carries the provider's own
 * refund reference; `rejected` is the provider's DEFINITIVE refusal (nothing was or will be refunded under this key); `ambiguous` is any
 * answer that does not prove either (a timeout, a lost response): the same attempt may only be dispatched again with the same key.
 */
export type RefundDispatchResult =
  | { kind: 'accepted'; providerRefundId: string }
  | { kind: 'rejected'; failureCode: string }
  | { kind: 'ambiguous' };

/**
 * Core V2 S6b (R6B-4, R6B-5): the provider's answer about one refund, read over its authenticated channel. Only `succeeded` (a money
 * movement: it becomes a `refund` fact) and `failed` (provider-confirmed) are definitive; `notFound` never proves a failure.
 */
export type RefundStatusResult =
  | { kind: 'succeeded'; amount: number; currency: string; providerRefundId: string; providerOccurredAt?: Date }
  | { kind: 'failed'; failureCode: string; providerRefundId?: string }
  | { kind: 'pending' }
  | { kind: 'notFound' };

/** One refund dispatch: the stable idempotency key is the refund attempt id (R6B-3); amount and currency are Payment's own rows. */
export interface RefundDispatch {
  refundAttemptId: string;
  idempotencyKey: string;
  paymentId: string;
  capturedTransactionId: string;
  amount: number;
  currency: string;
}

/**
 * The provider port (SDD section 13.1). payment-service depends on this interface, never on a vendor. Core V2 S6b: the refund members are
 * optional and exist only on an adapter whose `capabilities.refunds` is true (today only the non-production `simulation` provider).
 */
export interface PaymentProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  initiate(payment: PaymentRow, attempt: { id: string; merchantReference: string; options?: ProviderOptions }): Promise<InitiateResult>;
  /** `ref` is a providerTransactionId or a merchantReference — either identifies the same attempt to the provider. */
  fetchStatus(ref: string): Promise<FetchStatusResult>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<VerifyWebhookResult>;
  /** Re-derives the parsed shape from an already-verified, already-stored raw body — no signature check (the retrier
   * re-processes a stored event; it never re-authenticates one, since the body cannot have changed since receipt). */
  parseStoredBody(rawBody: Buffer): ParsedWebhookBody | null;
  /** Core V2 S6b: dispatch one full refund of a captured transaction, idempotent on `idempotencyKey` at the provider. */
  refund?(dispatch: RefundDispatch): Promise<RefundDispatchResult>;
  /** Core V2 S6b: the provider's current answer for one refund, by its idempotency key (the refund attempt id). */
  fetchRefundStatus?(refundAttemptId: string): Promise<RefundStatusResult>;
}

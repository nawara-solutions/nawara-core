import type { PaymentRow } from '../payments/payment.types.js';

export type FailureClass = 'retryable' | 'terminal' | 'ambiguous';

export type InitiateResult =
  | { kind: 'accepted'; providerTransactionId: string; nextAction?: Record<string, unknown> }
  | { kind: 'rejected'; failureClass: Exclude<FailureClass, 'ambiguous'>; failureCode: string }
  | { kind: 'ambiguous' };

export type FetchStatusResult =
  | { kind: 'succeeded'; amount: number; currency: string }
  | { kind: 'failed'; failureClass: Exclude<FailureClass, 'ambiguous'>; failureCode: string }
  | { kind: 'pending' }
  | { kind: 'notFound' };

export interface ParsedWebhookBody {
  providerEventId: string;
  type: string;
  reference: string;
  amount?: number;
  currency?: string;
  data: unknown;
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
 * The provider port (SDD section 13.1). payment-service depends on this interface, never on a vendor. Refund methods
 * are deliberately absent in this phase: refunds are not implemented (blocked by O-6), so a port member for them
 * would be dead code no caller can reach.
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
}

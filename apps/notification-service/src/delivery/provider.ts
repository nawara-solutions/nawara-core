import type { RenderedMessage } from './renderer.js';

/**
 * The provider port (SDD §8.4). The delivery engine depends on this and nothing else: no SDK, no HTTP, no provider status code reaches
 * it. An adapter maps every provider response to one of three results and returns BOUNDED codes only (`^[a-z][a-z0-9_]{0,63}$`); raw
 * provider bodies are never returned, stored or logged. Adapters: the test provider (16.7), Resend email and Twilio SMS (16.8).
 *
 * The classification boundary every adapter follows (Stage 16.8):
 *   - failed definitely BEFORE the request was transmitted (DNS, connection refused, TLS)     → rejected, retryable;
 *   - a documented temporary answer (429, 5xx)                                                → rejected, retryable (+ retryAfterMs);
 *   - a documented permanent rejection                                                        → rejected, terminal;
 *   - our credentials or sender configuration refused                                         → rejected, retryable, `provider_auth_fault`;
 *   - the provider MAY have received the request and the result is unknown (timeout, reset,
 *     an unreadable success)                                                                  → ambiguous.
 */
export type ProviderResult =
  | { kind: 'accepted'; providerMessageId: string; diagnostic?: ProviderDiagnostic }
  | { kind: 'rejected'; failureClass: 'retryable' | 'terminal'; code: string; retryAfterMs?: number; diagnostic?: ProviderDiagnostic }
  | { kind: 'ambiguous'; code: string; diagnostic?: ProviderDiagnostic };

/** Operational facts an adapter may report for the log line: an HTTP status and a provider's own error token. Never a body or text. */
export interface ProviderDiagnostic {
  httpStatus?: number;
  providerCode?: string;
}

/** What the engine gives each call. */
export interface ProviderCallContext {
  /** The delivery id: the provider reference. */
  reference: string;
  attemptId: string;
  /**
   * A key that stays the SAME when a delivery is resent after an ambiguous attempt and CHANGES after a definite provider answer
   * (`<deliveryId>:<definite failures so far>`). An adapter whose provider deduplicates on a request key sends it; a resend after a
   * lost answer is then deduplicated by the provider within its window. Derived from internal ids only, never a destination or code.
   */
  idempotencyKey: string;
  /**
   * Aborted by the engine when NOTIFICATION_PROVIDER_TIMEOUT_MS passes: the adapter must stop its I/O (its socket), not only its wait.
   * Shutdown does not abort a call: it waits for it (bounded by the same timeout), so an in-flight send ends with a known outcome.
   */
  signal: AbortSignal;
}

export interface ChannelProvider {
  /** A short adapter id (`test`, later the vendor), stored on the attempt and the delivery. */
  readonly id: string;
  readonly channel: 'EMAIL' | 'SMS';
  readonly capabilities: { idempotencyKey: boolean };
  /**
   * `reference` is the delivery id: sent as the provider's idempotency key / client reference where the provider supports one, so a
   * resend of the same delivery can be deduplicated by the provider. The engine bounds every call by NOTIFICATION_PROVIDER_TIMEOUT_MS.
   */
  send(message: RenderedMessage, ctx: ProviderCallContext): Promise<ProviderResult>;
}

/** The provider per channel. A channel without a provider is not delivered (its deliveries stay PENDING). */
export type ProviderRegistry = Partial<Record<'EMAIL' | 'SMS', ChannelProvider>>;
export const DELIVERY_PROVIDERS = Symbol('DELIVERY_PROVIDERS');

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

/** A diagnostic as the engine logs it: an integer HTTP status and a short token, or nothing. */
export function boundedDiagnostic(d: unknown): ProviderDiagnostic | undefined {
  if (typeof d !== 'object' || d === null) return undefined;
  const x = d as Record<string, unknown>;
  const out: ProviderDiagnostic = {};
  if (Number.isInteger(x.httpStatus) && (x.httpStatus as number) >= 100 && (x.httpStatus as number) <= 599) out.httpStatus = x.httpStatus as number;
  if (typeof x.providerCode === 'string' && PROVIDER_CODE.test(x.providerCode)) out.providerCode = x.providerCode;
  return out.httpStatus === undefined && out.providerCode === undefined ? undefined : out;
}
/** A provider result as the engine records it: an unexpected or unbounded code becomes a fixed one (never provider text). */
export function boundedCode(code: unknown, fallback: string): string {
  return typeof code === 'string' && CODE.test(code) ? code : fallback;
}

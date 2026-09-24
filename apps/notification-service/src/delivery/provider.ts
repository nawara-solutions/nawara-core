import type { RenderedMessage } from './renderer.js';

/**
 * The provider port (SDD §8.4). The delivery engine depends on this and nothing else: no SDK, no HTTP, no provider status code reaches
 * it. An adapter maps every provider response to one of three results and returns BOUNDED codes only (`^[a-z][a-z0-9_]{0,63}$`); raw
 * provider bodies are never returned, stored or logged. Real adapters (SMS, email) arrive in Stage 16.8.
 */
export type ProviderResult =
  | { kind: 'accepted'; providerMessageId: string }
  | { kind: 'rejected'; failureClass: 'retryable' | 'terminal'; code: string; retryAfterMs?: number }
  | { kind: 'ambiguous'; code: string };

export interface ChannelProvider {
  /** A short adapter id (`test`, later the vendor), stored on the attempt and the delivery. */
  readonly id: string;
  readonly channel: 'EMAIL' | 'SMS';
  readonly capabilities: { idempotencyKey: boolean };
  /**
   * `reference` is the delivery id: sent as the provider's idempotency key / client reference where the provider supports one, so a
   * resend of the same delivery can be deduplicated by the provider. The engine bounds every call by NOTIFICATION_PROVIDER_TIMEOUT_MS.
   */
  send(message: RenderedMessage, ctx: { reference: string; attemptId: string }): Promise<ProviderResult>;
}

/** The provider per channel. A channel without a provider is not delivered (its deliveries stay PENDING). */
export type ProviderRegistry = Partial<Record<'EMAIL' | 'SMS', ChannelProvider>>;
export const DELIVERY_PROVIDERS = Symbol('DELIVERY_PROVIDERS');

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** A provider result as the engine records it: an unexpected or unbounded code becomes a fixed one (never provider text). */
export function boundedCode(code: unknown, fallback: string): string {
  return typeof code === 'string' && CODE.test(code) ? code : fallback;
}

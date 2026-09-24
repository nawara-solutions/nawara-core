import { isValidEmail } from '../../intake/destination.js';
import type { ChannelProvider, ProviderCallContext, ProviderDiagnostic, ProviderResult } from '../provider.js';
import type { RenderedMessage } from '../renderer.js';
import { accepted, ambiguous, commonStatus, postOnce, providerToken, retryable, terminal, transportResult } from './http.js';

export interface ResendConfig {
  /** `NOTIFICATION_RESEND_API_KEY`: a secret, sent only in the Authorization header. */
  apiKey: string;
  /** `NOTIFICATION_EMAIL_FROM`, validated at startup: `Name <address>` or `address` on a domain verified in Resend. Never caller-controlled. */
  from: string;
  /** `NOTIFICATION_RESEND_BASE_URL` (https://api.resend.com; https only in production). */
  baseUrl: string;
}

const RESEND_ID = /^[A-Za-z0-9-]{1,128}$/;
const SUBJECT_MAX = 998; // RFC 5322 line limit; the template versions cap subjects at 255 already

/**
 * The Resend email adapter (ADR-0047): `POST /emails` over HTTPS with the rendered subject, text and optional HTML exactly as the
 * renderer produced them (no Resend template, so no provider-side interpolation), the sender from configuration only, and the engine's
 * idempotency key in `Idempotency-Key` (Resend: same key + same payload within 24 h returns the original id and sends nothing).
 *
 * Resend's documented errors, mapped (the rest by `commonStatus`):
 *   200 + id                                     → accepted;  200 without a readable id → ambiguous `provider_invalid_response`;
 *   409 invalid_idempotent_request / concurrent  → ambiguous `provider_idempotency_conflict` (an earlier request with the key exists);
 *   403 email_above_quota                        → retryable `provider_rate_limited`;
 *   400 / 422 (validation, missing field)        → terminal `provider_rejected`;
 *   any other 4xx                                → terminal `provider_rejected`.
 */
export class ResendEmailProvider implements ChannelProvider {
  readonly id = 'resend';
  readonly channel = 'EMAIL' as const;
  readonly capabilities = { idempotencyKey: true };
  private readonly url: string;
  private readonly authorization: string;

  constructor(private readonly config: ResendConfig) {
    this.url = new URL('/emails', config.baseUrl).toString();
    this.authorization = `Bearer ${config.apiKey}`;
  }

  async send(m: RenderedMessage, ctx: ProviderCallContext): Promise<ProviderResult> {
    // Defensive: the renderer and intake guarantee these; a violation is our bug and is never sent.
    if (m.channel !== 'EMAIL' || !isValidEmail(m.destination)) return terminal('invalid_destination');
    if (m.subject === undefined || m.subject.length === 0 || m.subject.length > SUBJECT_MAX || /[\r\n]/.test(m.subject)) return terminal('provider_invalid_request');
    const body = JSON.stringify({ from: this.config.from, to: [m.destination], subject: m.subject, text: m.text, ...(m.html === undefined ? {} : { html: m.html }) });
    const o = await postOnce(this.url, {
      headers: { authorization: this.authorization, 'content-type': 'application/json; charset=utf-8', 'idempotency-key': ctx.idempotencyKey, 'user-agent': 'nawara-notification-service' },
      body,
    }, ctx.signal);
    if (o.kind !== 'response') return transportResult(o);
    const name = providerToken((o.json as { name?: unknown } | undefined)?.name);
    const d: ProviderDiagnostic = { httpStatus: o.status, ...(name ? { providerCode: name } : {}) };
    if (o.status >= 200 && o.status < 300) {
      const id = (o.json as { id?: unknown } | undefined)?.id;
      return typeof id === 'string' && RESEND_ID.test(id) ? accepted(id, d) : ambiguous('provider_invalid_response', d);
    }
    if (o.status === 409 && (name === 'invalid_idempotent_request' || name === 'concurrent_idempotent_requests')) return ambiguous('provider_idempotency_conflict', d);
    if (o.status === 403 && name === 'email_above_quota') return retryable('provider_rate_limited', d, o.retryAfterMs);
    return commonStatus(o.status, d, o.retryAfterMs) ?? terminal('provider_rejected', d);
  }
}

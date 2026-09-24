import { E164 } from '../../intake/destination.js';
import type { ChannelProvider, ProviderCallContext, ProviderDiagnostic, ProviderResult } from '../provider.js';
import type { RenderedMessage } from '../renderer.js';
import { accepted, ambiguous, commonStatus, postOnce, providerToken, retryable, terminal, transportResult } from './http.js';

export interface TwilioConfig {
  /** `NOTIFICATION_TWILIO_ACCOUNT_SID` (`AC` + 32 hex). */
  accountSid: string;
  /** `NOTIFICATION_TWILIO_API_KEY_SID` (`SK` + 32 hex) and `NOTIFICATION_TWILIO_API_KEY_SECRET` (a secret): an API key, not the account auth token. */
  apiKeySid: string;
  apiKeySecret: string;
  /** `NOTIFICATION_TWILIO_MESSAGING_SERVICE_SID` (`MG` + 32 hex): the sender pool; server-owned, never caller-controlled. */
  messagingServiceSid: string;
  /** `NOTIFICATION_TWILIO_BASE_URL` (https://api.twilio.com; https only in production). */
  baseUrl: string;
}

const MESSAGE_SID = /^(SM|MM)[0-9a-f]{32}$/;
/** Twilio's hard limit on a message body (characters); the renderer's `smsMaxSegments` is far below it. */
const TWILIO_BODY_MAX = 1600;

/** Twilio error codes with a known meaning (https://www.twilio.com/docs/api/errors); the rest follow the HTTP status. */
const DESTINATION_REJECTED = new Set([
  21211, // invalid 'To' phone number
  21610, // the recipient replied STOP (unsubscribed)
  21612, // 'To' cannot be reached by this message
  21614, // 'To' is not a valid mobile number
]);
const CONFIG_FAULT = new Set([
  21408, // geo permissions disabled for the destination region (account setting)
  21606, // the sender is not a valid message-enabled number
  21703, // the Messaging Service has no sender able to reach this destination
  20404, // a resource (account, Messaging Service) not found: wrong SID
]);

/**
 * The Twilio Programmable Messaging adapter (ADR-0019, accepted in 16.8): `POST /2010-04-01/Accounts/{AccountSid}/Messages.json` over
 * HTTPS, form-encoded (UTF-8), `To` (canonical E.164, never normalized), `MessagingServiceSid` (configuration) and `Body` (the rendered
 * text; Twilio picks GSM-7 or UCS-2, so Arabic travels as UCS-2). Twilio's Messages API has no request idempotency key: an ambiguous
 * result relies on the SDD §8.5 policy alone.
 *
 *   201 + sid (SM… / MM…)           → accepted; 2xx without a readable sid → ambiguous `provider_invalid_response`;
 *   code 20429 or HTTP 429           → retryable `provider_rate_limited` (+ Retry-After when sent);
 *   code 20003 / HTTP 401, 403       → retryable `provider_auth_fault`;
 *   a CONFIG_FAULT code              → retryable `provider_config_fault` (our account or sender, not the recipient);
 *   a DESTINATION_REJECTED code      → terminal `destination_rejected`;
 *   code 21617 (body over 1600)      → terminal `content_too_long`;
 *   any other 4xx                    → terminal `provider_rejected`.
 */
export class TwilioSmsProvider implements ChannelProvider {
  readonly id = 'twilio';
  readonly channel = 'SMS' as const;
  readonly capabilities = { idempotencyKey: false };
  private readonly url: string;
  private readonly authorization: string;

  constructor(private readonly config: TwilioConfig) {
    this.url = new URL(`/2010-04-01/Accounts/${config.accountSid}/Messages.json`, config.baseUrl).toString();
    this.authorization = `Basic ${Buffer.from(`${config.apiKeySid}:${config.apiKeySecret}`).toString('base64')}`;
  }

  async send(m: RenderedMessage, ctx: ProviderCallContext): Promise<ProviderResult> {
    // Defensive: intake refuses a non-E.164 destination; nothing here ever adds a country code or rewrites a number.
    if (m.channel !== 'SMS' || !E164.test(m.destination)) return terminal('invalid_destination');
    if (m.text.length === 0) return terminal('provider_invalid_request');
    if (m.text.length > TWILIO_BODY_MAX) return terminal('content_too_long');
    const form = new URLSearchParams({ To: m.destination, MessagingServiceSid: this.config.messagingServiceSid, Body: m.text });
    const o = await postOnce(this.url, {
      headers: { authorization: this.authorization, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', 'user-agent': 'nawara-notification-service' },
      body: form.toString(),
    }, ctx.signal);
    if (o.kind !== 'response') return transportResult(o);
    const rawCode = (o.json as { code?: unknown } | undefined)?.code;
    const code = typeof rawCode === 'number' && Number.isInteger(rawCode) ? rawCode : undefined;
    const token = providerToken(code);
    const d: ProviderDiagnostic = { httpStatus: o.status, ...(token ? { providerCode: token } : {}) };
    if (o.status >= 200 && o.status < 300) {
      const sid = (o.json as { sid?: unknown } | undefined)?.sid;
      return typeof sid === 'string' && MESSAGE_SID.test(sid) ? accepted(sid, d) : ambiguous('provider_invalid_response', d);
    }
    if (code === 20429) return retryable('provider_rate_limited', d, o.retryAfterMs);
    if (code === 20003) return retryable('provider_auth_fault', d);
    if (code !== undefined && CONFIG_FAULT.has(code)) return retryable('provider_config_fault', d);
    if (code !== undefined && DESTINATION_REJECTED.has(code)) return terminal('destination_rejected', d);
    if (code === 21617) return terminal('content_too_long', d);
    return commonStatus(o.status, d, o.retryAfterMs) ?? terminal('provider_rejected', d);
  }
}
import type { ProviderDiagnostic, ProviderResult } from '../provider.js';

/**
 * The HTTP boundary shared by the real adapters (Stage 16.8): Node's built-in `fetch` (no SDK, no new dependency), one call, no
 * redirect, no retry, a bounded response body, and a classification of every transport failure by what can be PROVEN about whether
 * the request reached the provider. Nothing here logs, and nothing here returns an error message, a request or a response body.
 */
export type HttpOutcome =
  | { kind: 'response'; status: number; retryAfterMs?: number; json?: unknown }
  /** The request definitely never left: the connection was never established. */
  | { kind: 'not_sent'; code: string }
  /** The request may have been written: the answer is unknown. */
  | { kind: 'unknown'; code: string };

/** Connection-establishment failures: no byte of the request can have been written. */
const NOT_SENT = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL', 'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_NOT_YET_VALID',
]);

const MAX_BODY_BYTES = 64 * 1024;
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

function causeCode(e: unknown): string | undefined {
  for (let x: unknown = e, i = 0; x && i < 5; x = (x as { cause?: unknown }).cause, i++) {
    const code = (x as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** `Retry-After` as delta-seconds or an HTTP date, bounded to [0, 24 h]; anything else is ignored (the worker's backoff applies). */
export function parseRetryAfter(v: string | null, now = Date.now()): number | undefined {
  if (!v) return undefined;
  const t = v.trim();
  let ms: number;
  if (/^\d{1,9}$/.test(t)) ms = Number(t) * 1000;
  else {
    if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(t)) return undefined; // IMF-fixdate only
    const at = Date.parse(t);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

async function readBounded(res: Response): Promise<string | undefined> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * One POST. The engine's signal aborts it (its socket too) at the provider timeout. Connections are reused by Node's global dispatcher.
 * A body that cannot be read or parsed is reported as `json: undefined`: the caller decides what an unreadable answer means for its status.
 */
export async function postOnce(url: string, init: { headers: Record<string, string>; body: string }, signal: AbortSignal): Promise<HttpOutcome> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, redirect: 'manual', signal });
  } catch (e) {
    if (signal.aborted) return { kind: 'unknown', code: 'provider_timeout' };
    const code = causeCode(e);
    return code && NOT_SENT.has(code) ? { kind: 'not_sent', code: 'provider_unreachable' } : { kind: 'unknown', code: 'provider_connection_lost' };
  }
  const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
  let json: unknown;
  try {
    const text = await readBounded(res);
    json = text === undefined || text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined; // a reset or an abort while reading: the status is still known
  }
  return { kind: 'response', status: res.status, retryAfterMs, json };
}

export const accepted = (providerMessageId: string, diagnostic?: ProviderDiagnostic): ProviderResult => ({ kind: 'accepted', providerMessageId, diagnostic });
export const retryable = (code: string, diagnostic?: ProviderDiagnostic, retryAfterMs?: number): ProviderResult => ({ kind: 'rejected', failureClass: 'retryable', code, retryAfterMs, diagnostic });
export const terminal = (code: string, diagnostic?: ProviderDiagnostic): ProviderResult => ({ kind: 'rejected', failureClass: 'terminal', code, diagnostic });
export const ambiguous = (code: string, diagnostic?: ProviderDiagnostic): ProviderResult => ({ kind: 'ambiguous', code, diagnostic });

/** A transport outcome that is not a response, as a port result. */
export function transportResult(o: Exclude<HttpOutcome, { kind: 'response' }>): ProviderResult {
  return o.kind === 'not_sent' ? retryable(o.code) : ambiguous(o.code);
}

/**
 * The status classes common to both providers (their documented error tables):
 *   502 / 504  a gateway could not get the upstream's answer: it MAY have processed the request → ambiguous;
 *   other 5xx  the provider answered with a temporary failure → retryable;
 *   429        rate limited → retryable, with the bounded `Retry-After`;
 *   401 / 403  our credentials or account refused → retryable `provider_auth_fault` (alerted, bounded by the attempt budget);
 *   3xx / 404 / 405  a wrong base URL or path: configuration → retryable `provider_config_fault` (alerted).
 * Returns undefined for the statuses each adapter maps from the provider's own error code.
 */
export function commonStatus(status: number, diagnostic: ProviderDiagnostic, retryAfterMs?: number): ProviderResult | undefined {
  if (status === 502 || status === 504) return ambiguous('provider_gateway_timeout', diagnostic);
  if (status >= 500) return retryable('provider_unavailable', diagnostic, retryAfterMs);
  if (status === 429) return retryable('provider_rate_limited', diagnostic, retryAfterMs);
  if (status === 401 || status === 403) return retryable('provider_auth_fault', diagnostic, retryAfterMs);
  if ((status >= 300 && status < 400) || status === 404 || status === 405) return retryable('provider_config_fault', diagnostic);
  return undefined;
}

/** A provider's own error token (Resend `name`, Twilio numeric `code`), bounded; never its message. */
export function providerToken(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  return typeof v === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(v) ? v : undefined;
}

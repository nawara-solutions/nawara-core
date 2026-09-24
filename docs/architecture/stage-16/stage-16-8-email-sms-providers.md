# Stage 16.8 — Email and SMS providers

- **Status:** implemented and validated on `feat/notification-real-providers` (awaiting review).
- **Scope:** the Resend email adapter and the Twilio SMS adapter behind the Stage 16.7 `ChannelProvider` port; per-channel provider
  selection; credentials and server-owned senders validated at startup; the provider classification boundary; request idempotency
  (Resend); error sanitization; the engine-owned abort of timed-out calls.
- **Decisions:** D2 → **Resend** ([ADR-0047](../../adr/0047-resend-as-the-email-provider.md), accepted); D3 → **Twilio**
  ([ADR-0019](../../adr/0019-twilio-as-sms-gateway-provider.md) accepted, with an acceptance note). Both over **direct HTTPS with Node's
  built-in `fetch`: no SDK and no new dependency.**
- **Not in scope:** D21 `notif_dest` (still deferred), Auth changes, push, preferences, attachments / File Service, webhooks, 16.9 / 16.10.

## 1. Architecture

```text
DeliveryWorker ──► ChannelProvider (port, unchanged in shape)
                     ├── ResendEmailProvider   src/delivery/providers/resend.ts
                     ├── TwilioSmsProvider     src/delivery/providers/twilio.ts
                     └── TestProvider          (kept: tests, development; refused in production)
                   shared HTTP boundary        src/delivery/providers/http.ts  (fetch, no redirect, no retry, 64 KiB body cap,
                                                                                transport classification, Retry-After parsing)
```

The worker gained no provider-specific code. Port changes (additive): the call context carries `idempotencyKey` and `signal`; a result
may carry a bounded `diagnostic` (`httpStatus`, `providerCode`) that the engine prints on the log line. The engine also logs
`provider_config_fault` as an error, as it already did `provider_auth_fault`.

## 2. Configuration and credentials

| Variable | Rule |
|---|---|
| `NOTIFICATION_EMAIL_PROVIDER` | `none` (default), `test`, `resend` |
| `NOTIFICATION_SMS_PROVIDER` | `none` (default), `test`, `twilio` |
| `NOTIFICATION_RESEND_API_KEY` | required with `resend`; `re_` + 16–200 `[A-Za-z0-9_]`; secret |
| `NOTIFICATION_EMAIL_FROM` | required with `resend`; `Name <address>` or `address`; name ≤ 64 without `"<>,;:\@` or control characters |
| `NOTIFICATION_TWILIO_ACCOUNT_SID` / `_API_KEY_SID` | required with `twilio`; `AC` / `SK` + 32 hex |
| `NOTIFICATION_TWILIO_API_KEY_SECRET` | required with `twilio`; 32 letters or digits; secret |
| `NOTIFICATION_TWILIO_MESSAGING_SERVICE_SID` | required with `twilio`; `MG` + 32 hex; **the sender** |
| `NOTIFICATION_RESEND_BASE_URL`, `NOTIFICATION_TWILIO_BASE_URL` | default the real https APIs; plain http accepted only outside production (local stubs) |

- `test` on either channel is refused in production (unchanged invariant). `NOTIFICATION_DELIVERY_PROVIDER` (16.7) is refused with a
  message naming its replacements, so a stale deployment fails loudly instead of silently sending nothing.
- Credentials are read only for the provider selected, from the environment or `*_FILE` (kit `EnvReader`); a `ConfigError` names the
  variable and never echoes its value (tested, including in the production image). They live only in the adapter instance: in the
  `Authorization` header, never in a log, error, health response, database row or image.
- Configuration errors stop startup; provider unavailability never does (no call at startup; readiness unchanged, §9).

## 3. Sender identity

The sender is configuration only: `NOTIFICATION_EMAIL_FROM` for email, the Messaging Service SID for SMS. The API refuses `from`,
`sender`, `messagingServiceSid` and `provider` fields (unknown-field refusal, tested); an adapter ignores anything but its configuration
(tested with a message object carrying `from` / `replyTo`). Verification before production: the Resend sending domain (SPF, DKIM;
DMARC advised); the Twilio Messaging Service's senders, including Tunisian alphanumeric sender ID registration (required for domestic
entities above 30 000 SMS / month, about 18 days) and the destination countries enabled in Messaging Geo Permissions.

## 4. The adapters

**Resend:** `POST /emails`, `Authorization: Bearer`, `Content-Type: application/json; charset=utf-8`, body
`{ from, to: [destination], subject, text, html? }`: exactly the rendered content (no Resend template, so no provider interpolation).
Defensive refusals before any request: a non-email destination (`invalid_destination`), a missing subject or one with CR/LF or over
998 characters (`provider_invalid_request`).

**Twilio:** `POST /2010-04-01/Accounts/{AccountSid}/Messages.json`, basic auth with the API key, form UTF-8
`To`, `MessagingServiceSid`, `Body`. Defensive refusals: a destination that is not canonical E.164 (`invalid_destination`: `22123456`,
`21622123456`, `0021622123456`, `022123456`, `+216 22 123 456` are never rewritten, tested); a body over Twilio's 1600-character limit
(`content_too_long`, never truncated). Twilio picks GSM-7 or UCS-2; the renderer's `smsMaxSegments` already bounds the cost.

## 5. Classification

| Evidence | Result | Code |
|---|---|---|
| connection never established (DNS, refused, unreachable, TLS certificate) | retryable | `provider_unreachable` |
| 429 (Resend `rate_limit_exceeded`, `daily_quota_exceeded`; Twilio 20429), Resend 403 `email_above_quota` | retryable + `Retry-After` | `provider_rate_limited` |
| 500, 503 and other 5xx except 502 / 504 | retryable + `Retry-After` | `provider_unavailable` |
| 401 / 403, Twilio 20003 | retryable, error log | `provider_auth_fault` |
| 3xx, 404, 405, Twilio 20404 / 21408 / 21606 / 21703 | retryable, error log | `provider_config_fault` |
| Twilio 21211 / 21610 / 21612 / 21614 | terminal | `destination_rejected` |
| Twilio 21617 | terminal | `content_too_long` |
| any other 4xx (Resend `validation_error` 400 / 422, …) | terminal | `provider_rejected` |
| 502 / 504 (a gateway lost the upstream's answer) | **ambiguous** | `provider_gateway_timeout` |
| the engine timeout fired (request aborted) | **ambiguous** | `provider_timeout` |
| the connection lost after the request was written | **ambiguous** | `provider_connection_lost` |
| 2xx without a readable, bounded id (non-JSON, no id, malformed, > 64 KiB) | **ambiguous** | `provider_invalid_response` |
| Resend 409 `invalid_idempotent_request` / `concurrent_idempotent_requests` | **ambiguous** | `provider_idempotency_conflict` |

Timeouts are never retryable: only a failure proven to precede transmission is. Ambiguity then follows the frozen SDD §8.5 (one resend
of a code, otherwise `UNCONFIRMED`). Auth and configuration faults stay retryable within `NOTIFICATION_MAX_ATTEMPTS`, as 16.7
decided: each delivery makes at most 5 calls over about 7.5 minutes (30 s base backoff), then `FAILED retries_exhausted`. There is no
provider-wide circuit breaker: the durable backoff bounds the traffic per delivery; a breaker is a 16.9 candidate (§12).

## 6. Idempotency and references

- **Resend:** `Idempotency-Key: nawara-notification/<deliveryId>/<n>`, `n` = the delivery's `RETRYABLE_FAILURE` attempts so far
  (counted from the attempt rows when the attempt starts). Resend's documented behaviour: the same key and the same payload within
  24 hours return the original response and send nothing; a different payload is `409 invalid_idempotent_request`; keys ≤ 256
  characters, scoped per endpoint. Whether a *failed* request's key may be reused is not documented, so the key changes after every
  definite answer and stays the same only across an ambiguous attempt and its §8.5 resend. **Effect:** a one-time code whose answer was
  lost and is resent within 24 hours with an identical payload is not delivered twice (tested with the stub). **Not claimed:**
  exactly-once email; a lost answer for a non-code still ends `UNCONFIRMED`.
- **Twilio:** no request idempotency on the Messages API; §8.5 alone applies (worst case: one extra SMS with the same code).
- **References:** only the Resend `id` (`[A-Za-z0-9-]{1,128}`) or the Twilio `sid` (`SM`/`MM` + 32 hex) is stored, in
  `providerMessageId`. No response body, header or provider text is persisted anywhere (tested by dumping every table).

## 7. Timeout, lease and resources

- One timeout, owned by the engine: at `NOTIFICATION_PROVIDER_TIMEOUT_MS` it decides `ambiguous provider_timeout` **and aborts the
  adapter's request**, closing its socket (tested on the stub's side). `fetch` has no retry; redirects are not followed.
- **Values (unchanged):** timeout 10 s for both channels, lease 60 s (≥ 2 × timeout), worker drain 12 s, provider timeout < 60 s stop
  grace − HTTP drain. Measured with the local stand-in: adapter overhead ≈ 2 ms (attempt latency p50 7 ms, p99 12 ms against a 5 ms
  stub). **Live provider latency was not measured** (no sandbox credentials); the 10 s bound is far above both providers' normal
  answer times and is re-checked in the sandbox smoke.
- Connections are reused by Node's global `fetch` dispatcher (one adapter instance per channel for the application's life); nothing
  holds the process open at exit (production image: stop 69 ms idle, 1.5 s during a hung call, exit 0).

## 8. Error sanitization

The adapters never throw, never log and never return a message: every outcome is a bounded code plus an HTTP status and the provider's
error token (Resend `name`, Twilio numeric `code`). Transport errors are reduced to their Node / undici error code (`cause.code`),
matched against a fixed list. The engine logs `describeFailure` (class and code only) for anything unexpected. Tests put personal
data, the API key and the code into provider error bodies and scan results, logs and every table: 0 hits.

## 9. Readiness and shutdown

Readiness is unchanged (D12): database, migrations, RabbitMQ and event intake; providers are not dependencies, so a provider outage
leaves intake and the API up while deliveries back off durably. Shutdown is unchanged: claims stop, queued claims are released, the
in-flight call ends by its own result or the timeout, the outcome is persisted, then the pool closes (tested with the real adapters: a
500 ms answer finished `SENT`; a hung call `UNCONFIRMED provider_timeout`, socket closed).

## 10. Unicode (EN / FR / AR)

The providers transport the rendered result as they receive it; they never translate or re-encode. Tested: French accents and Arabic
in the Resend subject, text and HTML (JSON UTF-8) and in the Twilio `Body` (form UTF-8), byte-exact at the stand-in; an Arabic
template version rendered and delivered through the engine to the Twilio stand-in unchanged.

## 11. Evidence

- **Tests:** unit 295 (was 218: +17 configuration, +60 adapter contract tests against a local HTTP stand-in); Notification E2E 275
  (was 263: +12 in `test/provider-adapters.e2e-spec.ts`, the real adapters selected by configuration against the stand-in on a real
  PostgreSQL); the Stage 16.7 engine suite (58) unchanged and green; real-broker package 13/13.
- **Mutations** (each killed, then all five files restored and verified with `sha256sum -c`):

  | Mutation | Failing tests |
  |---|---|
  | M1 an aborted (timed-out) request classified as not sent (retryable) | 2 adapter timeout tests |
  | M2 the raw provider error body logged | 2 E2E leak tests |
  | M3 the test provider allowed in production | the production-refusal config test |
  | M4 the engine timeout removed | 2 E2E (hung API: 60 s test timeout; shutdown during a hang) |
  | M5 a sender taken from the message | the server-owned sender test |
  | M6 a local number "normalized" to +216 | 4 E.164 tests |
  | M7 the raw response stored as the message id | 6 adapter tests, 3 E2E including the persistence scan |

- **Leak scan** (sentinel code, email, phone, provider API key and secret, request-hash key, secret key, service token, provider error
  bodies containing personal data, database and broker passwords): application logs 0, every table 0, production-image logs 0, image
  `pg_dump` 0.
- **Performance sanity** (local stand-in with 5 ms latency, not a capacity figure): 1 000 emails + 1 000 SMS, 3 workers ×
  concurrency 4: 3.45 s, 2 000 requests, 0 duplicate attempts, at most 11 requests in flight at the stand-in (≤ 12), peak 12 database
  connections across the 3 processes.
- **Production image** (throwaway PostgreSQL + RabbitMQ, migrator / app roles, a host stand-in for both APIs): `test` refused in
  production; Resend without a key refused (named); a malformed account SID refused, value not echoed; a plain-http provider URL refused
  in production; a valid production configuration (real https URLs, well-formed dummy credentials) starts, uid 1000 (`node`), PID 1,
  `/ready` 200, stop 69 ms, exit 0 (no provider was called); in development against the stand-in: a code sent by both adapters, its
  secret purged; a 429 with `Retry-After: 1` scheduled by the worker's own backoff; a stop during a hung Resend call 1.5 s, exit 0,
  `UNCONFIRMED provider_timeout`.
- **External sandbox smoke:** **PENDING — credentials not supplied.** No real Resend or Twilio request was made in this stage.

## 12. Carryovers

- **Auth E.164 (production prerequisite):** Auth accepts `^\+?[0-9]{8,15}$`; Notification keeps strict E.164, so an Auth-originated
  non-canonical number fails safely (`FAILED invalid_destination`). A separate Auth correction is required before enabling production
  SMS for Auth users. Auth was not changed.
- **D21:** `notif_dest` not implemented; the preferred direction for 16.9 is an HMAC-SHA-256 of the normalized destination under a
  dedicated limiter key (not the request-hash key, a secret key, a service token or a provider credential).
- **Provider operations (16.9):** credential rotation runbook (Resend key, Twilio API key); monitoring and alerting on
  `provider_auth_fault` / `provider_config_fault` / `provider_rate_limited`; a provider-wide circuit breaker if faults prove costly.
- **ADR-0047 open items (owner, before production):** Resend cost at volume, a Tunisia / MENA deliverability pilot, the
  data-processing agreement and region.
- **Sandbox smoke** with test credentials (opt-in, never CI) and a live latency check of the 10 s timeout.
- Unchanged: request-hash key rotation, secret-key retirement runbook, D10 retention, D19 Auth outbox, attachments (Stage 17).

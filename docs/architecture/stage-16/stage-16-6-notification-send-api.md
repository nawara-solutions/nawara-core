# Stage 16.6 — Notification send API

- **Status:** implemented and validated (2026-09-24), pending review
- **Decision:** [ADR-0046](../../adr/0046-notification-service-architecture.md) rules 8, 9, 13, 14 and 15; D15 and D16 and the new
  **D25** (the keyed request hash) in the [Stage 16.1 register](./stage-16-1-decisions-and-roadmap.md); the
  [SDD](../../sdd/notification-service.md) §4, §7.2, §9 and §11.
- **Scope:** the internal service-to-service API that records durable notification work: send, status and cancel. There is no
  provider call, no attempt and no worker (16.7). Nothing is sent.

## 1. Architecture

```text
Core service ── Bearer <service token>, Idempotency-Key ──► POST /notification/notifications
   ServiceTokenGuard (caller = the token's service) ─► body check (400) ─► NOTIFICATION_SERVICE_POLICY (403) ─► per-caller limit (429)
   ─► requestHash = HMAC-SHA-256(key, canonical body) ─► existing (caller, key)? same hash → the original 202 · else 422
   ─► IntentCore (shared with the Stage 16.5 event intake): template version per channel in the resolved locale (404),
      variable values (422), destination format (422), split + seal secrets
   ─► BEGIN · INSERT notification ON CONFLICT (sourceService, idempotencyKey) DO NOTHING · INSERT deliveries (PENDING) · COMMIT ─► 202
```

`IntentCore` (`src/intake/intent-core.ts`) is the one implementation of four shared steps: template and locale resolution (the
database is the publication authority), the secret / non-secret split, sealing, and delivery creation. The Stage 16.5 event intake was
refactored onto it with its behaviour unchanged, and its suites stay green.

What each transport keeps for itself:

| | Event intake (16.5) | Send API (16.6) |
|---|---|---|
| identity | `(source, eventId)` | `(authenticated caller, Idempotency-Key)` + request hash |
| authorization | the event map (a static allowlist) | `NOTIFICATION_SERVICE_POLICY` |
| invalid destination | a durable `FAILED invalid_destination` delivery (the event is valid business input) | `422 invalid_destination`, nothing written (rejected input) |
| malformed input | dead-lettered once | `400` / `422` |

The API never goes through RabbitMQ and adds no outbox: the delivery rows are the durable work of Stage 16.7.

## 2. Routes

| Method | Route | Authentication | Purpose | Response |
|---|---|---|---|---|
| POST | `/notification/notifications` | service token + `Idempotency-Key` | record an intent by template | `202 { id, status: "accepted", deliveries: [{ id, channel, status: "PENDING" }] }` |
| GET | `/notification/notifications/:id` | service token; the creating caller only | derived status | `200` view (below), else `404 notification_not_found` |
| POST | `/notification/notifications/:id/cancel` | service token; the creating caller only | cancel the PENDING deliveries | `200` view, or `409 delivery_in_progress` |

OpenAPI is at `/notification/docs` behind basic auth, mounted only with `SWAGGER_PASSWORD`. There is no list, search, admin or
delete route (SDD §7.2).

## 3. Authentication and caller policy

- **Authentication:** the kit `ServiceTokenGuard` (a SHA-256 digest per caller in `SERVICE_TOKENS`, constant-time comparison). The
  caller's name comes from the token only.
  - A `caller` or `sourceService` field in the body is refused (`400`: an unknown field).
  - A caller header is ignored.
  - No token, a bad token, an unregistered token or a user JWT gets `401`, and nothing is written.
- **Policy** (`NOTIFICATION_SERVICE_POLICY`, SDD §11.2, parsed at startup):

  ```json
  { "callers": { "<caller>": { "templates": ["membership.approved"], "channels": ["EMAIL", "SMS"], "organizations": "none" | "request" } } }
  ```

  - **Deny by default:** a registered caller with no entry, or an entry with no token, refuses to boot.
  - **No wildcard:** the templates list is explicit. Channels are only `EMAIL` / `SMS`. An unknown property (for example
    `categories`) refuses boot.
  - **Enforcement:**

    | Violation | Response |
    |---|---|
    | template not in the caller's list | `403 template_not_allowed` |
    | channel not in the caller's list | `403 channel_not_allowed` |
    | an organization with `organizations: "none"` | `403 organization_not_allowed` |

  - **The category is the template's:** a caller cannot choose it, and a `category` field is refused.

## 4. Request contract (every field typed and bounded; unknown fields refused)

| Field | Rule |
|---|---|
| `template` | a template key the caller's policy lists (required) |
| `organizationId` | uuid or null; only with `organizations: "request"` |
| `recipient` | `{ type: [a-z][a-z0-9_]{0,31}, id: 1–128 }` or null; a generic reference, never contact data |
| `locale` | BCP 47 or null |
| `channels` | 1–2 of `{ channel: EMAIL \| SMS, destination: 1–320 }`, each channel at most once (`422 duplicate_channel`) |
| `data` | an object; validated against the template (§7) |
| `scheduledAt` | ISO UTC, in the future and ≤ `NOTIFICATION_MAX_SCHEDULE_AHEAD_SEC` ahead (`422 schedule_out_of_range`) |
| `expiresAt` | ISO UTC, in the future and after `scheduledAt` (`422 schedule_out_of_range`) |

- **Never accepted** (a `400`): a provider, a status, an attempt, a lease, a category, a subject, a body, a template version.
- **Validation:** the body is validated by a hand-written parser, not the global DTO pipe, so the frozen codes are exact:
  `validation_error` with field-level messages that never echo a value.

## 5. Idempotency and the keyed request hash (D25)

- **Header:** `Idempotency-Key` is required: 8–128 of `[A-Za-z0-9._:-]`, taken as sent (case-sensitive, no normalization).
  - Missing or empty: `400 idempotency_key_required`.
  - Malformed: `400 validation_error`.
- **Identity:** `(authenticated caller, Idempotency-Key)`, the 16.4 partial unique index on `notification`. Each caller has its own
  namespace.
- **Request hash:** `hex(HMAC-SHA-256(NOTIFICATION_REQUEST_HASH_KEY, "nawara.notification.api.v1|" + canonicalJson(body)))`, stored
  in `notification.requestHash` (64 hex characters; no schema change).
  - `canonicalJson` is the kit's: object keys sorted, so property order and whitespace do not matter.
  - **The whole semantic body participates, secret variables included**: the same key with a changed one-time code gives `422
    idempotency_key_reused`.
  - The canonical plaintext exists only inside the call; it is never stored or logged.
  - Hashes are compared in constant time (`timingSafeEqual`).
- **Why keyed, and why Notification differs from Payment:**

  ```text
  Payment request bodies ─── no low-entropy secret ─── unkeyed SHA-256 is fine (unchanged)
  Notification bodies ────── may carry a one-time code (10^6 candidates) with every other field stored in clear beside the hash
                             ─── unkeyed SHA-256 lets a database reader recover a live code in about a second ─── HMAC-SHA-256
  ```

  This is a Notification-specific security refinement that replaces the SDD's "SHA-256 of the canonical request (the Payment
  pattern)". It is not a change to Payment.
- **The key** (`NOTIFICATION_REQUEST_HASH_KEY`):
  - required; base64 of ≥ 32 random bytes; validated at startup;
  - must differ from every `NOTIFICATION_SECRET_KEYS` key;
  - never in the database, a log, an error, a health or readiness answer, or a response.
- **Rotation (a carryover to 16.9):** there is one key. Changing it makes a retry of a request accepted under the previous key look
  different, so that retry gets `422 idempotency_key_reused`. Deploy a new key only when no in-flight retries are expected. Versioned
  request-hash keys are a Stage 16.9 Security / Operations item.

## 6. Destinations, locale, templates

- **Destinations:** the Stage 16.5 validators, unchanged (D20).
  - **SMS:** canonical E.164 `^\+[1-9][0-9]{7,14}$`. No country is guessed, no `+216` is added, no local number is converted.
  - **EMAIL:** the bounded ASCII check.
  - On the API, an invalid destination is **`422 invalid_destination`** for the whole request: nothing is written, not even a
    partial intent. The durable `FAILED` path of the event intake is not used for rejected HTTP input.
- **Locale, per channel:** requested → base language → `NOTIFICATION_DEFAULT_LOCALE`. Nothing is taken from a phone number, an
  organization, the caller or `Accept-Language`.
- **Templates:** the active version per (key, channel, resolved locale) from the database, pinned on each delivery. A later v2 never
  moves an existing delivery (tested). A policy-listed key with no published version is `404 unknown_template`.

## 7. Variables and secrets

- **Variables:** validated against the pinned version's schema before anything is written.
  - The rules: required, no unknown variable, types and bounds, ISO UTC datetimes, https URLs, letter-and-digit codes; nothing is
    coerced.
  - A failure is `422 invalid_template_data`, naming the variables only.
- **Secrets (the Stage 16.5 mechanism):** secret-flagged variables are sealed together with AES-256-GCM
  (`NOTIFICATION_SECRET_KEYS`, AAD bound to the notification id).
  - Stored: `secretCiphertext` + `secretKeyId`.
  - Never in `data`, a response, a log, an error or the hash diagnostics.
  - The plaintext lives only in the request's memory.
  - The purge (terminal state or `expiresAt`) belongs to the 16.7 worker.

## 8. Transaction and response boundary

```text
BEGIN
  INSERT notification … ON CONFLICT ("sourceService", "idempotencyKey") WHERE "sourceKind" = 'api' DO NOTHING RETURNING id
  INSERT notification_delivery × N   (PENDING, due at scheduledAt or now; pinned version + locale)
COMMIT
→ 202
```

- **Losing a concurrent copy:** a request that loses the insert answers from the winner's row: the same hash replays the `202`, a
  different hash gets `422`.
- **Lost response:** a response lost after the commit is a safe retry (tested with an injected failure after `COMMIT`).
- **Database down:** a `500` (SDD §13, the O3 semantics), nothing written; the same key succeeds once the database is back.

## 9. Status and cancellation

- **GET:** the creating caller only; another caller's notification is `404`, indistinguishable from a missing one.
  - The status is **derived** from the deliveries: `IN_PROGRESS` while one is PENDING or SENDING; otherwise `CANCELLED` if the
    cancel stamp is set; otherwise `COMPLETED`. There is no stored notification status.
  - The response lists deliveries as `{ id, channel, status, attempts, locale, templateVersion, destinationHint ("…" + the last 2
    characters), sentAt, failureCode }`.
  - It never includes `data`, secrets, full destinations or provider data.
- **Cancel** (SDD §9.3), one transaction on the locked intent:
  - `cancelledAt` / `cancelledBy` are set once, while a delivery is PENDING or SENDING;
  - every PENDING delivery becomes CANCELLED;
  - repeating it is `200` with the same state;
  - if all deliveries are terminal: `200`, nothing changes;
  - if a delivery is SENDING: `409 delivery_in_progress`. The pending ones *are* cancelled, and the SENDING one is left for the 16.7
    pre-send check, which reads `cancelledAt`.
  - **Deviation:** the kit error envelope carries `{ message, code }` only, so the 409 states the counts in its message instead of
    listing the deliveries. The caller uses GET for the detail.

## 10. Errors (the kit envelope `{ statusCode, message, error, code, requestId }`)

| Class | Status / code |
|---|---|
| no, bad, unknown or user token | `401` |
| template / channel / organization outside the policy | `403 template_not_allowed` / `channel_not_allowed` / `organization_not_allowed` |
| missing Idempotency-Key | `400 idempotency_key_required` |
| malformed key, unknown field, bad type or bound | `400 validation_error` |
| no published version | `404 unknown_template` |
| key reused with a different request | `422 idempotency_key_reused` |
| invalid data / destination / duplicate channel / schedule | `422 invalid_template_data` / `invalid_destination` / `duplicate_channel` / `schedule_out_of_range` |
| per-caller intake limit | `429 rate_limited` (`notif_api_caller`, keyed by the caller name only; no destination key, D21 untouched) |
| not found / another caller's | `404 notification_not_found` |
| cancel with a delivery in flight | `409 delivery_in_progress` |
| database unavailable | `500` (opaque) |

## 11. Readiness and RabbitMQ

The API writes to the database directly and does not need the broker. Readiness is unchanged: `database` + `migrations` +
`rabbitmq` + `event-intake`, following the certified D12 contract, and O2 stays with SRE. So with the broker down the service reports
`503` and a load balancer stops routing to it, but a request that reaches it is still accepted durably (tested). Readiness was not
redesigned here.

## 12. Configuration (new)

| Variable | Default | Bounds | Notes |
|---|---|---|---|
| `NOTIFICATION_SERVICE_POLICY` | empty | JSON (above) | required as soon as a caller is registered |
| `NOTIFICATION_REQUEST_HASH_KEY` | **required** | base64, ≥ 32 bytes, differs from the secret keys | secret |
| `NOTIFICATION_MAX_SCHEDULE_AHEAD_SEC` | 2592000 (30 days) | 60–31536000 | the SDD's `NOTIFICATION_MAX_SCHEDULE_AHEAD`, with the unit named |
| `NOTIFICATION_API_INTAKE_LIMIT_PER_MINUTE` | 600 | 1–100000 | per caller (SDD §11.3) |
| `SWAGGER_USERNAME` / `SWAGGER_PASSWORD` | `docs` / unset | password ≥ 16 | the docs are mounted only with a password |

The 30-day and 600-per-minute defaults are engineering bounds, not product decisions. Tune them from evidence.

## 13. Evidence

| Proof | Where | Result |
|---|---|---|
| policy parser (deny by default, no wildcard, 12 refusals); the request parser (20 refusals, no value echoed); `Idempotency-Key`; the request hash (order-stable, changes with the code / any field / the key, not the unkeyed SHA-256, constant-time compare) | `src/api/api.spec.ts` | pass |
| OpenAPI: 3 operations with bearer auth and `Idempotency-Key`; request schema = the enforced fields; no list route; no full destination | `src/docs/openapi.spec.ts` | pass (unit total 194) |
| auth matrix (4 × 3 routes, 0 writes), impersonation, policy (3 × 403), category refused, 20 validation / business refusals (0 writes, no code echoed), E.164 (5 invalid → 422, 2 valid → 202 stored as given), email (4 invalid), no partial intent, accepted rows (api identity, 64-hex HMAC, pinned versions, PENDING, code sealed and opening, 0 attempts), schedule + per-channel locale, v1 / v2 pinning; idempotency: replay, reordered and whitespace body, changed non-secret → 422, changed code → 422, other caller, 10 concurrent identical → 1, 8 concurrent conflicting → 1 + 7 × 422, lost response after commit → the same intent, restart → the same 202; **security: an exhaustive unkeyed search of all 10^6 codes over the known body never matches the stored hash, while the HMAC with the key does**; dump / log / response scan; GET (creator, other caller, unknown, malformed); cancel (all pending, repeat, other caller, SENDING → 409, all terminal → no change); database down → 500, no write, then 202 once; 429; API / event parity; broker down → 503 yet accepted; in-flight shutdown → 202 committed, close bounded | `test/send-api.e2e-spec.ts` | 64 / 64 |
| Stage 16.3–16.5 regression (foundation incl. docs behind basic auth, process, migrations, persistence, health, runtime role, intake, real broker) | Notification E2E | pass (E2E total 205) |
| real Auth → RabbitMQ → Notification, and the Billing / Payment loops | `test/e2e-real-broker` | 13 / 13 |
| production image (real PostgreSQL provisioned by the init script, real RabbitMQ, a service token, a policy): migrate as the migrator; boot as `notification_app`, `/ready` 200, uid 1000; no or bad token → 401; send 202; identical replay; changed code → 422; forbidden template → 403; GET `IN_PROGRESS` with `…12`; cancel → `CANCELLED`; 0 attempts; `docker stop` exit 0 in 63 ms; 0 leaks (token, digest, code, phone, secret key, hash key, database password) in the logs and 0 (code, keys) in a data dump; `smoke-core-image.sh` passes | local | pass |
| mutations: M1 guard removed → 5 auth tests fail; M2 template policy bypassed → policy test fails; M3 every hash equal → 3 conflict tests fail; M4 secret into `data` → 2 tests fail; M5 local numbers accepted → 5 E.164 tests fail; **M6 HMAC → the old unkeyed SHA-256 → 2 unit tests and the brute-force security test fail** | | killed, restored |
| HTTP sanity (local, not a capacity figure): 2 300 requests (1 500 new, 500 duplicates, 300 conflicting), concurrency 50, 2.47 s (~930 req/s); exactly 1 500 intents / 3 000 deliveries; 1 972 × 202 and 328 × 422 (300 conflicts, plus 28 keys whose conflicting body arrived first, making the original and its duplicate the 422s: first writer wins); pool at 10, 0 idle transactions | temporary probe | pass |

## 14. Carried over

- **D19 Auth outbox:** deferred.
- **Auth E.164 normalization:** required before production SMS (Notification stays strict).
- **D21:** open; the intake limit is keyed by caller, not destination.
- **D2 / D3:** provider decisions, before 16.8.
- **D10:** retention open.
- **Provider-error sanitization:** 16.8 / 16.9.
- **Attachments:** Stage 17.
- **Request-hash key rotation / versioning:** Stage 16.9.
- **For the 16.7 review:** the event intake's in-transaction `PENDING → SENDING → FAILED` representation for an invalid event
  destination. The API does not use it.

# Stage 16.5 — Notification event intake

- **Status:** implemented and validated (2026-09-24), pending review
- **Decision:** [ADR-0046](../../adr/0046-notification-service-architecture.md) rules 8, 9, 12 and 18; D4, D5, D7, D11, D12 and D20 in
  the [Stage 16.1 register](./stage-16-1-decisions-and-roadmap.md); the [SDD](../../sdd/notification-service.md) §6.2, §6.4, §7.1, §12,
  §13 and §16.
- **Scope:** canonical Auth event → durable notification intent. There is no provider call, no attempt, no send API (16.6) and no
  worker (16.7). Every accepted delivery stays `PENDING`; an undeliverable one is recorded `FAILED invalid_destination`.

## 1. Flow

```text
Auth (16.2 envelope) ─► nawara.events ─► queue notification.events (bound to the 9 mapped keys only)
    ─► kit RabbitMqEventBus consumer (prefetch 5, envelope check, retry 3 x 5 s, DLQ notification.events.dead)
    ─► IntakeService: mapping (source, name) ─► version ─► payload ─► destination presence ─► locale ─► template version
       ─► variable values ─► split secret / non-secret ─► seal secrets (AES-256-GCM) ─► destination format (E.164 / email)
    ─► ONE transaction: INSERT notification ON CONFLICT (sourceService, sourceEventId) DO NOTHING
                        + INSERT its delivery (PENDING, due now)  [or PENDING → SENDING → FAILED invalid_destination]
    ─► COMMIT ─► the handler returns ─► the kit acknowledges
```

Notification never calls Auth. Every fact comes from the event: the destination, the code, the recipient id and the organization.

## 2. RabbitMQ topology (the kit's, unchanged)

| Item | Value |
|---|---|
| Exchange | `nawara.events` (durable topic, shared; Auth publishes to it) |
| Queue | `notification.events` (durable, owned by Notification, SDD §7.1), dead-letter exchange `nawara.events.dlx` |
| Bindings | exactly the 9 mapped routing keys (the table below); `user.registered`, `membership.requested` and `membership.admin_provisioned` are never routed here |
| Retry | the kit default: 3 retries × 5 s through `notification.events.retry`, then `notification.events.dead` (SDD §13) |
| DLQ | `notification.events.dead`, annotated `x-nawara-failure` / `x-nawara-failure-reason`; never purged unseen (15.7) |
| Prefetch | `min(10, max(1, DB_POOL_MAX / 2))` = 5 by default (the Billing rule, Stage 15.8) |
| Confirm, heartbeat | `RABBITMQ_CONFIRM_TIMEOUT_MS` (5000), `RABBITMQ_HEARTBEAT_S` (10), Core bounds |

The kit consumer checks, before the handler runs: a string `messageId`, an event-name `type`, and a JSON-object body. Anything else
is `malformed_envelope` and is dead-lettered at once. The logical identity is **(headers.source, messageId = eventId)**.

## 3. Event map (`src/intake/event-map.ts`: data, not branches)

| Auth event | Template | Category | Channel | Recipient | Organization | Expiry | Secret |
|---|---|---|---|---|---|---|---|
| `member.contact_verification_requested` | `identity.contact_verification_code` | SECURITY | from `channel` | `user` / `userId` | none | `expiresAt` | `code` |
| `admin.operator_code_issued` | `identity.operator_login_code` | SECURITY | from `channel` | `user` / `userId` | none | `expiresAt` | `code` |
| `admin.operator_confirmation_code_issued` | `identity.operator_confirmation_code` | SECURITY | from `channel` | `user` / `userId` | none | `expiresAt` | `code` |
| `admin.owner_recovery_requested` | `identity.owner_recovery_requested` | SECURITY | from `channel` | `user` / `userId` | none | – | – |
| `admin.owner_recovery_completed` | `identity.owner_recovery_completed` | SECURITY | from `channel` | `user` / `userId` | none | – | – |
| `admin.owner_login_from_new_device` | `identity.owner_new_device_login` | SECURITY | from `channel` | `user` / `userId` | none | – | – |
| `membership.approved` / `.rejected` / `.revoked` | the same key | TRANSACTIONAL | from `channel` | `user` / `userId` | `organizationId` | – | – |

- Every mapping is `source: auth-service`, `version: 1`.
- `channel` `email` → `EMAIL`, `phone` → `SMS`; one delivery per event.
- **Variables:**
  - `code`, `expiresAt` (codes);
  - `availableAt`, `ipAddress` (recovery requested);
  - `occurredAt` ← `timestamp`, `ipAddress` (recovery completed, new device);
  - none for membership.

## 4. Validation

- **Payload:** each mapping lists its required fields and types (`id`, `uuid`, `channel`, `destination`, `string` ≤ 1024,
  `datetime` ISO UTC).
  - A missing or mistyped field is `malformed_payload`; the log names the fields, never the values.
  - Unknown extra fields are ignored and never stored, so an additive producer change does not break intake. A breaking change
    publishes a new version.
- **Version:** `headers.version` must equal the mapping's (1). Anything else is `unsupported_version`, never read as v1.
- **Destination presence:** `destination: null` is `no_destination`.
- **Template variable values** (SDD §6.2), validated against the pinned version's schema before anything is stored:
  - rules: required, no unknown variable, no coercion;
  - `string`: 1..maxLength, no control characters;
  - `code`: letters and digits, ≤ maxLength;
  - `integer`: a safe integer;
  - `datetime`: ISO 8601 UTC that round-trips;
  - `url`: https, ≤ maxLength;
  - a failure is `invalid_template_data`; the log names the variables, never the values.
- **Template:** no active version for (key, channel, resolved locale), or a category that disagrees with the mapping, is
  `unknown_template`. That is a deployment defect: dead-lettered, replayable after a fix, and never another template.

All of these are `PermanentEventFailure`: dead-lettered at once, nothing written, no retry.

## 5. Destinations (D20 RESOLVED for intake)

- **SMS:** `^\+[1-9][0-9]{7,14}$` (canonical E.164, 8 to 15 digits).
  - Nothing is normalized, prefixed or guessed: no default country and no `+216`.
  - No country is derived from an organization, a locale or the server.
  - `20000003`, `21620000003`, `0021620000003`, `+216 20 000 003` and `+021620000003` are all invalid.
- **EMAIL:** a conservative ASCII check (not full RFC 5322):
  - at most 254 characters, one `@`;
  - the local part is 1–64 characters of letters, digits and the RFC atext set, with no leading, trailing or doubled dot;
  - the domain has at least two labels of letters, digits and inner hyphens, at most 63 each (an IDN arrives as `xn--`);
  - no whitespace or control character.

  The address is stored exactly as given: no case folding, no trimming.
- **An invalid destination is a business outcome, not a poison message** (SDD §7.1).
  - The intent and its delivery are recorded, and the delivery ends `FAILED`, `failureClass = terminal`,
    `failureCode = invalid_destination`, in the same transaction.
  - The frozen matrix has no `PENDING → FAILED` edge, so the delivery takes the allowed path `PENDING → SENDING → FAILED` inside the
    transaction. No other process can see or claim the intermediate state.
  - No attempt row is written, the destination is stored as received, and **no secret is sealed**: nothing will ever be sent, so
    the code is not kept.
  - It is never retried and never dead-lettered.
- **Consequence for Auth (D20 carry-over):** Auth still accepts `+?[0-9]{8,15}`. A phone stored without `+` now yields a visible
  `FAILED invalid_destination` SMS delivery (proven with the real Auth). Producer-side E.164 normalization, with real country
  context, is required before SMS is enabled in production.

## 6. Locale and template resolution

- **Locale:**
  - `NOTIFICATION_DEFAULT_LOCALE` is required, a BCP 47 locale, and a product input (D7).
  - Resolution per delivery: exact requested → base language → the default. A missing or malformed request resolves to the
    default.
  - Auth events carry no locale, so they resolve to the default (`en` today).
- **Template:** the active (highest) version of (platform template key, channel, resolved locale) from the **database**, the
  published authority. The delivery pins that version id, channel and locale (16.4 composite foreign key).
  - Publishing v2 later changes nothing for existing deliveries; new events pin v2 (tested).
- **Start guard:** the intake does not consume while any mapped template lacks an EMAIL or SMS version in the default locale. It
  logs `event_intake_waiting reason=default_locale_not_published` and `/ready` answers 503.

## 7. Secrets (D5, SDD §12.1)

- **Key ring:** `NOTIFICATION_SECRET_KEYS` (`id:base64(32 bytes)`, distinct ids and keys) and `NOTIFICATION_SECRET_ACTIVE_KEY_ID`.
  Both are required with no default, never logged, and never in the database.
- **Sealing:** every secret variable of an intent is sealed together, as canonical JSON, with AES-256-GCM: a fresh 96-bit nonce,
  AAD `nawara.notification.v1|<notificationId>`, layout `version | nonce | ciphertext | tag`.
  - The result goes in `secretCiphertext` with `secretKeyId`.
  - A ciphertext moved to another notification, a tampered byte or an unknown key fails to open.
- **Plaintext lifetime:** the handler's memory only. It is never in `notification.data`, a log, an exception message or a
  failure reason.
- **Purge:** at terminal state or `expiresAt` (16.7 worker). An intent whose only delivery is already terminal keeps no secret.
- **Expired at intake:** following SDD §13 ("the claim records it `EXPIRED`"), an event consumed after its `expiresAt` is recorded
  `PENDING` with its expiry. The 16.7 claim expires it and purges the secret, and it is never sent.

## 8. Transaction, ACK and idempotency

- **One transaction per event:** the notification and its delivery. The `INSERT … ON CONFLICT (sourceService, sourceEventId) WHERE
  sourceKind = 'event' DO NOTHING` uses the 16.4 partial unique index.
  - No row returned means a duplicate: nothing is written, `notification_duplicate` is logged, and the message is acknowledged.
  - A concurrent copy waits for the first transaction, then does nothing.
- **ACK ordering:** the handler returns only after `COMMIT`, and the kit acknowledges only after the handler returns.
  - A failure before or at the commit is not acknowledged: the kit retries.
  - A commit whose outcome was lost (a timeout, or a crash after the commit) is redelivered and resolved by the unique identity.
- **Deduplication:** no in-memory deduplication, no receipt table, no distributed transaction. The kit `InboxService` stays unused
  in V1 (SDD §3); the notification's unique source identity is the one source of truth for logical idempotency.

## 9. Readiness, start order, shutdown

- **`/ready`:**
  - `database` + `migrations` (the kit);
  - `rabbitmq` (a connect probe, the Billing pattern);
  - `event-intake` (the consumer has started and is attached).

  `/health` stays liveness only.
- **Start order:** the consumer subscribes only once the database answers, every migration is applied and the default locale
  covers every mapped template. The broker must also answer, since the kit's first subscribe fails fast.
  - Until then the process stays up, not ready, and retries with jittered backoff (250 ms → 5 s), logging each new reason once.
  - Billing's consumer fails the process instead; here waiting is needed for the migration and locale guard.
- **Shutdown (Stage 15.5):**
  1. At shutdown start, the consumer is cancelled (no new delivery) and in-flight handlers finish and settle within the kit's
     5 s drain, while the pool is open.
  2. HTTP drains.
  3. `onApplicationShutdown` closes the bus (bounded by 3 × heartbeat).
  4. The kit closes the pool last.

## 10. Failure behaviour (measured on real PostgreSQL and RabbitMQ)

| Case | Outcome |
|---|---|
| Broker down at startup | process up, `/ready` 503 (`event-intake`, `rabbitmq`), `event_intake_waiting reason=broker_unavailable`; starts by itself when the broker answers |
| Broker lost after startup | `/ready` 503; the kit reconnects (`rabbitmq_consumer_recovered`); consuming resumes with no restart |
| Database lost while consuming | the handler fails; nothing acknowledged or written; `event_retry_scheduled`; when the database returns, exactly one intent; nothing dead-lettered |
| Crash between commit and ACK (injected in a test) | redelivered after 5 s, `notification_duplicate`, still one intent |
| Poison: pre-16.2 envelope, `version: 2`, payload missing `expiresAt` | each in `notification.events.dead` exactly once (reasons `malformed_envelope`, `unsupported_version`, `malformed_payload`), never retried, nothing written |
| Shutdown with a delivery in flight | the in-flight event committed and acknowledged, no redelivery, close bounded (< 8 s) |

## 11. Evidence

| Proof | Where | Result |
|---|---|---|
| E.164 (5 valid, 14 invalid), email (6 valid, 14 invalid), locale chain, variable values (1 valid, 14 invalid, no value echoed), sealing (round trip, fresh nonce, moved ciphertext, tamper, unknown key, rotation), event map (queue, 9 bindings, not-consumed events, (source, name), templates / variables agree with the catalog), payload problems | `src/intake/intake.spec.ts` | pass (unit total 151) |
| config: broker, key ring and locale required and bounded, never echoed | `src/config/notification-config.spec.ts` | pass |
| all 9 mappings × EMAIL / SMS on real PostgreSQL (template, category, recipient, organization, correlation, expiry, channel, destination, locale, pinned version, data without the code, sealed code opens, 0 attempts); 5 invalid destinations → FAILED, no secret; 10 permanent failures + unknown template → nothing written; 5× replay → 1; 12 concurrent copies → 1; version pinning across v2; locale resolution; leak scan (code, email, phone, IP) of logs and a dump of the notification and delivery tables | `test/intake.e2e-spec.ts` | 40 / 40 |
| real RabbitMQ: queue, consumer, ACK after commit, unconsumed event not routed, 10 copies → 1, 3 poison → DLQ once, crash window, database loss, broker loss, broker down at start, restart replay, in-flight shutdown | `test/event-intake-broker.e2e-spec.ts` | 9 / 9 (repeated) |
| **real Auth → RabbitMQ → Notification** (both built processes): an operator code by email → PENDING EMAIL on `identity.operator_login_code`, correlation id carried, the sealed code opens to Auth's 6-digit code; by E.164 phone → PENDING SMS; by `2162…` (valid for Auth, not E.164) → FAILED `invalid_destination`, no secret; 0 attempts; empty DLQ; no code / destination / key in either service's log | `test/e2e-real-broker/stage16-5-auth-notification.e2e-spec.ts` | 4 / 4 |
| readiness, migrations-before-consume, runtime role, foundation, built process | the updated 16.3 / 16.4 suites | pass (Notification E2E total 140) |
| production image on real PostgreSQL (the init script) and real RabbitMQ: migrate as the migrator, boot as `notification_app`, `/ready` 200, a published code event → sealed intent + PENDING SMS, 0 attempts, `docker stop` exit 0 in 67 ms, 0 leaks (code, phone, key, database password); `smoke-core-image.sh` passes | local | pass |
| mutations: M1 ACK before commit → 7 broker tests fail; M2 identity from a fresh uuid → replay and concurrency fail; M3 local numbers accepted → 4 unit + 3 intake tests fail; M4 secret routed into `data` → 7 tests fail (including the leak scan) | | killed, restored |
| throughput sanity (a local laptop, not a capacity figure): a 3 300-message backlog (300 duplicates) drained in 2.63 s including startup (~1 255 msg/s); 3 000 intents, 3 000 deliveries, 300 duplicates; at most 5 database sessions (prefetch 5); no retry, nothing dead-lettered | temporary probe | pass |

## 12. Carried over

- **D19 Auth outbox:** deferred. Notification consumes idempotently what it receives, but an event Auth never published (the
  commit → publish window) cannot be recovered here.
- **D20:** resolved for intake. Producer normalization (Auth) remains required before SMS production.
- **D21 (unpeppered rate-limit keys):** open. No destination limiter exists; it must be resolved before 16.7's destination limits.
- **Providers:** D2 and D3 before 16.8. Provider-error sanitization (the 16.3 finding) is required in 16.8 / 16.9.
- **Retention (D10):** open.
- **Attachments:** File Service (Stage 17).
- **Preferences** and **Push:** not in V1.

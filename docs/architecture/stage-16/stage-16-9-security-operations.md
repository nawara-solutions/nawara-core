# Stage 16.9 — Notification security and operations

- **Status:** implemented and validated on `feat/notification-security-operations` (awaiting review).
- **Scope:** the D21 destination limiter (HMAC-keyed `notif_dest`); request-hash key rotation; the secret-encryption key lifecycle
  and a retirement check; production key-material checks and purpose separation; an operational snapshot signal; retention of
  technical limiter state; the alerting contract and [runbooks](../../runbooks/notification-service.md); a focused security review;
  ADR-0046 acceptance.
- **Not in scope:** Auth changes (E.164, outbox), notification-history retention durations (owner / legal), provider sandbox calls
  (no credentials), 16.10 certification, File Service, push, preferences.
- **Schema:** unchanged (no migration). Everything new uses the existing tables and indexes.

## 1. Carryover inventory

| Item | Classification | Outcome |
|---|---|---|
| D21 destination limiter privacy | IMPLEMENT IN 16.9 | `notif_dest` keyed by HMAC under a dedicated key (§2) |
| Request-hash key rotation / versioning | IMPLEMENT IN 16.9 | current + ≤ 2 previous keys (§3) |
| Secret-encryption key retirement | IMPLEMENT + RUNBOOK | usage / retire-check tool, missing-key signal, runbook (§4) |
| Provider credential rotation | DOCUMENT / RUNBOOK | configuration-only; runbook §4 (no code change needed) |
| Provider auth / config / rate-limit alerting | IMPLEMENT (signals) + DOCUMENT (routing) | error-level log signals exist (16.8); alert contract (§6) |
| Provider-wide circuit breaker | NOT REQUIRED FOR V1 | proven bounded by durable backoff (§7) |
| D10 retention | IMPLEMENT (limiter state) + OWNER / LEGAL (history) | §8 |
| Auth E.164 | PRODUCTION PREREQUISITE (Auth, separate change) | §11 |
| D19 Auth outbox | DEFERRED (Auth; accepted risk in ADR-0046 §17) | §11 |
| Real provider sandbox smoke | PENDING — credentials not supplied | §12 |
| Live provider latency | PENDING | §12 |
| Resend cost / MENA deliverability / DPA | OWNER / EXTERNAL DECISION | §12 |
| ADR-0046 status | DOCUMENTATION CLOSURE | Accepted with an acceptance note (no material deviation) |
| Attachments | DEFERRED (File Service, Stage 17) | unchanged |

No stop condition applied: D21's SDD semantics (per channel + destination, at claim time, `FAILED rate_limited`) fit the kit limiter
with an HMAC identifier; rotation needed no schema change; no destructive migration; history retention is left to the owner.

## 2. D21 — the destination limiter

```text
identity  = hex(HMAC-SHA-256(NOTIFICATION_DESTINATION_LIMIT_KEY, "nawara.notification.destination-limit.v1|" + channel + "|" + destination))
kit key   = sha256("notif_dest:" + identity)          (kit_rate_limit, bucket notif_dest)
```

- **Keyed input:** the destination exactly as intake accepted and stored it: canonical E.164 for SMS; the email address byte for byte
  (no case folding, `+tag` or dot stripping, no provider aliasing), so two distinct destinations never share a bucket (tested).
- **Scope and window (SDD §11.3):** per channel + destination, across all callers and templates; a fixed window;
  `NOTIFICATION_RATE_DESTINATION_LIMIT` (default 30, 1–100 000) per `NOTIFICATION_RATE_DESTINATION_WINDOW_SEC` (default 3600,
  60–86 400). Engineering defaults, set above the producers' own throttles (Auth's code throttles stay primary); not caller-chosen.
- **Where:** in the worker, after the pre-send checks and the caller + template limit, before decrypting and calling the provider. Over
  the limit → `FAILED rate_limited` (terminal, no attempt), logged `bucket=notif_dest`. Each claim processing counts one hit (retries
  and a §8.5 resend count: they are traffic to the destination).
- **Concurrency:** the kit hit is one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING count` on the primary key. Tested: 50
  simultaneous decisions → exactly the limit allowed; 24 deliveries to one destination across 3 workers → exactly 5 sent.
- **Failure:** fail closed. A limiter error throws before any decryption or call; the claim has no attempt, so its lease expires and
  recovery returns it to `PENDING` (tested: nothing sent, then sent once).
- **Privacy:** the table holds `sha256("notif_dest:" + HMAC)`, never the destination or a plain hash of it (tested against the plain
  SHA-256 of every guessable form and against an HMAC under a different key). Without the dedicated key, a guessed phone number cannot
  be tested against the table. The delivery's destination snapshot (SDD §12.2) is unchanged and is the only place destinations live.
- **Key rotation:** `NOTIFICATION_DESTINATION_LIMIT_PREVIOUS_KEY` (optional, one key). Both buckets are hit and both must allow, so a
  rotation neither resets a destination's count nor opens a burst (tested). Remove the previous key after one window; removing it
  earlier resets counts once (documented).
- **Configuration:** the key is required whenever a provider is selected (the worker runs), read whenever set.

## 3. Request-hash key rotation

The stored `requestHash` stays a 64-hex HMAC (no schema change, no key id). New requests are hashed with
`NOTIFICATION_REQUEST_HASH_KEY`; a replay is compared, in constant time, under the current key and each of
`NOTIFICATION_REQUEST_HASH_PREVIOUS_KEYS` (at most 2). Tested: a request stored under key A replays under B-with-A-previous; a changed
body is `422`; a fresh request is hashed with B; once A is removed, a retry of the A-request is `422 idempotency_key_reused` and no
second intent exists. An "unknown key version" is therefore indistinguishable from a changed request, which fails safe (`422`).
Retirement window: at least the callers' retry window (runbook: 7 days recommended). The configuration is the rotation state, so a
restart preserves it.

## 4. Secret-encryption key lifecycle

The existing ring (`NOTIFICATION_SECRET_KEYS`, active id, key id stored beside each ciphertext) already supports add / activate /
decrypt-old. Secrets are purged at terminal state or `expiresAt`, so an old key empties on its own: **no re-encryption**.
- `secretKeyUsage()` and the operator CLI `npm run secret-keys -w notification-service -- usage | retire-check <keyId>` (runtime role;
  key ids and counts only, over the partial live-secret index). `retire-check` exits 0 only if the key is not active and no live
  ciphertext references it, else 3 (tested, including in the production image).
- The operational snapshot reports a live key id absent from the ring as `notification_secret_key_missing` (error); such codes fail
  `render_failed`, never send (tested).
- Runbook §2: add k2 active → wait until `retire-check k1` exits 0 → remove k1.

## 5. Key material and purpose separation

| Purpose | Variable | Rule |
|---|---|---|
| sealing one-time codes | `NOTIFICATION_SECRET_KEYS` | 32 bytes per key |
| API request-body HMAC | `NOTIFICATION_REQUEST_HASH_KEY` (+ `_PREVIOUS_KEYS`) | ≥ 32 bytes |
| destination-limiter HMAC | `NOTIFICATION_DESTINATION_LIMIT_KEY` (+ `_PREVIOUS_KEY`) | ≥ 32 bytes |
| service authentication | `SERVICE_TOKENS` (digests) | kit |
| Resend / Twilio | `NOTIFICATION_RESEND_API_KEY`, `NOTIFICATION_TWILIO_API_KEY_*` | 16.8 shapes |

Startup refuses any two key-material entries (secret ring, request-hash current and previous, limiter current and previous) that are
equal, naming the two variables, never the value. In **production** it also refuses a key published for development (`.env.example`
values, recognized by SHA-256 fingerprint; no literal in the code) and a patterned key (fewer than 12 distinct byte values in 32
bytes). The service never generates or stores a key.

## 6. Operational signals and the alerting contract

Core has no metrics platform (SDD §16), and Stage 16.9 adds none. Signals are structured log lines:
- per event (existing): `notification_delivery_sent`, `_retry_scheduled`, `_failed` (with `code`, and `bucket` for limits),
  `_unconfirmed`, `_expired`, `_cancelled`, `_resend_after_ambiguity`, `_lease_recovered`, `notification_provider_failure` (class,
  code, `httpStatus`, `providerCode`), `provider_auth_fault` / `provider_config_fault` (error), `notification_secret_purged`, pass
  failures;
- **new:** `notification_ops_snapshot due=… oldestDueAgeSec=… retrying=… scheduled=… sending=… staleLeases=… liveSecrets=…` every
  `NOTIFICATION_OPS_REPORT_INTERVAL_MS` (default 60 s), counts over the partial indexes only; `notification_secret_key_missing`
  (error); `notification_retention_cleaned` (a count).

No signal carries a destination, a code, content, a credential or a high-cardinality id beyond the existing per-event ids. The alert
rules (thresholds are starting points for SRE) are in [runbooks §1](../../runbooks/notification-service.md).

## 7. Circuit breaker: not required for V1

Durable per-delivery backoff already bounds provider traffic: each delivery makes at most `NOTIFICATION_MAX_ATTEMPTS` calls, spaced
by `base × 2ⁿ` (and `Retry-After`), with at most `NOTIFICATION_WORKER_CONCURRENCY` calls in flight per instance, each bounded by the
timeout; a not-yet-due delivery is never claimed. Tested: 10 deliveries against a total outage → exactly 30 calls (10 × 3) across any
number of passes, no call while nothing is due, all `retries_exhausted`. During an outage the provider sees at most (new deliveries +
their retries) calls, which is the load it would see anyway. A breaker would add shared state for no bound it does not already have;
revisit only if a provider penalizes the account for failed calls at that rate.

## 8. Retention (D10)

| Data | Class | Rule |
|---|---|---|
| sealed secrets | secret | purged at terminal state or `expiresAt` (16.7), unchanged |
| `kit_rate_limit` rows (limiter state) | technical | **implemented:** an expired window is deleted by `RetentionWorker` |
| intents (`data`, `recipientId`), deliveries (`destination`), attempts, API idempotency identity | personal / operational | **OWNER / LEGAL (D10):** not deleted; durations are not invented |
| template versions | configuration | kept (they explain past deliveries) |
| code-bearing DLQ messages | secret in transit | SRE runbook (15.7), never purged unseen |

`RetentionWorker`: every `NOTIFICATION_RETENTION_INTERVAL_MS` (60 s), batches of `NOTIFICATION_RETENTION_BATCH_SIZE` (500), at most 20
per pass, only the buckets this service writes, each by its own window (`notif_api_caller` 60 s, `notif_caller_template` 60 s,
`notif_dest` its configured window), `FOR UPDATE SKIP LOCKED`, a MATERIALIZED CTE on the primary key. The tests found that the first
version (`DELETE … WHERE ctid IN (SELECT … LIMIT … SKIP LOCKED)`) could delete more than the batch (the subquery may be re-run); the
secret purge used the same pattern and was changed too. Tested: bounded batches, active windows and foreign buckets kept, idempotent,
a locked row skipped without waiting, a failed pass leaves everything for the next.

## 9. Focused security review

- **API** (send, status, cancel): service token (401 matrix unchanged), per-caller policy (templates, channels, organizations),
  creating-caller reads and cancels only (404 otherwise), `Idempotency-Key` shape, the kit's bounded JSON body, unknown fields refused
  (including `from`, `sender`, `provider`), E.164 / email validation, safe errors; the 16.6 suite is green. Docs stay behind basic auth
  and only when `SWAGGER_PASSWORD` is set; no provider or key setting appears in the OpenAPI.
- **Event intake:** canonical envelope, the static event map, `(sourceService, sourceEventId)` dedupe, poison → DLQ, ack after commit,
  sealed secrets, destination validation (16.5 suite and real-broker package green).
- **Worker:** `SKIP LOCKED`, lease fencing, calls outside transactions, bounded concurrency and timeout, pre-send cancel / expiry,
  ambiguity, late-result refusal, purge, shutdown (16.7 / 16.8 suites green); plus the fail-closed destination limiter.
- **HTTP surface:** the kit `configureApp` (secure headers, bounded body, no CORS by default), unchanged.
- **Logs:** reviewed every new line: counts, key ids, bucket names, codes. Destination hints (last 2 characters) remain API-only.
- **Database role:** the runtime role only needs DML (it deletes limiter rows and reads counts); no new DDL, no migration; tested in
  the production image as `notification_app`.

## 10. Health, readiness and degradation

Unchanged: `/health` = process; `/ready` = database + migrations + RabbitMQ + event intake. A provider outage is not readiness
(tested: Resend unreachable, `/ready` 200 while the delivery is `PENDING provider_unreachable`; in the image, Twilio unreachable →
`/ready` 200). Degradation is visible through the provider and snapshot signals (§6).

## 11. Auth prerequisites (unchanged, not modified here)

- **E.164 (production SMS prerequisite):** Auth accepts `^\+?[0-9]{8,15}$`; Notification keeps strict E.164, so a non-canonical
  Auth number fails `invalid_destination` and no country is ever guessed. The smallest future Auth correction: require canonical
  E.164 for new contacts, and inventory existing non-E.164 contacts for a deliberate, owner-approved migration (never by prepending a
  country code).
- **D19 Auth outbox:** Auth publishes after commit, fire-and-forget with a publisher confirm; an event can be lost if the broker fails
  between the commit and the confirm. ADR-0046 §17 accepts this (a code lost that way is re-requested by the user); the outbox is a
  future Auth change, owned by Auth.

## 12. External and owner items (not resolved here)

- **Provider sandbox smoke:** PENDING — credentials not supplied (no Resend or Twilio request has been made by any stage).
- **Live provider latency:** PENDING. The 10 s timeout / 60 s lease relationship rests on the bounded adapters and is to be revisited
  if live evidence contradicts it.
- **ADR-0047 owner items:** Resend cost at volume, a Tunisia / MENA deliverability pilot, the data-processing agreement: open.

## 13. Production enablement checklist

**Code ready (this repository):**
- [x] migrations (unchanged since 16.4 / 16.5) and the production image
- [x] providers per channel (`resend`, `twilio`), `test` refused in production
- [x] key rings and purpose separation validated at startup; development / patterned keys refused in production
- [x] destination limiter, retention of limiter state, operational snapshot, runbooks

**Production enablement (evidence required, none claimed here):**
- [ ] secrets generated and stored: secret key ring, request-hash key, destination-limiter key, service tokens, Resend key, Twilio API key
- [ ] Resend sending domain verified: SPF, DKIM; DMARC policy decided
- [ ] Resend data-processing agreement reviewed; sending region confirmed; cost at expected volume reviewed
- [ ] Tunisia / MENA deliverability pilot (AR, FR, EN)
- [ ] Twilio account, Messaging Service with senders; alphanumeric sender ID registration where required (Tunisia: domestic entities
      above 30 000 SMS / month); destination countries enabled in Messaging Geo Permissions
- [ ] Auth stores canonical E.164 phone numbers (separate Auth change) before enabling SMS for Auth users
- [ ] sandbox / live smoke per provider performed and recorded
- [ ] log-based alerts from runbooks §1 connected to the platform's alerting
- [ ] `NOTIFICATION_SERVICE_POLICY` and `SERVICE_TOKENS` for each producer

## 14. Evidence

- **Tests:** unit 311 (was 295: +14 configuration, +1 limiter identity, +1 request-hash rotation); Notification E2E 292 (was 275: +17
  in `test/security-operations.e2e-spec.ts`); earlier suites adjusted only where 16.9 changes behaviour (the engine suites raise the
  destination limit because they reuse one destination; the process test's fixture keys are random-looking, since production now
  refuses patterned keys; a 16.7 assertion that no `notif_dest` row exists now asserts none is a plain hash); real-broker package green.
- **Mutations** (each killed, then all seven files, including the rebuilt kit `dist`, restored and verified with `sha256sum -c`):

  | Mutation | Failing tests |
  |---|---|
  | M1 the limiter identity as plain SHA-256 | the identity unit test; the privacy and rotation E2E |
  | M2 the limiter reusing `NOTIFICATION_REQUEST_HASH_KEY` | the privacy and rotation E2E (the configuration refuses equal keys separately) |
  | M3 previous request-hash keys ignored | the rotation E2E |
  | M4 retirement allowed while live | the lifecycle and CLI E2E |
  | M5 the kit hit as check-then-act | the limit, 50-concurrent and 3-worker E2E |
  | M6 the destination logged by the limiter | the leak scan |
  | M7 a provider readiness check | the outage-readiness E2E |
  | M8a retention ignoring the window | the retention E2E |
  | M8b retention without the batch bound | the retention E2E |

- **Query plans** (≈ 205 000 deliveries, 2 000 live secrets, 300 000 limiter rows): limiter hit = an `INSERT … ON CONFLICT` on
  `kit_rate_limit_pkey`, 0.5 ms; retention batch = a limited scan stopping at 500 matches + primary-key deletes, 3.5 ms (the scan is
  sequential but bounded by `LIMIT`; the table holds only live windows and is not a request path); secret-key usage =
  `notification_secret_expiry_idx`, 0.9 ms; the snapshot = index-only scans of the due, lease and secret partial indexes, 26 ms with
  200 000 un-vacuumed dead index entries in the test (autovacuum removes them in production). No new index was needed.
- **Sanity** (local, not capacity): 1.45 ms per limiter decision with a previous key (2 hits); 400 concurrent decisions over 20
  destinations with limit 5 → exactly 100 allowed in 166 ms, pool at 10; retention 500 rows in 8 ms, 200 500 rows in 1.4 s across
  bounded passes; snapshot 4 ms.
- **Production image** (throwaway PostgreSQL + RabbitMQ, migrator / app roles): production refuses the test provider, a provider
  without a limiter key, the published development request-hash key, a patterned limiter key, and a limiter key equal to the
  request-hash key (never echoing a value); a valid production configuration starts (uid 1000, PID 1, `/ready` 200), the retention
  worker deletes 1 200 expired limiter rows as the runtime role, the snapshot line appears, the CLI runs as the runtime role
  (`retire-check` of the active key exits 3), stop exits 0 in 67 ms; in development the limiter rows are HMACs (0 plain-hash matches), a
  down SMS provider leaves `/ready` 200, a stop during a hung call exits 0 in 1.5 s; 0 leaks in logs or `pg_dump`.
- **Leak scan:** codes, destinations, the limiter, request-hash (current, previous) and secret keys, the service token, provider keys,
  database and broker passwords: 0 hits in application logs, the limiter table, the image logs and `pg_dump`; the runbooks and this
  record contain placeholders only.

## 15. Carried over

- **16.10:** the Notification-wide focused certification.
- **Auth:** E.164 contacts (production SMS prerequisite), D19 outbox.
- **Owner / legal:** D10 history retention durations; ADR-0047 cost, MENA pilot, DPA.
- **External:** provider sandbox smoke and live latency (credentials).
- **Platform:** routing the log-based alerts (runbooks §1) into the alerting system; a metrics platform, if Core adopts one.
- **Stage 17:** attachments through File Service.

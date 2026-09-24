# Stage 16.7 — Notification delivery engine

- **Status:** implemented and validated on `feat/notification-delivery-engine` (awaiting review).
- **Scope:** the `ChannelProvider` port and a no-network test provider; the delivery worker (discovery, claim, lease, renewal, bounded
  concurrency, pre-send checks, attempts, provider timeout, outcome mapping, retry and backoff, the SDD §8.5 ambiguity policy, stale-lease
  recovery from durable evidence); rendering of the **pinned** template version; the secret purge (SDD §12.1); the startup relationships
  (SDD §8.2); shutdown drain.
- **Not in scope:** real email or SMS providers, credentials or SDKs (16.8); push, preferences, File Service, Auth changes, commercial
  changes; destination-keyed rate limiting (D21, §13 below).
- **Design sources:** [SDD](../../sdd/notification-service.md) §5, §6.3, §8, §9.3, §11.3, §12.1, §13, §16; [roadmap](./stage-16-1-decisions-and-roadmap.md).

## 1. Architecture

```text
DeliveryModule (src/delivery/)
 ├── DeliveryWorker     PollLoop, runs only when NOTIFICATION_DELIVERY_PROVIDER names a provider
 │     pass = recoverStale → claim → process (≤ concurrency in flight, queued claims renewed every lease / 4)
 ├── SecretPurgeWorker  PollLoop, always runs (codes never outlive expiresAt at rest)
 ├── ChannelProvider    the port (provider.ts); ProviderRegistry = one provider per channel
 ├── TestProvider       no network, scenario chosen by the destination; refused in production (configuration)
 ├── render()           {{name}} interpolation of the pinned version (renderer.ts)
 └── retryDelayMs()     base × 2ⁿ⁻¹ ± 20 %, ceiling, Retry-After (backoff.ts)
```

The worker depends only on the port. A provider result is one of `accepted`, `rejected` (`retryable` | `terminal`, bounded code,
optional `retryAfterMs`) or `ambiguous`. Anything else (a thrown error, a rejection, a timeout, a result outside the contract) is
**ambiguous** (`provider_error`, `provider_timeout`, `provider_invalid_result`). Codes are bounded to `^[a-z][a-z0-9_]{0,63}$`: an
unbounded provider code becomes `provider_rejected` / `provider_ambiguous`, never provider text.

## 2. One pass

1. **Recover** expired leases (`status = 'SENDING' AND leaseUntil < now()`, `FOR UPDATE SKIP LOCKED`, ordered by intent so two
   recovering instances cannot deadlock on the intent locks), deciding from the evidence (§5).
2. **Claim** (one statement, committed): the frozen due selection
   `WHERE status = 'PENDING' AND "nextAttemptAt" <= now() [AND channel = ANY(<channels with a provider>)] ORDER BY "nextAttemptAt", id
   LIMIT $batch FOR UPDATE SKIP LOCKED`, then `status = 'SENDING', nextAttemptAt = NULL, leaseUntil = date_trunc('ms', now() + lease)`.
3. **Process** each claim, at most `NOTIFICATION_WORKER_CONCURRENCY` at once:
   1. read the context (delivery, intent, **pinned** version);
   2. **pre-send checks** (read after the claim): `cancelledAt` set → `SENDING → PENDING → CANCELLED` in one transaction, no attempt;
      `expiresAt` passed → `SENDING → EXPIRED`, no attempt;
   3. the `notif_caller_template` limit (source + template, per minute) → over it: `FAILED rate_limited`, no attempt;
   4. decrypt the sealed secret (AES-256-GCM, AAD bound to the intent) and render the pinned version; a render error or a ciphertext that
      does not open → `FAILED render_failed` / `content_too_long`, no attempt;
   5. **attempt `STARTED`, committed** (with `attempts = attempts + 1`, the attempt number, and a fresh lease for this call);
   6. the provider call **outside any transaction**, bounded by `NOTIFICATION_PROVIDER_TIMEOUT_MS`;
   7. **one transaction**: the attempt outcome (`WHERE outcome = 'STARTED'`) and the delivery transition (`WHERE status = 'SENDING' AND
      leaseUntil = <token>`), plus the secret purge when this was the intent's last live delivery.

No transaction is open while a provider call runs (tested: `pg_stat_activity` shows no `idle in transaction` session during calls).

## 3. Outcomes

| Provider result | Attempt | Delivery |
|---|---|---|
| accepted | `ACCEPTED`, `providerMessageId` | `SENT` (`sentAt`, `providerMessageId`). SENT means the provider accepted it, not that anyone received or read it |
| rejected, retryable | `RETRYABLE_FAILURE`, code | `PENDING`, `nextAttemptAt = now + backoff`; `FAILED retries_exhausted` at `NOTIFICATION_MAX_ATTEMPTS`; `EXPIRED` if the next attempt would fall at or after `expiresAt` |
| rejected, terminal | `TERMINAL_FAILURE`, code | `FAILED` (`failureClass = terminal`) |
| `provider_auth_fault` (an adapter's 401/403) | `RETRYABLE_FAILURE` | as retryable, plus an `error` log `provider_auth_fault` |
| ambiguous (incl. timeout, throw, rejection, invalid result, worker lost) | `AMBIGUOUS` | SDD §8.5 (§4) |

**Retry / backoff:** `min(ceiling, max(base × 2^(attempt−1) × U(0.8, 1.2), Retry-After))`. The due time is stored in `nextAttemptAt`:
no sleeping in the worker, no hot spin, and a restart keeps the schedule and the attempt count. Defaults: base 30 s, ceiling 30 min,
5 attempts (bounded configuration, §9); `expiresAt` always wins.

## 4. Ambiguity (SDD §8.5, frozen)

An `AMBIGUOUS` attempt means the provider **may** have accepted the message. The delivery goes back to `PENDING` (due now,
`ambiguousResends = 1`) only if the intent carries a sealed secret (a one-time code) **and** `ambiguousResends = 0` **and**
`now < expiresAt`. The resend renders the same pinned version with the same code and the same provider reference (the delivery id).
Anything else ends `UNCONFIRMED` (terminal) and is never resent: security alerts and general notices are never duplicated on a guess.
Worst case for a code: two messages with the same code.

## 5. Lease, crash windows and recovery

**Lease owner and token.** The schema has no owner column. A claim's ownership token is the exact `leaseUntil` it wrote (truncated to
milliseconds so it round-trips through the driver). Every post-claim write is conditional on `status = 'SENDING' AND leaseUntil = token`,
and the attempt completion on `outcome = 'STARTED'`. A worker whose lease was recovered can therefore never apply a late result (tested:
the old worker's `accepted` arrives after recovery → refused, `lease_lost`; the recorded `AMBIGUOUS worker_lost` stands).

**Timing.** `lease ≥ 2 × provider timeout` (startup check). The lease is refreshed when the attempt starts, so a call (≤ timeout) always
ends inside its lease: a live call is never recovered by another worker. Claims waiting in the batch are renewed every lease / 4 (tested:
5 sequential 1.5 s calls against a 5 s lease; a rival recovering every 250 ms took nothing).

**Recovery by evidence** (the attempt row is committed BEFORE every provider call, so its absence proves no call was made):

| Window | Durable state left | Recovery | Duplicate external send possible? |
|---|---|---|---|
| A: claimed, crash before the attempt | `SENDING`, no attempt | `PENDING`, due now → sent once | no |
| B: attempt `STARTED`, crash before the call | `SENDING`, attempt `STARTED` | attempt `AMBIGUOUS worker_lost` → §8.5 (code: one resend; alert: `UNCONFIRMED`) | code only (none was actually sent) |
| C: no call made, process dies (e.g. database lost before the attempt) | `SENDING`, no attempt | as A | no |
| D: provider accepted, crash before the outcome | `SENDING`, attempt `STARTED` | as B | a code: yes, once (the documented worst case); an alert: no (`UNCONFIRMED`) |
| E: attempt outcome written, crash before the delivery transition | impossible: one transaction; a failure between them rolls both back (tested) → state of D | as D | as D |
| F: delivery terminal, worker crashes | terminal | nothing: terminal rows are never claimed or recovered (tested with 3 workers × 5 passes: 0 new attempts) | no |

B cannot be distinguished from D, so it is treated as D (SDD §13: "we cannot prove the call was not made"). This is the frozen,
safe direction; no optimistic retry exists.

## 6. Cancellation and expiry

- **Cancel race (SDD §9.3):** a `PENDING` row is cancelled by the API and never claimed. A claimed row keeps `SENDING`; the API returns
  `409 delivery_in_progress` and sets `cancelledAt`; the worker's pre-send check reads it and ends the delivery `CANCELLED` via
  `SENDING → PENDING → CANCELLED` (both legal transitions, one transaction), with no attempt and no provider call.
- **Expiry:** checked after the claim (already expired, or expired between claim and send: `EXPIRED`, 0 calls), when scheduling a retry
  (a retry that would fall at or after `expiresAt` ends `EXPIRED` at once) and again when that retry becomes due. A code is never sent
  after `expiresAt`. `scheduledAt` is honoured by the due selection.

## 7. Secrets, rendering, template pinning

- **Decryption** happens in the worker right before rendering; the plaintext lives only in the rendered message object until the
  provider call returns. It is never written to a column, an attempt, a log, an error or a test snapshot (leak scan, §11).
- **Rendering** uses the delivery's `templateVersionId` (pinned at intake), never the latest version (tested: v1 pinned, v2 published,
  the old delivery renders v1 and a new one v2). `{{name}}` only; HTML-escaped in `bodyHtml`; no CR/LF in a subject; `url` must be
  https; datetimes per locale in `NOTIFICATION_TIME_ZONE`; an SMS over `smsMaxSegments` is `content_too_long`. Persisted data that is
  unexpectedly corrupt fails as `FAILED render_failed`, and the error carries a code only, never a value.
- **Purge (SDD §12.1):** `secretCiphertext` and `secretKeyId` become NULL in the transaction that makes the intent's last live delivery
  terminal (SENT, FAILED, UNCONFIRMED, EXPIRED, CANCELLED by the worker). The intent row is locked first so two deliveries finishing at
  once serialize (found by the leak scan and fixed; a test repeats the race 5 times). The `SecretPurge` loop catches the rest: intents
  past `expiresAt` (even while a delivery is still `PENDING`, which then ends `EXPIRED`), API cancels, and any crash between the two. A
  retry or a §8.5 resend always finds its secret: nothing is purged while a delivery is live and before `expiresAt`. `data`,
  `requestHash`, deliveries and attempts remain.

## 8. The 16.5 invalid-destination representation (review)

The event intake records an invalid destination as `PENDING → SENDING → FAILED invalid_destination` inside the intake transaction.
**Conclusion: harmless, kept.**
- The transient `SENDING` never commits: no other transaction, worker, recovery or status read can observe it.
- It creates no attempt (`attempts = 0`, `provider` NULL), so attempt history and the recovery evidence are unaffected.
- It emits no claim or send log, only `notification_delivery_failed … failureCode=invalid_destination`.
- The final row is exactly a worker-failed row with a distinct code, which is the operational meaning wanted.

No state-machine change is needed.

## 9. Configuration (validated at startup, bounded)

| Variable | Default | Bounds | Relationship |
|---|---|---|---|
| `NOTIFICATION_DELIVERY_PROVIDER` | `none` | `none`, `test` | `test` refused in production |
| `NOTIFICATION_WORKER_INTERVAL_MS` | 1000 | 100–60000 | |
| `NOTIFICATION_WORKER_BATCH_SIZE` | 20 | 1–500 | |
| `NOTIFICATION_WORKER_CONCURRENCY` | 4 | 1–50 | `< DB_POOL_MAX` |
| `NOTIFICATION_LEASE_MS` | 60000 | 5000–3600000 | `≥ 2 × provider timeout` |
| `NOTIFICATION_PROVIDER_TIMEOUT_MS` | 10000 | 100–30000 | `< 60 s stop grace − HTTP_DRAIN_TIMEOUT_MS`; worker drain = timeout + 2 s |
| `NOTIFICATION_RETRY_BASE_MS` / `_CEILING_MS` | 30000 / 1800000 | 1000–3600000 / ≥ base, ≤ 86400000 | |
| `NOTIFICATION_MAX_ATTEMPTS` | 5 | 1–20 | |
| `NOTIFICATION_TIME_ZONE` | `UTC` | IANA | |
| `NOTIFICATION_RATE_CALLER_TEMPLATE_PER_MINUTE` | 6000 | 1–1000000 | set above producers' own throttles |

These are engineering defaults for a test provider. The SDD asks for the provider timeout and lease "from measurement": they are
re-measured against the real adapters in 16.8. The HTTP drain bound becomes `< 50 s` with the default provider timeout (it was 120 s).

## 10. Shutdown, readiness, observability

- **Shutdown:** at `onModuleDestroy` the worker stops claiming; queued claims are released to `PENDING` at once (no attempt, so no call
  was made); the in-flight provider calls finish (bounded by the provider timeout) and their outcomes are persisted in
  `beforeApplicationShutdown`, before the kit closes the pool. Tested: idle close < 1.5 s; a 600 ms call finishes and is `SENT`,
  3 queued claims released; a hanging call is cut at the timeout and recorded `AMBIGUOUS`. Production image: `docker stop` during a
  hanging call → 469 ms, exit 0, delivery `UNCONFIRMED provider_timeout`.
- **Readiness unchanged** (D12): database + migrations + rabbitmq + event-intake. The worker and the providers are not readiness
  dependencies; a provider outage must not take the API and intake out of rotation.
- **Logs** (ids, channel, template key, attempt number, provider id, class, code, latency; never a destination, data, a code, rendered
  content, a ciphertext or provider text): `notification_delivery_claimed`, `_sent`, `_retry_scheduled`, `_failed`, `_unconfirmed`,
  `_expired`, `_cancelled`, `_resend_after_ambiguity`, `_lease_recovered` (with the evidence), `_released`,
  `notification_provider_failure`, `provider_auth_fault`, `notification_secret_purged` (a count), `notification_worker_pass_failure`,
  `notification_secret_purge_pass_failure`, `worker_drain_timeout`. Failures are described by `describeFailure` (class and code, never
  the message).
- **Metrics:** Core has no metrics platform; none is added. Signals for 16.9: due backlog per channel (query in the README), claimed /
  sent / retried / failed / unconfirmed / expired / cancelled counts, attempt latency, lease recoveries, purge counts (all present as
  structured log lines).

## 11. Evidence

**Tests:** unit 218 (was 194: +14 configuration, +10 renderer / backoff / test provider / codes). Notification E2E 263 (was 205: +58
in `test/delivery-engine.e2e-spec.ts` on a real PostgreSQL, fake providers, loops driven explicitly). Real-broker package 13/13.

**Campaigns:**

| Campaign | Result |
|---|---|
| C1 three workers, 60 deliveries | 60 calls, 60 distinct references, 60 attempts, every delivery `attempts = 1` |
| C2 claim then API cancel | 409, then `CANCELLED`, 0 calls, 0 attempts, secret purged |
| C3 expiry between claim and send | `EXPIRED`, 0 calls |
| C4 a retry due while 3 workers poll (6 concurrent passes) | exactly one new attempt (numbers 1, 2) |
| C5 stale lease | windows A–D recovered from the evidence (table §5) |
| C6 terminal rows, 3 workers × 5 passes | 0 new attempts, 0 calls |
| SKIP LOCKED | a claim with a due row locked elsewhere returns in < 1 s with the other row |
| bounded concurrency | 12 slow calls, concurrency 3 → max in flight 3 |
| fairness | FIFO by due time across channels: SMS created between two EMAIL batches are all sent before the later batch |
| failure isolation | an EMAIL provider throwing on every call; the SMS deliveries of the same pass are `SENT` |
| real database outage (loop running) | passes fail and log `notification_worker_pass_failure`; after reconnection the loop delivers |

**Failure injection:**

| Injection | Delivery | Attempt | Lease | Retry | Duplicate send possible | Recovery |
|---|---|---|---|---|---|---|
| provider throws (sync) / rejects (async) | `UNCONFIRMED` (alert) / resend once (code) | `AMBIGUOUS provider_error` | cleared | §8.5 | code: once | none needed |
| timeout (hang) | as above, `provider_timeout` | `AMBIGUOUS` | cleared | §8.5 | code: once | none needed |
| ambiguous after possible acceptance | as above | `AMBIGUOUS` | cleared | §8.5 | code: once | none needed |
| DB failure before the attempt (claim, `startAttempt`) | `SENDING` | none | expires | yes, as A | no | next pass after the lease |
| DB failure after `STARTED` / after the provider result | `SENDING` | `STARTED` | expires | §8.5 | code: once | `AMBIGUOUS worker_lost` |
| crash after acceptance / before finalization | `SENDING` | `STARTED` | expires | §8.5 | code: once | as above |
| shutdown during a call | outcome persisted | final | cleared | per outcome | no | none |

**Mutations** (each killed, then restored; `sha256sum -c` confirmed both files byte-identical):

| Mutation | Tests failing |
|---|---|
| M1 `SKIP LOCKED` removed from the claim | the SKIP LOCKED test (the claim blocks on the locked row until the statement timeout) |
| M2 pre-send cancel check removed | C2 |
| M3 pre-send expiry check removed | 4 (already expired, C3, expiry during retry, purge past expiry) |
| M4 AMBIGUOUS classified as RETRYABLE | 11 (ambiguity, timeout, provider errors, isolation, purge after UNCONFIRMED, shutdown hang, leak scan) |
| M5 provider timeout removed | 2 (hanging provider: 60 s test timeout; shutdown during a hang) |
| M6 attempt persisted after the provider call | 4 (accepted evidence, window C, late result refused, stale token) |
| M7 purge disabled (in-transaction and loop) | 16 (every purge assertion and the leak scan) |
| (extra) intent lock removed from the purge check | the concurrent-finish purge test (round 1) |

**Leak scan:** sentinel code, email, phone, rendered SMS and email bodies, ciphertext (hex and base64), secret key, request-hash key,
service token and a provider-supplied text containing the phone and the code. Application logs: 0 hits. Every table dumped as JSON:
no code, rendered content, ciphertext, key or token anywhere; destinations only in `notification_delivery.destination`. Status API: no
code or destination. Production-image logs: 0 hits for the code, destinations, token, database and broker passwords and both keys.

**Query plans (EXPLAIN ANALYZE, 204 900 deliveries: 200 000 SENT, 1 000 CANCELLED, 3 600 PENDING of which 2 600 due):**
- claim: `Index Scan using notification_delivery_due_idx` (`nextAttemptAt <= now()`), incremental sort on the id tie-break, LockRows,
  Limit 20: 18 ms cold;
- recovery: `Index Scan using notification_delivery_lease_idx`: 17 ms cold;
- purge: `Index Scan using notification_secret_expiry_idx` with the per-intent `notification_delivery_channel_unique` probe: 0.09 ms.
No full scan; no new index needed.

**Performance sanity** (local, not a capacity figure): 3 workers × concurrency 4, batch 50, a 5 ms fake provider, the backlog above
plus 300 retry-due and 300 expired: 2 300 provider calls in 2.76 s; 0 deliveries with more than one attempt; 300 `EXPIRED` with 0
calls; the 1 000 future deliveries untouched; max 12 provider calls in flight in total (3 × 4) and 4 per worker; peak 12 database
connections across the 3 processes (pool 10 each); short `idle in transaction` gaps between statements only (none during provider
calls, tested).

**Production image** (throwaway PostgreSQL with the init roles + throwaway RabbitMQ, migrated by `notification_migrator`, run as
`notification_app`, `NODE_ENV=development`, the test provider): uid 1000 (`node`), PID 1 `node dist/main.js`, `/ready` 200; accepted
EMAIL + SMS `SENT`; a code `SENT` and its secret purged; `+retry` → `FAILED retries_exhausted` after 2 attempts; a scheduled intent
cancelled → `CANCELLED`, 0 attempts; `+429` with a 2 s expiry → `EXPIRED`; `+ambiguous` alert → `UNCONFIRMED`; no open lease; stop
during a hanging call 469 ms, exit 0. `NODE_ENV=production` with the test provider: exit 1 with the refusal message.

## 12. Guarantees and non-guarantees

- **Internal processing:** a due delivery is claimed by one worker at a time (`SKIP LOCKED` + the lease token); at most one attempt is
  `STARTED` per claim; every outcome is recorded once (`outcome = 'STARTED'` guard); a terminal delivery is never processed again;
  a cancelled or expired delivery is never sent after the pre-send check; attempts are history, never overwritten.
- **External side effect:** **at-least-once attempt, best-effort deduplication, never claimed exactly once.** A provider may accept a
  message whose answer is lost. For a one-time code this yields at most one extra message with the same code (§8.5); for anything else
  the delivery is `UNCONFIRMED`, which may hide a message that was in fact delivered or one that was not. The delivery id is passed as
  the provider reference for providers that deduplicate on it (16.8).
- A cancel cannot recall a call already in flight (`409 delivery_in_progress`).

## 13. Deviations from the SDD wording, and D21

- **`attempts` increments when the attempt is inserted**, not at the claim (SDD §8.1 step 1): the counter then equals the provider calls
  started, the `maxAttempts` budget is never consumed by a claim that made no call (window A, a pre-send cancel), and it serves as the
  attempt number under the claim's row lock.
- **Render before the attempt insert** (SDD §8.1 lists "insert the attempt, commit, render"): a render failure is terminal and makes no
  call, so it records no attempt (attempts represent provider executions).
- **Pre-send cancel path** `SENDING → PENDING → CANCELLED` in one transaction: the frozen matrix has no `SENDING → CANCELLED`; both steps
  are legal and nothing observes the intermediate state.
- **The claim takes only the channels that have a provider** (the frozen claim has no channel filter): with no provider for a channel,
  its deliveries stay `PENDING` instead of being claimed and failed.
- **Late-result guard:** the lease token plus `outcome = 'STARTED'` (SDD §13 names "a conditional update on attempts and status"): the
  same protection, expressed with the columns the schema has.
- **`notif_dest` (destination + channel limit, SDD §11.3 / D13) is NOT implemented.** Only `notif_caller_template` is. The kit key is an
  unpeppered SHA-256 of `bucket:identifier`; a phone-number key is enumerable (D21), and the 16.3–16.5 records require D21 resolved
  before any destination limit. The owner's 16.7 instruction was not to introduce destination-keyed limiting. **Owner decision needed
  (16.9 or earlier):** (a) a peppered/keyed kit identifier (the D21 kit follow-up), then `notif_dest`; (b) accept the SDD residual and
  add `notif_dest` on the unpeppered key; (c) drop `notif_dest` and rely on the producers' throttles (Auth's code throttles are the
  primary control today). Tests assert no `notif_dest` key and no destination-derived rate-limit key exists.

## 14. Carried over

- **D19 Auth outbox:** deferred.
- **Auth E.164 normalization:** before production SMS.
- **D21 destination rate-limit privacy:** open, and `notif_dest` deferred with it (§13).
- **D2 / D3 real provider decisions:** before 16.8; the provider timeout and lease re-measured with the real adapters.
- **D10 broad retention:** open (only the secret purge is implemented).
- **Provider-specific error sanitization:** 16.8 / 16.9 (the engine already records bounded codes only and logs no error message).
- **Attachments:** Stage 17.
- **Request-hash key rotation / versioning:** 16.9.
- **Secret key retirement:** a ciphertext whose key was removed from the ring fails as `render_failed` (tested with a tampered
  ciphertext); the rotation runbook (retire a key only after `expiresAt` of every row sealed with it) belongs to 16.9.

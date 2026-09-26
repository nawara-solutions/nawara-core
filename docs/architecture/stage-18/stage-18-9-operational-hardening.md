# Stage 18.9 — Operational hardening

- **Status:** implemented and validated on `feat/audit-operational-hardening` (awaiting review; not committed).
- **Question:** can Audit operate safely and predictably under production-like failure, load, restart and recovery?
- **Scope:** the three findings 18.8 deferred (O1 dead-letter confirm failure, O2 retention at scale, O3 dead-letter / redaction
  counters), a failure matrix over the whole service, fixes where behavior was wrong or unproven, and targeted mutation testing.
- **Not in scope (and not present):** new catalog actions, producer or authorization changes, retention durations (P-A2), erasure
  (P-A3), Auth IP retention (P-A5), broker identity (P-A1), the Stage 18.10 certification, Stage 19+, Final Core Validation. No ADR changed.

## 1. Baseline

`main` at `4beb81b` (the Stage 18.8 merge, PR #122); working tree clean except the untracked `docs/reports/` (untouched). Environment of
every measurement below: one Linux host, 12 logical CPUs, 11 GiB RAM, PostgreSQL 16 and RabbitMQ 3.13.7 (management variant) in Docker,
the service in-process (Vitest). Numbers identify cliffs; they are not capacity claims.

## 2. Failure matrix

"Proof" names the test; **new** = added in 18.9.

| Condition | Expected | Behavior found | Proof | Change |
|---|---|---|---|---|
| Audit PostgreSQL unavailable (ingestion) | nothing acked or written; kit retry; stored once on recovery | as expected | 18.5 `DATABASE OUTAGE`, `RETRY EXHAUSTION then REPLAY` | — |
| PostgreSQL slow | at most `prefetch` in flight; the rest wait in the broker | as expected | 18.5 `BACKPRESSURE` | — |
| PostgreSQL unavailable (query) | fail closed (5xx), never an empty 200; recovers | as expected, not proven | **new** operational `QUERY while PostgreSQL refuses connections` | — |
| RabbitMQ unavailable at start / lost at runtime | process up, `/ready` 503, reconnect, resume | as expected | 18.5 `BROKER DOWN AT STARTUP`, `BROKER LOST AT RUNTIME`; 18.7 Payment pipeline (relay through a cut proxy) | — |
| Publish confirm delayed / lost (relay) | row stays unpublished, retried | as expected | kit `rabbitmq-silent-broker`, 18.7 pipeline | — |
| Crash before ACK, before insert | redelivered, stored once | as expected | 18.5 `CRASH BEFORE INSERT` | — |
| Crash after insert, before ACK | redelivered → duplicate → ACK, one record | as expected | 18.5 `CRASH AFTER COMMIT, BEFORE ACK` | — |
| Duplicate / conflicting event id | ACK once / conflict DLQ, stored record untouched | as expected | 18.5 duplicates / conflicts, 18.7 closure | — |
| Retry queue / DLQ unavailable (deleted) | re-declared before each dead-lettering | as expected | kit `DLQ was deleted while the consumer was running` | — |
| **Sanitized DLQ copy refused by the broker (O1)** | raw original never dead-lettered; requeued; bounded; recovers | **tight requeue loop**: RabbitMQ redelivers a requeued message at once, so a refusing DLQ spun the delivery as fast as the round trip | **new** kit + audit real-broker tests (queue policy `reject-publish`) | **fixed** (§3) |
| Retention DB unavailable / killed mid-batch | committed batches deleted AND ledgered; rerun finishes | as expected, only an injected SQL failure proven | **new** SIGKILL of the built CLI; **new** connection terminated mid-run | — |
| SIGTERM during ingestion / DB wait / retry | consumer cancelled first, in-flight bounded (5 s), no false ACK | as expected | 18.5 `SHUTDOWN with a delivery stuck`, `cancelled at shutdown START`; process tests | — |
| SIGTERM during a DLQ-confirm hold | bounded; message kept | new path | **new** (§3) | — |
| SIGTERM during query | request completes, bounded drain | as expected | 18.2 foundation drain tests | — |
| SIGTERM during limiter purge | PollLoop stops at shutdown start, bounded | as expected | kit PollLoop tests; janitor uses it | — |
| SIGTERM to the retention CLI | no handler by design: Node exits; PostgreSQL rolls the open batch back | as expected | **new** SIGKILL test (same database outcome, harsher) | — |
| Restart with backlog / large backlog | drained once each, no DLQ, bounded memory | proven at small scale | 18.5 `SERVICE RESTART`; **new** 3 000-event backlog | — |
| Malformed / refused flood | every message dead-lettered and counted; consumer continues | as expected, but **one log line per message** from the kit and from ingestion (unbounded log volume) | **new** flood test | **fixed** (§5) |
| DB outage with a backlog | retries | as expected, but one `audit_ingest_transient_failure` warning per attempt | 18.5 | **fixed** (§5) |
| Rate limiter under concurrency | active windows kept, bounded purge | as expected | 18.8 janitor suite | — |
| Large table (query, retention, insert) | index-bounded | measured in 18.6 (500 000 rows) and 18.8 (620 000) | cited | — |
| Self-audit of a platform read fails | 503, no evidence returned, nothing written | as expected | 18.6 `FAIL CLOSED` | — |

## 3. O1 — the sanitized dead-letter copy cannot be confirmed

18.8 made a policy-protected consumer requeue the original when its sanitized copy is not confirmed, instead of letting the broker
dead-letter the raw message. Fault injection with the broker itself refusing the copy (a queue policy `max-length: 0` +
`overflow: reject-publish` on the DLQ, set through RabbitMQ's management API) showed the requeue redelivered at once — a hot loop for as
long as the fault lasted.

**Fix (kit, opt-in path only):** before the requeue the delivery is **held** (unacknowledged, occupying one prefetch slot) for the
subscription's existing retry delay (`retry.delayMs`, default 5 s — no new tuning value). At most `prefetch` deferrals per delay,
whatever the fault's duration. A stopping consumer aborts the hold (an `AbortController` per consumer), so shutdown stays bounded; the
unacknowledged message then returns to the queue for the next instance. Consumers without a dead-letter policy never reach this path.

**Proven on real RabbitMQ:** raw original never in the DLQ, never acknowledged, still owned by the work queue (ready or unacked);
9 deferrals in 4 s with a 400 ms hold (a tight loop would be hundreds); shutdown during the fault 51–69 ms; the message still queued
after shutdown; a new instance with the DLQ accepting again → exactly one **redacted** copy, the original acknowledged, the secret marker
absent from the DLQ body, headers and every log line. Kit test: 500 ms holds bounded, and a 4 s hold cut short by `close()` (< 1 s).

## 4. Crash windows, outages, backlog, retention at scale

- **Crash windows (A, B, C):** proven by 18.5 (after-commit crash → duplicate → one row; insert failure not acknowledged; DB outage →
  retry → stored). Re-run green.
- **Backlog:** 3 000 events published while Audit was down, drained after start in 1.47–1.60 s (≈ 1 900–2 000 events/s), 3 000 rows,
  0 dead letters; the queue emptied steadily (e.g. 2 939 → 1 928 → 869 at 0.2 / 0.7 / 1.2 s). Heap growth −8.8 to +35.7 MB across runs
  (GC not forced; noisy). In-flight work is bounded by `prefetch` (5): the backlog stays in the broker, not in memory.
- **Retention (O2):** the built CLI killed with SIGKILL after ≥ 1 500 of 60 000 rows, and a run whose database connection was terminated:
  in both, deleted rows = the ledger's sum (no deletion without its ledger row, no ledger row without its deletion), the 500 rows
  inside the horizon untouched, a rerun finishing exactly. A purge of 30 000 rows alongside live ingestion (300 events) and queries (10):
  every event stored, every query 200, the purge complete. Plan behavior at 320 000 / 620 000 rows: 18.8 (cited).

## 5. Observability (O3) and log volume

`BrokerNotices` (audit-service) counts every kit bus notice by its stable event name — a closed set: `retry_scheduled`,
`retry_exhausted`, `dead_lettered` (and by class `_malformed`, `_permanent`, `_retries_exhausted`), `dead_letter_retained`,
`dead_letter_redacted` (the non-replayable kind), `dead_letter_deferred`, `consumer_lost` / `_recovered` / `_reconnect_failed` /
`_drain_timeout`, `channel_error`, `confirm_timeout`, `settle_failed`, `connection_abandoned` — and reports them in the existing
`audit_ops_snapshot` line (every 60 s and at shutdown). No id, source, organization or reason value becomes a label.

**Log budget:** each notice name, each ingestion refusal reason and the transient-failure warning are written at most 20 times per
snapshot interval; every occurrence is still counted, and the snapshot reports `logs_suppressed=n`. Measured: a 300-message flood wrote
≤ 20 `event_dead_lettered` lines and ≤ 20 per refusal reason, 410 lines suppressed, the counters exact. Retention reports through its CLI
output (JSON counts); the limiter purge logs `audit_limiter_purged rows=n` (at most one line per 60 s pass).

## 6. Readiness, shutdown, resources, query, broker trust

- **Readiness:** `/ready` requires `database`, `migrations`, `rabbitmq`, `audit-ingestion`; the limiter purge and retention are not
  readiness dependencies (no flapping from optional work). Transitions proven in 18.2 / 18.5 and here (query path, DB loss and return).
- **Shutdown:** HTTP drain, consumer cancel-then-drain (5 s), relay / PollLoop stops, bus close, pool last (Stage 15.5 order), now also
  bounded during a DLQ-confirm hold.
- **Resources:** in-flight deliveries ≤ prefetch; retries live in the broker; query pages ≤ 100; limiter and retention batches bounded;
  counter and log-budget keys from closed sets. No unbounded in-process structure found.
- **Query:** statement timeout, 5xx on DB loss, page and window bounds, keyset pagination, isolation and `no-store`: unchanged (18.6 / 18.8).
- **Self-audit:** a platform read whose `platform_query.executed` cannot be written returns 503 and no evidence (18.6, re-run green).
- **Broker trust:** `sourceService` is the envelope's claimed source, checked against the catalog, **not** proven by broker credentials.
  Per-service broker identity (P-A1) remains a production prerequisite.

## 7. Targeted mutations (critical invariants)

| # | Mutation | Result |
|---|---|---|
| X1 | the hold before requeue removed (tight loop) | killed (kit + audit) |
| X2 | requeue replaced by the broker dead-lettering the raw original | killed (kit + audit) |
| X3 | a stopping consumer no longer ends the hold | first **survived** (the kit test's 500 ms hold vs a 450 ms bound was too tight a margin); test strengthened (4 s hold) → killed |
| X4 | ACK before the durable insert | killed |
| X5 | duplicate handling disabled | killed |
| X6 | the trigger admits a delete inside the horizon | first **survived**: the 18.8 tests deleted by `"eventId"`, a column the retention role cannot read, so PostgreSQL refused on privilege before the trigger ran. Tests now delete by `id` and require the trigger's message, plus a positive control → killed |
| X7 | redacted dead letters no longer counted | killed |

Every target file restored and hash-verified; every `dist` rebuilt from the restored sources.

## 8. Changes

- `@nawara/service-kit`: the deferral hold (opt-in path only; §3).
- audit-service: `BrokerNotices` and `LogBudget`; the snapshot's broker counters and `logs_suppressed`; budgeted refusal and
  transient-failure lines.
- Tests: `test/operational.e2e-spec.ts` (7), a kit real-broker test, `test/support/broker-mgmt.ts`; 18.8 retention assertions now
  exercise the trigger.
- CI: the integration job's broker is `rabbitmq:3.13-management-alpine` (same version) with `TEST_RABBITMQ_MGMT_URL` (fault injection).

## 9. Production prerequisites (unchanged, still open)

P-A1 per-service broker identity · P-A2 retention durations (the policy ships empty) · P-A3 erasure policy · P-A4 alert routing (the
snapshot now carries the signals to route) · P-A5 Auth local-audit IP retention (a decision, 18.8 §7) · P-A6 RabbitMQ in production ·
P-A7 audit database backup / restore preserving append-only guarantees · DLQ access control on the broker · `AUDIT_RETENTION_PASSWORD`
and a scheduler for `npm run retention` once durations exist.

## 10. Left for 18.10

The focused Stage 18 certification: the complete matrix across 18.1–18.9, a clean re-run of every Audit suite, the image, and the
closure record. Candidate items it should re-check: the management-statistics wait in the O1 test (one unexplained failure in one
full-suite run, never reproduced in 10 later runs; hypothesis: sampled broker statistics lagging).

# Core validation (Stage 15): method, baseline and campaign plan

- **Status:** Stage 15.1 (strategy and baseline). Written 2026-09-23 against `main` at `5e72510` (Stage 14 closed, PRs #78–#84).
- **Purpose:** Stage 14 built and hardened runtime mechanisms. Stage 15 tries to break them under controlled, reproducible conditions
  and measures what happens. This document is the controlling plan: every later Stage 15 sub-stage adds its results to section 13,
  and no production setting is changed without an experiment recorded here.
- **Related:** [production-readiness.md](./production-readiness.md) (status, Stage 14 findings and limits),
  [service-kit README](../../libs/service-kit/README.md#operational-signals-stage-147) (log signals and CLIs).

**Method.** Hypothesis → controlled experiment → measurement → comparison with the stated criterion → PASS / FAIL / INCONCLUSIVE /
NEEDS PRODUCT/SRE DECISION → only then fix, tune or defer. "No crash" is not a pass; "looks fast" is not a measurement.

**What local results mean.** Stage 15 runs on the test environment of section 4. Its numbers characterise **that environment**; they
are not production capacity. Correctness results (an invariant held or broke) transfer; absolute throughput and latency do not.

## 1. System under test

Only **auth-service** is deployed to production (automatic deploy on every push to `main` that touches it; last deployed image built
from `d385299`). Billing, Organization and Payment images are built and smoke-tested in CI, not deployed. RabbitMQ is not deployed to
production. So the outbox, consumer and worker mechanisms are validated **ahead of** their first deployment; Auth's database behaviour
is the part with direct production relevance today.

```text
                               HTTP clients (apps, operators, payment providers)
                                              │
     ┌────────────────────┬──────────────────┼─────────────────────┬──────────────────────────┐
     ▼                    ▼                  ▼                     ▼                          │
auth-service ◄───── organization-service   billing-service ───► payment-service ◄── provider webhooks
 (deployed)   bearer   (human admin:          │   service token    │  (stored in webhook_event)
     ▲        grants,   /auth/grants,         │   (dispatcher,     │
     │        step-up)  /auth/step-up)        │    reconciler)     │
     └─────────── /auth/me, access checks ────┴────────────────────┘
                     (Billing, Payment → Auth)

 Each service ──► its own PostgreSQL database (auth, organization, billing, payment), own pool, own roles

 payment-service ── OutboxRelay ──►┐
 billing-service ── OutboxRelay ──►┼──► RabbitMQ  nawara.events (topic)
 auth-service ─ fire-and-forget ──►┘         │   (Auth: no outbox, F14)
                                             ▼
                          billing.payment-events (+ .retry, .dead) ──► PaymentEventConsumer (Billing)
```

Database per service (`<svc>_migrator` owns the schema, `<svc>_app` is DML-only; Auth: owner + `auth_app`). Migrations run only
through the explicit runner (`nawara-migrate`, Auth's `dist/cli/migrate.js`), never at startup. Every service exposes `/health`
(liveness, no dependency) and `/ready` (dependency checks). Operator CLIs: `nawara-migrate`, `nawara-check-outbox-lag`,
`nawara-check-dlq`, `nawara-dlq`; `scripts/smoke-core-image.sh` for images.

## 2. Runtime limits (none is changed by 15.1)

| Setting | Default | Bounds | Service(s) | Where | Bounds what | Stage 15 |
|---|---|---|---|---|---|---|
| `DB_POOL_MAX` | 10 | 1–100 | all four | kit `base-config`; Auth `app-config` | connections per process | measure, tune in 15.8 |
| `DB_CONNECTION_TIMEOUT_MS` | 5000 | 100–60000 | all four | same | pool acquisition **and** connect | validate 15.2 |
| `DB_STATEMENT_TIMEOUT_MS` | 30000 | 1000–600000 | all four | same (server-side) | one statement | validate 15.2, tune 15.8 |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 60000 | 1000–3600000 | all four | same (server-side) | idle session in a transaction | validate 15.2 |
| `DB_QUERY_TIMEOUT_MS` (added in 15.2) | statement timeout + 5000 (35000) | 1000–660000, > `DB_STATEMENT_TIMEOUT_MS` | all four | same (client-side `query_timeout`) | waiting for an answer from a silent server or network | validated 15.2 |
| `RABBITMQ_CONFIRM_TIMEOUT_MS` | 5000 | 100–60000 | Billing, Payment | service config | publisher confirm wait | validate 15.3 |
| `RABBITMQ_HEARTBEAT_S` (added in 15.3) | 10 | 5–60 | Billing, Payment (kit bus default 10) | service config → bus | a silent broker: every channel operation and close (~3 × heartbeat) | validated 15.3 |
| consumer retry | 3 retries, 5000 ms | 0–10, 100–300000 ms | Billing (`BILLING_PAYMENT_EVENT_RETRY_MAX/_DELAY_MS`) | billing config → bus | handler failures before DLQ | validate 15.3 |
| consumer prefetch | 10 | constant | kit bus | `rabbitmq-event-bus.ts` | unacked deliveries per consumer | measure 15.3/15.8 |
| consumer drain | 5000 ms | constant | kit bus | same | in-flight deliveries at close | validate 15.5 |
| consumer reconnect backoff | 500 ms → 30 s, jitter | constant | kit bus | same | reconnect storm | validate 15.3 |
| outbox relay | every 1000 ms, batch 50, backoff 1 s → 60 s, **unlimited attempts** | constant | Billing, Payment | kit `outbox-relay.ts`, `events.module.ts` | publish retries | validate 15.3 |
| `PollLoop` drain | 5000 ms | constant | every worker and the relay | kit `poll-loop.ts` | wait for an in-flight pass | validate 15.5 |
| `WEBHOOK_RETRY_MAX_ATTEMPTS` | 10; backoff 10 s × 2ⁿ from receipt | constant | Payment | `webhook-retrier.ts` | retries of a stored callback | validate 15.4 |
| dispatcher | every 2000 ms, batch 50, stale `sending` 60 s | 100–300000 / 1–1000 / 1 s–1 h | Billing (`BILLING_DISPATCH_*`) | billing config | send retries, reclaim | validate 15.4 |
| reconciler | every 30 s, batch 50, stale 300 s | configurable | Billing (`BILLING_RECONCILE_*`) | billing config | missed settlements | validate 15.4 |
| attempt resolver | every 5000 ms, batch 100, `submitted` stale 5 min | constant | Payment | `attempt-resolver.ts` | stuck attempts | validate 15.4 |
| expiry sweeper | every 5000 ms, **no batch limit** | constant | Payment | `expiry-sweeper.ts` | expired payments | measure 15.4/15.7 |
| Payment HTTP client | 5000 ms | 100–60000 (`PAYMENT_TIMEOUT_MS`) | Billing | billing config | Billing → Payment call | validate 15.6 |
| Auth HTTP client | 3000 ms | 100–30000 (`AUTH_TIMEOUT_MS`) | Billing, Payment, Organization | service config | identity checks | validate 15.6 |
| readiness check | 2000 ms per check (Auth 1500) | constant | all | `HealthModule` | one `/ready` check | measure 15.2 |
| JSON body | 100 KB | 1–10240 (`BODY_LIMIT_KB`) | kit services | base config | request size | – |
| Docker stop grace | 10 s (Docker default) | not set in compose or deploy | all | `docker-compose.yml`, deploy `docker stop` | SIGTERM → SIGKILL | measure 15.5 |

**Known relationships to test, not assumptions:** `RABBITMQ_CONFIRM_TIMEOUT_MS` should stay below
`DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` (the relay waits for the confirm inside its claim transaction); total worker drain can exceed the
Docker stop grace (drains are sequential per module and each worker is waited for twice); `DB_POOL_MAX` × processes must stay below
PostgreSQL `max_connections` (100 on the local server) with room for migrations and CLIs; the time a dispatcher instance needs to
send its **whole claimed batch** (up to batch × `PAYMENT_TIMEOUT_MS`, because the rows are claimed together and sent one after
another) should stay below `BILLING_DISPATCH_STALE_SENDING_MS`, otherwise the tail of the batch is reclaimed as stale while it is still
queued or in flight. (15.1 stated this as `PAYMENT_TIMEOUT_MS` < stale; 15.4 measured that the per-call bound is not enough, section
13.4. Payment's natural key keeps it correct either way; it costs duplicate sends.)

## 3. Concurrency and resources

| Component | Instances per process | Interval / batch | Claim / lock | Transaction boundary | External I/O in the transaction | Retry | Idempotency |
|---|---|---|---|---|---|---|---|
| OutboxRelay (Billing, Payment) | 1 | 1 s / 50 | `FOR UPDATE SKIP LOCKED` | the whole batch | **yes**: broker publish + confirm (bounded 5 s each) | backoff 1 s → 60 s, unlimited | consumer inbox (at least once) |
| PaymentDispatcher (Billing) | 1 | 2 s / 50 | `FOR UPDATE SKIP LOCKED`, row set to `sending` | the claim only | no: HTTP to Payment after commit | stale `sending` reclaimed after 60 s | Payment's natural key |
| PaymentReconciler (Billing) | 1 | 30 s / 50, cursor | none (reads stale `requested`) | per request | no | next pass | settlement rules (conflict detection) |
| PaymentEventConsumer (Billing) | 1 queue, prefetch 10 | push | – | per event (receipt + effect) | no | 3 × 5 s, then DLQ | `payment_event_receipt` |
| ExpirySweeper (Payment) | 1 | 5 s / **all due** | `FOR UPDATE` per payment (waits, no skip) | per payment | no | next pass | status re-checked under lock |
| AttemptResolver (Payment) | 1 | 5 s / 100 | **none** (by design) | per attempt, after the provider call | provider call **before**, outside any transaction | next pass | same transition rules as `sync` |
| WebhookRetriever (Payment) | 1 | 5 s / 100 | `FOR UPDATE SKIP LOCKED` + observed `attempts` | per event (claim + reprocess) | no | 10 attempts, 10 s × 2ⁿ | observed-attempt claim |
| Auth events | per request | – | – | none (fire-and-forget) | – | none (F14) | none |

With N instances of a service, each component runs N times; only the SKIP LOCKED claims divide work. Correctness under N > 1 is a 15.4
question, answered in section 13.4 (current inventory and models there).

| Resource | Limit | Notes |
|---|---|---|
| Pool per process | `DB_POOL_MAX` (10) | shared by HTTP, workers and readiness |
| PostgreSQL connections | `max_connections` 100 (local server) | production limit UNKNOWN |
| RabbitMQ connections / channels | 1 connection, 1 confirm channel + 1 channel per consumer per process; **one extra connection per `/ready` probe** (the `rabbitmq` check connects and closes, about 54 ms, section 12) | broker limits UNKNOWN |
| HTTP clients | no concurrency limit; bounded by timeout | Node global `fetch` |
| Inbound HTTP | **UNBOUNDED** concurrency (no server limit); per-route rate limits are DB-backed (one write per call) | |
| Worker concurrency | one pass at a time per loop (`PollLoop`) | |
| Event loop, CPU, memory | **IMPLICIT**: no container CPU/memory limits in compose or deploy | measured, not bounded |

## 4. Test environment (15.1 reference machine)

| Item | Value |
|---|---|
| CPU / RAM | Intel i5-12450H, 12 logical CPUs / 11.4 GiB (a developer laptop; about 4 GiB free while measuring) |
| OS | Kali GNU/Linux rolling, kernel 6.19.14 |
| Node / npm | 24.18.0 / 11.16.0 |
| Docker | 28.5.2 |
| PostgreSQL | 16.15 (compose `postgres:16-alpine`, `max_connections` 100, `shared_buffers` 128 MB) |
| RabbitMQ | 3.13.7 (compose `rabbitmq:3.13-management-alpine`) |
| Network | loopback; services run as local Node processes from `dist` (not containers) unless a campaign needs the image |
| Replicas | 1 per service unless the campaign varies it |
| Databases | one throwaway database per run, migrated with the real runner |

A laptop is noisy (thermal scaling, desktop load). Capacity campaigns (15.8) must record CPU governor and background load and repeat
runs; a result that moves more than its measured run-to-run range is not a difference.

## 5. Correctness invariants (canonical)

Stage 15 stops and investigates on any violation (section 9). Each is backed by the named mechanism.

| # | Invariant | Mechanism |
|---|---|---|
| I1 | A committed business change has its outbox row; a rolled-back one has none | `OutboxService.enqueue` takes the transaction's client |
| I2 | An outbox row is stamped published only after the broker confirmed it | relay stamps after `publish` resolves (confirm awaited) |
| I3 | Every committed event is eventually published once the broker is back (no lost event) | unlimited relay retries, rows stay pending |
| I4 | A duplicate or redelivered event has no second business effect | inbox / `payment_event_receipt` in the effect's transaction |
| I5 | No payment request produces two payments; no invoice is settled twice | dispatcher claim + Payment natural key; Billing settlement conflict rules |
| I6 | A stored webhook is never reprocessed by two workers at once, and never beyond 10 attempts | SKIP LOCKED + observed-attempt claim; `retries_exhausted` |
| I7 | A failed transaction leaves no partial write | `tx()` rollback |
| I8 | Work abandoned by a stop or crash is reclaimable and is reclaimed | rollback, stale `sending`, unacked redelivery, pending outbox |
| I9 | Every wait on a dependency is bounded by its configured limit (no hang) | Stage 14.4/14.6 limits; the client-side query deadline (15.2) |
| I10 | `/ready` is 503 while a required dependency is down and 200 after it recovers; `/health` stays 200 | readiness registry |
| I11 | Migration history cannot drift silently; a refused migration changes nothing | checksums, strict history, lock |
| I12 | Runtime roles cannot run DDL or create roles | `<svc>_app` grants |
| I13 | No credential, token, payload or webhook body reaches a log | message-free failure logging, redaction |

Duplicate **delivery** is expected (at least once) and is not a failure; a duplicate **business effect** is.

## 6. Measurement model

Measured with the repository's own tools (Node scripts, the kit's `BrokerProxy`, `pg_stat_activity`, `/proc`, the log signals, the
CLIs); **no metrics platform is introduced** (Stage 14.7 decision).

| Dimension | How |
|---|---|
| Latency p50/p95/p99/max, throughput, error rate | load script timings (section 8) |
| Recovery time | fault removed → `/ready` 200 and backlog 0 |
| Backlog growth / drain rate, oldest age, attempts | `nawara-check-outbox-lag`; `SELECT` on work tables |
| DB connections in use | `pg_stat_activity` by `application_name` |
| Worker pass / shutdown time | log timestamps (`service_shutdown_*`, `worker_drain_timeout`), process exit |
| CPU, RSS, event-loop lag | `/proc/<pid>`; `perf_hooks.monitorEventLoopDelay` in a test build if needed |
| Duplicate work / lost work / duplicate effects | invariant queries against the databases after each run |
| Retries, DLQ count | log signals; `nawara-check-dlq` |
| Log volume | lines and bytes per second per service from stdout |
| Table and index growth | `pg_total_relation_size`, row counts per operation |

## 7. Result vocabulary and stop conditions

- **PASS**: the invariant and the stated criterion hold. **FAIL**: an invariant or an explicit criterion is violated.
  **INCONCLUSIVE**: the environment or test cannot establish the result. **NEEDS PRODUCT/SRE DECISION**: consistent behaviour, but no
  agreed threshold exists (for example an acceptable recovery time). A slow result is not a FAIL unless a criterion says so.
- **Stop immediately and investigate before any further load:** data corruption; a duplicate financial effect; lost committed work;
  migration drift; privilege escalation; unbounded growth of memory or connections; a service that does not recover after the fault is
  removed; host instability.

## 8. Safety and tooling

- **Only throwaway infrastructure:** local compose or disposable containers, one throwaway database per run, loopback hosts only, test
  credentials only, no production credentials or data, never a production host. `scripts/validation/baseline.mjs` refuses
  `NODE_ENV=production` and non-loopback hosts; later harnesses keep these guards. Tests that need a clean cluster use a throwaway
  PostgreSQL container (the organization suite already refuses a cluster that hosts a real database).
- **Available now:** `BrokerProxy` (TCP relay: `sever` = connection cut, `freeze` = stall one direction; works for PostgreSQL too),
  `createTestDatabase`, process control from Node (`SIGTERM`, `SIGKILL`), Docker (`docker stop -t`, `docker kill`), `smoke-core-image.sh`,
  ApacheBench (`ab`, system package). **Missing:** a latency-injecting provider for Payment (only the scenario-based test provider
  exists: 15.4 needs a test-only wrapper), a concurrent HTTP load generator in the repository, a slow-network (latency) proxy mode.
  Recommendation: add `autocannon` as a dev dependency when 15.8 starts (Node, scriptable, reports percentiles; `ab` has no keep-alive
  percentiles worth trusting and is not a repository dependency); extend `BrokerProxy` with a delay mode rather than adding toxiproxy.
- **Deterministic control over sleeps:** faults are applied and removed by the harness at known points; assertions wait on conditions
  (latches, log lines, row states), never on fixed sleeps alone.

## 9. Reproducibility, repetition and comparison

- Every experiment report records the fields of the template (section 14). A number without its Git SHA, environment and configuration
  is not a result.
- **Repetition:** latency and startup/shutdown baselines: 3 runs, report median and range. Capacity points: 1 warm-up + 3 measured runs
  of at least 60 s each. Race-sensitive correctness campaigns (claims, shutdown, duplicate delivery): at least 20 iterations, and any
  single violation is a FAIL.
- **Before / after:** same experiment, environment, dataset and configuration except the one intentional variable; compare medians only
  when the difference exceeds both ranges. Numbers from different machines are never compared as if equivalent.

## 10. Data profiles

No traffic or volume data exists for any Core product, so absolute sizes are **TBD by 15.7 (growth) for 15.8 (capacity)**. The
correctness campaigns size backlogs from the code's own batch sizes instead:

| Profile | Definition | Used by |
|---|---|---|
| SMALL | the e2e fixtures: a few organizations, invoices and payments | functional checks, baseline |
| MULTI-BATCH | 10 × the component's batch: relay 500 outbox rows, dispatcher 500 requests, retrier / resolver 1000 rows | 15.3, 15.4 (head-of-line, fairness, drain) |
| MEDIUM / LARGE | TBD BY 15.7 GROWTH MEASUREMENT | 15.8 |

## 11. Stage 15 structure (recommended)

The proposed order put capacity and tuning (15.6) before cross-service failures and data growth. Evidence argues for moving tuning
last: tuning changes the very limits the failure campaigns validate, so every correctness campaign must first establish its behaviour
at the current defaults; and capacity datasets need the growth measurements. Log volume is a by-product of every outage campaign and
is measured there, then assessed in 15.7.

```text
15.1 Strategy & Baseline                       (this document)
          │
          ▼
15.2 Database stress & recovery                pool saturation, outage, disconnect, slow query, idle tx; Auth first (deployed)
          │
          ▼
15.3 RabbitMQ, outbox & consumer failure       broker down/stall/recover, outbox accumulate/drain, retry, DLQ, duplicates
          │
          ▼
15.4 Worker & concurrency                      multi-instance claims, webhook retrier, AttemptResolver latency, sweeper backlog
          │
          ▼
15.5 Shutdown & restart                        drain timing vs stop grace, SIGKILL mid-work, reclaim and convergence
          │
          ▼
15.6 Cross-service failure                     Payment down/slow, Auth down, one database down, restart during processing
          │
          ▼
15.7 Data growth & operational load            table growth per operation, log volume, CLI behaviour at size (feeds F12)
          │
          ▼
15.8 Capacity & runtime tuning                 first bottleneck, pool sizing, timeout relationships; re-run affected campaigns
          │
          ▼
15.9 Final validation & closure
```

Dependencies: 15.2 before everything (every mechanism uses the pool); 15.3 before 15.4 (workers publish through the outbox); 15.5 needs
the in-flight scenarios of 15.2–15.4; 15.6 composes them; 15.7 needs the working system; 15.8 needs every correctness baseline (a
tuned value is accepted only after the campaigns it affects are re-run with it); 15.9 re-runs the full matrix. A harness checkpoint
opens 15.2: extract the baseline script's service launcher and measurement helpers into a reusable test-only harness before the first
campaign.

## 12. Master validation matrix and acceptance criteria

| Stage | Campaign | Fault / load | Measurements | Invariants | Pass | Fail | Tuning variable |
|---|---|---|---|---|---|---|---|
| 15.2 | Pool saturation | concurrent requests > `DB_POOL_MAX` | latency, errors, time waiting for a client, connections | I7, I9, I10 | waits ≤ `DB_CONNECTION_TIMEOUT_MS` + margin; excess callers fail fast with 5xx, no hang; connections ≤ pool; `/health` 200; full recovery once load stops | a wait beyond the bound; a leaked connection; no recovery | `DB_POOL_MAX`, connection timeout |
| 15.2 | PostgreSQL outage | refuse (proxy sever), stall (freeze), mid-query disconnect | detection time, `/ready`, error kinds, recovery time, log volume | I7, I9, I10, I13 | `/ready` 503 within one probe; bounded failures with the right `kind`; `/ready` 200 and work resumes after recovery | a hang, a crash, no recovery, a partial write | – |
| 15.2 | Slow query / idle tx | `pg_sleep`, idle open transaction | cancellation time, rollback, lock release | I7, I9 | cancelled at the bound (57014 / 25P03), locks released, pool usable | statement past its bound; lock held | statement, idle-tx timeouts |
| 15.3 | Broker down during work | proxy sever | business commits, outbox growth/s, oldest age, drain/s after recovery, duplicates | I1, I2, I3, I4 | business writes unaffected; backlog drains to 0 after recovery; every row published; no duplicate effect | a lost or never-published row; a duplicate effect | relay batch/interval (not a setting today) |
| 15.3 | Confirm stall | proxy freeze | publish failure time, DB connection held, recovery | I2, I3, I9 | publish fails at the bound; row pending; connection released | row stamped without confirm; wait past bound | `RABBITMQ_CONFIRM_TIMEOUT_MS` |
| 15.3 | Consumer failure | handler failures, poison message, redelivery | retries, DLQ, duplicates | I4 | ≤ `maxRetries` retries then DLQ; replay applies once | message lost, looped or applied twice | retry max/delay |
| 15.4 | Multi-instance workers | 2–4 processes, MULTI-BATCH | work split, starvation, contention, double processing | I5, I6 | no row processed twice concurrently; every row finished; no starvation | a duplicate effect or a stranded row | batch sizes |
| 15.4 | AttemptResolver latency | test provider with injected latency, 2+ instances | provider calls per attempt, duplicate transitions | I5 | duplicate polls allowed; **no** duplicate state transition or event | a duplicate transition or event | NEEDS DECISION on acceptable amplification |
| 15.4 | Webhook retrier | old failing events + new events, 2+ instances | backoff timing, attempts, head-of-line | I6 | backoff matches 10 s × 2ⁿ; stops at 10; new events not blocked | an 11th attempt; concurrent reprocess; blocked new event | – |
| 15.5 | Shutdown timing | SIGTERM idle / one / all passes hung / confirm stalled / consumer busy | SIGTERM → exit, per-phase time, SIGKILL occurrence | I8 | idle exit well under 10 s; with hung work: bounded and reclaimable | work lost; a stop that never ends | drain timeout, stop grace (NEEDS SRE DECISION) |
| 15.5 | Kill and restart | SIGKILL mid-batch, restart | reclaim time, convergence | I3, I4, I5, I8 | every row / message / request converges; no duplicate effect | stranded or duplicated work | stale thresholds |
| 15.6 | Payment down or slow | stop or delay Payment | dispatcher behaviour, request states, recovery | I5, I9 | bounded by `PAYMENT_TIMEOUT_MS`; requests retried, none lost or doubled | a duplicate payment; a stuck request | `PAYMENT_TIMEOUT_MS`, stale sending |
| 15.6 | Auth down | stop Auth | 401/503 behaviour of Billing/Payment/Organization | I9, I10 | bounded by `AUTH_TIMEOUT_MS`, no hang | a hang or a wrong authorization outcome | `AUTH_TIMEOUT_MS` |
| 15.7 | Data growth | N business operations | rows and bytes per operation per table, index growth, query time at size | – | measured; feeds the F12 retention decision | – (NEEDS PRODUCT DECISION on retention) | – |
| 15.7 | Log volume | sustained outage | lines/s, bytes/s per service, repeats, recovery line | I13 | measured; NEEDS SRE DECISION on acceptable volume | a secret in a log | – |
| 15.8 | Capacity | ramp concurrency | latency and error curves, first bottleneck, resources | all | a characterised curve and named bottleneck | an invariant broken under load | `DB_POOL_MAX`, timeouts |

## 13. Results register

| Stage | Date | SHA | Campaign | Result | Report |
|---|---|---|---|---|---|
| 15.1 | 2026-09-23 | `5e72510` | Idle / light baseline, billing-service | PASS (tooling and reference established) | section 13.1 |
| 15.2 | 2026-09-23 | `f78a2ad` | Database stress and recovery (13 campaigns) | **FAIL** on I9 (a query on an established connection has no client-side bound); every other invariant PASS | section 13.2 |
| 15.2 | 2026-09-23 | `f78a2ad` + corrective patch | I9 correction (`DB_QUERY_TIMEOUT_MS`) and the full 15.2 matrix re-run | PASS: I9 bounded; no regression | section 13.2.1 |
| 15.3 | 2026-09-23 | `33a0225` | RabbitMQ, outbox and consumer failure (17 campaigns, kit and live services) | **FAIL** on I9 (channel-level broker operations have no Core-configured bound); I1–I8, I10, I13 PASS; no lost event, no duplicate effect | section 13.3 |
| 15.3 | 2026-09-23 | `33a0225` + corrective patch | I9 correction (`RABBITMQ_HEARTBEAT_S`, bounded closes) and the full 15.3 matrix re-run (19 campaigns) | PASS: I9 bounded by Core whatever the broker's heartbeat policy; no regression | section 13.3.1 |
| 15.4 | 2026-09-23 | `a760c85` | Workers and concurrency (23 campaigns: kit, Payment workers, live Billing / Payment fleets; race campaigns ≥ 20 iterations) | PASS on C1–C13: no duplicate protected effect, no lost work, no invalid state, no cross-tenant write, no lock leak; throughput / amplification findings carried to 15.8 | section 13.4 |
| 15.5 | 2026-09-23 | `804dc72` | Shutdown and restart (17 campaigns: SIGTERM / SIGKILL / `docker stop` windows, frozen dependencies, restart cycles, rolling restart, backlog, dependency-down startup) | **FAIL** on S2/S8 (a busy keep-alive connection keeps a SIGTERMed service serving, and `/ready` 200, with no Core bound) and on S3 (a cancellation accepted while Payment is unavailable is silently lost); every crash / kill window otherwise PASS (no lost, partial or duplicated effect; no manual repair) | section 13.5 |
| 15.5 | 2026-09-23 | `804dc72` + corrective patch | F-A (bounded HTTP drain, readiness at shutdown start), F-C (Auth pool order), F-D (one concurrent drain per worker), F-B (cancellation answered only when Payment confirmed); full 15.5 matrix re-run (21 campaigns) plus the new cancellation campaigns | F-A, F-B, F-C, F-D corrected and revalidated (no client can extend the HTTP drain; `/ready` 503 from the first moment; each worker drains once, concurrently; 0 accepted-but-lost cancellations; every crash window as before) — **FAIL on S8/S10 in containers (new finding F-H)**: with the broker frozen, Nest completes its shutdown but PID 1 never exits (an AMQP socket left half-closed keeps Node's event loop alive); SIGKILL even with a 45 s grace | section 13.5.1 |
| 15.5 | 2026-09-23 | `804dc72` + corrective patches 1 and 2 | F-H: the kit bus destroys the transport of every connection it gives up on (error close, abandoned close); one close deadline; waits end when the connection is gone. Full 15.5 matrix + new container campaigns, full 15.3 matrix, 15.4 subset | **PASS**: frozen broker in the production image → natural exit (exit 0) at 27–29 s, 12/12 plus 20/20 cycles, with the broker's heartbeat on or off; every crash window, cancellation and accounting as before; worst graceful shutdown 39.8 s → **60 s** stop grace set in the Auth deploy and Compose | section 13.5.2 |

### 13.1 Baseline (15.1)

`node scripts/validation/baseline.mjs --runs 3 --samples 200`, billing-service from `dist`, default limits, one instance, local
PostgreSQL 16.15 and RabbitMQ 3.13.7 on loopback, reference machine of section 4. Median [min–max] of 3 runs; sequential single
client (no concurrency).

| Measurement | Result |
|---|---|
| Start to `service_started` / to first `/ready` 200 | 577 ms [575–595] / 643 ms [642–665] |
| Idle RSS / idle CPU (10 s window) | 156 MB [151–158] / 0.8 % of one core [0.5–0.8] |
| `GET /health` p50 / p95 / p99 | 2.5 / 3.5 / 4.8 ms |
| `GET /ready` p50 / p95 / p99 | 59.7 / 67.2 / 69.5 ms |
| `SELECT 1` round trip p50 / p95 / p99 | 0.13 / 0.42 / 0.65 ms |
| Broker round trip (confirmed publish → handler) p50 / p95 / p99 / max | 1.0 / 2.1 / 6.0 / 45.7 ms |
| SIGTERM → exit, idle | 13 ms [13–13], `service_shutdown_complete` logged |
| Warn/error log lines during the run | 0 |

**Observation (a 15.2 question, not a defect):** `/ready` costs about 60 ms per probe because the `rabbitmq` check opens and closes a
new AMQP connection each time (about 54 ms measured; the database check about 0.14 ms, the migrations check about 0.9 ms). Frequent
probes across many instances would create broker connection churn.

### 13.2 Database stress and recovery (15.2)

**Harness:** `scripts/validation/db-campaigns.mjs` (campaigns) on `scripts/validation/lib/harness.mjs` (guards, throwaway databases, service
launcher, session and process sampling). It refuses `NODE_ENV=production`, non-loopback hosts, and any cluster that hosts a real Core
database, so it runs only against a throwaway PostgreSQL container; every campaign creates and drops its own databases. Run:
`VALIDATION_DATABASE_ADMIN_URL=... [VALIDATION_PG_CONTAINER=<throwaway container>] node scripts/validation/db-campaigns.mjs --out r.json [campaign ...]`.

**Setup:** `main` at `f78a2ad`; reference machine of section 4; throwaway `postgres:16-alpine` (16.15, `max_connections` 100, 3 reserved)
on loopback; RabbitMQ 3.13.7 healthy throughout (not a variable). Services from `dist`, one instance each unless stated, **Stage 14
defaults**. Library campaigns drive the services' own `DbService` classes (kit and Auth). Where a campaign lowers a server-side bound to
1 s, it is only to avoid waiting 30 s / 60 s on each of 20 iterations; the defaults were read back from the server (`statement_timeout`
30 s, `idle_in_transaction_session_timeout` 1 min) in every run. Timing caveat: an editor extension (Console Ninja) had patched
`node_modules/@nestjs/core` on this machine and runs inside every Nest process (not present in CI or images); it does not affect
correctness results.

**Finding (FAIL, I9): a query on an already-established connection is not bounded.** When the server stops answering after it has
accepted a query, nothing in the client ends the wait. `statement_timeout` is enforced by the server (which is not answering),
`DB_CONNECTION_TIMEOUT_MS` covers only acquiring or opening a connection, and neither `pg` client (kit or Auth) sets a client-side
`query_timeout` or TCP keepalive. Evidence: a one-direction network stall held a `SELECT 1` for the whole 45 s observation (3/3 runs); a
`docker pause` of the database (the host frozen, its kernel still accepting TCP) held it for the whole 40 s freeze, and it returned
only after the unpause (41.3 s). During that freeze billing-service's relay and dispatcher, which log a failure every 1–2 s in a
refused-connection outage, logged **nothing**: their passes were silently stuck, each holding a pool client, while `/ready` correctly
answered 503 (2.0 s) and `/health` 200. With a fault that never clears (a host that dies after acknowledging a query, a partition), the
wait, the held client and the stuck worker would last until the process restarts; `pool.end()` at shutdown would wait for that client
too. New connections, readiness and every other path are bounded (below). Not fixed here: it needs a production change (see
section 16).

| Campaign | Fault | Runs | Observed | Result |
|---|---|---|---|---|
| Control | none | 1 × (50 + 50 + 200 samples) | ready 679 ms after start; `/health` p50 0.7 ms; `/ready` p50 56 ms; `SELECT 1` p50 0.13 ms; 4 idle sessions; 0 warn/error | PASS (reference) |
| A. Pool saturation curve | 1, 5, 9, 10, 11, 15, 20 callers holding 6 s | 3 per point | exactly `min(c, 10)` succeed; the `c − 10` others fail at **5.00 s** (`kind=db_connect_timeout`); server sessions never > 10; `SELECT 1` right after: ok; pool back to 10 idle / 0 waiting | PASS |
| A. Queued callers | 11 and 20 callers holding 2 s | 1 each | all succeed; the queued ones after ~4.0 s (one hold + wait) | PASS |
| A. Leak check | 20 × (15 slow queries + 12 rolled-back transactions) on one pool | 20 | pool 10/10/0 and 10 server sessions after every round; 0 idle-in-transaction; no growth | PASS |
| B. Statement timeout | `pg_sleep(3)`, bound 1 s (default 30 s verified) | 20 | cancelled at 1.00 s [1.00–1.01], `57014`, `db_statement_timeout`; next query ok | PASS |
| B. …inside a transaction | insert, then slow statement | 20 | 0 partial commits; next transaction commits | PASS |
| C. Idle in transaction + lock | A holds a row lock and idles, bound 1 s (default 1 min verified) | 20 | A ended by the server, lock released 1.01 s [1.00–1.04] after A's last statement, B proceeds; A's write never commits (final value exactly 20 × B); no crash; broken client destroyed; pool usable | PASS |
| Lock contention | B updates a row A holds, statement bound 1 s | 20 | B cancelled at 1.00 s (`57014`): lock waits count toward `statement_timeout` (no `lock_timeout` set); all later updates applied exactly | PASS |
| D. Unavailable at startup | port closed at start, restored later | 3 × 4 services | every service starts and stays live (`/health` 200), `/ready` 503; recovers **without restart** 14–68 ms after the database returns | PASS |
| E/L. Runtime outage, repeated | connection cut 10 s, restored; 5 cycles | billing 5, auth 5 | `/ready` 503 within 5–64 ms of the cut; 200 again 14–67 ms after restore, every cycle; `/health` 200; sessions back to 2; logs `readiness_check_failed` once per check, `…recovered` once; `error=Error code=ECONNREFUSED kind=network_unreachable` with `localhost` (no `AggregateError`); no credential in any line | PASS |
| F. Mid-query disconnect | connection cut during `pg_sleep(2)` | 20 | `kind=db_connection_lost`; no crash; the next 15 queries all ok (no poisoned client) | PASS |
| F. Mid-transaction disconnect | cut after 2 inserts, before COMMIT | 20 | 0 partial rows; fresh transaction commits | PASS |
| G. Stall, new connection | listener accepts, never answers | 5 | fails at **5.00 s** (`db_connect_timeout`); readiness 503 at 2.0 s | PASS |
| G. Stall, established connection | response path stalled / database frozen | 3 + 1 | **no bound**: waited the whole fault (45 s, 40 s) | **FAIL (I9)** |
| H. Readiness under exhaustion | 10 of 10 clients held, real Nest app | 20 | `/ready` 503 at 2.01 s [2.00–2.02]; `/health` 200 (4 ms); `/ready` 200 again 8 ms after release | PASS |
| Auth `DbService` | statement 1 s; exhaustion; refused | 10 / 10 / 1 | `57014` at 1.00 s; Auth readiness 503 at **1.50 s**; `/auth/health`'s `SELECT 1` fails at **5.0 s** (no wrapper: bounded only by the pool); refused → `ECONNREFUSED`, 8 ms | PASS |
| Relay connection hold (DB side) | publish takes 5 s | 1 and 3 relays | each relay holds **one** client, idle in transaction, for the publish; 3 relays → 3 | PASS (≤ 1 client per relay) |

**Connection accounting** (peak under 80 concurrent `/ready` per process; pg-pool closes idle clients after 10 s):

| Scenario | Processes | Configured max | Peak server sessions | After burst | After 12 s idle |
|---|---|---|---|---|---|
| Auth + Organization + Billing + Payment | 4 | 40 | 40 (10 per database) | 40 | 4 |
| billing × 1 | 1 | 10 | 10 | 10 | 2 |
| billing × 2 | 2 | 20 | 20 | 20 | 4 |
| billing × 3 | 3 | 30 | 30 | 30 | 3 |

Demand is exactly `processes × DB_POOL_MAX` at peak. On a 100-connection server (97 usable) that leaves room for 9 processes at the
default, minus migration runners and CLIs.

**Timeouts observed** (median [range]):

| Failure | Configured bound | Observed | Code / kind | Recovered |
|---|---|---|---|---|
| Pool acquisition | 5000 ms | 5001 ms [5000.5–5001.6] | `db_connect_timeout` | yes |
| New connection, stalled server | 5000 ms | 5001 ms [5000.9–5006.1] | `db_connect_timeout` | yes |
| Statement | 1000 ms (test) / 30 s default | 1002 ms [1000.9–1013.8] | `57014` `db_statement_timeout` | yes |
| Idle in transaction | 1000 ms (test) / 60 s default | lock free after 1006 ms [1002–1040] | reported as `db_connection_lost` | yes |
| Readiness, pool exhausted | 2000 ms (Auth 1500) | 2006 ms [2002–2017] (Auth 1501) | check name only | yes, 8 ms after release |
| Query on established connection, stalled | **none** | the whole fault (40–45 s) | – | only when the fault clears |

**Side measurements.** Log volume during a refused-connection outage: billing 1.4 warn/s + 0.5 error/s (`outbox_relay_pass_failure`
every 1 s, `payment_dispatch_pass_failure` every 2 s), Auth only the four transition lines. RSS rose across outage cycles (billing
156 → 185 MB over 5, Auth 185 → 199 MB over 5) and was still rising slowly: INCONCLUSIVE over this few cycles (heap warm-up or a
leak); a longer soak belongs to 15.5/15.8. CPU during an outage: 5–11 % of one core.

**Carried forward:** 15.3: the relay holds its transaction open during a slow publish (1 client per relay, confirmed). 15.5: a stuck
query also blocks `pool.end()` at shutdown. 15.6: Auth rate-limits `/health` and `/ready` (probes faster than about 1 per second from one
address are answered 429). 15.7: log volume above; an idle-in-transaction termination is logged as `db_connection_lost`, not
`db_idle_in_transaction_timeout` (the 25P03 is captured but the thrown error is generic). 15.8 tuning candidates (no change made):
`/auth/health` bound 5 s equals the compose healthcheck timeout (5 s); the `/ready` broker check's per-probe connection (about 54 ms);
pool size against `max_connections` per deployment; whether a `lock_timeout` shorter than `statement_timeout` is wanted.

### 13.2.1 Corrective patch for I9 (15.2)

The failure above is kept as found. This is the correction and its evidence.

**Root cause, confirmed in the installed `pg` 8.23.0 / `pg-pool` 3.14.0 source and by experiment.** `connectionTimeoutMillis` bounds only
acquiring a pooled client and opening a connection. `statement_timeout` and `idle_in_transaction_session_timeout` are session settings
enforced by PostgreSQL: a silent server enforces nothing. `query_timeout` (default off) is the only client-side bound on waiting for an
answer, and neither `DbService` set it. `keepAlive` (default off) only asks the OS to probe an idle socket; Node exposes no interval or
count, so detection takes the kernel's defaults (minutes), and a socket that stays up (a proxy, a frozen host whose kernel still answers)
never fails a probe at all.

**What `query_timeout` does, and does not do (experiments against a frozen server, bound 2 s).** It rejects the caller with
`Error('Query read timeout')` (no code) at the bound. It sends nothing to the server and cancels nothing there. If the query was already
sent, the connection stays waiting for that answer and later queries queue behind it. `pool.query` releases the client with the error, so
pg-pool destroys it (pool back to 0 clients, the next query fine). **Inside a transaction it was unsafe with the existing `tx()`:** the
timed-out write left the transaction open, the `ROLLBACK` queued behind the silent statement and was dropped when it timed out too, the
client went back to the pool as idle, and the next, unrelated caller's transaction committed **its own row and both "failed" rows**
(A, B and C all present). A client-side deadline alone would have turned a hang into a silent wrong commit.

**Design (production change, narrow).**

- `DB_QUERY_TIMEOUT_MS`, beside the other DB limits, in the kit's `loadDbRuntimeConfig` and in Auth's configuration: default
  `DB_STATEMENT_TIMEOUT_MS` + 5000 (35000), bounds 1000–660000, and it must be **greater** than `DB_STATEMENT_TIMEOUT_MS` (refused at
  startup otherwise), so a slow statement is still cancelled by the server first and the client deadline is only the backstop. The 5 s
  margin: server cancellation reached the client 1–14 ms after the bound here, and 5 s is the repository's bound for waiting on a peer
  (connection, broker confirm, Payment and Auth calls).
- Both `DbService`s pass it to the pool as `query_timeout`; constructed directly without it, they derive the same default.
- Both `tx()`s treat a client-side timeout as a broken connection: no `ROLLBACK` (it would only queue behind the silent statement), the
  client is released with the error, so pg-pool destroys it (`pg` 8.23 force-closes a socket with a query in flight). Closing the
  connection ends the session; PostgreSQL rolls the open transaction back. A timeout on `COMMIT` itself is ambiguous (the server may
  have committed), exactly like a connection lost during `COMMIT`: the existing idempotency and at-least-once rules cover it.
- `describeFailure` recognises it as `kind=db_query_timeout`, distinct from `db_statement_timeout`, `db_connect_timeout` and
  `network_unreachable`. `nawara-check-outbox-lag` gets the same deadline (35 s). The migration runner stays unbounded on purpose (a long
  DDL is legitimate and an operator watches it).
- **Not adopted:** TCP keepalive. The pool closes idle clients after 10 s, before any keepalive probe; a checked-out client is bounded by
  the query deadline; and the probe cadence is kernel-dependent. It adds nothing deterministic here.

**Tests.** Configuration (kit and Auth): default, derived default, minimum, maximum, zero, negative, fractional, non-numeric, and the
ordering rule. `failure.spec`: the classification, and the exact `'Query read timeout'` text pinned against the installed `pg`.
`query-deadline.int-spec` (kit, real PostgreSQL, stalled connection): negative control (a 600 s deadline stays pending past 3 s and
returns only when the fault clears); a read fails at the bound without the fault being removed, the client destroyed, the pool
recovered; a timed-out transaction is **not** committed by the next borrower and leaves no idle-in-transaction session; shutdown is not
held; direct construction is bounded. Reverting the `tx()` change makes the transaction test fail. `db-query-deadline.e2e-spec` (Auth's
own `DbService`): the same read, transaction and default checks.

**Before / after** (same campaigns, same machine, same throwaway server):

| Experiment | Before | After |
|---|---|---|
| Established connection, response path stalled (3 runs) | still pending at 45 s | fails at 35.00 s [35.00–35.00], `db_query_timeout`; the connection works after the fault clears |
| Database frozen 40 s (`docker pause`), established query | returned after the unpause, 41.2 s | fails at 35.0 s, during the freeze |
| Billing workers during the freeze (defaults) | silent for 40 s | `outbox_relay_pass_failure` and `payment_dispatch_pass_failure` (`db_query_timeout`) at ~35 s; no warn/error once the database is back |
| Same, test bounds (statement 1 s, deadline 3 s) | – | first worker failure at 3.8 s, 14 visible failures during the freeze, clean afterwards |
| `/ready` / `/health` during the freeze | 503 at 2.0 s / 200 | unchanged: 503 at 2.0 s / 200 |
| SIGTERM with the database frozen (defaults) | **still running at 60 s** (`pool.end()` held by the stuck clients) | exits at 33.4 s: four 5 s drain timeouts, then the stuck passes fail at the deadline |
| Same, test bounds | – | exits at 1.4 s |

**Full 15.2 matrix re-run after the patch: no regression.** Pool saturation (exactly 10 succeed, the rest fail at 5.00 s; leak check
constant at 10 sessions), statement timeout outside and inside transactions (0 partial commits), idle-transaction kill and lock release
(1.01 s), lock contention, mid-query and mid-transaction disconnect (0 partial rows, no poisoned client), new-connection stall (5.00 s),
readiness under exhaustion (503 at 2.01 s, `/health` 200), startup with the database down (all four recover without restart),
5 outage cycles each for Billing and Auth (`error=Error code=ECONNREFUSED kind=network_unreachable`, no `AggregateError`, no
credential), Auth library scenarios, connection accounting (exactly processes × 10), relay hold (1 client per relay); 0 uncaught
exceptions. The RSS creep across outage cycles was seen again (billing 148 → 189 MB, Auth 185 → 199 MB over 5): still INCONCLUSIVE,
for the 15.5/15.8 soak.

**For 15.5:** with the defaults a shutdown during a frozen database now ends at about 33 s, which is still past Docker's 10 s stop grace
(the process would be killed at 10 s; no work is lost, section 13.2). The drains remain sequential and each worker is waited for twice.

### 13.3 RabbitMQ, outbox and consumer failure (15.3)

**Harness:** `scripts/validation/broker-campaigns.mjs` on `scripts/validation/lib/harness.mjs`, which now also starts and removes its
own throwaway RabbitMQ and PostgreSQL containers (names `validation-*`, fixed free loopback ports; it touches no other container) and
reads broker state with `rabbitmqctl`. `scripts/validation/lib/crash-consumer.mjs` is a child consumer that SIGKILLs itself at a chosen
point. Kit-layer campaigns drive the real `OutboxService` → `OutboxRelay` → `RabbitMqEventBus` → `InboxService` path with per-event-id
accounting (business row, outbox row, publish attempts, physical deliveries, inbox accepts, business effects); app-layer campaigns drive
live payment-service and billing-service (Payment's outbox, Billing's `billing.payment-events` consumer and `payment_event_receipt`)
through real cancellations. Run: `node scripts/validation/broker-campaigns.mjs --out r.json [campaign ...]`. The test proxy's `freeze()`
did not freeze connections opened during a freeze (the 15.2 limitation); `BrokerProxy` now pauses after piping (test-only code).

**Setup:** `main` at `33a0225` (Stage 15.2 merged; its fix deployed with Auth); throwaway `rabbitmq:3.13-management-alpine` (heartbeat
proposed by the broker: 60 s) and `postgres:16-alpine`; reference machine of section 4; every Stage 14/15 default (confirm 5000 ms,
prefetch 10, retry 3 × 5000 ms, relay every 1000 ms, batch 50, backoff 1 s → 60 s). One test-only change to an unrelated setting: the
app harness raises Billing's invoice and payment-request create rate limits (seeding ~100 requests from one producer; not under test).

**Path under test (from the source).** A business transaction writes its state and an `outbox` row together; the relay claims up to 50
due rows `FOR UPDATE SKIP LOCKED` in one transaction, publishes each (persistent, durable topic exchange `nawara.events`) and **awaits the
publisher confirm inside that transaction**, then stamps `publishedAt` (or records `attempts`, `lastError`, `availableAt` = now + 1 s × 2ⁿ,
capped 60 s, and stops the batch). There is no "claimed" state: a row is pending (`publishedAt` null) or published; a claim is only the
row lock of the open transaction. The consumer acknowledges **after** the handler resolves, and the handler commits the inbox row and the
effect in one transaction; a failure is republished (confirmed) to `<queue>.retry` (TTL 5 s) or `<queue>.dead`, then acknowledged.

**Finding (FAIL, I9): channel-level broker operations are bounded only by the AMQP heartbeat, which Core does not configure.** A publish
on an open confirm channel is bounded by `RABBITMQ_CONFIRM_TIMEOUT_MS`, a new connection by the connect timeout, readiness by its 2 s
check. But opening a channel, declaring the exchange or queue, cancelling a consumer and closing a channel or connection are protocol
round trips with no deadline in the kit, and the kit sets no client heartbeat, so it accepts whatever the broker proposes (amqplib:
"no preference, accept server value"; detection after two missed intervals). Measured with the broker frozen (`docker pause`, TCP still
accepted), after the first confirm timeout discards the channel:

| With the broker's heartbeat | Relay pass needing a new channel | Consumer notices the loss | Billing SIGTERM → exit |
|---|---|---|---|
| 60 s (RabbitMQ default) | ends at **174.8 s** (PostgreSQL had already ended its idle transaction at 60 s; the pass fails with `db_connection_lost`) | 179.9 s (`consuming` until then, though `/ready` is 503 at 2 s from its own connect check) | **172 s** (Docker's 10 s stop grace would SIGKILL it) |
| 0 (heartbeats disabled, a legal broker setting) | **still pending at 240 s** | never | consumer close **still pending at 240 s** |

No event was lost and no effect duplicated in any of these runs (after the unpause: 4/4 events, one delivered twice, applied once). The
failure is the wait itself: its bound is neither configured nor guaranteed by Core. Not fixed here (production change; section 16).

**Results** (kit layer unless marked *app*; every accounting row: 0 lost, 0 duplicate effects):

| Campaign | Fault | Runs | Observed | Result |
|---|---|---|---|---|
| Baseline | none | 200 events | each published, delivered and applied exactly once; occurrence → handler median 2.1 s (relay pass cadence: 50 rows per 1 s pass) | PASS |
| *App* baseline | none | 20 cancellations | 20 `payment.cancelled` → 20 receipts → 20 requests cancelled in 704 ms; outbox → published median 364 ms | PASS |
| Broker down before publish | broker stopped, 100 business transactions | 3 | business transactions unaffected (median 1 ms); rows pending; 1 relay failure line/s; ≤ 1 DB client held; first publish 0.2 s after the broker returns; backlog drained in 2.3–2.5 s; 105/105 exactly once | PASS |
| *App* broker down | broker stopped, 30 real cancellations | 1 | cancel API 200; both `/ready` 503, `/health` 200; Payment outbox accumulates; drained 12.4–12.7 s after the broker returns (rows had backed off); 30/30 receipts, 30 distinct events, 30 cancelled; 1 Billing consumer | PASS |
| Repeated outages | 5 × (stop 8 s, start), continuous traffic | 5 cycles | every cycle: 1 consumer, 2 connections, 2 channels (no multiplication); consumer re-attached ≤ 0.5 s after the broker is back; RSS 99 → 101 MB; 553/553 exactly once | PASS |
| *App* repeated outages | 3 × stop/start with cancellations | 3 | 5/5 per cycle; Billing queue: 1 consumer, 2 connections, 2 channels | PASS |
| Confirm timeout | broker→client stalled | 3 + 20 | fails at 5.00 s [5.00–5.01] (`broker_confirm_timeout`); a fresh channel every time; later publish ok (median 11 ms); late confirms never resolve a later publish | PASS |
| Lost confirm (ambiguity) | message stored, confirm lost | 20 | first pass fails, row stays pending (`lastError` recorded), 1 DB client held and 1 session idle in transaction for the stall; retry → **2 physical deliveries → 1 effect** every time | PASS |
| Connection cut mid-publish | connection severed while awaiting the confirm | 20 | pass fails ~9 ms after the cut; retried; 2 deliveries → 1 effect | PASS |
| Broker freeze | broker process frozen | 1 + 1 (heartbeat 0) | see the finding above | **FAIL (I9)** |
| Consumer failures | transient×2 then ok; always transient; permanent; poison ahead of good messages | 1 | transient: 3 deliveries, 1 effect (~10 s); always transient: 1 + 3 retries → dead-lettered `retries_exhausted` (15.7 s); permanent: dead-lettered at once; good messages behind the poison applied in 15–24 ms (no head-of-line block); dead letters keep message id, type, correlation id, failure, reason, retry count | PASS |
| Duplicate delivery | same id 3× sequentially; 4× concurrently to 2 competing consumers | 5 + 20 × 10 | 815 physical deliveries of 205 events → 205 effects (inbox unique `eventId`) | PASS |
| Crash windows | SIGKILL before the tx (A), inside it (B), after COMMIT before the ack (C) | 20 each | A, B: no effect, redelivered, applied once; C: effect committed, redelivered, inbox skips it: still 1 | PASS |
| Prefetch | handler never finishes, 25 messages | 3 | exactly 10 unacknowledged held, 15 ready; connection dies → 25 ready again | PASS |
| Multiple relays | 3 relays, 500 rows | 1 | split 150/150/200, 500 deliveries, 0 duplicates; while relay A holds a claimed batch, relay B publishes 50 other rows in 83 ms, 0 lock waits | PASS |
| Backoff | every publish refused | 1 | next attempt after 1.0, 2.0, 3.9, 7.9, 16.0 s; 60.0 s at attempt 11 (cap) | PASS |
| Durability across restart | failures recorded, relay process replaced | 1 | attempt counters continue (not reset), payloads intact, 10/10 published and consumed | PASS |
| Broker restart | container restarted with 100 persistent messages queued; again with a consumer attached and 200 in flight | 1 + 1 | 100/100 survive and are applied once; the attached consumer reconnects by itself (6.4 s) and 300/300 applied once | PASS |
| *App* service restart with backlog | broker down, 20 cancellations, Payment restarted, broker back | 1 | 20 pending before and after the restart; 20/20 applied once | PASS |

**Accounting (logical events → effects):** baseline 200/200; broker down 3 × 105/105 (120 attempts each); outage cycles 553/553 (593
attempts); lost confirm 20 events, 40 deliveries, 20 effects; cut mid-publish 20/40/20; duplicates 205/815/205; crash windows 60/60;
multi-relay 500/500/500; broker restart 300/300; app 20 + 30 + 20 + 15 cancellations, every one receipted once.

**Connections and channels:** one kit process = 1 publisher connection + confirm channel, 1 connection + 1 channel per consumer; Billing
live: 2 connections, 2 channels; after every recovery the same counts and exactly 1 consumer on the queue. DB clients held by a relay:
1 per relay, only while a pass runs; during a confirm stall that client is idle in transaction for up to `RABBITMQ_CONFIRM_TIMEOUT_MS`
(5 s) per row. Current defaults keep `RABBITMQ_CONFIRM_TIMEOUT_MS` (5 s) < `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` (60 s) as required.

**Log volume during outages:** kit relay 1 line/s; app: Payment 1.1 warn/error lines/s (`outbox_publish_failure`), Billing 0.7
(`rabbitmq_consumer_lost`, `…reconnect_failed`); credentials in logs: 0.

**Carried forward:** 15.4: relay throughput is one batch (50) per 1 s pass; a slow-but-confirming broker keeps a relay's transaction
(and its row locks) open for batch × confirm wait (observed 150 s at 3 s per publish; up to 250 s at the 5 s bound). 15.5: shutdown
during a broker freeze waits for the heartbeat (172 s) or forever with heartbeats off (the I9 finding). 15.6: while a broker is frozen
Billing's `rabbitmq-consumer` readiness check reports `consuming` (the separate `rabbitmq` check makes `/ready` 503). 15.7: log rates
above. 15.8: drain after an outage is paced by per-row backoff (12 s after a ~15 s outage); relay batch and interval; the per-probe
broker connection of `/ready`. A connection-closed publish failure is logged as `error=Error` without a `kind`.

### 13.3.1 Corrective patch for I9 (15.3)

The failure above is kept as found. This is the correction and its evidence.

**amqplib 2.0.1 semantics, from its source and `scripts/validation/amqp-semantics.mjs`** (a throwaway broker configured `heartbeat = 0`,
frozen with `docker pause`, each operation on its own connection, 20 s observation, client heartbeat 2 s where requested):

| Operation on a silent connection | No client heartbeat (the kit before) | Client heartbeat 2 s | Promise deadline 1.5 s + `stream.destroy()` |
|---|---|---|---|
| channel open; confirm channel + exchange declare; queue declare; consume; cancel | pending (20 s) | **rejected at ~5.9 s** (`Channel ended, no reply will be forthcoming`); connection `error: Heartbeat timeout`, `close` | still waited for the heartbeat (~5.9 s): destroying the socket does not end amqplib's connection or its pending operations |
| channel close; connection close | pending | **pending even after the heartbeat tore the connection down**: amqplib never settles a close waiting for its close-ok when the connection dies | pending |
| reuse after the broker answers again | a torn-down connection is never reusable (`Connection closed (Error: Heartbeat timeout)`) | same | same |
| late frames after teardown | no uncaught error in any case | none | none |

Negotiation (the client's request is honoured): broker at 60 s → none 60, 0 → 0, 5 → 5, 10 → 10, 120 → 60 (the smaller); broker at 0 →
client 10 gives 10 (when either side is 0 the greater value wins; RabbitMQ documents the same rule). amqplib checks for received traffic
every interval and fails the connection on the second consecutive miss, so detection takes 2–3 intervals.

**Design (evidence-based).**
- **A Core-owned heartbeat:** the bus requests `heartbeat` itself (option `heartbeatS`, default 10 s; `RABBITMQ_HEARTBEAT_S`, 5–60, in
  Billing and Payment; a directly constructed bus gets the same 10 s). It bounds every request/response operation at about 3 × the
  heartbeat on any broker, including one with heartbeats off. 10 s: RabbitMQ's guide calls 5–20 s optimal and warns that values under
  5 s are fairly likely to cause false positives; 0 is refused by configuration (it would hand the bound back to broker policy).
- **Bounded closes:** channel close, connection close and consumer cancel, on the shutdown path and in a failed re-attach, are awaited at
  most 3 × the heartbeat and then abandoned. By then a silent connection has been torn down; the close would never settle; nothing is
  reused (a new connection is opened on demand), so abandoning it cannot mix responses between operations.
- **Rejected:** general per-operation deadlines that destroy the socket. In this amqplib, destroying the socket does not end the
  connection's pending operations (they still wait for the heartbeat); doing it properly would drive private teardown internals; and the
  heartbeat already bounds every such operation with a Core-configured value. The publisher confirm keeps its own, shorter bound
  (`RABBITMQ_CONFIRM_TIMEOUT_MS`, 5 s < the ≥ 20 s heartbeat detection), unchanged.
- `describeFailure` classifies amqplib's teardown texts as `kind=broker_connection_lost` (`Heartbeat timeout`, `Channel ended, no reply
  will be forthcoming`, `Channel closed`, `Connection closed (…)`, and `channel closed`, which also fixes the kind-less log line of a
  publish whose connection was cut). Texts pinned against the installed amqplib.

**Tests.** `rabbitmq-silent-broker.int-spec` (kit, real RabbitMQ, frozen connection, heartbeat 1 s): negative control (no client
heartbeat: a publish needing a new channel still pending at 4 s); the same publish fails in < 4 s while the broker is still frozen,
`broker_connection_lost`, and the next one uses a fresh connection; a consumer is detected as lost in < 4 s, re-attaches, exactly one
consumer remains and it processes; closing is bounded for a publisher-only bus (Payment) and a publisher + consumer bus (Billing); a
directly constructed bus negotiates 10 s. Removing the heartbeat request fails four of them; removing the bounded close fails the close
test. Configuration tests in Billing and Payment (default, bounds, 0 refused); classification tests.

**Before / after** (the same campaigns; broker frozen after a confirm timeout discarded the channel):

| Experiment | Before | After (default heartbeat 10 s) |
|---|---|---|
| Relay pass needing a new channel (broker heartbeat 60 s) | 174.8 s, PostgreSQL had killed its transaction | **24.8 s**, `broker_connection_lost`; the attempt is recorded in the still-open transaction |
| Consumer detects the loss | 179.9 s | **29.8 s** |
| Broker with heartbeats off: same publish | pending at 240 s | **25.0 s** (negotiated 10 s) |
| Broker with heartbeats off: consumer close | pending at 240 s | **24.9 s** |
| Billing SIGTERM with the broker frozen, 3 runs each | 172 s | **27.8 s** [27.83–27.86]; heartbeats off: **27.9 s** [27.79–27.88] |
| Readiness during the freeze | 503 at 2.0 s | unchanged |

The shutdown time is the consumer cancel waiting for the heartbeat teardown (≤ 3 heartbeats), then bounded closes. It is finite and
Core-controlled, and still above Docker's 10 s stop grace (for 15.5).

**Full 15.3 matrix re-run after the patch: no regression.** 19 campaigns, every accounting 0 lost / 0 duplicate effects: baseline 200/200;
broker down 3 × 105/105 (drain 2.3–2.5 s); 5 outage cycles 563/563, always 1 consumer / 2 connections / 2 channels; confirm timeout
5.00 s, fresh channel 20/20; lost confirm and cut mid-publish 20 each, 2 deliveries → 1 effect; consumer transient / poison / permanent /
DLQ as before (good messages behind the poison in 15 ms); duplicates 815 → 205; crash windows A, B, C × 20; prefetch 10 held, 25
back; multi-relay 150/150/200 and SKIP LOCKED 137 ms with 0 lock waits; backoff 1–16 s, cap 60 s; broker restart 100/100 and 300/300; app
baseline, broker down (drain 7.3 s), Payment restart with backlog, 3 live outage cycles; credentials in logs 0.

### 13.4 Workers and concurrency (15.4)

**Question.** When worker passes, processes, service instances, consumers, retries and external callbacks run concurrently, does Core
keep one business effect per logical item, avoid unsafe ownership, make progress and recover from races? Correctness under the current
defaults only; nothing is tuned (batch, prefetch, pool and timeouts are the Stage 14/15 defaults unless a row says otherwise).

**Harness (test-only).** `scripts/validation/worker-campaigns.mjs` starts its own throwaway RabbitMQ and PostgreSQL (`validation-*`,
loopback) and removes them at the end. Three layers:
- **kit**: the real `OutboxService` → `OutboxRelay` → `RabbitMqEventBus` → `InboxService` path with per-event accounting
  (`lib/kit-world.mjs`, extracted from the 15.3 script, which now imports it; its 15.3 campaigns were re-run unchanged: baseline
  200/200, lost confirm 20 × (2 deliveries → 1 effect), crash windows A/B/C × 20); `lib/crash-relay.mjs` is a relay child that is
  SIGKILLed while it holds its claim;
- **Payment workers in process**: `AttemptResolver`, `WebhookRetriever`, `ExpirySweeper`, `AttemptService` and `IdempotencyService`
  built from `dist`, one `DbService` pool per simulated instance, so every lock is decided by PostgreSQL between separate sessions; a
  scripted provider with barriers stands in for the test provider where two resolvers must observe the same attempt;
- **live fleets**: N billing-service processes on one database and one broker, calling `lib/fake-payment.mjs` (Payment's create /
  get / cancel contract with its real natural-key semantics, plus hold, abort-unprocessed and process-then-drop-the-response hooks and
  counters of physical and concurrent calls per request); `paymentEventPublisher` publishes Payment's events to Billing's queue; two
  live payment-service processes for Payment's own workers. Only Billing's dispatch interval (300 ms), where a campaign needs it the
  stale-`sending` window (3 s), and the seeding rate limits are changed. No real provider is ever called.

Run: `node scripts/validation/worker-campaigns.mjs --out r.json [campaign ...]`; the reference run below is one full pass of all 23
campaigns (9 min 11 s), 0 uncaught errors or unhandled rejections, containers removed.

**Setup:** `main` at `a760c85` (Stage 15.3 merged: Core-owned heartbeat `RABBITMQ_HEARTBEAT_S`, bounded closes, confirm timeout 5 s,
silent-broker tests), PostgreSQL 16.15 and RabbitMQ 3.13 throwaway containers, reference machine of section 4. F2 still open.

**Invariants.** Physical attempts may exceed one; business effects may not.

| Id | Invariant |
|---|---|
| C1 | One logical work item → exactly one intended business effect |
| C2 | Exclusive claims where the design requires exclusivity; where it permits duplicate execution, a downstream key makes it safe |
| C3 | No lost work: every durable item ends in an allowed terminal or retry state |
| C4 | Business state and its bookkeeping (outbox, receipts, transitions) stay atomic; no race exposes a partial state |
| C5 | Idempotency holds under truly simultaneous attempts with the same key |
| C6 | One slow, locked or poisoned item does not stop unrelated work where the design claims it should not |
| C7 | No lock leak after success, failure, timeout, exception, process death or connection destruction |
| C8 | No worker multiplication inside a process after reconnects or recovery |
| C9 | Two or more instances of a service stay correct (no accidental singleton assumption) |
| C10 | Retry state is monotonic: attempts never decrease, terminal work is never resurrected or overwritten by a stale attempt |
| C11 | No cross-tenant write |
| C12 | A dependency timeout never lets a second worker start conflicting work while the first can still commit an incompatible effect |
| C13 | Accounting balances: logical input, physical attempts, effects, retries, terminal failures, pending |

**Worker inventory and concurrency model (current source, after 15.2 and 15.3).** Models: A exclusive DB claim (waits), B SKIP LOCKED
work stealing, C optimistic / idempotent concurrent execution, D singleton assumption, E external-provider reconciliation.

| Service | Worker | Interval / batch | Claim | Transaction | External I/O | Retry / terminal | Idempotency | Model |
|---|---|---|---|---|---|---|---|---|
| kit (Billing, Payment) | `OutboxRelay` | 1 s / 50 | `FOR UPDATE SKIP LOCKED`, `ORDER BY occurredAt, id` | the whole batch | **inside**: publish + confirm (≤ 5 s each) | backoff 1 s × 2ⁿ ≤ 60 s, unlimited; first failure ends the pass | consumer inbox | B |
| kit | `PollLoop` (all workers) | – | – | – | – | next pass | – | a pass never overlaps the next (measured) |
| Billing | `PaymentDispatcher` | 2 s / 50 | `FOR UPDATE SKIP LOCKED` on `created` or stale `sending`; row set to `sending`, `sendingSince` stamped | the claim only | **outside**: one create per row, **sequential**, after the claim commits | stale `sending` reclaimed after 60 s; `rejected` terminal | Payment's natural key `(producer, paymentRequestId)` | B + C |
| Billing | `PaymentReconciler` | 30 s / 50, cursor | none | per request (`applyPaymentEvent`) | GET Payment, outside | next pass | deterministic event id → `payment_event_receipt` | C / E |
| Billing | `billing.payment-events` consumer | push, prefetch 10 | – | per event: receipt + effect | none | 3 × 5 s, then DLQ | `payment_event_receipt` (unique event id) | C |
| Billing | settlement → subscription roll (inside the consumer's transaction) | – | `FOR UPDATE` invoice → payment request, then subscription per organization | same transaction | none | – | the receipt | A |
| Payment | `AttemptResolver` | 5 s / 100 | **none** (by design) | per attempt, after the provider call | provider fetch **before**, outside | next pass | state-machine guards under `FOR UPDATE` payment → attempt | E + C |
| Payment | `WebhookRetriever` | 5 s / 100 | `FOR UPDATE SKIP LOCKED` + observed-`attempts` claim | per event | none (reprocessing is local) | 10 attempts, 10 s × 2ⁿ; `retries_exhausted` terminal | observed-attempt claim | B |
| Payment | `ExpirySweeper` | 5 s / **all due, unordered** | `FOR UPDATE` per payment (**waits**) | per payment | none | next pass | status re-checked under lock; refuses while an attempt is open | A |
| Payment | HTTP `Idempotency-Key` (create payment, start attempt) | – | unique key row | with the operation | – | replay | `idempotency_key` + natural key | C |

No worker relies on a singleton assumption (model D): every one was run with 2–4 instances below.

**Lock order (from source).** Billing: invoice → payment request (issue, request creation, event application); paths that lock only a
payment request (dispatch claim, `markRequested`, `markRejected`, cancel) never lock the invoice afterwards; the subscription is locked
last, per organization. Payment: payment → attempt (resolver apply, attempt start, webhook reprocessing); the sweeper locks the payment
alone. No opposing order exists in production code, so the deadlock campaign is the 0 `deadlocks` counter of `pg_stat_database` sampled
in every campaign rather than a manufactured SQL pattern.

**Results** (every accounting balanced; 0 duplicate effects, 0 lost items, 0 deadlocks in every campaign):

| Campaign | Setup | Iterations | Observed | Result |
|---|---|---|---|---|
| PollLoop overlap | pass 150 ms, interval 50 ms | 10 passes | max 1 pass at a time; next pass starts 50 ms [49–51] after the previous **ends** (serial, never overlapping) | PASS (C8) |
| Multiple relays | 1, 2, 4 relays, 1000 rows (20 batches) | 3 | split [1000], [500, 500], [250 × 4]; drain 2272 / 1043 / 681 ms; every row `attempts` 1, published once, 0 lock-wait sessions; 1000 → 1000 effects each | PASS (C1, C2, C6) |
| Slow-broker contention | relay A's confirms slowed (test proxy), relays B, C free, 220 rows | 1 | A holds 50 rows (1 lock, 1 session idle in transaction) for **20.4 s**; B and C publish the other 150 in 283 ms, never A's rows; unrelated business transactions 1 ms; 220 → 220 | PASS; lock duration → 15.8 |
| Concurrent duplicate delivery (kit) | same event id released by a barrier into 3 consumers | 20 × 100 events | 300 simultaneous deliveries → 100 inbox accepts → 100 effects | PASS (C5) |
| Relays + consumers + broker interruption | 2 relays, 2 consumers, 3 broker stop/start cycles, continuous traffic | 3 cycles | every cycle: 2 queue consumers, 4 connections, 4 channels (no multiplication); 472 events, 521 publish attempts, 472 deliveries, 472 effects | PASS (C3, C8) |
| Relay SIGKILLed holding its claim | child relay claims 50 rows, publish never resolves, SIGKILL | 5 | row locks released 12–26 ms after the kill; another relay published them in 265–308 ms; 300 → 300 | PASS (C7) |
| Outbox retry race | relay A's publish fails while relay B polls the same due row | 20 | B never took the row A held; attempts 1 after A's failure, 2 final; all published | PASS (C10) |
| AttemptResolver races | 2 resolvers, same `unknown` attempt, both provider calls released by one barrier; pairs succeeded/succeeded, succeeded/failed, failed/succeeded, pending/succeeded, notFound/succeeded | 20 per pair (100) | both call the provider (by design); the first commit wins under the payment → attempt locks, the second is refused by the state machine (logged `attempt_resolver_failure`, 40 lines, left for the next pass); contradictory pairs end 11/9 and 9/11 by commit order, always a legal pair (`succeeded`/`succeeded` or `failed`/`created`); ≤ 1 `payment.succeeded` per payment, never two terminal events | PASS (C1, C4, C10) |
| AttemptResolver amplification | 10 unresolved attempts, 1 / 2 / 4 resolvers, one pass each | 1 | provider calls per attempt per pass = number of resolvers (10 / 20 / 40) | PASS; provider load → 15.8 |
| Webhook retrier races | 3 retriers, rows success / slow / transient / exhausting / fresh | 20 rounds | max 1 concurrent reprocess per row; 39 rows `retries_exhausted`, each once (a row made fresh in one round exhausts in a later one); attempts never above 10; 3 `payment.succeeded` per round (one per success row) | PASS (C2, C10) |
| Expiry sweepers | 3 sweepers, 200 due payments of 20 organizations | 1 | 200 expired once, 200 events; 20/20 organizations fully expired; 486 ms | PASS (C1, C11) |
| Sweeper head-of-line | one due payment row locked by another transaction; 3 sweepers over 30 due payments (30 organizations) | 1 | **all 3 sweepers wait on the one lock: 0 of 30 expired in 3 s**; 30/30 once the lock is released | PASS for correctness; availability → 15.8 (below) |
| Expiry boundary | attempt start and sweep fired ±15 ms around `expiresAt` | 20 | 10 expired (start refused), 9 started (not expired: open attempt), 1 start refused before the sweep saw it due (left `created` for the next pass); never expired with an open attempt | PASS (C4) |
| Payment idempotency | create with the same request 5 × simultaneously; attempt start with the same key 5 ×; 20 distinct keys | 20 + 20 + 20 | same key: 1 row, 1 id returned to all 5, 1 fresh; distinct keys: 20/20 ok (no false collapse) | PASS (C5) |
| DB timeout under contention | sweeper B blocked by A's lock, `statement_timeout` 1 s (test value) | 20 | B fails `57014 db_statement_timeout` at 1008 ms [1005–1076]; 0 sessions left idle in transaction; the payment expired once by a later pass | PASS (C7, C12) |
| *Live* Billing dispatch | 1 / 2 / 3 instances, 60 requests | 3 | split [60], [41, 19], [31, 21, 8]; 1 create per request, max 1 concurrent; payment ids match | PASS (C9) |
| *Live* dispatcher stale race | 3 instances, stale 3 s, 20 requests; Payment holds each create 1.5 s (below stale) and 4.5 s (above) | 2 × 20 | **1–3 creates per request and up to 3 at the same time even below stale** (below); 1 payment per request, ids match, all `requested` | PASS (natural key); finding below |
| *Live* dispatcher crash windows | 1 instance killed while its creates are at Payment, then a new instance (stale 3 s); C: Payment never processes them; D: Payment creates, the response is lost | 4 rounds × 5 each | 20/20 `requested` per window, 1 payment per request whose id matches; 1–3 creates per request | PASS (C3, C12) |
| *Live* competing consumers | 3 Billing instances, 90 settlements, 15 organizations | 1 | applied 31 / 34 / 25; 90 receipts, 90 invoices paid, 90 transitions; 3 queue consumers; 0 cross-tenant rows | PASS (C9, C11) |
| *Live* duplicate delivery race | each settlement event published 3 × at once to 3 instances | 20 × 5 | 100 receipts, 100 invoices paid, 0 dead letters | PASS (C5) |
| *Live* dual-path settlement | event and reconciler settle the same payments concurrently | 20 | 20 paid once: 20 receipts `applied`, 17 `ignored`; 44 reconciler GETs | PASS (C1) |
| *Live* same-organization subscription | 2 recurring invoices per organization paid at once | 20 organizations | 20 active subscriptions, period exactly [T + 1 month, T + 2 months], each on its own organization's product, 0 conflicts | PASS (C4, C11) |
| *Live* restart under competition | 2 instances; SIGKILL A mid-dispatch, restart it | 3 cycles, 36 requests | 36/36 paid, 0 stuck, 36 payments; 2 instances, 2 queue consumers after each cycle | PASS (C8, C9) |
| *Live* pool pressure | 2 instances dispatching a 150-request backlog, HTTP reads alongside | 1 | reads 4.3 ms [1.8–16.1]; at most 4 database sessions of 20 configured | PASS |
| *Live* Payment × 2 | 2 payment-service processes, 40 expiring payments, 10 webhooks on their last attempt | 1 | 40 `payment.expired`, each published and delivered once; each webhook's 10th attempt made by one instance (`webhook_retry_unresolved` × 10), the terminal `retries_exhausted` written once by the other's next pass (× 10) | PASS (C9, C10) |

**Accounting (logical → physical → effects).** Multi-relay 3 × 1000 → 1000 attempts → 1000; slow broker 220 / 220 / 220; kit duplicate
race 100 events, 300 deliveries, 100 effects; interruption 472 events, 521 attempts, 472 deliveries, 472 effects; relay crash 300 / 300 /
300; resolver 100 races, ≤ 1 success event each; webhooks 39 exhausted transitions = 39 rows; sweep 200 → 200 events; dispatch 60 →
60 creates (1–3 instances); stale race 40 requests → 40 payments (more creates); crash windows 40 → 40 payments; consumers 90 → 90;
duplicate race 300 deliveries → 100; dual path 37 receipts → 20 effects; subscriptions 40 invoices → 20 subscriptions.

**Findings (correctness intact; carried).**
- **Dispatcher: the stale window is per batch, not per call (15.8, and the section 2 relationship corrected).** An instance claims up
  to 50 rows and stamps `sendingSince` on all of them at once, then sends them one after another outside the transaction. Rows late in
  the batch go stale while still queued behind earlier sends, so another instance reclaims and sends them too: up to 3 concurrent
  creates per request with a 1.5 s hold and a 3 s window. Payment's natural key returns the same payment every time (1 payment per
  request, the recorded id always matches), so it costs duplicate calls, not money. It stays safe only while every Payment deployment
  enforces the natural key. With defaults it needs ~60 s of sends in one batch (e.g. 50 × 1.2 s).
- **ExpirySweeper head-of-line (15.8).** The sweeper selects every due payment, unordered and unbounded, and takes each with a
  waiting `FOR UPDATE`, so one payment held by another transaction stops every sweeper instance, and every other organization's
  expiries behind it, for up to `DB_STATEMENT_TIMEOUT_MS` (30 s); the timeout then fails the whole pass. The lock itself is needed:
  it is what serialises expiry against an attempt start (boundary campaign). Production transactions on a payment are short, so this is
  availability, not correctness. `SKIP LOCKED` or a per-row lock timeout are the options for 15.8.
- **AttemptResolver amplification (15.8; product decision in section 16).** N instances → N provider status calls per unresolved
  attempt per 5 s pass; both write attempts are serialised and the loser is refused, so state is safe.
- **Relay lock duration under a slow broker (15.8).** Confirmed from 15.3: a slow but confirming broker holds a relay's 50 row locks and
  one pool client for batch × confirm time (20 s here); other relays keep publishing other rows.
- **Minor:** every Billing receipt records `causeType` `payment_event`, including the reconciler's, so the path is not visible in the
  receipt (15.7); the sweeper logs no line per expired payment (only the event exists) (15.7).

**Logs and correlation (15.7 input).** Worker lines carry the worker, the item (`attempt=`, `event=`, `request=`), the provider or
failure `kind` and a per-pass correlation id; the instance is the process (one log stream each). Live runs, per instance: Billing
competing consumers 89–114 lines, 0 warn/error; restart under competition 42–65 lines, 2 warn (`payment_dispatch_stale_recovery`, the
killed instance's rows reclaimed); Payment pair 39 lines each, 10 warn (`webhook_retry_unresolved`) on one and 10 error
(`webhook_retry_exhausted`) on the other. Lines containing a service token, the database password or the credentialed broker URL: **0**
in every instance. Resource check across cycles: queue consumers and broker connections / channels return to one per instance after
every broker cycle and restart; 0 sessions idle in transaction after every timeout; relay and resolver loops never exceed one per process.

Crash window A (before the claim commits) leaves nothing durable (the request stays `created`); window B (claimed, not sent) is the
state of every row an instance had claimed but not yet sent when it was killed; window E (`markRequested` committed) is final and never
reclaimed (every live run). Retry state (C10): outbox attempts only increase and a row is never taken while locked; webhook attempts
stop at 10 and `retries_exhausted` is written once; resolver writes after a terminal state are refused.

### 13.5 Shutdown and restart (15.5)

**Question.** When a service gets SIGTERM, `docker stop`, SIGKILL or a restart while real work is in flight, does it stop within a
Core-controlled bound without losing durable work, corrupting state, duplicating a protected effect, leaking resources or needing manual
repair? Graceful-shutdown results and correctness results are reported separately: a SIGKILL after the grace period followed by a
clean recovery is a correctness PASS and a graceful-shutdown finding.

**Harness (test-only).** `scripts/validation/shutdown-campaigns.mjs` (17 campaigns) on the Stage 15 harness:
- `lib/live-core.mjs` starts services from `dist`, signals them and rebuilds the shutdown timeline from their own log lines while
  probing `/ready` and `/health` every 25 ms on fresh connections (see F-A: a pooled keep-alive probe would itself hold the server open);
- `lib/payment-world.mjs` is the 15.4 in-process Payment layer, moved into a shared module (15.4's Payment campaigns re-run unchanged);
- the fake Payment gained a cancel hook;
- container campaigns run `validation-<service>:15-5` images built from this checkout (same Dockerfile, `node dist/main.js` as PID 1,
  default stop signal) on a `validation-net-*` network;
- barriers inside transactions are test-only triggers in throwaway databases, released through advisory locks;
- a frozen database is a TCP proxy that stalls server-to-client traffic; a frozen broker is `docker pause`;
- a kill as PostgreSQL sees it is `pg_terminate_backend` of one simulated instance's sessions.

Reference run: all campaigns in one pass (54 min), 0 uncaught errors, every `validation-*` container and network removed. `main` at
`804dc72` (15.2 query deadline, 15.3 heartbeat and bounded closes, 15.4 tooling present); F2 open.

**Invariants.** S1 SIGTERM handled; S2 new work stops; S3 every in-flight operation ends completed, rolled back, retryable, redelivered
or reconciled, never silently lost; S4 no partial transaction; S5 no outbox loss; S6 ack only after durable success; S7 worker drain
bounded; S8 no dependency (or client) makes shutdown unbounded; S9 pool close bounded; S10 broker close bounded; S11 SIGKILL after the
grace period recoverable; S12 restart needs no repair; S13 one protected effect; S14 no resource multiplication; S15 readiness truthful.

**Shutdown order (Nest 12.0.3, from its source; verified by the logs).** `enableShutdownHooks()` listens to every signal; one shutdown
runs at a time (a second signal is ignored). Each step:
1. `prepareClose`: the Express adapter marks itself closing. No effect: its 503-on-closing option is not enabled.
2. `onModuleDestroy` (all modules): `service_shutdown_started`. **Auth closes its database pool here, while its HTTP server still
   serves.**
3. `beforeApplicationShutdown`: **modules one after another**; inside one module, providers of the same dependency level in parallel.
   - Every worker `stop()`: `PollLoop` drain, at most 5 s.
   - Billing's consumer: cancel (≤ 3 × heartbeat), in-flight deliveries drain (≤ 5 s), channel close (≤ 3 × heartbeat).
   - **HTTP still accepts connections and `/ready` still answers 200.**
4. `dispose`: HTTP `server.close()`. No socket is force-closed (`forceCloseConnections` is off). Node closes the connections idle at
   that instant and waits for the others, with no bound.
5. `onApplicationShutdown`: modules one after another.
   - **Every worker `stop()` again**: a pass still hung is waited for a second time.
   - Consumer close (idempotent).
   - Relay `stop()` again, then `bus.close()`: publisher and connection close, each ≤ 3 × heartbeat.
   - `DbService` `pool.end()` waits for checked-out clients, bounded only by `DB_QUERY_TIMEOUT_MS`.
   - `service_shutdown_complete`.
6. Nest re-raises the signal. Outside a container it terminates the process. Inside a container, as PID 1, it is ignored and Node exits
   when its event loop is empty (exit 0).

**Theoretical budget at the defaults (worst case, Billing / Payment).**

| Step | Bound | Sequential with | Billing | Payment |
|---|---|---|---|---|
| worker drains, `beforeApplicationShutdown` | 5 s per module with a hung pass | modules sequential | 2 modules (dispatcher/reconciler/consumer; relay) ≤ 10 s | 4 modules (resolver, retrier, sweeper, relay) ≤ 20 s |
| consumer cancel + drain + channel close | 3 × `RABBITMQ_HEARTBEAT_S` + 5 s + 3 × heartbeat | the drains | ≤ 65 s | – |
| HTTP close | **none** (longest in-flight request; a busy keep-alive connection: unbounded) | everything | ≤ 35 s per in-flight DB-bound request, else ∞ | same |
| worker `stop()` repeated, `onApplicationShutdown` | 5 s per module again | modules sequential | ≤ 10 s | ≤ 20 s |
| bus close | 3 × heartbeat per close | – | ≤ 30 s measured | ≤ 30 s measured |
| pool close | `DB_QUERY_TIMEOUT_MS` (35 s) per stuck client | – | ≤ 35 s | ≤ 35 s |

The waits overlap in practice (one stuck resource usually explains all of them), so the measured worst cases are 28–35 s, but no single
Core setting bounds the total, and the HTTP step has no bound at all.

**Deployment contract (repository).**
- Auth is the only deployed service.
  - `provision-and-deploy.sh` stops the old container with plain `docker stop` (SIGTERM, Docker's default 10 s grace, then SIGKILL),
    renames it, then starts the new one: **not a rolling deploy; downtime between the two**.
  - It has no `--stop-timeout` and no `--init` (Node is PID 1), with `--restart unless-stopped`.
- Billing, Payment and Organization have **no production deployment definition** (unknown production setting).
- Compose sets no `stop_grace_period`, so the default of 10 s applies.
- The Dockerfiles set no `STOPSIGNAL` (SIGTERM).
- Classification: **implicit / default-dependent** (10 s) for Auth and compose; **unknown** for the other services.

**Results** (every correctness row: 0 lost, 0 partial, 0 duplicated effects; 0 sessions idle in transaction and 0 locks after every
death; no manual repair):

| Campaign | Runs | Observed | Graceful | Correct |
|---|---|---|---|---|
| Idle SIGTERM (Auth, Organization, Billing, Payment) | 3 each | exit 21 / 22 / 26 / 18 ms (medians); `/ready` refused from the HTTP close on | yes | – |
| Idle `docker stop` | 3 each | 0.36–0.40 s, exit 0 (PID 1 exits cleanly) | yes | – |
| HTTP request in flight (Billing `issue` waiting on a row lock) | 1 + 1 | released at 2 s: request completes 200, invoice issued, exit 2.05 s; never released: 500 at the 30 s statement timeout, invoice still `draft`, exit 30.0 s | bounded by the request | PASS |
| **Keep-alive connection busy at SIGTERM** (`/ready` in flight, client continues on the same connection) | 3 + 3 | **never exits while the client continues** (20 s observed, ~286 requests served, all `/ready` 200), exits 6.1 s after the client stops; controls: idle keep-alive 13–28 ms, fresh connections 44–73 ms | **no bound** | – |
| Auth requests across SIGTERM | 3 | pool closed first: `/auth/health` 503 until the HTTP close (2 of 3 runs saw 1–2 × 503) | yes | see F-C |
| Consumer transaction windows (A lock wait, B after first mutation, C inside COMMIT) × SIGTERM with barrier released in drain | 20 each | commits, acks, not requeued; exit 1.08–1.09 s | yes | PASS |
| same × SIGKILL | 20 each | A, B: rolled back, requeued, applied once after restart; **C: COMMIT completes on the server after the client died, message requeued (ack never sent), redelivery finds the receipt: 1 effect** | – | PASS (S4, S6, S13) |
| same × SIGTERM, barrier held | 3 each | A, B: exit 30.0 s (statement timeout); C: **35.0 s** (the wait inside COMMIT is not cancelled by `statement_timeout`; the 15.2 client deadline ends it; the commit then completes, redelivery deduplicated) | 30–35 s | PASS |
| Outbox K (claimed, no channel yet) / L (published, confirm pending), broker answers during drain | 20 each | published before exit, 1 attempt, exit 1.0–1.1 s | yes | PASS |
| same, broker never answers | 3 each | row pending (1 attempt), next instance publishes; exit 35.0 s (K once 5.0 s) | 35 s | PASS (S5) |
| Outbox accounting | 46 + 23 warm | 69 events → 69 receipts → 69 cancellations, 0 pending | – | PASS |
| Dispatcher (fake Payment holds the batch's first create): answers in drain / processes then loses the response / never answers | 20 / 20 / 3 | exit 1.05 / 1.05 / 5.04 s (the old pass keeps sending the rest of its batch while draining); new instance: every request `requested`, 1 payment each, id matching | yes | PASS |
| Sweeper waits for a row lock: released in drain / never | 3 / 3 | exit 1.04 s, expired once / **exit 30.0 s** (drain 5 s, repeated stop 5 s, pool close waits for the statement timeout); expired once after restart | 30 s | PASS |
| Sweeper killed inside its expiry transaction | 20 | rolled back (`created`, 0 events), expired once with 1 event after restart | – | PASS |
| Resolver: provider call in flight at shutdown / killed during resolution | 20 / 20 | drain times out 5.0 s, the late answer cannot write (pool closed), attempt stays `unknown`; next instance: `succeeded`, 1 terminal event | – | PASS |
| Retrier killed before bookkeeping commits / on the 10th attempt | 20 / 20 | attempts not consumed (3 → 3; 9 → 9), then monotonic (→ 5; → 10 and `retries_exhausted` once) | – | PASS (C10) |
| Frozen PostgreSQL, statement timeout 2 s / defaults | 3 + 1 per service | 11.8–11.9 s / **Billing 28.8 s, Payment 31.9 s**: drain timeouts at 5, 10, then again at 15, 20 s (modules sequential, stop repeated), then the pool waits for the query deadline | ≤ 32 s | PASS (S7, S9) |
| Frozen RabbitMQ (broker heartbeat 60 s / disabled) | 3 each | Billing 27.7 s both; Payment with a publish in flight 35.1 s both (confirm 5 s, then heartbeat-bounded closes) | ≤ 35 s | PASS (S10) |
| `docker stop`, broker frozen (Billing, Payment) / keep-alive busy / sweeper on a lock | 3 each | **SIGKILL at 10.3–10.5 s (exit 137)**; after `docker start`: ready in 0.7–1.2 s, the pending outbox row published, 1 consumer, expired once | **no** | PASS (S11) |
| Dependency down at startup (PostgreSQL; RabbitMQ; schema missing) | 1 each | stays alive, `/ready` 503, `/health` 200 (Auth: 503), becomes ready **in the same process** 30–360 ms after the dependency returns; **Billing with RabbitMQ down exits 1** (`connect ECONNREFUSED`, no `kind`); Payment starts unready and recovers | – | PASS (restart policy needed for Billing) |
| Normal startup | 3 each | no HTTP answer before ready: connections refused until the first 200 (Billing 0.64 s, Payment 0.58 s) | – | PASS (S15 at startup) |
| Restart cycles under traffic: 10 SIGTERM + 10 SIGKILL of Billing and Payment | 20 | every cycle: 1 queue consumer, 3 broker connections, 3 channels, sessions 2–7 (no growth); back ready in 0.68–0.77 s; ~360 requests: 1 payment each, every applied cancellation once, **1 request left open** (see F-B) | yes | **F-B** |
| Rolling restart, Billing ×2 + Payment ×2 behind a failover proxy | 3 rounds | 140/140 cancelled once, 2 consumers throughout, no leaks; 5 client errors (connections refused by the instance being stopped) | yes | PASS (S14) |
| Full backlog restart | 1 | 60 outbox rows, 30 unsent requests, 30 queued messages, 20 due webhooks: all drained after a full stop and start, each effect once (59 s, paced by outbox backoff) | – | PASS (S12) |
| Repeated `stop()` on a hung pass | 1 | first 5.0 s, second **another 5.0 s**; two concurrent calls 5.0 s together | – | – |

**Finding F-A (FAIL, S2 / S8 / S15): the HTTP drain has no Core-controlled bound.** Nest closes the HTTP server only after every worker
has drained, and then only with `server.close()`, which waits for open connections forever: a keep-alive connection that is busy at that
instant keeps serving new requests (and `/ready` keeps answering 200) for as long as its client uses it. A reverse proxy's pooled
upstream connections (Traefik) or Billing's own `fetch` connections to Payment are such clients under steady traffic. In containers the
10 s grace then ends it with SIGKILL, and recovery is correct, but the bound is Docker's, not Core's. Until the HTTP close, `/ready` is
200 during the whole shutdown (workers already stopped). Reproducer: campaign `keepAlive` (6/6), `dockerStop` (3/3 SIGKILL).
Corrective directions (not implemented):
- from the start of shutdown, `/ready` answers 503 and every response carries `Connection: close`;
- close the HTTP server early, with a Core deadline (for example `HTTP_DRAIN_TIMEOUT_MS`), then close all remaining connections
  (`closeAllConnections()`).

**Finding F-B (FAIL, S3): a cancellation accepted while Payment is unavailable is silently lost.** Billing's cancel endpoint stamps
`cancelRequestedAt` and calls Payment once. It ignores the outcome (`transient` on a network error, timeout or 5xx) and answers 200
("cancellation requested"). Nothing sends it again: the reconciler only reads Payment, which still reports a non-terminal payment. The
producer believes the cancellation is under way; the payment stays open and payable. Found in the restart cycles: 1 of ~360 requests
was left open in 2 of 3 runs. The diagnosed one got a 200 from Billing while Payment, restarting, never cancelled it. Deterministic
reproducer `cancelDuringPaymentOutage`, 5/5:
- Payment answers 503 and Billing still answers 200;
- after 10 s and 9 reconciler reads the payment is still `pending`, and Payment received exactly 1 cancel call;
- a client retry of the same call heals it, but the client was told it had succeeded.

Corrective directions (not implemented):
- answer 503 (retryable) when Payment's outcome is not a confirmed cancel, keeping the marker so a retry is a safe replay; and/or
- a durable retry: a worker re-sends the cancel for requests with `cancelRequestedAt` whose payment is not terminal.

**Other findings (correctness intact).**
- **F-C (Auth):** the pool is closed in `onModuleDestroy`, before the HTTP server closes. A request that arrives or is in flight during
  shutdown gets 503/500. Direction: close it in `onApplicationShutdown`, as the kit does.
- **F-D:** worker drains are **sequential across modules and repeated**: every worker's `stop()` runs in both hooks, and a hung pass is
  waited for twice (measured 5 + 5 + 5 + 5 s). Direction (option C): one drain per worker (a second `stop()` returns the first's
  outcome), started concurrently.
- **F-E:** the pool close waits for a stuck client up to `DB_QUERY_TIMEOUT_MS` (35 s). The broker closes take up to 3 × heartbeat
  (Billing 27.7 s, Payment 35 s). Both are bounded, and both are above the 10 s grace.
- **F-F:** Billing exits at startup when RabbitMQ is unreachable, while Payment and every database outage start unready and recover in
  place. It depends on the restart policy (`unless-stopped` in the Auth deploy; nothing defined for Billing), and the crash line has no
  `kind`.
- **F-G (15.7):** Auth rate-limits `/auth/health` (429 when probed 4 times a second). A late write on a closed pool logs `error=Error`
  with no `kind`.

**Stop-grace conclusion (for review, not implemented).**
- Correctness does not need a longer grace: every SIGKILL window recovered without loss, duplication or repair (S11, S12).
- Gracefulness does. Measured graceful worst cases are 28–35 s (frozen broker, frozen database, a lock or COMMIT that never ends), plus
  the unbounded F-A.
- Recommendation: **option D**.
  1. Bound the HTTP drain in Core (F-A).
  2. Make drains single and concurrent (F-D, option C), which removes 15–20 s.
  3. Optionally a bounded pool close at shutdown.
  4. Then declare an explicit grace in every deployment: `docker stop -t` / `--stop-timeout`, and compose `stop_grace_period`. The
     grace must be greater than the maximum graceful shutdown plus a margin. With today's bounds, that means at least 45 s; after 1–3,
     about the heartbeat bound (≈ 30 s) plus a margin.
- Reducing the heartbeat or the query deadline to fit 10 s (option A) trades false broker-loss detections and early query cancellation
  for speed, and is not recommended from this evidence.

**Answer: deploying a new version while Billing and Payment work (measured).**
- The old container gets SIGTERM:
  - Its workers finish their current pass or give up after 5 s each, one module after another, and do it again in the second hook.
  - The consumer stops taking deliveries and lets in-flight ones settle.
  - HTTP keeps serving until the drains end, and longer if a client keeps a keep-alive connection busy (F-A).
- Docker allows 10 s, then SIGKILLs. That happens whenever the broker or database is stuck, a worker waits on a lock, or a keep-alive
  client stays busy.
- In every case measured, the new container recovered all durable work without manual intervention or duplicate effects:
  - outbox rows are published;
  - unacknowledged messages are redelivered and deduplicated by receipt;
  - claimed payment requests are reclaimed and resent under Payment's natural key;
  - unresolved attempts, due webhooks and expiries are resumed.
- The exception is F-B: a cancellation accepted by Billing while Payment was down is lost unless the client retries.
- The current Auth deploy stops the old container before starting the new one, so each deploy is also an outage.

### 13.5.1 Corrective patch (15.5)

Section 13.5 is kept as found (FAILED on F-A and F-B). This is the correction and its revalidation. Both preserved reproducers were
re-run on the unchanged source first: `keepAlive` still hung 6/6; `cancelDuringPaymentOutage` still answered 200 with the payment
payable 5/5.

**F-A: the HTTP drain had no Core bound.**
- **Root cause (from the Nest 12.0.3 and Node sources):**
  - Nest closes the HTTP server only in `dispose()`, after every `beforeApplicationShutdown`.
  - It closes it with `server.close()`, which closes only the connections idle at that instant and then waits for the others. It does
    not force-close sockets unless `forceCloseConnections` is set.
  - A keep-alive connection busy at that instant keeps being served, and `/ready` knew nothing about shutdown.
- **Selected design** (kit `HealthModule`, `HttpDrain` + `ShutdownState` + `shutdownAdmission`). At `onModuleDestroy`, the first
  shutdown hook:
  1. The service is marked draining. `/ready` answers 503 (`shutting_down`, without running the checks). The first middleware refuses a
     new request with 503 and `Connection: close`; `/health` is still answered, so liveness stays distinct from readiness.
  2. `server.close()` and `closeIdleConnections()` run at once, in parallel with the worker drains.
  3. After `HTTP_DRAIN_TIMEOUT_MS`, `closeAllConnections()` runs and `http_drain_timeout` is logged if anything was still open. The
     setting defaults to 5000 ms (500–120000, validated at startup, same default as the worker drain), for all four services; Auth reads
     it through its own config with the kit's bounds.
  4. Nest's own `dispose()` then finds the server closed. A second `close()` resolves as soon as the last connection is gone, so it does
     not hang (verified).

  Node 22 (container) and 24 (local) both provide `closeIdleConnections` / `closeAllConnections`: no custom connection manager.
- **Rejected alternatives:**
  - Nest's `forceCloseConnections`: destroys every socket, in-flight requests included, only at `dispose()`, after the worker drains.
  - Nest's `return503OnClosing`: flags only from `prepareClose`, and does not bound the drain.
  - `Connection: close` alone: bounded only per connection; a hung request would still hold the server.
  - A periodic `closeIdleConnections`: racy.
- **Tests:**
  - `libs/service-kit/test/http-drain.spec.ts`:
    - an in-flight request completes;
    - the next request on the same keep-alive socket gets 503 `shutting_down`, `Connection: close`;
    - new connections are refused;
    - liveness 200 / readiness 503 during the drain;
    - a hung request is cut at the deadline;
    - a continuously sending client cannot extend shutdown.
  - Config tests for the bounds (kit and Auth).
  - **Mutation:** removing `HttpDrain` fails 3 of the 4 drain tests; the hung request never ends.

**F-C: Auth's pool closed first.**
- Auth's `DbService` closed its pool in `onModuleDestroy`, the first hook, while HTTP still admitted requests.
- It now closes in `onApplicationShutdown`: after the HTTP server has closed and the drain has ended, as in the kit.
- Test: `apps/auth-service/test/shutdown-order.e2e-spec.ts` queries the database from `beforeApplicationShutdown`, the drain window.
  - it passes, and the pool is closed after shutdown;
  - **mutation:** the hook moved back to `onModuleDestroy` fails the test.

**F-D: drains sequential and repeated.**
- **Root cause:**
  - Every worker service called `stop()` in `beforeApplicationShutdown` and again in `onApplicationShutdown`.
  - `PollLoop.stop()` raced the still-running pass against a fresh 5 s timer each time.
  - Nest runs each hook module by module.
- **Selected design:**
  - `PollLoop.stop()` is **idempotent**: the first call's drain is stored, and every later or concurrent call returns it. `start()`
    resets it.
  - Each worker service **starts** its drain in `onModuleDestroy`, which Nest runs for every module before any
    `beforeApplicationShutdown`, and awaits the same promise in the later hooks. Billing's consumer close is handled the same way.
- **Concurrent:** relay, dispatcher, reconciler, consumer, resolver, retrier and sweeper. None of them depends on another's drain: a pass
  that writes an outbox row after the relay stopped leaves it pending, which is durable and published on the next start.
- **Still ordered, after every drain:** the bus close and the pool close, in `onApplicationShutdown`.
- **Tests:** PollLoop idempotency, one budget and one notice (**mutation:** a non-idempotent `stop()` fails it). Measured: repeated
  `stop()` on a hung pass 5.0 s + **0 ms** (before 5.0 + 5.0 s); frozen database, Billing and Payment workers all time out at
  **5.0 s together** (before 5, 10, 15, 20 s).

**F-B: the cancellation contract.**
- **What the endpoint promises (SDD 17.3, 21.2, endpoint 15):**
  - a never-sent request is cancelled locally;
  - for a sent one, "cancellation requested at Payment": Billing calls Payment's cancel synchronously with the deterministic key
    `billing-cancel-{paymentRequestId}` (a retry is a replay), and the request's terminal state arrives by `payment.cancelled` or the
    reconciler, never from the response;
  - if Payment refuses because money may be in flight: `409 payment_request_in_flight`;
  - if Payment is already terminal: no error.
- **Ownership:** Billing owns the commercial intent; Payment executes the cancellation and emits the single terminal event.
- **Pending state:** the only one is `cancelRequestedAt`, an informational marker that nothing ever re-sent from.
- **Payment's side:** the cancel is idempotent by key and refused while an attempt is open. Cancel versus success serialises on the
  payment row: the first terminal state wins (SDD 21.5 and the concurrency table).
- **The defect:** the controller ignored Payment's outcome: transient, auth fault, not found and in-flight were all answered 200.
- **Contracts considered:**
  - **A, synchronous confirmation:** the designed contract. Only a confirmed outcome is a success; anything else is a retryable
    failure.
  - **B, durable asynchronous intent:** would need a new re-send mechanism (an outbox-driven or reconciler-driven cancel), which Core
    does not have for commands.

  **A selected.** It is what the SDD already describes, it adds no mechanism, and it keeps Billing as the commercial authority and
  Payment as the executor.
- **Implementation (Billing controller only):**
  - `cancelled` / `already_terminal` → 200 (unchanged);
  - `in_flight` → `409 payment_request_in_flight` (the SDD rule, which the code had skipped);
  - `transient` / `auth_fault` / `not_found` → **`503 payment_unavailable`** (new code), logged `payment_cancel_unconfirmed`;
  - a request already `cancelled` answers 200 with itself, so a retry after a lost answer is not a conflict.
  - The success status stays 200 as implemented and tested (the SDD says 202; recorded, not changed).
  - The marker is still stamped before the call, as before (the SDD says "nothing changed" on 409; recorded, not changed).
- **Tests:** Billing E2E for transient-then-retry (same key, marker not re-stamped), auth fault / not found, in flight, already terminal,
  and already cancelled. **Mutation:** ignoring the outcome again fails 3 of them.

**Cancellation revalidation** (Billing live; fake Payment with Payment's cancel semantics; every answer checked against Payment's state
at that moment: 0 answers of success while the payment was still payable):

| Window | Iterations | Answers | Final | Logical cancels / applied receipts |
|---|---|---|---|---|
| B1 Payment unavailable, then back | 20 | 503 → 200 | cancelled / cancelled | 1 / 1 |
| B2 Payment cancels, response lost | 20 | 503 → 200 (replay) | cancelled | 1 / 1 |
| B3 Payment cancels, Billing SIGKILLed before answering | 20 | ECONNRESET → 200 after restart (request already cancelled via the reconciler, or replay) | cancelled | 1 / 1 |
| B4 Billing SIGKILLed right after answering | 20 | 200 | cancelled (the event consumed by the next instance) | 1 / 1 |
| B5 Payment's broker frozen (real Payment) | 10 | 200 (confirmation is synchronous) | event held in Payment's outbox, delivered after the thaw: cancelled | 1 / 1 |
| Payment stopped, then started (real Payment) | 10 | 503 → 200 | cancelled | 1 / 1 |
| B6 duplicate | 20 | 200, 200 | cancelled | 1 / 1 (2 physical calls) |
| B7 three concurrent | 20 | 200 ×3 | cancelled | 1 / 1 (3 physical calls) |
| B8 cancel races payment success | 20 | 200 or 409 | exactly one terminal: paid (16) or cancelled (4) | ≤ 1 / 1 |
| B9 cancel races reconciliation | 20 | 200 | cancelled | 1 / 1 |
| B10 cancel races SIGTERM (Payment answers inside / after the HTTP drain) | 10 + 10 | 200 / 503 → 200 on the new instance | cancelled; exit 1.0 s / 5.0 s | 1 / 1 |
| B11 Payment refuses (open attempt) | 20 | 409 | the payment honestly left payable (nothing was accepted) | 0 |
| B12 three transient failures, then recovery | 20 | 503 ×3 → 200 | cancelled | 1 / 1 (4 physical calls) |
| Payment side, cancel vs successful attempt (in process) | 20 | – | cancelled (11, attempt refused) or attempt open and cancel refused (9) | ≤ 1 terminal event |

- In B8, 9 races answered 200 while Payment had already succeeded. That is the documented rule ("already terminal: no error; the
  terminal event settles the request"): the request ended `paid`, and nothing payable was left.
- Real Payment accounting: 20 requests → 20 `payment.cancelled` → 20 receipts → 20 cancelled, 0 pending.

**Shutdown revalidation** (the full 15.5 matrix on the corrected build, 21 campaigns, 53 min, 0 uncaught, all `validation-*` containers
and networks removed; correctness identical to 13.5 in every window: 0 lost, 0 partial, 0 duplicated effects):

| Scenario | Before (13.5) | After |
|---|---|---|
| Idle SIGTERM, Auth / Organization / Billing / Payment (median) | 21 / 22 / 26 / 18 ms | 16 / 18 / 22 / 15 ms |
| Keep-alive busy at SIGTERM (Billing, Payment; 3 each) | **never exits** while the client continues | exits 57–78 ms: the busy connection gets one 503, then refused |
| 10 keep-alive clients busy at SIGTERM (3 each) | – | 19–84 ms |
| `/ready` after SIGTERM | 200 until HTTP closes (indefinitely under F-A) | 503 or refused from the first probe |
| Hung HTTP request (row lock never released) | 30.0 s, request 500 at the statement timeout | HTTP cut at **5.08 s** (the drain deadline); the process still exits at **29.9 s** (see limitation) |
| In-flight request released at 2 s | 2.05 s, 200 | 2.07 s, 200, invoice issued |
| Frozen PostgreSQL, statement timeout 2 s / defaults | 11.9 s / Billing 28.8, Payment 31.9 s | **4.96 s** / 28.8, 31.9 s |
| Worker drain timeouts under a frozen database | 5, 10, 15, 20 s | 5.0 s, once, all workers together |
| Frozen RabbitMQ, Billing / Payment (heartbeat 60 or 0) | 27.7 / 35.1 s | 26.8 / 34.4 s |
| Consumer window held until exit: A, B / C | 30.0 / 35.0 s | 30.0 / 35.0 s |
| Sweeper waiting on a lock never released | 30.0 s (drain 5 + repeated 5, then statement timeout) | 30.0 s (drain 5, once, then statement timeout) |
| Dispatcher: Payment never answers | 5.04 s | 5.03 s |
| `docker stop`, idle | 0.36–0.40 s, exit 0 | 0.28–0.39 s, exit 0 |
| `docker stop`, keep-alive busy | **SIGKILL at 10.4 s** | **0.39 s, exit 0** |
| `docker stop`, broker frozen / sweeper on a lock | SIGKILL at 10.3–10.5 s | SIGKILL at 10.3–10.4 s (F-E; recovery clean) |
| Restart cycles 10 + 10 / rolling ×3 / backlog | 1 request left open (F-B) / clean / clean | 359/359 / 138/138 / 60/60 settled once; 1 consumer (2 rolling), 3 connections, no growth |

**New shutdown order and bound (defaults).**
- **At `onModuleDestroy`, together:**
  - readiness 503 and admission closed;
  - the HTTP server closed (≤ `HTTP_DRAIN_TIMEOUT_MS`, 5 s);
  - every worker drain started (≤ 5 s each, concurrently);
  - Billing's consumer close started (≤ 3 × heartbeat per operation on a silent broker).
- `beforeApplicationShutdown` and `dispose` then only wait for those.
- **In `onApplicationShutdown`:** the bus close (≤ 3 × `RABBITMQ_HEARTBEAT_S` = 30 s on a silent broker, after the confirm's 5 s),
  then the pool close (a stuck client is destroyed at its `DB_QUERY_TIMEOUT_MS` = 35 s, counted from the query's start, which usually
  precedes the signal).

| Component | Bound | Measured |
|---|---|---|
| HTTP drain | `HTTP_DRAIN_TIMEOUT_MS` = 5 s | 5.08 s (hung request) |
| Worker drains | 5 s, concurrent | 5.0 s |
| RabbitMQ cleanup | confirm 5 s + 3 × heartbeat (30 s) | 26.8 s (Billing), 34.4 s (Payment, publish in flight) |
| Database cleanup | `DB_QUERY_TIMEOUT_MS` = 35 s from the stuck query's start | 28.8–35.0 s |
| **Total process** | about **35 s** at the defaults (the database and broker bounds overlap in time, because their clocks start when the dependency went silent) | **max 35.0 s** |

- **Remaining limitation:** closing a hung request's connection at 5 s does not cancel its SQL statement. The process still waits for
  the statement timeout through the pool close. That wait is bounded by Core (F-E), not by any client.
- **Stop grace:** graceful shutdown needs up to ~35 s, which would call for **45 s** (35 s + 10 s, ≈ 30 % margin). Not implemented
  (production configuration, for review):
  - Auth deploy: `docker run --stop-timeout 45` and `docker stop -t 45` in `provision-and-deploy.sh`;
  - Compose: `stop_grace_period: 45s` on the four services;
  - any future Billing / Payment / Organization deployment: declare 45 s.
- Correctness does not depend on it: every SIGKILL window recovered.
- **But the grace was tested in containers and does not work yet for a frozen broker** (F-H below).

**Finding F-H (FAIL, S8 / S10, in containers only): after a Core-bounded shutdown, PID 1 does not exit.** `dockerStopWithGrace`
(`docker stop -t 45`, 3 runs each):

| Case | Result |
|---|---|
| Sweeper waiting on a lock | exits gracefully at **30.3 s, exit 0** |
| Broker frozen, Billing | `service_shutdown_complete` logged (≈ 27 s), then **SIGKILL at 45.3 s, exit 137**, 3/3 |
| Broker frozen, Payment | `service_shutdown_complete` logged, then **SIGKILL at 45.2–45.4 s, exit 137**, 3/3 |

Diagnosis (`dockerFrozenBrokerDiag`, `docker stop -t 90`):
- Nest completes at 26.9 s.
- 3 s later PID 1 still holds **one socket: the AMQP connection to the frozen broker, in `FIN_WAIT2`**. amqplib closed it with a
  graceful half-close (FIN); the paused broker never answers; the kit's bounded close abandoned the wait but not the socket.
- The database sockets closed normally.
- Node's event loop stays alive, and Docker SIGKILLs at 90.4 s.
- Outside a container this is hidden: Nest re-raises the signal after its shutdown, and that terminates the process. As PID 1 (the
  images have no init), the re-raised signal is ignored.
- The initial 15.5 run never saw it: Docker's 10 s default SIGKILLed before the post-shutdown hang could show.

Correctness is intact (every SIGKILL recovered), but shutdown is not bounded by Core in the production runtime. Reproducers:
`dockerStopWithGrace`, `dockerFrozenBrokerDiag`. **Not corrected (stop condition).** Candidate directions, for approval:
1. Exit explicitly once Nest's bounded shutdown has completed: Nest 12's `enableShutdownHooks(signals, { useProcessExit: true })` calls
   `process.exit(0)` after the sequence, so no leftover handle can hold the process, as PID 1 or not.
2. Destroy the underlying socket when the kit abandons a bounded AMQP close (the handle itself, not amqplib's pending operations, which
   15.3 showed a destroy does not end).
3. Run the images with an init (`--init` / tini). This is deployment-level, and it does not fix the handle.

Option 1 is the smallest and covers every dependency; 2 fixes the specific leak. They are complementary.

**Other dispositions.**
- **F-E:** carried as the grace recommendation above. No timeout was shrunk.
- **F-F:** Billing exiting at startup with RabbitMQ down is **intentional and documented** (kit README: `subscribe()` fails fast when
  the broker is unreachable at start; an attached consumer recovers by itself). Kept, but every deployment of Billing needs a restart
  policy (`unless-stopped` or equivalent).
- **F-G → 15.7:**
  - Auth rate-limits `/auth/health` (429 under frequent probing);
  - `error=Error` with no `kind` for a late write on a closed pool;
  - the new `payment_cancel_unconfirmed` and `http_drain_timeout` lines are one per event.
- **Stage 20 (release management):** the Auth deploy stops the old container before starting the new one (an outage per deploy).
- **15.8:** the four 15.4 findings are unchanged.

### 13.5.2 Corrective patch 2: F-H (15.5)

Sections 13.5 (initial validation: FAILED on F-A, F-B) and 13.5.1 (patch 1: F-A, F-B, F-C, F-D fixed; F-H found) are kept as found.
This is the correction of F-H and the final revalidation.

**Pre-fix reproduction (again, on the patch-1 images):** `dockerFrozenBrokerDiag` (Billing, broker paused, `docker stop -t 90`):
`service_shutdown_complete` at 26.95 s, then one socket in PID 1 (the AMQP connection, `FIN_WAIT2`), SIGKILL at 90.3 s (exit 137).
`dockerStopWithGrace` (`-t 45`): Billing and Payment 45.3–45.4 s, exit 137, 6/6; the sweeper control exits gracefully at 30.3 s.

**Root cause (amqplib 2.0.1 source).**
- `connect.js` passes the `net`/`tls` socket itself to `new Connection(sock)`. `Connection.stream` is that socket, and
  `ChannelModel.connection` is the `Connection`.
- Every end of a connection goes through `Connection.toClosed()`: close-ok received, heartbeat timeout (`Heart` `timeout`), socket
  error.
- `toClosed()` invalidates the connection and calls **`this.stream.end()`**, a half-close. The socket stays readable until the peer's
  FIN. A silent broker never sends it, so the socket stays open in `FIN_WAIT2` as a referenced handle.
- The kit's bounded close only abandoned the promise (`abandonAfter`), never the socket. Nothing ever destroyed it.
- Outside a container, the signal Nest re-raises after shutdown kills the process and hides this. As PID 1 that signal is ignored, and
  the handle keeps Node alive until SIGKILL.
- **Is there a reason to keep an abandoned connection's socket?** No:
  - the connection is invalidated and never reused (a new connection is opened on demand);
  - nothing can be sent on it;
  - late frames are ignored;
  - amqplib's own open-failure path already does `end()` then `destroy()`.

**Alternatives evaluated.**
- **Destroy the transport the kit gave up on:** selected; it fixes the resource that leaks.
- **Explicit `process.exit()` after Nest's shutdown** (Nest 12 `useProcessExit`): not adopted. It would hide any leaked handle rather
  than dispose of it. With the leak fixed it is not needed, and nothing else was left open in any container run.
- **An init process (`--init`, tini):** not a fix, because the handle would still leak. It is signal forwarding and zombie reaping
  hygiene, recorded for Stage 20.
- **Destroying on every close:** rejected. A healthy broker completes the graceful FIN itself, and a reset there would be abrupt for no
  benefit.

**Selected design (kit `RabbitMqEventBus`).**
- **Transport disposal:**
  - A connection closed **by an error** (heartbeat timeout, socket error, a close forced by the broker) has its transport destroyed at
    once.
  - A `close()` the broker does not answer within the bound (3 × heartbeat) is **abandoned and its transport destroyed**, logged
    `rabbitmq_connection_abandoned`.
  - A **clean close** (close-ok from a healthy broker) keeps amqplib's graceful FIN.
- **Bounds:**
  - `close()` uses **one deadline** for the publisher channel and the connection together (not a full bound for each).
  - Every bounded wait in `close()` and in a consumer's stop also **ends when the connection is gone** (amqplib never settles a channel
    operation that waited on a connection that died).
- **The one amqplib internal:** the destroy is the kit's only use of `ChannelModel.connection.stream`, in `destroyTransport()`. It is
  guarded (another shape degrades to a no-op), version-noted (2.0.1) and pinned by the integration test.
- **Unchanged:** publish and consume semantics. A destroyed socket fails an unconfirmed publish, so the outbox row stays pending and is
  sent again; an unacknowledged delivery is redelivered and deduplicated by the inbox or receipt. Nothing is marked published or acked
  because of a destroy.

**Tests.** `libs/service-kit/test/rabbitmq-transport-disposal.int-spec.ts` (real RabbitMQ behind a freezable, severable proxy):
- **silent broker:** `close()` < 4 s (heartbeat 1 s), socket destroyed, the connection never reused;
- **heartbeat teardown alone:** socket destroyed;
- **no client heartbeat:** abandoned at the one bound (29–33 s, not two bounds) and destroyed, with `rabbitmq_connection_abandoned`;
- **healthy close:** < 1 s, nothing abandoned, closed by the peer's FIN;
- **broker vanishes during the close:** returns at once, socket destroyed.

**Mutation:** without the destroy, the silent-broker, abandoned and vanish tests fail. The heartbeat-only case passes regardless through
the proxy, whose real broker still answers the FIN; a paused broker (the container test) is where that path matters. The 15.3 silent-broker
spec still passes.

**Production-container revalidation** (images built from this source, Node as PID 1, `docker stop -t 45`, 3 runs each):

| Case | Before | After |
|---|---|---|
| Frozen broker, Billing (broker heartbeat 60 s / disabled) | SIGKILL at 45.3 s, exit 137 | **27.1 s / 27.1 s, exit 0** |
| Frozen broker, Payment with a publish in flight | SIGKILL at 45.3 s | **28.7 s / 28.7 s, exit 0**; the pending row is published after restart, 1 `payment.cancelled` per payment |
| Diagnosis run (`-t 90`) | complete 27.0 s, `FIN_WAIT2` socket, SIGKILL at 90.3 s | complete 27.0 s, **exit 0 at 27.0 s**, no socket left |
| Billing consumer with an unacked delivery blocked in its transaction, broker frozen | – | **39.8 s [39.7–39.8], exit 0**; not acked; redelivered after restart, applied once (receipt 1); 1 consumer |
| Broker vanishes during the close | – | Billing 2.7 s, Payment 2.7 s, exit 0 |
| 10 cycles: freeze, stop both, natural exit, restart (Billing + Payment) | – | 20/20 exit 0, stop 21.8 s [21.6–29.3]; broker connections 2, channels 2, consumers 1 every cycle; database sessions 2–3; memory 70–78 MiB, no trend; 20/20 events published once |
| After restart, every case | – | ready in 0.7–0.9 s, exactly 1 Billing consumer, outbox drained |

The 39.8 s case is the longest graceful path:
- the consumer's statement waits its 30 s timeout, counted from before the signal;
- the handler's failure path then tries to republish to the retry queue, which opens a connection to the frozen broker, bounded by the
  5 s connect timeout;
- then the bounded closes.

**Final shutdown timing** (corrected build; host processes unless marked; median [range], 3 runs):

| Scenario | Graceful shutdown |
|---|---|
| Idle Auth / Organization / Billing / Payment | 16 [13–18] / 12 [10–14] / 15 [13–40] / 18 [12–21] ms |
| Busy keep-alive (Billing / Payment) | 53 [51–62] / 74 [72–86] ms |
| 10 busy keep-alive clients (Billing / Payment) | 41 [32–81] / 54 [48–70] ms |
| Hung HTTP request | HTTP cut at 5.09 s; exit 29.9 s (the statement timeout) |
| Hung worker(s) (frozen database, 2 s statement timeout) | 4.96 s |
| Frozen PostgreSQL, defaults (Billing / Payment) | 28.8 / 31.9 s |
| Frozen RabbitMQ (Billing / Payment) | 26.8 / 28.3 s |
| Frozen RabbitMQ, **container** (Billing / Payment) | 27.1 / 28.7 s, exit 0 |
| Heartbeat-disabled RabbitMQ, **container** (Billing / Payment) | 27.1 / 28.7 s, exit 0 |
| Consumer blocked in a transaction + frozen RabbitMQ, **container** | 39.8 s, exit 0 |
| DB lock wait (sweeper) | 30.0 s (container with `-t 45`: 30.3 s, exit 0) |
| Commit blocked (consumer window C held) | 35.0 s |
| Provider call hung (dispatcher) | 5.06 s |
| `docker stop`, idle | 0.33–0.37 s, exit 0 |

**Stop grace.**
- **Measured maximum graceful shutdown: 39.8 s** (container; host 35.0 s).
- **Theoretical bound of the longest path:** ≈ 41 s (`DB_QUERY_TIMEOUT_MS` 35 s, counted from the stuck query's start, plus the 5 s
  broker connect timeout plus the closes, which end when the connection is gone). The worker drain and the HTTP drain (5 s each) run
  concurrently, inside that window.
- The 45 s proposed in 13.5.1 would leave about 5 s of margin, so it is **revised to 60 s**: 39.8 s + 20 s (≈ 50 %), above the ≈ 41 s
  bound.
- Set where deployment definitions exist:
  - Auth deploy `docker stop -t 60` and `docker run --stop-timeout 60`;
  - Compose `stop_grace_period: 60s` on the four services.
- Billing, Payment and Organization have no deployment yet; each one must declare ≥ 60 s.
- Invariant: stop grace (60 s) > maximum graceful shutdown (≈ 41 s bound, 39.8 s measured) + margin.

**Regression.**
- **15.3 (full matrix, 19 campaigns): unchanged.**
  - baseline 200/200;
  - broker down 3 × 105/105;
  - 5 outage cycles, 1 consumer each;
  - confirm timeout 5.00 s;
  - lost confirm and cut mid-publish 20 × (2 deliveries → 1 effect);
  - consumer transient / poison / permanent → DLQ (the 2 dead-lettered events are the designed poison messages);
  - duplicates 800 → 200;
  - crash windows A/B/C × 20;
  - prefetch;
  - multi-relay;
  - backoff 1–16 s;
  - durability;
  - broker restart;
  - app flows;
  - silent broker and heartbeat-disabled;
  - Billing SIGTERM on a frozen broker 27.9 s.
- **15.4 subset: unchanged.**
  - relays 1/2/4 splits;
  - kit duplicate race 300 → 100;
  - relays + consumers + broker interruption (2 consumers, 4 connections);
  - relay crash;
  - competing consumers 90;
  - Billing duplicate race 100;
  - restart under competition 36/36;
  - Payment pair 40/10.
- **15.5 full matrix on the final build:** every row as in 13.5.1. F-A, F-B, F-C and F-D hold:
  - busy keep-alive exits in milliseconds;
  - `/ready` is 503 at shutdown;
  - 0 cancellation violations across B1–B12;
  - drains once, concurrently.
- **Suites and images:** full build and suites green; production images smoke-tested (non-root, `/health` 200); no validation tooling
  in the images.

**Dispositions.** F-E is resolved by the explicit 60 s grace (no Core timeout was shortened). F-F: intentional fail-fast, documented.
F-G → 15.7. Init process and start-before-stop deploy → Stage 20. The 15.4 findings → 15.8.

## 14. Experiment report template

```text
Experiment:        <stage>.<n> <name>
Question:          <one question>
Hypothesis:        <expected behaviour, from the mechanism>
Invariants:        I<n>, ...
Git SHA:           <sha>             Harness: <script + arguments>
Environment:       CPU / RAM / OS / Node / Docker / PostgreSQL / RabbitMQ (section 4 or differences)
Configuration:     every non-default setting; replicas per service
Dataset:           SMALL | MULTI-BATCH | MEDIUM | LARGE (+ counts)
Procedure:         warm-up; fault or load applied at <point>; removed at <point>; duration; concurrency
Runs:              <n> (+ warm-up)
Measurements:      table: median [min–max]; p50/p95/p99 where relevant
Invariant checks:  query or assertion per invariant, with result
Result:            PASS | FAIL | INCONCLUSIVE | NEEDS PRODUCT/SRE DECISION
Interpretation:    what it shows and does not show (environment limits)
Follow-up:         fix / tune / defer, with owner and target stage
```

## 15. What local validation cannot tell

Cloud network latency and jitter, production storage IOPS and CPU, the production PostgreSQL `max_connections` and memory, real payment
provider latency and failure behaviour (no real adapter exists yet), real traffic mix and peaks, multi-host failure modes, and
container CPU/memory limits (none are set today). Stage 15 separates **correctness validation** (transfers) from **capacity prediction**
(does not, without production-like hardware and data).

## 16. Open decisions carried by Stage 15

| Decision | Needed by | Owner |
|---|---|---|
| F2: required checks / branch protection on `main` (an experimental change could merge without CI) | before 15.2 changes land | repository admin |
| ~~I9 remediation (15.3 FAIL)~~ **resolved** by the corrective patch: a Core-owned AMQP heartbeat (`RABBITMQ_HEARTBEAT_S`) and bounded closes in the kit bus (section 13.3.1); per-operation deadlines with socket destruction assessed and rejected | – | – |
| ~~I9 remediation (15.2 FAIL)~~ **resolved** by the corrective patch: client-side `DB_QUERY_TIMEOUT_MS` in the kit and in Auth, timed-out clients destroyed (section 13.2.1); TCP keepalive assessed and not adopted | – | – |
| Acceptable recovery time after a dependency outage | 15.2 / 15.3 result classification | SRE / product |
| ~~15.5 FAIL F-A~~ **resolved** (section 13.5.1): readiness 503 and admission closed at shutdown start, HTTP drain bounded by `HTTP_DRAIN_TIMEOUT_MS` | – | – |
| ~~15.5 FAIL F-B~~ **resolved** (section 13.5.1): success only when Payment confirmed the cancel; `503 payment_unavailable` otherwise (contract A, the SDD's own) | – | – |
| ~~15.5 FAIL F-H~~ **resolved** (section 13.5.2): the kit bus destroys the transport of every connection it gives up on | – | – |
| ~~Stop grace~~ **set to 60 s** (section 13.5.2) in the Auth deploy and Compose; every future deployment of a Core service must declare ≥ 60 s | – | – |
| Init process (`--init` / tini) for signal forwarding and zombie reaping (not needed for correctness) | Stage 20 | SRE |
| Start-before-stop / rolling deploy for Auth (every deploy is an outage today) | Stage 20 | SRE |
| SDD endpoint 15: success is `200` in code and tests but `202` in the SDD, and the marker is stamped even when Payment refuses (SDD: "nothing changed") | Billing doc review | engineering |
| Acceptable AttemptResolver provider-call amplification (15.4 measured: N instances → N calls per unresolved attempt per pass; state safe) | 15.8 | product (provider cost / rate limits) |
| ExpirySweeper head-of-line blocking and dispatcher per-batch stale reclaim (15.4: correct, availability and duplicate-call cost) | 15.8 | engineering |
| Acceptable log volume during outages | 15.7 | SRE |
| Retention periods (F12) | after 15.7 | product / legal |
| Traffic assumptions for capacity targets | 15.8 | product |

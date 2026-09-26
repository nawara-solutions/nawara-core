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
| 15.6 | 2026-09-24 | `f6199dd` | Cross-service failures (20 campaigns: one service or dependency down while others run, combined failures, recovery orders, restart windows ≥ 20 iterations, event delay / replay / ordering, service authentication, tenant isolation, 10 repeated cycles, startup orders, readiness matrix, production containers) | **PASS**: no lost accepted work, no duplicate protected effect, no false success, no cross-tenant write, no manual repair; every order converges; containers exit naturally under the 60 s grace. No production change. Observations carried to 15.7 / 15.8 and one readiness decision (SRE) | section 13.6 |
| 15.7 | 2026-09-24 | `7908ab9` | Data growth and log volume (5 campaigns: per-operation growth through the real APIs, cloned volume to 100 k lifecycles with the services' own queries under EXPLAIN, outbox accumulation during a broker outage (3 runs), DLQ residue lifecycle (3 runs), log volume in 11 scenarios, Auth / Organization probes, sensitive-log scan) | **PASS**: linear growth (Billing 18.4 KB, Payment 11.0 KB per lifecycle); request-path and claim queries flat to 100 k; exact outbox drain; DLQ residue resolved by replay with no second effect; no sensitive data in logs. No production change. Retention matrix (no duration invented), D1, O3–O5 classified, 15.8 handoff | section 13.7 |
| 15.8 | 2026-09-24 | `c2a5108` + tuning | Capacity and runtime tuning (baseline profile 3 levels × 3 runs; pool 5/10/20; pool exhaustion; ExpirySweeper scan to 500 k; dispatcher batch and stale envelope; prefetch 1/5/10/20; outbox batch, pass and backoff; backlog recovery; multi-instance; readiness cost; affected 15.3–15.7 campaigns re-run) | **PASS**: 7 retained changes, each with before/after evidence, a mutation-proven test and its historical campaigns re-run: ExpirySweeper partial index (15 ms → 0.04 ms at 100 k) and SKIP LOCKED (0 → 999 expired in 3.5 s with one row held); AttemptResolver lease (N → 1 provider call per attempt); dispatcher claim renewal + startup relationship (9 → 0 duplicate sends); prefetch 10 → 5 (no pool starvation); outbox full-batch passes (backlog 111 s → 17 s) and backoff ceiling 60 → 15 s; duplicate `billing_transition` index dropped. Request-path latency and throughput unchanged; no invariant regression | section 13.8 |
| 15.9 | 2026-09-24 | `aab849f` | Final validation and Phase C closure: canonical matrix re-run on the merged build (15.2 DB 12, 15.3 broker 15, 15.4 workers 17, 15.5 shutdown / production containers 18, 15.6 cross-service 18, 15.7 growth / DLQ / logs 4, 15.8 capacity 7 campaigns), migration chain (clean + upgrade from `c2a5108`), production images, full regression | **PASS**: invariants I1–I18 hold; no correctness defect; no production change; open items all owned (section 17) | sections 13.9, 17 |

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

### 13.6 Cross-service failures (15.6)

**Question.** When Auth, Organization, Billing, Payment, PostgreSQL or RabbitMQ are unavailable, alone or together, and recover in
different orders, does Core keep ownership, tenant isolation, accepted work, idempotency, truthful answers, bounded waits and automatic
convergence?

**Harness (test-only).** `scripts/validation/cross-service-campaigns.mjs` on `lib/core-stack.mjs`: real Billing and Payment processes,
with every cross-service edge breakable on its own:
- each service's PostgreSQL through its own TCP proxy (`down` = refused, `freeze` = hung);
- each service's RabbitMQ link through its own proxy, plus a whole-broker stop (`stop_app`);
- the Billing → Payment HTTP edge through a fault proxy (`refuse`, `blackhole`, `drop` = Payment processed and the answer was lost,
  `truncate` = the answer cut after its status line);
- a fake Auth answering `/auth/me` for payer bearers;
- real Auth and Organization where their own behaviour is measured.

The commercial flow runs through the real APIs: invoice → payment request → dispatcher → Payment; payer attempt (test provider) + sync →
`payment.succeeded`; producer cancel → `payment.cancelled`; Billing's receipts. Production-container checks run in
`shutdown-campaigns.mjs` (`dockerCrossServiceOutage`, `dockerFrozenBrokerFinal`, `dockerFrozenCycles`, all with `docker stop -t 60`).
Main at `f6199dd` (15.5 merged); Node 24.18 (images: Node 22), Docker 28.5, PostgreSQL 16.15, RabbitMQ 3.13, amqplib 2.0.1. A 15.5
smoke on this base first confirmed:
- idle SIGTERM exits in 13–27 ms;
- a busy keep-alive connection exits in 58–94 ms;
- a repeated stop costs 0 ms;
- a cancel during a Payment outage gets 503, then 200 on retry.

**Invariants (C1–C12 of the stage):**
- **C1** no lost accepted work;
- **C2** no duplicate protected effect;
- **C3** no false success on a synchronous contract;
- **C4** no cross-tenant write;
- **C5** ownership kept (no service writes another's database);
- **C6** no accidental synchronous coupling;
- **C7** truthful readiness;
- **C8** no manual repair;
- **C9** replay safe;
- **C10** restart safe;
- **C11** service authentication fails closed;
- **C12** bounded failures.

**Cross-service edges (from the code).**

| Caller → callee | Transport | Sync | Timeout / retry | Idempotency | Failure behaviour |
|---|---|---|---|---|---|
| Billing → Payment: create payment | HTTP, service token | sync, but dispatched asynchronously by the dispatcher | `PAYMENT_TIMEOUT_MS` 5 s; request left `sending`, resent after `BILLING_DISPATCH_STALE_SENDING_MS` (60 s) | Payment's natural key `(producer, paymentRequestId)` | transient → retried; `rejected` → terminal |
| Billing → Payment: cancel | HTTP, service token | sync (the caller's request) | 5 s; the caller retries | `Idempotency-Key billing-cancel-{requestId}` | confirmed → 200; open attempt → 409; anything else → 503 `payment_unavailable` (15.5) |
| Billing → Payment: get payment (reconciler) | HTTP, service token | background | 5 s; next pass (30 s) | read-only | next pass |
| Payment → Billing: `payment.succeeded/failed/cancelled/expired` | RabbitMQ (Payment outbox → `billing.payment-events`) | async | outbox backoff; consumer 3 × 5 s then DLQ; reconciler backstop | `payment_event_receipt` (unique event id) + state checks | pending in the outbox / queued / reconciled |
| Billing, Payment → Auth `/auth/me`; Organization → Auth `/auth/grants`, step-up | HTTP (user bearer only) | sync | 3 s (`AUTH_TIMEOUT_MS`) | read-only | 503, fail closed |
| Producers → Billing; Billing → Payment; callers → Organization | service tokens (digests, deny by default; Organization adds a per-caller policy) | – | – | – | 401 |
| Auth → anything | none (`AUTH_EVENTS=off` in production; `PAYMENT_SERVICE_URL` in its deploy env is unused by the code) | – | – | – | – |

- **Readiness:** every service checks only its own database and migrations; Billing and Payment also check RabbitMQ, and Billing its
  consumer. **No service's readiness depends on another service.**
- **Startup:** Billing refuses to start without RabbitMQ (fail-fast, documented); everything else starts unready and recovers.
- **Database ownership:** each service owns one database (C5 holds by construction: separate databases and credentials; no campaign
  saw a cross-database write).

**Readiness matrix** (process / `/health` / `/ready`, with a relevant operation; 3 runs where timed):

| Failure | Auth | Organization | Billing | Payment |
|---|---|---|---|---|
| RabbitMQ down | up / 200 / 200 | up / 200 / 200 | up / 200 / **503**; invoices work; its cancel still 200 (Payment confirms over HTTP) | up / 200 / **503**; API works, events wait in the outbox |
| Billing DB down | up / 200 / 200 | up / 200 / 200 | up / 200 / 503; DB-backed reads answer **500** | up / 200 / 200; cancels and payments work |
| Payment DB down or hung | up / 200 / 200 | up / 200 / 200 | up / 200 / 200; invoices work; cancel 503 `payment_unavailable` (12–15 ms down, 5.0 s hung) | up / 200 / 503 |
| Billing down | up / 200 / 200 | up / 200 / 200 | – | up / 200 / 200; cancels and payments work, events queue |
| Payment down | up / 200 / 200 | up / 200 / 200 | up / 200 / 200; invoices, requests accepted (`sending`); cancel 503 | – |
| Auth down | – | up / 200 / 200 | up / 200 / 200; service-token routes work, payer routes **503** | up / 200 / 200; payer routes 503 |

**Results.** 0 uncaught errors in every run; every accounting row: at most one Payment payment per request, one applied receipt, one
terminal event, 0 payment-id mismatches, 0 cross-tenant rows.

| Id | Failure | Operation | Observed | Recovery | Invariants | Result |
|---|---|---|---|---|---|---|
| A | Payment stopped / hung, Billing up (3 + 3) | Billing: invoices, a new request, cancel of a sent one, its retry | Billing alive and ready; invoices and reads 200; new request accepted and left `sending`; cancel **503 `payment_unavailable`** in 12–14 ms (stopped) / **5.0 s** (hung), never success | cancel retried → 200 → cancelled once; the new request sent after the 60 s stale window (converged 49–59 s) | C1 C3 C6 C12 | PASS |
| B | Billing stopped, Payment up (5) | Payment: producer cancel, payer payment | both 200/201 without Billing; events queued in Billing's durable queue (2) | Billing restarted: both applied once in 0.73–0.79 s | C1 C5 C6 | PASS |
| C | Billing → Payment cut: before Payment; Payment killed in its transaction; committed, answer lost; answer cut; create answer lost; Payment killed inside the create (20 + 20 + 20 + 20 + 20 + 10) | cancel / dispatch | first answer 503 (never success) / create left `sending` | retry 200 (replay) / resend after stale: one payment, one cancellation, ids match | C2 C3 C10 | PASS |
| D | Billing SIGKILLed during a real Payment event: before delivery; after the receipt INSERT; inside COMMIT (5 + 20 + 20) | consumer | D2 rolled back; D3 committed on the server with no ack | redelivered: 1 receipt, 1 effect every time | C1 C2 C9 C10 | PASS |
| E | RabbitMQ down, all four services up (3) | per service (matrix) | Billing / Payment unready in 13–20 ms; HTTP keeps working; outboxes accumulate (4 / 6) | consumer back 4.3 s [4.3–4.5], converged 5.8 s [5.7–5.9]: every event applied once | C1 C2 C6 C7 | PASS; readiness semantics → decision below |
| F | Billing DB down; Payment DB down; Payment DB hung (3 each) | the other service's work | only the affected service unready; the other unaffected | ready again 53–65 ms after the database returns, no restart | C6 C7 C8 | PASS |
| G | Billing DB down while a Payment event arrives: 5 s (5), 25 s (3) | consumer | not acked as done: retried (5 s), dead-lettered after the retry budget (25 s) | applied once 0.18–0.20 s after the DB returns (retry) or 0.74–0.97 s (reconciler, test window 5 s); DLQ keeps the dead copy | C1 C2 C8 | PASS (DLQ hygiene → 15.7) |
| H | Payment DB down / hung while Billing calls Payment (3 + 3) | cancel | 503 in 12–15 ms / 5.0 s; payment untouched | retry after recovery → 200 once | C3 C12 | PASS |
| I | Billing DB + RabbitMQ; Payment DB + RabbitMQ; both restore orders | Payment / Billing keep working | as the matrix | converged 4.2–5.7 s in every order | C1 C2 C8 | PASS |
| J | Billing down + RabbitMQ down: Billing first (restart policy) / RabbitMQ first | a Payment cancel | Billing exits while the broker is down (6 starts) | converged 7.1 s / 5.4 s, same end state | C1 C8 | PASS |
| K | Billing killed + its DB down: Billing first / DB first | a Payment event | Billing alive, `/ready` 503 while its DB is down | converged 6.2 s / 1.0 s, same end state | C1 C7 C8 | PASS |
| L | Billing + Payment restarted together (SIGKILL / SIGTERM alternately) with Payment outbox pending, requests unsent, a payment in progress, webhooks due (5) | all | – | converged 2.7–2.8 s every time; 20 items once; webhooks retried (attempts 1–4); 1 consumer, 2 connections | C1 C2 C10 | PASS |
| M | Billing + RabbitMQ down, Payment terminal: 4 recovery orders (3 items each) | – | – | 8.3 / 8.4 / 11.4 / 11.5 s, every item cancelled once | C1 C8 | PASS |
| N | a `payment.cancelled` held while the reconciler settles the request and a second request is paid (5) | – | the old event arrives last | receipt `ignored`; invoice stays paid; nothing moves back | C9 | PASS |
| O | identical replay of an applied event; the same fact under a new event id (20 + 20) | – | 0 extra effects; a new event id adds an `ignored` receipt | – | C2 C9 | PASS |
| P | `payment.succeeded` before Billing learned the payment id (create answer lost, request `sending`) (10) | – | receipt `deferred` | resend (natural key) + reconciler → paid once, ids match | C2 C9 | PASS |
| Q | missing / invalid / malformed / user-shaped / other-service-shaped credentials on Billing, Payment, Organization service routes | – | 401 everywhere, 0 writes; Auth unavailable: payer routes **503**, service routes unaffected | – | C11 | PASS |
| R | Billing started with a wrong Payment token | dispatch, cancel | ready; Payment refuses (0 payments); cancel 503; logs `reason=auth_fault` / `outcome=auth_fault`; 0 token strings in any log | restarted with the right token: sent after the 60 s stale window (56.7 s), 1 payment; cancel 200 | C3 C11 | PASS |
| S | organizations A and B, retries during a Payment outage, a broker outage, replays of A's events | – | 0 wrong finals, 0 organization mismatches (Payment ↔ invoice), 0 receipts pointing at another request | – | C4 | PASS |
| T | 10 cycles: Payment down → back, broker down → back, Billing restarted, with traffic | – | every cycle 2 connections, 2 channels, 1 consumer; sessions 2–5 / 3; outboxes 0; open requests 0; RSS 147–157 / 182–183 MB | 30/30 once | C1 C2 C8 | PASS |
| Startup | Billing before Payment; broker down; DB down | – | Billing ready without Payment (0.7 s), request `sending`; broker down: Billing exits 1 (by design), Payment unready; DB down: both unready | Payment started: request sent after the stale window (57.9 s), 1 payment; both recover in place | C6 C7 | PASS |
| Containers | production images, `docker stop -t 60`: broker stopped; PostgreSQL paused; broker frozen (3 each), 10 frozen-broker cycles | – | broker stopped: exit 0 in 0.3–0.5 s, restarted while down Billing exits and runs again when it returns; PostgreSQL paused: Payment exit 0 at 33.0–33.2 s; frozen broker: exit 0 at 27.0 / 28.7 s | ready again; 1 consumer; outbox drained; one event | C10 C12 | PASS |

**Timings** (local, 3 runs, median [range]; not production SLOs):

| Path | Time |
|---|---|
| Payment stopped → Billing cancel answers 503 | 13.4 ms [12.0–13.6] |
| Payment hung → Billing cancel answers 503 | 5.01 s [5.009–5.010] |
| Payment DB down / hung → Billing cancel 503 | 12–15 ms / 5.01–5.02 s |
| RabbitMQ outage → Billing and Payment unready | 18.8 ms [13.3–19.6] |
| RabbitMQ back → Billing consumer restored | 4.33 s [4.28–4.51] |
| RabbitMQ back → every delayed event applied | 5.76 s [5.70–5.94] |
| Billing restarted with queued events → applied | 0.75 s [0.73–0.79] |
| A service's DB back → ready again (no restart) | 53–65 ms |
| Payment back → a request left `sending` is sent | 49–59 s (the 60 s stale window) |
| Billing + Payment restarted together → converged | 2.8 s [2.7–2.8] |

**Resources.** Steady after every campaign:
- 1 Billing consumer, 2 broker connections and 2 channels (Billing's bus and Payment's publisher);
- database sessions 2–5 per service;
- 0 sessions idle in a transaction after recovery;
- outboxes drained;
- no process left behind.

**Findings (correctness intact; no production change).**
- **O1 (15.8):** after a failed send, a request stays `sending` until `BILLING_DISPATCH_STALE_SENDING_MS` (60 s) before it is resent,
  so Billing → Payment recovery takes ~50–60 s after Payment returns (A, startup order, R). Correct and bounded; a tuning question
  (retry delay after a transient failure vs the stale window).
- **O2 (NEEDS SRE DECISION):** Billing and Payment report `/ready` 503 while RabbitMQ is down (the 15.3 `rabbitmq` check), although
  their synchronous HTTP keeps working: Billing's cancel still gets Payment's confirmation, and Payment's API writes to its outbox. An
  orchestrator that routes on `/ready` would take both out of service for a broker outage. Keep (readiness = "can do all of its work,
  including async") or split (serve HTTP, alert on the broker)?
- **O3 (observability, 15.7):**
  - a DB-backed Billing read with its database down answers a generic 500 (never success, deterministic), not a 503;
  - Payment's own 5xx is classified by Billing as unconfirmed (503).
- **O4 (15.7):** a message dead-lettered during a long Billing database outage stays in `billing.payment-events.dead` after the
  reconciler has applied its effect. Replaying it is safe (receipt), but the DLQ depth alarm stays raised: DLQ hygiene and retention.
- **O5 (15.7):**
  - the same fact under a new event id adds an `ignored` receipt row (growth);
  - receipts record `causeType` `payment_event` even when the reconciler applied the effect (known since 15.4).
- **O6 (by design, Stage 20):** Billing must run under a restart policy; it exited and was restarted 4–6 times until the broker
  returned (J, M, containers).
- **O7 (hygiene):** the Auth deploy writes `PAYMENT_SERVICE_URL`, which Auth's code never reads.

### 13.7 Data growth and log volume (15.7)

**Question.**
- Which Core tables grow, how fast, and do the services' own queries degrade as they grow?
- Which data needs retention or cleanup, and under which safety conditions?
- How much do the services log when healthy and during outages, and are those logs useful and free of sensitive data?
- Which decisions belong to product, security, SRE or legal rather than to engineering?

**Harness.** `scripts/validation/growth-campaigns.mjs` (campaigns `growth`, `outboxOutage`, `logVolume`, `dlqLifecycle`,
`edgeProbes`), on its own throwaway RabbitMQ and PostgreSQL containers, with real Billing and Payment processes
(`lib/core-stack.mjs`, which gains an `unavailable` 503 mode on the Billing → Payment fault proxy) and real Auth and Organization for
their probes.
- **Volume.** Synthetic volume is made by cloning the rows the real flow wrote (45 paid, 4 cancelled and 1 open lifecycle):
  - the status mix, row sizes and cross-table references are the services' own;
  - uuid keys are remapped consistently across tables, so references still meet;
  - times are spread back one second per copy;
  - it is loaded with the services stopped, triggers and foreign keys off for the loader session only; CHECK constraints stay on.
- **Synthetic rows.** Auth, Organization and `webhook_event` have no flow here: their rows are synthetic, one row per lifecycle, as a
  scale proxy. The webhook bodies are about 400 B of generated JSON with no real data.
- **Queries.** Each query is the service's own SQL, run under `EXPLAIN (ANALYZE, BUFFERS)` 3 times after `VACUUM ANALYZE`; writes are
  rolled back.
- **Logs.** Log lines are counted and templated, never copied.
- **Baseline.** `7908ab9`, Node 24.18, PostgreSQL 16, RabbitMQ 3.13.

**Growth per business operation** (measured through the real APIs; rows per operation):

| Operation | Billing | Payment |
|---|---|---|
| Create an invoice and its payment request (issue, dispatch) | `billing_transition` 5, `invoice` 1, `invoice_line` 1, `payment_request` 1, `outbox` 1 | `payment` 1, `outbox` 1 |
| Pay (attempt, sync) → paid | `billing_transition` 2, `payment_event_receipt` 1 | `payment_attempt` 1, `idempotency_key` 1, `outbox` 1, `kit_rate_limit` 1 per new payer |
| Cancel → cancelled | `billing_transition` 1, `payment_event_receipt` 1 | `idempotency_key` 1, `outbox` 1 |
| Bytes per lifecycle (this mix, heap + indexes) | 18.4 KB | 11.0 KB |

- No service writes the kit `inbox` today: Billing's consumer de-duplicates on its receipt; nothing else consumes.
- Neither Payment nor Billing ever deletes a row. The only DELETEs in Core are Auth's `auth_throttle` and the kit's `kit_rate_limit`
  reset of one key after a success, and an unconfirmed TOTP factor.

**Storage at volume** (total including indexes and TOAST):

| Lifecycles | Billing | Payment | Auth (proxy) | Organization (proxy) |
|---|---|---|---|---|
| 1 k | 7.2 MB | 4.8 MB | 1.7 MB | 0.8 MB |
| 10 k | 59.5 MB | 41.7 MB | 8.5 MB | 4.8 MB |
| 50 k | 298 MB | 211 MB | 37.9 MB | 22.2 MB |
| 100 k | 597 MB | 421 MB | 74.4 MB | 43.9 MB |

Growth is linear. The largest tables at 100 k lifecycles:
- `billing_transition` 262 MB: 688 k rows, heap 140 MB, indexes 122 MB;
- Payment `outbox` 188 MB (198 k rows) and Billing `outbox` 134 MB (100 k rows): **32 % of both databases is published outbox rows
  that nothing reads again**;
- `invoice` 99 MB, `webhook_event` 58 MB, `payment_attempt` 53 MB, Payment `idempotency_key` 50 MB;
- Payment `kit_rate_limit` 29 MB: 92 k rows, one per distinct payer, never removed.

After the load, both services start against the 100 k databases and are ready in 1.3 s. A new lifecycle completes normally: paid,
one receipt, one terminal event.

**Query time at volume** (median ms of 3 [range]; the scan at 100 k):

| Query (service) | 1 k | 10 k | 50 k | 100 k | Plan at 100 k |
|---|---|---|---|---|---|
| Outbox claim (both) | 0.06–0.08 | 0.05–0.09 | 0.10–0.12 | 0.14–0.15 | partial index on unpublished rows, 1 buffer |
| Dispatcher claim (Billing) | 0.07 | 0.09 | 0.08 | 0.14 | partial index `payment_request_dispatch_idx` |
| Reconciler scan (Billing) | 0.05 | 0.41 | 2.39 | 3.36 [3.29–14.97] | bitmap on two partial indexes (2 000 open requests at 100 k) |
| **ExpirySweeper scan (Payment)** | 0.11 | 1.81 | 4.84 | **11.27 [11.16–13.87]** | **sequential scan of `payment`** (4 132 buffers) |
| AttemptResolver scan (Payment) | 0.06 | 0.03 | 0.03 | 0.04 | partial unique index on open attempts |
| Webhook retrier scan (Payment) | 0.07 | 0.08 | 0.13 | 0.10 | partial `webhook_event_retry_idx` |
| Receipt by event id, receipts by request, invoice list of a payer, history of an entity (Billing) | ≤ 0.06 | ≤ 0.05 | ≤ 0.05 | ≤ 0.06 | index scans |
| Idempotency lookup, webhook dedupe, payment by id / by request (Payment) | ≤ 0.18 | ≤ 0.11 | ≤ 0.06 | ≤ 0.09 | index scans |
| Rate-limit / throttle upsert (Billing, Auth), inbox dedupe insert | ≤ 0.12 | ≤ 0.11 | ≤ 0.22 | ≤ 0.26 | unique index |
| Refresh token by hash, audit of an actor, Organization idempotency lookup | ≤ 0.08 | ≤ 0.10 | ≤ 0.06 | ≤ 0.07 | index scans |

- Every request-path query stays flat under 0.3 ms. The hot worker claims use partial indexes, so published or terminal rows cost them
  nothing.
- **The ExpirySweeper scan is the one query that grows with the whole table:** 5 s interval, linear, about 110 ms per pass at 1 M
  payments by extrapolation. It is handed to 15.8 (a partial index on open payments); nothing was changed.
- The reconciler scan grows with the number of *open* requests, which is expected.
- Cleanup-shaped queries have no supporting index and scan sequentially (7.6–25 ms at 100 k): published outbox rows older than X,
  expired throttle windows, expired or revoked refresh tokens, expired kit rate-limit windows. They matter only if a cleanup is built.
- **Index finding:** `billing_transition` has a unique and a non-unique index on the same `(entityType, entityId, revision)`. The
  planner uses the non-unique one, and the duplicate costs roughly 50 MB per 100 k lifecycles. For 15.8 or a schema cleanup; not
  changed here.

**Outbox accumulation while RabbitMQ is unreachable** (Payment's broker edge refused, 100 payments paid, 3 runs):

| Measure | Result |
|---|---|
| Payments still succeed while the broker is gone | 100/100 (3.4–4.0 s for 100 pays) |
| Pending events (100 settlements plus earlier creation events) | 123–124 rows, 328–336 KB of table |
| Relay attempts per row after about 10 s | 4 (the backoff doubles; 60 s ceiling) |
| Payment log lines during the outage | 8–9 (`outbox_relay_pass_failure`, one per pass, not one per row) |
| Drain after the broker returns | **7.6 s [7.3–8.0]**, all applied in Billing 7.6 s [7.3–8.1] |
| Accounting | 100 paid, one payment, one applied receipt and one terminal event each, 0 cross-tenant |

The drain waits for the relay's next backoff slot, not for throughput. After a long outage (60 s ceiling) the first publish can be up
to 60 s after the broker returns; that belongs to the 15.8 handoff (outbox retry and backoff).

**DLQ residue after reconciliation (O4) and cause attribution (O5)** (3 runs):
1. A cancellation event is dead-lettered while Billing's database is down (`retries_exhausted`).
2. The reconciler settles the request from Payment's API: `billing_transition` records `causeType = reconciliation`, correctly.
3. The DLQ still holds 1 message, so `nawara-check-dlq` keeps alarming.
4. `nawara-dlq` inspect, then replay → `consumed`: Billing acknowledges it as `ignored / already_applied` under its own event id. That
   adds one receipt row and makes no second effect (one applied receipt, request `cancelled`, one payment).
5. DLQ depth 0; a second replay → `not_found`.
- **Lifecycle (O4):** the residue is expected and the existing tooling already resolves it safely. The runbook is: inspect, confirm
  the request is settled, **replay** (never purge). The replay is idempotent and leaves an auditable receipt. Purging would lose
  that record. An automatic TTL or purge is not adopted: it would silently drop a message whose effect might *not* have been
  reconciled (for example an event about a request that has no `paymentId`).
- **Growth (O5):**
  - replaying the same fact under a new event id adds one `ignored` receipt row (about 150 B). There is at most one extra row per
    replay and per reconciler-applied fact (the reconciler's synthetic id is deterministic, so repeated passes do not add rows);
  - receipts are append-only and are billing evidence (below): no cleanup.
- **Attribution (O5):** receipts written by the reconciler say `causeType = payment_event`.
  - The schema reserves `reconciliation` for receipts **without** an event id (constraint `payment_event_receipt_event_iff_event`).
    The reconciler needs a deterministic synthetic id to stay idempotent: without it, a reconciliation that ends `deferred` or
    `conflict` would add one receipt on every pass.
  - The authoritative history (`billing_transition`) already attributes the effect to `reconciliation`, and the synthetic id is
    reproducible (uuid v5 of `paymentId:status:reconciliation`).
  - So the receipt field is **ambiguous but not misleading about what happened**. Correcting it needs a migration that relaxes that
    CHECK, on an append-only table. **Not changed:** the benefit is cosmetic and the table is evidence (engineering decision, low
    priority).

**Billing's 500 when its database is gone (O3).**
- **Reproduced:** `GET /billing/invoices/{id}` and `GET /billing/payment-requests/{id}` answer `500 {"message":"Internal server error",
  requestId}` and log `unhandled error error=Error detail="connect ECONNREFUSED <host>:<port>"` with a request id and correlation id.
- **Contract:** this is the kit filter's documented behaviour for every Core service: anything that is not an `HttpException` is an
  opaque 500. The Billing and Payment SDDs say only "database unavailable: `/ready` fails; requests fail; nothing is half-applied",
  and `/ready` does answer 503. So it is **not a contract defect**, and it is not Billing-specific.
- **Observability and classification gap:**
  - the filter logs the raw message rather than the Stage 14.7 facts (`describeFailure`: class, code, kind);
  - so an unavailable database cannot be told from a bug by the log's fields, and a host:port reaches the log.
- **Options:**
  - (a) log `describeFailure` facts in the filter: logs only, no contract change;
  - (b) map classified database-unavailable kinds to 503: an API contract change for all four services and their clients' retry
    semantics.
  - Neither was made here: (a) is an engineering follow-up; (b) needs an API decision.

**Log volume** (Billing + Payment, 30 s fault windows with `/ready` and `/health` probed every second on both; per minute):

| Scenario | Billing | Payment | Useful? |
|---|---|---|---|
| Healthy, idle (108 probes) | 0 | 0 | probes are not logged |
| Healthy, 20 lifecycles | 79 lines / 23 KB (info, 2 templates) | 0 | one line per dispatch and per applied event, with correlation id |
| Both databases refused | 268 lines / 60 KB | 104 / 23 KB | one line per worker **pass** with `code=ECONNREFUSED kind=network_unreachable`; readiness failed / recovered once each |
| RabbitMQ stopped | 17 / 3.7 KB | 2 / 0.6 KB | `rabbitmq_consumer_lost` once, `reconnect_failed` per backoff attempt, readiness once |
| RabbitMQ frozen | 4 / 1 KB | 2 / 0.6 KB | readiness `ReadinessCheckTimeout`, consumer lost at the heartbeat, consumer recovered |
| Payment API hung (blackhole) | 12 / 3.5 KB | – | one `payment_dispatch_failure reason=transient` per request per timeout |
| Payment API 503 / refused, 20 requests | 435 / 127 KB | – | `payment_dispatch_failure` plus `stale_recovery` per request per retry: **grows with the backlog** |
| Consumer retry storm (Billing DB down, 20 events) | 644 / 181 KB | – | per event: 4 failures, 3 `event_retry_scheduled`, `retry_exhausted`, `dead_lettered` (bounded by the retry budget) |

- **Intervals.** These campaigns use test intervals (dispatch every 300 ms, stale send 5 s). With the defaults (2 s, 60 s):
  - per-pass lines fall to 60 per minute for the outbox relay (1 s), 30 for the dispatcher (2 s) and 12 for the 5 s workers;
  - per-request retry lines fall to 1–2 per request per minute.
- **Scaling.** Pass-level lines are independent of the backlog; per-item lines scale with it (10 k stuck requests → about 20 k lines
  per minute at the defaults).
- **Every fault announces itself, and every recovery announces itself:**
  - `readiness_check_recovered`, `rabbitmq_consumer_recovered`, `payment_dispatch_success`, `payment_reconcile_success`;
  - per-item lines carry `correlationId`;
  - pass-level lines deliberately do not.
- **Resources** (default dispatch interval, 20 s phases):
  - CPU 0.6–1.4 % per service in every phase (idle, both databases down, 50 requests retrying against a 503);
  - RSS 133–171 MB;
  - database sessions 0 during the outage, 1–4 after it;
  - 0 idle in transaction; 2 broker connections, 3 channels.
- **Sensitive data** (1 199 captured lines, plus the O3 lines):
  - no bearer token, password, secret, authorization header, URL credential, `token=`, cookie, or either live service credential;
  - 0 non-JSON lines;
  - the only data beyond ids is a database host:port in the O3 `unhandled error` detail.

**Carried log gaps, resolved or classified:**
- **Failure taxonomy gaps** (engineering, logs only):
  - `readiness_check_failed check=rabbitmq error=Error` carries no code or kind;
  - the late write after pool close (15.5) logs `error=Error` with no kind: pg-pool's "Cannot use a pool after calling end" is not in
    `BY_PG_MESSAGE`;
  - an idle-in-transaction termination is logged as `db_connection_lost` (15.2);
  - the 500 filter logs a message instead of facts (O3).
  - Recommended: add `db_pool_closed` and broker-refused kinds, and facts in the filter. **Not changed** (observability only;
    correctness intact).
- **Level inconsistency:** a pass failure is `warn` in the outbox relay but `error` in the dispatcher, reconciler, ExpirySweeper,
  AttemptResolver and webhook retrier. An SRE paging rule should key on the event name, not on the level.
- **ExpirySweeper visibility:** it logs only pass failures. An expired payment produces no log line, only its `payment.expired` event.
  A payment skipped because an attempt is open (head-of-line, 15.4) is silent. Its scan is the one query that grows (above).
- **Reconciler versus event attribution:** in logs it is clear (`payment_reconcile_success` versus `payment_event_applied`), and in
  `billing_transition` too. It is ambiguous only in the receipt (O5).
- **Worker and retry signals:** present and bounded (above).
- **Auth health rate limit (15.5 / 15.6):**
  - `/auth/health`, `/health` and `/ready` share Auth's global throttle (`BASELINE_RATE_LIMIT_PER_MINUTE` = 100 per address);
  - probed 6 times per second from one address, Auth answered **429 on 77/127 `/auth/health` and 78/127 `/health` probes**, from
    25 s;
  - Auth logged **nothing** about it;
  - Organization (kit health) never limited its probes (254 × 200);
  - behind a gateway, where every client shares one address, ordinary traffic can starve the healthcheck.
  - **NEEDS SRE / SECURITY DECISION:** exempt the probes from the throttle, or key the throttle on the forwarded client address.
- **Shutdown log volume (15.5):** a bounded, constant number of lifecycle lines per shutdown (13.5.x). No change.

**Retention decision matrix.** No duration is invented: the repository establishes only Payment's `IDEMPOTENCY_TTL_HOURS` (24,
configured) and nothing else.

Lifecycle classes: A permanent business, B long-lived history, C temporary operational, D idempotency, E retry / recovery, F security /
rate limit, G raw provider payload, H unknown.

| Dataset | Class | Growth | Cleanup today | Safe to delete when | Decision |
|---|---|---|---|---|---|
| `invoice`, `invoice_line`, `payment_request`, `payment`, `payment_attempt`, products, prices, subscriptions | A | 1 per lifecycle (transitions 6.9) | none | never by a technical job (financial records) | legal / product (B-032, O-17) |
| `billing_transition`, `payment_event_receipt` | B (evidence) | 6.9 and 1–2 per lifecycle | none, append-only triggers | only under a legal retention period, by an archival process | legal |
| `auth_audit_event`, Organization `admin_actor_event`, `ownership_event`, `hierarchy_authority_event` | B (security / audit) | per security event | none, append-only | after the audit retention period; Audit service later | security / legal |
| `outbox` (Organization, Billing, Payment), published rows | C | 1–2 per lifecycle, 32 % of storage | none | `publishedAt` is set **and** older than the replay / forensics horizon (the relay reads only unpublished rows) | SRE (horizon), NEEDS DECISION |
| `outbox`, unpublished rows | E | during broker outages | – | **never** (undelivered events) | – |
| `inbox` (kit, in Organization, Billing and Payment) | D | **0: no service consumes through the kit inbox today** (Billing's receipt is its dedupe) | none | when a consumer adopts it: only after the broker can no longer redeliver that event id (redelivery and DLQ replay horizon) | SRE, when first used |
| Payment `idempotency_key` | D | 1 per attempt or cancel | none (`expiresAt` written, **never read**) | `expiresAt < now()`: the SDD defines expiry (≥ 24 h, configured) and says an expired key is treated as new, safe because every money-moving creation also has a permanent natural key | engineering; the horizon is established. See D1 |
| Organization `idempotency_key` | D | 1 per create | none, **no expiry column** | undefined: no retry horizon exists | product / API, NEEDS DECISION |
| `webhook_event`, rows | E, then B | 1 per verified delivery | none | the state is terminal (`processed`, `ignored`, `failed` with exhausted or malformed) **and** the dispute / audit period has passed | legal / product (O-17) |
| `webhook_event.rawBody` | G | the provider's body size | none; immutable (`forbid_column_change`) | the retrier needs it while the state is retryable (`parseStoredBody`). After that it is dispute evidence only | **NEEDS PRODUCT / SECURITY / LEGAL DECISION** (O-17); may contain payer personal data from real providers |
| `kit_rate_limit`, `auth_throttle` | F | 1 per distinct identifier (Payment: 1 per payer) | per-key reset after a success | `windowStart` older than the bucket's longest window (such a row is equivalent to an absent one: the upsert restarts it) | engineering (technical, no policy needed); the kit needs the buckets' maximum window |
| `refresh_token` | F | 1 per login or refresh | none (ADD: "a known operational need") | the family is dead (all revoked or expired). A rotated-out token is the reuse detector: deleting it turns a late theft signal (`session.refresh_reuse_detected`, audited) into "unknown token"; non-operator families have no ceiling | security, NEEDS DECISION |
| Expiring Auth challenges (`owner_auth_challenge`, `owner_step_up`, `admin_operator_code`, `member_contact_verification`, `owner_recovery_request`), `device` | C / F | per flow | none | after expiry plus the audit need; `device` has an open privacy question (ADD) | security / privacy |
| DLQ messages | E | per exhausted event | operator replay | after replay (`consumed` or `not_found`); **never purged unseen** | SRE runbook |
| `schema_migrations`, `ownership_import_run`, `hierarchy_id_ledger` | A | constant | – | never | – |

**D1 (documentation versus code, not a correctness defect):**
- Payment's SDD says keys expire after the configured retention and an expired key is treated as new. The code writes `expiresAt`
  and never reads it, so an old key replays forever, which is the stricter behaviour (no double effect is possible).
- Honouring the SDD needs either a cleanup of expired keys or an expiry check in `reserve`. Both change what a client sees on a
  retry after 24 h: re-execution instead of a replay. Both are safe by the SDD's argument.
- Recommended as the first cleanup to build; not built in 15.7 (API behaviour change).

**Cleanup design (not implemented).** Every candidate deletion is either:
- blocked on a duration that no document establishes (outbox, inbox, webhook bodies, audit, refresh tokens, Organization keys), or
- purely technical but not needed at the measured volume, while it would add a new periodic worker to Core: expired rate-limit
  windows (Payment's 92 k rows at 100 k payers = 29 MB) and expired Payment idempotency keys (D1).

When built, each cleanup should:
- be a kit `PollLoop` worker deleting in bounded batches (`DELETE … WHERE ctid IN (SELECT … LIMIT n)`) on an index that exists for it:
  - `outbox ("publishedAt") WHERE "publishedAt" IS NOT NULL`;
  - `kit_rate_limit ("windowStart")`;
- never touch unpublished outbox rows, retryable webhooks, or append-only evidence;
- be proven with the ≥ 20-iteration concurrency campaign against the live writer, for example a rate-limit sweep racing `hit`: the
  sweep re-evaluates `windowStart` on the locked row, so a row restarted by `hit` is kept.

No cleanup was implemented, so there is no concurrency proof to report.

**Results.**
- **PASS:** growth measured and linear; every request-path and claim query stays flat to 100 k; the services start and work at size.
- Outbox accumulation and drain are exact (3/3).
- The DLQ residue is resolved by the existing replay with no second effect (3/3).
- No sensitive data in any captured log line.
- No production code changed. The findings are handed off below and in section 16.

**Handoff to 15.8 (no value changed in 15.7):**

| Item | Evidence | 15.8 question |
|---|---|---|
| ExpirySweeper full scan | 11.3 ms at 100 k payments, linear, every 5 s | partial index on open payments with `expiresAt`, and the interval |
| Outbox backoff after an outage | drain waits for the next backoff slot (7.6 s after a 10 s outage, up to 60 s) | reset or shorten the backoff when the broker returns |
| Per-request dispatch retry logging | about 2 lines per stuck request per stale cycle | aggregate per pass, or accept; tied to the 60 s stale window (O1) |
| Duplicate `billing_transition` index | about 50 MB per 100 k lifecycles | drop the non-unique twin (a migration) |
| Cleanup-shaped scans | 7.6–25 ms sequential at 100 k | indexes only when a cleanup is built |
| Auth probe throttling | 429 on health probes, silent | probe exemption or throttle key (SRE / security) |

### 13.8 Capacity and runtime tuning (15.8)

**Question.** Are the pools, worker concurrency, RabbitMQ behaviour, batch sizes, polling intervals, timeouts and recovery mechanisms set to
safe, explainable defaults, and do they scale out without weakening correctness?

**THIS MACHINE IS NOT A PRODUCTION CAPACITY MODEL.** Every number below is relative:
- a knob before and after, or one value against another, on one laptop;
- the laptop is 12th-gen Core i5-12450H (12 threads), 11.4 GiB RAM of which about 4 GiB is free, Docker 28.5.2 with no CPU or memory
  limits, and PostgreSQL 16 / RabbitMQ 3.13 in throwaway containers on loopback;
- nothing here says how many users or requests per second production supports.

**Method.**
- **Harness:**
  - `scripts/validation/capacity-campaigns.mjs` (new);
  - `lib/load.mjs` (new): a dependency-free load generator with fixed concurrency and duration, a 10 s warm-up, keep-alive
    connections, p50/p95/p99 and status counts;
  - the fault proxy in `lib/core-stack.mjs` gained a `slow:<ms>` mode and records which payment request each call carried.
- **Runs:**
  - each benchmark is 3 measured runs after a warm-up;
  - median [min–max] throughout;
  - load runs are 60 s (pool experiments 30 s);
  - kit-level outbox and backlog campaigns 3 runs; prefetch 3 clean runs plus 1 SIGKILL run.
- **One dimension at a time:**
  - every "before" was measured on the unchanged build of `c2a5108`;
  - every "after" on the final build;
  - a candidate was kept only with its correctness proof: a focused test that fails when the change is reverted (mutation), plus the
    historical campaigns it can affect.
- **Regression thresholds** (set before interpreting any result): a candidate fails on any correctness regression, a new duplicate
  effect, lost work, a cross-tenant write, an unbounded wait, a connection leak, memory growth, worker starvation, provider-call
  amplification, an unexplained p99 regression, or worse recovery without a compensating benefit.

**Runtime knob inventory** (from the code at `c2a5108`; ★ = changed by 15.8):

| Knob | Default | Bounds | Used by | Why it exists | Evidence |
|---|---|---|---|---|---|
| `DB_POOL_MAX` | 10 | 1–100 | every service | concurrent database work per process | 15.8: 5 → 10 +19 % throughput; 20 no faster, p99 ×2 |
| `DB_CONNECTION_TIMEOUT_MS` | 5 000 | 100–60 000 | every service | bounded wait for a pool client or a connection | 15.2, 15.8 exhaustion: waits end at 5.0 s |
| `DB_STATEMENT_TIMEOUT_MS` / `DB_QUERY_TIMEOUT_MS` | 30 000 / +5 000 | 1 000–600 000 / must exceed statement | every service | server cancel / silent-server bound | 15.2 (I9) |
| `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` | 60 000 | 1 000–3 600 000 | every service | a leaked transaction cannot hold locks for ever | 15.2 |
| `RABBITMQ_HEARTBEAT_S` | 10 | 5–60 | Billing, Payment | silent-broker detection | 15.3.1 |
| `RABBITMQ_CONFIRM_TIMEOUT_MS` | 5 000 | 100–60 000 | Billing, Payment | bounded publisher confirm | 15.3 |
| bus connect timeout / consumer reconnect | 5 s / 0.5–30 s | code | kit bus | bounded reconnect | 15.3 |
| ★ consumer prefetch | was 10 (hard-coded); now 5, Billing `min(10, max(1, DB_POOL_MAX / 2))` | 1–100 | kit bus, Billing consumer | unacknowledged deliveries = concurrent handlers = pool clients | 15.8 below |
| event retry | 3 × 5 000 ms | 0–10, 100–300 000 | Billing consumer | transient handler failures, then DLQ | 15.3, 15.6 |
| outbox relay interval / batch | 1 000 ms / 50 | code | kit relay (Billing, Payment) | at-least-once publication | 15.8 below |
| ★ outbox relay pass | was one batch per poll; now full batches back to back for at most 1 000 ms (`maxPassMs`) | code | kit relay | backlog drain | 15.8 below |
| ★ outbox backoff | 1 s × 2ⁿ per row, ceiling was 60 s, now 15 s | code | kit relay | no hot loop during an outage | 15.8 below |
| `BILLING_DISPATCH_INTERVAL_MS` / `_BATCH_SIZE` | 2 000 / 50 | 100–300 000 / 1–1 000 | Billing dispatcher | sends committed requests to Payment | 15.8: batch 50 kept |
| `BILLING_DISPATCH_STALE_SENDING_MS` | 60 000 | 1 000–3 600 000; ★ now also ≥ 2 × `PAYMENT_TIMEOUT_MS` | Billing dispatcher | re-send after a lost or failed send | 15.4, 15.6 O1, 15.8 |
| `BILLING_RECONCILE_INTERVAL_MS` / `_STALE_REQUESTED_MS` / batch | 30 000 / 300 000 / 50 | 1 000–3 600 000 / 1 000–86 400 000 / code | Billing reconciler | settles lost events from Payment's API | 15.6 |
| ExpirySweeper interval / selection | 5 000 / all due ids | code | Payment | expires payments past `expiresAt` | ★ 15.8: index + SKIP LOCKED |
| AttemptResolver interval / batch / ★ lease | 5 000 / 100 / 5 000 ms | code | Payment | settles stuck attempts by asking the provider | ★ 15.8: lease |
| WebhookRetrier interval / batch / stuck / attempts | 5 000 / 100 / 10 s / 10 (10 s × 2ⁿ) | code | Payment | reprocesses failed or stuck deliveries | 15.4 |
| `PAYMENT_TIMEOUT_MS` | 5 000 | 100–60 000 | Billing → Payment | bounded internal call | 15.6, 15.8 |
| `AUTH_TIMEOUT_MS` | 3 000 | 100–30 000 | Billing, Payment, Organization → Auth | bounded identity check | 15.6 |
| provider timeout | per provider (`capabilities.timeoutMs`; test provider 200 ms) | adapter | Payment attempts, resolver | provider-specific | no real adapter yet |
| readiness check timeout / broker connect | 2 000 / 2 000 ms | code | every service | bounded `/ready` | 15.8: `/ready` 55 ms |
| `HTTP_DRAIN_TIMEOUT_MS` / worker drain | 5 000 / 5 000 | 500–120 000 / code | every service | bounded shutdown | 15.5 |
| `BASELINE_RATE_LIMIT_PER_MINUTE` | 100 (per address) | 1–1 000 000 | Auth (every route) | brute-force brake | 15.7, 15.8 finding |

**Baseline load profile.** The mix below, at light (4), moderate (16) and pressure (64) concurrent clients:
- Billing invoice read 30 %;
- Billing draft-invoice create 10 %;
- Payment read (service token) 25 %;
- Organization reference read (service token) 15 %;
- Auth `/auth/health` 20 %, with Auth's baseline limit raised for the test.

| Level | rps | p50 | p95 | p99 | errors | CPU Billing / Payment / Auth / Org | RSS max (MB) | DB sessions | PostgreSQL CPU |
|---|---|---|---|---|---|---|---|---|---|
| idle | – | – | – | – | – | 3.3 / 0.5 / 0.1 / 0.1 % | 193 / 159 / 185 / 156 | 8 | – |
| light | 2 011 [1 988–2 177] | 1.37 | 7.05 | 8.67 [8.26–8.73] | 0 | 52 / 23 / 50 / 14 % | 278 / 303 / 411 / 258 | 16 | 128 % |
| moderate | 2 807 [2 804–3 196] | 2.95 | 20.2 | 30.2 [25.1–31.3] | 0 | 78 / 37 / 89 / 21 % | 289 / 329 / 451 / 254 | 35 | 205 % |
| pressure | 2 897 [2 882–2 906] | 8.70 | 66.7 | 139.7 [128.1–151.7] | 0 | 83 / 39 / 94 / 22 % | 302 / 329 / 445 / 246 | 40 | 219 % |

- **First bottleneck:** a service's single Node event loop. At pressure, Billing uses 83–92 % of one core, with its pool fully used, and
  Auth 94 %. PostgreSQL, at about 2.2 cores, is not the limit.
- **Degradation is graceful:** throughput flattens between moderate and pressure, and latency grows with it; there are no errors and no
  timeouts.
- **Auth's CPU is the in-memory throttler, not its work:**
  - `@nestjs/throttler` 6.7 keeps one timer per request per key, and every timer that fires filters the key's whole list: quadratic in
    requests per key;
  - so with the baseline limit raised, one probing address makes Auth spend 94 % of a core at 579 rps (Organization: 22 % at 434 rps)
    and stay at 36 % for many seconds after the load ends;
  - at the default limit (100 per minute) each key stays small;
  - see the Auth health-probe decision below.

**Database pool size** (Billing only, 75 % reads / 25 % writes; 3 × 30 s):

| `DB_POOL_MAX` | c16 rps | c16 p50 / p99 | c64 rps | c64 p50 / p99 | sessions | PostgreSQL CPU |
|---|---|---|---|---|---|---|
| 5 | 1 464 | 10.4 / 23.5 | 1 275 | 49.2 / 74.2 | 5 | 160–198 % |
| **10** (default) | **1 735** | 6.35 / 43.4 | 1 530 | 40.2 / 76.0 | 10 | 186–217 % |
| 20 | 1 642 | 4.24 / 73.6 | 1 616 | 33.5 / **145.7** | 17–20 | 223–267 % |

Decision: **keep 10**.
- 20 gives no throughput (Billing is CPU-bound) and doubles the tail latency, while costing twice the database connections.
- 5 loses 16–19 % throughput.

**Pool exhaustion** (3 runs):
- **Setup:** every Billing pool client was blocked by an `ACCESS EXCLUSIVE` lock on `invoice`, held for 15 s, while 100 concurrent reads
  arrived.
- **Result, each run:**
  - 90 reads answered 500 at 5.01–5.09 s (`DB_CONNECTION_TIMEOUT_MS`);
  - the 10 that held a client answered 200 when the lock was released (15.0–15.1 s);
  - 0 sessions idle in a transaction afterwards, 10 sessions (the pool);
  - the next read 200 in 2–5 ms, `/ready` 200.
- The waits are bounded, nothing leaks, and the service recovers with no restart (the Stage 15.2 guarantees).
- The 500, rather than a 503, is the O3 classification question (15.7), unchanged.

**Database connection budget.**
- **Formula for a deployment:** Σ over services (`DB_POOL_MAX` × processes) + one migration runner per service being deployed
  + operator / CLI sessions (`psql`, `nawara-check-outbox-lag`, backups) + `superuser_reserved_connections` (3) ≤ `max_connections`
  (100 on both the Compose and the throwaway PostgreSQL).
- **Observed per process:**
  - idle: 1–2 sessions per service;
  - load: every process reaches its pool (4 services × 10 = 37–40 sessions at pressure);
  - so plan with the theoretical maximum, not the idle count.
- **With the defaults (pool 10):**
  - 1 process per service = 40 + about 10 reserve;
  - 2 per service = 80 + about 10: this fits under 100, but only just;
  - more processes need a larger `max_connections` or smaller pools (pool 5 costs about 16 % per process).
- No replica count is established by the deployment architecture yet (Stage 20).
- Multi-instance measurement: 1 / 2 / 4 Billing processes on one database, pool 10 each, 64 clients, 3 × 30 s, 0 errors throughout:

| Profile | 1 instance | 2 instances | 4 instances |
|---|---|---|---|
| Read only: rps / p99 | 3 776 / 27.2 ms | – | 5 197 / 47.0 ms (+38 %) |
| Reads 75 % + writes 25 %: rps / p99 | 1 887 / 48.5 ms | 2 678 / 61.7 ms | 1 807–2 973 / 80–259 ms |
| Billing sessions under load (theoretical n × 10) | 10 (10) | 20 (20) | 40 (40), against max_connections 100 |

- **Reads scale** until this machine's 12 threads saturate: 4 instances at about 80 % each, plus PostgreSQL and the load generator.
- **Writes of one caller serialise on its rate-limit counter.** Every create increments the same `kit_rate_limit` row, and at 4
  instances the sessions wait on `Lock:transactionid` and WAL sync.
  - The low 4-instance figure came after 1 and 2 instances had already written many invoices; the fresh run gave the high figure.
  - The default limit (300 creates per minute per caller) caps one caller far below that point.
  - It only matters where a caller's limit is raised: then run fewer, bigger instances, or partition the caller.
- **Sessions reach exactly the theoretical pool total under load:** plan the budget with n × pool.

**ExpirySweeper scan** (the sweeper's own query, 97 % closed / 2 % open with a future expiry / 1 % open without one; median of 3):

| Payments | Without index | With `payment_expiry_open_idx` | Index size |
|---|---|---|---|
| 1 k | 0.18 ms, seq scan, 31 buffers | 0.035 ms, index scan, 1 buffer | 16 KB |
| 10 k | 1.15 ms, 304 buffers | 0.041 ms | 16 KB |
| 50 k | 6.20 ms, 1 516 buffers | 0.049 ms | 16 KB |
| 100 k | 15.0 ms, 3 031 buffers | 0.036 ms | 32 KB |
| 500 k | 31.6 ms, 15 158 buffers | 0.058 ms | 88 KB |

- **Write cost:** inserting 10 k payments took 294 ms without the index and 285 ms with it (median of 3), because the index holds only
  open payments.
- **Kept:** migration `0007_payment_expiry_open_index.sql`. The scan's cost now follows the open payments, not the history.

**ExpirySweeper head-of-line blocking.**
- **Before:** the per-payment `SELECT … FOR UPDATE` waited on a payment another transaction held. With one expired payment locked for
  the whole observation, **0 of 1 000 expired payments** were expired in 120 s: each pass stopped on the held row until the statement
  timeout.
- **After:** `FOR UPDATE SKIP LOCKED` leaves a held row for the next pass. The 999 others were expired in **3.5 s**, and the held one
  4.9 s after its holder released it (the next pass).
- One `payment.expired` event per payment; a Payment read's p50 was 2.1 ms (p99 15 ms) during the drain.
- **Why it is safe:** nothing is decided about a row this pass could not lock, and the next pass re-reads it: still due and still open
  means it is expired then. The attempt check and the state guard are unchanged.
- **Proof:** a new E2E test runs 20 iterations of 5 expired payments with one held at a different position each time. It fails with
  the lock-waiting query (the pass does not finish in 3 s).

**Billing dispatcher: the stale-sending relationship.**
- **The problem:**
  - a pass claims up to `BATCH_SIZE` requests and stamps each `sendingSince` at claim time, then sends them one after the other, each
    call bounded by `PAYMENT_TIMEOUT_MS`;
  - the last claim can therefore wait up to BATCH_SIZE × PAYMENT_TIMEOUT_MS before it is sent: 50 × 5 s = 250 s with the defaults,
    against a stale window of 60 s;
  - meanwhile another instance treats those claims as abandoned and sends them too.
- **Reproduced, scaled down 6×:**
  - timeout 1 s, stale 10 s, batch 20, two instances, Payment hung for about 10.5 s after the claim and then healthy;
  - **9 duplicate calls in flight** (two calls for one request within 2 s) and 21 `payment_dispatch_stale_recovery` lines per run
    (3/3 runs identical);
  - still 20 payments: Payment's natural key made the duplicates harmless, but they are wasted calls and misleading logs.
- **Rejected:**
  - a batch small enough to fit (10 × 5 s < 60 s): measured 4× slower to drain 200 requests (44.0 s instead of 11.3 s);
  - tuning the stale window alone.
- **Kept: claim renewal.**
  - While a pass is still sending, it renews the `sendingSince` of the claims it has not sent yet, every quarter of the stale window
    (`renewSending`, one UPDATE). `sendingSince` then means "last sign of life of the instance holding it"; a dead instance stops
    renewing, and its claims go stale exactly as before.
  - The only relationship left is that one send must fit in the stale window with margin. Enforced at startup:
    `BILLING_DISPATCH_STALE_SENDING_MS ≥ 2 × PAYMENT_TIMEOUT_MS`. With renewal every stale / 4, a claim is at most stale / 4 + one send
    old when its send ends.
- **After:** the same scenario gives **0 duplicates in flight**, exactly one call per request after recovery, 20 payments (3/3 runs).
  The 12 remaining `stale_recovery` lines are the legitimate retries of sends that timed out.
- **Proof:** a new E2E test runs two instances with Payment at 300 ms per call, stale 1 s, batch 6, 20 iterations: every request is
  sent exactly once. It fails with renewal disabled (2 calls). Config tests check the startup refusal.

**Dispatcher batch size** (200 requests waiting, interval 2 s; Payment fast, 3 runs, or slowed to 200 ms per call, 1 run):

| Batch | Fast: time to zero | Fast: left at 10 s | Slow: time to zero | Billing read p99 during the drain | Payment calls |
|---|---|---|---|---|---|
| 10 | 44.0 s [43.9–44.1] | 160 | 86.6 s | 19–21 ms | 200 |
| 25 | 19.4 s [19.4–19.6] | 100 | 62.6 s | 18–19 ms | 200 |
| **50** | **11.3 s** [11.1–11.4] | 50 | 54.2 s | 16–22 ms | 200 |

- **Kept 50.** It is the fastest drain, with no cost to HTTP latency; with renewal, the batch no longer interacts with the stale window.
- **Fairness:**
  - order is FIFO by `createdAt`;
  - a new request created 2 s into a 200-request backlog was sent after 11.0 s (before) and 11.2 s (after);
  - it is delayed by the backlog, never starved.

**Stuck-request resend window (O1).**
- After a transient failure (503) a request is resent **59.6 s** after Payment returns. A normal request goes from creation to
  `requested` in 1.8 s (the 2 s poll).
- With renewal, the stale window's only safety bound is ≥ 2 × `PAYMENT_TIMEOUT_MS` (10 s), so it could be lowered safely.
- It now trades recovery delay against retry pressure and log lines during a Payment outage (two lines per stuck request per window,
  15.7).
- **NO CHANGE:** 60 s kept. Lowering it is an SRE choice (recovery time objective), not a safety question any more.

**AttemptResolver amplification** (the Stage 15.4 campaign, unchanged: N resolver instances over 10 unresolved attempts, one pass each):

| Resolvers | Provider calls per attempt, before | After |
|---|---|---|
| 1 | 1 | 1 |
| 2 | 2 | **1** |
| 4 | 4 | **1** |

- **Kept: a lease.** Migration `0008_attempt_resolver_lease.sql` adds `payment_attempt."resolveAfter"`.
  - Before asking the provider, an instance claims the attempt with one conditional UPDATE: still open, and the lease is free or has
    run out. The lease lasts 5 s, the pass interval.
  - No transaction is held across the provider call; the state machine never reads the column.
  - A worker that dies holding a lease blocks nothing: the lease runs out.
- **Proof:**
  - a new E2E test runs four instances concurrently over 20 iterations of 3 open attempts: exactly one call per attempt, none again
    inside the lease, one again after it;
  - it fails without the claim (2 calls);
  - the 15.4 race campaigns pass (below).

**RabbitMQ prefetch** (Billing consumer, pool 10; 300 settled payments waiting in Billing's queue; the consumer's own span, first to last
receipt; 3 clean runs plus 1 run with a SIGKILL mid-drain):

| Prefetch | Events/s | Billing sessions (peak) | Billing read p50 / p99 during the drain | SIGKILL run |
|---|---|---|---|---|
| 1 | not measured with the span metric (whole drain 1.6 s, 3× prefetch 5's by the same measure) | 3–4 | 2.7 / 7.8 ms | 300 paid, one effect each |
| **5** (new) | 525 [490–546] | 6–8 | 4.3 / 10.6 ms | 300 paid, one effect each |
| 10 (old) | 846 [750–866] | **9–10 (the whole pool)** | 7.4 / 13.9 ms | 300 paid, one effect each |
| 20 | 824 [738–909] | 10 | 36.3 / 48.4 ms | 300 paid, one effect each |

- **Changed to 5:** in the kit, `DEFAULT_PREFETCH`, validated 1–100; in Billing, `min(10, max(1, DB_POOL_MAX / 2))`.
- **Why:**
  - each delivery is handled concurrently and holds a database client;
  - with prefetch equal to the pool, a backlog takes every client, so an HTTP request waits for one: up to `DB_CONNECTION_TIMEOUT_MS`,
    then a 500 (the exhaustion case above);
  - 525 events/s per instance is far above Payment's event rate.
- **Trade-off:** 38 % less consumer throughput for a bounded share of the pool, a smaller unacknowledged window and fewer redeliveries
  after a crash.
- **After** (the built default): 572 / 543 / 611 events/s, 6–7 sessions, read p50 3.2–4.2 ms; the SIGKILL run: 300 paid, one effect
  each.

**Outbox relay batch and pass** (kit relay through the real broker, a consumer counting deliveries):

| Measurement | Before | After |
|---|---|---|
| One batch's pass (claim + publish with confirms + stamp): 10 / 50 / 200 rows | 21 / 89 / 303 ms | unchanged |
| Drain rate at the 1 s interval, batch 10 / 50 / 200 | 9.8 / 45.9 / 153.5 events/s | – |
| 5 000-event backlog, time to zero (batch 50) | **111 s** [111.0–111.2] | **16.8 s** [15.3–16.9] |
| Steady 200 events/s for 30 s: backlog when production stops | **4 650** (then 104 s to drain) | **60–160** (drained in < 1 s) |
| 300 Payment events after a 60 s broker outage, time to zero (live services) | 58.5 s | 15.0 s |
| Duplicates / lost | 0 / 0 | 0 / 0 |

- **Batch kept at 50:** batch 200 is faster per poll, but holds its transaction and row locks about 3.4× longer (303 ms).
- **Kept: full batches back to back.** One poll relays batches while they come back full, for at most 1 000 ms (`maxPassMs`), then
  waits the normal interval.
  - Each batch is still its own short transaction, and confirm-then-stamp is unchanged: a row is never stamped without its confirm.
  - The pass stops at the first failure (an outage keeps its one-failure-per-poll pace) and at the first batch that is not full.
  - It stays inside the 5 s shutdown drain budget.
- **Proof:** the kit tests "back to back", "bounded in time" and "failure ends the poll". Reverted, the first fails (50 of 120
  relayed).

**Outbox backoff after an outage** (broker unreachable for 90 s, then back; 3 runs each):

| Backoff ceiling | Drain after the broker returns, 1 event | Drain, 200 events | Failure lines per minute during the outage (1 / 200 events) |
|---|---|---|---|
| 60 s (old) | 33.7 s | 57.6 s | 4.7 / 60 |
| **15 s** (new default) | 0.45 s | 15.2 s | 6 / 60 |
| 5 s | 2.6 s | 5.4 s | 13.3 / 60 |

- **Changed to 15 s** (`DEFAULT_MAX_BACKOFF_MS`). The ceiling is the worst delivery delay after recovery; the outage cost barely moves,
  because a poll stops at its first failure.
- 5 s would add little recovery gain for about 3× the retries of a lone event.
- **Rejected:** "reset every backoff after a successful publish". A poison row (the broker rejecting that one message) would then be
  retried on every other poll.
- **Proof:** a kit test (≤ 15 s after 20 failures). Reverted, it fails (60 s).

**Worker polling, capacity and detection** (defaults, per process):

| Worker | Interval | Queries per minute, idle | Capacity per process (measured or bounded) | Detection latency | Log lines during a failure |
|---|---|---|---|---|---|
| Outbox relay (Billing, Payment) | 1 s | 60 (one claim transaction) | about 300 events/s (5 000 in 16.8 s; was 46/s) | ≤ 1 s | ≤ 60/min (one per poll) |
| Billing dispatcher | 2 s | 30 | about 18 requests/s (Payment fast) | ≤ 2 s | pass: 30/min; per request: 2 per stale window |
| Billing reconciler | 30 s | 2 | 50 per pass (1.7/s), after 300 s stale | 300 s + 30 s | 2/min |
| Billing consumer | push | 0 | about 525 events/s (prefetch 5) | immediate | ≤ 8 per failing event (bounded by its retries) |
| Payment ExpirySweeper | 5 s | 12 (index scan) | 999 in 3.5 s | ≤ 5 s | 12/min |
| Payment AttemptResolver | 5 s | 12 | 100 per pass, provider-bound | ≤ 5 s (+ provider window) | 12/min, plus per attempt |
| Payment WebhookRetrier | 5 s | 24 | 100 per pass | ≤ 10 s (stuck threshold) | 12/min |

- No worker polls faster than it needs to, and none was changed.
- Event-driven wake-ups would be a redesign, not a tuning.
- Every worker drains a backlog faster than the matching creation path can fill it.
- The reconciler is the slowest, deliberately: it is the fallback for lost events.

**Internal HTTP and provider timeouts.**
- **The calls:**
  - Billing → Payment: 5 s, dispatch / cancel / reconcile;
  - Billing, Payment, Organization → Auth: 3 s;
  - readiness checks: 2 s;
  - the provider: per adapter (test provider 200 ms).
- **No call is stacked on another call's full deadline:**
  - a Billing → Payment call does no Auth call on Payment's side (service token);
  - the payer routes that ask Auth are not called by Billing.
- **The caller's budget is shorter than the callee's worst case:** 5 s against Payment's 30 s statement timeout. That is safe because
  every Billing → Payment call is idempotent (natural key, `Idempotency-Key`, read-only reconcile): a Payment commit after Billing gave
  up is found on the next attempt.
- **The provider timeout is a per-adapter capability.** No real adapter exists, so there is nothing to tune on localhost.
  - With several instances, the lease now keeps a slow provider from being asked N times.
  - The resolver's `initiated` grace is timeout + visibility lag.
- **NO CHANGE.**

**RabbitMQ readiness cost.**
- `/ready` opens and closes one AMQP connection: p50 54.8 ms (Billing) and 56.3 ms (Payment), p99 about 70–74 ms, one connection churned
  per probe. `/health` answers in 2.2 ms.
- At a 10 s probe period that is 6 connections per minute per process, which RabbitMQ handles trivially.
- Reusing the bus's own connection (heartbeat-backed) would be cheaper, but it would change what "ready" proves, and it is tied to the
  open SRE decision O2 (15.6).
- **NO CHANGE**, recorded as evidence for O2.
- The 503 seen once after the pressure run did not reproduce: `readinessAfterLoad` had both services ready 0.1 s after 30 s of
  pressure, for 40 s, before and after tuning.

**Auth health-probe throttling (NEEDS SRE / SECURITY DECISION, unchanged).**
- **The setup:** `/auth/health`, `/health` and `/ready` sit behind Auth's global `ThrottlerGuard` (100 per minute per address; 15.7:
  429 on health probes, not logged).
- **The new evidence:** the obvious workaround, raising the limit, costs quadratic CPU per address in the in-memory throttler (above).
- **The options** (not chosen here):
  1. exempt the three health routes (`@SkipThrottle`): they do one `SELECT 1`, like every other service's unthrottled `/ready`;
  2. key the throttle on the forwarded client address (`TRUST_PROXY`) behind a trusted gateway;
  3. a shared throttler storage.
- Security-sensitive routes keep their own database throttle (`auth_throttle`) in every option.

**`billing_transition` duplicate index.**
- **Redundant, per the catalog:**
  - `billing_transition_entity_idx` is a btree on `("entityType", "entityId", revision)`: not partial, same columns, order and
    opclasses as the index behind the constraint `billing_transition_revision_unique`;
  - no foreign key references the table;
  - nothing names the index.
- **Measured at 200 k rows** (median of 3):

| | With the duplicate | Without |
|---|---|---|
| Index bytes (all indexes) | 39.2 MB | 23.9 MB (−39 %) |
| Insert 200 k transitions | 1 512 ms | 1 206 ms (−20 %) |
| BI-19 trigger lookup / entity history | 0.052 / 0.047 ms (non-unique index) | 0.049 / 0.047 ms (unique index), same buffers |

- **Removed:** migration `0014_drop_duplicate_transition_index.sql`.

**Rate-limit storage.**
- `kit_rate_limit` and `auth_throttle` lookups are unique-index upserts: 0.08–0.26 ms at 100 k rows (15.7), flat.
- A purely technical sweep is safe (15.7 matrix): a row whose window ended behaves like an absent one. **Not built:** no volume
  problem, and it would be a new periodic worker.
- The idempotency key TTL (D1, 15.7) is a policy follow-up, not a capacity knob. **Not changed.**

**Before / after, whole system** (same profile, isolated runs):

| Metric | Light before → after | Moderate before → after | Pressure before → after |
|---|---|---|---|
| Throughput (rps) | 2 011 → 2 031 | 2 807 → 2 803 | 2 897 → 2 909 |
| p50 (ms) | 1.37 → 1.38 | 2.95 → 3.14 | 8.70 → 8.42 |
| p95 (ms) | 7.05 → 7.00 | 20.2 → 20.5 | 66.7 → 66.5 |
| p99 (ms) | 8.67 → 8.48 | 30.2 → 29.5 | 139.7 → 133.0 |
| Errors | 0 → 0 | 0 → 0 | 0 → 0 |
| CPU Billing / Payment | 52 / 23 → 52 / 24 % | 78 / 37 → 80 / 37 % | 83 / 39 → 82 / 39 % |
| RSS max Billing / Payment (MB) | 278 / 303 → 273 / 304 | 289 / 329 → 294 / 304 | 302 / 329 → 307 / 304 |
| DB sessions (max) | 16 → 17 | 35 → 35 | 40 → 38 |
| Broker connections / channels / unacked after | 2 / 3 / 0 → 2 / 3 / 0 | | |

- The request path is unchanged, as expected: no retained change touches it.
- The gains are in backlog recovery, multi-instance behaviour and outage recovery (tables above).

**Backlog recovery** (before → after):

| Backlog | At 10 s | At 30 s | At 60 s | Time to zero |
|---|---|---|---|---|
| 1 000 expired payments, one of them locked | 1 000 → **0** (+ the locked one) | 1 000 → – | 1 000 → – | never in 120 s → **3.5 s** (+ 4.9 s after release) |
| 300 Payment events after a 60 s broker outage | 6 → 4 | 1 → 0 | 0 | 58.5 s → **15.0 s** |
| 5 000 events in one relay (kit) | 4 550 → 2 000 | 3 650 → 0 | 2 300 → 0 | 111 s → **16.8 s** |
| 200 payment requests to dispatch | 50 → 50 | 0 | 0 | 11.3 s → 11.2 s (unchanged by design) |

- **HTTP during the drains:**
  - Billing read p99 16–22 ms during a dispatch drain;
  - Payment read p50 2.1 ms / p99 15 ms during the expiry drain;
  - Billing read p50 about 4 ms during a consumer drain at prefetch 5;
  - the workers never starved HTTP.

**Log volume after tuning:** the Stage 15.7 log campaign re-run on the final build (30 s windows, lines per minute):

| Scenario | 15.7 | 15.8 |
|---|---|---|
| Healthy, idle | 0 | 0 |
| Healthy, 20 lifecycles | Billing 78.8 | 79.5 |
| Both databases refused | Billing 267.7, Payment 104.3 | 268, 103.2 |
| RabbitMQ stopped / frozen | Billing 17.3 / 4, Payment 1.9 / 2 | 17.4 / 4, 1.9 / 2 |
| Payment API 503 / refused | Billing 434.8 / 432.4 | 436.2 / 436.9 |
| Payment API hung | Billing 11.8 | 27.8 (*) |
| Consumer retry storm | Billing 643.8 | 647.1 |

- Tuning created no log amplification: the retained changes do not add lines per outage, and the outbox's shorter ceiling costs at most
  6 instead of 4.7 lines per minute for a single waiting event (see the backoff table).
- (*) That scenario's stale window is 5 s, so the new startup rule forced its Payment timeout down to 2.5 s (from 5 s). Each hung call
  now times out twice as fast; the lines per call are unchanged.
- Sensitive-data scan: 1 207 lines, no pattern, no live credential, 0 non-JSON lines.

**Memory and CPU.**
- **RSS:**
  - idle 147–193 MB per service;
  - under load up to 307 (Billing) / 304 (Payment) / 420 (Auth) / 242 (Organization) MB;
  - back to its post-warm-up plateau after load (Billing 310, Payment 304 MB);
  - no run-to-run growth across the 3 × 3 load runs or the backlog drains.
- **CPU:**
  - idle 0.1–3.8 % (Billing's is its 2 s dispatcher plus the 1 s relay);
  - an outage 0.7 % (15.7);
  - load: see the tables above.
- **No busy polling or retry loop was found.** Auth's post-load CPU is the throttler timers (above), a known and bounded effect of the
  raised test limit.

**Configuration bounds and relationships** (all validated at startup):
- **Kept from before:**
  - every interval, timeout, pool and batch has a minimum of at least 1 (or 100 ms / 1 s): zero, negative and huge values are refused;
  - `DB_QUERY_TIMEOUT_MS > DB_STATEMENT_TIMEOUT_MS`;
  - `RABBITMQ_HEARTBEAT_S` 5–60 (never 0).
- **New:**
  - `BILLING_DISPATCH_STALE_SENDING_MS ≥ 2 × PAYMENT_TIMEOUT_MS` (refused otherwise);
  - bus prefetch 1–100 (refused otherwise);
  - Billing's prefetch derived from `DB_POOL_MAX` (never more than half the pool, at most 10).
- **Documented, not enforceable in one process:**
  - Σ pools × processes + reserve ≤ `max_connections` (the budget above);
  - the stop grace (60 s) must exceed the HTTP and worker drains (15.5).
- The test harnesses that set a 3 s or 5 s stale window now set `PAYMENT_TIMEOUT_MS` to half of it.

**Migration safety.**
- `0007_payment_expiry_open_index` is `CREATE INDEX`, in the runner's transaction: it takes a `SHARE` lock on `payment`, so writes wait
  for the build.
  - Measured: the index covers only open rows, and the build reads the whole table (about 30 ms of scan at 500 k rows here). Seconds on
    a large table, no data change.
  - Payment is not in production yet (Auth is the only deployed service).
  - For a large production table, Stage 20 should build it `CONCURRENTLY` outside the runner's transaction.
- `0008_attempt_resolver_lease` is `ADD COLUMN` without a default: a catalog-only change, a brief `ACCESS EXCLUSIVE` lock.
- `0014_drop_duplicate_transition_index` is `DROP INDEX`: a brief `ACCESS EXCLUSIVE` lock on `billing_transition`, no rewrite.
- **Compatibility and rollback:**
  - old code runs on the new schema: it ignores the column and does not use the dropped index;
  - new code needs 0008 (the resolver's claim names the column), so migrate before deploying the new Payment;
  - rollback is the reverse DDL (drop the index or column, recreate the dropped index); none is needed for correctness.

**Correctness revalidation of the affected guarantees** (historical campaigns re-run on the final build): each re-run campaign's own invariants hold, with 0 uncaught errors in every harness.

| Change | Guarantee at risk | Re-run (stage: campaigns) | Result |
|---|---|---|---|
| Relay: full batches, 15 s ceiling | at least once; confirm before stamp; no loss or duplicate effect; bounded outage behaviour | 15.3: brokerDownBeforePublish, outageCycles, confirmTimeout, lostConfirm, connectionCutDuringPublish, crashWindows, multiRelay, outboxBackoff, outboxDurabilityAcrossRestart, appFlow. 15.4: multiRelay, relaysConsumersBrokerInterruption, relayCrashHoldingLocks, outboxRetryRace. 15.5: outboxShutdown | 0 lost, 0 duplicate effects, pending 0 after recovery. Backoff ceiling 14.99 s at attempt 11 (was 60 s), same early schedule. Shutdown with a batch in flight: 20/20 exit in about 1.08 s, published at exit |
| Prefetch 5 | redelivery bounded, one effect, no pool starvation | 15.3: prefetch, consumerFailures, duplicateDelivery. 15.4: billingCompetingConsumers, billingDuplicateDeliveryRace, billingPoolPressure. 15.5: consumerWindows. 15.6: rabbitDown, billingDbDownWhileEventArrives | 5 unacknowledged while a handler is held (was 10), all 25 back in the queue when the consumer dies; one receipt and one effect per event everywhere; 20/20 of every consumer window converged; the broker outage converged in 6.1–7.3 s |
| Sweeper index + SKIP LOCKED | one expiry per payment; no expiry with money in flight; bounded shutdown | 15.4: expirySweeperRaces. 15.5: sweeperShutdown | 3 concurrent sweepers: 200/200 expired once. One row locked: 29/30 expired in about 77 ms passes, 0 sessions waiting on the lock (was: the pass blocked). The boundary race with an attempt start stays consistent (20/20). Shutdown no longer waits for a held row: 13–16 ms (was 1.05 s, or 30 s when the lock was never released); that payment expires once after restart |
| Resolver lease | no duplicate transition or event; recovery after a crash | 15.4: attemptResolverRaces, attemptResolverAmplification, paymentLiveTwoInstances. 15.5: paymentWorkerWindows | every race pair ends with at most one terminal event; amplification 1 / 1 / 1. A resolver SIGKILLed holding a claim: the survivor settles the attempt after **5.16 s [5.03–5.28]** (one lease), 20/20 `succeeded`, one event. The 15.5 campaign now waits for the lease: its first version expected recovery within 0 s |
| Dispatcher renewal + startup relationship | one payment per request; no lost request; bounded shutdown | 15.4: billingMultiInstanceDispatch, billingDispatcherStaleRace, billingDispatcherCrashWindows. 15.5: dispatcherShutdown. 15.6: paymentDownBillingUp, paymentRestartDuringBillingRequest (6 windows, 110 iterations), eventOrdering, repeatedCycles, smoke | one payment per request everywhere, 0 id mismatches, 0 cross-tenant. The 15.4 stale race (3 instances, Payment holding a create 1.5 s / 4.5 s): **1 create per request, at most 1 concurrent, 0 stale recoveries** (15.4: up to 3 creates, 2–3 concurrent, 25–30 stale recoveries) |

- **The stale race needed rescaling.** It was designed for a 3 s stale window with a 5 s timeout and a 4.5 s hold: "a send outliving the
  stale window". The new startup rule refuses that configuration, so it now runs with a 10 s window and a 5 s timeout. Harnesses that used
  a 3 s or 5 s window with the default timeout now set the timeout to half the window.
- **The sweeper's 15.5 shutdown scenario no longer reaches its precondition** (a pass blocked on a lock). The precondition no longer
  exists, which is the improvement.


**Regression and production images.**
- **Full regression, all green:**
  - build;
  - unit: kit 132, Auth 102, Organization 138, Billing 321, Payment 92;
  - kit integration 109;
  - E2E: Auth 311, Organization 232 (on a throwaway PostgreSQL: its guard refuses the Compose cluster), Billing 251, Payment 116;
  - real broker 9; Auth–Organization 4;
  - `check:repo`, `test:repo`.
  - Billing's migrations test now pins 14 service migrations (it pinned 13).
- **All four production images rebuilt and smoked:** uid 1000, `/health` 200 and stable, `/ready` answers.
- **Run as containers:**
  - `dockerStop` and `dockerCrossServiceOutage` (15.5, 15.6): idle stops 0.27–0.39 s, exit 0; broker stopped / database paused
    converge;
  - `dockerStopWithGrace` with a frozen broker: Billing 27.2 s and Payment 28.7 s, natural exit 0 (3/3), under the 60 s grace;
  - the 10 s Docker default still SIGKILLs that case, as in 15.5.
- **No validation tooling in the images.**

**Tuning decision register:**

| Item | Baseline | Candidate(s) | Result | Decision |
|---|---|---|---|---|
| DB pool | 10 | 5, 20 | 5: −16–19 % rps; 20: same rps, p99 ×2, 2× connections | **NO CHANGE**, 10 justified |
| DB pool exhaustion | – | – | bounded 5 s, no leak, recovery | NO CHANGE |
| Rabbit prefetch | 10 | 1, 5, 20 | 10 and 20 take the whole pool (HTTP p50 ×2 to ×9); 5 gives 525 events/s and a bounded share | **CHANGED to 5** (derived: pool / 2) |
| Outbox batch | 50 | 10, 200 | 200 holds locks 3.4× longer | NO CHANGE |
| Outbox pass | 1 batch per poll | full batches back to back ≤ 1 s | backlog 111 s → 16.8 s; steady 4 650 → ≤ 160 | **CHANGED** |
| Outbox backoff ceiling | 60 s | 15 s, 5 s; reset on success | 57.6 s → 15.2 s recovery; outage lines unchanged; reset rejected (poison row) | **CHANGED to 15 s** |
| Dispatcher batch | 50 | 10, 25 | 50 fastest (11.3 s vs 44.0 s), no HTTP cost | NO CHANGE |
| Dispatcher stale | 60 s, claim-time stamp | renewal; smaller batch; smaller stale | 9 duplicates → 0 with renewal | **CHANGED: renewal + startup relationship**; 60 s kept |
| AttemptResolver | N calls per attempt for N instances | lease | 1 / 2 / 4 → 1 / 1 / 1 | **CHANGED: lease** |
| ExpirySweeper query | seq scan (15 ms at 100 k) | partial index | 0.036 ms, 32 KB, no insert cost | **CHANGED: index** |
| ExpirySweeper HOL | blocks on a held row | SKIP LOCKED | 0 in 120 s → 999 in 3.5 s | **CHANGED** |
| Provider timeout | per adapter | – | no real adapter | NO CHANGE |
| Internal timeouts | 5 s / 3 s | – | no stacking; idempotent retries | NO CHANGE |
| Worker intervals | 1 / 2 / 5 / 30 s | – | capacity above creation rates | NO CHANGE |
| Rabbit readiness | connect per probe (55 ms) | reuse the bus connection | changes what "ready" proves (O2) | NO CHANGE (SRE) |
| Auth probe throttling | 429 on probes | exempt / trusted proxy | raising the limit is quadratic CPU | NO CHANGE (SRE / security) |
| `billing_transition` index | duplicate | drop | −39 % index bytes, −20 % insert time, same plans | **CHANGED: dropped** |
| Rate-limit storage | no cleanup | technical sweep | flat lookups at 100 k | NO CHANGE (documented) |
| Idempotency TTL | stored, never read | – | policy (D1) | NO CHANGE |

**Handoff to 15.9** (re-run for closure, no new optimisation work):
- the full regression;
- the canonical matrix (15.2–15.8) on the final build: database outages (15.2), broker and outbox (15.3), workers and races (15.4),
  shutdown / restart including containers (15.5), cross-service (15.6), growth and log volume (15.7), and this stage's
  `capacity-campaigns.mjs` (baseline profile, backlog recovery, dispatcher stale, prefetch, multi-instance);
- production-image smoke;
- the consolidation of every open decision (section 16);
- Phase C closure.

### 13.9 Final validation and Phase C closure (15.9)

**Question.** Does the final integrated Core (`main` at `aab849f`, after every Stage 13–15.8 change) keep its guarantees strongly enough to
close Phase C and serve as the foundation for Stage 16?

**Method.**
- **No tuning, no features.** Nothing was optimised or added.
- **Configuration:** every campaign ran on the merged build with the Stage 15.8 defaults.
- **Canonical subset:** each stage's campaigns that prove a final guarantee. Exploratory and diagnostic campaigns were not repeated.
- **Streams:** five parallel streams, each on its own throwaway PostgreSQL / RabbitMQ containers. The 15.8 load profile ran alone
  afterwards.
- **Containers:** they ran the production images built from `aab849f`. Those images are byte-identical to the 15.8 build (same image
  ids), tagged as the Docker campaigns expect.

**Final invariant register** (evidence from this run unless stated):

| # | Invariant | Evidence | Result |
|---|---|---|---|
| I1 | Authentication answers only "who are you"; no commercial dependency | no HTTP client and no Billing / Payment / entitlement reference in Auth's code; `requiresSubscription` is stored and returned by onboarding and never read for a decision (ADR-0044); Auth E2E (final regression) | PASS |
| I2 | Security state (active / blocked identity, suspension, session ceiling) is separate from commercial state | Auth E2E (blocking, recovery, session ceiling, reuse detection); the Billing entitlement route refuses even a valid active user bearer (entitlement E2E) | PASS |
| I3 | Authorization is not an entitlement check | role / capability guards (Auth grants, Organization `SERVICE_POLICY`, Billing / Payment service tokens) read no subscription state; `serviceAuth` campaign | PASS |
| I4 | Billing owns commercial state; entitlement derives from the Subscription, never directly from a settlement | `deriveEntitlement` reads Subscription timestamps only; the Payment→Subscription integration suite (cases 1–15) applies settlements through Billing's receipt; `entitlementKind` is a compatibility field only (ADR-0045: no branch on it anywhere) | PASS |
| I5 | Tenant isolation | `tenantIsolation`, `billingCompetingConsumers` (0 cross-tenant rows), entitlement / subscription tenant E2E cases, account checks in every live campaign (`crossTenant` 0) | PASS |
| I6 | Idempotency: no duplicate protected effect on retry or replay | `paymentIdempotencyRaces`, `billingDuplicateDeliveryRace`, `duplicateDelivery`, `eventOrdering`, the Payment natural key in every dispatcher campaign, `dlqLifecycle` | PASS |
| I7 | Durable async work survives broker, service, database, consumer and worker failure | `brokerDownBeforePublish`, `outageCycles`, `crashWindows`, `consumerWindows`, `backlogRestart`, `rabbitDown`, `billingDbDownWhileEventArrives`, `dbAndRabbitDown` | PASS |
| I8 | Outbox: business transaction → row → publish → confirm → stamp | `confirmTimeout`, `lostConfirm`, `connectionCutDuringPublish`, `outboxDurabilityAcrossRestart`, `outboxShutdown`, relay kit tests (a row is never stamped without its confirm) | PASS |
| I9 | A redelivered event has one effect | `duplicateDelivery`, `billingDuplicateDeliveryRace`, receipt-per-event checks everywhere, `dlqLifecycle` replay → `ignored` | PASS |
| I10 | A silent or unavailable database bounds every wait; timed-out clients are destroyed | 15.2 canonical DB campaigns; startup refuses `DB_QUERY_TIMEOUT_MS ≤ DB_STATEMENT_TIMEOUT_MS` | PASS |
| I11 | A connection with an ambiguous transaction is never reused | `midQueryDisconnect`, `serverFrozen`, `idleTransaction`, `connectionAccounting` (0 idle in transaction afterwards) | PASS |
| I12 | Several instances never multiply protected work | `multiRelay`, `attemptResolverAmplification` (1 call per attempt for 1 / 2 / 4 instances), `expirySweeperRaces`, `billingMultiInstanceDispatch`, `billingDispatcherStaleRace`, `webhookRetrierRaces`, `billingCompetingConsumers`, `paymentLiveTwoInstances` | PASS |
| I13 | Shutdown: `/ready` false at once, new work refused, workers drained, resources closed, natural exit | `httpInFlight`, `keepAlive`, `consumerWindows`, `outboxShutdown`, `dispatcherShutdown`, `sweeperShutdown`, `frozenPostgres`, `frozenRabbit`, and the production-container campaigns (Node = PID 1, 60 s grace) | PASS |
| I14 | Recovery with no manual repair | `recoveryOrders`, `serviceAndDependencyDown`, `multiServiceRestart`, `startupOrder`, `repeatedCycles`, `restartCycles`, `backlogRestart`, DB `runtimeOutage` | PASS |
| I15 | Commercial lifecycle V1 (pending / active / grace / expired; UTC half-open periods; early renewal from max(now, end); late renewal from the settlement instant; cancel-at-period-end keeps access; termination may shorten it) | Billing E2E: subscriptions 1–16, hardening A–K, Payment→Subscription 1–15, entitlement 1–10 | PASS |
| I16 | Payment is settlement authority only | Payment's code has no subscription or entitlement concept; it emits `payment.*` facts, Billing decides (receipts, conflict on mismatch) | PASS |
| I17 | No false success | cancel contract (`cancellationContract`, `paymentDownBillingUp`: `503 payment_unavailable`, never 200 unconfirmed); dispatcher `transient` keeps `sending`; readiness truthful | PASS |
| I18 | Bounded resources | the resource snapshots of every campaign (sessions, idle in transaction, broker connections / channels / consumers, RSS); log volume per outage bounded (`logVolume`); retry budgets and backoff ceilings | PASS |

**Canonical validation matrix** (the reusable certification suite; re-run on this build):

| Campaign(s) | Stage | Invariants | Result on the final build |
|---|---|---|---|
| `control`, `poolSaturation`, `connectionAccounting` | 15.2 | I10, I18 | pool waits bounded; sessions = pool total (4 × 10 = 40 at the burst), back to the idle baseline; 0 idle in transaction — PASS |
| `statementTimeout`, `idleTransaction`, `midQueryDisconnect` | 15.2 | I10, I11 | statement cancelled at its bound, 0 partial commits; a lost connection mid-query / mid-transaction: 20 + 20 runs, 0 partial rows, the pool usable, no crash — PASS |
| `connectionStall`, `serverFrozen` (database container paused) | 15.2 | I10 | new connection fails at 5.0 s (`db_connect_timeout`); an established query ends at 35.0 s (`db_query_timeout`); `/ready` 503 within one probe (2.0 s), `/health` 200; ready 56 ms after the database returns — PASS |
| `runtimeOutage`, `authOutage`, `relayConnectionHold` | 15.2 | I10, I14, I18 | 5 outage cycles each for Billing and Auth: no crash, recovery without restart, 0 credential lines in logs — PASS |
| `frozenShutdown` | 15.2 | I13 | SIGTERM with the database frozen: exit 33.4 s, within the 60 s grace — PASS |
| `brokerDownBeforePublish`, `outageCycles`, `brokerRestartPersistence` | 15.3 | I7, I8 | 0 lost, 0 duplicate effects; backlog converges after every cycle — PASS |
| `confirmTimeout`, `lostConfirm`, `connectionCutDuringPublish`, `brokerFreeze`, `outboxDurabilityAcrossRestart` | 15.3 | I8, I10 | a publish fails at the confirm bound (5.0 s) and the row stays pending; never stamped without a confirm; 0 lost / 0 duplicate — PASS |
| `consumerFailures`, `duplicateDelivery`, `crashWindows`, `prefetch` | 15.3 | I7, I9 | transient → retried then applied once; poison / permanent → DLQ (the only 2 "not applied", by design); consumer killed in each window 20×: redelivered, one effect; 5 unacknowledged at most (prefetch 5) — PASS |
| `multiRelay`, `outboxBackoff`, `appFlow` | 15.3 | I8, I12 | several relays: 0 duplicate / lost; backoff ceiling 15 s; the live flow's accounting exact — PASS |
| `multiRelay`, `relayCrashHoldingLocks`, `outboxRetryRace` | 15.4 | I8, I12 | 0 duplicate / lost; a crashed relay's rows reclaimed; no double publish of a held row — PASS |
| `attemptResolverRaces`, `attemptResolverAmplification`, `paymentLiveTwoInstances` | 15.4 | I6, I12 | every race pair: at most one success event, never two terminal events; provider calls per attempt 1 / 1 / 1 for 1 / 2 / 4 resolvers — PASS |
| `webhookRetrierRaces`, `expirySweeperRaces`, `paymentIdempotencyRaces` | 15.4 | I6, I12 | one reprocess of a row at a time; 3 sweepers: 200/200 expired once; one row locked: 29/30 expired, 0 sessions waiting; 0 expirations with an open attempt; one row and one result per idempotency key (20 iterations) — PASS |
| `billingMultiInstanceDispatch`, `billingDispatcherStaleRace`, `billingDispatcherCrashWindows` | 15.4 | I6, I12 | at most 1 concurrent create per request; stale race: 1 create per request, 0 stale recoveries; crash windows C / D: every request requested with one matching payment — PASS |
| `billingCompetingConsumers`, `billingDuplicateDeliveryRace`, `billingDualPathSettlement`, `billingSameOrganizationSubscription`, `billingRestartUnderCompetition` | 15.4 | I5, I6, I9 | 0 cross-tenant rows, 0 deadlocks, one receipt per event, dual path (event + reconciler) applied once — PASS |
| `idleBaseline`, `httpInFlight`, `keepAlive` | 15.5 | I13, I17 | readiness drops at once, in-flight request completes, new requests refused, keep-alive clients cannot extend the drain — PASS |
| `consumerWindows`, `outboxShutdown`, `dispatcherShutdown`, `sweeperShutdown`, `paymentWorkerWindows` | 15.5 | I7, I13, I14 | every window 20×: exited, 0 partial states, 0 idle in transaction after death, converged; a SIGKILLed resolver's attempt settled by the survivor after 5.14 s [5.05–5.23] (one lease), one event — PASS |
| `frozenPostgres`, `frozenRabbit`, `restartCycles`, `backlogRestart`, `cancellationContract` | 15.5 | I7, I13, I14, I17 | 0 not exited; 20 graceful / forced cycles under traffic: one payment per request, 0 idle in transaction at the end; backlog restart settled; cancel answers success only when confirmed — PASS |
| `dockerStopWithGrace`, `dockerFrozenBrokerFinal`, `dockerConsumerInFlightFrozen`, `dockerBrokerVanishes`, `dockerCrossServiceOutage` (production images, Node = PID 1, 60 s grace) | 15.5 | I13 | every stop exit 0, no SIGKILL: idle 0.29–0.32 s; frozen broker 27.1–28.7 s; consumer in flight with the broker frozen 39.8 s (the worst case); broker vanishes 2.7 s; cross-service outage converged — PASS |
| `smoke`, `paymentDownBillingUp`, `billingDownPaymentUp`, `paymentRestartDuringBillingRequest`, `billingRestartDuringPaymentEvent` | 15.6 | I7, I14, I17 | one payment, one applied receipt, one terminal event per request; 0 id mismatches — PASS |
| `rabbitDown`, `perServiceDbDown`, `billingDbDownWhileEventArrives`, `dbAndRabbitDown`, `serviceAndDependencyDown` | 15.6 | I7, I14 | converged in every order; 0 cross-tenant; one idle-in-transaction sample right after convergence re-examined: 0 in 213 samples over the next 15 s (3 re-runs) — a transaction caught between statements — PASS |
| `multiServiceRestart`, `recoveryOrders`, `eventOrdering`, `repeatedCycles`, `startupOrder`, `readinessMatrix` | 15.6 | I7, I9, I14 | every recovery order converges with no manual repair; out-of-order / replayed events one effect — PASS |
| `serviceAuth` | 15.6 | I3, I5 | missing / invalid / malformed / user-shaped / other-service tokens: 401 on every protected route, 0 protected writes; Auth unavailable → payer routes 503, service routes work; 0 token leaks in logs — PASS |
| `tenantIsolation` | 15.6 | I5 | two organizations: 0 organization mismatches, 0 receipts pointing elsewhere, 0 cross-tenant — PASS |
| `growth` (to 100 k lifecycles) | 15.7 | I18 | request-path and claim queries ≤ 0.11 ms (index scans), ExpirySweeper 0.03 ms; services ready at size in 1.4 s; a new lifecycle completes — PASS |
| `dlqLifecycle` | 15.7 | I6, I9 | 3/3: DLQ 1 → replay `consumed` → receipt `ignored` → DLQ 0, one applied effect, a second replay `not_found` — PASS |
| `logVolume`, `edgeProbes`, sensitive scan | 15.7 | I18 | per-outage lines bounded and equal to 15.8; recovery lines present; 1 213 lines scanned, no secret; Auth health probes still 429 at 6/s (documented, open) — PASS |
| `poolExhaustion` | 15.8 | I10, I18 | every pool client blocked 15 s, 100 reads: 90 answer 500 at 5.01–5.12 s (`DB_CONNECTION_TIMEOUT_MS`), 10 finish at release; 0 idle in transaction; next read 200 — PASS |
| `dispatcherStale` (2 Billing instances, batch 20 × 1 s vs a 10 s window, Payment hung then back) | 15.8 | I6, I12 | 3/3 runs: 0 duplicate calls in flight, one call per request after recovery, 20 payments — PASS |
| `backlogRecovery` | 15.8 | I12, I14 | 1 000 expired payments with one held: 999 expired in 3.5 s, the held one 4.8 s after release, 1 000 distinct `payment.expired` events; 300 outbox events after a 60 s broker outage: zero in 13.6 s, one applied receipt each; a new request behind a 200-request backlog sent after 11.5 s (FIFO, no starvation) — PASS |
| `prefetch` (the built default) | 15.8 | I9, I18 | 581–594 events/s, 6–7 Billing sessions (of 10), Billing read p50 3.9–4.2 ms during the drain; SIGKILL mid-drain: 300 paid, one effect each — PASS |
| `multiInstance` (1 / 2 / 4 Billing) | 15.8 | I12, I18 | 2 138 / 2 623 / 2 759 rps, 0 errors; sessions exactly 10 / 20 / 40 (= n × pool, ≤ 100) — PASS |
| `readinessCost`, `baselineLoad` | 15.8 | I18 | see the load smoke below — PASS |

**Service-specific certifications.**
- **Database (15.2):**
  - refused, stalled and frozen databases, statement and idle-in-transaction timeouts, a mid-query disconnect, pool saturation and
    exhaustion, and a frozen-database shutdown are all bounded;
  - a timed-out client is destroyed, never reused;
  - recovery needs no restart;
  - startup still refuses `DB_QUERY_TIMEOUT_MS ≤ DB_STATEMENT_TIMEOUT_MS` (kit config tests).
- **RabbitMQ (15.3):**
  - stopped, frozen, severed and restarted brokers, lost confirms and cut connections: no lost durable work, no duplicate effect;
  - the consumer comes back by itself;
  - `RABBITMQ_HEARTBEAT_S` 0 is still refused: the bounds are 5–60 (config tests);
  - containers exit naturally with the broker frozen (27–29 s) or gone (2.7 s).
- **Outbox (15.3 / 15.8):**
  - a row is stamped only after its confirm, and a restart mid-publish republishes it (at least once, absorbed downstream);
  - a large backlog converges, with full batches back to back;
  - the backoff ceiling is 15 s;
  - HTTP stays responsive during the drains.
- **Billing dispatcher:**
  - claim renewal holds with 2 instances, large batches and a slow or hung Payment: 0 in-flight duplicates, 1 create per request in the
    15.4 stale race;
  - startup enforces `BILLING_DISPATCH_STALE_SENDING_MS ≥ 2 × PAYMENT_TIMEOUT_MS` (Billing config tests).
- **AttemptResolver:**
  - 1 provider call per open attempt with 1, 2 and 4 resolvers;
  - a SIGKILLed lease holder's attempt is settled by the survivor after one lease: 5.14 s [5.05–5.23], 20/20, one event, no manual
    step.
- **ExpirySweeper:**
  - index scan at 100 k payments: 0.03 ms;
  - with one expired payment held and 999 others: the 999 expire in 3.5 s; the held one stays `created` while held and expires once
    after release;
  - 3 concurrent sweepers: 200/200 expired once;
  - no expiry while an attempt is open (20/20 boundary races).
- **Worker concurrency:**
  - relays, dispatcher, resolver, sweeper, webhook retrier and competing consumers, at 2–4 instances: no duplicate effect, no
    amplification, no stranded work, 0 deadlocks;
  - FIFO fairness;
  - recovery after an instance's death: SIGKILL windows in 15.4 / 15.5.
- **Service authentication and tenant isolation:** see the matrix (`serviceAuth`, `tenantIsolation`). Plus the Billing entitlement and
  subscription E2E tenant cases and `billingCompetingConsumers` (0 cross-tenant rows).
- **Commercial lifecycle and effective access** (Billing E2E, run in the final regression):
  - entitlement cases 1–10: none / pending / active / exact end (exclusive) / grace / elapsed grace / termination /
    cancel-at-period-end / status independence;
  - `GET /billing/organizations/{id}/entitlement`: service token only (a valid active user bearer is refused), organization-scoped,
    answers exactly `{valid, expiresAt}`, read-only;
  - subscriptions 1–16: first activation, early / exact-boundary / late / grace renewal anchors, cancellation and reversal, termination,
    concurrency;
  - hardening A–K (races, cross-tenant);
  - Payment → Subscription 1–15: initial activation from a settlement, renewal, duplicate / concurrent delivery, mismatches → no effect,
    failure events never activate, atomicity, the reconciliation path converging on the same anchor;
  - Payment grants nothing: it emits `payment.*` facts, and only Billing's receipt path changes commercial state.

**Migration chain.**
- Clean chain on an empty database for each service:
  - Auth 9 files, Organization 5, Billing 14, Payment 8, plus the kit's 3 where used;
  - no duplicate number, no gap, applied in order;
  - the final objects are present: `payment_expiry_open_idx`, `payment_attempt."resolveAfter"`, and `billing_transition` with only its
    primary key and unique index.
- Upgrade from the pre-15.8 schema (the migration folders at `c2a5108`):
  - `main` applies exactly Billing `0014_drop_duplicate_transition_index` and Payment `0007_payment_expiry_open_index` and
    `0008_attempt_resolver_lease`;
  - the older files' checksums still match;
  - a rerun applies nothing.
  - Organization has no change.
- Billing's and Payment's migration E2E suites pin the exact files.

**Migration deployment risks (Stage 20).**
- Payment `0007` builds its index inside the runner's transaction (a `SHARE` lock: writes to `payment` wait while it builds). On a large
  production table, build it `CONCURRENTLY` outside the runner, or use an equivalent safe strategy.
- Payment `0008` must be applied before the Payment version whose resolver writes `resolveAfter`. Older code runs fine on the new
  schema.
- Billing `0014` is a brief `DROP INDEX` lock.

**Production images.**
- The four images were rebuilt from `aab849f`.
- Each one:
  - runs as uid 1000 on Node 22.23;
  - is `docker-entrypoint.sh` → `node dist/main.js`, and Node is PID 1 (checked in a running container);
  - answers `/health` 200 (stable) and `/ready` truthfully (503 without dependencies).
- Their content: `apps`, `libs`, the production `node_modules` and package manifests only. No validation script, harness, spec, vitest,
  typescript or supertest is present; the only matches are third-party packages' own internal files.

**Final load smoke** (the 15.8 profile, 3 × 60 s per level after a 10 s warm-up; the same build as the 15.8 final):

| Level | 15.8 final | 15.9 | Errors | CPU Billing / Payment | RSS max (MB) Billing / Payment / Auth / Organization | DB sessions |
|---|---|---|---|---|---|---|
| light | 2 031 rps, p50 1.38, p95 7.0, p99 8.5 ms | 1 879 [1 580–2 094] rps, p50 1.44, p95 7.4, p99 10.0 ms | 0 | 55 / 24 % | 272 / 304 / 363 / 253 | 17 |
| moderate | 2 803 rps, p99 29.5 ms | 2 861 [2 742–3 128] rps, p50 3.09, p95 19.7, p99 29.8 ms | 0 | 81 / 38 % | 292 / 255 / 404 / 189 | 34 |
| pressure | 2 909 rps, p99 133 ms | 2 810 [2 788–2 819] rps, p50 8.94, p95 71.4, p99 139.9 ms | 0 | 82 / 38 % | 304 / 255 / 415 / 240 | 39 |

- **No meaningful regression.** The code is byte-identical to the 15.8 final build. The light-level spread (1 580–2 094 rps) is machine
  variance: desktop applications used about 40 % of a core during this run.
- **After the load:** broker connections 2 / channels 3 / unacknowledged 0; 0 idle in transaction; Billing and Payment ready.
- **`/ready`:** 54–56 ms (one AMQP connection per probe), against 1.6–2.5 ms for `/health`, as in 15.8.
- **Harness observation:** one repeat of the light level failed while seeding (the invoice create answered 404, before any measurement).
  - It did not reproduce: 600 product → price → invoice → issue sequences across 4 fresh stacks gave 0 failures, and the next run
    passed.
  - The likely cause is the harness itself: `freePort()` releases a port that a proxy bound to port 0 may receive before the service
    listens. Not proven.
  - OBSERVATION (test harness), not a Core defect.

**Connection budget.**
- Σ (`DB_POOL_MAX` × processes) + one migration runner per service being deployed + operator / CLI sessions + 3 reserved ≤
  `max_connections` (100 by default).
- With the defaults (pool 10, 4 services), one process per service = 40 + reserve; two = 80 + reserve.
- No replica count is fixed until Stage 20.
- Observed: under load every process reaches exactly its pool (1 / 2 / 4 Billing instances = 10 / 20 / 40 sessions; four services = 40 at the burst in `connectionAccounting`), never more; idle 1–2 per process. Both PostgreSQL clusters here: `max_connections` 100, 3 reserved.

**Logging and sensitive data.** - The 15.7 log campaign on this build gives the same lines per minute as 15.8 in every scenario (healthy 0 per probe; both databases
  refused 269 / 105; broker stopped 17 / 2; Payment 503 or refused 438; consumer retry storm 647, bounded by the retry budget).
- Every fault and every recovery has a named line; per-item lines carry `correlationId`.
- **Sensitive-data scan:**
  - 1 213 lines from the growth / log campaigns: no bearer token, password, secret, authorization header, URL credential, cookie or
    live service credential;
  - 0 non-JSON lines;
  - `serviceAuth`: 0 token leaks in the logs of all services;
  - the database outage cycles: 0 credential lines;
  - raw webhook bodies are never logged (15.7 review).

**Resource stability.** - Every campaign snapshots its resources after recovery: database sessions (back to the idle baseline, 1–2 per process), 0 idle in
  transaction, broker connections / channels (2 / 3), 1 consumer per consumer instance, outboxes drained, no process left.
- A handful of samples taken mid-traffic show 1–3 sessions idle in a transaction, the same pattern as every earlier run:
  - `restartCycles` cycles, 0 at the end;
  - one `dbAndRabbitDown` sample, re-examined: 0 in 213 samples over 15 s.
  These are live transactions between statements, never a leak.
- RSS: idle 148–188 MB, under load up to 304 (Billing) / 255 (Payment) / 415 (Auth) / 253 (Organization) MB, with no run-to-run growth.
- CPU at idle 0.1–2.6 %.

**DLQ and reconciliation (operational decision, recorded).**
- A message dead-lettered during a long Billing database outage stays in `billing.payment-events.dead` after the reconciler has
  settled the request from Payment.
- The runbook is: `nawara-dlq list` → confirm the request's state → `nawara-dlq replay`. The replay is acknowledged as
  `ignored / already_applied`, with one more receipt and no second effect.
- **No automatic or unseen purge:** a purged message could be one whose effect was never reconciled.
- This run (`dlqLifecycle`, 3/3): DLQ 1 → replay `consumed` → DLQ 0; receipts `applied` + `ignored`, 1 applied effect; a second replay `not_found`.

**Documentation consolidation.**
- `production-readiness.md`:
  - the Stage 15.4 multi-instance paragraph and the 15.7 growth note, which described behaviour since fixed, are marked superseded by
    15.8 and now state the current behaviour;
  - the runtime-limits table gains the 15.8 knobs (stale relationship, prefetch, relay pass / backoff, resolver lease);
  - a Phase C closure section is added.
- `core-validation.md`: section 17 is the consolidated, current register of open decisions and deferred items; section 16 stays as
  the historical Stage 15 log.
- The SDDs and READMEs were updated with each stage (the last in 15.8) and describe the implementation as merged.

**ADR consistency.**
- ADR-0044 (one organization-scoped Subscription; Billing is the commercial authority; Payment is settlement-only; `requiresSubscription`
  is a non-authoritative hint) matches the code.
- ADR-0045 (`entitlementKind`: validated on product create, part of the product's replay identity, copied into invoice lines and the
  `invoice.created` payload, never read for a decision) matches the code.
- ADR-0028's open question 4 (should `requiresSubscription` come from Payment) is answered by ADR-0044.
- ADRs 0035, 0038, 0044 and 0045 are still marked *Proposed* although 0044 and 0045 record decisions already implemented and merged.
  Accepting them is the project owner's decision (register below). No contradiction between an ADR and the implementation was found.

**Commercial V2 boundary.**
- None of these concepts exists in Core: organization seats, user entitlement, payer ≠ beneficiary, sponsorship, prepaid grants,
  commercial redemption, capability grants, transfers / revocations, quantity pricing changes, or a V2 lifecycle.
- A code and migration scan finds only Auth's join-code and operator-code "redeem" (security flows).

**Phase D readiness (Stage 16, Notification).** The foundation Stage 16 needs exists and is certified:
- the service-kit (configuration, logging, request / correlation ids, errors, health / readiness, service tokens, database with bounded
  timeouts and migrations, outbox / inbox, RabbitMQ bus with confirms, retries, DLQ and tools, `PollLoop` workers with bounded drains,
  HTTP drain);
- service authentication; tenant context (organization scope from Auth / Organization);
- the idempotency patterns (natural key, `Idempotency-Key`, receipts / inbox);
- shutdown / restart; the production image pattern (non-root, Node PID 1, 60 s grace);
- the validation suite below.

No mandatory blocker. The open items are policy or Stage 20 decisions that do not block building a service.

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

*Historical Stage 15 log. The current, consolidated register at the close of Phase C is section 17.*

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
| 15.6 O2: should Billing / Payment `/ready` include RabbitMQ (today: 503 during a broker outage although their HTTP still works)? 15.8 evidence: the check opens one AMQP connection per probe (p50 55 ms, vs 2 ms for `/health`) | before production routing on `/ready` | SRE |
| 15.6 O1: resend delay after a transient Payment failure (60 s stale window). 15.8: kept; with claim renewal its only safety bound is ≥ 2 × `PAYMENT_TIMEOUT_MS` (10 s), so lowering it is now a recovery-time vs retry-pressure choice | before production alerting | SRE |
| Start-before-stop / rolling deploy for Auth (every deploy is an outage today) | Stage 20 | SRE |
| SDD endpoint 15: success is `200` in code and tests but `202` in the SDD, and the marker is stamped even when Payment refuses (SDD: "nothing changed") | Billing doc review | engineering |
| ~~Acceptable AttemptResolver provider-call amplification~~ **resolved** (section 13.8): a 5 s lease makes it one provider call per attempt per lease whatever the number of instances | – | – |
| ~~ExpirySweeper head-of-line blocking and dispatcher per-batch stale reclaim~~ **resolved** (section 13.8): SKIP LOCKED; claim renewal with `BILLING_DISPATCH_STALE_SENDING_MS ≥ 2 × PAYMENT_TIMEOUT_MS` enforced at startup | – | – |
| Acceptable log volume during outages (15.7 measured: 0 lines/min idle; per-pass lines 12–60/min per worker at default intervals; per-item retry lines grow with the backlog) | before production alerting | SRE |
| Retention periods (F12): published outbox horizon (and the inbox's, once a consumer uses it); webhook rows and raw bodies (O-17); audit trails; refresh tokens; Organization idempotency keys (no expiry column). Matrix in section 13.7 | before production data accumulates | product / legal / security / SRE |
| 15.7 D1: honour Payment's documented key expiry (`expiresAt` is never read; an old key replays forever) by a cleanup or an expiry check | before the first cleanup | engineering |
| 15.7: Auth health endpoints share the global throttle (429 on probes, not logged) — exempt probes or key on the forwarded address. 15.8: raising `BASELINE_RATE_LIMIT_PER_MINUTE` is not a fix (the in-memory throttler's cost is quadratic in requests per address) | before production routing behind a gateway | SRE / security |
| 15.7 O3: log `describeFailure` facts in the kit exception filter; separately, whether database-unavailable should map to 503 (API contract, all services) | engineering (a); API decision (b) | engineering / API |
| Traffic assumptions for capacity targets (15.8 measured only relative behaviour on one laptop; replicas per service are not established) | before capacity planning | product |
| 15.8: build `payment_expiry_open_idx` (Payment 0007) `CONCURRENTLY` outside the migration transaction when `payment` is large in production | Stage 20 | engineering / SRE |
| 15.8: connection budget per deployment (Σ pools × processes + migrations + operators + 3 ≤ `max_connections`; with defaults ≤ 2 processes per service on a default PostgreSQL) | Stage 20 | SRE |

## 17. Phase C closure: consolidated registers (Stage 15.9)

This section is the **current** register at the close of Phase C.
- Section 16 stays as the historical Stage 15 log: its struck-through rows are resolved.
- Every open row here has an owner, a target and the risk of ignoring it.
- None is a correctness defect of the current implementation: the current behaviour is safe and documented in each case.

### 17.1 Retention register (from 15.7; no duration invented)

| Data | Status | Safe-deletion condition (when a duration exists) | Owner |
|---|---|---|---|
| Published outbox rows | TECHNICALLY SAFE BUT POLICY OPEN | `publishedAt` set and older than the replay / forensics horizon (the relay reads unpublished rows only) | SRE |
| Unpublished outbox rows | DECIDED: never deleted | – | – |
| Kit `inbox` | DECIDED: not used by any consumer today; a horizon is needed only when one adopts it | after the broker can no longer redeliver that id | SRE |
| `payment_event_receipt`, `billing_transition` (commercial evidence) | LEGAL DECISION | a legal retention period, then archival; append-only today | legal |
| Invoices, payment requests, payments, attempts, subscriptions | LEGAL DECISION (B-032, O-17) | never by a technical job | legal / product |
| Payment `idempotency_key` | TECHNICALLY SAFE BUT POLICY OPEN (D1) | `expiresAt < now()` (24 h configured). Today `expiresAt` is written, never read: an old key replays (stricter than the SDD, safe) | engineering |
| Organization `idempotency_key` | PRODUCT DECISION | no expiry column and no retry horizon yet | product / API |
| `kit_rate_limit`, `auth_throttle` | TECHNICALLY SAFE BUT POLICY OPEN | window older than the bucket's longest window (such a row behaves like an absent one) | engineering |
| `refresh_token` | SECURITY DECISION | the family is dead: rotated tokens are the reuse detector | security |
| `webhook_event` rows and `rawBody` | PRODUCT / SECURITY / LEGAL DECISION (O-17) | terminal state and past the dispute period; `rawBody` is immutable and may carry payer personal data | product / security / legal |
| Auth / Organization audit trails | FUTURE AUDIT (audit-service) + LEGAL | after the audit retention period | security / legal |
| DLQ messages | DECIDED (runbook) | after inspection and replay; never purged unseen | SRE |
| Notification secret ciphertext (Stage 16, ADR-0046; column built in 16.4, sealing 16.5, purge worker 16.7: implemented) | DECIDED (technical) | purged once every delivery is terminal or `expiresAt` has passed | engineering |
| Notification intents, deliveries (`destination`), `data` (Stage 16, ADR-0046; tables built in 16.4) | PRODUCT / LEGAL DECISION | personal data; no duration yet | product / legal |
| Notification delivery attempts (Stage 16, ADR-0046; table built in 16.4) | SRE DECISION | operational evidence | SRE |
| Notification template versions (Stage 16, ADR-0046; built and published in 16.4) | DECIDED: kept | explain past deliveries; immutable | – |
| Code-bearing messages in `notification.events.dead` (Stage 16, ADR-0046; not built yet) | DECIDED (runbook) | an expired replay is recorded `EXPIRED`, never sent; never purged unseen | SRE |

### 17.2 Open decisions and deferred items

> **2026-09-26 (ADR-0051, owner decision D3):** every item this register targeted at "Stage 20" now targets **Stage 21.x Production
> Prerequisite Closure**. Stage 20 is Release Management (release metadata and client compatibility), not deployment engineering.
> Earlier "Stage 20" mentions in the historical sections of this document mean Stage 21.x.

| Item | Class | Why deferred | Owner | Target | Risk if ignored |
|---|---|---|---|---|---|
| F2: required CI checks / branch protection on `main` | SRE DECISION (repository setting) | outside the code | repository admin | before Phase D merges | a change can merge without CI |
| Backup job, off-host copy, restore drill on the real volume, RPO / RTO | STAGE 21.x (a production blocker, not a Phase C one) | needs production infrastructure and a policy | SRE / product | Stage 21.x | data loss without a tested restore |
| F12 retention durations (17.1) | PRODUCT / LEGAL / SECURITY / SRE | no duration is established | the owners in 17.1 | before production data accumulates | unbounded growth (about 30 KB per lifecycle; 32 % is published outbox) |
| O2: should Billing / Payment `/ready` include RabbitMQ? | SRE DECISION | orchestration policy; `/ready` costs one AMQP connection per probe (55 ms) | SRE | Stage 21.x | a broker outage takes both services out of routing although HTTP works |
| Auth health probes share the global throttle (429 on probes, not logged); raising the limit costs quadratic CPU | SRE / SECURITY DECISION | exemption vs forwarded-address key vs shared storage | SRE / security | before routing Auth behind a gateway | healthchecks fail under ordinary traffic from one address |
| O3: a database-unavailable request is an opaque 500; the filter logs a message, not facts | FOLLOW-UP (a: engineering) / API DECISION (b: 503 mapping) | (b) changes the contract of all services | engineering / API | Stage 16 or later | alerting cannot tell a database outage from a bug |
| Log taxonomy gaps (broker readiness `error=Error`, closed pool, idle-in-transaction as `db_connection_lost`) | FOLLOW-UP | observability only | engineering | any later stage | weaker classification in logs |
| D1: honour Payment's documented idempotency expiry | FOLLOW-UP | changes what a client sees on a retry after 24 h | engineering | before the first cleanup job | none today (stricter than documented) |
| Organization idempotency expiry model | PRODUCT DECISION | no retry horizon defined | product / API | before retention work | key table grows without bound |
| O1: 60 s stale-resend window | SRE DECISION | since 15.8 only a recovery-time vs retry-pressure trade-off | SRE | Stage 21.x | up to 60 s before a request is re-sent after a transient Payment failure |
| Acceptable outage log volume and alerting thresholds | SRE DECISION | per-item retry lines grow with the backlog | SRE | Stage 21.x | noisy logs during long outages |
| Payment `0007` index built without `CONCURRENTLY` | STAGE 21.x | release mechanics | engineering / SRE | Stage 21.x | writes to `payment` wait during the build on a large table |
| Migrate before deploying (Payment `0008` before the lease code) | STAGE 21.x | release ordering | SRE | Stage 21.x | the new resolver would fail its claim on an old schema |
| Connection budget per deployment (Σ pools × processes + reserve ≤ `max_connections`) | STAGE 21.x | replicas not established | SRE | Stage 21.x | pool exhaustion at the database |
| Restart policy (Billing exits at startup without RabbitMQ), rolling deploy (Auth stops before start), init process (tini) | STAGE 21.x | deployment design | SRE | Stage 21.x | an outage per deploy; Billing down until restarted |
| O7: Auth deploy writes `PAYMENT_SERVICE_URL`, which Auth never reads | FOLLOW-UP (hygiene; verified still present in `apps/auth-service/deploy/provision-and-deploy.sh`) | harmless | engineering | Stage 21.x | confusion only |
| SDD endpoint 15: cancel answers `200` in code, `202` in the SDD | FOLLOW-UP (documentation) | doc review | engineering | Billing doc review | reader confusion |
| Organization service authority activation (built, not authoritative; gated operation never performed) | PRODUCT DECISION | a deliberate, explicit activation | project owner | before Organization is the source of truth | Auth stays the owner of Company / Platform / Organization |
| ADR-0035, 0038, 0044 and 0045 still *Proposed* though 0044 / 0045 record merged decisions | PRODUCT DECISION (governance) | acceptance is the owner's act | project owner | before Phase D | ambiguity about which decisions are binding |
| F14: Auth events have no transactional outbox (fire-and-forget by design) | OBSERVATION (decided) | Auth publishes nothing that another service must act on | – | – | a lost Auth event (none is relied on) |
| Traffic assumptions and production capacity | PRODUCT DECISION | 15.8 measured relative behaviour on one laptop only | product | before capacity planning | wrong sizing |
| Commercial V2 (seats, user entitlement, payer ≠ beneficiary, sponsorship, prepaid grants, capability grants, transfers) | FUTURE CAPABILITY | out of Core V1 by design | product | after Core V1 | – |

### 17.3 Reusable reliability certification (for every future Core service)

A new service (Notification, File, Audit, Security / Admin) is certified by running, against its own throwaway containers and its
production image, the applicable rows of the canonical matrix (section 13.9) with the same pass criteria:

| Area | Proven with (existing harness to copy or extend) | Pass criterion |
|---|---|---|
| Database failure | `db-campaigns.mjs`: refused, silent / frozen, statement timeout, idle transaction, mid-query disconnect, pool saturation, frozen shutdown | every wait bounded; timed-out clients destroyed; 0 idle in transaction; recovery without restart |
| Broker failure (if it publishes or consumes) | `broker-campaigns.mjs`: broker down / frozen, lost confirm, connection cut, crash windows, outage cycles | no loss, no duplicate effect, bounded teardown |
| Outbox durability | `broker-campaigns.mjs` + kit relay tests | a row is stamped only after its confirm; backlog converges |
| Consumer idempotency | `duplicateDelivery`, `billingDuplicateDeliveryRace` pattern | one effect per event id under redelivery and concurrency |
| Worker concurrency | `worker-campaigns.mjs` race pattern (≥ 20 iterations, 2–4 instances) | no duplicate effect, no amplification, no stranded work |
| Shutdown / restart | `shutdown-campaigns.mjs`: in-flight HTTP, keep-alive, worker windows, frozen dependencies, production container with Node = PID 1 and a 60 s grace | `/ready` 503 at once; natural exit; no SIGKILL; recoverable work |
| Cross-service failure | `cross-service-campaigns.mjs` / `lib/core-stack.mjs` | truthful bounded answers; convergence in any recovery order |
| Service authentication | `serviceAuth` pattern | missing / invalid / malformed / wrong identity → 401 / 403, 0 protected writes |
| Tenant isolation | `tenantIsolation` pattern (≥ 2 organizations) | 0 cross-tenant mutations |
| Growth and logs | `growth-campaigns.mjs` (queries at volume, log volume, sensitive scan) | flat request-path queries; bounded logs; no secret in logs |
| Capacity smoke | `capacity-campaigns.mjs` baseline profile | no unexplained regression; sessions ≤ pool total |
| Resource cleanup | every harness's resource snapshots and teardown | sessions, broker connections / consumers and processes back to steady state |
| Production image | `scripts/smoke-core-image.sh` + an image content check | non-root, Node PID 1, health / ready, no validation tooling |

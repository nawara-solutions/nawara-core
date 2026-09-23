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
| `RABBITMQ_CONFIRM_TIMEOUT_MS` | 5000 | 100–60000 | Billing, Payment | service config | publisher confirm wait | validate 15.3 |
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
PostgreSQL `max_connections` (100 on the local server) with room for migrations and CLIs; `PAYMENT_TIMEOUT_MS` should stay below
`BILLING_DISPATCH_STALE_SENDING_MS` (otherwise a send still in flight is reclaimed as stale).

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
question.

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
| I9 | Every wait on a dependency is bounded by its configured limit (no hang) | Stage 14.4/14.6 limits |
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
| Acceptable recovery time after a dependency outage | 15.2 / 15.3 result classification | SRE / product |
| Acceptable shutdown time and the stop grace to configure | 15.5 | SRE |
| Acceptable AttemptResolver provider-call amplification | 15.4 | product (provider cost / rate limits) |
| Acceptable log volume during outages | 15.7 | SRE |
| Retention periods (F12) | after 15.7 | product / legal |
| Traffic assumptions for capacity targets | 15.8 | product |

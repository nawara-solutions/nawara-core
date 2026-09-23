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
| Acceptable shutdown time and the stop grace to configure | 15.5 | SRE |
| Acceptable AttemptResolver provider-call amplification (15.4 measured: N instances → N calls per unresolved attempt per pass; state safe) | 15.8 | product (provider cost / rate limits) |
| ExpirySweeper head-of-line blocking and dispatcher per-batch stale reclaim (15.4: correct, availability and duplicate-call cost) | 15.8 | engineering |
| Acceptable log volume during outages | 15.7 | SRE |
| Retention periods (F12) | after 15.7 | product / legal |
| Traffic assumptions for capacity targets | 15.8 | product |

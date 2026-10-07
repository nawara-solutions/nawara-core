# Local observability (V2 A12.5, A12.6)

LOCAL development only. Nothing here is production configuration, and it neither performs nor authorizes any production action:
production observability is A12.10, behind its own decision gate (D2). Record:
[core-v2-a12-observability.md](../architecture/core-v2-a12-observability.md) §3D–§3I, §4G–§4P.

## What it is

- **Normal development** uses `docker-compose.yml` alone. Every Core service keeps the kit default `METRICS_ENABLED=false`, so no
  metrics listener exists and nothing is collected.
- **Observability** is opt-in through the overlay `docker-compose.observability.yml`. It sets `METRICS_ENABLED=true`,
  `METRICS_HOST=0.0.0.0` and `METRICS_PORT=9464` on the eight Core services (auth, billing, payment, organization, notification,
  file, audit, release) and starts Prometheus (`prom/prometheus:v3.13.4`, the 3.13 LTS line, pinned by digest).
- Prometheus scrapes `<service>:9464/metrics` over the Compose network, with one job per service, plus the RabbitMQ broker (job
  `rabbitmq`, `rabbitmq:15692/metrics`, A12.5.2) and the PostgreSQL server through `postgres-exporter` (job `postgres`,
  `postgres-exporter:9187/metrics`, A12.5.3), and, since A12.6.3, a narrow allowlist of its own metrics (job `prometheus`,
  `localhost:9090` inside its container): **eleven targets**. Ports 9464, 15692 and 9187 are **never** published to the host. Only the
  application ports (unchanged), RabbitMQ's existing 5672 / 15672, and Prometheus on `127.0.0.1:9090` are reachable from the host.
- **Grafana (A12.6.1)** reads Prometheus and shows the provisioned "Nawara Core" dashboards on `127.0.0.1:3100` (see
  [Grafana](#grafana-a1261)). Since A12.6.3 Prometheus evaluates LOCAL alert rules (see [Alerts](#alerts-a1263)). Alertmanager is
  deferred until a concrete receiver exists. Host and
  container metrics are deferred to A12.10. There is no log collection (decision D7).

## Use

```bash
OBS="-f docker-compose.yml -f docker-compose.observability.yml"
docker compose $OBS --profile db up -d --wait postgres rabbitmq
# migrations, once per empty database: see the header of docker-compose.yml (`npm run migrate` per service, `auth-migrate`)
docker compose $OBS --profile db up -d --wait auth-service billing-service payment-service organization-service \
  notification-service file-service audit-service release-service postgres-exporter prometheus grafana
```

Then open `http://127.0.0.1:9090/targets`: eleven jobs (eight services, `rabbitmq`, `postgres` and `prometheus`), all `UP`. A service started without
the overlay has no metrics listener, and its target is `DOWN`.

The overlay needs `MONITORING_PASSWORD` and `GRAFANA_ADMIN_PASSWORD` in `.env` (see `.env.example`); without them Compose refuses to
start in this mode.

Stop with `docker compose $OBS --profile db down`. Prometheus keeps at most 3 days or 1 GB in the named volume
`nawara_prometheus_data` (disposable: `docker volume rm <project>_nawara_prometheus_data`).

## Grafana (A12.6.1)

- **Open** `http://127.0.0.1:3100` and sign in as `admin` with `GRAFANA_ADMIN_PASSWORD` from your `.env`. The `.env.example` value is a
  non-secret local placeholder. `admin/admin` does not work, there is no anonymous access, and there is no sign-up.
- **Content:** folder **Nawara Core** → **Core · Overview** (`/d/nawara-core-overview`) and, since A12.6.2, **Core · Service**
  (`/d/nawara-core-service`), **Core · Messaging** (`/d/nawara-core-messaging`) and **Core · PostgreSQL** (`/d/nawara-core-postgresql`);
  see [Operational dashboards](#operational-dashboards-a1262). One datasource: **Prometheus** (`nawara-prometheus`). Grafana reads
  nothing else: no database, broker or service.
- **Nothing is kept.** Grafana's state lives in tmpfs, and the datasource, folder and dashboard are provisioned from
  `infra/observability/grafana/` at every start. Dashboards cannot be saved or deleted from the UI. Recreating the container
  (`docker compose $OBS up -d --force-recreate grafana`) restores exactly what the repository holds. To change a dashboard, edit it
  locally, export the JSON (Share → Export, **without** "Export for sharing externally"), and replace the file in
  `infra/observability/grafana/dashboards/nawara-core/`; `npm run check:repo` checks it. A sign-in session does not survive a
  recreation.
- **No call home.** Usage reporting, update and plugin-update checks, the news feed, Gravatar, feedback links, plugin preinstall
  and the plugin catalogue are off. No plugin is installed.
- **Reading the overview:**
  - *No data* means the series does not exist: for example, a target not scraped yet, or a service started without the overlay.
  - *Not run* (readiness) means nothing has called `/ready` since the service started. Compose healthchecks call `/health`, so this is
    normal locally, and it is **not** a sign that the service is unhealthy. A service is listed only once its `/ready` has run. The raw
    gauges read 0 before that, so the panels filter them out. Readiness has no alert.
  - A service with no database pool, consumer or outbox simply has no line in that panel: not applicable, not 0.
  - The **5xx ratio** stays blank below 1 request per minute (not applicable). 0 means traffic with no 5xx.
  - RabbitMQ backlog is the **aggregate** of all queues, retry and dead-letter queues included. No queue is identified.

## Operational dashboards (A12.6.2)

Each has one selector at the top. It offers only known values, and a panel uses it as an exact match.

- **Core · Service:** choose the service in **Core service** (the eight Core scrape jobs). Rows: availability (target, uptime,
  readiness), HTTP (rate by status class, 5xx ratio, p95 / p99, busiest and failing routes, in flight), database pool, outbox,
  messaging and runtime (CPU, memory, event loop, GC).
- **Core · Messaging:** the top row covers every Core consumer: attached or lost, and messages each one **parked** in its
  `<queue>.dead` since start. Choose a queue in **Consumer queue** for its outcomes, handler latency and incidents. Then come
  publishing for all Core publishers, and the RabbitMQ broker.
- **Core · PostgreSQL:** the server row covers the whole local server. Choose a database in **Database** for its size, sessions,
  transactions, locks, deadlocks, tuples and cache. `postgres` is the maintenance database; its sessions are the exporter's and
  administrative ones.

**Reading the empty states.** A panel never invents a 0; its empty text says why it is empty:

| Shown | Meaning |
|---|---|
| *not applicable* (no outbox / no consumer / no pool) | the selected service does not have that component (audit-service and notification-service have no outbox; only billing, notification and audit consume) |
| *not run* | `/ready` has not been called since the service started (Compose calls `/health`); not a failure |
| *no outbox* on the outbox figures of a service that has one | the relay has not read the outbox aggregate yet; the **Outbox stats age** panel says how fresh the figures are |
| *none observed* | the event (a consume or publish outcome, a loss, a pool or relay failure) has not happened since the process started. Rare events are counted **since start**; **Uptime** says since when |
| blank 5xx / rollback / cache ratio | too little traffic for a meaningful ratio (below 1 request or 1 transaction per minute, or no block access) |
| `0` | a real zero: the series exists and the value is 0 |

**Messaging: two kinds of "dead letter".**
- *Application dead-lettered (parked)* comes from Core's consumers. The message is in `<queue>.dead`, classified as malformed,
  permanent or retries exhausted. This is the signal to act on; the `nawara-check-dlq` CLI lists the messages.
  *Dead-letter deferred* means the parking copy could not be confirmed: the message was requeued, not lost.
- *Broker dead-letter mechanics* is RabbitMQ's own counter. **expired** rises with every retry: a retry-queue message whose delay ends
  goes back to its main queue that way. It is not a count of parked messages, and Core's parked copies do not appear in it.
- *Aggregate broker backlog* is every queue together: main, retry **and** dead-letter queues. Parked messages stay in it until someone
  removes them, so a flat non-zero backlog can be parked messages, not slow consumers. No queue is identified; per-queue depth is not
  enabled.

**PostgreSQL: not available here.** Query latency, slow or top statements, blocker → waiter pairs, per-table / per-index activity and
I/O timing are not collected locally (no `pg_stat_statements`, those exporter collectors off, `track_io_timing` off). The dashboard says
so in a text panel. Lock counts and sessions waiting on a lock are available.

Latency panels (p95 / p99) are histogram estimates, precise only to the bucket bounds, and blank when nothing happened in the window.

## Alerts (A12.6.3)

Prometheus evaluates the rules in `infra/observability/prometheus/rules/` every 30 s. **There is no Alertmanager**: nothing is sent
anywhere. Read alerts at `http://127.0.0.1:9090/alerts` (pending = the condition holds but not yet for its `for` duration; firing).
Grafana is not configured for alerting; its view of these Prometheus rules is checked in the A12.6.3 runtime proof. Thresholds are
LOCAL validation values, not production ones.

| Alert | Fires when | Severity |
|---|---|---|
| CoreServiceDown | a Core service's metrics target has not answered for 2 minutes | critical |
| RabbitMQDown | the broker's metrics endpoint has not answered for 2 minutes | critical |
| PostgreSQLDown | postgres-exporter answers but has not reached PostgreSQL for 2 minutes (`pg_up` 0) | critical |
| PostgresExporterDown | postgres-exporter has not answered for 5 minutes: monitoring is blind, the database may be fine (PostgreSQLDown cannot fire then) | warning |
| PrometheusRuleFailures | a rule group failed to evaluate in the last 10 minutes (`rule_group` names it) | warning |
| PrometheusConfigReloadFailed | the last configuration reload failed; the previous configuration stays in force | warning |
| ConsumerDetached | a consumer (billing, notification or audit) has been detached from its queue for 2 minutes | critical |
| MessagesDeadLettered | a consumer parked messages in `<queue>.dead` in the last 10 minutes (inspect them with `nawara-check-dlq`) | warning |
| OutboxBacklogAging | the oldest pending outbox event has been older than 60 s for 5 minutes (only once the outbox was read) | warning |
| OutboxStatsStale | the outbox figures have not been read for over 2 minutes, or never since a start more than 5 minutes ago | warning |
| DbPoolWaiting | requests have waited for a database pool client for 3 minutes | warning |
| HttpServerErrorRatio | over 5 minutes, more than 5 % of a service's requests AND at least 3 answered 5xx, for 3 minutes | warning |
| BrokerResourceAlarm | RabbitMQ has raised its memory, disk or file-descriptor alarm for 1 minute (`alarm` says which) | critical |
| PgConnectionPressure | client backends above 80 % of the non-reserved connection slots for 5 minutes | warning |
| PgDeadlocks | PostgreSQL resolved deadlocks in a database in the last 10 minutes | warning |
| PgLockWaits | sessions in a database have waited on locks for 5 minutes (not "locks exist"; which session blocks which is not shown) | warning |

- **Readiness has no alert** (dashboard only): its gauges change only when something calls `/ready`.
- A stopped service is `up` 0 (its target stays configured), so CoreServiceDown fires for it after 2 minutes; this is expected locally
  when you run only part of the stack.
- No alert fires for a component a service does not have (no consumer, pool or outbox: no series), and outbox figures count only once
  the outbox has been read.
- **MessagesDeadLettered** can miss a dead letter right after a restart whose count equals the previous process's, and fires once
  for old dead letters when Prometheus is new: the dashboards' since-start counts stay the reference.
- Deferred: an alert on settle failures, on dead-letter queue depth or broker backlog (per-queue metrics are not enabled), on long
  transactions, and any notification (no Alertmanager).
- Change a rule: edit the rule file, add or adjust its test in `infra/observability/prometheus/tests/`, run
  `bash scripts/check-prometheus-rules.sh`, then restart Prometheus (`docker compose $OBS restart prometheus`; the lifecycle API is off).

## Settings and why

| Setting | Value | Reason |
|---|---|---|
| scrape / evaluation interval | 30 s | local development, not live monitoring; eight cheap targets |
| scrape timeout | 10 s | well above a local scrape (a few ms) |
| retention | 3 days, 1 GB | short and disposable; no production assumption |
| admin API, lifecycle API, remote write | off | not needed locally; less surface |
| container | read-only, all capabilities dropped, `no-new-privileges`, config mounted read-only | nothing else is needed |
| Grafana | `127.0.0.1:3100`, read-only, all capabilities dropped, `no-new-privileges`, non-root, tmpfs state, read-only provisioning | local viewing only; the repository is the source of truth |

`npm run check:repo` enforces the invariants: no `METRICS_ENABLED` in `docker-compose.yml`, 9464 and 15692 never published, pinned
overlay images, loopback-only ports, no admin, lifecycle or remote-write flags, no Docker socket or privileged mode, no credential or
remote write in the scrape configuration, the ten expected jobs present, and `postgres-exporter` connecting as `observability_monitor`
with an interpolated password (never written out, never in a URL; only the overlay passes `MONITORING_PASSWORD`). For Grafana
(A12.6.1) it also enforces the pinned OSS image on `127.0.0.1:3100` only, the container hardening, tmpfs state, anonymous access and
sign-up off, an interpolated admin password that is never `admin`, every call-home and plugin switch off, exactly one credential-free
Prometheus datasource, and deterministic dashboards that select by `job` and never use `or vector(0)`. Since A12.6.2 it also
requires the four dashboards, bounded single-valued variables used only as exact matches, aggregate-only broker metrics kept apart
from application metrics, and no PostgreSQL panel on data that is not collected. Since A12.6.3 it also requires: no `alerting` block;
the rules glob as the only `rule_files`; one self-scrape job keeping exactly the approved families; the rules mounted read-only and the
tests never; and bounded alert rules with a firing and a quiet promtool test each. `bash scripts/check-prometheus-rules.sh` (Docker)
runs promtool from the pinned image; CI runs it too.

## RabbitMQ broker metrics (A12.5.2)

The services' own messaging metrics (A12.3: publish and consume outcomes, handler duration, redeliveries, consumer up/loss/recovery,
settle failures) describe what each **service** saw, per queue it consumes. The broker job adds what the **broker** holds and does,
for the whole node.

- **Source:** RabbitMQ's native `rabbitmq_prometheus` plugin (3.13.7). The repository's `rabbitmq:3.13-management-alpine` image
  already enables it, so the broker serves `/metrics` on 15692 inside its container in every mode. Nothing in RabbitMQ is configured
  for this; only Prometheus, in the opt-in overlay, scrapes it.
- **Access:** the endpoint needs no credential, and Prometheus holds none. That is acceptable only because 15692 is reachable from the
  Compose network alone. It is not a production pattern: production RabbitMQ is provisioned differently (`infra/rabbitmq`), and any
  production rollout needs separate A12.10 authorization.
- **Aggregation:** the default **aggregated** endpoint (`prometheus.return_per_object_metrics = false`): node-wide totals, with no
  per-queue, per-connection, per-channel, vhost or user label. Its series count does not grow with queues or clients (measured: an
  extra queue added no series).
  - The scrape returns about 2,150 samples. About 1,880 are Erlang VM internals (per-allocator memory, scheduler micro-state
    accounting) that no A12.5 / A12.6 signal uses. The `rabbitmq` job drops exactly those two families (`erlang_vm_allocators`,
    `erlang_vm_msacc_*`), leaving about 270 series. Native names are never rewritten.
  - The per-object (`/metrics/per-object`) and detailed (`/metrics/detailed`) endpoints exist but are not scraped.

| Signal | Metric (native name) |
|---|---|
| node identity and uptime | `rabbitmq_identity_info`, `rabbitmq_erlang_uptime_seconds` |
| alarms | `rabbitmq_alarms_memory_used_watermark`, `rabbitmq_alarms_free_disk_space_watermark`, `rabbitmq_alarms_file_descriptor_limit` |
| memory | `rabbitmq_process_resident_memory_bytes` vs `rabbitmq_resident_memory_limit_bytes` |
| disk | `rabbitmq_disk_space_available_bytes` vs `rabbitmq_disk_space_available_limit_bytes` |
| connections, channels | `rabbitmq_connections`, `rabbitmq_channels` (and their `_opened_total` / `_closed_total`) |
| queues and backlog | `rabbitmq_queues`, `rabbitmq_queue_messages_ready`, `rabbitmq_queue_messages_unacked`, `rabbitmq_queue_messages` |
| consumers | `rabbitmq_consumers`, `rabbitmq_queue_consumers` |
| message activity | `rabbitmq_global_messages_received_total`, `_routed_total`, `_delivered_total`, `_acknowledged_total`, `_redelivered_total`, `_dead_lettered_*_total` |
| broker target availability | `up{job="rabbitmq"}` |

Everything here is **aggregate**: ready, unacknowledged and total messages, consumers, and broker message activity are node totals
(dead-letter queues included). No queue is identified: per-queue identification is not enabled, and the detailed and per-object
endpoints are not scraped. **Per-queue / DLQ-specific broker visibility is an A12.6 cardinality and dashboard decision.**

## PostgreSQL server metrics (A12.5.3)

The services' pool metrics (`nawara_db_pool_*`, A12.3) describe each service's **client** pool. The `postgres` job adds the **server**:
availability, sessions by state, transactions, locks, waiting sessions, deadlocks, database sizes, tuple activity and cache reads.

- **Exporter:** `prometheus-community/postgres_exporter` v0.20.1, `quay.io/prometheuscommunity/postgres-exporter:v0.20.1` pinned by
  digest. Upstream CI-tests PostgreSQL 13–18; the local server is PostgreSQL 16.15. It runs only in the overlay, on the Compose network
  (9187, never published), as `nobody`, read-only, with no capabilities and `no-new-privileges`.
- **Coverage:** one exporter for the one shared server. It connects to the `postgres` maintenance database and reads server-wide views,
  which cover all databases: `pg_stat_database` and `pg_database_size` per database, and `pg_stat_activity` and `pg_locks` for the whole
  server. It has no `CONNECT` on any service database.
- **Identity:** `observability_monitor`: `LOGIN`, `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`, member of the
  built-in `pg_monitor` only (`pg_read_all_stats`, `pg_read_all_settings`, `pg_stat_scan_tables`). It owns nothing and can write
  nothing.
- **Trust boundary:**
  - *Database role capability:* as a `pg_monitor` member, `observability_monitor` can read everything that built-in role can, including
    other sessions' current statement text in `pg_stat_activity`. That is accepted for this LOCAL design.
  - *Exported telemetry:* the exporter configured here does **not** export SQL or query text to Prometheus. The validated telemetry has
    no query label, `stat_statements` is off, and `pg_stat_statements` is not configured.
  - Production monitoring-role and credential policy requires separate A12.10 authorization.
- **Existing volumes:** `infra/postgres/init/01-service-databases.sh` runs automatically only when PostgreSQL initialises a **fresh**
  volume. It creates the role only when `MONITORING_PASSWORD` is set, which only the overlay passes. A local volume that was already
  initialised does **not** gain the role just because observability mode is turned on. Either apply that script's monitoring block (it
  is idempotent) by hand as the `postgres` admin, or recreate the volume, but only when it is a disposable local volume whose data you
  do not need.
- **Credentials:** `MONITORING_PASSWORD` comes from `.env` (the local, non-secret placeholder is in `.env.example`). It reaches the
  exporter as `DATA_SOURCE_PASS`, never in `prometheus.yml` or a connection URL. Production credentials are A12.10.
- **Cardinality:** about 950 series, bounded by fixed sets: `datname` (12 databases), lock `mode` (9), session `state` (6), role names
  (`usename`, `rolname`), Core services' fixed `application_name`, and PostgreSQL settings (one gauge each). The per-table and
  per-index collectors (`stat_user_tables`, `statio_user_tables`, `statio_user_indexes`) are **off**: table-level scans and index
  activity are not collected, and tuple activity is per database. No query text is exported: `stat_statements` is off,
  `pg_stat_statements` is not installed, and no exported label carries a statement.

| Signal | Metric |
|---|---|
| availability | `up{job="postgres"}` (exporter), `pg_up` (database reachable as the monitoring role), `pg_scrape_collector_success{collector}` |
| connections | `pg_stat_activity_count{datname,state,usename,application_name,…}`, `pg_stat_database_numbackends`, `pg_settings_max_connections` |
| transactions | `pg_stat_database_xact_commit`, `pg_stat_database_xact_rollback` |
| locks, blocking | `pg_locks_count{datname,mode}`; sessions waiting on a lock: `pg_stat_activity_count{wait_event_type="Lock"}`; `pg_stat_activity_max_tx_duration` |
| deadlocks | `pg_stat_database_deadlocks` |
| size | `pg_database_size_bytes{datname}` |
| tuple activity | `pg_stat_database_tup_returned`, `_fetched`, `_inserted`, `_updated`, `_deleted` |
| cache | `pg_stat_database_blks_hit`, `pg_stat_database_blks_read` |

**Not covered (a separate PostgreSQL configuration decision):** query latency and slow queries. They need `pg_stat_statements`
(`shared_preload_libraries`) or statement logging, neither of which A12.5 changes. Blocking is visible as lock counts and waiting
sessions, not as blocker-to-waiter pairs.

## Reading failures (A12.5.4)

Proven together on the full local stack. Monitoring is passive: none of these changes application, broker or database behaviour.

| What fails | What Prometheus shows |
|---|---|
| a Core service | its `up{job="<service>"}` = 0; every other target stays UP |
| RabbitMQ | `up{job="rabbitmq"}` = 0, and each consumer's `nawara_event_consumer_up` = 0 (losses counted). After recovery, consumers re-attach on their own (recoveries counted) |
| PostgreSQL | `pg_up` = 0 while `up{job="postgres"}` stays 1 (the exporter answers); DB-backed `/ready` reports `database` |
| postgres-exporter | `up{job="postgres"}` = 0; PostgreSQL and the services are unaffected |
| Prometheus | nothing else changes: services, broker and database keep working, and each `/metrics` is still served inside the network |

## Adding a workload later

Another workload (for example `nawara-ia`, or a product such as School or Drive) is added as **its own scrape job** pointing at its own
metrics endpoint. Its code, metric names and instrumentation stay in its own repository (ADR-0055); nothing in `libs/service-kit` or a
Core service changes. Not done in A12.5.

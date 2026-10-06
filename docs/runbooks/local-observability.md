# Local observability (V2 A12.5)

LOCAL development only. Nothing here is production configuration, and it neither performs nor authorizes any production action:
production observability is A12.10, behind its own decision gate (D2). Record:
[core-v2-a12-observability.md](../architecture/core-v2-a12-observability.md) §3D, §3E, §4G, §4H.

## What it is

- **Normal development** uses `docker-compose.yml` alone. Every Core service keeps the kit default `METRICS_ENABLED=false`, so no
  metrics listener exists and nothing is collected.
- **Observability** is opt-in through the overlay `docker-compose.observability.yml`. It sets `METRICS_ENABLED=true`,
  `METRICS_HOST=0.0.0.0` and `METRICS_PORT=9464` on the eight Core services (auth, billing, payment, organization, notification,
  file, audit, release) and starts Prometheus (`prom/prometheus:v3.13.4`, the 3.13 LTS line, pinned by digest).
- Prometheus scrapes `<service>:9464/metrics` over the Compose network, with one job per service, plus the RabbitMQ broker (job
  `rabbitmq`, `rabbitmq:15692/metrics`, A12.5.2): **nine targets**. Ports 9464 and 15692 are **never** published to the host. Only the
  application ports (unchanged), RabbitMQ's existing 5672 / 15672, and Prometheus on `127.0.0.1:9090` are reachable from the host.
- **Collection only.** Grafana, dashboards and alerts come in A12.6, and PostgreSQL server metrics in A12.5.3. Host and container
  metrics are deferred to A12.10. There is no log collection (decision D7).

## Use

```bash
OBS="-f docker-compose.yml -f docker-compose.observability.yml"
docker compose $OBS --profile db up -d --wait postgres rabbitmq
# migrations, once per empty database: see the header of docker-compose.yml (`npm run migrate` per service, `auth-migrate`)
docker compose $OBS --profile db up -d --wait auth-service billing-service payment-service organization-service \
  notification-service file-service audit-service release-service prometheus
```

Then open `http://127.0.0.1:9090/targets`: nine jobs (eight services and `rabbitmq`), all `UP`. A service started without the
overlay has no metrics listener, and its target is `DOWN`.

Stop with `docker compose $OBS --profile db down`. Prometheus keeps at most 3 days or 1 GB in the named volume
`nawara_prometheus_data` (disposable: `docker volume rm <project>_nawara_prometheus_data`).

## Settings and why

| Setting | Value | Reason |
|---|---|---|
| scrape / evaluation interval | 30 s | local development, not live monitoring; eight cheap targets |
| scrape timeout | 10 s | well above a local scrape (a few ms) |
| retention | 3 days, 1 GB | short and disposable; no production assumption |
| admin API, lifecycle API, remote write | off | not needed locally; less surface |
| container | read-only, all capabilities dropped, `no-new-privileges`, config mounted read-only | nothing else is needed |

`npm run check:repo` enforces the invariants: no `METRICS_ENABLED` in `docker-compose.yml`, 9464 and 15692 never published, pinned
overlay images, loopback-only ports, no admin, lifecycle or remote-write flags, no Docker socket or privileged mode, no credential or
remote write in the scrape configuration, and the nine expected jobs present.

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

## Adding a workload later

Another workload (for example `nawara-ia`, or a product such as School or Drive) is added as **its own scrape job** pointing at its own
metrics endpoint. Its code, metric names and instrumentation stay in its own repository (ADR-0055); nothing in `libs/service-kit` or a
Core service changes. Not done in A12.5.

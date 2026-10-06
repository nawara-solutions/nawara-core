# Local observability (V2 A12.5)

LOCAL development only. Nothing here is production configuration, and it neither performs nor authorizes any production action:
production observability is A12.10, behind its own decision gate (D2). Record:
[core-v2-a12-observability.md](../architecture/core-v2-a12-observability.md) §3D, §4G.

## What it is

- **Normal development** uses `docker-compose.yml` alone. Every Core service keeps the kit default `METRICS_ENABLED=false`, so no
  metrics listener exists and nothing is collected.
- **Observability** is opt-in through the overlay `docker-compose.observability.yml`. It sets `METRICS_ENABLED=true`,
  `METRICS_HOST=0.0.0.0` and `METRICS_PORT=9464` on the eight Core services (auth, billing, payment, organization, notification,
  file, audit, release) and starts Prometheus (`prom/prometheus:v3.13.4`, the 3.13 LTS line, pinned by digest).
- Prometheus scrapes `<service>:9464/metrics` over the Compose network, with one job per service. Port 9464 is **never** published to the
  host. Only the application ports (unchanged) and Prometheus on `127.0.0.1:9090` are reachable from the host.
- **Collection only.** Grafana, dashboards and alerts come in A12.6; RabbitMQ broker metrics in A12.5.2; PostgreSQL server metrics in
  A12.5.3. Host and container metrics are deferred to A12.10. There is no log collection (decision D7).

## Use

```bash
OBS="-f docker-compose.yml -f docker-compose.observability.yml"
docker compose $OBS --profile db up -d --wait postgres rabbitmq
# migrations, once per empty database: see the header of docker-compose.yml (`npm run migrate` per service, `auth-migrate`)
docker compose $OBS --profile db up -d --wait auth-service billing-service payment-service organization-service \
  notification-service file-service audit-service release-service prometheus
```

Then open `http://127.0.0.1:9090/targets`: eight jobs, all `UP`. A service started without the overlay has no metrics listener, and its
target is `DOWN`.

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

`npm run check:repo` enforces the invariants: no `METRICS_ENABLED` in `docker-compose.yml`, 9464 never published, pinned overlay images,
loopback-only ports, no admin, lifecycle or remote-write flags, no Docker socket or privileged mode, and no credential or remote write
in the scrape configuration.

## Adding a workload later

Another workload (for example `nawara-ia`, or a product such as School or Drive) is added as **its own scrape job** pointing at its own
metrics endpoint. Its code, metric names and instrumentation stay in its own repository (ADR-0055); nothing in `libs/service-kit` or a
Core service changes. Not done in A12.5.

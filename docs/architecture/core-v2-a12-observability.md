# Core V2 A12: observability foundation

- **Status:** RECORD of A12.0 discovery, the A12.1 design freeze (owner decisions D1–D8), the A12.2 kit metrics foundation, its
  local security review and the A12.2a correction (§3A), written 2026-10-05: **A12.2 MERGED** (PR #205, `763e1a8`), not certified. Then the
  A12.3 service and messaging metrics (§3B): **A12.3 FORMALLY CLOSED** (PR #206, merge `272ab8d`, post-merge Core CI 24/24). Then A12.4
  logging and PII (§3C): **architecture approved** (owner decisions W1, W2); **A12.4.2 kit hardening implemented and proven locally**
  (§4C; commit `b5bb23d`); **A12.4.3 TypeScript service adoption proven locally** (§4D; commit `ad15d19`); A12.4.4 (ai-service)
  **NOT APPLICABLE**: the AI runtime is not a Core-owned service (§3C); **A12.4.5 service negative controls and
  security review proven locally** (§4E; commit `dc0e6b4`); **A12.4.6 final local validation passed** (§4F): **A12.4 FORMALLY CLOSED** (PR
  #207, merge `6fac8fe`, post-merge Core CI green). Then A12.5: **A12.5.1 local Prometheus collection MERGED** (PR #209, `1ad43d2`; §3D, §4G;
  local only), with an A12.3 post-certification correction (§3D); **A12.5.2 RabbitMQ broker metrics proven locally** (§3E, §4H; not
  committed); A12.5.3–A12.5.5 and A12.6 pending. Metrics are **off by default**
  (`METRICS_ENABLED=false`): no service changes behaviour until a deployment sets it. Nothing here is deployed, scraped in production
  or alerted on; Prometheus exists only as the opt-in LOCAL overlay (A12.5.1), and no Grafana, Alertmanager or exporter exists yet
  (A12.5.3+, A12.6). It performs and authorizes no production action.
- **Scope of A12.2:** the service-kit metrics foundation (bounded registry, closed label policy, separate metrics listener, HTTP and
  runtime metrics, an additive readiness observer), its integration through `configureApp` and auth-service's explicit wiring, and a
  repository guard. Not included: messaging, outbox, DLQ, pool and domain metrics (A12.3), logging changes (A12.4), the local stack,
  dashboards and alert rules (A12.5–A12.6), any production rollout (A12.10, separately authorized), tracing, Loki.
- **Related:** [production readiness](production-readiness.md), [Organization runbook §6 (G4)](../runbooks/organization-production.md),
  [G6 rehearsal plan §8](stage-21/stage-21-x-g6-rehearsal-plan.md), [A14 supply chain](core-v2-a14-supply-chain.md).

## 1. Starting point (A12.0)

Core had structured JSON logs with credential redaction, request and correlation ids, `/health` (liveness) and `/ready` (named
dependency checks), catalogued operational log events pinned by tests, periodic `*_snapshot` log lines, and the `nawara-check-outbox-lag`
and `nawara-check-dlq` CLIs. It had no metrics endpoint, no HTTP or runtime metrics, no tracing and no observability stack. The G4
cutover monitoring (attended) relies on the existing log names, CLI outputs and exit codes and on `/ready` semantics; its live
demonstration belongs to G6.

## 2. Owner decisions (A12.1)

| | Decision |
|---|---|
| D1 | Prometheus-compatible pull metrics through a shared kit mechanism; existing snapshot logs stay; metrics are additional evidence |
| D2 | production placement of the stack is not decided; it follows measured headroom, retention, interval, series count and footprint |
| D3 | application-side messaging metrics approved; `rabbitmq_prometheus` designed as an option; production enablement separately authorized |
| D4 | readiness semantics, G4 signal names, CLI behaviour and exit codes unchanged before G6 |
| D5 | Auth `/auth/health` unchanged (a public database-readiness check named "health"; a migration is a post-G6 item) |
| D6 | rules → evaluation → Alertmanager with no external receiver (attended) |
| D7 | JSON stdout logs kept; no Loki; rotation, retention and PII redaction designed |
| D8 | tracing deferred; W3C trace context reserved for later |

Refinement D1a: metrics are served by a **separate listener** (`METRICS_PORT`), never by the application server, so `/metrics` can
never be an application route or appear under a routed prefix such as `/auth`, and it keeps answering while the application drains.

## 3. A12.2 implementation (kit metrics foundation)

All metrics code lives in `libs/service-kit/src/metrics/`; `prom.ts` is the only module that imports the client library
(`prom-client` 15.1.3, owner decision H1: kept for A12), and `check:repo` refuses any reference to it, or to its successor
`@prometheus-io/client`, anywhere else (`checkMetricsClientImport`, syntax-aware since A12.2a, §3A).

- **Label policy** (`label-policy.ts`). Label sets are made only by the kit's factories (`closedSet` is the public one; the route and
  readiness-check sets are internal) and are authentic, frozen objects: registration refuses anything else. Label names come from one catalog (`service`, `method`, `route`, `status_class`, `outcome`,
  `kind`, `event`, `queue`, `check`, `pool`, `caller`, `metric`), checked against a forbidden-word screen (identifiers, contact data,
  credentials, raw request parts, free text). Every value resolves through a set fixed by code: a closed list, the router's declared
  route templates (computed once), or a capped, pattern-checked set of code-registered names (readiness checks). Anything else folds
  into `other` (`__unmatched__` for routes). Resolution never throws.
- **Bounded registry** (`metrics.ts`). `BoundedMetrics` is the only way to create a metric: `nawara_` names, `_total` counters,
  `_seconds`/`_bytes` histograms, one-line help, at most four labels, a private registry per process. Each metric holds at most
  `maxSeries` label combinations (default 500); past it, observations fold into one overflow series and are counted in
  `nawara_metrics_label_overflow_total{metric}`. That counter is created outside the public path and labelled only with registered
  metric names, so it is bounded and cannot overflow itself.
- **Configuration** (`metrics-config.ts`). `METRICS_ENABLED` (default `false`), `METRICS_HOST` (an IP literal, default `127.0.0.1`;
  all interfaces only when written out), `METRICS_PORT` (default 9464, 1024–65535, never `PORT`; `0` only under `NODE_ENV=test`).
  Validated even while disabled. Part of `BaseConfig`; auth-service reads it with the same kit function.
- **Listener** (`metrics-server.ts`, `metrics-host.ts`). `GET`/`HEAD /metrics` only (404 elsewhere, 405 for other methods),
  `unref`'d, rendered from in-memory state. An occupied port is logged as `metrics_listener_failed error=<class> code=<code>` (no
  host, port or message) and the service keeps serving. `MetricsHost` (provided by the kit's global `HealthModule`) refuses a second
  installation and closes the listener in the last shutdown phase.
- **HTTP** (`http-metrics.ts`). `nawara_http_server_requests_total` and `nawara_http_server_request_duration_seconds`
  (`method`, `route`, `status_class`) and `nawara_http_server_requests_in_flight`. The route is the template Express matched
  (`req.baseUrl + req.route.path`), read when the response finishes; the request target is never read. Probe routes `/health`,
  `/ready` and `/auth/health` are excluded by template. An aborted request is counted once, as `aborted`. Requests refused by the
  shutdown admission (before the middleware) are not counted.
- **Runtime** (`runtime.ts`). Sixteen standard process and Node metrics (CPU, resident memory, start time, file descriptors, heap
  used/total, external memory, event-loop lag p50/p99/max/mean, GC duration, version), moved from a staging registry; per-heap-space,
  active handles/requests/resources, virtual memory and the heap-bytes duplicate are left out.
- **Readiness** (`health/readiness.registry.ts`, additive). `setObserver()` lets the metrics see what each `/ready` run found after
  the result is decided: `nawara_readiness_ready`, `nawara_readiness_check_up{check}`, `nawara_readiness_check_duration_seconds{check}`,
  `nawara_readiness_last_run_timestamp_seconds`. The observer cannot change the result, the response, the timeout, the drain answer or
  the log lines (a throwing observer is ignored), and metrics never run a check.
- **Integration.** `configureApp` calls `installMetrics` right after the request-context middleware (no service code changes);
  auth-service, which builds its pipeline itself, calls it at the same point in `main.ts`. With metrics off, nothing is installed.

## 3A. Security review and the A12.2a correction

The local security review attacked the exposure boundary, raw-data leakage, route attribution, cardinality, the registry, the
readiness observer and the listener lifecycle (all held), and found two defects, corrected in A12.2a before any commit:

- **H-1 (HIGH): the metrics-client guard was regex-based.** It missed template-literal specifiers (``import(`prom-client`)``,
  ``require(`prom-client`)``) and `createRequire(...)('prom-client')`, and its comment stripping was not string-aware: `"a//b"` or a
  pair of glob strings (`'apps/*/src'` … `'lib/**/x'`) hid a real import. **Correction:** the guard parses each source file with the
  TypeScript compiler API (already a workspace dependency; no new package) and inspects real module specifiers only: import and
  export declarations, import types, `import x = require()`, dynamic `import()`, `require()`, `module.require()`, `require.resolve()`
  and functions obtained from `createRequire(...)` (direct or through a variable); string and no-substitution template literals,
  escapes decoded. Comments, ordinary strings and lookalike packages are not references.
- **M-1 (MEDIUM): the label policy could be bypassed by code.** Registration checked forbidden words but not catalog membership,
  `LabelSet` was structurally forgeable (`{ name: 'route', resolve: (v) => String(v) }` put a raw token in a label), and the public
  `growingSet` accepted any pattern and limit. **Correction:** label sets are authentic only when the kit's factories made them (a
  module-private `WeakSet`, never exported; each set frozen, so `resolve` cannot be swapped; copies, prototypes and proxies are refused);
  registration refuses a non-authentic set and an uncatalogued name; `growingSet` and `lazyClosedSet` are internal to the metrics module
  (not exported, and the package `exports` map refuses deep imports).
- **L-1 (LOW): regression gaps** closed with permanent tests: forged and look-alike sets, uncatalogued names, the removed `growingSet`
  export and blocked deep imports (`metrics-registry.spec.ts`); the full guard matrix including template literals, `createRequire`,
  `require.resolve`, escaped specifiers and comment-like strings (`check-repo.test.mjs`); encoded, unicode, malformed and redirect
  request targets and the middleware position (`metrics-http.spec.ts`); auth-service's `main.ts` order, asserted on its syntax tree.
- **Owner-review boundary (static guard limits, accepted; L-3, LOW).** The import guard is a static, defence-in-depth repository
  control, not a JavaScript sandbox. It blocks every ordinary, statically identifiable reference to the metrics client (§3A, H-1). It
  does not, by design, follow deliberate constructs that only an intentional code change can introduce:
  - a fully computed module specifier (`'prom-' + 'client'`), or a template-literal specifier with a substitution (`` `prom-${x}` ``);
  - an npm alias introduced in package metadata (`"x": "npm:prom-client@…"`);
  - a deliberate relative import into the kit's internal source;
  - an aliased or indirect `require` (`const r = require; r(…)`, `(0, require)(…)`);
  - a renamed or destructured `createRequire` (`import { createRequire as cr }`, `const { createRequire: cr } = …`).

  Each of these is a reviewed source change, not a runtime or request path: no request can reach them. They remain with owner PR review
  (the A14.4 trust boundary), and the package `exports` map still refuses deep imports of the kit's internals; code that bypassed the
  guard would also bypass the label policy only by a change a reviewer sees.
- **L-2 (LOW, recorded, unchanged):** an asynchronous readiness observer that rejects would surface as an unhandled rejection. The
  only observer is the kit's synchronous one, installed once by code; readiness semantics are G4/G6-sensitive and stay unchanged.
- The guard depends on the TypeScript compiler API (`typescript` 6.0.3 here). It fails closed: if that API is unavailable (for example
  a TypeScript major without the JS API), `check:repo` cannot load and fails instead of passing.

### G4 non-regression

A12 does not remove, rename or change any G4 or kit log signal (`readiness_check_failed` / `_recovered`, outbox, retry,
dead-letter, consumer, database, hierarchy, ownership and shutdown signals, every `*_snapshot` line), the `nawara-check-outbox-lag` and
`nawara-check-dlq` CLIs (arguments, output, exit codes), `/health`, `/ready`, Auth `/auth/health` or any Docker healthcheck. The
existing observability, readiness and health suites pass unmodified (§4).

## 3B. A12.3 service and messaging metrics

Owner decisions: **D-1** no `event` label (event names are not universally closed, and audit-service accepts `audit.#`), so messaging
metrics carry the consumer's own `queue` and a closed `outcome` only; **D-2** no domain snapshot mirroring; **D-3** no DLQ depth from the
application (it stays with `nawara-check-dlq` and, later, broker metrics); **D-4** no wrapping of database queries; **D-5** a minimal
synchronous gauge `collect` for scrape-time pool state.

- **Observer hooks (single-shot, synchronous, isolated).** `RabbitMqEventBus.setObserver`, `OutboxRelay.setObserver` and
  `DbService.setPoolObserver` (and the same on auth-service's own pool) tell one observer each outcome AFTER it is decided and settled. A
  throwing observer is ignored; the notices are unchanged and stay the authoritative operational signals (no metric parses a log line).
- **Messaging** (`metrics/messaging-metrics.ts`): `nawara_events_published_total{outcome=confirmed|failed|confirm_timeout}`,
  `nawara_event_publish_duration_seconds`; `nawara_events_consumed_total{queue,outcome}` (processed, retry_scheduled,
  dead_lettered_malformed / _permanent / _retries_exhausted, dead_letter_deferred, dead_letter_unannotated: the existing notice branches),
  `nawara_event_handler_duration_seconds{queue}`, `nawara_event_redeliveries_total{queue}`, `nawara_event_consumer_up{queue}`,
  `nawara_event_consumer_losses_total{queue}`, `nawara_event_consumer_recoveries_total{queue}`, `nawara_event_settle_failures_total{queue}`.
  `queue` is a name code registered when subscribing (at most 16 per process, pattern-checked, internal set). Each observation is made
  after the ack / nack it reports: the acknowledgement order of every outcome is unchanged (proven against the bus's real code).
  **`processed` means the handler completed successfully**; a subsequent acknowledgement failure is represented separately by
  `nawara_event_settle_failures_total` (the broker redelivers that message), so the same delivery can count once as `processed` and once
  as a settle failure, and again on its redelivery. Dashboards and alerts (A12.6) must read the two together.
- **Outbox** (`metrics/outbox-metrics.ts`): `nawara_outbox_pending_events`, `nawara_outbox_retrying_events`,
  `nawara_outbox_oldest_pending_age_seconds`, `nawara_outbox_stats_timestamp_seconds` (the same aggregate as `nawara-check-outbox-lag`),
  read by the relay's existing poll loop (no new timer), at most every 15 s per instance, only with an observer, outside the claim
  transaction, bounded by the pool's timeouts; a failing read is swallowed and only lets the timestamp go stale. `nawara_outbox_relay_pass_failures_total{kind}`
  counts pass failures by the closed failure kind. The CLI is unchanged and remains the G4 evidence.
- **Pool** (`metrics/pool-metrics.ts`): `nawara_db_pool_connections`, `_idle_connections`, `_waiting_clients`, `_max_connections`
  (`pool`), read at scrape from the pool's getters (no query, no timer); `nawara_db_pool_errors_total{pool,kind}` from idle-client
  errors. Database-side metrics stay with the PostgreSQL exporter (A12.5).
- **Wiring.** `installMetrics` observes the kit `EVENT_BUS`, `OutboxRelayService` and the kit `DbService` token when present (so
  auth-service's own pool, which it provides behind that token, is covered by an additive `poolStats()` / `poolMax` / `setPoolObserver`
  only). audit-service and notification-service keep their buses under their own tokens and observe them with one line after
  `configureApp` (`MetricsHost.observeEventBus`). Each source is observed once; with metrics off nothing is observed.
- **Deferred:** an `event` label (needs closed per-service catalogs; Auth has none), domain snapshot mirroring, DLQ and queue depth
  (`rabbitmq_prometheus`, A12.5 / A12.10), database operation errors, `postgres_exporter`, dashboards and alerts (A12.6), production
  rollout (A12.10).

## 3C. A12.4 logging and PII contract

Approved architecture (A12.4.1, owner decisions **W1** frames-only stacks, **W2** bare `code` stays redacted). It hardens the existing
`JsonLogger`; no logging library is added. It applies to **operational logs only**: audit records (audit-service storage, the
`audit-contract` catalog) are required evidence and are not sanitized by it, and operational logs never copy audit payloads.

- **Never-throws.** No logger entry point throws into its caller. Values go through `safeSerialize` (`logging/safe-serialize.ts`): only
  own, enumerable data properties are read through descriptors; an accessor is `[accessor]` (never invoked); `toJSON`, inspection hooks
  and `Symbol.toStringTag` are never consulted; a throwing Proxy is `[unserializable]`; a cycle `[circular]`; BigInt a bounded `…n`
  string; Buffer / typed arrays / ArrayBuffer / DataView `[binary N bytes]`; Date its ISO string (`[invalid date]`); Map / Set
  `[Map N]` / `[Set N]` (never their contents); symbols and functions placeholders. A record that cannot be built becomes
  `log_record_unserializable`; a failing sink is ignored.
- **Bounds.** Depth 6, strings 2000 characters, arrays 50 items, objects 50 keys (plus a `[+N]` marker), stacks 20 frames, a line
  16 KiB (past it the caller's fields become `fieldsTruncated: true`; envelope and `msg` stay).
- **Envelope.** `ts`, `level`, `service`, `msg`, `context`, `requestId`, `correlationId`, `stack`, `droppedFields`, `fieldsTruncated`
  belong to the logger. A caller field whose name matches one (case- and separator-insensitively) is dropped and only its NAME is listed
  in `droppedFields`.
- **Classification.** A: secrets, never emitted. B: direct PII (email, phone, IP, user agent, address, recipient / destination / contact,
  personal names), redacted by key by default. C: internal identifiers (user, company, organization, platform, event, request,
  correlation, payment, invoice, delivery, file ids), allowed as explicitly named fields. D: bounded operational data.
- **Key redaction** (normalized: case and separators ignored). Secret families `password`, `passwd`, `secret`, `token`, `jwt`,
  `authorization`, `cookie`, `apikey`, `credential`, `privatekey`, `signature`, `pepper`, `connectionstring`, `challenge`, `sessionid`, and
  the words `otp`, `totp`, `dsn`. Any key ending in `code` is redacted (bare `code` included: Auth carries a factor code under it) except
  `statusCode`, `errorCode`, `providerCode`, `failureCode`, `reasonCode`, `exitCode`, `taxCode`, `productCode`, `currencyCode`,
  `countryCode`; `challengeId` is an identifier. PII by key only: free text is not scanned for PII, so a call site never puts PII in `msg`.
- **Free-text scrubbing** (`msg`, string fields, key names): `Bearer` / `Basic` credentials (quoted or not), URL userinfo passwords,
  secret query values (`token`, `access_token`, `refresh_token`, `id_token`, `api_key`, `apikey`, `key`, `secret`, `password`, `code`,
  `signature`, `sig`, `X-Amz-Signature`, `X-Amz-Credential`), `password=` / `secret=` / `token=`-style pairs in prose (not `code=` or
  `key=`, which are operational words in log lines), JWT-shaped values, `/file/t/<token>` paths.
- **Errors.** An Error is `{ errorType, errorCode?, errorKind? }` as `describeFailure` classifies it, read from a data-only copy (no
  getter runs): never its message, cause or stack. A stack (Nest's `error(msg, stack, ctx)`) keeps its `at …` frames only (W1), the
  same in development and production. No SQL, parameters, PostgreSQL detail or connection string.
- **Structured fields.** camelCase, all optional: `operation`, `outcome`, `statusCode`, `errorType`, `errorCode`, `errorKind`,
  `eventType`, `eventId`, `durationMs`, `attempt` and category-C ids. `msg` stays a stable event key or description; existing
  `snake_case key=value` lines are compatible debt; no untrusted value is interpolated into `msg`. No schema version field.
- **HTTP.** No access or request logging is added (no URL, query, body, headers, IP or user agent); HTTP metrics cover traffic.
- **Correlation.** Preserved as is. `runWithEventContext` restores `requestId` (`event:<id>`) and a validated `correlationId` for a
  consumer that calls it explicitly; the event bus delivery path is not wrapped. No tracing or causation ids.
- **Untrusted values.** `safeToken(value, pattern, max)` returns the value only when it matches (`SAFE_ID`, `EVENT_NAME`), else
  `[invalid]`; logs only, never a metric label.
- **Unchanged.** `redact` / `redactString` (`logging/redact.ts`) keep their behavior: the outbox relay stores `redactString` output in
  `lastError` and `nawara-check-outbox-lag` prints it (G4 evidence). A12.3 metrics, observers, event delivery, outbox and pool code are
  not touched; log fields never become metric labels.
- **Pending adoption (A12.4.3+).** Auth honours `LOG_LEVEL`; Notification intake and Billing payment-event lines move broker
  `source` / `correlationId` to `safeToken` fields (Billing restores context); CLI failures print type and code, not `e.message`; the
  ownership CLI's `code` field becomes `errorCode`.
- **AI boundary (owner decision, 2026-10-06).** A12.4 covers operational logging and PII safety for Core-owned services. The AI
  runtime is not one: AI implementation belongs to the separate `nawara-ia` repository and workstream, which establishes its own
  compatible logging and PII policy and uses this one as an integration reference, not as Core-owned implementation. A12.4.4 (planned
  as ai-service JSON logging) is therefore **NOT APPLICABLE**; the number is kept so the phase history stays readable. The committed
  `apps/ai-service` scaffold is left as it is until a separate architecture task removes it. (Later: removed by that task;
  the boundary is [ADR-0055](../adr/0055-ai-service-repository-boundary.md).)

## 3D. A12.5.1 local Prometheus, and an A12.3 post-certification correction

A12.5.0 discovery and the owner's decisions: Grafana starts in A12.6; `postgres_exporter` with a `pg_monitor` role is A12.5.3;
scrape targets are the Compose-network Core services only; host and container metrics are deferred to A12.10.

- **Opt-in overlay** (`docker-compose.observability.yml`). Normal development (`docker-compose.yml` alone) keeps every service's
  kit default `METRICS_ENABLED=false`. The overlay adds `METRICS_ENABLED=true`, `METRICS_HOST=0.0.0.0` and `METRICS_PORT=9464` to the
  eight Core services, merged into their environment (no service is duplicated), and starts Prometheus
  `prom/prometheus:v3.13.4@sha256:87861b8c…e84e32e` (the 3.13 LTS line) on `127.0.0.1:9090`. It has a 3 d / 1 GB retention, no admin,
  lifecycle or remote-write API, and runs read-only with no capabilities. Port 9464 stays inside the Compose network.
- **Scrape configuration** (`infra/observability/prometheus/prometheus.yml`): one job per service, 30 s interval, 10 s timeout, no
  relabelling and no credential. A future workload (`nawara-ia`, a product) is one more job; its code stays in its own repository.
- **Repository guard** (`checkLocalObservability`, `check:repo`): no `METRICS_ENABLED` in `docker-compose.yml`; 9464 never published;
  pinned overlay images and loopback-only ports; no admin, lifecycle or remote-write flag, Docker socket or privileged mode; no
  credential or remote write in the scrape configuration.
- **A12.3 post-certification correction** (found by the A12.5.1 runtime proof; A12.3 stays formally closed). With metrics on,
  audit-service and notification-service exited at startup. `installMetrics` looked up its optional providers (the kit `EVENT_BUS`,
  `OutboxRelayService`, `DbService`) with `app.get` inside `try`/`catch`. But `NestFactory.create`, under Nest's default
  `abortOnError: true` (every service's `main.ts`), returns a proxy that runs each application method in Nest's exception zone, which
  logs a failed lookup and calls `process.exit(1)` before the `catch` runs (`@nestjs/core` 12.0.3, `nest-factory.js`
  `createExceptionZone`, `exceptions-zone.js`). Audit and Notification provide neither the kit `EVENT_BUS` nor an outbox relay; a service
  without `DbService` would have exited too. The A12.3 tests built applications with `Test.createTestingModule`, which has no such
  proxy. **Correction:** the three optional lookups go through the root `ModuleRef` (a plain lookup whose `UnknownElementException` the
  kit catches); the required `MetricsHost` and `ReadinessRegistry` stay on `app.get`, so a genuinely missing one still fails startup
  as before; no service's `abortOnError` changes. No production impact: metrics are off unless a deployment sets them.

## 3E. A12.5.2 RabbitMQ native broker metrics (local)

- **Capability.** The repository's local broker image `rabbitmq:3.13-management-alpine` (RabbitMQ 3.13.7) already enables
  `rabbitmq_prometheus` (`/etc/rabbitmq/enabled_plugins`: `[rabbitmq_management,rabbitmq_prometheus]`). It serves `/metrics` on 15692
  inside the container, without authentication, in every mode. No RabbitMQ configuration, plugin, image or Compose change is needed:
  normal development is unchanged by construction, and the broker is scraped only by the opt-in overlay's Prometheus.
- **Scrape job** `rabbitmq` → `rabbitmq:15692/metrics`, on the Compose network only; 15692 is never published. With the eight service
  jobs, Prometheus has nine targets.
- **Cardinality.** The default **aggregated** endpoint (`return_per_object_metrics = false`) gives node-wide totals, with no queue,
  connection, channel, vhost or user label, so the series count is independent of the number of queues. Of its ~2,150 samples, ~1,880
  are Erlang VM internals (`erlang_vm_allocators`, `erlang_vm_msacc_*`) that no A12.5 / A12.6 signal uses. The job drops exactly those
  two families with one `metric_relabel_configs` rule (no renaming, no added label), leaving ~270 stored series. The per-object and
  detailed endpoints are not scraped.
- **Queue depth.** Ready, unacknowledged and total messages are observable as **node totals** (dead-letter queues included, no queue
  named). Per-queue depth, for example a DLQ alert, would need the detailed endpoint with per-queue labels: a separate A12.6 decision
  with a different, bounded cardinality.
- **Boundary.** The unauthenticated endpoint is acceptable only inside the local Compose network. Production RabbitMQ (provisioned by
  `infra/rabbitmq`, without the management plugin) is unchanged; any production enablement is A12.10, separately authorized.
- **Guard.** `checkLocalObservability` now also refuses host publication of 15692, and requires the eight Core jobs plus `rabbitmq`.

## 4. Evidence (A12.2, local)

Branch `feature/core-v2-a12-observability-foundation` from `main` at `ceb5407`, 2026-10-05, Node 24 locally (the images run Node 22).

| Step | Result |
|---|---|
| Route-template spike (Nest 12.0.3, Express 5.2.1, through `configureApp`) | **PASS** 7/7: the declared template is present at finish for a normal answer, a guard refusal, a pipe refusal, a thrown error and a tokenized path; absent for an unknown path; the Express 5 router lists every template |
| Focused metrics and security tests (kit) | 54/54 plus the spike: seeded UUID, organization id, email, token, request and correlation ids, header and query absent from the exposition; forbidden labels refused; hostile values folded; series bounded under 400 randomized requests; overflow bounded and non-recursive; no metrics on the application port; loopback by default; second installation refused; occupied port logged by class and code only, service keeps serving; `unref` proven in a child process |
| Readiness non-regression | identical result, log lines and check-run count with and without the observer (healthy, failing, timeout); a throwing observer changes nothing; drain answer unchanged; scrapes never run a check; `/ready` body and status identical with metrics on and off |
| service-kit | build, typecheck, lint (one pre-existing warning in an untouched file); unit 337/337 (`observability.spec` unmodified); integration 113 + the management-API-gated DLQ file 15/15 |
| Final kit rebuild | clean rebuild after the last kit change; every dependent run below used that `dist/` (fingerprint checked before each) |
| `check:repo` / `test:repo` / `test:deploy` | PASS / 62/62 / 315/315, 0 skipped |
| auth-service | unit 117/117; metrics e2e 6/6; full e2e 435/435 |
| organization-service | unit 143/143; metrics e2e 4/4; full e2e 13 files 260 passed, and `ownership.e2e-spec` 18/18 on a throwaway PostgreSQL (it refuses, by design, a cluster that hosts the `organization` database) |
| billing / audit / notification / release / file / payment | unit 345 / 236 / 316 / 87 / 261 / 105; e2e 336 / 434 (+7 skipped: the A13 container suite, not run) / 321 / 225 / 296 (+35 skipped: S3-gated) / 163 |

Two existing tests changed, both exhaustive lists of a service's configuration keys (Organization, Billing): `metrics` is the one key
added, the field this phase introduces into `BaseConfig`. No readiness, health, logging or G4 test changed.

## 4B. Evidence (A12.3, local re-proof)

Branch `feature/core-v2-a12-service-metrics` from `main` at `763e1a8`, uncommitted, 2026-10-06, Node 24 locally. Local evidence for the
owner's security review: **not certified, not merged**.

| Step | Result |
|---|---|
| service-kit build | `npm run build -w @nawara/service-kit` exit 0; `dist/` then compared with a fresh non-incremental compile of the same source: 64/64 `.js` and 64/64 `.d.ts` byte-identical (source maps differ only in their output-relative `sources` path). Every dependent run below used that `dist/` |
| service-kit unit | 365/365 (29 files); the A12.3 files (`metrics-service.spec`, `metrics-messaging-semantics.spec`) 20/20 (before the C-1 correction below): scrape-time `collect`, a synchronous throw contained, a non-function `collect` refused; hostile and unknown values folded, queue names capped; off-by-default, one observer per source, the in-memory bus ignored; the 8 ack/nack outcomes identical in channel calls and notices with and without the observer; handler duration only when the handler ran; a second observer refused |
| service-kit integration | 120/120, 0 skipped (17 files; the management-API-gated DLQ file included), against local PostgreSQL 16 and a **disposable** RabbitMQ 3.13.7 (`rabbitmq:3.13-management-alpine`, empty, tmpfs data, no volume, `nofile` 65536, loopback ports 5673/15673, removed afterwards): the existing local broker could not finish booting (1,110 leftover test queues against a 927 file-handle limit), an environment issue, and was not modified. `metrics-messaging.int-spec` 2/2 (publish confirmed / confirm timeout / failed; consume processed, retry, dead-lettered permanent / retries exhausted / malformed; consumer up / lost / recovered; notices unchanged); `metrics-outbox.int-spec` 4/4 (equal to `nawara-check-outbox-lag` healthy / aging / retrying; a failing metrics read changes no claim, publish, stamp, attempt, backoff or notice; 15 s throttle, no query without an observer; bounded failure kind; a throwing observer contained) |
| Security negative controls | PASS: the hostile routing key, message id, type, headers, payload (organization and user id, email, token), exception text and any UUID are absent from the exposition (kit broker test, Audit and Notification e2e); `queue` and `outcome` are the only messaging labels; series bounded (queue ≤ 16, pool ≤ 8, closed outcomes and kinds) |
| auth-service | build, typecheck, lint (0 findings); unit 117/117; e2e 436/436 (41 files), including `metrics.e2e-spec` 7/7: pool gauges (`pool="main"`, max 10) and the outbox gauges from its central-audit relay |
| audit-service | build, typecheck, lint; unit 236/236; e2e 442/442 (18 files, 0 skipped), including `metrics.e2e-spec` 1/1: processed and dead-lettered deliveries counted by `audit-service.audit` only, hostile names and values absent |
| notification-service | build, typecheck, lint; unit 316/316; e2e 322/322 (15 files), including `metrics.e2e-spec` 1/1: intake deliveries by `notification.events` and a closed outcome, no destination, code, id or header |
| billing-service (compatibility) | build, typecheck, lint; unit 345/345; e2e 336/336 (17 files, its broker case included) |
| `check:repo` / `test:repo` | PASS / 64/64 |
| Lint | no new finding. Pre-existing warnings in files A12.3 does not change: service-kit `events/rabbitmq-event-bus.ts:438` (`no-useless-spread`, a line from 2026-09-23); audit `test/localization.e2e-spec.ts:3`; notification `test/event-intake-broker.e2e-spec.ts:4`, `src/intake/intent-core.ts:56`, `test/send-api.e2e-spec.ts:195`; billing `test/dispatcher-stale-retry.e2e-spec.ts:2` |

**C-1 correction (local security review, 2026-10-06).** The review found that the gauge `collect` contained only a *synchronous*
throw: TypeScript accepts a promise-returning function where `void` is expected, the wrapper dropped the returned promise, so an async
`collect` could still `set` a value after the scrape, and its rejection was never handled (a probe showed it ends the process, a
scrape-triggered crash). No caller was affected (the only `collect`, the pool metrics, is synchronous). Correction in
`metrics/metrics.ts`, type unchanged: `collect` stays synchronous and is never awaited; `set` is honoured only while the synchronous
call runs (later calls are ignored); a returned promise or any thenable gets a no-op rejection handler (a throwing `then` getter is
contained like any throw). Targeted re-proof (nothing else depends on this path): kit build, `dist/` again identical to a fresh
non-incremental compile (64/64 `.js` and `.d.ts`), typecheck, lint (only the pre-existing warning), unit 366/366 with the focused files
21/21, Auth `metrics.e2e-spec` 7/7, `check:repo` PASS. The two `collect` tests now prove the contract: a value an async `collect` sets
after its first `await` never shows, and an async rejection, a delayed one, a non-Promise thenable and a throwing `then` getter raise no
unhandled rejection; both fail against the previous wrapper. The RabbitMQ, outbox, Audit, Notification and Billing evidence above does
not use this path and was not rerun.

The A12.2 post-merge CI failure (run 37310414915, Payment `expiry-sweeper` timing) was not rerun: its one authorized rerun passed (§5).

## 4C. Evidence (A12.4.2 kit hardening, local)

Branch `feature/core-v2-a12-logging-pii` from `main` at `272ab8d`, 2026-10-06, Node 24 locally; not committed. Files:
`logging/safe-serialize.ts` (new), `logging/json-logger.ts`, `context/request-context.ts` (`runWithEventContext`, `SAFE_ID` exported),
`index.ts` (exports), `test/logging-hardening.spec.ts` (new), `test/logging.spec.ts` (the stack assertion now expects frames only).

| Step | Result |
|---|---|
| service-kit build | exit 0; `dist/` identical to a fresh non-incremental compile (65/65 `.js` and `.d.ts`; source maps differ only in their output path) |
| Focused logging tests | `logging-hardening.spec` + `logging.spec` 56/56: the 41 required negative controls (secrets nested and in arrays; normalized keys; bare `code`, `joinCode`, `invitationCode`, `totpCode` redacted; `statusCode` / `errorCode` / `providerCode` visible; PII keys; Bearer, quoted Bearer, Basic, URL credentials, secret query values, prose `password=` pairs, bare JWT, `/file/t/<token>`; throwing getter, `toJSON`, `Symbol.toStringTag` / `toPrimitive` getters, throwing and revoked Proxies; BigInt; cycles; depth, array, key and record bounds; Buffer, typed arrays, ArrayBuffer, DataView; Dates; Map; Set; Error facts without message, cause or getters; frames-only, at most 20, no message; envelope collisions incl. case variants; `droppedFields` unspoofable; CR / LF / control characters; huge strings; unbuildable record; failing `JSON.stringify`; failing sink; levels) plus `safeToken` and `runWithEventContext` |
| service-kit unit | 415/415 (30 files) |
| typecheck / lint | clean / no new finding (the one pre-existing `rabbitmq-event-bus.ts:438` warning) |
| `check:repo` | PASS |
| Static security review | three probe findings fixed in this slice (quoted Bearer, prose `password=` pairs, case-variant envelope names) and a `Symbol.toStringTag` getter read replaced by a prototype check; residual, by design: secrets or PII written as prose or JSON inside `msg` other than the patterns above are a call-site responsibility (service negative controls, A12.4.5) |

Not run in this slice: service suites (A12.4.3 rebuilds the kit and runs the affected services), integration suites, CI.

## 4D. Evidence (A12.4.3 TypeScript service adoption, local)

Branch `feature/core-v2-a12-logging-pii` on `b5bb23d`, 2026-10-06; committed as `ad15d19`. What changed:

- **Auth:** `LOG_LEVEL` read with the kit `EnvReader` (default `info`, anything outside debug / info / warn / error refused at
  startup) and used by `main.ts`. CLI failures go through `describeCliFailure`; its Core-authored operator messages are `CliRefusal`.
- **Notification:** the intake consumer restores its log context with `runWithEventContext` (it used to put the raw broker
  correlation header in every line's envelope); intake lines carry `eventId`, `eventType`, `source` as `safeToken`-validated fields.
  The correlation id stored with the notification is unchanged.
- **Billing:** the payment-event handler runs in `runWithEventContext`; `eventId`, `eventType`, `paymentRequestId` are validated fields.
  The business correlation id passed to `applyPaymentEvent` (recorded with the receipt) is unchanged.
- **CLIs:** `describeCliFailure` (kit) prints a fixed category and `describeFailure` facts, never `e.message`, in `nawara-migrate`,
  `nawara-dlq`, `nawara-check-dlq-depth`, `nawara-check-outbox-lag`, Auth's CLIs and the ownership CLI; Core-authored usage text is a
  `ConfigError` and stays readable; the category phrases keep the restore drill's classification (`infra/backup/restore-drill.sh`).
  A failed migration's `MigrationError` carries `describeFailure` facts, not PostgreSQL's message.
- **Ownership:** the structured `code` field is `errorCode`; the CLI's correlation id comes from the log context (a caller field of
  that name is dropped by the A12.4.2 envelope).
- **Kit logger:** a Nest `Logger` call `(msg, fields, contextName)` keeps both the fields and the context (it dropped the fields).

| Step | Result |
|---|---|
| service-kit | build exit 0, `dist/` identical to a fresh non-incremental compile (66/66 `.js` and `.d.ts`); unit 420/420; typecheck; lint (no new finding) |
| service-kit PostgreSQL integration (affected) | `migrations.int-spec` + `migrations-strict.int-spec` 15/15; `observability.int-spec` PostgreSQL block 6/6 (outbox-lag CLI failure prefix, migration runner). Its RabbitMQ block builds `new URL(TEST_RABBITMQ_URL)` while the file is collected, so without a broker URL the whole file errors at load (pre-existing, unchanged since `67a5ad7`); run with a placeholder URL and a `-t` filter selecting the PostgreSQL block, RabbitMQ block 2 skipped |
| Auth | build, typecheck, lint; unit 118/118 (incl. `LOG_LEVEL` default, valid levels, invalid refused); e2e 429 passed, 7 skipped |
| Notification | build, typecheck, lint; unit 316/316; `intake.e2e-spec` 42/42 incl. the two A12.4.3 tests (hostile source / event id / correlation header never echoed, `[invalid]` and `event:unknown` instead; valid ids in fields and restored context; no recipient, phone or code). Rest of e2e: `security-operations` `/ready` test environment-blocked (RabbitMQ stopped, not authorized); broker-gated suites skipped |
| Billing | build, typecheck, lint; unit 348/348 incl. `payment-event-consumer.spec` 16/16 (hostile correlation header, event id and payment request id never logged; business correlation id and event id unchanged; context restored); e2e 335 passed, 1 skipped (migration failure now facts, PostgreSQL text absent) |
| Organization | build, typecheck, lint; unit 144/144 incl. `ownership-admin.spec` (refusal logs `errorCode`, visible through `JsonLogger`); e2e 260 passed; `ownership.e2e-spec` safety-gated (it refuses a cluster that hosts the Organization database) |
| CLI failure output | `cli-failure.spec`: no message, connection string, SQL or value; Core-authored text kept; restore-drill phrases kept |
| `test:deploy` / `check:repo` | 315/315 / PASS |

A12.3 code (`events/`, `metrics/`, `db.service.ts`), `redact.ts` and ai-service are unchanged. Not run: RabbitMQ suites, CI.

## 4E. Evidence (A12.4.5 service negative controls and security review, local)

Branch `feature/core-v2-a12-logging-pii` on `f636c81`, 2026-10-06; committed as `dc0e6b4`. Method: a static review of every operational log
call site in the eight Core services (about 210, plus the kit's runtime ones), tracing each interpolated value to its source, then
behavioral controls where a service owns a sensitive boundary that no existing test proves through the production `JsonLogger`
routing. Each new control was run against the uncorrected code (or with a deliberate leak injected) and failed before it passed.

| Service | Sensitive boundary | Proof |
|---|---|---|
| Auth | passwords, TOTP secret and codes, access / refresh / challenge / enrollment tokens, WebAuthn challenge, recovery secret key, operator one-time code, join and invitation codes, forged bearer JWT and cookie, member and operator email, hostile request ids, a pool error carrying a connection string | **new** `test/logging-negative.e2e-spec.ts`: Nest-Logger lines routed through `JsonLogger` as in main.ts; none of the values in any line; lines are single-line JSON; hostile ids neither logged nor echoed. Request paths log nothing by design; the pool line is present with facts only. An injected `email=` line fails it |
| Organization | operator `--actor`, ownership CLI failures, service policy | **F-2 corrected**; `ownership-admin.spec.ts` (refusal and offline snapshot paths) and the built CLI: `verify-snapshot --actor "Jane Q. Person"` logs digest and correlation id, no name; missing / non-JSON / invalid snapshot files print a refusal or `failed (error=Error code=ENOENT)` |
| Billing | Payment's HTTP answer, broker events (A12.4.3), organization scope | **F-1 corrected**; `payment-integration.e2e-spec.ts`: a hostile rejection code is `code=[invalid]`, a valid one stays with request and correlation ids, outcome `rejected` unchanged. `organizationId` is UUID-validated before the scope log; `paymentId` is persisted to a `uuid` column before it is logged |
| Payment | provider webhooks (body, signature, card, contact) | **new** control in `webhooks.e2e-spec.ts`: a forged and a malformed signed webhook carrying card, CVC, email and a secret: the rejection is logged by provider only, nothing else appears |
| File | capability tickets and URLs, storage keys, file names and content, S3 errors | existing `upload` / `download` e2e (production routing) and `safeDetail`; no new test |
| Notification | recipient, content, OTP, provider text and codes, broker values | existing `delivery-engine` e2e (OTP, phone, provider exception text, poison values, DB password) and A12.4.3 intake; codes through `boundedCode` / `boundedDiagnostic`; no new test |
| Audit | event payload vs operational line | lines carry validated `eventId`, `action`, `source` (refusals: `safeId`); the payload stays in the audit record; no new test |
| Release | admin and automation operations | verified owner id, configured caller, closed operation / outcome / reason, store codes; no new test |

**Findings.**

- **F-1 (low, Billing, corrected):** `payment-dispatcher.ts` logged Payment's response `code` (`payment-client.ts`, from the HTTP body)
  unvalidated in `msg`. Now `safeToken` against the Core error-code form; nothing persisted or decided changes.
- **F-2 (medium, Organization, corrected):** the ownership operations logged `actor`, a person's name by schema
  (`0004_ownership_transition.sql`: "a person, or the provisioning identity"), Category B, on 15 lines. Removed from every line;
  `ownership_event` keeps it (audit evidence) with the same correlation id. Decision: the actor is **Category B**.
- **C-1 (concern):** Auth's test harness captures Nest-Logger lines with a plain logger, so the Stage 13.2 `logging.e2e-spec` checks the
  exception filter's lines only and its pool-warning case inspects no line. The new A12.4.5 test covers both through production routing.
- **C-2 (concern):** the ownership snapshot validator's refusal text quotes file values (version, ids, keys) to the operator's terminal and
  `ownership_event.detail`; not an operational log, hierarchy data (C/D), unbounded in length.
- **C-3 (concern):** `ownership approve --reference` is free operator text logged as `reference` (a rehearsal reference by contract).
- **Accepted boundary (A12.4.2):** prose PII inside `msg` is not detected by the logger; the static review found no call site that puts
  an untrusted or sensitive value into `msg`.

| Step | Result |
|---|---|
| New / changed controls | Auth `logging-negative` 1/1; Billing `payment-integration` 34/34 incl. F-1 (fails without the fix); Organization `ownership-admin.spec` 2/2 (both fail without the fix); Payment `webhooks` 9/9 |
| Affected suites | Billing build, typecheck, lint (one pre-existing warning, untouched file), unit 348/348, `dispatcher-stale-retry` e2e 6/6; Organization build, typecheck, lint, unit 145/145; Auth and Payment typecheck and lint |
| Built ownership CLI (offline, no database) | `verify-snapshot` with a person's name as actor: no name in any line; three failure paths safe |
| `check:repo` | PASS |

Not changed: service-kit, A12.3 code (metrics, labels, observers, delivery, outbox, pool), audit records, `observability.int-spec`,
ai-service. Not run: RabbitMQ suites, the safety-gated `ownership.e2e-spec`, CI. A12.4.6 is still required; A12.4 is not complete.

## 4F. Evidence (A12.4.6 final local validation)

The committed branch `dc0e6b4` (four commits on `main` at `272ab8d`: `b5bb23d`, `ad15d19`, `f636c81`, `dc0e6b4`), 2026-10-06. This is
PR-readiness validation, not Final Core Validation and not production proof.

- **Branch scope (34 files):** shared logging foundation (13 `libs/service-kit` files), TypeScript service adoption (Auth, Billing,
  Notification, Organization), security negative controls (Auth, Billing, Organization, Payment) and this document. Nothing else:
  `apps/ai-service`, `metrics/`, `events/`, `db.service.ts`, `redact.ts` and `observability.int-spec.ts` are identical to `main`; the
  only kit `db/` change is the migration failure text (facts instead of PostgreSQL's message).
- **Final static review** of every added line for passwords, tokens, authorization, cookies, JWT, TOTP, recovery, WebAuthn, email, phone,
  actor, recipient, content, payload, body, `error.message`, `JSON.stringify`, provider errors, SQL detail, connection URLs, broker
  headers and correlation ids: no reachable leak. Message text is printed only for Core-authored refusals (`ConfigError`,
  `MigrationError`, `CliRefusal`, `OwnershipError`); Billing's event `detail` is a closed union.
- **Residual concerns, accepted by the owner (not fixed):** C-1 Auth's historical logging test inspects the exception filter's lines only
  (the A12.4.5 control carries the evidence); C-2 the ownership snapshot refusal text quotes Category C/D file values to the operator's
  terminal and the audit detail, not to operational logs; C-3 `ownership approve --reference` is operator free text used as a reference
  label.
- **Boundaries:** A12.3 unchanged; A12.4.4 not applicable (the AI runtime belongs to `nawara-ia`; the scaffold's removal is a separate
  task); the `observability.int-spec` collection issue stays separate test-harness debt.

| Step | Result |
|---|---|
| service-kit | build; `dist/` identical to a fresh non-incremental compile (132 files); typecheck; lint (one pre-existing warning, untouched `events/` file); unit 420/420 |
| Services (typecheck, lint, unit; build where source changed) | Auth build, 118/118; Organization build, 145/145; Notification build, 316/316; Billing build, 348/348; Payment 105/105; File 261/261; Audit 236/236; Release 87/87. Lint warnings only in files this branch does not touch |
| Focused A12.4 controls (real PostgreSQL, no broker) | Auth `logging-negative` + `logging` 5/5; Billing `payment-integration` + `migrations` 42/42; Payment `webhooks` 9/9; Notification `intake` 42/42 |
| `check:repo` | PASS |

Not run: RabbitMQ suites (A12.4.3 and A12.4.5 evidence stands; kit source unchanged since then), the safety-gated `ownership.e2e-spec`,
Final Core Validation. A12.4 closes formally only after the pull request's CI passes and the owner merges it.

## 4G. Evidence (A12.5.1, local)

Branch `feature/core-v2-a12-prometheus` from `main` at `4e5e544`, 2026-10-06; not committed.

| Step | Result |
|---|---|
| Static Compose resolution | without the overlay: `METRICS_*` unset for all eight services (kit default off), no Prometheus. With it: all eight `true` / `0.0.0.0` / `9464`, every other environment key preserved, Prometheus only on `127.0.0.1:9090`. 9464 is published by nothing |
| `check:repo` / `test:repo` | PASS / 70 tests (6 new for the guard, each refusing a broken variant) |
| Prometheus pin | registry manifest index: `prom/prometheus:v3.13.4` is `sha256:87861b8c…e84e32e` (linux/amd64, arm64, arm/v7, ppc64le, riscv64, s390x); the pulled image's digest matches; upstream release v3.13.4 is final, and the 3.13 line is designated LTS by upstream |
| `promtool check config` | tracked configuration valid; a deliberately invalid temporary copy refused |
| A12.3 correction | `metrics-optional-providers.spec.ts` (real `NestFactory`, default `abortOnError`, `process.exit` recorded): 4/4. Against the original `install.ts` it fails (3 exits with every optional provider absent, 1 with only `DbService` absent). Required-provider failure still exits; metrics off touches nothing. Audit and Notification `main-metrics.spec.ts` (real `AppModule`, `main.ts`'s own lines): 2/2 each, and 2 exits each against the original kit |
| Focused suites | service-kit build (`dist/` identical to a fresh compile), typecheck, lint (one pre-existing warning), unit 424/424; Audit typecheck, lint, unit 238/238; Notification typecheck, lint, unit 318/318 |
| Runtime (an isolated, disposable Compose project with `.env.example` values and fresh volumes) | all eight services and Prometheus healthy; **8/8 targets UP** (scrapes of 4–9 ms); distinct `job` / `instance`. Audit and Notification answer `/health` 200 and `/ready` 200, and expose `nawara_service_info`, pool metrics and `nawara_event_consumer_up{queue}` = 1; `nawara_readiness_ready` follows the `/ready` runs |
| Negative controls | 9464 refused on the host; only `127.0.0.1:9090` listens; admin API disabled; lifecycle API 403; label names only `job`, `instance`, `check`, `kind`, `le`, `pool`, `queue`, `service` and the runtime version labels |

Not run: the broker-gated service metrics e2e suites (the runtime proof covers the real bootstrap), CI. A12.5 overall stays open
(A12.5.2–A12.5.5); A12.6 has not started.

## 4H. Evidence (A12.5.2, local)

Branch `feature/core-v2-a12-rabbitmq-metrics` from `main` at `1ad43d2` (PR #209 merged), 2026-10-06; not committed. Runtime: the
isolated, disposable Compose project of A12.5.1 (`.env.example` values), started with PostgreSQL, RabbitMQ, Audit, Notification and
Prometheus only. The other six service targets were not started; this change does not touch their runtime.

| Step | Result |
|---|---|
| Capability (throwaway container of the repository image, no network) | RabbitMQ 3.13.7; `rabbitmq_prometheus-3.13.7` bundled and enabled |
| Running broker | `rabbitmq-diagnostics environment`: `return_per_object_metrics false`, `tcp_config [{port,15692}]`; `GET rabbitmq:15692/metrics` from the Prometheus container: 200 without credentials; `/metrics/per-object` and `/metrics/detailed` exist, not scraped |
| Static | `docker-compose.yml`, the overlay and `infra/rabbitmq` unchanged; in observability mode RabbitMQ still publishes only 5672 / 15672; `promtool check config` SUCCESS; `check:repo` PASS; `test:repo` 72/72 (2 new) |
| Targets | `rabbitmq` UP (33 ms scrape); Audit and Notification UP; 9 jobs configured |
| Cardinality | 2,150 samples scraped, 267 stored after the drop; an 8th queue added none. Labels: node and cluster identity, versions, `protocol`, `queue_type` and Erlang `kind` / `type` / `table` / `usage`, with no queue, vhost, connection, channel, user or routing-key label |
| Controlled activity (test-only queues `a1252_metrics_probe` and `_2`, payload `metrics-probe`) | 3 published: `rabbitmq_queues` 6→7, `rabbitmq_queue_messages_ready` 0→3, `rabbitmq_queue_messages` 0→3, `received_total` 0→3. One fetch-and-requeue and three fetch-and-acks: `delivered_total` 4, `redelivered_total` 1, backlog 0. A manual-ack client (2 messages): `acknowledged_total` 0→2. One message held unacknowledged: `rabbitmq_queue_messages_unacked` 1, with `consumers`, `connections` and `channels` each +1; back to 0 after the ack |
| Resources | `rabbitmq_identity_info`, `rabbitmq_erlang_uptime_seconds`, `rabbitmq_process_resident_memory_bytes` / `_resident_memory_limit_bytes`, `rabbitmq_disk_space_available_bytes` / `_limit_bytes`, and the three `rabbitmq_alarms_*` gauges (0) present |
| Negative controls | host 15692 refused and not listening, no Docker host mapping; no credential in the scrape configuration; broker stopped → `up{job="rabbitmq"}` 0 and target DOWN; restarted → UP, with Audit and Notification still UP |

Not run: the full nine-target stack, CI. A12.5 overall stays open (A12.5.3–A12.5.5); A12.6 has not started.

## 5. Open

- **A15 technical debt (CI):** the Payment `expiry-sweeper` e2e test gives itself a 150 ms real-clock window
  (`apps/payment-service/test/expiry-sweeper.e2e-spec.ts:82`) and failed once on main after PR #205 (run 37310414915; the one authorized
  failed-jobs rerun passed). Recorded with the Billing audit-regex flake; not fixed here.

- `prom-client` is deprecated upstream in favour of `@prometheus-io/client` (0.16.x, first published 2026-08-21, an API-compatible
  superset). Owner decision H1: A12 keeps the validated `prom-client` 15.1.3 behind the single import module; the successor will be
  evaluated later as an isolated dependency change. The guard covers both names.
- Auth registry readiness metrics are stale in production unless something probes Auth's `/ready` (its Docker healthcheck probes
  `/auth/health`, unchanged under D5).
- A12.3–A12.10 per the A12.1 phase plan; production rollout only after the A12.1 production decision gate.

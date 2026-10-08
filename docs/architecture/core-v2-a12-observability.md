# Core V2 A12: observability foundation

- **Status:** RECORD of A12.0 discovery, the A12.1 design freeze (owner decisions D1–D8), the A12.2 kit metrics foundation, its
  local security review and the A12.2a correction (§3A), written 2026-10-05: **A12.2 MERGED** (PR #205, `763e1a8`), not certified. Then the
  A12.3 service and messaging metrics (§3B): **A12.3 FORMALLY CLOSED** (PR #206, merge `272ab8d`, post-merge Core CI 24/24). Then A12.4
  logging and PII (§3C): **architecture approved** (owner decisions W1, W2); **A12.4.2 kit hardening implemented and proven locally**
  (§4C; commit `b5bb23d`); **A12.4.3 TypeScript service adoption proven locally** (§4D; commit `ad15d19`); A12.4.4 (ai-service)
  **NOT APPLICABLE**: the AI runtime is not a Core-owned service (§3C); **A12.4.5 service negative controls and
  security review proven locally** (§4E; commit `dc0e6b4`); **A12.4.6 final local validation passed** (§4F): **A12.4 FORMALLY CLOSED** (PR
  #207, merge `6fac8fe`, post-merge Core CI green). Then A12.5: **A12.5.1 local Prometheus collection MERGED** (PR #209, `1ad43d2`; §3D, §4G;
  local only), with an A12.3 post-certification correction (§3D); **A12.5.2 RabbitMQ broker metrics MERGED** (PR #210, `77b2cc7`;
  §3E, §4H); **A12.5.3 PostgreSQL exporter MERGED** (PR #211, `331bc98`; §3F, §4I); **A12.5.4
  integrated observability and security validation MERGED** (PR #212, `879ea44`; §4J); **A12.5 FORMALLY CLOSED** for the LOCAL
  collection layer by the A12.5.5 certification (§4K). A12.6: the A12.6.0 decisions are recorded (§3G, D6a); **A12.6.1 LOCAL
  Grafana foundation and Core overview MERGED** (PR #214, merge `8d5aa7a`; §3G, §4L); **A12.6.2 operational dashboards (Core ·
  Service, Core · Messaging, Core · PostgreSQL), with the owner-approved Core · Overview outbox correction, MERGED / CLOSED** (PR #215,
  merge `e3b68dee818d05e271af90e9d787c74715edfb90`; §3H, §4M); A12.6.3: discovery (A12.6.3.0) approved, and **A12.6.3.1 alerting
  foundation (rule loading, allowlisted self-scrape, availability and Prometheus alerts)** and **A12.6.3.2 (the remaining ten
  alerts)** owner-approved locally; **A12.6.3.3 focused runtime proof COMPLETE**; **A12.6.3 CLOSED ON MAIN** (PR #216, merge
  `4ffcb0d4b5ced0174d76bcc7f8d9ce4fe0f4f120`; §3I, §4N–§4P). **A12.6.4 integrated local observability and security validation
  owner-approved locally** (§4Q); **A12.6.5 local certification COMPLETE: A12.6 LOCAL OBSERVABILITY FORMALLY CERTIFIED LOCALLY** (§4R).
  A12.6.4 and A12.6.5 are not yet on `main`: A12.6 is closed on `main` only once their pull request is merged. Production
  observability (A12.10) not started; G4 and G6 deferred, not certified; Final Core Validation not run. Metrics are **off by default**
  (`METRICS_ENABLED=false`): no service changes behaviour until a deployment sets it. Nothing here is deployed, scraped in production
  or alerted on; Prometheus, the PostgreSQL exporter and Grafana exist only in the opt-in LOCAL overlay (A12.5.1, A12.5.3, A12.6.1), and
  no Alertmanager exists (deferred, D6a). It performs and authorizes no production action.
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

Refinement D6a (A12.6.0 owner decision, 2026-10-06): **D6 is superseded and refined, not rewritten.** Alertmanager is **DEFERRED until a
concrete receiver exists**: an Alertmanager with nowhere to send adds a component and proves nothing. Until then, alert rules (later in
A12.6) are evaluated by Prometheus and read in its UI and in Grafana. The D6 row above stays as recorded in A12.1.

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

## 3F. A12.5.3 PostgreSQL exporter (local)

- **Topology.** One local PostgreSQL 16.15 server (`postgres:16-alpine`, Compose `postgres`) holding nine service databases (auth,
  billing, payment, accounting, organization, notification, file, audit, release). Each is owned by its `<svc>_migrator` and used by its
  `<svc>_app`, with PUBLIC's `CONNECT` revoked (ADR-0032), plus the optional `audit_retention`. `infra/postgres/init` creates them once,
  on an empty volume.
- **Exporter.** `prometheus-community/postgres_exporter` v0.20.1 (latest release; upstream CI-tests PostgreSQL 13–18),
  `quay.io/prometheuscommunity/postgres-exporter:v0.20.1@sha256:ac5ec343…713e`, verified against the registry manifest index (amd64,
  arm64, arm/v7, ppc64le). A single overlay service, `postgres-exporter`, with profile `db` and no published port; Prometheus job
  `postgres` → `postgres-exporter:9187`. One exporter covers the one server: it connects to the `postgres` maintenance database, whose
  server-wide views cover every database.
- **Least privilege.** `observability_monitor`: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT`, member of `pg_monitor`
  only, with no `CONNECT` on any service database. `pg_read_all_stats` gives database sizes and other sessions' activity without
  `CONNECT`, and `pg_read_all_settings` the settings. The init script creates it, idempotently, only when `MONITORING_PASSWORD` is set,
  which only the overlay passes (`docker-compose.yml` is unchanged); no application migration is involved. The password comes from
  `.env` (a placeholder in `.env.example`) as `DATA_SOURCE_PASS`, never in `prometheus.yml` or a URL.
  - The role can read other sessions' current statement text in `pg_stat_activity` (inherent to `pg_read_all_stats`). The exporter does
    not export it, and no label carries a statement.
- **Cardinality.** About 950 series, all bounded: databases, lock modes, session states, role names, fixed `application_name`, and
  settings. The per-table and per-index collectors are disabled. Tuple and cache activity are per database. No query text:
  `stat_statements` is off, and `pg_stat_statements` and query logging are not configured. Query latency and slow queries remain a
  separate PostgreSQL configuration decision.
- **Guard.** `checkLocalObservability` also refuses host publication of 9187 and requires the `postgres` job. The exporter must use
  `observability_monitor` with an interpolated `DATA_SOURCE_PASS`, with no `DATA_SOURCE_NAME` and no URL credential, and
  `docker-compose.yml` must not pass `MONITORING_PASSWORD`.

## 3G. A12.6.0 decisions and A12.6.1 Grafana foundation (local)

**A12.6.0 owner decisions (discovery approved 2026-10-06):**

| | Decision |
|---|---|
| Grafana | LOCAL only, in the opt-in overlay: the OSS image `grafana/grafana` (the `grafana-oss` repository is no longer updated upstream since 12.4.0), pinned by digest, `127.0.0.1:3100` (host 3000 is Auth) |
| Access | no anonymous access, no sign-up; the admin password comes from `.env` (`GRAFANA_ADMIN_PASSWORD`); `admin/admin` must not work |
| State | none persisted: the repository provisions the datasource, folder and dashboards on every start; runtime state is tmpfs |
| Datasource | exactly one: Prometheus, uid `nawara-prometheus`; Grafana never reads PostgreSQL, RabbitMQ or a service directly |
| Outbound | no usage reporting, update or plugin-update checks, news feed, Gravatar, feedback links, plugin preinstall or installation |
| Alertmanager | DEFERRED until a concrete receiver exists (D6a above) |
| Prometheus self-scrape | APPROVED for A12.6.3, as an allowlisted job; not in A12.6.1 |
| RabbitMQ per-queue / DLQ | DEFERRED; dashboards show the aggregate backlog, which includes dead-letter queues |
| Readiness | dashboard only: the last `/ready` result and its age; never an alert, never proof of unhealthy |
| Dashboards | query by `job` (only `nawara_service_info` carries `service`); no `or vector(0)`; no data, not applicable and zero stay distinct |

**A12.6.1 implementation:**
- **Service.** `grafana` in `docker-compose.observability.yml`:
  - `grafana/grafana:13.2.3@sha256:b28bae15…e572`, `127.0.0.1:3100:3000`; it starts after Prometheus is healthy, and its healthcheck is
    `/api/health`.
  - `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`, the image's non-root user (472); no Docker socket, no privileged mode.
  - Runtime state in tmpfs (`/var/lib/grafana`, `/tmp`), with no volume.
  - Provisioning and dashboards bind-mounted read-only from `infra/observability/grafana/`.
  - Hardening by `GF_*` environment: `GF_AUTH_ANONYMOUS_ENABLED=false`, `GF_USERS_ALLOW_SIGN_UP=false`, `GF_USERS_ALLOW_ORG_CREATE=false`;
    reporting, update checks, plugin update checks, feedback links, news and Gravatar off; `GF_PLUGINS_PREINSTALL_DISABLED=true`,
    `GF_PLUGINS_PREINSTALL_AUTO_UPDATE=false`, `GF_PLUGINS_PLUGIN_ADMIN_ENABLED=false`, `GF_PLUGINS_PUBLIC_KEY_RETRIEVAL_DISABLED=true`.
  - `GF_SECURITY_ADMIN_PASSWORD` interpolated from `GRAFANA_ADMIN_PASSWORD` (a non-secret local placeholder in `.env.example`; Compose
    refuses to start without it).
- **Provisioning.**
  - `provisioning/datasources/prometheus.yml`: one datasource, uid `nawara-prometheus`, `http://prometheus:9090`, proxy, no credential,
    not editable.
  - `provisioning/dashboards/nawara-core.yml`: one file provider, folder "Nawara Core" (uid `nawara-core`), `allowUiUpdates: false`,
    `disableDeletion: true`.
- **Dashboard.** `dashboards/nawara-core/core-overview.json`, "Core · Overview", uid `nawara-core-overview`. Deterministic JSON: no
  numeric id, version or timestamp; every panel names the datasource by uid. Rows:
  - **targets:** `up` for the eight Core jobs, `rabbitmq` and `postgres` (the exporter) separately, plus `pg_up`; scrape duration and
    samples per job;
  - **readiness (dashboard only):** the last `nawara_readiness_ready` and the age of the last run. Before the first `/ready` run the kit
    exports `nawara_readiness_ready 0` with `nawara_readiness_last_run_timestamp_seconds 0` (found in the §4L proof). Both panels
    therefore keep only series whose last-run timestamp is above 0. A service whose `/ready` never ran is not listed ("not run" when
    none has), and never reads as NOT READY. The guard requires this filter in every readiness query.
    The kit behaviour itself is unchanged.

  - **HTTP:** request rate by `job`, and the 5xx ratio. The ratio is shown only at 1 request per minute or more over 5 minutes, so it
    is blank below that, never 0. A real 0 means traffic with no 5xx.
  - **database pools:** waiting clients, and utilisation (connections / max);
  - **messaging and outbox:** `nawara_event_consumer_up` per queue; outbox oldest pending age, pending and retrying;
  - **RabbitMQ:** target up; aggregate ready and unacknowledged backlog (all queues, dead-letter queues included);
  - **PostgreSQL:** `pg_up`; connections (`numbackends`) against `max_connections`.
  - Services without a pool, consumer or outbox have no series: the panel shows nothing for them (not applicable), never 0.
- **Guard.** `checkLocalGrafana` (`npm run check:repo`) enforces all of the following:
  - the pinned OSS image, exactly `127.0.0.1:3100:3000`, read-only, no capabilities, `no-new-privileges`, no user override;
  - read-only repository mounts only; `/var/lib/grafana` in tmpfs;
  - every required `GF_*` value; no plugin installation variable and no external database, cache, SMTP or alerting setting;
  - an interpolated admin password, and a `.env.example` placeholder that is neither empty nor `admin`;
  - exactly one credential-free Prometheus datasource by uid; the one locked file provider;
  - dashboards with a unique fixed uid, no volatile keys, the datasource by uid only, no `or vector(`, no `service` selection
    outside `nawara_service_info`, and the last-run `> 0` filter in every readiness query.
  - `test:repo`: 83 tests, 8 for Grafana.
- **Not in A12.6.1:** other dashboards (A12.6.2), alert or recording rules and rule files, Prometheus self-scrape (A12.6.3),
  Alertmanager (deferred), any production Grafana (A12.10).

## 3H. A12.6.2 operational dashboards (local)

Three dashboards beside the overview, from the A12.5-certified metrics only: no new metric, exporter, scrape job, datasource, folder,
plugin or provisioning change; no kit or service change. Core · Overview is unchanged. They sit in the existing "Nawara Core" folder,
loaded by the A12.6.1 file provider, as deterministic JSON (`infra/observability/grafana/dashboards/nawara-core/`):

| Dashboard | uid | Variable | Answers |
|---|---|---|---|
| Core · Service | `nawara-core-service` | `job`: `label_values(nawara_service_info{job=~"<the 8 Core jobs>"}, job)` | is this service up and ready, its traffic, errors and latency, pool pressure, outbox, messaging and runtime |
| Core · Messaging | `nawara-core-messaging` | `queue`: `label_values(nawara_event_consumer_up{job=~"<the 8 Core jobs>"}, queue)` | are consumers attached, what consumers decided (incl. parked messages), publishing, and the broker's aggregate state |
| Core · PostgreSQL | `nawara-core-postgresql` | `datname`: `label_values(pg_database_size_bytes{job="postgres",datname=~"<9 service databases>\|postgres"}, datname)` | availability, connection capacity, sessions, transactions, locks and waits, deadlocks, size, tuples, cache, key settings |

- **One reusable dashboard per subject.** The service dashboard is selected by the scrape `job`, the authoritative Core identity
  (only `nawara_service_info` carries `service`). No metric gains a label; no dashboard is duplicated per service.
- **Bounded variables.** Each is a single-valued query variable (no multi-value, "All", custom or free text) read from a bounded
  source: the eight Core jobs (never `rabbitmq`, `postgres`, Prometheus or Grafana), the consumer queues the kit registers (at most 16 per
  process), and an explicit list of databases. Panels use them only as exact matches (`job="$job"`, `queue="$queue"`,
  `datname="$datname"`), never as a regular expression. The `postgres` maintenance database is offered: it holds the exporter's and any
  administrative sessions, which use connection capacity. Template databases are excluded.
- **No-data semantics.** No `or vector(0)`. Each empty state names itself (`noValue`):
  - *not applicable*: the series does not exist for this service. No outbox on audit-service and notification-service; no consumer
    except billing, notification and audit; no pool;
  - *not run*: readiness before the first `/ready` (the A12.6.1 `last_run > 0` filter, kept on every readiness query);
  - *not read yet*: the outbox gauges are shown only once the relay has read the aggregate (`nawara_outbox_stats_timestamp_seconds > 0`).
    Before that the kit exports 0, which is not a real zero. A separate stats-age panel makes a stale reading visible;
  - *none observed*: a labelled counter (a consume or publish outcome, a loss, a pool or relay failure) exists only once it first
    happened. These rare events are shown as the counter **since process start** (exact, beside an uptime panel), because `rate()` and
    `increase()` cannot see a series' first increment;
  - *zero* is shown only where it is real: a gauge or exporter series that exists, or a ratio over actual traffic.
    - The 5xx ratio needs at least 1 request per minute; the rollback ratio needs at least 1 transaction per minute; the cache-hit
      ratio needs a block access. Below that they are blank.
    - "Sessions waiting on a lock" is `… or (0 * <the sessions observed>)`: 0 only when sessions were observed and none waits.
- **Latency.** p95 / p99 by `histogram_quantile` over the existing buckets (HTTP and handler 5 ms … 60 s, publish 1 ms … 10 s), shown
  only when the window had observations, and labelled as estimates: precise to the bucket bounds only.
- **Application vs broker dead-lettering.** The application dead-letter outcome (`nawara_events_consumed_total{outcome=~"dead_lettered_*|
  dead_letter_unannotated"}`) is the permanent "parked in `<queue>.dead`" signal. `dead_letter_deferred` (copy not confirmed, requeued) is
  shown apart. Broker counters (`rabbitmq_global_messages_dead_lettered_*_total`) are a separate panel titled "dead-letter mechanics (not
  parked messages)": `expired` rises with every retry, because a `<queue>.retry` message whose TTL ends is dead-lettered back into its
  main queue. Core's annotated dead-letter copies are republished, not broker-dead-lettered, so they do not appear there. No panel
  mixes broker and application metrics, and none is called "DLQ".
- **Aggregate backlog.** Broker ready, unacknowledged and total messages are labelled "aggregate broker backlog (all queues, incl. retry
  and dead-letter)": parked messages stay in it. Per-queue / DLQ depth remains deferred; the broker's aggregated endpoint only (no
  detailed or per-object metrics, no queue or vhost label).
- **PostgreSQL limits.** Not shown, and named in a text panel: statements, query latency or text (`pg_stat_statements` not installed),
  blocker → waiter pairs, per-table / per-index activity (collectors off), and block I/O timing (`track_io_timing` off). Settings are a
  short list (capacity, memory, timeouts, `track_io_timing`), not a dump.
- **Guard** (`checkLocalGrafana` → `checkDashboardSemantics`, `npm run check:repo`). It requires the four dashboards with their fixed
  uids and titles, and, for every dashboard:
  - `editable: false`; no link, URL, Grafana.com id, SQL or credential-like key; panel types `row`, `stat`, `timeseries` and `text` only;
    unique panel ids;
  - variables: only the expected one per dashboard, single-valued, a `label_values()` over its own metric bounded by literal
    alternations (the eight Core jobs; databases without templates), used only as an exact match;
  - on the Service dashboard, every series selects `job="$job"`; on the other operational dashboards, every Core metric is bounded to
    the Core jobs;
  - broker metrics select `job="rabbitmq"`, never a detailed metric or a per-object label, and never sit in a panel with application
    metrics; a broker dead-letter panel says "mechanics" and never "DLQ"; a broker queue-total panel says "aggregate";
  - PostgreSQL metrics select `job="postgres"`, and no expression uses statements, query text, per-table / per-index or I/O-timing data;
  - the A12.6.1 rules (datasource by uid, no `or vector(`, readiness `last_run > 0`, `job` not `service`) apply to all four, and so
    does the outbox rule: an expression that reads `nawara_outbox_pending_events`, `_retrying_events` or `_oldest_pending_age_seconds`
    must carry `and on (job, instance) (nawara_outbox_stats_timestamp_seconds{…} > 0)`.

  The A12.6.1 Grafana test fixture now carries all four dashboards (the new missing-dashboard rule needs them); its assertions are
  unchanged. `test:repo`: 91 tests (8 new for A12.6.2).
- **Not in A12.6.2:** alert or recording rules, Prometheus self-scrape (A12.6.3), Alertmanager (deferred), per-queue / DLQ broker
  metrics (deferred), any production Grafana (A12.10).

**Dashboard gaps (A12.6), recorded, not fixed: A12.5 stays closed and no metric changed.**

| Operator question | Missing | Why the existing metrics are not enough | Recommendation |
|---|---|---|---|
| How many messages are parked in a given `<queue>.dead` now? | per-queue broker depth | the broker endpoint is aggregate by decision; the application counts parking events, not current depth | the deferred per-queue / DLQ decision; until then `nawara-check-dlq` |
| How often did an outcome first occur in this window? | pre-initialised outcome series | prom-client creates a labelled series at its first increment, which `rate()` / `increase()` cannot see | **owner decision: DEFERRED.** Known telemetry / dashboard gap; mitigated by since-start counts. No kit change; A12.3 and A12.5 are not reopened |
| Is Prometheus itself healthy (rule evaluation, TSDB, scrape load)? | Prometheus self-metrics | not scraped | A12.6.3 (approved allowlisted self-scrape) |

**Core · Overview outbox initialisation: owner-approved correction, resolved locally.** The A12.6.2 review found that the overview's
two outbox panels read `nawara_outbox_pending_events`, `_retrying_events` and `_oldest_pending_age_seconds` without the stats-timestamp
filter. Those gauges are unlabelled and the kit exports 0 until the relay's first successful aggregate read, so a service whose read had
not yet succeeded (for example, the database unreachable from start) showed 0 pending and age 0 instead of no data. The owner decided to
fix it now. Each of the three queries gained `and on (job, instance) (nawara_outbox_stats_timestamp_seconds{job=~"<Core jobs>"} > 0)`,
the filter Core · Service already uses: timestamp 0 (never read) → no series (no data); timestamp > 0 → the gauge as is, so 0 is a real
zero. Nothing else in the overview changed (its two outbox descriptions say so). No kit change was required; A12.5 stays closed. The
guard now refuses an outbox gauge without the filter on any dashboard (§4M, correction).

**Other owner decisions (A12.6.2 review):** pre-creating outcome series is **DEFERRED** (gap table above); the PostgreSQL `datname`
selector is **APPROVED as implemented**: the nine service databases plus `postgres` (its exporter and administrative sessions use the
same server's connection capacity), `template0` / `template1` excluded.

## 3I. A12.6.3 alerting foundation (local)

**A12.6.3.0 owner decisions (discovery approved 2026-10-07):** Prometheus is the alert-rule authority. The self-scrape is narrowly
allowlisted. Alertmanager stays DEFERRED (D6a): no `alerting:` block, and alerts are read in the Prometheus UI (`127.0.0.1:9090/alerts`)
(Grafana's read-only view of the Prometheus rules was not exercised by A12.6.3, which ran without Grafana; A12.6.4 checked it: §4Q). Readiness stays dashboard only, with no alert. RabbitMQ per-queue / DLQ depth, outcome-series
pre-creation and a SettleFailures alert are deferred. Grafana configuration is unchanged (no Grafana-managed alerting). Thresholds and
`for` durations are LOCAL validation values; production thresholds and receivers are A12.10.

**A12.6.3.1 implementation:**
- **Rule loading.** Prometheus loads `rule_files: [/etc/prometheus/rules/*.rules.yml]` at the existing global 30 s evaluation interval
  (no per-group interval).
  - The rules live in `infra/observability/prometheus/rules/nawara-core.rules.yml`, mounted read-only
    (`./infra/observability/prometheus/rules:/etc/prometheus/rules:ro`).
  - Their promtool tests live in `infra/observability/prometheus/tests/nawara-core.rules.test.yml`, which is never mounted.
- **Self-scrape.** Job `prometheus` scrapes `localhost:9090` inside its own container, so no new port is published. One
  `metric_relabel_configs` keep rule retains exactly eight families (names verified against the v3.13.4 source):
  - `prometheus_config_last_reload_successful`, `prometheus_config_last_reload_success_timestamp_seconds`;
  - `prometheus_rule_evaluation_failures_total`, `prometheus_rule_group_last_evaluation_timestamp_seconds`,
    `prometheus_rule_group_iterations_missed_total`;
  - `process_start_time_seconds`, `process_resident_memory_bytes`, `prometheus_tsdb_head_series`.

  Prometheus still writes `up` and the `scrape_*` series for the job. The only label beyond `job` / `instance` is `rule_group`
  (`<rule file>;<group>`): a container path plus a group name, bounded by the repository's groups. There is no URL, query, credential or
  user data. Go runtime, HTTP handler, service discovery, notification and other TSDB families are dropped. Expected size: 5 single
  series, 3 per rule group (3 groups now), plus 5 scrape series, about 19 in total.
- **Alerts (A12.6.3.1).** Labels: `severity` plus the series' own `job`, `instance` and `rule_group`. Annotations: static text with only
  those labels and `$value`.

| Alert | Group | Expression | for | Severity | Meaning |
|---|---|---|---|---|---|
| CoreServiceDown | core-services | `up{job=~"<the 8 Core jobs>"} == 0` | 2m | critical | a Core service cannot be scraped (static targets: a stopped container is `up` 0, never absent) |
| RabbitMQDown | infrastructure | `up{job="rabbitmq"} == 0` | 2m | critical | the broker's metrics endpoint does not answer |
| PostgreSQLDown | infrastructure | `pg_up{job="postgres"} == 0` | 2m | critical | the exporter answers but cannot reach PostgreSQL |
| PostgresExporterDown | infrastructure | `up{job="postgres"} == 0` | 5m | warning | monitoring is blind; `pg_up` disappears, so PostgreSQLDown cannot fire for this |
| PrometheusRuleFailures | prometheus | `increase(prometheus_rule_evaluation_failures_total{job="prometheus"}[10m]) > 0` | — | warning | a rule group failed to evaluate in the last 10 minutes (the counter starts at 0 when a group loads) |
| PrometheusConfigReloadFailed | prometheus | `prometheus_config_last_reload_successful{job="prometheus"} == 0` | — | warning | a reload (SIGHUP locally) failed; the previous configuration stays in force |

- **Validation.** `scripts/check-prometheus-rules.sh` runs `promtool check config`, `check rules` (lint fatal) and `test rules`. It uses
  the Prometheus image already pinned in `docker-compose.observability.yml` (no new dependency) with `--network none`, a read-only root
  and read-only mounts. Core CI runs it as a step of the existing `repository checks` job: no new job, and `core-ci-passed` is unchanged.
- **Guard** (`checkLocalObservability`, extended; `checkAlertRules`):
  - Prometheus configuration: no `alerting` block or Alertmanager; `rule_files` exactly the rules glob; exactly one `prometheus` job, on
    `localhost:9090`, keeping exactly the eight families with one keep rule; no other job scraping Prometheus.
  - Mounts: the rules directory mounted read-only exactly once; the tests directory never; every Prometheus bind mount read-only.
  - Rule shape: alert rules only, with unique names and no per-group interval; `severity` (critical | warning) is the only static label;
    annotations are `summary` / `description` with no URL, using only approved labels and `$value`.
  - Rule expressions:
    - no `or vector(`, no readiness metric, no detailed broker metric, no `label_replace` / `label_join`;
    - every series bounded to its job: `up` and `nawara_*` to the exact Core job list or `rabbitmq` / `postgres` / `prometheus`;
      `pg_*` to postgres, `rabbitmq_*` to rabbitmq, `prometheus_*` to prometheus;
    - matchers and groupings only on approved labels;
    - outbox gauges only behind the A12.6.2 stats filter.
  - Tests: they load exactly the rule file; every alert has a test where it fires and one where it does not; no test names an unknown
    alert.
  - `test:repo`: 98 tests (7 new for A12.6.3).
- **Deferred to A12.6.3.2** (implemented there; see below): ConsumerDetached, MessagesDeadLettered, OutboxBacklogAging,
  OutboxStatsStale, DbPoolWaiting, HttpServerErrorRatio, BrokerResourceAlarm, PgConnectionPressure, PgDeadlocks, PgLockWaits. These are
  **ten** alerts (the discovery's phase plan said "11"; the catalog has ten).
- **Not in A12.6.3:** Alertmanager and receivers, readiness alerts, SettleFailures, per-queue / DLQ alerts, Grafana-managed alerts, a
  PrometheusSelfScrapeDown alert (rejected: a down Prometheus evaluates nothing), production thresholds (A12.10).

**A12.6.3.2 implementation: the remaining ten alerts.** The same file, now four groups (`core-services`, `core-messaging`,
`infrastructure`, `prometheus`), 16 alerts, the global 30 s interval. Labels: `severity` plus `job`, `instance` and, where the operator
needs it, `queue`, `pool`, `datname` or `alarm`. Every rule aggregates other labels away: `outcome`, `route`, `method`, `status_class`,
`usename`, `application_name`, `wait_event`, `mode`, `state`, `datid` and the broker's `protocol` / `queue_type` /
`dead_letter_strategy` never reach an alert. `<C>` below is the exact list of the eight Core jobs. **All thresholds are LOCAL validation
values; production tuning is A12.10.**

| Alert | Group | Expression (concept) | for | Severity | Labels |
|---|---|---|---|---|---|
| ConsumerDetached | core-messaging | `nawara_event_consumer_up{job=~"<C>"} == 0` | 2m | critical | job, instance, queue |
| MessagesDeadLettered | core-messaging | increase of the four dead-letter outcomes over 10m `> 0`, **or** a dead-letter series that exists now but not 10m ago | — | warning | job, instance, queue |
| OutboxBacklogAging | core-messaging | `oldest_pending_age_seconds > 60 and on (job, instance) (stats_timestamp_seconds > 0)` | 5m | warning | job, instance |
| OutboxStatsStale | core-messaging | `time() - (stats_timestamp > 0) > 120`, **or** `stats_timestamp == 0` with the process older than 300 s | 2m | warning | job, instance |
| DbPoolWaiting | core-services | `nawara_db_pool_waiting_clients{job=~"<C>"} > 0` | 3m | warning | job, instance, pool |
| HttpServerErrorRatio | core-services | 5xx / non-aborted requests over 5m `> 0.05` **and** `increase(5xx[5m]) >= 3`, per job | 3m | warning | job |
| BrokerResourceAlarm | infrastructure | `label_replace(` the three `rabbitmq_alarms_*` families, `"alarm"`, …`) == 1` | 1m | critical | job, instance, alarm |
| PgConnectionPressure | infrastructure | `sum(numbackends) / (max_connections − superuser_reserved_connections) > 0.8` | 5m | warning | job, instance |
| PgDeadlocks | infrastructure | `sum by (…, datname) (increase(pg_stat_database_deadlocks{datname!~"template0\|template1"}[10m])) > 0` | — | warning | job, instance, datname |
| PgLockWaits | infrastructure | `sum by (…, datname) (pg_stat_activity_count{wait_event_type="Lock", datname!~template}) >= 1` | 5m | warning | job, instance, datname |

- **Applicability by existence.** No rule manufactures a series. A service without a consumer, pool or outbox has no series, so its
  rule cannot fire.
- **Outbox initialisation** (the A12.6.2 rule). OutboxBacklogAging reads the age only where the stats timestamp is above 0: an
  uninitialised 0 never alerts. OutboxStatsStale covers both ways the figures can be wrong:
  - *stale*: read before, then not for over 2 minutes;
  - *never read*: still 0 five minutes after the process started, for example the database unreachable from start. This is the case
    the overview correction was about; no other alert sees it.
  The 60 s age threshold is `nawara-check-outbox-lag`'s own "needs manual review" age.
- **MessagesDeadLettered.** `outcome` is folded away (the action, inspecting `<queue>.dead`, is the same); `dead_letter_deferred`,
  `processed` and `retry_scheduled` never fire it.
  - Branch A, `increase(…[10m])`, sees later increments, and a restart followed by a new dead letter (counter reset).
  - Branch B, `… unless … offset 10m`, sees the FIRST dead letter of a series. prom-client creates a labelled series at its first
    increment, which `increase()` cannot see.
  - **Residual limits, documented and tested:** (1) a restarted process whose count equals its predecessor's within the window
    (1 → 1) is not seen; (2) a series older than Prometheus' own history (a fresh Prometheus) fires once as new. The dashboards'
    since-start counts stay the reference. No kit change, no pre-created series (deferred).
- **HttpServerErrorRatio.** 4xx and client-aborted requests are not errors; aborted requests are left out of the denominator too. The
  absolute floor of at least 3 5xx answers in 5 minutes stops a single 5xx at low traffic from firing. The `for` window is 3 minutes.
- **BrokerResourceAlarm.** The one reviewed `label_replace`, over exactly `memory_used_watermark`, `free_disk_space_watermark` and
  `file_descriptor_limit`: aggregate families with no object label. The guard accepts only this exact form; `label_replace` stays
  forbidden everywhere else.
- **PostgreSQL.** Server-level connection pressure counts only the non-reserved slots. PgDeadlocks uses `increase`, so a statistics
  reset never fires. PgLockWaits counts sessions **waiting** at every evaluation for 5 minutes, which is sustained contention: lock
  counts alone never fire it, and blocker → waiter pairs are not collected. Template databases are excluded.
- **Guard additions** (`checkAlertRules`):
  - the exact catalog (`ALERT_CATALOG`, four groups, 16 alerts); deferred and rejected names refused (SettleFailures, readiness,
    self-scrape, DLQ / depth, broker backlog, long transactions, TSDB, Alertmanager);
  - approved labels `job`, `instance`, `queue`, `pool`, `datname`, `alarm`, `rule_group`;
  - selection-only matchers: `outcome=~` the four dead-letter outcomes, `status_class="5xx"` / `!="aborted"`,
    `wait_event_type="Lock"`;
  - no bare `{…}` selector, and no `label_replace` except BrokerResourceAlarm's exact form;
  - HttpServerErrorRatio has both its ratio and its absolute floor; PgLockWaits counts waiting sessions, never `pg_locks_count`;
  - no uncollected PostgreSQL data.

  `test:repo`: 104 tests (6 new for A12.6.3.2, and the A12.6.3.1 inventory assertion now checks the full catalog).
- **Deferred (unchanged):** SettleFailures, Alertmanager, readiness alerts, PrometheusSelfScrapeDown (rejected), RabbitMQ per-queue
  metrics, DLQ-depth and generic broker backlog alerts, outcome-series pre-creation, a long-running-transaction alert, TSDB failure
  alerts, production thresholds and receivers (A12.10), Grafana-managed alerting.

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

## 4I. Evidence (A12.5.3, local)

Branch `feature/core-v2-a12-postgres-metrics` from `main` at `77b2cc7` (PR #210 merged), 2026-10-06; not committed. Runtime: a fresh,
isolated, disposable Compose project (`.env.example` values, new volumes, so the init script ran) with PostgreSQL, the exporter and
Prometheus only.

| Step | Result |
|---|---|
| Static | normal mode: no `MONITORING_PASSWORD` for PostgreSQL, no exporter. Overlay: exporter as `observability_monitor`, password interpolated, 0 published ports. 9464 / 15692 / 9187 published by nothing; `docker-compose.yml` unchanged; `promtool check config` SUCCESS; `check:repo` PASS; `test:repo` 75/75 (3 new) |
| Role | init logged "observability monitoring role created"; super, createdb, createrole, replication and bypassrls all false; member of `pg_monitor` only; owns no database; CONNECT only on `postgres` and the templates |
| Negative controls (as the role) | 23 of 23 denied: CREATE DATABASE, ROLE and SCHEMA; CREATE TABLE in public; ALTER another role; GRANT itself `pg_write_all_data`; SET ROLE postgres; INSERT, UPDATE, DELETE, TRUNCATE, ALTER, DROP and even SELECT on an admin-owned probe table; CONNECT to each of the nine service databases |
| Allowed reads | `pg_stat_activity` (all sessions), `pg_stat_database`, `pg_database_size` of a database it cannot connect to, `pg_locks`, superuser-only settings |
| Target | `postgres` UP (28 ms scrape); 13 collectors succeed; the three per-table / per-index collectors off; 10 jobs configured (the other nine targets not started here) |
| Cardinality | 954 samples scraped and stored; labels `datname` (12), `mode` (9), `state` (6), role names, `application_name`, `server`; no `query` label, no statement text in any label |
| Controlled activity (admin, probe table in `postgres`) | a held row lock with a blocked second session: `pg_locks_count{mode="rowexclusivelock"}` 4, `pg_stat_activity_count{wait_event_type="Lock"}` 1. A deliberate deadlock ("deadlock detected"): `pg_stat_database_deadlocks` 0→1, `xact_rollback` 14→15; `xact_commit`, `tup_updated`, `blks_hit` / `blks_read`, `pg_database_size_bytes`, `numbackends`, `pg_settings_max_connections` present |
| Failure visibility | PostgreSQL stopped: exporter target UP, `pg_up` 0, then 1 after restart. Exporter stopped: `up{job="postgres"}` 0, then 1 after restart |
| Container | user `nobody`, read-only root filesystem, not privileged, `cap_drop [ALL]`, `no-new-privileges`, no port binding, no mount; host 9187 refused |

Not run: the eight services and RabbitMQ (unchanged by this step; their jobs remain configured), CI. A12.5 overall stays open (A12.5.4,
A12.5.5); A12.6 has not started.

## 4J. Evidence (A12.5.4 integrated validation, local)

Branch `feature/core-v2-a12-observability-validation` from `main` at `331bc98` (PR #211 merged), 2026-10-06; evidence only, not
committed. Runtime: one fresh, isolated, disposable Compose project (`.env.example` values, new volumes, so the full bootstrap ran,
including `observability_monitor`), with all eight services, RabbitMQ, PostgreSQL, postgres-exporter and Prometheus together.

| Step | Result |
|---|---|
| Static target model | 10 jobs: 8 × `<service>:9464` (application telemetry), `rabbitmq:15692` (broker, the VM-family drop only), `postgres-exporter:9187` (PostgreSQL); no credentials, remote write or rule files |
| Normal mode (resolved) | no Prometheus or exporter; Core `METRICS_ENABLED` unset ×8; no service receives the monitoring password; 9464 / 15692 / 9187 published by nothing; the RabbitMQ definition and the PostgreSQL image / volumes identical to observability mode. A role created on a volume initialised in observability mode persists as database state, not as configuration |
| Observability mode (resolved) | adds exactly `prometheus` and `postgres-exporter`; Core `METRICS_ENABLED=true` ×8; only `postgres` and `postgres-exporter` receive `MONITORING_PASSWORD` |
| Bootstrap | 11 init steps including "observability monitoring role created"; every service's migrations applied |
| **Targets** | **10/10 UP simultaneously** (scrapes of 4–67 ms) |
| Core | `nawara_service_info`, readiness, HTTP and pool ×8; outbox ×6 (Audit and Notification have none); consumers ×3 (Audit, Billing, Notification) |
| RabbitMQ / PostgreSQL | identity, 3 connections, channels and consumers, 9 queues, backlog, activity, alarms, disk; `pg_up`, sessions, commits, locks, deadlocks, sizes, tuples, cache |
| Cross-layer: messaging | 2 synthetic envelopes from source `a1254-probe` to Notification's intake: application `nawara_events_consumed_total{outcome="dead_lettered_permanent"}` 2; broker `received` / `routed` 0→4 (including the 2 dead-letter republishes), `delivered` / `acknowledged` 0→2; the parked DLQ messages show in the aggregate `ready` backlog (2). The two layers are complementary signals of the same activity, not exact event accounting |
| Cross-layer: database | 10 DB-backed `/ready` calls to Billing: `pg_stat_database_xact_commit{datname="billing"}` 282→363, `tup_returned` up; application `nawara_readiness_ready` 0→1, pool metrics present. Complementary signals, not exact query accounting |
| Host exposure | 9464, 15692 and 9187 not listening on the host (connection refused); 9090 on `127.0.0.1` only. Published: the unchanged application ports, RabbitMQ 5672 / 15672 and Prometheus `127.0.0.1:9090` |
| Prometheus | admin API disabled; lifecycle 403; remote-write receiver 404; runtime flags admin / lifecycle / receiver false, retention 3d / 1GiB; no container privileged, no `docker.sock` |
| Secrets | the monitoring password is in no exporter log line, not in Prometheus's loaded configuration, and not in any stored label value; it is held only by `postgres` and `postgres-exporter`; no RabbitMQ or auth credential in Prometheus |
| Labels / PII | 1,837 stored series. Label names per job match the approved designs. No email, UUID, JWT, bearer token, URL, SQL or probe payload in any label value. The exporter's own `code` / `tags` / `branch` / `revision` are its handler status and build info |
| Cardinality | Core 71–88 series per service; RabbitMQ 2,144 samples scraped / 261 stored, no VM-internal series; PostgreSQL 954, no per-table or per-index series, `pg_settings` kept. Local figures, not production sizing |
| Failures | a Core service stopped: only its `up` 0 (9/10), then 10/10. RabbitMQ stopped: `up` 0 and `nawara_event_consumer_up` 0 ×3 (3 losses), Core targets UP; after restart `up` 1, consumers 1 ×3 (3 recoveries). PostgreSQL stopped: `pg_up` 0 with the exporter target UP, Billing `/ready` 503 `database, migrations`; after restart `pg_up` 1, ready 200. Exporter stopped: `up{job="postgres"}` 0, PostgreSQL healthy, Billing ready |
| Non-invasive | Prometheus stopped: all 8 services 200 on their health / readiness routes, every container healthy, each `/metrics` still served inside the network, broker running; 10/10 after restart. **Conclusion: a monitoring-layer failure did not become a platform or application failure** |
| Monitoring role | all attributes false except `inherit`; member of `pg_monitor` only; owns no database, schema or table; no CONNECT on service databases. Init script, overlay and scrape config identical to the reviewed A12.5.3 commit |
| Repository | `check:repo` PASS; `test:repo` 75/75; `promtool check config` SUCCESS; `sh -n` init OK; both Compose modes resolve. No guard needed changing |

Accepted observations (owner, not A12.5.4 defects):
- The aggregate RabbitMQ backlog includes dead-lettered messages. Per-queue and DLQ-specific backlog visibility is not enabled; it is an
  A12.6 cardinality and dashboard decision.
- Prometheus does not scrape itself. Whether its self-observability is useful is decided in A12.6, with the dashboard and alert design.

Not run: the earlier A12.3 / A12.4 / A12.5.x campaigns, CI. A12.5 overall stays open: A12.5.5 is the local certification. A12.6 has not
started.

## 4K. A12.5 local certification (A12.5.5)

**Certified 2026-10-06 on merged `main` at `879ea44` (PR #212). A12.5 is FORMALLY CLOSED for the LOCAL collection layer.** This
certification evaluates the merged evidence of A12.5.1–A12.5.4 (§4G–§4J). No runtime was rerun.
- Since the A12.5.4 integrated proof (`331bc98`), `main` changed only `core-v2-a12-observability.md` and `local-observability.md`.
- Every configuration, infrastructure, application, service-kit, guard and workflow file is identical to what was proven.

**Certified architecture (local):** Prometheus (opt-in, `127.0.0.1:9090`) scrapes the eight Core services (`:9464`), RabbitMQ (aggregate
metrics, `:15692`) and `postgres-exporter` (`:9187`) for the one PostgreSQL server. All three are internal to the Compose network.
Normal mode keeps observability off by default.

**Local collection certified ≠ production monitoring certified.** This closes A12.5 only. It does not close A12, and it does not certify
production observability, G4, G6 or Final Core Validation.

**Certifies:** opt-in local Prometheus collection; the eight Core scrape targets; RabbitMQ broker and PostgreSQL exporter collection;
local exposure and network boundaries; credential handling; metric and label safety; the cardinality decisions; failure visibility;
collector non-invasiveness; normal-versus-observability separation; the local runbook (`docs/runbooks/local-observability.md`).

**Does not certify:** Grafana, dashboards, alerts or Alertmanager (A12.6); production observability, credentials, monitoring role,
network topology, retention or capacity (A12.10); host and container metrics; backup observability; query latency and slow-query
analysis; per-queue RabbitMQ visibility; any SLO; G4; G6; Final Core Validation.

| Requirement | Evidence | Merged artifact | Result | Residual / deferred |
|---|---|---|---|---|
| Opt-in observability; metrics off in normal mode | §3D, §4G, §4J | `docker-compose.observability.yml`; base file sets no `METRICS_ENABLED` (guard) | PASS | — |
| Prometheus pinned, local retention, loopback only | §3D, §4G, §4J | `prom/prometheus:v3.13.4@sha256:87861b8c…`, 3d / 1GB, `127.0.0.1:9090` | PASS | production retention: A12.10 |
| Eight Core targets | §4G (8/8), §4J (10/10) | `prometheus.yml`, jobs ×8 on `:9464` | PASS | — |
| Core identity, HTTP, readiness, pool, messaging / outbox | §3B, §4G, §4J | service-kit metrics (A12.2 / A12.3, with the §3D correction) | PASS | — |
| Core bounded labels | §3A, §4G, §4J | closed label policy | PASS | — |
| RabbitMQ availability, connections, channels, queues and backlog, consumers, activity, redelivery, memory, disk, alarms | §3E, §4H, §4J | job `rabbitmq` → `rabbitmq:15692` | PASS | per-queue / DLQ: A12.6 |
| RabbitMQ aggregate cardinality, internal endpoint | §3E, §4H, §4J | aggregate `/metrics`, the exact VM-family drop, 15692 unpublished (guard) | PASS | — |
| PostgreSQL `pg_up`, sessions, transactions, locks and waits, deadlocks, size, tuples, cache | §3F, §4I, §4J | job `postgres` → `postgres-exporter:9187` | PASS | query latency, blocker graph: later |
| Least-privilege monitoring role | §3F, §4I (23/23 denied), §4J | init: `observability_monitor`, `pg_monitor` only | PASS | production role: A12.10 |
| Internal exporter; no query text | §3F, §4I, §4J | 9187 unpublished; per-table / index collectors off; no `stat_statements` | PASS | `pg_stat_statements`: later |
| 10/10 simultaneous targets | §4J | the merged stack | PASS | — |
| Cross-layer messaging and database | §4J (complementary signals, not exact accounting) | — | PASS | — |
| Host exposure, secrets, labels / PII, combined cardinality | §4J | — | PASS | — |
| Failure matrix and non-invasiveness | §4J | — | PASS | — |

**Security (all PASS):**
- 9464, 15692 and 9187 are not host-published; Prometheus 9090 is on loopback only.
- Admin API, lifecycle API and remote-write receiver are off.
- No `docker.sock`; no privileged monitoring container.
- No real monitoring password is committed (a local placeholder in `.env.example`; `.env` untracked), and no credential is in `prometheus.yml`.
- No sensitive label value and no SQL or query text was found in the integrated proof.
- The monitoring role is not a superuser and has no application write or admin authority.
- RabbitMQ detailed and per-object scrapes are off.
- Normal mode stays observability-default-off.

**Cardinality** (local evidence only, never production sizing, Prometheus capacity or retention):
- Core: the A12.3 bounded labels.
- RabbitMQ: the aggregate endpoint, the exact Erlang VM-internal drop, no per-object or detailed scrape.
- PostgreSQL: per-table and per-index collectors off, `pg_settings` kept, no query labels or text.
- Integrated: about 1,837 stored series.

**Failure and non-invasiveness** (§4J):
- A Core service down shows only its target DOWN.
- RabbitMQ down shows the broker target DOWN, and the consumers' metrics record the loss and recovery.
- PostgreSQL down shows `pg_up` = 0 with the exporter still scrapeable, then recovery.
- The exporter down shows its target DOWN while PostgreSQL is unaffected.
- Prometheus down: services, broker and database continue.

**Observability is not a platform authority and owns no business state.** This is local evidence, not a production availability or
SLO claim.

**Accepted, not blockers:**
- **Prometheus self-scrape:** not enabled; an A12.6 dashboard and alert decision.
- **RabbitMQ per-queue / DLQ:** not enabled; the aggregate backlog includes dead-lettered messages; an A12.6 cardinality and dashboard
  decision.
- **PostgreSQL query visibility:** `observability_monitor` inherits `pg_monitor` and can read statement text in `pg_stat_activity`
  (role capability), but the exporter exports no SQL or query text to Prometheus (telemetry). Accepted locally; production role policy
  is A12.10.

**Deferred and classified:**
- **A12.6:** Grafana, dashboards, alerts and Alertmanager; the per-queue / DLQ decision; the Prometheus self-observability decision.
- **Later PostgreSQL work:** `pg_stat_statements`, query latency, slow-query analysis, blocker-to-waiter visibility.
- **A12.10:** production deployment, credentials, monitoring role, network topology, host and container metrics, backup
  observability, retention and capacity.
- **G4:** live production monitoring proof.
- **G6:** deferred.
- **Final Core Validation:** absolute last.

None of these is required for the local collection layer.

**Static re-validation on `879ea44`:** `check:repo` PASS; `test:repo` 75/75 (11 observability guard tests); `promtool check config`
SUCCESS; `sh -n` on the PostgreSQL init OK; normal and observability Compose resolve; the runbook link resolves.

## 4L. Evidence (A12.6.1, local)

Disposable Compose project `a1261-obs`: fresh volumes, the tracked `.env.example` placeholders, and the full overlay stack (eight
services, RabbitMQ, PostgreSQL, the exporter, Prometheus, Grafana) all healthy. Torn down afterwards: its containers, volumes, network
and built images were removed. The user's own containers and volumes were not touched.

| Proof | Result |
|---|---|
| Hardening | `read_only: true` and tmpfs work together: Grafana 13.2.3 starts and stays healthy with a read-only root (`/var/lib/grafana` and `/tmp` in tmpfs, uid 472). Inspected: user 472, `CapEff` 0, no capabilities added, `no-new-privileges`, not privileged, no Docker socket; writes to the image and provisioning paths fail (read-only file system); mounts are three read-only binds and no volume |
| Exposure | host listener `127.0.0.1:3100` only; the non-loopback host address gets no answer; 9464, 15692 and 9187 are not published |
| Authentication | unauthenticated `/api/user`, `/api/search`, `/api/datasources`, `/api/folders`, the dashboard and `/api/admin/settings` → 401; `admin/admin` (basic and form login) → 401; an empty password → 401; sign-up refused; the configured credential → 200. `/api/health` is public liveness only |
| Effective configuration | `/api/admin/settings`: anonymous off, sign-up and organisation creation off; reporting, update checks, plugin update checks, feedback links, news and Gravatar off; plugin preinstall disabled, auto-update off, plugin admin off, public-key retrieval off, no preinstall list; SQLite in `/var/lib/grafana`; the admin password is masked |
| Outbound | open connections sampled three times over 40 s: loopback, the Compose gateway (inbound host requests) and `prometheus:9090` only. The logs name no grafana.com, telemetry or Gravatar endpoint. No plugin directory content; only bundled core plugins; the plugin install API → 404 |
| Datasource | exactly one: `nawara-prometheus`, prometheus, `http://prometheus:9090`, proxy, no basic auth, read-only; health OK; deleting or modifying it → 403. With Prometheus stopped, health returns an explicit error (no host), Grafana stays up and services are unaffected; after restart, health is OK |
| Provisioning | one folder ("Nawara Core", uid `nawara-core`), one dashboard (`nawara-core-overview`, "Core · Overview"), provisioned from `core-overview.json`; saving over it → 400 "Cannot save provisioned dashboard"; deleting it → 400 |
| Queries | every panel query (25 targets) succeeds through Grafana: `up` 8 Core + `rabbitmq` + `postgres`; `pg_up`; scrape health on 10 jobs; pools on 8 jobs; consumers on 3 jobs (audit, billing, notification); outbox on 6 jobs; aggregate RabbitMQ backlog; PostgreSQL connections vs max |
| Readiness semantics | before any `/ready`: no series ("not run"), although the kit exports 0. After one `/ready` on billing: billing READY (1), age about 51 s; no other service is listed |
| HTTP semantics | with about 1.2 req/s on billing: request rate shown; 5xx ratio = 0 (a real zero: traffic, no 5xx); release-service (one request, below 1/min) has a rate but **no** 5xx ratio (blank, not applicable) |
| Recreation | `--force-recreate grafana`: a new container; the old session cookie → 401; a datasource added at runtime is gone; the baseline proof passes again (66/66); no Grafana volume exists |
| Configuration | Compose refuses to start the overlay without `GRAFANA_ADMIN_PASSWORD`; the normal `docker-compose.yml` has no Grafana, Prometheus or exporter and no `METRICS_ENABLED` |
| Determinism | regenerating the dashboard gives the identical file (same SHA-256); top-level keys have no id, version or timestamp; no numeric datasource id, no `or vector`, no `service` selector |

Finding, fixed in the dashboard: the readiness gauges are 0 before the first `/ready` run (above). The first runtime proof showed every
service NOT READY with an age of about 56 years. The fix and its guard are in §3G. No kit, service or Prometheus change was made.

Not done: other dashboards, rules, self-scrape, Alertmanager (out of scope); CI (not run: no push).

## 4M. Evidence (A12.6.2, local)

Branch `feature/core-v2-a12-operational-dashboards` from `main` at `8d5aa7a` (PR #214 merge), 2026-10-07. Disposable Compose project
`a1262-obs`: fresh volumes and a scratch copy of `.env.example` (never the developer's `.env`). Services were migrated, and the full
overlay stack was healthy with ten targets UP. Torn down afterwards: its containers, network, volumes and built images were removed.
Earlier retained evidence volumes and the developer's own volume were not touched.

| Proof | Result |
|---|---|
| Static | `check:repo` PASS; `test:repo` 90/90; the four dashboard files parse; regenerating the three new files gives byte-identical output (SHA-256); `core-overview.json` byte-identical to `origin/main`; normal and observability Compose resolve; the normal file has no Prometheus, Grafana or exporter |
| Provisioning | after `--force-recreate grafana`: one folder (Nawara Core, `nawara-core`) with exactly `nawara-core-overview`, `nawara-core-service`, `nawara-core-messaging`, `nawara-core-postgresql`; one datasource (`nawara-prometheus`, health OK); saving over or deleting a provisioned dashboard → 400 |
| Variables | resolved through Grafana's Prometheus datasource (`label/<name>/values?match[]=<the variable's selector>`, as `label_values()` does): `job` = the eight Core jobs exactly (Prometheus also has `rabbitmq`, `postgres`, which are excluded); `queue` = `audit-service.audit`, `billing.payment-events`, `notification.events`; `datname` = the nine service databases and `postgres` (`template0` / `template1` excluded) |
| Queries | every panel target through Grafana `/api/ds/query` with the variable substituted, 0 errors. Service: 38 targets for each of five jobs (billing, audit, release, notification, payment). Messaging: 36 for each of the three queues. PostgreSQL: 35 for each of four databases (release, accounting, postgres, auth) |
| Service selection | billing: consumer `billing.payment-events` ATTACHED, outbox figures, readiness READY after one `/ready` (checks database, migrations, rabbitmq, rabbitmq-consumer). audit: consumer ATTACHED, every outbox panel empty (not applicable). release: HTTP figures, no consumer (not applicable). The data changes with the job |
| HTTP | release at about 1.3 requests/s (the public compatibility route, 4xx): rate by status class, 5xx ratio = 0 (real: traffic, no 5xx), p95 ≈ 18 ms, p99 ≈ 24 ms, busiest route by template. payment with 2 requests (0.004/s, below 1/min): rate shown, 5xx ratio **blank** |
| Readiness | release never had `/ready`: raw `nawara_readiness_ready` 0 and last-run 0, while every readiness panel shows **not run**. billing and audit after one `/ready`: READY, age about 30 s |
| Messaging | three proof messages on the disposable broker: one malformed (no envelope) and one well-formed with an empty payload to `payment.succeeded`, one well-formed to `audit.local_proof`. Application outcome: billing `dead_lettered_malformed` 1 and `dead_lettered_permanent` 1, audit `dead_lettered_permanent` 1, all in their `<queue>.dead`. Broker: aggregate backlog total 3 (the parked messages), every `dead_lettered_*` reason 0 (the copies are republished, not broker-dead-lettered). So the application dead-letter panel and the broker dead-letter-mechanics panel answer different questions, as designed |
| Broker | target UP, alarms OK, 3 connections / 3 channels / 3 consumers / 9 queues (main, retry and dead for three consumers), message rates, memory and disk against their limits |
| PostgreSQL | `pg_up` 1; 9 connections of 100 (3 superuser-reserved); sessions by state; release: about 5 commits/s, rollback ratio 0, cache hit ≈ 1.0, locks by mode, 0 waiting, 0 deadlocks in range, tuple rates, size. accounting (no service) still has background transactions (about one every 27 s), so its ratios are real; settings: `track_io_timing` off, timeouts off (0) |
| Security regression | published host ports are loopback only: the application ports, 5433, 5672, 15672, 9090 and 3100. 9464, 15692 and 9187 are not published. Anonymous and `admin/admin` → 401 on the user, search, datasource and dashboard APIs. Anonymous access and sign-up are off; reporting and update checks are off; plugin preinstall is disabled. No installed plugin (the plugin directory is empty; only bundled plugins). No established outbound socket at the sample. Grafana: user 472, read-only root, `CapDrop ALL`, `no-new-privileges`, not privileged |

Finding (recorded in §3H, not a defect of these dashboards): a labelled counter is created at its first increment, so `rate()` shows 0 for
that first event; the dashboards therefore show rare events as since-start counts. Observation on the overview's outbox panels: §3H.

Not done: alert rules, self-scrape, Alertmanager, per-queue metrics (out of scope); CI (not run: no push).

**Owner-approved correction (Core · Overview outbox, §3H), focused validation only.** Core · Overview differs from `origin/main` only in
panels 19 and 20: three expressions gained the stats-timestamp filter, and the two descriptions gained one sentence; uid, title, layout,
datasource and every other panel are unchanged. The edit is deterministic (re-applying it gives the same SHA-256), and the three new
dashboards still regenerate byte-identically. `check:repo` PASS; `test:repo` 91/91. The join semantics were proved with
`promtool test rules` (the pinned Prometheus image, no network, synthetic series), running the overview's exact expressions. With
auth-service never read (timestamp 0, gauges 0), billing-service read with nothing pending, and payment-service read with pending 5,
retrying 2 and age 42 s, each query returns only billing 0 and payment's value. auth-service is absent (no data), and labels and
legends are unchanged. The same test with the `origin/main` expressions fails: auth-service appears as a false 0. No stack was
started.

## 4N. Evidence (A12.6.3.1, local, static)

Branch `feature/core-v2-a12-alerting-foundation` from `main` at `e3b68de` (PR #215 merge), 2026-10-07. Static and synthetic only. No
Compose stack was started: `promtool check config` loads the configuration and the rule files it references, which is the loading
proof this slice needs. The runtime proof (rules loaded in a running Prometheus, the self-scrape series count, a real fire and
recovery) is A12.6.3.3.

| Proof | Result |
|---|---|
| `promtool check config` (lint fatal) | SUCCESS, 1 rule file found |
| `promtool check rules` (lint fatal) | SUCCESS, 6 rules |
| `promtool test rules` | SUCCESS, 6 test groups |
| Test coverage | CoreServiceDown: healthy, a 1-minute outage, a sustained outage firing for exactly one job, recovery, and the broker and exporter down without a CoreServiceDown. RabbitMQDown: healthy, transient, sustained, recovery. PostgreSQL unreachable with the exporter up: PostgreSQLDown only, then recovery. Exporter down (`pg_up` stale): PostgresExporterDown only, not before 5 minutes, then recovery. PrometheusRuleFailures: none, one failure firing with its `rule_group`, resolved after the 10-minute window, and a counter reset (3 → 0, a restart) never firing. PrometheusConfigReloadFailed: success, failure, success again |
| Negative controls (mutated copies of the rules, in scratch) | each makes `promtool test rules` fail: an unbounded `up == 0`, a PostgreSQLDown that also fires on `absent(pg_up)`, PostgresExporterDown `for: 1m`, PrometheusRuleFailures on the raw counter |
| `check:repo` / `test:repo` | PASS / 98/98 |
| Compose | the normal and observability files resolve |

## 4O. Evidence (A12.6.3.2, local, static)

Same branch, continuing A12.6.3.1 (`origin/main` still `e3b68de`), 2026-10-07. Static and synthetic only: no stack, no dashboard or
kit change.

| Proof | Result |
|---|---|
| `promtool check config` / `check rules` (lint fatal) | SUCCESS: 1 rule file, 16 rules |
| `promtool test rules` | SUCCESS: 18 test groups (6 from A12.6.3.1, 12 new) |
| New cases | ConsumerDetached: attached, a 1-minute detach, a sustained detach firing with its queue, reconnect, a non-consumer. MessagesDeadLettered: `processed` / `retry_scheduled` / `dead_letter_deferred` never; the first dead letter (series appears at 1), a later increment, a stable count resolving after 10 minutes, a restart then a new dead letter (reset); both residual limits shown. OutboxBacklogAging: never-read zero, real zero, ageing shorter than `for`, sustained ageing, drained, no outbox. OutboxStatsStale: fresh, stale, never read inside and past the 5-minute grace, first read resolving, no outbox. DbPoolWaiting: idle, a brief wait, a sustained wait, recovery, no pool. HttpServerErrorRatio: no 5xx series, one 5xx at low traffic, many 5xx at 1 %, 100 % but two 5xx (aborted and 4xx ignored), a firing service and its recovery. BrokerResourceAlarm: none, a short alarm, disk and file-descriptor alarms each labelled, memory alone, recovery. PgConnectionPressure: 70 %, a short spike, sustained 86 %, recovery. PgDeadlocks: flat, one deadlock, resolution, a statistics reset, a template database. PgLockWaits: locks held without waiting, a short wait, sustained waiting, recovery |
| Negative controls (mutated copies of the rules, in scratch) | each makes `promtool test rules` fail: HttpServerErrorRatio without its absolute floor, PgLockWaits on `pg_locks_count`, MessagesDeadLettered without the first-event branch, OutboxStatsStale without the startup grace, PgDeadlocks including template databases. The floor mutation first passed: the low-traffic services were only pending at the test's evaluation times. A 9-minute evaluation was added, and the mutation now fails |
| Guard negative controls (`test:repo`) | outbox filter removed or `>= 0`, `or vector(0)`, the HTTP floor or ratio removed, a broadened broker alarm match, a bare `{__name__=…}` selector, label_replace elsewhere, PgLockWaits on locks held, uncollected PostgreSQL data, widened outcome / status_class / wait_event_type matchers, propagated `outcome` / `usename`, deferred alert names, a missing catalog alert |
| `check:repo` / `test:repo` | PASS / 104/104 |

## 4P. Evidence (A12.6.3.3, focused local runtime proof)

Same branch and working tree (`origin/main` `e3b68de`), 2026-10-07.
- **Project:** disposable Compose project `a1263-obs`, using the existing overlay topology with a scratch copy of `.env.example` (never
  the developer's `.env`). Images were built and service migrations run.
- **Why the full stack:** every scrape target is static. A partial stack would leave the other targets `up` 0 and fire seven more
  CoreServiceDown alerts plus RabbitMQDown and PostgresExporterDown, so "exactly one CoreServiceDown" could not be shown.
- **Not started:** Grafana (not needed).
- **Scope:** one real fire and recovery. Not a failure matrix: the other alerts are proven by promtool (§4O).

| Proof | Result |
|---|---|
| Startup | Prometheus healthy with the new configuration; 11/11 targets UP (eight Core services, `rabbitmq`, `postgres`, `prometheus`) |
| Rule inventory (`/api/v1/rules`) | 4 groups (`core-messaging`, `core-services`, `infrastructure`, `prometheus`), all from `/etc/prometheus/rules/nawara-core.rules.yml`, interval 30 s; **16 alerting rules**, 0 recording rules, 16 unique names, every rule health `ok`. No deferred or rejected alert (SettleFailures, PrometheusSelfScrapeDown, readiness, DLQ depth, broker backlog, long transaction, TSDB) |
| Self-scrape | `up{job="prometheus"}` 1. **22 stored series** for `job="prometheus"`, in exactly the 8 allowlisted families plus the 5 scrape series: `prometheus_rule_evaluation_failures_total`, `prometheus_rule_group_iterations_missed_total` and `prometheus_rule_group_last_evaluation_timestamp_seconds` with 4 series each (one per group); `prometheus_config_last_reload_successful`, `prometheus_config_last_reload_success_timestamp_seconds`, `process_start_time_seconds`, `process_resident_memory_bytes` and `prometheus_tsdb_head_series` with 1 each; `up`, `scrape_duration_seconds`, `scrape_samples_scraped`, `scrape_samples_post_metric_relabeling` and `scrape_series_added`. Label names: `__name__`, `job`, `instance`, `rule_group` only. Unrestricted, the endpoint returns **1,087** samples (`scrape_samples_scraped`); the allowlist keeps **17** (`scrape_samples_post_metric_relabeling`). Whole head: 1,809 series. No unexpected family. (A12.6.3.1's estimate of about 19 assumed three groups; four groups give 22.) |
| Rule health | `prometheus_config_last_reload_successful` 1; `prometheus_rule_evaluation_failures_total` 0 in all 4 groups; `prometheus_rule_group_iterations_missed_total` 0 in all 4 groups; each group last evaluated 12–34 s before the read |
| Initial state | `release-service` healthy, `up` 1; no alert pending or firing |
| Target | **`release-service`**: it consumes nothing, no other service calls it, it holds no migration or cutover state, and stopping or starting it is non-destructive |
| Injection | `docker compose -p a1263-obs … stop release-service` at 09:24:43Z (not removed, not rebuilt); `up{job="release-service"}` 0 by 09:24:58Z |
| Pending | 09:25:03Z: CoreServiceDown, `job="release-service"`, `instance="release-service:9464"`, state **pending**, activeAt 09:25:00Z |
| Firing | 09:27:04Z: state **firing**, 2 minutes after activeAt (`for: 2m`). Exactly one active alert in Prometheus; `ALERTS` showed RabbitMQDown, PostgreSQLDown and PostgresExporterDown empty; the only target down was `release-service` |
| Recovery | `docker compose … start release-service` at 09:27:17Z: healthy and `up` 1 after about 10 s, no active alert after about 14 s; the CoreServiceDown rule `inactive`, health `ok` |
| After the cycle | still 22 stored series in 13 families for `job="prometheus"`; rule evaluation failures 0 in all groups |
| Exposure (focused) | host ports loopback only (application ports, 5433, 5672, 15672, 9090); 9464, 15692 and 9187 unpublished. Prometheus: mounts `prometheus.yml` and `/etc/prometheus/rules` read-only (writing there: "Read-only file system") and its data volume; no tests directory; read-only root, `CapDrop ALL`, unchanged flags. The running configuration has no `alerting`, Alertmanager, remote write or credential; `activeAlertmanagers` empty. Admin API → "admin APIs disabled"; `/-/reload` → "Lifecycle API is not enabled" |
| Cleanup | `release-service` restored and healthy before teardown. The disposable project was removed: containers, network, its three volumes, its nine built images. No prune. Earlier retained evidence volumes, the developer's own volume and unrelated containers are unchanged. No observability stack was running before; none is running after |

**A12.6.3.3 COMPLETE. A12.6.3 LOCALLY COMPLETE** (A12.6.3.1–.3; not yet committed). A12.6 stays OPEN: A12.6.4 integration and security
validation, A12.6.5.

## 4Q. Evidence (A12.6.4, integrated local observability and security validation)

Branch `feature/core-v2-a12-integration-validation` from `main` at `4ffcb0d` (PR #216 merge, containing `4bb7f50`), 2026-10-07. One
campaign that proves only what the earlier evidence did not.
- **Discovery (A12.6.4.0) change-impact result:** Grafana configuration, the exporter, `infra/postgres`, `infra/rabbitmq`, service-kit and
  the services are unchanged since their evidence, which stands. Not repeated: the A12.6.1 hardening campaign, the A12.6.2 query
  campaign, the A12.5.3 privilege drill, the A12.5.4 failure matrix and the A12.6.3 CoreServiceDown cycle.
- **Preflight:** `check:repo` PASS, `test:repo` 104/104, promtool 16 rules SUCCESS.
- **Project:** disposable Compose project `a1264-obs`, with fresh volumes and a scratch copy of `.env.example` (never the developer's
  `.env`). Images built and service migrations run.
- **Topology:** the complete overlay: PostgreSQL, RabbitMQ, the eight Core services, postgres-exporter, Prometheus and Grafana.
- **Traffic:** a few harmless 4xx GET requests to two services, no 5xx.
- **No additional failure injection was performed.**

| Proof | Result |
|---|---|
| Integrated topology | 13 containers healthy; Prometheus job set **exactly** the 11 expected (8 Core, `rabbitmq`, `postgres`, `prometheus`), all `up`, 0 dropped targets (11/11 at 09:48:53Z) |
| Rules | 4 groups (`core-messaging` 4, `core-services` 3, `infrastructure` 7, `prometheus` 2); 16 alerting, 0 recording, 16 unique; health `ok`; static label keys `severity` only; evaluation failures 0 and missed iterations 0 in every group; reload successful 1 |
| Prometheus control plane | running config has no `alerting`, Alertmanager, remote write or credential (0 matches); `activeAlertmanagers` empty; admin, lifecycle and remote-write receiver flags `false`; admin API → "admin APIs disabled"; `/-/reload` → "Lifecycle API is not enabled"; host binding `127.0.0.1:9090` only |
| Grafana smoke | `/api/health` ok; `127.0.0.1:3100` only; exactly one datasource (`nawara-prometheus`, prometheus, `http://prometheus:9090`), health OK; exactly the four dashboards in folder `nawara-core`; anonymous → 401, `admin/admin` → 401 |
| **Gap 1: Overview outbox correction, live** | The three corrected queries (panels 19 and 20) through Grafana's datasource all keep the `and on (job, instance) (nawara_outbox_stats_timestamp_seconds > 0)` filter and have no `vector(`. They return exactly the six outbox services (auth, billing, file, organization, payment, release, each 0: real zeros, stats read). audit-service and notification-service do not appear (no outbox). The jobs with stats timestamp > 0 are the same six; none was still 0 (every relay read within seconds of start). The never-read case therefore cannot occur in a healthy running stack without restarting a service, so it stays proven by promtool (§4M correction note) |
| **Gap 2: Grafana rule view** | **Supported.** `GET /api/prometheus/nawara-prometheus/api/v1/rules` (Grafana proxying the datasource's rules) → 200, the four groups, 16 alerting rules. Grafana-managed rules (`/api/prometheus/grafana/api/v1/rules`) → empty: no Grafana-managed alerting. Prometheus stays the rule authority |
| Representative dashboard queries (through Grafana) | Service: `up{job="billing-service"}` 1; release-service request rate `4xx` ≈ 0.077/s. Messaging: consumers attached for the three queues (audit, billing, notification), each 1. PostgreSQL: `pg_up` 1; connections 9–10 against `max_connections` 100 and 3 reserved |
| Cross-layer consistency (same live data, compared as sets) | **Outbox:** the Overview's corrected domain equals OutboxBacklogAging's domain (the runtime rule expression without its age threshold): 6 = 6 job/instance pairs. **Messaging:** the Messaging dashboard's consumer domain equals ConsumerDetached's: 3 = 3 job/instance/queue. **DB pool:** the Service dashboard's pool-waiting query over every `$job` equals DbPoolWaiting's: 8 = 8 job/instance/pool (`main`). No difference |
| Cardinality | `prometheus_tsdb_head_series` 1,868 = stored series. Per job: postgres 959, rabbitmq 266, billing 92, release 91, auth / file / organization / payment 74, audit / notification 71, prometheus **22**. Top families: `nodejs_gc_duration_seconds_bucket` 168, `pg_locks_count` 108, `nawara_event_publish_duration_seconds_bucket` 104, `pg_stat_activity_count` 72, `pg_stat_activity_max_tx_duration` 72, `pg_roles_connection_limit` 35, … |
| Cardinality vs the 1,809 reference | +59, all bounded and activity-dependent: +34 HTTP series (17 each for the two services that received traffic, one route each; the other six have none); Node GC series per GC kind (bounded at 3 kinds × 9 = 27 per job, now present on all eight); session-dependent PostgreSQL activity series. No unexpected family, no unbounded growth. Local evidence only, not production sizing |
| Labels and sensitive data | 52 label names. Beyond the kit / exporter / broker labels already documented, the extras are bounded build and identity information (one value each: versions, `goos`, `revision`, RabbitMQ cluster and node identity), exporter and broker internals (`collector` 13, `registry`, `content_type`, `encoding`, the exporter's own handler `code` 3, RabbitMQ's fixed Mnesia `table` 22 and memory `usage` 7), PostgreSQL role names (`rolname` 35, all built-in `pg_*` or service roles, as documented in A12.5.3) and `server` (1 value, `host:port`). Value counts: route 2, queue 3, datname 12, usename 8, application_name 6, instance 11, rule_group 4. Pattern scan (email, UUID, query string, URL, long digit runs, credential words) over route / queue / instance / application_name / usename / datname / rule_group / service / check: **0 hits**; every route a template. No `query`, `statement`, `payload`, `header`, `authorization`, `email`, id, `url` or `vhost` label; no `pg_stat_statements*`, `pg_stat(io)_user_(tables\|indexes)*` or `rabbitmq_detailed_*` family (581 families in total) |
| RabbitMQ boundary | scrape URL `http://rabbitmq:15692/metrics` (aggregate; not `/metrics/detailed` or `/metrics/per-object`); 0 `rabbitmq_*` series with a `queue` or `vhost` label; the three alarm families present, one series each, all 0. Nothing triggered |
| PostgreSQL boundary | `up{job="postgres"}` 1, `pg_up` 1; 0 `pg_*` series with a `query` label; no statement or per-table / per-index family; the alert families present (`numbackends` 12, `max_connections` 1, `superuser_reserved_connections` 1, `deadlocks` 12, `pg_stat_activity_count` 72). The monitoring-role privilege drill was **not** repeated: A12.5.3 stands |
| Exposure and hardening | host bindings all `127.0.0.1` (application ports 3000–3007, Grafana 3100, Prometheus 9090, PostgreSQL 5433, RabbitMQ 5672 / 15672); 0 non-loopback bindings; 9464, 15692 and 9187 not published (Compose-network only). Prometheus, Grafana and postgres-exporter: read-only root, `CapDrop ALL`. No container privileged; no Docker socket mounted. Prometheus mounts `prometheus.yml` and `rules` read-only (tests not mounted); Grafana mounts its provisioning and dashboards read-only. The application, database and broker containers keep the unchanged local-development settings |
| Healthy-stack alerts | at 09:56:00Z, 7 minutes after full initialization (past OutboxStatsStale's 300 s grace plus `for: 2m`): `count(ALERTS)` none; `max_over_time(count(ALERTS)[8m:30s])` empty, so **no alert was pending or firing at any point**; no outbox stats still 0; 11/11 targets up |
| Cleanup | the project's 13 containers, network, three volumes (`a1264-obs_*`) and nine built images removed, plus the scratch env and wrapper. **No prune.** Containers, volumes and networks identical to the pre-campaign snapshot. Earlier retained evidence volumes, the developer's own volume and unrelated containers are preserved |

**A12.6.4 COMPLETE LOCALLY** (not yet committed). A12.6 stays OPEN until A12.6.5, the local certification, which consumes A12.5 and
A12.6.1–A12.6.4 evidence and inexpensive static checks; it does not rerun this campaign. Local evidence only: it certifies no
production Prometheus, Grafana, thresholds, receivers, retention, host monitoring, production database or broker monitoring, backup
observability or live alerting (A12.10, G4).

## 4R. A12.6 local certification (A12.6.5)

**A12.6 LOCAL OBSERVABILITY — FORMALLY CERTIFIED LOCALLY.** Branch `feature/core-v2-a12-integration-validation` at `main` `4ffcb0d`,
2026-10-07. This is a certification from accumulated evidence: **no runtime campaign was repeated**. No Docker stack was started, no
alert was triggered, no cardinality was re-measured, and no Grafana, RabbitMQ or PostgreSQL check was rerun.
- **Consumed:** A12.3 (§3B, §4B), A12.4 (§3C, §4C–§4F), A12.5.1–A12.5.5 (§3D–§3F, §4G–§4K), A12.6.0 (§3G, D6a), A12.6.1 (§3G, §4L),
  A12.6.2 (§3H, §4M with its Overview correction), A12.6.3 (§3I, §4N–§4P; PR #216) and A12.6.4 (§4Q).
- **Static checks at certification:** `check:repo`, `test:repo` (104/104), `scripts/check-prometheus-rules.sh` (16 rules) and the
  documentation links.

**Local certified ≠ production monitoring certified.** This certifies the LOCAL, opt-in observability layer that A12.6 built on the
A12.5 collection layer:
- Grafana (`127.0.0.1:3100`, one Prometheus datasource) and its four provisioned dashboards;
- the 16 Prometheus alert rules evaluated by Prometheus;
- the allowlisted Prometheus self-scrape;
- their integration with the eight Core services, RabbitMQ and PostgreSQL;
- the security, exposure and data-boundedness properties below;
- the repository guards that keep them so.

It certifies nothing in production (A12.10), G4, G6 or Final Core Validation.

| Requirement | Evidence | Result |
|---|---|---|
| **Collection:** the eight Core services are observable | A12.5 (§4G, §4J, §4K); A12.6.4: 8/8 Core targets up together with everything else | PASS |
| **Infrastructure metrics:** RabbitMQ and PostgreSQL observability | A12.5.2 / .3 / .4 (§4H–§4J); A12.6.4: `rabbitmq` and `postgres` targets up, `pg_up` 1, the alert families present | PASS |
| **Prometheus:** integrated collection, rules and self-observability | A12.5 (§4G, §4K); A12.6.3 (§4N–§4P: 16 rules load, self-scrape allowlist, 22 series); A12.6.4: exactly 11 jobs all up, 4 groups / 16 rules healthy, 0 evaluation failures, 0 missed iterations, reload successful | PASS |
| **Grafana:** local operator visualisation through one Prometheus datasource | A12.6.1 (§4L: hardening, authentication, outbound, datasource, provisioning, recreation); A12.6.2 (§4M); A12.6.4: healthy, exactly one datasource `nawara-prometheus` (OK), 401 for anonymous and `admin/admin`, read-only rule view of the 16 Prometheus rules | PASS |
| **Dashboards:** Overview, Service, Messaging and PostgreSQL views | A12.6.1 (Overview) and A12.6.2 (§4M: every panel query, variables, no-data semantics); A12.6.4: the four uids provisioned, one representative live query per dashboard | PASS |
| **Outbox initialisation semantics:** uninitialised gauges never shown as a healthy zero | A12.6.2 correction (§3H, §4M: promtool synthetic proof, old expression fails, corrected passes; guard); A12.6.3 (rules and guard carry the same filter; OutboxStatsStale covers never-read); A12.6.4 (§4Q: live, the corrected queries return exactly the six initialised outbox services, none for audit / notification) | PASS |
| **Alerting:** bounded local catalog with deterministic semantics | A12.6.3 (§3I, §4N, §4O): 16 alerts in 4 groups, 18 promtool test groups, mutation negative controls, `checkAlertRules` (exact catalog, bounded labels, selection-only matchers, HTTP floor, single reviewed `label_replace`) | PASS |
| **Runtime alert pipeline:** a real target failure reaches pending / firing and recovers | A12.6.3.3 (§4P): `release-service` stopped → CoreServiceDown pending → firing after `for: 2m` → service restored → inactive; only that alert | PASS |
| **Healthy integrated topology:** no spurious alerts | A12.6.4 (§4Q): the complete stack healthy for more than 7 minutes (past OutboxStatsStale's grace + `for`), `count(ALERTS)` 0, no pending or firing alert in the window | PASS |
| **Cross-layer consistency:** dashboard and alert domains agree | A12.6.4 (§4Q): outbox 6 = 6, messaging 3 = 3, DB pool 8 = 8 (same live data, compared as sets) | PASS |
| **Cardinality:** local metrics bounded and explained | A12.5 (§3E, §3F, §4J: about 1,837, drops and disabled collectors); A12.6.3.3 (22 self-scrape series: 1,087 endpoint samples → 17 kept + 5 scrape series); A12.6.4: **1,868** series, self-scrape **22**, the difference attributed to bounded activity series | PASS |
| **Sensitive-data safety:** no sensitive or unbounded application data in metrics or alerts | A12.2a / A12.3 closed label policy (§3A, §3B), A12.4 logging and PII contract (§3C); A12.5.4 label review (§4J); dashboard and rule guards (§3H, §3I); A12.6.4 (§4Q): 52 label names all bounded, 0 pattern hits (email, UUID, query string, URL, long digits, credential words), no forbidden label or family; alert labels only `severity` plus bounded series labels | PASS |
| **Exposure:** monitoring endpoints exposed as intended | A12.5 (§4J), A12.6.1 (§4L), A12.6.3.3 (§4P), A12.6.4 (§4Q): host bindings loopback only (Prometheus 9090, Grafana 3100); 9464 / 15692 / 9187 on the Compose network only; observability containers read-only, `CapDrop ALL`, not privileged, no Docker socket; Prometheus admin, lifecycle and remote-write receiver off; no Alertmanager or remote write | PASS |
| **Repository enforcement:** future changes are guarded | `check:repo` (`checkLocalObservability`, `checkAlertRules`, `checkLocalGrafana`, `checkDashboardSemantics`), `test:repo` 104/104, promtool `check config` / `check rules` / `test rules` in Core CI (`repository checks`, required by `core-ci-passed`) | PASS |

**Cardinality note.** 1,868 series (22 of them the Prometheus self-scrape) is bounded LOCAL evidence for one development stack with light
traffic. It is not a production capacity, retention or sizing figure (A12.10).

**Security and privacy summary.**
- Metrics come from closed label sets: route templates, code-declared queues and pools, fixed outcomes. The exporter exports no query
  text and no per-table or per-index data; the broker endpoint is aggregate only.
- Alerts carry only `severity` and bounded series labels, with static annotations.
- Grafana and Prometheus are loopback-only, authenticated (Grafana) or administratively inert (Prometheus), read-only and
  capability-free. Their configuration holds no credential.
- The monitoring role is least-privilege (`pg_monitor`), proven by A12.5.3's 23 refusals; its configuration has not changed since.

**Deferred and out of scope** (preserved; none is waived):

| Item | Classification |
|---|---|
| Alertmanager | DEFERRED (D6a: until a concrete receiver exists) |
| External alert receivers, production alert routing | PRODUCTION-SCOPE (A12.10) |
| Production thresholds (the A12.6.3 thresholds are LOCAL validation values) | PRODUCTION-SCOPE (A12.10) |
| Production retention and capacity tuning | PRODUCTION-SCOPE (A12.10) |
| RabbitMQ per-queue metrics | DEFERRED (cardinality decision) |
| DLQ-depth alerting, generic broker backlog alert | DEFERRED (needs per-queue metrics) |
| SettleFailures alert | DEFERRED |
| Outcome-series pre-creation (kit change) | DEFERRED (MessagesDeadLettered keeps its documented residual limits) |
| Long-running PostgreSQL transaction alert | DEFERRED |
| TSDB failure alerts | DEFERRED |
| PostgreSQL query latency, `pg_stat_statements`, blocker → waiter visibility | DEFERRED (separate PostgreSQL decision) |
| Readiness alert | NOT REQUIRED FOR LOCAL A12.6 CERTIFICATION (owner decision: readiness is dashboard only) |
| Prometheus self-scrape-down alert | NOT REQUIRED FOR LOCAL A12.6 CERTIFICATION (rejected: a down Prometheus evaluates nothing) |
| Host and container monitoring | PRODUCTION-SCOPE (A12.10) |
| Backup observability | PRODUCTION-SCOPE (A12.10) |
| Production Prometheus / Grafana deployment, credentials, monitoring role, operational access | PRODUCTION-SCOPE (A12.10) |
| Production PostgreSQL and RabbitMQ monitoring | PRODUCTION-SCOPE (A12.10) |
| Live operational monitoring proof | G4 (deferred) |

**Boundaries.**
- A12.6 local certification ≠ A12.10 production observability. A12.10 is NOT STARTED, and decides deployment topology, thresholds,
  receivers and routing, retention, credentials, production database and broker monitoring, capacity and operational access.
- A12.6 does not certify G4, which stays deferred. A12.6 has no dependency on G6, G7, F6 or F7: G6 is deferred; G7, F6 and F7 are locked.
- **FCV NOT RUN — ABSOLUTE LAST**, after the planned Core and platform work, the required production gates and the required service work.
  This certification is not permission to run it.

**Status.** A12.6.0 CLOSED; A12.6.1 CLOSED; A12.6.2 CLOSED; A12.6.3 CLOSED ON MAIN (PR #216); A12.6.4 OWNER APPROVED LOCALLY; **A12.6.5
LOCAL CERTIFICATION COMPLETE**; **A12.6 FORMALLY CERTIFIED LOCALLY**. The A12.6.4 evidence and this certification are not yet
committed, so A12.6 is not yet closed on `main`.

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

## 6. Later status: a seventeenth alert, `DeadLetterCopyFailing` (2026-10-08, V2 A3M.4)

Appended; the sections above, including the A12.6 certification evidence (§4O to §4R), are unchanged. The A12.6 local certification
covered **16 alerts** (`ALERT_CATALOG`, four groups). V2 A3M.4 remedies the messaging finding G7
([A3M record](core-v2-a3m-messaging.md) §7; [ADR-0057](../adr/0057-messaging-conventions.md) §8): a consumer whose dead-letter copy is
not confirmed now holds and requeues the message (`dead_letter_deferred`) instead of letting the broker dead-letter it
(`dead_letter_unannotated`, which `MessagesDeadLettered` alerts on). So that a broken dead-letter path is still alerted, A3M.4 adds a
**seventeenth alert**, `DeadLetterCopyFailing` (`core-messaging`, warning): `dead_letter_deferred` increasing in every 2-minute window
for 5 minutes, on the existing `nawara_events_consumed_total` family and labels, with its promtool test; `check:repo` admits exactly this
alert and this outcome. The sixteen existing alerts, their expressions and tests, the metric families and labels (including
`dead_letter_unannotated`, now no longer produced) and the dashboards are unchanged. This is a narrow forward change: the A12
certification is **not reopened or invalidated**, and none of its evidence was rerun.

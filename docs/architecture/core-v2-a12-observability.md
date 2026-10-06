# Core V2 A12: observability foundation

- **Status:** RECORD of A12.0 discovery, the A12.1 design freeze (owner decisions D1–D8), the A12.2 kit metrics foundation, its
  local security review and the A12.2a correction (§3A), written 2026-10-05: **A12.2 MERGED** (PR #205, `763e1a8`), not certified. Then the
  A12.3 service and messaging metrics (§3B): **A12.3 FORMALLY CLOSED** (PR #206, merge `272ab8d`, post-merge Core CI 24/24). Then A12.4
  logging and PII (§3C): **architecture approved** (owner decisions W1, W2); **A12.4.2 kit hardening implemented and proven locally**
  (§4C; not committed); **service adoption (A12.4.3+) pending**; A12.4 not closed. Metrics are **off by default**
  (`METRICS_ENABLED=false`): no service changes behaviour until a deployment sets it. Nothing here is deployed, scraped in production
  or alerted on; no Prometheus, Grafana, Alertmanager or exporter exists yet (A12.5+). It performs and authorizes no production action.
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
  ownership CLI's `code` field becomes `errorCode`; ai-service: JSON logs, no query string in the uvicorn access log.

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

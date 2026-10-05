# Core V2 A12: observability foundation

- **Status:** RECORD of A12.0 discovery, the A12.1 design freeze (owner decisions D1–D8), the A12.2 kit metrics foundation, its
  local security review and the A12.2a correction (§3A), written 2026-10-05. **A12.2 IMPLEMENTED LOCALLY** (not merged, not certified). Metrics are **off by default**
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

## 5. Open

- `prom-client` is deprecated upstream in favour of `@prometheus-io/client` (0.16.x, first published 2026-08-21, an API-compatible
  superset). Owner decision H1: A12 keeps the validated `prom-client` 15.1.3 behind the single import module; the successor will be
  evaluated later as an isolated dependency change. The guard covers both names.
- Auth registry readiness metrics are stale in production unless something probes Auth's `/ready` (its Docker healthcheck probes
  `/auth/health`, unchanged under D5).
- A12.3–A12.10 per the A12.1 phase plan; production rollout only after the A12.1 production decision gate.

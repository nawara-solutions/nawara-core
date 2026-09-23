# @nawara/service-kit

Technical foundations shared by Nawara Core services ([ADR-0034](../../docs/adr/0034-shared-service-kit-and-api-conventions.md)).
**Infrastructure only: no business logic.** It has no invoice, payment, refund, tax, product, organization or membership
logic, and it never will. (`auth-client.ts` reads the shape of Auth's identity response, and holds no logic about it.)

auth-service does **not** use the kit and is not migrated onto it; it keeps its own implementations. The kit copies proven
patterns from it without importing its code.

| Area | What you get |
|---|---|
| Configuration | `EnvReader` (`NAME` or `NAME_FILE`, typed, fail-closed, **never echoes a value**), `loadBaseConfig` (defaults to *production* behaviour when `NODE_ENV` is unset) |
| Request context | `x-request-id` / `x-correlation-id` middleware (unsafe inbound ids are replaced), `getRequestContext()`, `correlationHeaders()` for outgoing calls |
| Logging | `JsonLogger`: one JSON line per event with service, requestId, correlationId; credential-shaped keys and bearer/URL passwords are redacted |
| Errors | `KitExceptionFilter`: Nest's `{statusCode, message, error}` plus `requestId`; anything unexpected is an opaque 500, no stack, SQL or credential in a response |
| Health | `GET /health` (process alive, touches nothing) and `GET /ready` (registered dependency checks, 503 with the *names* of failing checks only) |
| Service authentication | `ServiceTokenGuard` (per-caller tokens, SHA-256 digests, constant-time comparison, one generic 401), `HttpAuthClient` (asks Auth about the *end user*, live, fail closed) |
| Database | `DbModule`/`DbService` (pool, `tx()`, readiness, graceful shutdown), explicit migration runner and `nawara-migrate` CLI |
| Events | `OutboxService`, `OutboxRelay`, `InboxService`, `EventBus` port with `InMemoryEventBus` and `RabbitMqEventBus` |
| Rate limiting | `RateLimitModule`/`RateLimitService`: Postgres-backed fixed-window limiter, generic bucket/identifier/rule — no business meaning, keys are hashed before storage |
| HTTP baseline | `configureApp`: helmet, bounded JSON body, DTO whitelist (unknown fields rejected), error filter, shutdown hooks, CORS off unless exact origins are listed |
| Testing | `@nawara/service-kit/testing`: `createTestDatabase` |

## Wiring a service

```ts
// main.ts
const config = loadBaseConfig('billing-service');            // throws ConfigError, without echoing values
const logger = new JsonLogger(config.serviceName, config.logLevel);
const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false, bufferLogs: true });
configureApp(app, config, logger);                          // bodyParser must be false: the kit installs a bounded one
await app.listen(config.port);

// app.module.ts
imports: [
  HealthModule.forRoot(),
  DbModule.forRoot({ url: reader.required('DATABASE_URL'), applicationName: 'billing-service', migrations: { dirs: [kitMigrationsDir, ownDir] } }),
  ServiceAuthModule.forRoot(parseServiceTokens(reader.get('SERVICE_TOKENS'))),
  EventsModule.forRoot({ source: 'billing-service', bus: new RabbitMqEventBus({ url: reader.required('RABBITMQ_URL') }) }),
]
```

Constructor injection needs an explicit `@Inject(Token)` (the test runner does not emit decorator metadata), as in auth-service.

## Service authentication (ADR-0033)

* One token **per caller → callee pair**. Create one: `generateServiceToken()` returns `{ token, digest }`.
* The **caller** keeps the raw `token` in its secret store and sends `Authorization: Bearer <token>`.
* The **callee** stores only the digest: `SERVICE_TOKENS=<caller>:<digest>[,<caller>:<digest>]` (at most two per caller, so a token can be rotated without downtime).
* `@UseGuards(ServiceTokenGuard)` authenticates the calling **service** (`@CallerService()`); it says nothing about any end user. An administrator's user token is never accepted as a service credential.
* End-user identity is asked of Auth with the user's bearer (`HttpAuthClient`), never verified locally, and the user's bearer is never sent to any other service.

## Migrations: explicit, never automatic

```bash
MIGRATION_DATABASE_URL=postgres://<svc>_migrator:...@host:5432/<svc> \
  node libs/service-kit/dist/cli/migrate.js --dir apps/<svc>/db/migrations     # kit migrations run first; --no-kit to skip
```

* Nothing migrates at service start. `DbModule` can make `/ready` **fail while migrations are pending**, so an instance whose schema is behind does not take traffic.
* Order is deterministic: directories in the order given, files by name; the kit's own files are named `kit_NNNN_*.sql`.
* The kit also ships a generic, reusable `forbid_column_change()` trigger function (immutable-column enforcement): `CREATE TRIGGER x_immutable BEFORE UPDATE ON x FOR EACH ROW EXECUTE FUNCTION forbid_column_change('col1', 'col2')` in your own migration, once the kit's migrations have run.
* Each file runs in **one transaction with its bookkeeping row** (files must not contain `BEGIN`/`COMMIT`); a failure rolls back and is not recorded.
* An applied file whose contents later change is refused (checksum). Two runners at once are serialized (advisory lock).
* Use the **migrator** role for this step and the least-privilege **runtime** role for the service (`DATABASE_URL`). See `infra/postgres`.
* **Production:** applying migrations there is a deployment step. Do not assume a migration exists in production because it exists in the repository; check `schema_migrations` after every deploy. The kit does not deploy anything.

## Events: outbox and inbox (ADR-0037)

```ts
// producer: the event and the business change commit together (or not at all)
await db.tx(async (q) => {
  await q.query('INSERT INTO ...');
  await outbox.enqueue(q, { name: 'thing.happened', payload: { thingId } });   // never touches the network
});
// consumer: idempotent by construction
bus.subscribe({ queue: 'svc.thing', bindings: ['thing.*'], handler: (e) => inbox.handle(db, e, async (q) => { /* effect */ }).then(() => undefined) });
```

* The relay publishes **at least once**; consumers absorb duplicates through the inbox (inbox row and effect share one transaction).
* A broker outage only delays delivery: the relay records the error class, backs off, and business transactions are unaffected.
* Metadata (`eventId`, `occurredAt`, `correlationId`, `source`, `version`) travels in message **headers**; the payload keeps its flat shape. Payloads carry opaque ids and plain facts, never secrets.
* A failing consumer is retried a bounded number of times, then dead-lettered (`<queue>.dead`) for an operator to inspect and replay; nothing is dropped silently or retried in a hot loop. See **Dead letters** below.
* An event published while **no queue is bound** is dropped by the broker (normal topic-exchange behaviour): consumers must declare their queue before events matter.

## Dead letters: retry, inspect, replay

Topology per consumer queue `Q` (all durable, all declared by the consumer's `subscribe`; `Q`'s own arguments are unchanged):

| Queue | Role |
|---|---|
| `Q` | work queue, bound to the shared topic exchange |
| `Q.retry` | delay queue: nothing consumes it; a message's own `expiration` dead-letters it (default exchange) straight back into `Q` |
| `Q.dead` | the dead-letter queue: holds a failed message until an operator replays it. Nothing deletes it automatically |

**Failure handling.** A handler that rejects is classified by what it throws:

* `PermanentEventFailure(reason)` (a malformed payload, an identifier that is not a valid id): dead-lettered at once, no retry.
* anything else (a lost connection, a deadlock, a timeout): possibly transient, so retried up to `retry.maxRetries` (default **3**) times, `retry.delayMs` (default **5000**) apart, then dead-lettered as `retries_exhausted`. `maxRetries: 0` dead-letters on the first failure.
* a message that is not an event at all (bad JSON, no message id or type): dead-lettered as `malformed`; the handler is never called.

Retry and dead-lettering republish the message with its original body, message id, type and headers (so event id and correlation id never change) plus annotation headers (`x-nawara-retry-count`, and on the dead-letter copy `x-nawara-failure` = `malformed|permanent|retries_exhausted`, `-failure-reason`, `-failure-error` (an error class name, never a message), `-failed-at`, `-consumer`). The dead-letter queue is re-declared before every dead-lettering (a broker drops a message dead-lettered into a missing queue). The copy is confirmed by the broker before the original is acknowledged, so a crash in between duplicates (consumers de-duplicate) and never loses. Retried messages can be redelivered out of order relative to newer ones: consumers validate state, not order. Notices (via `onNotice`; never a URL, credential, payload or error message): `event_retry_scheduled`, `event_retry_exhausted`, `event_dead_lettered`, each with `queue=`, `event=`, `correlationId=`.

**Inspect** (read-only; nothing is consumed or deleted):

```bash
# `nawara-dlq` is the kit's `bin`; from a built checkout or a service image run `node libs/service-kit/dist/cli/dlq.js` instead
RABBITMQ_URL=amqp://... nawara-check-dlq --queue billing.payment-events.dead          # depth only; exits 1 if non-empty
RABBITMQ_URL=amqp://... nawara-dlq list --queue billing.payment-events.dead --field paymentRequestId
# dlq_depth queue=... depth=1 shown=1
# dlq_message position=1 event=<id> name=payment.cancelled correlationId=<id> classification=retries_exhausted reason=- error=error retries=3 replays=0 failedAt=<iso> paymentRequestId=<id>
```

`--field <name>` shows the named top-level payload field (a scalar, truncated); payloads are never dumped otherwise.

**Replay** moves ONE message back into its consumer's work queue, unchanged apart from a replay counter, and reports what became of it:

```bash
RABBITMQ_URL=amqp://... nawara-dlq replay --queue billing.payment-events.dead --event-id <id> [--wait-seconds 10]
# dlq_replay_started ...   dlq_replay_result outcome=consumed|rejected_again|pending|not_found ...
```

Exit code `0` consumed, `2` rejected again (it is back in the DLQ, annotated, and can be replayed again), `3` still pending when the wait ended, `4` not found in the DLQ, `1` error. `consumed` means the consumer acknowledged it: what the consumer DID with it (applied, already applied, deferred, conflict) is that consumer's own log line and record. The tool only republishes to the work queue named by the `.dead` queue, never edits a body, and the message goes through the consumer's normal validation and de-duplication: it has no way to apply anything itself. It needs the broker credentials and nothing else; there is no HTTP endpoint and no application-level authorization: the boundary is the trusted infrastructure/operator boundary around `RABBITMQ_URL`. Printed values are limited to the fixed columns above (plus `--field`), reduced to printable ASCII and cut to 128 characters, because header values are written by whoever published the message. If the same event id is in the DLQ twice, one invocation replays the first.

## Rate limiting

```ts
// app.module.ts
imports: [DbModule.forRoot({ ... }), RateLimitModule]

// somewhere with RateLimitService injected
await this.rateLimit.assert('signup', req.ip, { limit: 5, windowSec: 60 }); // throws 429 { code: 'rate_limited' } once over
```

* Bucket, identifier and rule are all supplied by the caller — the kit assigns no business meaning to any of them.
* The counter increments on every `hit`/`assert` call, success or not, so a caller cannot probe for free.
* Identifiers are hashed (sha256) before being stored; nothing raw (IP, email, token) sits in `kit_rate_limit`.
* `reset()` clears one identifier's counter, for example after a legitimate success that should not count against it.

## Operational signals (Stage 14.7)

Logs are the diagnosis channel (one JSON line on stdout per event, `JsonLogger`); `/ready` is only the orchestration state and
the CLIs below are for targeted checks. There is no metrics or tracing stack. Each signal is a stable `event_name key=value` message:
search for the name, never for the prose after the `—`. A failure is described by `describeFailure(e)` as
`error=<class> [code=<SQLSTATE|errno>] [kind=<kind>]` and NEVER by its message (messages can carry hosts, SQL values, provider
text). Kinds: `db_statement_timeout`, `db_idle_in_transaction_timeout`, `db_connect_timeout` (pool acquisition or connect past
`DB_CONNECTION_TIMEOUT_MS`), `db_query_timeout` (no answer within `DB_QUERY_TIMEOUT_MS` from a silent server or network; the
connection is destroyed), `db_connection_lost`, `db_unavailable`, `db_auth_failed`, `db_serialization_failure`, `db_deadlock`,
`broker_confirm_timeout`, `broker_connection_lost` (the broker connection was torn down: a missed heartbeat, a closed socket,
and the channel operations it rejected), `network_unreachable`.

| Signal | Level | Emitted by | Key fields |
|---|---|---|---|
| `readiness_check_failed` / `readiness_check_recovered` | warn / info | `ReadinessRegistry`, on a check's state CHANGE only (not per probe) | `check=`, failure |
| `db_pool_idle_client_error` | warn | `DbService` pool | failure |
| `outbox_publish_failure` | warn (via `onError`) | `OutboxRelay`, per failed publish | `eventId= name= correlationId= attempt= ageSeconds= retryInMs=`, failure |
| `outbox_relay_pass_failure` | warn (via `onError`) | `OutboxRelay`, a pass that failed (e.g. the claim query) | failure |
| `worker_drain_timeout` | warn | every `PollLoop` user (`onDrainTimeout`), incl. `worker=outbox_relay` | `worker= drainTimeoutMs=` |
| `rabbitmq_confirm_timeout` | warn | `RabbitMqEventBus` | `eventId=`, `name=` or `target=`, `timeoutMs=`, `outcome=unconfirmed` (may have been stored: not "failed") |
| `rabbitmq_consumer_lost` / `_reconnect_failed` / `_recovered` | warn / warn / info | consumer supervision | `queue=` |
| `rabbitmq_consumer_drain_timeout` | warn | consumer close | `queue= inFlight=` |
| `event_retry_scheduled` / `event_retry_exhausted` / `event_dead_lettered` | warn / warn / error | consumer failure path | `queue= event= correlationId=` ... |
| `service_shutdown_started` / `service_shutdown_complete` | info | `HealthModule` (Nest lifecycle) | `signal=` |
| `http_drain_timeout` | warn | `HealthModule` (`HttpDrain`), connections still open at the HTTP drain deadline | `drainTimeoutMs= openConnections=` |
| `rabbitmq_connection_abandoned` | warn (via `onNotice`) | `RabbitMqEventBus.close()`, the broker never answered the close within the bound: the transport was destroyed | `closeBoundMs=` |

**Graceful shutdown (Stage 15.5).** When shutdown starts (Nest's `onModuleDestroy`, the first hook), `HealthModule` marks the service
draining: `/ready` answers 503 (`shutting_down`), and `configureApp`'s first middleware (`shutdownAdmission`; Auth installs it itself)
refuses a new request with 503 and `Connection: close` (`/health` is still answered). The HTTP server stops accepting connections at
once. Requests already running may finish; after `HTTP_DRAIN_TIMEOUT_MS` (default 5000, 500-120000), every connection still open is
closed. No client, keep-alive or not, can extend this. Workers start draining at the same moment. `PollLoop.stop()` is idempotent: later
hooks await the same drain, so a hung pass costs one drain budget, not one per hook. The database pool and the broker close last, in
`onApplicationShutdown`.

**Broker connection disposal (Stage 15.5, F-H).** amqplib ends a connection with a half-close (`stream.end()`), and a silent broker never
completes it, so the socket would stay open (`FIN_WAIT2`) and keep Node's event loop alive. In a container Node is PID 1, and it would
never exit. The bus therefore **destroys the transport of every connection it gives up on**:
- a connection closed by an error (heartbeat timeout, socket error, a close forced by the broker);
- a `close()` the broker does not answer within the bound (3 × heartbeat); this also logs `rabbitmq_connection_abandoned`.

A clean close (close-ok from a healthy broker) keeps amqplib's graceful FIN.
- A closed connection is never reused; the next use opens a new one.
- `close()` has one deadline for the publisher channel and the connection together.
- Every bounded wait in `close()` and in a consumer's stop also ends as soon as the connection itself has closed.
- The destroy is the kit's only use of amqplib's undocumented `ChannelModel.connection.stream` (the net/tls socket), in
  `destroyTransport()`, guarded, and pinned by `rabbitmq-transport-disposal.int-spec` (amqplib 2.0.1).

`onNotice(message, level)` passes the level above; `onError(message)` for the relay is one level (the services log it at warn).
Services add their own worker signals in the same shape (`*_pass_failure` with the failure, `webhook_retry_exhausted`, ...) and a
`service_started` line (`port`, `environment`, no configuration values).

`nawara-check-outbox-lag --database-url <url> [--max-age-seconds 60]` prints `pending`, `oldest pending age`, `retrying` (pending rows
that already failed a publish), `max attempts`, and the oldest pending row's `id`/`name`/`attempts`/`nextAttemptAt` and last recorded
error (class and redacted message, never a payload). Exit `0` when no pending row is older than the threshold, `1` when one is or
when the check itself fails (connect is bounded at 10 s). Retries stay unlimited: a high `max attempts` with an old row means an event
has been retrying for a long time, not a brief broker blip. `nawara-migrate` prints a line when it has to wait for another runner's
migration lock (the wait itself is unchanged).

## Not in the kit (yet)

OpenAPI setup, outbox pruning, alerting on the dead-letter queue (the tools below read it; nothing here pages anyone), and any service-specific configuration. RabbitMQ is **not** deployed to production; the kit runs against a local broker.

`RabbitMqEventBus` requests its own AMQP heartbeat (`heartbeatS`, default 10 s; services configure `RABBITMQ_HEARTBEAT_S`, 5-60).
The negotiated value is the smaller of this and the broker's proposal, or this one when the broker turns heartbeats off, so a silent
broker is detected within about 3 heartbeats whatever the broker's configuration: the connection is torn down and every channel
operation still waiting on it (channel open, declare, consume, cancel) fails (`kind=broker_connection_lost`). Closing is bounded by the
same 3 heartbeats: amqplib never settles a close whose connection dies mid-close, so the bus stops waiting and never reuses that
connection (Stage 15.3, invariant I9).

`RabbitMqEventBus` consumers are supervised: `subscribe()` fails fast when the broker is unreachable at start, but once attached a consumer that loses its connection, its channel or its queue is re-created with bounded exponential backoff (`consumerReconnect`) until `close()`. `consumerStatus()` reports `consuming` / `reconnecting` for readiness, and `onNotice` receives `rabbitmq_consumer_lost` / `rabbitmq_consumer_recovered` / `rabbitmq_settle_failed` (never a URL or credential). A message being handled when the channel dies is redelivered by the broker, so handlers must stay idempotent. `BrokerProxy` (`@nawara/service-kit/testing`) severs and restores a broker connection in tests.

## Tests

```bash
npm test -w @nawara/service-kit                      # unit: no external services
TEST_DATABASE_ADMIN_URL=postgres://postgres:pw@127.0.0.1:5432/postgres \
TEST_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672 \
  npm run test:integration -w @nawara/service-kit    # real PostgreSQL and RabbitMQ
```

Locally a missing service skips its integration suite with a notice. With `CI=true` a missing service is a **failure**, so CI can never silently skip what it claims to cover.

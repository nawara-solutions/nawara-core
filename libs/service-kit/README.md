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
* A failing consumer dead-letters the message (`<queue>.dead`); nothing is dropped silently or retried in a hot loop.
* An event published while **no queue is bound** is dropped by the broker (normal topic-exchange behaviour): consumers must declare their queue before events matter.

## Not in the kit (yet)

Rate limiting, OpenAPI setup, a retry/delay policy for consumers beyond the dead-letter queue, outbox pruning, and any service-specific configuration. RabbitMQ is **not** deployed to production; the kit runs against a local broker.

## Tests

```bash
npm test -w @nawara/service-kit                      # unit: no external services
TEST_DATABASE_ADMIN_URL=postgres://postgres:pw@127.0.0.1:5432/postgres \
TEST_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672 \
  npm run test:integration -w @nawara/service-kit    # real PostgreSQL and RabbitMQ
```

Locally a missing service skips its integration suite with a notice. With `CI=true` a missing service is a **failure**, so CI can never silently skip what it claims to cover.

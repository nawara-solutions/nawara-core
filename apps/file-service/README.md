# file-service

> **Status: foundation + persistence (Stages 17.2, 17.3).** A production-shaped service with health, readiness, service
> authentication, the caller policy and the `file` / `file_access_ticket` schema with its repositories. **No byte path yet:** no
> storage, no upload, download or ticket route (17.4–17.6).

Generic file objects for Nawara Core: products keep the business meaning and relationships (`StudentDocument.fileId`); File Service
owns immutable bytes, generic metadata, integrity, lifecycle, storage and controlled byte access. Design:
[ADR-0048](../../docs/adr/0048-file-service-architecture.md), [SDD](../../docs/sdd/file-service.md),
[Stage 17.1 decisions and roadmap](../../docs/architecture/stage-17/stage-17-1-decisions-and-roadmap.md),
[Stage 17.2 record](../../docs/architecture/stage-17/stage-17-2-service-foundation.md),
[Stage 17.3 record](../../docs/architecture/stage-17/stage-17-3-persistence-metadata.md).

## What exists (17.2 foundation)

| Capability | From the kit |
|---|---|
| Bootstrap, bounded JSON body (parses `application/json` only: raw upload bodies will stream untouched), DTO whitelist, secure headers, CORS off by default | `configureApp` |
| Structured JSON logs (`ts`, `level`, `service`, `msg`, `requestId`, `correlationId`), credential redaction; no access log (no request path is ever logged) | `JsonLogger` |
| `x-request-id` / `x-correlation-id` accepted when safe, generated otherwise, echoed | `requestContextMiddleware` |
| Uniform error body `{ statusCode, message, error, code?, requestId }`; an unexpected error is an opaque 500 | `KitExceptionFilter` |
| `GET /health` (liveness) and `GET /ready` (readiness: `database` + `migrations`), at the root | `HealthModule`, `DbModule` |
| SIGTERM / SIGINT: `/ready` 503 and new requests refused, running requests drained within `HTTP_DRAIN_TIMEOUT_MS`, the pool closed last, exit | `HttpDrain` (Stage 15.5) |
| Service-token authentication (`SERVICE_TOKENS`); the caller is always the token's service | `ServiceAuthModule` |
| `FILE_SERVICE_POLICY`: per-caller operations, organization mode, media types and size ceiling, deny by default, validated at startup | this service |

**Persistence (17.3):** `db/migrations/0001_file_schema.sql` (metadata only, never bytes) and `src/persistence/`: `FileRepository`
(`createUploading`, the owner- and organization-scoped `findOwned`; no unscoped lookup), `TicketRepository` (digest-only tickets:
`recordDownload`, `recordUpload`, the atomic `claimUse`, issuer-scoped `revoke`, transactional `revokeAllForFile`), the storage-key
generator and the ticket digest. The lifecycle transitions arrive with the stages that own their storage side.

**Not here, by design (ADR-0048):** no call to Auth or to any product service; object storage is not a readiness dependency (and there
is no storage until 17.4); no RabbitMQ; no user JWT; no worker.

## Configuration

| Variable | Default | Bounds | Notes |
|---|---|---|---|
| `NODE_ENV` | `production` | `development`, `test`, `production` | unset means production (the safe behaviour) |
| `PORT`, `LOG_LEVEL`, `BODY_LIMIT_KB`, `CORS_ORIGINS`, `TRUST_PROXY`, `HTTP_DRAIN_TIMEOUT_MS` | kit defaults | kit bounds | the Core HTTP baseline |
| `DATABASE_URL` | **required** | `postgres:` / `postgresql:` | the runtime role `file_app`; production refuses `postgres`, `root` and `*_migrator` |
| `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | 10, 5000, 30000, 60000, statement + 5000 | kit bounds | |
| `MIGRATION_DATABASE_URL` | – | | the migrator, read only by `npm run migrate` |
| `SERVICE_TOKENS` | empty | `<caller>:<sha256 hex>`, ≤ 2 per caller | empty refuses every service-token call |
| `FILE_SERVICE_POLICY` | empty | `{"callers": {…}}` | required once `SERVICE_TOKENS` registers a caller; see below |
| `FILE_MAX_BYTES` | 26214400 (25 MiB) | 1 – 104857600 (100 MiB) | the global ceiling; every caller's `maxBytes` must be ≤ it; enforced on uploads from 17.5 |

`FILE_SERVICE_POLICY`:

```json
{ "callers": {
    "core-drive":        { "operations": ["upload", "read", "attach", "delete", "issue_ticket"], "organizations": "request",
                           "mediaTypes": ["application/pdf", "image/jpeg"], "maxBytes": 10485760 },
    "core-notification": { "operations": ["read"], "organizations": "none" } } }
```

Operations: `upload`, `read`, `attach`, `delete`, `issue_ticket`. `mediaTypes` (a subset of `application/pdf`, `image/jpeg`,
`image/png`, `image/webp`, `image/heic`, `image/heif`) and `maxBytes` are required exactly when the caller may `upload` or
`issue_ticket`. Unknown properties, operations or types, a wildcard, or a `maxBytes` above `FILE_MAX_BYTES` stop the process.

## Run

```bash
npm run build -w @nawara/service-kit && npm run build -w file-service
MIGRATION_DATABASE_URL=postgres://file_migrator:…@host/file npm run migrate -w file-service   # the kit baseline + the file schema
npm run start:prod -w file-service                                                             # or: docker compose --profile db up -d file-service
npm test -w file-service                                                                       # unit
TEST_DATABASE_ADMIN_URL=postgres://postgres:…@127.0.0.1:5433/postgres npm run test:e2e -w file-service
```

The production image (`apps/file-service/Dockerfile`, repo-root context) is two stages with production dependencies only; it runs as
the non-root `node` user with Node as PID 1. Compose gives it a 60 s stop grace. An existing local PostgreSQL volume predates the
`file` database (the init script runs only on an empty volume): add the `FILE_*` passwords from `.env.example` and recreate the volume,
or provision it by hand as `infra/postgres/init/01-service-databases.sh` does.

## Next (Stage 17 roadmap)

| Stage | Adds |
|---|---|
| 17.3 | ✅ the `file` and `file_access_ticket` tables, constraints, triggers, repositories |
| 17.4 | the storage port, filesystem and S3-compatible adapters |
| 17.5 | streamed upload, type from bytes, SHA-256, idempotency, attach, upload tickets |
| 17.6 | streamed download, safe headers, download tickets (issue, redeem, revoke) |
| 17.7 | delete, orphan cleanup, reconciliation |
| 17.8 / 17.9 / 17.10 | security and integrity, operational hardening, focused certification |

# file-service

> **Status: the complete V1 lifecycle (Stages 17.2–17.9), certified in Stage 17.10.** Services upload, read and delete their own files
> and issue upload / download tickets; clients redeem tickets directly (no user token, no call to Auth); bounded workers remove deleted
> bytes, abandoned uploads, expired temporary files, old tickets and expired limiter windows. Production enablement still needs the
> prerequisites of the [17.10 record](../../docs/architecture/stage-17/stage-17-10-focused-certification.md) §10 (storage provider,
> malware decision, backup / DR, alert routing, …). **No malware scanning exists** (Stage 17.8 decision B): a valid PDF or image may still
> carry malicious content.

Generic file objects for Nawara Core: products keep the business meaning and relationships (`StudentDocument.fileId`); File Service
owns immutable bytes, generic metadata, integrity, lifecycle, storage and controlled byte access. Design:
[ADR-0048](../../docs/adr/0048-file-service-architecture.md), [SDD](../../docs/sdd/file-service.md),
[Stage 17.1 decisions and roadmap](../../docs/architecture/stage-17/stage-17-1-decisions-and-roadmap.md),
[Stage 17.2 record](../../docs/architecture/stage-17/stage-17-2-service-foundation.md),
[Stage 17.3 record](../../docs/architecture/stage-17/stage-17-3-persistence-metadata.md),
[Stage 17.4 record](../../docs/architecture/stage-17/stage-17-4-storage-abstraction.md),
[Stage 17.5 record](../../docs/architecture/stage-17/stage-17-5-upload-lifecycle.md),
[Stage 17.6 record](../../docs/architecture/stage-17/stage-17-6-download-authorization.md),
[Stage 17.7 record](../../docs/architecture/stage-17/stage-17-7-delete-cleanup-lifecycle.md),
[Stage 17.8 record](../../docs/architecture/stage-17/stage-17-8-security-integrity.md),
[Stage 17.9 record](../../docs/architecture/stage-17/stage-17-9-operational-hardening.md),
[Stage 17.10 certification](../../docs/architecture/stage-17/stage-17-10-focused-certification.md), [runbook](../../docs/runbooks/file-service.md).

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

**Storage (17.4):** `src/storage/`: `StoragePort` (`put` / `get` / `head` / `delete`, streams only, never overwrites, idempotent
delete, neutral `StorageError`s), `FilesystemStorage` (development and tests; refused in production) and `S3Storage` (any
S3-compatible provider by configuration; the production provider is not chosen yet), selected once by `FILE_STORAGE_PROVIDER`. Object
storage is never a readiness check.

**Upload (17.5):** `src/upload/`: `POST /file/uploads/tickets` (service, `issue_ticket`), `PUT /file/t/{token}` (the ticket
holder; single-use), `POST /file/files` (service, `upload`, idempotent), `POST /file/files/{id}/attach` (service, `attach`). Raw
streamed bodies with a required `Content-Length`; the type from the bytes (PDF, JPEG, PNG, WebP, HEIC, HEIF); SHA-256 while
streaming; OpenAPI at `/file/docs` when `SWAGGER_PASSWORD` is set.

**Download (17.6):** `src/download/`: `GET /file/files/{id}` and `GET /file/files/{id}/content` (owner, `read`),
`POST /file/files/{id}/tickets` (owner, `issue_ticket`; reusable until expiry and at most `FILE_TICKET_MAX_DOWNLOADS` uses, unless `singleUse`), `DELETE /file/tickets/{ticketId}`
(issuer), `GET /file/t/{token}` (the ticket holder). Streamed with backpressure; `attachment`, `private, no-store`, `nosniff`, a sandbox
CSP; no Range, no HEAD.

**Delete and cleanup (17.7):** `DELETE /file/files/{id}` (owner, `delete`; logical: DELETING + tickets revoked, `202`,
idempotent); `src/cleanup/`: one bounded worker loop (orphan expiry, physical delete with lease + fence + backoff, upload-lease sweep,
ticket retention); `npm run reconcile -- [--repair]` (the operator tool: reports missing objects, removes leftovers of failed rows).

**Not here, by design (ADR-0048):** no call to Auth or to any product service; object storage is not a readiness dependency; no RabbitMQ
(outbox events wait for Stage 18); no user JWT; no malware scanner (decision B); no public or presigned URL, Range, multipart or versions.

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
| `FILE_STORAGE_PROVIDER` | **required** | `filesystem`, `s3` | no default, no fallback; `filesystem` is refused in production |
| `FILE_STORAGE_ROOT` | – (filesystem) | absolute | the development / test directory |
| `FILE_S3_ENDPOINT`, `FILE_S3_REGION`, `FILE_S3_BUCKET`, `FILE_S3_ACCESS_KEY_ID`, `FILE_S3_SECRET_ACCESS_KEY` (`*_FILE`), `FILE_S3_FORCE_PATH_STYLE` | – (s3) | https in production | the S3-compatible store; credentials never logged |
| `FILE_STORAGE_KEY_PREFIX`, `FILE_STORAGE_*_TIMEOUT_MS`, `FILE_STORAGE_MIN_THROUGHPUT_BYTES_PER_SECOND`, `FILE_STORAGE_MAX_ATTEMPTS` | `files`, 2 s / 45 s (idle, since 17.9) / 10 s, 64 KiB/s, 3 | see the [17.4 record](../../docs/architecture/stage-17/stage-17-4-storage-abstraction.md) §3 | |
| `FILE_PUBLIC_BASE_URL` | **required** | https in production | ticket URLs are `<base>/file/t/<token>` |
| `FILE_REQUEST_HASH_KEY`, `FILE_RATE_LIMIT_KEY` (`*_FILE`) | **required** | base64, ≥ 32 bytes, different | the service-upload request hash; the keyed client address of the redemption limiter |
| `FILE_UPLOAD_TICKET_TTL_SECONDS`, `FILE_ATTACH_TTL_SECONDS`, `FILE_UPLOAD_IDLE_TIMEOUT_MS`, `FILE_TICKET_FAILURE_LIMIT` | 120 s, 24 h, 30 s, 20/min | see the [17.5 record](../../docs/architecture/stage-17/stage-17-5-upload-lifecycle.md) §12 | |
| `SWAGGER_USERNAME`, `SWAGGER_PASSWORD` | `docs`, unset | password ≥ 16 | OpenAPI at `/file/docs` (basic auth) only when set |
| `FILE_DOWNLOAD_TICKET_TTL_SECONDS`, `FILE_DOWNLOAD_IDLE_TIMEOUT_MS` | 120 s, 30 s | 60–300 s, 1–120 s | download tickets; a client that stops reading is cut off |
| `FILE_CLEANUP_ENABLED`, `FILE_CLEANUP_INTERVAL_MS`, `FILE_CLEANUP_BATCH_SIZE`, `FILE_DELETE_CONCURRENCY`, `FILE_DELETE_LEASE_SECONDS`, `FILE_DELETE_RETRY_BASE_SECONDS` / `_MAX_SECONDS`, `FILE_TICKET_RETENTION_SECONDS` | true, 30 s, 20, 4, 300 s, 30 s / 1 h, 24 h | see the [17.7 record](../../docs/architecture/stage-17/stage-17-7-delete-cleanup-lifecycle.md) §10 | the cleanup workers |
| `FILE_{UPLOAD,TICKET,DOWNLOAD}_RATE_PER_CALLER` / `_PER_ORGANIZATION`, `FILE_TICKET_MAX_DOWNLOADS`, `FILE_UPLOAD_MAX_IN_FLIGHT` | 600 / 120, 1200 / 300, 1200 / 300 per min; 50; 64 | see the [17.8 record](../../docs/architecture/stage-17/stage-17-8-security-integrity.md) §4 | usage limits (F32), reusable-ticket cap, per-process upload bound |
| `FILE_DOWNLOAD_MAX_IN_FLIGHT`, `FILE_DOWNLOAD_MIN_THROUGHPUT_BYTES_PER_SECOND`, `FILE_S3_MAX_SOCKETS` | 64, 16 KiB/s, 96 | see the [17.9 record](../../docs/architecture/stage-17/stage-17-9-operational-hardening.md) §17 | per-process download bound (`503 download_busy`), whole-transfer download deadline, S3 socket pool per client (checked against the bounds at boot) |
| `FILE_OPS_REPORT_INTERVAL_MS`, `FILE_CLEANUP_MAX_BATCHES_PER_PASS`, `FILE_CLEANUP_PURGE_BATCH_SIZE`, `FILE_REQUEST_HASH_PREVIOUS_KEYS` | 60 s, 10, 500, empty | 17.9 record §17 | the operational snapshot, cleanup drain mode, request-hash key rotation |

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
docker compose --profile storage-test up -d s3-test                                             # the S3-protocol TEST server (Stage 17.4)
TEST_DATABASE_ADMIN_URL=postgres://postgres:…@127.0.0.1:5433/postgres \
  TEST_S3_ENDPOINT=http://127.0.0.1:9000 TEST_S3_ACCESS_KEY_ID=… TEST_S3_SECRET_ACCESS_KEY=… npm run test:e2e -w file-service
# Stage 17.9 operational probes (slow, measurements; never part of test / test:e2e): the BUILT service, same environment variables
OPS_REPORT=/tmp/file-ops.txt npm run test:ops -w file-service
```

Operations: signals, alert conditions and procedures are in the runbook [docs/runbooks/file-service.md](../../docs/runbooks/file-service.md);
the measured envelope is in the [Stage 17.9 record](../../docs/architecture/stage-17/stage-17-9-operational-hardening.md).

The production image (`apps/file-service/Dockerfile`, repo-root context) is two stages with production dependencies only; it runs as
the non-root `node` user with Node as PID 1. Compose gives it a 60 s stop grace. An existing local PostgreSQL volume predates the
`file` database (the init script runs only on an empty volume): add the `FILE_*` passwords from `.env.example` and recreate the volume,
or provision it by hand as `infra/postgres/init/01-service-databases.sh` does.

## Next (Stage 17 roadmap)

| Stage | Adds |
|---|---|
| 17.3 | ✅ the `file` and `file_access_ticket` tables, constraints, triggers, repositories |
| 17.4 | ✅ the storage port, filesystem and S3-compatible adapters |
| 17.5 | ✅ streamed upload, type from bytes, SHA-256, idempotency, attach, upload tickets |
| 17.6 | ✅ streamed download, safe headers, download tickets (issue, redeem, revoke) |
| 17.7 | ✅ delete, orphan cleanup, reconciliation |
| 17.8 | ✅ security and integrity |
| 17.9 | ✅ operational hardening: measured envelope, download bound, idle / deadline fixes, drain mode, signals, runbook |
| 17.10 | ✅ focused certification: invariant matrix, integrated probes, one 17.9 defect fixed (idle re-arm listener growth), closure verdict |

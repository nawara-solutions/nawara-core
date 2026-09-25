# Stage 17.5 — File upload lifecycle

- **Status:** merged (PR #109); certified with the whole of Stage 17 in [17.10](./stage-17-10-focused-certification.md).
- **Scope:** the first path by which untrusted bytes enter File Service: upload-ticket issuance by a trusted service, ticket
  redemption by an untrusted client, service upload (Option A), attach; streaming ingestion with size enforcement, type detection
  from the bytes, SHA-256, storage through `StoragePort`, the lifecycle transitions, idempotency, failure semantics, abuse bound,
  OpenAPI.
- **Not in scope (and not present):** downloads, download tickets, metadata reads, ticket revocation route, delete (17.6 / 17.7);
  the lease sweep, orphan cleanup, reconciliation (17.7); malware scanning (F19); a production storage provider (O2 / F6).
- **Frozen design followed:** [ADR-0048](../../adr/0048-file-service-architecture.md), [SDD §3, §5, §7, §8, §10, §11, §13, §14](../../sdd/file-service.md),
  [Stage 17.1](./stage-17-1-decisions-and-roadmap.md) (F8, F12, F13, F14, F16, F18, F22, F29, F32, F35, F36), the 17.3 schema, the
  17.4 port. No decision reopened.

## 1. Baseline and three reconciliations with the frozen design

`main` at `9da00dc` (Stage 17.4 merged, PR #108). Three points of the stage brief differ from the merged architecture; the merged
architecture was followed (as the brief instructs) and each is recorded here:

1. **The file row is created at redemption, not at intent.** The 17.3 schema forbids an upload ticket from naming a file at insert,
   and SDD §3 / §11.1 define the upload ticket as an INTENT (organization, size, types, attach flag) that records the one file it
   creates, once. An issued-but-unused ticket therefore creates nothing (no orphan row, nothing to clean up).
2. **Idempotency keys belong to the service upload** (`POST /file/files`, SDD §10: `Idempotency-Key` + keyed request hash), not to
   ticket issuance. Ticket issuance is deliberately NOT idempotent: a replay could only return a new ticket (the raw token is never
   stored and must not become recoverable), and since issuance creates no file, a duplicate issuance creates only a second
   short-lived capability that expires unused. The redemption itself is idempotent in the frozen sense: the retry of a completed
   redemption returns the created file.
3. **The upload-lease sweep moves to 17.7.** The 17.1 roadmap row lists it under 17.5; SDD §12 lists it under 17.7 cleanup; the stage
   brief excludes workers. Rows left `UPLOADING` by a crash wait for 17.7 (§9).

## 2. Routes and trust boundary

| Route | Actor | Authorization | Purpose |
|---|---|---|---|
| `POST /file/uploads/tickets` `{ organizationId?, maxBytes, mediaTypes, attach? }` | trusted service | service token + policy `issue_ticket` | issue a single-use upload ticket → `201 { ticketId, url, expiresAt }` |
| `PUT /file/t/{token}` (raw body) | **untrusted client** | the ticket only (no user token, no call to Auth) | redeem: stream one file → `201` file (a retry after completion: `200`, same file) |
| `POST /file/files` (raw body; `Idempotency-Key`, `Content-Length`, optional `X-Organization-Id`, `X-File-Name`, `Content-Type`, `Content-Digest`, `X-Attach`) | trusted service | service token + policy `upload` | upload its own file (Option A) → `201` (replay `200`) |
| `POST /file/files/{id}/attach` (optional `X-Organization-Id`) | trusted service | service token + policy `attach` | mark its file attached, idempotently → `200` |

- **Owner:** always the authenticated caller (service routes) or the ticket's issuer (redemption). No request field can set it: the
  DTO whitelist refuses an `ownerService` property (400) and headers such as `X-Owner-Service` are ignored (tested).
- **Organization:** optional (platform files). A caller with `organizations: none` sending one is `403 organization_not_allowed`.
  File Service never verifies an organization with Auth or Organization.
- **Policy at issuance:** `maxBytes` ≤ the caller's `maxBytes` (`403 max_bytes_not_allowed`), `mediaTypes` ⊆ the caller's
  (`403 media_type_not_allowed`), types from the V1 allow-list (`400`).
- **Policy at redemption:** the issuer must STILL hold `issue_ticket` (and its organization mode) in the current policy; the effective
  limit is min(`FILE_MAX_BYTES`, the issuer's policy, the ticket) and the allowed types are the ticket's ∩ the policy's.
- **Headers:** every upload / ticket route answers with `Connection: close` (an early refusal never makes the server read and discard
  a large unread body to keep the connection alive) and `Cache-Control: no-store`; helmet sends `Referrer-Policy: no-referrer`.

## 3. Tickets

- **Generation:** 32 bytes from `crypto.randomBytes` (256 bits), base64url (43 characters), returned ONCE inside
  `url = <FILE_PUBLIC_BASE_URL>/file/t/<token>`. Stored: SHA-256 of the token string only (17.3 schema; no HMAC, no key, F35).
- **Lifetime:** `FILE_UPLOAD_TICKET_TTL_SECONDS`, default **120 s** (bounds 60–300, F16; the schema enforces the same). The lifetime
  bounds the START of an upload (the claim), not the transfer.
- **Single use — the consumption point:** the redemption's transaction begins with ONE conditional statement
  (`UPDATE … SET "useCount" = "useCount" + 1 WHERE "tokenDigest" = $1 AND operation = 'upload' AND "revokedAt" IS NULL AND
  "expiresAt" > now() AND (NOT "singleUse" OR "useCount" = 0)`), then, in the same transaction, checks the issuer's current policy
  and the declared size, creates the `UPLOADING` row and binds it to the ticket. **The ticket is consumed when that transaction
  commits**, before any byte is read. A policy or size refusal rolls the transaction back (the ticket stays usable).
- **Concurrency:** two claims serialize on the row lock; PostgreSQL re-evaluates the second's condition after the first commits, so it
  fails. Tested: 20 concurrent redemptions → exactly one `201`; the others `409 upload_in_progress` or `200` (the finished file);
  one file, one object.
- **After consumption:** a storage failure, a refusal or a disconnect ends the file `FAILED` / `REJECTED`; the ticket stays spent (no
  second write, no unlimited retries with one capability); the product issues a new ticket. The retry of a COMPLETED redemption
  (the client lost the response) returns the created file (`200`, SDD §11.1), writing nothing; a retry while it is in progress is
  `409 upload_in_progress`. The same raw ticket can never upload twice.
- **Failures:** unknown, malformed, expired, revoked, used-then-failed, and a download ticket presented for upload are ONE response
  (`404 { code: "ticket_invalid" }`, identical bodies apart from the request id). A download ticket is never consumed by an upload
  (the claim filters the operation).
- **Leakage:** the token lives only in the path; no log line holds it, its digest, a ticket path or a storage key (tested on every
  log line of the suite); the kit logs no request paths.

## 4. Abuse bound (F32, the 17.5 part)

Failed redemptions (`ticket_invalid`) count per client: the address (`req.ip`, honouring `TRUST_PROXY`) is keyed with
`FILE_RATE_LIMIT_KEY` (HMAC-SHA-256) before it reaches the kit limiter (the D21 lesson: an unkeyed IPv4 digest is reversible). Over
`FILE_TICKET_FAILURE_LIMIT` (default 20) per minute, EVERY redemption from that client is `429 rate_limited`, valid or not: a limiter
that only refused failures would tell a blocked client which of its tickets are valid. This needed a generic `peek` on the kit
limiter (read the window without counting). Deferred to 17.8: per-caller issuance limits, per-organization limits, retention of
expired limiter rows (windows reset on their own).

## 5. Streaming pipeline

```text
PUT / POST body (raw, Content-Length required)
   │  411 without Content-Length (chunked); 413 when it exceeds the limit — before a byte is read
   ▼
head window: read ≤ 4 KiB (+ at most one chunk) ─► type decided from the bytes (allow-list) ─► declared type / extension must agree
   │                                                    415 unsupported_media_type          422 media_type_mismatch
   ▼
replay the head, then the rest ─► Meter: count every byte (the limit, again), SHA-256 incrementally
   ▼
StoragePort.put(key, stream, { sizeBytes: Content-Length, contentType: detected, sha256: Content-Digest?, signal })
   │  the store publishes a complete, exactly-sized object or nothing (17.4: VerifiedBody, atomic publish, If-None-Match / link)
   ▼
UPDATE file SET status = 'AVAILABLE', mediaType, sizeBytes, sha256, availableAt … WHERE id = $1 AND status = 'UPLOADING'
```

- **Backpressure:** the request is read only as fast as the store accepts (async iteration + `pipeline`); nothing reads ahead.
- **Memory:** a 20 MiB upload through the real application held < 12 MiB of live buffers, client and server together (forced
  collections between samples; a buffering implementation holds the whole file).
- **Cancellation:** a client disconnect (`close` before the body completed) or `FILE_UPLOAD_IDLE_TIMEOUT_MS` (default 30 s) without a
  byte aborts the signal: the store stops and publishes nothing; the row ends `FAILED` (`client_aborted` / `upload_timeout`).
- **Timeouts (three bounds):** idle 30 s per upload (stalled or malicious slow streams); the store's whole-transfer deadline
  (17.4: 10 s + size at 64 KiB/s); Node's server-wide `requestTimeout`, raised from 300 s to that deadline for `FILE_MAX_BYTES` + 60 s
  (a legitimate 25 MiB upload on a slow link needs ~410 s).

## 6. Size

`FILE_MAX_BYTES` (25 MiB default, ≤ 100 MiB) ∧ the caller's `maxBytes` ∧ the ticket's `maxBytes`. `Content-Length` is REQUIRED
(SDD §7): absent or chunked → `411 length_required`; over the limit → `413 file_too_large` from the header alone. The bytes are
counted independently while streaming (the Meter refuses the byte past the limit) and the store refuses any body not exactly
`Content-Length` long. HTTP framing makes the body exactly `Content-Length` bytes; a body that ends early is a disconnect (`FAILED
client_aborted`). Exact limit: accepted; one byte over: refused (tested).

## 7. Type detection (F13)

An explicit allow-list of signatures, decided on the first 4 KiB: `%PDF-` at offset 0; JPEG `FF D8 FF`; the 8-byte PNG signature;
`RIFF….WEBPVP8[ LX]`; HEIF by its leading ISO-BMFF `ftyp` box. **No detection dependency was added:** six signatures are small and
auditable, and a general detector would parse untrusted containers (ZIP / Office / …) only to reach a refusal the allow-list gives
for free. **HEIC:** the `ftyp` box must be the first box, complete within the window, sanely sized, with aligned brands; major brand
`heic`/`heix`/`heim`/`heis` → `image/heic`; major `mif1` → `image/heic` when an HEVC brand is compatible, else `image/heif`; image
sequences (`hevc`, `msf1`), AVIF and video brands are refused. This is a structural header check (as for every type), not a decode.
**Declared vs detected:** the stored `mediaType` is ALWAYS the detected type; the declared `Content-Type` and the name's extension are
hints that must agree (aliases such as `image/jpg` agree; `application/octet-stream` asserts nothing) or `422 media_type_mismatch`.
**Signature validation is not malware scanning** (F19): a malicious PDF or image, or a polyglot whose prefix is an allowed
signature, passes; downloads will be served as attachments with `nosniff` and a sandbox CSP (17.6).

## 8. Integrity, names, lifecycle

- **SHA-256** of exactly the accepted bytes, computed incrementally in the Meter; stored lowercase hex, set once (17.3). A client
  `Content-Digest` (service upload) is only a constraint, enforced by the store before publishing (`422 checksum_mismatch`). No
  deduplication.
- **Names:** `X-File-Name`, percent-encoded UTF-8, sanitized (SDD §8: NFC; controls, bidi controls, separators removed; 255 bytes
  keeping the extension); presentation only; never a path, never logged.
- **Lifecycle:** created `UPLOADING` → `AVAILABLE` (after the store published) or `REJECTED` (`file_too_large`,
  `unsupported_media_type`, `media_type_mismatch`, `checksum_mismatch`) or `FAILED` (`client_aborted`, `upload_timeout`,
  `upload_incomplete`, `storage_unavailable`, `storage_timeout`, `storage_rejected`, `storage_already_exists`, `finalize_failed`).
  `VERIFYING` is skipped (no scanner). Each transition is conditional on `UPLOADING`; the schema forbids everything else.
- **Temporary / attached:** a new file has `attachDeadline` = now + `FILE_ATTACH_TTL_SECONDS` (24 h); the owner attaches it
  (`POST …/attach`), or the ticket's `attach: true` attaches on completion, or a service upload with `X-Attach: true` creates it
  attached. Expiry of unattached files is 17.7.
- **Idempotency (service upload):** `requestHash` = HMAC-SHA-256(`FILE_REQUEST_HASH_KEY`, canonical JSON of the declared metadata:
  organization, name, declared type, length, client digest). Same key + same declaration → the same file (`200`, bytes not stored
  again); different → `422 idempotency_key_reused`; in progress → `409 upload_in_progress`; a `FAILED` / `REJECTED` attempt frees the
  key (17.3 partial unique index). Concurrent duplicates: one file (tested).

## 9. Crash windows (database and storage never share a transaction)

| Window | Database | Storage | Client retry | Ticket | Later (17.7) |
|---|---|---|---|---|---|
| A. claim committed (row `UPLOADING`), process dies before the store | `UPLOADING` | nothing | a new ticket (this one is spent) | consumed | lease sweep → `FAILED` |
| B. during the PUT | `UPLOADING` | nothing (a PUT publishes atomically; filesystem: a `.tmp` leftover) | a new ticket | consumed | lease sweep; `.tmp` cleanup |
| C. object published, process dies before finalization | `UPLOADING` | complete object | a new ticket | consumed | lease sweep → `FAILED` + delete the object |
| D. finalization fails (database error) | `FAILED finalize_failed` (best effort) | removed (best effort) | a new ticket | consumed | if either best effort failed: C |
| E. client disconnects after completion | `AVAILABLE` | the object | the same ticket → `200`, the same file | consumed | nothing |

`storage_timeout` on a PUT leaves the outcome unknown: the adapter's idempotent `delete` removes a possibly landed object. Service
uploads behave the same with the Idempotency-Key in place of the ticket (a `FAILED` attempt can be retried with the same key).

## 10. Errors (stable codes; SDD §14)

`ticket_invalid` 404 · `rate_limited` 429 · `length_required` 411 · `file_too_large` 413 · `unsupported_media_type` 415 ·
`media_type_mismatch` 422 · `checksum_mismatch` 422 · `idempotency_key_reused` 422 · `upload_in_progress` 409 · `file_not_found` 404
· `file_not_available` 409 · `operation_not_allowed` / `organization_not_allowed` / `max_bytes_not_allowed` / `media_type_not_allowed`
403 · `validation_error` 400 · `upload_aborted` 400 · `upload_incomplete` 400 · `upload_timeout` 408 · `storage_unavailable` 503 ·
`storage_error` 500 · `upload_failed` 500. No response carries a storage key, path, bucket, endpoint, provider error, stack,
database error, ticket digest or token (tested). The kit's status texts gained 408 / 411 / 415.

## 11. Observability

One log line per upload: `file_upload route=<ticket|service> outcome=<available|failureCode> file=<id> owner=<service>
duration_ms=… [media=<type> size=<bucket>]`, plus `file_upload_ticket_issued owner=… ticket=<id> ttl_s=…` and the 17.4
`storage_op` lines. Bounded values only (size buckets `le_100k` / `le_1m` / `le_10m` / `gt_10m`); never a token, digest, key, name,
content, header value, endpoint or organization.

## 12. Configuration (added)

| Variable | Default | Rule |
|---|---|---|
| `FILE_PUBLIC_BASE_URL` | **required** | https in production; no credentials, query, fragment or trailing slash |
| `FILE_REQUEST_HASH_KEY` | **required** | base64, ≥ 32 bytes |
| `FILE_RATE_LIMIT_KEY` | **required** | base64, ≥ 32 bytes, different from the request-hash key |
| `FILE_UPLOAD_TICKET_TTL_SECONDS` | 120 | 60–300 |
| `FILE_ATTACH_TTL_SECONDS` | 86 400 | 300–2 592 000 |
| `FILE_UPLOAD_IDLE_TIMEOUT_MS` | 30 000 | 1 000–120 000 |
| `FILE_TICKET_FAILURE_LIMIT` | 20 / min | 1–1 000 |
| `SWAGGER_USERNAME` / `SWAGGER_PASSWORD` | `docs` / unset | OpenAPI at `/file/docs` behind basic auth, only when set (16+) |

## 13. Evidence

- **Unit:** 212 in 7 files (upload 54 new: signatures incl. HEIC variants and 25 adversarial samples, names, headers, the request
  hash, the ingest pipeline; configuration 32 (+15 for 17.5); earlier suites unchanged).
- **E2E (real PostgreSQL 16; filesystem store; S3 on VersityGW):** 210 in 11 files: upload 37 and upload-on-S3 4 (new), foundation 24
  (routes, OpenAPI), built process 21 (+2 refusals), and every 17.2–17.4 suite (schema 46, repository 20, runtime role 4, health 5,
  storage filesystem 25, storage S3 19, S3 outages 5).
- **Kit:** the rate-limit integration suite (8, incl. `peek`) and the kit unit suite (132) pass; Notification's unit suite (311) passes.
- **Key results:** 20 concurrent redemptions → one upload; every invalid ticket → one identical 404; the raw token absent from the
  database and every log; `411` / `413` answered from the header with the ticket untouched; exact limit accepted; a disconnect or a
  stall → `FAILED`, no object, no temporary file; executables, ELF, HTML, SVG, archives, Office, random and empty bodies → `415`;
  a real PNG declared PDF / a real PDF named `.jpg` → `422`; a database failure at finalization → opaque 500, object removed, row
  `FAILED`; a storage outage → `503`, row `FAILED`, `/ready` 200; a 20 MiB upload in < 12 MiB of live buffers; blocked clients get
  `429` for valid and invalid tickets alike.
- **Mutations (17; all killed after one test was added):**

  | Mutation | Caught by |
  |---|---|
  | M1 the claim ignores single use | 21 E2E |
  | M2 the claim ignores expiry | 2 E2E |
  | M3 the claim ignores revocation | 5 E2E |
  | M4 the owner read from a request header | the spoofing test |
  | M5 the organization policy check removed | the policy test |
  | M6 the size check inside the claim removed (ticket consumed by an oversized declaration) | the size test |
  | M7 the streamed bytes not counted against the limit | **survived first**: the head check, the store's exact length and HTTP framing each stop an oversize body before the Meter does; a unit test now isolates the Meter (a lenient store, a body past the limit after the head window) and kills it |
  | M8 detection falls back to PDF | 30 unit + 13 E2E |
  | M9 SHA-256 skips the first chunk | 1 unit + 9 E2E |
  | M10 a failed upload marked AVAILABLE | 18 E2E |
  | M11 the raw ticket logged | the log scan |
  | M12 the whole file buffered before storing | 1 unit + 3 E2E (memory bound) |
  | M13 the idle / abort watch removed | the stall test |
  | M14 the idempotency conflict not detected | the replay / conflict test |
  | M15 a storage failure treated as success | 2 unit + 2 E2E |
  | M16 the limiter refuses only failures (an oracle) | the no-oracle test |
  | M17 the declared type ignored | 2 E2E (mismatch) |

- **Image:** production refuses a missing / plain-HTTP public URL, a missing request-hash key, the same key for both purposes, a TTL
  over 300 s, the filesystem store; boots with an unreachable store, ready 200; an upload then answers `503 storage_unavailable` and
  `/ready` stays 200; no docs without a password; a development container on the S3 test server round-trips a PDF (AVAILABLE, digest
  equal), replays it (200), refuses an executable named `.pdf` (415); uid 1000, Node PID 1, stop 61 ms exit 0, no secret in layers,
  no token, digest, key, password, name or storage key in the logs. Repository smoke passes.
- **Defect found (source hygiene):** invisible bidi control characters were written literally (not as escapes) in the 17.3 filename
  CHECK constraint and one 17.3 test, and first in this stage's sanitizer. Behaviour was correct (tested), but invisible characters in
  source are a Trojan-Source review hazard. The sanitizer and the test now use escapes; the migration is checksummed and forward-only,
  so it stays as is (allow-listed, with its reason); `check:repo` now refuses such characters anywhere in source.

## 14. Deferred

- **17.6:** downloads and download tickets (issue, redeem, revoke route), metadata read, the download-ticket TTL, `inline` rules,
  redemption limits for downloads.
- **17.7:** the upload-lease sweep (crash windows A–C), orphan (unattached) expiry, the delete worker, `.tmp` and object
  reconciliation, retention of expired tickets and limiter rows.
- **17.8:** per-caller / per-organization rate limits on issuance and uploads, the scanner hook (`VERIFYING`), filename / header
  fuzzing, threat-model verification.
- **17.9:** operational signals and snapshot, key rotation (request-hash and rate-limit keys: a previous-key window like
  Notification's), production image review.
- **Production enablement:** the storage provider (O2 / F6), the malware policy (F19), retention (F23), backup / DR (F34).

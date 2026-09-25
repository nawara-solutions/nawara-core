# Stage 17.6 — File download and authorization

- **Status:** merged (PR #110); certified with the whole of Stage 17 in [17.10](./stage-17-10-focused-certification.md).
- **Scope:** the controlled byte-read boundary: owner metadata and content for trusted services (Option A), short-lived download tickets
  (issue, redeem, revoke) for clients (Option C), safe response headers, streaming with backpressure and cancellation, integrity faults
  on read, the shared redemption abuse bound, OpenAPI.
- **Not in scope (and not present):** deletion and cleanup (17.7), a scanner (17.8), a production provider (O2 / F6), cross-service
  read delegation (`file_delegation`, with Notification attachments), public or presigned URLs, Range, HEAD.
- **Frozen design followed:** [ADR-0048](../../adr/0048-file-service-architecture.md) §7, [SDD §9, §11, §11.1, §13, §14](../../sdd/file-service.md),
  [Stage 17.1](./stage-17-1-decisions-and-roadmap.md) (F9, F15, F16, F35, F36; the 17.6 roadmap row), the 17.3 schema, the 17.4 port,
  the 17.5 ticket format. No decision reopened.

## 1. Baseline and reconciliations

`main` at `0bb440e` (Stage 17.5 merged, PR #109). Where the stage brief and the frozen design differ, the frozen design was followed:

1. **ETag:** SDD §9 freezes `ETag` = the SHA-256 of the content: the header is sent. Conditional GET (`If-None-Match` → 304) is not
   implemented (responses are `no-store`; nothing caches them).
2. **HEAD:** the brief allows deferring it; Express would otherwise answer HEAD with the GET handler, which would REDEEM a ticket (and
   consume a single-use one) only to send headers. HEAD is refused explicitly: `405` with `Allow: GET` on byte routes.
3. **Metadata read** (`GET /file/files/:id`) is a frozen V1 route (SDD §13, `read`) and is included (owner only).

## 2. Routes

| Route | Caller | Authorization | Answer |
|---|---|---|---|
| `GET /file/files/{id}` (`X-Organization-Id` when the file has one) | trusted service | service token + `read`; owner + organization in the lookup | `200` file metadata |
| `GET /file/files/{id}/content` | trusted service | service token + `read`; owner + organization in the lookup; `AVAILABLE` | `200` bytes, `attachment` |
| `POST /file/files/{id}/tickets` `{ operation: "download", disposition?, singleUse? }` | trusted service | service token + `issue_ticket`; owner + organization; `AVAILABLE`; `inline` for images only | `201 { ticketId, url, expiresAt }` |
| `DELETE /file/tickets/{ticketId}` | trusted service | service token + `issue_ticket`; issuer + organization | `204` (idempotent) |
| `GET /file/t/{token}` | **client** | the ticket only (no user token, no service token, no call to Auth) | `200` bytes of the bound file |

- **Owner:** always the authenticated caller; a header (`X-Owner-Service`) or query (`?ownerService=`) is ignored, a body property is
  refused (DTO whitelist). **Organization:** `X-Organization-Id`; a caller with `organizations: none` sending one is `403`.
- **Separate paths:** service routes accept only service tokens; the ticket route accepts only a ticket (no Authorization header is
  read); no route accepts either.
- **Non-disclosure:** a foreign, missing, malformed file id, another organization or a missing organization are the SAME
  `404 file_not_found` (one query: `id AND ownerService AND organizationId`). Only the owner learns a file's state
  (`409 file_not_available` for `UPLOADING` / `VERIFYING` / `REJECTED` / `FAILED`, `410 file_deleted` for `DELETING` / `DELETED`).
- **Generic:** no product route; the internal content route is what Notification attachments (later, with a delegation) and Billing
  PDFs will use, but nothing product-specific exists.

## 3. Download tickets

- **Format:** the 17.5 format: 32 CSPRNG bytes, base64url, in `<FILE_PUBLIC_BASE_URL>/file/t/<token>`, returned once; only the SHA-256
  digest is stored (F35).
- **Lifetime:** `FILE_DOWNLOAD_TICKET_TTL_SECONDS`, default **120 s** (60–300, F16; the schema enforces the bounds relative to the
  database clock). The caller cannot choose or extend it.
- **Binding:** operation `download`, exactly one file (the path's file, never a request field), the issuing owner, the file's
  organization, the disposition (`inline` only for images, SDD §9).
- **Reuse (F36):** reusable until expiry by default (a dropped connection can retry); `singleUse: true` makes it single-use. Each use is
  counted (`useCount`). *(Superseded in part by Stage 17.8: a reusable ticket is also bounded by `FILE_TICKET_MAX_DOWNLOADS` uses.)*
- **Redemption = one statement** (`TicketRepository.claimDownload`): the ticket (operation `download`, not revoked, not expired, unused if
  single-use) AND its file (the bound id, `AVAILABLE`, still the issuer's in the ticket's organization) are checked and the use is
  claimed atomically; the issuer's CURRENT policy (`issue_ticket`, organization mode) is re-checked in the same transaction (a refusal
  rolls back: nothing consumed). Concurrent single-use redemptions serialize on the ticket row: exactly one wins.
- **Lifecycle over validity:** a file that leaves `AVAILABLE` is never served through an old ticket (the claim requires `AVAILABLE`).
- **Revocation:** `DELETE /file/tickets/{id}` (issuer + organization; idempotent; another caller's or unknown ticket → the same
  `404 ticket_not_found`). It stops FUTURE redemptions; a download authorized before the revocation commits may complete (bytes already
  authorized are not recalled; tested). `revokeAllForFile` (17.3) stays internal for the 17.7 deletion transaction.
- **Invalid tickets:** malformed, unknown, expired, revoked, used (single-use), an upload ticket, a ticket whose file left `AVAILABLE`,
  a ticket whose issuer lost `issue_ticket`: ONE response, `404 { code: "ticket_invalid", message: "The link is not valid." }` (the
  17.5 message was generalized to cover both directions).
- **Abuse bound:** the 17.5 limiter, now shared (`RedemptionLimiter`): failed redemptions per keyed client address (HMAC with
  `FILE_RATE_LIMIT_KEY`), one budget for upload and download; over it, EVERY redemption is `429` (no oracle). No ticket material
  reaches the limiter.

## 4. Response

| Header | Value |
|---|---|
| `Content-Type` | the verified type stored at upload (never the declared one) |
| `Content-Length` | the stored `sizeBytes`, after checking it equals the store's size |
| `Content-Disposition` | `attachment` (or `inline` for an image ticket that asked) `; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded>` |
| `Cache-Control` / `Pragma` | `private, no-store` / `no-cache` (also on every error of these routes and on ticket issuance) |
| `X-Content-Type-Options` | `nosniff` |
| `Content-Security-Policy` | `default-src 'none'; sandbox` |
| `Referrer-Policy` | `no-referrer` |
| `ETag` | `"<sha256>"` (no conditional GET) |
| `Accept-Ranges` | `none` (a `Range` header is ignored: full `200`, RFC 9110) |
| `Cross-Origin-Resource-Policy` | `cross-origin` on the ticket route only (a capability used by the product's client, e.g. an inline image); the service route keeps helmet's `same-origin` |

**Content-Disposition** is built by one encoder: the stored name is re-cleaned (controls, bidi controls, separators; the stored value
is untouched), the fallback keeps printable ASCII without `"` / `\` (others → `_`), the UTF-8 form is percent-encoded byte by byte
(RFC 8187 attr-char otherwise); a missing name → `file.<ext>`. No quote, CR, LF or control character can reach the header (tested with
ASCII, spaces, quotes, French, Arabic, 100-character Arabic names, CR/LF, NUL, ESC, NEL, bidi overrides and isolates).

## 5. Streaming

```text
authorize (service lookup or ticket claim)  →  StoragePort.get(key, signal)  →  size check  →  ByteCounter  →  HTTP response
```

- The store is opened only after authorization; no database call happens inside the byte stream.
- `pipeline` carries backpressure end to end. **Measured:** a client that pauses a 20 MiB (filesystem) or 16 MiB (S3) download holds
  ~0.1 MiB of live buffers at the pause and grows ≤ 0.5 MiB during a 500 ms hold (the server stops reading the store).
- A client disconnect aborts the signal and destroys the store stream (filesystem descriptor / S3 socket): an 8 MiB download aborted
  after its first chunk stopped after a small fraction of it on both adapters (logged `outcome=aborted bytes=…`).
- A client that stops reading for `FILE_DOWNLOAD_IDLE_TIMEOUT_MS` (default 30 s) is cut off.
- `ByteCounter` refuses to end a response shorter or longer than `Content-Length`: an object that ends early mid-stream destroys the
  connection, so a client can never take a truncated file for a complete one (tested by truncating the object during a paused
  download).
- Errors before the first byte are normal responses; after it, only the connection can be ended (HTTP limitation).

## 6. Storage faults and integrity

| Condition | Answer | Signal |
|---|---|---|
| object missing (record `AVAILABLE`) | `500 file_content_missing` | `file_storage_inconsistent file=<id> reason=object_missing`; the row is NOT changed (reconciliation is 17.7) |
| store size ≠ recorded size | `500 file_content_missing` (nothing sent) | `reason=size_mismatch` |
| store unavailable / timeout | `503 storage_unavailable` | `storage_op … outcome=storage_unavailable` |
| store rejected (permissions, bucket) | `500 storage_error` | `storage_op` WARN |
| stream fails after bytes began | connection destroyed | `file_download … outcome=stream_failed` |

SHA-256 is **not** recomputed on each download (it is the `ETag`, verified at upload; continuous integrity scanning is later work).
*(Superseded by Stage 17.8: the SHA-256 is recomputed during every download and a mismatched download cannot complete.)*
`/ready` stays `200` during a storage outage (tested in-process and in the image).

## 7. Observability

`file_download route=<service|ticket> outcome=<ok|aborted|stream_failed|storage_*|size_mismatch> file=<id> owner=<service>
media=<type> size=<bucket> bytes=<sent> duration_ms=…`, `file_download_ticket_issued owner=… ticket=<id> single_use=… ttl_s=…`,
`file_ticket_revoked owner=… ticket=<id>`, `file_storage_inconsistent file=<id> reason=…`, and the 17.4 `storage_op` lines. Never a
token, digest, ticket path, storage key, bucket, endpoint, name or content (tested on every log line). The kit writes no access log;
request paths never reach a log.

## 8. Configuration (added)

| Variable | Default | Rule |
|---|---|---|
| `FILE_DOWNLOAD_TICKET_TTL_SECONDS` | 120 | 60–300 |
| `FILE_DOWNLOAD_IDLE_TIMEOUT_MS` | 30 000 | 1 000–120 000 |

## 9. Evidence

- **Unit:** 223 in 8 files (Content-Disposition 8 new; configuration 35, +3 for 17.6; earlier suites unchanged).
- **E2E (real PostgreSQL 16; filesystem; S3 on VersityGW):** 235 in 13 files; new: download 20, download-on-S3 5; updated:
  foundation 24 (routes, HEAD, OpenAPI); every 17.2–17.5 suite passes; eight consecutive full runs green after the fixes below.
- **Key results:** identical `404` for foreign / missing / malformed / wrong-organization ids (12 probes, one body); only `AVAILABLE`
  served (UPLOADING / FAILED / REJECTED 409, DELETING / DELETED 410, for the owner only); every unusable ticket one identical
  `ticket_invalid` (8 cases incl. an upload ticket bound to a file and a file that left AVAILABLE after issuance); 20 concurrent
  reusable redemptions all byte-exact (`useCount` 20); 20 concurrent single-use redemptions → exactly one; revocation idempotent and
  non-disclosing; a revocation during a stream lets it complete and refuses the next; HEAD 405 without consuming; Range ignored;
  headers exact; paused client: ~0.1 MiB held, ≤ 0.5 MiB growth (both adapters); abort stops the store stream early (both adapters);
  missing object / size mismatch → 500 `file_content_missing` + inconsistency signal, row unchanged; truncation mid-stream → the
  connection ends at once, logged `stream_failed`; storage outage → 503, `/ready` 200; no token, digest, ticket path or key in logs.
- **Mutations (24; all killed on the final code):**

  | Mutation | Caught by |
  |---|---|
  | M1 owner removed from the lookup | 3 E2E (non-disclosure) |
  | M2 organization-mode check removed | policy test |
  | M3a the claim ignores AVAILABLE / M3b the owner path serves any state | lifecycle tests |
  | M4 expiry ignored / M5 revocation ignored | 2 / 4 E2E |
  | M6 operation binding removed | **survived first** (an upload ticket never reaches the join in the normal flow); a test now binds an unused upload ticket to a file (a state the schema allows) and kills it |
  | M7 ticket-to-file binding removed | 12 E2E |
  | M8 the ticket path logged | log scan |
  | M9 `nosniff` removed / M11 cacheable downloads | header tests |
  | M10 the name not re-cleaned | 3 unit |
  | M12 missing object reported as an outage / M13 storage detail leaked | fault tests |
  | M14 the object buffered before sending | 5 E2E (backpressure) |
  | M15 client abort not propagated | abort tests (both adapters) |
  | M16 limiter refuses only failures | no-oracle test |
  | M17 a foreign file disclosed (403) | non-disclosure test |
  | M18 reusable made single-use / M19 single-use not atomic | reuse / concurrency tests |
  | M20 HEAD reaches the GET handler | HEAD test |
  | M21 size-mismatch check removed | integrity test |
  | M22 a short object ends the response normally | **survived first** (the client saw an incomplete body either way, but only after the keep-alive timeout, and the server logged `ok`); the test now requires a prompt close and a `stream_failed` log, and kills it |
  | M23 issuer policy not re-checked | policy-revocation test |

- **Defects found and fixed during validation:** (1) a stream-length refusal was logged as a client `aborted` (destroying the
  response fires the close listener first): failures are now classified by cause; (2) a race in the truncation test (the log line
  lands just after the socket closes) and (3) fast-transfer memory thresholds in 17.4 / 17.5 tests that sat inside sampling noise:
  now size-relative (0.75 × size) and, for downloads, a deterministic paused-client measure.
- **Image:** production with an unreachable store: ready 200, upload and download 503; development round trip on the S3 test server:
  upload, service download and ticket download byte-exact, headers as specified, HEAD 405, invalid ticket 404; uid 1000, Node PID 1,
  stop < 100 ms exit 0, no secret in layers, no token / digest / key / password / name in the logs. Repository smoke passes.

## 10. Deferred

- **17.7:** deletion (logical + physical, with `revokeAllForFile` in its transaction), the upload-lease sweep, orphan and `.tmp`
  cleanup, reconciliation of `file_content_missing` rows, retention of expired tickets and limiter rows.
- **17.8:** per-caller issuance limits, threat-model verification, header fuzzing at scale, the scanner hook.
- **17.9:** signals / snapshot, key rotation, production image review.
- **Later decisions:** Range (resumable / partial downloads, if large media ever arrive), HEAD (would need a non-consuming check),
  conditional GET, cross-service read delegation (Notification attachments), a separate download origin.
- **Production enablement:** the storage provider (O2 / F6), the malware policy (F19), backup / DR (F34).
- **21.R1 / 21.R2:** route naming (`/file/files`, `/file/t`) is recorded for the Core API audit, not changed here.

# Stage 17.4 — File storage abstraction

- **Status:** implemented and validated on `feat/file-service-storage` (awaiting review).
- **Scope:** the provider-neutral byte store behind File Service: `StoragePort`, the filesystem adapter (development and tests), the
  S3-compatible adapter, storage configuration and provider selection, error normalization, bounded timeouts and retries, abort
  propagation, observation hooks, one contract test suite run against both adapters, S3 test infrastructure (Compose profile, CI).
- **Not in scope (and not present):** any HTTP route besides `/health` and `/ready`; upload, download, tickets, type detection,
  checksum computation of uploads, the upload lifecycle, idempotency, cleanup workers, scanning. Nothing calls the port yet (17.5).
- **Frozen design followed:** [ADR-0048](../../adr/0048-file-service-architecture.md) §4 / §5 / §8, [SDD §4, §6, §15](../../sdd/file-service.md),
  [Stage 17.1](./stage-17-1-decisions-and-roadmap.md) F5, F6 (open), F7, F9, F12, F26, F31. No decision reopened.

**PRODUCTION STORAGE PROVIDER — STATUS: NOT YET FROZEN** (O2 / F6; §12).

## 1. Baseline

`main` at `2525d0f` (Stage 17.3 merged, PR #107). The 17.3 schema needed no change: `file.storageProvider` records the adapter name
(`filesystem` | `s3`), `file.storageKey` is the bridge, and `newStorageKey` (17.3) stays the only key generator; adapters validate
keys with `isStorageKey` and never build one.

## 2. StoragePort (SDD §4)

```ts
interface StoragePort {
  readonly provider: 'filesystem' | 's3';
  put(key, body: Readable, { sizeBytes, contentType, sha256?, signal }): Promise<void>;
  get(key, { signal }): Promise<{ body: Readable; sizeBytes: number }>;
  head(key, { signal }): Promise<{ sizeBytes: number } | undefined>;
  delete(key, { signal }): Promise<void>;
}
```

| Semantics (identical in every adapter; one contract suite proves it) | |
|---|---|
| `put` | publishes a complete object or nothing; the body must deliver exactly `sizeBytes`; an optional expected SHA-256 is enforced; **never replaces** an existing object (`storage_already_exists`) |
| `get` | a stream with backpressure plus the stored size; `storage_not_found` when absent; never buffered |
| `head` | the stored size, or `undefined` |
| `delete` | idempotent: a missing object is success |
| keys | only the generator's shape (`<prefix>/<uuid>/<32 hex>`); anything else is `storage_invalid_key` before any I/O |
| failures | a `StorageError` with a provider-neutral code; a failure of the **caller's body** rejects with that body's own error; an abort through `signal` rejects with the signal's reason (so 17.5 can tell a client abort from a storage fault) |

Clarifications of the SDD sketch (no decision changed): `get` also returns the stored size (a disagreement with PostgreSQL's
`sizeBytes` is an inconsistency 17.6 / 17.7 can detect); `provider` is exposed so 17.5 records it in `file.storageProvider`.
Deliberately absent (SDD §4, ADR-0048 §5): list, copy, rename, public or signed URLs, bucket management, ACL, tagging, versioning,
multipart exposed to callers.

**Errors** (`StorageError`, message = the code; `detail` = a bounded token such as `ENOSPC` or `NoSuchBucket`; the provider error is
never attached as `cause`):

| Code | Meaning | Retryable | Future client mapping |
|---|---|---|---|
| `storage_not_found` | no object | no | `file_content_missing` (an `AVAILABLE` row without bytes) |
| `storage_already_exists` | `put` to an occupied key | no | internal (keys are unique by construction) |
| `storage_unavailable` | 5xx, 429, refused / reset connection, DNS, disk full, I/O error | yes | `503 storage_unavailable` |
| `storage_timeout` | a deadline passed (for `put`: outcome unknown; `head` tells) | yes | `503 storage_unavailable` |
| `storage_rejected` | access denied, bad credentials, missing bucket, symlink or foreign entry in the root: operator fault | no | 500 + an operator signal |
| `storage_invalid_key` | a key outside the grammar (programming error) | no | 500 |
| `storage_length_mismatch` | the body was shorter / longer than `sizeBytes` | no | the upload's own error (17.5) |
| `storage_checksum_mismatch` | the bytes do not match the expected SHA-256 | no | `422 checksum_mismatch` (17.5) |

## 3. Provider selection and configuration

The provider is chosen **once**, at composition (`StorageModule.forRoot` → `createStorage`), from the validated configuration; the
domain receives `STORAGE_PORT` and never branches on the provider. There is **no default and no fallback**: a missing or unknown
provider stops the process.

| Variable | Default | Bounds / rule |
|---|---|---|
| `FILE_STORAGE_PROVIDER` | **required** | `filesystem` \| `s3` |
| `FILE_STORAGE_KEY_PREFIX` | `files` | the key grammar, ≤ 130 characters |
| `FILE_STORAGE_REQUEST_TIMEOUT_MS` | 10 000 | 1 000 – 60 000: head, delete, a read's first byte; the base of a write's deadline |
| `FILE_STORAGE_MIN_THROUGHPUT_BYTES_PER_SECOND` | 65 536 | 1 024 – 100 MiB: a write's whole-transfer bound = base + size at this rate (25 MiB → 410 s) |
| `FILE_STORAGE_ROOT` (filesystem) | required | absolute, not `/`; **refused in production, with no override** |
| `FILE_S3_ENDPOINT` | required | `https:` in production (`http:` allowed elsewhere, for a local test server); no credentials, query or fragment in it |
| `FILE_S3_REGION` | required | a region token (`auto`, `eu-west-3`, …) |
| `FILE_S3_BUCKET` | required | portable bucket name |
| `FILE_S3_ACCESS_KEY_ID`, `FILE_S3_SECRET_ACCESS_KEY` | required | also `*_FILE` (mounted secrets); the secret ≥ 16 characters; never echoed, logged or stored |
| `FILE_S3_FORCE_PATH_STYLE` | `false` | path-style addressing for providers that need it |
| `FILE_STORAGE_CONNECT_TIMEOUT_MS` | 2 000 | 100 – 2 000 (SDD §15: ≤ 2 s) |
| `FILE_STORAGE_IDLE_TIMEOUT_MS` | 30 000 | 1 000 – 120 000: socket idle (no byte) bound |
| `FILE_STORAGE_MAX_ATTEMPTS` | 3 | 1 – 5: idempotent operations only |

Startup never contacts the store (a production smoke uses an unresolvable endpoint and boots): a storage outage never prevents the
process from starting.

## 4. Filesystem adapter (development and tests; F7)

- **Layout:** `<root>/<key>`: the key's own directories (mode 0700), objects mode 0600; the root is created 0700 on first use
  (nothing at construction). Temporary writes in `<root>/.tmp/<32 hex>.part` (a server-generated name; no key can name `.tmp`: keys
  have no dot). Ownership: the service user (`node` in the image); nothing is world-accessible.
- **Atomic publish, no overwrite:** the body streams into a fresh temporary file (`O_EXCL | O_NOFOLLOW`, fsync on close), then
  `link(temp, final)`: atomic, and it fails with `EEXIST` if the key exists (a `rename` would silently replace). The temporary name
  is removed in every outcome (success, failure, abort, duplicate).
- **Path containment:** keys must match the generator's grammar (no `.`, `\`, leading `/`, `%` decoding); independently,
  `resolveWithin` refuses any resolved path outside the root's real path.
- **Symlinks:** every directory on a key's path is checked with `lstat` (a symlink or a non-directory is `storage_rejected`); objects
  and the temporary file are opened with `O_NOFOLLOW`; on Linux the opened descriptor's real path (`/proc/self/fd/N`) is re-checked
  against the root, closing the check-then-open gap for reads and temporary writes; `delete` of a symlink at a key removes the link,
  never its target. **Residual (documented):** Node has no `openat` / `RESOLVE_BENEATH`, so a principal able to write inside the root
  could swap a key's directory for a symlink between the check and the final `link` / `unlink`. The root must be writable only by the
  service user; the adapter is refused in production.
- **Errors:** `ENOENT`/`ENOTDIR` → not found; `EEXIST` → already exists; `EACCES`/`EPERM`/`EROFS`/`ELOOP`/`EXDEV` → rejected;
  `ENOSPC`/`EDQUOT`/`EIO`/`EMFILE` and the rest → unavailable. The errno name is the only detail; paths never leave the adapter.

## 5. S3-compatible adapter (F5 / F6)

`@aws-sdk/client-s3` (the maintained S3 client; configuration-only provider neutrality: endpoint, region, bucket, addressing) with
`@smithy/node-http-handler` (bounded connect and socket timeouts, keep-alive agents).

- **Operations used:** `PutObject`, `GetObject`, `HeadObject`, `DeleteObject`. No `CreateBucket` / `DeleteBucket` /
  `PutBucketPolicy` / ACL / presign / multipart / list: the bucket is provisioned operationally and must be private.
- **Write:** one streamed `PutObject` with the exact `Content-Length` and `If-None-Match: *` (412 → `storage_already_exists`); a
  single PUT is atomic on S3 (an interrupted request publishes nothing). **Never retried** (`maxAttempts: 1`: the body is a one-shot
  stream); bounded by the whole-transfer deadline. A failing or refused body aborts the request at once (defect found and fixed in
  this stage, §11).
- **Read / head / delete:** a separate client with `maxAttempts` (default 3, standard retry mode with jittered backoff) until the
  response starts; a read is never retried once bytes flow; the first-byte deadline is released when the stream begins (the stream is
  then bounded by the socket idle timeout and the caller's signal). Delete is idempotent (204 for a missing key; a not-found is
  swallowed too, on any provider).
- **Checksums:** the SDK's automatic request / response checksums are off (`WHEN_REQUIRED`): several S3-compatible providers reject
  or mishandle the newer defaults. An expected SHA-256 is verified in the stream (`VerifiedBody`, §6); the ETag is never treated as a
  digest. The provider-side checksum as a second check (F12) is carried to the provider evaluation (§12).
- **No console output:** the SDK logger is silenced (its messages would bypass the JSON logs and can carry hosts and request ids).
- **Metadata:** only the transport `Content-Type` and `Content-Length`; no user metadata. PostgreSQL is the authority for owner,
  organization, name, type and lifecycle.

## 6. Streaming, verification, memory

- Every path is a stream: `pipeline` (filesystem) or the SDK's streamed body (S3); reads return a `PassThrough` fed by `pipe`
  (backpressure end to end). No `Buffer.concat`, `readFile` or stream-to-buffer on a storage path (test helpers only).
- **`VerifiedBody`** counts bytes and, when an expected SHA-256 is given, hashes them; it **holds the last chunk back** until the
  source has ended and been verified. A store considers a body complete at `Content-Length` bytes and may commit it then; holding
  the final bytes means a short, long or mismatched body never reaches the store complete, so nothing is published (one chunk of lag).
- **Measured:** a 48 MiB object in and out of each adapter holds < 16 MiB of live buffers (sampled after forced collections); a paused
  reader holds only stream buffers.

## 7. Timeouts, retries, abort

| Bound | Value | Where |
|---|---|---|
| TCP connect | ≤ 2 s | S3 (HTTP handler) |
| socket idle | 30 s | S3 (HTTP handler): requests and read streams |
| head / delete / first byte of a read | 10 s | both (deadline) |
| whole write | 10 s + size ÷ 64 KiB/s | both (deadline) |
| retries | 3 attempts, idempotent operations only, standard backoff | S3 (SDK) |

Abort: every operation takes an `AbortSignal` (SDD §4). A write aborted mid-stream stops (the request is aborted / the temporary
file removed) and rejects with the signal's reason; an aborted read destroys the provider stream; an already-aborted signal refuses
before any I/O. There is no retry loop of our own on top of the SDK's.

## 8. Readiness and outages (ADR-0048 §8, F26)

No readiness check exists for storage, and no background probe: with PostgreSQL healthy and the store down, `/health` 200, `/ready`
200, and each storage operation fails with `storage_unavailable` / `storage_timeout` (tested with the application wired to an
unreachable store). Outages were exercised at the protocol level: connection refused → `storage_unavailable` (fast); a server that
never answers → `storage_timeout` within the deadline; 503 → `storage_unavailable` after exactly 3 attempts for reads and deletes and
exactly 1 for a write; 403 → `storage_rejected`, not retried. The process stays up; no error carries a host, bucket, request id or
provider message.

## 9. Crash windows (for 17.5 / 17.7; no reconciliation built here)

| Crash | Storage state left | Recovery (later stage) |
|---|---|---|
| during an S3 PUT | nothing (a single PUT is atomic) | the upload lease sweep marks the row `FAILED` (17.5 / 17.7) |
| right after an S3 PUT, before the row update | a complete object, row `UPLOADING` | lease sweep → `FAILED` + delete the key (SDD §5.3) |
| during a filesystem write | an orphan `.tmp/<random>.part`, no object | reconciliation removes `.tmp` entries older than the upload lease (17.7) |
| between the filesystem `link` and the temporary `unlink` | the object (complete) + a leftover temporary name | as above; the object is correct |
| during a delete | the object present or absent | delete is idempotent: the delete worker retries (17.7) |

PostgreSQL and the store never share a transaction (no 2PC, no XA); the primitives (atomic publish, no overwrite, idempotent
delete, `head`) make every window recoverable by state + reconciliation.

## 10. Observability

`ObservedStorage` wraps the adapter and reports each operation: `operation`, `provider` (`filesystem` / `s3`), `outcome` (`ok`, a
`storage_*` code, `aborted`, `source_error`), `durationMs`, `bytes`, `detail` — bounded labels only, never a key, file id,
organization, bucket, endpoint or path. The default observer logs `storage_op …` at DEBUG for successes and WARN for failures; a
metrics exporter can replace it without touching adapters. An observer failure never changes an outcome.

## 11. Evidence

- **Unit:** 143 in 6 files: storage configuration 30 and storage primitives 40 (new: verifier, error mapping, stream plumbing,
  deadlines, observer, provider selection); configuration 17, caller policy 25, storage key 22, ticket digest 9.
- **E2E:** 166 in 9 files: filesystem adapter 25 (contract 14 + 11), S3 adapter against VersityGW 19 (contract 14 + 5), S3 outages
  5 (new); health 5 (+1: storage is not readiness), built process 19 (+6 storage refusals), foundation 23, schema 46, repository 20,
  runtime role 4.
- **Contract (14 cases, both adapters):** byte-exact round trip (every byte value, 1 MiB), empty object, missing read / head,
  no-overwrite with the original intact, concurrent writers (exactly one wins), idempotent delete, failing body (its own error, nothing
  published, key reusable), short / long body, SHA-256 match / mismatch, abort mid-write, pre-aborted signal, abort mid-read, stalled
  write → timeout, invalid keys for every operation.
- **Defect found by the contract suite and fixed:** the S3 adapter did not abort the request when the body failed or was refused;
  the request waited for missing bytes until the deadline and reported `storage_timeout` (nothing was published, but slowly and
  misclassified). A failing / refused body now aborts the PUT immediately.
- **Mutations:** §13.
- **Image (production build):** production refuses the filesystem store, a missing provider and a plain-HTTP endpoint (exit 1,
  nothing echoed); boots with an unresolvable S3 endpoint; migrate 4 then 0; ready 200 with the store unreachable; the image's own
  S3 adapter round-trips 3 MiB byte-exact against the test server, refuses the duplicate, deletes idempotently; uid 1000, Node PID 1,
  no secret in the layers, mount point `node 700` and empty; stop 56 ms, exit 0; no leak of any token, password, S3 secret, access key
  or endpoint in the logs. Repository smoke passes. `npm audit` (production dependencies): 0 vulnerabilities; both new direct
  dependencies Apache-2.0.

## 12. S3 compatibility checklist and the provider carryover

| Capability | Required by File Service | Notes |
|---|---|---|
| Streaming `PutObject` with `Content-Length` | **yes** | one PUT per object, ≤ 100 MiB |
| Conditional create `If-None-Match: *` on `PutObject` (412) | **yes** | no-overwrite guarantee |
| Streaming `GetObject` | **yes** | |
| `HeadObject` (size) | **yes** | `put` outcome after a timeout; reconciliation |
| `DeleteObject` (idempotent) | **yes** | |
| Custom endpoint, path-style addressing | **yes** | configuration only |
| SigV4 authentication, private bucket, TLS | **yes** | |
| Server-side encryption at rest | **yes (provider setting)** | F20; not requested per object |
| Provider SHA-256 checksum on PUT | no (optional second check, F12) | evaluate per provider |
| Multipart upload | no | objects ≤ 100 MiB |
| Presigned URLs, public URLs, ACLs | **no** (must not be used) | F9: bytes stream through File |
| Bucket creation / policy from the service | **no** | operational provisioning |
| Listing | no (only a future operator reconciliation tool, 17.7) | |
| Versioning, lifecycle rules, events, tagging, replication | no | |

**Production storage provider: STATUS NOT YET FROZEN.** Candidates: Cloudflare R2, AWS S3, Backblaze B2, other S3-compatible
providers (an EU provider, self-hosted). The vendor ADR (before production enablement) must weigh: cost and egress, latency from
Tunisia / MENA, data residency, DPA and privacy terms, durability, backup / DR (F34), operational load, and **actual compatibility
with the checklist above, verified by running this stage's contract suite against the candidate**. VersityGW (and any other test
server) is test infrastructure only; MinIO, named in the SDD for tests, no longer publishes public images, so the SDD reference is
updated.

## 13. Mutations

16 mutations; each file restored and verified by SHA-256 afterwards. 15 killed, 1 equivalent survivor.

| Mutation | Caught by |
|---|---|
| M1 filesystem containment check removed | containment test |
| M2 filesystem allowed in production | 1 unit + 1 built-process test |
| M3 filesystem writes in place (a partial object visible) | 5 E2E (failing / short / aborted / stalled writes) |
| M4 an S3 error carries the provider error (message, cause) | 19 unit + 11 E2E (leak checks) |
| M5a filesystem buffers the whole object | 6 E2E (memory bound and others) |
| M5b S3 buffers the whole object | 3 E2E |
| M6a S3 `If-None-Match` removed (overwrite) | 2 E2E (no-overwrite, concurrent writers) |
| M6b filesystem publishes with `rename` (overwrite) | 3 E2E |
| M7 a storage check added to readiness | 3 E2E (`/ready` with an unreachable store) |
| M8 credentials logged at startup | 2 E2E (log scans) |
| M9 an unknown provider falls back to the filesystem | 1 unit + 1 built-process test |
| M10 filesystem delete of a missing object fails | contract (idempotent delete) |
| M11 the verifier releases the last chunk early | 3 unit + 2 E2E |
| M12 the S3 write client retries (`maxAttempts: 3`) | **survived: equivalent** — the SDK itself never retries a request whose body is a stream ("non-retryable streaming request"), so one attempt is observed either way. `maxAttempts: 1` stays as explicit defence should the SDK change. |
| M13 the S3 fail-fast on a refused body removed (the defect of §11) | 2 E2E |
| M14 a symlinked directory accepted | symlink test |

## 14. Docker, Compose, CI

- **Image:** the SDK is a production dependency; no storage server, no credentials, no data in the image; an empty mount point
  `/var/lib/file-service/storage` (owner `node`, 0700) for the development volume; still `USER node`, Node as PID 1.
- **Compose:** `file-service` uses the filesystem store on the named volume `file_storage_dev` (development); an `s3-test` service
  (profile `storage-test`, VersityGW pinned, loopback only, test credentials from `.env`) for running the S3 suites locally.
- **CI:** the file-service job starts a pinned VersityGW with per-run random credentials and exports `TEST_S3_*`; the S3 suites fail
  (never skip) in CI without them. No cloud account, deterministic.

## 15. Deferred and carryovers

- **17.5:** the upload route feeding `put` (size cut-off, type detection, SHA-256 while streaming, idempotency, the lifecycle
  transitions, recording `storageProvider` / the key), upload tickets.
- **17.6:** download streaming from `get`, safe headers, download tickets.
- **17.7:** delete worker (`delete`), lease sweep, orphan and `.tmp` cleanup, reconciliation (the only place a listing might be added,
  operator-only).
- **17.8 / 17.9:** storage signals and snapshot, credential rotation runbook, key-prefix and bucket-policy checks.
- **Production enablement:** the provider (O2 / F6) with its vendor ADR and a contract run against it; SSE at rest (F20); backup / DR
  (F34); malware policy (F19).

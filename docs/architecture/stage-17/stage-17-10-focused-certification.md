# Stage 17.10 — File Service focused certification and closure

- **Status:** certification complete on `feat/file-service-focused-certification`, **awaiting human review** (not committed, not
  pushed). **Verdict: Stage 17 can be closed** for its V1 scope once this branch is reviewed (§12); production enablement is NOT
  certified here and stays gated by the prerequisites of §10.
- **Scope:** independent certification that the guarantees of Stages 17.1–17.9 hold together: a master invariant matrix, documentation
  ↔ implementation consistency, database, boot, configuration, runtime, storage, operations, image, dependency and API contract
  certification, the full File regression, a risk-based mutation campaign, repeatability, and the residual-risk, production-prerequisite
  and Stage 21 registers.
- **Not in scope (and not added):** new features of any kind, a malware scanner, a production storage provider, backup tooling, alert
  routing, route renaming (21.R1 / 21.R2), Notification attachments, Billing integration, the Core-wide validation (Stage 22).
- **Rule followed:** production code changed only where certification exposed a defect that breaks an approved invariant (§4, one
  change); every other change is tests, OpenAPI annotations or documentation.

## 1. Baseline and method

| Item | Value |
|---|---|
| Starting `main` | `dc3722f65d89967fcfed4b4a90c7edabef5c15fd` (Stage 17.9 merged, PR #113); working tree clean except an unrelated untracked `docs/reports/` |
| Host | Intel Core i5-12450H, 12 logical CPUs, Linux 6.19 (Kali), Node v24.18.0 (the image: Node 22.23.3 on `node:22-alpine`) |
| PostgreSQL | 16.15 (`postgres:16-alpine`), throwaway containers: one test server, one provisioned by `infra/postgres/init` (the production role layout) |
| S3-compatible test server | VersityGW v1.8.0 (test infrastructure, never a provider choice) |
| Image | `apps/file-service/Dockerfile` built from this branch |

Method (risk-based, §1 of the brief): every frozen invariant of 17.1–17.9 was extracted into the matrix (§2) and given current evidence —
an existing test that still runs green, or a new certification probe where the existing evidence was per-stage only. New probes target
what no single stage could test: the stages together (`test/certification.e2e-spec.ts`), the production role layout, the upgrade path,
realistic query plans, the built process under 58 configurations, the hardened image, and the documented contract.

## 2. Master invariant matrix

Status: **PASS** (current evidence, green on this branch) · **ACCEPTED RISK** (a stated residual, §9) · **PREREQUISITE** (needs a
production decision or setup, §10) · **DEFERRED** (a later stage by decision). "cert" = `test/certification.e2e-spec.ts` (new in 17.10).

### 2.1 Architecture

| ID | Stage | Invariant | Implementation | Evidence | Status |
|---|---|---|---|---|---|
| A1 | 17.1 F1, F4 | Business services own a file's meaning and relationships; File has no business reference, type or product concept | schema (no reference table, no product column); `check:repo` product-term guard over `src/` and migrations | `schema.e2e` "no product concept"; `check:repo` pass; grep of `src/` and `db/` (only sample file names in tests) | PASS |
| A2 | 17.1 F1 | File owns bytes, integrity, lifecycle and controlled access | `file` table, `StoragePort`, workers, routes | cert lifecycle (both adapters) | PASS |
| A3 | 17.1 F4, F30 | Products persist `fileId`; `fileId` is not authorization | UUID v4 ids; every lookup is id + owner + organization | cert isolation matrix (45 probes) | PASS (product side: Stage 21) |
| A4 | 17.1 F3, SDD §6 | No storage path, key, provider or bucket ever leaves File | `fileView` omits them; errors normalized; logs bounded | cert lifecycle (no `storageKey` in any view), log scans (cert, 17.5–17.8 suites, image) | PASS |
| A5 | 17.1 F15, F16 | No synchronous call to Auth or any product service | no HTTP client in `src/`; no JWT guard; `AppModule` imports | static scan (no `fetch` / client / JWT); `foundation.e2e` (no Auth dependency in readiness) | PASS |
| A6 | 17.1 F5, 17.4 | Provider behind `StoragePort`; composition is the only provider branch | `createStorage`; `ObservedStorage` | one contract suite on both adapters (`storage-filesystem.e2e`, `storage-s3.e2e`); cert lifecycle on both | PASS |

### 2.2 Identity and authorization

| ID | Stage | Invariant | Implementation | Evidence | Status |
|---|---|---|---|---|---|
| I1 | 17.2 | Service identity comes from the token only | kit `ServiceTokenGuard`, `@CallerService` | `foundation.e2e` (header / query / body spoofing); cert (a ticket as bearer → 401) | PASS |
| I2 | 17.2 | Caller policy denies by default and is validated at boot | `FileCallerPolicy.parse`, `policy()` checks | `caller-policy.spec`; config matrix §6.2 (6 policy refusals); mutation M4 | PASS |
| I3 | 17.3 / 17.5 | The owner is server-derived (caller or ticket issuer), never a request field | `FileScope` from the caller / `ticket.issuedBy`; DTO whitelist | cert lifecycle (`x-owner-service` ignored; row owner = issuer); mutation M5 | PASS |
| I4 | 17.3 / 17.6 | Organization scope enforced on every read, ticket, attach, delete, revocation | `findOwned`, `recordDownload`, `attach`, `requestDeletion`, `revoke` (all `IS NOT DISTINCT FROM`) | cert isolation matrix; mutations M2, M7 | PASS |
| I5 | 17.3 | A platform (null) organization is not a wildcard | `IS NOT DISTINCT FROM` both ways | cert probes "missing organization" and "platform mismatch" (all 5 operations); mutation M3 | PASS |
| I6 | 17.1 §3, 17.3 | A ticket cannot escalate: one file / one intent, one operation, no metadata, delete, attach, issue; not a credential | operation-filtered claims; ticket routes separate from service routes | cert "a ticket is not a credential"; `download.e2e` (upload ticket on download route); `upload.e2e` (download ticket on upload route) | PASS |

### 2.3 Upload

| ID | Stage | Invariant | Implementation | Evidence | Status |
|---|---|---|---|---|---|
| U1 | 17.5 | Streamed, never buffered; backpressure end to end | `ingest` (head window + `Meter` + `StoragePort.put`) | `upload.e2e` 20 MiB bounded memory; ops probes (80 × 24 MiB: +10–68 MiB) | PASS |
| U2 | 17.5 / 17.2 | Size bounded by min(ceiling, policy, ticket); `Content-Length` required; exact limit accepted | `declaredLength`, claim-time check, `Meter`, store length check | `upload.e2e`, `upload.spec` (Meter isolated), `security.e2e` (framing) | PASS |
| U3 | 17.5 | Upload ticket single use, atomic, consumed at claim commit; a refused claim does not consume it | `claimUse` one conditional UPDATE + CHECK + trigger | `upload.e2e` 20-way; `upload-s3.e2e` 10-way; cert outage (failed attempt did not consume); mutation M8 | PASS |
| U4 | 17.5 | Type decided from the bytes (allow-list); declared type and extension must agree | `detectMediaType`, `declaredAgrees`, `extensionAgrees` | `upload.spec`, `security.spec` (10 000 heads), polyglot tests | PASS |
| U5 | 17.5 | SHA-256 computed over exactly the accepted bytes; client `Content-Digest` only compared | `Meter`, `VerifiedBody` | cert lifecycle (digest = SHA-256 of the sent bytes); `upload.e2e` | PASS |
| U6 | 17.3 | Immutable object: set-once content, never overwritten | triggers `file_set_once` / `file_immutable`; `If-None-Match: *` / `link` | `schema.e2e`; storage contract (no overwrite); cert lifecycle (retry stores nothing) | PASS |
| U7 | 17.5 / 17.8 | Safe file name (controls, every bidi control, separators removed, NFC, ≤ 255 bytes); DB last line (0001 + 0003) | `sanitizeFileName`; CHECKs | `security.spec` 20 000 names; `security.e2e`; cert (French + Arabic name round trip) | PASS |
| U8 | 17.5 | Idempotent service upload (key + keyed hash); key reuse → 422; failed attempt frees the key | `createUploading` + partial unique index; `idempotentReplay`; previous-key window (17.9) | `upload.e2e`, `operations.e2e` (rotation) | PASS |
| U9 | 17.5 / 17.7 | Crash windows converge without promoting uncertain bytes | lease = request bound + 120 s; sweep deletes then fails the row | `deletion.e2e` windows E–F; cert restart (stale UPLOADING + object → FAILED `upload_abandoned`, object gone); mutation M14 | PASS |

### 2.4 Download

| ID | Stage | Invariant | Implementation | Evidence | Status |
|---|---|---|---|---|---|
| D1 | 17.6 | Owner + organization authorization before the store is opened | `owned()` then `stream()` | `download.e2e`; cert isolation matrix; mutations M1–M3 | PASS |
| D2 | 17.6 | Ticket redemption is one atomic claim of ticket + file binding + AVAILABLE; one `ticket_invalid` for every refusal | `claimDownload` | `download.e2e` (8 invalid cases, one body); mutation M10 | PASS |
| D3 | 17.8 | Reusable ticket cap: server-controlled (`FILE_TICKET_MAX_DOWNLOADS`, 50, 1–10 000), atomic, not caller-settable | `useCount < $cap` in the claim | `security.e2e` (cap 3, 100 concurrent → exactly 3; caller field → 400); config matrix (0, 10 001 refused); mutation M9 | PASS |
| D4 | 17.6 | Single-use atomicity | same claim + CHECK | `download.e2e` 20-way; cert (single-use serves once) | PASS |
| D5 | 17.6 | Safe headers: verified type, exact length, one Content-Disposition encoder, `private, no-store`, `no-cache`, `nosniff`, sandbox CSP, `no-referrer`, ETag = SHA-256, `Accept-Ranges: none`, CORP `cross-origin` on tickets only | `stream()`, `contentDisposition` | cert lifecycle (every header, both adapters; service route keeps `same-origin`); image (headers through the image); `security.spec` 20 000 names; mutations M26, M27 | PASS |
| D6 | 17.6 / 17.9 | Streaming with backpressure; disconnect aborts the store; idle and whole-transfer deadlines free the slot | `pipeline`, `res.setTimeout`, deadline timer | `download.e2e`, `download-s3.e2e`; `operations.e2e`; ops probes (300 disconnects: fds back to baseline; 60 paused readers: 0 DB sessions busy) | PASS |
| D7 | 17.8 | SHA-256 verified on every download, last chunk held back | `VerifiedDownload` | `download.spec`; `security.e2e`, `download-s3.e2e` tampering; mutations M15, M16 | PASS |
| D8 | 17.8 | **Exact tamper guarantee:** a download whose bytes do not match the stored SHA-256 cannot complete successfully; wrong size / missing object fail before any byte; a one-chunk file sends nothing; bytes before the last chunk MAY have been sent | as D7 + the pre-stream size check | `security.e2e` (same size both paths; one-chunk; other size; missing); `operations.e2e` (incident counters) | PASS (guarantee frozen, §8) |

### 2.5 Lifecycle

| ID | Stage | Invariant | Implementation | Evidence | Status |
|---|---|---|---|---|---|
| L1 | 17.5 / 17.7 | Temporary files expire through the normal deletion path | `expireUnattached` | cert temporary-file test (expired → DELETED, object gone, in-time file untouched) | PASS |
| L2 | 17.5 | Attach is idempotent and owner-scoped; attach vs expiry: one winner | conditional UPDATE + `SKIP LOCKED` | `upload.e2e`; `deletion.e2e` attach vs expiry race; cert (attach on DELETING already-attached: 200, no restore) | PASS |
| L3 | 17.7 | Logical delete: AVAILABLE → DELETING in one transaction with every ticket revoked; HTTP never waits on storage | `requestDeletion` | `deletion.e2e` (injected revocation failure); cert lifecycle; outage (`202` with the store down, 17.7 / ops); mutation M11 | PASS |
| L4 | 17.7 | Access denied at once; bytes may remain until the worker | claims require AVAILABLE | cert lifecycle (410, `ticket_invalid`, new ticket 410, object still present) | PASS |
| L5 | 17.7 | Delete idempotent; never restores access | UPDATE requires AVAILABLE; tombstone | cert lifecycle (retry while DELETING: same request time; after DELETED: 202 DELETED; content 410) | PASS |
| L6 | 17.7 | Async physical deletion: lease, fence, backoff, never giving up, absent object = done | `claimDeletions`, `retryDeletion` (fenced), `completeDeletion` | `deletion.e2e` (retry, crash windows A–D, replicas), **new fence test** (§4 D-3); mutations M12, M13 | PASS |
| L7 | 17.7 | Abandoned uploads recovered after the lease | sweep | `deletion.e2e`; cert restart | PASS |
| L8 | 17.7 / 17.9 | Crash convergence after a restart, no manual database step | leases, idempotent delete, DB-held state | cert restart (DELETING, a live lease honoured then reclaimed, a retry, stale upload, live ticket, spent budget); ops restart (kill -9, 8/8 converged) | PASS |

### 2.6 Security

| ID | Stage | Invariant | Implementation | Evidence | Status |
|---|---|---|---|---|---|
| S1 | 17.6 | Non-disclosure: missing / malformed / foreign service / foreign organization / platform mismatch are one status, code, message and body shape | one scoped query, one `FILE_NOT_FOUND` | cert matrix: 5 operations × 9 probes = 45 identical answers; revocation 5 probes identical; mutation M6 | PASS |
| S2 | 17.8 / 17.9 | Rate limits per caller and per (caller, organization), atomic, isolated, retained | `UsageLimiter`, `RedemptionLimiter`, retention | `security.e2e`; ops (500 concurrent: exact budgets; 5 000 clients purged); cert restart (spent budget survives); mutations M19, M20 | PASS |
| S3 | 17.8 | Unicode / bidi / controls never reach a header or a stored name | sanitizer + encoder + CHECK | `security.spec`, `security.e2e`; cert (header properties) | PASS |
| S4 | 17.4 | No path traversal; keys server-generated and grammar-checked; filesystem containment, `O_NOFOLLOW`, fd re-check | `isStorageKey`, `resolveWithin`, `confine` | `security.spec` 10 000 keys; `storage-filesystem.e2e`; mutation M17 | PASS (residual R15, development only) |
| S5 | 17.4 | Filesystem store refused in production, no override | `loadStorageConfig` | config matrix; image (exit 1); mutation M18 | PASS |
| S6 | 17.2–17.9 | Secrets, tokens, tickets, digests, keys, names never logged or echoed | kit logger, bounded log fields, no access log | log scans (cert, every suite, image: 0 leaks); config matrix (58 cases, 0 echoes); §6.9 scan | PASS |
| S7 | 17.6 | Cross-service isolation | owner in every scoped query | cert matrix (Drive ↔ Billing, both directions, every operation) | PASS |
| S8 | 17.6 | Cross-organization isolation | organization in every scoped query | cert matrix (org A / org B / platform) | PASS |
| S9 | 17.8 F19 | Malware scanning | not built (decision B) | README and SDD state it; §8 | ACCEPTED RISK R1 / PREREQUISITE P3 |

### 2.7 Operations

| ID | Stage | Invariant | Implementation | Evidence | Status |
|---|---|---|---|---|---|
| O1 | 17.8 / 17.9 | Overload is `503 upload_busy` / `download_busy`, distinct from `429`; nothing consumed; slots released on every path | `OpsCounters.tryEnter`; the download slot inside the claim | `security.e2e`, `operations.e2e`; ops (80 → 64 + 16 × 503; 24 tickets used once through 46 × 503); mutations M21–M23 | PASS |
| O2 | 17.7 / 17.9 | Worker leases, fences, drain mode, one batch per pass during an outage | `CleanupWorker` | `deletion.e2e`, `operations.e2e`, ops backlog | PASS |
| O3 | 17.4 / 17.9 | Storage outage: byte operations fail safely, `/ready` DB-only, deletes reschedule, lifecycle authority stays in the database, recovery automatic | normalized errors, no storage readiness | `health.e2e`, `deletion-s3.e2e`, ops storage faults (refuse / hang / recover), image (store unreachable) | PASS |
| O4 | 17.2 / 17.10 | Database outage: `/ready` fails, `/health` live, state-changing requests fail closed, **no object written without a durable row**, recovery automatic | DB first on every write path | cert outage (5 operations refused, store unchanged, rows unchanged, ticket still usable after recovery) | PASS |
| O5 | 17.2 / 17.9 | Graceful shutdown: admission stops, bounded drain, workers and reporter stop before the pool | kit drain, `beforeApplicationShutdown` | `foundation.e2e`, `deletion-s3.e2e`; ops shutdown (upload / download 5.0 s, hanging store 18 ms, 8 claims released); image stop 55 ms idle / 5.1 s mid-download; mutation M24 | PASS |
| O6 | 17.9 | Bounded signals: snapshot, counters, storage lines, integrity incident; closed label sets | `FileOpsReporter`, `OpsCounters` | `operations.e2e`, `ops.spec`; mutation M25 | PASS |
| O7 | 17.9 | Backlog visibility and persistent-failure view | snapshot fields | `operations.e2e` snapshot test; runbook §1 / §3 | PASS (routing: P6) |
| O8 | 17.9 | Credential / key rotation (tokens, request-hash previous keys, S3 / DB by rolling deploy) | kit two-token rule; `FILE_REQUEST_HASH_PREVIOUS_KEYS` | `operations.e2e` rotation tests; runbook §7 | PASS |
| O9 | 17.9 O-4 | The upload idle timer blames only a client that stops sending, **with bounded resources** | `watchUpload` | **defect D-1 found and fixed** (§4); `operations.e2e` new regression test; mutation M28 | PASS (after fix) |

## 3. Documentation ↔ implementation consistency

Compared: the 17.1 decisions, the SDD, the 17.2–17.9 records, the README, the runbook, the migrations README, the generated OpenAPI,
the migrations and the running service. The current approved behaviour is frozen; stale text was corrected, never the code.

| Drift | Where | Current behaviour (frozen) | Fix |
|---|---|---|---|
| "Draft … nothing implemented" | SDD status | implemented 17.2–17.9, certified here | status updated |
| Reconciliation "deletes orphan keys older than the lease" / "objects … with no row, reported and optionally repaired" | SDD §5.3, §12; 17.1 F28 | no bucket listing: objects with no row are not searched; only objects of FAILED / REJECTED / DELETED rows are removed (`--repair`) | corrected, 17.7 cited |
| "The provider checksum is used … as a second check" | SDD §7; 17.1 F12 | not used (SDK checksums off, 17.4); a provider-evaluation item | corrected |
| Download tickets "reusable until expiry" | 17.1 F36 / §3, 17.6 §3, README | TTL **and** `FILE_TICKET_MAX_DOWNLOADS` uses (17.8) | annotated |
| "SHA-256 is not recomputed on each download" | 17.6 §6 | recomputed on every download (17.8) | annotated as superseded |
| Idle stream 30 s | SDD §15, 17.1 F31 | client idle 30 s, store idle 45 s (enforced since 17.9) | annotated |
| Errors list lacks `download_busy` and the implemented codes | SDD §14 | the full implemented set | completed |
| Ticket issuance responses `{ url, expiresAt }` | SDD §13 | `{ ticketId, url, expiresAt }` | corrected |
| `0003` "only new rows can be checked" | 17.8 §4.5 | a NOT VALID CHECK is enforced on every UPDATE of an old row (§5.2) | corrected with the measured consequence |
| `0003` missing | migrations README | three migrations | row + upgrade precondition added |
| Evidence placeholders `UNIT_RESULT`, `E2E_RESULT`, `IMAGE_RESULT`, `AUDIT_RESULT`, `MUTATION_TABLE` merged unfilled | 17.9 §15 | — | replaced by "not recorded at merge" + the 17.10 evidence (numbers are not back-filled) |
| Records "awaiting review" | 17.2–17.9 status lines | merged (PR #106–#113) | updated |
| README "17.2–17.7", "no worker", "no storage until 17.4" | README | 17.2–17.10; workers exist | updated; malware statement added |
| OpenAPI omits statuses the routes answer (notably `410 file_deleted` on ticket issuance; 401 / 403; 400 / 408 / 500 on uploads; 500 `file_content_missing` on downloads) | controllers | as implemented | `@ApiResponse` annotations added (no route or behaviour change); cert test pins the set |

Verified consistent (no change): ADR-0048; the runbook (every required procedure present: storage outage, backlog, persistent delete
failure, integrity incident, overload vs rate limits, pool saturation, rotation, reconciliation, deployment checklist, backup / restore
consistency; it forbids hand edits of lifecycle rows); README configuration table; the 17.9 envelope numbers (re-measured, §6.8).
Minor, left as is: two stale source comments / one test title in the configuration module ("download-ticket TTL absent until 17.6"),
harmless and outside the certification change budget; recorded for 21.R1.

## 4. Defects found

| # | Defect | Kind | Resolution |
|---|---|---|---|
| **D-1** | **The Stage 17.9 upload idle re-arm (O-4) doubled its `timeout` listeners every idle period while the store held bytes back.** `req.setTimeout(ms, onIdle)` adds a listener on every call, and every registered listener re-armed on the next period. Measured on one upload request (upload idle 1 s, store stalled): 64 listeners after 3 s, 4 096 after 8 s, **8 388 608 after 14 s**. With the defaults (30 s / 45 s) it stops near 2, but any allowed configuration with a wider ratio (store idle up to 300 s, upload idle down to 1 s), or a store that accepts bytes very slowly, exhausts memory and blocks the event loop: an approved invariant (bounded resources under a slow store, 17.9 O-4 / §5.3) did not hold. | defect (17.9) | **Fixed (the only production change):** `src/upload/upload-http.ts` re-arms with `req.setTimeout(ms)` (no new listener) and removes the listener on release. Re-measured: 1 listener at 3 s and at 14 s, same outcome (`503 storage_unavailable` at the store's idle bound). Regression test in `operations.e2e-spec.ts` (fails with 512 listeners on the old code: mutation M28). |
| D-2 | One 17.9 operational probe (`pressure.ops-spec.ts`, S3) set a 60 s download idle bound but not the store's idle bound, so the later 17.9 boot check refused the service: the probe could not run on the merged code (consistent with the unfilled 17.9 evidence table). | test defect (17.9) | the probe sets `FILE_STORAGE_IDLE_TIMEOUT_MS=90000`; 18 / 18 probes pass. |
| D-3 | The delete-worker fence (17.7: "a worker whose lease was taken over changes nothing") had no isolating test: the existing test called the stale `retryDeletion` only after the row was DELETED, where the status condition alone refuses it; mutation M12 (fence removed) survived. | test gap | new test in `deletion.e2e-spec.ts` (a stale holder cannot reschedule nor release a live claim); M12 now killed. |
| D-4 | OpenAPI did not document statuses the routes answer (§3). | contract documentation | annotations + a certification test. |
| D-5 | Documentation drift (§3), including an incorrect database rationale (§5.2). | documentation | corrected. |

No certification finding required a schema change, a new dependency, a configuration default change or a route change.

## 5. Database

### 5.1 Fresh database, rerun, catalog, privileges (§4 of the brief)

PostgreSQL 16.15 provisioned by `infra/postgres/init/01-service-databases.sh` (roles `file_migrator` / `file_app`, no superuser, no
`CREATEDB` / `CREATEROLE` / replication / `BYPASSRLS`):

- `npm run migrate` as the migrator: **6 applied** (3 kit + `0001`–`0003`); rerun: **0 applied, 6 already applied**; `pg_dump
  --schema-only` identical between the runs (only `pg_dump`'s per-dump `\restrict` nonce differs). Through the image: 0 applied.
- Catalog: `file` 26 CHECK + PK + UNIQUE; `file_access_ticket` 13 CHECK + PK + UNIQUE + FK (no cascade); 11 indexes (`file_pkey`,
  `file_storage_key_unique`, `file_idempotency_unique`, `file_upload_lease_idx`, `file_orphan_deadline_idx`, `file_delete_due_idx`, the
  4 ticket indexes, `kit_rate_limit_pkey`); 10 triggers, all enabled; every table, index and function owned by `file_migrator`, no
  `SECURITY DEFINER`; the only NOT VALID constraint is `file_original_name_no_marks` (intended).
- Runtime role `file_app`: DML only; refused (as `file_app`): `CREATE TABLE`, `ALTER TABLE`, `DISABLE TRIGGER`, `DROP TRIGGER`,
  `DROP CONSTRAINT`, `DROP INDEX`, `TRUNCATE`, `SET session_replication_role`, replacing a trigger function, creating a function,
  `VALIDATE CONSTRAINT`, `CREATE ROLE`, `pg_read_file`, connecting to another service's database; the schema's own guards refused an
  `AVAILABLE` insert, a hard delete, an owner change and an illegal transition.
- Observation (Core-wide, not File-specific): through the Core default privileges the runtime role also has DML on
  `schema_migrations` (it cannot apply DDL, but could falsify the ledger that readiness reads). Recorded for Stage 21 / 21.R1 (§11).

### 5.2 Upgrade path (§5)

| Path | Result |
|---|---|
| 17.3 schema (kit + `0001`) with representative rows (AVAILABLE, DELETING, DELETED, UPLOADING, FAILED, a download and an upload ticket) → HEAD | `0002`, `0003` applied; 6 / 6 rows and 2 / 2 tickets kept; the historical DELETING row scheduled (`deleteNextAttemptAt` set, attempts 0), others not; rerun 0 applied |
| 17.7 schema (`0001`, `0002`) → HEAD | `0003` applied; rows kept |
| an edited `0001` offered to the runner | refused: "0001_file_schema.sql was modified after it was applied" |

**NOT VALID treatment (measured):** `0003` does not check existing rows at creation, but PostgreSQL enforces a NOT VALID CHECK on every
UPDATE of a row. A row written before `0003` whose name holds one of the marks (a 17.3–17.7 row could) therefore can never change state
(`AVAILABLE → DELETING` refused), and one such row in a worker batch fails the whole batch statement (tested: the delete claim of a batch
holding one such row fails, and the healthy row in it is not claimed). `VALIDATE CONSTRAINT` fails over such a row (expected). No such
row can exist in a deployed database (production was never enabled before `0003`), so no data was mutated and no code changed; the
operational treatment is a precondition query before applying `0003` to any older database (migrations README, runbook §9): it must
return 0, otherwise the database is a development one and is recreated. The 17.8 record's rationale was corrected.

### 5.3 Query plans at realistic scale (§6)

500 000 files (462 000 AVAILABLE, 20 000 DELETED, 10 000 DELETING, 5 000 FAILED, 3 000 UPLOADING of which 1 000 stale, 2 000 expired
temporary files), 300 000 tickets (5 000 live), 100 000 limiter rows (4 of 5 buckets File's, 90 % expired); `ANALYZE`; statements
verbatim from the repositories; writes inside rolled-back transactions:

| Hot path | Plan | Time |
|---|---|---|
| scoped read (`findOwned`) | Index Scan `file_pkey` | 0.02 ms |
| download claim (digest + file join + cap) | Index Scan `…_token_digest_unique` → Index Scan `file_pkey` | 2.5 ms |
| upload claim / `findUsedUpload` | Index Scan `…_token_digest_unique` | 0.07 / 0.04 ms |
| ticket insert from the file row (`FOR SHARE`) | Index Scan `file_pkey` + LockRows | 0.8 ms |
| delete-worker claim (20) | Index Scan `file_delete_due_idx` (materialized, SKIP LOCKED) | 21 ms |
| temporary-file expiry (20) | Index Scan `file_orphan_deadline_idx` | 11.7 ms |
| stale upload scan | Index Scan `file_upload_lease_idx` | 0.05 ms |
| ticket retention (500) | Index Scan `file_access_ticket_expiry_idx` | 2.8 ms |
| revocation of a file's tickets / one ticket | Index Scan `file_access_ticket_file_idx` / `_pkey` | 0.5 / 0.04 ms |
| idempotency lookup | Index Scan `file_idempotency_unique` | 0.04 ms |
| limiter hit / peek | Index Scan `kit_rate_limit_pkey` | 0.03 ms |
| reconcile page (200) | Index Scan `file_pkey` | 1.1 ms |
| limiter retention (500) | Seq Scan `kit_rate_limit` under LIMIT (stops at 500) | 2.6 ms |
| ops snapshot (every interval) | Index-only / bitmap scans on the partial indexes; 2 seq scans of `kit_rate_limit` (~11 ms each at 100 000 rows) | 240 ms total |

No full scan of `file` or `file_access_ticket` on any hot path. The `kit_rate_limit` scans are bounded by retention (live windows plus
one interval) and run once per interval or under `LIMIT`; no index was added (the brief: no index for a dataset that is not slow).

## 6. Runtime certification

### 6.1 Boot (§7)

| Path | Result |
|---|---|
| source / development (`nest start`, filesystem, runtime role) | started; `/health` 200, `/ready` 200; no token 401; valid token on an unknown id → uniform 404; docs off; SIGTERM exit in 6 ms; 0 secret occurrences in 35 log lines |
| built / production (`node dist/main.js`, S3 endpoint unresolvable) | the same; startup never contacts the store |
| production image | §6.10 |

### 6.2 Fail-closed configuration matrix (§8)

58 configurations on the built process with `NODE_ENV=production`: the valid one boots; **57 unsafe ones exit 1** with a message that
names the variable (and, for relationships, the numbers), never a value. Covered: missing / superuser / migrator / non-postgres
`DATABASE_URL`; malformed `SERVICE_TOKENS`; tokens without a policy and a policy without tokens; malformed, wildcard, unknown-operation,
over-ceiling, off-allow-list policies; missing / unknown provider; filesystem in production; malformed, plain-HTTP, credentialed and
query-carrying S3 endpoints; short S3 secret; invalid bucket; traversal key prefix; `FILE_MAX_BYTES` 0 / 100 MiB + 1 / non-numeric; ticket
TTLs 30 s and 301 s; ticket cap 0 and 10 001; a zero rate; organization budget above caller budget; in-flight bounds 0 and 5 000; the
download and upload bounds over the S3 pools; 4 sockets; store idle not above client idle; batch 0 / 501; delete concurrency 17; a lease
below one pass; retry max below base; 101 batches per pass; purge batch 0; a 1 s report interval; DB pool 0 / 101; a non-numeric DB
timeout; missing / short / reused request-hash keys; 3 previous keys; a previous key equal to the current; plain-HTTP, credentialed and
trailing-slash public base URLs; a short docs password. A synthetic canary secret, the token, both keys and every database password were
searched in every output: 0 occurrences.

### 6.3 Health and readiness (§9, frozen)

`/health` = liveness only (200 whatever the database, the store or the load). `/ready` = database + migrations: 200 when both hold; 503
with the database gone (cert outage, `health.e2e`) or a migration pending (`health.e2e`); **200** with the store unreachable
(`health.e2e`, image, ops faults), at download / upload capacity (`operations.e2e`), and with no broker or Auth (neither is a
dependency). Bodies carry status and check names only (`security.e2e`). Kit behaviour recorded in 17.9 and re-observed here: under
database-pool saturation `/ready` answers 503 too (its check queues on the same pool) — Stage 21 (§11).

### 6.4 End-to-end flows (§10–§17, §26–§27)

`cert` runs the whole journey on **both adapters** (filesystem and S3): upload ticket issued by a trusted service → redeemed by an
untrusted client (owner = issuer, organization bound, a spoofed `X-Owner-Service` ignored, only the token's SHA-256 stored, SHA-256 and
size exact, no key in the view) → retry of the completed redemption (200, same file, nothing stored) → attach ×2 → reusable download
ticket ×2 (byte-exact, every §9 header, French + Arabic name in RFC 8187 form) → single-use ticket (once) → service read (`same-origin`)
→ delete (202 DELETING; content 410, old ticket `ticket_invalid`, new ticket 410; object still present) → delete retry (same request
time) → worker → DELETED, object gone → delete after DELETED (202 DELETED, access never restored) → terminal. The image repeats it on
S3 through the production build (§6.10). The 17.5–17.8 suites cover the failure matrices (§12 of the brief: malformed / expired /
revoked / consumed tickets, oversized, truncated, unsupported, MIME spoof, digest mismatch, disconnect, storage failure, overload) and
remain green.

### 6.5 Isolation and non-disclosure (§21–§23)

Two services (`core-drive`, `core-billing`), organizations A and B and platform files. Five owner operations (metadata, content, ticket
issuance, attach, delete) × nine probes (missing UUID, malformed id, SQL-shaped id, Billing → Drive's file, Drive → Billing's file,
right owner / organization B, organization file as platform, platform file with an organization, foreign service on a platform file):
**45 answers, one shape** (`404`, `file_not_found`, one message, the same body keys), and a database snapshot identical before and after
(nothing attached, deleted or ticketed). Revocation: foreign service, foreign organization, missing organization, unknown and malformed
ticket ids — one `404 ticket_not_found`; the probed ticket still works. No constant-time guarantee is claimed (the brief).

### 6.6 Ticket cap, integrity, headers, resources (§17–§20)

Frozen as in D3–D8 (§2.4). Evidence re-run green: 100 concurrent redemptions with cap 3 → exactly 3; tampering on both adapters; one-chunk
tamper sends nothing; headers exact through the application and the image; paused / trickling / disconnecting clients bounded (slots and
descriptors released: ops disconnect 300 → fds 34 → 33).

### 6.7 Rate limits and overload (§24–§25)

Values unchanged (600 / 120, 1 200 / 300, 1 200 / 300 per minute; 20 failed redemptions per keyed client). Exact under 500 concurrent
issuances; unrelated caller unaffected; 5 000 keyed clients purged by bounded batches; cert: probes of foreign ids are charged (the 17.8
"no free probing" rule — observed when the isolation matrix spent a caller's ticket budget). Overload: `429` = a caller's budget, `503
*_busy` = this process's capacity; neither consumes a ticket or touches readiness; slots return on failure and disconnect (mutations
M21–M23). Validity disclosure under overload, precisely: while downloads are at capacity a **valid** ticket answers `503 download_busy`
and an invalid one `404 ticket_invalid` (the 17.9 O-7 design: junk never occupies a slot); this tells a holder only what redeeming it
would, and tokens are 256-bit (R10). For uploads, a well-formed token of any validity answers `503 upload_busy` while busy (the slot is
taken before the claim), so nothing is disclosed.

### 6.8 Operations envelope (re-run of the 17.9 probes on the fixed build)

`npm run test:ops`: 18 / 18 (after D-2). Upload bound: 80 × 24 MiB → 64 × 201 + 16 × `503 upload_busy` (both adapters); 24 tickets
through a bound of 4 → 46 × 503 on the way, 24 × 201, each ticket used once. Downloads: 60 paused S3 readers all served, 0 database
sessions busy, an unrelated upload 201 and download 200 meanwhile. Connections: 500 keep-alive / slowloris / silent sockets all closed by
the server (5 s / 64 s / 64 s), descriptors back to baseline. Memory plateau ≈ 341 MiB over 12 000 downloads. Pool saturation: the known
kit behaviour (opaque 500, `/ready` 503; §11). Shutdown: upload and download cut at the 5 s drain bound, a hanging-store pass stopped in
18 ms with 8 claims released. `kill -9` + restart: 8 / 8 converged after the 30 s lease; live ticket 200; spent budget 429. Storage
refuse / hang / +50 ms / recovery as in 17.9 (no restart needed; 0 idle-in-transaction sessions; no bucket or endpoint in 93 log lines).
SHA-256 single-core rate 1 770 MiB/s.

### 6.9 Observability, cardinality, secrets (§38–§40)

Operators can distinguish every required condition from the lines of 17.9 (runbook §1): upload / download overload
(`file_ops_counters upload_busy / download_busy`), rate-limit saturation (`rate_limited_*`, `redemption_blocked`), storage failures
(`file_storage_ops outcome=storage_*`), cleanup backlog (`deleting_due`, `oldest_deleting_age_s`, `stale_uploads`, `temporary_expired`,
`limiter_expired`), persistent delete failures (`max_delete_attempts` + `delete_errors`), digest mismatch (`file_integrity_incident`,
`file_storage_inconsistent`), worker failure (`file_cleanup_pass_failed`, `file_ops_snapshot_pass_failure`), database readiness
(`readiness_check_failed check=database`, `db_pool_waiting`). **Cardinality:** snapshot / counter / storage lines carry closed-set labels
only (tested; mutation M25); per-event lines (`file_upload`, `file_download`, `file_deletion_*`, `file_storage_inconsistent`) carry a
file id, an owner service and a request id — structured investigation fields of LOGS, never metric labels; no line carries an
organization, ticket, digest, storage key, file name or client address. **Secrets:** scans of `src/`, `dist/`, the migrations, the
Dockerfile, the README, the SDD, the Stage 17 records, the runbook, ADR-0048 and the OpenAPI document: 0 access-key ids, private keys,
credentialed URLs, bearer literals, ticket URLs or 64-hex digests; OpenAPI has no examples. `.env.example` holds development placeholders
only (R17). Image history: 0 secrets; image and process logs: 0 leaks (the only `/file/t/` strings are Nest's startup route patterns).

### 6.10 Image (§41)

Built from this branch: `USER node` (uid 1000), `CMD node dist/main.js` (PID 1), environment `PATH`, `NODE_VERSION`, `YARN_VERSION`,
`NODE_ENV=production` only; production dependencies only (no test runner, spec, `.env` or key file; `typescript` is a runtime dependency
of `@nestjs/swagger`; `node_modules/@vitest` is an empty directory). Run with `--read-only --cap-drop ALL --security-opt
no-new-privileges`: `CapEff 0`, `NoNewPrivs 1`, root filesystem read-only (verified by a refused write), live and ready; helmet headers,
no `X-Powered-By`, TRACE 404, docs 404, no token 401. Production refuses the filesystem store (exit 1). Store unreachable: upload `503
storage_unavailable`, ticket issuance 201, `/ready` 200. Development container on the S3 test server (still read-only, no capabilities):
ticket upload → AVAILABLE with the exact SHA-256, retry 200, ticket download byte-exact with every header, HEAD 405, delete 202 → content
410 / old ticket `ticket_invalid` → the worker (1 s interval) → DELETED and the bucket empty. `docker stop`: 55 ms idle, 5.1 s during a
throttled download (the drain bound), exit 0. Migrations through the image as the migrator: 0 pending.

### 6.11 Dependencies (§42)

`npm audit --omit=dev` (File workspace, and the whole repository's production graph): **0 vulnerabilities**. The full graph reports 5
(2 high: `tmp`, `undici`; all via the root dev tool `@nestjs/mau`) — development tooling, absent from the image, not from Stage 17:
non-blocking. Stage 17's own direct dependencies: `@aws-sdk/client-s3` 3.1140.0 and `@smithy/node-http-handler` 4.12.1 (Apache-2.0,
pinned). Licenses of the 153 packages in the image: MIT 111, Apache-2.0 29, ISC 7, BSD-3-Clause 2, 0BSD 1, Python-2.0 1, and the two
private workspace packages. No upgrade was made.

### 6.12 OpenAPI (§43)

Mounted only with `SWAGGER_PASSWORD`, behind basic auth (401 without). The document lists exactly the implemented routes (no rename);
after D-4 every route documents what it answers: bearer security on service routes and none on `/file/t/{token}`; 401 / 403; `404
file_not_found` / `ticket_invalid` / `ticket_not_found`; `409 file_not_available` / `upload_in_progress`; `410 file_deleted`; `429`;
`503 storage_unavailable` / `upload_busy` / `download_busy`; uploads 400 / 408 / 411 / 413 / 415 / 422 / 500; downloads 500
`file_content_missing`. Pinned by a certification test. Kit-owned: `/ready`'s 503 is not in the kit's document (§11).

### 6.13 Reconciliation tool (§47)

Built CLI against seeded inconsistencies: bounded (`--limit 3` → 3 scanned, `next_after`), resumable (`--after`), machine-readable (JSON
lines: `fileId`, `status`, `finding` only; a summary), read-only by default; `--repair` removed exactly the two leftover objects of
FAILED / DELETED rows, never touched AVAILABLE findings; rows unchanged; invalid arguments exit 1 without echo; a refused store gives
`storage_unavailable` per row (a hanging store waits up to 30 s per row: runbook §8 says not to run it during an outage). **Detects:**
AVAILABLE rows with a missing or wrong-size object; objects still present for FAILED / REJECTED / DELETED rows. **Does not detect:**
same-size alterations (read-time only, D7), objects with no row (no listing), anything about UPLOADING / DELETING rows (the workers'),
tampering of metadata.

### 6.14 Runbook (§48)

Covers storage outage, cleanup backlog, persistent delete failure, integrity mismatch, overload vs rate limits, pool saturation,
credential rotation, reconciliation, deployment checklist and backup / restore consistency; it explicitly forbids hand edits of lifecycle
rows, moving a file back to AVAILABLE and deleting bucket objects. Added in 17.10: the migrations step and the `0003` precondition.

## 7. Test pyramid, regression, mutations, repeatability

| Suite | Result (final branch) |
|---|---|
| File unit (`npm test -w file-service`) | 257 passed, 11 files |
| File E2E (`test:e2e`, PostgreSQL 16 + VersityGW) | **304 passed, 18 files** (baseline on `main`: 293 / 17; +9 certification, +1 D-1 regression, +1 D-3 fence) |
| Certification suite (`test/certification.e2e-spec.ts`, new) | 9 passed (8 filesystem + 1 S3) |
| Operational probes (`test:ops`) | 18 / 18 |
| Kit: unit / integration (rate limit incl. `peek`, DB, DB resilience, migrations, strict migrations, generic triggers, query deadline) | 132 / 47 passed |
| Consumers of the kit primitives Stage 17 touched (`peek`, the 408 / 411 / 415 status texts, `poolStats`) — unit | Notification 311, Billing 321, Payment 92, Organization 138, Auth 117 |
| `lint` (oxlint type-aware), `typecheck`, `check:repo`, `test:repo`, `git diff --check` | clean |

Stage 17 kit changes (all additive): `RateLimitService.peek` (17.5), `STATUS_TEXT` 408 / 411 / 415 (17.5), `DbService.poolStats`
(17.9); the repository guard gained identifier-aware product-term matching (17.3) and the invisible-character check (17.5). The kit's
`observability.int-spec` could not be loaded locally without `TEST_RABBITMQ_URL` (its skip path builds a URL in the describe body):
broker-only, unrelated to File, recorded for 21.R1.

### 7.1 Mutation campaign

Inventory of the historical campaigns: 17.2 (7), 17.3 (12), 17.4 (16, one equivalent), 17.5 (17), 17.6 (24), 17.7 (23), 17.8 (40, one
equivalent); 17.9's table was never recorded. Decision: not a re-run of all ~140 (their harness was ad hoc and the files moved), but a
risk-based set of **28** spanning every certification area, including the 17.9 controls that had no recorded campaign and the 17.10
defect; each applied alone to the source, the relevant unit / E2E suites run, the source restored and all 57 source files verified
byte-identical by SHA-256 afterwards.

| # | Area | Mutation | Killed by |
|---|---|---|---|
| M1 | authorization | scoped read ignores the owner | cert |
| M2 | authorization | scoped read ignores the organization | cert |
| M3 | authorization | a null organization becomes a wildcard | cert |
| M4 | authorization | policy checks the caller but not the operation | `upload.e2e` (2) |
| M5 | authorization | ticket upload takes the owner from a header | cert (2) |
| M6 | non-disclosure | attach answers 403 for a foreign file | cert |
| M7 | non-disclosure | revocation ignores the organization | cert |
| M8 | ticket atomicity | upload claim ignores single use | `upload.e2e` (14) |
| M9 | ticket atomicity | reusable cap removed | `security.e2e` |
| M10 | lifecycle | download claim ignores AVAILABLE | `download.e2e` / `deletion.e2e` |
| M11 | deletion | delete does not revoke tickets | `deletion.e2e` (3) |
| M12 | deletion | worker fence removed | **survived first**; killed by the new fence test (D-3) |
| M13 | cleanup | claim ignores a live lease | cert restart |
| M14 | cleanup | abandoned upload's object not removed | cert restart |
| M15 | integrity | download digest not compared | `security.e2e` (2) |
| M16 | integrity | last chunk not held back | `download.spec` (2), `security.e2e` (2) |
| M17 | storage | filesystem containment removed | `security.spec`, `storage-filesystem.e2e` |
| M18 | storage | filesystem allowed in production | `storage-config.spec` |
| M19 | rate limits | usage limits never refuse | cert restart |
| M20 | rate limits | organization budget keyed by caller only | `security.e2e` (2) |
| M21 | overload | the gate never refuses | `ops.spec`, `security.e2e` / `operations.e2e` (2) |
| M22 | overload | download slot never released | `operations.e2e` |
| M23 | overload | a busy download commits its claim (spends a use) | `operations.e2e` |
| M24 | shutdown | the worker loop is not stopped | `deletion-s3.e2e` |
| M25 | observability | unbounded storage-outcome label | `ops.spec` |
| M26 | headers | raw name in the ASCII fallback | `download.spec` (4), cert (2) |
| M27 | headers | CORP `cross-origin` on service reads | cert (2) |
| M28 | operations | the D-1 defect (listener per re-arm) | `operations.e2e` (512 ≠ 1) |

**Result: 28 / 28 killed** (27 on the first pass; M12 after the test of D-3).

### 7.2 Repeatability

- Complete unit + E2E: one baseline run on `main` and two runs on the final branch (§7.3).
- The concurrency-, race-, lease-, worker- and outage-sensitive tests (certification suite; repository claims; deletion races,
  replicas, fence, leases; S3 concurrency; the cap; the operations bounds and the listener test) re-run 5 times (§7.3).
- The historically flaky scenarios named in 17.6 (truncation race, memory thresholds) are in the E2E runs. No test was skipped, retried or
  loosened to pass.

### 7.3 Final counts

| Run | Unit | E2E | Notes |
|---|---|---|---|
| baseline, `main` `dc3722f` | 257 / 257 | 293 / 293 (17 files, 111 s) | before any 17.10 change |
| final branch, run 2 | 257 / 257 | 304 / 304 (18 files, 126 s) | |
| final branch, run 3 | 257 / 257 | 304 / 304 (18 files, 127 s) | |
| sensitive subset × 5 | — | 46 / 46 each time | certification, claims, races, replicas, fence, leases, S3 concurrency, cap, bounds, listener |
| operational probes | — | 18 / 18 | after D-2 |

No flaky result in any run; nothing skipped except the suites' own environment gating (none, with every `TEST_*` variable set).

## 8. Frozen guarantees (the closure contract)

1. **Ownership and isolation:** every operation acts only on the caller's own files in the presented organization (null = platform, never
   a wildcard); anything else is one indistinguishable `404`. File never calls Auth or a product service; it never validates a user JWT.
   Products authorize their users, then issue capabilities.
2. **Tickets:** opaque 256-bit tokens, only their SHA-256 stored; one operation on one file or one upload intent; TTL 60–300 s (default
   120 s), never extended; upload tickets single-use (consumed at claim commit; a refused claim does not consume); download tickets
   reusable until expiry **and at most `FILE_TICKET_MAX_DOWNLOADS` uses** (default 50, 1–10 000, server-only), or single-use; revocable;
   every refusal one `ticket_invalid`; a ticket is never a credential.
3. **Upload:** streamed; size ≤ min(ceiling, policy, ticket) with `Content-Length` required; type from the bytes (PDF, JPEG, PNG, WebP,
   HEIC, HEIF); SHA-256 over exactly the stored bytes; immutable once AVAILABLE; idempotent service uploads.
4. **Integrity (exact wording of 17.8):** *a download whose streamed bytes do not match the authoritative stored SHA-256 cannot complete
   successfully* — the response is terminated before its last chunk; a size mismatch or a missing object fails before any byte; a file
   that fits in one chunk sends nothing. **Not** claimed: that no altered byte is ever transmitted (bytes before the last chunk may be).
5. **Lifecycle:** DB is the authority; delete is logical first (access stops at commit, tickets revoked in the same transaction), physical
   deletion asynchronous with lease, fence and backoff, never restoring access; tombstones stay; temporary files expire through the same
   path; abandoned uploads are failed, never promoted.
6. **Malware:** **no malware scanning exists.** The guarantees are type / signature validation, size validation, private storage,
   controlled access, SHA-256 integrity, `attachment` by default, `nosniff` and a sandbox CSP. A syntactically valid PDF or image may
   still contain malicious content (decision B; F19 is an owner decision before production user uploads: P3).
7. **Operations:** `/health` liveness only; `/ready` database + migrations only (storage, overload, broker and Auth never affect it);
   overload `503 *_busy` vs policy `429`; bounded signals; bounded shutdown; recovery without manual database work.

## 9. Residual risk register

| # | Risk | Impact | Current mitigation | Why accepted / deferred | Owner / stage | Production blocker? |
|---|---|---|---|---|---|---|
| R1 | Malicious content inside a valid PDF / image (no scanner) | a viewer exploit on a user's device | allow-list (no executables, archives, Office, HTML, SVG), attachment default, `nosniff`, sandbox CSP, no server-side parsing | decision B (17.8); scanning needs an owner / security choice | owner, F19 (P3) | **decision required** before production user uploads |
| R2 | A stolen reusable download ticket used within its TTL and cap | one file read up to 50 times in ≤ 300 s | 256-bit, digest-only, never logged, `no-referrer`, `no-store`, TTL, cap, revocation, single-use option | the product chooses single-use for sensitive links | products (Stage 21) | no |
| R3 | A stolen service token acts as its caller | that caller's operations within its policy and budgets | token digests, deny-by-default policy, budgets, rotation (runbook §7) | inherent to service auth | operations | no |
| R4 | Homoglyph / confusable names | display spoofing | sanitizer, attachment, the verified type decides | printable Unicode is legitimate (Arabic / French) | — | no |
| R5 | A product passes a wrong organization of its own tenant | a file recorded under the wrong organization | organization immutable and enforced afterwards | File cannot verify business ownership (F2) | products | no |
| R6 | Provider-specific S3 behaviour untested live (`If-None-Match: *`, `ContentLength` on GET, 404 / 412 mapping, throughput, latency from Tunisia / MENA) | uploads refused or misclassified on a real provider | contract suite + probes on VersityGW; checklist 17.4 §12 | no provider chosen (O2 / F6) | owner (P1) | **yes** (P1) |
| R7 | TLS termination, proxy trust and connection limits live outside the service | redemption limiter bypass with a wrong `TRUST_PROXY`; connection exhaustion | runbook §9 checklist; silent-socket bound | infrastructure responsibility | operations (P7) | **yes** (P7) |
| R8 | Database and bucket restored to different points in time | missing objects, resurrected deleted files | reconcile tool, runbook §10 | backup / DR not built (F34) | owner (P4) | **yes** (P4) |
| R9 | Defaults are safety bounds, not capacity figures | refusals or waste under real traffic | bounded, validated configuration; measured envelope (17.9) | no production traffic yet | operations (P9) | no (tune at enablement) |
| R10 | Under download capacity a valid ticket answers 503, an invalid one 404 | validity learnable only by a holder | 256-bit tokens; failures still limited | the O-7 design keeps junk out of the slots | — | no |
| R11 | A storage failure after a claim spends a single-use ticket (upload or download) | the client needs a new ticket | the product re-issues; reusable tickets retry | a claim must commit before bytes flow | products | no |
| R12 | Bytes before the last chunk of a tampered object reach the client | a client that ignores `Content-Length` / ETag could use them | truncated response, ETag = SHA-256, incident signal | the streaming model (no whole-file buffering) | — | no |
| R13 | Tampering is detected only on read; reconcile compares sizes | a same-size alteration unnoticed until read | download digest check, incident alert, provider versioning (P4) | no continuous scanner in V1 (F28) | later | no |
| R14 | Pool exhaustion answers an opaque 500 and flaps `/ready` | misleading status under DB saturation | pool bounds, `db_pool_waiting` signal, runbook §6 | Core-wide kit behaviour | Stage 21 (kit) | no |
| R15 | Filesystem adapter check-to-link window | only if the root is writable by another principal | root owned by the service user; refused in production | Node has no `openat` | development only | no |
| R16 | The runtime role holds DML on `schema_migrations` (Core default privileges) | a compromised runtime could make readiness lie | cannot apply DDL; readiness is advisory | Core-wide provisioning | Stage 21 / 21.R1 | no |
| R17 | Production accepts the published `.env.example` development keys | predictable request-hash / rate-limit keys | the example is labelled development-only | no deny-list of known keys | operations (P5) | no (P5) |
| R18 | A pre-`0003` row with a bidi mark in its name would freeze and fail worker batches | a stuck worker on such a database | no deployed database has one; precondition query | historical development data only | operations | no |
| R19 | Under upload capacity a well-formed junk token gets `503` and is not counted as a failed redemption | a busy process gives a prober no failure budget penalty | 256-bit tokens; the slot is held only for one short claim when not busy | slot before claim keeps "busy never consumes a ticket" simple | — | no |

## 10. Production prerequisite register

Verified against the merged documents (17.1 §8, SDD §18, 17.4 §12, 17.8 §6, 17.9 §16, the runbook); none is invented.

| # | Prerequisite | Source |
|---|---|---|
| P1 | Choose the S3-compatible provider (vendor ADR: cost / egress, Tunisia / MENA latency, residency, DPA, durability) and run this stage's contract suite and the 17.9 probes against it (live smoke) | F6 / O2; 17.4 §12; 17.9 §16 |
| P2 | Provision the bucket: private, SSE at rest, least-privilege credentials (Put / Get / Head / Delete on the prefix only), no public access | F20; 17.4 §5 / §12; runbook §7 |
| P3 | Owner decision on malware scanning for production user uploads (F19; the `VERIFYING` hook exists) | 17.1 F19; 17.8 §6 |
| P4 | Backup / DR: database backups, bucket versioning with a retention longer than the backup interval, paired restore procedure | F34; runbook §10 |
| P5 | Production secrets generated fresh and mounted (`*_FILE`): service tokens, `FILE_REQUEST_HASH_KEY`, `FILE_RATE_LIMIT_KEY`, database roles, S3 credentials, docs password if docs are enabled | 17.5 §12; runbook §7 |
| P6 | External alert routing for the runbook §1 rules | 17.9 §9 |
| P7 | Load balancer: TLS, per-client and total connection caps, idle timeout below 65 s, `X-Forwarded-For` overwritten when `TRUST_PROXY=true`; drain bound below the orchestrator's grace | 17.9 §5.4; runbook §9 |
| P8 | Container memory limits measured on the production image | 17.9 §16 |
| P9 | Tune the defaults (bounds, budgets, cap, cleanup) against real traffic | 17.9 §16 |
| P10 | Legal retention durations for tombstones and failed rows (F23) | 17.1 F23; 17.7 §12 |
| P11 | `FILE_SERVICE_POLICY` entries for the real consumers (operations, organization mode, types, `maxBytes`) | SDD §11 |

## 11. Stage 21 / 21.x hand-off (not implemented here)

**Stage 21 — Shared Services Integration:** Drive (upload / download tickets after its own authorization, `fileId` on its records,
attach after its write, delete with its record); Billing (service upload of rendered PDFs created attached, its own SHA-256 check,
downloads through its authorization and tickets); caller policies per consumer (P11); **Notification attachments** (F25: an
owner-issued read delegation, `file_delegation`, streaming at send time — deferred until then, not started in Stage 17). Audit events
(`file.*` through the kit outbox, F24) belong to Stage 18.

**Stage 21.x — Production Prerequisite Closure:** P1–P10.

**21.R1 / 21.R2 and the kit:** route naming (`/file/files`, `/file/t`); a distinct 503 for database-pool exhaustion and a readiness check
that does not queue behind requests (R14); runtime-role DML on `schema_migrations` (R16); `/ready` 503 in the kit's OpenAPI; the kit
`observability.int-spec` local-skip bug; Notification's foundation log-leak test (carried from 17.2); the stale configuration comment and
test title (§3).

## 12. Closure decision

- **Certification blockers open: none.** The one defect that broke an approved invariant (D-1) is fixed with a regression test and a
  killed mutation; the test gaps (D-2, D-3) and the documentation / contract drift (D-4, D-5) are corrected.
- **Every invariant of the matrix has current evidence:** 55 invariants, 54 PASS (O9 after the D-1 fix), 1 accepted risk with an owner
  decision pending (S9 malware scanning → R1 / P3); no FAIL.
- **Stage 17 can be formally closed** for the File Service V1 scope after human review of this branch (it contains one production-code
  change, D-1).
- **Production enablement is not certified:** it requires P1–P11, with P1 (provider + live smoke), P3 (malware decision), P4 (backup /
  DR) and P7 (edge configuration) as the gating items.

## 13. Changes in this stage

| File | Change |
|---|---|
| `apps/file-service/src/upload/upload-http.ts` | D-1 fix (re-arm without a new listener; remove it on release) |
| `apps/file-service/src/{upload/upload,download/download,deletion/deletion}.controller.ts` | OpenAPI response annotations only (D-4) |
| `apps/file-service/test/certification.e2e-spec.ts` | new: the cross-stage certification suite (9 tests) |
| `apps/file-service/test/operations.e2e-spec.ts` | D-1 regression test |
| `apps/file-service/test/deletion.e2e-spec.ts` | D-3 fence test |
| `apps/file-service/test/ops/pressure.ops-spec.ts` | D-2 probe fix |
| `docs/…` (SDD, 17.1, 17.2–17.9 status lines, 17.6, 17.8, 17.9, README, migrations README, runbook) | D-5 drift corrections |
| this record | new |

No schema, migration, dependency, configuration default, route, response shape or kit change.

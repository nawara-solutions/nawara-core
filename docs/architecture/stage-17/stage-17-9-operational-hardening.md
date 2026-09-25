# Stage 17.9 — File operational hardening

- **Status:** merged (PR #113). **Stage 17.10 found and fixed one defect of this stage** (the upload idle re-arm, O-4: [17.10 record](./stage-17-10-focused-certification.md) §4).
- **Scope:** the operational envelope of File Service, established by measurement: download verification cost, download and upload
  concurrency, connection pressure, slow and disconnecting clients, database pool pressure, storage latency / outage / recovery, cleanup
  backlog, rate limits under concurrency and growth, shutdown and restart recovery, credential rotation; the operational signals
  (`file_ops_snapshot`, F27) and alert-ready conditions; the operator runbook ([`docs/runbooks/file-service.md`](../../runbooks/file-service.md)).
- **Not in scope (and not present):** File certification (17.10); the audit trail (Stage 18); a production object store (O2 / F6), a
  malware scanner (F19), storage quotas, backup / DR (F34), external alert routing; a metrics platform (Core has none: F27); route or
  API cleanup (21.R1 / 21.R2); Stage 15.9 / 22 validation.
- **Frozen design followed:** [ADR-0048](../../adr/0048-file-service-architecture.md), [SDD](../../sdd/file-service.md), the
  [Stage 17.1](./stage-17-1-decisions-and-roadmap.md) decisions (F27 observability, F28 reconciliation, F32 rate limits, F34 backup),
  the 17.2–17.8 records, and the 17.8 integrity contract (unchanged, §4). No decision reopened; every behaviour change is listed in §3.

## 1. Baseline

`main` at `2c61625` (Stage 17.8 merged, PR #112). Carry-overs addressed here: 17.1 (signals, snapshot, runbooks, key / credential
rotation, production image), 17.4 (storage signals, credential rotation runbook), 17.5 (request-hash and rate-limit key rotation), 17.6
(signals, production image review), 17.7 (backlog signals, alerting, key rotation), 17.8 (SHA-256 cost, throughput, download and
connection caps, ticket-cap / upload-cap / rate-limit tuning). "Outbox events if Stage 18 needs them" stays with Stage 18 (nothing
consumes them yet).

**Measurement environment** (every number below is from it; none is a capacity claim):

| Item | Value |
|---|---|
| Host | Intel Core i5-12450H, 12 logical CPUs, 11 GiB RAM, Linux 6.19 (Kali); `/tmp` on tmpfs |
| Node | v24.18.0 for the probes (the image runs `node:22-alpine`; the image probe re-checked behaviour, not throughput) |
| PostgreSQL | 16.15 (`postgres:16-alpine`, throwaway container, `max_connections=200`) |
| S3-compatible test server | VersityGW v1.8.0 on tmpfs (semantics only: its throughput says nothing about R2, S3 or any provider) |
| Service | the BUILT service (`dist/main.js`) as its own process; CPU, memory and descriptors read from `/proc/<pid>`, so the load client is not in the measurement; `NODE_ENV=development` (filesystem allowed), `LOG_LEVEL=info` |
| Defaults in force | `DB_POOL_MAX=10`, `DB_CONNECTION_TIMEOUT_MS=5000`, statement 30 s; headers 60 s, keep-alive 5 s; upload / download idle 30 s; upload bound 64; download bound 64 (17.9); ticket cap 50; F32 budgets 600/120, 1200/300, 1200/300 per minute (raised to 10^6 in the throughput probes so they measure the byte path, not the policy); cleanup: 30 s interval, batch 20, delete concurrency 4, lease 300 s |
| Objects | 64 KiB, 1 MiB, 24 MiB (near the 25 MiB `FILE_MAX_BYTES` default); random bytes behind a PDF signature (incompressible) |

**How to reproduce:** `npm run build -w file-service`, then with `TEST_DATABASE_ADMIN_URL` (and `TEST_S3_*` for the S3 rows) set:
`npm run test:ops -w file-service` (all probes) or one file (`… -- test/ops/download-cost.ops-spec.ts`). `OPS_REPORT=<file>` collects
the result lines. Knobs: `OPS_SIZES`, `OPS_CONCURRENCY`, `OPS_ADAPTERS`, `OPS_ENTRY` (another build), `OPS_HELD`, `OPS_BACKLOG`,
`OPS_CLEANUP_ENV`, `OPS_UPLOAD_CONCURRENCY`, `OPS_CONNECTIONS`. The probes are not part of `test` or `test:e2e` (slow, machine
dependent); their assertions are resource invariants (no failures, no busy database session while bytes stream, descriptors back to
baseline, exact budgets), never timings.

## 2. Findings

| # | Finding (measured) | Kind | Resolution |
|---|---|---|---|
| O-1 | **Slow readers starved every download on S3.** 60 paused readers on the S3 reader client's 50-socket pool: 10 of them failed, and an unrelated small download failed `503 storage_unavailable` after 6 s. Downloads had no bound at all. | availability | `FILE_DOWNLOAD_MAX_IN_FLIGHT` (default 64) + `FILE_S3_MAX_SOCKETS` (default 96, per client) + a boot check that the byte-path bounds fit the pools (§5.1). Re-measured: 60 held → all served, the unrelated download 200 in 5 ms; 80 held → exactly 64 served, the rest `503 download_busy` at once. |
| O-2 | **A reader that trickles held a download forever** (the idle timeout only fires on a full stop). | availability | whole-transfer download deadline: storage request timeout + size at `FILE_DOWNLOAD_MIN_THROUGHPUT_BYTES_PER_SECOND` (default 16 KiB/s: 24 MiB → 26 min 40 s max) (§5.2). |
| O-3 | **`FILE_STORAGE_IDLE_TIMEOUT_MS` never ended a stalled S3 transfer** (since 17.4). In `@smithy/node-http-handler` 4.x `requestTimeout` is a whole-request timer that only WARNS (to the console); the idle bound is `socketTimeout`. A store that accepts and never answers held an upload until the service's own 30 s client timer, which then blamed the client and closed the connection without an answer. | defect (17.4) | `socketTimeout` (and the handler's logger silenced); default raised 30 s → 45 s, and it must exceed the client idle timeouts (boot check) so a stalled client is cut by the client's timer (§5.3). Re-measured: a hanging store fails the upload `503 storage_unavailable` (`storage_timeout`) at the store's bound. |
| O-4 | **The upload idle timer blamed the client for the store's backpressure**, and, once the body was complete, **destroyed the connection without an answer** while a slow store was still accepting the tail (Node does not deliver a socket timeout to a complete request; with no listener it destroys the socket). | defect (17.5) | the idle timer re-arms while bytes wait unread (the store, not the client, is slow) and is cleared once the body is complete (§5.3). Regression tests with fake stores. |
| O-5 | **Connections that send nothing were never closed** (500 silent sockets held 500 descriptors indefinitely; a partial request line closes at 65 s, an idle keep-alive at 5 s). | availability | `server.timeout` = max(headers timeout, one database wait) + 5 s = 65 s by default (§5.4). Re-measured: silent sockets closed at 64 s. |
| O-6 | **Each cleanup task handled one batch per pass**: at most `batch / interval` = 40 rows a minute per task and replica, below what deletes, issuance and redemption failures can produce (measured: 18 rows per pass per category). | backlog | drain mode: a task repeats full batches up to `FILE_CLEANUP_MAX_BATCHES_PER_PASS` (10); the SQL-only purges use `FILE_CLEANUP_PURGE_BATCH_SIZE` (500); only settled rows count as progress, so an outage still costs one batch per pass (§6). Re-measured: 2 000 rows per category drained in 2–30 s at a 1 s interval. |
| O-7 | **The 17.9 download bound itself, first placed before the ticket claim, let junk tickets occupy slots** (1 773 of 5 000 junk redemptions answered 503 instead of 404) and would have let a junk flood starve real downloads. | defect (found in this stage) | the redemption takes its slot INSIDE the claim's transaction, after the ticket proved valid; a full process rolls the claim back (no use spent) (§5.1). Re-measured: 5 000 junk → 5 000 × 404. |
| O-8 | **No operational signal existed** beyond per-event log lines (F27 planned `file_ops_snapshot`). | observability | `file_ops_snapshot`, `file_ops_counters`, `file_storage_ops`, `file_integrity_incident` (§8). |
| O-9 | **Request-hash key rotation turned honest retries into `422`** (no previous-key window, unlike Notification). | operations (17.5 carry-over) | `FILE_REQUEST_HASH_PREVIOUS_KEYS` (at most 2) (§10). |

Everything else probed held as designed (§4–§11): memory bounded, descriptors released, no database session busy while bytes stream,
`/ready` independent of storage, exact rate budgets under concurrency, automatic convergence after outages and restarts.

## 3. Behaviour changes (explicit)

| Before | Now | Why |
|---|---|---|
| downloads unbounded per process | `FILE_DOWNLOAD_MAX_IN_FLIGHT` (64); over it `503 download_busy` (retryable, nothing consumed) | O-1 |
| a download bounded only by the client idle timeout | also a whole-transfer deadline (`outcome=deadline`) | O-2 |
| S3 socket pool 50 (fixed) per client | `FILE_S3_MAX_SOCKETS` (96, 8–1 024), validated against the bounds | O-1 |
| `FILE_STORAGE_IDLE_TIMEOUT_MS` inert, default 30 s, max 120 s | enforced (`socketTimeout`), default 45 s, max 300 s, must exceed the client idle timeouts | O-3 |
| upload idle timer could fire under store backpressure / after a complete body | only a client that stops sending is cut | O-4 |
| silent connections never closed | closed after 65 s (default) | O-5 |
| one batch per task per pass | drain mode (`FILE_CLEANUP_MAX_BATCHES_PER_PASS` 10, `FILE_CLEANUP_PURGE_BATCH_SIZE` 500) | O-6 |
| after an upload's `storage_timeout`, the answer waited for a best-effort object delete (up to the request deadline) | the delete runs in the background; the refusal and the FAILED row are unchanged | the answer never waits on a store that just timed out |
| request-hash key rotation had no window | `FILE_REQUEST_HASH_PREVIOUS_KEYS` | O-9 |
| — | new error code `download_busy` (503) | O-1; `upload_busy` (17.8) unchanged |

No route, request or response shape changed; `429 rate_limited` and `503 upload_busy` keep their 17.8 meaning.

## 4. Download verification cost (SHA-256, Stage 17.8)

The 17.8 contract is unchanged: SHA-256 is recomputed during every download, only the last chunk is held back, and **an
integrity-mismatched download cannot complete successfully** (bytes before the last chunk may already have been sent). Nothing is
buffered whole (measured below).

Cost, isolated with a measurement-only build without the two hashing lines (never committed; deleted after the runs), medians of 3
runs each:

| Adapter, size, concurrency | Verified MiB/s | No-hash MiB/s | Ratio | Extra CPU ms per MiB |
|---|---|---|---|---|
| filesystem, 24 MiB, 1 | 589 | 870 | 0.68 | +0.46 |
| filesystem, 24 MiB, 10 | 910 | 1 204 | 0.76 | +0.12 |
| filesystem, 24 MiB, 50 | 819 | 1 265 | 0.65 | +0.33 |
| S3, 24 MiB, 1 | 595 | 728 | 0.82 | +0.87 |
| S3, 24 MiB, 10 | 644 | 979 | 0.66 | +0.92 |
| S3, 24 MiB, 50 | 643 | 884 | 0.73 | +0.41 |
| filesystem, 1 MiB, 10 / 50 | 416 / 384 | 481 / 527 | 0.86 / 0.73 | +0.80 / +0.80 |
| S3, 1 MiB, 10 / 50 | 280 / 303 | 343 / 324 | 0.82 / 0.94 | +0.96 / +0.64 |

- **CPU:** verification costs about 0.1–1.0 ms of CPU per MiB served, consistent with this CPU's single-core SHA-256 rate (1 800–2 000
  MiB/s, 0.5 ms/MiB). Budget one core per ~1–2 GiB/s of downloads on similar hardware.
- **Throughput:** it matters only when ONE process is CPU-bound on large objects: the per-process ceiling drops from ~0.9–1.3 GiB/s to
  ~0.6–0.9 GiB/s here (5+ Gbit/s, above typical egress). Small objects are dominated by per-request work (64 KiB: 15–64 ms CPU per
  MiB, hashing is noise). Single runs of the 1 MiB / concurrency 1 case vary more than the difference.
- **Memory:** growth during a batch stays under ~100 MiB even for 50 concurrent 24 MiB downloads on S3 (1.2 GiB in flight): no
  whole-file buffering. Resident memory plateaus near 340 MiB under sustained load (12 000 downloads: 278 → 344 MiB, flat after the
  first 3 000): lazy collection, not a leak.
- **Event loop / health:** `/health` p95 stays under 20 ms at every level on the filesystem adapter and under 120 ms at 50 concurrent
  24 MiB S3 downloads.

Verified-download detail (the complete matrix, before the 17.9 bounds existed; the bounds are not binding at ≤ 50):

| Adapter | Size | Concurrency | MiB/s | p95 ms | Server cores | Memory growth MiB | Descriptors peak | DB busy peak |
|---|---|---|---|---|---|---|---|---|
| filesystem | 64 KiB | 1 / 10 / 50 | 23 / 79 / 94 | 4 / 13 / 48 | 0.7 / 1.4 / 1.5 | 30 / 35 / 2 | 27 / 49 / 117 | 1 / 5 / 10 |
| filesystem | 1 MiB | 1 / 10 / 50 | 183 / 511 / 414 | 12 / 29 / 134 | 1.6 / 2.1 / 1.6 | 0 / 4 / 1 | 36 / 53 / 128 | 1 / 2 / 4 |
| filesystem | 24 MiB | 1 / 10 / 50 | 548 / 823 / 776 | 56 / 291 / 1 545 | 1.9 / 2.3 / 1.8 | 0 / 3 / 4 | 36 / 54 / 134 | 0 / 0 / 10 |
| S3 | 64 KiB | 1 / 10 / 50 | 13 / 42 / 42 | 7 / 21 / 100 | 0.8 / 1.1 / 1.2 | 35 / 62 / 3 | 27 / 50 / 111 | 1 / 2 / 2 |
| S3 | 1 MiB | 1 / 10 / 50 | 155 / 290 / 306 | 12 / 45 / 190 | 1.5 / 1.7 / 1.6 | 46 / 5 / 17 | 36 / 52 / 124 | 1 / 2 / 10 |
| S3 | 24 MiB | 1 / 10 / 50 | 503 / 563 / 619 | 66 / 426 / 1 937 | 2.2 / 2.0 / 1.9 | 4 / 33 / 104 | 36 / 54 / 134 | 1 / 3 / 9 |

"DB busy peak" is sampled from `pg_stat_activity` during the batch: the peaks at high concurrency are the authorization queries of
requests starting together; with 60 readers held mid-stream, **0** sessions are busy (§7).

## 5. Concurrency and connections

### 5.1 Download bound (O-1, O-7)

Per process, `FILE_DOWNLOAD_MAX_IN_FLIGHT` (default 64, 1–4 096). A service read takes its slot after authorization, the usage limits
and the lookup, before the store is opened; a ticket redemption takes it inside the claim's transaction (valid tickets only; a full
process rolls the claim back). Released exactly once when the download settles (success, failure, disconnect, deadline). Over the bound:
`503 download_busy`. Why 64: it matches the upload bound; measured cost per held download is ~1.2–1.6 MiB of memory and two
descriptors, so 64 held downloads cost ~100 MiB, while CPU saturates near 5–10 concurrent large downloads anyway (more concurrency
adds latency, not throughput). It is a safety bound, not a capacity figure.

On S3, each download holds a socket of the READER client for its whole transfer (deletes and heads share that pool); uploads hold
sockets of the WRITER client. Boot check: `FILE_UPLOAD_MAX_IN_FLIGHT ≤ FILE_S3_MAX_SOCKETS` and `FILE_DOWNLOAD_MAX_IN_FLIGHT +
FILE_DELETE_CONCURRENCY + 8 ≤ FILE_S3_MAX_SOCKETS` (defaults: 64 ≤ 96; 64 + 4 + 8 = 76 ≤ 96).

Measured after the change (S3, 24 MiB, paused readers): 60 held → 60/60 served, an unrelated upload 201 (84 ms), download 200 (5 ms),
metadata 200; 80 held → 64 served, 16 `503`, the unrelated download `503 download_busy` in 3 ms (explicit overload instead of a 6 s
storage failure). Filesystem identical in outcome.

### 5.2 Slow and disconnecting clients (O-2)

- A paused reader is cut after `FILE_DOWNLOAD_IDLE_TIMEOUT_MS` (30 s, 17.6); a trickling reader after its whole-transfer deadline
  (§3); either frees its slot (tested: `outcome=deadline`, the next download 200).
- 300 client disconnects mid-download (6 waves of 50): 300 × `outcome=aborted` logged, descriptors 34 → 33 after the storm, memory
  flat, and 50 concurrent full downloads succeed right after: no leaked stream, socket or slot, on both adapters.
- Uploads: a client that stops sending is cut at `FILE_UPLOAD_IDLE_TIMEOUT_MS`; a client that disconnects releases its slot (17.8
  tests); the upload slot is released on every path (17.8 + mutation M6).

### 5.3 Idle timers on both sides of a stream (O-3, O-4)

| Situation | Timer that ends it | Code / outcome |
|---|---|---|
| the client stops sending an upload | `FILE_UPLOAD_IDLE_TIMEOUT_MS` (30 s) | `408 upload_timeout` |
| the client stops reading a download | `FILE_DOWNLOAD_IDLE_TIMEOUT_MS` (30 s) | connection closed, `outcome=aborted` |
| the client reads a trickle | whole-transfer deadline | connection closed, `outcome=deadline` |
| the store stops reading an upload (backpressure) | `FILE_STORAGE_IDLE_TIMEOUT_MS` (45 s) | `503 storage_unavailable`, `outcome=storage_timeout` |
| the store stalls mid-download | `FILE_STORAGE_IDLE_TIMEOUT_MS` | connection closed, `outcome=stream_failed` |
| the store never answers | request deadline (10 s first byte / put deadline) | `503 storage_unavailable` |

The store's idle bound must exceed both client idle bounds (boot check): when a client stalls, the store's socket goes quiet too, and
the client's timer must fire first. It must also exceed the provider's worst silent wait for a complete PUT (measured through a proxy:
a 3 s bound fails a 1 MiB upload whose store answers ~12 s after the body; the 45 s default absorbs this).

### 5.4 HTTP connection pressure (O-5)

| 500 connections that … | Descriptors | Memory | `/health` p95 meanwhile | Closed by the server |
|---|---|---|---|---|
| sent a request, then stay idle (keep-alive) | +500 | +11 MiB | 4–5 ms | all at 5.0 s (`keepAliveTimeout`) |
| send half a request line (slowloris) | +500 | +0–8 MiB | 2–8 ms | all at 64–65 s (`headersTimeout` + check interval) |
| send nothing at all | +500 | +0 MiB | 2 ms | **never** before 17.9 → all at 64 s now (`server.timeout`) |

Node's other defaults are kept (headers 60 s, keep-alive 5 s, no `maxRequestsPerSocket`); `requestTimeout` stays sized for uploads
(17.5). The process alone has no connection cap: per-client and total connection limits, TLS and request-rate shaping are the load
balancer's job (runbook §9), which also keeps idle client connections from reaching the service at all.

### 5.5 Uploads (the 17.8 bound: kept at 64)

| Adapter, size | 1 | 16 | 64 | 80 (over the bound) |
|---|---|---|---|---|
| S3, 1 MiB: MiB/s, p95 ms | 17, 57 | 119, 133 | 191, 315 | 235, 329 (80 × 201: short uploads finish before the 80th starts) |
| S3, 24 MiB: MiB/s, p95 ms, memory | 374, 64, +0 | 615, 621, +14 MiB | 653, 2 307, +46 MiB | 613, 2 478, +68 MiB: **64 × 201, 16 × 503 `upload_busy`** |
| filesystem, 24 MiB | 506, 47 | 655, 586 | 686, 2 229, +30 MiB | 64 × 201 + 16 × 503 on a disk-backed root (see below) |

64 is kept: at the bound, memory grows ~70 MiB (streams, no buffering), CPU stays near 1.5–2 cores, database sessions ≤ 8, and `/health`
p95 < 100 ms; throughput is flat from 16 to 64 (the process is CPU / store bound), so a higher bound would only add latency, and a lower
one would refuse legitimate parallel uploads earlier. Overload invariant re-validated under concurrency: 24 ticket redemptions of 8 MiB
against a bound of 4, retried on `503`: 44 × `upload_busy` on the way, **24 × 201, every ticket used exactly once**. (One filesystem run
on the tmpfs `/tmp` produced `400 upload_aborted` answers while tmpfs was nearly full; the same 80 × 24 MiB batch against an ext4 root
with an out-of-process client gave 64 × 201 + 16 × 503 three times out of three. The filesystem adapter is development-only.)

### 5.6 Reusable-ticket cap (`FILE_TICKET_MAX_DOWNLOADS`: kept at 50)

It is a security bound on a leaked link (17.8), not a capacity figure; no measurement here argues for another value. Legitimate use
of one ticket within its 60–300 s life is a handful of requests (a browser retry, an image rendered twice, a resumed attachment): 50 is
an order of magnitude above that and three orders below "unlimited". Unchanged, server-controlled, atomic (17.8: 100 concurrent
redemptions against a cap of 3 serve exactly 3).

## 6. Cleanup backlog (O-6)

Seeded backlogs (DELETING rows whose objects are gone, abandoned uploads, expired temporary files, expired tickets, expired limiter
windows), the built service with its workers on a 1 s interval:

| Build | Rows per category | Deletes | Abandoned | Temporary (expire + delete) | Tickets | Limiter | CPU | DB busy peak |
|---|---|---|---|---|---|---|---|---|
| before (one batch per pass) | 400 | 21.8 s (18 / pass) | 21.8 s | 42.5 s | 21.8 s | 21.8 s | 0.6 s | 3 |
| 17.9 (drain mode, defaults) | 2 000 | 17.1 s (117 / pass) | 17.4 s | 29.9 s | 1.8 s | 1.8 s | 1.9 s | 4 |

At the default 30 s interval that is up to ~400 deletions and ~10 000 purged rows per minute per replica (before: 40 each); replicas
add throughput (claims are exclusive, 17.7). Every batch stays bounded and short; the delete lease still covers one batch (validated
at boot). During a storage outage a pass stops after its first batch (only settled rows count as progress): tested, 70 due rows and an
unreachable store → exactly one batch of 20 attempted and rescheduled, `/ready` 200.

## 7. Database pool

`DB_POOL_MAX=10` per replica (kit default; 1–100), `DB_CONNECTION_TIMEOUT_MS=5000`, statement 30 s, query 35 s; unchanged (no
measurement argues for another default; the database's `max_connections` across replicas is the real budget).

- **Bytes never hold a connection:** with 60 readers paused mid-stream, `pg_stat_activity` shows 0 busy sessions and 10 idle; the same
  holds in the deterministic e2e test (and the pool's `waiting` = 0). Authorization, the claim and the ticket check finish before the
  first byte; the storage call is outside every transaction.
- **Storage latency never opens a long transaction:** with the store hanging, 0 sessions `idle in transaction` (storage probe).
- **Saturation:** a burst of 50 database-bound requests while a lock stalls the database: with the default pool, 23 succeed and 27 fail
  after the 5 s wait; with a pool of 2 and a 1 s wait, 48 fail after 1 s. The failure is an opaque `500` (the kit maps a pool timeout
  like any unexpected error) and `/ready` answers 503 meanwhile (its check waits on the same pool). Both are Core-wide kit behaviour,
  recorded for Stage 21 (a distinct `503` for pool exhaustion and a readiness check that does not queue behind requests), not changed
  here. The snapshot now reports `db_pool_total / idle / waiting` (a read-only `DbService.poolStats()` added to the kit).

## 8. Operational signals (F27)

No metrics platform exists in Core (F27; Notification publishes the same kind of lines), so none is introduced. Every
`FILE_OPS_REPORT_INTERVAL_MS` (60 s; 10 s – 1 h) each replica writes:

- `file_ops_snapshot` — from the database (partial indexes only): `uploading`, `stale_uploads`, `deleting`, `deleting_due`,
  `oldest_deleting_age_s`, `delete_retrying`, `max_delete_attempts`, `delete_errors=<code>:<n>,…` (the eight most frequent codes),
  `temporary_expired`, `limiter_rows`, `limiter_expired`; live gauges `uploads_in_flight=n/bound`, `downloads_in_flight=n/bound`,
  `db_pool_total / idle / waiting`.
- `file_ops_counters` — per interval, every name every time: `upload_busy`, `download_busy`, `rate_limited_{upload,ticket,download}`,
  `redemption_blocked`, `ticket_invalid`, `integrity_{digest_mismatch,size_mismatch,object_missing}`, `download_deadline`.
- `file_storage_ops` — one line per (operation, outcome) seen: `count`, `mean_ms`, `max_ms`, the provider NAME; failures at warn.
- `file_integrity_incident` (error) — once per interval with any integrity counter, on top of the per-file `file_storage_inconsistent`.

**Cardinality:** every label comes from a closed set (the counter names are a TypeScript union; storage outcomes are matched against a
bounded grammar and anything else folds into `other`; delete error codes are the schema-constrained machine codes). Tests assert that
no snapshot field carries a file id, organization, caller, token, digest, storage key or name, and that hostile outcomes (a key, a URL,
a CR/LF) fold into `other`. Per-event lines (17.5–17.8) keep their ids for investigation; they are logs, not metrics.

**Persistent deletion failure** is visible as `max_delete_attempts` climbing with one `delete_errors` code dominating (the backoff caps
at 1 h after ~8 attempts), distinct from a temporary outage (codes `storage_unavailable` / `storage_timeout` that clear on recovery).

## 9. Alert-ready conditions

The conditions (thresholds are starting points for production tuning) are in the runbook §1; the most important: any
`file_integrity_incident`; `storage_rejected` at all; storage failures sustained over 3 intervals; `oldest_deleting_age_s` > 1 h;
`stale_uploads` > 0 for 3 snapshots; `db_pool_waiting` > 0 for 3 snapshots; `upload_busy` / `download_busy` in 5 consecutive intervals;
`ticket_invalid` > 500 per interval (probing). **External routing is deferred** (no pager, chat or mail destination chosen in Core;
production prerequisite, Stage 21 / enablement). Security-relevant signals (integrity, probing) are operational signals here; the
cross-Core audit trail is Stage 18.

## 10. Rotation

| Credential | Behaviour (tested where marked) | Restart |
|---|---|---|
| Caller service token | the kit's two digests per caller: both resolve to the SAME caller (one policy, one budget, one owner); removing the old digest refuses it (401) (tested) | rolling config deploy |
| `FILE_REQUEST_HASH_KEY` | `FILE_REQUEST_HASH_PREVIOUS_KEYS` (≤ 2, distinct from the current keys): a replay accepted under the old key replays during the window; after it, `422`, never a second file (tested) | rolling deploy |
| `FILE_RATE_LIMIT_KEY` | replace; failed-redemption windows restart (≤ 1 min of forgotten failures); no window needed | rolling deploy |
| S3 credentials | read at boot; wrong or revoked → `storage_rejected` for every operation, not retried, `/ready` 200 (17.4 tests); there is no hot reload: deploy the new key, then revoke the old one | yes (rolling) |
| Database password | read at boot; established pool connections survive a password change, new ones fail until the deploy | yes (rolling) |

No File-specific credential system was added; service identity stays the kit's.

## 11. Shutdown and restart

Measured on the built service (S3 through a fault proxy; `HTTP_DRAIN_TIMEOUT_MS` = 5 s):

| On SIGTERM during | Exit | What remains |
|---|---|---|
| an upload whose client trickles | 5.0 s (drain bound) | the client's connection is closed; the row stays `UPLOADING` until its lease, then the sweep fails it (17.7) |
| a download whose client is paused | 5.0 s | the connection is closed at the drain bound |
| a cleanup pass blocked on a hanging store | 39 ms | all 8 claimed deletions released at once (`file_deletion_interrupted`, fenced), none leased after exit |

Order (unchanged, re-checked): admission stops and `/ready` answers 503; the HTTP drain; the workers and the ops reporter stop (the
reporter before the pool, tested by mutation); the pool closes last; the process re-raises the signal (Nest) and exits.

`kill -9` with 8 deletions claimed against a hanging store, then a restart against a healthy one: all 8 `DELETED` 29 s later (their
30 s lease expired: no manual step); a ticket issued before the crash is redeemable after it; an exhausted rate budget still answers
`429` (database state). Abandoned uploads recover through the lease sweep (17.7 tests; the lease is the upload request bound + 120 s).

## 12. Storage latency, outage, recovery

Through a TCP fault proxy in front of VersityGW (the probe's store idle bound 3 s, request deadline 2 s):

| Condition | Upload | Download | Delete request | Worker | `/ready` |
|---|---|---|---|---|---|
| +50 ms per relayed chunk | 201 (0.9 s) | 200 (0.9 s) | 202 | converges | 200 |
| store refuses connections | `503 storage_unavailable` (ms) | `503` (0.2 s) | 202 (database only) | reschedules with backoff (`storage_*`), row stays DELETING; the deleted file answers `410` | 200 |
| store accepts and never answers | `503` at the store's idle bound (6 s) | `503` at the request deadline (2 s) | 202 | reschedules | 200 (0 sessions idle in transaction) |
| store back | 201 | 200 | — | the pending deletion `DELETED` 2–4 s later, no restart | 200 |

No log line contains the bucket or the endpoint (95 lines scanned). Storage stays outside readiness (ADR-0048 §8); overload and outages
never take a replica out of rotation.

## 13. Rate limits (F32: kept)

- **Values unchanged** (uploads 600 / 120, issuance 1 200 / 300, service reads 1 200 / 300 per minute per caller / per (caller,
  organization)). There is no product traffic to tune against; they stay conservative starting points, explicitly for production
  tuning, and every one is bounded configuration.
- **Exact under concurrency:** 500 concurrent issuances (5 organizations × 80, 40 platform, from one caller with a budget of 100 and 40
  per organization; plus 60 from a second caller): the first caller got exactly 100, no organization more than 40, the second caller all
  60, nothing but 201 / 429 (the kit's single atomic upsert per hit).
- **Growth bounded:** 5 000 distinct clients failing redemptions (through `TRUST_PROXY`): 5 000 × `404`, 5 000 keyed rows (one per
  client and window), 0 reversible to an address, purged 3 s after their window by bounded batches (≤ 2 000 per pass, the primary-key
  index), with cleanup running meanwhile.
- `TRUST_PROXY=true` trusts every hop (kit): only behind a proxy that overwrites `X-Forwarded-For` (runbook §9).

## 14. Reconciliation and backup / DR

The reconcile tool (17.7) is bounded (`--limit` ≤ 1 000 000, resumable `--after`), read-only by default, never lists the bucket, never
changes a row, prints ids and machine codes only; `--repair` removes only objects of FAILED / REJECTED / DELETED rows. During an outage
each check waits up to 30 s and reports `storage_unavailable` (do not run it then). It compares sizes, not digests (same-size
alterations surface only on read). Backup / DR (F34) remains a production prerequisite; the restore-consistency risks (database and
bucket at different points in time: missing objects, resurrected deleted files, invisible leftovers) and the operator actions are in the
runbook §10. No backup mechanism was built.

## 15. Evidence

| Suite | Result |
|---|---|
| unit (`npm test -w file-service`) | not recorded at merge (placeholder); re-run in 17.10: 257 passed |
| e2e (`test:e2e`, PostgreSQL 16 + VersityGW) | not recorded at merge (placeholder); re-run in 17.10: 293 passed on the merged code |
| operational probes (`test:ops`, 8 files) | the numbers above; **17.10:** one probe (S3 pressure) no longer booted under the later 17.9 idle-bound check and was fixed; 18 / 18 pass |
| lint (oxlint type-aware), typecheck, `check:repo`, `git diff --check` | clean |
| image probe (production image) | not recorded at merge (placeholder); certified in 17.10 |
| `npm audit --omit=dev` | not recorded at merge (placeholder); 17.10: 0 vulnerabilities |

New tests: `src/ops/ops.spec.ts` (gates, counters, cardinality, deadline and socket-bound formulas), configuration tests (bounds and the
three relationships), `test/operations.e2e-spec.ts` (download bound and ticket rollback, junk tickets never busy, deadline, snapshot
fields, integrity counters, token and request-hash rotation, drain mode, outage batch, stalled and slow stores), two fake-server tests
in `storage-s3-failures.e2e-spec.ts` (mid-body read stall, a store that stops reading).

### Mutation campaign

Not recorded at merge (the table was a placeholder). Stage 17.10 ran a risk-based campaign covering the 17.9 controls (overload gates,
slot release, busy claims, cardinality, the idle re-arm): [17.10 record](./stage-17-10-focused-certification.md) §7.

## 16. Production prerequisites and deferred work

- **Stage 17.10 (focused certification):** re-run the File suites and probes that certification selects; certify the envelope in this
  record on the production image and a real provider.
- **Stage 21 / 21.x:** kit: a distinct overload answer for pool exhaustion and a readiness check that does not queue behind requests
  (§7); external alert routing and dashboards (§9); API naming (21.R1 / 21.R2).
- **Production enablement:** the storage provider (O2 / F6) with a real-provider run of the contract suite and these probes; the
  malware decision (F19, still deferred); backup / DR (F34) with bucket versioning; load-balancer connection limits and
  `X-Forwarded-For` hygiene; container memory limits measured on the production image; tuning of every default in this record against
  real traffic.
- **Not here:** storage quotas (F21; commercial policy), the audit trail (Stage 18), public sharing / CDN / presigned URLs / multipart.

## 17. Configuration (added or changed)

| Variable | Default | Bounds | Notes |
|---|---|---|---|
| `FILE_DOWNLOAD_MAX_IN_FLIGHT` | 64 | 1–4 096 | per process; `503 download_busy` |
| `FILE_DOWNLOAD_MIN_THROUGHPUT_BYTES_PER_SECOND` | 16 384 | 1 024–104 857 600 | the whole-transfer download deadline |
| `FILE_S3_MAX_SOCKETS` | 96 | 8–1 024 | per S3 client (writer, reader); checked against the bounds |
| `FILE_STORAGE_IDLE_TIMEOUT_MS` (changed) | 45 000 (was 30 000) | 1 000–300 000 (was 120 000) | now enforced; must exceed the client idle timeouts |
| `FILE_OPS_REPORT_INTERVAL_MS` | 60 000 | 10 000–3 600 000 | the operational snapshot |
| `FILE_CLEANUP_MAX_BATCHES_PER_PASS` | 10 | 1–100 | drain mode |
| `FILE_CLEANUP_PURGE_BATCH_SIZE` | 500 | 1–5 000 | expired tickets and limiter windows |
| `FILE_REQUEST_HASH_PREVIOUS_KEYS` | empty | ≤ 2 base64 keys (≥ 32 bytes), distinct | request-hash key rotation |
| (server) `timeout` | 65 000 | derived | max(headers timeout, DB connection wait + query timeout) + 5 s |

Relationships checked at boot (all fail closed with a message naming the variables, never a value): organization budget ≤ caller budget
(17.8); delete lease > one pass's worst case (17.7); upload bound ≤ S3 sockets; download bound + delete concurrency + 8 ≤ S3 sockets;
store idle > upload and download idle (S3 only).

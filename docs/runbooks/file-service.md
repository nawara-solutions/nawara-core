# file-service runbooks

Operational procedures for the File Service (Stage 17.9). Signals are structured JSON log lines (`msg` field); Core has no metrics
platform (F27), so alert rules are log-based (§1) and routing them to people (pager, chat, mail) is a production prerequisite, not
chosen here. Never paste a token, ticket URL, key, credential, storage key, bucket name or file name into a ticket, chat or command
history. Every placeholder below (`<…>`) is yours to fill; no real value appears in this document.

Related: [service README](../../apps/file-service/README.md), [SDD](../sdd/file-service.md),
[Stage 17.9 record](../architecture/stage-17/stage-17-9-operational-hardening.md) (measurements, limits, rationale),
[Stage 17.8 record](../architecture/stage-17/stage-17-8-security-integrity.md) (security contract).

**Never, as a normal recovery step:** update or delete `file` / `file_access_ticket` rows by hand, move a file back to `AVAILABLE`,
or delete objects from the bucket. The workers and the reconcile tool (§8) are the supported paths; the schema refuses most manual
edits anyway (triggers).

## 1. Signals and alert rules

Every `FILE_OPS_REPORT_INTERVAL_MS` (default 60 s) each replica writes `file_ops_snapshot` (durable backlog + live gauges),
`file_ops_counters` (what happened in the interval) and `file_storage_ops` (one line per storage operation and outcome). Counts and
bounded codes only: never an id, key, bucket, endpoint, caller token or name.

| Signal (`msg` starts with) | Level | Alert when (starting points: tune with real traffic) | Runbook |
|---|---|---|---|
| `file_integrity_incident` | error | any occurrence | §4 |
| `file_storage_inconsistent … reason=digest_mismatch` / `size_mismatch` / `object_missing` / `stream_length` | warn | any occurrence | §4 |
| `file_storage_ops … outcome=storage_unavailable` / `storage_timeout` | warn | count > 20 per interval for 3 consecutive intervals | §2 |
| `file_storage_ops … outcome=storage_rejected` | warn | any occurrence (credentials, bucket, policy: an operator fault) | §2, §7 |
| `file_ops_snapshot … oldest_deleting_age_s=N` | info | N > 3600 (a deletion waiting over an hour) | §3 |
| `file_ops_snapshot … deleting_due=N` | info | N growing across 15 min | §3 |
| `file_ops_snapshot … max_delete_attempts=N delete_errors=…` | info | N ≥ 8 (a delete failing for hours: backoff caps at 1 h) | §3 |
| `file_ops_snapshot … stale_uploads=N` | info | N > 0 for 3 snapshots (the lease sweep is not keeping up or the store is down) | §3 |
| `file_ops_snapshot … temporary_expired=N` / `limiter_expired=N` | info | N growing across 15 min (cleanup not keeping up) | §3 |
| `file_ops_snapshot … db_pool_waiting=N` | info | N > 0 for 3 snapshots | §6 |
| `file_ops_counters … upload_busy=N` / `download_busy=N` | info | N > 0 for 5 consecutive intervals (sustained overload) | §5 |
| `file_ops_counters … rate_limited_upload/ticket/download=N` | info | sustained, or a jump without a known product event | §5 |
| `file_ops_counters … redemption_blocked=N` / `ticket_invalid=N` | info | `ticket_invalid` > 500 per interval, or any `redemption_blocked` sustained (probing) | §5 |
| `file_ops_counters … download_deadline=N` | info | sustained growth (clients far below the minimum throughput, or a slow-reader attack) | §5 |
| `file_cleanup_pass_failed`, `file_ops_snapshot_pass_failure` | warn / error | 3 in 5 min | §3 |
| `http_drain_timeout`, `worker_drain_timeout` | warn | repeated on every deploy | §9 |

Readiness (`/ready`) covers the database and its migrations only. A storage outage, overload (`503 upload_busy` / `download_busy`) or
a rate limit never takes a replica out of rotation; do not add them to readiness or to a liveness probe.

## 2. Storage outage

**Recognize it:** `file_storage_ops … outcome=storage_unavailable` or `storage_timeout` for every operation; uploads and downloads
answer `503 storage_unavailable`; `file_deletion_retry … reason=storage_*` lines; `delete_errors=storage_unavailable:N` in the
snapshot. `/health` and `/ready` stay 200 (by design). Metadata reads, ticket issuance, attach and delete REQUESTS keep working (they
need only the database).

**Expected behaviour (measured in 17.9):** a refused connection fails an upload in milliseconds; a store that accepts and never answers
fails it at `FILE_STORAGE_IDLE_TIMEOUT_MS` (default 45 s) or the request deadline, never later; downloads fail at
`FILE_STORAGE_REQUEST_TIMEOUT_MS` (10 s) before the first byte. No database transaction is held across storage I/O. A deleted file
stays deleted (`410`): an outage never restores access. The delete worker reschedules with backoff (30 s → 1 h) and each pass stops
after one failing batch.

**Do:** confirm with the provider's status; check credentials and bucket policy only if the outcome is `storage_rejected` (§7). Nothing
needs restarting: when the store returns, pending deletions and new operations converge on their own (measured: seconds after
recovery, no restart).

**Do not:** restart replicas in a loop (readiness is healthy on purpose), fail over to another bucket, or edit rows.

## 3. Cleanup backlog and persistent delete failures

**Recognize it:** `deleting_due` or `oldest_deleting_age_s` growing; `stale_uploads`, `temporary_expired` or `limiter_expired` not
returning to 0; `max_delete_attempts` high with one `delete_errors` code dominating.

**Capacity:** each replica's pass runs every `FILE_CLEANUP_INTERVAL_MS` (30 s) and repeats full batches up to
`FILE_CLEANUP_MAX_BATCHES_PER_PASS` (10): about 400 deletions and 10 000 purged ticket / limiter rows per minute per replica with the
defaults (measured drain rates in the 17.9 record). Every replica runs the workers; claims are exclusive, so adding replicas adds
throughput.

**Distinguish:**
- a temporary outage: `delete_errors=storage_unavailable:N` / `storage_timeout:N`, recovering when the store does (§2);
- a persistent failure: `storage_rejected` (permissions: the runtime credentials need `DeleteObject`), or one code for hours with
  `max_delete_attempts` climbing: fix the cause (credentials, bucket policy), the rows retry on their own;
- a throughput shortfall: no errors, `deleting_due` still growing: raise `FILE_CLEANUP_MAX_BATCHES_PER_PASS` or
  `FILE_CLEANUP_BATCH_SIZE` (the delete lease is validated against the worst case at boot), or add replicas.

**Do not:** set rows to `DELETED` by hand (the object would stay in the bucket and nothing would ever remove it), or clear
`deleteNextAttemptAt`.

## 4. Integrity incident (`file_integrity_incident`, `file_storage_inconsistent`)

**What it means:** the stored object does not match the record written at upload (the SHA-256 and size verified then). `object_missing`:
the record is AVAILABLE, the object is gone. `size_mismatch`: the object's size differs (refused before any byte). `digest_mismatch`:
same size, other bytes: detected while streaming; the response is cut before its last chunk, so no client can complete the download,
but the bytes before the last chunk HAVE been sent (the 17.8 contract: an integrity-mismatched download cannot complete successfully;
it is not a promise that no altered byte is transmitted).

**This is an incident, not a repair task.** Possible causes: storage corruption, an operator or tool writing into the bucket, a
restore that paired rows and objects from different points in time (§10), or a compromise.

**Do:** preserve evidence (the log lines with the file id, the provider's access logs and object versions if enabled); identify every
affected file (`npm run reconcile` finds missing and wrong-size objects; same-size alterations are found only on read); escalate to
security; restore the object from the provider's versioning or backup if one exists.

**Do not:** delete the file, re-upload other bytes under its id, edit `sha256`, or move the row to another state. The service never
repairs automatically.

## 5. Overload (`503`) vs rate limits (`429`)

| Answer | Meaning | Who acts |
|---|---|---|
| `429 rate_limited` | a CALLER (or one caller's ORGANIZATION) spent its per-minute budget (F32): uploads, ticket issuance, service reads | the caller slows down; raise `FILE_*_RATE_PER_*` only with product agreement |
| `429 rate_limited` on `/file/t/…` | a client address failed too many redemptions (probing) | nobody: it expires with its window |
| `503 upload_busy` / `download_busy` | THIS PROCESS has no free slot (`FILE_UPLOAD_MAX_IN_FLIGHT` / `FILE_DOWNLOAD_MAX_IN_FLIGHT`); nothing was consumed | the client retries (same ticket, same Idempotency-Key); operators add replicas if sustained |
| `503 storage_unavailable` | the store failed (§2) | provider / operator |

Retrying rules for callers: `429` → back off to the next minute; `503 *_busy` → retry after a short jittered delay; a ticket stays valid.
Sustained `download_busy` with `download_deadline` growing can be slow readers holding slots: slots are bounded by the whole-transfer
deadline (`FILE_DOWNLOAD_MIN_THROUGHPUT_BYTES_PER_SECOND`, default 16 KiB/s); per-client connection limits belong to the load
balancer (§9).

## 6. Database pool saturation

**Recognize it:** `db_pool_waiting` > 0 in snapshots; opaque `500` answers with `timeout exceeded when trying to connect` in the
failure logs; `/ready` may flap to 503 (the readiness check waits for the same pool: a Core-wide kit behaviour, recorded for Stage 21).

**Do:** check the database first (locks, slow statements: `pg_stat_activity` for `application_name = 'file-service'`); bytes never hold
a connection (measured), so a saturated pool is database latency or a burst of database work, not slow clients. Raise `DB_POOL_MAX`
only within the database's `max_connections` budget across all replicas.

## 7. Credential and key rotation

| Secret | Rotation | Restart? |
|---|---|---|
| Caller service token (`SERVICE_TOKENS`) | the kit allows two tokens per caller: deploy `<caller>:<new digest>` next to the old one, move the caller to the new token, then remove the old digest (an old token is refused at once: 401). Both resolve to the SAME caller: one policy, one budget, one owner. | a configuration deploy (rolling) |
| `FILE_REQUEST_HASH_KEY` | deploy the new key with the old one in `FILE_REQUEST_HASH_PREVIOUS_KEYS` (at most 2); keep it for the callers' retry window (7 days recommended); then remove it. A replay under a removed key answers `422 idempotency_key_reused`, never a second file. | rolling deploy |
| `FILE_RATE_LIMIT_KEY` | replace it: the failed-redemption windows restart (at most one minute of forgotten failures); no previous-key window is needed | rolling deploy |
| S3 credentials (`FILE_S3_ACCESS_KEY_ID`, `FILE_S3_SECRET_ACCESS_KEY` / `*_FILE`) | read at boot only: create the new key at the provider, deploy it (rolling), then revoke the old one. With revoked or expired credentials every storage operation answers `storage_rejected` (not retried; uploads and downloads fail, `/ready` stays 200); valid credentials plus a restart recover. There is no hot reload. | yes (rolling) |
| Database password (`DATABASE_URL` / `*_FILE`) | read at boot: give the runtime role a new password (or a second role), deploy, then remove the old one. Established pool connections survive a password change; new connections fail until the deploy. | yes (rolling) |
| `SWAGGER_PASSWORD` | redeploy | yes |

## 8. Reconciliation (`npm run reconcile`)

`npm run reconcile -- [--limit N] [--after <fileId>] [--repair]` (image: `node dist/cli/reconcile.js …`), with the service's own
configuration (runtime database role, configured store). Read-only by default. It walks rows in id order, at most `--limit` (default
1000, max 1 000 000), prints one JSON line per finding (`fileId`, `status`, `finding`: `object_missing`, `size_mismatch`,
`orphan_object` for a failed, refused or deleted row whose object still exists (`orphan_object_removed` with `--repair`), `storage_unavailable`) and a summary with `next_after`; resume with `--after`. It never
lists the bucket and never changes a row. `--repair` only deletes objects that belong to rows already FAILED / REJECTED / DELETED.

Use small `--limit` values during business hours; do not run it during a storage outage (each check waits up to 30 s and reports
`storage_unavailable`). A missing object of an AVAILABLE row is an incident (§4), not something `--repair` touches. Same-size
alterations are not detected (it compares sizes, not digests).

## 9. Deployment checklist (operational)

- `TRUST_PROXY=true` only behind a proxy that OVERWRITES `X-Forwarded-For` (the kit trusts every hop: a client that reaches the
  service directly could rotate addresses past the redemption limiter).
- The load balancer caps connections per client and in total, and its idle timeout is below the service's (65 s silent-socket bound).
- `FILE_S3_MAX_SOCKETS` ≥ `FILE_UPLOAD_MAX_IN_FLIGHT` and ≥ `FILE_DOWNLOAD_MAX_IN_FLIGHT` + `FILE_DELETE_CONCURRENCY` + 8 (checked at
  boot).
- `FILE_STORAGE_IDLE_TIMEOUT_MS` > the upload and download idle timeouts (checked at boot) and above the provider's worst response
  latency for a complete PUT (a silent wait longer than this bound fails the upload as `storage_timeout`).
- `HTTP_DRAIN_TIMEOUT_MS` (5 s) below the orchestrator's termination grace period; a download or upload still running at the end of
  the drain is cut (the client retries: tickets and Idempotency-Keys make that safe).
- Memory: resident memory settles near 350 MiB under sustained load in the 17.9 probes (lazy garbage collection, not growth); size
  container limits with headroom and measure on the production image.

## 10. Backup and restore consistency

Metadata (PostgreSQL) and bytes (the bucket) are two stores with no shared transaction; a backup is consistent only if both sides are
restored to compatible points in time. Restoring the database to T1 and the bucket to T2:

- T2 earlier than T1: AVAILABLE rows whose objects are missing → `file_content_missing` on read, `object_missing` in reconcile: an
  incident per file (§4).
- T2 later than T1: objects with no row (not listed by anything: the service never lists the bucket) and objects of rows that the
  restore shows as live but were deleted after T1 (they become readable again: a deleted file resurrected).
- Bucket versioning with a retention window longer than the database backup interval lets operators pick object versions that match
  the restored rows.

Backup / DR (F34) is a production prerequisite; this document only states the dependency.

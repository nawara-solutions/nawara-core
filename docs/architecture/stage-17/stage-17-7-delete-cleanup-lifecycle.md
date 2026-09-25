# Stage 17.7 — File delete and cleanup lifecycle

- **Status:** implemented and validated on `feat/file-service-delete-cleanup` (awaiting review).
- **Scope:** the owner delete route (logical first), the bounded cleanup workers of SDD §12 (orphan expiry, the physical-delete
  worker, the upload-lease sweep, ticket retention), the operator reconciliation tool, crash and race safety.
- **Not in scope (and not present):** a scanner, DLP or content inspection (17.8); alerting, dashboards, key rotation, backup / DR, a
  production provider (17.9 / production enablement); legal retention periods (F23); a bucket-wide crawler; upload cancellation.
- **Frozen design followed:** [ADR-0048](../../adr/0048-file-service-architecture.md) §6, [SDD §5, §11.1, §12, §13](../../sdd/file-service.md),
  [Stage 17.1](./stage-17-1-decisions-and-roadmap.md) F17, F18, F23, F28, F34; the 17.3 state machine; the 17.4 delete contract; the
  17.5 crash windows; the 17.6 read rules. No decision reopened.

## 1. Baseline and findings

`main` at `9d12413` (Stage 17.6 merged, PR #110). Three findings, each resolved minimally:

1. **Schema:** 0001 had no durable delete lease or retry schedule. **Migration `0002_file_deletion_worker.sql`** (forward-only) adds
   `deleteAttempts` (the fence), `deleteNextAttemptAt` (the schedule; set iff DELETING), `deleteLeaseUntil` (set only on DELETING),
   `deleteLastError` (a bounded code), the claim index `file_delete_due_idx`, and drops 0001's now-unused `file_deleting_idx`.
2. **Upload lease (17.5):** it was the store's write deadline + 60 s, but a request that is slow BEFORE the store write (a stalled head)
   is bounded only by the server's `requestTimeout`, which can be later. The sweep must never act while a request could still write, so
   the lease is now `uploadRequestTimeoutMs + 120 s` (Node checks request timeouts every 30 s; clock skew).
3. **Delete vs ticket issuance (17.6):** the download-ticket insert did not lock the file row, so a ticket could commit just after a
   concurrent deletion (unredeemable: the claim requires AVAILABLE, but it should not exist). The insert now requires `AVAILABLE` and
   takes `FOR SHARE` on the file row.

## 2. Lifecycle

```text
 UPLOADING ──(upload completes, 17.5)──► AVAILABLE ──(DELETE by the owner, or unattached past its deadline)──► DELETING
     │                                                                                                            │
     │ past the upload lease (no request can still write): delete the key (idempotent), then                     │ worker: claim (lease + fence)
     ▼                                                                                                            │ StoragePort.delete (idempotent)
  FAILED upload_abandoned                                                                                         ├── ok / already absent ──► DELETED (tombstone)
                                                                                                                  └── failure ──► stays DELETING, retried with backoff
```

- **Entering deletion:** only `AVAILABLE` (the 17.3 state machine). `UPLOADING` / `VERIFYING`: `409 upload_in_progress` (no upload
  cancellation in V1; an abandoned one is swept). `REJECTED` / `FAILED`: `409 file_not_available` (terminal, no bytes).
- **Idempotent:** `DELETING` and `DELETED` answer `202` with the file again (the request time is not moved; one completion).
- **Terminal:** `DELETED` (final in every field; the row is a tombstone, never hard-deleted: the schema refuses `DELETE`).
- **Never restored:** a failed physical delete leaves the file `DELETING`; there is no `DELETING → AVAILABLE` transition.

## 3. The delete route

`DELETE /file/files/{id}` (SDD §13), `X-Organization-Id` when the file has one. Service token + policy `delete`; the owner is the token's
caller (never a header); `organizations: none` callers sending an organization get `403`. A foreign, missing, malformed id, another
organization or a missing organization: the same `404 file_not_found` (one query: id + owner + organization). Tickets never reach it
(`/file/t/{token}` has no DELETE; a ticket is not a service token: 401).

**Transaction (one, short):** `UPDATE file SET status = 'DELETING', deletionRequestedAt, deleteNextAttemptAt = now() WHERE id AND owner AND
organization AND status = 'AVAILABLE'` + `UPDATE file_access_ticket SET revokedAt = now() WHERE fileId AND revokedAt IS NULL`. Both or
neither (tested by failing the revocation: the file stays AVAILABLE and its tickets live). Access stops when it commits; the bytes stay
in the store until the worker removes them (tested: DELETING + object present → content `410 file_deleted`, ticket `404 ticket_invalid`,
new ticket `410 file_deleted`, metadata shows DELETING).

## 4. Races

| Race | Mechanism | Result (tested with real PostgreSQL and explicit transactions) |
|---|---|---|
| delete vs ticket issuance | issuance inserts `… WHERE status = 'AVAILABLE' FOR SHARE OF file`; deletion UPDATEs the row | issuance first → the deletion waits, then revokes the new ticket; deletion first → issuance waits, re-checks, creates nothing (`410`) |
| delete vs redemption | the claim needs `AVAILABLE`; deletion revokes the ticket rows | redemption waiting on the deletion's ticket lock is refused after it commits; a stream authorized before the commit completes (17.6 rule) |
| delete vs service download | lookup + `AVAILABLE` before the store is opened | a stream authorized before the commit completes; after it: `410` |
| attach vs orphan expiry | both are conditional row updates; expiry uses `SKIP LOCKED` | attach first → expiry skips it, then finds it attached; expiry first → attach waits, finds DELETING: `409`, nothing attached |
| repeated delete | the UPDATE requires AVAILABLE | later calls see DELETING / DELETED: `202`, no second transition |
| two replicas | claims are row-locked (`SKIP LOCKED`), leased and fenced | disjoint claims; 30 files deleted by concurrent workers, each completed exactly once |

## 5. The workers

One `PollLoop` per process (`FILE_CLEANUP_ENABLED`, every `FILE_CLEANUP_INTERVAL_MS`, first pass one interval after boot, never before
the HTTP server; boot never waits on storage or a backlog). Each pass, bounded by `FILE_CLEANUP_BATCH_SIZE` per task:

1. **Orphan expiry** (SDD §5.2): `AVAILABLE`, unattached, `attachDeadline <= now()` → `DELETING` + tickets revoked (the same path as a
   requested deletion). Materialized CTE + `SKIP LOCKED`; the UPDATE re-checks "still unattached".
2. **Physical delete:** claim due rows (`status = DELETING AND deleteNextAttemptAt <= now() AND lease free`, `ORDER BY
   deleteNextAttemptAt LIMIT n FOR UPDATE SKIP LOCKED`, materialized) → lease `now() + FILE_DELETE_LEASE_SECONDS`, `deleteAttempts + 1`;
   commit. Then, OUTSIDE any transaction, `StoragePort.delete` (≤ `FILE_DELETE_CONCURRENCY` at once). Success or an absent object →
   `DELETED` (conditional on DELETING). Failure → rescheduled `now() + min(max, base × 2^(attempt-1))` with the error code, fenced on the
   attempt (a worker whose lease was taken over changes nothing). Defaults: lease 300 s, backoff 30 s → 1 h, never giving up (a file
   must not stay half-deleted; persistent failures stay visible: `deleteAttempts`, `deleteLastError`, WARN lines).
3. **Upload-lease sweep:** `UPLOADING` with `uploadExpiresAt <= now()`: delete the key (idempotent; the object may exist: published, then
   the process died before finalizing), then `FAILED upload_abandoned` (conditional). Never promoted to AVAILABLE: its verified type,
   size and digest were never recorded. A storage failure leaves the row for the next pass. Duplicate work across replicas is harmless
   (idempotent delete, conditional update).
4. **Ticket retention** (SDD §11.1): ticket rows expired more than `FILE_TICKET_RETENTION_SECONDS` (24 h) ago, a bounded `SKIP LOCKED`
   batch. Live tickets and files are never touched.

**Lease safety:** the configuration refuses a lease that does not exceed one pass's worst case (`ceil(batch / concurrency) × storage
request deadline × attempts`). All times are the database clock. **Shutdown:** `beforeApplicationShutdown` (before the pool closes)
stops the loop (no new claim) and aborts in-flight storage calls; an interrupted deletion releases its lease at once (fenced, no
backoff); the pass is waited for within the HTTP drain bound; a claim cut by a crash expires with its lease.

## 6. Crash windows

| Crash | State left | Recovery (tested) |
|---|---|---|
| A. after DELETING commits, before any worker | DELETING, due | any worker claims it |
| B. after a claim, before the storage call | DELETING, leased | nobody touches it until the lease expires, then another worker reclaims (attempt + 1) |
| C. after the storage delete, before DELETED | DELETING, object gone | the reclaim deletes an absent object (success) → DELETED |
| D. after DELETED | DELETED | terminal: a late completion or reschedule is a no-op (fence / condition) |
| E. UPLOADING, object never published | UPLOADING past its lease | sweep → FAILED `upload_abandoned` |
| F. object published, row still UPLOADING | UPLOADING past its lease, object | sweep deletes the object, then FAILED (never AVAILABLE) |

No window needs manual database work. Object absence means "done" only for a DELETING (or abandoned UPLOADING) row; for an AVAILABLE row
it is an integrity incident (§7).

## 7. Reconciliation (operator tool, SDD §12)

`npm run reconcile -- [--repair] [--limit N] [--after <fileId>]`: one bounded, resumable pass (id order) over rows whose storage state
is decided. AVAILABLE rows whose object is missing (or the wrong size) are **reported, never reclassified** (a missing object is not an
authorized deletion). FAILED / REJECTED / DELETED rows that still have an object (a best-effort cleanup of 17.5 that did not happen) are
reported, and removed with `--repair`, by their recorded key only. Output: JSON lines with ids, states and findings (never keys); a
summary with `next_after`. No continuous scanner, no bucket listing: **storage-only orphans with no row are not searched** (the port has
no list operation; keys are server-generated and rows are never deleted, so such objects only come from the crash windows above, which
the sweep covers). A bucket inventory, if ever needed, is 17.9 / operations work.

## 8. Indexes and query plans

On 20 000 rows (15 000 AVAILABLE, 3 000 DELETING, the rest UPLOADING) after `ANALYZE`: the delete claim uses `file_delete_due_idx`
(new), the upload sweep `file_upload_lease_idx`, orphan expiry `file_orphan_deadline_idx`, ticket retention
`file_access_ticket_expiry_idx` (all partial, from 0001 except the first). `file_deleting_idx` (0001) was replaced (§1).

## 9. Observability

`file_deletion_requested file=<id> owner=<service>`, `file_deletion_completed file=<id> attempt=<n>`, `file_deletion_retry file=<id>
attempt=<n> reason=<storage code> next_in_s=<s>`, `file_deletion_interrupted`, `file_temporary_expired file=<id>`,
`file_upload_abandoned file=<id>`, `file_upload_abandoned_cleanup_failed … reason=<code>`, a pass summary `file_cleanup_pass expired= deleted=
retried= abandoned= tickets_purged=`, and the 17.4 `storage_op` lines (bounded error class). Never a key, path, bucket, endpoint, token
or digest (tested). No metrics platform exists in Core (F27): the counters above are logged per pass; dashboards and alerts are 17.9.

## 10. Configuration (added)

| Variable | Default | Bounds |
|---|---|---|
| `FILE_CLEANUP_ENABLED` | `true` | boolean |
| `FILE_CLEANUP_INTERVAL_MS` | 30 000 | 1 000 – 3 600 000 |
| `FILE_CLEANUP_BATCH_SIZE` | 20 | 1 – 500 |
| `FILE_DELETE_CONCURRENCY` | 4 | 1 – 16 |
| `FILE_DELETE_LEASE_SECONDS` | 300 | 30 – 3 600, and above one pass's worst case |
| `FILE_DELETE_RETRY_BASE_SECONDS` / `_MAX_SECONDS` | 30 / 3 600 | 1 – 3 600 / 1 – 86 400, max ≥ base |
| `FILE_TICKET_RETENTION_SECONDS` | 86 400 | 3 600 – 2 592 000 |

The attach window (`FILE_ATTACH_TTL_SECONDS`, 24 h, 17.5) is server-controlled; no request can extend it.

## 11. Evidence

- **Unit:** 234 in 9 files (cleanup configuration and backoff 11 new).
- **E2E (real PostgreSQL 16; filesystem; S3 on VersityGW):** 257 in 15 files: deletion 18 and deletion-on-S3 4 new; every 17.2–17.6 suite
  passes (updated for 0002 and for download tickets requiring AVAILABLE); three consecutive full runs green.
- **Key results:** the lifecycle AVAILABLE → DELETING → DELETED on both adapters (object removed from the directory / the bucket); access
  stops at the commit while the object still exists; atomic deletion + revocation (an injected revocation failure leaves the file
  AVAILABLE and its tickets live); non-disclosure (5 probes, one body, plus an owner-only mismatch); UPLOADING 409, FAILED / REJECTED
  409; storage failure → DELETING kept, rescheduled 30 s later, completed after recovery; lease reserves, expiry reclaims, the stale
  holder is fenced; crash windows A–F; 30 files deleted by concurrent workers, each once; abandoned uploads with and without an object;
  a live upload untouched; the upload lease ≥ the request bound + 120 s; orphan expiry through the normal path; attach vs expiry, delete
  vs issuance, delete vs redemption and delete vs service download, both interleavings each; ticket retention; reconciliation (report,
  repair, bounded, resumable); query plans on 20 000 rows; the workers on their timer, then a prompt stop with no pass after it; an S3
  outage: delete accepted, retried, `/ready` 200.
- **Mutations (23; all killed after the fixes below):**

  | Mutation | Caught by |
  |---|---|
  | M1 delete ignores the owner | **survived first** (every cross-owner probe also mismatched the organization); an owner-only probe now kills it |
  | M2 delete ignores the organization | non-disclosure test |
  | M3 any state enters deletion | 2 E2E (state rules) |
  | M4 tickets not revoked | 3 E2E |
  | M5 DELETING still downloadable by ticket | access test |
  | M6 tickets issued for DELETING files / M17 issuance without the row lock | **survived first**: the race tests created supertest requests lazily, so they ran after the other transaction committed and the race was never exercised; requests are now sent eagerly and both are killed |
  | M7 repeated delete refused | idempotency test |
  | M8 claims without the lease check / M9 expired lease never reclaimed | lease tests |
  | M10 an absent object treated as a failure | crash-C test (both adapters) |
  | M11 a storage failure marks DELETED | retry test |
  | M12 finalization not conditional | fence test |
  | M13 stale-upload age check removed / M14 lease shorter than the request bound / M15 abandoned object kept | sweep and lease tests |
  | M16 attach vs expiry unprotected | attach race test |
  | M18 revocation outside the deletion transaction | atomicity test |
  | M19 storage in readiness | outage test |
  | M20 provider errors not redacted | 19 unit + outage log test |
  | M21 filesystem key check skipped on delete | storage contract |
  | M22 workers not stopped at shutdown | shutdown test (strengthened: no pass after close) |
  | M23 no backoff | 1 unit + retry test |

- **Image:** 5 migrations applied then 0; production with an unreachable store: upload / download 503, delete 202 (DELETING), `/ready`
  200; development on the S3 test server: delete 202, content 410 and the old ticket 404 at once, the worker (1 s interval) removes the
  object from the bucket and closes the row DELETED; uid 1000, Node PID 1, stop < 100 ms exit 0, no leak; the repository smoke passes.

## 12. Deferred

- **17.8:** threat-model verification, per-caller issuance limits, the scanner hook, integrity scanning beyond reconciliation.
- **17.9:** signals / snapshot (pending deletions, oldest due, stale uploads), alerting, key rotation, a storage inventory if needed.
- **Production enablement:** provider (O2 / F6), malware policy (F19), legal retention (F23: how long DELETED tombstones and FAILED
  rows are kept is an owner / legal decision), backup / DR (F34).
- **Later:** upload cancellation, the filesystem `.tmp` leftovers of crashed writes (development adapter only).

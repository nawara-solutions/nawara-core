# Core V2 DO-65: evidence retention and legal holds (safety baseline and design)

- **Status:** design record, **DO-65 OPEN**. Documentation only: no code, migration, configuration, retention duration or runtime change.
- **Date:** 2026-11-23, at main `1863196`.
- **Decisions:** the Owner's DO-65 direction of 2026-11-23 (R-A, H-A, F-A design only, dead-letter no purge, no permanence decision,
  regulatory verification, restore prerequisite), recorded in §2.
- **Scope:** development and simulation. Nothing here is a production certification, a legal retention period or an authorization to
  delete, purge, compact, activate a storage provider or change production settings.

## 1. The open item

DO-65 (register type DECIDE, group G6 audit and evidence reach): evidence grants last at most 7 days, Payment and Billing keep only file
ids, neither calls File's hold API, and nothing found stops the owning service deleting the bytes after a grant ends. The read-only review
of 2026-11-23 widened the inventory to every class of financial and authorization evidence (§3).

## 2. Owner decisions (2026-11-23)

| # | Decision | Effect |
|---|---|---|
| R-A | Keep the existing empty Audit retention policy | `audit_retention_policy` stays empty: no category has a duration and **nothing is purged**. The mechanism (ADR-0049 A41, migration `0003`) stays as built and unused. |
| H-A | Preserve H7 trusted Company-scoped holds | A legal hold covers only records with a trusted Company scope row. No global hold or retention suspension, no new Organization hold authority. |
| F-A | Verified File hold placement and release for financial cases: **design only** | Investigated in §5. Nothing is implemented or activated until ownership, release, O2 storage and recovery guarantees are approved. |
| D | Dead-letter observations keep their no-purge behaviour | No retention duration and no compaction of `audit_dead_letter_transition` or `audit_dead_letter_coverage`. |
| K | No final legal permanence decision | The purge ledger, hold events and Auth receipt rows are preserved **indefinitely today** because nothing deletes them, pending qualified legal and compliance review (§6). That is the current state, not a decision that they are permanent. |
| V | Regulatory verification required | Applicable Tunisian and other relevant legal, tax, accounting, data-protection and provider retention obligations must be verified by a qualified reviewer before any duration is set (§6). No statutory period is stated in Core. |
| DO-5 | Restore correctness is a mandatory prerequisite | Automatic retention deletion may not be enabled before restore correctness is proven (§7). |

## 3. Current state per evidence class

| Evidence class | Authoritative owner (producer) | Current retention | Legal-hold coverage |
|---|---|---|---|
| Receipt audit records `authorization_receipt.*` (category `security`) | audit-service (auth-service) | Never purged (empty policy) | Holdable: trusted Company scope, required, for a broker-verified producer |
| Financial audit records: the 18 G6-C actions (`G6C_COMPANY_SCOPE`: refund case, refund attempt and authorization, fraud hold, fee actions) and `financial_loss.recorded` when it names a Company | audit-service (payment-service, billing-service) | Never purged | Holdable when the producer is broker-verified |
| Every other catalog action (about 109 of 131), across `security` (38 actions in all), `commercial` (73), `administrative` (16), `business` (4) | audit-service (all producers) | Never purged | **Not holdable** (no trusted scope; ownership is never inferred) |
| Unverified or compatibility deliveries, and historical records without a scope row | audit-service | Never purged | **Not holdable** |
| Dead-letter transitions and coverage heartbeats (migration `0009`) | audit-service (itself; only with `AUDIT_DEAD_LETTER_OBSERVATION=enabled`, default disabled) | Append-only for every role; outside the retention mechanism | Not applicable (header-only diagnostics, no tenant identifier) |
| Purge ledger `audit_retention_run`, hold events `audit_legal_hold_event` | audit-service | Append-only for every role; never deleted | Not applicable |
| Payment records (payments, attempts, refund attempts, refund facts, provider transaction facts, disputes) | payment-service | Kept; no retention mechanism. Stored provider notifications can never be deleted (DO-70, `0029`). Money-command idempotency is class M, removed after 90 days (S4g) | Not applicable; Payment places no File hold |
| Billing records (invoices, cases, obligations, recovery, fraud holds) | billing-service | Kept; no retention mechanism | Not applicable; Billing places no File hold |
| Evidence file bytes and metadata | file-service | Grants last 24 h by default, at most 7 days, never extended. The owning service can delete its file once no hold is active; bounded workers remove deleted bytes | File evidence holds (S2-File.3) block every delete path, including the database guard `file_hold_guard`, but only when the file's owner places one |
| Auth receipt rows `authorization_receipt` (digests only) | auth-service | Immutable (trigger); never deleted | Not applicable |

Facts the table rests on:
- **Retention mechanism.** Per category only (four categories, `CHECK`ed in `0003`). The horizon is measured on Audit's `recordedAt`. Only
  the separate `audit_retention` role can delete, it reads only `id`, `category` and `recordedAt`, and every batch is ledgered in the same
  transaction. There is no HTTP delete route and no erasure path (A42 / P-A3, reserved).
- **Holds.** A hold window, when given, is on `occurredAt`; a hold has no expiry. The delete trigger takes the Company's hold advisory lock
  shared and refuses a held record for every role; the retention job skips held records (`audit_record_is_held`).
- **Granularity.** Financial and non-financial commercial actions share the `commercial` category, so any future per-category duration
  would apply to both. A distinct financial retention class would need a schema and catalog change (option R-C, not approved).

## 4. Remaining limitations

1. **Unholdable records.** With H-A, about 109 catalog actions, every unverified delivery and every historical unscoped record cannot be
   placed under a legal hold. Today this has no effect because nothing is purged (R-A). It becomes a real gap the day any duration is set.
   Extending trusted scope is the DO-59 to DO-61 work, not DO-65.
2. **Financial evidence files.** Payment and Billing hold file ids only. A file attached to a dispute or fraud-hold case can be deleted by
   its owning service after the grant ends; no Core service places a hold for a financial case.
3. **Organization evidence.** No Organization scope is trusted and no Organization hold authority exists (F7 gated).
4. **Unbounded diagnostics.** With observation enabled, each Audit process instance writes a heartbeat every 60 s (about 525 600 rows a
   year) that is never removed (decision D).
5. **No restore proof for the newer tables.** The Audit backup's `REQUIRED_DATA` check and the restore drill's append-only controls were
   written for A13 (`audit_record`, `audit_retention_policy`, `audit_retention_run`, `outbox`, `inbox`). The dump is of the whole database and
   the facts file lists every trigger, but no drill yet proves that `audit_record_scope`, `audit_legal_hold_event`, the hold-aware delete
   trigger and the `0009` tables survive a restore with their guards. DO-5 (no drilled production restore on record) is unchanged.

## 5. File evidence holds for financial cases (F-A, design only)

**Existing pieces.** File's hold API (`POST /file/files/{id}/holds` and `/holds/release`, `{ holdRef }`) is callable only by the file's owner
service; a hold is the holder's reference, has no expiry, is idempotent on placement and final on release, and blocks every delete path in the
database. Payment's dispute evidence and Billing's fraud-hold cases read files through File evidence grants (S2-File.2, S6e-D) and record
only ids.

**Questions to approve before any implementation:**
1. *Ownership.* The file's owner is the service that uploaded it, not Payment or Billing. Either the owner places the hold on the case's
   request (a new contract between the owner and the case service), or File admits a case service as a holder of files granted to it (a new
   File authority). Neither exists.
2. *Hold reference.* One hold per case and file, derived from the case id (for example the dispute or fraud-hold id), so placement is
   idempotent and a release names exactly what it placed.
3. *Placement point.* When evidence is attached to the case, in the same unit of work as the case's own record, with a recoverable outbox
   intent so a File outage never loses the hold.
4. *Release.* Only when the case reaches a final state that the Owner has approved as releasing evidence, and never while a Company legal
   hold or an open dispute covers the same evidence. The release rule is a policy decision; Core does not choose it.
5. *O2 storage.* A metadata hold protects the bytes only if the storage provider honours deletion through File alone; whether object lock
   or versioning is needed depends on the provider decision (O2), which stays open.
6. *Recovery.* After a restore of File, Payment or Billing, holds and case states must be reconciled (§7).

## 6. Regulatory and provider verification (decisions V and K)

Before any retention duration, permanence decision or evidence release rule:
- A qualified reviewer verifies the applicable Tunisian legal, tax and accounting obligations (commercial records, invoices, payment and
  refund evidence) and data-protection obligations, and those of any other jurisdiction a Company operates in.
- Each payment provider's contract and scheme rules (dispute and chargeback evidence windows, record keeping) are verified once real
  providers exist; only simulation and test providers exist today.
- The outcome is recorded as an Owner decision per category or class. Core states no statutory period, and nothing in this record is one.

Until then the purge ledger, hold events, Auth receipt rows and all Audit records are preserved indefinitely because nothing deletes them.

## 7. Restore prerequisite (DO-5)

Automatic retention deletion stays disabled until restore correctness is proven. A restore must keep these consistent:
1. **Holds.** Hold events committed after the backup are lost by a restore. Before retention runs on a restored database, every hold placed
   or released since the backup must be re-established from an independent record, or retention must stay suspended for that database.
2. **Purged records.** Rows purged after the backup reappear. Their deletion must be repeated from the purge ledger's cutoffs before the
   database serves reads, and the restored ledger must not be silently extended or rewritten.
3. **Purge ledger.** `audit_retention_run` must be restored complete and append-only; a restored ledger shorter than the live one is
   evidence of a gap that must be recorded, not hidden.
4. **Scope rows and guards.** `audit_record_scope`, `audit_legal_hold_event`, the hold-aware delete trigger, `audit_record_is_held` and the
   retention role's grants must be proven present and enforcing in the restored database (an extension of the A13 drill's negative
   controls).
5. **Cross-service.** A restore of Payment, Billing or File must not release a File hold or reopen deletion of a file still referenced by
   a case.

## 8. Implementation plan (each step needs its own GO; none deletes anything)

| Step | Change | Depends on |
|---|---|---|
| 1 | This record | — |
| 2 | Restore-drill extension: prove scope rows, hold events, the hold-aware delete trigger and the `0009` tables after an Audit restore, with negative controls (development). **Implemented for development, 2026-11-23** ([A13 record](./core-v2-a13-audit-backup.md) §10); no production restore drill yet | DO-5 drill tooling; GO |
| 3 | Read-only retention preview: per category, what a horizon would select and how much of it is holdable; no policy row, no deletion | GO |
| 4 | File evidence holds for financial cases (§5) | Ownership and release decisions, O2, recovery (§7) |
| 5 | Dead-letter observation retention mechanism, still without a duration | A change to decision D |
| 6 | Any retention duration | §6 verification, steps 2 and 3, a DO-5 production restore drill, and an explicit Owner decision per category |

## 9. Dependencies

- **O2 (file storage provider):** §5 item 5; file holds protect bytes only within File.
- **DO-5 (backup and restore):** §7; a mandatory prerequisite for any automatic deletion.
- **F7 (Organization authority):** Organization-scoped evidence and holds wait for F7; it stays gated.
- **DO-59 to DO-61:** which actions may claim trusted Company scope, and therefore what a hold can cover.

DO-65 stays OPEN. F-29 stays LOCKED, R3-F2 OPEN, and DO-43, DO-59, DO-60, DO-61, DO-66, DO-76, DO-77 and OD-RLSC-1 OPEN.

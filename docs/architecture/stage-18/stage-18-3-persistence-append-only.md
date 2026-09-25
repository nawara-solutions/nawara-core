# Stage 18.3 — Audit persistence and the append-only model

- **Status:** implemented and validated on `feat/audit-service-persistence` (awaiting review; not committed).
- **Scope:** the durable `audit_record` (migration `0001_audit_record.sql`), its database invariants, the append-only grants and
  triggers, the idempotency foundation, the V1 indexes, the internal repository, tests on real PostgreSQL.
- **Not in scope (and not present):** the producer contract, validation and catalog (18.4), RabbitMQ ingestion (18.5), query routes
  (18.6), producer changes and the Auth outbox (18.7), retention and the maintenance role (18.8), operational campaigns (18.9),
  certification (18.10), cryptographic tamper evidence (A46: not in V1).
- **Frozen design followed:** [ADR-0049](../../adr/0049-audit-trail-architecture.md) (Accepted), [SDD §5](../../sdd/audit-service.md),
  [Stage 18.1](./stage-18-1-decisions-and-roadmap.md) A9–A15, A21–A33, A37, A41–A46. No decision reopened; no deviation.

## 1. Baseline

`main` at `689684dc3014ac6a2e63f6c6fcc8a75e760bc1f1` (Stage 18.2 merged, PR #116); working tree clean except the untracked
`docs/reports/` (untouched). Patterns reused: the File / Billing / Organization append-only triggers, the kit migration runner, the
18.2 provisioning (default privileges grant `SELECT, INSERT, UPDATE, DELETE` on every new table to the runtime role).

## 2. `audit_record`

| Column | Type | Null | Source | Rule |
|---|---|---|---|---|
| `id` | bigint identity (`GENERATED ALWAYS`) | no | Audit | internal; the keyset tie-breaker; never caller-supplied (`428C9`), never an external identity |
| `eventId` | uuid | no | producer outbox id | unique with `sourceService` |
| `sourceService` | text | no | envelope `source` | `^[a-z][a-z0-9-]{1,62}$` (the kit caller grammar) |
| `action` | text | no | payload | ≤ 100, `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` (the kit event grammar); catalog membership is 18.4 |
| `category` | text | no | catalog | `security`, `business`, `commercial`, `administrative` |
| `schemaVersion` | integer | no | envelope `version` | 1–1000 |
| `actorType`, `actorId`, `userKind` | text | `userKind` only | payload | §3 |
| `organizationId` | uuid | yes | payload (resource-derived) | NULL = platform-level, never "all" |
| `resourceType`, `resourceId` | text | no | payload | type `^[a-z][a-z0-9_]{0,63}$`, id `^[A-Za-z0-9._:-]{1,128}$` |
| `subjectType`, `subjectId` | text | yes, together | payload | same grammars; both or neither |
| `outcome` | text | no | payload | `succeeded`, `denied` |
| `changes` | jsonb | yes | payload | §5 |
| `correlationId` | text | yes | envelope | `^[A-Za-z0-9._:-]{8,128}$` (the kit request-context grammar); navigation only |
| `causationId` | uuid | yes | payload | ≠ `eventId` |
| `occurredAt` | timestamptz | no | envelope (producer DB clock) | finite; stored as sent (future and far past kept, A22) |
| `recordedAt` | timestamptz | no | Audit | set by a `BEFORE INSERT` trigger to `now()` whatever the INSERT supplies |

No foreign key; no name, email, phone, IP, user agent, token, raw payload, snapshot, metadata-bag or `updatedAt` column (immutable
rows need none). One audit table only: no actor, resource, organization, user or catalog table (the catalog is a code contract, 18.4).
Every externally derived string is bounded by its grammar; the grammars are ASCII-only, so no invisible or bidi character can enter
a machine identifier.

**Identifiers, explicitly:** `eventId` = the producer's identity of one event (deduplication key with `sourceService`);
`correlationId` = a join key to technical logs of the same operation, possibly client-chosen, never evidence; `causationId` = the
`eventId` of the event whose consumption caused this action (a consumer-driven step), linking automated actions to their trigger.

## 3. Actor model (A9, A10)

| `actorType` | `actorId` | `userKind` | Valid |
|---|---|---|---|
| `user` | lowercase UUID (an Auth user id) | `member` / `owner` / `operator` | yes |
| `user` | anything else, or an e-mail | any | no |
| `user` | UUID | NULL or another value | no |
| `service` | a service name | NULL | yes |
| `service` | a UUID, text with spaces | — | no |
| `service` / `system` | valid | any non-NULL | no |
| `system` | a process code `^[a-z][a-z0-9_]{0,63}$` | NULL | yes |
| `system` | empty or free text | — | no |
| `operator` (or anything not in the three) | — | — | no: operator is a user kind |

`actorId` is never NULL (a system actor names its process). The actor (who caused it) and `sourceService` (who emitted it) are
separate columns and never collapsed.

**Defect found and fixed while testing:** the first draft of the actor and subject checks used `IN (…)` / regex on nullable columns;
a CHECK whose expression is NULL passes, so a user actor without `userKind` and a half subject were accepted. Every nullable term now
carries an explicit `IS NOT NULL`; dedicated tests insert those rows directly and a mutation (M13) proves the test catches the regression.

## 4. Tenant and resource model (A11, A12)

`organizationId` is the organization recorded on the affected resource by its producer; NULL is a platform-level record. A malformed
value or a wildcard (`all`, `*`) is refused by the uuid type. `resource` is exactly one `{type, id}`; `subject` is at most one, both
columns or neither. No relationship graph, no foreign key.

## 5. Changes (A27, A28)

Physical representation: `jsonb`, but only this shape (`audit_changes_valid`, an immutable SQL function used by the CHECK):

- an object of 1–8 keys, each `^[a-z][a-z0-9_]{0,31}$`;
- each value a **scalar** or exactly `{ "from": scalar, "to": scalar }`;
- scalar = a string of 1–64 characters `[A-Za-z0-9._:+-]` (codes, enum-like values, ISO dates, UUIDs: no spaces, prose, accents,
  newlines or controls) | an integer with |n| ≤ 2^53 − 1 (no fraction; jsonb has no NaN / Infinity) | a boolean | null;
- no array, no deeper nesting, no top-level non-object;
- **size:** at most 1 024 bytes of PostgreSQL's canonical jsonb text (`octet_length(changes::text)`, UTF-8 bytes, keys normalized by
  jsonb, `", "` / `": "` separators). Tested at the exact boundary: 1 024 accepted, 1 025 refused.

**Layered secret defense:** the schema accepts any key and value of the right *shape*; it cannot know that a key named `password` or
a 43-character value is a secret. That is the catalog's job (18.4: only cataloged keys per action) and ingestion's (18.5: secret-shaped
value checks, dead-letter `sensitive_value`). The schema's contribution is structural: no free text, no nesting, 64-character values,
1 KiB total, so a token-sized value is the most that could slip through a catalog mistake, never a payload dump. The repository takes a
typed record, never a raw message, and there is no column that could hold the envelope.

## 6. Append-only enforcement and its limit (A23, A45)

| Layer | Mechanism | Stops |
|---|---|---|
| 1. Privileges | the migration calls `audit_restrict_to_append_only('audit_record')`: `REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` from PUBLIC and from **every** non-owner grantee found in the table's ACL (the Core default privileges had granted UPDATE / DELETE to the runtime role; role names are not hard-coded) | the runtime role and any other non-owner role, whatever its name (`42501 permission denied`) |
| 2. Triggers | `audit_record_no_update_delete` (row, BEFORE UPDATE OR DELETE) and `audit_record_no_truncate` (statement) raise `42501 audit_record is append-only` | everyone while enabled, including the owner and a superuser; a future accidental grant |
| 3. Schema ownership | the migrator owns table, triggers and functions; the runtime cannot alter, disable, drop or replace them, own the table, set `session_replication_role`, or execute the helper (EXECUTE revoked from PUBLIC) | the runtime giving itself authority back |

**Runtime role after migration (tested, and in the image against `infra/postgres/init`):** `INSERT, SELECT` only on `audit_record`.
UPDATE, DELETE, TRUNCATE, an upsert (`ON CONFLICT DO UPDATE` needs UPDATE), GRANT to itself (a warning that grants nothing), trigger
or constraint changes, ownership changes, replication role: all refused.

**The exact guarantee:** audit records are append-only against the normal Audit application role. The table owner (the migrator) and a
PostgreSQL superuser can disable the triggers and rewrite or delete records (demonstrated in a rolled-back transaction); a backup restore
or host access is equally outside the V1 model. There is no cryptographic tamper evidence (A46). Migrations stay possible: the owner
evolves the schema; a data migration that must touch rows would disable the trigger explicitly and visibly in its own migration.

**Migration-ledger weakness (Stage 21) is not a path to the records:** the runtime can still delete a `schema_migrations` row (inherited
Core default privileges; tested), and after doing so it still cannot update or delete an audit record.

**Future append-only tables:** default privileges grant UPDATE / DELETE to the runtime on every table the migrator creates (tested: a new
table is mutable until restricted). The Audit convention: every migration that creates an append-only table calls
`SELECT audit_restrict_to_append_only('<table>');` and adds the same triggers. A catalog test asserts that no non-owner role holds a
mutating privilege on `audit_record`; later stages extend it to their tables.

**Retention (18.8):** nothing here prevents it. A maintenance role will need DELETE granted explicitly and the trigger taught to admit
that role for rows past their category's horizon, in an 18.8 migration; `audit_app` never receives DELETE.

## 7. Idempotency foundation (A15, A48)

- `CONSTRAINT audit_record_source_event_unique UNIQUE ("sourceService", "eventId")`: the real guarantee (no read-then-insert).
- `insertOnce` is one `INSERT … ON CONFLICT ("sourceService", "eventId") DO NOTHING RETURNING *`; when nothing is returned it reads the
  stored row and returns `{ kind: 'duplicate', existing }` unchanged.
- **Exact vs conflicting duplicate:** every caller-supplied field is stored, so no fingerprint column is needed:
  `sameEvidence(existing, candidate)` compares them field by field (changes canonically; `id` / `recordedAt` excluded). Stage 18.5
  decides what a conflicting duplicate does (dead-letter `event_id_conflict`); the stored row is never overwritten.
- **Concurrency (tested through the pool):** 20 simultaneous deliveries of one event → 1 inserted, 19 duplicates, 1 row; 20 simultaneous
  *conflicting* deliveries → 1 row, equal to the one reported inserted.

## 8. Repository (internal API)

`AuditRecordRepository` (the only reader / writer of the table):

| Method | Does |
|---|---|
| `insertOnce(record, q?)` | the idempotent insert above; refused records throw `AuditPersistenceError('invalid_record', constraint)` (a code and the constraint name, never row data) and store nothing |
| `findBySourceAndEventId(source, eventId, q?)` | the stored record or `undefined` |
| `sameEvidence(stored, candidate)` | pure comparison (exported function) |

No update, delete, save, patch or upsert exists. `occurredAt` is converted to a `Date` before SQL (PostgreSQL's timestamp input also
accepts `now`, `yesterday`, `epoch`, `infinity`); the schema additionally refuses non-finite times. Every method takes the caller's
transaction client (`q`), so 18.5 can store a record together with its own bookkeeping (tested: rollback leaves nothing, commit keeps it).
The types (`NewAuditRecord`, `AuditRecordRow`) are internal persistence types, separate from the 18.4 producer contract.

## 9. Indexes (A37) and query plans

| Index | Serves |
|---|---|
| `audit_record_pkey` (id) | identity |
| `audit_record_source_event_unique` | idempotent insert and lookup |
| `audit_record_org_time_idx` (organizationId, occurredAt DESC, id DESC) | organization-scope keyset pages; `organizationId IS NULL` (platform-level) |
| `audit_record_actor_time_idx` (actorType, actorId, occurredAt DESC, id DESC) | actor investigations |
| `audit_record_resource_time_idx` (resourceType, resourceId, occurredAt DESC, id DESC) | resource history |
| `audit_record_subject_time_idx` (…, partial: subject present) | subject history |
| `audit_record_correlation_idx` (partial: correlation present) | log → evidence |
| `audit_record_recorded_idx` (recordedAt) | retention (18.8), ingestion lag (18.9) |

Action, category, source and outcome are filters inside these (A37). **Plans** (PostgreSQL 16.15, 60 000 rows: 200 organizations plus
platform-level, 2 000 users, 4 sources; `ANALYZE`; `EXPLAIN ANALYZE`):

| Query shape | Plan | Time |
|---|---|---|
| organization scope, keyset `(occurredAt, id) < (…)`, 92-day window, 50 rows | Index Scan `audit_record_org_time_idx` | 0.09 ms |
| platform-level (`organizationId IS NULL`), 31-day window | Bitmap scan of `audit_record_org_time_idx` | 0.78 ms |
| actor / resource / subject history | Index Scan on its index | 0.02–0.03 ms |
| action within an organization | Index Scan `audit_record_org_time_idx` (filter) | 0.18 ms |
| correlation id | Index Scan `audit_record_correlation_idx` | 0.03 ms |
| idempotent lookup (bound parameters) | Index Scan `audit_record_source_event_unique` (both columns) | 0.06 ms |
| retention scan by `recordedAt` | Index Scan `audit_record_recorded_idx` | 0.02 ms |

Not covered by an index by design: a platform-wide unfiltered time scan across all organizations (18.6 decides whether platform-scope
queries require a filter or a dedicated index).

## 10. Storage footprint

At 60 000 representative rows (half with a `from/to` change, a quarter with a subject): heap 293 B/row, indexes 458 B/row, **total ≈ 751
B/record** (the 18.1 estimate was ≈ 1 KiB); the largest indexes are resource (115 B/row), actor (110), organization (82), idempotency
(71). An order of magnitude, not a capacity figure (18.9).

## 11. Evidence

- **Unit:** 42 (unchanged).
- **E2E (PostgreSQL 16.15):** 166 in 5 files: persistence 103 (new), foundation 24, health 5 (updated for 0001), runtime role 19, built
  process 15. Persistence covers: migrations fresh / re-run / 18.2 → 18.3 upgrade; catalog shape; exact grants; the future-table
  convention; runtime refusals; no self re-grant; the ledger weakness not reaching records; owner and superuser refused by triggers; the
  stated superuser limit; `recordedAt` / `id` ownership; `occurredAt` as sent; a 43-case constraint matrix plus 7 direct-SQL refusals; NOT NULL on 11 columns;
  8 accepted and 22 refused `changes` shapes; the 1 024-byte boundary; insertOnce / duplicates / `sameEvidence` (13 variants);
  transactions; two 20-way concurrency tests; typed refusal of a malformed lookup key; 9 query shapes using their index; footprint.
- **Hostile inputs (all refused by grammar or type, stored nothing):** bidi controls and newlines in actions, subjects and changes;
  prose and accents; e-mail as user id; SQL-looking and log-injection resource ids (the statement is parameterized; the value is refused
  by the grammar, the table unaffected); malformed UUIDs and wildcards; nested objects, arrays, fractions, 2^53, 1e308; 65-character and
  empty strings; oversized keys; `yesterday` / `infinity` as times.
- **Mutations (each alone; sources restored and SHA-256 verified):** **13 / 13 killed.**

  | # | Mutation | Tests failing |
  |---|---|---|
  | M1 | unique (sourceService, eventId) removed | 78 |
  | M2 | runtime keeps UPDATE | 4 |
  | M3 | runtime keeps DELETE | 3 |
  | M4 | actor consistency removed | 9 |
  | M5 | category constraint removed | 2 |
  | M6 | changes over 1 024 bytes allowed | 1 |
  | M7 | nested / array values allowed | 6 |
  | M8 | caller can set recordedAt | 1 |
  | M9 | resource validation removed | 5 |
  | M10 | organization + time index removed | 3 |
  | M11 | append-only trigger removed | 3 |
  | M12 | repository upserts instead of DO NOTHING | 77 |
  | M13 | NULL-passing actor check (the defect of §3) | 1 |

- **Image:** built; migrations through the image as `audit_migrator` 4 applied then 0; ready as `audit_app` (uid 1000, hardened flags);
  against a database provisioned by `infra/postgres/init`: grants exactly `INSERT, SELECT`, insert and select work, UPDATE / DELETE /
  TRUNCATE denied; stop 56 ms exit 0; no log leak; the repository smoke passes.
- **Gates:** lint 0 findings, typecheck, `check:repo`, `git diff --check`.

## 12. Deferred and findings

| Item | Stage |
|---|---|
| The action catalog, per-action change keys, secret-shaped value rejection, payload → `NewAuditRecord` mapping | 18.4 / 18.5 |
| Conflicting-duplicate handling (`event_id_conflict`), clock-skew counting | 18.5 |
| Query primitives, scopes, keyset cursors, whether platform-wide scans need a filter or index | 18.6 |
| Maintenance role, retention DELETE path through the trigger | 18.8 |
| Volume, lag and plans at scale | 18.9 |
| Runtime DML on the migration ledger (inherited, not a path to records) | Stage 21 |
| Default privileges granting UPDATE / DELETE to every new table (Audit protects its tables locally) | Stage 21 (Core provisioning) |
| Broker-proven `sourceService` (P-A1) and the other 18.1 prerequisites | production prerequisites |

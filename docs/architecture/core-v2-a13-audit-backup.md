# Core V2 A13: audit-service backup and restore coverage

- **Status:** **CERTIFIED — LOCAL TOOLING + CI** (2026-10-04, §9): merged by PR #194 (`96e3aaf`). Record of A13.0 discovery, the owner
  decisions O1–O6, the O3 production inspection, the A13.1 design freeze, the A13.2 implementation, the A13.3–A13.3b local proof and the
  A13.4/A13.4a security review. **Production Audit backup coverage is NOT operational:** no production Audit deployment, backup, restore
  drill or privilege correction has been performed, and the first production Audit backup is blocked until migration 0004 is deployed
  (§8, §9). BUILT ≠ DEPLOYED.
- **Scope:** add audit-service to the existing Core backup and restore tooling (Stage 21.x G5, [runbook](../runbooks/core-backup-restore.md))
  without changing the certified Auth and Organization behaviour, and correct the confirmed Audit `schema_migrations` privilege defect
  in the repository.
- **Related:** [backup and restore runbook](../runbooks/core-backup-restore.md) §1, §5A, §6A; [production readiness](production-readiness.md)
  §5; [V2 A0 record](core-v2-a0-immutable-deployments.md) (how an Audit image reaches production).

## 1. Why

audit-service is in production and holds append-only accountability evidence (the Auth → Audit relay), but the backup tooling covered
only organization-service and auth-service (G5 decision D4). Audit had no backup, no restore drill and no recovery procedure.

## 2. Owner decisions

| | Decision |
|---|---|
| O1 drill readiness | a **disposable RabbitMQ** inside the isolated drill so the restored service passes its **real** `/ready` (database, migrations, broker, ingestion consumer); never a `/health`-only drill |
| O2 policy | Audit inherits RPO 24 h, RTO 4 h, 30 daily backup days, no PITR/WAL. While backups stay manually triggered, the 24 h RPO is a **target, not an operationally guaranteed objective**; scheduled backups stay G6-gated |
| O3 privileges | verify in production first (§3); result **O3-B** |
| O4 application proof | structural, security and facts verification **and** an application-level read of a known restored record, with a drill-only identity; production authorization unchanged |
| O5 recovery | never DROP-and-replace the live Audit database: restore into a new, isolated database, verify, reconcile, explicit operator decision, controlled cutover |
| O6 drill cadence | deferred to the G6 production-operations work; A13 makes the drill executable, testable and observable |

## 3. O3: the production privilege finding (O3-B, confirmed)

A read-only, owner-executed inspection of production (2026-10-04; catalog queries in a read-only session, hash-gated scripts) found:

- `audit_app` holds **SELECT, INSERT, UPDATE and DELETE on `schema_migrations`** (TRUNCATE, REFERENCES, TRIGGER false). The cause is the
  general default privilege `audit_migrator` → `audit_app=arwd` on tables (and `rU` on sequences); Audit's deploy never narrowed the
  migration history, as Auth's and Organization's deploys do. A runtime able to write the history could mark a future migration as
  applied, null a checksum or erase the history.
- `audit_record`: `audit_app` holds SELECT and INSERT only. The append-only triggers (`audit_record_stamp`, `_no_update_delete`,
  `_no_truncate`; `audit_retention_run_no_update_delete`, `_no_truncate`; `outbox_immutable`) are present and enabled. `audit_app` has
  no EXECUTE on `audit_grant_retention` or `audit_restrict_to_append_only`, no elevated attribute and no role membership.
- The applied migrations are the service-kit baseline (`kit_0001_outbox_inbox`, `kit_0002_rate_limit`, `kit_0003_generic_triggers`)
  and Audit's `0001`–`0003`. `inbox`, `outbox` and `kit_rate_limit` are expected: the kit runner applies its baseline by default
  (`libs/service-kit/src/cli/migrate.ts`) and Audit's deploy does not pass `--no-kit`. A13.0's statement that Audit has no outbox was a
  discovery error and is withdrawn.

## 4. Design and implementation (A13.1 frozen, A13.2 implemented)

**Backup** (`infra/backup/backup.sh`, unchanged pipeline, a third target):

| | audit-service |
|---|---|
| database | `nawara-core-audit-db`, database `audit`, dumped as `audit_migrator` (the owner; `audit_app` cannot read the retention tables) |
| REQUIRED_DATA | `schema_migrations audit_record audit_retention_policy audit_retention_run outbox inbox` (a data section exists even for an empty table); `kit_rate_limit` is facts-only |
| facts | the shared facts (row counts, structure, migration digest, outbox, owners, ACLs) plus Audit's integrity facts in place of an authority marker: append-only triggers and state, owner and ACL of the privilege helpers and trigger functions, default ACLs, the schema ACL, a digest of every record's identity, `occurredAt` and `recordedAt`, and the newest record (`known`, its instant truncated to the millisecond the API accepts) |
| secret files | `db.env`, `roles.env`, `.env` (encrypted, as every service's) |

The shared facts SQL and the Auth and Organization targets are byte-identical to the certified tooling (a test pins their hashes).

**Security correction** (`apps/audit-service/deploy/provision-and-deploy.sh`): after the migrations and before the application
environment or any container change, every deploy runs `REVOKE ALL ON TABLE schema_migrations FROM audit_app; GRANT SELECT ON TABLE
schema_migrations TO audit_app;` (idempotent) and then a fail-closed assertion: no elevated attribute; no `schema_migrations`
INSERT/UPDATE/DELETE/TRUNCATE; no `audit_record` UPDATE/DELETE/TRUNCATE; no write on either retention table; no EXECUTE on the two
privilege helpers; and SELECT on `schema_migrations`, SELECT and INSERT on `audit_record` present. A failure never starts a first
deployment and never swaps a running one. The general default privileges are unchanged (the runtime needs them on `inbox`, `outbox`,
`kit_rate_limit`). **This correction reaches production only through a later, separately authorized Audit deployment (A3.6-class) or a
separately authorized SQL action; A13 does not apply it.**

**Restore drill** (`infra/backup/restore-drill.sh`, `SERVICE=audit-service`):

```text
sha256 checks → decrypt → drill DB (postgres, --network none) → Audit roles and default privileges (as the deploy) → pg_restore
→ kit + Audit migrations as audit_migrator → facts compared (BEFORE narrowing: equality with the source as it was)
→ O3-B NOTICE if the source let audit_app write the history → narrowing → the deploy's assertion
→ triggers present and enabled → controls (rolled back) → disposable broker (rabbitmq:3.13.7-alpine@sha256:d7af1c87…, container:<drill db>,
  RABBITMQ_NODENAME=rabbit@localhost, drill-only vhost user) → isolation checked (db: none; broker and service: container:<drill db>)
→ service (RABBITMQ_URL = exactly the drill broker; drill-only reader) → real GET /ready → consumer on the drill broker
→ GET /audit/platform/records returns the known record → remove all three containers with their volumes; DRILL_RESULT … duration_s=…
```

The controls are **LOCAL / DISPOSABLE RESTORE MUTATION** against the drill's own database, every one rolled back, never production:
N1 `audit_app` UPDATE `audit_record`; N2–N4 the owner's UPDATE, DELETE (retention policy cleared first, inside the rolled-back block)
and TRUNCATE on `audit_record` (the append-only trigger); N5–N7 the same on `audit_retention_run`; N8 an `outbox` event rewrite;
N9a–c `audit_app` INSERT, UPDATE, DELETE on `schema_migrations`; N10 `audit_app` running `audit_grant_retention`; P1 a supplied
`recordedAt` replaced by the database clock; P2 all six triggers present and enabled.

**Feasibility (A13.2 spike, local):** the preferred topology works: PostgreSQL on `--network none`, RabbitMQ with
`--network container:<db>` and `RABBITMQ_NODENAME=rabbit@localhost` became ready (`check_running`, `check_port_connectivity`, `ping`),
the drill vhost and user were configured, loopback AMQP and PostgreSQL were reachable, the namespace had only `lo` and no route, external
addresses were unreachable and `nawara-core-rabbitmq` did not resolve. The broker CLI must run as the `rabbitmq` user (a root CLI before
the node writes its Erlang cookie makes the node exit, as `infra/rabbitmq/provision.sh` records); the drill does so. The fallback (a
per-drill `--internal` network) was not needed.

## 4A. Restore blockers found by the real drill (A13.3, A13.3a)

- **Audit restore blocker (pre-existing, HIGH, corrected locally).** `audit_changes_valid(jsonb)` (0001) calls
  `audit_change_scalar_valid` unqualified and had no fixed `search_path`; `pg_restore` loads data with `search_path = ''` and PostgreSQL
  inlines the function when the `changes` CHECK is prepared, so **every restore of an Audit database holding a record failed**. 0001
  stays unchanged; the forward migration `0004_changes_validation_search_path.sql` sets `search_path = public, pg_temp` on the function
  (Organization's convention; public is the migrator's, the runtime cannot create there, alter the function or create temporary objects).
  Validation is unchanged (an invalid `changes` is still refused under an empty search_path; a regression test in
  `apps/audit-service/test/persistence.e2e-spec.ts` pins it). Audit now has **7** migrations (the kit baseline and 0001–0004); the six
  append-only and immutability triggers are unchanged. **0004 must reach production before the first production Audit backup**; that
  Audit deployment (production-gated, A3.6-class) can carry the O3-B `schema_migrations` correction as well.
- **Two shared-tooling defects, corrected in A13.3b:**
  1. *ACL representation.* The shared `acl|` restore fact compared raw ACL text. A table whose privileges were all revoked keeps an
     explicit owner-only ACL in the source; `pg_dump` serializes nothing for an ACL equal to the default, so the restore has the default
     (NULL) ACL: identical privileges, different text, and the drill failed closed on `audit_retention_policy`. The fact is now canonical:
     `array_to_string(coalesce(c.relacl, acldefault(<'s' for a sequence, 'r' for a table>, c.relowner)), ' ')`. Proven on PostgreSQL: an
     explicit default and a NULL ACL give the same fact; a default ACL plus an unauthorized runtime grant gives a different one (a real
     difference still fails the drill); the sequence default (`rwU`) differs from the table default (`arwdDxt`), so the object type is
     used. The Auth and Organization facts SQL changes in this one line only (golden hashes updated); each backup carries its own facts
     SQL, so certified backups are unaffected and their real-volume drills are not rerun.
  2. *Readiness race.* The drill waited for its database with `pg_isready` over the socket, which the image's temporary init server also
     answers before it is stopped and the final server starts; a drill could fail at random (it failed closed). The wait is now
     `pg_isready -h 127.0.0.1` (the init server does not listen on TCP), with the same retries and the same failure.
- **Local proof with the repository scripts (A13.3b):** the real Audit deploy (7 migrations; `audit_app` SELECT-only on
  `schema_migrations`), 240 synthetic records, `backup.sh`, then `restore-drill.sh` with the source removed. Case 1 (source re-broadened
  to the historical O3-B shape): 14 checks, 48 facts, the O3-B `NOTICE`, the intended privileges asserted, 12 refusals and P1/P2, the
  disposable broker, the real `/ready`, the consumer on the drill broker, the known record read back; `duration_s=90`. Case 2 (narrowed
  source): the same, no notice; `duration_s=98`. These are local RTO measurements, not production ones.

## 5. Recovery (O5)

The runbook's §6A replaces DROP-and-restore for Audit: contain (stop the service; the durable queue keeps accumulating), restore into a
new isolated database, verify, establish the gap, reconcile what exists (records in a readable live database: copy procedure **not
implemented**; queued messages: delivered after cutover, duplicates absorbed by `(sourceService, eventId)`; dead-lettered messages: the
kit's DLQ tools), explicit operator decision, controlled cutover (the exact repointing procedure is a later item), verification.
Re-emitting producers' already-published outbox rows is **not implemented**. Evidence acknowledged into lost data cannot be re-delivered:
a backup bounds what is restored, not what can be reconstructed.

## 6. Observability hooks (for A12; nothing implemented there)

The existing per-service status files (`backup/status/<service>.last-attempt` with the failing stage, `.last-success` with the stamp,
PostgreSQL version, TOC entries and every artifact's size and sha256) already cover Audit: backup age, success or failure, failing
stage, artifact sizes (and a sudden drop), TOC count; retention failures surface as exit 3. The drill's `DRILL_RESULT` line (service,
stamp, checks, duration) is the restore-side signal. Monitoring never replaces a restore drill.

## 7. Evidence (local)

Counts at A13.2 (focused): `backup-restore.test.mjs` 103 (71 unchanged + 32 Audit), `audit-deploy.test.mjs` 25 (15 unchanged + 10); the
other deploy suites unchanged and passing. Later: A13.3 `test:repo` 50/50, `test:deploy` 253/253, a 62-mutation negative-control
campaign (60 detected; B15 and R5 analysed as redundant-layer gaps; 0 restoration failures); A13.3a Audit E2E specs 110/110 and unit
tests 236/236; A13.3b `test:deploy` 256/256 and both real drills (§4A); A13.4a `backup-restore.test.mjs` 111/111 (M1, below).
`check:repo` passes throughout. A disposable local PostgreSQL 16 smoke ran
the real Audit and kit migrations and exercised the new SQL: the facts query, the deploy's assertion (empty after narrowing; it names
`schema_migrations:INSERT` when re-broadened), the six triggers, and the controls (all refused, every row count unchanged; a disabled
append-only trigger is detected as N2). It found one defect, fixed before review: the known record's instant carried microseconds, which
the API's `from`/`to` grammar refuses.

**M1 (A13.4 review, corrected in A13.4a).** Nothing enforced "0004 before the first Audit backup": `backup.sh` would have dumped a
database without 0004 and produced a backup the drill cannot restore. `backup.sh` now refuses an Audit backup at preflight unless
`schema_migrations` records `0004_changes_validation_search_path.sql` (a constant of the Audit target, read as `audit_migrator` before
anything is dumped; Auth and Organization run no such check). Tests prove the refusal leaves no dump, upload, manifest or success status,
that a caller cannot redirect or bypass it, and that removing or weakening it is detected; the query was checked on PostgreSQL.

## 8. Not done here (each separately authorized)

The required future order, none of it performed: A13 tooling certified → a separately authorized Audit immutable-digest deployment →
migration 0004 applied → the O3-B `schema_migrations` narrowing and assertion → deployment health, `/ready` and consumer verified → only
then the first production Audit backup (`backup.sh` refuses it before) → its verification → a separately authorized production
real-volume Audit restore drill. A3.6 stays deferred.


| Item | Gate |
|---|---|
| A13.3 local validation campaign (full suites, negative controls, the local end-to-end Audit drill with the real image, local RTO) | local, next |
| the `schema_migrations` correction in production | production-gated: an Audit deployment (A3.6-class) or separately authorized SQL |
| migration 0004 in production (**before** the first production Audit backup) | production-gated: an Audit deployment (A3.6-class) |
| the first production Audit backup; off-host object check | production-gated |
| the real-volume Audit drill in the recovery environment; production-data RTO | production-gated |
| scheduled backups, the `production-backup` environment, operational RPO, recurring drill cadence | G6-gated |

A3.6 and A3.7 stay deferred; A3.8 is not certified; G6 is deferred; G7, F6 and F7 stay locked; Final Core Validation is the absolute
last.

## 9. Certification (local tooling + CI)

**Certified:** the A13 implementation and its local and CI evidence. **Not certified (production-gated):** see the table below.

| Evidence | Identifier | Result |
|---|---|---|
| Implementation | PR #194, head `c540627904263f8046cb8cbe6ee77dfc3fb7e80d`, merge `96e3aaf722859478d3dd25848f1db81f56ae9d83` | merged by the owner, 2026-10-04 |
| PR Core CI | run 37231246351, attempt 1 | 24/24 passed |
| Post-merge Core CI | run 37231831988, attempt 1 | 24/24 passed, `core-ci-passed` passed |
| Post-merge Audit image | run 37231832018 | success: `ghcr.io/nawara-solutions/nawara-core-audit-service:sha-96e3aaf722859478d3dd25848f1db81f56ae9d83`, index digest `sha256:436b0797f62054399895066d4c13f3e39447a69c6e3636d4a54b9fdcaf4e54c0` (contains 0004 and the O3-B deploy correction). **BUILT ≠ DEPLOYED** |

**Local proof (§4, §4A, §7, M1):** the Audit backup target and restore drill; the real PostgreSQL dump and restore proof; migration 0004;
the O3-B narrowing and assertion; the canonical ACL fact; the TCP readiness probe; the migration-0004 backup prerequisite; and two
complete local Audit drills with the repository scripts (the disposable RabbitMQ, the real `/ready`, the consumer, the known-record
read). Final validation: `test:repo` 50/50; `test:deploy` 261/261; `backup-restore.test.mjs` 111/111; the A13.3 negative controls (62
attempted, 60 detected, B15 and R5 analysed as redundant-layer gaps, 0 restoration failures); the M1 controls 5/5; Case 1 (O3-B source)
and Case 2 (narrowed source) each 14 checks and 48 facts. The local drill duration, about 90–98 s, is **not** a production RTO.

**Security review (A13.4, A13.4a):** 0 BLOCKER, 0 HIGH, 0 MEDIUM (M1 fixed). Open LOW findings, non-blocking: L1, the real PostgreSQL
and full Audit E2E proofs are local evidence, not CI; L3, the analysed B15 and R5 mutation gaps. (L2 was resolved in A13.4a.)

| Not certified here (production-gated) | Gate |
|---|---|
| a production Audit deployment; 0004 and the O3-B correction applied in production | a separately authorized Audit digest deployment (A3.6-class) |
| the first production Audit backup | **blocked**: `backup.sh` refuses it until `0004_changes_validation_search_path.sql` is in production `schema_migrations` |
| a production Audit restore drill; a production RTO | separately authorized, after the first backup |
| an operational 24 h RPO | G6-gated scheduling; the RPO stays a target |

A3.6 and A3.7 stay deferred; A3.8 is not certified; G6 is deferred; G7, F6 and F7 stay locked; Final Core Validation is the absolute last.

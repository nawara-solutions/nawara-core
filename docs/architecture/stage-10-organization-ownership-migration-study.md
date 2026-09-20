# Stage 10 study: organization ownership migration (Auth → organization-service)

- **Status:** Study only. **No implementation, no migration, no change of ownership.** Classification: **BLOCKED BY ARCHITECTURE DECISION** (section 23).
- **Date:** 2026-09-20
- **Update (2026-09-20):** the classification above is the study as first written and is kept as history. Its blocking decisions have since been taken: BD-1 to BD-3 are adopted as decisions 1 to 4 of [ADR-0040](../adr/0040-organization-ownership-migration-decisions.md) (Amendment 1) and BD-4 is resolved by [ADR-0042](../adr/0042-service-token-scopes-and-administrative-authorization.md) (Amendment 1). ADR-0040 is now Accepted (decisions 1 to 6 and the production-readiness gates of its decision 7), and the architecture no longer blocks *starting* Stage 10.1 (see the [BD-4 implementation study](./stage-10/stage-10-bd4-implementation-study.md), section 16). Production readiness is a separate matter, governed by those gates. Where this study calls the contract step a table drop, ADR-0040 supersedes it.
- **Baseline:** `main` at `6e7ddcc` (descendant of the audited `f2edb08`; auth, billing, payment and the kit are unchanged since `f2edb08`).
- **Governing decision:** [ADR-0039](../adr/0039-organization-ownership-and-cross-service-migration-authority.md). Also read: ADR-0020, 0022, 0024, 0026, 0030, 0031, 0033, 0038.
- **Method:** every fact below was taken from the repository itself. Auth's schema was obtained by applying all seven Auth migrations to a scratch PostgreSQL 16 and reading the system catalogs; Organization Service's the same way. Nothing here was run against a real environment.

## 1. Executive summary

Stage 10 is **not** "copy three tables, switch the owner, drop three tables". Seven Auth-owned tables have foreign keys into the hierarchy, and Auth's authorization, `/auth/me`, onboarding and administration read the hierarchy locally. The migration mechanics of ADR-0039 (import, verify, freeze, cutover) are sound and can be made rigorous, but **the ADR is silent or wrong on the one question that decides whether the end state works: what Auth does with hierarchy facts after cutover.**

Headline findings, each verified in the repository:

1. **ADR-0039 cannot be implemented as written past cutover.** It says Auth keeps "a copy … for its own membership joins" with no projection. A non-authoritative, unsynchronized copy is wrong the moment organization-service creates or renames anything: a new organization could never receive a membership, join code, invitation or operator assignment (the FKs point at Auth's stale copy), and `/auth/me` would show stale names. Either the FKs go and something else validates (section 15), or Auth is fed (a projection, which ADR-0039 did not choose). **This needs a new decision (BD-1).**
2. **`/auth/me` is session validation for the whole platform.** ADR-0033 has every service ask Auth `GET /auth/me` on every user request (the kit's `HttpAuthClient` does, uncached, and treats a response without a `memberships` array as a 503). Making `/auth/me` synchronously depend on organization-service would make organization-service's availability a dependency of every Billing and Payment user call. The "login/refresh independence" rule must therefore be read to include `/auth/me`.
3. **The write-path inventory in ADR-0039 was wrong** (already corrected in the ADR's note). The real set is: the bootstrap CLI's `INSERT INTO company`, and direct SQL. There are no Auth HTTP write routes and no platform or organization writers at all. There is also **no creation path for Company/Platform/Organization anywhere after cutover** except organization-service's service-token API, and nobody is designated to call it (BD-4).
4. **Production reality changes the freeze design.** Auth's production app connects as its PostgreSQL bootstrap superuser (least-privilege roles are "NEEDS IMPLEMENTATION" in production), so a `REVOKE`-based freeze would do nothing. A trigger-based freeze does work. **Auth's production deploy also applies every pending migration automatically on each deploy**, so any Stage 10 Auth migration must be an inert "expand" step; the freeze, the switch and the destructive "contract" must be separate, deliberately gated actions (ADR-0039 forbids cutover coinciding with a code deployment).
5. **Organization-service has no production presence yet** (no deploy workflow, no production database or roles, no registered callers). That is a precondition, not a Stage 10 detail.
6. **The delete-and-reinsert finding is load-bearing.** Any strategy that lets Auth trust an anchor (organization → platform → company) recorded once relies on those anchors never changing. The triggers guarantee that for UPDATE only; organization-service's runtime role can still delete and re-insert an id under another parent. The lifecycle decision (deletion, id reuse) is a prerequisite for the Auth reference model, not an independent backlog item (BD-5).

Migration mechanics are otherwise well determined and are designed in sections 7 to 11: an export artifact produced under a snapshot, an all-or-nothing rerunnable import that never overwrites, full-column verification run twice (before and after freeze), a trigger-based freeze that proves no write occurred, a single-writer cutover ordering, and a rollback that is provably safe only in a "zero-write window".

## 2. Current-state architecture

```
auth-service (owns, physically, TODAY)            organization-service (built, NOT authoritative, no callers)
  User, credentials, sessions, MFA/recovery         Company / Platform / Organization (empty)
  OrganizationMembership                            own DB, service-token-only API, no Auth dependency
  company / platform / organization  ◄── 7 Auth tables carry FKs into these three
billing / payment: opaque organizationId / platformId, no FK, no Auth-membership use
```

| Fact | Evidence |
|---|---|
| Auth owns the 3 tables; the only application writer is the bootstrap CLI | `apps/auth-service/src/cli/owner-tools.ts:31`; no Auth route or service writes `platform` or `organization`; no Auth migration inserts rows |
| Auth production: dedicated PostgreSQL container, app connects as the bootstrap superuser `auth` | `apps/auth-service/deploy/provision-and-deploy.sh:43-85` (`DATABASE_URL=postgres://$PGUSER:…`); `docs/architecture/production-readiness.md` §2 ("NEEDS IMPLEMENTATION") |
| Auth deploy applies pending migrations automatically | `deploy/provision-and-deploy.sh:67-76` |
| Only auth-service has a deploy workflow | `.github/workflows/` (`auth-service-deploy.yml`, `auth-service-docker-build.yml`, `core-ci.yml`) |
| Organization-service accepts no caller until tokens are registered | `SERVICE_TOKENS` empty by default; refused with 401 |
| Other services identify users through Auth on every request | ADR-0033; `libs/service-kit/src/service-auth/auth-client.ts:54` |

## 3. Actual Auth hierarchy schema

Derived by applying migrations 0001 to 0007. Migration 0001 creates the three tables (including `platform`'s `UNIQUE (id, companyId)`); 0004 adds `platform.key` with its two constraints and `organization`'s `UNIQUE (id, platformId)`. Migrations 0005 to 0007 do not alter the three tables: they add the invitation table, change `organization_membership` and `user`, and create the `member_platform` view.

| Table | Columns (type, null) | Constraints and triggers |
|---|---|---|
| `company` | `id uuid PK default gen_random_uuid()`, `name text NOT NULL`, `createdAt timestamptz NOT NULL`, `updatedAt timestamptz NOT NULL` | `CHECK btrim(name) <> ''` |
| `platform` | `id`, `companyId uuid NOT NULL`, `name text NOT NULL`, **`key text NULL`**, `createdAt`, `updatedAt` | FK `companyId → company(id)` RESTRICT; `UNIQUE (id, companyId)`; `platform_key_format CHECK (key IS NULL OR key ~ '^[a-z][a-z0-9-]{1,39}$')`; `platform_key_uk UNIQUE (key)`; trigger `platform_company_immutable` (`forbid_column_change('companyId')`) |
| `organization` | `id`, `platformId uuid NOT NULL`, `name text NOT NULL`, `taxCode text`, `address text`, `phone text`, `type text` (opaque), `createdAt`, `updatedAt` | FK `platformId → platform(id)` RESTRICT; `UNIQUE (id, platformId)`; trigger `organization_platform_immutable`; index `organization_platform_idx` |

Also in Auth: view `member_platform` (membership → organization → platform → company; **used by no code**) and `platform_non_working_day` (**no code touches it**). No function or trigger reads the hierarchy tables: the guard triggers only freeze columns, and `user_require_subtype` merely matched the word "organization".

## 4. Actual Organization Service schema

Migrations `0001` to `0003` (plus the kit's). Column sets are **identical** to Auth's for all three tables (position, type, nullability, default, collation), including `platform.key` with the same two named constraints. Deliberate differences: the two composite `UNIQUE` keys are absent (they exist in Auth only as targets for Auth-owned composite FKs), extra keyset-pagination indexes, and stricter immutability triggers (`id` and `createdAt` frozen too). The database accepts explicit ids and timestamps; the API never does. The runtime role can `DELETE` (default grants); there is no lifecycle, no importer, no authority state.

## 5. Exact Auth dependent-table inventory

Catalog result: **nine FKs reference the three tables. Two are internal to the hierarchy; seven come from Auth-owned tables.** All nine are `ON DELETE RESTRICT`, `ON UPDATE NO ACTION`, not deferrable.

| # | Auth table | Column(s) | FK constraint | References | Why Auth needs it | Can the FK survive cutover? | Replacement | App validation needed | Ordering impact |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `owner` | `companyId` | `owner_companyId_fkey` | `company(id)` | Owner is company-scoped; `owner_single_per_company_v1` (unique), `owner_user_company_uk` (target of composite FKs) | **No** (target is non-authoritative) | opaque `companyId`; existence checked once, at bootstrap, against organization-service | Yes, at owner bootstrap only (BD-4) | Bootstrap must create the company in organization-service first |
| 2 | `operator` | `companyId` | `operator_companyId_fkey` | `company(id)` | Operator belongs to the owner's company; `operator_user_company_uk` | **No** | opaque `companyId`; **no external check needed**: it is derived from the creating owner's own row (`operator-admin.service.ts:24`) | No new lookup | none |
| 3 | `platform_assignment` | `platformId, companyId` | `pa_platform_fk` | `platform(id, companyId)` (composite) | Guarantees a grant names a platform of the operator's company; append-only history | **No** | opaque ids; the same-company rule is **already re-checked in code** (`assignment.service.ts:47`) and must become a check against organization-service at grant time | **Yes**, at grant (BD-1) | Grants stop working post-cutover unless the check is replaced |
| 4 | `platform_non_working_day` | `platformId` | `platform_non_working_day_platformId_fkey` | `platform(id)` | Platform calendar; **no code uses it** | **No** | drop the table or the FK; preflight must count rows | Only if rows exist | Preflight gate |
| 5 | `organization_membership` | `organizationId` | `membership_organization_fk` | `organization(id)` | The user ↔ organization link (ADR-0030); `membership_user_org_uk`, `membership_org_status_idx` | **No** | opaque `organizationId` (ADR-0039 already says so) | Existence is established when the join code/invitation is created, not at membership time | Verification must prove no orphan |
| 6 | `organization_join_code` | `organizationId, platformId` | `join_code_org_platform_fk` | `organization(id, platformId)` (composite) | Pair consistency: a code can never cross platform or company; `join_code_id_org_uk` | **No** | opaque pair, derived **server-side at creation** from the organization (`platformOfOrganization`) | **Yes**, at creation (BD-1) | Code creation needs the derivation replaced |
| 7 | `organization_admin_invitation` | `organizationId, platformId` | `admin_invitation_org_platform_fk` | `organization(id, platformId)` (composite) | Same as 6; `admin_invitation_id_org_uk` | **No** | as 6 | **Yes**, at creation (BD-1) | as 6 |
| (i) | `organization` → `platform` | `platformId` | `organization_platformId_fkey` | `platform(id)` | Hierarchy | moves with the table | organization-service's own FK | n/a | n/a |
| (i) | `platform` → `company` | `companyId` | `platform_companyId_fkey` | `company(id)` | Hierarchy | moves with the table | organization-service's own FK | n/a | n/a |

**Indirect dependents** (transitive closure over the FK graph, none carries a hierarchy column, none is affected by removing FKs 1 to 7, because `owner`, `operator` and `organization_membership` remain): `operator_schedule`, `operator_time_off`, `admin_operator_code` (via `operator`); `admin_device`, `owner_auth_challenge`, `owner_auth_factor`, `owner_recovery_request`, `owner_step_up` (via `owner`).

**Non-FK dependents:** view `member_platform` (depends on all three tables, unused: dropped at contract); the redundant `platform_assignment.companyId` (kept: it still keys the `operator` and `owner` composite FKs, which stay local).

**Read-path inventory (Auth application code that reads the hierarchy).** This is what actually breaks or changes:

| Flow | File | Reads | Kind of fact |
|---|---|---|---|
| Owner/operator authorization (`check`) | `platform/platform-access.service.ts` | `platform` existence, `platform.companyId` | **anchor** (platform → company) and existence |
| Organization authority (join codes, membership decisions, admin invitations) | same, `platformOfOrganization` | `organization.platformId`, `platform.companyId` | **anchors** |
| `GET /auth/me` memberships | `membership/membership.service.ts:59-72` | org `name`; platform `id`, `key`, `name` | anchor + **mutable presentation** |
| `POST /auth/onboarding/resolve` (unauthenticated) and invitation preview | `onboarding/onboarding.service.ts:64-97`, `invitation.service.ts:80-113` | org and platform names, `key` | mutable presentation |
| Registration, join, invitation consume | `auth/auth.service.ts:62,111`, `invitation.service.ts:141` | **ids only** (they share `lookup()`, whose JOIN exists for `resolve`) | none needed |
| Join-code creation | `onboarding.service.ts:147` | `platform.key` (cosmetic code prefix) | mutable presentation |
| Operator assignment | `platform/assignment.service.ts:47` | platform exists **and** belongs to the owner's company | anchor |
| Bootstrap CLI | `cli/owner-tools.ts:30-31` | `SELECT`/`INSERT` on `company` | **write** |
| **Login, refresh, logout, member access check** (`memberBelongsTo`) | `auth/auth.service.ts`, `platform-access.service.ts` | **nothing from the hierarchy** | none |

The split between **immutable anchors** (organization → platform, platform → company; frozen by trigger) and **mutable presentation** (names, `key`, metadata) drives the design in sections 13 and 15.

## 6. Cross-service reference inventory

| Service | Reference | Type | Constraint | Uses Auth memberships or platform access? |
|---|---|---|---|---|
| billing | `invoice.organizationId` | `uuid` null | none (`REFERENCES` count in billing and payment migrations: **0**) | no |
| billing | `platform_currency.platformId` | `text` 1 to 128 chars, PK part | none; B-036 unresolved | no |
| payment | `payment.organizationId` | `uuid` null, frozen by trigger | none | no |
| billing, payment | user identity via `GET /auth/me` | `id`, `isActive` only | n/a | **only `identity.id`/`isActive`**; `memberships`/`adminTier` are read by nobody; `hasPlatformAccess` is called by nobody |
| Auth events | `user.registered`, `membership.*` carry opaque `organizationId` | payload | none | n/a |
| external apps (nawara-drive, daycare) | `/auth/me`, `/auth/onboarding/resolve` shapes | HTTP | **unknown, not in this repo** (BD-8) | probably |

Historical invoices, payments and snapshots are immutable and never rewritten; nothing needs to change in Billing or Payment (section 16).

## 7. Migration phases

ADR-0039 defines phases A to E. This study splits them slightly and adds a mandatory preflight; the mapping is exact:

| Study phase | ADR-0039 | Nature | Reversible? |
|---|---|---|---|
| A Preflight | (new) | read-only | yes |
| B Bootstrap/import | A | writes only organization-service's own DB | yes (abandon) |
| C Verification | B | read-only | yes |
| D Controlled freeze | C | writes Auth marker (reversible) | yes until E |
| E Cutover | D | activates organization-service | zero-write window only |
| F Post-cutover verification | E | read-only | n/a |
| (later) Contract | (new) | drops Auth objects | **no** |

State machine (durable, recorded in organization-service's DB, with a matching marker in Auth):

```
planned → exported → imported → verified → frozen → verified_frozen → org_active → verified_active → (soak) → auth_retired
             ▲          │ any mismatch/failure stops the run; nothing self-repairs
             └──────────┘ abandon (before freeze) or unfreeze (before org_active)
```

| Phase | Exact operations | Owner / DB / service | Reads | Writes | Invariants | Failure conditions | Recovery | Idempotency |
|---|---|---|---|---|---|---|---|---|
| **A** | schema-version check of both DBs; migrations 0001 to 0003 applied on organization-service; **org DB empty of hierarchy rows**; org-service has **no registered tokens** (unreachable to everyone); Auth counts, orphan and cross-table id-collision checks (`id` sets of the three tables must be disjoint); `key` values match the format; `platform_non_working_day` row count; backups of both DBs taken **and restore-tested**; decisions BD-1..BD-5 recorded | migration operator; Auth DB (read-only), org DB | Auth hierarchy + dependents; org catalog | none (a `planned` run record in org DB) | preconditions of section 8 | any check fails | fix, rerun | read-only, always safe |
| **B** | export from Auth under one snapshot to an artifact; import artifact into org DB, parents first, one transaction | operator; Auth DB (read-only snapshot), org DB | Auth 3 tables | org 3 tables + run record | ids, timestamps, `key`, every column copied byte-exact; Auth untouched | artifact corrupt; destination row differs | transaction rolls back; org DB left empty | rerun = compare-only, never update (section 8) |
| **C** | full comparison (section 9) plus dependent cross-check | operator | both DBs | report + run record | equivalence | any diff | stop; investigate; **no repair** | read-only |
| **D** | activate Auth freeze (section 10) | operator; Auth DB | Auth | Auth marker row | single writer: nobody writes hierarchy | lock timeout; freeze rejected | rollback = unfreeze | activate is idempotent; a second activate is a no-op |
| **E** | re-verify under freeze; **activate organization-service with tokens still unregistered** | operator; org DB, Auth DB | both | org authority flag; Auth marker `org_authoritative` | at most one of (Auth unfrozen, org active) is true at any instant | crash between steps | section 18 | each step is a compare-and-set on the run state |
| **F** | re-run verification against org DB and the frozen Auth snapshot; only then register caller tokens | operator | both | token registration (config) | nothing wrote between activation and check | any diff | section 18 | read-only until tokens |

Observability and correlation ids for every step: section 20.

## 8. Bootstrap/import design

**Mechanism options (temporary migration tooling only; the permanent runtime architecture keeps database-per-service):**

| Option | Verdict | Why |
|---|---|---|
| Organization-service reads Auth's DB directly | **Rejected** | needs Auth DB credentials and network reach in organization-service's environment; Auth's production DB has no published port (`deploy/provision-and-deploy.sh`); normalizes the cross-DB access ADR-0032 forbids, even if temporary |
| Auth HTTP API | **Rejected** | Auth has no list endpoint for these tables; adding one exposes the whole hierarchy on a new surface, with no user or service scope model (O13/O14 open) |
| **Export artifact from a read-only snapshot, then file-based import** | **Recommended** | no cross-DB credential anywhere; the export runs where Auth's DB is reachable (operator, inside Auth's network); the artifact is checksummed and verifiable offline; organization-service only reads a file; both steps are inspectable and rerunnable |

**Export.** One `REPEATABLE READ, READ ONLY` transaction on Auth; export the three tables **ordered by `id`** as canonical rows (all columns, timestamps in microsecond text form, `NULL` distinguished from empty string) plus a **manifest**: source database identity, Auth migration checksums, per-table row count and sha256 of the canonical rows, a whole-artifact sha256, snapshot time. No Auth write, no Auth code change required (a standalone tool run by the operator).

**Import.** A dedicated organization-service command, run by the migration role, never through the HTTP API (the API refuses ids by design):

1. Verify manifest and checksums before touching the database.
2. One transaction, parents first (company, platform, organization), explicit `id` and timestamps.
3. For a row that already exists: **identical** → skip; **different in any column** → abort the whole run (no `UPDATE`, no `ON CONFLICT DO UPDATE`).
4. Rows present in the destination but absent from the artifact → abort.
5. Record the run and digests in the run table.

Because the three tables are small, all-or-nothing in one transaction is simplest and gives "partial import" no valid state. **Rerun safety:** the import is compare-and-insert; running it twice yields the same result or a mismatch failure, never a silent overwrite. **Preserved:** ids, all timestamps, `key`, `taxCode`, `address`, `phone`, `type`, NULL semantics; the database re-enforces uniqueness and checks on insert. **Not preserved by design:** index names and the two composite unique keys (documented in section 4).

**Where the tooling lives** (implementation-stage choice): outside both services' runtime paths, one dedicated package, removed after Stage 10 completes. **Ratifying this option is a small decision (BD-6).**

## 9. Verification design

Compare **every persisted column**, not only ids and counts. Field lists (from the actual schema; the study brief's lists omit three organization columns that exist):

| Table | Compared columns |
|---|---|
| company | `id, name, createdAt, updatedAt` |
| platform | `id, companyId, name, key, createdAt, updatedAt` |
| organization | `id, platformId, name, taxCode, address, phone, type, createdAt, updatedAt` |

Checks, all in both directions (missing and extra rows are failures):

1. **Set equality** of ids per table; **disjointness** of the three id sets.
2. **Row equality** on canonical text (timestamps to the microsecond; `NULL` ≠ `''`), with a per-table and a whole digest.
3. **Hierarchy:** every `platform.companyId` and `organization.platformId` resolves inside the destination; identical parent per child as in Auth.
4. **Constraint equivalence:** an automated catalog comparison (columns, nullability, defaults, PK, unique, check, FK) of Auth vs organization-service, expecting exactly the documented differences (section 4). This is buildable now and catches schema drift before it matters.
5. **Dependent cross-check (this is what protects Auth):** for each of the seven dependent tables, every referenced id exists in the destination; every join code and invitation `(organizationId, platformId)` pair equals the destination's `organization.platformId`; every `platform_assignment (platformId, companyId)` equals the destination's `platform.companyId`; every owner/operator `companyId` exists.
6. **Auth-side invariants hold** on the source (no orphans, `key` format).

**Mismatch behavior:** the run **fails and stops**. Nothing repairs anything (ADR-0039: "verification failing means Phase C is not entered"; no ADR authorizes a repair). The report lists differences by table and id (ids only, no row content in logs).

Verification runs **twice**: before the freeze (proves the import) and **after** the freeze (proves the state that will actually be handed over). A pass before the freeze says nothing about the cutover instant.

## 10. Write-freeze design

**Verified write paths to `company`, `platform`, `organization`:**

| # | Path | Status |
|---|---|---|
| W1 | Bootstrap CLI `INSERT INTO company` (`cli/owner-tools.ts:31`) | real; runs from an operator shell |
| W2 | Direct SQL by anyone with database access | real; **in production the app itself is the bootstrap superuser** |
| W3 | Auth migrations | none insert rows (verified); schema-only per ADR-0016 |
| W4 | Test helpers | tests only |
| W5 | Any Auth HTTP route or internal service | **none exists** (ADR-0039's list was wrong) |

**Mechanism.** Because W2 includes a superuser and Auth's app is one, a `REVOKE` freeze is ineffective in production today. Use **database triggers**, which fire regardless of role:

- An *expand* migration (inert, safe to auto-deploy) adds a single-row `ownership_state` table (`auth_authoritative | frozen | org_authoritative`) and `BEFORE INSERT/UPDATE/DELETE` row triggers plus a `BEFORE TRUNCATE` trigger on the three tables that raise unless the state is `auth_authoritative`. Dormant until the marker changes.
- **Activation** is one transaction: `LOCK TABLE company, platform, organization IN SHARE ROW EXCLUSIVE MODE` (waits for in-flight writers, blocks new ones), then set the marker to `frozen`, commit. In-flight writes therefore either commit before the lock or are rejected after it.
- A superuser can still deliberately bypass triggers (`session_replication_role`, disabling a trigger). The freeze is a guard against mistakes and stale code, not against a malicious database administrator; the proof below catches the rest.

**Proof that no write happened in the critical window:** the canonical digest of the three tables at export equals the digest computed after the freeze (and again at cutover). Equal digests mean no row changed. PostgreSQL write counters (`pg_stat_user_tables`) are recorded as advisory evidence only, since they are not transactional.

**Stale code:** an old Auth instance still running is stopped from writing by the database, independent of its version.

**Lifting.** The freeze is never lifted for the copy once organization-service is active; it becomes the permanent "Auth is not authoritative" guard until the contract step drops the tables. It is lifted only by rollback before activation (section 18).

**Organization-service side:** until activation it must accept no hierarchy write except the importer; the preflight asserts no service token is registered.

## 11. Cutover design

**No distributed transaction exists between the two databases.** The design instead guarantees a **single-writer invariant at every instant**: at most one of {Auth unfrozen, organization-service active} is true, because the order is *freeze Auth → verify frozen → activate organization-service → mark Auth retired*, and each step is a compare-and-set on the recorded run state.

- Crash after freeze, before activation: nobody can write the hierarchy (safe stall); recovery is unfreeze or resume.
- Crash after activation, before the Auth marker reaches `org_authoritative`: Auth stays frozen, so still exactly one writer.

**The authority record (BD-2, deferred by ADR-0039).** Candidate for ratification: the authoritative record is organization-service's **own** state row, which organization-service enforces on itself (it refuses hierarchy writes unless `authoritative`); the Auth marker is a defensive mirror. Consumers never poll it: after cutover the only party that needs to know is the party that decides where Auth looks for hierarchy facts, and that is an Auth **deployment-time configuration** (below), not a runtime query. This must be decided, not assumed.

**Code deploy is never the cutover** (ADR-0039). Auth changes follow expand / switch / contract:

| Step | What | Automatically deployable? |
|---|---|---|
| Expand | inert marker table and dormant triggers; new code behind an interface with the *local* implementation still selected; any new columns (BD-1) | yes (auto-applied by the deploy script, therefore must be inert) |
| **Switch** | operator flips Auth's hierarchy source to the new implementation (configuration + restart) as part of the cutover, after Phase F | **no**, deliberate |
| **Contract** | drop FKs 1 to 7, the `member_platform` view, then the three tables, in one transactional migration after a soak | **no**: irreversible, separate release, explicit approval, backup first |

## 12. Auth membership implications

Answers to the required questions:

1. **Does `OrganizationMembership` keep `organizationId`?** Yes, as an opaque id (ADR-0039, ADR-0030). No other change to the relationship.
2. **How is organization existence validated?** Today by FK. After cutover, existence is established when the **join code or invitation is created** by an authorized administrator (the only doors into a membership), not when the membership row is written; registration, join and invitation-consume already work from ids stored on the code/invitation row. The creation-time check needs organization-service (BD-1).
3. **Does Auth need synchronous organization-service calls?** For login, refresh, logout, session use and `memberBelongsTo`: **no** (none read the hierarchy). For administration (authority derivation, code and invitation creation, assignment): **depends on BD-1**.
4. **Can membership authorization work on opaque ids alone?** Yes for the member check. Owner/operator/org-admin authority additionally needs `organization → platform → company` (anchors).
5. to 8. see section 13.
9. **Organization-service unavailable:** login/refresh/logout/member access unaffected. Administration and any flow that needs a fresh hierarchy fact fails **closed** (503), per the existing "any service → dependency: fail closed" convention. `/auth/me` behavior depends on BD-1 (section 13).
10. **What must remain in Auth locally:** memberships (opaque `organizationId`), join codes and invitations with their stored `(organizationId, platformId)`, owner/operator `companyId`, assignments. Whether Auth additionally stores anchors on membership rows, or reads presentation facts elsewhere, is BD-1.

## 13. `/auth/me` implications

**What `/auth/me` returns today** for a member: per membership `organization {id, name}`, `platform {id, key, name}`, `status`, `audience`, `isOrganizationAdmin`, plus `id`, `adminTier`, `isActive`. Billing and Payment use only `id` and `isActive`; **external consumers are unknown (BD-8)**.

**Why it is not "just another endpoint".** Other services call it on every user request and fail with 503 if it errors or lacks `memberships`. Any synchronous dependency of `/auth/me` on organization-service becomes a dependency of every Billing/Payment user call.

| Option (Auth's reference model after cutover) | `/auth/me` | Administration | New Auth state | Violates |
|---|---|---|---|---|
| **R1** Pure synchronous lookup, no local state | depends on organization-service | depends | none | login/refresh/session independence in spirit (`/me` is validation); availability coupling |
| **R2** Capture the **immutable anchors** on Auth-owned relationship rows at creation (validated once), read **presentation** (names, `key`) by bounded, optional enrichment | ids local; names best-effort (contract change: optional) | anchors local, no call | new columns on Auth rows (join codes and invitations already store the pair; membership does not), backfilled at expand | "no duplicate hierarchy data in Auth" unless explicitly approved; **only safe if anchors truly never change (BD-5)** |
| **R3** Event-fed read replica in Auth (projection) | local | local | a replica of the hierarchy | **explicitly not chosen by ADR-0039**; a standing event contract; needs the reliable-events work (ADR-0037, not deployed to production) |
| R4 Keep Auth's tables as a frozen copy, FKs unchanged | stale names | new orgs unusable | stale tables | **not viable** (finding 1) |

**Recommendation to ratify (not decided here):** R2, because it is the smallest change consistent with every non-negotiable and mirrors a pattern Auth already uses (join codes store their platform). It requires BD-5 first. R1 is the fallback if the `/auth/me` contract may not lose names. R3 needs its own explicit approval.

## 14. Auth login/refresh independence analysis

Verified: `login`, `refreshSession` and `logout` and every method they call (`users`, `sessions`, `refresh`, `ownerAuth`, `throttle`, `audit`) read **no** hierarchy table or column. Stage 10 must add none. The non-negotiable is preserved by: no organization-service call from these paths; no Auth code deploy that changes them; the regression suite of section 22 (which asserts login/refresh keep working with organization-service stopped). The related, stricter constraint is section 13: `/auth/me` must not gain a mandatory synchronous dependency either.

## 15. Foreign-key transition strategy

Rules: no permanent cross-service FK; no generic tenant abstraction; no duplicated authoritative hierarchy in Auth without an explicit decision.

1. **Expand** (inert, auto-deployable): marker table and dormant triggers; new code behind a `HierarchyReader` port with the local SQL implementation selected; if R2, add anchor columns and backfill from the existing local tables **before** any switch.
2. **Switch** at cutover: the port selects the organization-service implementation (client with a per-pair service token, ADR-0033; bounded timeout; fail closed). The FKs still exist but are no longer relied upon.
3. **Contract** after a soak: drop FKs 1 to 7 (`owner_companyId_fkey`, `operator_companyId_fkey`, `pa_platform_fk`, `platform_non_working_day_platformId_fkey`, `membership_organization_fk`, `join_code_org_platform_fk`, `admin_invitation_org_platform_fk`), drop `member_platform`, drop the three tables, in one transactional migration.
4. **Replacements per table:** section 5. The composite-FK guarantees (pair and company consistency) become **creation-time validation against the authoritative source plus anchor immutability**, which is why BD-5 gates R2.
5. Intermediate state is legal and tested: FKs present but unused. Nothing at the database level breaks while both exist, because organization-service is a separate database.

Open: whether the contract step drops the three tables or keeps them read-only for a defined period (BD-1).

## 16. Billing/Payment impact analysis

None required. Both store `organizationId`/`platformId` as opaque values with no `REFERENCES` (0 across both services' migrations); historical `invoice` and `payment` rows and Billing's immutable issuer/bill-to snapshots are untouched by an ownership change; `payment.organizationId` is frozen by trigger. Neither consumes `memberships` or platform access. **Do not modify either service in Stage 10.** A future need to validate an `organizationId` for non-user requests (ADR-0031's open question) is now answerable by organization-service but is a separate decision, not part of this stage. B-026/O-18 and B-036 are unaffected.

## 17. Failure matrix

| # | Scenario | Detection | Expected state | Safe action | Rollback / recovery | Manual? |
|---|---|---|---|---|---|---|
| 1 | Importer crashes | no `imported` state; process exit | org DB unchanged (one transaction) | rerun | none needed | no |
| 2 | Importer runs twice | second run finds identical rows | idempotent skip | none | none | no |
| 3 | Partial import | impossible (single transaction) | empty or complete | rerun | none | no |
| 4 | Source row changes during export | snapshot isolation makes it invisible; Phase C/F digests catch drift | artifact is a consistent snapshot | rerun export, then verify again after freeze | discard artifact | no |
| 5 | Destination row differs | importer compare finds a difference | run aborted, nothing written | investigate | abandon org DB import | **yes** |
| 6 | Verification mismatch | Phase C report | stays at `imported` | stop, investigate | abandon or fix cause, reimport | **yes** |
| 7 | Freeze fails (lock timeout) | activation transaction errors | still `auth_authoritative` | retry in a quiet window | none | maybe |
| 8 | Write occurs during freeze | trigger raises; digest at freeze equals digest at export | write rejected, no change | investigate the caller | none | maybe |
| 9 | Auth crashes during cutover | run state shows last completed step | freeze persists in DB; single writer intact | restart Auth, resume | unfreeze if before activation | maybe |
| 10 | Org service crashes during cutover | activation is one DB transaction | either active or not | restart, compare-and-set resumes | before activation: unfreeze | maybe |
| 11 | Deployment rollback after cutover | version check | database authority unchanged | see section 18 | ownership is **not** rolled back by a redeploy | **yes** |
| 12 | Migration command interrupted | run record shows the step | state is the last committed step | resume the named step | none | no |
| 13 | DB connection loss | client error | last committed state stands | resume | none | no |
| 14 | Stale old Auth process still running | old code writes are rejected by triggers | reads stale, writes blocked | drain the old process | none | no |
| 15 | Org service unavailable after cutover | health/ready | login/refresh unaffected; hierarchy-dependent flows fail closed per BD-1 | restore service | n/a | maybe |
| 16 | Auth unavailable after cutover | health | organization-service unaffected (no Auth dependency) | restore Auth | n/a | no |
| 17 | A dependent Auth FK cannot be removed | contract migration error | DDL is transactional: nothing dropped | find the blocking object (view, dependent) | none | **yes** |
| 18 | Orphaned membership | verification cross-check (Phase C/F) and a re-runnable read-only reference report | none exist pre-cutover (FK); post-cutover only via deletion (BD-5) | do not proceed / fix data explicitly | not auto-repaired | **yes** |
| 19 | Duplicate hierarchy id | PK violation, or id-set overlap check across the three tables | run aborted | investigate | none | **yes** |
| 20 | Delete/reinsert lifecycle edge | pre-cutover: DELETE blocked by freeze trigger; post-cutover: runtime role still has DELETE | **unresolved by any ADR** | do not proceed to R2 without BD-5 | n/a | **yes (decision)** |

## 18. Rollback strategy

**Deployment rollback is not ownership rollback** (ADR-0039). Tiers:

| Point | Supported? | How and proof |
|---|---|---|
| Before freeze | yes | abandon: discard the artifact, empty the org tables (allowed only while `authoritative` was never set) |
| During freeze, before activation | yes | flip the Auth marker back to `auth_authoritative`; the copy is discarded or reimported |
| After activation, **zero-write window** (organization-service active, no token ever registered, org digest equals the export digest) | **yes, provably** | set org inactive, unfreeze Auth; proof = digest equality and no registered tokens |
| After any write reached organization-service | **not supported without reconciliation (BD-3, deferred by ADR-0039)** | recommended stance: one-way door; forward-fix only; do not register tokens until Phase F passes |
| Old Auth code deployed after cutover | discouraged | it reads its stale local copy and cannot write (triggers); hierarchy-dependent decisions fail **closed** for anything new; names may be stale |
| Org service deployed but unavailable | n/a | see failure 15 |

"Point Auth back at its old tables" is **not** offered: after a single organization-service write, those tables are stale and un-synchronized.

## 19. Security model

- No HTTP route triggers or reports the migration; it is an operator-run command set. Nothing is exposed to users or service tokens.
- Migration data is business data (names, tax codes, addresses, phones), no credentials or user data. The artifact is permission-restricted (0600), checksummed, transferred over an operator-controlled channel, and deleted after Phase F. Logs carry counts, digests and ids, never row content.
- The importer uses a database role, not a service token; organization-service stays unreachable (no tokens) until Phase F passes.
- Auth calling organization-service after the switch uses the existing per-pair token (ADR-0033). **Token scope is O13/O14, unresolved:** every registered caller currently has full read and write on the hierarchy, so an Auth token could mutate it. This is documented, not solved here (BD-4).
- No client-supplied ownership is trusted: parents are validated by foreign keys and are immutable.
- Existing weakness to record: Auth's production app runs as the database superuser.

## 20. Observability

Structured JSON logs through the existing `JsonLogger`, no new metrics platform. Every line carries `migration_id` (uuid for the run), `correlation_id` (the kit's request context, or a generated id for CLI steps), `phase`, `state`, `outcome`. Machine-identifiable events: `migration_started`, `bootstrap_started`, `bootstrap_completed`, `bootstrap_failed`, `verification_started`, `verification_failed`, `verification_succeeded`, `freeze_started`, `freeze_failed`, `cutover_started`, `cutover_succeeded`, `cutover_failed`, `post_cutover_verification_failed`, `rollback_started`, `rollback_completed`. The durable record is a run table in organization-service's DB (state, timestamps, digests, counts, operator) mirrored by the Auth marker; the logs are the narrative, the tables are the truth.

## 21. Idempotency

| Command | Key/state | Rerun | Safe after cutover? |
|---|---|---|---|
| plan/preflight | run id | read-only | yes |
| export | run id, snapshot | produces a new artifact; never overwrites | yes (read-only) |
| import | manifest digest | compare-and-insert; identical skip, different abort | **no** (refuses once `authoritative`) |
| verify | run id | read-only | yes |
| freeze | state compare-and-set | second call no-op | n/a |
| activate | state compare-and-set | second call no-op | already done |
| rollback (zero-write) | requires the proof | refuses if proof fails | **no** |
| contract | explicit approval flag, separate release | not rerunnable | terminal |

Destructive operations are never implicitly rerunnable and require an explicit confirmation argument.

## 22. Test strategy

- **Unit:** row canonicalization and digests; importer mapping; mismatch detection (every column, NULL vs empty, timestamp microsecond); state machine (illegal transitions rejected); cutover guards (refuse when preconditions fail).
- **Integration (two real databases):** Auth DB (all 7 migrations) → export → organization DB import; full hierarchy including a platform with and without `key`; every dependent table's cross-check; membership preservation; FK removal/replacement in a scratch Auth database; import rerun safety.
- **Failure:** kill the importer mid-run; import twice; corrupt artifact; destination row differs; source change during export; write during freeze rejected; crash at each cutover step; organization-service down after cutover.
- **Database:** constraint and uniqueness equivalence (automated catalog diff); hierarchy integrity; migration rerun; trigger freeze fires for a superuser; lock behavior under concurrent writers.
- **Regression:** Auth login, refresh, logout, `/auth/me`, membership authorization, join, invitation flows (existing 230 e2e tests stay green, and the login/refresh tests are re-run with organization-service stopped); Billing and Payment suites unchanged.
- **Post-cutover:** organization-service authoritative; Auth cannot mutate the hierarchy; no cross-service FK remains (catalog assertion); ids stable (digest equality).

## 23. Open decisions and blockers

| ID | Decision | Type | Blocks |
|---|---|---|---|
| **BD-1** | Auth's reference model after cutover (R1/R2/R3), the `/auth/me` and `/onboarding/resolve` contract, the fate of Auth's tables, and the FK replacement of section 15. **Also requires amending ADR-0039's "Auth keeps a copy" language.** | architecture | everything after Phase B |
| **BD-2** | The cutover authority record (deferred by ADR-0039) | architecture | Phase E |
| **BD-3** | Ownership-rollback posture after the first organization write (deferred by ADR-0039) | architecture | production Phase E |
| **BD-4** | Who creates and administers Company/Platform/Organization after cutover, human authorization (F23) and the service-token scope for Auth and operators (O13/O14 stay open; document, do not invent) | architecture (+ business input) | Phase F opening for callers; the bootstrap-owner flow |
| **BD-5** | Lifecycle: deletion, archival and **id reuse** (the delete-and-reinsert finding), including the runtime role's `DELETE` grant | architecture / business | R2; safe post-cutover operation |
| BD-6 | Ratify the export-artifact import mechanism | architecture (small) | Phase B design |
| BD-7 | Production topology and gating: organization-service production DB, roles, pipeline; Auth production runs as superuser and auto-applies migrations, so Stage 10 Auth migrations must be inert and the switch/contract must be gated | operational | Phase A |
| BD-8 | Compatibility promises to external consumers of `/auth/me` and `/onboarding/resolve` (not verifiable from this repository) | business/architecture | BD-1 |

**Not blockers, remain deferred:** B-026/O-18, B-036. **Unknowable here and required as Phase A inputs:** production row counts, any `platform_non_working_day` rows, existing `key` values, and whether any environment holds data the local tests never saw.

## 24. Recommended next implementation stages

**Study result: BLOCKED BY ARCHITECTURE DECISION.** No partial migration code should be written until BD-1 to BD-5 are decided.

1. **Stage 10.0, decisions (ADR work, no code):** one ADR for BD-1/BD-2/BD-3 (Auth's reference model, authority record, rollback posture), amending ADR-0039's copy language; a minimal lifecycle decision for BD-5 (at least "ids are never reused"); BD-4's creation path and token approach; BD-6 and BD-7.
2. **Stage 10.1, foundations that change no ownership** (safe once 10.0 lands, several are safe earlier): organization-service production deployment, roles and pipeline (BD-7); the automated Auth-vs-organization catalog comparison as a CI test; the run table and the import/verify tooling.
3. **Stage 10.2, expand:** inert Auth migration (marker, dormant triggers, port with the local implementation, anchors if R2 with backfill) deployed and soaked.
4. **Stage 10.3, rehearsal:** the full A to F sequence against a restored copy of production data in a scratch environment, including failure injection.
5. **Stage 10.4, production migration:** A to F with the switch, the Phase F verification, then token registration.
6. **Stage 10.5, soak and contract:** after the soak, the gated irreversible removal of FKs, view and tables.

## Appendix: how the facts were obtained

Auth schema: migrations `apps/auth-service/db/migrations/0001` to `0007` applied to a scratch PostgreSQL 16; FKs from `pg_constraint` (with `confdeltype`/`confupdtype`), dependent objects from `pg_views`, `pg_proc`, `pg_trigger`, and the FK graph closure. Code paths by reading `apps/auth-service/src` (platform-access, membership, onboarding, invitation, auth, users, operator, cli). Cross-service references by reading Billing and Payment migrations and sources and the kit's `AuthClient`. Production posture from `deploy/provision-and-deploy.sh` and `docs/architecture/production-readiness.md`. No production system, real database or real environment was touched.

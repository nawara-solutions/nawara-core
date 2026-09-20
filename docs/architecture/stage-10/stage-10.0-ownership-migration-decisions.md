# Stage 10.0: ownership migration decisions

- **Status of this document:** decision study. It **proposes**; it decides nothing that an existing ADR has not already decided. Nothing here is implemented.
- **Date:** 2026-09-20
- **Baseline:** `main` at `6e7ddcc`. The Stage 10 study ([`../stage-10-organization-ownership-migration-study.md`](../stage-10-organization-ownership-migration-study.md)) is preserved unchanged; this document **refines** it where stated (sections 4 and 14).
- **Companion draft:** [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md), status **Proposed** when this study was written; **Accepted 2026-09-20** (see the update note below).
- **Status vocabulary:** `DECIDED` means an existing ADR in this repository already decides it (most ADRs here still carry the header status "Proposed" and the project owner treats them as governing; this document does not reopen that). `PROPOSED` is a recommendation awaiting approval. `BLOCKED` cannot be answered without input this repository does not contain. `DEFERRED` is postponed by an existing ADR and stays postponed.

## 1. Decision summary

> **Update (2026-09-20).** The table below is the study as first written and is kept as history. Since then: **BD-1** (R2c), **BD-2** (the freeze, verify, activate, retire model) and **BD-3** (the one-way door) are **adopted** as decisions 1 to 4 of [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md) (ADR-0040 Amendment 1); **BD-4** is **resolved** by [ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md) and its Amendment 1 together with ADR-0040 Amendment 1. **BD-5** interim invariants and **BD-6** (import) are **still Proposed** (ADR-0040 decisions 5 and 6); **BD-5** semantics, **BD-7** and **BD-8** are **still blocked**. Section 16's prerequisites for Stage 10.1 therefore still list ADR-0040 as Accepted and BD-7a to BD-7c as decided.

> **Update (2026-09-20, OPEN-1 and OPEN-2).** ADR-0040 is now **Accepted** (Amendment 2). **BD-5's interim invariants** and **BD-6** are accepted as its decisions 5 and 6 (I1 and both parts of I2, as migration invariants and not a lifecycle policy; BD-5 semantics stay undecided). **BD-7a to BD-7e** are accepted as production-readiness and cutover gates G1 to G7 (its decision 7), with a production-like rehearsal and explicit human approval before the real activation. **Section 16's prerequisites are met for *starting* Stage 10.1.** That is not production readiness: no gate is met, and no cutover is approved.

| ID | Decision | Status | One-line conclusion |
|---|---|---|---|
| BD-1 | Auth's reference model after cutover | **PROPOSED** (R2c) | Keep Auth's hierarchy tables as a **non-authoritative, validated reference cache**, filled only by a "first-touch" protocol from organization-service, never on login, refresh, session validation, `/auth/me` or onboarding |
| BD-2 | Cutover mechanism | **PROPOSED** | The study's freeze → verify → activate → retire model holds, with three refinements from repository facts |
| BD-3 | First write / one-way door | **PROPOSED** | Ownership rollback is supported **only** in a provable zero-write window; afterwards it is a one-way door and any return requires designed reconciliation |
| BD-4 | Company creation and token scope | **BLOCKED** | O-13/O-14 (no scope model) and F23 (no human authorization) decide it; cutover would remove today's only provisioning path without replacing it |
| BD-5 | Lifecycle and id reuse | semantics **BLOCKED**; interim guard **PROPOSED**; reparenting: no operation designed, anchors immutable (ADR-0024) | Migration removes the FK protection that stops deleting referenced entities, so an interim "no id reuse, no physical delete" invariant is needed before cutover |
| BD-6 | Export-file import | **PROPOSED** | Checksummed export artifact produced under a snapshot, then a file-based, compare-and-insert import |
| BD-7 | Production topology and gating | **BLOCKED** (owner decisions) | Organization-service has no production presence; Auth auto-deploys and auto-migrates on merge; backups have never been restored |
| BD-8 | External `/auth/me` consumers | **BLOCKED** (evidence) | Not verifiable from code; the contract must be treated as frozen until the owner obtains evidence |

Two findings in this document were **not** in the earlier study and change the design:

1. **The study's R2 has a first-touch hole.** Auth-owned relationship rows do not exist yet for a brand-new organization, so the very first administrative action on it (creating its first join code or invitation) has no local anchor to read. R2 must therefore include an explicit first-touch validation step (section 4.5). The variant proposed here, R2c, reuses Auth's existing tables for this.
2. **Migration removes an integrity guarantee, not only a copy.** Today `ON DELETE RESTRICT` plus never-deleted dependents (memberships, assignments) makes it impossible to delete an organization that anything in Auth references. After cutover the referencing rows live in other databases, so nothing prevents deletion. That is why BD-5 is a pre-cutover matter (section 8).

## 2. Current architecture

Facts, each verified in the repository (see the study for the schema and the full dependent-table inventory):

- Auth owns the three tables. Their only application writer is the bootstrap CLI's `INSERT INTO company` (`cli/owner-tools.ts:31`); no Auth HTTP route writes any of them.
- **Nine** FKs point at the hierarchy: two internal, **seven** from Auth-owned tables (`owner`, `operator`, `platform_assignment`, `platform_non_working_day`, `organization_membership`, `organization_join_code`, `organization_admin_invitation`).
- What Auth reads from the hierarchy falls into four kinds of fact:

| Fact | Meaning | Mutable in organization-service? |
|---|---|---|
| **F1** existence | "this id is a real company/platform/organization" | only by deletion (BD-5) |
| **F2** anchors | organization → platform, platform → company | **no**: immutable by trigger and by ADR-0024 |
| **F3** presentation | organization `name`; platform `name`, `key` | yes |
| **F4** lifecycle status | archived, disabled, suspended | **does not exist** (BD-5) |

- `login`, `refresh`, `logout` and the member access check read **none** of them.
- Every other service identifies a user by calling `GET /auth/me` **on every request**, uncached, and fails with 503 if it errors or lacks `memberships` (`libs/service-kit/src/service-auth/auth-client.ts:54-59`). In Billing and Payment only `id` and `isActive` are used.
- Auth's production app connects as the PostgreSQL superuser; a merge to `main` touching `apps/auth-service/**` builds and deploys Auth and **applies pending migrations automatically** (`auth-service-docker-build.yml`, `deploy/provision-and-deploy.sh`). Organization-service has no deploy workflow, no production database and no registered caller.

## 3. Decision principles

Already decided by existing ADRs, used as constraints here:

| Principle | Source | Status |
|---|---|---|
| Login and refresh never depend on another service; authentication is not entitlement | ADR-0026, ADR-0039 "Auth independence" | DECIDED |
| Ids are stable across the migration; no re-keying | ADR-0039 | DECIDED |
| One authoritative owner of Company/Platform/Organization: organization-service after cutover | ADR-0031, ADR-0039 | DECIDED |
| Auth keeps User, credentials, sessions, MFA, **OrganizationMembership** | ADR-0030, ADR-0031, ADR-0039 | DECIDED |
| Database per service; no cross-service FK | ADR-0032 | DECIDED |
| Service-to-service auth is a per-pair token, deny by default; end users are identified by asking Auth, not by local token verification | ADR-0033 | DECIDED |
| Anchors are immutable (trigger); reparenting has **no designed operation** ("a deliberate, audited migration, not an `UPDATE`") | ADR-0024 lines 161-163 | DECIDED (immutability); reparenting not designed |
| Cutover must not silently coincide with a code deployment | ADR-0039 | DECIDED |

Principles this document adds and asks the owner to confirm (all PROPOSED):

- **P-A.** The login/refresh rule extends to **every path other services use to validate a session**: `/auth/me` counts, because ADR-0033 makes it the session validator for the whole platform. It must not gain a synchronous dependency on organization-service.
- **P-B.** Auth never *writes* authoritative hierarchy data and never creates hierarchy entities on behalf of a client; any hierarchy row in Auth is a validated copy of what organization-service said.
- **P-C.** Any fact Auth trusts without asking organization-service must be immutable at the source (F2) or explicitly accepted as stale (F3). Anything mutable and security-relevant must be asked live.
- **P-D.** Irreversible steps are separate, gated, and never ride an automatic deploy.

## 4. BD-1: Auth's reference model after cutover

**Question:** after organization-service is authoritative, where does Auth get the information it needs for each operation?

### 4.1 The operations, traced to code

| # | Operation | Code | Hierarchy facts it needs |
|---|---|---|---|
| 1 | login, refresh, logout | `auth.service.ts` | none |
| 2 | identity part of `/auth/me` (`id, email, phone, adminTier, isActive, contactVerified`); **owners and operators get `memberships: []`** | `auth.service.ts:202-214` | none |
| 3 | `/auth/me` `memberships[]` (members only): per membership `organization {id,name}`, `platform {id,key,name}` | `membership.service.ts:59-72` | F2 (platform id), F3 (names, key) |
| 4 | member access check `GET /auth/organizations/:id/membership` | `platform-access.service.ts` `memberBelongsTo` | none (membership rows only) |
| 5 | `POST /auth/onboarding/resolve` (unauthenticated), invitation preview | `onboarding.service.ts:64-97`, `invitation.service.ts:80-113` | ids from the code row; F3 for display |
| 6 | register, join, invitation consume | `auth.service.ts:62,111`, `invitation.service.ts:141` | **ids only** (they share `lookup()`, whose hierarchy JOIN exists for `resolve`) |
| 7 | create join code / admin invitation | `onboarding.service.ts:129-147`, `invitation.service.ts:188-217` | F2 (authority), F1, F3 (`platform.key` cosmetic prefix) |
| 8 | list join codes / invitations / memberships by status; approve, reject, revoke, grant or revoke org admin | `authorize()` → `organizationAuthority` | **F2 only**, through `platformOfOrganization` (the queries themselves read no hierarchy table) |
| 9 | operator platform assignment: grant | `assignment.service.ts:45-47` | F1 + F2 (platform exists and belongs to the owner's company) |
| 10 | assignment revoke, history; operator creation | `assignment.service.ts`, `operator-admin.service.ts:24` | none new (owner's `companyId` is a local `owner` row) |
| 11 | `GET /auth/platform-access/:platformId`, `GET /auth/admin/organizations/:id` | `platform.controller.ts:31-50` | F1 + F2 (no consumer in this repository calls the first) |
| 12 | bootstrap owner | `cli/owner-tools.ts:30-31` | **a write** to `company` (BD-4) |
| 13 | `platform_non_working_day`, view `member_platform` | none | unused by any code |
| 14 | events (`user.registered`, `membership.*`) | `events/`, `membership.service.ts` | opaque `organizationId` only |

Two observations drive the options. First, **only operations 3, 5, 7, 9, 11 and 12 actually need a hierarchy fact**, and operations 3 and 5 sit on session-adjacent and pre-login paths. Second, F2 (anchors) covers operations 7 to 11, which are administration, and F2 is immutable.

### 4.2 The options

- **R1: live lookup, no Auth-side state.** Auth calls organization-service whenever it needs a fact.
- **R2: validated anchors kept in Auth.** Auth stores the immutable anchors (F2) locally, validated once against organization-service, and treats presentation (F3) separately. The study proposed this as "capture on Auth-owned relationship rows"; sections 4.5 and 4.6 refine it into R2c.
- **R3: event-fed projection.** Organization-service publishes hierarchy events; Auth consumes them into a local replica.
- **R4: keep Auth's tables as a frozen, never-updated copy.** Included only to record that it fails.

### 4.3 Where Auth gets each fact, per option

| # | Operation | R1 | R2c (proposed) | R3 |
|---|---|---|---|---|
| 1, 2, 4 | login, refresh, logout, identity, member check | none | none | none |
| 3 | `/auth/me` memberships | **sync call per request**, on the path every Billing/Payment call takes | local rows: exact ids and anchors, **names are a snapshot** | local replica |
| 5, 6 | resolve, register, join, consume | resolve needs a sync call (unauthenticated, pre-login); register/join/consume are ids-only | **local** (the code row and its cache rows already exist) | local |
| 7 | create join code / invitation | sync (authority, existence, key) | **first touch:** if the organization is cached, local; otherwise one bounded sync `ensure`, fail closed | local |
| 8 | authority for administration | sync per action | **local** (a relationship row exists, so the organization is cached) | local |
| 9 | assignment grant | sync per grant | first touch for a platform, else local | local |
| 10, 11 | history, operator creation, lookups | local or sync | local | local |
| 12 | bootstrap owner | needs the company created first (BD-4) | same; then `ensure company` | same |
| 14 | events | unchanged | unchanged | unchanged, **plus a new hierarchy event stream** |

### 4.4 The nine scenarios from the brief

| # | Scenario | R1 | R2c (proposed) | R3 |
|---|---|---|---|---|
| 1 | new organization created in organization-service | visible immediately, live | invisible to Auth until first touched; **first administrative action** on it does one validated `ensure` | arrives by event, with lag |
| 2 | organization renamed | live | `/auth/me` and resolve show the **old name** until refreshed (cosmetic; sub-decision 4.7) | eventual |
| 3 | platform metadata (`name`, `key`) changed | live | snapshot stale; a stale `key` only changes the cosmetic prefix of new join codes | eventual |
| 4 | company metadata changed | irrelevant: Auth reads a company only as an id | irrelevant | irrelevant |
| 5 | organization archived or disabled (if it ever exists) | must be checked live | **cache would not notice**; needs revalidation on administrative actions (DEFERRED until F4 exists, BD-5) | eventual |
| 6 | user added to a newly created organization | possible only if a code or invitation exists, which required admin first touch | same (**first touch already happened** when the admin created the code) | needs the replica row to have arrived first |
| 7 | invitation for a newly created organization | creation is the validation point | creation is the **first touch** | needs replica |
| 8 | operator assignment for a newly created platform | sync at grant | first touch at grant; the assignment row then carries `platformId` and `companyId` | needs replica |
| 9 | `/auth/me` needs metadata Auth no longer owns | sync (fragile) | local snapshot | local replica |

### 4.5 Why R2c, and what it precisely is

**R2c** keeps Auth's existing `company`, `platform` and `organization` tables, but their **meaning changes** at cutover: they become a non-authoritative reference cache with these rules:

1. **Single writer path.** Rows are inserted only by a `HierarchyReference.ensure(id)` operation that fetches the entity from organization-service (parents first) and inserts it. No client-supplied id is ever accepted without that fetch. A database guard rejects any other writer (flag-based, so mistakes and stale code are stopped; it is not adversary-proof, section 6.3 of the study).
2. **Anchors are immutable** (the existing triggers stay). A later fetch that disagrees on an anchor raises an alert and **fails closed**: it means an id was reused (BD-5) or the data was tampered with.
3. **No delete, no anchor change** in the cache.
4. **The seven FKs remain**, now intra-Auth and valid. Their value increases: **no relationship row (membership, code, invitation, assignment, owner, operator) can reference an id that was never validated against organization-service.**
5. **Presentation columns** (`name`, `key`) are snapshots; the other organization columns (`taxCode`, `address`, `phone`, `type`) are not read by Auth and are not refreshed.
6. Existing rows at cutover are exactly the imported, verified set.

This satisfies the constraints:

| Constraint | R2c |
|---|---|
| Login/refresh/session validation independent | yes: no path touches organization-service (P-A included: `/auth/me` is local) |
| No permanent cross-service FK | yes: every FK is inside Auth's database |
| No event replication or projection | yes: pull on first touch, no stream, no consumer |
| No duplicated *authoritative* data | yes: the cache is explicitly non-authoritative, anchors immutable, mismatches fail closed |
| Availability | organization-service down: everything works for cached entities; only first-touch flows fail closed (503) |
| No new Auth infrastructure | none beyond an HTTP client (R3 would need a broker consumer; RabbitMQ is not deployed to production, kit README) |
| Migration complexity | low: **no new columns, no dropped constraints, no new tables** for the seven dependents |

The study's earlier statement that the contract step drops the three tables **no longer applies under R2c**; the tables stay. This removes the largest irreversible step of the study's plan.

### 4.6 Evaluation against every requested criterion

| Criterion | R1 | R2c | R3 | R4 |
|---|---|---|---|---|
| OrganizationMembership | opaque id, live existence | opaque id, FK to validated cache | same as R2c | new organizations unusable |
| join codes / invitations | creation needs sync; consume local | first-touch creation; consume local | local | new organizations unusable |
| owner / operator / assignment | sync at grant | first touch at grant; rows keep `companyId`/`platformId` | local | new platforms unassignable |
| `platform_non_working_day` | unused | unused (FK stays; drop is optional later) | same | same |
| `/auth/me`, resolve | **operationally fragile** (P-A) | stable, stale-tolerant names | stable, eventual | stale |
| organization / platform / company metadata | live | snapshot (name, key), company none | replica | frozen |
| service availability | Auth admin *and* `/me` depend on org-service | only first-touch admin depends | broker + consumer must be up | none |
| consistency | strongest | strong for F1/F2, **weak for F3** | eventual, lag windows | broken |
| stale-data risk | none | **F3 names**; F1/F2 safe only if BD-5 holds | lag and lost-event risk | certain |
| database constraints | FKs must go (nothing local to reference) | FKs stay | FKs may stay | FKs stay but wrong |
| cross-service calls | many, some on hot paths | few, on cold admin paths | none synchronous | none |
| operational complexity | medium | low | high (broker, ordering, replay, backfill, dead letters) | none |
| migration complexity | high (drop FKs, rewrite six code paths) | low | high | none |
| rollback implications | Auth code rollback keeps working live | Auth code rollback keeps working (cache is local) | replica state to reconcile | n/a |
| security | Auth token can call org-service on hot paths | **residual risk RR-1** below | broker credentials, event trust | none |

**Residual risk RR-1 (interaction with O-13/O-14).** The kit's `ServiceTokenGuard` has no scopes (payment SDD O-14). Any token Auth is given to *read* organization-service can also *write* it. R2c minimizes how often Auth calls (first touch only) and Auth's code would only issue `GET`s, but a compromised Auth token could mutate the hierarchy. This is documented, not solved; it is resolved only by the scope decision (BD-4). It applies equally to R1 and R3 (event-publishing credentials).

### 4.7 Sub-decisions

| ID | Sub-decision | Status | Recommendation |
|---|---|---|---|
| BD-1a | Reference model | **PROPOSED** | R2c |
| BD-1b | `/auth/me` and resolve keep returning names and `key`, sourced from the snapshot; staleness accepted | **PROPOSED** | keep the contract unchanged. **This knowingly stores non-authoritative presentation data in Auth and needs the owner's explicit approval.** Revisit after BD-8: if no consumer needs names, drop them from the contract and from the cache |
| BD-1c | Snapshot refresh policy | **PROPOSED** | refresh on each `ensure` and on administrative touches, best effort, never on the request path of `/auth/me`, login or refresh |
| BD-1d | Revalidation on administrative actions | **DEFERRED** | needed only when F4 (lifecycle status) exists; belongs with BD-5 |
| BD-1e | Fallback if the owner rejects a stale-name snapshot | **PROPOSED** | R1 for `resolve` and `/auth/me` names only is **not** acceptable (P-A); the acceptable fallback is dropping names from the contract |
| BD-1f | R3 (projection) | **not recommended now** | would need reliable events in production, an Auth consumer, and its own ADR |

**Prerequisite:** R2c is safe only while ids are never reused and anchors never change. That is BD-5.

## 5. BD-2: cutover mechanism

**The study's model:** freeze Auth → verify frozen → activate organization-service → mark Auth retired. **Validated, with three refinements.**

### 5.1 What was verified

Experiments on a scratch PostgreSQL 16 with all Auth migrations applied:

| Behavior | Result |
|---|---|
| `LOCK TABLE company, platform, organization IN SHARE ROW EXCLUSIVE MODE` held | reads succeed; an insert that FK-checks against `organization` (registration/join analogue) **succeeds**; a referencing-row update succeeds; hierarchy `INSERT` and `UPDATE` **block** |
| Activation while a hierarchy writer is in flight | the lock **waits** (timed out at 1 s), then is acquired 36 ms after the writer commits |
| Trigger guard on the three tables | `INSERT`, `UPDATE`, `DELETE` and `TRUNCATE` are refused **even for a superuser** |
| Bypass | `SET session_replication_role = replica` defeats the guard (documented limit: a guard against mistakes and stale code, not a malicious administrator) |

So the freeze does **not** stop registrations, joins or logins, which is what ADR-0039 requires ("ordinary Auth operation is explicitly unaffected").

### 5.2 Facts that shape the sequence

- Auth deploys by **stopping the running container, renaming it, and starting the new one**, rolling back to the renamed container if the new one is not healthy (`provision-and-deploy.sh`). **There is no old/new overlap**, so a stale Auth process is unlikely; a rolled-back old container runs against the **already migrated** database, so expand migrations must be backward compatible.
- The app and the schema owner are the same superuser in production: role-based freeze is impossible; trigger-based works.
- A merge to `main` touching `apps/auth-service/**` migrates production automatically.

### 5.3 The model, with refinements

| Step | Action | Gate | Manual or automated |
|---|---|---|---|
| 0 | Expand (inert) merged and deployed, soaked | prior release | automated deploy, **manual go** |
| 1 | Verify (before freeze) | verification passes | automated check, manual go |
| 2 | Freeze Auth (lock, then marker) | lock acquired within the timeout | **manual** |
| 3 | Verify again under freeze | digests equal the export | automated gate |
| 4 | Activate organization-service, **no caller token registered** | run state and digest | **manual** |
| 5 | Post-activation verification | digest unchanged | automated gate |
| 6 | Register Auth's read token; switch Auth's hierarchy source (configuration, restart); mark Auth `org_authoritative` | health and readiness of both | **manual** |
| 7 | Open other callers (BD-4) | BD-4 decided | manual |

**Refinement 1: R2c changes what the marker means.** Under R2c the guard is not "nobody writes the tables" after cutover; it becomes "only the reference-cache protocol writes them, anchors immutable, no deletes". The freeze before cutover is total; the post-cutover guard is selective.

**Refinement 2: gated migrations are needed.** The auto-migrating deploy means any migration file merged to `main` runs in production. The freeze marker and guard are inert until activated, so they may ride a normal deploy; the switch is configuration, not code. Any **irreversible** migration (under R2c, only optional column or view cleanup) must not be merged until approved, or the deploy script needs a gated migration directory (BD-7).

**Refinement 3: the authority record.** PROPOSED: the record is organization-service's **own** state row, which organization-service enforces on itself (it refuses hierarchy writes unless `active`); the Auth marker mirrors it defensively. Auth's source switch is deploy-time configuration. Optionally Auth checks that organization-service reports `active` at first touch; this closes the case "Auth switched, organization-service not active" for the price of one extra field on a call that already happens.

### 5.4 Behaviors the brief asked about

| Aspect | Design |
|---|---|
| Old Auth process | none overlapping; a rolled-back old container sees the frozen or guarded tables, cannot write the hierarchy, and reads a still-correct cache |
| In-flight requests | activation waits for writers; registrations and joins proceed |
| Concurrent writes | blocked by the lock during activation and by the guard afterwards |
| Database permissions | trigger guard, not `REVOKE` |
| Health/readiness | gate on `/ready` of organization-service and `/auth/health` of Auth |
| Cutover detection | organization-service's state row (authoritative), Auth's marker (mirror), Auth's configuration (switch) |
| Verification | before freeze, under freeze, after activation |

**Status:** BD-2 **PROPOSED**. It depends on BD-1 (what the marker allows), BD-3 (rollback boundary) and BD-7 (gated migrations).

## 6. BD-3: first write and the one-way door

**Position (PROPOSED):** organization-service's first authoritative write closes the door. Ownership does not return to Auth automatically after it.

### 6.1 What counts as the first write

The first committed `INSERT`, `UPDATE` or `DELETE` on `company`, `platform` or `organization` in organization-service **after activation**. Idempotency rows are written in the same transaction as their resource, so they are never a first write on their own. Registering a caller token is treated as **opening** the door (writes become possible), so the zero-write proof requires that no token was ever registered.

### 6.2 Cases

| Case | Outcome |
|---|---|
| Write to Company, Platform or Organization | each request is one transaction: it is either fully in or fully out, so there is no "partial write" state |
| Zero-write window (active, no token ever registered, org digest equals the export digest) | **rollback is provably safe**: deactivate organization-service, unfreeze Auth |
| After any write | **not automatic**: organization-service now holds facts Auth never had (new rows, renames, possibly deletions) |
| Organization-service deployment rollback | database authority is unchanged; migrations are forward-only |
| Auth deployment rollback | works: the old container reads its local cache; hierarchy writes are blocked |
| Stale Auth deployment | same; new organizations are simply unknown to it and fail closed |
| Organization-service outage | R2c: cached entities keep working; first-touch flows fail closed |

### 6.3 If the owner ever wants ownership rollback after a write

It requires **designed reconciliation**, at minimum: freeze organization-service; export it; compare with Auth's cache; the difference is additive (new rows) plus possible renames plus possible deletions; deletions and renames need an explicit rule; Auth's cache is only a **subset** of organization-service, so Auth would have to be given every unseen entity before it could be authoritative; then re-verify and re-activate Auth. None of this is designed. **Recommended stance (PROPOSED): forward-fix only after the first write**, with the zero-write window as the sole supported rollback point. **Status: PROPOSED.** ADR-0039 defers exactly this; the owner must confirm the stance.

## 7. BD-4: who creates a Company after cutover, and the token scope

**Status: BLOCKED.**

### 7.1 Existing decisions and gaps

| Fact | Source |
|---|---|
| Only the bootstrap CLI creates a company, together with its owner, in Auth | ADR-0016, ADR-0022, `owner-tools.ts` |
| No route creates a platform or an organization; they appear only through direct database writes | ADR-0031, security review **F23 (open)** |
| Human owner/operator authorization for hierarchy management is **not designed** | ADR-0020's routes were never built |
| Multi-company support is "never actually exercised, an open question" | ADR-0022 |
| The kit's service-token guard **has no scopes**; which services may act for which organizations is unresolved | payment SDD **O-13, O-14**; **O-15** (hierarchy validation without user context) |
| Organization-service accepts only service tokens; currently none is registered | Stage 9 |

### 7.2 Candidate actors

| Actor | Fit | Problem |
|---|---|---|
| Operator running the bootstrap CLI in Auth | today's path | Auth would need **write** access to organization-service; with no scopes that is full write for any Auth compromise (RR-1) |
| Operator running an organization-service provisioning command, then passing the id to Auth's CLI (`BOOTSTRAP_COMPANY_ID`, validated by an `ensure`) | Auth needs **read** only in principle | needs a provisioning identity for organization-service; still no scope model to restrict it |
| A platform owner creating companies | multi-company is undecided | contradicts "one owner per company, exactly one company in practice" |
| Another Core service or a provisioning workflow | not designed | needs O-13/O-14 |

### 7.3 The consequence that matters

**Cutover would remove today's only way to create platforms and organizations (direct SQL in Auth) without replacing it.** After the guard is on, ad-hoc SQL in Auth cannot create them, and organization-service accepts no caller until tokens are registered. Unless BD-4 is decided, production would have **no way to create a new platform or organization** after cutover except by an operator registering a broad token by hand.

### 7.4 Conclusion

BD-4 is **BLOCKED** on O-13/O-14 and F23; this document does **not** invent scopes. What can be stated now (**PROPOSED constraints**, not a choice): (1) whichever path is chosen must not give Auth write access beyond what O-13/O-14 permit; (2) Stage 10 *migration* (moving existing data) does not need BD-4; only **opening callers** and **creating new hierarchy** do, so BD-4 blocks step 7 of section 5.3 and any post-cutover provisioning, not the import.

## 8. BD-5: lifecycle and id reuse

**Status:** lifecycle semantics **BLOCKED** (needs a business decision); reparenting has **no designed operation** (anchors immutable, ADR-0024); an interim guard **PROPOSED**.

### 8.1 What existing ADRs actually specify

| Question | Specified? | Source |
|---|---|---|
| Reassign an organization to another platform, or a platform to another company | **No operation is designed**; anchors are immutable by trigger; it "would be a deliberate, audited migration, not an `UPDATE`" | ADR-0024 lines 161-163; triggers |
| Delete a company, platform or organization | **No.** Only `ON DELETE RESTRICT` on the FKs | ADR-0024 lines 153-154; ADR-0020 lists organization deletion/deactivation as **out of scope, undesigned** |
| Archive, deactivate, suspend | **No** | ADR-0020; ADR-0039 defers "archive/deactivate rules, suspension" |
| Reuse of an id | **No** | nothing decides it |
| Dependents' deletion | **Decided the other way:** memberships, assignments, join codes are never deleted (history is the audit anchor) | ADR-0030 line 53, ADR-0022 lines 154-157, ADR-0024 |

### 8.2 Why the migration makes this urgent

In Auth today the combination "`RESTRICT` FK plus never-deleted dependents" means **an organization referenced by any membership, code, invitation or assignment cannot be deleted**. Only an organization nothing references can be. After cutover:

- Auth's rows reference the organization only by opaque id; organization-service **cannot see them**, so nothing prevents deleting an organization that hundreds of memberships reference.
- Billing's `invoice.organizationId`, Payment's `payment.organizationId` and their snapshots, and Auth's events also reference it, again with no FK.

The Stage 9 audit showed that organization-service's runtime role can delete a leaf organization and re-insert the **same id under another platform** (the immutability trigger guards `UPDATE` only). The chain of harm:

```
DELETE organization X            (nothing in org-service knows Auth/Billing/Payment reference X)
INSERT organization X under platform B (a different company)
  → Auth memberships of X now belong to an organization of another platform:
      users appear inside a tenant they never joined;
  → an owner of company A keeps cached authority over X (R2c anchors are cached) while X now sits in company B;
  → Billing/Payment history for X is now attributed to a different platform and company.
```

Cross-tenant misattribution from a single administrative mistake, undetectable without an anchor comparison. R2c's mismatch alarm (section 4.5, rule 2) is a **detector**, not a preventer.

### 8.3 Proposal (PROPOSED, requires owner approval; **not a lifecycle policy**)

The narrowest guard that makes the migration safe without deciding lifecycle semantics:

- **I1.** A hierarchy id is **never reused**.
- **I2.** No runtime path physically deletes a company, platform or organization until a lifecycle ADR exists.

Enforcement design (revoking `DELETE` from the runtime role, a delete guard) belongs to Stage 10.1 **after** approval; the choice between them is not made here. Archive, deactivate, suspend and deletion **semantics** remain **BLOCKED**, and R2c's revalidation on administrative actions (BD-1d) stays **DEFERRED** until they exist.

## 9. BD-6: export-file import

**Status: PROPOSED** (needs the owner's approval).

### 9.1 Alternatives

| Option | Security | Reproducibility | Audit | Consistency | Ops in production | Verdict |
|---|---|---|---|---|---|---|
| Direct read of Auth's DB by organization-service or a tool | needs Auth credentials and network reach in another environment; Auth's DB publishes no port; normalizes cross-DB access | replays against live data | weak | needs one snapshot | high risk | **reject** |
| Auth HTTP export API | adds a new endpoint exposing the whole hierarchy with no scope model | depends on pagination consistency | medium | weak unless snapshotted | new Auth surface | **reject** |
| `postgres_fdw` / `dblink` | cross-database credentials inside the database | live | weak | fine | extension privileges | **reject** |
| One-shot logical replication | cross-database credentials, subscription state | continuous | medium | fine | heavy for three small tables | **reject** |
| `pg_dump` of the three tables | version-sensitive: the production-readiness drill **failed** restoring a dump made by a newer client (`transaction_timeout`); dump is not canonical text for digesting | file | good | snapshot | must run inside the container | **use only for backup** |
| **Checksummed canonical export from a read-only snapshot, file-based import** | no cross-DB credential; artifact permissions and checksum | deterministic, re-verifiable offline | manifest, digests, run record | single `REPEATABLE READ` snapshot | run with the server container's own client where Auth's DB is reachable | **recommended** |

### 9.2 Behavior of the recommended model

- **Rerun:** the import is compare-and-insert: identical rows skip, differing rows abort, extra destination rows abort; never `UPDATE`.
- **Partial failure:** one transaction; nothing to clean up.
- **Checksums:** per-table and whole-artifact sha256 in a manifest that also records Auth's migration checksums, so the artifact cannot be applied against an unexpected schema.
- **Large datasets:** the three tables are bounded by the number of companies, platforms and organizations, expected to be small. Implementation should stream. A single transaction is comfortable to roughly 10^5 rows; beyond that use a staging table and one final transactional apply. The volume in production is **unknown** and is a Phase A input.
- **Operational simplicity:** two commands, both rerunnable, no standing credentials.

**Status: PROPOSED.** ADR-0039 does not choose an import mechanism.

## 10. BD-7: production topology and gating

**Status: BLOCKED.** Facts first, then the split between decisions and implementation.

### 10.1 What exists today, verified

| Item | State |
|---|---|
| Deployment workflow for organization-service | **none** (only `auth-service-deploy.yml` and `auth-service-docker-build.yml`) |
| Production database for organization-service | **none**; Auth runs its own dedicated PostgreSQL container with one superuser; ADR-0032's shared-server target is unimplemented |
| Database roles in production | **NEEDS IMPLEMENTATION** for every service (`production-readiness.md` §2 target, §5 status table); local roles exist (`infra/postgres`) |
| Secrets | Auth's script generates env files on the server (mode 600), nothing in GitHub; nothing exists for organization-service |
| Network | Auth reaches Payment by container DNS name on a shared Docker network; Traefik routes `/auth` only |
| Health/readiness | implemented in the service (`/health`, `/ready`); Auth has `/auth/health` |
| Service-token callers | none registered; distribution is manual (ADR-0033 consequence) |
| Monitoring and alerting | **none documented for any service** |
| Logging | JSON to stdout; retention unspecified |
| Backup and restore | **no backup job; a restore has never been drilled on the real volume: BLOCKER** per `production-readiness.md` §5; RPO/RTO **NEEDS DECISION** |
| Migration execution for organization-service | explicit runner exists (`npm run migrate`); no production procedure |
| Deployment rollback | Auth: rename-and-restart; organization-service: none |
| Auto-deploy of Auth | **any merge touching `apps/auth-service/**` deploys and migrates production** |

### 10.2 Architecture decisions (owner input required)

| ID | Decision | Status |
|---|---|---|
| BD-7a | Where organization-service and its database run (own container on the existing host, or the ADR-0032 shared server) and how it is exposed (internal only, or via Traefik at `/organization`). Recommendation: internal only initially, because its only callers are Core services | PROPOSED |
| BD-7b | A gated-migration mechanism, so an irreversible Auth migration is never applied by an automatic deploy (for example, migrations outside the deploy directory until approved) | PROPOSED |
| BD-7c | Least-privilege roles from day one for organization-service (it is new, no legacy), independent of fixing Auth's superuser posture | PROPOSED |
| BD-7d | The minimum monitoring and log retention required before cutover | BLOCKED |
| BD-7e | RPO/RTO and backup policy | BLOCKED (already "NEEDS DECISION") |

### 10.3 Stage 10.1 implementation (after the decisions)

Deployment workflow and image publishing, provisioning script and roles, server-side secrets, network and DNS, token registration procedure, backup job and off-host copy, a **restore drill on the real volume**, migration runbook, health-check hookup, the gated-migration mechanism. **None is built in this stage.**

## 11. BD-8: external consumers of `/auth/me`

**Status: BLOCKED (evidence).** This cannot be settled from code.

### 11.1 What was verified

| Question | Finding |
|---|---|
| What `/auth/me` returns today | `id, email, phone, adminTier, isActive, contactVerified, contactVerificationRequired, memberships[]` (`auth.service.ts:202-214`); per membership `id`, `organization {id,name}`, `platform {id,key,name}`, `status`, `audience`, `isOrganizationAdmin` |
| Which fields depend on the hierarchy | only `memberships[].organization.name` and `memberships[].platform.{id,key,name}`; owners and operators receive `memberships: []` |
| Consumers in this repository | Billing and Payment via the kit's `AuthClient`: they read `id` and `isActive`; the kit's declared contract lists only `organization.id`, `platform.id`, `status`, `isOrganizationAdmin`, **not names or `key`**; nobody reads `memberships` or `adminTier`; nobody calls `hasPlatformAccess` |
| Repository documents that disagree | Billing SDD R-11 says `/auth/me` "returns only the organization `id`", which is **not what the code returns** (a stale statement, no impact on Billing) |
| Local checkout of `nawara-drive` (`main`, `291df47`, read-only search) | **no reference** to `/auth/me`, `/auth/login`, `/auth/refresh`, `/auth/onboarding/*`, `AUTH_SERVICE` or the production host, in code, docs or config |
| Local checkout of `daycare` | **does not exist** on this machine; `CLAUDE.md` says it has its own local auth service |

### 11.2 What is not verifiable, and why it matters

Deployed builds and mobile apps, unmerged branches and other repositories, third-party or admin tooling, and anything not checked out here. The local absence of references is **weak evidence** and proves nothing about production clients.

It matters because BD-1b (names and `key` in `/auth/me` and resolve, possibly stale) and any decision to drop them depend on whether a consumer renders them.

### 11.3 Evidence the owner must obtain

1. Traefik access logs for `GET /auth/me` and `POST /auth/onboarding/resolve` over a representative window, grouped by client (user agent, application key).
2. For each client identified, the owning team's confirmation of which response fields it reads (`organization.name`, `platform.key`, `platform.name`).
3. Contract or e2e tests in client repositories that pin the response shape.
4. A decision on whether new consumers may rely on the current shape.

**Interim rule (PROPOSED):** treat the `/auth/me` and resolve response shapes as **frozen**: no removals, no new hierarchy dependency, until this evidence exists.

## 12. Recommended decisions

| ID | Recommended decision | Status | Approval needed from |
|---|---|---|---|
| BD-1a | R2c: validated reference cache with a first-touch protocol | PROPOSED | architecture owner |
| BD-1b | Keep names and `key` in `/auth/me` and resolve as a documented snapshot | PROPOSED | architecture owner (stores non-authoritative data in Auth) |
| BD-1c | Snapshot refreshed off the hot path | PROPOSED | architecture owner |
| BD-2 | Freeze, verify, activate (no tokens), verify, switch, open; authority record in organization-service, Auth marker as mirror, manual gates for every visible transition | PROPOSED | architecture owner |
| BD-3 | One-way door after the first write; zero-write window is the only supported rollback | PROPOSED | architecture owner |
| BD-4 | (no recommendation beyond constraints) | **BLOCKED** | owner, after O-13/O-14 and F23 |
| BD-5 | I1 "ids never reused" and I2 "no runtime physical delete" as an interim guard | PROPOSED | architecture owner and business (lifecycle) |
| BD-6 | Checksummed export artifact, file-based compare-and-insert import | PROPOSED | architecture owner |
| BD-7 | Decisions BD-7a to BD-7e, then 10.1 | **BLOCKED** | owner (topology, monitoring, RPO/RTO) |
| BD-8 | Treat `/auth/me` and resolve as frozen; obtain consumer evidence | **BLOCKED** | owner (evidence) |

## 13. Explicit unresolved decisions

- **BLOCKED:** BD-4 (company creation, O-13/O-14 scope model, F23 human authorization); BD-5 lifecycle semantics (deletion, archive, deactivate, suspend); BD-7d monitoring, BD-7e RPO/RTO; BD-8 consumer evidence.
- **DEFERRED by existing ADRs:** ownership-rollback reconciliation procedure (ADR-0039; this document only states the one-way-door stance); organization lifecycle semantics (ADR-0039); B-026/O-18 (organization-payer authority); B-036 (platform currency administration).
- **Not decided here, and not to be inferred:** service-token scopes (O-13/O-14/O-15); F4 lifecycle status; whether Auth's superuser posture is fixed before or independently of Stage 10.

## 14. Consequences

- **The study is refined, not replaced.** Its R2 becomes R2c (section 4.5); the irreversible "drop the three tables" step disappears under R2c; the freeze becomes selective after cutover (section 5.3). Its migration mechanics (export, import, verification, freeze proof, single-writer ordering, zero-write rollback) stand.
- **ADR-0039 is partly superseded, not wholly.** Its mechanism (phases A to E, stable ids, freeze, verification) is retained. On acceptance of ADR-0040 these passages are replaced or made precise (quoted exactly in ADR-0040): "it holds `organizationId` (on `OrganizationMembership`) as an opaque reference, the same way Billing and Payment do today" (Auth also keeps the validated cache); Phase D's "Auth for its own reference needs"; "a copy Auth still holds for its own membership joins" and "No Auth-side organization projection or replica is required" (made precise by R2c); the deferred cutover-detection mechanism; and the failure-handling row about Auth's hierarchy-mutating endpoints, which have never existed. "No new synchronous dependency is introduced on Auth's authentication path" stays true. The README defines no "amended" status, so the record follows the ADR-0001/ADR-0010 precedent ("partly superseded by"): a status note, links both ways, and a forward note in ADR-0039, whose text is not edited. Until acceptance ADR-0039 carries no pointer to ADR-0040.
- **Auth code will change in Stage 10.2** (not now): a `HierarchyReference` service with `ensure`, first-touch calls in the six administrative paths, a cache-write guard, and removal of the hierarchy JOIN from the shared `lookup()` used by register, join and consume.
- **A residual security risk (RR-1)** is accepted and documented until the scope decision exists.
- **The freeze and guard survive as permanent code**, not one-time tooling.

## 15. Required follow-up ADRs

| ADR | Content | Status |
|---|---|---|
| **ADR-0040** (drafted, Proposed) | BD-1, BD-2, BD-3, BD-6 and the interim BD-5 invariants; amends ADR-0039 | awaiting owner approval *(accepted 2026-09-20)* |
| Lifecycle ADR | deletion, archive, deactivate, suspend, id reuse (BD-5 semantics) | not drafted; needs business input |
| Producer/service-token scopes and hierarchy validation ADR | O-13, O-14, O-15; BD-4 | not drafted; already anticipated by the payment SDD |
| Production topology and gating ADR | BD-7a to BD-7e | not drafted |

## 16. Stage 10.1 prerequisites

Stage 10.1 (foundations that change no ownership) may start only when:

1. **ADR-0040 is Accepted** (BD-1, BD-2, BD-3, BD-6 and the interim BD-5 invariants approved).
2. **BD-7a, BD-7b and BD-7c are decided** (topology and exposure, gated migrations, least-privilege roles for organization-service).
3. BD-7d and BD-7e are decided, or the owner explicitly accepts proceeding to a **rehearsal** without them; **production Phase A cannot proceed without a restore drilled on the real volume**.
4. BD-8 evidence is obtained **before** any change to the `/auth/me` or resolve contract; until then those shapes stay frozen.
5. BD-4 is **not** required to start 10.1 or to migrate existing data; it is required before opening callers and before production cutover completes.
6. BD-5 semantics are **not** required for 10.1, but the interim invariants I1 and I2 must be approved before Auth's cache is trusted.

Candidate 10.1 work items once those hold: organization-service production deployment and roles, the automated Auth-versus-organization catalog comparison as a CI test, the run table and the import/verify tooling, a gated-migration mechanism, the Auth reference cache design (10.2), and a restored-copy rehearsal (10.3).

# 0040. Organization ownership migration: Auth's reference model, cutover mechanism, one-way door and import

- **Status:** Accepted <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X --> (**accepted** by the architecture owner on 2026-09-20: decisions 1 to 4 (DEC-4, Amendment 1); decisions 5 and 6, and the added **decision 7**, the production-readiness and cutover gates (OPEN-1 and OPEN-2, Amendment 2). Acceptance is architecture only: **nothing is implemented, no rehearsal has run, and no production gate is met.**)
- **Date:** 2026-09-20
- **Deciders:** Anwar (project owner). Decisions 5, 6 and 7 were accepted on 2026-09-20. The interim invariants I1 and I2 are accepted as **migration invariants, not as a lifecycle policy**, so they need no separate lifecycle decision.

> **Adoption record (2026-09-20).** Decisions 1 to 4 were adopted in Amendment 1; decisions 5 and 6 and the added decision 7 were accepted in Amendment 2; the ADR is **Accepted**. The original text below is kept unchanged for the historical record and still says "Proposed" in its own wording; where an amendment differs, **the amendment governs, and Amendment 2 governs over Amendment 1**.

> **Partly supersedes [ADR-0039](./0039-organization-ownership-and-cross-service-migration-authority.md)** (in effect: ADR-0040 is Accepted, 2026-09-20), on the passages listed under "Amendments to ADR-0039" only; the rest of ADR-0039 (phases, stable ids, verification, freeze, single cutover point) stands. Because the ADR README defines no "amended" status, the record on acceptance follows the repository's precedent for partial replacement (ADR-0001, ADR-0010): ADR-0039's status becomes "partly superseded by ADR-0040", the two ADRs link to each other, and a forward note is added to ADR-0039. ADR-0039 is **not edited** by this draft (**update 2026-09-20:** for decisions 1 to 4, adopted on that date, it now carries the forward note and its status reads partly superseded; see Amendment 1). The analysis behind every choice below is in the [Stage 10.0 decision study](../architecture/stage-10/stage-10.0-ownership-migration-decisions.md) and the [Stage 10 study](../architecture/stage-10-organization-ownership-migration-study.md).

## Context

ADR-0039 chose a bounded transition (import, verify, freeze, cutover) and left three things open that decide whether the end state works: cutover detection, ownership rollback, and what Auth does with hierarchy facts afterwards. It says that after cutover Auth holds `organizationId` "as an opaque reference, the same way Billing and Payment do today", that "a copy Auth still holds for its own membership joins" remains, and that "No Auth-side organization projection or replica is required". The Stage 10 study found that this cannot hold as written:

- Seven Auth-owned tables have foreign keys into `company`, `platform` and `organization`, and Auth's administration, `/auth/me`, onboarding and operator assignment read the hierarchy locally.
- A copy that is not maintained goes wrong the moment organization-service creates or renames anything: a new organization could never receive a membership, join code, invitation or assignment.
- `GET /auth/me` is called by Billing and Payment on **every** user request (ADR-0033), so a synchronous dependency of `/auth/me` on organization-service would put its availability on every user call.
- Once organization-service owns the hierarchy, the rows that reference it (Auth's, and Billing's and Payment's ids) are outside organization-service's database, so the `ON DELETE RESTRICT` protection that today prevents deleting a referenced organization disappears from organization-service's point of view.

## Options considered

**A. Auth's reference model after cutover** (the decision that matters most)

1. **R1, live lookup, no Auth-side state.** Strongest consistency; makes `/auth/me` and the unauthenticated onboarding resolution depend on organization-service, and forces the seven foreign keys out. Rejected for those paths.
2. **R2c, a validated, non-authoritative reference cache.** Auth keeps its three tables as a cache filled only by a "first-touch" fetch from organization-service; anchors immutable; foreign keys stay (now intra-Auth). Proposed.
3. **R3, an event-fed projection.** Local and fast; needs reliable events in production (RabbitMQ is not deployed there), a new consumer in Auth, ordering and backfill, and was explicitly not chosen by ADR-0039. Not recommended now.
4. **R4, keep the tables as a frozen, never-updated copy.** Fails: new organizations become unusable.

**B. Ownership rollback after the first organization-service write**
1. *Automatic rollback.* Rejected: once organization-service holds rows, renames or deletions Auth never saw, Auth's tables are a stale subset and cannot be proven authoritative again.
2. *Forward-fix only, with a provable zero-write window as the sole rollback point.* Proposed: the only case that can be proven safe.
3. *Designed reconciliation.* Not designed; ADR-0039 defers it. Possible later, and needs its own decision.

**C. Import mechanism**
1. *Direct read of Auth's database.* Rejected: needs Auth credentials and network reach elsewhere (Auth's production database publishes no port) and normalizes cross-database access (ADR-0032).
2. *Auth export API.* Rejected: a new endpoint exposing the whole hierarchy with no scope model (O-13/O-14 open).
3. *`postgres_fdw` / `dblink`, one-shot logical replication.* Rejected: cross-database credentials and standing state, heavy for three small tables.
4. *`pg_dump` of the three tables.* Rejected as the transfer format: version-sensitive (the production-readiness drill failed restoring a dump from a newer client) and not canonical text for digesting. It remains the backup tool.
5. *Checksummed canonical export from one read-only snapshot, then a file-based import.* Proposed: no cross-database credential, deterministic, verifiable offline, rerunnable.

## Decision (proposed)

1. **Reference model: R2c.** After cutover, Auth's `company`, `platform` and `organization` tables are a **non-authoritative reference cache** with these rules: rows are inserted only by an `ensure(id)` operation that fetches the entity from organization-service, parents first, and never from a client-supplied id; anchors (organization → platform, platform → company) are immutable, and a later fetch that disagrees on an anchor **fails closed and alerts**; no row is deleted; the seven foreign keys from Auth-owned tables (`organization_membership`, `organization_join_code`, `organization_admin_invitation`, `platform_assignment`, `owner`, `operator`, and the unused `platform_non_working_day`) remain and now guarantee that no such row references an id never validated against organization-service; presentation columns (`name`, `key`) are snapshots refreshed off the request path of login, refresh and `/auth/me`.
2. **No synchronous dependency on the session-validation paths.** Login, refresh, logout, session/token validation, `GET /auth/me`, the member access check and onboarding resolution/registration/join/consume never call organization-service. Only first-touch administrative flows (first join code or invitation for an organization, first assignment on a platform, and the bootstrap flow if the company-creation decision below so provides) may, bounded and fail closed. This is consistent with ADR-0039's "no new synchronous dependency … on Auth's authentication path", which stays true.
3. **Cutover sequence:** freeze Auth's hierarchy tables, verify under the freeze, activate organization-service with **no caller token registered**, verify again, register Auth's token and switch Auth's hierarchy source by **configuration** (never by a code deploy), then open other callers (this last step is gated by the undecided company-creation and token-scope question below). The authoritative record is organization-service's own state row, enforced by organization-service; Auth's marker mirrors it. Every visible transition is a manual gate; every verification is an automated gate.
4. **One-way door:** the first committed hierarchy write in organization-service after activation ends automatic rollback. The only supported rollback point is the **zero-write window** (active, no caller token ever registered, organization-service digest equal to the export digest). Afterwards, ownership returns to Auth only through a separately designed reconciliation.
5. **Import:** a checksummed canonical export produced under one read-only snapshot, and a file-based, all-or-nothing, compare-and-insert import that never overwrites and aborts on any difference. Organization-service never holds Auth's database credentials.
6. **Interim invariants** (not a lifecycle policy): **I1** a hierarchy id is never reused; **I2** no runtime path physically deletes a company, platform or organization until a lifecycle ADR exists. The enforcement mechanism is chosen after this ADR is accepted.

## Not decided here

- ~~**Who creates a Company after cutover and with what token scope**~~ **Decided** by D1 and AD-4 (a dedicated non-human provisioning identity in organization-service, with a one-time controlled bootstrap for the first Company) and recorded in [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md) and Amendment 1 below. The original text was: "needs O-13, O-14, O-15 and the human-authorization gap F23. Cutover would remove today's only provisioning path (direct SQL in Auth); this must be decided before production cutover completes."
- **Lifecycle semantics:** deletion, archive, deactivate, suspend (a business decision; ADR-0024 designs no reparenting operation and makes anchors immutable).
- ~~**Production topology and gating:**~~ **Decided as gates** by decision 7 (Amendment 2): the requirements are fixed; the concrete topology is a gated Stage 10.1 deliverable. Original text: where organization-service runs, exposure, gated migrations, least-privilege roles, monitoring, RPO/RTO, backup and a restore drilled on the real volume.
- **External consumers of `/auth/me` and `/auth/onboarding/resolve`:** not verifiable from this repository; the response shapes stay frozen until the owner obtains evidence.
- B-026/O-18 and B-036, unchanged.

## Consequences

- **Easier:** no new constraints on the seven dependent tables and none dropped, no irreversible table drop in this ADR's plan (this supersedes the contract step in the Stage 10 study), `/auth/me` and registration keep working with organization-service down, and the migration reuses ADR-0039's mechanism.
- **Harder or given up:** Auth stores a **non-authoritative copy of presentation data** (names, `key`) that can be stale after a rename; administrative first-touch flows depend on organization-service; the cache-write guard and a `HierarchyReference` service become permanent Auth code; correctness relies on I1 and on anchors never changing.
- **Residual risk (RR-1):** the kit's service-token guard has no scopes, so any token Auth holds to *read* organization-service can also write it. Documented, not solved; resolved only by the scope decision.
- **Follow-up work:** the ADRs listed in the Stage 10.0 study (lifecycle; producer service-token scopes and hierarchy validation; production topology and gating: **now decision 7 of this ADR, with the concrete topology recorded at gate G1**); Stage 10.1 foundations; Auth changes in Stage 10.2 (`ensure`, first-touch calls in six administrative paths, the cache-write guard, removing the hierarchy JOIN from the shared `lookup()`).

## Amendments to ADR-0039 (applied for decisions 1 to 4, adopted 2026-09-20)

The passages below are replaced by decisions 1 to 4, which are adopted. ADR-0039 carries a forward note to that effect (its status is "partly superseded by ADR-0040", following the precedent described above). Decisions 5 and 6 replace no ADR-0039 passage.

Quotations are exact.

- **"Ownership boundaries" / "Auth's relationship to the hierarchy after cutover"**: "it holds `organizationId` (on `OrganizationMembership`) as an opaque reference, the same way Billing and Payment do today". Under decision 1 Auth's **membership** still stores an opaque `organizationId`, but Auth **also keeps the hierarchy tables as a validated reference cache** with intra-Auth foreign keys, which Billing and Payment do not. This passage is replaced by decision 1.
- **Phase D, "Cutover"**: "organization-service's copy is the one every service (including, from then on, Auth for its own reference needs) treats as the real `Company`/`Platform`/`Organization` record". Under decision 1 Auth uses its own validated cache for its reference needs and consults organization-service only on first touch. This passage is replaced by decision 1.
- **"Auth independence" (the paragraph containing "a copy Auth still holds for its own membership joins") and the heading "No Auth-side organization projection or replica is required"**: made precise by decision 1: a validated, non-authoritative reference cache with a defined population protocol, not a synchronized replica. Still no projection or event stream.
- **"Consequences" (Good)**: "no new synchronous dependency is introduced on Auth's authentication path" remains true; decision 2 records that first-touch administrative calls are not on that path.
- The deferred cutover-detection mechanism is filled by decision 3.
- The deferred ownership-rollback posture is filled by decision 4 (one-way door; reconciliation not designed).
- The failure-handling row about Auth's hierarchy-mutating endpoints is moot: no such endpoints have ever existed (see the factual correction already in ADR-0039).
- Its phase list stays; the study's mapping (preflight, bootstrap, verification, freeze, cutover, post-cutover verification) refines it.

## Amendment 1 (2026-09-20): adopted decisions, fresh-environment sequence, provisioning and consumers

- **Status of the amendment:** recorded from the architecture owner's written direction of 2026-09-20 on DEC-4 (and DEC-3, DEC-5 where they touch cutover). The original decisions above are kept; this amendment governs where it differs.

### A1.1 Adoption record

| Decision | After Amendment 1 |
|---|---|
| 1 Reference model R2c | **Adopted**, with A1.2 |
| 2 No synchronous dependency on the authentication paths | **Adopted**; the bootstrap flow is now provided for (A1.2) |
| 3 Cutover sequence | **Adopted as amended** (A1.3) |
| 4 One-way door | **Adopted**; the rule is restated in A1.4 |
| 5 Import mechanism | **Adopted by Amendment 2** (A2.2) |
| 6 Interim invariants I1 and I2 | **Adopted by Amendment 2** as migration invariants, not a lifecycle policy (A2.3) |

**What remained unresolved when Amendment 1 was written** was the owner's decision on decisions 5 and 6 and on the production gates. Amendment 2 resolves them. What Amendment 2 leaves undecided is listed in A2.8.

### A1.2 Amended decisions 1 and 2

- **Auth is not a second authority.** After Organization Service becomes authoritative it is the only authority for Company, Platform and Organization and their lifecycle and metadata. Auth owns User, credentials, sessions, MFA, recovery and membership, and keeps `company`, `platform` and `organization` only as the **non-authoritative validated reference cache** of decision 1, required by Auth-owned relationships and workflows. Descriptive fields (`name`, `key`) may be stale.
- **Company is included.** `ensure(id)` covers the Company (parents first). **Auth never creates a Company**: the direct Company insert of `bootstrap-owner` is removed in the authoritative mode (AD-4). The Auth `owner.companyId` row is a reference row placed by a validated `ensure(companyId)`.
- **Auth's credential** for `ensure` is a service credential with the full-read capability and an explicit Platform scope (ADR-0042 Amendment 1, A.3 and A.5). Reading a Company is not Platform-scoped.
- **The bootstrap flow** is an administrative first-touch flow (decision 2, condition met): bounded and fail closed, off the authentication path. The deliberate administrative dependency **Client, then Auth bearer authentication, then Organization Service authorization** is not an authentication-path dependency. Login, refresh, logout, session validation, `GET /auth/me`, registration, join, onboarding and ordinary authentication operations still never call Organization Service.

### A1.3 Amended decision 3: two environment classes

The freeze, verify, activate and retire model is preserved. **There is one moment at which authority transfers: the activation.**

**Existing environment** (Auth holds the authoritative Company): the sequence of decision 3 is unchanged: import, verify, freeze, verify under the freeze, activate with **no caller token registered**, verify, register Auth's credential and switch Auth's source by configuration, then open other callers. The Company already exists (imported), so **no bootstrap runs**. The provisioning identity is registered only **after** post-cutover verification, so the zero-write window is never weakened. Billing's and Payment's reference reads open only after cutover verification; before it, Platform-scoped production requests involving an Organization fail closed (ADR-0042 Amendment 1, A.3).

> **Superseded by Amendment 2 (A2.5, 2026-09-20).** The ten-step fresh-environment table and the reconciliation note that follow are replaced by the fresh-environment sequence of A2.5. The two paragraphs headed "State and permitted operations in a fresh environment" and "What the switch at step 8 changes" stay in force, with "step 8" read as the single **ACTIVATE AUTHORITY** step, and so does the paragraph beginning "While the state is `inactive`", with "steps 2 and 4" read as the bootstrap and Auth's `ensure` (F2 and F4 in A2.5).

**Fresh environment** (no legacy hierarchy in Auth). *(Superseded; kept as history.)* The owner's ten steps, with the ADR-0040 gate each maps to:

| # | Step | Gate |
|---|---|---|
| 1 | Provision Organization Service (deploy, explicit migration, state row `inactive`); register the provisioning credential | preflight |
| 2 | Create the first Company through the one-time controlled bootstrap | the first committed write |
| 3 | Organization Service holds the hierarchy content (the Company); authority is **not yet activated** | (reads "establish" as "holds the data"; see below) |
| 4 | Register Auth's read credential; bootstrap and validate Auth's reference state by `ensure(companyId)`; create the owner referencing it (no Company insert in Auth) | bootstrap |
| 5 | Verify ids, hierarchy and the Auth foreign-key references (the reference rows equal Organization Service's, and `owner.companyId` resolves) | verify |
| 6 | Freeze Auth hierarchy writes: the cache accepts rows only through `ensure`; the legacy Company insert path is disabled | freeze |
| 7 | Verify the final export or digest (decision 5, Proposed) | verify under the freeze |
| 8 | **Activate** Organization Service authority (state row `active`) and switch Auth's source by configuration | **activate** |
| 9 | Retire Auth hierarchy writes for good (the cache-write guard stays) | retire |
| 10 | Post-cutover verification, then open other callers | verify, open |

*(Superseded by A2.5 and A2.7: the confirmation it asks for is closed.)* **Reconciliation note.** The owner's list says "establish Organization Service as the authoritative hierarchy" at step 3 and "activate Organization Service authority" at step 8. ADR-0040 has one activation gate, so this amendment reads step 3 as *Organization Service holds the authoritative content* and step 8 as the *single authority activation*. **In a fresh environment there is no legacy authority to freeze or to return to, and no zero-write window to protect**, so the provisioning and Auth read credentials may be registered before activation; that permission is limited to fresh environments. The owner is asked to confirm this reading; it does not change the sequence.

While the state is `inactive` or in transition, **service authorization in consumers** enters the controlled transition state of AD-5: no operation silently accepts an unvalidated relationship, and operations needing the authority may be temporarily unavailable. That wording does not apply to the bootstrap and Auth's `ensure` (F2 and F4 in A2.5; originally steps 2 and 4).

**State and permitted operations in a fresh environment.** While a fresh environment's state row is `inactive`, Organization Service accepts only: the first-Company bootstrap and any later provisioning by the provisioning credential; Auth's `ensure` reads, by Auth's read credential, for the bootstrap flow only; and health and readiness. It refuses human administration, Billing's and Payment's reference reads and every other caller. The marker that allows the bootstrap (F2) before activation is an **environment-class marker recorded by the provisioning process in the state row** (the "explicit fresh-environment flag" of the implementation study's IC-12; its form is a Stage 10.1 detail). An existing environment has no such marker, so the provisioning credential is refused there until after cutover verification.

**What the switch at step 8 changes.** Before step 8, Auth's hierarchy source is "non-authoritative, bootstrap only": `ensure` is permitted in the bootstrap flow alone, and the local hierarchy write paths are already off. After step 8 the source is `organization-service` and `ensure` serves every administrative first-touch flow of decision 2.

### A1.4 Decision 4 restated (one-way door)

- **Existing environment (decision 4 as adopted).** The first committed hierarchy write in Organization Service **after activation** ends automatic rollback. The verified import, which precedes activation and is checked against the export digest, is not such a write. Before that write rollback rests on the provable zero-write window; after it, ownership rollback **requires reconciliation** and is **not** an automatic deployment rollback. **No automatic rollback is invented.**
- **Fresh environment. Superseded by Amendment 2 (A2.6).** This bullet originally closed the door at the first-Company bootstrap. The owner's direction of 2026-09-20 says the door is **not** moved earlier than decision 4 requires, so in a fresh environment, as in an existing one, the door is the first committed hierarchy write **after activation**. The original bullet read: "The owner's rule (before the first committed write a provable zero-write window; after it, reconciliation) is applied with the first-Company bootstrap as that write. **This closes the door earlier, by design: at the bootstrap (step 2), before activation (step 8)**, because no earlier authority exists to return to and no import precedes it. It is a consequence of applying the rule to a fresh environment, stated so that it is not read as a change to decision 4 for existing environments; **the owner is asked to confirm it**. This ADR designs no ownership rollback for a fresh environment. How an environment whose only write is that bootstrap is re-created is an operational runbook matter (BD-7), not an ownership rollback."
- AD-5's emergency mechanism (changing the **active authority** only during a formally controlled rollback or recovery procedure, gated, fail-closed, auditable and following this ADR's rollback semantics) is consistent with this rule. There is no permanent "disable authorization" mode.

### A1.5 Residual risk RR-1

RR-1 (any token that reads Organization Service can also write it) is resolved by the capability split of ADR-0042 (decision 3, with A.3 and A.5) **when implemented**; until then it stands.

### A1.6 What this amendment does not do

It does not decide decisions 5 and 6, lifecycle (BD-5), production topology (BD-7), the `/auth/me` consumers (BD-8), multi-company support or B-026, O-18 and B-036. It implements nothing and adds no route, migration or schema.

## Amendment 2 (2026-09-20): decisions 5 and 6 accepted; production-readiness and cutover gates (decision 7); terminology; the one-way door

- **Status of the amendment:** recorded from the architecture owner's written direction of 2026-09-20 on OPEN-1 (decisions 5 and 6) and OPEN-2 (BD-7a to BD-7e). **With it this ADR is Accepted.** The original text and Amendment 1 are kept; where this amendment differs, it governs, and each difference is named. It implements nothing.

### A2.1 Adoption record

| Decision | State |
|---|---|
| 1 Reference model R2c | adopted (Amendment 1) |
| 2 No synchronous dependency on the authentication paths | adopted (Amendment 1) |
| 3 Cutover sequence | adopted (Amendment 1), refined for the two environment classes in A2.5 |
| 4 One-way door | adopted (Amendment 1), made precise in A2.6 |
| 5 Import | **accepted** (A2.2) |
| 6 Interim invariants I1 and I2 | **accepted as migration invariants, not a lifecycle policy** (A2.3) |
| 7 Production-readiness and cutover gates (added) | **accepted** (A2.4) |

### A2.2 Decision 5 accepted: the checksummed snapshot export and import

**The guarantee.** *Organization Service receives exactly the verified hierarchy snapshot intended for cutover.*

**The mechanism** (unchanged from the original decision, and not replaced by `pg_dump`): a checksummed canonical export produced under **one read-only `REPEATABLE READ` snapshot** of Auth's hierarchy, with per-table and whole-artifact sha256 digests in a manifest that also records Auth's migration checksums; and a **file-based, all-or-nothing, compare-and-insert import**: identical rows are skipped, a differing row or an extra destination row aborts the import, and nothing is ever updated. No database credential crosses services. `pg_dump` remains the **backup** tool only. Direct database reads, an Auth export API, `postgres_fdw` or `dblink` and logical replication stay rejected (Options C).

**The properties.** Deterministic; checksummed; verifiable offline; repeatable before activation; safe to validate before the one-way door.

```text
Auth hierarchy (existing environment)
   -> one consistent snapshot
   -> checksummed export
   -> verify the export
   -> controlled Auth freeze
   -> final snapshot verification (the final export is taken under the freeze)
   -> Organization Service import (compare-and-insert)
   -> verify the imported data equals the export digest
   -> ACTIVATE AUTHORITY
```

Runs of snapshot, export, import and verification **before the freeze** are preparation and rehearsal into an inactive Organization Service and are repeatable. If Auth changed between the last preparation export and the freeze, the verification under the freeze detects it, and the export and import are repeated under the freeze: compare-and-insert adds the delta and aborts on any difference. The data volume in production is unknown and is an input to the rehearsal (the Stage 10.0 study describes streaming, and a staging table above roughly 10^5 rows).

### A2.3 Decision 6 accepted: I1 and I2 as migration invariants

**I1.** A hierarchy id (Company, Platform or Organization) is **never reused**.

**I2.** Two parts, both recorded so that neither guard is dropped:
- **I2(a), the owner's statement:** existing hierarchy relationships are **not reparented or mutated** during the migration and ownership transition. This restates the anchor immutability that ADR-0024 designs, that both databases enforce by trigger, and that decision 1 protects (a later fetch that disagrees on an anchor fails closed and alerts). The compare-and-insert import enforces it across the transfer. It adds no mechanism for `UPDATE`; a delete followed by a re-insert under another parent is covered only by I1 and I2(b).
- **I2(b), this ADR's original I2:** no runtime path physically deletes a Company, Platform or Organization until a lifecycle ADR exists. It is retained because the migration removes the `ON DELETE RESTRICT` protection that today stops the deletion of a referenced entity.

**Reconciliation note.** The owner's wording of I2 differs from the original I2, which was a delete guard. Both parts are recorded, and neither decides any deletion semantics. I2(b) is retained conservatively from the original text; if the owner intended I2(a) alone, I2(b) is the only part to withdraw. It is an interim guard, not a deletion policy.

**Duration and scope.** The owner's direction places the invariants "during the migration and ownership transition". This ADR's original wording ran "until a lifecycle ADR exists" (I2) and gave I1 no end. **The longer duration is carried from that original text, not from the direction:** the invariants are required from acceptance, through the transition, and after it until a lifecycle ADR decides otherwise, because I2(b) protects references once the `ON DELETE RESTRICT` protection is gone and ADR-0042's memo depends on I1. If the owner intends them to end with the transition, ADR-0042's memo must end with them. **They are migration invariants, not a complete permanent lifecycle policy.** They do **not** decide: permanent deletion semantics, archival, deactivation or suspension, restoration, the whole of future lifecycle behavior, or any reparenting policy outside the migration boundary. Those stay in BD-5 (undecided).

**Consequence.** ADR-0042's rule that a memo of a positive lookup is allowed only while ids are never reused is satisfied while I1 holds. **Enforcement** (for example withholding `DELETE` from the runtime role, a delete guard) is a Stage 10.1 design choice. The invariants are **requirements from acceptance, not yet mechanically enforced in every respect**: the triggers guard `UPDATE` only, and until Stage 10.1 enforces I1 and I2(b) a role that may delete could delete and re-insert an id.

### A2.4 Decision 7 (added): production-readiness and cutover gates (BD-7a to BD-7e)

**Applicability.** These gates govern the **real production authority activation**. They do not gate starting Stage 10.1 work or running a non-production rehearsal.

**Deployment is not activation.**

```text
application deployment   !=   authority activation
```

A deployment may introduce **inert, expand-only** schema and code. It must never make Organization Service authoritative. The model is:

```text
deploy -> migrate (gated) -> verify -> health and readiness -> explicit authority switch (approved) -> post-switch verification
```

The authority switch is a **separate, explicit, controlled operational action** and is never a side effect of application startup, migration execution, deployment, a health check, a database connection or message consumption. As decision 3 already says, Auth's source is switched by configuration and never by a code deploy.

**The gates.** All must be met before the real production **ACTIVATE AUTHORITY**. Evidence is recorded for each.

| Gate | Requirement | Decision |
|---|---|---|
| **G1 Topology** | Organization Service has an **explicit production topology**, documented and approved: Auth Service and its database; Organization Service and its database; the network and security boundary; service credentials (kept out of source control); backup and restore; health and readiness; monitoring and alerting; the deployment path. Exposure is internal only initially (ADR-0042 decision 6; public exposure of any administrative surface stays undecided, ADR-0041). Databases are separate per service (ADR-0032). **No infrastructure product or provider is named by this ADR.** Organization Service must have a real, controlled deployment path before it becomes authoritative; deployed code is not authority | BD-7a |
| **G2 Gated migrations** | An irreversible migration is never applied by an automatic deploy. Only inert, expand-only changes may ride a normal deploy (Auth auto-deploys and auto-migrates on a merge to its directory, so its hierarchy-related code and schema ship inert until the switch). Contract or drop steps need separate approval; none is planned | BD-7b |
| **G3 Least privilege** | **Before activation, Auth must not need a PostgreSQL superuser for ordinary runtime operation, and neither must Organization Service.** Production roles are scoped to each service's needs, with the migration role separate from the runtime role (ADR-0032). Organization Service's configuration already refuses, in production, a runtime login named `postgres`, `root` or ending `_migrator`; that is a name check and does not test whether a role is a superuser; its production roles do not exist yet | BD-7c |
| **G4 Monitoring** | The minimum monitoring and alerting for the cutover exists and **is demonstrated in the rehearsal**: at least readiness of both services, the authority state and Auth's marker agreeing, a failed verification or digest mismatch, and the anchor-disagreement alert decision 1 requires. Log retention and thresholds are set in the rehearsal plan. (The minimum list is derived from decision 1's alert requirement and the health and readiness gates; the owner may adjust it in the rehearsal plan.) | BD-7d |
| **G5 Backup and restore** | A **documented** backup procedure is **not** a **verified** restore procedure. The rehearsal includes restore checks sufficient for the production requirements stated in `production-readiness.md`. The RPO and RTO targets are **stated by the owner in the rehearsal plan before the rehearsal**; this ADR fixes the requirement, not the numbers (that they are stated before the rehearsal is derived from BD-7e). The requirement of `production-readiness.md` and the Stage 10.0 study that a restore is **drilled on the real volume is not waived**: the rehearsal plan states whether the rehearsal's restore satisfies it or a separate drill on the real volume is also performed, and the approver accepts that | BD-7e |
| **G6 Rehearsal** | **One successful production-like rehearsal** of the complete ownership-transition procedure: environment preparation, migrations, hierarchy snapshot, checksum, verification, freeze, import, import verification, authority activation, Auth write retirement, post-cutover verification, health and readiness, backup and restore checks, monitoring and alert checks. **Unit tests passing is not a rehearsal.** The rehearsal plan defines, and the approver accepts, what "production-like" means for it | BD-7d, BD-7e |
| **G7 Approval** | The rehearsal is completed and its **results are recorded** (environment, versions and checksums, each gate's result, deviations, the approver); **all required gates pass**; and a named human approver **explicitly approves** the real production authority activation. Only then is it performed | explicit human approval |

**State of the gates, from the repository's own records** (the Stage 10.0 study and `production-readiness.md`; not re-verified against production by this amendment): no Organization Service production deployment or database exists; Auth's production database runs as a superuser; there is no documented production backup job, and a restore has never been drilled on the real volume; no monitoring is documented; no rehearsal has run. **No gate is met.** This ADR claims none.

### A2.5 Terminology and the two environment classes

One term names the authority switch: **ACTIVATE AUTHORITY** is the transition of Organization Service's own state row from `inactive` to `active`, performed as an explicit, approved, manual action. **There is one authority switch.** Everything else has its own name:

| Term | Meaning |
|---|---|
| prepare, import, verify | work into an **inactive** Organization Service; not authority; repeatable |
| freeze | Auth's hierarchy write lock and marker (existing environments only) |
| **ACTIVATE AUTHORITY** | the one switch (the state row) |
| mirror | Auth's `org_authoritative` marker and Auth's source configuration; **consequences** of the switch, not a second switch |
| retire | Auth's hierarchy write paths become permanently off, except the reference-cache protocol |
| the door | the first committed hierarchy write after activation (A2.6) |

**Imported data does not make Organization Service authoritative.** In an existing environment the data is imported and verified while Organization Service is inactive; only ACTIVATE AUTHORITY changes authority.

**Existing environment.** Auth holds the authoritative hierarchy.

| Step | Action | Gate | Rollback |
|---|---|---|---|
| E0 | Expand (inert) deployed and soaked | manual go | not applicable |
| E1 | **Prepare:** snapshot, checksummed export, verify the export, import into the inactive Organization Service, verify the import (repeatable; also the rehearsal) | automated check, manual go | discard the import |
| E2 | **Freeze** Auth (lock, then marker) | manual | unfreeze |
| E3 | **Final** snapshot and export under the freeze; verify digests; import (compare-and-insert); verify the imported data equals the export digest | automated gate | unfreeze, discard |
| E4 | For the **real** run, gate G7 approval recorded (in the rehearsal, G6, the same step runs without G7, which governs the real activation only); **ACTIVATE AUTHORITY** with **no caller token registered** | manual | the zero-write window |
| E5 | Post-activation verification (digest unchanged) | automated gate | the zero-write window |
| E6 | Register Auth's read credential (**this ends the zero-write window**: Stage 10.0 section 6.1 treats registering a token as opening the door, and the door itself is the first committed write); mirror: switch Auth's source by configuration and mark `org_authoritative`; **retire** Auth hierarchy writes | manual | no provable rollback once a token exists; reconciliation after any write |
| E7 | Post-cutover verification (health and readiness, backup and restore checks, monitoring and alerts); then open other callers | automated and manual | reconciliation |

**The import path** (a tool, not the API) is the one writer permitted while an existing environment's Organization Service is inactive; how it is authenticated is a Stage 10.1 design detail, and the API still refuses hierarchy writes unless active (Stage 10.0, Refinement 3). The existing Company is imported, so **no bootstrap runs**. The provisioning identity is registered only after E7's verification, so the zero-write window is never weakened.

**Fresh environment.** There is no legacy Auth authority to freeze. This is not a second migration protocol: it is the same activation model without the legacy steps.

| Step | Action |
|---|---|
| F1 | **Provision** Organization Service (deployment, explicit migration, state row `inactive`, an environment-class marker (`fresh`; the name is illustrative and its form is a Stage 10.1 detail)); register the provisioning credential |
| F2 | **Controlled bootstrap** of the first Company (one-time, provisioning identity) |
| F3 | **Establish the initial hierarchy:** the first Company. Platforms and Organizations are created **after** activation through the human administration path (ADR-0042 A.2), because no accepted decision grants any identity or capability to create them while inactive (see OPEN-5) |
| F4 | **Bootstrap the required Auth reference state:** register Auth's read credential; `ensure(companyId)`; create the owner referencing that row (no Company insert in Auth) |
| F5 | **Verify** ids, the hierarchy and Auth's foreign-key references (Auth's reference rows equal Organization Service's; `owner.companyId` resolves) |
| F6 | **ACTIVATE AUTHORITY**; mirror (Auth's source by configuration) |
| F7 | **Retire** (Auth's hierarchy write paths stay off; only the reference-cache protocol writes); post-activation verification; then open other callers |

**Permitted operations while a fresh environment is inactive** (unchanged from A1.3): the first-Company bootstrap and later provisioning by the provisioning credential; Auth's `ensure` reads for the bootstrap flow only; health and readiness. Refused: human administration, Billing's and Payment's reference reads, and every other caller. An existing environment has no `fresh` marker, so its provisioning credential is refused until after E7.

### A2.6 The one-way door, precisely

**The door is the first committed hierarchy write (`INSERT`, `UPDATE` or `DELETE` on `company`, `platform` or `organization`) in Organization Service after activation** (decision 4 as adopted, and the Stage 10.0 study section 6.1). This is **not moved earlier**.

| Regime | Rollback |
|---|---|
| **Before activation** (existing and fresh) | possible: the import and every preparation write are preparation, not authority. Existing: unfreeze Auth and discard the import. Fresh: no authority was ever transferred, so a failed preparation is corrected inside the inactive environment under the runbook; that is not an ownership rollback |
| **After activation, before the door** (the zero-write window: active, **no caller token ever registered**, the digest equals the export digest) | a **manual, provable** deactivation: deactivate Organization Service and unfreeze Auth. It is not automatic |
| **After a caller token is registered, before any write** | the zero-write proof no longer holds, because the token is treated as opening the door; rollback is **not supported as provable**, and is handled as in the next row |
| **After the door** (the first committed hierarchy write) | ownership rollback **requires reconciliation** and is **not an automatic deployment rollback**. Reconciliation is not designed (ADR-0039 defers it), and **no automatic rollback is invented** |

**The verified import is not the door.** It precedes activation and is checked against the export digest. In a fresh environment the bootstrap and the Auth reference rows precede activation and are not the door either. **No rollback after activation is automatic.** Registering a caller token ends the zero-write window (Stage 10.0 section 6.1 treats it as opening the door); the door itself is the first committed write. Under ADR-0042 Auth's credential is read-only, but the conservative rule of the Stage 10.0 study stands.

**Fresh environment after activation.** There is no export digest, and credentials are registered before activation, so **there is no zero-write window and no ownership rollback**: no legacy authority exists to return to, and this ADR designs none. The door is still the first committed hierarchy write after activation.

This supersedes the fresh-environment bullet of A1.4, which had closed the door at the bootstrap.

### A2.7 Confirmations resolved

- **The ten-step wording.** There is one switch, named ACTIVATE AUTHORITY. The earlier ten-step list, including "establish authority" at step 3, is replaced by the fresh sequence of A2.5. The earlier note asking the owner to confirm the reading is closed by this amendment.
- **The fresh-environment one-way door.** It is the same as for an existing environment: the first committed hierarchy write after activation (A2.6). The earlier request to confirm the earlier closing is closed, and that earlier closing is withdrawn.

### A2.8 Not decided after Amendment 2

- **BD-5 lifecycle semantics** (deletion, archive, deactivate, suspend, restoration) and any reparenting policy outside the migration boundary.
- **BD-8:** `/auth/me` and onboarding resolution stay frozen; nothing here changes them.
- **The concrete production topology** (for example where Organization Service's database runs within ADR-0032's database-per-service rule). It is a gated Stage 10.1 deliverable, approved at G1; no provider or product is chosen here.
- **RPO and RTO values, monitoring thresholds and log retention.** They are set in the rehearsal plan (G4, G5).
- **OPEN-5 (OPEN: OWNER DECISION REQUIRED, not blocking Stage 10.1):** whether initial Platforms or Organizations must exist before activation in a fresh environment. No accepted decision grants a capability to create them while inactive (the provisioning identity creates Companies only). Until decided, F3 holds the Company only and Platforms and Organizations are created after activation.
- Unchanged: multi-company support; B-026, O-18, B-036; OPEN-3 and OPEN-4 (non-blocking, defaults as recorded in ADR-0042).

### A2.9 Stage 10.1 prerequisites

The Stage 10.0 study's section 16 lists six prerequisites. They now read: (1) this ADR is Accepted, with the import mechanism and the interim invariants approved: **met**; (2) BD-7a, BD-7b and BD-7c decided: **met** as accepted *requirements* (G1 to G3); BD-7a in the Stage 10.0 study asked where Organization Service and its database run and how they are exposed, and the concrete topology stays undecided (A2.8), to be approved at G1; (3) BD-7d and BD-7e decided, or a rehearsal accepted without them: **met by the second branch**, the owner's acceptance of proceeding to a rehearsal (gates G4 to G6), which **does not waive** item 3's restore drilled on the real volume (G5); (4) BD-8 evidence before any change to `/auth/me` or the resolve contract: **not needed** for Stage 10.1, which changes neither; (5) BD-4 not required to start: **resolved anyway**; (6) I1 and I2 approved before Auth's cache is trusted: **met**. These are prerequisites to **start** Stage 10.1. **They are not production readiness, and they do not approve any production cutover.**

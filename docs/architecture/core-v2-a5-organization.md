# Core V2 A5: organization

- **Status:** RECORD of the A5.0 discovery (read-only, 2026-10-08, on `main` at `f90787a`, the PR #252 merge that closed A4) and of
  **A5.1: the A5 architecture and scope record** (merged, PR #253, `ffdb604`, 24/24 checks), and of **A5.2: the ADR review record**
  (§11; read-only review on `main` at `ffdb604`, 2026-10-09). The review record (PR #254) changed no ADR status; the owner's
  subsequent, individually approved ADR decisions are recorded in **§11.9** (ADR-0039 Accepted on `main`, PR #255; ADR-0031, 0026,
  0028, 0029 and 0030 accepted on 2026-10-09 in the grouped A5.2 documentation pull request, merged as PR #256; ADR-0023 accepted on
  2026-10-09 under A5.2-I, merged as PR #257). **A5.2 is not complete**: ADR-0017, 0020, 0022 and 0024 remain Proposed. OD-A5-3 is
  decided by ADR-0059, accepted on 2026-10-09 and merged as PR #258 (§10.1). The OD-A5-1 policy is decided by ADR-0060, accepted on
  2026-10-09 and merged as PR #259 (§10.0). OD-A5-4(a)–(d) are decided by ADR-0061, accepted on 2026-10-09 and merged as
  PR #260 (§10.2); OD-A5-4(e) stays open. OD-A5-2 has an owner-approved policy direction drafted as ADR-0062, **Proposed**, on its own
  branch (§10.3).
  **A5 is OPEN.** Its label is **🔴 (design 🟡)** ([roadmap](../CORE-ROADMAP.md), Core V2
  table; [V2-A record](core-v2-a-baseline-and-change-safety.md) §4): design, analysis and ADR review proceed now; **every runtime or
  authority change waits for the production transition of §7**. Nothing in this record is implemented, approved or activated by it.
- **Labels.** **[CURRENT]**: true on `main` today. **[TARGET: post-F7]**: the state the Accepted decisions define once F7 is complete.
  **[PROPOSED]**: a proposal of this record that needs an explicit owner decision. **[BLOCKED: gate]**: may not start before that gate.
- **Roadmap requirement (unchanged):** "companies and organizations, memberships, ownership, invitations, organization lifecycle, the
  Auth–Organization interaction", labelled 🔴 (design 🟡). The sub-stages of §9 and the decisions of §10 are **proposals of this record**,
  not roadmap requirements.
- **Binding decisions:** [ADR-0040](../adr/0040-organization-ownership-migration-decisions.md) (Accepted: Auth's reference model, the
  cutover mechanism, the one-way door), [ADR-0041](../adr/0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md),
  [ADR-0042](../adr/0042-service-token-scopes-and-administrative-authorization.md),
  [ADR-0050](../adr/0050-platform-administration-and-verified-human-authority.md) and
  [ADR-0056](../adr/0056-core-architecture-and-api-conventions.md) (its `[DEFERRED: A5 / F6 / F7]` and `[COMPAT]` items). Accepted ADRs win
  over this record.
- **Related:** [organization-service README](../../apps/organization-service/README.md), [SDD](../sdd/organization-service.md),
  [Stage 10.1 implementation](stage-10/stage-10-1-implementation.md), [cutover record](stage-21/stage-21-x-cutover-record.md),
  [G6 rehearsal plan](stage-21/stage-21-x-g6-rehearsal-plan.md), [organization-production runbook](../runbooks/organization-production.md),
  [A4 record](core-v2-a4-authentication.md).

## 1. Authority today and after F7

| Entity or capability | Authority [CURRENT] | Authority [TARGET: post-F7] |
|---|---|---|
| Company, Platform, Organization (data, lifecycle, metadata) | **Auth** (`AUTH_HIERARCHY_SOURCE=local`, the default; Auth's `company`, `platform`, `organization` tables) | **organization-service only**; Auth's tables become a non-authoritative, validated reference cache filled only by `ensure` (ADR-0040 decisions 1–2, Amendment 1 A1.2) |
| organization-service's own state | implemented, ownership state `inactive`: it holds data, is independently tested, and no Core flow reads or writes it | `active` from F6 (the one-way door: the first committed hierarchy write after activation ends automatic rollback, ADR-0040 decision 4) |
| Users, credentials, sessions, MFA, recovery | Auth | **Auth** (unchanged; organization-service never owns them) |
| Organization memberships (pending / active / rejected / revoked; multiple per user) | Auth | **Auth** (unchanged; ADR-0030; organization-service never owns membership) |
| Join codes, organization-admin invitations | Auth | **Auth** (unchanged), with organization ids validated through `ensure` |
| The single owner per Company | Auth (`bootstrap-owner` inserts the Company in local mode) | Auth owns the owner; the Company is Organization's; `bootstrap-owner` inserts **no** Company (ADR-0040 A1.2, AD-4) |
| Service-token authorization at organization-service | organization-service (`SERVICE_TOKENS`, `SERVICE_POLICY`: capabilities and `allowedPlatforms`, ADR-0042) | unchanged; further callers are opened only at the end of F7 |

A5 does **not** move membership, identity or invitation authority to organization-service.

## 2. Inventory [CURRENT] (A5.0)

| Capability | Implementation | Tests | Undecided |
|---|---|---|---|
| Hierarchy in Auth | migrations `0001`, `0008_hierarchy_authority.sql`; `src/hierarchy/hierarchy-authority.ts` (mode, reference-write gate, freeze, export, retire), `hierarchy-reference.ts` (`ensure`, `OrganizationDirectoryClient`), `snapshot.ts`; `src/cli/owner-tools.ts` (`bootstrap-owner`) | e2e `hierarchy-authority`, `hierarchy-reference`, `tenant-isolation`; cross-service `test/e2e-auth-organization/stage21c2-ownership-export-import.e2e-spec.ts` | – |
| Hierarchy in organization-service | `organization/companies`, `organization/platforms`, `organization/organizations` (create, list, read, update), `organization/admin/{platforms,organizations}` (create, update; human administration verified by Auth), `organization/reference/organizations/:id`; migrations `0001`–`0005` | e2e `companies`, `platforms`, `organizations`, `admin`, `platform-key`, `service-authorization`, `security`, `audit`, `localization`, `migrations`, `runtime-role`; OpenAPI `src/docs/openapi.spec.ts` | lifecycle (BD-5) |
| Memberships | Auth migrations `0004`, `0006`, `0007`, `0009`; `src/membership/`, `src/members/`; `auth/organizations/:organizationId/memberships*`, `auth/admin/members/:id/{suspend,restore}`, `auth/organizations/:id/membership` | e2e `multi-membership`, `member-zero-membership`, `member-security`, `onboarding`, `grants` | ADR statuses (0028, 0030) |
| Join codes and invitations | Auth migrations `0004`, `0005`; join codes are HMACs under `JOIN_CODE_PEPPER`; `auth/organizations/:id/{join-codes,admin-invitations}*`, `auth/onboarding/*` | e2e `admin-invitation`, `onboarding`, `audit-actions` | ADR statuses (0028, 0029) |
| Owner | one owner per Company (ADR-0017; the force-reset CLI was never built and is not to be built); owner MFA, step-up, recovery (A4) | e2e `owner-auth`, `owner-tools`, `bootstrap`, `recovery` | **owner transfer: no decision exists** |
| Organization lifecycle | **create and update only**: no delete, archive or status in either service (organization-service README; SDD) | – | **BD-5** (deletion, archive, deactivate, suspend, restoration; reparenting) |
| Ownership tooling | organization-service `src/cli/ownership.ts` (`status`, `declare-class`, `verify-snapshot`, `import`, `verify`, `approve`, `activate`, `retire`, `rollback`), reading `OWNERSHIP_ADMIN_DATABASE_URL`, `NODE_ENV`, `OWNERSHIP_PRODUCTION_ACTIVATION` from `process.env` (deliberately outside the A2 / A15 `EnvReader` convergence); Auth `dist/cli/main.js hierarchy-{status,verify,freeze,unfreeze,export,retire}` | organization-service e2e `ownership`, unit `ownership-admin.spec`, `golden-fixture.spec`, `hierarchy-snapshot.spec`; Auth e2e `hierarchy-authority` | convergence after F7 |
| Auth's Organization credential | `ORGANIZATION_SERVICE_URL`, `ORGANIZATION_SERVICE_TOKEN` (written by the deploy script once the F4 registration exists); `AUTH_HIERARCHY_SOURCE` is never written by a deploy (switching it is F6's mirror) | unit `app-config.spec`; e2e `hierarchy-reference` | – |

## 3. The Auth ↔ Organization interaction

**[CURRENT]** (ADR-0056 `[COMPAT]`: intentional in the pre-F6 transition state)
- **Auth → organization-service:** `ensure` and reference reads, only in `organization-service` mode and only from administrative
  first-touch flows (join code, invitation, platform assignment, the owner bootstrap); never from login, refresh, logout, `/auth/me`,
  registration, join or consume. Bounded and fail closed: `503 hierarchy_unavailable`. Production Auth runs in `local` mode.
- **organization-service → Auth:** `AuthGrantsClient` (`AUTH_SERVICE_URL`, `/auth/grants`) verifies the human administrator's own Auth
  bearer live (ADR-0050).

**[TARGET: post-F7]** Auth's source is `organization-service`; Auth's hierarchy writes are retired (the reference-write gate stays);
organization-service is the only hierarchy authority; other callers are opened. **Whether the two-way runtime dependency is then
removed, kept or narrowed is undecided** (§10, OD-A5-4).

## 4. Contracts and compatibility requirements

- Core V1 contracts are preserved (roadmap rule 7): status codes, `code`, response shape and events, unless the owner authorizes a change.
- ADR-0040 BD-8: `/auth/me` and onboarding resolution stay frozen.
- ADR-0041 / ADR-0050: administrative capabilities are domain-owned, client-neutral APIs; a human presents their own Auth bearer, verified
  live; no delegated-human token.
- ADR-0042: service tokens with explicit capabilities and Platform scope; reading a Company is not Platform-scoped.
- The A4 guarantees (A4 record §2.1) and the Auth configuration and JWT conventions are unchanged by A5.
- The ownership-transition procedure that G6 rehearses (fresh path, ADR-0040 A2.5, F1–F7) is not altered before F7 (§8).

## 5. What A5 is not

Not A5: authentication (A4, closed); roles, permissions and policy evaluation (A6); audit semantics (A7); Notification (A8); Billing and
Payment semantics, organization-payer authority (B-026 / O-18) and platform currency (B-036) (A10, A11); product integration and opening
product callers (A16); the production transition itself (§7), which is a production track, not an A5 sub-stage.

## 6. Classification

| Item | Label |
|---|---|
| Auth identity, sessions, MFA, recovery; memberships, join codes, invitations in Auth; organization-service's implemented API, service-token authorization and ownership mechanism; the F1–F7 tooling as it stands | 🟢 existing, no implementation |
| this record; ADR reviews (§11); the post-F7 design; deciding whether BD-5, OPEN-5, owner transfer, dependency removal and CLI convergence are in scope | 🟡 allowed now |
| activating authority; retiring Auth's local hierarchy path or legacy Company insert; removing the two-way dependency; changing either ownership CLI or Auth's `hierarchy-*` commands; any lifecycle runtime; opening callers; anything that changes the code G6 rehearses | 🔴 blocked (§7) |

## 7. Production gate (unchanged; roadmap G6 section, G6 plan §12)

```text
G6 baseline refresh
→ G6 recovery rehearsal (G6-B, G6-BV, G6-C, G6-D, G6-E, G6-F → G6 CERTIFIED)
→ pre-G7 Auth + Organization backup, verified (then the backup schedule)
→ G7   ownership approve --reference <G6 record>   (reversible by rollback until F6)
→ F6   ACTIVATE AUTHORITY and the Auth mirror      (no fresh-environment rollback, ADR-0040 A2.6)
→ F7   retirement and post-activation verification
→ post-F7 Auth + Organization backup, verified     (then other callers are opened)
```

Each step is a separate, owner-authorized production checkpoint, never part of an A5 sub-stage. G6 is deferred (G6-A certified; the
rehearsal host is an owner decision; the plan's read-only GHCR credential D-16 and an egress block are prerequisites). **Design
activities proceed now. Runtime and authority changes stay blocked until the applicable gate is complete**: anything that assumes
organization-service is authoritative waits for F6; retiring Auth's paths and opening callers wait for F7. The open F6 / F7
image-pinning decision (cutover record §8; deferred to G6-C) means code merged before F7 can reach production through F6 and F7's
redeploys unless images are pinned.

## 8. Risks of implementing before F7

- Invalidating G6: changed Auth, Organization or kit code is code the rehearsal did not run.
- Changing the rehearsed procedure: the ownership and hierarchy CLIs are the F1–F7 steps.
- Two authorities or a stranded state across the one-way door.
- Contradicting Accepted ADR-0040 (decision 4, A1.2) or BD-8.
- New requirements by implementation: lifecycle, owner transfer and multi-company have no decision.

## 9. Proposed sub-stages [PROPOSED]

| Sub-stage | Objective | Depends on | Files | Acceptance | Validation | Effort (Claude-assisted) |
|---|---|---|---|---|---|---|
| A5.1 | this record; A4 closure wording | A5.0 | this record, the roadmap, the A4 record | merged; every A5 item labelled; no runtime change | `check:repo`, `git diff --check`, links; Core CI | ✅ merged (PR #253) |
| A5.2 | ADR reviews, one ADR at a time (§11); each status change separately authorized | A5.1 | review record: this record and the roadmap; then `docs/adr/00xx-*.md` and the ADR index, one ADR per status-change PR | each review recorded (**done**, §11); statuses change only on explicit authorization (**pending**) | docs checks; Core CI per status-change PR | 10–20 h (review record done; about 12–18 h remain, §11.8) |
| A5.3 | post-F7 design: Auth as reference cache in steady state, retiring local mode and the legacy Company insert, the dependency decision, CLI convergence plan, and lifecycle only if decided in scope | A5.1, A5.2, owner decisions (§10) | this record; possibly a new ADR (Proposed) | designs owner-reviewed; implementation items labelled 🔴 | docs checks; Core CI | 10–25 h |
| A5.4 | implementation of the approved A5.3 designs | **F7** and a refreshed baseline | `apps/auth-service/src/hierarchy/*`, `src/cli/owner-tools.ts`, `src/config/app-config.ts`; `apps/organization-service/src/cli/ownership.ts`, `src/admin/*`; their tests | the V2 protocol: focused tests and mutants, service regression, `test:e2e:auth-organization` | full Core CI per pull request | ⚪ about 30–150 h, set by A5.3 |
| A5.5 | certification | A5.4 | this record, the roadmap | the criteria A5.3 fixes | records-based; merged pull requests' CI | 3–6 h |

Design phase (A5.2–A5.3): about 20–45 h. Assumptions: about 6 productive hours a day, one Core CI run per pull request, owner decision time
excluded. The production track (§7) is separate and owner-driven.

## 10. Owner decisions [PROPOSED, not approved]

| Id | Decision needed | Notes |
|---|---|---|
| OD-A5-1 | **BD-5 organization lifecycle** (deletion, archive, deactivate, suspend, restoration, reparenting): in A5 scope or not | no decision existed; organization-service has no status column or delete path. **Policy decided 2026-10-09** (§10.0; ADR-0060, merged as PR #259) |
| OD-A5-2 | **OPEN-5**: whether initial Platforms or Organizations must exist before activation in a fresh environment | ADR-0040 A2.8; not blocking Stage 10.1. **Policy direction approved 2026-10-09** (§10.3; ADR-0062 Proposed, not accepted) |
| OD-A5-3 | **Owner transfer**: in A5 scope or not | ADR-0017 keeps one owner per Company permanently; no transfer decision exists. **Decided 2026-10-09** (§10.1; ADR-0059) |
| OD-A5-4 | **Transitional dependencies**: after F7, remove, keep or narrow the two-way Auth ↔ Organization dependency and Auth's `local` mode | ADR-0056 `[COMPAT]` and `[DEFERRED: A5 / F6 / F7]`. **(a)–(d) decided 2026-10-09** (§10.2; ADR-0061, merged as PR #260); the dependency question itself, (e), stays open with OD-A5-5 |
| OD-A5-5 | **Ownership CLI convergence**: after F7, move `ownership` and Auth's `hierarchy-*` commands onto the kit's `EnvReader`, retire them, or keep them | excluded from A2 / A15; must not change before F7 |

### 10.0 OD-A5-1 design progress (2026-10-09)

- **Policy direction approved by the owner:** `ACTIVE`, `SUSPENDED`, `ARCHIVED` for Company, Platform and Organization; no physical
  deletion; independent local state with effective state derived from ancestors; restore lands in `SUSPENDED`; lifecycle independent of
  Billing; organization-service is the authority after F6/F7; Owner-with-MFA for Company and Platform, Owner or assigned Operator for
  Organization suspend and reactivate, Owner-only Organization archive and restore, never the Organization Admin; enforcement E4 + E1 +
  E5 (E5 a narrow amendment of ADR-0040 decision 2 for Auth's access-granting administrative writes only); access-reducing actions always
  available; an additive effective-status reference contract never memoized (OD-L5); closed reason codes (OD-L6); normal ADR-0059 transfer
  denied for an archived Company, exceptional recovery unaffected.
- **Design:** [ADR-0060](../adr/0060-company-platform-organization-lifecycle.md), **Accepted on 2026-10-09 (A5.3 OD-A5-1 owner
  authorization) and merged as PR #259**; the OD-A5-1 architecture policy is decided. Nothing is
  implemented or activated.
- **Relationships (separately approved; merged with PR #259):** ADR-0040 partly superseded (decision 2 only, the E5 administrative-write
  amendment); ADR-0042 decision 5 clarified (lifecycle status never memoized; status unchanged); ADR-0050 partly superseded also by
  ADR-0060 (the decision 12 lifecycle bullet only). ADR-0023, ADR-0059 and ADR-0026 are preserved.
- **Accepted limitations:** G1 (earlier join codes and invitations may still be redeemed during suspension, with no effective product
  access) and G2 (the E5 time-of-check/time-of-use window), documented, not permission to deploy unprotected paths. Also recorded: G3
  (local Auth reads are not lifecycle signals), G4 (E1 consumer certification), G5 (the reference-contract change).
- **Unresolved implementation details:** the exact OD-L5 reference-contract shape and the OD-L6 reason vocabulary.
- **Open:** retention and legal erasure; event-driven propagation (E3, after A3M.8); OD-L7 (commercial settlement restrictions);
  an organization-scoped member restriction.
- **Blocked:** any lifecycle runtime until F6/F7 (§6, §7). No lifecycle functionality is implemented or activated. A5.3 is not complete.

### 10.1 OD-A5-3 design progress (2026-10-09)

- **Policy direction approved by the owner:** exactly one active Owner per Company; controlled transfer; exceptional recovery.
  Decisions OD-T1 (disable the former Owner's account), OD-T2 (Strategy A: a new `kind = owner` account with a pending owner row), OD-T3
  (24-hour cool-down; completion requires delivered notification), OD-T4 (operator assignments preserved), OD-R1 (recovery stewards,
  two-person approval, fresh MFA) and OD-R3 (at least 7 days for exceptional recovery).
- **Design:** [ADR-0059](../adr/0059-company-ownership-transfer-and-exceptional-owner-recovery.md), **Accepted on 2026-10-09 (A5.3
  owner authorization) and merged as PR #258**; nothing implemented or activated. It records the `pending → active → retired` lifecycle, the database invariant, the steward token and
  guard contract, Company-level serialization, the cross-service dependencies (audit contract consumer-first, service-kit validation)
  and two default-off activation gates (`OWNER_TRANSFER`, `OWNER_RECOVERY`).
- **Open:** OD-S1 (steward provisioning: its own threat model, nothing authorized), OD-S2 (Release and Audit response mapping;
  deferred, fail closed today), OD-P1 (abandoned recipient-contact reuse details), OD-R2 (evidence standard), OD-R4 (external legal or
  notarial step), multi-company ownership (A5.3), Organization lifecycle interaction (OD-A5-1).
- **Relationships (separately approved, on the same branch):** ADR-0050 partly superseded (its Stage 19 scope passages only); ADR-0017
  marked partly superseded (permanence and no-transfer only) and still Proposed; ADR-0024 amended by a forward note and still Proposed.
- **Not done:** no steward provisioning (OD-S1 deferred), no runtime change, no migration, no activation of either gate. A5.3 is not
  complete.


### 10.2 OD-A5-4 design progress (2026-10-09)

- **Policy direction approved by the owner (OD-A5-4(a)–(d)):** keep first-touch `ensure` and add one explicit hierarchy-reference repair
  operation; active Company Owner only, with a fresh factor-only step-up; resolve authoritative parent links without writing, authorize
  the Owner's Company, then place through the guarded idempotent reference write; same-transaction audit on success, best-effort failure
  audit after rollback, alerts for parent-link mismatches; a restricted read-only diagnostic. No background or event-driven reference
  synchronization. Authorization reads stay local (ADR-0023 D1(a)).
- **Design:** [ADR-0061](../adr/0061-auth-hierarchy-reference-repair-and-diagnostics.md), **Accepted on 2026-10-09 (A5.3 OD-A5-4 owner
  authorization) and merged as PR #260**, with a separately approved clarification note on ADR-0040
  decision 2 (not a supersession). **No reference-repair or diagnostic functionality is implemented or active.** Prerequisites: the audit-contract and audit-service change
  (consumer-first, separately authorized), the resolve/place split of `ensure`, and F6/F7 for any runtime effect.
- **Open:** OD-A5-4(e) (post-F7 dependency convergence and Auth `local`-mode retirement) with OD-A5-5; OD-A5-2 (direction drafted in
  §10.3); the diagnostic CLI conventions (OD-A5-5).

### 10.3 OD-A5-2 design progress (2026-10-09)

- **Policy direction approved by the owner (OD-A5-2(a)–(f)), subject to final ADR review:** (a) the pre-activation hierarchy of a
  fresh environment is exactly the provisioned Company, and the certified F2, F3 (no-op), F4 and F5 stand; (b) the first Platform only
  after a certified G6, a completed G7, F6 and F7, a verified post-F7 backup and a separate attended authorization, created by the active
  Owner through Organization Service's human administration; (c) the one-time provisioning credential must not stay able to create
  Companies after the transition (a controlled disablement step, designed and verified before implementation; no ownerless Company);
  (d) a separately approved, audited, attended change-control procedure adds each new Platform to Auth's `allowedPlatforms` before any
  first touch or ADR-0061 repair; (e) new entities start `ACTIVE`, with an explicit, validated backfill of the existing Company in
  ADR-0060's L2 stage; (f) the certified F4 record is the historical evidence of the bootstrap, no audit record is backdated, and the
  missing `bootstrap-owner` audit is a recorded gap.
- **Design:** [ADR-0062](../adr/0062-initial-hierarchy-provisioning-and-first-platform-sequencing.md), **Proposed** (2026-10-09), not
  accepted. It reports one tension for the owner to resolve at acceptance: ADR-0042 D1 names the provisioning identity for later
  Companies, while ADR-0062 retires the current credential (read as a clarification, not a supersession).
- **Prerequisites found (implementation, separately authorized):** `register-caller.sh` hard-codes Auth's `"allowedPlatforms":[]` and
  rebuilds the policy on every run, and has no deregistration path; ADR-0060 L2 for the initial state and backfill.
- **Open:** multi-company creation and ownership; future Company onboarding; factor-only step-up for Platform and Organization
  creation; OD-A5-4(e); OD-A5-5; OD-S1. Nothing is implemented, provisioned or activated; A5.3 is not complete.

## 11. A5.2 ADR review record

**Status: review completed, decisions pending** *(at review time; the owner's later decisions are in §11.9)*. The read-only review ran on `main` at `ffdb604` (2026-10-09). **No ADR status is
changed by A5.2's review record**, and no ADR file is edited by it. Every **"recommend ACCEPT"** below is a recommendation of this
review, **not an approval and not a completed acceptance**: under the ADR index rules (OD-A1-1) an ADR becomes Accepted only on the
architecture owner's explicit approval, recorded in its status line, one ADR at a time, each in its own pull request with Core CI.
Merge, implementation or this record are not approval.

Recommendation labels: **ACCEPT** (recommend acceptance as written), **REVISE** (correct the Proposed text in place first, then
decide), **DEFER** (no status decision before the named prerequisite), **RETAIN** (keep Proposed, no action planned).

### 11.1 The ten ADRs and their current statuses

| ADR | Title (short) | Current status |
|---|---|---|
| [0017](../adr/0017-single-owner-with-secret-key-force-reset.md) | single owner per Company; CLI force-reset | Proposed (force-reset CLI never built; withdrawn from Core V1 by Accepted ADR-0050) |
| [0020](../adr/0020-organization-entity-and-platform-scoped-management.md) | Organization entity, platform-scoped management | Proposed |
| [0022](../adr/0022-company-and-platform-entities-with-operator-assignment.md) | Company, Platform, PlatformAssignment | Proposed |
| [0023](../adr/0023-platform-access-check-and-operator-login-decoupling.md) | platform-access check; operator login decoupled from calendars | Proposed |
| [0024](../adr/0024-database-enforced-tenancy-and-authorization-integrity.md) | database-enforced tenancy and authorization integrity | Proposed |
| [0028](../adr/0028-organization-join-codes-membership-and-organization-admin.md) | join codes, membership, organization-admin authority | Proposed |
| [0029](../adr/0029-organization-admin-invitations.md) | organization-admin invitations | Proposed |
| [0030](../adr/0030-multi-organization-membership-and-revoked-state.md) | multi-organization membership, REVOKED | Proposed |
| [0031](../adr/0031-organization-service-intended-owner-of-the-hierarchy.md) | organization-service as intended hierarchy owner | Proposed (amended 2026-09-19: mechanism not designed) |
| [0039](../adr/0039-organization-ownership-and-cross-service-migration-authority.md) | ownership and cross-service migration authority | Proposed, **partly superseded by [ADR-0040](../adr/0040-organization-ownership-migration-decisions.md)** (Accepted 2026-09-20) on the passages its "Amendments to ADR-0039" lists; the rest stands. A5.2 preserves this supersession |

### 11.2 Decision and dependency matrix

"Evidence" is G6, F6 or F7 evidence. Acceptance approves a decision; it does not implement or certify it, so no status decision below
requires executing G6, G7, F6 or F7. The column names where the natural decision point lies.

| ADR | Decision | Depends on | Compatible with certified V1 | Decidable now | Evidence | Recommendation |
|---|---|---|---|---|---|---|
| 0017 | exactly one owner per Company, permanently; a CLI secret-key force-reset | 0009, 0010, 0016, 0022, 0024, 0025, 0027, 0050 | single owner: yes; the CLI and the "dual loss is unrecoverable" consequence: no (§11.3) | after OD-A5-3 | none | **REVISE** |
| 0020 | Organization entity owned by Auth; four admin routes; a dedicated organization-service rejected | 0001, 0004, 0006, 0007, 0021, 0022, 0023, 0024 | partly: entity yes, routes mostly not built (§11.3) | no | F7 (natural point) | **DEFER** to A5.3 |
| 0022 | Company, Platform and append-only PlatformAssignment in Auth; owner company-wide; bootstrap creates the Company | 0009, 0011, 0016, 0017, 0020, 0023, 0024 | partly: entities and assignment routes yes, platform CRUD not built | no | F7 (natural point) | **DEFER** to A5.3 |
| 0023 | §1 operator login and session never consult a platform calendar; §2 `GET /auth/platform-access/:platformId`, live, collapsed 404 | 0011, 0012, 0014, 0021, 0022, 0024 | yes (both implemented); the two-call example names a route that does not exist | §1 yes; the two-call pattern after OD-A5-4 | none | **REVISE** |
| 0024 | `User.kind` with Owner/Operator subtypes, mandatory tenancy FKs, DB-unique active assignment, immutable anchors | 0009, 0011, 0016, 0017, 0020, 0022, 0023; partly superseded by 0030 | yes (Auth migrations) | after OD-A5-3 and the A6 alignment | none | **DEFER** |
| 0028 | join codes, membership state machine, organization-admin authority | 0020, 0024, 0026; amended by 0029, 0030, 0042 | yes, except the license call (§11.3) | yes, after the text correction | none | **REVISE**, then recommend ACCEPT |
| 0029 | single-use admin invitations; first-admin bootstrap by an Owner with a factor step-up | 0007, 0028, 0030 | yes, except the event-delivery text | yes, after the text correction | none | **REVISE**, then recommend ACCEPT |
| 0030 | one identity, many memberships; REVOKED; no `organizationId` claim | 0001, 0024, 0028, 0029 | yes, except the license check on join | yes, after the text correction | none | **REVISE**, then recommend ACCEPT |
| 0031 | organization-service is the intended owner of Company, Platform, Organization; mechanism not designed | 0020, 0024, 0030; 0039 and 0040 build on it | intent: yes; its "today" bullets are overtaken (§11.3) | intent: yes | none | **REVISE** (forward note to 0039 / 0040), then recommend ACCEPT of the intent |
| 0039 | five phases, stable ids, verification, narrow freeze, single cutover point | 0031, 0032, 0033, 0036; partly superseded by Accepted 0040 | yes: the phase tooling is implemented, CI-tested and is what G6 rehearses | **yes** | none (0040 was accepted before G6) | **recommend ACCEPT**, keeping the partial supersession by 0040 |

### 11.3 Current behavior versus outdated text

| ADR | Outdated text | Current behavior on `main` |
|---|---|---|
| 0017 | the owner's login is ADR-0010's secret-key login; a sole owner losing password and secret key is unrecoverable; "exactly one owner row globally" | owner login is password plus a second factor, the secret key a step-up and recovery credential (Accepted ADR-0025); cool-down recovery exists (ADR-0027, named by Accepted ADR-0050 as the extreme path); the limit is the per-Company index `owner_single_per_company_v1` (ADR-0024) |
| 0020 | `POST`, `GET` (list) and `PATCH /auth/admin/organizations` in Auth | Auth exposes only `GET /auth/admin/organizations/:id`; creating and updating organizations is organization-service's `organization/admin/organizations` (inactive authority) |
| 0022 | `POST`, `GET`, `PATCH /auth/admin/platforms` in Auth | not built in Auth; platform administration is organization-service's `organization/admin/platforms`. The assignment routes exist |
| 0023 | downstream services call `GET /auth/organizations/:id` (ADR-0021) | the implemented route is `GET /auth/admin/organizations/:id` |
| 0028 | registration asks payment-service whether the organization is licensed | Auth makes no license or entitlement call (Stage 11/12 decoupling; ADR-0026, still Proposed) |
| 0029 | "nothing delivers" the events | Auth publishes through its outbox; delivery stays off in production (`AUTH_EVENTS`, A3M.8 not activated) |
| 0030 | joining another organization runs a "fail-closed license check" | no license check (as for 0028) |
| 0031 | "no new Auth route"; organization-service "not on the critical path of any other service"; the only lookup is Auth's | the mechanism is decided by 0039 / 0040; Auth's administrative first-touch flows call `ensure` in `organization-service` mode (0040 decision 2); organization-service has `organization/reference/organizations/:id` |
| 0039 | Phase C names Auth hierarchy-mutating routes | those routes never existed; already corrected in 0039's own header and in 0040's amendments |

The A5.1 version of this section and the [A1 record](core-v2-a1-architecture.md) §3 describe 0020 and 0022 as "implemented in
Auth": that is true of the entities and the assignment routes, not of the hierarchy administration routes.

### 11.4 Conflicts with Accepted ADR-0040

| ADR | Conflict | Consequence |
|---|---|---|
| 0022 | the bootstrap command creates the Company | 0040 A1.2 (AD-4): Auth never creates a Company in the authoritative mode. Accepting 0022 as written contradicts an Accepted ADR |
| 0020 | Auth is chosen as the Organization owner; organization-service rejected | 0040 decisions 1 and 2 (with 0031): after activation organization-service is the only authority and Auth holds a reference cache |
| 0031 | the cross-service mechanism is "not decided" | decided by 0039 and 0040; needs a forward note, not a contradiction of intent |
| 0039 | the superseded passages (ownership boundaries, Phase D wording, "Auth independence", rollback) | already replaced by 0040 decisions 1 to 4; the remainder stands and is consistent |
| 0023 | the two-call pattern reads Auth's organization row | after F7 Auth's row exists only once `ensure` has run (0040 decision 1): an organization never touched by Auth answers 404. Not a contradiction today; a consumer contract risk for OD-A5-4 |
| 0024 | none: 0040 decision 1 keeps the intra-Auth foreign keys and immutable anchors | 0024's integrity design survives F7; its acceptance waits on 0017 and A6, not on F7 (this corrects the A5.1 text "acceptance after F7" for 0024) |

Other conflicts carried forward: **0017 versus 0024** (a "permanent architectural invariant" versus "owner cardinality is policy, not
architecture", one droppable index); **0028 and 0030 versus ADR-0026** (out-of-date license text while ADR-0026, which removed the
call, stays Proposed under OD-A4-8); **0024 versus OD-A5-1** (immutable anchors, `ON DELETE RESTRICT` and no reparenting operation, with
0040's interim invariant I2, bound any lifecycle decision; OD-A5-1 is now decided by [ADR-0060](../adr/0060-company-platform-organization-lifecycle.md),
which keeps the anchors immutable and I2(b) as a permanent rule, §10.0).

### 11.5 Owner decisions and the ADRs they touch

Unchanged from §10 and **not resolved by A5.2**.

| Owner decision | ADRs directly affected |
|---|---|
| OD-A5-1 organization lifecycle (BD-5) | 0024 (immutable anchors, RESTRICT, no reparenting), 0020 (deletion and deactivation out of scope), 0039 (lifecycle deferred), 0040 I2, 0031; 0028 and 0030 (effect on memberships, join codes, invitations) |
| OD-A5-2 initial hierarchy before activation (OPEN-5) | 0022 (bootstrap Company), 0040 A1.2 and A2.8, 0042 (the provisioning identity creates Companies only), 0031, 0039 Phase A |
| OD-A5-3 owner transfer | 0017, 0024, 0022; the Accepted owner model 0025, 0027, 0050 |
| OD-A5-4 Auth ↔ Organization dependency after F7 | 0039 ("Auth independence"), 0040 decisions 1 and 2, 0023, 0020 (Auth's organization read route), 0024 (the foreign keys that need the cache), 0031 |
| OD-A5-5 ownership CLI convergence | 0039 (phase tooling), 0040 decisions 5 and 7, 0022 and 0017 (bootstrap and CLI precedent) |

### 11.6 Decidable now versus deferred

| Now (each still needs explicit owner approval) | After an owner decision | Deferred to A5.3 (post-F7 design) |
|---|---|---|
| 0039 (recommend ACCEPT); 0031 intent (after a forward note); 0028, 0029, 0030 (after text corrections); 0023 §1 | 0017 (OD-A5-3); 0023's two-call pattern (OD-A5-4); 0024 (OD-A5-3, OD-A5-1, A6) | 0020 and 0022: the likely outcome is "partially superseded by ADR-0040", not Accepted, which is an owner decision |

No status decision requires G6, G7, F6 or F7 execution; none of these gates is run by A5.2.

### 11.7 Proposed review and acceptance ordering [PROPOSED]

The one-ADR-at-a-time rule applies to **status changes**; text corrections of Proposed ADRs may share a pull request.

1. **This review record** (this record and the roadmap; no status change).
2. **ADR-0039**: recommend ACCEPT, status "Accepted, partly superseded by ADR-0040". It is the only ADR whose superseded passages are
   already replaced by an Accepted ADR, which needs no OD-A5 decision and changes no rehearsed code. Accepting a child before its parent
   0031 has precedent (0040 was accepted while 0031 and 0039 were Proposed); the owner may prefer 0031 first.
3. **ADR-0031**: forward note to 0039 / 0040, then a decision on the intent.
4. **ADR-0028, 0029, 0030**: one text-correction pull request, then three status pull requests in base-first order 0028 → 0029 → 0030.
   Decide first whether the license text is corrected in place or ADR-0026 is reviewed first (OD-A4-8, carried forward).
5. **ADR-0023**: correct the route name and add the post-F7 caveat; decide §1 now or the whole ADR after OD-A5-4 (overlaps A4 and A6).
6. **ADR-0017**: after OD-A5-3, rewrite in place, then decide.
7. **ADR-0024, then 0020 and 0022**: keep Proposed; revisit in A5.3.

### 11.8 Effort

Remaining A5.2 work (Claude-assisted): 0039 about 1 h; 0031 1–2 h; membership cluster 4–6 h; 0023 2–3 h; 0017 2–3 h after OD-A5-3;
0024, 0020, 0022 records 2–3 h. About **12–18 h**, plus one Core CI run per pull request and owner decision time.

### 11.9 Outcomes of the A5.2 decisions (2026-10-09)

§11.1 to §11.8 are the review as performed on `ffdb604` and are kept unchanged as its record; the statuses there are the statuses
**at review time**. The owner then took the decisions below, **each explicitly and separately approved**, each in its own commit. The
first was merged on its own (PR #255); the others are carried by **one grouped documentation pull request**, under the owner's grouping
rule of 2026-10-09: compatible ADR changes may share a pull request only when each ADR is individually reviewed, explicitly approved
by the owner, changed separately and recorded in its own commit; this is not bulk acceptance and does not bypass the required Core CI.
That pull request was merged as PR #256; ADR-0023 followed separately (PR #257).

| ADR | Outcome | Approval |
|---|---|---|
| [0039](../adr/0039-organization-ownership-and-cross-service-migration-authority.md) | Accepted, partly superseded by ADR-0040, with an acceptance note (environment classes, expand-only Auth schema, ADR-0042 scope, historical passages, no operational authorization) | A5.2-C; **merged**, PR #255 |
| [0031](../adr/0031-organization-service-intended-owner-of-the-hierarchy.md) | Accepted (intent), partly superseded by ADR-0039 | A5.2-D |
| [0026](../adr/0026-authentication-is-not-entitlement.md) | Accepted after two in-place revisions: registration and join make no commercial check (decision 4); paid capabilities enforce authoritative entitlement at the point of use and deny when it is missing, invalid, expired, unavailable or indeterminate (decision 2) | A5.2-E |
| [0004](../adr/0004-synchronous-fail-closed-license-validation.md) | Accepted, partly superseded by ADR-0026 and ADR-0028 (metadata only) | A5.2-E, A5.2-F |
| [0006](../adr/0006-per-user-subscription-reservation-on-license-lapse.md) | **unchanged** (reviewed: ADR-0026 supersedes no decision of it; `subscription_invalid` was ADR-0005's) | owner decision, no change |
| [0028](../adr/0028-organization-join-codes-membership-and-organization-admin.md) | Accepted after the registration license sentences were revised; acceptance note point 3 corrected later (factual only: `AUTH_EVENTS=off` writes no domain-event row); partly superseded by ADR-0030 (metadata) | A5.2-F, A5.2-H |
| [0029](../adr/0029-organization-admin-invitations.md) | Accepted with a note (no normative change); unresolved questions 1–3 stay open; partly superseded by ADR-0030 (metadata) | A5.2-G, A5.2-H |
| [0030](../adr/0030-multi-organization-membership-and-revoked-state.md) | Accepted after two in-place revisions: a member has 0..N memberships and zero grants no organization authority (owner decision of 2026-09-20, migration `0009`); joining makes no commercial check | A5.2-H |
| [0001](../adr/0001-generic-organization-id-scoping-claim.md) | its existing partial supersession by ADR-0030 is formal (metadata only) | A5.2-H |
| [0023](../adr/0023-platform-access-check-and-operator-login-decoupling.md) | Accepted after three in-place revisions: the owner rule (active owner, platform in own company, else the collapsed `404`); the two-call pattern uses `GET /auth/admin/organizations/:id`; the post-transition cache-miss contract (owner decision D1(a): local reads of validated reference rows, collapsed `404`, no ensure-on-read, no new Organization dependency, no `503` for a miss). **Merged as PR #257** | A5.2-I |
| [0011](../adr/0011-operator-time-boxed-login-code.md), [0014](../adr/0014-schedule-anchored-operator-duration.md) | Accepted, **partly** superseded by ADR-0023 (business-day gating; platform-calendar combination); their earlier "Superseded by ADR-0023" status lines overstated it (metadata only) | A5.2-I; merged as PR #257 |
| 0017, 0020, 0022, 0024 | **Proposed**; 0017 marked partly superseded and 0024 amended by ADR-0059 (§10.1) | open |

**Architecture as now recorded (no runtime change):** registration, onboarding join and invitation acceptance make no commercial
check; a member has 0..N memberships and zero grants no organization authority; Auth owns identities, memberships, join codes and
invitations; with `AUTH_EVENTS=off`, which production runs, Auth writes no domain-event row, and the central audit intents are a
separate mechanism; organization-service's hierarchy authority is **not** activated in production.

**Open items recorded by these decisions (not authorized for implementation):**
- **Paid-capability enforcement gap.** No Core service consumes billing-service's entitlement contract, billing-service is not in
  production, and enforcement at the point of use exists only as ADR-0026 decision 2's requirement (a forgotten check fails open).
- **Event contract review.** `user.registered` carries the membership audience label in a payload field named `role`
  (`auth.service.ts`, `invitation.service.ts`, `events/event-catalog.ts`), while the user's role is `member`; a follow-up for an
  Auth / A3M event-contract review. No contract is changed here.
- ADR-0029's unresolved questions 1–3 (invitation delivery, a stronger proof for org-admin minting, an organization with no admin
  left) and ADR-0030's residual risks stay open. OD-A5-2, OD-A5-4 and OD-A5-5 stay open (OD-A5-1 and OD-A5-3 are decided later: §10.0, §10.1; OD-A5-4(a)–(d): §10.2).
- **Deferred runtime test (ADR-0023, D1(a)).** No end-to-end test covers the post-transition cache miss for an owner (an entity known
  to Organization Service but not yet in Auth's reference rows answers the collapsed `404`). A test item for later, separately
  authorized work; reference-cache consistency, freshness and lifecycle stay with A5.3, OD-A5-1 and OD-A5-4.
- **OD-A4-8** (scope: review ADR-0023 and ADR-0026 for possible acceptance): both decisions are taken. ADR-0026 is Accepted on `main`
  (PR #256); ADR-0023 is Accepted on `main` (PR #257). OD-A4-8 is therefore **resolved**.

## 12. Validation per sub-stage

Documentation sub-stages: `check:repo`, `git diff --check`, link and path checks; every pull request runs full Core CI (`core-ci-passed`
is required by the `main` ruleset). Implementation sub-stages (after F7): the [V2 validation protocol](core-v2-a-baseline-and-change-safety.md#8-v2-per-capability-validation-protocol)
with the affected services' suites and `test:e2e:auth-organization`. Reused, not repeated: the A1, A2, A3M, A4 and A15 evidence. Not
part of A5: G6, any production step, Final Core Validation (the absolute last validation).

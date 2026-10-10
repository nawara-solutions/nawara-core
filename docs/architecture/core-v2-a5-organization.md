# Core V2 A5: organization

- **Status:** RECORD of the A5.0 discovery (read-only, 2026-10-08, on `main` at `f90787a`, the PR #252 merge that closed A4) and of
  **A5.1: the A5 architecture and scope record** (merged, PR #253, `ffdb604`, 24/24 checks), and of **A5.2: the ADR review record**
  (§11; read-only review on `main` at `ffdb604`, 2026-10-09). The review record (PR #254) changed no ADR status; the owner's
  subsequent, individually approved ADR decisions are recorded in **§11.9** (ADR-0039 Accepted on `main`, PR #255; ADR-0031, 0026,
  0028, 0029 and 0030 accepted on 2026-10-09 in the grouped A5.2 documentation pull request, merged as PR #256; ADR-0023 accepted on
  2026-10-09 under A5.2-I, merged as PR #257). **A5.2 — COMPLETED (2026-10-09)** (owner decision): ADR-0017, 0020, 0022 and 0024 remained Proposed until their owner
  dispositions of 2026-10-09 (§11.9: 0017 superseded by ADR-0059, 0020 by ADR-0040, 0022 partially superseded by ADR-0040 and 0022 and
  0024 kept Proposed, deferred to A6), merged with PR #263. OD-A5-3 is
  decided by ADR-0059, accepted on 2026-10-09 and merged as PR #258 (§10.1). The OD-A5-1 policy is decided by ADR-0060, accepted on
  2026-10-09 and merged as PR #259 (§10.0). OD-A5-4(a)–(d) are decided by ADR-0061, accepted on 2026-10-09 and merged as
  PR #260 (§10.2). The OD-A5-2 architecture policy is decided by ADR-0062, accepted on 2026-10-09 and merged as PR #261
  (§10.3). The OD-A5-5 and OD-A5-4(e) architecture policies are decided by ADR-0063, accepted on 2026-10-09 and merged as
  PR #262 (§10.4). **A5.3: ARCHITECTURE DESIGN COMPLETE — RUNTIME NOT IMPLEMENTED — PRODUCTION NOT ACTIVATED**; **A5.3 — CLOSED (2026-10-09,
  architecture only)**: closure PR #263 merged at `a0fd8a1` and its merged documentation verified (§10.5).
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
| A5.2 | ADR reviews, one ADR at a time (§11); each status change separately authorized | A5.1 | review record: this record and the roadmap; then `docs/adr/00xx-*.md` and the ADR index, one ADR per status-change PR | each review recorded (**done**, §11); statuses change only on explicit authorization (**done**: every reviewed ADR has an owner disposition) — **COMPLETED 2026-10-09** | docs checks; Core CI per status-change PR | 10–20 h (review record done; about 12–18 h remained at review time, §11.8; completed 2026-10-09) |
| A5.3 | post-F7 design: Auth as reference cache in steady state, retiring local mode and the legacy Company insert, the dependency decision, CLI convergence plan, and lifecycle only if decided in scope | A5.1, A5.2, owner decisions (§10) | this record; possibly a new ADR (Proposed) | designs owner-reviewed; implementation items labelled 🔴 (**design complete**; ADR-0059 to ADR-0063) — **CLOSED 2026-10-09, architecture only** (PR #263, §10.5) | docs checks; Core CI | 10–25 h |
| A5.4 | implementation of the approved A5.3 designs | **F7** and a refreshed baseline | `apps/auth-service/src/hierarchy/*`, `src/cli/owner-tools.ts`, `src/config/app-config.ts`; `apps/organization-service/src/cli/ownership.ts`, `src/admin/*`; their tests | the V2 protocol: focused tests and mutants, service regression, `test:e2e:auth-organization` | full Core CI per pull request | ⚪ about 30–150 h, set by A5.3 (implementation governance A5.4-G1 accepted 2026-10-09, §9.1; RED work stays blocked until F7) |
| A5.5 | certification | A5.4 | this record, the roadmap | the criteria A5.3 fixes | records-based; merged pull requests' CI | 3–6 h |

Design phase (A5.2–A5.3): about 20–45 h. Assumptions: about 6 productive hours a day, one Core CI run per pull request, owner decision time
excluded. The production track (§7) is separate and owner-driven.

### 9.1 A5.4 implementation governance (A5.4-G1) [ACCEPTED 2026-10-09]

> **Acceptance note (2026-10-09, architecture-owner authorization; governance documentation only).** The owner accepted A5.4-G1,
> Controlled Pre-F7 Implementation Governance. The proposal text below is kept unchanged as history; its banner "Not in force" is
> superseded by this note. **Nothing is implemented, merged, deployed or activated by this acceptance, and every task still needs its
> own explicit authorization.** Where the preserved proposal text below says proposed, not accepted or not in force, this note governs.
> 1. **GREEN / YELLOW / RED approved.** GREEN (specifications and design documents, static security-boundary checks, test-only
>    infrastructure with no shipped runtime change, documentation and draft runbooks) may be developed and merged under each task's
>    authorization (ADR-0063 §11 items only after point 2's clarification is recorded). YELLOW (additive audit-contract declarations, disabled-by-default independently testable capabilities, inert step-up
>    purposes, Notification templates without producers) is approved as a category only: each task is separately authorized, and a
>    merge into `main` additionally needs evidence of no changed behavior in deployed images, an approved image-pinning policy and an
>    explicit merge authorization; no production rollout follows. RED stays **blocked** until its applicable gate or a separately
>    approved, specific governance amendment: hierarchy lifecycle runtime and migrations; Owner transfer, steward recovery and Owner
>    lifecycle migrations; reference-repair runtime; authority modes and CLI modifications; retiring local hierarchy authority;
>    G6/G7/F6/F7 tooling; hierarchy provisioning and first-Platform operations; `allowedPlatforms` and `register-caller.sh`; Auth →
>    Organization authority changes; `AUTH_EVENTS` and A3M.8 activation; production schema migrations and feature activation. Every
>    item of the **RED** row of the Classes table below also stays blocked (among them activating authority, retiring the legacy
>    Company insert, removing or narrowing the Auth ↔ Organization dependency, `bootstrap-owner` changes and opening callers).
> 2. **ADR-0063 §11.** A separately recorded, dated clarification on ADR-0063 is approved: the F7 restriction applies to operational
>    activation and transition-sensitive changes; GREEN work may be developed and merged under its authorization; YELLOW work may be
>    developed in isolation, with merges under the extra image-safety conditions; RED runtime stays gated except a separately approved,
>    narrow exception; no authority invariant, F6/F7 gate or certification requirement is weakened. It is supported by ADR-0063's preserved
>    status block ("every stage is separately authorized and, for runtime effect, blocked until F7"), by §4 (the readiness sequence is
>    verified in the G6 rehearsal before the check ships) and by its acceptance item 7 (every step separately authorized). The note
>    itself is the **next, separately scoped documentation action**; it is not in this commit. **Until it is recorded, no ADR-0063 §11
>    item (including A5.4-T1 and A5.4-A5) is developed or merged.**
> 3. **Certified digest-set policy approved.** G6 selects and rehearses one exact certified image-digest set (auth-service,
>    organization-service, audit-service), recording each digest, its approved configuration, the deployment script and release
>    context, which services redeploy at F6/F7, the G6 rehearsal and certification evidence, and the re-rehearsal required when any
>    digest or relevant configuration changes. F6/F7 use only that set, including configuration-only redeploys such as the F6 Auth mirror. The control is procedural until enforcement is separately
>    implemented. No digest is chosen and nothing is deployed now; workflows and credentials are unchanged; each service's first
>    production digest deployment stays separately authorized.
> 4. **A5.4-A5 pre-G6 exception to RED approved as a design.** A future, separately authorized implementation may add Auth's `/ready`
>    configuration/marker consistency check, in Auth only (read-only marker access; tests for permitted, forbidden and unreadable states;
>    the readiness reason and alert; no new startup database dependency; `/auth/health` verified unchanged and kept database-only,
>    outside the deploy health path). Its merge also needs the image-pinning approval. Prohibited: marker mutation, trigger, CLI or `ensure` changes, migrations,
>    deployment-script changes and any local-authority fallback. The exact F6 TRANSITIONAL behavior stays **OPEN** and must be specified
>    before any transition-dependent behavior is implemented or the check's merge is approved; the check is certified in G6 with the
>    approved digest and configuration. **No A5.4-A5 implementation is authorized by this acceptance.**

> **Update (2026-10-09, separately authorized).** The ADR-0063 §11 clarification of point 2 is now recorded
> ([ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md) §11). ADR-0063 §11 items, including A5.4-T1 and
> A5.4-A5, may therefore proceed only under their class and their own individual authorization; nothing is implemented, merged,
> deployed or activated by this update, and production activation stays blocked.

> **Update (2026-10-10, F6 readiness rulings; separately authorized).** The F6 TRANSITIONAL behavior that point 4 above left open is
> ruled in principle by the owner and recorded as a dated clarification on
> [ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md) §4: every source/marker disagreement is not ready
> with a direction-specific reason, including inside the attended F6 window; the mirror is source first; a `frozen` marker is not
> ready on the fresh path; `/ready` stays monitoring-only and `/auth/health`, the container healthcheck and the deploy wait are
> unchanged. Point 4's other conditions stand. **No A5.4-A5 implementation is authorized by this update**; the certified G6 plan
> and the active runbooks are unchanged, and wrong-side restore detection stays open. The owner later confirmed source first with the
> record's required design safeguards and no new technical write guard (2026-10-10).

> **Not in force.** This section is a proposal for the architecture owner (2026-10-09). Until it is explicitly approved, §6, §7, §8, the
> A5.4 row of §9 and the roadmap stay the effective gates: A5.4 stays **blocked until F7 (🔴)**. Nothing here authorizes code, a merge,
> a deployment or an activation, and no Accepted ADR is amended by it.

**Why.** The A5.4 readiness audit (2026-10-09, a read-only investigation reported to the owner; not a repository record) found that
"blocked until F7" (§9 A5.4 row; roadmap) and §6's 🔴 row ("anything that changes the code G6 rehearses") sit uneasily with three
facts: the V2-A definition of 🔴 ("meaningful implementation genuinely needs the post-F6/F7 ownership state",
[V2-A record](core-v2-a-baseline-and-change-safety.md) §2); ADR-0063 §4, which requires the F6 sequence of Auth's source/marker
readiness check to be verified in the G6 rehearsal before the check ships, so the check's code must be in the rehearsed build; and the
A0 / V2-A.2 digest deployments, under which a merge builds an image but never deploys it.

**Stage ids used here.** A5.4-T1: the static Auth never-call boundary check (ADR-0063 §5 and §11, "the static boundary test"; ADR-0042
decision 8). A5.4-A5: Auth's source/marker readiness check (ADR-0063 §4 and §11, "Readiness check and alert").

**Four execution boundaries, each needing its own owner approval.**

| Boundary | Meaning |
|---|---|
| develop | code on an unmerged branch; local tests only. Unmerged branches build no attested image and cannot be deployed (the image workflows publish only on pushes to `main`; pull requests build but never push; the deploy workflows accept only an attested `main` digest whose revision is an ancestor of `main`) |
| merge | the change enters `main`; an immutable image is built, never deployed |
| deploy | an explicit, owner-authorized deployment of an exact digest |
| activate | a gate, flag, configuration or production step turns behavior on |

**Classes (proposed).**

| Class | Content | Develop | Merge | Deploy / activate |
|---|---|---|---|---|
| **GREEN**: preparation and behavior-neutral | implementation specifications (SDD/TDD); static security-boundary checks in the repository checks (A5.4-T1); non-mutating test infrastructure; documentation and runbook drafts | yes, once this proposal is approved | yes, through the normal PR and CI | nothing to activate |
| **YELLOW**: additive and inert | new audit-contract declarations (consumer-first); disabled-by-default future capabilities; new step-up purpose declarations that cannot activate anything; Notification templates with no active producer | only with a **separate implementation authorization** per item | only if the item **both** changes no deployed image's behavior **and** the image-pinning decision below is approved; feature flags being off is **not** sufficient on its own | each deployment and activation separately authorized; runtime effect still waits for its ADR gate |
| **RED**: authority- and transition-sensitive | activating authority; hierarchy lifecycle schema and runtime; Owner transfer and recovery; reference-repair runtime; authority-mode changes and changes to either CLI (Auth `hierarchy-*`, Organization `ownership`, `bootstrap-owner`); retiring `local` mode or the legacy Company insert; removing or narrowing the Auth ↔ Organization dependency (OD-A5-4(e)); F6/F7 tooling and hierarchy provisioning changes (including `register-caller.sh`, the first Platform and `allowedPlatforms`); opening callers; any `AUTH_EVENTS` change; production migrations and activation | **blocked** (§6, §7) | blocked | blocked until the applicable gate, or an explicit governance amendment authorizing a narrower scope |

**Image-pinning dependency (cutover record §8, §13).** No YELLOW change that alters a deployed image's contents (auth-service,
organization-service, audit-service; `libs/service-kit` and `libs/audit-contract` alter all three) is merged before the owner approves
the image-pinning decision. Proposed answer, **not accepted**:

- At the G6 baseline refresh the owner records one **certified digest set**: one attested index digest each for auth-service,
  organization-service and audit-service, stating for each whether it is redeployed at F6/F7.
- G6 rehearses exactly that set. F6 and F7 deploy only that set through the digest-deploy workflows (which never build); this includes
  **configuration-only redeploys** such as the F6 Auth mirror (`AUTH_HIERARCHY_SOURCE`), which re-run `provision-and-deploy.sh` from the
  image and therefore must use the certified digest.
- A later merge to `main` changes no digest in the set; any change to the set, including a `libs/service-kit` or `libs/audit-contract`
  change, requires a re-rehearsal.
- **Enforcement is procedural:** the deploy workflows accept any attested `main`-ancestor digest. The owner's approval record in the G6
  baseline names the set, and each F6/F7 deployment's digest input must equal it.
- Production runs images that predate the immutable builds (§10–§13 of the cutover record); the deploy workflows refuse them. Adopting
  the set therefore means a first digest deployment of each service before or at the G6 refresh, which is a **production mutation**
  needing its own owner authorization.

**Pre-G6 exception for A5.4-A5 (Auth readiness check), proposed.** A5.4-A5 is **RED** (it changes the deployed Auth image's `/ready`
behavior and is authority-adjacent), and this is a narrow **exception** to RED, not a YELLOW item. Developing it needs a separate
implementation authorization; merging it also needs the image-pinning approval above. Each step is still separately authorized:

- **Code scope:** Auth only. One readiness check registered in the kit's readiness registry (`/ready`) that reads the existing
  `hierarchy_authority` marker and `AUTH_HIERARCHY_SOURCE`, plus its tests. No change to the marker, its triggers, the `hierarchy-*`
  commands, `bootstrap-owner`, `ensure`, migrations, deploy scripts or `/auth/health`. Startup gains no database dependency.
- **Not in the deploy health path:** `/auth/health` (the container healthcheck and the deploy wait in
  `apps/auth-service/deploy/provision-and-deploy.sh`) stays a database-only check, so the attended F6 mirror cannot be blocked by it.
- **Steady state, fail closed:** `local`/`local` (only until F6) and `org_authoritative`/`organization-service` are ready; `frozen`, any
  other combination, and a missing, invalid or unreadable marker are not ready, with a named reason and an alert; never a fallback to
  local authority.
- **Open design item: the TRANSITIONAL state.** The check reads only the marker and the source, not Organization's phase, so it cannot by
  itself tell the attended F6 window (runbook `organization-production.md` §6.2) from a mismatch such as a restored pre-F6 marker. How it
  does (for example an explicit, operator-set transitional window) is decided in the SDD/TDD and certified in the G6 rehearsal; this
  proposal does not decide it.
- **Images:** it reaches production only inside the certified digest set; until then it is merged at most, never deployed alone.
- **Deliverables:** tests for every source/marker combination and the unreadable marker; `/auth/health` unchanged; the F6 sequence in the
  G6 VM; the runbook statement that `/ready` never checks authority (`organization-production.md` §6.1), and its alert rule treating Auth not
  ready as critical (§6.3), updated when the check ships so the attended TRANSITIONAL window is accounted for.
- **Rollback limits:** before F6, redeploying an earlier certified digest removes the check, but only a labelled and attested digest is
  deployable (today's production images are not). After F6 the authority one-way door stands regardless of the check.

**A5.4-T1** (the static boundary check) is GREEN under this proposal and could proceed once the proposal, and the ADR-0063 reading below,
are approved.

**Relationship to Accepted ADRs.** ADR-0059, ADR-0060, ADR-0061 and ADR-0062 block **runtime effect** until F6/F7 and use default-off
gates, which this proposal keeps. **ADR-0063 §11** heads its whole stage list "blocked until F7", including the readiness check and the
static boundary test, without that qualifier. Approving this proposal therefore needs one of two owner decisions: **(i)** record that
ADR-0063 §11 is read as blocking runtime effect and deployment, not repository development and merging under this governance; or
**(ii)** add a separately approved clarifying note to ADR-0063 §11. Until then, this proposal does not claim that no ADR change is
needed. It also narrows this record's §6 🔴 row and the roadmap's A5.4 label, which are not ADRs.

### 9.2 A5.4 task progress

| Task | Class | State |
|---|---|---|
| A5.4-G1 implementation governance | – | Accepted 2026-10-09; merged as PR #266 (§9.1) |
| A5.4-T1 static Auth boundary check | GREEN | merged as PR #267 (2026-10-10): `checkAuthOrganizationBoundary` in `scripts/lib/checks.mjs`, run by `npm run check:repo`; a syntax-level check with documented limits |
| A5.4-D1 implementation specifications | GREEN | merged as PR #268 (2026-10-10): [`core-v2-a5-4-implementation-specifications.md`](core-v2-a5-4-implementation-specifications.md); documentation only, decides nothing |
| A5.4-D2 operational runbook drafts and readiness specifications | GREEN | merged as PR #269 (2026-10-10): [`core-v2-a5-4-operational-runbooks.md`](core-v2-a5-4-operational-runbooks.md) and the OPEN decision record [`core-v2-a5-4-f6-transitional-readiness.md`](core-v2-a5-4-f6-transitional-readiness.md); documentation only; no active runbook, plan or tool is edited, no approach or digest is selected |
| F6 readiness and mirror-order rulings | GREEN (documentation) | owner rulings in principle recorded 2026-10-10 on its own branch: a dated clarification on [ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md) §4 and the Decision of [`core-v2-a5-4-f6-transitional-readiness.md`](core-v2-a5-4-f6-transitional-readiness.md). Not ready with direction-specific reasons; source-first mirroring; `/ready` monitoring-only. The G6 plan and the active runbooks are unchanged; A5.4-A5 is not authorized |
| A5.4-AC1 reference-repair audit contract (decision) | YELLOW (decision recorded; no code) | owner decisions of 2026-10-10 recorded on its own branch: [`core-v2-a5-4-ac1-repair-audit-contract.md`](core-v2-a5-4-ac1-repair-audit-contract.md). Two producer-less actions, `hierarchy.reference_repaired` and `hierarchy.reference_repair_denied`; the collapsed `404`, operational failures and anchor mismatch stay open and block A5.4-A3 (decided in principle by batch 2, below). No library change; implementation needs its own authorization |
| A5.4-AC1 batch 1 declarations | YELLOW | merged as PR #272 (2026-10-10): `hierarchy.reference_repaired`, `hierarchy.reference_repair_denied`; producer-less; not deployed |
| A5.4-AC1 batch 2 decisions | YELLOW (decision recorded; no code) | owner decisions D1 to D4 of 2026-10-10 recorded on its own branch: [`core-v2-a5-4-ac1-batch2-decisions.md`](core-v2-a5-4-ac1-batch2-decisions.md) and [ADR-0064](../adr/0064-reference-repair-failure-and-incident-audit.md) (Accepted; partly supersedes the ADR-0061 §6 failure chain for infrastructure failures; records D1, D3, D4 as new policy). Two proposed actions; producers not authorized (declarations since merged, PR #274) |
| A5.4-AC1 batch 2 decisions, ADR-0064 | YELLOW (documentation) | merged as PR #273 (2026-10-10) |
| A5.4-AC1 batch 2 declarations | YELLOW | merged as PR #274 (2026-10-10): `hierarchy.reference_repair_unresolved`, `hierarchy.reference_anchor_mismatch_detected`; producer-less; not deployed |
| A5.4-A1 `hierarchy.reference.repair` step-up purpose | YELLOW | merged as PR #275 (2026-10-10): factor-only; consumed by no Auth route (the generic verify can still burn a proof: §9.3 S1); not deployed |
| A5.4-A2 and A5.4-A3 narrow RED exception | RED (exception accepted) | **accepted 2026-10-10** with [ADR-0065](../adr/0065-reference-repair-pre-f7-development-and-step-up-consumption.md) (proposed in PR #276): §9.3. In force. A2 is designed, implemented and merged (rows below); A3 has a design and test plan only (authorization 1, documentation); no A3 development is authorized or started |
| A5.4-A2 design and test plan | RED exception, authorization 1 of 7 (documentation) | merged as PR #278 (2026-10-10): [`core-v2-a5-4-a2-ensure-split-design.md`](core-v2-a5-4-a2-ensure-split-design.md) |
| A5.4-A2 implementation: the `ensure` resolve/place split | RED exception, authorizations 2, 4 and 5 of 7 | **merged as PR #279 (2026-10-10, merge commit `d5a8cbb`) and validated**: `HierarchyReference.ensure` now runs a private read-only resolve step and a private place step; behavior unchanged (15 golden-trace scenarios identical to `main` at `bb36ea3`, mutation tests, source-`local` proofs, full Core CI green). **Not deployed and not activated**: no image containing it is selected or deployed (authorization 6), and it has no emission or activation of its own. **G6 timing still applies** (§9.3 A.3): whether this merge precedes the G6 baseline refresh is not recorded and remains OPEN; the owner decides at certified-digest-set selection, and a selection made before `d5a8cbb` would need a separately authorized re-rehearsal |
| A5.4-A3 design and test plan | RED exception, authorization 1 of 7 (documentation) | merged as PR #280 (2026-10-10): [`core-v2-a5-4-a3-reference-repair-design.md`](core-v2-a5-4-a3-reference-repair-design.md); no code; local A3 development not authorized |
| A5.4-A3 owner rulings on the seven blocking decisions | RED exception (this documentation of rulings only; no code). The class of the O2 prerequisite task was not ruled by it (ruled afterwards: next row) | merged as PR #281 (2026-10-10): O1, O2, O3, O4, O5, O11 and O12 ruled (the design's §11.1; note below §9.3's acceptance note). O6 to O9 and O13 to O15 stay open (O10 since ruled, next row). **A3 stays blocked**: the O2 producer-scope prerequisite task is not authorized or started, and local A3 development is not authorized |
| A5.4-A3 owner rulings on O10 and on the O2 task | documentation of rulings only; no code | merged as PR #282 (2026-10-10; the design's §11.3): the O10 names and file boundaries are ruled; the **O2 producer-scope task is classified GREEN** (static repository checks, tests and documentation, no runtime change) **with two additional merge conditions**: a separate explicit owner approval before its merge, and verifiable evidence, from actual build inputs or produced images, that it changes no shipped runtime image contents. O2 may trigger the three image builds and deploys nothing. **Neither O2 nor A3 is authorized or started**; O6 to O9, O13 to O15, one O5 sub-point, and the local record types and log line stay open |
| A5.4-A3 O2: producer-scope enforcement relocation | GREEN, with two additional merge conditions | merged as PR #283 (2026-10-10): the two producer-less assertions of `libs/audit-contract/test` are replaced, in one change, by the repository check `checkRepairAuditProducerScope` (`npm run check:repo`), with equal or wider coverage (the design's §11.4). A check relocation, **not an audit producer activation**: no application, catalog or contract change. The four approved paths are enforcement boundaries only. The image-content evidence is recorded in PR #283. **A3 remains blocked**; deployment and activation permissions are unchanged |
| A5.4-A3 owner rulings on the remaining decisions | documentation of rulings only; no code | recorded 2026-10-10 on its own branch (the design's §11.5): O6, O9, O13, O14 and O15, the cached-Platform classification and the local diagnostics are recorded; for O7 a deferral of the metric to the A12 observability workstream is recorded for local implementation, merge and deployment (dated clarification on ADR-0064), and the owner's confirmation is still required for activation; **O8 is ruled as a contract and stays conditional** on evidence the implementation must produce, with a proposed fallback awaiting the owner's confirmation; the response code of an unreadable marker is proposed, not ruled. O15 makes the repair eligible only with source `organization-service` **and** marker `org_authoritative` (dated clarification on ADR-0061) and corrects the design's earlier statement about the marker. **A3 development is not authorized** |
| F6 follow-up: first-touch `ensure()` and the authority marker | OPEN; not part of A3; no change made | recorded 2026-10-10: `ensure()` does not read the authority marker. With source `organization-service` and marker `local`, Auth's database accepts ordinary hierarchy writes, so a first touch would place rows from Organization Service as local rows; today only Organization Service's "not authoritative" answer prevents it. The startup warning `hierarchy_source_mismatch` says first touches "fail closed until configuration and marker agree", which overstates what the code enforces. To be examined with the F6 transition work, under its own authorization. `ensure()` is unchanged |

**Owner classification rulings (2026-10-10; classification only, no implementation authorized):** A5.4-AS1 (audit-service acceptance
of the `steward` user kind, including its database CHECK change) is **RED**; A5.4-K1 (service-kit runtime `adminTier` fail-closed
validation) is **RED**; A5.4-AC1 (additive, producer-less audit-contract declarations) stays **YELLOW**; A5.4-D1 and A5.4-D2
(documentation) stay **GREEN**.

No RED task is authorized or started. The YELLOW items above are merged as producer-less or consumer-less declarations; nothing is
implemented as runtime behavior in a service, deployed or activated.

### 9.3 Narrow RED exception for A5.4-A2 and A5.4-A3 [ACCEPTED 2026-10-10]

> **Acceptance note (2026-10-10, architecture-owner acceptance; governance documentation only).** The owner accepted this section
> together with [ADR-0065](../adr/0065-reference-repair-pre-f7-development-and-step-up-consumption.md), which is now Accepted. The
> proposal text below is kept unchanged as history; its banner "Not in force" and its words "proposed", "if accepted" and "not accepted"
> are superseded by this note. **The exception is in force, and acceptance alone authorizes no implementation.**
> 1. **Scope.** The exception applies only to A5.4-A2 (the `ensure` resolve/place split) and A5.4-A3 (the repair route, with S1 and S2
>    as decided in ADR-0065), within A.1. Every other RED item stays governed by §9.1, unchanged; first-touch mismatch recording stays
>    excluded.
> 2. **Seven separate authorizations stay required** (A.2): design documents and test plans; local A2 development; local A3
>    development; each commit and each pull request; each RED-exception merge; each deployment; audit emission and activation after
>    their prerequisites. None has been requested or granted. No authorization advances the next.
> 3. **Unchanged restrictions.** The automatic stop conditions (A.5); the certified digest-set and G6 timing rule (A.3); the rule that
>    deployment and runtime effect stay blocked by the Audit consumer deployment, F6/F7 and the production prerequisites; the common
>    prohibitions of A.1.
> 4. **Clarifications confirmed with ADR-0065's acceptance:** the fail-closed `503` covers an **uncertain** consume outcome (no lookup,
>    no placement, no automatic retry with the same proof); S1 **clarifies** ADR-0042 Amendment 1 A.1 and supersedes nothing; and
>    **while Auth's source is `local` the repair route emits no new central repair-audit action, including for a non-Owner request
>    refused with `403`** (this completes A.4; existing unrelated producers and separately required local diagnostics or security
>    records are unaffected).
> 5. **C1** is closed by ADR-0065: local implementation and merge may precede the production Audit Service deployment and F7 under this
>    exception; production deployment, production audit emission and activation may not.
> 6. **Reading the preserved text.** "(if accepted)", "(**Proposed**)", "Until ADR-0065 is Accepted", "only after ADR-0065 … Accepted" and
>    "Neither S1 nor S2 nor C1 is accepted" below describe the state before acceptance. In A.5, the stop condition for a route that "writes anything"
>    with source `local` is not narrowed: it still means any write at all, including a reference placement or any other hierarchy or
>    cache write, any new repair audit (local or central), outbox row or central record, and any proof consumption. Only the unchanged
>    emission of existing, unrelated producers and existing security logging is outside it.

> **Owner rulings on the A3 blocking decisions (2026-10-10; documentation only).** Recorded in full in the
> [A3 design](core-v2-a5-4-a3-reference-repair-design.md) §11.1. They supersede no Accepted ADR, widen nothing in A.1 and authorize no
> development, merge, deployment, emission or activation. Three of them touch this section:
> 1. **A.5, bounded exception for S1 (O1).** S1 is implemented as ADR-0065 §4 defines it: for the repair purpose only, the generic
>    `POST /auth/step-up/verify` answers `403 step_up_required`, consumes nothing, keeps its existing local denial record, and adds no
>    central audit event, outbox row or hierarchy write. The stop condition "any existing … step-up or verify test changes behavior"
>    admits only the six A1 tests named in the design's §11.1. Every other stop condition stands unchanged; the repair route stays
>    fully inert with source `local` (A.4); and compatibility with the images actually deployed must be demonstrated before any
>    RED-exception merge.
> 2. **A.5, `libs/audit-contract` (O2).** A3 itself makes no change under `libs/`. The producer-less assertions are relocated into an
>    equivalent phase-aware repository check by a **separate prerequisite task** with its own development, review, CI and merge
>    authorization, never leaving an interval without enforcement. That task is not authorized here.
> 3. **Residual risk (O12).** A `503` for an integrity anomaly found before the Company is established is accepted as ADR-0061's
>    sequence dictates; for another Company's uncached id it can reveal that the id exists. This is accepted for that case only.
>
> The other rulings (O3, O4, O5, O11) concern the repair's internal design and change nothing here.

> **Not in force.** This is a proposal for the architecture owner (2026-10-10). Until the owner explicitly accepts it, A5.4-A2 and
> A5.4-A3 stay **RED and blocked** under §9.1, and this section authorizes no work beyond this documentation: no design work, code,
> commit, pull request, merge, deployment or activation. Acceptance would be recorded as a dated acceptance note in this section, as in
> §9.1; this banner stays until that note exists. Accepting it would itself authorize nothing either: every step in A.2 needs its own
> authorization.

**Basis.** §9.1 item 1 keeps RED work blocked "until its applicable gate or a separately approved, specific governance amendment", and
[ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md) §11 (clarification of 2026-10-09) keeps RED implementation
blocked "apart from explicitly approved, narrowly scoped exceptions" (§9.1 item 2 words it "a separately approved, narrow exception"). §9.1 item 4 (A5.4-A5) is the precedent. This proposal narrows the RED row for two
items only; it changes no Accepted ADR, no other RED item, no F6/F7 gate and no certification requirement. The repair semantics stay those
of [ADR-0061](../adr/0061-auth-hierarchy-reference-repair-and-diagnostics.md) as partly superseded by
[ADR-0064](../adr/0064-reference-repair-failure-and-incident-audit.md); in particular the route is disabled while Auth's hierarchy source
is `local` (ADR-0061 §4).

#### A.1 Scope (if accepted)

| Item | Permitted, each under its own authorization | Prohibited |
|---|---|---|
| **A5.4-A2**: the `ensure` resolve/place split | refactor `HierarchyReference.ensure` (`apps/auth-service/src/hierarchy/hierarchy-reference.ts`) into a read-only resolve step and the existing guarded place step; `ensure` keeps its exact external behavior (fetch order, early returns, the single placement transaction, `ON CONFLICT DO NOTHING`, the anchor re-read, the `hierarchy_anchor_mismatch` log and `503`, the `false` for a missing target); focused equivalence and regression tests | any new authority, caller or capability; the repair-only cached-ancestor comparison of ADR-0061 §4 step 4 inside `ensure`; any change to the first-touch callers or the owner bootstrap |
| **A5.4-A3**: the repair route, **only after ADR-0065 (C1, S1, S2) and this section are Accepted** | the Auth repair route and service implementing ADR-0061 §4 and §5 as amended by ADR-0064 §4; the dedicated committed proof consumption (S2); the generic-verification restriction (S1, as decided in ADR-0065); the producers of `hierarchy.reference_repaired`, `hierarchy.reference_repair_denied`, `hierarchy.reference_repair_unresolved` and `hierarchy.reference_anchor_mismatch_detected` **for the repair path only** (the mismatch record only with `operation` `reference_repair`), placed in the repair service and never in the shared `HierarchyReference.place`, so first-touch behavior and recording stay unchanged; the A5.4-T1 allow-list entry for the repair operation only (`scripts/lib/checks.mjs`); focused security and integration tests | recording an anchor mismatch from first-touch `ensure` (a separate RED decision); any other T1 entry; any route reachable with source `local` |

**Common prohibitions (both items):** changing a production hierarchy source or marker; enabling repair while the source is `local`; any
migration or schema change; any organization-service change; any audit-catalog change; any change to unrelated Auth behavior or to existing
first-touch recording; deploying an image outside the certified-digest-set treatment (A.3); any production audit emission before the
consumer is ready (A.3); bypassing G6, G7, F6 or F7; combining A2 and A3 in one change.

#### A.2 Separate authorizations

1. Preparing design documents and test plans (no code).
2. Local A2 development.
3. Local A3 development, only after ADR-0065 and this section are Accepted.
4. Each commit and each pull request.
5. A RED-exception merge approval for each pull request, in addition to the YELLOW conditions of §9.1 (no changed behavior in deployed
   images, the approved image-pinning policy) and the timing rule of A.3.
6. Each deployment of an image containing the code.
7. Activation: only after F6 and F7, with Auth's source `organization-service` and the audit-service deployment of A.3 done.

Accepting this proposal grants none of these; each is requested and approved on its own.

#### A.3 G6 and deployment sequencing

- **Certified digest set.** Code merged under this exception is in the next auth-service image. It must be merged **before the G6
  baseline refresh** that selects the certified digest set, so G6 rehearses it; if it is merged after that selection, the set changes
  and a separately authorized re-rehearsal is required (§9.1 item 3).
- **Consumer first.** No production emission of the four repair actions before an audit-service image that declares them is deployed
  (separately authorized). Production audit-service runs an image that predates them. The audit-service digest in the certified set
  must declare all four actions (PRs #272 and #274).
- **C1: the implementation-order condition of ADR-0061.** ADR-0061's acceptance item 2 requires, "before any implementation or
  activation", that the production Audit Service supports the repair actions and that the F6/F7 prerequisites are met. Read
  literally, it forbids writing A3 before that deployment and before F7. Because Accepted ADRs are immutable, this exception does **not**
  reinterpret it: it depends on [ADR-0065](../adr/0065-reference-repair-pre-f7-development-and-step-up-consumption.md) (**Proposed**),
  which would partly supersede that condition for **local implementation and merge only** (the owner's direction C1-a, in principle,
  2026-10-10). Production deployment, production audit emission and F6/F7 activation stay gated exactly as before. Until ADR-0065 is
  Accepted, A3 is not developed (A2 does not depend on it).
- **Merge is not deployment.** A merge approval never implies a deployment; each production deployment is separately authorized.
- The G6 rehearsal runs the route inert (source `local`) as part of the A.4 evidence, before activation is rehearsed.

#### A.4 Proof of inaccessibility before activation (required evidence for A3)

With Auth's source `local` (an e2e test on the real application):
- an unauthenticated caller gets `401` and a non-Owner `403`, before anything else (ADR-0061 §4 step 1);
- for an active Owner the route answers the collapsed `404`, **identical** for a valid proof, an invalid proof and another Company's id;
- the supplied proof's `consumedAt` stays NULL; no reference row is placed; no outbox row and no central or local audit record is
  written; the Organization Service client records **zero** calls.

With the source `organization-service` in tests: every row of ADR-0061 §5 as amended by ADR-0064 §4 is reproduced (including `400`,
`429`, the already-cached `200` and concurrent repairs), and S2's concurrency and failure cases.

#### A.5 Automatic stop conditions

Work stops, and is reported, if:
- any existing hierarchy, first-touch, bootstrap, step-up or verify test changes behavior, or the A2 equivalence tests fail;
- the T1 check needs any entry other than the repair operation;
- a migration, a schema change or an organization-service change becomes necessary;
- a change in `libs/service-kit` or `libs/audit-contract` becomes necessary (it changes all three service digests);
- an audit-catalog change becomes necessary;
- the generic `consume()` semantics would have to change;
- S1 or S2 needs more than described;
- the route is reachable, consumes a proof or writes anything with source `local`, or any observable behavior of a deployed image
  changes with source `local`;
- a merge would change the certified digest set without an authorized re-rehearsal;
- at activation, the deployed audit-service image does not declare the four actions;
- the scope of A.1 would have to grow.

#### A.6 Rollback

Before merge: nothing to undo. After merge, before deployment: revert the pull request. After deployment, before F6: the route is
inert with source `local`; redeploy the previous attested digest, if one exists, through the digest-deployment procedure. After F6:
ownership rollback follows ADR-0040 A2.6 (no automatic rollback after the one-way door), and image changes use only the certified
digest set. No rollback undoes reference rows already placed (never deleted), proofs already consumed or audit records already emitted
(append-only).

#### A.7 A3 security decisions for the owner [PROPOSED]

The owner's directions in principle (2026-10-10) are S1, S2, and `503` for a failed consumption. Their exact wording is decided in
[ADR-0065](../adr/0065-reference-repair-pre-f7-development-and-step-up-consumption.md) (**Proposed**) §4 and §5; summary:

**S1. Generic verification refuses the repair purpose.** `POST /auth/step-up/verify` refuses `hierarchy.reference.repair` before any
consuming statement, so a calling service cannot burn a repair proof and the proof stays usable by the repair route. The answer is the
endpoint's existing `403 step_up_required`, which it already gives for an unknown purpose, a wrong purpose or an invalid proof, so it
reveals nothing new. Every other purpose, the endpoint's authentication and service authentication are unchanged. ADR-0065 records it as
a clarification of ADR-0042 Amendment 1 A.1 (which names no purpose list): it narrows the endpoint for a purpose that did not exist when
A.1 was written, and a documentation follow-up is required (the endpoint's API description, a dated ADR-0042 note, the
`step-up.service.ts` comment).

**S2. Dedicated committed proof consumption.** Used only by the repair route; the existing `consume()` is unchanged for every other
purpose. One atomic statement consumes the proof only if Owner, session, purpose, unused, unexpired **and the allowed method** all hold;
it runs in its own transaction, committed before any hierarchy lookup; of two concurrent requests with the same proof, exactly one
consumes it. Outcomes: an invalid, expired, used or mismatched proof → `403 step_up_required` (ADR-0064's refusal row); a consumption
confirmed committed → continue; a consume transaction confirmed failed → `503 hierarchy_unavailable` with local evidence only; an
**uncertain** outcome → `503`, fail closed, with bounded local evidence. An uncertain outcome is not proof of consumption: Auth never
proceeds on it and never retries it; if the client re-presents the proof, that request's atomic statement decides, or the client
obtains a fresh proof.

Neither S1 nor S2 nor C1 is accepted by this proposal; they take effect only if ADR-0065 and this section are Accepted.

## 10. Owner decisions [PROPOSED, not approved]

| Id | Decision needed | Notes |
|---|---|---|
| OD-A5-1 | **BD-5 organization lifecycle** (deletion, archive, deactivate, suspend, restoration, reparenting): in A5 scope or not | no decision existed; organization-service has no status column or delete path. **Policy decided 2026-10-09** (§10.0; ADR-0060, merged as PR #259) |
| OD-A5-2 | **OPEN-5**: whether initial Platforms or Organizations must exist before activation in a fresh environment | ADR-0040 A2.8; not blocking Stage 10.1. **Decided 2026-10-09** (§10.3; ADR-0062, merged as PR #261) |
| OD-A5-3 | **Owner transfer**: in A5 scope or not | ADR-0017 keeps one owner per Company permanently; no transfer decision exists. **Decided 2026-10-09** (§10.1; ADR-0059) |
| OD-A5-4 | **Transitional dependencies**: after F7, remove, keep or narrow the two-way Auth ↔ Organization dependency and Auth's `local` mode | ADR-0056 `[COMPAT]` and `[DEFERRED: A5 / F6 / F7]`. **(a)–(d) decided 2026-10-09** (§10.2; ADR-0061, merged as PR #260); the dependency question itself, (e), is **decided 2026-10-09** (§10.4; ADR-0063, merged as PR #262) |
| OD-A5-5 | **Ownership CLI convergence**: after F7, move `ownership` and Auth's `hierarchy-*` commands onto the kit's `EnvReader`, retire them, or keep them | excluded from A2 / A15; must not change before F7. **Decided 2026-10-09** (§10.4; ADR-0063, merged as PR #262) |

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
- **Blocked:** any lifecycle runtime until F6/F7 (§6, §7). No lifecycle functionality is implemented or activated. A5.3 was not complete then; it is now CLOSED (2026-10-09, architecture
  only, §10.5), and no lifecycle runtime is implemented.

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
- **Not done:** no steward provisioning (OD-S1 deferred), no runtime change, no migration, no activation of either gate. A5.3 was not complete then; it is now CLOSED
  (2026-10-09, architecture only, §10.5).


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
- **Open:** none of OD-A5-4 remains open at the architecture level: (e) and OD-A5-5, including the diagnostic CLI conventions, are
  decided (§10.4); OD-A5-2 is decided (§10.3).

### 10.3 OD-A5-2 design progress (2026-10-09)

- **Policy direction approved by the owner (OD-A5-2(a)–(f)), subject to final ADR review (since accepted; see Design below):** (a) the pre-activation hierarchy of a
  fresh environment is exactly the provisioned Company, and the certified F2, F3 (no-op), F4 and F5 stand; (b) the first Platform only
  after a certified G6, a completed G7, F6 and F7, a verified post-F7 backup and a separate attended authorization, created by the active
  Owner through Organization Service's human administration; (c) the one-time provisioning credential must not stay able to create
  Companies after the transition (a controlled disablement step, designed and verified before implementation; no ownerless Company);
  (d) a separately approved, audited, attended change-control procedure adds each new Platform to Auth's `allowedPlatforms` before any
  first touch or ADR-0061 repair; (e) new entities start `ACTIVE`, with an explicit, validated backfill of the existing Company in
  ADR-0060's L2 stage; (f) the certified F4 record is the historical evidence of the bootstrap, no audit record is backdated, and the
  missing `bootstrap-owner` audit is a recorded gap.
- **Design:** [ADR-0062](../adr/0062-initial-hierarchy-provisioning-and-first-platform-sequencing.md), drafted as Proposed (2026-10-09)
  and **Accepted on 2026-10-09 (A5.3 OD-A5-2 owner authorization) and merged as PR #261**; the OD-A5-2
  architecture policy is decided. The tension it reported (ADR-0042 D1, A.2 and A.5 and ADR-0040 A2.5 name a provisioning identity for
  later Companies, while ADR-0062 retires the current credential) is resolved by the owner as a clarification of the deployment-credential
  lifecycle, not a partial supersession: the identity is a role; a credential is one instance of it.
- **Relationships (separately approved; merged with PR #261):** dated clarification notes, none a supersession, on ADR-0040 (OPEN-5
  answered; Company-only pre-activation hierarchy; first Platform after F7 and a verified post-F7 backup), ADR-0042 (D1, A.2, A.5:
  provisioning identity versus credential) and ADR-0060 (initial `ACTIVE` state; controlled backfill of the existing Company in L2).
  Their statuses are unchanged.
- **Production baseline:** the certified hierarchy is the one Company and its Owner; **no Platform or Organization exists** (`1 / 0 / 0`,
  [cutover record](stage-21/stage-21-x-cutover-record.md)). No runtime work, provisioning or activation has occurred.
- **Future implementation prerequisites (separately authorized):** the provisioning-credential retirement procedure; `register-caller.sh` hard-codes Auth's `"allowedPlatforms":[]` and
  rebuilds the policy on every run, and has no deregistration path; ADR-0060 L2 for the initial state and backfill; a consumer-first audit action for any future bootstrap.
- **Open:** multi-company creation and ownership; future Company onboarding; factor-only step-up for Platform and Organization
  creation; OD-A5-4(e); OD-A5-5; OD-S1. Nothing is implemented, provisioned or activated; A5.3 was not complete then and is now CLOSED (2026-10-09, architecture only,
  §10.5).

### 10.4 OD-A5-5 and OD-A5-4(e) design progress (2026-10-09)

- **Policy direction approved by the owner:** Organization Service stays the hierarchy authority after F6/F7 and Auth keeps validated
  references only; the transition is a one-way door, and no recovery silently restores Auth's local authority; no universal
  administrator, database bypass or new recovery authority mode. After F7, keep Auth `hierarchy-status`, Auth `hierarchy-verify` (a cache
  diagnostic), Organization `ownership status`, genuinely read-only Organization verification (a future read-only replacement of
  `verify`, which writes an `ownership_event` today) and the future ADR-0061 reference diagnostic (a restricted, read-only Auth CLI);
  authority-changing commands keep their mandatory post-F7 refusals and are removed only by a capability-based, separately approved
  stage. Once Auth's marker is `org_authoritative`, a source/marker mismatch, or a missing, invalid or unreadable marker, fails Auth's
  readiness and alerts, with the attended F6 transitional state defined explicitly. The narrowed two-way dependency is kept, enforced by
  a static Auth boundary test. A future runbook rule forbids restoring a pre-F6 Auth backup (old `local` marker) after F6, alongside the
  existing Organization rule. Both CLIs move to the kit's `EnvReader` in a separately authorized post-F7 stage.
- **Design:** [ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md), drafted as Proposed (2026-10-09) and
  **Accepted on 2026-10-09 (A5.3 OD-A5-5 and OD-A5-4(e) owner authorization) and merged as PR #262**;
  the OD-A5-5 and OD-A5-4(e) architecture policies are decided. ADR-0040 A1.4's AD-5 wording and A2.6 are preserved, with no recovery
  mechanism designed.
- **Relationships (separately approved; merged with PR #262):** dated clarification notes, none a supersession, on ADR-0040 (post-F7 CLI
  convergence; both `retire` commands kept for F6 and F7), ADR-0042 decision 8 (the complete never-call list kept, not narrowed; the
  static boundary test required) and ADR-0061 §6 (the diagnostic as a restricted, read-only Auth CLI subcommand); statuses unchanged.
- **Runbook (merged with PR #262):** a documentation-only rule in [`core-backup-restore.md`](../runbooks/core-backup-restore.md) §7 forbids restoring a pre-F6
  Auth backup after F6 as an ordinary restore; it is procedural, not enforced by any tool, and not rehearsed.
- **Not implemented:** the readiness check, the static boundary test, the read-only `verify`, the diagnostic CLI, the `EnvReader`
  convergence and any command retirement; no restore, production transition or G6/G7/F6/F7 step has occurred. A5.4 stays blocked until
  F7.
- **Reconciled for A5.3 closure (2026-10-09, owner dispositions; §10.5, §11.9):** ADR-0017 and ADR-0020 superseded; ADR-0022 partially
  superseded and, with ADR-0024, deferred to A6.

### 10.5 A5.3 closure record (2026-10-09)

**ARCHITECTURE DESIGN COMPLETE — RUNTIME NOT IMPLEMENTED — PRODUCTION NOT ACTIVATED.** **A5.3 — CLOSED (2026-10-09, architecture only).** The closure pull request
(#263) merged at `a0fd8a1`, and its merged documentation was independently verified on `main`. No production transition has occurred.
A5 as a whole stays OPEN: A5.4 and A5.5 remain gated (blocked until F7, after G6).

| Accepted ADR | Settles | Merged |
|---|---|---|
| [ADR-0059](../adr/0059-company-ownership-transfer-and-exceptional-owner-recovery.md) | OD-A5-3: exactly one active Owner, controlled transfer, exceptional recovery | PR #258 |
| [ADR-0060](../adr/0060-company-platform-organization-lifecycle.md) | OD-A5-1: Company, Platform and Organization lifecycle (E4 + E1 + E5) | PR #259 |
| [ADR-0061](../adr/0061-auth-hierarchy-reference-repair-and-diagnostics.md) | OD-A5-4(a)–(d): Owner-authorized reference repair and read-only diagnostics | PR #260 |
| [ADR-0062](../adr/0062-initial-hierarchy-provisioning-and-first-platform-sequencing.md) | OD-A5-2: initial hierarchy and first-Platform sequencing | PR #261 |
| [ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md) | OD-A5-4(e) and OD-A5-5: post-F7 authority modes, dependencies, CLIs and recovery | PR #262 |

- **Relationships and runbook:** the dated notes on ADR-0017, 0024, 0040, 0042, 0050, 0060 and 0061 (§10.0 to §10.4) and the
  post-F6 Auth backup restore rule (`core-backup-restore.md` §7; procedural, not rehearsed).
- **A5.2 dispositions recorded with this closure:** ADR-0017 superseded by ADR-0059 (ADR-0050's withdrawal of the force-reset CLI
  stands); ADR-0020 superseded by ADR-0040 (its rules survive in ADR-0042 decision 7, the Auth-local read in ADR-0023 D1(a)); ADR-0022
  Proposed, partially superseded by ADR-0040, its surviving decisions (append-only operator–Platform assignments, company-wide Owner
  scope, no `platformId` token claim, no `User.platformId`) deferred to A6; ADR-0024 Proposed, deferred to A6. The reciprocal notes
  were added on 2026-10-09 with the formal closure: ADR-0040 records its supersession of ADR-0020 and partial supersession of ADR-0022,
  ADR-0059 records the whole-ADR disposition of ADR-0017, and ADR-0042 records ADR-0020's new status.
- **Remaining A6 governance:** acceptance of ADR-0022's surviving decisions and of ADR-0024 (with ADR-0030, ADR-0059 and ADR-0060
  taken into account), and their open questions (`Operator.companyId`, Owner `isActive` versus status, per-assignment permissions,
  multi-company).
- **Implemented today versus future:** the legacy capabilities (Auth's `local` hierarchy, the transition CLIs, `bootstrap-owner`,
  first-touch `ensure`, Organization Service's admin routes behind its inactive authority, the database-integrity migrations) exist;
  **none** of the features decided by ADR-0059 to ADR-0063 is implemented.
- **Future A5.4 prerequisites (blocked until F7, after G6):** consumer-first audit-contract changes; Organization Service lifecycle (L2,
  L3) with the `ACTIVE` backfill and a read-only `verify`; Auth E5, the `ensure` resolve/place split and repair, ADR-0059 owner transfer and steward recovery (after OD-S1), the diagnostic CLI, the
  readiness mismatch check, the static boundary test, the owner lifecycle behind default-off gates and `EnvReader` convergence; the
  `register-caller.sh` scope and deregistration tooling and the provisioning-credential retirement design; consumer E1 adoption; later,
  the capability-based removal of legacy modes and E3 after A3M.8.
- **Still deferred:** multi-company onboarding; OD-S1 steward provisioning; OD-L5, OD-L6 and OD-L7; E3 lifecycle propagation;
  retention and erasure; factor-only MFA for Platform and Organization creation; provisioning-credential retirement; `allowedPlatforms`
  extension tooling; the exact F6 transitional readiness behavior.
- **Production gate (unchanged):** G6 → pre-G7 backup → G7 → F6 → F7 → post-F7 backup; G6 deferred; G7, F6 and F7 locked; no runtime
  feature is implemented and no production transition has occurred.

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
| [0017](../adr/0017-single-owner-with-secret-key-force-reset.md) | single owner per Company; CLI force-reset | Proposed (force-reset CLI never built; withdrawn from Core V1 by Accepted ADR-0050) (at review time; see §11.9) |
| [0020](../adr/0020-organization-entity-and-platform-scoped-management.md) | Organization entity, platform-scoped management | Proposed (at review time; see §11.9) |
| [0022](../adr/0022-company-and-platform-entities-with-operator-assignment.md) | Company, Platform, PlatformAssignment | Proposed (at review time; see §11.9) |
| [0023](../adr/0023-platform-access-check-and-operator-login-decoupling.md) | platform-access check; operator login decoupled from calendars | Proposed |
| [0024](../adr/0024-database-enforced-tenancy-and-authorization-integrity.md) | database-enforced tenancy and authorization integrity | Proposed (at review time; see §11.9) |
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
0024, 0020, 0022 records 2–3 h. About **12–18 h**, plus one Core CI run per pull request and owner decision time. *(Estimate at
review time; A5.2 was completed on 2026-10-09, so no A5.2 work remains.)*

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
| 0017, 0020, 0022, 0024 | **Proposed** until 2026-10-09; 0017 marked partly superseded and 0024 amended by ADR-0059 (§10.1); then the owner's A5.3 closure dispositions: 0017 **Superseded by ADR-0059**, 0020 **Superseded by ADR-0040**, 0022 **Proposed, partially superseded by ADR-0040, deferred to A6**, 0024 **Proposed, deferred to A6** (§10.5) | A5.3 closure owner dispositions |

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
  left) and ADR-0030's residual risks stay open. OD-A5-2, OD-A5-4 and OD-A5-5 stay open (OD-A5-1 and OD-A5-3 are decided later: §10.0, §10.1; OD-A5-4(a)–(d): §10.2; OD-A5-2: §10.3).
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

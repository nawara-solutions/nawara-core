# Core V2 A5: organization

- **Status:** RECORD of the A5.0 discovery (read-only, 2026-10-08, on `main` at `f90787a`, the PR #252 merge that closed A4) and of
  **A5.1: the A5 architecture and scope record**. **A5 is OPEN.** Its label is **🔴 (design 🟡)** ([roadmap](../CORE-ROADMAP.md), Core V2
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
| A5.1 | this record; A4 closure wording | A5.0 | this record, the roadmap, the A4 record | merged; every A5 item labelled; no runtime change | `check:repo`, `git diff --check`, links; Core CI | done with this record |
| A5.2 | ADR reviews, one ADR at a time (§11); each status change separately authorized | A5.1 | `docs/adr/00xx-*.md`, the ADR index | each review recorded; statuses change only on explicit authorization | docs checks; Core CI per status-change PR | 10–20 h |
| A5.3 | post-F7 design: Auth as reference cache in steady state, retiring local mode and the legacy Company insert, the dependency decision, CLI convergence plan, and lifecycle only if decided in scope | A5.1, A5.2, owner decisions (§10) | this record; possibly a new ADR (Proposed) | designs owner-reviewed; implementation items labelled 🔴 | docs checks; Core CI | 10–25 h |
| A5.4 | implementation of the approved A5.3 designs | **F7** and a refreshed baseline | `apps/auth-service/src/hierarchy/*`, `src/cli/owner-tools.ts`, `src/config/app-config.ts`; `apps/organization-service/src/cli/ownership.ts`, `src/admin/*`; their tests | the V2 protocol: focused tests and mutants, service regression, `test:e2e:auth-organization` | full Core CI per pull request | ⚪ about 30–150 h, set by A5.3 |
| A5.5 | certification | A5.4 | this record, the roadmap | the criteria A5.3 fixes | records-based; merged pull requests' CI | 3–6 h |

Design phase (A5.2–A5.3): about 20–45 h. Assumptions: about 6 productive hours a day, one Core CI run per pull request, owner decision time
excluded. The production track (§7) is separate and owner-driven.

## 10. Owner decisions [PROPOSED, not approved]

| Id | Decision needed | Notes |
|---|---|---|
| OD-A5-1 | **BD-5 organization lifecycle** (deletion, archive, deactivate, suspend, restoration, reparenting): in A5 scope or not | no decision exists; organization-service has no status column or delete path |
| OD-A5-2 | **OPEN-5**: whether initial Platforms or Organizations must exist before activation in a fresh environment | ADR-0040 A2.8; not blocking Stage 10.1 |
| OD-A5-3 | **Owner transfer**: in A5 scope or not | ADR-0017 keeps one owner per Company permanently; no transfer decision exists |
| OD-A5-4 | **Transitional dependencies**: after F7, remove, keep or narrow the two-way Auth ↔ Organization dependency and Auth's `local` mode | ADR-0056 `[COMPAT]` and `[DEFERRED: A5 / F6 / F7]` |
| OD-A5-5 | **Ownership CLI convergence**: after F7, move `ownership` and Auth's `hierarchy-*` commands onto the kit's `EnvReader`, retire them, or keep them | excluded from A2 / A15; must not change before F7 |

## 11. ADR review priorities

Reviews are read-only and recorded one ADR at a time; a status change is a separate, explicit owner authorization (ADR index rules).

| ADR | Review | Reason |
|---|---|---|
| [0017](../adr/0017-single-owner-with-secret-key-force-reset.md) | now | single owner implemented; the force-reset CLI is not to be built |
| [0023](../adr/0023-platform-access-check-and-operator-login-decoupling.md) | now | implemented in Auth; carried forward from OD-A4-8 |
| [0028](../adr/0028-organization-join-codes-membership-and-organization-admin.md), [0029](../adr/0029-organization-admin-invitations.md), [0030](../adr/0030-multi-organization-membership-and-revoked-state.md) | now | membership, join codes and invitations stay in Auth after F7 |
| [0039](../adr/0039-organization-ownership-and-cross-service-migration-authority.md) | now | text reconciliation with Accepted ADR-0040, which partly supersedes it |
| [0031](../adr/0031-organization-service-intended-owner-of-the-hierarchy.md) | now for its intent | full acceptance arguably after F7 |
| [0020](../adr/0020-organization-entity-and-platform-scoped-management.md), [0022](../adr/0022-company-and-platform-entities-with-operator-assignment.md), [0024](../adr/0024-database-enforced-tenancy-and-authorization-integrity.md) | review now; acceptance after F7 | they describe the hierarchy and database-enforced tenancy inside Auth, which becomes a reference cache after F7 |

## 12. Validation per sub-stage

Documentation sub-stages: `check:repo`, `git diff --check`, link and path checks; every pull request runs full Core CI (`core-ci-passed`
is required by the `main` ruleset). Implementation sub-stages (after F7): the [V2 validation protocol](core-v2-a-baseline-and-change-safety.md#8-v2-per-capability-validation-protocol)
with the affected services' suites and `test:e2e:auth-organization`. Reused, not repeated: the A1, A2, A3M, A4 and A15 evidence. Not
part of A5: G6, any production step, Final Core Validation (the absolute last validation).

# 0062. Initial hierarchy provisioning and first-Platform sequencing

- **Status:** Accepted (2026-10-09, by the architecture owner, A5.3 OD-A5-2 owner authorization) <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-10-09
- **Deciders:** Anwar (project owner)

> **Acceptance note (2026-10-09, A5.3 OD-A5-2).** The architecture owner accepted this ADR. The Proposed-era notes and body below are
> kept unchanged as history; their statement "This ADR is **Proposed**: it is not accepted" is replaced by this note, while "it
> **implements, provisions, migrates and activates nothing**, and it changes no credential" remains true. Acceptance:
> 1. **Accepted policy.** The fresh pre-activation hierarchy is one provisioned Company and no Platform or Organization; the certified
>    F2, F3 (no-op), F4 and F5 are preserved. The first Platform is created by the authenticated, active Company Owner through
>    Organization Service only after F7 and the verified post-F7 backup, under a separate attended authorization (§4). Organizations are
>    created through Organization Service's authorized human administration route with the existing assignment and step-up restrictions.
>    New Companies, Platforms and Organizations default to `ACTIVE`, subject to their active-ancestor requirements; the existing Company is
>    backfilled safely to `ACTIVE` in the separately authorized ADR-0060 lifecycle implementation (§8).
> 2. **Auth scope.** Each new Platform is added to Auth's `allowedPlatforms` only through a separately approved, least-privilege,
>    audited change-control procedure, before any Auth first touch or ADR-0061 repair (§5). The `register-caller.sh` behavior that resets
>    `allowedPlatforms` to `[]` must be **corrected and certified** before any operational scope extension. This acceptance authorizes no
>    tooling change.
> 3. **Provisioning credential.** The current production Company-provisioning credential must not remain capable of creating additional
>    Companies after the authorized initial transition; its retirement timing, method, verification and recovery implications are designed
>    and approved separately (§7).
> 4. **Bootstrap evidence.** The certified F4 runbook record remains the historical evidence of the completed Owner bootstrap; no Audit
>    Service record is backdated or fabricated. Any future bootstrap-capable implementation requires an independently authorized
>    audit-contract and Audit Service integration decision (§9).
> 5. **ADR-0040 / ADR-0042 interpretation (§13), decided as a clarification of deployment-credential lifecycle, not a partial
>    supersession.** The current production provisioning credential is one **instance** of the narrowly scoped provisioning capability.
>    Retiring it after the authorized initial transition does not retire the architectural possibility of provisioning future Companies.
>    Any future provisioning credential (of the dedicated provisioning identity, or of a new identity under its own decision) must
>    be separately created, scoped, authorized and certified for a future multi-company lifecycle; no currently deployed credential is implicitly authorized for later Company provisioning; and the current
>    single-Owner bootstrap limitations mean multi-company onboarding is not operationally ready. ADR-0042 D1, A.2 and A.5 and ADR-0040
>    A2.5 are read consistently with this: ADR-0042 D1 itself distinguishes the dedicated provisioning **identity** from its
>    **credentials** (whose form it leaves open), so A.5's "later Companies use the same provisioning identity" names the dedicated,
>    non-human provisioning role, not a standing credential; and ADR-0040 A2.5's "later provisioning by the provisioning credential" is
>    among the operations permitted while a fresh environment is still inactive: a permission, not an obligation to keep a credential
>    registered, which this ADR does not change. No material
>    contradiction with the normative text was found.
> 6. **Unimplemented and unapproved:** multi-company onboarding and future Company ownership, a per-Company ownership bootstrap, any
>    broader provisioning workflow. **Still open:** the exact provisioning-credential retirement procedure; the `allowedPlatforms`
>    scope-extension implementation and runbook; factor-only MFA for Platform and Organization creation; OD-A5-4(e); OD-A5-5; OD-S1;
>    every runtime implementation and activation gate. Nothing is implemented, provisioned or activated, and no G6, G7, F6 or F7 step
>    runs as part of this acceptance.
> 7. **Relationships.** The "proposed relationships" paragraph below now takes effect in substance. No other ADR is changed here: the
>    dated relationship notes on ADR-0040, ADR-0042 and ADR-0060 each require a separate authorization and commit.

> **Status of this document.** The architecture owner approved the **policy direction** of OD-A5-2(a)–(f) (2026-10-09), recorded below,
> subject to final ADR review. This ADR is **Proposed**: it is not accepted, it **implements, provisions, migrates and activates
> nothing**, and it changes no credential. Every stage it names is separately authorized and, for runtime effect, blocked until F6/F7.
>
> **Proposed relationships, effective only if this ADR is Accepted** (no other ADR is edited by this draft):
> - [ADR-0040](./0040-organization-ownership-migration-decisions.md): **answers OPEN-5** (A2.8) and narrows A2.5 F3/F7 (§3, §4); the
>   certified F2, F3, F4 and F5 and the one-way door (A2.6) are preserved;
> - [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md): **clarifies D1 and A.5** (§6, §7); see the reported
>   tension in §13: D1, A.2 and A.5 (and ADR-0040 A2.5) name the provisioning identity for later Companies, while §7 here retires the
>   current credential;
> - [ADR-0060](./0060-company-platform-organization-lifecycle.md): **clarifies** the initial local state and the backfill of the existing
>   Company (§8); the states, transitions, permissions and E4 + E1 + E5 are preserved;
> - [ADR-0059](./0059-company-ownership-transfer-and-exceptional-owner-recovery.md): **preserved** (exactly one active Owner; the
>   bootstrap is one of its Company-serialized mutations; OD-S1 stays open);
> - [ADR-0061](./0061-auth-hierarchy-reference-repair-and-diagnostics.md): **preserved** (repair is not a scope extension; §5);
> - [ADR-0050](./0050-platform-administration-and-verified-human-authority.md): **preserved** (decision 8: "No god admin database";
>   decision 9: same-transaction audit; decision 14: direct database manipulation is not a recovery procedure).

## 1. Context

**Implemented and certified (verified on `main` at `f9e83a2`; production evidence in the
[cutover record](../architecture/stage-21/stage-21-x-cutover-record.md)):**

- **Company provisioning.** `POST /organization/companies` requires `hierarchy.provision`, held by a dedicated identity alone
  (`apps/organization-service/src/authorization/service-policy.ts`). Before activation, a Company insert is accepted only in a `fresh`
  environment in phase `PREPARED`, by the application guard (`src/ownership/ownership.service.ts`, `assertWritable`) and by the database
  write gate (`db/migrations/0004_ownership_transition.sql`). The create is idempotent per caller and key and writes its central audit
  intent in the same transaction. Production F2 created Company `91bf0f27-6f5a-4883-a140-2b211d6759ed` (hierarchy `1 / 0 / 0`).
- **Owner bootstrap.** `bootstrap-owner` with `BOOTSTRAP_COMPANY_ID` (`apps/auth-service/src/cli/owner-tools.ts`) first places the
  Company's validated reference by `ensure` and refuses with nothing created if Organization Service cannot confirm it; it then takes a
  global advisory lock, refuses if **any** owner exists, and creates `user(kind = owner)` and `owner` in one transaction, with no
  Company insert in Auth. `owner.companyId` is immutable and unique per Company (Auth migrations 0001, 0002). Production F4 created the
  Owner (certified, V4); F5 recorded `VERIFIED`.
- **Platform and Organization administration.** `POST /organization/admin/platforms` (Owner of that Company) and
  `POST /organization/admin/organizations` (Owner, or an Operator assigned to the Platform) authenticate the end user's bearer through
  `GET /auth/grants`, verify a step-up (`platform.create`, `organization.create`) through `POST /auth/step-up/verify`, and write the
  entity, the actor record and the audit intent in one transaction (`src/admin/admin.controller.ts`). Until Organization Service is
  authoritative every such write is refused (`409 not_authoritative`). `hierarchy.write` cannot be assigned to any service.
- **Auth's scope.** Auth's Organization Service credential holds `hierarchy.read` with an explicit, **empty** `allowedPlatforms`. The
  deployment tool hard-codes that policy and rebuilds it on every run (`apps/organization-service/deploy/register-caller.sh`,
  `policy_for`); it has no deregistration path. Organization Service answers an out-of-scope Platform or Organization as not found.
- **Gaps.** No Platform or Organization exists. The provisioning credential stays registered and, once the phase is `ACTIVE`, its
  Company insert is accepted again; such a Company can never receive an Owner, because `bootstrap-owner` refuses whenever any owner
  exists. `bootstrap-owner` writes **no** audit record, and the shared catalog has no owner-bootstrap action. ADR-0060 states no
  initial lifecycle state.
- **Gates.** G6 is deferred; G7, F6 and F7 are locked; Auth runs in `local` mode.

## 2. Options considered

1. *A. Extend the one-time provisioning caller to Platforms and Organizations before activation.* Rejected: ADR-0042 gives the
   provisioning identity Company creation only and assigns `hierarchy.write` to no one; it would bypass the Owner's authority and step-up,
   and it would change the content certified at F5.
2. **B. The active Owner creates Platforms and Organizations through Organization Service's human administration, after the transition
   (chosen).** Accepted mechanism (ADR-0040 A2.5 F3, ADR-0042 A.2) and already implemented.
3. *C. A product or platform service creates the first records.* Excluded: no accepted decision names a holder of `hierarchy.write`.
4. *D. A privileged administrator or a manual database write.* Excluded by ADR-0050 decisions 8 and 14 and ADR-0042 D1 (not Auth's
   legacy direct-database path).

## 3. Decision: the pre-activation hierarchy (OD-A5-2(a))

- The pre-activation hierarchy of a fresh environment contains **exactly the provisioned Company**. No Platform or Organization is
  required or permitted before activation. This answers ADR-0040 OPEN-5.
- The certified F2 (first Company), F3 (no-op), F4 (Owner bootstrap) and F5 (verification) stand and are **never re-run**.

## 4. Decision: the first Platform and Organization (OD-A5-2(b))

The first Platform is created only after **all** of the following:

1. G6 recovery prerequisites and the rehearsal are certified;
2. G7 is authorized and completed;
3. F6 and F7 have completed successfully;
4. the post-F7 Auth and Organization backup is created and verified;
5. a **separate, attended authorization** permits ordinary hierarchy administration.

Then:

- the **active Owner** creates the Platform under their own Company through `POST /organization/admin/platforms` with a fresh
  step-up; Organizations follow through `POST /organization/admin/organizations` (Owner, or an assigned Operator with Operator step-up
  once it exists);
- each creation is subject to ADR-0060 E4 (an effectively `ACTIVE` parent) once implemented;
- no service, provisioning identity, CLI or database write creates a Platform or an Organization.

The first committed hierarchy write after activation remains ADR-0040's one-way door; this decision places it after the verified post-F7
backup.

## 5. Decision: Auth's Platform scope (OD-A5-2(d))

A new Platform becomes visible to Auth's Organization Service credential only through a **separately approved, audited and attended
change-control procedure**, completed **before** any Auth first touch (join code, invitation, operator assignment) or ADR-0061 repair on
that Platform. The procedure:

- verifies the Platform's authoritative Company association in Organization Service (it must be the operating Company);
- adds **exactly that Platform id** to Auth's `allowedPlatforms`; there is no wildcard, no unrestricted scope and no automatic grant
  (ADR-0042 A.5);
- records the Platform id, the justification, the approval and the verification result;
- respects the service-token and deployment architecture (ADR-0033, ADR-0042 decision 10): a configuration change loaded by a redeploy;
- defines failed-update and retry behavior: an update is all-or-nothing, re-running it converges to the same set, and a partial or
  failed update leaves the previous scope in force (fail closed).

An ADR-0061 repair or diagnostic does **not** extend scope: an out-of-scope Platform stays a collapsed `404`. The exact mechanism is a
separately reviewed operational contract. **Prerequisite:** today's tool cannot express it (it hard-codes `"allowedPlatforms":[]` and
rebuilds the policy on every run), so the tool must change, under separate authorization, before the first extension; otherwise a
later registration run would silently reset an extended scope.

## 6. Decision: no ownerless Company (OD-A5-2(c))

- After the initial transition, **no Company may be created without a defined path to exactly one active Owner** (ADR-0059).
- Multi-company creation and ownership and future Company onboarding are **not decided**; until they are, no Company is created after
  the initial one.

## 7. Decision: retiring the provisioning credential (OD-A5-2(c))

- The one-time production provisioning credential **must not remain capable of creating additional Companies** after the initial
  hierarchy transition.
- A controlled **disablement or deregistration** step becomes part of the future authorized transition procedure. Before it is
  implemented, its design must verify: the exact timing relative to F6, F7 and the post-F7 backup; its dependencies (the provisioning
  identity is not used by F5 to F7, which run through the ownership CLI); the rollback impact (before activation a fresh environment may
  roll back to `PREPARED` and need provisioning again, so disablement belongs **after** activation, when no rollback exists: ADR-0040 A2.6, the one-way door); and that it
  breaks no F6/F7 contract. **Prerequisite:** the deployment tool has no deregistration path today.
- Nothing here deletes, revokes, rotates or modifies any credential. Any later Company creation needs its own decision and a newly
  authorized provisioning identity.

## 8. Decision: initial lifecycle state (OD-A5-2(e))

- New Companies, Platforms and Organizations start with local lifecycle state **`ACTIVE`**, subject to ADR-0060's creation rules (an
  effectively `ACTIVE` parent, E4).
- When ADR-0060's L2 stage runs, the existing certified Company (and any entity existing then) receives an **explicit, validated
  backfill** to `ACTIVE`, verified by count and id against the certified state, inside that separately authorized migration.
- No schema or data change is made now.

## 9. Decision: the Owner bootstrap's audit evidence (OD-A5-2(f))

- The certified F4 runbook record is **accepted as the historical evidence** of the completed initial bootstrap.
- **No central audit record is invented or backdated.**
- The absence of central audit instrumentation in `bootstrap-owner` is recorded as an **implementation and security gap**. Any future
  bootstrap-capable implementation requires a separately authorized, consumer-first audit-contract and audit-service decision before
  it emits anything (audit-service is in production).

## 10. Failure, concurrency, recovery and idempotency

| Case | Required behavior | Today |
|---|---|---|
| Company create partly fails | one transaction (row, idempotency key, audit intent); retry with the same key replays | implemented |
| Duplicate Company (a new key) before activation | prevented operationally by the runbook count check; after activation prevented by §7 | no database guard |
| Company exists, Owner bootstrap fails | the Company remains; rerun the bootstrap (idempotent `ensure`) | implemented |
| Organization Service unavailable at bootstrap | refuse, nothing created | implemented |
| Concurrent Owner claims | one winner (lock, owner check, unique index); with ADR-0059, a Company-keyed lock and one `active` owner | implemented (global lock) |
| Owner bound to a wrong Company | prevented by pre-checks; the binding is immutable and ADR-0059 does not re-point owners | certified correct in production |
| Platform create fails after the step-up was consumed | the create is atomic with its actor record and audit; a new step-up is required; retry with the same key | implemented |
| Concurrent creates with the same key | one resource; the other replays | implemented |
| Platform outside Auth's scope | first touch and repair answer `404`; fixed only by §5 | implemented (fail closed) |
| Scope update fails | previous scope stays; retry converges (§5) | not implemented |
| Credential disablement fails | the credential may still be capable: stop, do not open ordinary administration, retry under the same authorization (§7) | not implemented |
| Audit intent cannot be written | the hierarchy write rolls back | implemented (Organization Service) |
| Orphans | an Auth reference row without an owner is harmless (existence only); an ownerless Company is prevented by §6 and §7 | partial |

## 11. Production gates, tests and certification

- Order: G6 → pre-G7 backup → G7 → F6 → F7 → post-F7 backup → verify → separate authorization → first Platform → scope extension →
  first Organization. No step is part of another task.
- **Tests (when implemented):** writes of Platforms and Organizations refused in every pre-activation phase; provisioning refused after
  disablement; owner and Company equality and step-up on the admin routes; idempotent replay; audit-or-rollback; E4 refusals under an
  inactive parent and `ACTIVE` as the initial state; the L2 backfill verification; Auth first touch false-negative out of scope and success
  after extension; scope-update atomicity and retry; concurrent bootstraps; authentication paths never calling Organization Service.
- **Certification:** the G6 rehearsal includes the post-F7 first Platform, the scope extension and the first Organization in the isolated
  environment; production repeats them only at attended, owner-authorized checkpoints.

## 12. Unresolved and non-goals

- **Unresolved:** multi-company creation and ownership; future Company onboarding; factor-only step-up for Platform and Organization
  creation (they accept the secret key today); OD-A5-4(e) post-F7 dependencies and `local`-mode retirement; OD-A5-5 CLI convergence;
  OD-S1 steward provisioning; the exact scope-extension and disablement mechanisms (§5, §7).
- **Non-goals:** no provisioning, bootstrap, credential, migration, runtime, API, CLI or audit change; no G6, G7, F6 or F7 step.

## 13. Reported tension (not a supersession)

Three accepted passages name a standing provisioning identity for later Companies: ADR-0042 D1 (later Companies, once Organization
Service is authoritative, are created by the dedicated provisioning identity), ADR-0042 A.5 ("later Companies use the same provisioning
identity", most precisely) with the A.2 create-Company row, and ADR-0040 A2.5 ("later provisioning by the provisioning credential"
among the operations permitted while a fresh environment is inactive). §7 retires the **current** credential after the transition. This
ADR reads all three as naming the **mechanism** for later Companies, not as requiring a standing credential, since multi-company support
is undecided in ADR-0042 itself; any later Company creation uses a newly authorized provisioning identity under its own decision. The
owner is asked to confirm this reading at acceptance; if it is not confirmed, the relationship to ADR-0042 (D1, A.2, A.5) and ADR-0040
A2.5 becomes a partial supersession, which this draft does not apply.

## Consequences

- **Easier:** one explicit, gated order from the certified Company and Owner to the first Platform and Organization; no ownerless
  Company; least-privilege scope for Auth; no invented audit history.
- **Harder or given up:** every new Platform needs an attended scope change before Auth can use it; a standing Company-creation
  capability is given up until multi-company is decided.
- **Follow-up (each separately authorized):** the scope-extension operational contract and tooling change; the provisioning
  disablement design; ADR-0060 L2 with the backfill; a consumer-first audit action for any future bootstrap; on acceptance, the dated
  relationship notes on ADR-0040, ADR-0042 and ADR-0060.

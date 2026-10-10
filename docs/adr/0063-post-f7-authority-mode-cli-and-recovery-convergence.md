# 0063. Post-F7 authority-mode, CLI and recovery convergence

- **Status:** Accepted (2026-10-09, by the architecture owner, A5.3 OD-A5-5 and OD-A5-4(e) owner authorization) <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-10-09
- **Deciders:** Anwar (project owner)

> **Acceptance note (2026-10-09, A5.3 OD-A5-5 and OD-A5-4(e)).** The architecture owner accepted this ADR. The Proposed-era notes and
> body below are kept unchanged as history; their statement "This ADR is **Proposed**: it is not accepted" is replaced by this note,
> while "**nothing in it is implemented**, and it authorizes no runtime change, CLI change, CLI execution, restore, migration or
> production operation" remains true. Acceptance:
> 1. **Authority and the one-way transition (§3).** Organization Service remains the hierarchy authority after the certified F6/F7
>    transition; Auth remains responsible for identities, grants and Owner associations, and its hierarchy references are not a second
>    authority. ADR-0040's precise one-way-door rules (A2.6) and the historical AD-5 wording of A1.4 are preserved; no new emergency
>    rollback mechanism is created or authorized.
> 2. **CLI retention and retirement (§6, §8).** Auth `hierarchy-status` and `hierarchy-verify` (read-only cache diagnostics) and
>    Organization `ownership status` and genuinely read-only verification diagnostics are retained; the ADR-0061 restricted reference
>    diagnostic is planned as an Auth CLI capability. Auth `hierarchy-retire` is retained for its certified F6 mirror and Organization
>    `ownership retire` for the certified F7 step. Authority-changing commands keep refusing once their valid phase has passed. Obsolete
>    transition commands are retired only when the capability-based criteria of §8 are all met (relevant environments have certified F7,
>    operational recovery and G6 needs are satisfied, development and CI alternatives exist, security tests pass, and a separate removal
>    approval is given); development, CI and recovery tooling stays until a verified replacement exists. No calendar date applies.
> 3. **Readiness consistency (§4).** In steady-state operation a source/marker mismatch, in either direction and including a restored old
>    `local` marker, makes Auth not ready and raises an operational alert. The narrowly scoped F6 transitional state is defined explicitly
>    in the future runbook and certified in the G6 rehearsal; no uncontrolled startup dependency is introduced; database-level authority
>    enforcement is preserved; there is no fallback to local authority.
> 4. **Dependencies (§5).** The narrowly defined Auth → Organization Service administrative dependency and Organization Service → Auth
>    `/auth/grants` and step-up verification are kept. Authentication, registration, join, refresh, sessions, `/auth/me`, `/auth/grants`
>    and ADR-0023's local authorization reads never synchronously depend on Organization Service; a static test guarding that boundary is
>    required.
> 5. **Recovery and backups (§9).** A pre-F6 Auth backup is never restored as an ordinary post-F6 recovery; the equivalent restriction on
>    incompatible Organization backups is preserved; an invalid authority-marker restoration is detected as a critical disagreement.
>    Exceptional recovery stays separately controlled and does not authorize restoring Auth's former authority. No universal
>    administrator or database-repair bypass is permitted.
> 6. **CLI configuration and diagnostics (§6, §7).** Both CLIs complete their `EnvReader` convergence in a separately authorized post-F7
>    stage (Auth is partly converged; Organization is the main gap), preserving credential and secret-handling boundaries. The ADR-0061
>    diagnostic outputs only approved identifiers, reference presence, immutable-parent agreement and reason codes, with no reference
>    placement, authority change or sensitive output.
> 7. **Not authorized by this acceptance (future implementation or documentation steps, each separately authorized):** changing Auth's
>    readiness implementation; implementing or removing CLI commands; changing `EnvReader` behavior; adding the diagnostic or the static
>    test; editing the recovery runbooks; running G6, G7, F6 or F7; restoring databases or changing production configuration; activating
>    any runtime feature.
> 8. **Relationships.** The "proposed relationships" paragraph below now takes effect in substance. No other ADR is changed here: the
>    dated notes on ADR-0040, ADR-0042 (decision 8) and ADR-0061 (§6) each require a separate authorization and commit.

> **Status of this document.** The architecture owner approved the **policy direction** of OD-A5-5 and OD-A5-4(e) (2026-10-09), recorded
> below. This ADR is **Proposed**: it is not accepted, **nothing in it is implemented**, and it authorizes no runtime change, CLI change,
> CLI execution, restore, migration or production operation. Every stage is separately authorized and, for runtime effect, blocked until
> F7.
>
> **Proposed relationships, effective only if this ADR is Accepted** (no other ADR is edited by this draft):
> - [ADR-0040](./0040-organization-ownership-migration-decisions.md): **clarifies** the authority-transition and F7 retirement semantics
>   (decision 3, A1.3, A2.5 F6/F7, A2.6); the one-way door, decision 4 and the AD-5 emergency-mechanism wording of A1.4 are preserved (§9);
> - [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md): **clarifies decision 8** — the static Auth boundary test
>   it says "should" exist becomes required (§5);
> - [ADR-0061](./0061-auth-hierarchy-reference-repair-and-diagnostics.md): **clarifies §6** — the diagnostic CLI conventions it left to
>   OD-A5-5 (§7);
> - [ADR-0023](./0023-platform-access-check-and-operator-login-decoupling.md), [ADR-0050](./0050-platform-administration-and-verified-human-authority.md),
>   [ADR-0059](./0059-company-ownership-transfer-and-exceptional-owner-recovery.md), [ADR-0060](./0060-company-platform-organization-lifecycle.md)
>   and [ADR-0062](./0062-initial-hierarchy-provisioning-and-first-platform-sequencing.md): **preserved**.

## 1. Context

**Implemented today (verified on `main` at `7868756`):**

- **Two independent Auth switches.** The configuration `AUTH_HIERARCHY_SOURCE` (`local` | `organization-service`,
  `apps/auth-service/src/config/app-config.ts`) and the database marker `hierarchy_authority.mode` (`local` | `frozen` |
  `org_authoritative`, `apps/auth-service/db/migrations/0008_hierarchy_authority.sql`). The marker's trigger refuses any change once it is
  `org_authoritative`; in that mode only the reference-cache protocol may write, never a delete. A source/marker disagreement is only
  **logged** at startup (`src/hierarchy/hierarchy-reference.ts`, `reportSource`); with source `local`, first touches skip `ensure`.
- **Organization Service's one-way door.** `ownership_state` cannot move backward from `ACTIVE` (only `ACTIVE` → `RETIRED`; trigger in
  `apps/organization-service/db/migrations/0004_ownership_transition.sql`); `rollback`, `import`, `declare-class`, `approve` and
  `activate` refuse after activation (`src/ownership/ownership-admin.ts`); every refusal appends an `ownership_event`.
- **The CLIs.** Auth `dist/cli/main.js hierarchy-{status,verify,freeze,unfreeze,export,retire}` and `bootstrap-owner`
  (`src/cli/main.ts`, `src/hierarchy/hierarchy-authority.ts`, `src/cli/owner-tools.ts`); Organization `ownership
  {status,declare-class,verify-snapshot,import,verify,approve,activate,retire,rollback}` (`src/cli/ownership.ts`), reading
  `process.env` outside the kit's `EnvReader` (A2 OD-A2-5, A15); Auth's CLI already reads its bootstrap variables through `EnvReader`
  (A4.3), so its convergence is partial and the Organization CLI is the main gap. After `org_authoritative`, `freeze`, `unfreeze`, `export` and `retire`
  refuse and record a rejected `hierarchy_authority_event`. Organization `verify` **writes an `ownership_event`** even when it changes no
  phase. Auth `hierarchy-status` is used by the restore drill (`docs/runbooks/core-backup-restore.md` §5).
- **Dependencies.** Auth → Organization Service only through `HierarchyReference`, injected only into onboarding, invitation, platform
  assignment and the CLI; Organization Service → Auth through `GET /auth/grants` and `POST /auth/step-up/verify`
  (`src/admin/auth-grants-client.ts`). **No static boundary test** enforces Auth's never-call list (ADR-0042 decision 8 says one should).
- **Restores.** The runbook forbids restoring a pre-F6 **Organization** backup after F6 (`core-backup-restore.md` §7); it does not name
  the matching **Auth** case, whose restore would bring back the `local` marker (a restore is not an `UPDATE`, so the trigger cannot
  stop it). The agreement check (`docs/runbooks/organization-production.md` §6.2) would detect the disagreement.
- **Defaults.** Dev and CI default to `local`; the G6 rehearsal and any fresh environment need the transition commands.
- **Gates.** Production Auth is `local`/`local`; Organization `VERIFIED`; G6 deferred; G7, F6 and F7 locked.

## 2. Options considered

1. *A. Keep every legacy mode and command as is.* Rejected: transition paths stay reachable and a mismatch is only a warning.
2. **B. Keep safe read-only diagnostics; authority-changing commands keep refusing after F7; remove them in a later, capability-gated
   stage (chosen).**
3. *C. Remove the legacy modes and commands now.* Rejected: breaks the G6 rehearsal, fresh environments and the dev/CI fixtures.
4. *D. A new controlled recovery authority.* Rejected: an emergency bypass contrary to ADR-0050 decisions 8 and 14 and ADR-0040's
   "no automatic rollback".

## 3. Decision: post-F7 authority

- Organization Service is the hierarchy authority after F6/F7. Auth is the authority for identities, ownership associations and grants,
  and stores validated immutable hierarchy **references** only; it never becomes a second hierarchy authority.
- The transition is a **one-way door**, as ADR-0040 A2.6 defines it (the first committed hierarchy write after activation); Auth's
  `org_authoritative` marker is, in addition, irreversible by trigger. No recovery procedure silently restores Auth's local hierarchy
  authority.
- No emergency universal administrator, direct database bypass or new recovery authority mode is authorized.

## 4. Decision: configuration and marker consistency

> **Clarification (2026-10-10, F6 readiness and mirror order; architecture-owner rulings in principle; a clarification, not a
> supersession; this ADR's status, this section's original text below, its rationale and its relationships are unchanged).** This
> section leaves "the exact sequencing" to the G6 rehearsal, and §12 lists "the exact TRANSITIONAL implementation" as unresolved. The
> owner rules as follows; the record is the
> [F6 readiness decision record](../architecture/core-v2-a5-4-f6-transitional-readiness.md).
> 1. **Readiness.** Every source/marker disagreement makes Auth **not ready, including inside the attended F6 window**, with a
>    direction-specific diagnostic reason (source ahead of the marker, or marker ahead of the source). The TRANSITIONAL state is
>    explicit because it is defined, named by its reason and expected only inside the authorized attended F6 step; it is **not** an
>    exemption from not ready. The words "other than the explicit TRANSITIONAL state" below are read with §10 ("TRANSITIONAL handled
>    explicitly"): handled explicitly, never reported ready. A known mismatch is never treated as automatically safe. This resolves
>    the TRANSITIONAL implementation that §11 and §12 leave unresolved, in the stricter direction: it reads "other than" as
>    identifying a named state, not as an exemption from not ready. On its plain wording the sentence can also be read as an
>    exemption; adopting that reading instead would need a new decision, not this note. A ready answer between `ownership activate`
>    and the new-source redeploy is expected and verifies nothing about the mirror.
> 2. **Mirror order: source first.** After `ownership activate`, Auth is first redeployed with
>    `AUTH_HIERARCHY_SOURCE=organization-service` and that deployment is verified; only then is the irreversible marker change
>    (`hierarchy-retire --fresh`) performed. No Accepted ADR fixes the order: ADR-0040 A2.5 defines the mirror as the source and
>    the marker together; its F6 row names only the source, and its existing-environment E6 row lists the source, then the marker.
>    The parenthetical below and the G6 plan §9.1 list the marker first, without an order rule. **This ruling changes that listed
>    order**: the G6 plan and the runbook's §6.2 prose must be updated and certified before F6 can run so, and the G6 rehearsal still
>    verifies the sequencing, as this section requires.
> 3. **`frozen`.** On the fresh F6 transition a `frozen` marker is not ready. The freeze semantics of an existing environment
>    (ADR-0040 E2) and every documented recovery or freeze rule are not changed by this note; whether readiness also reports not
>    ready during an existing environment's freeze is not decided.
> 4. **`/ready` stays a monitoring signal.** It is read by the attended operator, including for post-transition verification, and
>    is not used to route traffic. `/auth/health` stays database-only, and the container healthcheck and the deploy wait are
>    unchanged. No routing enforcement is introduced.
> 5. **The attended windows.** The decision record defines two: a **transition window** from `ownership activate` to the
>    authority agreement MATCH, to which a hard procedural limit applies, and the narrower **disagreement window** between the new
>    Auth container and the marker change, with the one reason expected inside it, the stop conditions and the escalation. Being
>    inside a window makes a mismatch expected, not safe. While the marker is still `local` the database write guard is open, so
>    the disagreement window relies on Auth's code and on the attended rule that no administrative first touch and no other
>    hierarchy command runs; that is a trade-off of the source-first order, stated in the record. In neither order does the flag-based guard
>    stop a credentialed or privileged direct SQL session.
> 6. **Restores.** This readiness check is **not sufficient** to detect a restore from the wrong side of F6. Restore provenance,
>    an independent authority agreement and generation or anchor consistency need separately governed designs and controls; they
>    are **open and not implemented**.
> 7. **Source-first safeguards (2026-10-10, after the source-first safety review).** The owner retains Option B and source first,
>    adopts the record's required design safeguards (a transition window from `ownership activate` to MATCH with a hard procedural
>    limit measured in G6; in-window restrictions; equal hierarchy-content evidence before the redeploy and before the marker
>    change; at most one pre-authorized retry), and introduces **no new technical write guard**. F6 is activation, the source mirror,
>    the marker retirement and agreement verification; F7 is Organization's `ownership retire` and the certified post-F7
>    procedures. Each safeguard still needs its own runbook text, rehearsal and production approval.
>
> **Not changed and not authorized.** No authority invariant, one-way-door rule (§3, §9; ADR-0040 A2.6), gate or certification
> requirement is weakened. The certified G6 plan and the active F6/F7 runbooks are unchanged and **cannot be executed in the
> source-first order until they are separately updated and certified**. Deployment health, traffic routing, the authority commands
> and every production configuration are unchanged. A5.4-A5 stays a design-approved exception: nothing is implemented, merged,
> deployed or activated by this note.

Once Auth's marker is `org_authoritative`:

- `AUTH_HIERARCHY_SOURCE` other than `organization-service` makes Auth **not ready** (`/ready` fails, naming the check, in the A12
  `readiness_check_failed check=<name>` form) and raises an operational alert.
- The rule is symmetric: **any** source/marker disagreement other than the explicit TRANSITIONAL state makes Auth not ready, including
  a source of `organization-service` with a `local` marker (for example after restoring a pre-F6 Auth backup, §9).
- **Missing, invalid or unreadable marker:** not ready (fail closed), with a distinct reason; never treated as `local`.
- No fallback to local authority; the database write restrictions are unchanged.
- **The certified transition is not broken:** the runbook's attended F6 **TRANSITIONAL** state (§6.2) is defined explicitly in the
  implementation, so that the mirror (`hierarchy-retire --fresh` and the Auth redeploy with the new source) completes; the exact
  sequencing is verified in the G6 rehearsal before the check ships. Startup itself does not depend on the database (readiness does).
- Read-only status and diagnostics stay available while not ready, where safe.

## 5. Decision: Auth ↔ Organization Service dependencies

Kept, narrowed:

- **Auth → Organization Service:** administrative first-touch `ensure`; ADR-0060 E5 lifecycle reads; ADR-0061 repair; other separately
  accepted, bounded administrative operations. Bounded and fail closed.
- **Organization Service → Auth:** `GET /auth/grants`; step-up verification for authorized human administration.
- **Never** a synchronous Organization Service call from authentication, login, registration, join, session refresh, `/auth/me`,
  `/auth/grants` or ADR-0023's local authorization reads.
- A **static dependency-boundary test** in Auth enforces this list (clarifies ADR-0042 decision 8 from "should" to required), following
  the precedent of the repository checks (`scripts/lib/checks.mjs`, the reference-write allowlist) or as a test in `apps/auth-service`.
- `allowedPlatforms` scope changes stay a change-controlled configuration step (ADR-0062 §5), not a runtime call.

## 6. Decision: the CLIs after F7

| Command | After F7 |
|---|---|
| Auth `hierarchy-status` | **retained** (read-only; the restore drill uses it) |
| Auth `hierarchy-verify` | **retained**, labelled a **cache** diagnostic, not an authority check |
| Organization `ownership status` | **retained** |
| Organization read-only verification diagnostics (including the offline `verify-snapshot`) | **retained**; a **future read-only replacement** of `verify` for post-transition use writes no `ownership_event`. The existing `verify` stays where certified transition workflows need it; historical evidence and the verified digest are never changed |
| ADR-0061 reference diagnostic (§7) | **added** later as a restricted Auth CLI operation |
| Auth `freeze`, `unfreeze`, `export`; Organization `declare-class`, `import`, `approve`, `activate`, `rollback` | **kept only** for pre-transition environments and certified rehearsals; their post-F7 refusals are **mandatory** and must keep recording a rejected event |
| Auth `hierarchy-retire` (the F6 mirror); Organization `ownership retire` (the F7 step) | **kept** for the certified transition steps and rehearsals; once their phase has passed, repeating them stays **refused** (`already_retired`, `not_retirable`) with a recorded rejected event |
| `bootstrap-owner` legacy Company-insert branch | kept until the removal stage (§8); unreachable once `org_authoritative` |

**Configuration convergence.** Both CLIs move to the kit's `EnvReader` conventions in a separately authorized post-F7 stage, preserving
credential semantics, the read-only/mutating distinction, defaults, required variables and secret handling, and the certified
transition tooling while it is still required.

## 7. Decision: the ADR-0061 diagnostic

A restricted, read-only **Auth CLI** operation that reads and compares immutable reference anchors with Organization Service:

- never places or repairs a reference and never changes hierarchy authority;
- outputs only approved identifiers, presence and anchor agreement, and reason codes; never names, user details, credentials or tokens;
- respects Auth's credential scope (`allowedPlatforms`) and Organization Service's policy;
- refuses on an authority inconsistency (§4) rather than reporting misleading results.

The exact database role and the use of Auth's service token are verified at implementation.

## 8. Decision: capability-based retirement

Legacy modes (`local`, `frozen`), the transition commands and the legacy Company-insert branch may be removed only when **all** hold:

1. the relevant deployments have completed and certified F7;
2. operational recovery no longer requires the commands;
3. the G6 rehearsal requirements are satisfied;
4. dev and CI fixtures have an approved replacement for `local`;
5. mandatory regression and security checks pass;
6. a separate change approval authorizes the removal.

No calendar date applies.

## 9. Decision: recovery and backups

A future runbook rule (not authorized to be written or applied by this ADR):

- After F6, an **Auth** backup containing the old `local` marker is never restored as ordinary recovery; the existing prohibition on
  pre-F6 **Organization** backups stays.
- Backup generations are tagged by their side of the door; a restore drill compares the restored marker and phase with the recorded ones.
- A marker or phase disagreement after any restore means: do not resume traffic, refuse, escalate to the owner; never edit either side.
- Ordinary restore procedures cannot reverse the authority transition.
- Any exceptional decision is **attended and owner-decided**. ADR-0040 A1.4's AD-5 wording (changing the active authority only during a
  formally controlled, gated, auditable procedure following ADR-0040's rollback semantics) is preserved, but after the door those
  semantics require reconciliation, which is not designed; this ADR designs and authorizes **no** such mechanism.

## 10. Failure matrix

| Case | Required behavior |
|---|---|
| Source and marker disagree after F7 | not ready; alert; no fallback |
| Marker missing, invalid or unreadable | not ready (fail closed) |
| Attended F6 mirror | TRANSITIONAL handled explicitly; verified in G6 |
| Authority-changing command after F7 | refused; rejected event recorded |
| Post-F6 restore of a pre-F6 Auth or Organization backup | forbidden as ordinary recovery; detected by the agreement check; escalate |
| Organization Service unavailable | administrative writes `503`; authentication unaffected |
| Diagnostic on an inconsistent authority | refuses |

## 11. Implementation and tests (each separately authorized; blocked until F7)

> **Clarification (2026-10-09, A5.4-G1, architecture-owner authorization; a clarification, not a supersession; this ADR's status,
> this section's original text below, its rationale and its relationships are unchanged).** Implementation timing for the stages
> below is governed by the Accepted A5.4-G1 governance ([A5 record](../architecture/core-v2-a5-organization.md) §9.1), read with
> this ADR's own statement that every stage is "separately authorized and, for runtime effect, blocked until F7":
> - **Developing, merging, deploying and activating are four separate authorization events.**
> - **GREEN** (behavior-neutral static checks and documentation, such as the static boundary test) may be developed and merged under
>   individually approved tasks.
> - **YELLOW** (additive, inert implementation) needs separate development authorization; merging it needs the approved digest-pinning
>   strategy, demonstrated absence of changed deployed behavior, and a separate approval.
> - **RED** implementation stays blocked under the effective A5.4 gates, apart from explicitly approved, narrowly scoped exceptions.
> - The **F7 restriction** of this section continues to govern runtime effects and production activation. All certified G6, G7, F6
>   and F7 procedures and every authority invariant of this ADR stay in force.
> - **A5.4-A5** (the readiness check and alert of §4) is a design-approved pre-G6 exception, **not** an implementation authorization.
>   The exact TRANSITIONAL readiness behavior stays unresolved (§12) and must be specified before any transition-dependent behavior is
>   implemented.
> - The **certified image-digest-set policy** is accepted; no individual digest is selected or deployed.

Readiness check and alert; the static boundary test; the read-only `verify` replacement; the ADR-0061 diagnostic; `EnvReader`
convergence; the runbook restore rule; later, the capability-gated removal. Tests: every authority-changing command refuses after F7
with a recorded event; read-only commands write nothing; each mismatch and marker failure makes Auth not ready; the F6 transitional
sequence completes in the G6 rehearsal; authentication paths never reach the Organization Service client; a restore drill detects a
`local` marker after F6; CI passes after fixtures leave `local`.

## 12. Unresolved and non-goals

- **Unresolved:** the exact TRANSITIONAL implementation (§4); the diagnostic's database role and token use (§7); backup tagging details
  (§9); the fixture replacement for `local` (§8).
- **Non-goals:** no runtime, CLI, migration, restore or production change; no G6, G7, F6 or F7 step; no `AUTH_EVENTS` or A3M.8 change.

## Consequences

- **Easier:** one explicit post-F7 command set; mismatches fail closed and visibly; the authentication boundary is tested; diagnostics
  without restoring old authority.
- **Harder or given up:** transition code lives on until every condition of §8 holds; readiness gains a configuration dependency that
  must accommodate the attended F6 step.
- **Follow-up:** on acceptance, separately approved notes on ADR-0040, ADR-0042 and ADR-0061; the runbook rule (§9); the runbook
  statement that `/ready` "never [checks] authority" (`docs/runbooks/organization-production.md` §6.1) updated when §4 ships; A5.4
  stages.

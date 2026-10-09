# 0063. Post-F7 authority-mode, CLI and recovery convergence

- **Status:** Proposed <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-10-09
- **Deciders:** Anwar (project owner)

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

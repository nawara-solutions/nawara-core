# Core V2 A5.4-D1: implementation specifications

- **Status:** DRAFT specification (2026-10-10), on `main` at `b8fb836` (the PR #267 merge). Documentation only: a **GREEN** task under
  the Accepted A5.4-G1 governance ([A5 record](core-v2-a5-organization.md) §9.1). It is **not an ADR** and decides nothing: it restates
  the Accepted decisions of ADR-0059 to ADR-0063 at implementation depth, against the code as it is, and lists what is still open.
- **Authority.** Where this document and an Accepted ADR differ, **the ADR governs**. Nothing here authorizes code, a merge, a
  deployment or an activation; each task below needs its own authorization under its class (§2).
- **Not a contract.** Table and field names, routes, payloads and error codes that an ADR did not fix are marked *illustrative* or
  **OPEN**. An illustrative shape is a starting point for the task's own design document (TDD), never an accepted API or schema.
- **Sources:** [ADR-0042](../adr/0042-service-token-scopes-and-administrative-authorization.md),
  [ADR-0059](../adr/0059-company-ownership-transfer-and-exceptional-owner-recovery.md),
  [ADR-0060](../adr/0060-company-platform-organization-lifecycle.md),
  [ADR-0061](../adr/0061-auth-hierarchy-reference-repair-and-diagnostics.md),
  [ADR-0062](../adr/0062-initial-hierarchy-provisioning-and-first-platform-sequencing.md),
  [ADR-0063](../adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md), and the source read on `b8fb836`.

## 1. Labels

| Label | Meaning |
|---|---|
| **ALREADY IMPLEMENTED** | true in the code on `main` today |
| **ACCEPTED DESIGN — NOT IMPLEMENTED** | decided by an Accepted ADR; no code exists |
| **OPEN DECISION** | not decided; alternatives are listed, none is chosen here |
| **GATED / NOT AUTHORIZED** | blocked by a production gate or by the A5.4-G1 class of the work |

## 2. Work items and their A5.4-G1 class

**GREEN** is developed and merged under a task authorization. **YELLOW** needs its own authorization, and a merge also needs evidence
of no changed behavior in deployed images, the approved image-pinning policy and an explicit merge approval. **RED** stays blocked
until its gate or a specific governance amendment.

**The mapping below is derived, not decided,** except where an owner ruling is recorded. A5.4-G1 defines the three classes by
category; the work-item ids and the class given to each come from the A5.4 readiness audit (which is not a repository record) and from
this document. The owner confirms or corrects the class of each item when it is authorized.

**Owner rulings (2026-10-10, classification only).** A5.4-AS1 is **RED** (a production schema change and Audit Service acceptance
behavior). A5.4-K1 is **RED** (shared fail-closed runtime behavior). A5.4-AC1, additive audit-contract declarations with no
producer, stays **YELLOW**. A5.4-D1 and A5.4-D2, documentation, stay **GREEN**; behavior-neutral tests stay GREEN where individually
authorized. A classification authorizes nothing: every implementation, merge, deployment and activation still needs its own
authorization and its gates.

| Id | Work item | Class | Section |
|---|---|---|---|
| A5.4-T1 | static Auth boundary check | GREEN, **merged (PR #267)** | §5.5, §7.6 |
| A5.4-D1 | this specification | GREEN | – |
| A5.4-D2 | runbook drafts (F6 transitional state, `allowedPlatforms` change control, credential retirement, first Platform) | GREEN (editing an active runbook needs its own authorization) | §6 |
| A5.4-AC1 | audit-contract declarations | YELLOW | §7.1 |
| A5.4-AS1 | audit-service acceptance of the `steward` user kind, including its database CHECK change (in production; a digest deployment is separately authorized) | **RED** (owner ruling, 2026-10-10) | §7.1 |
| A5.4-K1 | service-kit runtime `adminTier` fail-closed validation | **RED** (owner ruling, 2026-10-10) | §7.2 |
| A5.4-A1 | inert step-up purpose declarations in Auth | YELLOW | §7.3 |
| A5.4-N1 | Notification templates without a producer | YELLOW | §7.4 |
| A5.4-A5 | Auth `/ready` source/marker check | RED, with a design-approved pre-G6 exception (no implementation authorized) | §6.5 |
| A5.4-O1 to O5 | Organization lifecycle schema, API, E4, effective-status contract, read-only `verify` | RED | §3, §6.6 |
| A5.4-O6 | `register-caller.sh` scope extension and deregistration | RED | §6.2, §6.3 |
| A5.4-A2 to A4 | `ensure` split, reference repair, diagnostic CLI | RED | §5 |
| A5.4-A6 | Auth E5 | RED | §3.8 |
| A5.4-A7 to A10 | owner lifecycle schema, transfer, stewards and recovery, bootstrap | RED | §4 |
| A5.4-E1 | consumer adoption of the effective-status check | RED | §3.9 |
| A5.4-E3 | event-driven propagation | RED, after A3M.8 | §3.10 |
| A5.4-R1 | capability-based removal of legacy modes and commands | RED | §6.7 |

## 3. A. Hierarchy lifecycle (ADR-0060; initial state: ADR-0062 §8)

**Owning service:** organization-service (states, transitions, E4, the effective-status contract). Auth owns E5; each consumer owns E1.

### 3.1 Current behavior — ALREADY IMPLEMENTED

- `company`, `platform` and `organization` have no lifecycle column; the routes create, list, read and update only
  (`apps/organization-service/db/migrations/0001_company_platform_organization.sql`; repositories under `src/`).
- Ids are never reused (the `hierarchy_id_ledger`), parents are immutable and no hierarchy row is deleted once the service is
  authoritative (`db/migrations/0004_ownership_transition.sql`).
- Human administration: `POST` and `PATCH /organization/admin/{platforms,organizations}` authenticate the end user's bearer through
  `GET /auth/grants` and write the entity, the actor record and the audit intent in one transaction. The two `POST` creates also verify
  a step-up through `POST /auth/step-up/verify`; the `PATCH` metadata updates are not sensitive and need none
  (`src/admin/admin.controller.ts`). Every hierarchy write is refused until the service is authoritative.
- The reference read `GET /organization/reference/organizations/:id` returns `{ organizationId, platformId, companyId }` under
  `hierarchy.reference.read`, within the caller's `allowedPlatforms` (`src/reference/reference.controller.ts`).

### 3.2 States and effective state — ACCEPTED DESIGN — NOT IMPLEMENTED

- Local state per entity: `ACTIVE`, `SUSPENDED`, `ARCHIVED`, for Company, Platform and Organization alike.
- Effective state = the most restrictive of the entity and its ancestors (`ARCHIVED` > `SUSPENDED` > `ACTIVE`). A child's local state
  may change while an ancestor is inactive; its effective state stays inactive.
- A new entity starts `ACTIVE` (ADR-0062 §8), and creating it requires an effectively `ACTIVE` parent (E4).
- Independent of Billing subscriptions and entitlement. No physical deletion; ids and parent links stay immutable.

### 3.3 Transitions — ACCEPTED DESIGN — NOT IMPLEMENTED

| From | To | Operation | Rule |
|---|---|---|---|
| `ACTIVE` | `SUSPENDED` | suspend | a closed-vocabulary reason code is required |
| `SUSPENDED` | `ACTIVE` | reactivate | effective state stays inactive while an ancestor is inactive |
| `ACTIVE` or `SUSPENDED` | `ARCHIVED` | archive | the prior state is recorded for audit only |
| `ARCHIVED` | `SUSPENDED` | restore | restore always lands in `SUSPENDED`; reactivation is a separate operation |
| `ARCHIVED` | `ACTIVE` | – | not allowed |
| any | the same state | – | idempotent no-op; nothing is written |
| any | deleted | – | forbidden |

Each transition takes a row lock with a version precondition (`409` on conflict) and writes its central audit intent in the same
transaction (ADR-0050 decision 9).

### 3.4 Permissions — ACCEPTED DESIGN — NOT IMPLEMENTED

| Operation | Company | Platform | Organization |
|---|---|---|---|
| suspend | active Owner, fresh factor step-up | active Owner, fresh step-up | Owner with step-up, or an Operator assigned to its Platform with Operator step-up, only while the Platform and Company are effectively active |
| reactivate | active Owner, step-up | active Owner, step-up | Owner with step-up, or that Operator under the same ancestor condition |
| archive, restore | active Owner, step-up | active Owner, step-up | Owner only |

The Organization Admin never changes lifecycle state. Inactive scopes allow only these lifecycle operations and reads; Operators lose
authority under an inactive ancestor, where only the active Owner acts. There is no universal role: an unavailable Owner is restored
first through ADR-0059 recovery. ADR-0060 names a "fresh factor step-up" for the Company suspension; for the other cells it says
"step-up" and does not fix the method.

- **Dependency (GATED):** the Operator path needs the Operator step-up mechanism, which does not exist (`admin.controller.ts` states
  that organization creation "always denies operators today"). Until it exists, only the Owner can act.
- **OPEN DECISION:** the step-up purpose names for the lifecycle operations, the accepted methods of each (factor only or not, beyond
  the Company suspension), and whether one purpose covers a family of operations.
  They are declared in Auth (`STEP_UP_METHODS`, `apps/auth-service/src/owner/step-up.service.ts`) before organization-service can verify
  them (§7.3).

### 3.5 Schema and backfill (stage L2) — ACCEPTED DESIGN — NOT IMPLEMENTED; GATED

- Decided: a local lifecycle state and a version for the precondition on each of the three tables; a forward-only, gated migration; the
  existing certified Company (and every row existing then) receives an **explicit, validated backfill to `ACTIVE`**, verified by count
  and id against the certified state inside that migration (ADR-0062 §8).
- *Illustrative, not decided:* a `status` text column with a CHECK over the three values and `NOT NULL DEFAULT 'ACTIVE'`, a
  `statusVersion` integer, and `statusChangedAt`. The prior state at archive time is audit data, not necessarily a column.
- Constraints to respect: the write gate and the no-delete triggers of migration `0004` stay; the runtime role keeps DML only; the
  snapshot and digest tooling of the ownership transition reads these tables, so a column added before F7 changes what G6 rehearses.

### 3.6 E4 in organization-service — ACCEPTED DESIGN — NOT IMPLEMENTED

Creating a child, updating metadata and every hierarchy administration check the effective state **in the same transaction**, with
the ancestor rows read under a share lock. An inactive scope allows only the lifecycle operations of §3.4 and reads.
Tests: every ancestor combination; child creation refused under a `SUSPENDED` or `ARCHIVED` parent; restore landing in `SUSPENDED`.

### 3.7 Effective-status reference contract (stage L3) — ACCEPTED DESIGN, shape OPEN (OD-L5)

- Decided: the reference read gains an **additive** effective-status field; reads for Platform and Company status are added as E5
  needs them, under the existing capability model; lifecycle status is **never memoized**; missing or unknown lifecycle information is
  treated as **inactive** (deny).
- **OPEN DECISION (OD-L5), the exact shape only:** the field name and its values (the effective state only, or local and effective);
  whether the answer names the ancestor that makes the scope inactive; how a Company read is scoped (a Company has no Platform, so
  Platform scope does not apply to it); and which capability Auth's E5 read uses. Auth holds `hierarchy.read` and uses the full-read
  routes for `ensure`; it is not admitted for `hierarchy.reference.read` today.
- Compatibility: the reference read has no production reader today (ADR-0042 A.3 lists `payment-service` and `billing-service` as derived entries awaiting owner confirmation, Billing's Platform set is empty, and
  the service refuses reads until it is authoritative), so an additive field breaks nobody. It remains a contract change (**G5**).

### 3.8 E5 in Auth (stage L4) — ACCEPTED DESIGN — NOT IMPLEMENTED

A fresh effective-lifecycle read from organization-service on **every** access-granting administrative write, including for
references Auth already holds; bounded and fail closed (`503 hierarchy_unavailable`). **The direction rule:** access-reducing actions
stay available during suspension and when the lifecycle read is unavailable; access-granting actions require an effectively `ACTIVE`
scope. One exception: ADR-0059 normal transfer is allowed while the Company is `ACTIVE` or `SUSPENDED` and denied when `ARCHIVED`.

| Auth operation | Today (`apps/auth-service/src`) | Required effective state |
|---|---|---|
| join-code creation | `OnboardingService.create` (first touch only) | Organization `ACTIVE` |
| organization-admin invitation creation | `InvitationService.create` (first touch only) | Organization `ACTIVE` |
| membership approval; organization-admin capability grant | `MembershipService` (no Organization Service call) | Organization `ACTIVE` |
| operator platform-assignment grant | `AssignmentService.grant` (first touch only) | Platform, and so Company, `ACTIVE` |
| ADR-0059 normal transfer initiation and completion | not built | Company not `ARCHIVED` |
| revocations, rejections, operator block, account suspension | – | never checked (access-reducing) |

- The never-call list is unchanged: no lifecycle read on login, refresh, logout, session validation, `/auth/me`, `/auth/grants`, the
  member-access and platform-access reads, onboarding resolution, registration, join, invitation acceptance or ADR-0023's local reads.
- **Boundary check:** each new caller is a new entry of `AUTH_ORGANIZATION_OPERATIONS` in `scripts/lib/checks.mjs` (A5.4-T1); membership
  approval and the organization-admin grant are not approved callers today, so they fail the check until they are added with E5.
- **Implementation note:** approval and rejection share one method today (`MembershipService.decide`), and so do the administrator
  grant and revocation (`MembershipService.setAdmin`). E5 applies to the granting branch only, and the boundary check approves a
  method, not a branch, so the task's design must say how the access-reducing branch stays free of the lifecycle read.
- Accepted limitations: **G2**, a lifecycle change between the E5 read and Auth's commit is not seen by that request; **G3**,
  `/auth/me` and `platform-access` still report memberships and access for inactive scopes and are not lifecycle signals.
- **OPEN (implementation detail):** the response when the entity is unknown to organization-service or outside Auth's
  `allowedPlatforms` (the contract says "treated as inactive"; the status code Auth answers is not fixed).

### 3.9 E1 in consumers (stage L5) — ACCEPTED DESIGN — NOT IMPLEMENTED

Every affected organization-scoped operation checks effective lifecycle with organization-service at the point of use and fails closed
when the scope is inactive or cannot be confirmed. Auth's `platform-access` and admin organization lookup are **not** lifecycle checks.
Prerequisites: the L3 contract; each consumer's admission and Platform scope at organization-service (ADR-0042 A.3 lists
`payment-service` and `billing-service` for the reference read as derived entries awaiting owner confirmation; other consumers are
not admitted); consumer certification (**G4**: a
forgotten check fails open). Opening callers is the last part of F7.

### 3.10 E3 event-driven propagation (stage L6) — GATED

After A3M.8 is in production and by a separate decision. It is the future answer to **G1** (codes and invitations created earlier can
still be redeemed during suspension). Nothing is specified here.

### 3.11 Reasons and audit — ACCEPTED DESIGN, vocabulary OPEN (OD-L6)

Suspension, archiving and restoration carry a documented closed-vocabulary reason code in the central audit intent; free text never
enters central audit. **OPEN DECISION (OD-L6):** the vocabulary itself. The catalog has no lifecycle action today (§7.1).

### 3.12 Activation gate and open items

- **Gate:** any lifecycle runtime is RED and blocked until F6/F7; organization-service must be authoritative for any of it to act.
- **Open:** OD-L5, OD-L6, OD-L7 (commercial settlement in inactive scopes), retention and legal erasure, an organization-scoped member
  restriction, the lifecycle step-up purposes, the Operator step-up mechanism.

## 4. B. Owner transfer and exceptional recovery (ADR-0059)

**Owning service:** auth-service. No Organization Service write and no distributed transaction.

### 4.1 Current behavior — ALREADY IMPLEMENTED

- `owner (userId, companyId)`; `owner_single_per_company_v1` is unique on every owner row; `owner.companyId`, `owner.userId` and
  `user.kind` are immutable; seven foreign keys reference `owner` with `ON DELETE RESTRICT` (Auth migrations `0001`, `0002`).
- `bootstrap-owner` takes one global advisory lock and refuses when any owner exists (`src/cli/owner-tools.ts`).
- Same-owner credential recovery with a cool-down exists and never changes who the owner is (ADR-0027; `src/owner/recovery.service.ts`).
- `GET /auth/grants` returns `companyId` for an owner (`src/auth/grants.service.ts`); organization-service, release-service and
  audit-service read authority from it.

### 4.2 Owner lifecycle and the invariant — ACCEPTED DESIGN — NOT IMPLEMENTED

- `owner.status`: `pending | active | retired`, with `retiredAt`, `retiredBy`, `retiredReason` (`transfer | recovery | abandoned`).
  One-way transitions: `pending → active`, `active → retired`, `pending → retired`.
- **Exactly one active Owner per Company that has an Owner:** a partial unique index on `owner (companyId) WHERE status = 'active'`
  replacing `owner_single_per_company_v1`, and a deferred constraint trigger (if any owner row exists for a Company, exactly one is
  `active` at commit). A Company with no owner yet is allowed.
- **Only an `active` row confers authority**, everywhere: Auth authorization, owner login and MFA, step-up, the guard on owner routes,
  and `GET /auth/grants`. A pending owner gets an enrollment token and no session; a retired owner's account is disabled.
- Migration (stage T2, RED): the status column, the partial unique index, the deferred trigger and the transfer and recovery case
  tables. *Implied by the invariant, to be fixed in the task's design:* the existing owner row becomes `active`, and `bootstrap-owner`
  creates an `active` row under the Company-keyed lock of §4.5. *Illustrative, not decided:* the case tables' names and columns.

### 4.3 Normal transfer — ACCEPTED DESIGN — NOT IMPLEMENTED

1. **Initiate:** the active Owner, with a fresh **factor-only** step-up, names the recipient's contact and an expiry. One open case per
   Company. E5: the Company must not be `ARCHIVED`.
2. **Token:** single use, stored as a hash, bound to the recipient's contact, shown once, delivered out of band.
3. **Accept:** the recipient presents the token, the bound contact and a password; a **new `kind = owner` account** with a **pending**
   owner row is created; the recipient enrolls and confirms an MFA factor. No authority and no session.
4. **Cool-down:** **24 hours**, with a notification to the current Owner, who may cancel. Completion requires that the notification
   was **delivered**; a delivery failure blocks completion.
5. **Complete:** the atomic switch of §4.5 (E5 again: Company not `ARCHIVED`).
6. Operator assignments granted by the former Owner are preserved.

**OPEN DECISION (OD-P1):** reuse of an abandoned recipient account's contact (re-binding a pending account, or requiring a new contact).
**OPEN (implementation):** the step-up purpose names; the routes; how "delivered" is established from notification-service (§7.4).

### 4.4 Exceptional recovery — ACCEPTED DESIGN — NOT IMPLEMENTED; stewardship OPEN

- Two distinct stewards initiate and approve, each with fresh MFA; the database rejects `approvedBy = initiatedBy`; neither is the claimant.
- Identity and legal ownership are verified outside Auth; Auth records evidence **references** and the procedure version only.
  Contested or high-risk cases are never approved automatically.
- A cool-down of at least **7 days**, with notification to the existing Owner and trusted channels. The existing Owner (any working
  factor, or password plus secret key) or either steward can cancel. Completion is the atomic switch of §4.5 with reason `recovery`.
- Dependencies (ADR-0059 §10): a notification, audit-contract or steward-MFA failure blocks open, approve and complete;
  **cancellation is always allowed**. Recovery may remain available for any hierarchy lifecycle state, under these same safeguards
  (ADR-0060 §9).
- Steward identity: a new `user.kind = steward`, role `steward`, its own subtype table and its own factor, step-up and challenge tables;
  tokens carry no `adminTier`; the guard is default deny and stewards are refused on `/auth/me`, `/auth/grants` and
  `/auth/step-up/verify` (logout allows them); a dedicated steward login with mandatory MFA, while password login for a steward keeps
  answering the generic `401`. Stewards never receive an owner row, Company authority or unrelated Company data.
- Residual risks accepted by ADR-0059: two colluding stewards whose case the Owner does not notice within the cool-down; a stolen
  owner session with a working factor during the 24-hour window; a recipient needing a contact no other account uses.
- **OPEN DECISIONS, none decided here:** **OD-S1** steward provisioning (its own threat model; no bootstrap or CLI is authorized);
  **OD-S2** the Release and Audit mapping of Auth's `403` for a steward; **OD-R2** the evidence standard; **OD-R4** a mandatory external
  legal or notarial step. Recovery cannot be built or enabled before OD-S1.

### 4.5 Transaction and sequencing — ACCEPTED DESIGN — NOT IMPLEMENTED

- Every ownership mutation (open, accept, cancel, approve, complete, bootstrap) first takes a transaction advisory lock keyed by the
  Company, then locks the case row and the active owner row.
- **Completion, one Auth transaction:** lock; re-check the case status, expiry, elapsed cool-down, confirmed recipient factor and that
  the case's former owner is still the active owner; retire the old row; activate the new row; disable the former account and revoke its
  refresh-token families, step-ups, challenges and pending recovery; mark the case completed; write the central audit intent; write
  domain events only when `AUTH_EVENTS=on`. Commit runs the deferred invariant. Any failure rolls back everything.
- MFA: the Owner's factor-only step-up at initiation and cancellation; the recipient's factor enrollment before completion; steward
  MFA for open, approve and cancel.
- **OPEN (implementation):** where the E5 read sits relative to this transaction (it is a network call, made outside the lock and
  re-validated or accepted as the G2 window).

### 4.6 Audit and Notification

- Central audit intents for every transition, in the same transaction; the `steward` actor kind must be accepted by audit-service
  **before** Auth emits it (§7.1).
- Notification: delivery to the current Owner before a transfer completes; to the existing Owner and trusted channels at open,
  approval and before a recovery completes (§7.4). ADR-0059 stage T6 requires notification-service **and A3M.8 in production**.

### 4.7 Tests, gates and open items

- Tests (ADR-0059 §11): the invariant; concurrency (parallel completions, completion against cancellation, two cases opened at once,
  bootstrap against transfer, recovery against transfer); authority of pending and retired owners refused everywhere; revocation; the
  transfer and recovery flows; steward confinement; audit; kit validation.
- **Gates, both default off:** `OWNER_TRANSFER` and `OWNER_RECOVERY`. All of it is RED; runtime effect also waits for the notification
  and audit prerequisites.

## 5. C. Auth reference repair and diagnostics (ADR-0061; ADR-0063 §7)

**Owning service:** auth-service. The authority for what is true is organization-service.

### 5.1 Current behavior — ALREADY IMPLEMENTED

- `HierarchyReference.ensure` fetches an entity and its parents and places them in one step: a cached row answers locally; a missing
  target is `false`; an unavailable authority, a missing parent, a refused write or a parent-link mismatch is `503
  hierarchy_unavailable`. Placement is `INSERT … ON CONFLICT DO NOTHING`, then a parent-link re-read (`src/hierarchy/hierarchy-reference.ts`).
- Callers: join-code creation, invitation creation, the platform-assignment grant and the owner bootstrap. A mismatch is only logged.
- `StepUpService.consume` runs in the caller's transaction, so a rollback restores the step-up.
- No repair, reconciliation or diagnostic exists.

### 5.2 Repair sequence — ACCEPTED DESIGN — NOT IMPLEMENTED

1. **Authenticate** the active Company Owner. When Auth's hierarchy source is `local`, the route answers the collapsed `404` here.
2. Validate the identifier (`400`); apply per-actor and per-address rate limits (`429`).
3. **Consume** a fresh, factor-only `hierarchy.reference.repair` step-up, once per authorized attempt, **in its own committed
   transaction before any lookup**, so a later `404`, `503` or rollback never restores it. It is not consumed when the request is
   refused earlier (`400`, `401`, `403`, `429`, the disabled route). It is bound to the Owner and the session that created it.
4. **Resolve without writing:** fetch an uncached target and its parents with the hardened client; for an ancestor already cached,
   compare its local parent link with the authority's (new behavior). A cached target uses its validated links without a new lookup.
5. **Authorize:** the resolved Company must be the Owner's; otherwise the collapsed `404` with no placement.
6. **Place** through the existing guarded, idempotent reference write (parents first).
7. **Audit** the success, or the no-op, in the same transaction.
8. **Respond** with the kind, the id and whether a row was placed; nothing else.

Prerequisite (A5.4-A2): `ensure` is split into a resolve step and a place step, keeping the combined behavior for its existing callers.
The repair route is a new entry of `AUTH_ORGANIZATION_OPERATIONS` (A5.4-T1).

### 5.3 Failure rules — ACCEPTED DESIGN — NOT IMPLEMENTED

| Case | Response | Placement |
|---|---|---|
| not authenticated, not an active Owner, missing or invalid step-up | `401` / `403` | none |
| malformed identifier | `400` | none |
| rate limit exceeded | `429` | none |
| hierarchy source `local` | collapsed `404` | none |
| nonexistent, outside Auth's scope, or in another Company | the same collapsed `404` | none |
| already cached and authorized | `200`, nothing placed | none |
| authority unavailable, timeout, redirect, oversized or malformed answer, credential missing or refused | `503 hierarchy_unavailable` | none |
| parent missing or parent-link mismatch | `503`; a mismatch is a security event | none |
| placement refused by the database | `503` | none |
| concurrent repairs of the same id | each `200`; one row; parent links re-validated | idempotent |
| the audit intent cannot be written | `503` | rolled back |

In every row reached after step 3 the step-up stays consumed; the rows refused before it consume nothing.

### 5.4 Audit ordering — ACCEPTED DESIGN — NOT IMPLEMENTED

- Success: a central audit intent in the same transaction as the placement or the no-op.
- Failure after rollback: **best effort** — a new transaction to the central outbox, then Auth's local audit, then a structured log.
  Failed operations have no guaranteed durable central evidence.
- A parent-link mismatch (in repair and in first-touch `ensure`) raises an operational alert. Failure records carry ids, the actor
  and a reason code only, never the authoritative hierarchy.
- **OPEN (implementation), not decided here:** the audit contract's outcomes are `succeeded` and `denied` only
  (`libs/audit-contract/src/contract.ts`). How an upstream failure or an anchor mismatch is recorded (an action of its own with one of
  those outcomes, or a contract change) is decided with A5.4-AC1.

### 5.5 Diagnostic CLI — ACCEPTED DESIGN — NOT IMPLEMENTED

A restricted, read-only **Auth CLI subcommand**, run by the operator of the Auth deployment with Auth's own read credential, never
over HTTP. It compares Auth's reference anchors with organization-service; it places nothing and changes no authority; it outputs
only approved identifiers, presence, parent-link agreement and reason codes; it respects `allowedPlatforms`; it refuses when Auth's
authority state is inconsistent (§6.5). **OPEN (implementation):** the database role, the use of Auth's service token, the output
format. It is one more approved caller of the client in the A5.4-T1 policy.

### 5.6 Gate, lifecycle interaction and residual risks

RED. The route is disabled in `local` mode, so it has no effect before F6/F7. Prerequisites: A5.4-AC1, an authorized audit-service
deployment that carries the repair actions (§7.1), the `hierarchy.reference.repair` purpose (A5.4-A1, or with the route) and A5.4-A2.

**Lifecycle (ADR-0061 §7).** A repair is **permitted while the entity or an ancestor is `SUSPENDED` or `ARCHIVED`**: it places
existence and parent links only and grants nothing, so the rule that inactive scopes allow only lifecycle operations and reads (§3.6,
organization-service's E4) does not block it. A repaired, cached or `ensure`-confirmed reference is never lifecycle evidence; every
later access-granting write still performs E5. Test: a repair succeeds under an inactive ancestor and grants no access.

**Residual risks (ADR-0061 §8):** a timing difference between "not found" and "exists in another Company"; a Platform outside Auth's
scope looks nonexistent to the API, and the diagnostic distinguishes it for operators.

## 6. D. Provisioning and the authority transition (ADR-0062; ADR-0063; A5.4-G1)

This section restates constraints. **It changes no accepted transition procedure**, and no F-step is re-run.

### 6.1 Initial hierarchy — ALREADY IMPLEMENTED (certified) and ACCEPTED

- Certified production state: F2 created the Company, F3 was a no-op, F4 bootstrapped the Owner, F5 recorded `VERIFIED`; the hierarchy
  is `1 / 0 / 0` ([cutover record](stage-21/stage-21-x-cutover-record.md)). This is the documented, last-certified state.
- No Platform or Organization exists or is created before activation. The first Platform is created by the active Owner through
  `POST /organization/admin/platforms` only after G6, G7, F6, F7, a verified post-F7 backup and a separate attended authorization.
- No Company is created after the initial one until multi-company is decided (no ownerless Company).

### 6.2 Auth's Platform scope — ACCEPTED DESIGN — NOT IMPLEMENTED; tooling gap

- Each new Platform is added to Auth's `allowedPlatforms` by a separately approved, least-privilege, audited, attended change, before
  any first touch or repair on it. A repair does not extend scope.
- Decided constraints of that change (ADR-0062 §5): it first verifies the Platform's authoritative Company association; it adds
  **exactly that Platform id** (no wildcard, no unrestricted scope, no automatic grant); it records the Platform id, the
  justification, the approval and the verification result; it is a configuration change loaded by a redeploy; an update is
  all-or-nothing, a retry converges to the same set, and a partial or failed update leaves the previous scope in force (fail closed).
- **Tooling gap (ALREADY IMPLEMENTED behavior):** `apps/organization-service/deploy/register-caller.sh` hard-codes
  `"allowedPlatforms":[]` for `auth-service` and rebuilds the policy on every run, so a later run would reset an extended scope. The
  tool must be corrected and certified first (A5.4-O6, RED: it is F-step tooling).
- **OPEN (operational contract):** the exact mechanism that implements those constraints.

### 6.3 Provisioning-credential retirement — ACCEPTED POLICY; design OPEN

The production provisioning credential must not remain able to create Companies after the initial transition. ADR-0062 §7 already
places the disablement **after activation**, when no rollback exists; the exact timing relative to F7 and the post-F7 backup, the
method, the verification and the recovery implications are designed and approved separately. The tool has no deregistration path
today. The provisioning **identity** remains an architectural role; a future credential needs its own authorization.

### 6.4 F6/F7 authority invariants — ALREADY IMPLEMENTED

- organization-service: `ownership_state` cannot move backward from `ACTIVE`; `rollback`, `import`, `declare-class`, `approve` and
  `activate` refuse after activation, each with a recorded event (`src/ownership/ownership-admin.ts`, migration `0004`).
- Auth: the marker cannot leave `org_authoritative`; in that mode only the reference-cache protocol writes, never a delete (migration
  `0008`). Auth `hierarchy-retire` is the F6 mirror; organization-service `ownership retire` is the F7 step.
- The one-way door is the first committed hierarchy write after activation (ADR-0040 A2.6).

### 6.5 Readiness check (A5.4-A5) — design-approved exception; NOT AUTHORIZED

- Decided: once the marker is `org_authoritative`, any source/marker disagreement, in either direction, and a missing, invalid or
  unreadable marker make Auth **not ready**, with a named reason and an alert; no fallback to local authority; no new startup
  database dependency.
- Design constraints (A5.4-G1): Auth only; one check in the kit's readiness registry (`/ready`); `/auth/health` stays database-only
  and outside the deploy health path; no marker, trigger, CLI, `ensure`, migration or deploy-script change.
- **OPEN DECISION:** the F6 **TRANSITIONAL** behavior. The check reads the marker and the source, not organization-service's phase, so
  it cannot by itself tell the attended F6 window from a mismatch. It must be specified before any transition-dependent behavior is
  implemented or the merge is approved, and certified in G6. The runbook statements that `/ready` never checks authority and that an
  Auth not-ready is critical (`docs/runbooks/organization-production.md` §6.1, §6.3) are updated when the check ships.

### 6.6 CLIs and diagnostics after F7

- **ALREADY IMPLEMENTED and retained:** Auth `hierarchy-status` and `hierarchy-verify` (a cache diagnostic, not an authority check);
  organization-service `ownership status` and the offline `verify-snapshot`.
- **ALREADY IMPLEMENTED, kept only for pre-transition environments and certified rehearsals:** Auth `freeze`, `unfreeze` and
  `export`; organization-service `declare-class`, `import`, `approve`, `activate` and `rollback`. Auth `hierarchy-retire` (the F6
  mirror) and organization-service `ownership retire` (the F7 step) are kept for those steps. All keep refusing, with a recorded
  event, once their phase has passed. The legacy Company-insert branch of `bootstrap-owner` is kept until the removal stage and is
  unreachable once the marker is `org_authoritative`.
- **ACCEPTED DESIGN — NOT IMPLEMENTED:** a read-only replacement of `ownership verify` (which appends an `ownership_event` today) for
  post-transition use; the move of both CLIs to the kit's `EnvReader` in a post-F7 stage (Auth is partly converged).

### 6.7 Certified digest set, backups and removal

- **Certified digest set (accepted policy, not executed):** G6 selects and rehearses one exact digest each for auth-service,
  organization-service and audit-service; F6/F7 deploy only that set, including configuration-only redeploys; any change needs a
  re-rehearsal. No digest is selected here. The control is procedural.
- **Backups:** after F6 a pre-F6 Auth or Organization backup is never an ordinary restore (`docs/runbooks/core-backup-restore.md` §7).
  The rule is procedural: no tool enforces it and it has not been rehearsed. Tagging backup generations by their side of the door
  (ADR-0063 §9) is not designed. Reconciliation after the one-way door is not designed either, and no recovery mechanism is authorized.
- **Removal (A5.4-R1):** legacy modes and transition commands are removed only when every condition of ADR-0063 §8 holds.

## 7. E. Shared-service contracts

### 7.1 Audit, consumer first (A5.4-AC1, A5.4-AS1) — ACCEPTED DESIGN — NOT IMPLEMENTED

- Today: `USER_KINDS` is `member | owner | operator`; outcomes are `succeeded | denied`; the catalog holds `company`, `platform` and
  `organization` `created` / `updated`, `hierarchy.admin_operation_denied` and owner security actions; audit-service enforces the
  user kind in a database CHECK (`libs/audit-contract/src`; `apps/audit-service/db/migrations/0001_audit_record.sql`).
- Needed, each named by an ADR: lifecycle transitions with a reason code (ADR-0060); repair success, repair refusal and anchor
  mismatch (ADR-0061); transfer, recovery and steward actions and the `steward` user kind (ADR-0059); a bootstrap action for any future
  bootstrap-capable implementation (ADR-0062).
- **Order:** the contract declares; audit-service accepts (and is deployed, separately authorized, since it is in production); only
  then does a producer emit. A declaration without a producer is inert.
- **Two kinds of acceptance.** New *actions* reach audit-service through the contract library built into its image, so accepting them
  is an audit-service deployment of a build that contains A5.4-AC1 (the deploy boundary, separately authorized). The `steward` *user
  kind* also needs the database CHECK change: that is A5.4-AS1.
- **Class (owner ruling, 2026-10-10, §2):** A5.4-AS1 is **RED**: accepting the `steward` user kind means extending audit-service's
  database CHECK, a schema change of a production service, and changes what the service accepts. A5.4-AC1, producer-less
  declarations, stays **YELLOW**. The ruling is a classification; it authorizes no migration, deployment or activation.
- **Evidence AC1 must provide (YELLOW merge condition):** the contract's validation and screening code, which runs inside
  audit-service and the producers, reads `USER_KINDS` (`libs/audit-contract/src/validate.ts`, `screen.ts`). A declaration is mergeable
  as YELLOW only with evidence that it changes no deployed image's behavior; a `steward` value in `USER_KINDS` needs that evidence
  like any other declaration, or it travels with AS1 (alone, it would be accepted by validation and rejected by the database CHECK).
- **AS1's scope** also covers audit-service's own types: its query API enumerates the user kinds
  (`apps/audit-service/src/query/query.dto.ts`), as ADR-0059 §8 says ("audit-service's type and its … CHECK").
- **OPEN:** action names and target types; the reason-code vocabulary (OD-L6); the outcome question of §5.4.

### 7.2 service-kit (A5.4-K1) — ACCEPTED DESIGN — NOT IMPLEMENTED

`HttpAuthClient.getIdentity` returns `adminTier` unvalidated today (`libs/service-kit/src/service-auth/auth-client.ts`). Decided: it
validates `adminTier ∈ {owner, operator, null}` and fails closed otherwise (ADR-0059 §8; part of its stage T5, the steward work,
after OD-S1). It changes the kit, which every image contains, and it is a behavior change (a previously accepted value is refused).
**Class (owner ruling, 2026-10-10, §2): RED.** It is not a prerequisite of the lifecycle or repair work.

### 7.3 Inert step-up purposes (A5.4-A1) — ACCEPTED DIRECTION; names OPEN

`STEP_UP_METHODS` is the server-side allow-list of purposes and their methods; `POST /auth/step-up/verify` consumes one for a caller
service. Decided: `hierarchy.reference.repair` is factor-only (ADR-0061); the transfer initiation and cancellation need a
factor-only step-up (ADR-0059); the Company suspension needs a fresh factor step-up (ADR-0060). A declaration with no route that
requires it activates nothing. **OPEN:** the lifecycle and transfer purpose names, and the accepted methods of the other lifecycle
operations. `platform.create` and `organization.create` accept the secret key today; making them factor-only is undecided.

### 7.4 Notification (A5.4-N1) — ACCEPTED DESIGN — NOT IMPLEMENTED

- Today: notification-service is implemented and certified for email and SMS, **not in production**; its templates cover contact
  verification, operator codes, owner new-device login, owner recovery requested and completed, and membership outcomes.
- Needed: templates for a transfer opened, cancelled and completed and for the recovery notifications. A template with no producer
  is inert.
- Responsibility: Auth decides who is notified and requires delivery before completion; notification-service delivers and reports the
  delivery state. **OPEN (implementation):** how Auth learns "delivered" (a read of the delivery state, or an event), the template keys
  and their data. Production use needs notification-service and A3M.8 in production (ADR-0059 stage T6).

### 7.5 Consumer integration prerequisites

The L3 contract (§3.7); admission and Platform scope at organization-service per consumer; the F7 step that opens callers; consumer
certification of E1. ADR-0023's local reads and `/auth/me` are not lifecycle signals.

### 7.6 The boundary check (A5.4-T1) — ALREADY IMPLEMENTED

`checkAuthOrganizationBoundary` (`scripts/lib/checks.mjs`) refuses any Auth path to organization-service that is not an approved
administrative operation. E5, repair and the diagnostic each add their entry when implemented. It reads syntax: it does not follow a
value returned by a getter or a function, stored in another object, destructured or untyped, nor reflection; its comment lists the
limits. It narrows what a reviewer must look for and does not prove the absence of a runtime path.

## 8. Dependencies

These are the dependencies the ADR stages state (ADR-0059 §13, ADR-0060 §11, ADR-0061 §10). **This is not a delivery schedule**, and
the three tracks are independent of each other except where a line says so.

```text
Shared first step, for every track that audits:
  audit-contract declarations (AC1) → an authorized audit-service deployment that carries them

Lifecycle (ADR-0060 stages L2 to L6):
  organization-service: L2 schema + backfill, lifecycle API, E4 → L3 effective status
    the lifecycle API's step-ups need their purposes declared in Auth first (A1); a code fact, not an ADR stage:
    organization-service verifies a step-up through Auth, and Auth refuses a purpose it does not list
  L3 → Auth: E5 (A6, stage L4)
  L3 → consumers: E1 (stage L5, with consumer certification)
  later: E3 (stage L6, after A3M.8)

Reference repair (ADR-0061 stages R2 to R4; no lifecycle prerequisite):
  AC1 and its audit-service deployment → Auth: the ensure split, the repair purpose and the route (A1, A2, A3)
  diagnostic (A4): after the OD-A5-5 policy (decided by ADR-0063) and its open implementation details;
    the ADR states no dependency on repair

Ownership (ADR-0059 stages T2 to T7):
  Auth: owner lifecycle and active-only authority (A7; T2, T3) → transfer API behind OWNER_TRANSFER (A8; T4)
  notification integration (N1; T6) needs notification-service and A3M.8 in production; a transfer completes only
    after a delivered notification, so the gate cannot be enabled before T6
  after OD-S1, the steward work together (T5): the steward kind and audit-service's CHECK (AS1),
    the service-kit adminTier validation (K1), steward MFA and the recovery API (A9)
  E5 is extended to the transfer path once both exist (ADR-0060 stage L4)

Last: capability-based removal of legacy modes and commands (R1)
```

A5.4-AS1 and A5.4-K1 belong to the steward work only; neither is a prerequisite of the lifecycle or repair tracks. The Auth ↔
organization-service cycle is administrative only (organization-service reads grants and verifies step-ups in Auth; Auth reads
references and status in organization-service); for the lifecycle track it is ordered by deployment: Auth's inert purposes, then
organization-service's lifecycle and status contract, then Auth's E5.

## 9. Open decisions, consolidated

| Decision | Blocks |
|---|---|
| OD-L5 effective-status contract shape | L3, E5, E1 |
| OD-L6 reason-code vocabulary | lifecycle transitions and their audit actions |
| OD-L7 commercial settlement in inactive scopes | Billing and Payment behavior (a separate decision) |
| lifecycle and transfer step-up purpose names; factor-only for Platform and Organization creation | A1; the lifecycle API |
| Operator step-up mechanism | the Operator lifecycle path |
| OD-S1 steward provisioning; OD-S2; OD-R2; OD-R4; OD-P1 | recovery; details of transfer |
| audit action names and the failure-outcome question | AC1, repair |
| how Auth learns notification delivery; template keys | transfer completion |
| F6 TRANSITIONAL readiness behavior | A5.4-A5 |
| diagnostic database role, token use and output format | A4 |
| the exact `allowedPlatforms` mechanism (its constraints are decided, §6.2); provisioning-credential retirement design | the first Platform |
| the E5 answer for an unknown or out-of-scope entity; E5 placement relative to ownership transactions; the capability of the E5 read | E5 |
| retention and legal erasure; an organization-scoped member restriction (ADR-0060 §12) | later lifecycle work |
| backup-generation tagging; the replacement of `local` in dev and CI fixtures (ADR-0063 §12) | the restore procedure; removal (R1) |
| reconciliation after the one-way door (not designed; ADR-0040, ADR-0063 §9) | any post-activation ownership recovery |
| which digests form the certified set (selected at the G6 refresh) | F6/F7 |
| multi-company; future Company onboarding; a future Strategy C for ownership (ADR-0059 §12) | any second Company |

## 10. What this document does not do

It implements nothing, selects no digest, changes no ADR, runbook, schema, test or check, and authorizes no task. Each work item of §2
gets its own design document (a TDD, and an SDD update for the owning service) with the task that is authorized to build it.

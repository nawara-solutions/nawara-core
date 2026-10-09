# 0060. Company, Platform and Organization lifecycle

- **Status:** Accepted (2026-10-09, by the architecture owner, A5.3 OD-A5-1 owner authorization) <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-10-09
- **Deciders:** Anwar (project owner)

> **Acceptance note (2026-10-09, A5.3 OD-A5-1).** The architecture owner accepted the architectural design of this ADR as written
> (§3 to §12). The Proposed-era notes below are kept unchanged as history; their statement "This ADR is **Proposed**: it is not
> accepted" is replaced by this note, while "nothing in it is implemented, and it activates nothing" remains true. Acceptance:
> 1. **Implements and activates nothing.** No lifecycle runtime exists; every stage of §11 is separately authorized and stays blocked,
>    for runtime effect, until F6/F7.
> 2. **The E5 amendment of ADR-0040 decision 2** (§7) is accepted through this ADR: only Auth's access-granting administrative writes
>    make a fresh, fail-closed lifecycle read; authentication, sessions, registration, join, `/auth/me` and the ADR-0023 local reads
>    never call Organization Service.
> 3. **Accepted residual risks:** G1 (earlier join codes or invitations may still be redeemed during suspension, with no effective
>    product access until the scope is active) and G2 (E5's cross-service time-of-check/time-of-use window, requiring point-of-use
>    enforcement). These are accepted architecture limitations, **not** permission to deploy unprotected access paths.
> 4. **Deferred** (§12): retention and legal erasure; E3 event-driven propagation after A3M.8; OD-L7; an organization-scoped member
>    restriction; the exact OD-L6 reason vocabulary; the exact OD-L5 reference-contract shape.
> 5. **Relationships.** The "proposed relationships" listed in the preserved note below now take effect in substance: the amendment of
>    ADR-0040 decision 2, the clarification of ADR-0042 decision 5 and the partial supersession of ADR-0050 decision 12's lifecycle
>    scope bullet are decided by this acceptance; those ADRs' status lines and backlinks are **not**
>    changed here and require separate, explicit approvals and commits.

> **Clarified by [ADR-0062](./0062-initial-hierarchy-provisioning-and-first-platform-sequencing.md)** (Accepted 2026-10-09, A5.3
> OD-A5-2; a clarification of the initial lifecycle state, not a supersession; status, decisions and text unchanged). A newly created
> Company, Platform or Organization starts with local lifecycle state **`ACTIVE`**, and creating a child requires an **effectively
> `ACTIVE` parent** (E4, §7). The existing certified Company receives a **controlled `ACTIVE`-state backfill** when the separately
> authorized §11 L2 stage runs. No migration, lifecycle API or schema change is authorized by this note, and no service is activated by it.

> **Status of this document.** The architecture owner approved the **policy direction** of OD-A5-1 (2026-10-09), recorded below.
> This ADR is **Proposed**: it is not accepted, **nothing in it is implemented**, and it activates nothing. Every implementation stage
> is separately authorized and blocked, for runtime effect, until the ownership transition F6/F7 (§11).
>
> **Proposed relationships, effective only if this ADR is Accepted** (no other ADR is edited by this draft):
> - [ADR-0040](./0040-organization-ownership-migration-decisions.md): a **narrow amendment of decision 2** (§7, E5); decision 1, A1.2
>   and the interim invariant I2(b) (no physical deletion) are kept;
> - [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md): **clarifies decision 5** so that its memoization of
>   hierarchy references never applies to lifecycle status, and adds an effective-status reference contract (§8);
> - [ADR-0050](./0050-platform-administration-and-verified-human-authority.md): **partly supersedes** only the decision 12 Stage 19
>   scope bullet "organization lifecycle (suspend or archive; BD-5)"; decisions 5, 7, 9 and 10 stand and constrain this ADR;
> - [ADR-0023](./0023-platform-access-check-and-operator-login-decoupling.md): its local reference-read contract (D1(a)) is
>   **preserved**;
> - [ADR-0059](./0059-company-ownership-transfer-and-exceptional-owner-recovery.md): the transfer and recovery interaction is
>   documented (§9);
> - [ADR-0026](./0026-authentication-is-not-entitlement.md): the separation of authentication and commercial entitlement is
>   **preserved**.

## 1. Context

**Implemented today (verified on `main` at `459a565`):**

- No lifecycle exists in either service. organization-service's `company`, `platform` and `organization` have no status, archive or
  delete path, deliberately (`apps/organization-service/db/migrations/0001_company_platform_organization.sql`; its README and SDD).
  Its routes create, list, read and update only.
- Auth's hierarchy rows have no status either. After the ownership transition they are a validated, non-authoritative reference cache:
  rows are placed only by `ensure`, are **never updated** and never deleted (`apps/auth-service/db/migrations/0008_hierarchy_authority.sql`;
  `src/hierarchy/hierarchy-reference.ts`). A row already cached answers `ensure` locally, without calling organization-service.
- Hierarchy ids are never reused (I1) and rows are never physically deleted once organization-service is authoritative (I2(b)),
  by database triggers (`apps/organization-service/db/migrations/0004_ownership_transition.sql`). Parent links are immutable in both
  services.
- The only suspension that exists is **account** suspension (`user.isActive`), owner-only and global (ADR-0050 decision 5).

**Accepted constraints:**

- organization-service is the only authority for Company, Platform and Organization and their lifecycle after it becomes authoritative
  (ADR-0040 A1.2); Auth is not a second authority.
- Authentication, session, `/auth/me`, the member access check, onboarding resolution, registration, join and acceptance never call
  organization-service (ADR-0040 decision 2); today only an administrative **first touch** may.
- `GET /auth/platform-access/:platformId` and `GET /auth/admin/organizations/:id` read Auth's local rows; a cache miss is the collapsed
  `404`; no ensure-on-read (ADR-0023 D1(a)).
- Security suspension is not commercial state (ADR-0050 decision 10); authentication is not entitlement (ADR-0026).

## 2. Options considered

**Propagation**
1. *A. Cascade: write descendant states.* Rejected: many rows per action, provenance needed to restore correctly, more locking.
2. **B. Independent local state; effective state derived from the entity and its ancestors (chosen).** One row per action; restoration
   is exact; parent links are immutable, so the ancestor path never changes.

**Enforcement**
1. **E1.** Products and services check effective lifecycle at the point of use (chosen).
2. *E2.* A synchronous Auth → organization-service lookup on authorization reads. Rejected: contradicts ADR-0040 decision 2 and ADR-0023
   D1(a) and adds an availability dependency to every check.
3. *E3.* Organization-service pushes lifecycle changes to Auth through events. Not now: requires production messaging (A3M.8) and a
   cache-update path; recorded as a future alternative (§12).
4. **E4.** organization-service checks effective lifecycle before hierarchy administration (chosen).
5. **E5.** Auth's administrative, access-granting writes check effective lifecycle with organization-service on every operation
   (chosen; a narrow amendment of ADR-0040 decision 2).

## 3. Decision: states and effective state

- **States:** `ACTIVE`, `SUSPENDED`, `ARCHIVED`, for Company, Platform and Organization alike.
- **No physical deletion.** Ids and parent relationships stay immutable (I1, I2(b), ADR-0024 anchors). This ADR is the lifecycle
  decision ADR-0040 A2.3 refers to: it **keeps** I1 and I2(b) as permanent lifecycle rules, so ADR-0042 decision 5's memo of existence
  and parent links stays valid.
- **Local state** per entity; **effective state** = the most restrictive of the entity and its ancestors, with
  `ARCHIVED` > `SUSPENDED` > `ACTIVE`.
- A child's local state may change while an ancestor is inactive, but its effective state stays inactive: restoring or reactivating a
  child can never bypass an inactive ancestor.
- Lifecycle is independent of Billing subscriptions and commercial entitlement; it is never set by, or derived from, either.

## 4. Decision: transitions

| From | To | Operation | Notes |
|---|---|---|---|
| ACTIVE | SUSPENDED | suspend | closed-vocabulary reason code required (§6) |
| SUSPENDED | ACTIVE | reactivate | effective state still inactive while an ancestor is inactive |
| ACTIVE or SUSPENDED | ARCHIVED | archive | the state before archiving is recorded for audit only |
| ARCHIVED | SUSPENDED | restore | restore **always** lands in SUSPENDED; reactivation is a separate authorized operation |
| ARCHIVED | ACTIVE | – | not allowed directly |
| any | same | – | idempotent no-op; nothing written |
| any | deleted | – | forbidden |

Every transition takes a row lock with a version precondition (`409` on conflict) and writes its central audit intent in the same
transaction (ADR-0050 decision 9).

## 5. Decision: permissions

| Operation | Company | Platform | Organization |
|---|---|---|---|
| suspend | active Owner, fresh factor step-up | active Owner, fresh step-up | Owner with step-up, or an Operator assigned to its Platform with Operator step-up (ADR-0042 Amendment 1), only while the Platform and Company are effectively active |
| reactivate | active Owner, step-up | active Owner, step-up | Owner with step-up, or that Operator under the same ancestor condition |
| archive | active Owner, step-up | active Owner, step-up | **Owner only** |
| restore | active Owner, step-up | active Owner, step-up | **Owner only** |

- **Organization Admin** never changes lifecycle state.
- **Inactive scopes:** only the narrowly authorized lifecycle operations above and reads are permitted; ordinary administration is denied.
  Operators lose authority under an inactive ancestor; only the active Owner acts there.
- **No universal role.** If the Owner is unavailable, ownership is restored first through ADR-0059 recovery (separately gated).

## 6. Decision: reasons and audit

Suspension, archiving and restoration carry a **documented closed-vocabulary reason code** (OD-L6), recorded in the central audit
intent; free text never enters central audit (as ADR-0050 decision 5).

## 7. Decision: enforcement (E4 + E1 + E5)

**The direction rule.** Access-reducing actions stay available during suspension and when the lifecycle read is unavailable, subject to
existing authorization: revoking memberships, assignments, join codes and invitations; operator block; account suspension; ADR-0059
recovery. Access-granting actions require an effectively `ACTIVE` scope and fail closed. **One owner-approved exception:** ADR-0059
normal ownership transfer is not a scope-access grant; it is allowed while the Company is `ACTIVE` or `SUSPENDED` and denied when it is
`ARCHIVED` (§9).

**E4 (organization-service).** Creating a child, updating metadata and every hierarchy administration check the effective state in the
same transaction (the ancestor rows read under a share lock); inactive scopes allow only §5's lifecycle operations and reads.

**E1 (products and services).** Every affected organization-scoped operation checks effective lifecycle with organization-service at the
point of use and **fails closed** when it is inactive or cannot be confirmed. Auth's `platform-access` and admin organization lookup
**are not lifecycle checks**: a `200` there does not mean "active" (ADR-0023 D1(a) preserved).

**E5 (Auth administrative access-granting writes).** A fresh effective-lifecycle read from organization-service on **every**
operation, including for references Auth already holds; bounded and fail closed (`503 hierarchy_unavailable`):

| Auth operation | E5 | Required effective state |
|---|---|---|
| join-code creation | required | Organization effectively `ACTIVE` |
| organization-admin invitation creation | required | Organization effectively `ACTIVE` |
| membership approval; organization-admin capability grant | required | Organization effectively `ACTIVE` |
| operator platform-assignment grant | required | Platform (and so Company) effectively `ACTIVE` |
| ADR-0059 normal ownership-transfer initiation and completion | required | Company not `ARCHIVED` (the §7 exception) |
| revocations, rejections, operator block, account suspension | **not** checked | – (access-reducing) |

**Narrow amendment of ADR-0040 decision 2.** E5 extends the administrative paths that may call organization-service from "first touch"
to "every access-granting administrative write". It does **not** authorize any organization-service call on login, refresh, logout,
session validation, `/auth/me`, the member access check, onboarding resolution, registration, join, invitation acceptance,
`platform-access` or the admin organization lookup.

## 8. Decision: effective-status reference contract (OD-L5)

- organization-service's reference read gains an **additive** effective-status field; reads for Platform and Company status are added as
  E5 needs them, under the existing service-token capability model (ADR-0042).
- **Lifecycle status is never memoized.** ADR-0042 decision 5's memo applies to hierarchy existence and parent links only, which are
  immutable (I1); every lifecycle decision reads current status.
- Missing or unknown lifecycle information is treated as **inactive** (deny).

## 9. Decision: interaction with ADR-0059

- Ownership is Auth state and independent of hierarchy lifecycle; exactly one active Owner is unaffected.
- **Normal transfer is denied for an ARCHIVED Company** (checked through E5 at initiation and completion); it is allowed while the
  Company is ACTIVE or SUSPENDED.
- **Exceptional recovery** may remain available for any lifecycle state, under ADR-0059's existing safeguards (disabled by default;
  OD-S1 open); stewards access only the recovery case.

## 10. Residual risks and gaps

- **G1, redemption.** Join codes and invitations created while a scope was active can still be redeemed after it becomes inactive:
  registration, join and acceptance never call organization-service. The resulting membership must never bypass E1 at the point of use.
  Future alternative: event-driven revocation of outstanding codes and invitations (E3, after A3M.8).
- **G2, E5 concurrency window.** A lifecycle change between E5's read and Auth's commit is not seen by that request (one request wide).
  Product authorization must therefore fail closed on its own (E1).
- **G3.** `/auth/me` and `platform-access` still report memberships and access for inactive scopes; consumers must not treat them as
  lifecycle signals.
- **G4.** E1 depends on every product service implementing the check; a forgotten check fails open. Consumer certification is required.
- **G5.** The reference-contract additions are a contract change for organization-service consumers.

## 11. Implementation stages (each separately authorized; runtime effect blocked until F6/F7)

| Stage | Content |
|---|---|
| L1 | owner review and acceptance; then the separately approved relationship metadata on ADR-0040, ADR-0042 and ADR-0050 |
| L2 | organization-service: lifecycle columns, transitions, permissions, reason codes, audit, E4 (a gated migration) |
| L3 | organization-service: the effective-status reference contract (§8) |
| L4 | Auth: E5 on the access-granting writes of §7, with regression tests (and the ADR-0059 transfer path once it exists) |
| L5 | product and service adoption of E1, with consumer certification |
| L6 | E3 event-driven propagation, after A3M.8 is in production (a separate decision) |

Minimum tests: the transition table and version conflicts; effective state for every ancestor combination; E4 refusals; restore landing
in SUSPENDED; no deletion; E5 on every listed write including cached references, fail closed when organization-service is unavailable;
access-reducing actions unaffected; authentication paths never call organization-service; ADR-0059 transfer denied for an ARCHIVED Company
and recovery unaffected.

## 12. Open decisions

- Retention and legal erasure for archived entities.
- Future event-driven lifecycle propagation (E3).
- OD-L7: commercial settlement and invoicing restrictions for inactive scopes (a separate Billing/Payment decision).
- An organization-scoped (non-global) member restriction (ADR-0050's "future concern").
- The exact reason-code vocabulary (OD-L6) and the exact reference-contract shape (OD-L5).

## Consequences

- **Easier:** one authority for lifecycle; exact restoration; access-reducing operations never blocked; no deletion and no cross-service
  write.
- **Harder or given up:** Auth's administrative writes gain a fail-closed organization-service dependency (E5); product services must
  implement E1; redemption of earlier codes stays possible (G1); a per-request concurrency window (G2).
- **Follow-up:** the stages of §11; on implementation, the organization-service SDD and README and the Auth ADD and SDD are updated;
  the A5 record tracks progress.

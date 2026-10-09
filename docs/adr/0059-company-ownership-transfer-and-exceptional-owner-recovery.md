# 0059. Company ownership transfer and exceptional owner recovery

- **Status:** Accepted (2026-10-09, by the architecture owner, A5.3 owner authorization) <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-10-09
- **Deciders:** Anwar (project owner)

> **Acceptance note (2026-10-09, A5.3).** The architecture owner accepted the architecture of this ADR as written (§3 to §14). The
> Proposed-era notes below are kept unchanged as history; their statement "This ADR is **Proposed**: it is not accepted" is replaced
> by this note, while "nothing in it is implemented, and it activates nothing" remains true. Acceptance:
> 1. **Implements and activates nothing.** No runtime feature exists; both activation gates (§10) stay off; no ownership transfer or
>    exceptional recovery may be enabled until its prerequisites are implemented and certified.
> 2. **OD-S1 is deferred** to a separate threat model and owner approval. **No steward account may be provisioned and no
>    exceptional-recovery endpoint may be enabled** until OD-S1 is resolved and every required security control is implemented and
>    certified. OD-S2, OD-P1, OD-R2, OD-R4, multi-company ownership and Organization lifecycle interaction remain open (§12).
> 3. **Relationships (§14).** The partial supersession of ADR-0017 and ADR-0050 and the amendment of ADR-0024 are decided by this
>    acceptance; their status lines and backlinks are **not** changed here and require separate, explicit approvals and commits.
> 4. **Cross-service work** (audit contract and audit-service, service-kit, notification, downstream services) remains separately
>    gated and authorized (§8, §13).

> **Status of this document.** The architecture owner approved the **policy direction** of OD-A5-3 (2026-10-09): exactly one active
> Owner per Company, controlled transfer, and exceptional recovery, with the decisions OD-T1 to OD-T4, OD-R1 and OD-R3 recorded below.
> This ADR is **Proposed**: it is not accepted, **nothing in it is implemented**, and it activates nothing. Every implementation stage
> is separately authorized (§13).
>
> **Proposed relationships, effective only if this ADR is Accepted** (no other ADR is edited by this draft):
> - partly supersedes [ADR-0017](./0017-single-owner-with-secret-key-force-reset.md): the permanence of the single owner and "no
>   ownership-transfer mechanism will be built"; the exactly-one-active-owner principle is kept;
> - partly supersedes [ADR-0050](./0050-platform-administration-and-verified-human-authority.md) on its historical Stage 19 scope
>   passages only (§14); every other ADR-0050 decision stands and constrains this ADR;
> - amends [ADR-0024](./0024-database-enforced-tenancy-and-authorization-integrity.md) (owner cardinality and lifecycle) without
>   accepting it;
> - complements [ADR-0025](./0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md) and
>   [ADR-0027](./0027-service-layer-security-model.md) (same-owner credential recovery, unchanged); consistent with
>   [ADR-0040](./0040-organization-ownership-migration-decisions.md) A1.2 (Auth owns the owner; the Company is Organization's) and
>   [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md) (`GET /auth/grants`).

## 1. Context and current restrictions

The owner's policy (OD-A5-3): **a Company has exactly one active Owner; ownership may be transferred through a secure, controlled
process, with a separate exceptional recovery process when the existing Owner is unavailable.**

Today ownership is permanent. Verified in `apps/auth-service` (implemented):

- The owner ↔ company association is Auth's table `owner` (`userId` primary key, `companyId`), migration `0001`. organization-service
  holds no owner state; it learns a human's authority live from `GET /auth/grants` (ADR-0042); so do release-service and audit-service.
- `owner_single_per_company_v1` is a unique index on **every** owner row (`0001`); `owner_company_immutable` freezes `companyId` and
  `userId` (`0002`); `user_kind_immutable` freezes `user.kind` (`0001`).
- Seven foreign keys reference `owner` with `ON DELETE RESTRICT` (factors, step-up, challenges, recovery requests, admin devices, and
  `platform_assignment.assignedBy`/`revokedBy`), so an owner row can never be deleted or re-pointed.
- The deferred trigger `user_require_subtype` requires an `owner` row for every `kind = owner` account at commit.
- `user.email` and `user.phone` are each `UNIQUE` (one contact, one account).
- `bootstrap-owner` refuses when any owner exists anywhere (one owner system-wide in practice).
- Same-owner credential recovery (ADR-0027: password + secret key, cool-down, re-enrollment) exists and never changes who the owner is.

## 2. Options considered

**Identity of the new Owner**
1. **A. A new dedicated `kind = owner` account (chosen, OD-T2).** Fits the schema (same shape as bootstrap); existing member and
   operator accounts and memberships are untouched; immutable `kind` and `companyId` are kept. Cost: the recipient needs a contact no
   other account uses.
2. *B. Converting an existing member or operator.* Rejected: blocked by immutable `kind`, the role CHECK, the `(userId, kind)` subtype
   foreign keys, member-only and undeletable memberships, and the operator assignment foreign keys.
3. *C. Separating ownership authority from identity kind.* Not chosen now: it rewrites every owner path (MFA tables reference `owner`)
   and changes the `adminTier` contract read by `libs/service-kit`, billing-service and payment-service. A possible future ADR.

**Exceptional recovery authority**
1. **R-a. Dedicated recovery-steward identities in Auth with two-person approval (chosen, OD-R1).**
2. *R-b. Operators or the vendor Company's owner.* Rejected: company insiders, or a second owner (ADR-0050 decision 7).
3. *R-c. A privileged CLI.* Rejected: ADR-0050 decision 14 (no privileged recovery CLI; no direct database recovery).

## 3. Decision: exactly one active Owner

*Sections 3 to 10 state the **proposed** design. None of it is implemented: today's code behaves as described in §1 (for example,
token issuance would give any new non-member kind its own name as `adminTier`).*

**Every Company that has an Owner has exactly one active Owner.** Database-enforced (proposed):

- a partial unique index on `owner (companyId) WHERE status = 'active'`, replacing `owner_single_per_company_v1`;
- a deferred constraint trigger: for each Company touched in a transaction, if any owner row exists, exactly one is `active` at commit.
  A Company with no owner yet (before bootstrap) is allowed.

Owner rows are never deleted or re-pointed; every historical reference stays valid.

## 4. Decision: Owner lifecycle `pending → active → retired`

- `owner.status`: `pending | active | retired`, with `retiredAt`, `retiredBy`, `retiredReason` (`transfer | recovery | abandoned`).
- One-way transitions only: `pending → active`, `active → retired`, `pending → retired`; never back to `active`. `companyId`, `userId`
  and `kind` stay immutable.
- **Only an `active` owner row confers Company authority**, everywhere: Auth authorization, owner login and MFA, step-up, the guard on
  owner routes, and `GET /auth/grants` (which returns `companyId` only for an active owner). Pending and retired owners have none.
- A pending owner receives no session, only an enrollment token. A retired owner's account is disabled (OD-T1).

## 5. Decision: normal ownership transfer

1. **Initiate.** The active Owner opens a transfer case with a fresh **factor-only** step-up (TOTP or passkey, never the bare secret
   key), naming the recipient's contact and an expiry. One open case per Company.
2. **Token.** A single-use acceptance token, stored only as a hash and bound to the recipient's contact, shown once; delivered out of band.
3. **Accept.** The recipient accepts with the token, the bound contact and a password. A **new `kind = owner` account** with a **pending**
   owner row for the same Company is created (Strategy A); the recipient must enroll and confirm an MFA factor. No authority, no session.
4. **Cool-down.** A **24-hour** cool-down (OD-T3) with notification to the current Owner, who may **cancel** during it. Completion
   requires that the required notification was **delivered**: a delivery failure blocks completion; it never silently bypasses the safeguard.
5. **Complete** (§9): atomically, the old row is retired and the new row activated; the **former Owner's account is disabled** (OD-T1)
   and its refresh-token families, unconsumed step-ups and challenges, and any pending same-owner recovery are revoked; audit is written.
6. **Operator assignments** granted by the former Owner are preserved (OD-T4); the new Owner may review and revoke them.
7. **Abandoned cases (OD-P1, detail open).** Reusing an abandoned recipient account's contact requires separate contact verification,
   invalidation of every earlier token and concurrency protection; the exact mechanism (re-binding a pending account of the same Company
   or requiring a new contact) is recorded for further review.

## 6. Decision: exceptional recovery

For an Owner who cannot act (lost every factor and credential, departed, permanently unavailable, account disabled or compromised).
Same-owner credential recovery (ADR-0027) is unchanged and remains the path for an Owner who can still prove password and secret key.

1. **Stewards** (OD-R1) open and approve recovery cases; nothing else (§7).
2. **Two-person rule.** Two distinct stewards initiate and approve, each with fresh MFA; the database rejects `approvedBy = initiatedBy`;
   neither may be the claimant.
3. **Independent verification** of the claimant's identity and legal ownership, outside Auth; Auth records only evidence **references**
   and the version of the approved procedure. The evidence standard is **open (OD-R2)**; contested or high-risk cases are never approved
   automatically; a mandatory external legal or notarial step is **open (OD-R4)**.
4. **Cool-down** of at least **7 days** (OD-R3), with notification to the existing Owner and available trusted channels. The existing
   Owner (any working factor, or password plus secret key) or either steward can **cancel**.
5. **Completion** is the atomic switch of §9 with reason `recovery`; the claimant has a new pending owner account with a confirmed factor.
6. **Not operational** until the evidence-verification procedure, the required notification mechanisms, steward MFA and the two-person
   controls are implemented and validated (§10).

## 7. Decision: steward identity, token, guard and MFA contract

- **Identity.** A new `user.kind = steward` with its own subtype table, **role `steward`** (never `admin`; the role CHECK is extended),
  centrally administered and restricted to recovery cases. Stewards never receive an owner row, Company authority, unrelated Company data
  or universal administration.
- **Token.** Steward access tokens carry **no `adminTier`**. Token issuance and the guard map a tier only for `owner` and `operator`.
- **Guard.** Default deny: a steward passes **only** routes that explicitly list `steward`, including the routes that today accept any
  kind (`@Actors()`): `/auth/me`, `/auth/grants` and `/auth/step-up/verify` refuse stewards with `403`; logout allows them. The guard also
  requires an **active** owner row on owner routes.
- **Login and MFA.** A dedicated steward login with mandatory MFA, and dedicated steward factor, step-up and challenge tables; the owner
  tables are not reused. Password login for a steward keeps answering the generic `401`.
- **Provisioning (OD-S1, open).** How stewards are created is **not decided**: it requires its own threat model and owner approval. No
  bootstrap CLI or other provisioning mechanism is authorized by this ADR.

## 8. Decision: shared Audit, service-kit and downstream compatibility

Approved as future design dependencies only; each is separately authorized:

- **Audit contract.** `libs/audit-contract` `USER_KINDS` gains `steward`, with catalog actions for transfers, recovery and stewards.
  audit-service's type and its `"userKind" IN (...)` CHECK are extended **consumer-first** (audit-service is in production), before Auth
  emits any steward actor.
- **service-kit.** `HttpAuthClient.getIdentity` validates `adminTier ∈ {owner, operator, null}` and fails closed otherwise.
- **Billing and Payment.** They read `adminTier` through the kit; a steward never reaches them (Auth refuses `/auth/me` for stewards, so
  the kit sees an unauthenticated caller). No other change.
- **Release and Audit owner checks.** They call `/auth/grants`; a steward is refused at Auth and these services fail closed (today they map
  a non-`200`, non-`401` answer to `503`). Changing that mapping (OD-S2) is deferred.
- **Organization Service.** Unchanged: authority from `GET /auth/grants`; the active owner is the only one reported.

## 9. Decision: transaction and concurrency rules

- **Company-level serialization.** Every ownership mutation (open, accept, cancel, approve, complete, and bootstrap) first takes a
  transaction advisory lock keyed by the Company, then locks the case row and the active owner row (`SELECT … FOR UPDATE`).
- **Completion, one Auth transaction:** lock; re-check case status, expiry, elapsed cool-down, confirmed recipient factor and that the
  case's former owner is still the active owner; retire the old row; activate the new row; disable the former account and revoke its
  sessions, step-ups, challenges and pending recovery; mark the case completed; write the central audit intent; write domain events only
  when `AUTH_EVENTS=on`. Commit runs the deferred invariant check. Any failure rolls back everything.
- **Two active owners** are impossible: the partial unique index is global, not snapshot-bound. **Zero active owners** are never
  committed: the deferred trigger rejects it, and concurrent paths serialize on the lock and re-check under it.
- **Open cases.** A partial unique index allows one open case per Company. Expiry is checked under the lock at every step; a sweep may
  only label expired cases.
- **No distributed transaction** and no Organization Service write.

## 10. Decision: operational activation gates

Accepting this ADR activates nothing. Two independent gates, both **off by default**:

| | Normal transfer (`OWNER_TRANSFER`) | Exceptional recovery (`OWNER_RECOVERY`) |
|---|---|---|
| MFA | owner factor-only step-up to initiate and cancel; recipient factor enrollment | steward MFA login and step-up for open, approve and cancel; owner cancel by factor or password plus key |
| Notification | delivery to the current Owner required before completion | delivery to the existing Owner and trusted channels at open, approval and before completion |
| Identity and evidence | token bound to the recipient's contact | approved, versioned evidence procedure (OD-R2); references only; contested cases never automatic |
| Audit | central intents for every transition, same transaction | the same, with the `steward` actor kind live in audit-service |
| Prerequisites | Auth migration and authority filters, the transfer API, tests (§11), notification delivery in production | everything for normal transfer, plus stewards (OD-S1), steward MFA, the audit-contract change, a non-production rehearsal and owner sign-off |
| Dependency unavailable | notification undeliverable: no completion; database failure: nothing changes | any notification, audit-contract or steward-MFA failure: no open, approve or complete; cancellation is always allowed |

## 11. Threat model and residual risks

| Threat | Mitigation |
|---|---|
| Stolen owner session initiates a transfer | factor-only step-up; 24-hour cool-down with delivered notification and cancellation |
| Leaked acceptance token | single use, hashed, contact-bound, expiring, rate limited, generic errors |
| Concurrent transfers or recoveries | Company lock, row locks, one open case per Company, partial unique index |
| Former Owner keeps access | account disabled and sessions revoked in the completion transaction; the guard checks the account and the session live |
| Pending or retired owner exercising authority | active-only filters on every owner path, including `/auth/grants` |
| Steward privilege creep | no `adminTier`, role `steward`, default-deny guard, steward-only routes, no owner row |
| Insider recovery takeover | two distinct stewards, independent verification, 7-day cool-down, owner cancellation, audit |
| Downstream mis-reading a steward | Auth refuses stewards on `/auth/me` and `/auth/grants`; the kit validates `adminTier` |

**Residual risks:** two colluding stewards whose case the existing Owner does not notice within the cool-down; a stolen owner session
with a working factor during the 24-hour window if the notification is not acted on; a person needing a second contact for the owner
account.

**Test matrix for implementation (minimum):** the invariant (double activation, retire without activation, forbidden transitions,
foreign keys after retirement); concurrency (parallel completions, completion against cancellation, two cases opened at once, bootstrap
against transfer, recovery against transfer); authority (pending and retired owners refused everywhere, the new owner effective at once,
operator assignments preserved); revocation; the transfer flow (step-up, token, cool-down, notification failure); the recovery flow
(two-person rule, cool-down, cancellation, disabled gate); steward confinement (every non-steward route, token claims, downstream fail
closed); audit (same-transaction intents, audit-service accepting `steward`); kit validation.

## 12. Open decisions

- **OD-S1:** steward provisioning (a separate threat model and owner approval; nothing authorized).
- **OD-S2:** Release and Audit HTTP mapping of Auth's `403` for a steward (deferred; current behavior fails closed).
- **OD-P1:** implementation details of reusing an abandoned recipient account's contact.
- **OD-R2:** the evidence standard (a separately approved operational procedure).
- **OD-R4:** a mandatory external legal or notarial verification.
- Multi-company ownership (A5.3); interaction with Organization lifecycle (OD-A5-1); a future Strategy C.

## 13. Implementation stages (each separately authorized)

| Stage | Content |
|---|---|
| T1 | owner review and acceptance of this ADR; then the separately approved relationship metadata on ADR-0017, ADR-0024 and ADR-0050 |
| T2 | Auth migration: owner `status`, the partial unique index, the deferred trigger, the transfer and recovery case tables (a gated migration) |
| T3 | Auth: active-only authority on every owner path and `GET /auth/grants`, with regression tests |
| T4 | Auth: the normal transfer API behind `OWNER_TRANSFER` |
| T5 | steward kind, guard confinement, steward MFA, the audit-contract and audit-service change (consumer first), the kit validation, the recovery API behind `OWNER_RECOVERY`; after OD-S1 |
| T6 | notification integration (requires notification-service and A3M.8 in production) |
| T7 | production rollout through the normal, separately authorized Auth deployment; gates stay off until their prerequisites are certified |

## 14. Proposed relationship with ADR-0017, ADR-0024 and ADR-0050

- **ADR-0017 (Proposed).** Partly superseded: "Single owner per Company — permanent, not an interim state" and the Consequences entry
  "Ownership transfer … has no designed mechanism". The exactly-one-active-owner principle is kept.
- **ADR-0024 (Proposed).** Amended, not accepted: "Owner cardinality is policy, not architecture" gains the partial unique index, the
  owner lifecycle and the deferred trigger; immutable `kind` and `companyId` are kept.
- **ADR-0050 (Accepted).** Partly superseded, on these passages only: in decision 12 ("Out of Stage 19"), the bullets "ownership transfer
  or emergency owner replacement beyond Auth's recovery" and "break-glass, which is the single owner with cool-down recovery"; and, in
  Consequences, "an owner who has lost the password has no approved recovery in Core V1". Every other decision stands and constrains this
  ADR, in particular decision 7 (platform administration is a set of capabilities of the services, not a second owner), decision 8
  (no administrative database access), decision 9 (same-transaction audit) and decision 14 (no privileged recovery CLI; direct database
  manipulation is not an approved recovery procedure).

These relationships take effect only on this ADR's acceptance; the corresponding status lines and backlinks are separate, explicitly
approved changes.

## Consequences

- **Easier:** exactly one active owner is enforced by the database; transfers and recoveries are atomic, audited and preserve history; no
  cross-service state or distributed transaction.
- **Harder or given up:** the recipient needs an account with an unused contact; the former Owner's account is disabled; stewards need
  their own MFA and an audit-contract change; both gates depend on notification delivery, which is not yet in production.
- **Follow-up:** OD-S1, OD-P1, OD-R2, OD-R4; the stages of §13; the A5 record tracks progress.

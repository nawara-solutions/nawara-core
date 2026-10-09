# 0061. Auth hierarchy-reference repair and diagnostics

- **Status:** Accepted (2026-10-09, by the architecture owner, A5.3 OD-A5-4 owner authorization) <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-10-09
- **Deciders:** Anwar (project owner)

> **Acceptance note (2026-10-09, A5.3 OD-A5-4).** The architecture owner accepted the architectural design of this ADR as written (§3 to
> §10). The Proposed-era notes below are kept unchanged as history; their statement "This ADR is **Proposed**: it is not accepted" is
> replaced by this note, while "no reference-repair or diagnostic functionality is implemented or active" remains true. Acceptance:
> 1. **Explicitly accepted:** the step-up consumed in its own committed transaction once per valid attempt, even when the attempt later
>    returns `404`, `503` or fails in the placement transaction (§4 step 3); and **best-effort** audit of failed repairs after rollback,
>    with no guarantee of durable central evidence for every failure (§6).
> 2. **Implements and activates nothing.** Before any implementation or activation: the audit contract and the production Audit Service
>    must support the repair actions through separately authorized consumer-first changes; `ensure` must be safely split into resolve and
>    place; security, concurrency, audit and failure-path tests must pass; and the F6/F7 authority prerequisites must be met. This
>    acceptance authorizes none of those operations.
> 3. **Deferred:** OD-A5-4(e) (post-F7 dependency convergence and `local`-mode retirement) and the diagnostic CLI conventions, with OD-A5-5.
> 4. **Relationships.** The "proposed relationships" paragraph below now takes effect in substance: the clarification of ADR-0040
>    decision 2 is decided by this acceptance; ADR-0023, ADR-0042, ADR-0050 and ADR-0060
>    are preserved. No other ADR is changed here; any backlink or clarification note requires a separate approval and commit.

> **Status of this document.** The architecture owner approved the **policy direction** of OD-A5-4(a)–(d) (2026-10-09), recorded below;
> OD-A5-4(e) stays open with OD-A5-5. This ADR is **Proposed**: it is not accepted, **no reference-repair or diagnostic functionality is
> implemented or active**, and it activates nothing. Every stage is separately authorized and, for runtime effect, blocked until F6/F7.
>
> **Proposed relationships, effective only if this ADR is Accepted** (no other ADR is edited by this draft):
> - [ADR-0040](./0040-organization-ownership-migration-decisions.md): **clarifies decision 2** — an Owner-invoked repair is an
>   administrative first touch; every authentication and session path stays free of Organization Service calls;
> - [ADR-0023](./0023-platform-access-check-and-operator-login-decoupling.md) D1(a): **preserved** (local authorization reads, collapsed
>   `404` on a miss, no ensure-on-read);
> - [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md): **preserved** (immutable-anchor reference semantics;
>   Auth's existing read credential and scope);
> - [ADR-0060](./0060-company-platform-organization-lifecycle.md): **preserved** (Organization Service lifecycle authority, E5 as a
>   separate fresh check, effective status never inferred from a reference);
> - [ADR-0050](./0050-platform-administration-and-verified-human-authority.md): **preserved** (decision 7: capabilities of the services, not a
>   second owner; decision 8: "No god admin database"; decision 9: same-transaction audit; decision 14: Stage 19 introduced no privileged recovery CLI, and direct database manipulation is not a recovery procedure).

## 1. Context

**Implemented today (verified on `main` at `f78f272`):**

- After the ownership transition, Auth's `company`, `platform` and `organization` rows are a validated, non-authoritative reference
  cache. `HierarchyReference.ensure` (`apps/auth-service/src/hierarchy/hierarchy-reference.ts`) fetches the entity and its parents from
  Organization Service and places them in **one** step: a cached row answers locally without a call; a missing target is `false`
  (the caller answers `404`); an unavailable authority, a missing parent, a refused write or a parent-link mismatch is
  `503 hierarchy_unavailable`. Placement is `INSERT … ON CONFLICT DO NOTHING`, never an update, then a parent-link re-read.
- `ensure` runs only on administrative first touches: join-code and invitation creation, operator platform-assignment grant, and the
  owner bootstrap. The authorization reads (`GET /auth/platform-access/:platformId`, `GET /auth/admin/organizations/:id`, organization
  authority) read local rows only and answer a miss with the collapsed `404` (ADR-0023 D1(a)).
- **No repair, reconciliation or diagnostic exists.** An entity known to Organization Service but never touched by Auth is a fail-closed
  **false negative** until some first-touch action places it. A parent-link mismatch is only logged (`hierarchy_anchor_mismatch`).
- The shared audit catalog has **no** Auth-produced hierarchy-reference action (`libs/audit-contract/src/catalog.ts`).
- Production Auth runs in `local` mode; everything here is dormant until F6/F7.

## 2. Options considered

1. *A. First touch only.* Rejected as the only mechanism: owners have no way to repair a false negative.
2. **B. An explicit, Owner-authorized repair operation, in addition to first touch (chosen).**
3. *C. Periodic background reconciliation.* Rejected: places references nobody needs and drifts toward a synchronized replica, which
   ADR-0039 and ADR-0040 decision 1 rejected.
4. *D. Event-driven reference synchronization.* Rejected for references: contradicts "no projection or event stream" (ADR-0040 decision 1)
   and needs production messaging (A3M.8).

## 3. Decision: repair authority (OD-A5-4(a), (b))

- The existing first-touch `ensure` is kept unchanged for its callers. Normal Auth authorization reads stay local and never fetch.
- A separate repair operation is added for **platforms and organizations**. Only the **active Company Owner** (an active owner row under
  ADR-0059) may invoke it, with a **fresh, factor-only step-up** for the new purpose `hierarchy.reference.repair` (TOTP or passkey, never
  the bare secret key). No Operator, Member, Organization Admin, recovery steward or universal vendor authority.
- No background synchronization and no event-driven reference projection.

## 4. Decision: repair sequence

1. **Authenticate** the active Company Owner; in `local` mode the route answers the collapsed `404` here, before any step-up is
   consumed.
2. Validate the identifier (malformed: `400`); apply per-actor and per-address rate limits (exceeded: `429`).
3. **Require and consume** a fresh `hierarchy.reference.repair` step-up, **once per authorized attempt**, in **its own committed
   transaction before any lookup**, so that a later `404`, `503` or rollback never restores it. (Today's `StepUpService.consume` runs in the
   caller's transaction and a rollback un-burns it; repair deliberately differs.) It is never consumed when the request is refused before
   this step (`400`, `401`, `403`, `429`, or the disabled route in `local` mode). The step-up is bound to the Owner and session that created it, so one actor can never consume
   another's.
4. **Resolve without writing.** For an uncached target, fetch it and its parents from Organization Service with the same hardened client
   and response validation as `ensure`, placing **nothing**; for any ancestor already cached, compare the local parent link with the
   authority's. For a target already cached, use its already-validated immutable parent links, without a fresh Organization lookup (the
   accepted reference-cache contract). Comparing a cached ancestor's link with the authority during resolve is **new behavior**: today's
   `ensure` stops at the first cached ancestor and detects a mismatch only when a placement conflicts.
5. **Authorize:** the resolved Company must be the Owner's Company. Otherwise the collapsed `404`, with **no placement** and no hierarchy
   detail.
6. **Place** only through Auth's existing guarded, idempotent reference-write transaction: parents first, `INSERT … ON CONFLICT DO
   NOTHING`, parent-link re-read.
7. **Audit** the success with a central audit intent in the **same** transaction (§6); an already-present reference (nothing placed) is
   audited the same way, recording that nothing was placed.
8. **Respond** with minimal information: the kind, the id, and whether a row was placed. No names, no hierarchy beyond the requested id.

**The current combined `ensure` must not be reused in a way that places references before authorization**; implementation splits it into
a resolve step and a place step, keeping the combined behavior for the existing first-touch callers.

The route is **disabled outside the Organization-authoritative mode** (when Auth's hierarchy source is `local`, Auth is the authority and
there is nothing to repair): it answers the collapsed `404` and does nothing.

## 5. Decision: failure rules

| Case | Response | Placement |
|---|---|---|
| Not authenticated, not an Owner, inactive Owner, missing or invalid step-up | `401` / `403` (existing semantics) | none |
| Malformed identifier | `400` | none |
| Rate limit exceeded | `429` | none |
| Auth's hierarchy source is `local` (route disabled) | collapsed `404` | none |
| Nonexistent target, or outside Auth's Organization Service scope | collapsed `404` | none |
| Exists, but in another Company | the same collapsed `404` | none |
| Already cached and authorized | `200`, nothing placed | none |
| Authority unavailable, timeout, redirect, oversized or malformed response, Auth's credential missing or refused | `503 hierarchy_unavailable` | none |
| Parent missing at the authority, or parent-link mismatch | `503`; a mismatch is a security event (§6) | none |
| Placement refused by the database (for example the hierarchy is frozen) | `503` | none |
| Concurrent repairs of the same id | each `200`; one row; parent links re-validated | idempotent |
| Same-transaction audit intent cannot be written | `503` | **rolled back** |

In every row reached after step 3, the step-up stays consumed; the rows refused before step 3 consume nothing.

## 6. Decision: audit, alerts and diagnostics (OD-A5-4(c), (d))

- **Success:** a central audit intent written in the same transaction as the placement or the no-op (ADR-0050 decision 9).
- **Failure after rollback:** recorded **separately and best-effort** — first a new transaction to the central outbox, then, if that fails,
  Auth's local audit (`tryRecord`), then a structured log. **Failed operations do not have guaranteed durable central audit evidence**
  when best-effort delivery fails; that limitation is accepted and must be visible in operations.
- **Parent-link mismatch** (in repair and in first-touch `ensure`) is a security event: it raises an operational alert (as ADR-0040
  decision 7's monitoring requires) and is recorded through the same best-effort failure path. Failure records carry ids, the actor and a
  reason code only, never the authoritative hierarchy.
- **Audit contract (prerequisite):** new Auth-produced catalog actions for repair success, repair refusal and anchor mismatch, added to
  `libs/audit-contract` and accepted by audit-service **consumer-first** (audit-service is in production), each change separately
  authorized before implementation or activation.
- **Diagnostics:** a restricted, **read-only** capability that compares Auth's references with the authoritative Organization records
  (presence, parent-link agreement, "outside Auth's scope"). Output excludes names, contacts, tokens, secrets and unrelated hierarchy data.
  It never repairs, never modifies a database and is not a privileged recovery tool. It is a **deployment-level** tool, run only by the
  operator of the Auth deployment with Auth's own read credential, never exposed over HTTP. Its exact CLI conventions follow OD-A5-5.

## 7. Decision: lifecycle

- Repair of a validated, immutable reference is **permitted while the entity or an ancestor is SUSPENDED or ARCHIVED**: it places existence
  and parent links only and grants nothing.
- **A repaired, cached or `ensure`-confirmed reference is never lifecycle evidence** and never implies effective authorization.
- Every later access-granting write performs ADR-0060's separate, fresh E5 check; products keep E1 point-of-use enforcement.

## 8. Residual risks

- A timing difference between "not found" and "exists in another Company" (different lookup depth), mitigated by Owner-only access, a
  consumed factor per attempt, rate limits and failure audit.
- A platform outside Auth's Organization Service scope looks nonexistent to the API; the diagnostic distinguishes it for operators.
- Best-effort failure audit may be lost when every path fails (§6).
- Repair cannot ship before the audit-contract change and the resolve/place split.

## 9. Open decisions

- **OD-A5-4(e):** post-F7 Auth ↔ Organization dependency convergence and Auth `local`-mode retirement — open with OD-A5-5; not decided here.
- OD-A5-5: diagnostic CLI conventions.
- OD-A5-2 stays open.

## 10. Implementation stages (each separately authorized; runtime effect blocked until F6/F7)

| Stage | Content |
|---|---|
| R1 | owner review and acceptance; then any separately approved relationship metadata |
| R2 | audit contract and audit-service: the new actions, consumer-first |
| R3 | Auth: the resolve/place split, the repair route, the step-up purpose, failure audit and the mismatch alert; tests |
| R4 | the read-only diagnostic, after OD-A5-5 |

Minimum tests: authorized Owner places; another Company's Owner gets the collapsed `404` with no row placed; Operator, Member, Org Admin
and anonymous refused; step-up missing or secret-key-only refused; step-up consumed on `404`; identical answers for "missing" and
"another Company"; cached target with no Organization call; concurrent repairs give one row; every failure class gives `503` with nothing
placed; mismatch audited and alerted; same-transaction audit failure rolls back; repair under SUSPENDED or ARCHIVED ancestors grants
nothing and a later grant still runs E5; read routes and authentication paths make no Organization calls; the route refuses in `local`
mode.

## Consequences

- **Easier:** owners can repair fail-closed false negatives without weakening ADR-0023's local reads; mismatches become visible.
- **Harder or given up:** a new Owner capability and step-up purpose; an audit-contract dependency; best-effort failure audit.
- **Follow-up:** the stages of §10; the Auth ADD and SDD on implementation; the A5 record tracks progress.

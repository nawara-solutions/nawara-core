# 0039. Organization ownership and cross-service migration authority

- **Status:** Proposed <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X --> (**partly superseded by [ADR-0040](./0040-organization-ownership-migration-decisions.md)**, on the passages listed in that ADR's "Amendments to ADR-0039", by its decisions 1 to 4. ADR-0040 is **Accepted** (2026-09-20). The import mechanism this ADR left open is decided by ADR-0040 decision 5, and the interim id invariants by its decision 6. The rest of this ADR stands.)
- **Date:** 2026-09-20
- **Deciders:** Anwar (project owner)

> **Builds on [ADR-0031](./0031-organization-service-intended-owner-of-the-hierarchy.md)**, which names
> organization-service as the *intended* future owner of `Company`, `Platform` and `Organization` but explicitly
> declines to design the cross-service mechanism, deferring it "when organization-service is implemented" — this is
> [core-architecture.md](../architecture/core-architecture.md)'s **O9**. ADR-0031's own text is unchanged by this
> ADR: it remains the accurate record of the original deferral, and of the tenancy-anchor/provisioning design the
> project owner withdrew while writing it. This ADR is the "separate ADR" ADR-0031 said would eventually decide O9;
> the project owner chose to settle the mechanism now, at the architecture level, ahead of organization-service
> actually being built, rather than waiting until the build starts. It also builds on
> [ADR-0024](./0024-database-enforced-tenancy-and-authorization-integrity.md) (the FK/immutability shape of the
> hierarchy tables) and [ADR-0033](./0033-service-to-service-authentication-and-user-identity.md) (the service-token
> pattern this ADR reuses, not redesigns).
>
> **Factual correction (2026-09-20, Stage 9.1; no decision in this ADR is changed).** Phase C, "Migration phases", lists auth-service's
> hierarchy-mutating endpoints as "today `POST`/`PATCH /auth/admin/platforms`, `POST`/`PATCH /auth/admin/organizations`, and company
> creation via the bootstrap CLI". Checked against the source, **those four routes do not exist**. In auth-service the only statement that
> writes `company`, `platform` or `organization` outside tests is the bootstrap CLI's `INSERT INTO company`; the only related HTTP route is
> the read-only `GET /auth/admin/organizations/:id`. Platforms and organizations therefore reach Auth's database only by direct writes
> (migrations, fixtures, operator SQL), which is what ADR-0031 already said ("no route creates a platform or an organization", finding
> F23). Consequences to read into this ADR: the Phase C freeze must be designed against the paths that really write these tables, and the
> "Failure handling" row about Auth's hierarchy-mutation endpoints has no endpoint to decommission today. Also, the row being imported
> includes Auth's `platform.key` (migration 0004: optional, format-checked, unique), which organization-service carries since Stage 9.1.

## Context

The organizational hierarchy is fixed across this repo (`docs/architecture/core-architecture.md` §1):
`Company 1 → N Platform`, `Platform 1 → N Organization`. auth-service's schema enforces exactly this shape today:
`platform.companyId` is a `NOT NULL` foreign key to `company.id`, `organization.platformId` is a `NOT NULL` foreign
key to `platform.id`, and both foreign keys are additionally made immutable by trigger
(`platform_company_immutable`, `organization_platform_immutable` — migration `0001`). auth-service is also the
**sole authority** for `User`, credentials, sessions, refresh tokens, MFA/recovery and, since ADR-0030,
`OrganizationMembership` (`organization_membership`, migration `0007`) — the only link between a `User` and an
`Organization`. Every membership row still carries `organizationId` as a real, intra-database foreign key to
`organization.id`.

`docs/architecture/core-architecture.md` (§2–3, §11) already records `organization-service` as the **intended**
future owner of `Company`, `Platform`, `Organization` — their lifecycle, metadata, settings, policies and the
relationships between them — while noting the hierarchy tables stay in auth-service "as they are today" and the
cross-service mechanism is undecided (O9, §11). ADR-0031 is the ADR that recorded that split deliberately, and it
is explicit about what it does **not** design: how Auth references these entities once organization-service exists;
whether existing rows move or are adopted; creation ordering and failure handling. An earlier draft of ADR-0031
sketched a tenancy-anchor mechanism (an Auth provisioning route, a `provisioning` intermediate membership/anchor
state, and an ongoing reconciliation loop keeping Auth and organization-service in sync); the project owner withdrew
that draft because it invented synchronization and adoption machinery ahead of organization-service existing at all.

organization-service itself remains unbuilt: no schema, no database, no code. This ADR does not change that. What
it does is answer, architecturally, the two questions ADR-0031 left open and O9 names — how authority over
`Company`/`Platform`/`Organization` moves from auth-service to organization-service once organization-service is
built, and how the rest of the system (Billing, Payment, and any future consumer) keeps working correctly, with no
outage and no silent data drift, while and after that happens.

## Problem

Precisely, O9 is two coupled questions:

1. **Migration mechanism.** `Company`, `Platform` and `Organization` currently live only in auth-service's database.
   organization-service needs to become their authoritative owner without a "flag day" that either loses data,
   invents a second, divergent copy of the hierarchy, or requires every other service to be redeployed in lockstep.
2. **Cross-service reference stability.** Billing and Payment already hold `organizationId` (and, transitively,
   `platformId`/`companyId`) as opaque values with no foreign key into any other service's database (this repo's
   database-per-service principle, ADR-0032, makes a real cross-service FK impossible in the first place). Whatever
   the migration mechanism is, it must not require Billing, Payment, or any other consumer to change how they store
   or interpret those values — an `organizationId` written into an `invoice` or `payment` row today must remain a
   valid, meaningful reference after organization-service becomes authoritative.

This ADR answers both, without inventing anything about organization-service's internal schema, without touching
`User`/credentials/sessions/MFA/membership (all stay exactly as ADR-0024/ADR-0030 describe them), and without
resurrecting the withdrawn tenancy-anchor/provisioning design.

## Options considered

1. **Bootstrap/import, verify, freeze, cutover, post-cutover verify — a one-time, time-boxed transition with a
   single defined cutover point (chosen).** organization-service imports a copy of today's `Company`/`Platform`/
   `Organization` rows from auth-service while auth-service stays authoritative; the imported copy is verified
   against auth-service's own existing invariants; a short, narrowly-scoped write freeze on hierarchy mutations
   only precedes the moment authority formally switches; a post-cutover verification pass follows. This is a
   transition with a start and an end, not an ongoing protocol.
2. *An event-driven ownership-transfer model, with organization-service publishing lifecycle events
   (`organization.created`/`.updated`/…) and auth-service maintaining a permanent, event-derived read replica of
   `Company`/`Platform`/`Organization` for its own use.* Rejected. It solves a problem auth-service does not have:
   Auth's login, refresh and session code never reads `Company`/`Platform`/`Organization` business data (see "Auth
   independence" below) — a permanent replica would exist only to be unused, adding a standing event contract,
   consumer, and staleness-handling burden (this repo's events are not yet reliably delivered at all, per
   `core-architecture.md` §8/O10) for no consumer that needs it. It also leaves "who is authoritative right now"
   ambiguous indefinitely, rather than answering it once at a defined cutover point.
3. *The withdrawn tenancy-anchor/provisioning mechanism (an Auth-side anchor table, a `provisioning` intermediate
   state, automatic reconciliation loops).* Rejected, and already rejected once — this is the design ADR-0031's own
   text records the project owner withdrawing. It is a different shape of problem than the one this ADR solves: it
   invents an ongoing adoption/synchronization protocol and a new Auth schema state *before* organization-service
   exists, whereas bootstrap/import + cutover is a one-time, explicitly time-boxed transition run *once
   organization-service already exists*, with a defined end state (organization-service alone is authoritative) and
   no ongoing reconciliation loop left running afterward.
4. *Move `Company`/`Platform`/`Organization` out of auth-service immediately, with no transition period at all
   (a "flag day" cutover with no import/verify phases).* Rejected: it offers no way to detect, before the switch,
   that the two copies of the hierarchy actually agree, and no way to catch a bad copy before it becomes the only
   copy. ADR-0031 already rejected the related, larger move of reworking Auth's foreign keys as part of this
   decision; a same-day cutover would carry that same risk for the migration mechanism specifically.

## Decision

We chose **Option 1**. It is the one option that treats this as a bounded transition — with a start, a verified
middle, and a defined end — rather than either an indefinite synchronization protocol (Option 2), a resurrection of
the design already withdrawn once (Option 3), or an unverified instantaneous switch (Option 4).

### Ownership boundaries

| Concern | Owner after this ADR | Notes |
|---|---|---|
| `Company`, `Platform`, `Organization` — lifecycle, metadata, settings, policies, the `Company → Platform → Organization` relationships | **organization-service**, once built and cut over (Phase D below) | Sole authority once cutover completes; before that, auth-service remains authoritative exactly as ADR-0031 states |
| `User`, credentials, sessions, refresh tokens, MFA, recovery | **auth-service**, unconditionally, unaffected by this ADR | Never moves |
| `OrganizationMembership` (user ↔ organization, status, `audience`, org-admin capability) | **auth-service**, unconditionally, unaffected by this ADR | ADR-0030's model stands as-is; Auth may hold/reference `organizationId` on a membership row without owning the authoritative `Organization` record it points to |
| Opaque `organizationId`/`platformId`/`companyId` held by Billing, Payment, or any other consumer | unaffected; still opaque, still no cross-service FK | Section "Cross-service reference rules" |

Auth's relationship to the hierarchy after cutover is exactly the relationship ADR-0031 already anticipated for
"other services": it holds `organizationId` (on `OrganizationMembership`) as an opaque reference, the same way
Billing and Payment do today, rather than as the authoritative row.

### Migration phases

A five-phase, one-time transition, each phase gated on the previous one completing:

- **Phase A — Bootstrap/import.** organization-service, once built, imports a copy of every `Company`, `Platform`
  and `Organization` row currently in auth-service's database, using the same `id` values (see "IDs are stable"
  below). auth-service remains fully authoritative throughout — this phase changes nothing about which service
  answers "is this the real row." No Auth schema change, no Auth downtime, no freeze yet.
- **Phase B — Verification.** The imported copy is checked against auth-service's own live data using the
  invariants that already exist and are already enforced today, not any new business rule invented for this
  migration:
  - Every `Platform.companyId` in the import resolves to a `Company` that was also imported (mirrors
    `platform.companyId REFERENCES company(id)`, migration `0001`).
  - Every `Organization.platformId` in the import resolves to a `Platform` that was also imported (mirrors
    `organization.platformId REFERENCES platform(id)`).
  - Row counts and `id` sets for `Company`, `Platform` and `Organization` match between the import and auth-service's
    live tables at the moment of the check.
  Verification failing means Phase C is not entered; auth-service stays authoritative and the import is corrected
  and re-run (see "Failure handling").
- **Phase C — Controlled write-freeze, narrowly scoped.** Once verification passes, mutations to `Company`,
  `Platform` and `Organization` in auth-service (creation and updates — today `POST`/`PATCH
  /auth/admin/platforms`, `POST`/`PATCH /auth/admin/organizations` [these routes do not exist: see the factual correction at the top], and company creation via the bootstrap CLI) are
  frozen for the short window between the last successful verification and cutover, so the imported copy cannot go
  stale in the middle of the switch. **The freeze applies to these three tables' own mutating endpoints only.**
  Ordinary Auth operation is explicitly unaffected: login, refresh, logout, registration, joining an organization,
  membership approve/reject/revoke, and every session/security flow continue exactly as today, because none of
  them mutates `Company`/`Platform`/`Organization` rows (see "Auth independence").
- **Phase D — Cutover.** Authority formally switches to organization-service: from this point on,
  organization-service's copy is the one every service (including, from then on, Auth for its own reference needs)
  treats as the real `Company`/`Platform`/`Organization` record. See "Cutover procedure" for what this requires and
  what is deliberately left undecided.
- **Phase E — Post-cutover verification.** A second verification pass, structurally identical to Phase B's
  invariant checks, run against organization-service's now-authoritative data, to confirm the cutover itself
  introduced no drift (e.g. a write accepted by organization-service during the Phase C→D boundary that
  Phase B's snapshot could not have seen).

This is deliberately **not** the withdrawn tenancy-anchor/provisioning mechanism: it is a one-time, verified,
explicitly time-boxed transition with a single defined cutover point (Phase D), run once organization-service
already exists as a precondition — not an ongoing synchronization or adoption protocol, no `provisioning`
intermediate state anywhere in Auth's own schema, and no automatic reconciliation loop left running once Phase E
completes.

### Cutover procedure and how it's detected/recorded

Phase D is the single moment authority changes. Architecturally, this requires that at every point in time exactly
one service can be asked "are you authoritative for `Company`/`Platform`/`Organization` right now?" and get an
unambiguous answer that every consuming service and Auth itself agree on — before Phase D, auth-service; from Phase
D onward, organization-service. **The concrete mechanism that records and answers that question (a configuration
flag consulted by every dependent, a migration marker, a versioned-authority record queried at request time, or
something else) is not decided by this ADR** — nothing in the repository today evidences a preference, and
inventing one here would be exactly the kind of undesignable-yet detail this ADR is not meant to settle. It is
listed under "Deferred decisions" below and must be settled before Phase D is actually exercised.

What **is** decided: cutover is a single, atomic event from the system's point of view (Phase C's freeze exists
specifically so that no write can straddle it), it must be recorded durably enough that Phase E's verification and
any future audit can determine, after the fact, exactly when authority changed, and it must not silently coincide
with a code deployment — see "Rollback semantics" for why that distinction matters.

### Rollback semantics

**Deployment rollback is not the same as ownership rollback, stated explicitly.** If something goes wrong after
Phase D, reverting the deployed code (e.g. redeploying a prior version of a consumer that still reads
`Company`/`Platform`/`Organization` from auth-service) does **not** revert which service's data is authoritative.
organization-service may already have accepted new writes after cutover — a new `Organization` created, a
`Platform` renamed — that never existed in auth-service and that a code-level rollback cannot un-create by itself.
Treating a deployment rollback as if it also reverted ownership would silently lose those writes or reintroduce
stale data as if it were current.

**The exact reconciliation procedure for a post-cutover ownership rollback is explicitly not designed here.** This
ADR states the distinction (deployment rollback ≠ ownership rollback) and requires that whoever operates Phase D
know it exists as an open risk; it does not invent a reconciliation algorithm, a "roll authority back to
auth-service" procedure, or any data-merge rule for writes organization-service accepted after cutover. This is
listed under "Deferred decisions."

### Cross-service reference rules

Billing and Payment are **unaffected by this ADR** and require no schema change:

- Both already store `organizationId` as an opaque, non-foreign-keyed column — verified directly: billing-service's
  `invoice.organizationId` (migration `0003`) and payment-service's `payment.organizationId` (migration `0002`) are
  both plain `uuid` columns with no `REFERENCES` clause. Payment's own migration comment
  (`0006_phase1_acceptance_hardening.sql`) treats a mismatched `organizationId` as a same-database consistency
  check against `sellerId`, never as a cross-service integrity check.
- `payment.organizationId` is also one of the fields payment-service's own immutability trigger
  (`payment_snapshot_immutable`) freezes after creation — the historical value on a payment row is never expected
  to change regardless of what happens to the live `Organization` row elsewhere.
- Billing's `issuerSnapshot`/`billToSnapshot` (immutable JSON captured at invoice creation; the typed `(type, id)`
  party reference itself is per ADR-0036, while the snapshot container is a billing-service SDD design, not a
  separate ADR decision) remain the authoritative historical record of who was billed and by whom **at the time**,
  independent of which service later owns the live `Organization` row.
- No cross-service foreign key is introduced by this ADR, and none is possible under this repo's
  database-per-service principle (ADR-0032) regardless of which service owns `Organization`.

This ADR does not propose, and explicitly rules out proposing, any Billing or Payment schema change.

**IDs are stable across the migration.** The same `organizationId`/`platformId`/`companyId` values that exist in
auth-service today are the same values organization-service uses once it is authoritative. This is not a fresh
design choice being made here — it falls directly out of the fact just verified above: Billing and Payment already
treat these as opaque, unvalidated, non-foreign-keyed identifiers, so nothing downstream can be re-keyed without
breaking every existing invoice, payment, membership and license reference in the system. Phase A's import must
therefore preserve `id` values exactly, not regenerate them.

### Auth independence

**Ordinary Auth operation does not depend on organization-service, before, during or after this migration**, because
it never depended on `Company`/`Platform`/`Organization` business data in the first place for its core identity
flows. Verified directly in `apps/auth-service/src/auth/auth.service.ts`:

- `login()` calls only `users.findByIdentifier`, `passwords.verify`, `sessions.issue`/`ownerAuth.beginLogin`, and
  audit/throttle helpers. It performs no query against `organization`, `platform` or `company`, and (per ADR-0026)
  makes no call to any other service.
- `refreshSession()` calls only `refresh.rotate` and `users.findById`. Same absence of any hierarchy read.
- `logout()` touches only the refresh-token table.

**One genuine, narrower exception, named explicitly rather than silently ignored:** `me()` (`GET /auth/me`) *does*
read `memberships[]` via `MembershipService.list`, which joins through `organization_membership` to `organization`
(and, per `member_platform`, on to `platform`/`company`) to return each membership's organization/platform context.
This is not login or refresh — it is a separate, already-existing read endpoint, and it already depends on Auth's
own `organization`/`platform`/`company` tables today, exactly as ADR-0030 designed it. This ADR does not change
`GET /auth/me`'s behavior or dependencies: whichever service is authoritative for `Organization` at any point in the
migration, `GET /auth/me` keeps reading Auth's own copy of the hierarchy tables (pre-cutover, the authoritative copy;
post-cutover, a copy Auth still holds for its own membership joins — see "No Auth-side projection is required," which
is about *not needing a new synchronized copy*, not about deleting the columns `OrganizationMembership` already
depends on). No genuine counter-example that would force a new synchronous Auth→organization-service dependency was
found in `login`, `refresh`, or `logout`.

**No Auth-side organization projection or replica is required.** Auth does not need a synchronous or event-derived
copy of organization-service's post-cutover data merely to keep functioning, because the flows that matter for
authentication (login, refresh, session issuance) never read `Company`/`Platform`/`Organization` business data to
begin with, as just verified. Nothing in this ADR asks Auth to consume organization lifecycle events or to keep a
derived copy in sync going forward; if `GET /auth/me`'s existing join is ever judged to need re-pointing at
organization-service's data instead of Auth's own rows, that is a separate, future decision, not something this
migration mechanism requires.

### Authorization considerations

organization-service's service-to-service calls (to or from auth-service, billing-service, payment-service) use the
existing per-caller→callee service-token pattern already established by ADR-0033: a random token per pair, the
callee storing only its SHA-256 digest, constant-time comparison, deny-by-default routing. This is a **mechanical
extension** of an already-decided pattern, not a new authorization decision — organization-service is simply another
service that needs a token to call, and be called by, its peers.

This ADR does **not** resolve, and explicitly names as still open (owned by other, already-identified decisions,
not reopened here):

- **B-029 / O-13 / O-14** (billing-service SDD / payment-service SDD): which producer services may create billable
  obligations or catalog entries for which organizations, and the service-token *scope* model needed to express
  that limit. organization-service's own token(s) fall under whatever that eventual scope model turns out to be;
  this ADR does not anticipate or narrow it.
- **B-026 / O-18**: who may pay, or act, on behalf of an organization (organization-payer authority). Unrelated in
  substance to who owns the live `Organization` row, and left exactly as open as the billing/payment SDDs already
  describe it.

### Failure handling

Reasoned through for each scenario named; where the repository or this decision does not yet support a concrete
answer, that is stated as deferred rather than invented.

| Scenario | Architectural behavior |
|---|---|
| Import (Phase A) fails partway | auth-service was never touched and remains fully authoritative throughout Phase A; the import is simply re-run once fixed. No user-facing effect. |
| Verification (Phase B) detects a mismatch | Phase C is never entered; auth-service stays authoritative. The mismatch is corrected in the import (or, if it reveals a bug in the invariant check itself, in the check) and Phase B re-run. No freeze, no cutover, no user-facing effect. |
| A structural write to `Company`/`Platform`/`Organization` is attempted during the freeze (Phase C) | Rejected explicitly (not silently dropped or silently redirected). Ordinary login/refresh/membership traffic is unaffected — the freeze scopes only to the three hierarchy tables' own mutating endpoints, which nothing else in Auth's request path touches (see "Auth independence"). |
| Cutover (Phase D) fails before authority actually changes | auth-service remains authoritative; this is architecturally identical to a Phase B failure — no partial-authority state exists, because Phase D is the single atomic event at which authority changes, not a range of steps that can be half-completed. |
| Cutover succeeds, but a subsequent code deployment (e.g. pointing consumers at organization-service) fails | This is exactly the deployment-rollback-≠-ownership-rollback case. If organization-service accepted no writes in the interim, a plain redeploy of the prior code is sufficient. If it did accept writes, reconciling them is the deferred post-cutover procedure (see "Rollback semantics") — not invented here. |
| organization-service is unavailable immediately after cutover | Auth's own login/refresh/session flows are unaffected (per "Auth independence" — they have no synchronous dependency on organization-service). Any capability that *does* need live `Company`/`Platform`/`Organization` data from organization-service degrades exactly as any other synchronous service dependency going down would, per `core-architecture.md`'s existing "any service → dependency: fail closed" convention — this is not a new failure mode this ADR introduces. |
| A `Company`/`Platform`/`Organization` mutation is attempted after cutover through the old (auth-service) path | Must not succeed — the entire point of Phase D is that auth-service is no longer authoritative. Auth's own hierarchy-mutation endpoints must stop being a live, competing write path once cutover completes; the exact mechanism (decommissioning the endpoints, turning them into a read-only proxy to organization-service, or something else) is a Stage 9 implementation decision, not settled here. |
| Billing or Payment still reference an existing `organizationId` after cutover | No action needed. Both already treat it as an opaque identifier with no foreign key and no dependency on who owns the live row (see "Cross-service reference rules") — this is exactly the case those design choices were already built to tolerate. |
| Auth continues operating while organization-service is temporarily unavailable, at any point before or after cutover | Yes, unconditionally for login/refresh/session/membership traffic, because none of it has ever depended on organization-service or on live `Company`/`Platform`/`Organization` reads (per "Auth independence"). This holds identically before Phase A even starts and indefinitely after Phase E completes. |

## Consequences

**Good**

- O9 (`core-architecture.md` §11) is closed as an architectural question: there is now a defined, bounded mechanism
  for moving hierarchy authority from auth-service to organization-service, rather than an open-ended "decide when
  it is built."
- The mechanism reuses invariants that already exist and are already enforced (`platform.companyId`,
  `organization.platformId`, both `NOT NULL` FKs, both immutable by trigger) rather than inventing new business
  rules for the migration itself.
- Billing, Payment, and any other opaque-`organizationId` consumer require **no code or schema change** — the
  central risk O9 could have created (re-keying every financial record's organization reference) is avoided by
  keeping IDs stable across the migration.
- Auth's login/refresh availability is unaffected by organization-service's existence, construction, or downtime,
  now or after cutover — no new synchronous dependency is introduced on Auth's authentication path.
- The service-token pattern (ADR-0033) needs no new design to accommodate organization-service; it is a mechanical
  extension.

**Costs / risks**

- **A split-ownership window is a standing, accepted risk during the migration itself.** Between Phase A and Phase
  D, two copies of `Company`/`Platform`/`Organization` data exist (auth-service's live rows, organization-service's
  imported copy); only auth-service's is authoritative during that window, but the existence of a second, inert copy
  is itself a risk surface (e.g. accidentally querying the wrong one) that this ADR does not eliminate, only bounds
  in time via Phase B/C/D.
- **Post-cutover ownership rollback has no designed procedure.** Until it is designed (see Deferred decisions), a
  bad cutover that organization-service has already written new data against has no recorded recovery path beyond
  "investigate and reconcile manually."
- **The cutover-detection/authority-recording mechanism is undecided**, so Phase D cannot be executed today even
  once organization-service exists — a further, small decision is required first (see Deferred decisions).
- Auth's `GET /auth/me` keeps its existing dependency on Auth's own `organization`/`platform`/`company` tables
  unchanged by this ADR; if a future decision re-points that join at organization-service instead, that is new
  scope this ADR does not cover.
- Follow-up work this ADR creates: `core-architecture.md`'s O9 row should eventually be marked resolved (not done
  here — this task is scoped to this one file); a future Stage 9 SDD/ADD for organization-service itself, and the
  concrete Stage 9 prerequisites named below.

## Deferred decisions

Explicitly out of scope for this ADR, named so they are not mistaken for settled:

- **The post-cutover reconciliation / ownership-rollback procedure** (see "Rollback semantics") — what happens,
  concretely, if organization-service must be un-cut-over after it has already accepted new writes.
- **B-026 / O-18** — organization-payer authority (who may pay, or act, on behalf of an organization).
- **B-036** — platform currency administration (which service administers a platform's enabled currencies, and how
  an invoice determines its platform in the first place).
- **B-029 / O-13 / O-14** — producer / service-token *scopes*: which services may create billable obligations or
  catalog entries for which organizations, and the scope model for that.
- **Organization lifecycle semantics** beyond what already exists today (archive/deactivate rules, suspension, and
  any other business behavior for `Organization`/`Platform`/`Company` not already implemented in auth-service).
- **The exact cutover-detection/authority-recording mechanism** (a configuration flag, a migration marker, a
  versioned-authority record, or some other means every dependent consults) — nothing in the repository today
  evidences which of these is intended; it must be decided before Phase D is exercised.
- **What happens to Auth's own `Company`/`Platform`/`Organization`-mutating endpoints after cutover** (decommission,
  read-only proxy, or another shape) — named under "Failure handling" as a Stage 9 implementation decision.

## Implementation prerequisites for a future "Stage 9" (organization-service build)

Before work on organization-service itself begins, the following must exist or be decided — none of it is designed
or built by this ADR:

- organization-service exists as a real, deployed service with its own database, following this repo's
  database-per-service principle (ADR-0032), and its own schema for `Company`/`Platform`/`Organization` preserving
  the same `Company 1 → N Platform`, `Platform 1 → N Organization` invariants auth-service enforces today.
- Bootstrap/import tooling for Phase A (reading auth-service's current hierarchy rows and loading them into
  organization-service's database with identical `id` values).
- Verification tooling for Phase B and Phase E, implementing the invariant checks named above.
- A decision on the cutover-detection/authority-recording mechanism (see Deferred decisions) — required before
  Phase D can be executed, not before organization-service can be built.
- A decision on what happens to auth-service's own hierarchy-mutating endpoints post-cutover (see Deferred
  decisions).
- Per-pair service tokens (ADR-0033's existing pattern) minted for organization-service's calls to and from
  auth-service, billing-service and payment-service, as needed by whatever organization-service's own API surface
  turns out to require.
- The post-cutover reconciliation/ownership-rollback procedure should be designed before Phase D is exercised
  against a real environment carrying real subsequent writes — running the migration without it is a known,
  accepted risk, not a recommended one.

Resolving B-026/O-18, B-036, or B-029/O-13/O-14 is **not** a prerequisite for organization-service to be built or
for this migration mechanism to run — they are independent, already-tracked decisions this ADR does not fold in.

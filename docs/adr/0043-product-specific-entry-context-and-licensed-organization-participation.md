# 0043. Product-specific entry context and licensed organization participation

- **Status:** Proposed <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X --> (draft; not approved. Nothing in
  this ADR takes effect, and nothing is implemented, until the architecture owner accepts it.)
- **Date:** 2026-09-20
- **Deciders:** Anwar (project owner), approval pending

> **Extends** [ADR-0028](./0028-organization-join-codes-membership-and-organization-admin.md) (organization key
> semantics unchanged, generalized), [ADR-0030](./0030-multi-organization-membership-and-revoked-state.md) (multi-organization
> membership is the mechanism that makes a Flow-style consumer possible), [ADR-0031](./0031-organization-service-intended-owner-of-the-hierarchy.md)
> (`Platform` already models "a product/app"), [ADR-0038](./0038-entitlement-in-billing-service.md) (the entitlement
> boundary that "licensed Flow participation" is built on), and [ADR-0041](./0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md)
> (client neutrality, generalized from administration to entry). **Does not modify** ADR-0039, ADR-0040 or ADR-0042.
> Analysis in the [product entry context study](../architecture/stage-10/stage-10-product-entry-context-study.md).

## Context

Every organization-entry flow this repository has designed assumed one shape: a person opens a platform app and must
first say which organization they belong to (stated directly in ADR-0028's context). Nawara now plans products that
do not all share that shape. Nawara Driver and Nawara School are organization-oriented: the product presents an
organization-resolution input (a join code) before the product is used. Nawara Flow is platform-wide at entry: a
consumer enters Flow first, without naming an organization, and interacts with whichever organizations participate in
(are licensed for) Flow; an organization context is still required later for a specific organization interaction or
for Flow administration.

Without this decision, the repository has no stated rule for how a product declares its entry model, and future work
risks either (a) forcing Flow through the Driver/School join-code-at-entry shape, or (b) inventing per-client
conditionals ("if this is the Flow client, skip organization input") that put a business rule in the wrong place
(ADR-0041 already rejects client-conditioned business logic for administration; the same problem would recur for
entry if not named).

This is an architecture-level decision. It does not redesign Auth, organization-service, Billing, Payment or
Entitlement, and it does not implement Nawara Driver, Nawara School or Nawara Flow.

## Options considered

1. **One universal rule: every product requires organization context before entry.** Rejected. This is the rule
   implicitly in place today (Driver/School's only implemented shape); it does not fit Flow's platform-wide consumer
   experience and would force a join-code step with no organization for the user to name yet.
2. **Client-technology-conditioned entry behavior** (mobile shows an organization input, browser doesn't, etc).
   Rejected: entry behavior is a product/platform property, not a client-technology property (same reasoning as
   ADR-0041 for administration); it would also require every client of a given product to independently reimplement
   the same conditional correctly.
3. **An open marketplace: Flow exposes every organization that exists in Organization Service.** Rejected: organization
   existence and product participation are different concepts; this would expose organizations that never opted into
   Flow and removes the incentive for an organization to license Flow.
4. **Each product declares its own initial entry context model; Flow's organizations are scoped to licensed
   participants, not all of Organization Service.** Chosen.

## Decision (proposed)

We propose **Option 4**:

1. **Products do not share one universal entry flow.** Each product declares its own initial entry context model.
   This is the primary change this ADR makes.
2. **Nawara Driver requires organization context at initial entry**, via the existing organization-resolution
   mechanism (ADR-0028's join code, or an equivalent server-resolved code). No change to that mechanism.
3. **Nawara School requires organization context at initial entry**, by the same mechanism as Driver. No new,
   School-specific mechanism is introduced.
4. **Nawara Flow does not require organization context at initial entry.** A Flow consumer authenticates and enters
   the product before naming any organization.
5. **Flow can establish organization context later**, for a specific organization interaction, through whatever
   mechanism that interaction needs (an existing membership, a per-interaction lookup, or another server-approved
   mechanism) — not decided further here.
6. **Flow administration requires an authorized organization context**, established through an approved mechanism
   (organization membership with the organization-management capability, an operator's Platform assignment, an
   owner's company-wide authority, or an invitation — the same authority model ADR-0028's `organizationAuthority`
   and ADR-0042's service-token Platform scope already provide). The organization key is not the universal
   administrative mechanism; which specific mechanism Flow administration uses is product-level detail, not decided
   here.
7. **Organization keys are context-resolution mechanisms, not identity or roles.** Unchanged from ADR-0028: a key
   resolves to an organization/platform/audience server-side; it is never trusted as identity, authentication, role
   or permission.
8. **Product roles remain product-owned.** No product's roles (Student/Instructor/Admin for Driver, Student/Teacher/Admin
   for School, Consumer/Provider/Manager for Flow, or any other) become a field on the universal `User`. Unchanged
   from ADR-0028 and ADR-0030 (`User.kind` stays `member | owner | operator`; `audience` stays opaque).
9. **Organization existence does not imply participation in every product.** `Organization` is already single-parented
   to exactly one `Platform` (ADR-0031); an organization existing under one product's `Platform` does not make it
   visible to, or a participant of, another product. No change to the hierarchy is needed to state this.
10. **Flow only interacts with organizations that participate in (are licensed for) Flow.** Participation is: an
    `Organization` row exists under the Flow `Platform`, and it holds an active entitlement recognized by
    billing-service (ADR-0038). No new service is created for this; it is the existing hierarchy plus the existing
    entitlement boundary, applied to a Flow-scoped `Platform`.
11. **Future entitlement/licensing is the authority for product participation**, per ADR-0038's boundary
    (billing-service owns entitlements; Core never invents a second one). The business flow of an organization
    discovering, requesting, and licensing Flow participation (source material §5) is **not implemented by this
    ADR** — it is a product/business flow to design later, on top of the entitlement boundary this ADR does not
    change.
12. **Client technology does not determine the entry model.** A product's entry contract (organization-context vs.
    platform-wide) is the same for every client of that product (Android, iOS, web, Tauri, or any future client).
    This restates ADR-0041's client-neutrality principle, generalized from administration to entry.

## Not decided here

- **How a Flow-only consumer identity is represented in Auth.** `POST /auth/register` requires a join code
  unconditionally today, and a deferred database trigger requires every `kind=member` account to hold at least one
  organization membership at commit (ADR-0030). Nawara Flow's platform-wide entry implies an identity that can exist
  and authenticate before joining any organization, which the current data model cannot express. This is a real
  architectural fork (see the [product entry context study §4](../architecture/stage-10/stage-10-product-entry-context-study.md#4-the-one-real-tension-can-an-identity-exist-with-zero-organizations))
  and requires its own Auth-focused ADR; this ADR deliberately does not resolve it, consistent with its scope fence.
  **2026-09-20 update:** examined in depth in the [Auth, Flow subscription and membership study](../architecture/stage-10/stage-10-auth-flow-subscription-and-membership-study.md),
  which finds no security-relevant reason the invariant must stay as-is and rules out a synthetic organization.
  That study's tentative "new `User.kind`" idea is in turn superseded by the
  [user identity, membership and context study](../architecture/stage-10/user-identity-membership-context-study.md):
  the worker+consumer scenario shows a single-valued `User.kind` cannot express holding an organization role and an
  independent product-consumer role at once, so the open fork narrows to relaxing/replacing the membership
  invariant itself, not choosing a new identity kind. Still an owner decision; this ADR's status and decisions are
  unchanged.
  **2026-09-20 owner decision, implemented and independently audited:** recorded in
  [the member-membership-invariant owner decision](../architecture/stage-10/member-membership-invariant-owner-decision.md) —
  **ACCEPTED**: `member → OrganizationMembership [0..N]` (relaxing the prior `[1..N]` DB-enforced invariant).
  Implemented via migration `0009_member_zero_membership.sql` and verified by an independent read-only
  security/regression audit (verdict `PASS WITH FINDINGS`, zero security/authorization/migration/architecture
  blockers). A production Flow registration endpoint that would actually create a zero-membership member is
  still **not built** — only the underlying Auth identity capability exists. This does not add `User.kind =
  consumer` and does not accept ADR-0038. This ADR's own Status and Decision list remain unchanged and unaccepted.
- Whether, or when, Nawara Flow (or Nawara Driver, or Nawara School) is actually built.
- The Entitlement Service or any extension of billing-service's entitlement capability beyond ADR-0038.
- The specific mechanism(s) Flow administration or Flow's later organization-context establishment use (decision 5
  and 6 name the space; they do not choose within it).
- Whether `Platform.key` (already an Auth-issued public slug, per `apps/organization-service/README.md`) is reused
  as a product selector for clients, or is a separate concern.
- Any UI, client, or app-repository implementation (Android/iOS/web/Tauri for any product).

## Consequences

- **Easier:** a new product with a different entry shape (a delivery app, a booking app) can declare its own entry
  context without a Core change or a special case; Flow's "licensed participation" reuses the existing hierarchy and
  entitlement boundary instead of inventing a new one; client-neutrality now covers entry as well as administration,
  closing a gap ADR-0041 left open.
- **Harder, or given up:** Nawara Flow cannot ship a working consumer registration flow until the Auth identity
  question above is resolved by a separate, Auth-focused ADR; this ADR does not shortcut that by adding fields to
  `User` or relaxing the membership trigger unilaterally.
- **Stage 10:** no change to ADR-0039, ADR-0040 or ADR-0042; no new blocker for Stage 10.1; organization-service's
  non-authoritative status and production gates (ADR-0040 decision 7) are unaffected.
- **Follow-up:** an Auth-focused ADR for the zero-membership identity question; a later ADR for the Flow
  organization-participation/licensing business flow once entitlement work reaches it; `core-architecture.md` gets a
  short cross-reference to this ADR (no rewrite) noting that `Platform` already carries the "which product" concept
  entry-context decisions are keyed on.

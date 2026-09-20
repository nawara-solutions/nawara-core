# Stage 10: product entry context study

- **Status:** Study (no implementation). Feeds [ADR-0043](../../adr/0043-product-specific-entry-context-and-licensed-organization-participation.md).
- **Date:** 2026-09-20

## 1. Why this study exists

Every product-facing flow this repository has designed so far — join codes ([ADR-0028](../../adr/0028-organization-join-codes-membership-and-organization-admin.md)),
multi-organization membership ([ADR-0030](../../adr/0030-multi-organization-membership-and-revoked-state.md)), the
organization hierarchy ([ADR-0031](../../adr/0031-organization-service-intended-owner-of-the-hierarchy.md)) — was written
against a single implicit shape: a person opens a platform app and must first say which organization they belong to.
ADR-0028's own context section states this directly: *"A person opens a platform app (for example Nawara Drive) and
must first say which organization they belong to."*

Nawara now intends products that do not all share that shape:

```
Nawara Driver  → organization-context entry (join code / organization resolution before product use)
Nawara School  → organization-context entry (same mechanism, different consumer)
Nawara Flow    → platform-wide entry (no organization required to enter; organization context appears
                  later, per interaction, scoped to organizations licensed for Flow)
```

This is a genuine new requirement, not a restatement of something already decided. This study audits the repository
against it before any decision or code changes are made, per the scope fence in [ADR-0043](../../adr/0043-product-specific-entry-context-and-licensed-organization-participation.md).

**Boundary with `nawara-drive`:** this repo's services are consumed over HTTP only (CLAUDE.md); it does not contain
or need to read client/UI code. Nawara Driver, Nawara School and Nawara Flow are all products that will live outside
this repo (as `nawara-drive` does today). This study only tracks the **contract** each product's entry model implies
for Core's services, not any client implementation.

## 2. What "organization key" already means in this repository

[ADR-0028](../../adr/0028-organization-join-codes-membership-and-organization-admin.md) already defines the organization
key (join code) as a **context-resolution mechanism**, not an identity or a role:

- The client sends only the code; the server resolves `organizationId`, `platformId`, `audience`,
  `requiresApproval`, `requiresSubscription`.
- The code never carries a role or permission; `audience` is an opaque label the platform interprets, never Auth.
- The resulting membership is read live on every request (`organization_membership`), never cached in a token.

This is **already exactly** the "organization key semantics" section 10 of the source request asks for. No change is
needed here for Driver or School. **Classification: SAFE / ALREADY COMPATIBLE.**

## 3. What "platform" already means, and how it maps to products

`Company 1 → N Platform 1 → N Organization` ([core-architecture.md §1](../core-architecture.md#1-the-model-everything-shares)).
A **Platform is already the generic model of "a product/app"** ("Core never interprets what a platform is"). This
gives the new entry-context principle a natural home without inventing new entities:

- Nawara Driver, Nawara School and Nawara Flow are each a `Platform` row.
- An `Organization` row's parent is exactly one `Platform` (`Organization.platformId`, single FK, immutable —
  confirmed in `apps/organization-service/README.md`). There is **no** `Organization ↔ Platform` many-to-many.

This has a direct consequence for section 11 of the source request ("licensed organization participation"): **the
same real-world organization (e.g. a driving school) participating in both Nawara Driver and Nawara Flow requires two
separate `Organization` rows — one under the Driver `Platform`, one under the Flow `Platform`.** Core does not, and
should not, model "the same organization across products" as a single row; `Organization.type` is already opaque and
platform-scoped by design (ADR-0020). Whether two such rows represent "the same" business entity is a product/business
concept, not a Core one. **Classification: DOCUMENTATION UPDATE** (state this mapping explicitly in core-architecture.md
and in the new ADR, so a future reader does not try to model cross-platform organization identity in Core).

"Flow-licensed" (section 11: which organizations participate in Flow) is therefore not a new Core concept — it is:
*does a Flow-platform `Organization` row exist, and does it hold an active entitlement (billing-service,
[ADR-0038](../../adr/0038-entitlement-in-billing-service.md))?* No new service is implied. **Classification: SAFE /
ALREADY COMPATIBLE**, once stated explicitly (see ADR-0043 decision 9-11).

## 4. The one real tension: can an identity exist with zero organizations?

This is the audit's most important finding.

[ADR-0030](../../adr/0030-multi-organization-membership-and-revoked-state.md) states: *"A deferred constraint trigger
requires every member to have at least one membership at commit (rows are never deleted, so this holds for the life
of the account)."* `POST /auth/register` (`apps/auth-service/src/auth/dto.ts`) requires `joinCode` unconditionally —
there is **no** registration path today that creates a `kind=member` account without simultaneously creating an
organization membership.

Nawara Flow's stated entry model ("platform-wide... no organization required at entry... Flow can establish
organization context later") implies a consumer identity that can exist, authenticate, and use the product **before**
joining any organization. As written today, Auth's data model cannot express that: every member is DB-enforced to
have ≥1 membership from the moment the account exists.

This is not a bug and nothing here contradicts an *accepted* decision — ADR-0030 is still `Proposed`, and the ≥1-membership
trigger was a deliberate choice for the Driver/School shape the repository had at the time. But it is a genuine
architectural fork: either (a) a Flow-only identity is a `kind=member` with a relaxed membership requirement, (b) it
is some other identity shape Auth does not have yet, or (c) Flow's "no organization at entry" is satisfied some other
way (e.g. a lightweight, org-less session that is *not* yet a full member account, upgraded to a membership on first
organization interaction). Each option touches Auth's identity model — explicitly out of scope for this task (the
scope fence forbids redesigning Auth, adding `User.organizationId`/`User.platformId`, and adding Auth roles).

**Classification: ARCHITECTURE DECISION REQUIRED, DEFERRED** at the time this study was written. This ADR does not
resolve it; it names the fork so the next Auth-focused ADR starts from the real question instead of re-discovering
it. No code changes to Auth are made here for exactly this reason.

> **2026-09-20 owner decision accepted:** option (a) above. See
> [the member-membership-invariant owner decision](./member-membership-invariant-owner-decision.md) —
> `member → OrganizationMembership [0..N]` is the accepted future direction. Not yet implemented (no migration,
> trigger edit, or registration endpoint exists); the evidence and reasoning above that originally identified this
> fork are preserved unchanged.

## 5. Client neutrality: already the rule, already generalized correctly

[ADR-0041](../../adr/0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md) (Proposed) already
establishes that administrative capabilities are client-neutral APIs, that client type/technology never gates
authorization, and that "if mobile → show X" style client-conditioned logic does not belong in a domain service. This
is the same principle section 9 of the source request asks for ("product entry behavior belongs to the product
contract, not client technology"), just generalized from *administration* to *entry* in general. **Classification:
SAFE / ALREADY COMPATIBLE.** ADR-0043 restates it for entry context specifically and cross-links back to ADR-0041
rather than re-deciding it.

## 6. Flow administration: already has a home

Section 6 of the source request ("Flow administration still requires organization context") is already the shape
ADR-0028's `organizationAuthority` (owner / operator / org_admin, evaluated live per request from the organization in
the URL) and ADR-0042's service-token, Platform-scoped authorization model provide. Flow's administration surface
would be "one more product's admin API," authorized the same way Driver's and School's already are — no new
mechanism. **Classification: SAFE / ALREADY COMPATIBLE.**

## 7. Global business-role leakage: already prevented

Section 8 of the source request (product roles like Student/Instructor/Consumer/Manager must not become universal
`User` fields) is already enforced: `User.kind` stays `member | owner | operator`; `audience` on the membership is an
opaque label Auth never interprets (ADR-0028, ADR-0030). Nothing in the new entry-context model requires touching
this. **Classification: SAFE / ALREADY COMPATIBLE.**

## 8. Findings summary

| # | Finding | Classification |
|---|---|---|
| F1 | Join code / organization key is already a context-resolution mechanism, not identity or role (ADR-0028) | SAFE / ALREADY COMPATIBLE |
| F2 | `Platform` already models "a product/app"; `Organization` is single-parented to one `Platform` | DOCUMENTATION UPDATE |
| F3 | "Licensed Flow participation" reduces to an existing-Organization-row + billing entitlement question; no new service needed | DOCUMENTATION UPDATE |
| F4 | `POST /auth/register` requires `joinCode` unconditionally; a deferred DB trigger requires every member to have ≥1 membership at commit | ARCHITECTURE DECISION REQUIRED, DEFERRED |
| F5 | Client-neutrality rule for entry behavior already exists at the administration layer (ADR-0041) and generalizes cleanly | SAFE / ALREADY COMPATIBLE |
| F6 | Flow administration authorization already has a home (`organizationAuthority`, service-token Platform scope) | SAFE / ALREADY COMPATIBLE |
| F7 | Product roles are already kept off the universal `User` (ADR-0028, ADR-0030) | SAFE / ALREADY COMPATIBLE |
| F8 | No existing doc or code encodes "every product requires organization context at entry" as a cross-product rule; ADR-0028's context section only describes the mechanism for organization-context products, scoped by example to Nawara Drive | SAFE / ALREADY COMPATIBLE (worth stating explicitly so it is not mistaken for a universal rule later) |
| F9 | `nawara-drive` (this repo's only implemented consumer) is a separate git repo; its client code was not read — out of this repo's scope per CLAUDE.md. Any Driver-side entry UI assumptions are that repo's concern | DEFERRED (tracked as a contract need only, per CLAUDE.md "Consumers") |

## 9. What is explicitly not decided by this study or by ADR-0043

- How a Flow-only identity is represented in Auth (F4). Requires its own ADR once the project owner chooses among the
  options in §4.
- Whether/when Flow, as a product, is actually built. Nothing here authorizes building it.
- The future Entitlement Service and its API shape (deferred to when billing-service's entitlement capability, ADR-0038,
  is extended or a dedicated capability is designed).
- Whether `Platform.key` (already used by Auth as a public slug) is reused as the product/app selector clients use to
  address Driver/School/Flow, or whether that is a separate concern. Flagged for the owner, not decided here.

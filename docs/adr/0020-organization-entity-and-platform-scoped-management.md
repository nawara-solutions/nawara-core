# 0020. Organization entity and platform-scoped organization management

- **Status:** Proposed
- **Date:** 2026-09-18
- **Deciders:** Anwar (project owner)

> **Amended by [ADR-0024](./0024-database-enforced-tenancy-and-authorization-integrity.md)** (on the following point only; the rest of this ADR stands): `User.organizationId` now has a real FK and is `NOT NULL` for members (`kind = 'member'`), superseding this ADR's "no foreign key / no existence validation" position for `auth-service`'s own database — see ADR-0024.

## Context

Per ADR-0001, `organizationId` has always been a purely opaque string claim: stamped onto
`User` in `auth-service`, and, per ADR-0004/ADR-0006/ADR-0007, onto `License`, `Charge`, and
`UserSubscription` in `payment-service`. `auth-service` "never interprets or validates what
the string means beyond requiring it be present" (ADR-0001's Decision), and its own
Consequences say so explicitly: "every consumer must treat `organizationId` as opaque and
never assume `auth-service` validates it against anything real (e.g. that the organization
exists, or is in good standing)." That was a deliberate v1 scoping choice, not an oversight —
but it leaves a real, growing gap that both `docs/add/auth-service.md` and
`docs/sdd/auth-service.md` already name in their own Open questions sections:

> No first-class `Organization` entity exists anywhere in this repo. `organizationId` is
> purely an opaque string claim stamped onto `User`, `License`, `Charge`, and
> `UserSubscription` records — there is no table, service, or API that treats "an
> organization" as a real, queryable thing with its own attributes.

Concretely: there is no way for a platform's owner or operator to list, view, or manage the
set of organizations that belong to their own platform, because `organizationId` and
`platformId` (per ADR-0009) are two independent opaque claims with no recorded relationship
between them anywhere in this schema.

Separately, ADR-0009 through ADR-0017 have built out a full owner/operator authorization
model for platform-scoped `Admin` accounts, distinguished only by `adminTier`. The project
owner's business need for this decision is that **both** the owner and every operator who has
access to a platform must be able to manage every organization belonging to that platform, with
equal rights — there is no product requirement for organization management to be owner-only the
way, e.g., ADR-0010's secret-key rotation or ADR-0012's operator-management surface are.
Organizations also need real business attributes — at minimum a tax code, an address, a phone
number, and a `type` — with more fields expected to be added over time as the product's needs
grow.

**This ADR was originally written, and this Decision below was originally settled with the
project owner, against ADR-0009's model:** a platform-scoped `Admin` account carrying a single
`platformId` claim (owner: that platform's top-level administrator; operator: a delegated
account scoped to that same one platform), with `platformId` itself a purely opaque,
unvalidated string — there was no real `Platform` row anywhere in the schema for it to point
at, and no way to check a caller's claimed `platformId` against anything real. **ADR-0022,
written after this ADR but settled and rewritten in first, changes both halves of that
foundation**, and this revision updates this ADR's Decision to match, without re-litigating the
three modeling questions below (still true, and still not re-litigated in Options considered,
which instead covers where the resulting entity should live):

1. Whether `Organization` lives in `auth-service`, a new dedicated service, or
   `payment-service` — this is genuinely open and is what Options considered addresses.
2. Whether `Organization.type` should be a validated enum of known values or a generic,
   opaque string, `auth-service` never interpreting it — decided as opaque, for the same
   reason `organizationId` itself (ADR-0001) is opaque: per this repo's `CLAUDE.md`,
   `nawara-core` must stay generic, and a real value like `"driving-school"` would be a
   Nawara-Drive-specific concept leaking into a Core service.
3. Whether future organization fields should be added as ordinary typed columns via
   migration, or as a metadata/JSON blob — decided as ordinary typed columns, matching how
   this repo has already evolved `User` field-by-field, one ADR and one migration at a time
   (ADR-0009 added `platformId`/`adminTier`, ADR-0010 added `secretKeyHash`, ADR-0011 added
   `phone`, etc.).

Concretely, what ADR-0022 changes underneath this ADR:

- **`Platform` is now a real, first-class entity in `auth-service`'s own database** (owned by a
  `Company`), not an unvalidated opaque string. `Organization.platformId`, as this ADR
  introduces it below, is therefore a real foreign key to `Platform.id` from the start — both
  tables live in the same database — rather than the opaque, unvalidated string this ADR
  originally specified it as (when no `Platform` table existed anywhere for it to reference).
- **The owner/operator authorization model this ADR's endpoints need to gate against no longer
  derives platform scope from a JWT claim.** ADR-0022 drops the `platformId` JWT claim entirely.
  An owner's access is company-wide by construction (`adminTier: 'owner'` alone is sufficient).
  An operator's access to a given platform is now a live, revocable
  `PlatformAssignment {operatorId, platformId, active}` row (per ADR-0022), checked at request
  time — never assumed from a token claim, since an assignment can be revoked mid-session (per
  ADR-0023, which defines the concrete live-check primitive, `GET
  /auth/platform-access/:platformId`, this ADR's own endpoints reuse in-process).

This ADR resolves the original `Organization`-entity gap quoted above, and, per this repo's
ADR-immutability rule, does not amend or supersede ADR-0001, ADR-0004, ADR-0006, ADR-0007,
ADR-0009, or ADR-0022 — it adds a new decision layered on top of what they already established.
`organizationId` stays exactly the opaque claim/column ADR-0001 describes on every row that
already carries it; only `Organization.platformId` itself changes character, from an opaque
string (as this ADR would have specified it before ADR-0022) to a real FK, per ADR-0022's own
Decision naming this ADR, by number, as needing exactly that update.

## Options considered

1. **A new, dedicated `organization-service`.** Cleanest single-responsibility boundary — an
   `Organization` is its own bounded concept, and a new service would own it with no
   competing responsibilities. Rejected: this is a fairly simple CRUD entity (a handful of
   business fields, scoped by `platformId`), and standing up an entirely new microservice —
   its own database, its own deployment, its own JWT-verification/RBAC setup duplicated from
   scratch — is a disproportionate amount of new infrastructure for what this decision
   actually needs. It would also have to duplicate, or awkwardly depend on, `auth-service`'s
   existing owner/operator authorization model (now including `Company`/`Platform`/
   `PlatformAssignment`, per ADR-0022) just to answer "is this caller allowed to manage this
   organization," since that model is what actually decides the answer.
2. **`payment-service`.** Already stores `License`, `Charge`, and `UserSubscription` rows
   keyed by `organizationId` (per ADR-0004/ADR-0006/ADR-0007), so it already has a real,
   working relationship with the concept. Rejected: those entities are all billing/license
   concerns — what an organization has paid for, and whether it currently holds a valid
   license — not organization *identity*: a name, a tax code, an address, a phone number.
   Mixing the two would make `payment-service` responsible for data that has nothing to do
   with money, and — the more important problem — organization management is fundamentally an
   *authorization* question ("can this caller see/edit this organization"), and
   `payment-service` has no `Platform`/`PlatformAssignment` concept of its own to answer it
   with; it would need to import or duplicate `auth-service`'s owner/operator model just to
   gate these endpoints.
3. **`auth-service` (chosen).** `auth-service` already owns `Platform`/`PlatformAssignment`
   (per ADR-0022) and the entire owner/operator authorization model (ADR-0010/ADR-0011/
   ADR-0012/ADR-0017/ADR-0022/ADR-0023) that this decision needs to gate organization
   management with. Since managing an organization is, at its core, a question of "who is
   allowed to see/edit this organization under this platform" — a question `auth-service`
   already has every piece needed to answer — this is squarely inside `auth-service`'s existing
   jurisdiction, not a new concern being bolted on.

## Decision

We chose **Option 3**. Concretely:

### New `Organization` entity (auth-service, TypeORM per ADR-0003)

- `id: uuid` — primary key.
- `platformId: uuid` — **non-null, a real foreign key to `Platform.id`** (per ADR-0022). Every
  organization belongs to exactly one platform. Unlike `organizationId` itself (ADR-0001), which
  stays opaque everywhere it's referenced from outside `auth-service`'s own database (a real
  cross-service foreign key isn't possible under this repo's database-per-service principle),
  `Organization.platformId` is an actual, enforceable, intra-service foreign key: both
  `Organization` and `Platform` live in `auth-service`'s own database, per ADR-0022's Decision
  naming this exact upgrade. A typo'd or nonexistent `platformId` on organization creation is a
  real, checkable error now, not a silently-accepted opaque string.
- `name: string` — **required**. Every other field on this entity can legitimately be filled
  in later (a new organization can be created before its tax code or address is known), but a
  nameless organization is not a usefully manageable "thing" — an owner or operator listing
  their platform's organizations needs at least a name to tell one row from another. Required
  at creation time, not left nullable-then-enforced-at-the-DTO-layer the way ADR-0001 treats
  `organizationId`, because there is no equivalent out-of-band write path here that would ever
  need to create an unnamed row.
- `taxCode: string | null`.
- `address: string | null`.
- `phone: string | null`.
- `type: string | null` — **generic and opaque**, exactly like `organizationId` (ADR-0001):
  `auth-service` never validates or interprets specific values. Per this repo's `CLAUDE.md`
  hard rule, a concrete Nawara-Drive-specific value (e.g. `"driving-school"`) must never be
  baked in here as a real enum member or validated constant — each consuming app decides what
  its own organization types are and means.
- `createdAt: timestamp`, `updatedAt: timestamp`.

Future organization fields (more are explicitly expected) are added as ordinary typed
columns via their own migration, exactly the way this repo has already evolved `User`
field-by-field (ADR-0009's `platformId`/`adminTier`, ADR-0010's `secretKeyHash`, ADR-0011's
`phone`, etc.) — not as a metadata/JSON blob. This keeps `Organization` queryable and
typed the same way every other entity in this schema is, at the cost of a small migration
each time a field is added; that tradeoff is the one this repo has already made repeatedly
for `User` and is kept consistent here.

### `organizationId`, everywhere it already exists, now refers to this entity's `id`

**This is the central cross-cutting point of this decision, stated explicitly.**
`User.organizationId` in `auth-service` (per ADR-0001), and `License.organizationId`,
`Charge.organizationId`, and `UserSubscription.organizationId` in `payment-service` (per
ADR-0004/ADR-0006/ADR-0007), now refer to this new `Organization` entity's `id` — that string
finally has something real to point at. Every one of those existing rows and services keeps
treating the value exactly as opaque as it always has: they do not gain, and do not need,
access to `Organization`'s business fields, only its `id`. This ADR changes **nothing** about
how `User.organizationId` or any of `payment-service`'s entities work today — no foreign-key
constraint is added anywhere across the service boundary (a real cross-service constraint isn't
possible under this repo's database-per-service principle, since `payment-service` and
`auth-service` each own their own database), no existence-validation is added to
`POST /auth/register` or any `payment-service` write path, and no migration of existing
`organizationId` values is required. It only gives that id a real, queryable, manageable thing
to describe, closing the gap ADR-0001's own Consequences already flagged ("every consumer must
treat `organizationId` as opaque and never assume `auth-service` validates it against anything
real") by finally making "does this `organizationId` refer to a real organization" an answerable
question, without deciding, here, that anything should start asking it automatically.

### New endpoints, gated by the existing `RolesGuard`, not `AdminTierGuard`

All four endpoints below are Bearer-authenticated and gated by `auth-service`'s existing,
generic `RolesGuard` (`role: admin`) — the same guard the ADD already describes as gating
"anything restricted to the platform's own `Admin` role." This is a deliberate departure from
how every owner-only endpoint in this design is gated (ADR-0010's secret-key rotation,
ADR-0011's operator creation, ADR-0012's entire `AdminOperatorController` surface, all behind
`AdminTierGuard`): organization management is, by explicit product decision, **not**
owner-only — an owner and every operator with access to a platform get equal rights to manage
that platform's organizations, so gating on the generic `role: admin` claim (true for both
tiers) rather than `adminTier` is the correct, and only, way to express that.

**Authorization now branches on tier inside each handler, rather than deriving `platformId`
from a JWT claim** — the single biggest mechanical change this revision makes, since ADR-0022
removed the `platformId` claim from the JWT entirely (an owner's access is unconditional and
company-wide; an operator's access to any specific platform must be checked live against
`PlatformAssignment`, per ADR-0022/ADR-0023, never assumed from a stale claim):

- **`POST /auth/admin/organizations`** — creates an organization. Body:
  `{platformId, name, taxCode?, address?, phone?, type?}`. **`platformId` must now be supplied
  explicitly in the request body** — it can no longer be implied by a JWT claim, since no such
  claim exists for either tier (per ADR-0022). Authorization branches on the caller's
  `adminTier`:
  - **Owner** — any `platformId` that resolves to a real `Platform` is accepted; an owner's
    access is company-wide and unconditional (per ADR-0022), so no further check is needed
    beyond the platform existing at all. `404` if the given `platformId` doesn't resolve to any
    real `Platform`.
  - **Operator** — the given `platformId` must resolve to a platform the operator currently has
    an **active** `PlatformAssignment` for. This reuses the identical live-check ADR-0023
    defines for `GET /auth/platform-access/:platformId`, called in-process (the same service,
    not a network hop) rather than as a second HTTP round-trip, since `Organization`,
    `Platform`, and `PlatformAssignment` all live in `auth-service`'s own database and the same
    request already has the caller's verified JWT in hand.
  - **Response shape for a rejection, reasoned through explicitly, since this is a genuine
    judgment call this ADR has to make that ADR-0023's own endpoint didn't have to.** ADR-0023's
    `GET /auth/platform-access/:platformId` always returns `404` (never `403`) on an operator
    mismatch, because that endpoint's whole shape is a `:id`-style existence lookup —
    "does this operator have access to this platform" is structurally the same kind of question
    as "does this row exist," so this repo's collapsed-404 convention (ADR-0012/ADR-0017/
    ADR-0020/ADR-0021/ADR-0023's shared precedent) applies cleanly. `POST
    /auth/admin/organizations` is different in kind: `platformId` here is a **body-supplied
    input to a create action**, not a path parameter resolving an existing resource the caller
    is trying to reach — there is no `:id` in this URL to collapse a distinguishing response
    against, and a real `Platform` with that id may well exist and be visible to other callers
    (e.g. the owner) without this operator ever having a legitimate reason to believe otherwise
    from a `404` alone. This is the same category of situation ADR-0011's own
    `POST /auth/admin/operators` and ADR-0009's platform-scoped creation paths already resolve
    by taking the scope id from the caller's own claim rather than accepting an arbitrary
    caller-supplied value at all — but that escape hatch isn't available here, since this
    endpoint's whole point is letting an operator (or owner) explicitly choose which of
    *their own* platforms an organization belongs to, and an operator may legitimately have
    more than one. **Decision: `403 {message: "You do not have access to this platform."}`** —
    a distinguishing, non-collapsed response — for an operator supplying a `platformId` that
    exists but that they have no active assignment to, reserving `404` strictly for a
    `platformId` that doesn't resolve to any real `Platform` at all. This is a deliberate,
    narrower departure from the collapsed-404 convention than any prior endpoint in this design
    has taken, made because the input here is a body-supplied value being validated for a
    *create* action with no existing target resource to collapse against, not a `:id`-scoped
    lookup of something that already exists — flagged explicitly here, and worth revisiting if
    a reviewer judges the enumeration cost (confirming a `platformId` is real, even if
    inaccessible) too high for this project's threat model.
- **`GET /auth/admin/organizations`** — lists organizations. Authorization and scope branch on
  `adminTier`:
  - **Owner** — lists organizations across **every** platform under the owner's company (per
    ADR-0022's company-wide access), with an optional `?platformId=` query parameter to narrow
    the result to one platform. **Decision, not the only reasonable design:** default to
    listing everything, rather than requiring the owner to always specify a platform, because an
    owner managing several platforms has a legitimate, common need to see organizations across
    all of them at once (e.g. a cross-platform search), and nothing about `Organization`'s shape
    changes based on how many platforms exist. The optional filter exists for the equally common
    case where an owner is working within one specific platform's context and doesn't want every
    other platform's organizations mixed into the same list.
  - **Operator** — lists organizations only across the operator's **currently-active** assigned
    platforms — a join against `PlatformAssignment` (`WHERE active = true`), not a
    JWT-claim-scoped query the way this endpoint worked before ADR-0022. An operator with zero
    active assignments sees an empty list, not an error.
- **`GET /auth/admin/organizations/:id`** and **`PATCH /auth/admin/organizations/:id`** —
  looked up by `:id` alone first (no platform predicate in the initial lookup, since there is no
  single caller-claimed `platformId` to filter by anymore), then authorized against the
  resolved organization's own `platformId`:
  - **Owner** — any organization, unconditionally (company-wide access, per ADR-0022).
  - **Operator** — only if the resolved organization's `platformId` matches one of the
    operator's currently-active `PlatformAssignment`s (the same live check `POST
    /auth/admin/organizations` uses above).
  - **`404`, never `403`, on any mismatch** — an unknown `:id`, or a real organization whose
    platform the operator has no active assignment to — collapsing both into the same response.
    Unlike the body-supplied-`platformId` case on `POST /auth/admin/organizations` above, this
    **is** a `:id`-scoped lookup of a specific, already-identified resource, so this repo's
    established collapsed-404 convention (ADR-0012/ADR-0017/ADR-0021/ADR-0023's shared
    precedent — "neither the caller nor whatever's behind it has any legitimate reason to learn
    that a row exists if they have no access to it") applies here exactly as it always has,
    unaffected by ADR-0022's removal of the `platformId` JWT claim — only what the check is
    computed *against* changes (a live `PlatformAssignment` row instead of a token claim), not
    the response shape.

## Consequences

- Resolves the specific gap named in `docs/add/auth-service.md`'s and
  `docs/sdd/auth-service.md`'s Open questions: `auth-service` can now answer "which
  organizations belong to platform X," and a platform's owner or operator has a real surface
  to list, view, create, and update them — now against a real `Platform` entity (per ADR-0022)
  rather than an unvalidated opaque string, and against a live `PlatformAssignment` check for
  operators (per ADR-0022/ADR-0023) rather than a JWT claim that could go stale mid-session.
- **Does not touch `payment-service` at all.** A follow-up ADR, **ADR-0021**, uses this entity's
  `platformId` field (and, per its own rewrite, ADR-0023's platform-access-check endpoint) to
  close a related cross-platform authorization gap in `payment-service`'s license/
  cash-payment endpoints. This ADR only introduces the `Organization` entity and its
  `auth-service`-side management endpoints; how, or whether, `payment-service` ever consults
  `platformId` for its own authorization is entirely that ADR's own decision.
- Explicitly out of scope, named plainly rather than silently dropped: bulk-import of
  organizations, organization deletion or deactivation, and any Nawara-Drive-specific
  organization sub-concepts (e.g. licensing plans, school-specific attributes) — none of these
  are designed here. `CLAUDE.md`'s hard rule already forbids the last category from ever
  living in this repo at all; the first two are simply undesigned v1 gaps, the same "explicitly
  out of scope, named plainly" treatment ADR-0016 already gave ownership transfer and a
  second/standby owner.
- No existence-validation is added anywhere that currently accepts an `organizationId` at
  face value (`POST /auth/register`, or any `payment-service` write path) — every such path
  keeps behaving exactly as its own ADR already describes. Whether any of them *should* start
  validating against this new table is a separate, undesigned question this ADR deliberately
  does not answer.
- Adds `auth-service`'s first entity that is neither owned nor referenced by `User` directly,
  and (per ADR-0022) its first entity carrying a real, enforceable foreign key to `Platform` —
  `Organization` requires its own migration under `apps/auth-service/src/migrations/` (per
  ADR-0003), sequenced after `Platform`'s own migration (ADR-0022).
- Widens `auth-service`'s already-undesigned per-endpoint rate-limiting gap (see the ADD's
  non-functional constraints) to four more Bearer-authenticated endpoints — only the existing
  global baseline covers them so far, the same inherited gap ADR-0012's
  `AdminOperatorController` surface already accepted.
- Establishes a reusable precedent for gating a capability to "any admin with access to this
  platform, owner or operator alike" via the plain `RolesGuard`/`role: admin` check, distinct
  from the `AdminTierGuard`/`adminTier: owner`-only pattern every prior admin-tier-aware
  endpoint in this design has used — future decisions that need "equal owner/operator rights"
  rather than "owner-only" now have a concrete precedent to follow instead of re-deriving the
  choice.
- **Introduces a genuine, narrow departure from this repo's collapsed-404 convention**, on
  `POST /auth/admin/organizations` only: a `403` (not `404`) for an operator supplying a real
  but inaccessible `platformId` in the request body. This is named explicitly as a deliberate,
  reasoned exception (see Decision), not an inconsistency, but it is the first place in this
  design where a caller-supplied scope id that resolves to a real, existing row still produces
  a distinguishing authorization-failure response rather than a collapsed `404` — worth
  revisiting if a future reviewer judges the resulting enumeration cost too high.

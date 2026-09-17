# 0001. Generic `organizationId` as the multi-tenancy scoping claim

- **Status:** Accepted
- **Date:** 2026-09-16
- **Deciders:** Anwar (project owner)

## Context

`auth-service` is currently a bare, unmodified Nest CLI scaffold (`apps/auth-service/src/`
has only the default `app.controller.ts`/`app.service.ts`/`app.module.ts`/`main.ts` —
no `User` entity, no JWT/passport/bcrypt dependencies exist yet). Per this repo's root
`CLAUDE.md`, the `User` concept it will eventually own must stay generic: a plain
`role: string`, with no app-specific (driving-school) concepts — students, instructors,
schools, exams — allowed anywhere in `nawara-core`.

This repo's consumer, `nawara-drive` (a separate sibling repo), already has its own
`ARCHITECTURE.md` and ADRs defining a role model of `Admin`, `SchoolAdmin`, `Instructor`,
and `Student`, where `SchoolAdmin`, `Instructor`, and `Student` all need to be scoped to
one driving school (a `schoolId`). `nawara-drive`'s own ADR-0003
(`0003-rename-admin-to-desktop-and-formalize-school-admin.md`) explicitly defers solving
this scoping problem, noting that "today there is no auth system locally — per
`CLAUDE.md`, that's `nawara-core`'s responsibility ... so a `SchoolAdmin` login and
`schoolId`-scoped authorization middleware is future work." That deferred future work is
this decision.

A bare `role: string` alone cannot express this: role identifies *what kind* of user
(e.g. `"admin"`), not *which tenant* that user belongs to. Something else has to carry
"this SchoolAdmin belongs to school X" — but per the hard rule above, `auth-service`
itself must never know what a "school" is.

Separately, every end user who registers through `auth-service`'s public,
self-service `POST /auth/register` endpoint belongs to exactly one organization —
there is no supported flow for an end user to register without one. The only account
type that legitimately has no organization is the platform's own `Admin` account
(the operator who issues organization licenses, see ADR-0004), and `Admin` accounts
are never created through `/auth/register`; they are provisioned out-of-band
(seeded directly into the database, or via a separate internal/operator-only
mechanism not exposed to the public API). This split matters for where the
"is `organizationId` required?" question actually gets answered: it cannot be
answered once, globally, at the schema level, because the schema has to
accommodate both the common case (a scoped end user) and the rare, out-of-band
case (an unscoped `Admin`).

## Options considered

1. **No scoping field at all** — every consuming app maintains its own userId-to-tenant
   mapping table and does an extra lookup per request to resolve which organization a
   user belongs to. Maximally decoupled from `auth-service`, but pushes real,
   repeated work onto every consumer and duplicates a mapping `auth-service` could
   trivially carry as a single opaque attribute instead.
2. **A single nullable `organizationId: string | null` column on `User`** — nullable
   at the schema level (to allow for the out-of-band `Admin` case above), but
   required as input on the public `POST /auth/register` endpoint's `RegisterDto`
   specifically, so there is no self-service path for an end user to register
   without one — mirrored as a claim in the issued JWT, and fully opaque to
   `auth-service`, which never interprets or validates what the string means beyond
   requiring it be present. A user belongs to at most one organization at a time.
   Small, adds one column, one DTO-level validation rule, and one claim, and
   directly satisfies `nawara-drive`'s deferred need without `auth-service` ever
   learning what a "school" is.
3. **A many-to-many `organizationMemberships` model** (a user can belong to multiple
   organizations, each with its own role) — more realistic long-term flexibility for
   future apps whose users might span multiple tenants, but a materially bigger v1:
   array-valued JWT claims, a membership join table, and membership-management
   endpoints, none of which any current consumer actually needs yet.
4. **Encode the scope directly into the `role` string itself**
   (e.g. `"school:abc123:admin"`) — avoids any schema change, but conflates two
   orthogonal concerns (identity-kind vs. tenant) into a single string that every
   consumer now has to parse wherever it reads `role`, and that has no natural
   "no organization" representation.

## Decision

We chose **Option 2**: add a nullable `organizationId: string | null` column on
`User`, included as a claim in the issued JWT. The column stays nullable at the
database-schema level, because the platform's `Admin` accounts genuinely have no
organization and are provisioned out-of-band, never through `/auth/register`. But
the public self-service `RegisterDto` for `POST /auth/register` declares
`organizationId` as a required field — there is no org-less self-registration path
for end users. `auth-service` treats the value itself as completely opaque — it does
not know or care whether it represents a driving school, a delivery depot, or
anything else — while still enforcing, at the API-input level, that every
self-registered end user supplies one. Consuming services remain solely responsible
for giving the value meaning and enforcing whatever scoping logic they need using it.

## Consequences

- Unblocks `nawara-drive`'s deferred `schoolId` requirement without introducing a
  domain leak into `nawara-core` — `auth-service` never has to know what a "school" is.
- Does not support a user belonging to more than one organization at a time. If that
  need arises for some future consumer, it should trigger a new ADR superseding this
  one (revisiting option 3 above) rather than a silent schema hack bolted onto this
  design.
- Every consumer must treat `organizationId` as opaque and never assume `auth-service`
  validates it against anything real (e.g. that the organization exists, or is in good
  standing) — that validation, where needed, is a separate concern (see ADR-0004 for
  the one case where `auth-service` does perform such a check, against
  `payment-service`, not against the organization id itself).
- Keeping the column nullable, while making it required on `RegisterDto`, means the
  "must have an organization" rule lives in `auth-service`'s input validation layer,
  not in the database schema. Any future write path that creates a `User` row must
  independently uphold this rule — a raw seed script or an internal admin-provisioning
  mechanism is the only place a null `organizationId` should ever legitimately
  originate, and that must stay a deliberate, out-of-band decision rather than an
  accidental one.
- If a future consumer needs a genuine, always-org-less self-registration flow for
  end users (not just the operator-provisioned `Admin` case), that is a new
  requirement this ADR does not anticipate and would warrant its own ADR rather than
  quietly relaxing the `RegisterDto` validation added here.

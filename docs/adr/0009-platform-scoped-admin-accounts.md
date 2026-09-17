# 0009. Platform-scoped Admin accounts (platformId, owner/operator tiers)

- **Status:** Proposed
- **Date:** 2026-09-16
- **Deciders:** Anwar (project owner)

## Context

Today `auth-service` has exactly one kind of Admin: a single, global `User` row with
`role: "admin"` and `organizationId: null` (per ADR-0001, "the only account type that
legitimately has no organization"), provisioned out-of-band by a mechanism that is itself
still an open question in both `docs/add/auth-service.md` and `docs/sdd/auth-service.md`.
(Note: ADR-0001 informally calls this existing Admin "the operator who issues organization
licenses" — that's a plain-English description of its job, unrelated to the formal
`adminTier: "operator"` value this ADR introduces below; today's single global Admin maps to
the new `"owner"` tier, not `"operator"`.)
Nothing distinguishes one Admin from another, and there is no notion anywhere in this repo
of the platform administering more than one consuming app's deployment.

The business need driving this decision: each "platform" — one consuming app's whole
deployment, e.g. all of `nawara-drive`, or later all of `daycare` — needs its own top-level
administrator who oversees the organizations under that platform specifically, not every
organization across every platform indiscriminately. That top-level administrator, in turn,
needs to delegate day-to-day admin work (handling licenses, reviewing cash payments per
ADR-0007, etc.) to staff, without handing every staff member a standing password to manage
and rotate.

Two things are missing to support this: a way to say *which platform* an Admin administers,
and a way to say *what kind* of Admin a given account is (a platform's top-level owner vs.
a delegated staff member), since both will share the single `role: "admin"` value and the
same login/authorization machinery.

## Options considered

1. **Reuse the existing `organizationId` claim for platform-scoping** — no new column, no
   new claim. Rejected: it conflates two different levels of scoping. `organizationId` (per
   ADR-0001) identifies one tenant/customer under a platform (e.g. one driving school); a
   platform is the whole product line that can contain many organizations. Overloading the
   same field for both would make it ambiguous, for any given `User` row, which level a
   populated `organizationId` actually refers to, and would break the existing invariant
   that every Admin's `organizationId` is always null.
2. **A separate `Platform`/`Admin` entity, distinct from `User`** — models the two admin
   tiers as their own table(s), decoupled from the generic end-user model. Rejected: it
   would duplicate JWT-issuing, credential-verification, and guard-based authorization
   machinery that `User` already has (per ADR-0002's token issuance and the existing
   `RolesGuard`). Every one of those admins still needs to log in and receive the same kind
   of access/refresh token pair as any other `User`; a parallel entity buys no real
   separation, only duplicated code paths to keep in sync.
3. **A new, orthogonal `platformId` scoping claim plus an `adminTier` field, both added to
   the existing `User` entity (chosen).** Mirrors ADR-0001's `organizationId` pattern
   exactly — a new, opaque, `auth-service`-never-interprets scoping claim — but at a
   different, non-overlapping level, and reuses all of `User`'s existing login/token/guard
   machinery for the two admin tiers.

## Decision

We chose **Option 3**. Concretely:

- `User` gains `platformId: string | null`. Exactly analogous to how ADR-0001 already
  scopes regular users via `organizationId`: `auth-service` never interprets its value —
  each consuming app decides what a "platform" means to it, the same way it decides what an
  "organization" means. `platformId` is deliberately orthogonal to `organizationId`: an
  Admin's `organizationId` stays always-null, exactly as ADR-0001 already describes, and a
  regular end user's `platformId` stays always-null. Enforced at the provisioning/
  registration layer, not a database constraint — the same pattern ADR-0001 already uses for
  `organizationId` being required on `RegisterDto` while staying nullable at the schema
  level: every `role: "admin"` row must have a non-null `platformId`; every non-admin row
  keeps `platformId` null.
- `User` gains `adminTier: "owner" | "operator" | null` — null for every non-admin row,
  required for every `role: "admin"` row. This is what distinguishes the platform's
  top-level administrator (`"owner"`) from a delegated staff account (`"operator"`) now that
  both share the single `role: "admin"` value.
- Operators are `User` rows too (`role: "admin"`, `adminTier: "operator"`) — **not** a new
  entity. This reuses the same login machinery, the same `role`/`platformId` claims, and the
  same guard-based authorization every other Admin already gets, rather than building a
  parallel account type for what is, structurally, just another kind of Admin.
- `User.email` becomes nullable — an operator registered by phone only (see ADR-0011) has no
  email. A new `User.phone: string | null` is added, unique when present.
  `User.passwordHash` also becomes nullable — operators never receive a password at all (see
  ADR-0011; they authenticate via a time-boxed login code instead). Exactly one of
  `{email, phone}` is required when an owner creates an operator, enforced at the
  operator-creation endpoint itself (defined in ADR-0011), not at the schema level — the same
  "business rule lives in the input-validation layer, not the database" pattern ADR-0001
  already established for `organizationId`.
- The issued JWT (per ADR-0002) gains two new, always-optional claims: `platformId: string
  | null` and `adminTier: "owner" | "operator" | null`. Both are nullable/absent for
  non-admin users, exactly like `organizationId` behaves today for non-scoped accounts. This
  keeps ADR-0002's stateless-verification property intact: any downstream check on admin
  tier (e.g. ADR-0010's `AdminTierGuard`) reads the claim directly, with no database
  round-trip.

This ADR **neither amends nor supersedes ADR-0001**. ADR-0001 only ever decided
`organizationId`; `platformId` is new and orthogonal to it. Every Admin still has
`organizationId = null` exactly as ADR-0001 already describes — this decision adds a second,
independent scoping dimension alongside it, it does not change or replace the first one.

## Consequences

- This is the foundational decision that ADR-0010 (owner secret-key login) and ADR-0011
  (operator time-boxed login code) both build directly on — both reference `platformId` and
  `adminTier` as already-existing claims, not something they introduce themselves.
- The existing open question in `docs/add/auth-service.md`/`docs/sdd/auth-service.md` — "the
  internal mechanism for provisioning Admin accounts out-of-band" — is not resolved by this
  ADR, but it is sharpened: whatever that mechanism turns out to be now also has to seed
  `platformId` for every Admin it creates, and, for an owner specifically, the initial secret
  key ADR-0010 introduces. This ADR only adds the fields; it does not design how the first
  owner of a new platform actually comes into existence.
- `User.email` and `User.passwordHash` becoming nullable is a widening of an existing schema
  invariant every current read path (e.g. login-by-email, `bcrypt.compare` against
  `passwordHash`) implicitly assumed held for every row. Those paths need to keep working
  unchanged for regular end users and owners (who still have both fields populated) while
  the new operator paths in ADR-0011 branch around their absence.
- Two admin tiers now share one `role: "admin"` value and are told apart only by
  `adminTier`. Any future authorization logic gating something to "the platform's top-level
  administrator only" must check `adminTier === "owner"` explicitly (e.g. via
  `AdminTierGuard`, introduced in ADR-0010) — `RolesGuard`'s existing generic `role` check
  alone is no longer sufficient to distinguish the two.
- Introduces the platform as a second, independent multi-tenancy-like scoping dimension
  alongside organizations. Consuming apps that operate only a single platform can simply
  seed one `platformId` and never think about it further; nothing in this design requires a
  consumer to actually operate multiple platforms.

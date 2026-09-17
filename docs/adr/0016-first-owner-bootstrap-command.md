# 0016. One-time bootstrap command for a platform's first owner account

- **Status:** Accepted
- **Date:** 2026-09-17
- **Deciders:** Anwar (project owner)

## Context

ADR-0009 introduced `platformId`/`adminTier` and, with them, the platform-scoped `owner`
tier; ADR-0010 then built an owner's permanent secret-key login and self-service rotation on
top of that tier. Both ADRs explicitly left one thing unresolved: how a platform's very
first `owner` row ever gets created in the first place. ADR-0001 already called this "an
internal/operator-only mechanism not exposed to the public API," without designing it;
ADR-0009's Consequences sharpen it further ("this ADR only adds the fields; it does not
design how the first owner of a new platform actually comes into existence"); ADR-0010's
Consequences sharpen it once more ("whatever that mechanism is, it must now also generate
and hand off an owner's very first secret key at creation time"). Both `docs/add/auth-service.md`
and `docs/sdd/auth-service.md` carry the same open question, essentially unchanged, across
three revisions.

This is deliberately scoped narrower than it might sound: it is not a "backfill" of some
pre-existing admin row. `auth-service` is still a bare Nest CLI scaffold today
(`apps/auth-service/src/` has only the default `app.controller.ts`/`app.service.ts`/
`app.module.ts`/`main.ts`) — there is no deployed database anywhere under the ADR-0009
schema, so there is nothing literally to backfill. The real, still-open problem is simply:
for any platform, at any point (today's first platform, or a future second platform), how
does its first owner account come to exist at all, given that every other admin-creation
path in this design (`POST /auth/admin/operators`, per ADR-0011) requires an already-existing
owner to call it? Something has to sit below the owner tier to create the first one — but
ADR-0009 defines only two admin tiers, and neither can authorize its own creation.

Explicitly out of scope for this decision, and called out again in Consequences: transferring
ownership of an existing platform to a different account, provisioning a second or standby
owner for the same platform, and recovering a platform whose sole owner has lost both their
password and their secret key. These are related but materially larger and distinct
questions — neither ADR-0009 nor ADR-0010 designs an ownership-transfer or second-owner
mechanism, and `docs/add/auth-service.md`/`docs/sdd/auth-service.md` already carry an open
question about that single-owner-per-platform assumption. This ADR does not resolve it, only
names it more concretely.

## Options considered

1. **A manual SQL runbook** — a documented set of `INSERT`/`UPDATE` statements an operator
   runs by hand against the database. Rejected: it cannot safely produce the credential
   material this row needs — bcrypt-hashing `passwordHash` correctly (or, worse, a SHA-256
   `secretKeyHash`) is not something a person should be typing by hand into a `psql` session
   — and it silently drifts out of sync with the `User` entity's actual shape as new columns
   get added over time (exactly the kind of schema-shape drift ADR-0009 itself introduced,
   e.g. `platformId`/`adminTier`/`contactVerifiedAt`). It is also unreviewable and untestable
   for what is, by construction, the highest-privilege account type in the system.
2. **A TypeORM data migration that seeds the row and prints a generated secret key to deploy
   output** — reuses existing migration tooling (per ADR-0003), no new entrypoint. Rejected
   on three independent grounds: migrations run unattended on every environment this repo has,
   including CI and ephemeral test databases, so a credential-bearing row would silently
   appear in places nobody is watching for one; printing a raw secret key to deploy-log output
   directly violates ADR-0010's "returned exactly once, never persisted in plaintext" property
   for that same key (a build log is a persistence medium in practice, even if an
   unintentional one); and migrations are not a safe shape for a credential-provisioning
   operation specifically — they are not meant to be safely re-run when you legitimately need
   to repeat an operation, and are not meant to silently re-mint credentials when you don't
   want them to, both of which a bootstrap operation needs to reason about carefully.
3. **A new authenticated HTTP endpoint**, e.g. `POST /auth/admin/platforms`, that creates a
   platform's first owner. Rejected: there is no principal above `owner` in this design that
   could legitimately call it — ADR-0009 defines exactly two admin tiers, and neither is meant
   to authorize the other's creation. Making this endpoint callable at all would require
   either inventing a third admin tier solely to gate a single, rare operation, or leaving it
   behind a permanent, unrotated, static bootstrap token sitting on an unauthenticated,
   unrate-limited HTTP surface — a large, permanent attack surface for what should be one of
   the rarest operations in the system.
4. **An idempotent, explicitly-invoked CLI command, run out-of-band by whoever operates the
   deployment (chosen).** No new HTTP surface, no unattended execution path, and it writes
   through the same application code every other write path uses.

## Decision

We chose **Option 4**. Concretely:

- New file `apps/auth-service/src/cli/bootstrap-owner.ts`, invoked via a new package script
  `npm run -w auth-service bootstrap:owner`. It boots the application with
  `NestFactory.createApplicationContext(AppModule)` — **no HTTP listener** — resolves
  `UsersService` from the resulting context, and exits. This is deliberately **not** a
  TypeORM migration: ADR-0003 establishes `apps/auth-service/src/migrations/` as the home for
  this service's schema migrations, and this ADR keeps that directory schema-only (structural
  DDL, never data, and never credential material) as a new rule of its own rather than
  attributing it to ADR-0003. This command is a one-off, human-invoked operational tool that
  happens to live in the same codebase, not a step in the automated migration-run path.
  Nothing in this design ever runs it automatically — no
  application startup hook, no docker-compose entrypoint, no CI step. It is only ever run
  because a human deliberately typed the command.
- It writes through **the real `UsersService`/`User` entity** — the same code path
  `POST /auth/register` and `POST /auth/admin/operators` already use to create rows — rather
  than any hand-written SQL. This means it inherits `UsersService`'s bcrypt cost factor (per
  the ADD/SDD's documented ~250ms-per-hash tuning) and any validation `UsersService.create`
  already performs, automatically, with no separate credential-handling code path to keep in
  sync.
- **It mints no secret key at all.** This is the single most important property of this
  decision, stated explicitly: the command seeds only an email+password credential, nothing
  more. The owner obtains their actual first secret key by logging in with that password
  through the **existing** `POST /auth/login` and then calling ADR-0010's already-designed
  `POST /auth/admin/secret-key/rotate`, which returns the raw key exactly once, exactly the
  same way every subsequent rotation does. This keeps the set of surfaces that ever emit a raw
  secret key at exactly one — the one ADR-0010 already built — rather than adding a second,
  bootstrap-specific code path that also has to get the "generate, return once, never persist
  in plaintext" property right.
- Three environment variables, **all required, fail-closed**: the command exits non-zero with
  no partial writes if any is missing or malformed, checked before any database write is
  attempted.
  - `BOOTSTRAP_OWNER_PLATFORM_ID` — **no default, no well-known value, and no
    auto-generation.** Per ADR-0001/ADR-0009, `auth-service` never invents or interprets a
    scoping id; it only ever stores and echoes one. The platform id is a concept owned by
    whoever operates "a platform" — i.e. the deployer running this command — not something
    `auth-service` is entitled to make up on its own, even for its own bootstrap tooling.
  - `BOOTSTRAP_OWNER_EMAIL` — the owner's login email. Also, going forward, the destination
    `notification-service` would use for ADR-0010's device-alert (`admin.secret_key_login_from_new_device`)
    and rotation (`admin.secret_key_rotated`) events once that owner starts using secret-key
    login.
  - `BOOTSTRAP_OWNER_PASSWORD` — bcrypt-hashed at `UsersService`'s existing cost factor, then
    discarded: never logged, never echoed back in any command output, never persisted in any
    form other than the resulting `passwordHash`.

  No separate boolean "confirm you want to do this" gate flag is added on top of these three.
  The three required env vars already function as the gate — nothing invokes this command
  automatically, so their mere presence already reflects a deliberate human decision to run
  it, and a fourth flag would add ceremony without adding safety.
- Row written on creation: `role: 'admin'`, `adminTier: 'owner'`, `platformId: <env>`,
  `organizationId: null` (unchanged, per ADR-0001 — an admin's `organizationId` is always
  null), `email: <env>`, `passwordHash: bcrypt(<env>)`, `phone: null`, `secretKeyHash: null`,
  `secretKeyIssuedAt: null`, `isActive: true`, `contactVerifiedAt: null` (per ADR-0015, this
  field is meaningful only for operators — always null for an owner), `trialEndsAt: null`
  (per `docs/sdd/auth-service.md`, trial periods only apply to self-registered end users).
  This satisfies
  ADR-0009's invariant that every `role: 'admin'` row has a non-null `platformId` and
  `adminTier` from the moment it's created — there is no intermediate state where the row
  exists but doesn't yet qualify as a fully-formed owner.
- `secretKeyHash: null` is therefore a **legitimate, expected owner state** — the window
  between bootstrap and that owner's first `POST /auth/admin/secret-key/rotate` call, which
  could in principle be arbitrarily long if an owner delays rotating. `POST
  /auth/admin/login/secret-key`'s lookup (ADR-0010) gains an explicit `AND secretKeyHash IS
  NOT NULL` predicate alongside its existing `adminTier = 'owner'` check — defense-in-depth
  against a null or empty request body somehow hashing to a value that matches a null/empty
  stored column, the same kind of belt-and-suspenders check ADR-0015 already added elsewhere
  in this design (e.g. `contactVerifiedAt IS NOT NULL` on the operator login-code path, which
  is true by construction but checked explicitly anyway).
- **Idempotency**, keyed on `platformId`, evaluated in this order every time the command runs:
  1. A row already exists with `role='admin' AND adminTier='owner' AND platformId=<env>` →
     log that owner's id and exit `0`. Nothing is changed. Re-running the command for a
     platform that already has its owner is always a safe no-op.
  2. No owner exists yet for that `platformId`, but **exactly one** row exists anywhere with
     `role='admin' AND adminTier IS NULL` → the **"adopt" path**. In one transaction, that row
     is upgraded in place: `platformId` and `adminTier='owner'` are set on it. Critically,
     `passwordHash` is set from the env var **only if the row's existing `passwordHash` is
     currently null** — an already-populated `passwordHash` on that row is never overwritten.
     Exit `0`.
  3. **More than one** `role='admin' AND adminTier IS NULL` row exists anywhere → refuse
     outright: print every matching row's id, change nothing, and exit non-zero. Which one
     should become the owner of which platform is genuinely ambiguous in this state, and this
     command does not guess.
  4. Otherwise (no owner for this `platformId`, and no `adminTier IS NULL` row to adopt) →
     create a fresh row with the full shape above.

  Path 2 exists purely so this same command remains meaningful if this repo's `User` schema
  is ever seeded some other way before this command exists in the deploy pipeline for a given
  environment — it is not expected to be the common path, since a fresh environment (see
  Consequences) has no rows of any kind. Paths 1 and 4 are the ones actually exercised in
  practice today.

  Stated plainly, because it matters for how this command is understood operationally: this
  ordering makes the command **safe to re-run** (idempotent by detection), but it is
  **deliberately not a credential-reset or recovery mechanism** — under every one of the four
  paths above, it can never overwrite an existing `passwordHash` or `secretKeyHash`. A
  platform whose owner credentials are already set keeps them, no matter how many times this
  command runs.
- **A necessary, non-optional login/refresh fix, decided as part of this same ADR, not
  deferred to a separate one:** `AuthService.login` and `AuthService.refresh` both currently
  call `OrganizationValidationService.checkLicense(organizationId)` (and, transitively,
  `checkSubscription`) unconditionally, per ADR-0005 — see `docs/sdd/auth-service.md`'s login
  and refresh flows. Both calls must now short-circuit to "not applicable, proceed" when the
  requesting user's `organizationId` is `null`, exactly mirroring how ADR-0006 already treats
  "no `UserSubscription` row exists" as a non-blocking case rather than a rejection. Without
  this fix, a bootstrapped owner — who has `organizationId: null` by construction, per
  ADR-0001 — could never successfully call `POST /auth/login` at all, since `checkLicense`
  would be asked to validate a license for organization id `null` and would have no sensible
  answer other than "not allowed." That would make the rest of this ADR dead on arrival: the
  owner's only path to a first secret key runs through password login followed by
  `POST /auth/admin/secret-key/rotate`, and that path requires login to succeed first.

  This gap is pre-existing in ADR-0005, not newly introduced here — ADR-0005 was written
  before ADR-0009 introduced the owner/operator tiers, and its Context section never
  considered a null-`organizationId` admin logging in through the ordinary email+password
  path at all (an `Admin` account provisioned "out-of-band" was, at the time, treated as
  someone else's problem). This ADR is what turns that pre-existing gap from theoretical to
  fatal, since it is the first design that actually depends on an `organizationId: null`
  account completing an ordinary login. Per this repo's ADR-immutability rule
  (`docs/adr/README.md`), ADR-0005's own text is not edited to add this case — the same move
  ADR-0014 already made for ADR-0011/ADR-0013 rather than editing their text directly — this
  ADR's Decision is the place this behavior gets specified and decided, and
  `docs/add/auth-service.md`/`docs/sdd/auth-service.md`, being living documents, are updated
  in place to describe it as current behavior (prose and sequence diagram both).

## Consequences

- Closes the open question already flagged, with increasing specificity, by ADR-0001,
  ADR-0009, and ADR-0010, and by the corresponding open-questions entries in
  `docs/add/auth-service.md` and `docs/sdd/auth-service.md` — those entries are updated to
  point here (see the ADD/SDD themselves for the updated wording) rather than restating the
  open question.
- Every admin-creating path in this design now has a named owner of ADR-0009's
  non-null-`platformId`/`adminTier` invariant: `POST /auth/admin/operators` for operators (per
  ADR-0011), and this command for owners. Any future third path that creates a `role: 'admin'`
  row must uphold that same invariant explicitly — it does not follow automatically just
  because the column exists.
- Owner password login is now genuinely **load-bearing**, not merely the recovery fallback
  ADR-0010 originally framed it as ("password login remains the recovery path an owner falls
  back to if their secret key is compromised"). It is now also the *only* route by which a
  freshly bootstrapped owner ever reaches their first secret key. ADR-0010's own text is left
  unmodified (per this repo's ADR-immutability rule) — this is a new fact about how that
  existing mechanism gets used in practice, not a change to what ADR-0010 decided.
- Re-running this command is always a safe no-op, but it is explicitly **not** a recovery
  path. A sole owner who loses both their password and their secret key cannot be rescued by
  this command under any of its four idempotency branches — it will never overwrite an
  existing `passwordHash`. This is the same single-owner-per-platform fragility
  `docs/add/auth-service.md` and `docs/sdd/auth-service.md` already flag as an open question,
  now with a concrete, nameable failure mode attached to it. **Open question, not resolved
  here:** what recovery path (if any) exists for
  that scenario. Ownership transfer to a different account and provisioning a second/standby
  owner for the same platform are likewise **explicitly out of scope** here (see Context) and
  remain open.
- A fresh dev, CI, or test database is the **normal** case for this design, not an edge case:
  since nothing in `auth-service` is implemented yet, every environment starts with zero
  `User` rows of any kind, and idempotency path 4 (fresh creation) is what actually runs the
  first time this command is invoked anywhere. An environment that simply never runs this
  command has zero owners and every owner-tier surface (secret-key login/rotation, operator
  management, platform calendar writes) stays permanently unreachable there — this is the
  correct fail-closed default, not a gap to fix.
- A typo in `BOOTSTRAP_OWNER_EMAIL` silently misdirects every future security-relevant event
  for that owner (ADR-0010's new-device alert and rotation notifications) to the wrong inbox,
  since owner email is never verified anywhere in this design — email verification is
  explicitly out of v1 scope per the ADD, and ADR-0015's contact-confirmation mechanism is
  operator-only, not applied to owners. This is accepted as a v1 exposure, in the same spirit
  as ADR-0010's already-accepted weak device fingerprint — not solved here.
- The very first `POST /auth/admin/secret-key/rotate` call an owner ever makes (turning their
  `secretKeyHash: null` into a real key) is indistinguishable, in the event stream, from any
  later rotation — `admin.secret_key_rotated` fires identically either way, per ADR-0010's
  existing event shape. A distinct "key issued for the first time" event was considered and
  not added: this happens at most once per platform, and a separate event for a once-per-
  platform occurrence wasn't judged worth the extra event-shape surface. Accepted, not solved.
- Introduces `auth-service`'s first non-HTTP entrypoint into the application's module graph —
  `AppModule` must be bootable via `NestFactory.createApplicationContext` without ever
  starting an HTTP listener. This is a small but real new requirement on how the module graph
  is wired (nothing in it can assume an HTTP request/response context exists). It also sets a
  reusable precedent: the ADD's already-noted future need for a refresh-token-pruning job (an
  operational task, not a request handler) can follow the same non-HTTP-entrypoint shape this
  command establishes, rather than inventing a new one.

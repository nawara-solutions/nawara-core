# 0017. Owner recovery via multi-owner support and CLI force-reset

- **Status:** Proposed
- **Date:** 2026-09-17
- **Deciders:** Anwar (project owner)

## Context

ADR-0009 introduced `platformId`/`adminTier` and built the entire owner/operator design on
top of an implicit single-owner-per-platform assumption: every platform-scoped `Admin` row is
either the one `adminTier: "owner"` account or one of its delegated `adminTier: "operator"`
accounts, and nothing in ADR-0009 (or anything built on it since) contemplates a platform
having more than one owner at a time. ADR-0010 then built the owner's permanent secret-key
login on top of that same single-owner assumption — the secret key is a 1:1 relationship on
`User` itself, and password login is framed there as "the recovery path an owner falls back
to if their secret key is compromised," implicitly assuming that owner is always able to reach
their own password.

ADR-0016 designed how a platform's first owner comes to exist at all (an idempotent, human-
invoked CLI bootstrap command), but its Context section explicitly scoped ownership transfer
and a second/standby owner out, and its Consequences section named the resulting gap directly,
in terms this ADR exists to close:

> Re-running this command is always a safe no-op, but it is explicitly **not** a recovery
> path. A sole owner who loses both their password and their secret key cannot be rescued by
> this command under any of its four idempotency branches — it will never overwrite an
> existing `passwordHash`. ... **Open question, not resolved here:** what recovery path (if
> any) exists for that scenario. Ownership transfer to a different account and provisioning a
> second/standby owner for the same platform are likewise **explicitly out of scope** here
> (see Context) and remain open.

Both `docs/add/auth-service.md` and `docs/sdd/auth-service.md` carry the same open-questions
entry, essentially unchanged since ADR-0009, pointing at the same gap: "the single-owner-per-
platform assumption: nothing in ADR-0009/ADR-0010 designs an ownership-transfer mechanism"
(ADD wording), "no ownership-transfer mechanism is designed if a platform's owner needs to be
replaced" (SDD wording). ADR-0016 sharpened that pre-existing open question into a concrete,
nameable failure mode — total, permanent lockout of a platform's admin surface — but
deliberately did not resolve it.

Concretely, three related problems sit inside this one gap, and none of them has a design yet:

1. **Catastrophic sole-owner credential loss.** If a platform's only owner loses both their
   password and their secret key (e.g. a lost password manager plus a lost/reset device), every
   owner-only surface in this design — secret-key rotation, operator creation and management,
   platform calendar writes — becomes permanently unreachable for that platform. There is no
   account above `owner` that could intervene, per ADR-0009's own two-tier model, and ADR-0016's
   bootstrap command is explicitly not a credential-reset mechanism (it "can never overwrite an
   existing `passwordHash` or `secretKeyHash`").
2. **Ownership transfer.** A platform's owner may need to hand off control entirely — e.g.
   the person leaves the organization operating that platform. Nothing in ADR-0009 or ADR-0010
   designs how a different account becomes the new owner of an existing platform.
3. **A second or standby owner.** A platform operating at any real scale has an obvious
   business need for more than one person able to act as owner (redundancy, coverage, or simply
   more than one senior operator), independent of the recovery scenario above. ADR-0009 never
   designed for this either — its data model doesn't prohibit a second `adminTier: "owner"` row
   for the same `platformId`, but nothing creates one.

This ADR resolves all three, without amending or superseding ADR-0009, ADR-0010, or ADR-0016 —
per this repo's ADR-immutability rule, their text stays exactly as accepted; this ADR documents
the resolution as new decisions layered on top.

## Options considered

1. **Email-based self-service password/key reset** — the conventional "forgot password" flow:
   an owner requests a reset, a link or code is emailed to their registered address, and they
   set a new password from there. Rejected: owner email is never verified anywhere in this
   design. Email verification is one of `docs/add/auth-service.md`'s five features explicitly
   deferred past v1, and ADR-0015's contact-confirmation mechanism — the only contact-proof
   machinery this design has — is operator-only, never applied to owners (an owner's email is
   whatever was typed into `BOOTSTRAP_OWNER_EMAIL` or a later `POST /auth/admin/owners` call,
   with no proof anyone ever received mail at that address). Building a reset flow on top of an
   address that was never confirmed to be reachable by the account holder means anyone who can
   intercept, guess, or simply claim that address — a typo'd domain, an inbox the real owner no
   longer controls — gets to reset the credential for a platform's highest-privilege account.
   That is a worse security posture than having no self-service recovery path at all for
   exactly the account type where a false recovery is most damaging.
2. **Self-service recovery codes issued at bootstrap/rotation time** — analogous to TOTP backup
   codes: a batch of one-time-use codes generated and shown once (alongside, or instead of, the
   secret key), any one of which could later be redeemed to reset the password. Rejected on two
   independent grounds. First, cost: it introduces an entirely new credential type — generation,
   hashing, storage, display-once semantics matching the property ADR-0010 already established
   for the secret key, and a new verification endpoint — for what is meant to be a deliberately
   rare, break-glass operation; that's real added attack surface (a new class of long-lived,
   offline-guessable secrets sitting in whatever the owner used to record them) and
   implementation cost for low expected usage. Second, and more decisively, it only ever solves
   problem 1 above (catastrophic credential loss) — it does nothing for ownership transfer or a
   second owner, both of which are needed regardless of whether recovery codes exist. Since
   multi-owner support has to be built either way, recovery codes would be pure incremental
   complexity layered on top of a solution that already covers the credential-loss case as a
   side effect (see Decision), not a replacement for it.
3. **Multi-owner support plus a CLI-based operational recovery path for the catastrophic case
   (chosen — both together, not either/or, because they solve different failure modes).**
   In-band owner creation (mirroring ADR-0011's operator creation) resolves ownership transfer
   and the second-owner need directly, and as a byproduct gives an owner a real, low-cost
   mitigation against ever hitting the catastrophic single-point-of-failure case in the first
   place. A separate, narrow, ops-only CLI extension handles the one scenario multi-owner
   support cannot retroactively fix: a platform that is *already* down to one owner who has
   *already* lost both credentials, with no second owner to fall back on.

## Decision

We chose **Option 3**. Concretely:

### In-band owner creation — `POST /auth/admin/owners`

A new endpoint, Bearer-authenticated, gated by the existing `AdminTierGuard` to
`adminTier: 'owner'` only — exactly the same guard ADR-0010 already built, no new
authorization primitive. This mirrors `POST /auth/admin/operators` (ADR-0011) in almost every
respect, with one deliberate difference driven by how the two tiers authenticate: an operator
never holds a password (ADR-0011), but an owner's whole identity model is built around
password-or-secret-key login (ADR-0010), so a newly created owner needs a password from the
moment they exist, not a code-based credential.

- Body: `{email?, phone?, password}` — exactly one of `email`/`phone` is required (`400`
  otherwise), `409` on a duplicate email/phone, identical to the validation
  `POST /auth/admin/operators` already enforces for its own `{email?, phone?}` pair. `password`
  is always required (`400` if missing) — unlike an operator, a new owner cannot be created
  password-less, since there is no operator-style code login for owners and this is the
  in-band route's only way to hand the new owner a usable first credential.
- `platformId` is taken from the **caller's own** JWT claim, never accepted in the request
  body. This is the same defense-in-depth pattern ADR-0007 established for `organizationId` on
  `POST /payment/charges/cash` and ADR-0011 already applies to operator creation: "never trust
  a body-supplied tenant/scope id when the caller's own claim already says which scope they act
  for." Without this, a compromised or malicious owner session on platform A could otherwise
  attempt to plant a new owner on platform B by simply supplying a different `platformId` in
  the body — the JWT-derived value closes that off structurally, not by validation logic that
  could be forgotten on some future endpoint.
- Row written on creation: `role: 'admin'`, `adminTier: 'owner'`, `platformId` (from the
  caller's claim), `passwordHash: bcrypt(password)` (the same `UsersService`-owned bcrypt cost
  factor every other password goes through), `secretKeyHash: null`, `secretKeyIssuedAt: null`,
  `organizationId: null` (unchanged, per ADR-0001 — an admin's `organizationId` is always
  null), `email`/`phone` as given, `contactVerifiedAt: null` (per ADR-0015, meaningful only for
  operators — always null for an owner, exactly as ADR-0016's bootstrapped owner also has it),
  `isActive: true`.
- **The new owner obtains their own first secret key exactly the way a bootstrapped owner
  does, per ADR-0016**: log in via the existing `POST /auth/login` with the password just set,
  then call the existing `POST /auth/admin/secret-key/rotate`. This decision deliberately reuses
  that entire flow rather than inventing a second credential-issuance path for a
  `POST /auth/admin/owners`-created owner — for the identical reason ADR-0016 gave for keeping
  its own bootstrap command from minting a key directly: it keeps the set of surfaces that ever
  emit a raw secret key at exactly one (`POST /auth/admin/secret-key/rotate`), rather than
  adding a second code path that also has to get the "generate, return once, never persist in
  plaintext" property right independently. `secretKeyHash: null` is therefore the same
  legitimate, expected state ADR-0016 already established for a freshly bootstrapped owner —
  this is not a new state this ADR introduces, only a second creation path that also lands in
  it.
- Publishes a new event, `admin.owner_registered = {ownerId, platformId, createdByOwnerId,
  channel: "email"|"phone", timestamp}`, mirroring `admin.operator_registered`'s shape
  (ADR-0011) field-for-field except `ownerId`/`createdByOwnerId` in place of
  `operatorId`/`ownerId` — letting `notification-service` send a welcome/confirmation message
  the same way it already can for a new operator, with no new event-shape convention
  introduced.

### Deactivation, activation, and the "last owner" invariant

Two new endpoints, `POST /auth/admin/owners/:id/deactivate` and
`POST /auth/admin/owners/:id/activate`, both Bearer-authenticated, `adminTier: 'owner'` only
(`AdminTierGuard`). Every `:id` lookup is scoped as
`WHERE id=:id AND adminTier='owner' AND platformId=<caller's own JWT claim>` → **`404`, never
`403`**, on any mismatch (unknown id, an id that belongs to a different platform, or an id that
isn't an owner at all — e.g. an operator's id). This is the identical collapsed-404 pattern
ADR-0012 already established for its own `:id`-scoped operator-management lookups, applied here
for the same reason: it avoids confirming, to a caller probing ids, that a given id even exists
on this platform.

Deactivating an owner:

- Sets `isActive: false`.
- Revokes all of that owner's refresh tokens, via the existing
  `RefreshTokenService.revokeAllForUser(id)` ADR-0012 already introduced for blocking an
  operator — the same session-termination machinery, reused rather than duplicated. The same
  accepted limitation ADR-0012 already documents applies unchanged here: this caps the
  deactivated owner's remaining access to at most their current access token's own short
  remaining TTL, since a stateless JWT cannot be force-expired early.
- **Is rejected outright if it would leave the platform with zero `isActive: true` owners.**
  This is a hard invariant, not a soft warning: a platform can never be fully de-owned through
  this endpoint. The rejection uses a specific, distinguishable error shape rather than a
  generic `409` — `409 {reason: "last_owner", message: "Cannot deactivate the platform's last
  active owner. Add another owner first."}` — deliberately informative here, for the same
  reason ADR-0013's `session_ceiling_reached` response is deliberately informative rather than
  generic: the caller is already a fully authenticated owner of this exact platform, acting on
  their own platform's data, so naming the precise reason leaks nothing to anyone who couldn't
  already see it, and it tells the caller exactly what corrective action to take (create a
  second owner first) rather than leaving them to guess why a plausible-looking request failed.

This safeguard is also what gives ownership *transfer* almost for free, without a dedicated
"transfer" endpoint: add a new owner via `POST /auth/admin/owners`, then deactivate the old one
via this endpoint. The "last owner" check only blocks the deactivation until a second owner
exists — once one does, deactivating the original owner is a normal, permitted call. No
separate transfer mechanism is designed, or needed, on top of these two endpoints.

**Concurrency note, stated as a requirement, not left implicit:** the "last owner" check must
not be implemented as a naive read-then-write in application code (e.g. "count active owners,
if count > 1 then proceed to set `isActive = false`"). Two simultaneous deactivation requests
for a platform's last two owners could both read "2 active owners" before either write lands,
and both then proceed to deactivate, leaving zero. This must be enforced with a proper atomic
check — a transaction with a row lock on the platform's owner rows (e.g.
`SELECT ... FOR UPDATE` scoped to `platformId` before the count check and the write), or a
single conditional query that only succeeds if the resulting count would stay above zero (e.g.
an `UPDATE ... WHERE id = :id AND (SELECT COUNT(*) FROM "user" WHERE platformId = :platformId
AND adminTier = 'owner' AND isActive = true) > 1`) — not a check-then-act pair of separate
database round-trips.

### CLI force-reset mode on `bootstrap-owner.ts`

For the one scenario multi-owner support cannot retroactively fix — a platform already down to
one owner who has already lost both credentials, with no second owner to add via the endpoint
above — a new, explicitly opt-in mode on the **existing** `bootstrap-owner.ts` script from
ADR-0016. This is deliberately not a new script: it extends the one operational tool ADR-0016
already established for exactly this class of rare, high-privilege, ops-invoked operation,
rather than adding a second entrypoint with its own trust model to reason about.

- A new environment variable, `BOOTSTRAP_OWNER_FORCE_RESET=true`. Unset (the default), the
  command behaves exactly as ADR-0016 describes, with its stated invariant fully intact: it
  "can never overwrite an existing `passwordHash` or `secretKeyHash`." Set, and only then, the
  command is deliberately permitted to override that invariant for one specific, identified
  owner.
- When `BOOTSTRAP_OWNER_FORCE_RESET=true`, the command takes a different path than any of
  ADR-0016's four idempotency branches: it identifies the target owner by
  `BOOTSTRAP_OWNER_RESET_EMAIL` combined with the existing `BOOTSTRAP_OWNER_PLATFORM_ID` — not
  by "adopt" or "create" logic, since the target row is known to already exist. No matching
  `role='admin' AND adminTier='owner' AND platformId=<BOOTSTRAP_OWNER_PLATFORM_ID> AND
  email=<BOOTSTRAP_OWNER_RESET_EMAIL>` row → exit non-zero, no writes, same fail-closed
  posture ADR-0016 established for its own required-env-var checks.
- On a match, the command overwrites **only** `passwordHash`, from `BOOTSTRAP_OWNER_PASSWORD`
  (bcrypt-hashed at `UsersService`'s existing cost factor, same as every other password write in
  this design). `secretKeyHash`/`secretKeyIssuedAt` are deliberately left untouched. This is
  fine either way, stated explicitly: if the owner still has their old secret key, it keeps
  working unchanged after this reset (a partial credential loss — password only — doesn't need
  to cost them their still-valid key); if they don't, they reach a working key the same way
  every other owner does — password login followed by `POST /auth/admin/secret-key/rotate` —
  which is already the established path this whole design relies on, not a special case invented
  for recovery.
- The command also revokes all of that owner's existing refresh tokens (via the same
  `RefreshTokenService.revokeAllForUser` used elsewhere in this ADR and in ADR-0012), as a
  defensive measure taken unconditionally, not only when there's specific evidence of
  compromise. The reasoning: "owner lost both credentials" and "an attacker compromised the
  account and changed both credentials to lock the real owner out" are indistinguishable from
  the command's point of view — both present as "the legitimate owner can no longer log in" —
  so this treats the two cases identically and ends all existing sessions defensively, exactly
  the same posture ADR-0010 already takes for a suspicious secret-key rotation.
- Invoking this mode requires direct server/deploy access — it is not, and per this decision
  must never become, a self-service or HTTP-reachable path. This is the same trust model
  ADR-0016 already accepted for first-owner bootstrap, and for the identical reason ADR-0016
  gave for rejecting an HTTP bootstrap endpoint (see ADR-0016's Options considered, option 3):
  a permanent, unauthenticated or static-token-gated HTTP surface for a rare, high-privilege
  operation is a worse, larger, standing attack surface than requiring whoever operates the
  deployment to have ops access and run a command. That tradeoff doesn't change just because
  this particular invocation is a reset rather than a first creation.

## Consequences

- Closes the gap ADR-0016's own Consequences named explicitly (quoted in Context above), and
  resolves the open-questions entry `docs/add/auth-service.md` and `docs/sdd/auth-service.md`
  have carried, essentially unchanged, since ADR-0009 — both are updated in place to point here
  (see the ADD/SDD themselves for the exact updated wording) rather than restating the open
  question.
- Every `role: 'admin' AND adminTier: 'owner'` row now has two named, deliberate creation
  paths, exactly the way ADR-0016 named the invariant-upholder for every admin-creating path
  that existed at the time: ADR-0016's CLI bootstrap command, for a platform's very first owner
  (still the only path capable of creating an owner where none exists yet, since no in-band
  caller can exist before one does), and this ADR's `POST /auth/admin/owners`, for every
  subsequent owner on an already-owned platform. Any future third path that creates a
  `role: 'admin' AND adminTier: 'owner'` row must uphold the same non-null-`platformId`/
  `adminTier` invariant ADR-0009 established and ADR-0016 already named — it does not follow
  automatically just because the columns exist.
- **Residual risk this ADR does not solve, stated plainly**: a platform's very first owner —
  freshly bootstrapped via ADR-0016, before they've exercised `POST /auth/admin/owners` even
  once — has exactly the same catastrophic lockout exposure ADR-0016 originally described,
  right up until they act. This ADR gives that owner the *means* to eliminate the exposure
  (add a second owner immediately after bootstrapping), but the system does not enforce, default
  to, or nag toward that action anywhere — there is no "you have only one owner" warning, no
  onboarding step that requires it, nothing that makes a single-owner platform anything other
  than a fully valid, silently-fragile steady state. "Add a second owner immediately after
  bootstrapping" is, as of this ADR, an operational recommendation this design should surface —
  e.g. as operator-facing guidance or onboarding documentation for whoever runs
  `bootstrap-owner.ts` — not something this design enforces or defaults to. Whether to change
  that (e.g. a dashboard warning, or refusing some owner-only action until a second owner
  exists) is new, undesigned scope, not decided here.
- **The CLI force-reset path is unauditable by the app itself**, stated as an accepted gap in
  the security-event trail, in the same spirit as ADR-0013's already-accepted observability
  tradeoff for post-ceiling token replay: because force-reset bypasses the API entirely (it
  writes directly through `UsersService` from a CLI process with no authenticated caller, no
  HTTP request, and no JWT claim to attribute the action to), no `admin.*` event is published
  for it, unlike every other credential-affecting action in this design
  (`admin.secret_key_rotated`, `admin.operator_blocked`, and this ADR's own
  `admin.owner_registered`). Whoever operates the deployment is trusted to keep their own
  external record of when and why this mode was invoked — `auth-service` has, and can have, no
  visibility into it. This mirrors the trust model ADR-0016 already accepted for the ordinary
  bootstrap path (also un-eventable, for the same structural reason), extended here to the
  reset path.
- `POST /auth/admin/owners` inherits the same already-accepted, still-undesigned rate-limiting
  gap every other admin-creating endpoint in this design has (per `docs/add/auth-service.md`'s
  non-functional constraints, most recently widened by ADR-0012's owner-only
  `AdminOperatorController` surface) — not a new gap, a wider surface exposed to the existing
  one.
- The "last owner" safeguard's atomicity requirement (see Decision) is a concrete new
  implementation constraint on whatever ORM/transaction pattern `OperatorManagementService`'s
  sibling owner-management service ends up using — a naive read-then-write would silently
  reintroduce the exact failure mode this ADR exists to prevent (a platform left with zero
  active owners), so this needs to be treated as a correctness requirement at implementation
  time, not an optional hardening pass.
- `admin.owner_registered`'s inline shape carries no contact info (`channel` only, no
  `destination`), unlike `admin.operator_registered`'s established shape it otherwise mirrors —
  this is intentional and not an inconsistency to fix: `notification-service` already has no
  independent way to resolve a `userId` to a contact address (per ADR-0010/ADR-0011's own
  "why these carry contact info inline" reasoning), but an owner-created-owner notification is
  not the same kind of time-critical, sole-means-of-access delivery a login/confirmation code
  is — carrying `destination` here was not judged necessary to add now; it can be revisited if
  a concrete notification need for it emerges.

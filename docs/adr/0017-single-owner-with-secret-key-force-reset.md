# 0017. Single owner per platform, permanently, with a CLI secret-key force-reset tool

- **Status:** Proposed
- **Date:** 2026-09-18
- **Deciders:** Anwar (project owner)

## Context

ADR-0009 introduced `platformId`/`adminTier` and built the entire owner/operator design on
top of an implicit single-owner-per-platform assumption: every platform-scoped `Admin` row is
either the one `adminTier: "owner"` account or one of its delegated `adminTier: "operator"`
accounts, and nothing in ADR-0009's own language ever contemplates a platform having more than
one owner at a time ("a platform's top-level administrator," singular, throughout). ADR-0010
then built the owner's permanent secret-key login on top of that same single-owner assumption —
the secret key is a 1:1 relationship on `User` itself, and password login is framed there as
"the recovery path an owner falls back to if their secret key is compromised," implicitly
assuming that owner, and only that owner, is always able to reach their own password.

ADR-0016 designed how a platform's first owner comes to exist at all (an idempotent, human-
invoked CLI bootstrap command), but its Context section explicitly scoped ownership transfer
and a second/standby owner out, and its Consequences section named the resulting gap directly,
in terms this ADR exists to address:

> Re-running this command is always a safe no-op, but it is explicitly **not** a recovery
> path. A sole owner who loses both their password and their secret key cannot be rescued by
> this command under any of its four idempotency branches — it will never overwrite an
> existing `passwordHash`. ... **Open question, not resolved here:** what recovery path (if
> any) exists for that scenario. Ownership transfer to a different account and provisioning a
> second/standby owner for the same platform are likewise **explicitly out of scope** here
> (see Context) and remain open.

An earlier draft of this ADR answered that open question by adding multi-owner support: an
in-band `POST /auth/admin/owners` endpoint, a deactivate/activate pair, and a hard "never leave
a platform with zero active owners" invariant, on the theory that letting a platform have more
than one owner would resolve ownership transfer, give a platform a standing second owner for
redundancy, and, as a side effect, mitigate the catastrophic sole-owner-lockout case. That
draft was never accepted (this ADR's status has stayed `Proposed` throughout), and per this
repo's ADR-immutability rule (`docs/adr/README.md`) a `Proposed` ADR is rewritten in place
rather than superseded — this revision replaces that decision rather than building on it.

Separately, and still unresolved by anything above: ADR-0010 gives an owner two signals that
their secret key may have leaked — `admin.secret_key_login_from_new_device` (an unrecognized
device logged in with the key) and `admin.secret_key_rotated` (the key was rotated, possibly
not by the real owner). An owner who receives either alert, and who can still log in with their
password (i.e. this is not the total-lockout scenario above), already has an in-band way to
invalidate the possibly-compromised key: `POST /auth/admin/secret-key/rotate`. But that path
requires trusting the running API to correctly authenticate the owner and process the rotation
— exactly the kind of trust an owner reacting to a *suspected compromise* may not want to place
in the live service, versus acting directly against the database through an operator-controlled
tool independent of whatever is happening on the API surface. Nothing in this design today
gives an owner, or whoever operates the deployment on the owner's behalf, that alternative,
out-of-band lever.

Concretely, two separate problems sit inside this gap:

1. **Whether a platform should ever have more than one owner at all.** ADR-0009's data model
   doesn't prohibit a second `adminTier: "owner"` row for the same `platformId`, but nothing
   in this design was ever built assuming one exists, and the question of whether to allow one
   has not, until now, been explicitly decided either way.
2. **An out-of-band way to invalidate a possibly-compromised secret key**, for an owner who
   still has password access and has received one of ADR-0010's alerts, that doesn't depend on
   trusting the live API the way `POST /auth/admin/secret-key/rotate` does.

This ADR resolves both, without amending or superseding ADR-0009, ADR-0010, or ADR-0016 — per
this repo's ADR-immutability rule, their text stays exactly as accepted; this ADR documents the
resolution as new decisions layered on top.

## Options considered

1. **Multi-owner support (the previous draft of this decision)** — an in-band
   `POST /auth/admin/owners` creation endpoint, a deactivate/activate pair, and a hard "last
   owner" invariant. This resolves ownership transfer and a standing second owner directly, and
   gives an owner a self-service way to eliminate the sole-owner lockout risk before it ever
   happens (add a second owner immediately). Rejected on reflection: it permanently grows the
   owner tier's surface area — a new endpoint group, a new hard invariant that has to be
   enforced atomically under concurrency, a new `admin.owner_registered` event, and an ongoing
   design question of whether/when a platform should actually have more than one — for a
   capability this project has decided it does not want. The owner tier is meant to model one
   platform's one top-level administrator; "one or more, defaulting to one" is a materially
   different, larger model than "exactly one," and this project chooses the latter, permanently.
2. **Do nothing beyond what ADR-0010/ADR-0016 already provide** — leave
   `POST /auth/admin/secret-key/rotate` as the only way to invalidate a secret key, and leave
   the sole-owner-lockout gap exactly as ADR-0016 stated it, unaddressed. Rejected as
   incomplete: it leaves an owner who suspects their key is compromised with no way to act
   except through the same live API surface the compromise might involve, which is precisely
   the scenario where an operator wants an independent, out-of-band lever — the same reasoning
   ADR-0016 already used to justify a CLI tool over an HTTP-only path for bootstrap in the first
   place (see ADR-0016's Options considered, option 3).
3. **Strict single owner per platform, permanent, plus a narrow, ops-only CLI tool that
   force-resets only the secret key (chosen).** Keeps the owner tier exactly as simple as
   ADR-0009 always implicitly modeled it, and adds the one piece of tooling actually motivated
   by a concrete, named scenario (a suspected key leak, with the owner still holding their
   password) rather than building a general-purpose multi-owner capability to indirectly cover
   it. Deliberately does **not** attempt to solve ownership transfer or the sole-owner-lockout
   case — both are named and accepted as open/out of scope below, not silently dropped.

## Decision

We chose **Option 3**. Concretely:

### Single owner per platform — permanent, not an interim state

A platform has, and will only ever have, exactly one `role: 'admin' AND adminTier: 'owner'`
row, created once via ADR-0016's `bootstrap-owner.ts`. There is no in-band way to create,
deactivate, or replace an owner, and none is planned. Concretely, this ADR removes, from the
design (nothing under `apps/` ever implemented any of it, so there is no code to remove):

- The in-band `POST /auth/admin/owners` endpoint.
- The `POST /auth/admin/owners/:id/deactivate` and `.../activate` endpoints.
- The "never leave a platform with zero active owners" invariant, and the atomic-check
  requirement that existed solely to enforce it.
- The `admin.owner_registered` event.

This is not a narrowing of scope pending a future revisit — it is this ADR's central,
deliberate decision, stated plainly: **single-owner-per-platform is now a permanent
architectural invariant**, not an unresolved question or a temporary simplification. It was
always the implicit assumption underlying ADR-0009's "platform's top-level administrator"
framing and ADR-0010's secret-key design; this ADR is what makes that assumption explicit and
final, closing the open question `docs/add/auth-service.md`/`docs/sdd/auth-service.md` have
carried since ADR-0009 by resolving it as "no ownership-transfer or second-owner mechanism will
be built," not by building one. ADR-0016's own text needs no change: it never assumed more than
one owner, and this ADR does not add anything for it to account for — `bootstrap-owner.ts`
remains exactly the single, idempotent, create-only tool ADR-0016 designed.

### CLI tool: force-resetting a possibly-compromised secret key

For the scenario named in Context — an owner who receives one of ADR-0010's alerts
(`admin.secret_key_login_from_new_device` or `admin.secret_key_rotated`), still has password
access, and wants to invalidate the secret key out-of-band rather than through the live
`POST /auth/admin/secret-key/rotate` endpoint — a new, standalone CLI tool.

**Naming: a new script, not a new mode on `bootstrap-owner.ts`.** This is a real design choice,
made deliberately rather than defaulted:

- `bootstrap-owner.ts` (ADR-0016) exists to answer one question: "does this platform's one
  owner row exist yet, and if not, create it." ADR-0016 states explicitly that this command is
  "deliberately not a credential-reset mechanism" — that was true of the command as originally
  designed, and this ADR keeps it true, rather than reopening it. The previous draft of this
  ADR added a second, reset-flavored mode to that same script (`BOOTSTRAP_OWNER_FORCE_RESET`);
  this revision does not carry that mode forward at all, in any form, on `bootstrap-owner.ts`.
- The operation this ADR actually needs — replacing an *existing* owner's secret key — is
  conceptually distinct from anything `bootstrap-owner.ts` does: it never creates a `User` row,
  never touches `passwordHash`, and is triggered by an entirely different scenario (the owner
  still has full account access and is reacting to a suspected leak) than bootstrap's own
  "does the owner row exist" question. Folding a third, differently-scoped, differently-gated
  destructive branch into one script — on top of the create-only behavior ADR-0016 already
  established — increases the chance an operator invokes the wrong mode against a
  highest-privilege account, with no in-app safeguard beyond which environment variables happen
  to be set.
- A separate, purpose-named script makes the operation legible from its filename alone, and
  keeps its own environment variables and failure branches from ever being confused with
  bootstrap's.
- The counter-argument — reuse `bootstrap-owner.ts`'s existing `NestFactory.
  createApplicationContext` boilerplate and its established "extend rather than add a new
  entrypoint" precedent — is weaker here than it looks: that precedent was set by the
  password-reset mode this revision removes entirely. With that mode gone, there is no existing
  second mode on `bootstrap-owner.ts` to extend; adding one back, for a differently-scoped
  operation, would be establishing a new precedent, not following an existing one.

Decision: a new file, `apps/auth-service/src/cli/reset-owner-secret-key.ts`, invoked via a new
package script `npm run -w auth-service reset:owner-secret-key`. It boots the application the
same way `bootstrap-owner.ts` does — `NestFactory.createApplicationContext(AppModule)`, no HTTP
listener — resolves the same secret-key-issuing service ADR-0010 already introduced (whatever
this service's DI-resolved class is named for secret-key issuance, e.g. `SecretKeyService` per
the SDD's class diagram) from the resulting context, and exits.

- **Identification, reusing an existing env var:** `BOOTSTRAP_OWNER_PLATFORM_ID` (the same
  variable ADR-0016 already defined, not a new one) plus a new `OWNER_SECRET_KEY_RESET_EMAIL`
  — the owner's email. Since exactly one owner ever exists per platform (per the decision
  above), this pair unambiguously identifies the target row: `WHERE role = 'admin' AND
  adminTier = 'owner' AND platformId = <BOOTSTRAP_OWNER_PLATFORM_ID> AND email =
  <OWNER_SECRET_KEY_RESET_EMAIL>`. No matching row → exit non-zero, no writes — the same
  fail-closed posture ADR-0016 established for its own required-env-var checks, checked before
  any database write is attempted.
- **Action, atomic, in one write:** generate a new, high-entropy raw secret key, hash it with
  **SHA-256, not bcrypt** — the identical reasoning ADR-0010 already gives for `secretKeyHash`:
  a secret key is a high-entropy, server-generated value, not a low-entropy, human-chosen
  password, so it doesn't need bcrypt's deliberate slowness to resist brute force — and
  overwrite `secretKeyHash`/`secretKeyIssuedAt` on the matched row. There is no separate
  "revoke" step before the write: overwriting both columns atomically already revokes the old
  key exactly the way `POST /auth/admin/secret-key/rotate` already does for a self-service
  rotation; this tool performs the identical database-level operation, only through a CLI
  invocation instead of an authenticated HTTP call.
- **Also revokes all of that owner's existing refresh tokens, unconditionally**, via the
  existing `RefreshTokenService.revokeAllForUser(ownerId)`. This reuses, unchanged, the exact
  reasoning ADR-0010 already applies to a suspicious rotation and the reasoning the previous
  draft of this ADR gave for its own (now-removed) force-reset mode: "the owner lost the key"
  and "an attacker has the key and is actively using it" are indistinguishable from this tool's
  point of view — both look identical from outside the account — so both are treated the same
  way, ending every existing session rather than trying to guess which case applies.
- **Prints the new raw key exactly once**, in the command's own output, mirroring ADR-0010's
  own property for `POST /auth/admin/secret-key/rotate` field-for-field: "returns the new raw
  key exactly once, never persisted in plaintext." The plaintext key is never logged anywhere
  else, and is never written to any column other than the SHA-256 hash it's immediately reduced
  to.
- **Writes through real application code, never raw SQL** — the same secret-key-issuing service
  `POST /auth/admin/secret-key/rotate` already uses, not a hand-written `UPDATE` statement. This
  reuses ADR-0016's own rejection of a manual SQL runbook (its Options considered, option 1)
  for the identical reason: hashing correctly by hand in a `psql` session is not something a
  person should do for the platform's highest-privilege credential, it silently drifts from the
  entity's real shape as columns change over time, and it is unreviewable and untestable.
- **No HTTP surface, requires direct server/deploy access, never auto-invoked** — no startup
  hook, no docker-compose entrypoint, no CI step. This is the identical trust model ADR-0016
  already accepted for `bootstrap-owner.ts`, for the identical reason ADR-0016 gave for
  rejecting an HTTP bootstrap endpoint (its Options considered, option 3): a permanent,
  unauthenticated or static-token-gated HTTP surface for a rare, high-privilege operation is a
  worse, larger, standing attack surface than requiring ops access and a deliberately-typed
  command.
- **No `admin.*` event is published for this action.** Because it bypasses the API/JWT
  entirely — a CLI process, no HTTP request, no authenticated caller — there is no principal to
  attribute an event to. This is the same accepted gap the tool it replaces already named for
  itself, and the same one ADR-0016 already accepts for the ordinary bootstrap path. Whoever
  operates the deployment is trusted to keep their own external record of when and why this
  tool was run; `auth-service` has, and can have, no visibility into it.
- **Idempotency is deliberately different from `bootstrap-owner.ts`'s.** Bootstrap is
  create-if-missing and safe to re-run as a no-op once the owner exists. This tool is a reset,
  not a create: on every successful match it always writes a brand-new key, unconditionally.
  Running it twice in immediate succession simply mints two consecutive keys, invalidating the
  first with the second — there is no "already reset" no-op branch, because every invocation is
  a deliberate, one-off human action against an already-existing row, not a step that might be
  repeated unintentionally by automation the way a deploy-time migration or bootstrap command
  might be.

## Consequences

- The owner tier stays exactly as simple as ADR-0009 originally modeled it: one owner row per
  platform, one creation path (`bootstrap-owner.ts`), no deactivate/activate surface, no "last
  owner" invariant to maintain, no `admin.owner_registered` event. Every future admin-creating
  path in this design still only has to reason about the two invariants ADR-0009 established
  (non-null `platformId`/`adminTier`) for exactly two rows types: the one owner and however many
  operators — never a variable-sized owner set.
- **The catastrophic sole-owner-lockout risk is reintroduced, and knowingly accepted as
  permanent, not an oversight.** If a platform's sole owner loses **both** their password and
  their secret key, nothing in this design can recover that platform's admin access: there is
  no second owner to fall back on (by this ADR's own decision), and `reset-owner-secret-key.ts`
  only ever touches the secret key — it cannot help an owner who has also lost their password,
  since a lost password isn't something this tool, or `bootstrap-owner.ts`, is designed to
  overwrite. This is the exact scenario ADR-0016's Consequences already named — "**Open
  question, not resolved here:** what recovery path (if any) exists for that scenario" — and it
  remains exactly that: unresolved. The difference is that it is no longer an open question this
  design might still close with a future second-owner mechanism; by choosing strict
  single-ownership, this ADR closes off that particular mitigation permanently and accepts the
  resulting exposure as the cost of keeping the owner tier simple. Whether some other recovery
  path (e.g. a manually-verified, heavily-audited out-of-band identity-proof process outside
  this schema entirely) should exist is new, undesigned scope, not decided here.
- Ownership transfer (a platform's owner needing to be replaced by a different person or
  account) has no designed mechanism, and this ADR does not add one. The only way to change who
  operates a given platform's owner credentials is to have the current owner rotate/share
  their own login, or to re-run `bootstrap-owner.ts` against a platform id that has never had an
  owner — neither of which is a real transfer mechanism, and none is designed here.
- `reset-owner-secret-key.ts` closes a narrower, real gap: an owner who still has their password
  and wants to act on an ADR-0010 compromise alert now has an out-of-band lever independent of
  trusting the live API, alongside the existing in-band
  `POST /auth/admin/secret-key/rotate` self-service path, which remains unchanged and remains
  the ordinary way an owner rotates their own key.
- **The CLI reset path is unauditable by the app itself**, in the same spirit as ADR-0016's
  already-accepted trade-off for the ordinary bootstrap path: because it bypasses the API
  entirely, no `admin.*` event exists for it, unlike every other credential-affecting action in
  this design (`admin.secret_key_rotated` chief among them, which this tool deliberately does
  not publish). Whoever operates the deployment is trusted to keep their own external record of
  when and why this tool was invoked.
- `docs/add/auth-service.md` and `docs/sdd/auth-service.md`'s open-questions entries are updated
  in place to state single-owner-per-platform as a decided, permanent invariant — not to
  restate it as still-open — while keeping the dual-credential-loss risk stated as an explicit,
  accepted gap, per this Consequences section.

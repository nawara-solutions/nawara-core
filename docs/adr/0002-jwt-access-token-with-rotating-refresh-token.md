# 0002. JWT access token + DB-backed refresh token with rotation & reuse detection

- **Status:** Proposed
- **Date:** 2026-09-16
- **Deciders:** Anwar (project owner)

## Context

`auth-service` (currently a bare Nest CLI scaffold with no JWT/passport dependencies)
needs to issue tokens that other `nawara-core` services — and potentially a future API
gateway — can verify locally, without a database round-trip on every request, so
verification can scale horizontally without every request hammering a shared database.
At the same time, the design needs genuine revocation: a user must be able to log out,
and a stolen or leaked token must be invalidatable before it naturally expires — a
purely stateless token scheme cannot provide that on its own.

Multiple, very different client types will hold these tokens: a NestJS backend service,
an Angular/Tauri desktop app (`nawara-drive`'s `apps/desktop`), and an Expo/React Native
mobile app. The mechanism therefore has to work over plain HTTP/JSON, since it can't
reliably assume all clients maintain a cookie jar the way a browser would.

## Options considered

1. **A single, longer-lived, purely stateless JWT with no refresh mechanism at all** —
   the simplest possible design. It is fundamentally unrevocable: the only way to end a
   session early is to wait out the token's expiry, forcing an uncomfortable tradeoff
   between session convenience (long expiry) and compromise-exposure window (short
   expiry, frequent re-logins).
2. **A short-lived stateless JWT access token paired with an opaque, database-backed
   refresh token that is rotated on every use**, with a `familyId` grouping each
   rotation chain together so that reusing an already-rotated (i.e., stolen and
   already-consumed) refresh token revokes the entire family as a theft signal. Gives
   fast, DB-free access-token verification plus real, timely revocation, at the cost of
   more moving parts (a stored table, rotation bookkeeping).
3. **Both access and refresh tokens are stateless JWTs, with revocation implemented via
   a Redis-backed denylist of revoked token ids** — avoids a database write on every
   refresh, but requires standing up a new piece of infrastructure (Redis) that does not
   exist anywhere in this repo yet, and does not give reuse-detection "for free" the way
   a stored, single-use refresh token does (a denylist only stops tokens explicitly
   revoked, not ones silently stolen-and-reused).
4. **Traditional server-side session with an HTTP-only cookie, no JWTs at all** — the
   simplest revocation story of any option considered (just delete the session row), but
   a poor fit for API-only, multi-client consumers like a mobile app or a Tauri desktop
   shell that can't reliably rely on cookie jars, and it reintroduces a DB lookup on
   every authenticated request, defeating the stateless-verification goal.

## Decision

We chose **Option 2**. The access token is a short-lived JWT carrying `sub` (user id),
`role`, `organizationId` (per ADR-0001), `iat`, and `exp`, verified purely by signature
and expiry — no database lookup on the hot path. The refresh token is an opaque,
high-entropy random string; only its hash is ever persisted; each successful refresh
rotates it (issues a new one, invalidates the old) while preserving a `familyId` that
links the whole rotation chain together, so that presenting an already-rotated-away
refresh token is treated as a signal of theft and revokes every token in that family.

## Consequences

- Requires a `RefreshToken` table/entity that `auth-service` alone owns and writes to
  (see ADR-0003 for the persistence choice backing it).
- Other `nawara-core` services (or a future API gateway) can validate access tokens
  entirely locally with nothing more than a shared verification key/secret, never
  touching `auth-service`'s database — consistent with this repo's database-per-service
  principle.
- This is materially more complex to implement correctly than a pure-stateless design:
  it needs rotation bookkeeping, reuse-detection logic, and an eventual pruning job for
  expired/rotated-away rows. It is nonetheless the only option among those considered
  that gives both horizontal-scalability-friendly verification and real, timely
  revocation without introducing a new infrastructure dependency (Redis) that nothing
  else in this repo currently needs.

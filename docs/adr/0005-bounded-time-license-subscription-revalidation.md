# 0005. Bounded-time license and subscription re-validation on login and refresh

- **Status:** Superseded by ADR-0026
- **Date:** 2026-09-16
- **Deciders:** Anwar (project owner)

> **Superseded by [ADR-0026](./0026-authentication-is-not-entitlement.md).** `auth-service` no longer checks licenses or subscriptions on login or refresh; entitlement is enforced by platform services against `payment-service`. Text below is left as the original record.

## Context

`auth-service` currently validates an organization's license only at B2B registration time
(`ADR-0004`): once via `POST /auth/organizations/validate`, and again server-side inside
`POST /auth/register` to close the time-of-check-to-time-of-use gap. After that, per `ADR-0002`,
an access token is verified purely locally — no DB or service call — so nothing today
re-checks an organization's license validity once a user is already logged in. If an
organization's license later lapses, every user registered under it — including the
organization's own admin — keeps working normally, potentially indefinitely, until they
happen to log out on their own.

This needs to change: when an organization's license lapses, everyone registered under it
should be logged out of the app. Separately (and out of scope here — see `ADR-0006`), a
specific user may hold an individual subscription independent of the org's license; whether
that subscription is currently valid is a distinct question from whether the org's own
license is valid, and both need to gate access.

At the same time, `ADR-0002`'s decision that access-token verification must never require a
DB or service call (for horizontal scalability) is a constraint worth keeping. This system has
no existing infrastructure for real-time session revocation or push-based forced disconnects —
no revocation cache, no WebSocket or persistent push layer — and introducing either would be a
materially bigger scope than currently warranted.

## Options considered

1. **Re-check org-license (and individual-subscription, per `ADR-0006`) validity on every
   `POST /auth/login` and `POST /auth/refresh` call, extending the exact pattern `ADR-0004`
   already uses at registration.** No new infrastructure — reuses the `payment-service` call
   `auth-service` already makes. A login is rejected outright if the org's license (or the
   user's own subscription, when one exists) is invalid; an already-logged-in user is logged
   out the next time their access token needs refreshing. This does not achieve instant
   logout — a user with a still-valid access token keeps working until that token's TTL
   elapses.
2. **A revocation check (e.g. Redis-backed) on every protected request.** Enables near-instant
   logout, but breaks `ADR-0002`'s no-DB/service-call-per-request design and adds a new piece
   of always-available shared infrastructure that every token-verifying service would need to
   reach, for a system with no other real-time infrastructure today.
3. **Real-time push to already-connected clients** (e.g. WebSocket or a persistent push
   channel) to force an immediate client-side logout. Most accurate and instant, but requires
   standing up an entirely new communication channel beyond the one-shot FCM push already
   planned for `notification-service` — a materially bigger scope than this decision warrants
   right now.
4. **Do nothing beyond registration-time validation.** Rejected outright — this is precisely
   the gap being closed.

## Decision

We chose **Option 1**. `POST /auth/login` and `POST /auth/refresh` both now call
`payment-service` to check the requesting user's organization's license status, extending the
exact call `POST /auth/register` already makes per `ADR-0004`, and separately check the user's
own individual-subscription status when a subscription exists for that user (per `ADR-0006`).
An invalid org license rejects the call with the same `403` "contact your organization"
response already used at registration; an invalid individual subscription rejects with a
distinct `403`. `payment-service` being unreachable fails closed with `503`, consistent with
`ADR-0004`.

Because access tokens remain short-lived (per `ADR-0002`) and are never re-verified against
this check directly — verification stays local and stateless — the practical effect is: a new
login attempt is blocked immediately once a license or subscription is invalid, and an
already-logged-in session is logged out the next time it needs to refresh, bounded by the
access-token's TTL rather than instant.

## Consequences

- No new infrastructure: reuses the existing `payment-service` dependency and its fail-closed
  semantics from `ADR-0004`.
- `ADR-0002`'s access-token verification remains a pure, local, stateless operation — this
  decision only touches the `/login` and `/refresh` endpoints, not every protected request.
- Logout is bounded by the access-token TTL, not instant. If enforcement needs to be faster
  than that window in the future, that requires revisiting this decision (Options 2/3 above) —
  this ADR deliberately does not solve that.
- `/auth/login` and `/auth/refresh` now share `POST /auth/register`'s availability coupling to
  `payment-service`: if `payment-service` is down, no one can log in or refresh a token, not
  just complete new registrations. This is a materially wider blast radius than `ADR-0004`
  introduced, and should be weighed against the access-token TTL chosen — a longer TTL reduces
  how often `payment-service` is hit, at the cost of a longer bounded-logout window.
- This ADR does not decide the individual-subscription data model or the freeze/resume
  mechanics used when an org's license lapses and later recovers — see `ADR-0006`.

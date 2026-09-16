# 0006. Per-user subscription reservation on organization license lapse

- **Status:** Proposed
- **Date:** 2026-09-16
- **Deciders:** Anwar (project owner)

## Context

A user can hold an individual subscription — their own paid access, independent of and in
addition to the organization's own license — via `payment-service`'s generic `Product`/`Charge`
model (per `CLAUDE.md`). Whether a given user ever has one is entirely up to the consuming app
(not modeled here — see "Consequences"): some users under an organization may never need one,
others may hold one throughout their time under that organization.

`ADR-0005` establishes that when an organization's own license lapses, every user under that
organization is logged out — including a user who separately holds a currently-valid individual
subscription. That user did nothing wrong and already paid for time that hasn't been used yet;
simply letting their subscription continue counting down while they can't use the app (because
their organization's license, not their own subscription, is the reason they're locked out)
would silently cost them paid time they can't use. `payment-service` needs a way to preserve
that unused time until the organization's license is valid again, then restore it and notify
the affected user.

`payment-service` owns this decision alone: it already owns `Product`/`Charge` data, and nothing
about freezing/resuming a subscription touches `auth-service`'s `User` table or requires a
cross-service database query, consistent with this repo's database-per-service principle.

## Options considered

1. **Freeze the remaining duration at suspension time, and resume by re-anchoring `expiresAt`
   from the moment of reactivation.** When the organization's license lapses, every affected
   `UserSubscription` moves to `suspended`: its remaining duration (`expiresAt - suspendedAt`)
   is captured once and stored, and `expiresAt` itself is cleared. When the organization's
   license becomes valid again, each suspended subscription's `expiresAt` is recomputed as
   `reactivatedAt + frozenRemainingDuration`, and its status returns to `active`. The
   subscription's clock only ever runs while its organization's license is valid.
2. **Extend `expiresAt` by the suspended duration instead of freezing and re-anchoring** — i.e.
   leave `expiresAt` untouched while suspended and, on reactivation, push it forward by however
   long the suspension lasted. Mathematically similar for a single suspension, but compounds
   awkwardly across multiple lapse/reactivate cycles (each one needs to know exactly how long
   the previous suspension lasted, and any clock/timezone drift accumulates across edits to the
   same field) — freezing an explicit remaining-duration value avoids that bookkeeping.
3. **Track banked time in whole days rather than a duration/timestamp** — simpler to reason
   about at a glance, but loses precision (a user suspended for part of a day either gains or
   loses a fractional day depending on rounding direction) and doesn't compose cleanly with
   `expiresAt` already being a timestamp everywhere else in this system. Rejected in favor of
   duration-based freezing.
4. **Let the subscription keep counting down during the organization's suspension** (i.e. do
   nothing special) — rejected outright; this is exactly the loss of paid time being avoided.

## Decision

We chose **Option 1**. `payment-service` gets a new `UserSubscription` entity, independent of
`auth-service`'s `User`: `userId` and `organizationId` are both stamped onto it from the JWT
claims at the moment the subscription is purchased (never queried from `auth-service`), so
`payment-service` can identify every `UserSubscription` under a given organization using only
its own data.

When `payment-service` detects that an organization's license has lapsed, it moves every
`UserSubscription` under that organization from `active` to `suspended`: it computes and stores
`frozenRemainingSeconds = expiresAt - now`, then clears `expiresAt`. When that organization's
license becomes valid again, each `suspended` subscription is moved back to `active`:
`expiresAt` is recomputed as `now + frozenRemainingSeconds`, and `frozenRemainingSeconds` is
cleared. A `UserSubscription` with no row at all for a given user is treated as "not
applicable" everywhere this is checked (per `ADR-0005`) — its absence is never itself a reason
to block access.

`payment-service` publishes per-user `subscription.suspended` /
`subscription.resumed` events (`{ userId, organizationId, frozenRemainingSeconds, timestamp }`
and `{ userId, organizationId, restoredExpiresAt, timestamp }` respectively) so
`notification-service` can inform the affected user, alongside organization-level
`license.expired` / `license.reactivated` events (`{ organizationId, ownerId, timestamp }`,
using the `userId` of whoever purchased the organization's license) for notifying the
organization's admin. These follow the same flat, primitive-payload, publisher-decoupled
convention already established by `auth-service`'s `user.registered` event, and carry the same
"RabbitMQ doesn't exist yet in this repo" infrastructure gap noted there.

## Consequences

- No cross-service database access: `payment-service` can suspend/resume every affected
  subscription and identify who to notify using only data it already owns (`UserSubscription`
  rows and the purchasing `userId` on the organization's license `Product`), consistent with
  database-per-service.
- A subscription's active duration only ever elapses while its organization's license is
  valid — a user is never charged, in used time, for a period they couldn't access the app.
- This introduces four new events (`license.expired`, `license.reactivated`,
  `subscription.suspended`, `subscription.resumed`), all currently undeliverable in practice —
  no RabbitMQ broker, exchange/queue convention, or client library exists anywhere in this repo
  yet (same gap already flagged in `auth-service`'s design docs). These are design
  recommendations, not buildable components, until that follow-up infrastructure work lands.
- `payment-service` needs some mechanism to actually detect that an organization's license has
  lapsed or been renewed in order to trigger the suspend/resume flow (e.g. a scheduled sweep
  over license expiry dates, or reacting to whatever process renews/revokes a license). That
  detection mechanism is not decided by this ADR — it belongs in `payment-service`'s own SDD.
- This ADR deliberately does **not** decide which users or roles ever get a `UserSubscription`
  in the first place — per `CLAUDE.md`'s hard rule that `nawara-core` stays generic, that
  decision belongs entirely to the consuming app (e.g. `nawara-drive` deciding which of its own
  roles need to purchase individual access). `auth-service` and `payment-service` only ever
  observe whether a `UserSubscription` row exists for a given user, never why.

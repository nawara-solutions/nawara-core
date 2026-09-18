# 0026. Authentication is not entitlement: auth-service stops gating login/refresh on licenses and subscriptions

- **Status:** Proposed
- **Date:** 2026-09-18
- **Deciders:** Anwar (project owner)

> **Supersedes [ADR-0005](./0005-bounded-time-license-subscription-revalidation.md) in full** and the
> login/refresh usage of [ADR-0004](./0004-synchronous-fail-closed-license-validation.md) and
> [ADR-0006](./0006-per-user-subscription-reservation-on-license-lapse.md)'s `subscription_invalid`
> contract. ADR-0004's **registration-time** license check and `payment-service`'s ownership of
> licenses, subscriptions, reservations and billing (ADR-0006/0007/0008) are unchanged.

## Context

ADR-0004/0005 made `auth-service` a second enforcement point for *paid access*: on every login and
refresh it called `payment-service` and answered `403` when the user's organization license had
lapsed (`"contact your organization"`) or the user's individual subscription was not `active`
(`403 subscription_invalid`), and `503` when `payment-service` was down. `User.trialEndsAt` carried
trial state on the identity row.

This mixes four things that should stay apart:

| Concept | Question | Owner |
|---|---|---|
| Identity | who is this? | auth-service |
| Authentication | can they prove it? | auth-service |
| Authorization | which tenant/platform boundary may they touch? | auth-service (boundary) + platform services (business permissions) |
| **Entitlement** | has this organization/user **paid** for this capability? | **payment-service** |

Concrete harm from the mix: a lapsed license makes an organization's members, and their data, locked
out of *authentication* — including of free/unpaid functionality a platform may still offer, and of
the very screen that says "renew your license"; `payment-service` downtime takes login down (`503`)
for every organization; and subscription state on `User` forces `auth-service` to know billing
concepts (`trialEndsAt`) and to be redeployed for pricing changes.

## Options considered

1. **Keep ADR-0005 as is.** Rejected by the business rule: an expired license must not invalidate the
   identity, and authentication must not depend on billing.
2. **Keep the check but return a soft flag in the token.** Rejected: a cached entitlement claim in a
   token is stale by construction (the same reason ADR-0022 dropped `platformId` from the JWT), and it
   still couples login to `payment-service`.
3. **Remove entitlement from login/refresh entirely; platform services ask `payment-service`
   themselves at the point of use (chosen).**

## Decision

1. **Login and refresh never call `payment-service`.** `POST /auth/login` and `POST /auth/refresh`
   succeed or fail on credentials, account state (`isActive`), operator schedule/session rules and
   token validity only. They no longer return the organization-license `403`, `403
   subscription_invalid`, or `503` from `payment-service`, and login/refresh stay available when
   `payment-service` is down.
2. **Entitlement is enforced by whoever provides the paid capability.** Platform services call
   `payment-service` (its existing organization-license and user-subscription endpoints, ADR-0004/0006)
   with the `organizationId`/`userId` from the verified token, and return their own response
   (typically `402`/`403`) when entitlement is missing. `auth-service` never puts entitlement in a
   token.
3. **`User.trialEndsAt` is removed** (migration `0002`; the migration refuses if rows still hold a
   value unless the operator has exported it and explicitly acknowledges). A trial is a subscription:
   `payment-service` creates it when it consumes `user.registered` (already published, ADR-0018);
   trial length is `payment-service` configuration. `POST /auth/organizations/validate` no longer
   returns a trial preview.
4. **Kept, deliberately: the registration-time license check (ADR-0004).** Creating a *new* identity
   inside an organization with no valid license is an onboarding/capacity decision, not
   authentication; it remains a synchronous, fail-closed yes/no question to `payment-service`. This is
   the one remaining place `auth-service` asks `payment-service` anything, and it is flagged below.
5. **`auth-service` stores no license, subscription, plan, billing or trial state** anywhere
   (`User`, `Organization`, `Platform`, `Company`). The database test suite asserts no such columns.

## Consequences

**Good**

- Clean four-way separation; auth availability no longer depends on `payment-service`.
- A lapsed organization's users can still sign in and reach the "renew" experience; deciding what a
  lapse *blocks* is the platform's call.
- No billing vocabulary in the identity model.

**Costs / risks**

- **Behavior change for clients:** apps that relied on login returning `403`/`subscription_invalid`
  must handle the platform service's entitlement response instead. Every platform service must now
  actually perform its entitlement check — forgetting it fails **open** (a lapsed org keeps access),
  where the old design failed closed at login. A shared helper/guard in each consumer is recommended.
- ADR-0006's user-facing wording moves to the platform layer; its reservation mechanics are untouched.
- Extra latency/load moves from login to per-request entitlement checks in platform services
  (`payment-service` can cache short-TTL results; that is its concern).
- `payment-service` must implement the trial-subscription creation on `user.registered` before
  `trialEndsAt` is dropped in any deployed environment (none exists yet).

## Open questions

- Should the registration-time license check (item 4) also move out (e.g. registration performed by
  the platform after its own entitlement check)? Kept for now to avoid redesigning onboarding.
- Whether a suspended organization should be able to *register new users* is a payment/onboarding
  policy; auth only relays the yes/no.

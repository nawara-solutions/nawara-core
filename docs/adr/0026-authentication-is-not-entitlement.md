# 0026. Authentication is not entitlement: auth-service stops gating login/refresh on licenses and subscriptions

- **Status:** Accepted (2026-10-09, by the architecture owner, A5.2-E owner authorization; decisions 2 and 4 revised before acceptance)
- **Date:** 2026-09-18
- **Deciders:** Anwar (project owner)

> **Acceptance note (2026-10-09, A5.2-E).** Before acceptance the owner approved two normative revisions, made in place while this
> ADR was Proposed: **decision 4** (registration and join no longer make any commercial check, matching Stage 12.1) and
> **decision 2** (paid capabilities enforce authoritative entitlement at the point of use and deny when it is not confirmed). The
> rest is read as follows; no other decision is changed:
> 1. **Entitlement ownership.** The statements that payment-service owns licenses, subscriptions and reservations are historical:
>    entitlement ownership is billing-service's under [ADR-0038](./0038-entitlement-in-billing-service.md), whose implemented
>    structure is recorded in [ADR-0044](./0044-subscription-entitlement-final-model.md). **Both stay Proposed**; this ADR neither
>    accepts nor supersedes them, and its decisions do not depend on which service owns entitlement.
> 2. **Decision 3.** `User.trialEndsAt` was removed (Auth migration `0002`). Trial creation on `user.registered` is **not built**;
>    trials are deferred (B-019, ADR-0044).
> 3. **Removed endpoint.** `POST /auth/organizations/validate` no longer exists; join-code resolution
>    (`POST /auth/onboarding/resolve`, [ADR-0028](./0028-organization-join-codes-membership-and-organization-admin.md)) replaced it
>    and never checked a license. Open question 1 is closed by decision 4; open question 2 is moot for Auth.
> 4. **Open implementation risk (not runtime behavior).** No paid-capability enforcement is verified today: no Core service
>    consumes billing-service's entitlement contract (`GET /billing/organizations/:organizationId/entitlement`), billing-service is
>    not in production, and enforcement at the point of use exists only as this decision's requirement on the services that provide
>    paid capabilities. Until a consumer implements and verifies it, the risk named under Consequences (a forgotten check fails
>    open) stands.
> 5. **No operational authorization.** This acceptance changes no runtime code and authorizes no deployment or production change.

> **Forward note (2026-09-19):** the principle (authentication is not entitlement) is unchanged, but the statement that payment-service owns licenses, subscriptions and reservations is amended by [ADR-0038](./0038-entitlement-in-billing-service.md): billing-service owns them.

> **Supersedes [ADR-0005](./0005-bounded-time-license-subscription-revalidation.md) in full** and the
> login/refresh usage of [ADR-0004](./0004-synchronous-fail-closed-license-validation.md) and
> [ADR-0006](./0006-per-user-subscription-reservation-on-license-lapse.md)'s `subscription_invalid`
> contract, and (revised 2026-10-09, decision 4) **ADR-0004's license check**: its validation step and its
> registration-time re-check. `payment-service`'s ownership of licenses, subscriptions, reservations and billing
> (ADR-0006/0007/0008) is not changed by this ADR (see the forward note above on ADR-0038).

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
2. **Entitlement is enforced by whoever provides the paid capability** (revised 2026-10-09, before acceptance). A service
   that provides a paid capability checks authoritative entitlement with the entitlement owner's contract at the point of use,
   for the organization taken from the request or the resource, and **denies** the capability (its own response, typically
   `402`/`403`) when entitlement is missing, invalid, expired, unavailable or indeterminate. Authentication stays independent of
   entitlement: no authentication or session decision depends on an entitlement check, and `auth-service` never puts
   entitlement in a token. *(Original text, kept as history: platform services call `payment-service`'s organization-license and
   user-subscription endpoints, ADR-0004/0006, with the `organizationId`/`userId` from the verified token.)*
3. **`User.trialEndsAt` is removed** (migration `0002`; the migration refuses if rows still hold a
   value unless the operator has exported it and explicitly acknowledges). A trial is a subscription:
   `payment-service` creates it when it consumes `user.registered` (already published, ADR-0018);
   trial length is `payment-service` configuration. `POST /auth/organizations/validate` no longer
   returns a trial preview.
4. **Registration and join make no commercial check** (revised 2026-10-09, before acceptance). `POST /auth/register` and
   `POST /auth/onboarding/join` make no license, subscription or entitlement check, and invitation acceptance never did
   (ADR-0029). `auth-service` asks no commercial service anything. A join code's `requiresSubscription` is a
   non-authoritative hint to the app, stored and returned, never enforced by Auth. The check was removed in Stage 12.1 (commit
   `f1901f9`). *(Original text, kept as history: "Kept, deliberately: the registration-time license check (ADR-0004) … a
   synchronous, fail-closed yes/no question to `payment-service`.")*
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

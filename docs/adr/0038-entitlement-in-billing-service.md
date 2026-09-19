# 0038. Entitlement (licenses and subscriptions) lives in billing-service

- **Status:** Proposed
- **Date:** 2026-09-19
- **Deciders:** Anwar (project owner)

> Relocates `License` and `UserSubscription` from the payment-service design and **amends the ownership statement of
> [ADR-0026](./0026-authentication-is-not-entitlement.md)** (which names payment-service as owner of licenses, subscriptions and
> reservations); ADR-0026's principle that authentication is not entitlement is unchanged. Keeps the rules of
> [ADR-0006](./0006-per-user-subscription-reservation-on-license-lapse.md) and
> [ADR-0008](./0008-automatic-grace-license-on-license-lapse.md). Amends the route location of
> [ADR-0004](./0004-synchronous-fail-closed-license-validation.md).

## Context

The requirements name `OrganizationLicense` and `UserSubscription` as entitlements but assign them to none of the three
financial services and rule out a separate subscription service. Entitlement answers "what did they buy and is it still valid",
which follows *what is owed* (Product → Invoice → payment succeeded → Entitlement), not *how money moved*.

## Options considered

1. **billing-service.** Chosen.
2. *payment-service.* Rejected: mixes money movement with access rights.
3. *Decide later.* Rejected: leaves the old design's cleanup open.

## Decision

- billing-service owns `organization_license` (one active per organization; `standard` or `grace`) and `user_subscription`
  (user **and** organization; a user may hold subscriptions under many organizations; `active | suspended | expired`).
- Trials (the old design started one on `user.registered`) are an open decision, not carried over silently.
- Entitlement changes only from events: a `payment.succeeded` for an invoice line of an entitlement product activates or
  extends it; expiry and renewal are evaluated by billing. The reservation (freeze remaining time when a license lapses) and
  the grace rule of ADR-0006/ADR-0008 are re-expressed on these records.
- billing-service exposes an entitlement-status API (`{ valid, expiresAt }`, same answer for "none" and "expired") that
  platform services call at the point of use, authenticated with a service token.
- **Authentication never depends on entitlement.** A lapsed license or subscription leaves the user and their memberships
  valid in Auth; only the protected capability is denied by the consuming service.
- Auth's registration/join license check currently calls payment; repointing it (or removing it) is a separate, additive Auth
  change and an open decision.

## Consequences

- payment-service stays purely about money; entitlement logic lives next to what was bought.
- The entitlement API is a synchronous dependency of consuming services, with a fail-open or fail-closed choice each must document.
- Auth's contract with payment changes path and owner later.

# 0068. No cash settlement for Nawara-sold products in Core V2 (partly supersedes ADR-0007)

- **Status:** Proposed <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-10-21
- **Deciders:** Anwar (project owner, architecture owner)

> **Core V2 S0 (2026-10-21).** The architecture owner approved this decision (pre-freeze decision D1) and its wording at the Core V2
> S0 freeze ([S0 record](../architecture/core-v2-s0-architecture-freeze.md)). That is not an acceptance of this ADR: its status stays
> `Proposed` until the owner changes it explicitly. It **partly supersedes** the Accepted
> [ADR-0007](./0007-out-of-band-cash-payment-confirmation.md); following the repository's ADR workflow, ADR-0007 is not edited here,
> its status line and a reciprocal note change only with separate, explicit approval, and the supersession takes effect when this ADR
> is Accepted.

## Context

ADR-0007 (Accepted) decided trust-based confirmation of cash payments by an administrator, later re-scoped to the invoice seller's
authority (its forward note, [ADR-0035](./0035-financial-service-boundaries.md), [ADR-0036](./0036-money-parties-and-source-references.md)).
The financial architecture describes the resulting flow, `cash submission → review → confirm → payment succeeded`. payment-service's
schema keeps `settledMethod ∈ {gateway, cash}` (`apps/payment-service/db/migrations/0002_payment.sql`); no code path sets `cash`
today.

The approved Core V2 commercial model has Nawara as the seller of Premium and states that only verified electronic settlement
activates it: cash alone never activates, and there is no manual settlement confirmation. Under Pay with School, the school collects
cash from the student and then pays Nawara electronically. ADR-0007, applied to Nawara-sold products, contradicts that model.

## Options considered

1. **Keep ADR-0007 for every seller.** Rejected: a human confirmation could activate Nawara-sold Premium.
2. **Withdraw cash settlement entirely.** Rejected: other sellers' cash flows are not decided for Core V2 and should not be closed by
   this decision.
3. **Prohibit cash settlement for Nawara-sold products; defer it for every other seller (chosen).**

## Decision

1. For any payment whose seller is a Company (`seller.type = company`; in Core V2 the only Company seller is the Nawara operating
   Company, ADR-0036), no manual, trust-based or out-of-band
   confirmation may move a payment to `succeeded`. Such a payment succeeds only on verified electronic settlement reported by a
   payment provider (or, outside production, by the simulation adapter).
2. Cash a school collects from a student under Pay with School is not a payment to the seller. billing-service records it as an
   assistance obligation (ADR-0035, clarification C1); it never settles a payment for the student and never activates entitlement. A
   school's repayment of a recovery obligation is an electronic `recovery_settlement` payment
   ([ADR-0044](./0044-subscription-entitlement-final-model.md) B8).
3. payment-service refuses `settledMethod = 'cash'` for Nawara-sold payments at the database level.
4. Cash settlement for any other seller type is deferred: it is not part of Core V2 and requires a separate decision before any route
   or schema enables it.
5. ADR-0007's rationale (cash has no independent verification signal) is preserved; this decision applies it strictly to Nawara-sold
   products.

## Consequences

- No human action can activate Nawara-sold Premium; activation follows only verified electronic settlement.
- ADR-0007 stays Accepted for what it still governs (other sellers, deferred); its status line and a reciprocal note need separate
  approval.
- Follow-up: the database guard in payment-service and the financial architecture update (removing the Nawara `cash → succeeded`
  path), under separate authorization.

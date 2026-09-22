# 0044. Subscription and Entitlement final model: one organization-scoped Subscription, no License/UserSubscription split

- **Status:** Proposed. Records decisions already implemented and merged through Stage 12.1-12.7 (PR #71); per this
  repo's ADR workflow, this document itself moves to `Accepted` on merge like any other ADR — its `Proposed` status
  reflects review state of this record, not doubt about the underlying shipped code.
- **Date:** 2026-09-22
- **Deciders:** Anwar (project owner)

> **Amends [ADR-0038](./0038-entitlement-in-billing-service.md)'s structure**, not its ownership principle. ADR-0038's
> decision that entitlement lives in billing-service, not payment-service, and that authentication never depends on
> entitlement, **stands unchanged and is confirmed by what was built.** What this ADR replaces is ADR-0038's proposed
> **shape** — two tables (`organization_license`, `user_subscription`), user-and-organization scope, and two status
> routes — which was never built that way. Following this repository's precedent for partial replacement without
> editing an already-written ADR (ADR-0001, ADR-0010, ADR-0039/0040): ADR-0038's status line gets a forward note
> ("superseded in part by ADR-0044 — see this document's 'Amends ADR-0038' note above"); its own text is not edited. This ADR also
> resolves the `docs/sdd/billing-service.md` §32 business-decision register entries B-018, B-020, B-021, B-022, B-025
> and B-035 (each cited below), and leaves B-019, B-023 and B-024 exactly as undecided/deferred as they were.

## Context

ADR-0038 (2026-09-19, still `Proposed`) decided billing-service owns entitlement and proposed a schema: a
per-organization `organization_license` (`standard`/`grace`) plus a per-user, per-organization `user_subscription`
(`active`/`suspended`/`expired`), reservation-on-lapse borrowed from the old ADR-0006/0008 payment-service design.
Stage 12 (12.1 through 12.7) then actually built the domain, and the real implementation, reviewed and merged one
sub-stage at a time, diverged from that proposal in structure while keeping its ownership principle. This ADR records
what was actually decided and built, so the SDD and architecture docs have one place to point to instead of
describing a shape that does not exist.

## Options considered

1. **Build ADR-0038's `organization_license` + `user_subscription` two-table model as proposed.** Rejected during
   implementation: V1 has no requirement for subscriptions to vary per user within an organization (Nawara Drive's
   only real consumer is organization-scoped commercial access), so the extra dimension was pure speculative
   generality with no current business decision to justify it (SDD §0.1's own guardrail: a `[B]` item is not
   implementation authority).
2. **One `subscription` row per Organization, Product+Price-driven, with a single derived Entitlement question.**
   Chosen. Matches what Nawara Drive actually needs (an organization either currently has commercial access to a
   product or it does not) and needs no reservation/freeze concept, because there is no per-user subscription to
   reserve.
3. **A generic `Plan` abstraction above Product/Price.** Rejected: no requirement drove it; Product + Price's
   existing `interval` field already carries the billing cadence (SDD §12); a Plan layer would be speculative.

## Decision

- **Ownership (confirmed, unchanged from ADR-0038):** billing-service owns Subscription and derives Entitlement from
  it. Payment never owns commercial access; Auth never owns or checks it; Organization never owns it.
- **Schema (replaces ADR-0038 §"Decision", supersedes the SDD §16.2 table):** one table, `subscription`
  (`apps/billing-service/db/migrations/0013_subscription.sql`), scoped by `organizationId` alone (`UNIQUE
  ("organizationId")` — one CURRENT, mutable row per Organization, not a history of past rows). No `user_subscription`
  exists and none is planned: there is no per-user entitlement dimension in V1. Columns: `organizationId`,
  `productId`, `priceId`, `status`, `currentPeriodStart`, `currentPeriodEnd`, `graceUntil`, `cancelAtPeriodEnd`,
  `effectiveTerminationAt`, `revision`, `createdAt`, `updatedAt`. `productId`/`priceId` are immutable in V1 (no
  offering-change operation exists — B-023 below). History is the same append-only `billing_transition` table
  invoice/payment_request already use, widened to a third entity type, not a parallel mechanism.
- **Scope is `organizationId` alone (resolves the duplication question SDD §9 asks about `platformId`):** an
  Organization already belongs to exactly one Platform (Organization's own architecture), so Platform identity is
  always derivable through Organization and is never duplicated onto Subscription.
- **Lifecycle (replaces ADR-0038/SDD §17.5's `active(standard)`/`active(grace)`/`expired` license-style shape):**
  four statuses — `pending → active → (grace | expired) → active`, enforced by a database trigger
  (`billing_subscription_lifecycle`), matching the SDD §10 marker convention as `[D]`, implemented. `pending` is the
  born state (no period yet); `active → active` is the one self-loop (an early renewal or a cancellation toggle,
  still auditable via `revision`); reversal of `expired` is a fresh `active`, not a distinct "reactivated" status.
- **Period semantics (resolves the ambiguity ADR-0038 left open):** UTC, half-open, `[currentPeriodStart,
  currentPeriodEnd)` — valid while `currentPeriodStart <= now < currentPeriodEnd`.
- **B-018 (does recurring billing exist) — RESOLVED: yes, via Product+Price, not a separate
  `recurring_definition` entity.** SDD §15's proposed `recurring_definition`/cycle-invoice runner design was never
  built and is not needed: a `price.interval = 'recurring'` (with `intervalUnit`/`intervalCount`) is Subscription's
  only billing-cadence input: `apps/billing-service/src/domain/subscription-period.ts`. An invoice may carry **at
  most one** recurring line (`ambiguous_subscription_obligation`, `apps/billing-service/src/invoices/invoice.repository.ts`),
  since V1 has exactly one Subscription offering per Organization. There is no scheduled/automatic billing run: a
  Subscription is created and renewed only as a *result* of a settled Payment for a recurring obligation, never by a
  cron job that itself issues invoices. `recurring_definition` remains not built and not designed; if a future stage
  needs scheduled invoice generation, that is a new decision, not implied by anything here.
- **B-020 (grace periods) — RESOLVED: grace is optional, per-deployment configuration, frozen per period.**
  `SUBSCRIPTION_GRACE_DAYS` (unset = no grace at all, no Nawara-wide hard-coded default). `activate`/`renew`
  precompute `graceUntil` from that policy in the **same statement** as `currentPeriodEnd`, so it is a trustworthy,
  already-frozen timestamp on the row from the moment a period exists — never recomputed later, never affected by a
  subsequent change to `SUBSCRIPTION_GRACE_DAYS` for a period that already started. `enterGrace()` only normalizes
  the status label once `now` has crossed `currentPeriodEnd`; it cannot invent a grace horizon that was not already
  precomputed, and a subscription with no configured grace has no grace window to enter at all
  (`subscription_grace_unavailable`).
- **B-021 (per-user reservation on lapse) — REJECTED, not merely deferred.** ADR-0038's proposed `user_subscription`
  (user **and** organization scope, with a freeze/reservation mechanic re-expressing ADR-0006) is not built and is
  not planned: V1 has no per-user entitlement dimension to reserve. If a future product genuinely needs
  per-user-within-organization access, that is a new ADR, not a resumption of this one.
- **B-022 (cancellation) — RESOLVED: `cancelAtPeriodEnd`, at-period-end only, never immediate.** Setting it schedules
  what happens at the *next* period boundary; it never revokes already-purchased access, and `deriveEntitlement`
  structurally cannot see it (it is not even part of `deriveEntitlement`'s input type) — access for an already-paid
  period is unaffected by a pending cancellation. A period change (a renewal) force-clears it: cancellation is a
  decision about the period that is ending, never inherited by a new one.
- **B-025 (renewal anchor and stacking) — RESOLVED.** `renewalAnchor()`
  (`apps/billing-service/src/domain/subscription-period.ts`): renewing at or before the access boundary (still
  `active`, or within `graceUntil`) anchors the next period on the **original** `currentPeriodEnd` — already-paid
  time is never lost, and grace time is never additionally credited on top of it. Renewing after that boundary has
  fully elapsed anchors on the settlement instant itself (`now` at the authoritative Payment `closedAt`) — no
  back-charging for inaccessible days. The exact edge (`now === boundary`) resolves to the early-renewal branch
  either way, so the two rules never disagree at the boundary.
- **Entitlement is not persisted (confirmed, unchanged from ADR-0038's principle, corrects SDD §16.2/17.5's implied
  per-row entitlement state):** `deriveEntitlement` (`apps/billing-service/src/domain/entitlement.ts`) is a pure
  function of an already-loaded Subscription and a caller-supplied `now`; it is not a table, not a service, not
  cached. `{ valid: boolean, expiresAt: Date | null }` is the frozen V1 result shape — confirmed matching ADR-0038's
  proposed shape exactly.
- **The status API is ONE route (replaces ADR-0038/SDD §16.3/18's two routes,
  `/billing/licenses/{organizationId}/status` and `/billing/subscriptions/{userId}/status`), because there is no
  per-user dimension to ask about separately (B-021):** `GET
  /billing/organizations/:organizationId/entitlement` (`EntitlementController`, Stage 12.5), service-token only,
  `200 { valid, expiresAt }` always — no Subscription, `pending`, not-yet-started, expired, or an unknown
  organization are all `valid: false`, never a 404 or a transport error.
- **B-035 (does Auth keep a synchronous entitlement check) — RESOLVED: no, removed entirely, not repointed.**
  ADR-0038 and SDD §16.4 proposed a phased migration (Billing ships the route, then a separate Auth PR adds a
  Billing client behind configuration, then cutover, then the Payment client is removed last). That phased path was
  not taken: Stage 12.1 (commit `f1901f9`) deleted `apps/auth-service/src/payment/payment-client.ts` and the
  registration/join license-check block outright, in one change, because the route it called
  (`GET /payment/licenses/{organizationId}/status`) was never implemented on the payment-service side and never
  will be — payment-service is settlement-only (see ADR-0035). Auth's `requiresSubscription` field
  (`organization_join_code.requiresSubscription`) is retained as a non-authoritative onboarding hint only: it is
  stored and returned, never read to gate any control-flow decision.
- **Payment → Subscription integration (Stage 12.4, confirms and narrows ADR-0037's generic outbox/inbox
  design for this specific consumer):** a settled `payment.succeeded` may activate/renew Subscription only after
  Billing validates the PaymentRequest/Invoice state, amount, currency, recurring-obligation classification and
  organization scope through the **same** transaction as the `payment_event_receipt` write
  (`PaymentRequestRepository.applyPaymentEvent` → `linkSubscription`, one Postgres transaction, commits or rolls
  back as one unit). Billing remains commercial-state owner: Payment never decides Subscription state, and
  Subscription is never derived directly from provider/gateway data.
- **Real-broker transport guarantees (Stage 12.7, confirms ADR-0018/0037's transport design against this specific
  path):** RabbitMQ delivery is at-least-once; the commercial effect is idempotent/exactly-once via
  `payment_event_receipt`'s unique index on `eventId` plus `PaymentRequest.status`-based convergence between the
  live event and reconciliation paths. A settlement's authoritative timestamp (Payment's `closedAt`, equal by
  construction to the outbox row's `occurredAt`, since both are `now()` inside Payment's one settlement
  transaction) survives real, delayed broker delivery and a Billing outage/restart unchanged — proven with a real
  RabbitMQ broker and real PostgreSQL, not by inspection alone. **ADR-0018 and ADR-0037's own "production broker
  deployment is a separate, still-deferred approval" language is unaffected by this** — Stage 12.7 proves the
  transactional-outbox/RabbitMQ code path is correct against a real (non-mocked) broker in tests and CI; it says
  nothing about whether RabbitMQ has been deployed to a live production environment, which remains a separate,
  undecided operational question.
- **Still deferred, not decided here (unchanged from ADR-0038/SDD, listed for completeness):** B-019 (trials),
  B-023 (proration, upgrade/downgrade — Product/Price stay immutable for an existing Subscription), B-024
  (pause/resume), B-017/refund-driven entitlement revocation, a persisted Entitlement table or service, an
  Entitlement cache/projection, `Plan`/`SubscriptionPlan` as a concept above Product/Price, and any
  frontend/consuming-app subscription UX.

## Consequences

- ADR-0038's ownership principle is confirmed by the built system; its proposed schema is not used and should not be
  implemented by a future contributor reading it in isolation — this ADR is now the structural source of truth,
  and ADR-0038 carries a forward note saying so.
- `docs/sdd/billing-service.md` §§15–18, 21.3–21.4, 23–26, 32–34 need updating to describe the built model instead
  of the proposed one (done alongside this ADR, in the same Stage 12.8 change).
- `docs/architecture/financial-architecture.md` and `docs/architecture/core-architecture.md`'s data-model/ownership
  sections describe the same superseded `organization_license`/`user_subscription` shape and need the same
  correction (done alongside this ADR).
- No production code changes: this ADR records decisions already made and shipped through Stage 12.7; nothing here
  requires new implementation.

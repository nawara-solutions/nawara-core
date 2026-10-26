# 0044. Subscription and Entitlement final model: one organization-scoped Subscription, no License/UserSubscription split

- **Status:** Proposed. Records decisions already implemented and merged through Stage 12.1-12.7 (PR #71); per this
  repo's ADR workflow, this document itself moves to `Accepted` on merge like any other ADR — its `Proposed` status
  reflects review state of this record, not doubt about the underlying shipped code.
- **Date:** 2026-09-22 (Revision 1: 2026-10-21)
- **Deciders:** Anwar (project owner)

> **Revision 1 (Core V2 S0, 2026-10-21).** Part B below was added by the Core V2 S0 architecture freeze
> ([S0 record](../architecture/core-v2-s0-architecture-freeze.md)). The architecture owner approved its direction and wording at S0;
> that is not an acceptance of this ADR. The status stays `Proposed` until the owner changes it explicitly (the ADR workflow in
> [README](./README.md): merge is not approval). Part A is the record of what was built, kept as written except for the passages
> marked *Revision 1*. Part B is **not implemented**. The status line above is kept unchanged as history; the repository's current
> workflow (README, "Merge is not approval") governs.

> **Amends [ADR-0038](./0038-entitlement-in-billing-service.md)'s structure**, not its ownership principle. ADR-0038's
> decision that entitlement lives in billing-service, not payment-service, and that authentication never depends on
> entitlement, **stands unchanged and is confirmed by what was built.** What this ADR replaces is ADR-0038's proposed
> **shape** — two tables (`organization_license`, `user_subscription`), user-and-organization scope, and two status
> routes — which was never built that way. Following this repository's precedent for partial replacement without
> editing an already-written ADR (ADR-0001, ADR-0010, ADR-0039/0040): ADR-0038's status line gets a forward note
> ("superseded in part by ADR-0044 — see this document's 'Amends ADR-0038' note above"); its own text is not edited. This ADR also
> resolves the `docs/sdd/billing-service.md` §32 business-decision register entries B-018, B-020, B-021, B-022, B-025
> and B-035 (each cited below), and leaves B-019, B-023 and B-024 exactly as undecided/deferred as they were.
>
> **Revision 1** adds a Personal Subscription, owned by a named user for one Platform's product and portable across that
> Platform's Organizations, and replaces settlement classification by "has an organization and exactly one recurring line" with an
> explicit, immutable routing record. It does not reopen B-021 and does not revive ADR-0038's `user_subscription`. `entitlementKind`
> remains a compatibility field governed by [ADR-0045](./0045-commercial-entitlementkind-compatibility-fields.md); it is never a
> routing input.

## Context

ADR-0038 (2026-09-19, still `Proposed`) decided billing-service owns entitlement and proposed a schema: a
per-organization `organization_license` (`standard`/`grace`) plus a per-user, per-organization `user_subscription`
(`active`/`suspended`/`expired`), reservation-on-lapse borrowed from the old ADR-0006/0008 payment-service design.
Stage 12 (12.1 through 12.7) then actually built the domain, and the real implementation, reviewed and merged one
sub-stage at a time, diverged from that proposal in structure while keeping its ownership principle. This ADR records
what was actually decided and built, so the SDD and architecture docs have one place to point to instead of
describing a shape that does not exist.

**Revision 1 context.** The approved Core V2 commercial model makes Nawara the seller of personal Premium subscriptions owned by a
named user, scoped to user + Platform + product, purchasable directly or through Pay with School (the school pays Nawara
electronically for a consenting student). The built settlement link (`PaymentRequestRepository.linkSubscription`) applies a settled
invoice to the Organization Subscription whenever the invoice has an `organizationId` and exactly one recurring line. An assisted
personal purchase carries the school's `organizationId`, so that rule would activate the school's Organization Subscription.
Revision 1 removes that hazard by routing on an explicit target and purpose.

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

Revision 1:

4. **Derive the target from `entitlementKind`.** Rejected: ADR-0045 forbids treating it as commercial behavior.
5. **Derive the target from the presence of `organizationId`.** Rejected: that is the hazard; the organization on an assisted
   invoice is context, not the beneficiary ([ADR-0036](./0036-money-parties-and-source-references.md)).
6. **An explicit `product.subscriptionTarget`, snapshotted with the invoice's purpose into an immutable routing record, with
   database-enforced routing.** Chosen.

## Decision

### Part A — Organization Subscription (built; unchanged except where marked "Revision 1")

- **Ownership (confirmed, unchanged from ADR-0038):** billing-service owns Subscription and derives Entitlement from
  it. Payment never owns commercial access; Auth never owns or checks it; Organization never owns it. *Revision 1:* the same holds
  for the Personal Subscription (Part B).
- **Schema (replaces ADR-0038 §"Decision", supersedes the SDD §16.2 table):** one table, `subscription`
  (`apps/billing-service/db/migrations/0013_subscription.sql`), scoped by `organizationId` alone (`UNIQUE
  ("organizationId")` — one CURRENT, mutable row per Organization, not a history of past rows). No `user_subscription`
  exists and none is planned: there is no per-user entitlement dimension in V1. *Revision 1:* this table never holds per-user rows;
  per-user commercial access is the separate Personal Subscription of Part B, not ADR-0038's `user_subscription`. Columns:
  `organizationId`, `productId`, `priceId`, `status`, `currentPeriodStart`, `currentPeriodEnd`, `graceUntil`, `cancelAtPeriodEnd`,
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
  since V1 has exactly one Subscription offering per Organization. *Revision 1:* an invoice carries at most one entitlement-bearing
  line (B2). There is no scheduled/automatic billing run: a
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
  (`subscription_grace_unavailable`). *Revision 1:* this describes the built V1 behavior, which does **not** satisfy the Core V2
  grace policy when the setting is unset or other than 1; B13 replaces it for Core V2.
- **B-021 (per-user reservation on lapse) — REJECTED, not merely deferred.** ADR-0038's proposed `user_subscription`
  (user **and** organization scope, with a freeze/reservation mechanic re-expressing ADR-0006) is not built and is
  not planned: V1 has no per-user entitlement dimension to reserve. If a future product genuinely needs
  per-user-within-organization access, that is a new ADR, not a resumption of this one. *Revision 1 does not reopen B-021:* the
  Personal Subscription is scoped to a user and one Platform's product, never within an Organization, and has no reservation or
  freeze.
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
- **B-025 amendment (2026-09-29, owner decision): monthly and yearly renewals keep a persistent billing anchor.** The
  rule above fixes *which instant* a new period starts from; this fixes *where it ends* on the calendar. Implemented
  by `db/migrations/0015_subscription_billing_anchor.sql` (`subscription."billingAnchorAt"`,
  `billing_subscription_period_end`) and `SubscriptionRepository.rollPeriod`.
  1. A monthly or yearly subscription stores a **persistent billing anchor**: the instant that fixes its day of month,
     its UTC time of day and, for a yearly price, its month. It is set by the first activation (the settlement
     instant), and the first period ends on that anchor's cadence too: a direct `SubscriptionRepository.activate({ start,
     end })` sets the anchor to `start` and refuses (`400 invalid_subscription_period`) any `end` other than the anchored
     period end (`billing_subscription_period_end`, the function every renewal uses), so Jan 31 → Feb 15 is refused and
     Jan 31 → Feb 28 is the only first monthly period from Jan 31. Day and week activations keep their caller-supplied
     period. An off-cadence first period (a trial, an introductory or a prorated period) is not part of this decision:
     those remain B-019 and B-023. Early renewals, on-time renewals (including `now === currentPeriodEnd`) and renewals inside
     `graceUntil` still start at the original `currentPeriodEnd`, and **keep** the anchor. *Revision 1:* the direct activation
     operation is retired (B3); every first period is then established by a verified settlement.
  2. A month that does not have the anchor's day **clamps only that occurrence** to its last day. The anchor itself
     is never rewritten by a clamp.
  3. A later month or year that has the anchor's day **recovers** it: Jan 31 → Feb 28 → Mar 31 → Apr 30 → May 31, and
     Aug 31 → Sep 30 → Oct 31 → Nov 30 → Dec 31. Before this amendment each renewal added the interval to the previous,
     possibly clamped, end, so Jan 31 → Feb 28 → Mar 28 → Apr 28 ratcheted down for good and N monthly renewals did not
     equal one N-month purchase.
  4. A **genuinely late** renewal is one settled after the paid period *and* any grace window have fully elapsed
     (`now > (graceUntil ?? currentPeriodEnd)`, `isLateRenewal`). It starts at the settlement instant, as above, and
     **resets the anchor** to that instant. The old cadence is not resumed: with an old anchor on the 31st, a
     settlement on Apr 12 gives Apr 12 → May 12 → Jun 12 → Jul 12.
  5. **Day and week** prices keep start + interval, unchanged. They have no calendar-month cadence and no anchor
     (`billingAnchorAt` is NULL).
  6. **Leap years:** a Feb 29 anchor clamps to Feb 28 in non-leap years and recovers Feb 29 in the next leap year
     (yearly: Feb 29 2028 → Feb 28 2029 → Feb 28 2030 → Feb 28 2031 → Feb 29 2032).
  7. **`intervalCount > 1`** follows the same rule: each period ends `intervalCount` months (× 12 for a year) after the
     month the period starts in, on the anchor's day, clamped only in that month. Every 2 months from Jan 31 gives
     Mar 31 → May 31 → Jul 31 → Sep 30 → Nov 30 → Jan 31.

  Grace, cancellation and entitlement are unchanged: `graceUntil` is still the new period end plus
  `SUBSCRIPTION_GRACE_DAYS`, `cancelAtPeriodEnd` still acts on the stored `currentPeriodEnd` (which may be a clamped
  Feb 28 for a 31st anchor), and `deriveEntitlement` still reads only the stored boundaries. The anchor is stored
  because it cannot be derived: a period ending on the 28th cannot tell a 28th anchor from a clamped 29th, 30th or
  31st. The database guard allows it only on a non-pending monthly or yearly subscription, and only as the start of
  the new period that establishes it. Existing rows are backfilled with their `currentPeriodStart`, a deterministic
  fallback that cannot recover an anchor clamped before this amendment (Billing was not deployed to production).
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
  organization are all `valid: false`, never a 404 or a transport error. *Revision 1:* this route is unchanged; the separate
  personal read is B6 (B-021's reasoning applies within an Organization and still holds).
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
  Subscription is never derived directly from provider/gateway data. *Revision 1:* the recurring-obligation classification is
  replaced by the invoice's routing record (B2), and event acceptance additionally follows ADR-0057 §13.
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
  frontend/consuming-app subscription UX. *Revision 1:* B-017 stays deferred for the Organization Subscription only; the Personal
  Subscription's reversal is decided in B5.

### Part B — Revision 1: Personal Subscription and explicit settlement routing (proposed, not implemented)

- **B1. Target.** Every recurring product declares `platformId` and `subscriptionTarget ∈ {none, organization, personal}`,
  immutable after its first sale. The target is independent of `entitlementKind` (ADR-0045).
- **B2. Routing record.** When an invoice leaves `draft`, Billing records an immutable `invoice_entitlement` with a
  server-determined `purpose` and `target`:

  | purpose | target | payer | beneficiary | required reference |
  |---|---|---|---|---|
  | `organization_subscription` | `organization` | user | — | organization |
  | `direct_purchase` | `personal` | user (= beneficiary) | buyer | product |
  | `assisted_settlement` | `personal` | organization | consenting student | assistance request |
  | `recovery_settlement` | `none` | organization | — | recovery obligation |
  | `non_entitlement` | `none` | any | — | — |

  *Owner decision (Core V2 S3a, Option C):* `non_entitlement` is the routing of an ordinary invoice: it is allowed only when no line
  belongs to a subscription product (`subscriptionTarget` `organization` or `personal`) and the invoice is neither an assisted nor a
  recovery settlement; it never activates, renews or extends a subscription. With it, every newly issued invoice has exactly one
  routing record (DB-2 unchanged). Subscription products declare their Platform and have recurring prices only; ordinary products are
  `none`. Invoices issued before S3a are not backfilled: without a routing record they never change a subscription, and their
  routing is never derived from `entitlementKind`.

  *Owner decision (Core V2 S4a, P-1, 2026-10-26; prospective):* the `non_entitlement` payer is narrowed from "any" to **a user or a
  Company**: an Organization pays only `assisted_settlement` or `recovery_settlement` (B7, S0 DB-15, S-6). New `non_entitlement` routing
  records refuse an Organization payer; records written earlier are immutable and are not re-judged. Payment stores the routing purpose as
  its own immutable `purpose` and enforces the same pairing independently (register PAY-01 F). The rest of this table is unchanged.

  An invoice carries at most one entitlement-bearing line. A recovery invoice has exactly one line referencing its recovery
  obligation, no product, and an amount and currency copied from the obligation's outstanding amount; it never takes a
  client-supplied amount. Combination rules are same-row checks; consistency with the invoice payer, the product target, the
  assistance request and the recovery obligation is enforced by composite foreign keys; immutability by a row trigger and grants.
- **B3. Organization guard.** The Organization Subscription may start or extend a period only when the same transaction records a
  `subscription_settlement` whose `(invoiceId, purpose)` references an `organization_subscription` routing record (a deferred
  database check). Grace, expiry, cancellation and termination are unaffected. The direct activation and renewal operations without
  a settlement are retired.
- **B4. Personal Subscription.** One `PersonalSubscription` per (owner user, product), where the product belongs to exactly one
  Platform. Its validity follows an append-only purchase ledger: one `SubscriptionPurchase` per settled `direct_purchase` or
  `assisted_settlement` invoice (`UNIQUE(invoiceId)`, composite foreign key on `(invoiceId, purpose)`), with original span, paid
  duration, effective span and reversal references. It is portable across the Platform's Organizations; leaving or losing an
  Organization membership never revokes it. Buying it grants no Platform authorization and no membership. It has no grace window
  (B13.2).
- **B5. Reversal (K-3 Option D).** A reversal removes the reversed purchase's span and re-lays later paid periods with their full
  paid duration and no gaps; anchors are unchanged outside reversals. **At most one reversal per purchase.** Every cause (refund
  completion, direct final-lost chargeback) is appended separately; a second cause performs no entitlement change and opens
  reconciliation.
- **B6. Personal entitlement read.** `GET /billing/users/:userId/platforms/:platformId/products/:productId/entitlement`,
  service-token only, `200 { valid, expiresAt }`. Consumers treat an unavailable answer as not entitled.
- **B7. Payers.** An Organization may be the payer only for `assisted_settlement` or `recovery_settlement`; Payment enforces the
  same pairing independently. Payer, purpose, beneficiary, amount, currency and seller are immutable once a payment is requested.
- **B8. Recovery settlement.** A recovery obligation may have many historical invoices but at most one open or uncertain settlement
  channel; a new channel opens only after the previous one is definitively closed, for the then-outstanding amount and the
  obligation's currency. Every verified success, including a late success after cancellation or expiry, is recorded as a
  `RecoveryPayment` of the verified captured amount. The obligation is recovered when verified recoveries reach the base amount. Any
  excess is recorded as a surplus owed to the school, never as revenue or loss, and is resolved by a full refund of an entirely
  surplus payment or by evidenced external repayment confirmed by the school. Electronic partial refunds are deferred, and that
  deferral does not limit the repayment obligation. A recovery payment never creates a purchase and never activates, renews,
  extends or reverses any entitlement. New Pay with School requests remain blocked until verified recovery of the base amount is
  complete.
- **B9. Malformed or ambiguous invoices.** Refused at issue. If settled money nevertheless reaches an invoice whose routing is
  missing or inconsistent, no entitlement changes and Billing opens a reconciliation case.
- **B10. Chargebacks.** A provisional dispute never changes entitlement. A direct purchase lost at final stage is reversed under B5
  and written off, with no debt and no ban. An assisted purchase lost at final stage keeps the student's entitlement, opens a school
  recovery obligation for the base amount only (Nawara absorbs provider and chargeback fees), and blocks new Pay with School
  requests for that Organization until recovery.
- **B11. Losses require evidence.** A reversal cause alone never creates a `FinancialLoss`. A loss is recorded only from recorded
  provider facts that show money not retained (an over-return, a direct final-lost chargeback write-off) or from an owner write-off
  of an unrecoverable recovery obligation; later corrective facts append adjustments. Reconciliation may be opened without a loss.
- **B12. Events.** `billing.subscription.*` events are produced only by B3 and B4/B5 effects; recovery produces only
  `billing.recovery.*`. All are idempotent by deterministic identity.
- **B13. Core V2 grace policy.**
  1. An Organization Subscription period has exactly **24 hours** of grace after `currentPeriodEnd`:
     `graceUntil = currentPeriodEnd + interval '24 hours'`, computed in UTC in the same statement that establishes the period and
     frozen for that period.
  2. A Personal Subscription has **no grace**; access ends at the end of its effective span.
  3. The V1 configuration `SUBSCRIPTION_GRACE_DAYS` (optional, 1–365 days) does not satisfy B13.1 when unset or other than 1. Core
     V2 replaces it with the fixed policy; it is not configurable per deployment.
- **B14. Assisted settlement uniqueness and late success.** An assistance request yields at most one purchase. A verified success on
  a settlement channel that was already definitively closed, or for a request that already has a purchase or whose cash return is
  confirmed, is recorded, creates no purchase and opens reconciliation. The default resolution is a full refund of that payment to
  the school's original method. The owner may instead apply that payment as the request's single purchase only when all of the
  following hold: (1) an explicit owner authorization with factor step-up; (2) an affirmative student attestation that the school's
  cash was not returned, or reliable independent evidence establishing that it was not returned; (3) verification that no
  `SubscriptionPurchase` already exists for the assistance request; (4) verification that the cash-return obligation has not been
  confirmed as returned; (5) an auditable decision recording the reason code and the supporting evidence. Contradictory, unreliable
  or insufficient evidence means the case stays in reconciliation, and no entitlement activation is permitted. When the exception
  applies, the cash-return obligation closes as superseded by settlement, recorded violations are kept, and restrictions clear only
  as their own rules allow.

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
  requires new implementation. *Revision 1:* that statement holds for Part A only. **Part B requires implementation** (Billing
  routing, ledger and recovery schema; retiring the direct activation and renewal operations before the deferred guard; the fixed
  grace policy of B13; Payment's payer and purpose checks) under separate authorization, and the Billing SDD and the financial
  architecture need the matching updates. Billing is not in production; backfills refuse on ambiguity rather than infer.
- *Revision 1:* no settlement can reach the wrong entitlement, and personal access survives Organization changes; in exchange there
  are two entitlement shapes and a routing record to maintain. The enforceable constraints, recovery and assisted late-settlement
  rules and certification criteria are in the [S0 record](../architecture/core-v2-s0-architecture-freeze.md).

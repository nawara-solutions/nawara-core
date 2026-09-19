# 0007. Out-of-band cash payment confirmation via Admin role

- **Status:** Accepted
- **Date:** 2026-09-16
- **Deciders:** Anwar (project owner)

> **Forward note (2026-09-19):** the cash flow is kept, but the actor model changes from a platform-scoped "Admin" to the invoice **seller's** authority, and cash becomes a payment method in payment-service ([ADR-0035](./0035-financial-service-boundaries.md), [ADR-0036](./0036-money-parties-and-source-references.md)); the authority rules are a proposed policy (open decision 7 in [financial-architecture.md](../architecture/financial-architecture.md)).

## Context

`payment-service`'s `Charge` model (per `CLAUDE.md`) is gateway-agnostic in principle, but
today it only actually recognizes the four gateway providers (`flouci | konnect | paymee |
stripe`) — every `Charge` is assumed to have been paid through one of them. In practice, some
organizations and users pay in cash, entirely outside any of those gateways: no gateway ever
sees the money change hands, so nothing calls back into `payment-service` to confirm it, and
there is currently no `Charge` shape, endpoint, or lifecycle that can represent "this was paid,
but a human needs to say so" rather than "a gateway said so."

`payment-service` has zero authenticated endpoints today — both existing endpoints
(`GET /payment/licenses/:organizationId/status`, `GET /payment/subscriptions/:userId/status`)
are unauthenticated, internal, service-to-service reads (see `docs/sdd/payment-service.md`'s API
contract). The platform's own `Admin` role is a generic `role: "admin"` `User` account,
provisioned out-of-band with no dashboard or UI anywhere in this repo (an admin dashboard is a
`nawara-drive`-specific concept, out of scope for `nawara-core` per `CLAUDE.md`); `ADR-0004`
already established the precedent that this Admin user is the one who acts on an organization's
behalf after it pays, by generating that organization's license. The purchase/checkout flow that
turns a successful `Charge` into a `License`/`UserSubscription` row is itself still undesigned
(flagged as an open question in both `docs/add/payment-service.md` and
`docs/sdd/payment-service.md`) — this decision doesn't solve that, but it does need to name it as
a now-shared dependency, since a confirmed cash `Charge` needs to feed the same issuance step a
confirmed gateway `Charge` eventually will.

## Options considered

1. **Require an uploaded receipt/proof-of-payment as part of the cash request**, which the
   Admin would review before confirming. Rejected: no file-storage infrastructure exists
   anywhere in this repo, and it was explicitly decided, with the human stakeholder, that a
   `productId` reference plus the requesting organization's identity is sufficient trust for a
   v1 — not a document upload.
2. **Fully automatic, self-service confirmation with no Admin gate** — the organization submits
   a cash-payment record and it's immediately treated as paid, no human review. Rejected: unlike
   a gateway charge, a cash payment has no independent verification signal — no third party ever
   confirms the money actually moved — so removing the human trust boundary entirely would let
   any caller grant themselves a license or subscription for free.
3. **Trust-based Admin confirmation via role-gated endpoints, no proof upload (chosen).** The
   organization submits a cash-payment request referencing a `Product`; the platform's Admin
   reviews and explicitly confirms or rejects it. This mirrors `ADR-0004`'s existing precedent of
   the Admin acting as the trust boundary for an organization's payment, without requiring any
   new infrastructure (file storage, a review UI) this repo doesn't have.

## Decision

We chose **Option 3**. Concretely:

- `Charge` gets a new `method: "gateway" | "cash"` field. `gatewayProvider`/`gatewayReference`
  become nullable, required if and only if `method = 'gateway'`, and null if and only if
  `method = 'cash'`.
- `Charge` gets a new `submittedByUserId: uuid | null` — the org-side caller who submitted the
  cash request. This is distinct from the existing `payerId` (whoever the resulting
  `License`/`UserSubscription` is *for*): for an `individual_subscription` cash request, the
  organization submits the request on behalf of a different user (the beneficiary), so the two
  fields diverge. For an `org_license` request they're typically the same person, but the field
  is still populated explicitly rather than inferred.
- No new `Charge.status` values. Cash charges use the existing `pending → succeeded` (Admin
  confirms) or `pending → failed` (Admin rejects) lifecycle — the same enum a declined gateway
  charge already uses.
- **`POST /payment/charges/cash`** — the organization submits a cash-payment request. Auth: any
  caller whose JWT `organizationId` claim matches the org being billed — deliberately no extra
  "org-admin" role, consistent with `ADR-0006`'s precedent that "`payment-service` only ever
  observes [whether a row exists], never why; role eligibility is a consuming-app decision."
  Body: `{ productId, beneficiaryUserId? }` — `beneficiaryUserId` is required if and only if the
  referenced `Product.type === 'individual_subscription'`; supplying it for an `org_license`
  product is rejected (400), as is referencing a `one_time`-type product (out of scope for this
  decision). Creates a `Charge` with `method = 'cash'`, `status = 'pending'`, `organizationId`/
  `payerId` set appropriately, and `submittedByUserId` set to the caller's own `userId`; amount
  and currency are copied from the `Product`. Publishes a new event `charge.cash_requested =
  { chargeId, productId, organizationId, payerId, submittedByUserId, amount, currency,
  timestamp }`.
- **`POST /payment/charges/:chargeId/cash/confirm`** — Admin-only (`role: admin`). Returns `409`
  unless the charge is `method = 'cash' && status = 'pending'`. Sets `status = 'succeeded'`, then
  hands off to the still-undesigned "successful `Charge` → `License`/`UserSubscription` issuance"
  mechanism, which is explicitly out of scope here — this decision flags it as a dependency now
  shared between the still-hypothetical gateway purchase flow and this cash flow, rather than
  designing it. That mechanism must set `License.type = 'standard'` (see `ADR-0008`) on the
  resulting write.
- **`POST /payment/charges/:chargeId/cash/reject`** — same auth as confirm, same `409`
  precondition, sets `status = 'failed'`. This is a small addition beyond the literal
  confirmation request: without it, a bad or fraudulent cash request would sit `pending`
  indefinitely with no way to close it out.
- **`GET /payment/charges?method=cash&status=pending`** — Admin-only listing. Needed because no
  admin dashboard exists anywhere in this repo (per `CLAUDE.md`); without this endpoint the
  Admin would have no way to discover pending cash requests beyond whatever consumes the
  `charge.cash_requested` event directly.
- All three Admin-only endpoints require a `RolesGuard`/JWT-verification capability that does not
  exist in `payment-service` today — see Consequences.

## Consequences

- `payment-service` gains its first authenticated endpoints. It has no JWT verification or
  `RolesGuard` today (unlike `auth-service`, which already has both — see
  `docs/add/auth-service.md`'s "RBAC guards (`RolesGuard`)" component), so building that
  capability becomes a blocking dependency of this decision, not an optional hardening step.
- That capability needs the JWT signing secret/key to verify tokens locally, and
  `docs/add/auth-service.md`'s existing "No secret-distribution mechanism yet" gap ("there is
  currently no mechanism anywhere in this repo for distributing the JWT signing secret/key to
  other services... that might want to verify tokens locally") — previously flagged only as a
  hypothetical future-service problem — now concretely blocks `payment-service`, not just a
  theoretical consumer.
- The cash-confirmation `Charge → License/UserSubscription` issuance hand-off is explicitly not
  designed by this ADR. It is now a shared dependency of two flows (gateway purchase and cash
  confirmation) instead of one, which raises the cost of continuing to leave it undesigned —
  flagged as an open question in `docs/add/payment-service.md` and `docs/sdd/payment-service.md`.
- No proof-of-payment/receipt is required or stored anywhere in this flow. The trust boundary is
  entirely the Admin's own judgment when confirming or rejecting — this is a deliberate, accepted
  risk (see Options considered), not an oversight; revisiting it would need file-storage
  infrastructure this repo doesn't have.
- Cash charges reuse the existing `Charge.status` enum rather than adding new states, so any
  future reporting/reconciliation logic written against `status` doesn't need to special-case
  `method = 'cash'` — only the confirm/reject endpoints care about the distinction.
- Adds a new small surface for `payment-service` to get wrong: the `beneficiaryUserId`/
  `Product.type` validation on `POST /payment/charges/cash` needs to be enforced server-side on
  every request, since it's the only guard against, e.g., a cash request silently being submitted
  for a `one_time` product this decision doesn't cover.

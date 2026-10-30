# 0067. Auth authorization receipts for owner-approved refunds

- **Status:** Proposed <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-10-21
- **Deciders:** Anwar (project owner, architecture owner)

> **Core V2 S0 (2026-10-21).** The architecture owner approved this decision's direction (P0 decision C-1) and its wording at the Core
> V2 S0 freeze ([S0 record](../architecture/core-v2-s0-architecture-freeze.md)). That is not an acceptance of this ADR: its status
> stays `Proposed` until the owner changes it explicitly. Nothing in it is implemented. Number 0066 is skipped here because a draft
> ADR-0066 exists on an unmerged branch; numbering is re-checked when this ADR is merged.

## Context

Refunds of Nawara-sold Premium are owner-only, require a factor step-up, and go back to the original payment method (approved Core V2
commercial rules). The refund is decided in billing-service (a refund case) and executed by payment-service (provider refund).
payment-service must therefore know, for each refund it executes, that the Company owner approved exactly that refund: this case,
this payment, this amount, this currency.

The existing mechanisms do not provide that proof:

- A step-up token (ADR-0025, ADR-0042 Amendment 1) is single-use, purpose-bound and verified by the service the owner calls; it does
  not bind an amount or a target, and it is consumed by the first verifier.
- Forwarding the owner's bearer from billing-service to payment-service would turn a reusable credential into service-to-service
  authority, which ADR-0050 rules out (verified human authority through Auth, no delegation).
- auth-service has no service-callee route today; every Auth route is called by a human or a public flow.

## Options considered

1. **Forward the owner's bearer or step-up token to payment-service.** Rejected: a reusable or unbound credential leaves Auth's
   verification, and nothing binds the amount.
2. **Billing asserts the approval to Payment with its service token.** Rejected: a Billing token alone would be able to move money
   out.
3. **An Auth-issued, purpose-bound, single-use authorization receipt, consumed by its named audience (chosen).**

## Decision

1. **Issue.** auth-service issues a receipt to the active Owner of a Company after a factor step-up for purpose `refund.authorize`
   (TOTP or passkey; never the secret key). The binding is `{operation: 'refund', audience: 'payment-service', companyId,
   refundCaseId, paymentId, amount, currency, reason, legalOverride}`; `companyId` must equal the Owner's Company. The receipt lives
   10 minutes. Auth stores only digests of the secret and of the canonical binding, the issuer and the session; the plaintext secret
   is returned once and never stored.
2. **Lost issuance response.** The issue request carries an idempotency key. A replay with the same key voids the receipt **only
   while it is `issued`** and answers `409 receipt_issued_response_lost`; the Owner then issues a new receipt with a new step-up. A
   consumed receipt is never voided: its replay answers `409 receipt_already_consumed`, without the secret.
3. **Consume.** Only the bound audience may consume, through a new deny-by-default `AUTH_SERVICE_POLICY` (Auth's first
   service-callee route). Consumption is one conditional update that requires matching digests, status `issued`, an unexpired
   receipt, and an issuer who is still active and still the Owner of `companyId`. It is idempotent on a caller-supplied `consumeRef`;
   a different `consumeRef` on a consumed receipt answers `409`. A lookup by `consumeRef` lets the consumer recover a lost response
   without the secret.
4. **Commit point.** Consumption is the authorization commit point. A later loss of the Owner's authority does not cancel a consumed
   authorization; before consumption it refuses it (`authority_revoked`).
5. **Synchronous acceptance.** billing-service relays the secret in memory only and never persists it. payment-service first commits
   a durable refund intent whose `consumeRef` is the refund attempt's id, then consumes the receipt, then commits `authorized` and
   answers. Provider dispatch is asynchronous, from the durable intent, with a stable provider idempotency key. A crash between these
   steps is recovered through the `consumeRef` lookup; an unconsumed, expired receipt leaves the intent `authorization_expired` and
   the case awaiting a new authorization.
6. **Scope of a refund.** A refund case is `full_purchase`, or a full refund of a payment that produced no entitlement; partial-amount
   refunds are deferred in Core V2. A definitive provider failure ends the attempt, and a further attempt requires a new receipt. A
   completed refund case never accepts a new attempt. No new refund case may be opened while a dispute on the payment is open.
7. **Audit.** auth-service records issuance, consumption and voiding as audit actions; payment-service records `approvedBy` from
   Auth's consumption response (verified actor), never from a request body.

## Consequences

- payment-service can prove owner approval of every refund without any reusable human credential leaving Auth.
- auth-service gains its first service-callee route and policy (`AUTH_SERVICE_POLICY`), a receipts table (new; no existing row
  changes) and a step-up purpose; payment-service gains the durable intent and recovery path.
- payment-service becomes a service caller of auth-service; its admission is recorded with the other service-token admissions
  (ADR-0042) when the policy is implemented.
- The 10-minute lifetime covers only the synchronous chain; asynchronous work runs on the consumed authorization.
- Follow-up: implementation and certification under separate authorization (S0 record, stage S2 for Auth and S6 for refunds); the
  financial architecture document needs the matching update.

## Amendment (Core V2 S6h R6H-5, the Owner's decision, 2026-10-30)

The decision 1 binding gains one optional field, `captureFactId`: the verified capture fact a capture-specific FULL refund returns. It is
absent (never null) for an ordinary refund, so every ordinary receipt's canonical form and digests are unchanged; when present it is part
of the canonical binding, so a receipt for one capture can never authorize an ordinary refund or another capture, nor the reverse. Purpose,
lifetime, consumption and recovery are unchanged. Contract: `docs/architecture/core-v2-d-a2-auth-authorization-receipts.md` §17f.

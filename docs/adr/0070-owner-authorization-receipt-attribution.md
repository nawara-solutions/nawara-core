# 0070. Owner authorization receipt attribution in the central audit (successor to ADR-0067 for the general mechanism)

- **Status:** Proposed <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-11-22
- **Deciders:** Anwar (project owner, architecture owner)

> **Core V2 F-22 / G6-B (2026-11-22).** The architecture owner approved this decision's direction and scope (D-F22-1 to D-F22-6). That
> is not an acceptance of this ADR: its status stays `Proposed` until the owner changes it explicitly. It **does not edit**
> [ADR-0067](./0067-auth-authorization-receipts-for-owner-approved-refunds.md), which remains the refund-specific decision with its
> approved policy unchanged; this ADR governs what ADR-0067's text does not cover (F-22): the general receipt mechanism's central
> audit attribution (DO-62). It builds on [ADR-0069](./0069-verified-audit-producers-and-audit-contract-v2.md) (contract version 2,
> verified producers, trusted Company scope). It is implemented for Core V2 development and simulation only, in two changes merged by
> the owner in this order: the audit contract (Audit accepts and validates the attribution, #542) BEFORE the Auth producer (Auth emits
> it, #543); main `1863196`, automatic full CI 45157636086 (32/32). Nothing is deployed and nothing is production-certified.
>
> **Closure for development and simulation (2026-11-23).** The owner closed F-22 and DO-62 for development and simulation only, on the
> evidence recorded in [core-v2-s0-architecture-freeze.md](../architecture/core-v2-s0-architecture-freeze.md) §1.5 (DO-62). That closure
> does not change this ADR's status (`Proposed`), ADR-0067's status, or any other open item.

## Context

Auth issues **ten** single-use, Owner-approved authorization receipt operations, each approved in the receipts contract
([core-v2-d-a2-auth-authorization-receipts.md](../architecture/core-v2-d-a2-auth-authorization-receipts.md) §5 to §17g) and each
bound to exactly one consumer audience by Auth's binding grammar (`apps/auth-service/src/receipts/receipt-binding.ts`, rule F-7).
ADR-0067's text describes only the first (`refund`, consumed by `payment-service`); billing-service is the second audience
(ADR-0067 Amendment 1, descriptive; the operation and audience table is in
[core-v2-g8-adr-governance-status.md](../architecture/core-v2-g8-adr-governance-status.md) §2).

The central audit actions `authorization_receipt.issued`, `.consumed` and `.voided` (ADR-0067 decision 7; S2-Audit.2) carry the
receipt id, the Company from Auth's own Owner row, the actor and, on the consumption, the verified approver, but **no change facts**:
the central record cannot say which operation was approved, for which target, or which consumer action used the receipt (DO-62;
the related approved deferral is F-24). Auth itself stores only digests of the binding, so the audit record is the only central
place this can be stated.

Two constraints shape the answer. Version-2 receipt events already exist (outbox rows, stored records, dead-letter replays) and must
stay valid. And the Owner's earlier decision R6B-7 keeps the receipt out of Payment's refund events: Payment's
`refund_attempt.authorized` names the attempt, its payment and its case, never the receipt.

## Options considered

1. **Amend ADR-0067 to cover the general mechanism.** Rejected (D-F22-1): it would rewrite an approved refund decision.
2. **Add `receipt_id` to every consumer's audit events.** Rejected (D-F22-4): it reverses R6B-7 for refunds and changes ten
   consumer contracts to state what Auth already knows at the consumption.
3. **A new contract version 3 with attribution required.** Rejected (D-F22-3): it adds a version for three actions and still
   needs version 2 kept for every existing event.
4. **Optional attribution facts on the three existing version-2 actions, validated as one tuple, emitted by Auth from its verified
   binding (chosen).**

## Decision

1. **Successor, not amendment.** This ADR governs the attribution of every Owner authorization receipt operation in the central
   audit. ADR-0067 is unchanged and remains the refund decision; its title, text, status and approved policy are not edited.

2. **The attribution tuple.** `authorization_receipt.issued`, `.consumed` and `.voided` may carry, in `changes`:
   `operation` (one of the ten codes), `target_type` and `target_id` (the binding identifier that names what the Owner approved).
   `authorization_receipt.consumed` also carries `consume_ref`, the consumer's own reference that Auth records on the receipt row in
   the consuming statement. `consume_ref` is refused on `.issued` and `.voided`. Nothing else of the binding travels: no amount,
   currency, reason, beneficiary, Organization, payment, secret or digest.

3. **The operation matrix** (a restatement of Auth's binding grammar; this ADR creates no operation, audience or permission):

   | Operation | Step-up purpose | Audience (the only consumer) | `target_type` | `target_id` (binding field) |
   |---|---|---|---|---|
   | `refund` | `refund.authorize` | payment-service | `refund_case` | `refundCaseId` |
   | `dispute_decision` | `payment.dispute.decide` | payment-service | `payment_dispute` | `disputeId` |
   | `provider_fact_associate` | `payment.provider_fact.associate` | payment-service | `provider_transaction_fact` | `factId` |
   | `fraud_hold_place` | `billing.fraud_hold.place` | billing-service | `fraud_hold` | `holdId` |
   | `fraud_hold_release` | `billing.fraud_hold.release` | billing-service | `fraud_hold` | `holdId` |
   | `recovery_surplus_external` | `billing.recovery_surplus.record_external` | billing-service | `recovery_surplus` | `surplusId` |
   | `late_settlement_apply` | `billing.late_settlement.apply` | billing-service | `assistance_late_settlement` | `lateSettlementId` |
   | `recovery_write_off` | `billing.recovery.write_off` | billing-service | `recovery_obligation` | `obligationId` |
   | `recovery_restriction_suspend` | `billing.recovery_restriction.suspend` | billing-service | `recovery_restriction_suspension` | `suspensionId` |
   | `recovery_restriction_revoke` | `billing.recovery_restriction.revoke` | billing-service | `recovery_restriction_suspension` | `suspensionId` |

   `target_type` is the Audit resource type of the same entity where Audit has one; a recovery-restriction suspension has no Audit
   resource of its own and is named as Billing records it. (Verification against the code refined two names of the reviewed F-22
   design: `late_settlement` became `assistance_late_settlement`, the existing Audit resource type, and `recovery_suspension`
   became `recovery_restriction_suspension`, Billing's record; no operation, audience or field changed.)

4. **Validation (Audit, the one validator).** None of the tuple, or all of it. When present: a known operation, exactly its
   `target_type`, a canonical UUID `target_id` and, on `.consumed`, a `consume_ref` and a service actor that is exactly the
   operation's audience. Partial or contradictory attribution is refused (`invalid_changes`) before anything is stored. The producer
   rule (auth-service only), the required Company scope from Auth's Owner row, `approvedBy` (consumption only), the actor rules and
   every version-1 behavior are unchanged. Trusted scope still requires a broker-verified producer (ADR-0069 decision 4): an
   unverified delivery is stored, never trusted.

5. **Compatibility (D-F22-3).** The facts are optional in the catalog. A version-2 receipt event written before attribution (no
   `changes`) stays valid and is stored unattributed; old Audit evidence is never upgraded or rewritten. Version-1 behavior is
   unchanged. Completeness of new events is the producer's duty, enforced by Auth's tests: every receipt event Auth writes carries
   the complete tuple.

6. **Provenance (the producer, Auth).** Auth takes the attribution only from a binding it parsed and verified itself, never from an
   audit payload or any other request field: at issue, the binding the Owner approved after the operation's own factor-only
   step-up; at consumption, the binding whose digest the consuming statement matched, for the authenticated caller that must equal
   the binding's audience (F-7); at the automatic void, the replaying request's binding, whose request hash (an HMAC of the
   canonical binding, immutable on the row) the voiding statement itself requires equal to the receipt's.

7. **Linkage.** The refund link is `consume_ref`: Payment uses the refund attempt id as the receipt's `consumeRef`, and that id is
   the resource of Payment's own `refund_attempt.authorized`, whose `refund_case_id` equals the receipt's `target_id`. R6B-7 is kept:
   Payment's refund events never name the receipt (D-F22-4). For the other nine operations, `consume_ref` and `target_id` are not
   interchangeable and are linked per operation:

   | Operation | Consumer's `consumeRef` | Consumer audit record naming the target |
   |---|---|---|
   | `refund` | the refund attempt id | `refund_attempt.authorized` resource = `consume_ref`; its `refund_case_id` = `target_id` |
   | `dispute_decision` | Payment's decision intent id | `payment_dispute.decided` resource = `target_id` |
   | `provider_fact_associate` | Payment's association intent id | `provider_fact.associated` resource = `target_id` |
   | `fraud_hold_place` | the hold id (= `target_id`) | `fraud_hold.placed` resource = `target_id` |
   | `fraud_hold_release` | a reference derived from the hold id | `fraud_hold.released` resource = `target_id` |
   | `recovery_surplus_external` | a reference derived from the surplus and the secret | `recovery_surplus.resolved` resource = `target_id` |
   | `late_settlement_apply` | a reference derived from the late settlement and the secret | `assistance_late_settlement.applied` resource = `target_id` |
   | `recovery_write_off` | a reference derived from the obligation and the secret | `recovery_obligation.written_off` resource = `target_id` |
   | `recovery_restriction_suspend` | the suspension id (= `target_id`) | `recovery_restriction.suspended` change `suspension_id` = `target_id` |
   | `recovery_restriction_revoke` | a reference derived from the suspension id | `recovery_restriction.suspension_revoked` change `suspension_id` = `target_id` |

8. **Isolation.** The receipt records keep only the Company scope (the issuing Owner's Company, from Auth's row); no Platform and no
   Organization scope is asserted, and Organization identifiers in a binding never travel (F7 Organization authority stays gated).

9. **Release order (D-F22-5).** In any rollout, audit-service must accept the attribution (the audit contract change) **before** Auth
   emits it: the validator refuses undeclared change facts, so an attributed event reaching an older Audit would be refused and
   dead-lettered. This is an order only; no deployment or activation is authorized by this ADR.

## Consequences

- The central audit can say, for every receipt, which operation and target the Owner approved and, for a consumption, which
  consumer reference used it; Audit refuses attribution that contradicts Auth's operation matrix or the consuming audience.
- Old receipt records stay unattributed forever: the attribution is evidence from its introduction onward only.
- No financial state, balance, authorization outcome, step-up, receipt rule or Payment or Billing event changes; no migration.
- The two implementation changes ship in order (audit contract, then Auth). The other nine operations' consumer links are stated
  here from the consumers' code; refund's link is proven end to end over the real broker.
- F-24 (an Owner timeline of financial actions) and every other open item (DO-62's acceptance, R3-F2, F-29, DO-43, DO-59 to DO-61,
  DO-65, DO-66, DO-76, DO-77, OD-RLSC-1) are unchanged by this ADR.

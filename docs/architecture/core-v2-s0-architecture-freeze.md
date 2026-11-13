# Core V2 S0: architecture freeze record

- **Status:** S0 architecture freeze, recorded 2026-10-21 under the architecture owner's S0-DOC authorization (documentation only).
- **Scope:** the eight Core services: Auth, Organization, Billing, Payment, File, Notification, Audit, Release.
- **What this record is:** the approved Core V2 architecture direction, the frozen ADR wording, the contract and safeguard registers,
  the explicit deferrals and the implementation gates, consolidated from the AR-04 architecture review (AR-04.1 to AR-04.6 and the S0
  packages).
- **What it is not:** an implementation authorization, an ADR acceptance, a production change or a certification. **Nothing in this
  record is implemented.** Every implementation stage, every production action and every ADR status change needs its own explicit
  owner authorization.

Labels used below: **[INV]** approved business invariant (earlier rounds); **[DIR]** approved P0 architecture direction;
**[OD]** pre-freeze owner decisions D1–D8; **[S0]** approved at the S0 freeze; **[DEF]** deferred; **[GATE]** decided at a named
implementation gate. Labels such as C-1 to C-6, D-1 to D-6, R-6a and AR-04.x refer to the Core V2 architecture-review
conversation packages, which are not stored in the repository; the decisions they carry are restated here. DB-n are the
database-enforcement rows of §3.2 (distinct from ADR-0035's clarifications C1–C4). Approval of a direction or of wording is not approval of a concrete route, table or migration name; those are
specifications to be confirmed during implementation review.

## 1. Approved decisions

### 1.1 Business invariants [INV]

- Nawara is the seller. Personal Premium subscriptions are owned by the named user, scoped to user + Platform + subscription product,
  may coexist per user and Platform, and are portable across that Platform's Organizations. Direct checkout carries no school fee.
- Pay with School: student-initiated with consent; the school collects the base price plus an optional, approved, student-funded fee
  (≥ 0); the school pays Nawara the full base price electronically; Nawara absorbs provider fees. Verified settlement activates; cash
  alone never activates. No wallets, seats or manual settlement confirmation. 72 hours after physical cash collection the school must
  have settled, or must return the full cash including its fee.
- Refunds: owner-only with factor step-up, to the original method; an assisted refund returns the base price to the school's card and
  the school owes the student the full cash.
- Chargebacks: a provisional dispute never cancels Premium; a direct purchase lost at final stage reverses only that purchase (no debt,
  no ban, write-off recorded); an assisted purchase lost at final stage keeps the student protected, opens a school recovery
  obligation and blocks new Pay with School (T3). Fraud holds are evidence-based, owner step-up, 14-day review, exact-duration
  compensation; the owner decides contest or accept.
- **K-3 Option D:** a reversal removes the reversed purchase's span and re-lays later paid periods with their full paid duration and
  no gaps; anchors are unchanged outside reversals.
- Fees: the owner sets caps and approves; delegated operators propose; operators never approve in Core V2. One currency per Platform
  (TND first). K-3 Option D. Core V2 is implemented and certified against a simulation provider only. No second checkout while a
  payment is uncertain.

### 1.2 P0 architecture directions [DIR]

| Id | Direction |
|---|---|
| C-2 | Personal Subscription, separate purchase ledger, explicit settlement-target routing, Organization payer for approved assisted purchases |
| D-1 | Local development and simulation Organization authority is separate from production; existing production authority and the G6 / F7 gates are unchanged |
| C-1 | Auth-issued, exact-binding, single-use refund authorization receipts ([ADR-0067](../adr/0067-auth-authorization-receipts-for-owner-approved-refunds.md)) |
| D-2 / D-3 | Broker-verified producer identity, restricted topic permissions, durable provenance-based retry and replay ([ADR-0057](../adr/0057-messaging-conventions.md) §13) |
| D-6 | Actual physical cash collection anchors the 72-hour deadline; separate server report time; open student dispute rights; auditable corrections |
| T1 / T2 | New Pay with School requests are blocked while an overdue settlement (T1) or an overdue cash return (T2) is unresolved; existing payment and cash-return paths stay available |

### 1.3 Pre-freeze owner decisions [OD]

| Id | Decision |
|---|---|
| D1 | No manual or trust-based cash settlement for Nawara-sold products ([ADR-0068](../adr/0068-no-cash-settlement-for-nawara-sold-products.md)); cash for other sellers deferred |
| D2 | Any authenticated, active, eligible member may buy an available Platform-scoped personal Premium product without school membership; the purchase grants no Platform authorization or membership |
| D3 | No new refund case while a payment dispute is open; existing refund attempts continue through reconciliation; no financial fact is discarded |
| D4 | Full-purchase refunds only in initial Core V2; partial-amount refunds deferred; unexpected partial provider outcomes are still recorded and reconciled |
| D5 | Assisted chargeback recovery is the base amount only; Nawara absorbs provider and chargeback fees |
| D6 | No new Pay with School requests while the Organization is inactive; settlement, full cash return, disputes, reconciliation and recovery remain dischargeable *(S0-C14 item 7: on one obligation, a NEW recovery settlement channel is refused during a refund and chargeback overlap; channels already started and the recording of verified money stay)* |
| D7 | Money-command idempotency retention (class M) of 90 days, backed by permanent business and financial uniqueness |
| D8 | The AR-04.6 technical direction, subject to the safeguards of §4 |

### 1.4 Approved at the S0 freeze [S0]

The architecture owner **explicitly approved** the following as normative S0 decisions (2026-10-21); they are not pending
recommendations:

- Safeguards V-1, V-2, V-3 and S-4 to S-9 (§4).
- Recovery settlement with `subscriptionTarget = none`, never creating or changing a subscription.
- `FinancialLoss` only from provider-fact evidence or a separately authorized write-off.
- **Organization Subscription grace: exactly 24 hours. Personal Subscription grace: none.**
- Late assisted settlement L-1 to L-6 (§3.4), including L-4's evidence requirements.
- The over-recovery rules R-1 to R-5 (§3.5), including the surplus liability owed to the school and its repayment rules.
- Every other business and architecture decision recorded in §1.1 to §1.3 and in this record.

This is approval of the architecture, not an implementation authorization: every implementation stage, production action and ADR
status change still needs its own explicit owner authorization.

### 1.5 Post-freeze clarifications and revisions [S0-C]

- **S0-C1 Audit admission before provenance (2026-10-23, owner-approved).** [ADR-0057](../adr/0057-messaging-conventions.md) §13.2
  ("Audit admission"), with cross-references in §13.4 and §13.8. Before provenance, the Audit consumer refuses permanently, with no
  handler, no `Q.retry`, no provenance row and no persistent body digest, any delivery whose bytes are not canonical, that fails the
  Stage 18.8 confidentiality screen, or that fails the complete applicable audit-contract validation; this applies through the event
  exchange and the default exchange alike. Producer verification still comes only from the broker `user_id` and the catalog owner. A
  refused delivery is never a verified replay; recovering one needs a separately authorized mechanism consistent with §13.7. Audit
  provenance retention follows the open P-A2 decision behind the production gate AP-R of the
  [execution roadmap](./core-v2-s-execution-roadmap.md) §7. Safeguard S-8, the provenance tuple, §13.3 and every other consumer are
  unchanged. This is a clarification of the frozen wording, not an implementation authorization or an ADR status change.
- **S0-C2 Notification keyed body commitment (2026-10-23, owner-approved normative revision).**
  [ADR-0057](../adr/0057-messaging-conventions.md) §13.2 ("S0-C2"), with consequences in §13.3, §13.4 and §13.8. For the Notification
  consumer only, and for all nine Auth events it consumes, the body element of the provenance tuple is `bodyMac`, an HMAC-SHA-256 of the
  complete raw body bytes under a dedicated Notification provenance key (`bodyMacKeyId`, `bodyCommitmentVersion`), instead of the
  unkeyed `bodySha256`, which would let a reader of Notification's database recover the six-digit codes three of those events carry.
  Notification never stores an unkeyed body digest; a comparison is made under the stored row's key, so a rotation never creates a false
  conflict; a missing or unusable key fails closed (§13.3); a retired key makes its rows unverifiable, never a verified replay; each key
  is kept at least for the §13.8 minimum. Billing, Audit (S0-C1), every other consumer, the event contracts and safeguard S-8 are
  unchanged. This revises the frozen wording for one consumer; it is not an implementation authorization, a key or secret provisioning,
  or an ADR status change.
- **S0-C3 Replay verification rollout (2026-10-23, owner-approved clarification).** [ADR-0057](../adr/0057-messaging-conventions.md)
  §13.4 ("S0-C3"), with notes in §13.2 (S0-C2), §13.7 and §13.8. The §13.4 rule stays the mandatory end state. S1c computes a closed-set
  replay classification (`replay_matched_verified`, `replay_matched_unverified`, `replay_no_provenance`, `replay_mismatch`,
  `replay_unverifiable`, `replay_lookup_failure`) in observe-only mode, with no new refusal and no change to any consumer's acceptance;
  S1e alone enforces it, per consumer, under a separately approved policy, and financial consumers enforce before their production
  activation (§13.5, §13.10). The `source` header and message id are lookup keys, never identity; a match with an unverified original
  stays unverified; conflict evidence never verifies a replay; a later conflicting observation does not invalidate a verified original;
  a verification failure is never a verification. Notification conflict evidence records `differs` or `unverifiable` (a retired key is
  never evidence of changed content), through an additive migration with S1c. Re-emission (§13.7) waits for OD-15. Safeguard S-8, S0-C1,
  S0-C2's commitment and every financial invariant are unchanged. This is not an implementation authorization or an ADR status change.
- **S0-C4 Payment-first re-emission (2026-10-23, owner-approved clarification; resolves OD-15 for Payment only).**
  [ADR-0057](../adr/0057-messaging-conventions.md) §13.7 ("S0-C4"), with a pointer in §13.6. A §13.7 re-emission is a new
  authenticated publication, not a backfill: it may establish a new verified observation and never rewrites, deletes, replaces or
  promotes an earlier one or claims the earlier publication was authenticated. Owner only, through the protected production execution
  gate bound to the exact event; no caller argument authorizes. A restricted command inside payment-service republishes one existing,
  published, unchanged outbox row (`payment.succeeded`, `payment.failed`, `payment.cancelled`, `payment.expired`, version 1) through
  its own broker identity, with serialization pipeline version 1 established for the row (otherwise ineligible); no caller content, no
  row modification. Intent and producer audit evidence are durable before publication; outcomes (confirmed, unroutable, failed,
  uncertain) after. Code-bearing Auth events are never eligible. S1e evaluates the stored verified observation. Auth and Organization
  stay undecided (G-7 / M3). Safeguard S-8, §13.6, every financial invariant and the outbox relay are unchanged; architecture only: no
  implementation, schema, audit-catalog or production authorization.
- **S0-C5 Broker topic permissions (2026-10-23, owner-approved clarification; S1d).** [ADR-0057](../adr/0057-messaging-conventions.md)
  §13.1 ("S0-C5"); D-2/D-3 and §13.1 unchanged. Topic grants are exact, escaped, anchored routing keys generated from each producer's
  event contract and its audit-catalog actions (`audit.<action>`); the §13.1 families state ownership, not grants (`billing.*` and
  `refund.*` declare no event and grant nothing); missing or inconsistent sources fail closed. Domain-event families are granted only
  when an explicit reviewed activation state says so (Auth's are not active in production); unknown fails closed; grants are provisioned
  before a producer publishes. The `amq.default` and shared fanout DLX write grants stay, as an explicit residual risk: S1d is not
  queue-injection protection, and S1e (Billing ← Payment fail-closed before Billing's first production consumption) stays required.
  Billing keeps one identity (the exact union of its grants); a replay identity and the topology hardening are deferred. Billing and
  Payment grants are defined in code only, never provisioned by S1d; R2b needs only Payment's ordinary grants. A rollback that restores
  a broader grant is a security-impacting exception needing its own authorization. Documentation only: no code, broker, permission or
  production change.
- **S0-C6 S1e consumer enforcement (2026-10-23, owner-approved clarification).** [ADR-0057](../adr/0057-messaging-conventions.md)
  §13.5 ("S0-C6"); §13.2–§13.5, S0-C1 to S0-C5 and safeguard S-8 unchanged. The trust decision is durable before any business handler
  runs and before any business de-duplication slot is claimed; the stored verified observation is authoritative (S0-C4), never an
  aggregate conflict. Per-consumer outcomes for every classification; permanent refusals go through privacy-safe dead-letter paths; a
  transient lookup or commit failure is a bounded hold, never processing. Billing is verified-only from its first production deployment
  (no observe-only, compatibility, bypass or override), refuses to start without enforcement, and for replays uses trusted values stored
  from the verified original (an additive migration after a field-use inventory, S1e-2). Audit keeps admission first and alone may run a
  temporary, explicitly configured compatibility phase, ended only after verified publisher identity, the C-4 disposition, S1-R and its
  gates, strict testing and Owner approval. Notification is verified-only from its first deployment; a missing key holds, a retired key
  refuses (`replay_unverifiable`), and refused code-bearing events never keep their code. Documentation only: nothing implemented or
  enabled, no production change.
- **S0-C7 Pre-lifecycle certification of S5 (2026-10-30, owner-approved clarification; DN-1, S0 §6 V-4, S0 §8).** DN-1, V-5 (V5-1 to
  V5-9) and ADR-0060 are unchanged. DN-1.4 governs Core V2: no Company, Platform or Organization can be inactive until the release that
  first allows a scope to become inactive (the *first lifecycle-enabled release*: ADR-0060 §11 L2 and L3 with gate V-4).
  1. Core V2 S5 is certified on its S5a to S5d criteria and on evidence that no Core V2 path can produce, store, read or act on an
     inactive Company, Platform or Organization: tests T-A1 to T-A4 and the repository check of T-A3.
  2. The S0 §8 criterion **"inactive scopes refuse new requests while every discharge action works for its authorized actors"** is
     retained verbatim. The evidence of item 1 does not satisfy it. It is a blocking certification criterion of the first
     lifecycle-enabled release, including its integration (S-INT-equivalent) path.
  3. The first lifecycle-enabled release is not authorized for production, and no scope may become inactive in production, until that
     release certifies together: V-4 (V5-8); S5e and D6 (V5-1 to V5-7); V5-2 activation with the applicable OD-R6a certification;
     ADR-0060 §11 L5 consumer adoption by Billing and Payment; and the criterion of item 2.
  4. V5-9 is unchanged: no lifecycle-aware S5e runtime, temporary always-active adapter, unbound lifecycle port or speculative operation
     registry before V-4.
  5. This clarification takes effect when T-A1 to T-A4 are merged. It implements and activates nothing and changes no ADR status.

  *Evidence of item 5 (recorded 2026-10-31):* T-A1 Auth (#411, `7cc86d1`), T-A2 Organization Service (#412, `6b0150b`), T-A4 Billing
  (#414, `31eebe1`) and T-A3 kit contract and `check:repo` `checkPreLifecycleInvariant` (#415, `abb39f4`) are merged. Item 1 certifies
  pre-lifecycle Core V2 behaviour only; it does not certify lifecycle-enabled behaviour. No stage verdict is changed by this record.
- **S0-C8 Reachable late assisted settlement (2026-11-01, owner-approved clarification with ONE owner-approved policy addition, item 8;
  S0 §3.4 L-1 to L-6, §3.2 DB-9, DB-10, DB-12, DB-14; finding F-SINT-1; decisions LS-1 to LS-10 of the
  [proposal](./core-v2-f-sint-1-l4-reachability-proposal.md)).** The text of §3.2 and §3.4 is unchanged and governs. This entry states how
  it applies to Payment's verified late success, which S4c finality makes the only real form of a success on a definitively closed
  assisted channel. Items 1 to 7 and 9 to 11 are clarifications; item 8 is new policy.
  1. *Input (LS-1, LS-4).* A late assisted settlement, the only input of L-4, is either (a) the S5b E-7 record of an applied
     `payment.succeeded` that could not apply (unchanged, kept as a fail-closed path), or (b) Payment's verified late success (EVT-10
     v1, or Payment's PAY-12 read when the event is lost; verified-only, S0-C6) of a payment whose immutable routing purpose (DB-1) is
     `assisted_settlement`, eligible only when **all** hold: Payment's payment ended `failed`, `cancelled` or `expired` and the late
     success states that status; Billing's payment request ended in the same state; that request's channel is definitively `closed`;
     the verified capture fact (`factId`, FC-1) is present; the captured amount and currency equal the channel invoice's total; and no
     late assisted settlement exists for that invoice. Any other late success stays a refund-only `late_success` case. Eligibility
     never replaces L-4's five conditions; both apply in full.
  2. *Finality.* Payment's final state, Billing's final payment request and the closed channel are never reopened or changed. No
     `payment.succeeded` is produced. Nothing is purchased and no entitlement changes on receipt (L-2).
  3. *Ordering (LS-5).* A late success received before Billing holds its payment request's final state is recorded (L-1). Its
     classification is deferred and retried until Payment's authoritative state (event or read) is applied. Finality is never inferred
     from time, absence or the late success itself.
  4. *Default (L-3, LS-6).* The ordinary outcome remains the full refund of that captured movement to the school's card (Owner receipt
     flow), executed by Payment's capture-specific refund (R6H-5) and bound to the capture fact (`captureFactId`). There is at most one
     live (not cancelled) refund case per captured movement, whatever its eligibility. The request keeps its obligation, violations
     and restrictions.
  5. *Application (LS-2, LS-3, LS-9).* L-4 applies to (b) exactly as to (a): the BIL-32 route, the Auth `late_settlement_apply`
     receipt with factor step-up and its unchanged binding, the attestation and evidence paths, every refusal, and the atomic commit.
     A valid application commits, in one transaction: the single purchase; the invoice `paid`; the request `settled`; and the live
     deadline obligation `superseded_by_settlement` when one exists. The settlement time is Payment's recorded instant of the late
     success (`recordedAt`), never Billing's processing clock; the application instant anchors the period (R6G-5). Before `settleBy`,
     an otherwise eligible application needs no obligation. After `settleBy`, the existing obligation and discharge rules apply unchanged.
  6. *Evidence identity and uniqueness (DB-14 mechanism).* The identities are Payment's `lateSuccessId` and its capture fact `factId`.
     Billing records each once. Each late success evidences **at most one** effect: one late assisted settlement, one recovery payment
     (only under `recovery_settlement` routing), or one `late_success` case. An L-4 purchase from (b) is evidenced by its late success,
     unique per late success, instead of a `payment.succeeded` receipt. The invariants of DB-9, DB-10, DB-12 and DB-14 are unchanged.
  7. *Mutual exclusion.* A captured movement is either purchased under L-4 or refunded, never both. L-4 is refused while any refund
     case of the payment is not cancelled, or ever relayed an authorization (R6G-7). After an application, the purchase is refunded only
     as a Personal purchase of that capture, with S6d's effects (one reversal; a new `refund_completion` obligation). R6H-5's exclusions
     between ordinary and capture-specific cases are kept. A late success under one routing can never produce another routing's effect.
  8. **Policy addition (LS-7; Owner-approved; NOT a clarification of S0).** L-4 is also refused (`late_settlement_refused`, reason
     `chargeback_recorded`) when Billing holds a verified chargeback (dispute loss) on that payment. It applies to inputs (a) and (b),
     narrows L-4, and opens no new path to a purchase.
  9. *Existing records (LS-8).* Late successes already handled as refund-only `late_success` cases (development and simulation only)
     stay refund-only and are never reclassified. Late successes are never converted broadly into purchases. The direct-order rule of
     §3.4 is unchanged.
  10. *Preserved.* S4c finality; FC-1; L-1 to L-6 and L-4's five conditions; the invariants of DB-9, DB-10, DB-12 and DB-14;
      ADR-0057 §13 and S0-C1 to S0-C7; Auth receipt bindings and Owner step-up semantics. ADR-0044 Part B (B14), ADR-0045 and ADR-0069
      stay Proposed, and no Accepted ADR is edited.
  11. *Certification (G4).* The S-INT G4 L-4 criterion is met only by real events, across separately spawned Auth, Billing and Payment
      with RabbitMQ, as listed in the [S-INT readiness record](./core-v2-s-int-readiness.md) §7.3 (G4). Inserting an obligation while a
      channel is in flight is never evidence. The only permitted test aid is a labelled clock shift: all of a request's times moved back
      together, after its channel is closed, to reach `settleBy`.
  12. This clarification implements and activates nothing and changes no stage verdict or ADR status. The register entries BIL-23 H,
      BIL-32 G, BIL-33 G and EVT-10 record its contract. PR-2a, PR-2b, PR-3 and PR-4 (proposal §10) each need a separate Owner
      authorization.
- **S0-C9 Late-capture dispute attribution (2026-11-01, owner-approved clarification with TWO owner-approved policy additions, items 4
  and 5; S0 §3.1 FC-1, FC-4, FC-5, §3.4, S0-C8 item 8; ADR-0044 B10 as frozen here; finding F-SINT-2; decisions CB-1 to CB-6).** S0-C8,
  FC-1, FC-4, FC-5, B10 and every recovery invariant are unchanged and govern. Before this entry a provider dispute was attributable only
  to the capture of a payment's succeeded attempt (register PAY-09 F, R6E-1), so a dispute of a late capture (S0-C8 item 1 b) was a
  conflict: no chargeback fact (FC-1), no `payment.dispute.lost`, and Billing could neither refuse L-4 (S0-C8 item 8) nor apply B10 / S6f
  to an L-4 purchase. Items 1 to 3 and 6 to 10 are clarifications required by that frozen policy; items 4 and 5 are new policy.
  1. *Attribution (CB-1).* A new verified provider dispute is also attributed to the referenced attempt's capture when ALL hold: the
     payment is final `failed`, `cancelled` or `expired`; the attempt has exactly ONE capture fact; that fact is uncontested; and Payment
     recorded a late success naming it. The dispute is bound to that fact (`captureFactId`) in the exposure the provider states, never
     above the capture. Payment's status, its attempts and every recorded fact are unchanged: no final state is reopened and no
     `payment.succeeded` is produced. Anything ambiguous (two captures of one attempt, a contested fact, a capture of another payment,
     an exposure above the capture or in another currency) stays a conflict, as before. A second capture of a SUCCEEDED payment is out of
     scope and stays a conflict.
  2. *Capture-bound events and losses (CB-2).* `payment.dispute.opened` and `payment.dispute.lost` version 1 gain two additive fields,
     always present in new events: `captureFactId` (the disputed capture fact) and `captureBasis` (`settling_capture` | `late_capture`).
     A version-1 event without them is a legacy event and means `settling_capture` of the payment's succeeded attempt (the only
     attribution that existed). Billing binds a loss to the captured movement it names, never to an unrelated purchase:
     `settling_capture` keeps the S6e rules; `late_capture` affects a purchase only when that purchase is the L-4 purchase evidenced by the
     late success naming that fact (then B10 / FC-4 / S6f: entitlement preserved, base-only recovery obligation, T3); any other late
     capture has no purchase effect. A late-capture loss received before Billing recorded that late success is held, never applied to a
     purchase, until the late success is recorded (event or Payment's read).
  3. *Out-of-order provider facts (CB-5).* A dispute notification whose capture is not yet verified is held for bounded retry by
     Payment's webhook retrier (its existing bound) and processed once when attribution succeeds. When the bound is exhausted it is
     recorded as an explicit conflict (`capture_unverified`): no chargeback fact, no event, no purchase effect; the payment's exposure is
     `unresolved` and the conflict is visible for manual reconciliation. A held notification is not a conflict while it is held.
  4. **Policy addition (CB-3; Owner-approved; NOT a clarification).** Before consuming the Owner's receipt, the L-4 application reads
     Payment's authoritative dispute exposure of that payment (the R6A-3 read). `clear` continues; an open dispute or open exposure refuses
     `409 late_settlement_refused` reason `payment_dispute_open`; a chargeback recorded at Payment refuses reason `chargeback_recorded`
     (S0-C8 item 8, unchanged, also re-checked by the database from Billing's recorded losses); `unresolved` exposure, an unavailable
     Payment or a failed verification answers `503 late_settlement_dispute_unavailable`. A refusal or a 503 spends no receipt and changes
     no financial state. The read is NOT a cross-service lock: item 7 states what happens after it.
  5. **Policy addition (CB-4; Owner-approved in principle; NOT a clarification).** A `late_assisted_settlement` or `late_success`
     reconciliation case of an UNSOLD late capture resolves as `chargeback_returned` only when Billing holds a verified loss bound to
     exactly that capture (`late_capture`) whose chargeback fact equals the capture's full amount, in its currency; no purchase exists
     from that late success; and no refund case of that capture is live or completed. It creates no refund case, no provider refund, no
     purchase, no entitlement and no obligation change (the request keeps its cash-return obligation, violations and restrictions, as
     under L-3). The loss, its chargeback fact and the case are kept; `chargeback_returned` (the provider's reversal; *corrected by S0-C10 item 9: the captured money returned to the payer by a chargeback, never a
     provider reversal of a chargeback*) is distinct from
     `refund_completed` (a refund executed through Payment). A partial chargeback never resolves the case: it stays open with a review
     case, and no remainder is refunded or sold automatically.
  6. *Mutual exclusion.* One captured movement has at most one return: a refund case is refused while the payment's exposure is not
     `clear` (FC-5, R6A-3, unchanged); a chargeback after a completed refund of that capture is `chargeback_refund_overlap` (S6h,
     unchanged; *clarified by S0-C14 item 8: on every capture basis, including an assisted settling capture*), never `chargeback_returned`; L-4 is refused once a loss is recorded (S0-C8 item 8) and, per item 4, while a dispute is
     open; a chargeback of an L-4 purchase never reverses it (FC-4) and opens one base-only recovery obligation per loss (S6f) *(amended by S0-C10 item 5: at most one per assisted purchase, for the first
     qualifying loss)*.
  7. *Ordering outcomes (no synchronous guarantee).* Dispute recorded before the exposure read: refused (item 4). Loss already at Billing:
     refused (`chargeback_recorded`). Dispute recorded at Payment after the read, before the commit: the application commits; a later
     loss follows item 2 for that L-4 purchase (preserved, base-only recovery, T3), exactly as an assisted purchase charged back after
     purchase; a later win changes nothing. Loss at Billing before EVT-10: held (item 2); a later L-4 is refused. Refund and dispute:
     serialized under Payment's payment row lock (FC-5). Duplicate, forged or replayed notifications and events: unchanged safeguards
     (provider signature, one observation per webhook event, unique `(provider, providerDisputeId)` and chargeback fact identity,
     deterministic event ids, verified-only consumption S0-C6): never a second effect.
  8. *Existing evidence (CB-6).* Conflicts recorded before this entry (development and simulation only) are never rewritten or
     reinterpreted: they keep counting toward `unresolved` exposure and are resolved only by explicit reconciliation. Items 1 to 5 apply
     to notifications processed after their implementation.
  9. *Preserved.* Payment finality (S4c); FC-1 (every chargeback a fact); FC-4; FC-5; B10; S6e direct and assisted rules; S6f recovery
     (base only, Nawara absorbs fees, D5); S0-C8 items 1 to 12; Auth receipts and Owner step-up. ADR-0044 Part B, ADR-0045 and ADR-0069
     stay Proposed; no Accepted ADR is edited.
  10. *Acceptance (later implementation; real events across processes, simulation only):* (1) a dispute opened before L-4 refuses it
      without spending the receipt; (2) a verified loss after L-4 preserves the entitlement and opens the base-only recovery obligation and
      T3; (3) a full chargeback of an unsold late capture resolves its case as `chargeback_returned` with no refund; (4) a partial one
      never does; (5) an out-of-order dispute is attributed once or recorded as an explicit conflict; (6) forged, duplicated and replayed
      dispute notifications and events give no second effect; (7) capture or amount mismatches fail safe; (8) Payment's final state and
      provider evidence are unchanged. The register entries PAY-09 G, PAY-14 H, EVT-03, BIL-32 H and BIL-33 H record its contract.
      Implements and activates nothing; each Billing, Payment, harness and certification PR needs a separate Owner authorization.
- **S0-C10 Repeated and excess chargeback losses (2026-11-05, ADOPTED CONTRACT, the Owner's S0-C10 contract GO: decisions C10-1 to C10-7;
  clarification of FC-4, FC-6, B10, R6F-3, R6F-8 and S0-C9 item 6, with an Owner-approved amendment of R6F-8's per-loss obligation in item 5;
  logic-audit findings F-03, F-07; F-26 as a scope limit). IMPLEMENTED for development and simulation only (Billing `0049`, the Owner's implementation decisions
  O-1 to O-5, 2026-11-05), not certified: certification needs a separate Owner review.** Assigns no liability. FC-1, FC-5, S0-C9, S0-C11 to S0-C13 and every recovery invariant not named here are unchanged and
  govern. Before this entry a second full loss of an assisted purchase could open a second recovery obligation (`recovery_obligation` is unique per
  dispute), a second full chargeback of a direct purchase could record a second write-off (`financial_loss` is unique per chargeback fact), and an
  assisted chargeback above the payment failed on every recovery pass with no review.
  1. *Facts (C10-1).* Every authenticated provider debit stays recorded, whatever follows: as Payment's chargeback fact when Payment binds it
     (FC-1), otherwise as Payment's preserved conflict observation (S0-C9, S0-C13 Part A). At Billing every verified loss stays a
     `payment_dispute_loss`. A refusal of an automatic effect never removes, clamps or rewrites a fact, a loss or its provider-stated amount.
  2. *Recognition is not liability (C10-1, C10-4).* **Accounting recognition** states that a provider debit occurred: every chargeback fact is
     included at once in FC-5 payment and Company balances and listed in Payment's chargeback reconciliation items, never clamped, with
     `netRetained` free to go negative, whether or not any liability is assigned. **Liability** states who bears it. Recognition never assigns
     liability and never by itself creates an obligation, T3, purchase reversal, write-off or `FinancialLoss`. A recognized debit with no assigned
     bearer is an **unassigned provider debit**: it stays unassigned and visible (item 7), and is never assigned to Nawara, the Organization or the
     beneficiary without a separately adopted liability policy.
  3. *The capture and its loss cap (C10-2, Constraint A).* A loss is bound to one capture: for `settling_capture`, the payment's settling capture,
     whether or not the loss names its fact; for `late_capture`, the fact it names (S0-C9 item 2). The capture's **gross** is that fact's amount (for
     a settling capture, the payment request's amount, which equals it). Its **cumulative loss** is the sum of the chargeback amounts of every
     verified Billing loss bound to it, in its currency. An automatic loss effect applies only to a loss in the capture's currency for which the
     cumulative loss, including that loss, does not exceed the gross. No reversal, win or later fact reduces the cumulative loss under this entry
     (item 9).
  4. *First automatic effect.* Only a verified FULL loss (its chargeback equals the gross) within the cap has an automatic effect, once per
     capture, and only as already approved: for an assisted purchase, one base-only recovery obligation and T3 (S6f, D5; item 5); for a direct
     purchase, its reversal (FC-4) and one `direct_chargeback_write_off` (FC-6). The write-off is recognized only for the loss whose effect
     reversed the purchase, at most one per capture. This entry widens neither effect.
  5. *One obligation per assisted purchase (C10-2, Constraint B; amends R6F-8 and S0-C9 item 6).* An assisted purchase has at most ONE automated
     Organization recovery obligation across its whole capture and dispute history, in any state: recovering it, writing it off or settling it never
     permits another. A second dispute, another capture reference or another loss never opens a second obligation. R6F-8's "a FULL chargeback ...
     opens `recovery_obligation`" and S0-C9 item 6's "one base-only recovery obligation per loss" read: for the first loss that qualifies under
     item 4; every later loss of that purchase goes to review (item 6). When two full losses arrive, the first recorded by Billing opens it; the
     amount is the same base either way.
  6. *Repeated, excess and contradictory losses (C10-2, C10-3).* No automatic effect, and no obligation, T3, reversal, write-off or `FinancialLoss`,
     for: a further loss of a purchase that already has its obligation or reversal; a loss that takes its capture's cumulative loss above the
     gross, or whose own chargeback exceeds it; a loss in another currency; a loss bound to a capture that is not the purchase's. Each goes to
     review: for an assisted purchase in the adopted `recovery_review`, with the new reasons `repeated_loss` (Constraint B) and
     `chargeback_exceeds_capture` (Constraint A), alongside `partial_chargeback` and `refund_completed`; for a direct purchase in the existing
     dispute-loss review (`reversed_by_another_chargeback`, `chargeback_exceeds_payment`, `currency_mismatch`, and `chargeback_exceeds_capture` for
     a partial that takes the cumulative loss above the gross). When a loss meets both an excess condition and a partial one, the excess reason
     applies. A review is a classification, never a retry: it ends F-07's repeated failure.
  7. *Monitored, visible, fail-closed (C10-3, C10-4).* Each review keeps the loss, its chargeback fact, its dispute, payment, capture and purchase,
     and the Organization and Company it belongs to. An assisted `repeated_loss` or `chargeback_exceeds_capture` review is listed for the Owner as a
     BIL-33 reconciliation case of the new type `chargeback_loss_review` (evidence the loss's dispute; amount and currency the loss's), which is not
     review-only and has no resolution kind under this entry: it stays open. A direct one stays the existing non-acknowledgeable
     `contradictory_effect` case. No acknowledgement, dismissal, liability assignment or automatic closure is added. While open nothing is released:
     the capture's exposure stays as recorded, so refunds and L-4 of that capture remain refused by their existing rules.
  8. *Committed effects stand.* A loss arriving after an obligation, reversal or write-off never undoes, reduces or duplicates it; it is reviewed
     under item 6.
  9. *Provider reversals (C10-5, F-26; scope limit).* A `won` notification or any reversal statement does not prove that funds were restored.
     Under this entry nothing clears exposure, reduces a cumulative loss, adjusts an obligation, write-off or `FinancialLoss`, or reassigns liability
     because of one. Unchanged: a `won` after a `lost` stays a `terminal_contradiction` conflict (S0-C9, S0-C13 Part A), and a `won` of a dispute
     with no chargeback fact clears that dispute's exposure as before (S6e), since no money left. S0-C9 item 5's gloss of `chargeback_returned` is
     corrected: it means the provider returned the captured money to the payer by a chargeback, never a provider reversal of a chargeback.
     Reversal-based clearance stays separately gated.
  10. *Partial chargebacks.* R6F-3 stands: a partial within the cap is review only (`partial_chargeback`), and its existing case and Owner
      acknowledgement are unchanged. *(S0-C15A item 6: two reasons are refused beside unresolved refund evidence of the same movement.)* A full loss after a partial, or partials summing above the gross, exceed the cap (item 6).
  11. *Idempotency, crash, replay and concurrency.* Unchanged safeguards keep one record per provider event (one observation per webhook event,
      unique chargeback fact identity, one Billing loss and one effect per dispute, deterministic event and audit ids, verified-only consumption).
      The recovery and dispute-loss workers decide under the existing Organization and payment request locks, and the database re-derives every
      condition, so a crash or concurrent pass commits either the whole effect or nothing and a retry finds the committed decision.
  12. *Database boundary (C10-2).* Billing enforces at the database: one `recovery_obligation` per `purchaseId`, in any state (beside the
      existing per-dispute key); its insert guard re-derives the cap (item 3) from recorded losses; one `direct_chargeback_write_off` per capture;
      `recovery_review` reasons widened by item 6 only, still append-only and one per loss.
  13. *Historical records (C10-6).* Existing obligations, write-offs, losses, reviews and provider facts are never backfilled, rewritten, deleted
      or compensated. The implementation's migration first looks for an assisted purchase with more than one obligation, or a capture with more
      than one direct write-off; if any exist it refuses to apply and reports them, changing nothing, for the Owner's decision. Losses recorded
      before the implementation are classified under item 6 only when first visited after it; a loss already visited keeps its recorded outcome.
  14. *Scenarios (expected outcomes).*

      | Scenario | Outcome |
      |---|---|
      | First full chargeback of an assisted purchase | One base-only obligation and T3; entitlement preserved (B10) |
      | Second full chargeback of the same capture | Recorded; `recovery_review` `repeated_loss`; `chargeback_loss_review` case; no second obligation or T3 |
      | Two partials whose sum exceeds the gross | First: `partial_chargeback`. Second: `chargeback_exceeds_capture`, open case; no effect from either |
      | Repeated notification or event, same identity | One observation, fact, loss and effect; replays change nothing |
      | Different verified debit facts on one capture | Each recorded; the first full within the cap applies; the others reviewed under item 6. A second chargeback statement of the same dispute stays a Payment conflict and is refused by Billing, as today |
      | Several capture references on one assisted purchase | A loss of a capture that is not the purchase's has no purchase effect (S0-C9 item 2); at most one obligation for the purchase in any case |
      | Direct purchase charged back again | One reversal (FC-4) and one write-off per capture; the second loss is reviewed (`reversed_by_another_chargeback`), no second write-off |
      | Excess loss with no assigned bearer | Recognized in balances (negative `netRetained` allowed); unassigned; open review case |
      | Reversal with no authenticated funds-restoration evidence | No clearance or adjustment (item 9) |
      | Crash, replay, concurrent visits | One decision per loss; at most one obligation per purchase; the database refuses a second |
      | Historical duplicate obligations or write-offs | Kept as recorded; the migration refuses and reports them (item 13) |

  15. *Acceptance (later implementation, simulation only; separate Owner authorization).* Service and database tests prove Constraint A and
      Constraint B independently: a second obligation for the same purchase under another dispute is refused by the database even when the cap would
      allow it, and a loss above the cap is refused an effect even when the purchase has no obligation. Real events across processes cover the first
      full loss, the second full loss and partials above the gross for an assisted purchase, and the second full loss of a direct purchase; refunds and
      L-4 of that capture stay refused. Existing tests that protect valid behaviour stay; the register entries BIL-28 G, BIL-33 L and BIL-34 G record
      this contract. ADR-0035, ADR-0044 Part B and ADR-0069 stay Proposed; no Accepted ADR is edited.
  16. *Implementation decisions (the Owner's O-1 to O-5, 2026-11-05).* O-1 (Option B): a loss that existed when `0049` ran is marked
      `beforeS0c10`, never ordered; a capture's only such loss is its first, several such losses are never first (review), every later loss follows
      all of them, and one already in review keeps that review. O-2: an L-4 capture's loss above it is a `recovery_review`, not an effect-stage review;
      earlier ones keep theirs. O-3: the ledger `capture_loss_cap`. O-4: a direct write-off follows its committed reversal on the next reconciliation
      pass. O-5: in any environment, in this order: an audit-service whose catalog has `chargeback_loss_review`; the required audit and broker permissions
      (Billing already publishes `audit.reconciliation_case.opened`, so S0-C10 changes none); then a Billing that opens the case.
- **S0-C11 Capture evidence for commercial effect (2026-11-03, owner-approved clarification of FC-1, FI-13, S4c F-4 and S0-C8 item 1, with
  owner-approved additions in items 2, 3, 7 and 8; logic-audit findings F-27, F-28).** The number S0-C10 is reserved for a separate draft that is not
  adopted. *(S0-C10 was adopted on 2026-11-05; see above.)* FC-1 to FC-5, S0-C8 and S0-C9 are unchanged and govern except as stated here. The first recorded fact under an identity
  `(provider, providerTxnId, 'capture')` is the only evidence of what was captured under that identity.
  1. *Verified capture.* A capture is **verified for commercial effect** only when all hold: it reached Payment through an authenticated provider
     channel; it is committed as a `provider_transaction_fact`; the observation equals that fact in amount, currency, payment and attempt; and the
     fact has no recorded contradiction.
  2. *Settlement.* A payment moves to `succeeded` only on a verified capture whose amount and currency equal the payment's, and only while that capture
     is the attempt's single capture fact. A missing, mismatched or contested fact never settles.
  3. *Several references.* Distinct provider references on one attempt are distinct facts. None is merged, netted, preferred or discarded, and none
     settles automatically. Payment may report that facts share an attempt, amount and currency as *potentially equivalent*: a derived observation, never
     stored as a determination and with no financial effect. Only a separately approved contract may determine equivalence. A further capture of an
     already `succeeded` payment stays on its existing path (R6H-5), and a new refund authorization on that path is subject to S0-C12 item 14(d).
  4. *Missing evidence.* An observation that can't be keyed to a fact creates no settlement, late success or L-4 eligibility. A stored notification,
     where one exists, is kept and stays visible.
  5. *Contradiction.* An observation contradicting a recorded fact is kept once and changes nothing: it never overwrites the fact, settles, grants or
     reverses a purchase, records a late success, qualifies for L-4, or authorizes a refund. No precedence rule applies: neither figure is treated as true.
     The fact remains what was first reported, and is contested.
  6. *Late success.* A late success states the amount and currency of the fact it names, and only an observation equal to that fact records one.
  7. *L-4.* A late assisted settlement is applied only when, at the last read before the receipt is consumed, Payment states that its capture fact exists,
     is uncontested and equals the late success and the channel invoice's total. Contested, missing or mismatched: `409`. Payment unavailable or an
     invalid answer: `503`. Neither spends the receipt or writes anything.
     - *Several captures (S0-C12 item 14).* A capture of an attempt holding more than one capture fact at that read: `409 capture_unverified`, as under 7c.
     - *Not a lock.* This read is a point-in-time check and **not a cross-service lock**: no guarantee extends between it and Billing's commit. A
       contradiction recorded before the read refuses. One recorded after it doesn't refuse, doesn't undo the commit, and doesn't reverse the committed
       purchase (FC-4).
     - *Evidence.* In that case, the contradiction stays visible under item 8, and its `capture_contradiction` case records that an L-4 purchase rests on
       the contested capture.
     - *7c, input (a), the S5b E-7 record (owner-approved 2026-11-03).* An E-7 late settlement's capture is its payment's **settling capture**: the
       single capture fact Payment holds on the payment's committed succeeded attempt, identified only from Payment's committed records and stated
       through the verified service read PAY-16. Billing names the payment from its own payment request, never from a request value. An E-7
       application is applied only when, at the last read before the receipt is consumed, Payment states that the payment is `succeeded`, that its
       succeeded attempt holds exactly one capture fact, that the fact is uncontested, and that its amount and currency equal the payment's, the
       original settlement's (the payment request) and the channel invoice's total. Missing, legacy-unverifiable (no fact, as for a settlement
       recorded before S4d) or unequal evidence: `409 capture_unverified`; ambiguous (more than one capture fact on that attempt): `409
       capture_unverified`; contested: `409 capture_contested`; Payment unanswerable or an answer about anything else: `503`. None spends the
       receipt or writes anything. No fact is inferred from the payment amount, a request value, provider metadata or an arbitrary capture
       reference. The two sub-items above apply unchanged. Until PAY-16 is implemented and certified, every E-7 application is refused
       `409 capture_unverified` (the Owner's interim rule): E-7 eligibility is restricted, not removed.
     - *Capture provenance.* Every L-4 application, of either input, records the capture fact id it relied on, taken only from Payment's verified
       answer in that application, immutable, and never backfilled; an application recorded before this item keeps none. One capture fact
       evidences at most one L-4 application.
  8. *Visibility.* A capture contradiction stays visible until an approved contract resolves it: as Payment's Owner-readable `fact_conflict` item; as a
     commercial audit record written with the contradiction; and as Billing `capture_contradiction` reconciliation cases. *(Tenant-isolation
     clarification, owner-approved 2026-11-03.)* There is one case per contested fact **and** per payment whose attempt recorded the contradicting
     observation, scoped to that payment's seller Company as Billing's own records of that payment establish it, never from provider data.
     - If the contested fact belongs to that same payment, the case may show its evidence: the fact, its figures and the observation.
     - If it belongs to another payment, the case shows only that payment's own observation and that it contradicts a fact recorded elsewhere. It
       never shows the other payment, its Company, the other fact's id, amount or currency, or any other private evidence.
     - Each case's identity is derived one-way from the contested fact and the observing payment. It is stable under replay and retry, and it can't be
       used to correlate cases across Companies.
     - A case is visibility only: it grants no authority over the fact, can't be acknowledged or closed by an Owner, and reverses, refunds or transfers
       nothing. Refund-fact contradictions are excluded.
  9. *What a contradiction blocks,* for the contested capture only: settlement; a new late success; L-4; ordinary and capture-specific refunds; attribution
     of a new dispute to it (S0-C9 item 1); counting it as a new recovery payment. **It doesn't block or undo:** a purchase already made (FC-4); an authorized
     refund attempt (FC-2, FC-3); a recovery payment already counted; existing T1, T2 or T3 state; reads; or operations on another capture, except
     that a capture fact of the same attempt makes that attempt ambiguous under S0-C12 item 14.
  10. *Reading with existing text.* "Verified success" in L-1, S4c F-4, S0-C8 item 1 and §3.5 means, for commercial effect, a capture verified under
      item 1. L-1 stays satisfied for a contradiction: the fact and the conflict are the record, and nothing is discarded. L-3 and S0-C8 item 4 keep the
      refund as the default, but while the capture is contested that refund waits and the case stays in reconciliation (L-4's closing rule). FC-1 is
      unchanged: a movement that can't be keyed stays what it already is under PAY-05 and PAY-13, an unmatched notification with no fact.
  11. *Preserved.* FC-1 to FC-5; S4c F-1 to F-5, with F-4's matching-amount behaviour unchanged where the capture is verified under item 1; S0-C8 other than
      the addition in item 7; S0-C9; PAY-12's scoping, including G. ADR statuses are unchanged, and no Accepted ADR is edited.
  12. *Acceptance (later implementation; real events across processes, simulation only).* (1) A signed contradiction, before or after settlement, in either
      order and through either channel, produces no settlement, purchase or late success. (2) No fact and several facts never settle. (3) L-4 refuses a
      contested, missing or mismatched capture without spending the receipt, and answers `503` when Payment can't. (4) A contradiction after the read
      leaves the purchase and opens one case recording it. (5) Both refund routes refuse a contested capture, and an authorized attempt continues. (6) F-4's
      paths are unchanged. (7) The contradiction is audited once, atomically. The register entries PAY-02, PAY-05, PAY-07, PAY-12, BIL-32, BIL-33 and EVT-10
      record its contract. **Implemented for development and simulation only; the Owner closed S0-C11 as PASS for development and simulation at `787c856`
      (2026-11-03).** It is not production-certified, and two-Company real-event evidence (L2) is required before real money.
- **S0-C12 Wrong-amount captures (2026-11-04, ADOPTED #467: clarification of L-1, L-2, FI-13 and S0-C8 item 1, read with S0-C11, with owner-approved
  additions D-1 and D-B; logic-audit findings F-01, F-20, FN-1; decisions A1 and N1, with N3 future-gated). PASS FOR DEVELOPMENT AND SIMULATION ONLY (the Owner's decision, 2026-11-05, at `12f52df`): not production-certified and not
  real-money ready (item 20). Items 14 to 20 and the references to them come from the Owner's FN-1 contract GO, 2026-11-04.** A *wrong-amount capture* is a capture
  verified under S0-C11 item 1 whose amount or currency differs from its payment's. It is an immutable financial observation, never a sale. FC-1 to FC-5, S4c
  F-1 to F-5, S0-C8, S0-C9 and S0-C11 are unchanged and govern except as stated here.
  1. *No commercial effect by itself.* Recording it settles nothing, finalizes or reopens no payment, changes no attempt state, creates no purchase or
     entitlement, never qualifies for L-4, counts toward no recovery obligation and authorizes no refund. FI-13 is unchanged: it never settles the payment.
  2. *After finality (A1; F-01).* On a payment `failed`, `cancelled` or `expired`, an uncontested wrong-amount capture whose currency matches `^[A-Z]{3}$`
     is a late success with the fact's exact amount and currency (EVT-10 v1, PAY-12 `late_success`). At Billing it is **refund-only**: a `late_success`
     reconciliation case, resolved only by the capture-specific refund (R6H-5) of exactly that capture's amount, in its currency, never automatically, under
     S0-C9 item 6 and every existing refund gate (Owner receipt, idempotency, dispute exposure, S0-C11 item 9, item 14(d)). A `succeeded` payment's further
     capture stays on its existing path (R6H-5), subject to item 14(d).
  3. *Recovery payments (D-1).* A late capture of a `recovery_settlement` payment counts toward its recovery obligation only when it meets the recovery
     invoice's evidence requirements: its amount and currency equal the recovery invoice's total and currency exactly, its fact is uncontested
     (S0-C11 item 1), and its attempt is not ambiguous (item 14). A wrong-amount late success never counts: it creates no `recovery_payment`, satisfies no principal, creates no surplus and changes no
     T3. It stays an observable fact and a refund-only `late_success` case. A capture equal to the invoice's total keeps §3.5 unchanged, including
     over-recovery when the outstanding amount has fallen. Any other use requires a separately approved recovery-allocation contract.
  4. *Recovery refund exception (D-B).* For a `recovery_settlement` payment, and only for a capture that item 3 excluded, the capture-specific refund
     (R6H-5, `late_capture`) is permitted when all hold: the capture is that payment's own verified, uncontested capture fact; no `recovery_payment` names
     its late success; the refund returns exactly that capture's amount in its currency; and every existing refund gate, item 14(d) included, is met. It never refunds another
     capture, a counted recovery payment, a surplus or a principal, and it is no general recovery-payment refund route.
  5. *Before finality (N1; F-20).* On a payment that is not final, a wrong-amount capture is **not** a late success. It is an Owner-readable Payment
     reconciliation item of kind `capture_mismatch` (PAY-12), scoped through its payment's seller Company, with the fact's identity, amount, currency and a
     reason (`amount_mismatch`, `currency_mismatch`). No Billing case opens for it (item 9). S4c F-1 to F-3 are unchanged: the payment may stay non-final,
     no refund route exists while it does, and the item may stay unresolved until a separately approved finality policy exists (**documented limitation**).
     *N3*, ending an attempt because of a wrong-amount capture, is not part of this entry: it needs separate Owner approval, per provider, after the
     adapter's capture semantics are verified.
  6. *Reaching finality, atomically.* When a payment becomes `failed`, `cancelled` or `expired` by an existing rule, the same transaction, under the payment
     lock, records its state, event and audit and, for each uncontested capture fact of that payment that settled nothing, has a currency matching
     `^[A-Z]{3}$`, has no late success and whose attempt is not ambiguous (item 14), that late success with its EVT-10 and audit. A capture first processed on an already final payment records its
     late success in the transaction that decides it. A final status is never reopened.
  7. *Recovery of the only unavoidable window.* FC-1 and V-2 commit a fact on its own before its processing, so that step cannot share a transaction. A
     durable, bounded, idempotent reconciliation pass completes a committed capture fact whose processing was interrupted: it selects from committed
     records only (no queue to lose), works in bounded batches with the backoff of item 15, and under the payment lock records the late success only where
     item 6 would have and no late success names the fact (`payment_late_success_one_per_fact`, `0025`), with a deterministic event id derived from the row.
     It never settles, never reopens a final status and never duplicates a late success, event, audit record, refund authorization or reconciliation effect.
  8. *Currencies.* Amounts and currencies are recorded exactly; never converted, rounded or normalized; no exchange rate is ever applied or assumed.
     - *A valid, different three-letter code* (`^[A-Z]{3}$`): items 2 to 7 apply with the provider's currency. Balances stay per currency. A refund in that
       currency proceeds only if the provider adapter supports it; otherwise it fails closed.
     - *An unrecognized currency that a fact can hold* (1 to 16 characters, not `^[A-Z]{3}$`): the fact is kept as observed; **no late success and no
       EVT-10** (Billing could not hold it), no Billing case, no settlement, allocation, entitlement or refund route. **[O-1, confirmed by the Owner,
       2026-11-04; not an authorization for new financial behaviour]** It is visible as a `capture_mismatch` item with reason `unrecognized_currency`, whatever
       the payment's state.
     - *A value no fact can hold* (item 16 lists the shapes): the authenticated evidence stays stored as received and is not a fact, as under S0-C11 item 4,
       and item 16 governs its quarantine. **[Documented limitation, O-2: approved for development and simulation only; a real-provider blocker, item 19]** No
       Owner API shows it; making it Owner-visible or actionable needs a separately approved policy.
  9. *Billing.* Under this entry only a late success opens a Billing case. R6H-5's existing `unmatched_capture` case, for a further capture of a `succeeded`
     payment (`duplicate_capture`, `other_attempt_capture`), is outside this sentence and stays; this entry adds no other case. Billing reads PAY-12 kinds it
     names; a kind or reason that no contract names opens nothing and is logged. **Billing's D-1, D-B and allow-list implementation is certified before Payment emits a wrong-amount late success.**
  10. *Audit.* Commercial actions (version 1, no trusted scope), each written in its record's own transaction, never before its catalog entry exists:
      `payment_late_success.recorded` for every late success, and `payment_capture_mismatch.recorded` once per wrong-amount capture fact. Identifiers,
      reason codes and integer amounts only; a currency only when it matches `^[A-Z]{3}$`; never raw provider text, secrets or notification bodies.
  11. *Preserved.* S4c F-4 (a matching capture during `closing` settles; on a final payment or against a confirmed failure it is recorded and changes nothing),
      read with this clarification (FN-2, the Owner's Option A, 2026-11-05): **a capture observed while the payment is non-final is recorded as an immutable fact;
      eligible late-success and EVT-10 creation is deferred until valid terminal finality (item 6).** No finality rule changes and no payment closes to release one.
      If another attempt settles the payment, the capture keeps its existing `other_attempt_capture` treatment. FI-13, FC-1 to FC-5, S0-C8, S0-C9 and S0-C11. ADR statuses are unchanged; no Accepted ADR is edited.
  12. *Acceptance (later implementation; real events across processes, simulation only).* (1) After finality: one late success, a refund-only case, and the
      capture-specific refund of exactly the fact's amount and currency, completed once. (2) Before finality: a `capture_mismatch` item, no late success, no
      Billing case; when the payment later becomes final, one late success in that transaction. (3) **Recovery (D-1, the S0-C11 L3 obligation, which the Owner
     recorded as discharged for development and simulation on 2026-11-04, real-provider limitations retained):** an equal
      late recovery capture counts once (principal, surplus, T3 per §3.5); a wrong-amount one never counts (no `recovery_payment`, principal, surplus or
      T3 change) and its D-B refund completes once; a contested one records no late success. (4) An interrupted window recovered once. (5) An unrecognized
      currency: no late success and no case. (6) Replays and concurrency: one record, one event, one audit record. (7) S0-C8, S0-C9, S0-C11 and F-4 suites
      unchanged. The register entries PAY-02, PAY-05, PAY-12, EVT-10, BIL-23, BIL-28 and BIL-33 record its contract. **Evidence for items 1 to 13:** real-event
      and service suites merged in #471 and #472 (main `31effb6`, Core CI 41915287149). Each further Billing, audit, Payment and certification PR needs a
      separate Owner authorization.
  13. *Implementation order and deployment compatibility.* (a) **Billing first:** D-1 (classification and database guard), D-B (the narrow
      route) and the PAY-12 allow-list, certified while Payment still emits no wrong-amount late success; the change is additive and safe against today's
      Payment (an equal late success still counts; no wrong-amount one exists yet). (b) **Audit catalog** entries for both actions and the reconciler
      actor, before any emission. (c) **Payment** last: FI-13 placement, `capture_mismatch`, atomic finality, the recovery pass and the currency rule. EVT-10
      stays v1 (no new field), so no consumer contract changes; an older Billing deployment is the one unsafe pairing (it would count a wrong-amount recovery
      late success), so Payment's change is never deployed where Billing's step (a) is not. (d) Real-event cross-process tests, then certification. Each
      step is reversible on its own: reverting Payment's step stops new wrong-amount late successes; Billing's guards stay safe either way.
  14. *Several capture facts on one attempt (FN-1).* Every authenticated capture stays its own immutable fact with its provenance. A different provider
      reference does not prove a different movement of money. An attempt is **ambiguous** while it holds more than one capture fact, contested or not. A
      contradiction of a fact (S0-C11 item 5) is not another fact. Ambiguity is per attempt: captures of different attempts keep the existing rules.
      (a) *Committed effects stand.* A settlement, late success, case, recovery allocation, entitlement or refund authorization committed before the ambiguity
      was known is not changed, reversed or reinterpreted. Payment and Billing finality are unchanged, and nothing historical is deleted or backfilled.
      (b) *No new late success.* While an attempt is ambiguous, no fact of it records a late success. A fact without one stays in exceptional review, derived
      from the facts, never a determination of equivalence. L-1 stays satisfied: the fact is the record and nothing is discarded. No provider may create a late
      success from ambiguous evidence; future authorization needs a separate Owner-approved policy with verified reference semantics.
      (c) *No new commercial effect.* An ambiguous attempt authorizes no new settlement, recovery allocation, L-4 eligibility or entitlement, whatever the
      amount of any fact and whichever arrived first, including an equal capture following a wrong-amount one. "Every verified success" in §3.5 is read with
      items 3 and 14. A late success already recorded stays refund-only evidence.
      (d) *No new refund without permission.* A new refund authorization for any fact of an ambiguous attempt requires an explicit provider permission,
      default-deny, checked before a receipt is consumed. Without it: refused, no receipt spent. Nothing is ever refunded automatically. A refund authorized
      before the ambiguity was known stands.
      (e) *Provider permissions.* Recorded per named provider, append-only, never inferred from a reference, amount or timing. The existing `simulation` and
      `test` providers hold refund permission only, preserving the certified R6H-5 simulation behaviour, because the simulator defines its own references. It
      never authorizes a settlement, recovery allocation, L-4 or entitlement, and no real provider adapter holds it. It does not override item 4 or its database
      guard: a recovery capture with no eligible recorded late success stays in review and has no refund route; no recovery allocation, principal reduction, T3
      clearance, surplus or entitlement results from an ambiguous capture.
      (f) *`multiple_captures`.* A PAY-12 kind: one row per capture fact of an ambiguous attempt, in any payment state, identified by the fact's id, with its
      payment, amount, currency as stored, attempt, sibling count, whether contested, its late success if any, whether in review, and the derived "potentially
      equivalent" observation. Owner only, own bearer verified live, scoped to the seller Company through the fact's own payment; no service or producer read;
      unmatched facts never appear. Read-only and derived at read: nothing is stored, a replay adds no row, existing facts appear with no backfill, and paging
      is the existing keyset by id. It authorizes no settlement, refund, case closure, recovery or entitlement, and opens no Billing case.
      (g) *Progress.* Facts in review are excluded from recovery selection before its batch limit, so they consume no attempts and hold back no other fact.
      (h) *No exit yet.* Exceptional review has no automatic exit. This is accepted for development and simulation only (item 19).
  15. *Bounded recovery (item 7).* Per fact: at most **12 processing attempts**, durable state, waits of 2^n seconds after attempt n, for n = 1 to 11. The
      cumulative theoretical wait is 4,094 seconds, about **68 minutes**. The longest is 2,048 seconds, so no cap applies. The effective schedule follows the
      recovery pass, every 30 seconds: a fact is taken at the first pass after its wait.
      - *Counted:* a transient per-fact failure, an unknown failure, and a pass that wrote nothing for a fact still eligible. *Not counted:* success; a fact that
        became ineligible; a payment another transaction holds. The count is written in its own transaction after the failed one rolls back; a lost write
        under-counts, and evidence is never lost.
      - *Infrastructure failure* (the database or its connections unavailable) ends the pass and **consumes no fact's attempt**. The worker pauses, doubling from
        30 seconds to at most **15 minutes**, and resets on success. A paused tick does no database work, so resource use stays bounded; failures are logged with
        their consecutive count and monitored, and recovery resumes by itself.
      - *Permanent refusal* (a database guard refusing a fact that selection still finds eligible) stops retrying at once and is recorded as refused, because
        a retry can't change it. *Transient unavailability* is everything that may succeed unchanged.
      - *Fairness:* each fact has its own transaction; a failure never ends the pass for other facts. Due, non-terminal, eligible facts are selected before the
        batch limit, never-tried first, then oldest due.
      - *Exhaustion is not abandonment:* the fact stays, durably marked and visible to the Owner through PAY-12 and to operators through logs. A provider
        redelivery still processes normally.
      - *Reactivation is NOT authorized.* The intended direction is an Owner-requested reactivation that only retries existing rules, keeping full history; it
        can't authorize a financial effect or remove an ambiguity. **R6H-2 does not support it:** R6H-2 acknowledges three named review-only Billing case types, and
        this would be a Payment action able to lead to a new financial record. It requires a **separate security contract decision**. No new receipt purpose,
        step-up operation or route is created here.
  16. *Quarantine of invalid currency evidence (D4).* Shapes: a missing or `null` currency, a non-string value, an empty string, over 16 characters, or a string
      PostgreSQL text can't hold. A 1 to 16 character storable value stays under item 8. Only after the source is authenticated, and only for a permanent shape
      failure, never a database error: the evidence is durably quarantined, append-only, in one transaction, with the original value preserved exactly, without
      truncation or normalization, and the stored notification unchanged. **A successful acknowledgement is returned only after that commit**, in the form the
      provider's approved adapter contract defines. It means "authenticated evidence durably held", never "processed". HTTP 200 is not a statement of financial
      success. `simulation` and `test` answer `{ received: true }` with 200. If persistence fails, the answer stays retryable and reprocessing can't duplicate the
      record; the same event is a no-op, and a new event is its own record. A status read, having no stored notification, leaves the quarantine record as its
      evidence. Quarantine has no financial effect: no fact, settlement, capture normalization, attempt or payment change, and no Owner-visible monetary
      reconciliation. Logs and audit carry identifiers and reason codes only. Eventual reconciliation needs a separately approved policy (item 19).
  17. *Refund of an ineligible currency (D5).* When Payment's read for the same payment and fact is well-formed and states a 1 to 16 character currency not
      matching `^[A-Z]{3}$`, Billing answers `409 refund_not_eligible`. Unavailable, invalid or inconsistent Payment evidence: `503`. Owner verification, Company
      scope, the collapsed `404`, capture identity, receipts and financial finality are unchanged: nothing is written, no receipt is spent, and the answer carries
      no currency value.
  18. *Other malformed evidence (separately gated).* A verified notification with a **missing amount**, and an authenticated body that **cannot be parsed**, are
      outside this entry. As implemented, they are stored and answered HTTP 200 with state `ignored` or `failed` / `malformed_body`. That is recorded as an
      **unresolved risk**, not an approved real-provider acknowledgement policy. The one overlap: an invalid currency with a missing or invalid amount is item 16's, and
      its record keeps both defects without inventing either value.
  19. *Real-provider blockers.* No real provider may be activated until each is separately authorized and certified. **B1** FN-1: items 14 and 15 implemented
      and certified. **B2** a per-adapter provider permission with verified reference semantics: one reference per capture or per attempt, stability across
      channels, partial capture and correction. **B3** an approved reconciliation or return route for facts in exceptional review. **B4** O-2: Owner visibility and
      reconciliation of quarantined monetary evidence. **B5** a per-adapter acknowledgement contract, and bodies over the service's body limit, refused before
      authentication and storage. **B6** refunds in another currency: adapter support or failing closed. **B7** item 18. **B8** N3, S0-C11's L2 two-Company
      evidence, and production readiness.
  20. *Status and implementation requirements.* **Items 1 to 20: PASS for development and simulation only (the Owner's decision, 2026-11-05, at `12f52df`).** Real-money and
      production readiness are not certified. Retained: blockers B2 to B8; S0-C11's L2 two-Company real-process evidence; F-20 and N3; no exceptional-review return
      route; no approved reactivation operation; S-INT doesn't run audit-service, so a real Payment emission reaching it isn't observed; item 18; and the existing
      infrastructure and production-readiness gates. Implemented for development and simulation only: items 14, 15, 16 and 17, and FN-2 (item 11).
      **Historical limitation:** a late success recorded before `0026` with a non-final status, and any EVT-10
      dead-lettered for it, can't self-heal: the row is immutable, Billing refuses it, replay refuses it again, and finality won't record its fact again. Such a
      row exists only in development or simulation data, is kept as recorded, and has no automatic backfill, duplicate EVT-10 or compensation; correcting one needs a
      separately approved policy. Items 14 to 19 required, in Payment only and expand-only with no backfill and no existing row changed: a provider
      permission record, with `simulation` and `test` entries; recovery state; a quarantine record; and the late-success insert guard (`0024`) extended to
      refuse a late success of an ambiguous attempt, so direct SQL can't bypass item 14(b). It runs on insert only, so existing rows are untouched.
      `payment_late_success_once` stays as it is while no provider may create such late successes. Additive: an attempt's capture count on Payment's capture
      read, for Billing's D-1 and L-4 checks; EVT-10 stays v1. Acceptance (real events across processes, simulation only): each case of items 14, 15, 16 and 17 on
      every channel, with replay and concurrency; both orders of a status read and a notification; R6H-5 simulation behaviour unchanged; tenant isolation of
      `multiple_captures`; the recovery test's equal capture moved to its own attempt, keeping what it proves. Reactivation stays out until its decision.

- **S0-C13 Part A Terminal dispute conflicts: visibility and recording audit (2026-11-05, ADOPTED CONTRACT, the Owner's Part A GO: clarification of S0-C9 items 3
  and 8; logic-audit finding F-02; register PAY-09 J, PAY-12 K). IMPLEMENTED (#479) and PASS FOR DEVELOPMENT AND SIMULATION ONLY (the Owner's decision, 2026-11-05, at `069da1f`, main CI 42102155049 24 of 24): not
  production-certified and not real-money ready.** Retained: S0-C11 L2 (two-Company cross-process isolation); a mandatory security review of provider-reference
  correlation and cross-tenant disclosure before real-provider certification; items 8 and 9's exclusions; exposure `unresolved` until Part B. Parts B and C are not adopted and
  are not authorized. S0-C9, S0-C11 and S0-C12 are unchanged and govern. Before this entry a conflict was stored and counted as `unresolved` exposure, but no Owner
  API listed it and no audit record was written for it.
  1. *Owner item.* Every `payment_dispute_observation` with disposition `conflict`, exactly the rows the exposure's `conflicts` field counts, of a payment whose
     seller is a Company, is readable by that Company's active Owner through PAY-12 kind `dispute_conflict`, whether or not Payment holds a dispute record for it.
     Read-only and derived at read from committed evidence, with no new storage. A provider dispute reference is always stated on such a row; what can be missing is
     Payment's own dispute record.
  2. *Isolation and identity.* Scoped through the payment's seller, verified live from the Owner's own bearer. Another Company's Owner gets no such item, a
     non-Owner or a service gets `403`, Auth unavailable gets `503`, and a service read of the kind gets the same `400` as a kind that doesn't exist. The item's id is
     the observation's id, with the existing keyset paging. One observation exists per webhook event, so a replay adds no item; a distinct provider event is its own
     observation and its own item.
  3. *Fields.* The standard item fields, with `amount` and `currency` as the notification stated them and `at` as the observation time, and `detail`: `reason`,
     `notificationKind`, `attemptId`, `providerDisputeId`, `disputeId`, `chargeback` (`{reference, amount, currency}` or null) and `providerOccurredAt`. Each value is this
     observation's or its payment's, never one read from another payment's row. **`disputeId` is non-null only when that dispute belongs to this payment:**
     `payment_mismatch` names a dispute of another payment, possibly another Company's, so its id is withheld. No id is ever fabricated. Never included: the raw body,
     headers, signature, credentials or the webhook event id. No resolution, status or acknowledgement field exists until Part B defines a lifecycle.
  4. *Original evidence.* The original form stays in its authoritative stores: the stored authenticated notification and the immutable observation (CB-6). Nothing
     rewrites them, and the item and the audit record expose only the structured fields stated here.
  5. *Audit action `payment_dispute.conflict_recorded`.* Business meaning approved by the Owner. Category `commercial`; version 1, no trusted scope and no `approvedBy`,
     as every Payment action (S2-Audit D3). Producer `payment-service`, actor system `payment_webhook`, because a conflict only ever comes from a verified provider
     notification, on first delivery or on the retrier's last permitted processing. `organizationId` as recorded on the payment (optional). Resource
     `payment_dispute_observation` and the observation's id, since there may be no dispute. No subject; outcome `succeeded`. Changes: `payment_id` and `attempt_id`
     (uuid, required), `reason` (code: the six conflict reasons), `notification_kind` (code: `opened`, `won`, `lost`), `dispute_id` (uuid, optional, under item 3's rule).
     No amount, provider reference or chargeback reference. Written in the observation's own transaction through the transactional outbox, with an event id
     derived from the observation's id; a failed write fails the transaction, leaving the notification retryable. A replay finds the observation first and writes
     nothing. Earlier observations stay unchanged and readable and get no audit record (CB-6).
  6. *Audit compatibility and order.* Additive to the catalog and compatible: an audit-service with an older catalog refuses the action as `unknown_action` and keeps the
     message replayable after an upgrade (ADR-0049 A50). Adding it requires, together: the catalog entry and its regenerated document, the catalog's pin tests, and
     Payment's broker topic permission (`infra/rabbitmq/provision.sh`, pinned in `scripts/check-repo.test.mjs`). In any environment, the broker permission and an
     audit-service with the new catalog come before Payment emits it. Payment isn't in production, so this entry requires and performs no deployment; any later one
     stays separately authorized.
  7. *Financial safeguards.* Visibility and evidence only. Reading changes and clears nothing, and an item never means exposure has cleared: `unresolved` stays
     `unresolved`, and the exposure read stays the authority. Refund and L-4 refusals, capture and payment finality, Organization obligations, recovery allocation
     and every immutable record are unchanged. No clearance, dismissal, refund, compensation or event follows from it.
     *PAY-09 isolation (the Owner's Part A implementation GO; ADR-0050).* A dispute's detail lists an observation naming it only when that observation's payment is
     sold by the same Company. A notification of another Company's payment that names the dispute (`payment_mismatch`) is that Company's evidence, in its own item.
  8. *Boundary.* Only evidence safely bound to a known payment and seller Company. Outside this entry: malformed notifications and notifications matching no attempt,
     which have no trusted payment binding; a held notification, which is not yet a conflict (S0-C9 item 3); and a payment sold by an Organization, as with every
     PAY-12 Owner kind. A Company is never inferred from an untrusted payload. **Provider-level visibility and reconciliation of the unbound notifications stays a
     future requirement.**
  9. *Order.* Part A, then S0-C10 (multiple-chargeback protection), then Part B (evidence-based conflict resolution), which needs its own adoption. Reassess if Part A
     exposes a critical safety issue. Until Part B, a conflict has no exit: its payment's exposure stays `unresolved`.
  10. *Acceptance (later implementation, simulation only; needs a separate Owner authorization).* The Company's Owner reads every reason, with and without a dispute
      record; another Company, a member, a service and a service read are refused; `payment_mismatch` withholds the other payment's dispute id; paging is stable; earlier
      rows stay readable and unaudited; the audit record is atomic and single under replay and retrier processing; reading writes nothing and exposure, refunds and L-4
      answer as before; a real cross-process read replaces the admin SQL in `s-int-late-capture-disputes`. ADR-0035 and ADR-0069 stay Proposed, and this entry implies no
      acceptance. ADR-0049 is unedited; its catalog rule governs item 6.
- **S0-C14 Refund and chargeback overlap precedence (2026-11-06, ADOPTED CONTRACT FOR CONTROLLED DEVELOPMENT AND SIMULATION IMPLEMENTATION ONLY, the Owner's S0-C14 Step 0 GO:
  corrected items 1 to 15, labelled C1 to C15 in the Owner's review and distinct from ADR-0035's clarifications; clarification of FC-4, B10, R6F-4, R6F-8, R6H-2, S0-C9 item 6 and BIL-34 F;
  an Owner-approved narrow amendment of S0 §3.5, FC-9, I-11, DN-1.2, BIL-26 part G and the Billing README in item 7; findings DO-50, DO-51, DO-52). IMPLEMENTED for Core V2 DEVELOPMENT AND SIMULATION ONLY (S0-C14 WP A to D, 2026-11-06, the Owner's WP GOs; local branch, integration checkpoint pending): not production-certified and not real-money ready. The certification verdict (item 20) awaits the Owner's review.** Assigns no liability. FC-1, FC-5, S0-C9 to S0-C13 and every
  recovery invariant not named here are unchanged and govern. Before this entry the outcome of a refund and a chargeback on one captured movement depended on arrival order (item 18), and no adopted
  rule set precedence between FC-4, B10, R6D-1 and R6F-4.
  1. *Terms (C1).* A **recovery obligation** is the recorded debt. **Collection permission** is whether a new settlement channel may start. **T3** is the derived restriction on new
     assistance requests. A **suspension** is an Owner decision that T3 does not apply to one obligation. None of these is a final financial resolution. None exists under this entry.
  2. *Overlap (C2).* An overlap exists when one captured movement has both a completed refund and a verified chargeback loss. It is decided from recorded facts, never from arrival order.
  3. *Facts stand (C3).* No provider fact, balance, loss, review, reversal, write-off, obligation, recovery payment or suspension record is rewritten, deleted, clamped, netted or automatically
     undone.
  4. *Refund governs the purchase (C4).* A completed refund reverses its purchase under R6D-1, even after a final loss. FC-4 and B10 read: a chargeback never reverses an assisted purchase.
  5. *Waiting effect (C5).* A recovery obligation or direct write-off is a **waiting effect** while any relay of that movement is `NULL`, `authorization_pending`, `authorized`, `dispatching`,
     `submitted`, `unknown`, `discrepancy`, or `succeeded` with its case not completed. It is also waiting while Payment cannot confirm the position under item 6. The loss, its effect row and
     any direct reversal are not delayed.
  6. *Resumption (C6).* A waiting effect proceeds only when: (a) a Payment refunds read that started after the loss was committed in Billing, and was not reused, shows no live attempt, no refund
     evidence and no attempt unknown to Billing; and (b) at the effect's own statement, every relay of that movement is `rejected`, `authorization_expired`, `authorization_refused` or `failed`.
     No timer resumes an effect. No lock spans Billing and Payment. This item does not guarantee that no refund follows: a refund reported after a confirmed failure may coexist with the
     effect, and item 8 then applies.
     - **Safety invariants.** *I1 Closed set:* once a chargeback fact is committed, no new refund attempt can commit for that payment (admission and dispute ingestion share the payment row lock;
       application logic under a database lock, not a constraint). *I2 Fresh read:* the read starts after the local loss commit, so it sees the whole closed set; results are never reused across
       decisions. *I3 Double check:* an effect commits only if the read showed no live attempt and no refund evidence, and the guard then saw no live relay. Only (b) is database-enforced; a
       database guard cannot prove that a read happened.
     - **The race.** After the read, a `failed` attempt can still gain verified money at Payment before the effect commits. It cannot be prevented, only detected. What the invariants prove: an
       effect committed at a moment after the loss when every attempt was refused, expired or `failed`, with no refund evidence. Refused and expired attempts were never dispatched. So an effect
       can sit beside a refund only if the provider confirmed failure and later reported money, or the money reached no attempt at all.
     - **PAY-08 is not a snapshot.** It runs separate queries, attempts first. Attempt states only move forward, so it behaves as a slightly earlier read, which is safe.
  7. *Collection freeze (C7).* While an overlap exists on an obligation, no new settlement channel may start. A channel already open continues. Every verified recovery payment is counted as
     adopted. **S0-C14 C7 exception.** While a refund and chargeback overlap exists on a recovery obligation, starting a NEW recovery settlement channel on that obligation is refused. For that
     obligation only, this narrows S0 §3.5 (a new channel also requires that no overlap exists), I-11, FC-9 and the "recovery settlement" entry of DN-1.2. Channels already started, the recording
     of verified money and every other discharge action are not excepted. The S0 §8 criterion keeps its text and is read with this exception. DN-1 still does not amend ADR-0060. A-6 (PAY-03 F) is
     not part of this amendment: the refusal is in Billing and existing channels continue.
  8. *Overlap case (C8).* The reconciliation worker opens one `chargeback_refund_overlap` case per overlap, whatever the purchase kind, capture basis or order. It cannot be acknowledged, and
     has no resolution kind under this entry.
  9. *Acknowledgement (C9).* Acknowledging a review closes only that review. `reviewed_no_financial_effect` is refused while an overlap exists on that movement.
  10. *Suspension (C10).* The live Owner of an obligation's Company and Platform may suspend its T3 with a `recovery_restriction_suspend` receipt, while the obligation is open and an overlap exists
      on it. *(The Owner's WP A finalization, 2026-11-06: the receipt binds the Company, the suspension id (chosen before the receipt), the obligation, its Organization, the loss's dispute, the
      completed refund case of the overlap and the closed reason code `refund_chargeback_overlap`; register AUTH-01 H.)* A suspension changes T3 for that obligation only. It has no expiry. An open or uncertain channel does not block it. The debt, the freeze, T1, T2, a write-off and the overlap case are
      untouched, and an unused suspension right never lapses: if the Owner never acts, T3, the freeze and the case stay. Evidence is append-only, one `suspended` and at most one `revoked` per
      suspension id, at most one active per obligation, each with a unique receipt and `consumeRef`; the database re-derives eligibility under the Organization lock.
  11. *Revocation (C11).* That Owner may revoke an active suspension with a `recovery_restriction_revoke` receipt *(the same fields, the active suspension's id, and the closed reason code
      `owner_reinstated_restriction`)*. T3 then applies to new requests only. There is no automatic revocation.
  12. *Waiting visibility (C12).* Each waiting effect opens one `chargeback_effect_waiting` case, which cannot be acknowledged. It resolves only as: `effect_applied`, when the obligation or direct
      write-off of that loss exists; or `refund_completed`, naming the completed refund of the same captured movement, when the effect will not be applied. Otherwise it stays open. Overlap cases
      are unaffected. `effect_applied` is never used when no effect was applied. No new resolution value is needed. The database check for this type is stricter than the existing
      `refund_completed` branch: a capture-specific refund of another capture does not count. The case opens only for a loss that qualifies for an effect (S0-C10 item 4); a partial or repeated loss
      was never going to produce one. Waiting cases are Owner-only.
  13. *Reads (C13).* Existing obligation and restriction reads state collection and suspension status. An absent T3 never implies the debt ended.
  14. *Reconciliation safety check (C14).* The Billing financial reconciliation check runs before the four financial workers (`dispute_loss_worker`, `refund_effect_worker`, `recovery_worker`,
      `reconciliation_worker`) start, on every process start. It is a consistency safety check. **It is not proof that no independent restore occurred.** A pass means only that no inconsistency was
      found in what it covers. Item 6 still applies to every effect.
      - **Coverage limits.** It cannot detect: a Billing rewind affecting payments with no loss yet (Payment has no list of all attempts; item 6 covers these when a loss arrives); both databases
        rewound together; provider activity Core never received; rewinds after the scan; losses with no chargeback fact, which the losses read omits.
      - **Scan.** Page `GET /payment/disputes/losses` by keyset, at most 200 per page, until a short page. Page Billing relays, losses and completions by keyset the same way. Read PAY-08 for every
        payment involved. A partial, failed or timed-out scan is not a pass, and there is no sampling. Compare in one direction only: Payment ahead of Billing's mirror is normal, so an event in
        transit never counts as a mismatch.
      - **Worker startup.** The process and HTTP start normally. The check runs in the background and never blocks bootstrap. The four workers construct but run no pass until it passes, and each
        instance runs its own. *Unavailable* (Payment down, partial scan): retry with backoff, workers stopped, logged, `/ready` unaffected. *Mismatch:* sticky for the process life, workers stopped,
        `/ready` not ready, no automatic override. Nothing is lost while stopped: rows wait in the database and are selected later. The relay reconciler stays on.
  15. *Limits (C15).* Nothing here assigns liability, forgives debt, sets a timeout or defines a final resolution. D9 (partial refund beside a loss) and D15 (final liability for the overlap
      shortfall), decision numbers of this review and distinct from [OD] D1 to D8, stay unresolved. A `discrepancy` relay waits under item 5 until a separate decision.
  16. *Exact amendments.* Each adopted text below is kept in place and carries a dated pointer here. Nothing is deleted.

      | Rule | Adopted text, kept | Effect of this entry |
      |---|---|---|
      | S0 §3.5 | "a new channel only after definitive closure" | Item 7: a new channel also requires that no overlap exists on that obligation |
      | S0 §3.5, BIL-28 A | "T3 clears only when verified recoveries reach the base amount" | Item 10: a suspension stops T3 applying to that obligation and never clears the debt |
      | FC-9, I-11 | "block **new** assistance requests only"; "discharge stays available" | Item 7: the exception, on that obligation only. A collection freeze is not a restriction |
      | DN-1.2 | "recovery settlement" in the closed discharge set | Item 7: starting a NEW channel is excepted during an overlap; recording verified money never is |
      | BIL-26 G | "blocks only NEW assistance requests: every discharge action, including recovery settlement and surplus confirmation, stays available" | Replaced for the future by BIL-26 H |
      | Billing README | Discharge wording of the S5d and S6f notes | Dated pointers; the README keeps describing current behaviour until implementation |
      | S0 §8, S0-C7 item 2 | "every discharge action works for its authorized actors" | **Wording unchanged**, read with item 7 |
      | FC-4, B10 | "An assisted purchase lost at final stage is never reversed" | Item 4: a chargeback never reverses it; a completed refund does |
      | R6F-4, R6F-8 | "a FULL chargeback of a never-refunded payment"; refunded: "no debt and no T3" | Items 5, 6: decided with live refunds too. A committed obligation stands if a refund completes later (item 3) |
      | S0-C9 item 6 | "a chargeback after a completed refund of that capture is `chargeback_refund_overlap`" | Item 8: applies to every capture basis, including an assisted settling capture |
      | R6H-2 | Review-only acknowledgement | Item 9 |
      | BIL-34 F | "never with a completed refund of the payment" | A rule at recognition, widened by items 5, 6. Not an end-state guarantee (item 6): a write-off already recorded stands and item 8 opens the case |

      ADR-0035, ADR-0044 Part B, ADR-0057, ADR-0067, ADR-0068 and ADR-0069 stay Proposed and unedited; no Accepted ADR is edited. F-22 (ADR-0067's text) stays open and gains the two operations of item 10.
  17. *Recorded limitation: no new collection route.* An unresolved obligation can consequently have no new collection route: if its only channel closes during an overlap, or none was open, nothing
      can collect the remainder. An overlap is derived from permanent facts, and neither a suspension nor anything else under this entry ends it, so the freeze lasts until a separately adopted
      contract provides otherwise. The debt stays open and visible. This is not forgiveness, a write-off, a release or a final financial
      resolution, and no read may imply one. **Owner decision, 2026-11-06:** this is an INTERIM development and simulation policy, and it is an explicit
      blocker for real-money readiness until a separately approved resolution policy exists.
  18. *Findings (post-workshop validation, 2026-11-06, at `2ae3dea`, simulation provider, real processes, each scenario run twice; the observation register is kept outside this repository).* Every database
      invariant held in every run: each step was lawful, and the guards check only at insert. **Status (2026-11-06): remediated for DEVELOPMENT AND SIMULATION ONLY** by the
      implementation of items 4 to 14 (WP A to C) and certified locally in the tested scope (WP D, item 20); each stays open for production and real money.

      | Finding | Classification | Observed | Governed by |
      |---|---|---|---|
      | DO-52 | **Reproduced defect** | Assisted, loss first, then an in-flight refund: open obligation and T3 on a reversed, refunded purchase, no case, and a new settlement accepted | Items 4 to 8 |
      | DO-50 | **Reproduced defect**, in one ordering; the other two conform | Direct, write-off pass first, then an in-flight refund: write-off stands and no overlap case opens. Acknowledging `second_reversal_cause` then left no open case | Items 5, 6, 8, 9 |
      | DO-51 | **Confirmed visibility gap; policy interpretation resolved by this entry** | Assisted, refund first, then loss: debt protection works as adopted, but only a `recovery_review` row, no case and no read route | Item 8: S0-C9 item 6 covers this path |

  19. *Implementation dependency plan (each step needs its own Owner GO; development and simulation only).* Status 2026-11-06: steps 0 to 7 done locally (WP A: steps 1, 2; WP B:
      steps 3, 4, 6; WP C: step 5; WP D: step 7); step 8 is the integration checkpoint, separately authorized.

      | Step | Work | Depends on |
      |---|---|---|
      | 0 | This contract text. No code | Owner GO (done by this entry) |
      | 1 | Audit catalog: `recovery_restriction.suspended`, `recovery_restriction.suspension_revoked` (version 1, no trusted scope), `case_type` value `chargeback_effect_waiting`; generated document, pin tests, Billing's broker topic permission and its check-repo pin. No `resolution` value | 0 |
      | 2 | Auth: two factor-only purposes, two bindings. Code only, no migration | 0, parallel with 1 |
      | 3 | Billing migration (PROPOSED `0050`, expand-only, no data): suspension event table, guards, `billing_assistance_restrictions`, case type constraint, and `billing_reconciliation_resolution_guard` with item 12's stricter same-movement check | 1 |
      | 4 | Billing service: overlap discovery, waiting filter, Billing client parsing PAY-08 `allocations` and `unallocatedFacts` (Payment already returns them), post-loss read rule, freeze, acknowledgement rule. Worker filters ship with guard use, so a trigger refusal never aborts a pass | 3 |
      | 5 | Billing: suspend and revoke routes, read fields, the BIL-26 route description | 2, 3 |
      | 6 | Billing: reconciliation safety check (item 14): complete scan, background start | 4 |
      | 7 | Tests V1 to V32, cross-process, two instances | 4, 5, 6 |
      | 8 | Certification; registers updated for DO-50, DO-51, DO-52 | 7 |

      Payment and File need no change. In any environment: audit catalog, broker permission, Auth, then Billing.
  20. *Certification tests (all required; V30, V31 and V32 are explicitly required).* Interleavings use barrier locks held by the test, labelled as test aids, with two separate Billing processes.
      V1, V2, V3 and V9 are critical.

      | Test | Setup | Fails if |
      |---|---|---|
      | V1 | Hold the recovery visit between read and insert; complete the refund | Obligation opens |
      | V2 | Same for the write-off pass | Write-off recorded with a live relay |
      | V3 | Two Billing processes, one database, one loss, many passes | Two obligations, two write-offs or two cases |
      | V4 | Direct SQL insert past the application with a live relay | Guard accepts it |
      | V5 | Direct SQL channel insert during an overlap | Guard accepts it |
      | V6 | Refund `failed`, effect proceeds, verified refund lands | No overlap case, or any effect undone |
      | V7 | Channel open, overlap arises, then the payment succeeds | Payment refused or dead-lettered |
      | V8 | Suspend, then full recovery | T3 reappears, or the suspension row changed |
      | V9 | Suspend and assistance request concurrently, two processes | T3 read mid-change |
      | V10 | Two concurrent suspensions; replayed receipt | Two active suspensions, or a second consumption |
      | V11 | Receipt for another obligation, Organization or Company | Accepted |
      | V12 | Crash after Auth consumed, before commit; retry | Nothing recorded, or the retry refused |
      | V13 | `NULL`, `unknown`, `discrepancy` relays beside a loss | Effect proceeds, or no waiting case |
      | V14 | Relay row deleted to simulate a rewind, refund live | Effect proceeds: item 6's read must hold it. Must pass |
      | V15 | Refund after a chargeback attempted at Payment | Admitted |
      | V16 | Acknowledge `second_reversal_cause` during an overlap | Reason accepted, or the overlap closes |
      | V17 | Payment holds an attempt with no relay | Effect does not wait |
      | V18 | Two suspension requests at once (Auth holds one Owner per Company: that Owner's two receipts) | More than one active suspension |
      | V19 | Suspension or revocation races an assistance request, two processes | T3 applied retroactively, or read mid-change |
      | V20 | Waiting case on each exit, then a real overlap | Wrong resolution (`effect_applied` with no effect), or no overlap case afterwards |
      | V21 | Reads for the Owner, the Organization administrator and another Company | Wrong status or disclosure, or a read implies the debt ended |
      | V22 | Billing starts with a relay removed on a payment that has a loss | Workers start |
      | V23 | Payment unreachable, or behind Billing | Workers start; or a mismatch is not sticky |
      | V24 | Many concurrent lost disputes and refund admissions | An attempt commits after a chargeback fact |
      | V25 | Attempt live at the read; barrier before commit | Effect commits |
      | V26 | Attempt `failed` at the read; barrier; verified refund lands; release | Effect undone or refused, or no overlap case within two passes |
      | V27 | Recording proxy on PAY-08 | A read started before the loss commit, or is reused across decisions |
      | V28 | Mirror and Payment disagree, both directions | Effect commits |
      | V29 | PAY-08 answers 503, malformed, or without refund evidence | Effect commits |
      | V30 | All attempts dead at the read; a new relay commits before the transaction | Guard allows the effect, or the effect never resumes after `rejected` |
      | V31 | Labelled fixture: an attempt at Payment with no Billing relay | Effect commits, or nothing flags the mismatch |
      | V32 | Recording proxy on Payment's refund call | The relay row is not committed when the call arrives |

      **Local result (WP D and the Owner's final concurrency proof, 2026-11-06, development and simulation, one host):** V1 to V32 pass across real Auth, Payment, Audit and two
      Billing processes, except V4, V5 and the `unknown`/`discrepancy` part of V13, which pass in-process on real PostgreSQL.
      - **Forced interleavings** (the order is imposed and proven from the database: `pg_stat_activity`, `pg_blocking_pids`, `pg_locks`; no waiter fairness is assumed, because the transaction that goes
        first holds the contended lock while paused on a separate test gate). V1: a worker paused at its `INSERT` after a clean PAY-08 read while the late refund completes; the
        database refuses it (0039's `recovery_obligation_refunded` fires before 0050's guard). V9 and V19: both orders each, with real Organization-lock contention. V24: both
        transaction orders, with real payment-row contention. V30: a worker paused at the Organization lock while a relay commits. V26, V28 and V12: a controlled sequence.
      - **Natural concurrency** (the outcome is checked, not each ordering): V3, V18, and V24's stress part.
      - **Certification limitation (deferred by the Owner, 2026-11-06):** the direct write-off's insert window is not forced. V2 proves the write-off waits while a refund is live, and the database
        guards exist, but no test pauses a write-off at its insert while a refund completes.
  21. *Assumptions register.* None is database-enforced across the two databases. **A1, A3, A4 and A6 are not proven by the tests cited for them in the Owner's review.**

      | Assumption | Status | Proof required |
      |---|---|---|
      | A1 Billing commits the relay before calling Payment | Code order; **locally evidenced by V32** (every relay call of two processes arrived after its row was committed) | V32 (done locally) |
      | A2 After a chargeback, Payment refuses every new refund (I1) | Application rule under a row lock; **locally evidenced by V15 and by V24 forced in both transaction orders** (real payment-row contention). V24's stress part submitted 66 admission requests: that is a count of requests, not of lock races, and few of them contended. Not exhaustive | V15, V24 (done locally) |
      | A3 Only Billing creates refunds for its payments | **Not proven.** Policy and producer check; no test confirmed | A named test at certification; V31 covers only the failure case |
      | A4 A dead relay status comes only from Payment's own statement | **Not proven.** V28 proves an effect stays safe if A4 is false, not that A4 holds | A named test at certification |
      | A5 Neither database is rewound independently | **Not provable by Core** | V14, V22, V23 reduce it; `G-FIN-RESTORE` governs |
      | A6 Payment's loss eventually reaches Billing | **Not proven.** No test confirmed | A named test at certification |
      | Provider de-duplicates by key and may report after failure | Unknown | Real provider only |
      | A refund that matches no attempt | Not covered: stays an unmatched fact | Separate work |
      | Multi-instance behaviour | Local proof only | V3, V9; real deployment |

  22. *`G-FIN-RESTORE` (mandatory production activation gate of Billing; S0 §6).* These modules are not mounted in production, so it needs no code now. Billing and Payment are in backup scope, with
      paired restore points. After any restore of either database, the financial workers stay off by deployment control until the Owner authorizes them. A documented procedure reconciles the two
      databases and the provider. A restore drill has passed. In development and simulation: after a restore of either database, discard both, or stop and report.
  23. *Preserved.* Earlier drafts of items 6, 12 and 14 were never adopted: in particular `effect_applied` on the mere existence of an overlap case, and a startup gate described as a restore gate. Every other
      outstanding observation of the workshop register stays open as recorded, as do S-INT's F findings, S0-C13 Parts B and C, S0-C11 L2, V-4, V-5 and the OD items. No production gate moves: G6 deferred, G7, F6 and F7
      locked, Final Core Validation last.
- **S0-C15A Unresolved refund and chargeback exposure (2026-11-07, ACCEPTED FOR DEVELOPMENT AND SIMULATION within the locally tested scope, the Owner's S0-C15A decisions A1, A2 (partial) and A3 and the Owner's acceptance of R1 to R17, the negative controls and migration `0051`: not production-certified and not real-money ready; finding DO-72).** Assigns no liability. FC-1, FC-5, S0-C10 items 2 and 8, and S0-C14 are unchanged except as stated. Before this entry a partial refund and a partial chargeback of one captured movement could leave every Billing case closed while Payment's balance stayed negative (DO-72): S0-C14 item 9 protects a completed refund only.
  1. *Exposure.* An exposure exists on a verified loss with a chargeback fact when no refund of its captured movement is completed and refund evidence of that movement is unresolved. Refund evidence is a relay at `discrepancy`, a relay at `succeeded` whose case is not completed, or a `refund_discrepancy` case of a relay of that movement. A `refund_discrepancy` case of the payment naming no relay Billing holds also counts, because it cannot be shown to be other money. A relay of another capture never counts. It is decided from recorded facts, never from arrival order, an amount threshold or a balance. In-flight attempts are not refund evidence.
  2. *Not an overlap.* An exposure is not an overlap under S0-C14 item 2. It freezes no collection, creates no restriction and changes no waiting effect.
  3. *Facts stand.* No provider fact, balance, loss, reversal, write-off, obligation, recovery payment, review or earlier resolution is rewritten, netted or undone. An acknowledgement already recorded stands.
  4. *Exposure case.* The reconciliation worker opens one `chargeback_refund_exposure` case per exposure, whatever the purchase kind, capture basis or order. Its evidence is the loss's dispute, and its amount and currency are the loss's chargeback, which is verified. It is Owner-only and cannot be acknowledged. Its `detail` records, once at opening, what the refund evidence proves: `refund_money_verified` only when a fresh Payment refunds read shows a verified allocation on a relay of that movement; otherwise `refund_evidence_unresolved`, which claims no money, including when Payment cannot answer or the movement association is uncertain. The case opens either way, so the Owner sees it.
  5. *Exit.* It resolves only as `refund_completed`, naming the completed refund of the same captured movement, once that movement's `chargeback_refund_overlap` case exists. Otherwise it stays open. No timer, Owner action or balance closes it.
  6. *Acknowledgement.* While an exposure exists on a case's movement, `reviewed_no_financial_effect` and `duplicate_evidence_reviewed` are refused. `provider_statement_reviewed` makes no claim about money, stays available and closes only that review. This rule applies to exposures only: S0-C14 item 9 is unchanged for a completed-refund overlap (decision A2).
  7. *One rule, two places.* `billing_acknowledgement_refused_by_exposure` is the one rule. The database resolution guard and the service both call it; the database decides, and the service answers `409 reconciliation_case_in_exposure`.
  8. *Meaning.* The case states that a verified chargeback sits beside refund evidence that is not resolved, and which class that evidence is. It is not a debt, a loss, a write-off, a restriction or a resolution, and no read may imply one. It does not state a refund amount: that stays at Payment and is read from Payment's balance route.
  9. *Timing.* No lock spans an acknowledgement and an arriving fact. An acknowledgement that commits before a fact is recorded stands, and the case then opens from the facts at a later worker pass. The class in `detail` is not updated later: a case opened as `refund_evidence_unresolved` stays so even if money is verified afterwards, and Payment stays authoritative.
  10. *Limits.* D9, D15, FD-1 to FD-5 and the collection-freeze exit stay unresolved. Not covered: a refund fact matching no attempt (DO-57, S0-C14 item 21), a chargeback stated only in a conflict (DO-56), and a payment sold by an Organization, as with every Owner case kind. The evidence class is held by Billing's case, not by the audit record, which carries the case type only.
  11. *Amendments, all pointers.* R6H-2: two reasons are refused under an exposure. S0-C10 item 10: acknowledgement unchanged except beside unresolved refund evidence. S0-C14 item 9: unchanged. BIL-33 N. Audit catalog: one `case_type` value; no action, resolution value, field or broker grant changes. Migration `0051`, expand-only. In any environment: audit catalog, then Billing. Payment, File and Auth need no change.
- **S0-C15B Contested refund and dispute evidence stays Owner-visible (2026-11-08, IMPLEMENTED FOR DEVELOPMENT AND SIMULATION, merged by the Owner in #487 at `89cad7c`; the Owner's decisions B-D1 to B-D11 with the revised B-D3, B-D6 and B-D8; migration `0052`: not production-certified and not real-money ready; findings DO-56, DO-57).** Assigns no liability, records no loss, debt or resolution, and changes no money. FC-1, FC-5, S0-C10, S0-C13 Part A, S0-C14 and S0-C15A are unchanged except as stated. Before this entry the Owner could close every Billing case while a refund fact stood contested at Payment (DO-57) or while a chargeback was stated only in a preserved dispute conflict (DO-56).
  1. *Refund contest (DO-57).* One `refund_fact_contested` case per refund fact Payment holds as contested (a recorded provider fact conflict on it), Owner-only. Its amount and currency are the VERIFIED fact's; contested provider amounts stay at Payment (the Owner's `fact_conflict` items, cross-referenced by the case's evidence id, which is the fact's id). `detail` is `contested_after_allocation` or `contested_unallocated`. A refund contest is never a verified loss, a reversal or a resolution.
  2. *Only genuine contradictions (B-D8).* Allocation blocks for `currency_mismatch` or `no_authorization` are not contests: the block alone opens no `refund_fact_contested` case (a fact so blocked and LATER genuinely contradicted opens one, as any contest does). They stay Owner-visible at Payment (`allocation_blocked` items, `unresolved.blocked`) and, since DO-73 (below), in Billing as `refund_fact_unallocated`.
  3. *Payment's reads must agree (B-D6).* The case opens only when Payment's producer item states the contradiction and Payment's refunds read (PAY-08) states the same fact as a refund of the same payment and refund attempt. Otherwise, including when Payment cannot answer, nothing is opened, nothing existing changes, a `payment_evidence_inconsistent` warning is logged and the next pass reads again; Payment's own items stay the visible record meanwhile. A technical inconsistency is never classified as provider evidence and no provider fact is invented.
  4. *Dispute conflict (DO-56, B-D1).* One `dispute_conflict_observed` case per preserved dispute conflict of a payment Billing produced, every conflict reason included (`payment_mismatch` and `capture_unverified` too). Billing learns of it from Payment's producer-only item `dispute_conflict_presence`, which carries the observation's id, the payment and the time only. The case can hold no amount, currency, capture or detail (enforced by the database). The S0-C13 boundary holds: the reason, the notification, the dispute, any chargeback reference or figure, and any other payment or Company stay in the Owner-only `dispute_conflict` item at Payment, which shares the case's evidence id. A contested chargeback never becomes a verified loss.
  5. *Interim fail-closed condition (B-D3).* In this development and simulation phase neither type can be acknowledged or resolved: no resolution kind names them. This lasts until P-2 (dispute-conflict resolution) and the FD resolution decisions (FD-1 to FD-8) define the evidence that may close them. It is not a permanent business rule.
  6. *Acknowledgement (B-D4).* While a contested case exists on a case's movement (same payment; same capture where both name one; a dispute conflict covers the whole payment), `reviewed_no_financial_effect` is refused. `duplicate_evidence_reviewed` is refused only on the contested refund attempt's own `refund_discrepancy` case; an unrelated genuine duplicate stays available. `provider_statement_reviewed` stays available. An acknowledgement recorded before the contest stands. `billing_acknowledgement_refused_by_contest` is the one rule: the database resolution guard and the service both call it; the service answers `409 reconciliation_case_contested`. Order of refusals: S0-C14 overlap, then S0-C15A exposure, then this rule.
  7. *Evidence binding.* `reconciliation_contest_evidence` binds each refund-contest case, in the case's own transaction, to its payment, its refund fact (once), Billing's own relay of the contested attempt (of the same payment) when Billing holds one, and that relay's capture, derived by the database. A case cannot commit without it, and it is append-only. These constraints establish local referential integrity between Billing's rows; they prove nothing about provider financial truth. Without a relay the rule covers the whole payment and the duplicate rule cannot fire.
  8. *Audit (B-D5).* A refund fact contradiction is recorded with the existing `provider_fact_conflict.recorded` action (wording widened to capture or refund facts; optional `refund_attempt_id`), once per recorded conflict row, in its transaction, with the row-derived event id: the same notification again records nothing. No currency, provider reference or body. No historical audit backfill.
  9. *Balance (B-D7).* Payment's balance adds `unresolved.disputeConflicts`; `unresolved.conflicts` keeps its meaning (provider fact conflicts).
  10. *History.* The worker re-reads Payment's full item lists, so contests and conflicts recorded before `0052` open their cases at the first pass; `0052` writes no row, and no earlier case, resolution or financial record is changed.
  11. *Limits.* B-D6 residual: while Payment's reads stay inconsistent Billing has no contest case for that fact, and other cases of that money may be acknowledged meanwhile. DO-73 (point 2) is not covered. Payments not produced by Billing stay Payment-only (B-D9). Held dispute notifications and losses without a chargeback fact are out of scope (B-D10). Financial D9, D15, FD-1 to FD-8, P-2 and the collection-freeze exit stay unresolved. The S0-C15B decision B-D9 is unrelated to the financial gap D9.
  12. *Amendments, all pointers.* R6H-2: one more refused reason under a contest. BIL-33 O; PAY-12 J. Audit catalog: two `case_type` values; `provider_fact_conflict.recorded` purpose widened and one optional field. Migration `0052`, expand-only. In any environment: audit catalog and audit-service, then Payment, then Billing (Billing skips only the presence kind against an older Payment).
- **DO-73 Verified refund money Payment cannot allocate stays Owner-visible (2026-11-08, IMPLEMENTED FOR DEVELOPMENT AND SIMULATION; the local implementation and its verification accepted by the Owner on 2026-11-09; the Owner's decisions U-1 to U-7; migration `0053`: not production-certified and not real-money ready; finding DO-73).** Assigns no liability, decides no exchange rate, reverses no purchase or entitlement, records no loss, debt or resolution, and changes no money. S0-C14, S0-C15A and S0-C15B are unchanged except as stated.
  1. *Case.* One `refund_fact_unallocated` case per verified refund fact of a Billing-produced payment that Payment permanently blocked from allocation for `currency_mismatch` or `no_authorization` (`detail`), Owner-only, from the facts: whatever the refund case's status and whatever was acknowledged before. A `contested` block is S0-C15B's; a fact genuinely both blocked and contested holds both cases (U-1).
  2. *Payment's reads must agree (B-D6 pattern).* Payment's producer item `allocation_blocked` states the block and its reason; PAY-08 states the same fact of the same payment as `blocked` with the same reason, amount and currency, under its refund attempt. Otherwise (Payment unavailable, 404, the fact absent, still pending, another reason or figures) nothing is opened, a `payment_evidence_inconsistent` warning is logged and the next pass reads again; once the reads agree the case opens (U-6). A failure reading the kind skips only this kind.
  3. *Figures (U-4).* The verified fact's amount and currency, exactly, never converted. A currency that is not three capital letters cannot be held without truncation: the case then holds no figures and Payment stays authoritative.
  4. *Interim fail-closed condition (the B-D3 pattern).* No resolution kind names the type: it can never be acknowledged or resolved, until FD-1 to FD-8 define the evidence that may close it. Not a permanent business rule.
  5. *Acknowledgement.* While such a case exists on a case's movement (same payment; same capture where both name one), `reviewed_no_financial_effect` is refused; `duplicate_evidence_reviewed` only on the blocked attempt's own `refund_discrepancy` case; `provider_statement_reviewed` and any unrelated genuine duplicate stay available. One SQL rule, `billing_acknowledgement_refused_by_unallocated`, called by the database guard and the service. An acknowledgement recorded before the case opened stands (U-6).
  6. *Cancellation (U-2, O1).* A refund case with such a case on one of its relays cannot be cancelled (service and database). This is Billing-local: Payment can record a refund fact at any time and no lock spans the two services, so a cancellation that committed before Billing learned of the fact stands, and the case still opens later, linked to that relay. No cross-service atomicity is claimed. Payment's FC-5 check still refuses a second refund of that money.
  7. *Evidence binding.* `reconciliation_unallocated_evidence` binds each case, in its own transaction, to its payment, its refund fact (once), Payment's refund attempt, Billing's own relay of that attempt (derived; a relay of another payment is refused) and that relay's capture (derived). A case cannot commit without it; it is append-only. Local referential integrity only: it proves nothing about provider financial truth.
  8. *Audit (U-3).* Payment records `refund_fact.allocation_blocked` once per newly recorded block row, `contested` included, in the block's transaction, with an event id derived from the fact: identifiers, the reason and the verified amount; never the currency, a provider reference or the notification. No historical backfill. Billing records `reconciliation_case.opened` (one `case_type` value). No operational alerting is added (U-3b, deferred).
  9. *History.* The worker re-reads Payment's full item list, so blocks recorded before `0053` open their cases at the first pass; `0053` writes no row, and no earlier case, resolution or financial record changes.
  10. *Limits.* PAY-08 is unchanged (U-5): an associated unmatched refund fact cannot be blocked for these two reasons, and its absence from PAY-08 while pending is recorded separately as DO-74 (uncharacterized). Payments not produced by Billing, or with no Company Owner, open no Billing case. Observed in the tested path (T20, simulation): Payment refuses a refund attempt on an Organization-sold payment (`payment_not_refundable`) before any refund fact or allocation block exists, so no block, block audit or Billing case follows; this is an observation of that path, not a guarantee for other provider anomalies. Who bears the money, exchange-rate policy, purchase or entitlement treatment, and closure stay with D9, D15, FD-1 to FD-8 and P-2 (U-7).
  11. *Amendments, all pointers.* S0-C15B point 2 (wording). R6B-10: one more refusal of a cancellation. R6H-2: one more refused reason. BIL-33 P; PAY-12 L. Audit catalog: one action, one `case_type` value. Migration `0053`, expand-only. In any environment: audit catalog and audit-service, then Payment, then Billing.

- **DO-74 A refund attempt's own observation of a refund fact that is not its payment's stays Owner-visible and contested (observer side; 2026-11-10, IMPLEMENTED FOR DEVELOPMENT AND SIMULATION, merged by the Owner in #491 at `8d89bed`; the Owner's design decisions of 2026-11-10; migration `0054`: not production-certified and not real-money ready; finding DO-74, Step 0 at `baf32cc`).** Associates no fact, allocates, completes, reverses or writes off nothing, assigns no liability and changes no money. S0-C14, S0-C15A, S0-C15B and DO-73 are unchanged except as stated.
  1. *The defect (R1, reachable).* A provider first reports an attempt's own refund under an unknown reference (an UNMATCHED fact: no payment, no attempt), then the attempt reports it itself. Payment records an observation (`provider_transaction_fact_conflict`) under the observing payment and attempt and moves the attempt to `discrepancy`; PAY-08 lists only the payment's own facts, so S0-C15B's `refundContest` could never agree with Payment, no contest case opened, and the Owner could close the attempt's `refund_discrepancy` as `duplicate_evidence_reviewed`. The same holds when the contradicted fact is another payment's, of the same or another Company.
  2. *PAY-08 (producer only, additive).* `observationConflicts: [{refundAttemptId, conflictIds, observations, firstObservedAt}]`: per attempt of THIS payment, its own observations that contradict a refund fact which is not this payment's (neither its own nor associated to it). Only the observing payment's own rows cross: never the fact, its id, amount, currency, provider reference, payment or Company, and never whether the fact is unmatched or another payment's. A fact of the payment's own stays S0-C15B's path and is never listed. Read-only; every existing field and its meaning is unchanged; S0-C14's and S0-C15A's judgements never read it (a malformed field is discarded alone, never the whole answer).
  3. *Case.* One `refund_observation_conflict` case per observing refund attempt (identity: the attempt, Billing's own relay), Owner-only: no amount, currency or detail, nothing of the fact. Repeated notifications (each a new observation at Payment) and worker passes never open a second case. Opened only when Payment's producer `fact_conflict` item and PAY-08 agree: the same attempt, the item's own observation listed under it (the B-D6 pattern); otherwise nothing opens, `payment_evidence_inconsistent` is logged and the next pass reads again. An attempt that is not Billing's own relay of that payment opens nothing.
  4. *Interim fail-closed condition (the B-D3 pattern).* No resolution kind names the type: it can never be acknowledged or resolved, until the FD decisions define the evidence that may close it. Not a permanent business rule.
  5. *Acknowledgement.* The type joins S0-C15B's contested movement: on the case's movement (same payment; same capture where both name one) `reviewed_no_financial_effect` is refused; `duplicate_evidence_reviewed` is refused on the observing attempt's own `refund_discrepancy` case (`409 reconciliation_case_contested`); `provider_statement_reviewed` stays available. One SQL rule, `billing_acknowledgement_refused_by_contest` (extended), called by the database guard and the service. An acknowledgement recorded before the case opened stands.
  6. *Evidence binding.* `reconciliation_observation_evidence` binds each case, in its own transaction, to its payment, the observing attempt (a foreign key to Billing's relays; a relay of another payment refused; once per attempt), the Payment observation whose item opened it, and that relay's capture (derived). A case cannot commit without it; it is append-only. Local referential integrity only.
  7. *Audit.* No new action. Payment's existing `provider_fact_conflict.recorded` stays once per observation; Billing records `reconciliation_case.opened` with one new `case_type` value.
  8. *History and versions.* Observations recorded before `0054` open their cases at the first pass; `0054` writes no row. An older Billing ignores the field; against an older Payment the field is absent and nothing opens (as before). Order: audit catalog and audit-service, then Payment, then Billing.
  9. *Remaining confidentiality exposure (pre-existing, not widened).* Payment's existing `fact_conflict` item (the observing Company's Owner and Billing's producer read) carries the contradicted fact's opaque id, and the observing organization's `provider_fact_conflict.recorded` names that fact as its resource: an identifier only, never figures, provider reference, payment or Company. Billing never stores it.
  10. *Separate findings, open.* **R3 (PRIORITY, reachable, unchanged):** an unmatched refund whose provider reference equals a FAILED attempt's own, never reported by that attempt, is invisible to PAY-08 and S0-C14 judges the loss clean: the obligation or write-off proceeds although the money may have been returned twice; it needs the Owner's policy decision (no write-off, allocation, authorization or association behaviour is changed here). **O-2 (uncharacterized):** when the contradicted fact is another payment's, that payment's own Billing learns nothing of the contest (its `fact_conflict` item is scoped to the observer); not implemented without a separate GO. **Observed, pre-existing:** a report on a FAILED attempt while a newer attempt of the payment is effective answers the webhook `500` (`refund_attempt_one_effective`), the fact and observation committed first. **F-29 stays locked;** before association authority is reconsidered, PAY-08 must state associated facts as the target payment's own (DO-74 L1–L4) and the DO-74 exclusion of facts associated to the observing payment must be re-certified with real associations.
  11. *Amendments, all pointers.* S0-C15B point 5 (one more contesting type). R6H-2: one more non-acknowledgeable type. BIL-33 Q; PAY-08 H. Audit catalog: one `case_type` value. Migration `0054`, expand-only.

- **R3 Credible refund evidence after a FAILED refund attempt holds a loss's automatic financial effect (2026-11-10, ACCEPTED FOR DEVELOPMENT AND SIMULATION ONLY by the Owner, 2026-11-10; the Owner's design decisions of 2026-11-10 including B-1 option A; Payment migration `0028`, Billing migration `0055`: not production-certified and not real-money ready; finding R3, Step 0 at `8d89bed`).** Associates no fact, allocates, completes, reverses or writes off nothing, assigns no liability, changes no collection, refund authorization or refund allocation, and rewrites no financial record. S0-C14, S0-C15A, S0-C15B, DO-73 and DO-74 are unchanged except as stated.
  1. *The defect (R3, reachable).* A provider refunds an attempt it reported FAILED, under a reference Payment cannot match: an UNMATCHED verified refund fact whose provider transaction id equals the failed attempt's own provider refund id. PAY-08 never listed it (it is no payment's), S0-C14 treated `failed` as dead, and the direct write-off or the assisted obligation proceeded although the money may have been returned. An exact reference match is evidence of RISK, never of ownership: nothing attributes the money.
  2. *Matching authority.* Only an adapter that DECLARES `refundReferenceScope: 'provider'` (today only the simulation adapter) is compared, exactly (same provider, kind `refund`, byte-equal reference). Any other adapter's failed attempts read `unknown` (fail-closed). Real-provider matching is not approved (open decision O-1).
  3. *Payment (PAY-08 I, producer only, additive).* `failedAttemptEvidence: [{refundAttemptId, state}]` per FAILED attempt of the payment: `unmatched_fact`, `notification_pending` (a signature-verified refund notification naming the reference, at any age and in any state, not the attempt's own processed report), `unknown` (no declared authority, a fact under the reference bound elsewhere or associated, a notification naming it with an unusable amount or currency, or the provider's historical notifications not yet indexed) or `none`. Nothing of the fact or notification crosses. Migration `0028` indexes each stored notification once (`evidenceIndex`, `providerTransactionId`; write-once; the signed body unchanged); historical rows are indexed by a bounded, resumable, idempotent backfill that is never scheduled (test databases only in this phase); while any is pending, the provider's failed attempts read `unknown`.
  4. *B-1 (option A).* A signed notification with no trustworthy reference (unparseable, or a refund naming no transaction) is preserved as received, indexed `unparseable` or `no_reference`, logged once without content (`webhook_unattributable_refund_evidence`), and attributed to no payment or Company: no provider-wide hold. It is discoverable by authorized platform operators from Payment's own database (runbook query); an alert on the log line is recommended, none is implemented here.
  5. *Billing (fail-closed by absence and by presence).* The judge holds a failed attempt of the loss's movement unless Payment states `none` (`refund_evidence_after_failure` for a risk, `failure_evidence_unknown` for anything else); the reader also holds when a relay Billing mirrors as failed is not stated `none`. Each effect transaction writes a `loss_effect_attestation` (dispute, effect, the loss's payment and capture copied, the movement's failed relays computed, the read's start at or after the loss and within 120 seconds, the current transaction); the database refuses either effect without this transaction's attestation, or beside a marker. Positive risk becomes a `refund_relay_failure_evidence` marker (one per relay, append-only, never cleared), written by the relay reconciler and the judge path under the relay's row lock; the effect guard share-locks the movement's relays first. Refusals keep the existing constraint names. `decide` refuses an absent read explicitly.
  6. *Owner visibility and hold lifecycle.* The existing `chargeback_effect_waiting` case (Owner-only, never acknowledgeable) carries the reason; it resolves only as `effect_applied` (refused while a marker exists) or `refund_completed`, so an R3 hold is interim and non-resolvable until FD-1, FD-2/FD-3 and FD-8 (and the F-29 association authority for a completed refund) define legitimate closure evidence. A marker also makes the movement's `chargeback_refund_exposure` case open (beside a held loss, or after a committed effect).
  7. *Late evidence.* Evidence that reaches Payment after Billing's read but before its insert, or after the effect committed, is detected (marker, exposure case) while the movement has no completed refund; the effect stands and nothing is rewritten. No cross-service atomicity is claimed. Coverage is NOT complete: see finding R3-F1 (point 12).
  8. *What the database cannot authenticate.* That Payment really answered `none`: a writer with INSERT rights could forge an attestation (refused while a marker exists); owners and superusers can bypass any trigger. The guards establish local consistency, not provider truth.
  9. *History and versions.* `0055` writes no row; the first pass after it records markers from Payment's current answers; earlier effects stand (exposure detection only). An older Payment (field absent) holds only movements with a failed relay; an older Billing on the new schema is refused under the existing constraint names and waits. Order: Payment, then Billing.
  10. *Separate findings, open.* O-2, the failed-attempt webhook 500 and F-29 are unchanged. Unattributable signed evidence (point 4) creates no hold by decision B-1.
  11. *Amendments, all pointers.* DO-74 point 10 (R3 now held; D12 certifies it). S0-C14 item 6 (one more not-clean reason pair). BIL-33 R; PAY-08 I. Migrations `0028` (Payment), `0055` (Billing), expand-only.
  12. *Finding R3-F1 (OPEN; a coverage limit that predates R3, not an R3 regression).* A FAILED relay stays in the relay reconciler's rotation whatever its refund case's status (a case with a failed relay cannot be cancelled), so unmatched evidence that arrives later is still recorded as a durable marker. But once the movement has a completed refund (a later attempt succeeded), `billing_loss_unresolved_exposure` is false by S0-C15A's overlap rule, the exposure case does not open, and the only Owner-visible case is the movement's `chargeback_refund_overlap` (open, never acknowledged or resolved), whose `refund_and_chargeback` detail does not name the marker: the evidence is recorded, not surfaced. Smallest future remediation (not implemented): surface a marker of the movement on the overlap case (a detail or read field), without a new scanner and without changing any resolution.
  12a. *R3-F1 visibility (ACCEPTED FOR DEVELOPMENT AND SIMULATION ONLY by the Owner, 2026-11-10; the Owner's F1-a read-only and F1-b; not production-certified).* Billing's Owner reads of `chargeback_refund_overlap`, `chargeback_effect_waiting` and `chargeback_refund_exposure` (list and read) state `unreconciledFailedAttemptEvidence` (boolean), derived when read from `billing_loss_movement_marked` over the loss's movement: true when an R3 marker is recorded there and no approved evidence-resolution path has reconciled it (none exists). It shows on open and on resolved cases (a `refund_completed` closure keeps its stored resolution; nothing is reopened) and asserts no further refund, double payment, liability or ownership. It carries no fact, figure or provider reference; Company and Platform scoping is the read's own. No status, resolution, timestamp, precedence, uniqueness or acknowledgement rule changes; no new case type, migration or Payment change; an older Billing omits the field. R3-F1 stays OPEN for reconciliation (F-29, FD-6, FD-8); R3-F2 is unchanged.
  13. *Finding R3-F2 (OPEN; current approved S0-C14/S0-C15A behaviour, not changed by R3).* A completed refund of the movement (a second attempt) closes `chargeback_effect_waiting` and `chargeback_refund_exposure` as `refund_completed` (S0-C14 item 12; S0-C15A item 5) while the unmatched fact of the failed attempt stays unassociated: the provider may have returned the money twice. The overlap case stays open; nothing is written off, recovered or attributed. R3 adds no closure or acknowledgement path (it only adds refusals) and no refund-authorization restriction. Deciding it needs F-29 (the association authority for the unmatched fact) and FD-6 and FD-8 (write-off during an overlap; closed resolution kinds).

- **O-2 The fact owner of a contested verified refund fact sees it (2026-11-11, ACCEPTED FOR DEVELOPMENT AND SIMULATION ONLY by the Owner; INTEGRATION OPEN until merge and post-merge verification; the Owner's O2-a to O2-d; Step 0 and design gate at `258c11c`/`f62b96b`: not production-certified and not real-money ready).** Associates, allocates, completes, reverses or writes off nothing; no liability, collection or refund-authorization change.
  1. *The gap (reachable).* An observation recorded under the OBSERVING payment (another payment's attempt, possibly another Company's) left the FACT OWNER's Billing with no case after allocation and, before allocation, with only Payment's `allocation_blocked contested` (DO-73 leaves `contested` to S0-C15B, whose item was scoped to the observer).
  2. *Producer (PAY-12 M).* `refund_fact_contested`, scoped to the fact's own payment, one item per contested fact, carrying only the owner's own fact, figures, attempt and `observedAt`; no observer evidence of any kind. One-bit disclosure to the owner, accepted.
  3. *Consumer (BIL-33 T).* S0-C15B's existing case and evidence, opened by an isolated reader under PAY-08 agreement (fact, attempt, exact figures) and Billing's own relay; no DO-74 fallback; fail closed. Acknowledgement: S0-C15B's existing refusal on the owner's movement only (O2-c).
  4. *Open, unchanged:* the observer-side `fact_conflict` item's foreign fact id (O2-d, separate privacy review); associated facts (F-29 locked); the capture-fact analogue (S0-C11 `capture_contradiction`, uncharacterized); R3-F2, FD-1 to FD-8; the unrelated Billing event-provenance test timing race (`event-provenance.e2e-spec.ts`, the dead-letter notice asserted right after the queue depth). O-2 is not closed before integration and post-merge verification.
  5. *Amendments, all pointers.* DO-74 point 10 (O-2 now implemented for the fact owner; DO-74 D6 certifies A's one owner case, naming nothing of B). S0-C15B's observer path ends early only on the item's own payment's contest case. BIL-33 T; PAY-12 M. No migration.

- **FDR Legacy FD identifiers and the Financial Decision Register (2026-11-11, DATED POINTER, NON-RETROACTIVE; the Owner's provenance gate and FDR v0 decisions of 2026-11-11). Approves no financial policy, definition, resolution kind, closure authority or implementation, and changes no behavior.**
  1. *Legacy identifiers.* The original definitions of FD-1 to FD-8 were not recovered. The repository introduces them only as collective references (FD-1 to FD-5 in the S0-C15A entry, `93ae45d`; FD-1 to FD-8 in the S0-C15B entry, `c24c0f4`); the individual glosses in the R3 entry (points 6, 12a, 13) restate unverified labels. FD-1 to FD-8 remain **unresolved legacy identifiers**. No earlier entry is rewritten, and no applied migration is changed.
  2. *Forward register.* New financial decisions are recorded as FDR-NN in the contract register, §7.2 (Financial Decision Register v0: FDR-01 to FDR-11, every one `v0`, PROPOSED — NOT APPROVED). The FDR is a forward-looking decision register, **not a reinterpretation of earlier approvals**, and no FDR entry defines, approves or satisfies an FD identifier.
  3. *Gates stay unsatisfied.* FDR v0 satisfies no historical gate. Each gate that names FD-1 to FD-8 (the crosswalk in contract register §7.2.3 lists the 15 references) is satisfied only by a separate, dated Owner adoption record that names the approved FDR versions that together meet it and the certification evidence proving the resulting behavior. Until then every interim fail-closed restriction stands.
  4. *Distinct items, unchanged.* F-29 stays **LOCKED**; R3-F2 stays **OPEN**; P-2 stays a separate decision; financial D9 and financial D15 (S0-C14 item 15) keep their identifiers and are distinct from the notification decision D15 of stage 16.1. The four meanings (a refund operation completed; a case resolved; the financial evidence reconciled; final liability assigned) are analytical vocabulary only.

- **FDR-08 v1 Reconciliation closure-evidence framework (2026-11-12, DATED POINTER, NON-RETROACTIVE; the Owner's FDR-08 v1 framework adoption of 2026-11-12, on `main` at `ab058e9`). Approved as a FRAMEWORK ONLY: no resolution kind, case type, acknowledgement or closure authority, financial reconciliation or liability decision, and no behavior change.**
  1. *Approved.* The A–D closure semantics (A a refund operation completed; B a case operationally resolved; C financial evidence reconciled within a stated scope; D final liability assigned), the per-kind evidence documentation requirements, safety invariants S1–S9, the nine restricted case-type dependency framework, and the classification of every existing resolution kind, `acknowledged` included, as level B (operational resolution) only. The record is contract register §7.2.5.
  2. *Unchanged.* Every earlier entry of this section, every applied migration, the resolution guard (Billing `0053`), the reconciliation worker and every acknowledgement rule. F-29 stays **LOCKED**; R3-F2 stays **OPEN**; every legacy FD gate stays **UNSATISFIED** (FDR-08 v1 is not an adoption record for any of them); every other FDR entry stays `v0`, PROPOSED — NOT APPROVED.
  3. *Open findings (no solution approved).* DO-75 post-closure contradictory evidence, with visibility gaps V1 (non-Company sellers: no case), V2 (a repeated observation on one attempt) and V3 (a repeated contest of one refund fact); DO-76 provider refund evidence on a known but unauthorized refund attempt (`no_authorization`; an authorization-integrity anomaly, separate from F-29); DO-77 the intended authority model for non-Company seller visibility (cross-references DO-75 V1). Contract register §7.2.6.

- **FDR-01 v1 and FDR-09 v1 Financial-liability and fee-accounting definitions (2026-11-12, DATED POINTER, NON-RETROACTIVE; the Owner's FDR-01 v1 and FDR-09 v1 definition adoption of 2026-11-12, on `main` at `1325c44`). Approved as DEFINITIONS ONLY: no liability bearer, amount, recovery route, correction or settlement behavior, no fee-accounting model, schema, journal or uniqueness key, and no behavior change.**
  1. *FDR-01 v1 (contract register §7.2.7).* Six analytical stages, FDR-01 L1 to L6 (provider-movement recognition; provider-movement evidence; financial-evidence reconciliation; contractual responsibility; authorized liability decision; collection, recovery or settlement), unrelated to the late-settlement rules L-1 to L-6 (§3.4). They are not an automated workflow, do not map one-to-one to FDR-08's A to D levels, and never establish one another: recognition is not liability (S0-C10 item 2), and a case closure names no contractual bearer. FC-6 losses and S6f recovery obligations are unchanged and not reclassified. Financial D15 (S0-C14 item 15) stays a distinct, unresolved decision.
  2. *FDR-09 v1 (contract register §7.2.8).* Fee categories (provider processing, chargeback, Organization cash fees, fee refunds, reversals and corrections, gross-versus-net reporting, currency provenance, double-counting risks) and six framework principles. Options A (Payment fee facts), B (statement-based records) and C (ledger entries) are alternatives that may complement each other; option D records the CURRENT INTERIM LIMITATION only (principal-based movement accounting; no comprehensive fee accounting) and is not a permanent policy.
  3. *Unchanged.* Every earlier entry of this section, including S0-C10 item 9 (provider reversals; F-26 stays OPEN, now listed as an architecture dependency in §7.2.7) and the FDR-08 v1 pointer above. F-29 stays **LOCKED**; R3-F2 stays **OPEN**; DO-75 to DO-77 stay **OPEN**; S0-C14 item 17 stays a real-money blocker; every legacy FD gate stays **UNSATISFIED**; FD-1 to FD-8 are not reinterpreted. Dated DO-75 and DO-77 cross-references are added in contract register §7.2.6. "Payment SDD O-1/O-2/O-3" (provider contracts; merchant of record; settlement and custody) are distinct from this section's O-1 and O-2.

- **FDR-10 v1 and FDR-11 v1 Provider-evidence and currency-evidence definitions (2026-11-12, DATED POINTER, NON-RETROACTIVE; the Owner's FDR-10 v1 and FDR-11 v1 definition adoption of 2026-11-12, on `main` at `2ce23ea`). Approved as DEFINITIONS ONLY: no real-provider financial policy, adapter, activation, association, reversal, conversion, rate, settlement or financial effect, and no behavior change.**
  1. *FDR-10 v1 (contract register §7.2.9).* Evidence concepts FDR-10 E1 to E4 (provider assertion; authenticated provider event or status observation; evidence supporting an actual money movement; reconciliation against provider statements) and FDR-10 E5 (a Core financial effect derived from approved evidence: a processing consequence, not a higher evidence level); no automatic progression. Safety rules FDR-10 V1 to V7. A won dispute does not by itself prove that funds were restored (S0-C10 item 9); no reversal or loss correction is authorized. Existing simulation and test behavior is unchanged; real-provider effects still need adapter certification and blockers B1 to B8 (S0-C12 item 19).
  2. *FDR-11 v1 (contract register §7.2.10).* Currency-evidence topics and safety principles FDR-11 C1 to C6. Preserved unchanged: no conversion and no inferred rate (S0-C12 item 8); one currency per Platform as current behavior, not permanent policy; currency-mismatched refund facts blocked (DO-73); unmatched and quarantined evidence inert; provider-stated original figures preserved.
  3. *Namespace and unchanged items.* Contract register §7.2.11 qualifies recurring identifiers (R3 O-1; S0-C12 O-1, O-2; S0-C10 O-1 to O-5; the O-2 fact-owner finding; Payment SDD O-1 to O-3; FDR-01 L1 to L6; FDR-10 E and V; FDR-11 C) without renaming any decision. Every earlier entry of this section is unchanged. F-29 stays **LOCKED**; R3-F2, F-26, DO-37 and DO-75 to DO-77 stay **OPEN**; the FDR-01 and FDR-09 policy decisions stay open; B1 to B8 stay unauthorized; S0-C14 item 17 stays a real-money blocker; every legacy FD gate stays **UNSATISFIED**.

- **DO-70 A stored provider notification is never deleted (2026-11-12, IMPLEMENTED FOR DEVELOPMENT AND SIMULATION, pending the Owner's review; the Owner's accelerated-closure GO of 2026-11-12, batch 1; Payment migration `0029`; not production-certified). Enforces the existing FC-1 text "Raw webhooks stay in the existing `webhook_event`"; adds no new rule, effect, route or event.**
  1. *The gap (DO-70).* `webhook_event` guarded only UPDATE (0005 freezes the received evidence; 0028 writes the evidence index once). A notification no fact, observation or quarantine record references (an `ignored`, `failed` or `unmatched` row; a malformed dispute notification, DO-55) could be deleted; a referenced one was protected only by its foreign key.
  2. *The guard.* DELETE and TRUNCATE are refused for every role, the owner included, by trigger (`23514`, `webhook_event_retained`); non-owner grantees, the runtime role included, also lose DELETE, TRUNCATE, REFERENCES and TRIGGER on the table. INSERT, SELECT and the UPDATE of delivery and processing bookkeeping keep their existing rules.
  3. *Evidence.* Payment `db/tests/invariants.sql` (DO-70: eight cases, three of them negative controls; four failed before `0029`) and `test/runtime-role.e2e-spec.ts` (the runtime role is refused on privilege; bookkeeping still updatable; received evidence still frozen).
  4. *Still open.* DO-70 is advanced, not closed: retention and privacy of raw bodies (Payment SDD O-17) and a read route stay open. A future approved retention policy that prunes or redacts stored notifications needs its own migration and authority. DO-22 (no database transition guard for the webhook state machine) is unchanged.

- **DO-45 The capture-processing crash window under a real crash (2026-11-13, VERIFIED FOR DEVELOPMENT AND SIMULATION, pending the Owner's review; the Owner's accelerated-closure GO of 2026-11-13, batch 2; test evidence only: no code, migration or behavior change; not production-certified).** Before this entry, S0-C12 item 7's window (FC-1 and V-2 commit a capture fact on its own before its processing) was evidenced only by a labelled fixture (a fact inserted by SQL, no process killed: `s-int-evidence-completeness`, S0-C12 12(4)).
  1. *The run.* In `s-int-evidence-completeness` (real Auth, Billing and Payment processes, real RabbitMQ, simulation provider), a genuine signed capture of a final (`failed`) payment's failed attempt is delivered while a test connection holds that payment row `FOR NO KEY UPDATE` (LABELLED LOCK HOLD: it fixes only the timing). The fact's own transaction (`FOR KEY SHARE`) commits; its processing (`FOR UPDATE`) waits; Payment is then killed with SIGKILL inside the window.
  2. *What is proven.* Inside the window the fact is committed and no late success exists; the crashed delivery is never acknowledged to the provider; after the crash only the fact and the stored notification (unprocessed) survive. After the restart, durable recovery from committed records records the late success exactly once, with one `payment.late_success.recorded` event and one audit intent, and Billing records one late success and one refund-only case. A redelivery of the same notification and a new notification of the same transaction record nothing twice (one fact, one late success, one event, one audit intent, one Billing record, one case); every Billing case of the payment is its own Organization's under the one Company; the final status is never reopened; nothing is dead-lettered.
  3. *Two recovery paths.* After a restart both durable paths may complete the window: the webhook retrier (the stored notification; audit actor `payment_webhook`) and the item 7 capture reconciler (the fact; `payment_capture_reconciler`). The test accepts either and requires exactly one effect. Locally (not in CI), with only the retrier disabled in the built service the reconciler alone recovered the fact exactly once, and with both disabled the test failed as required (negative control).
  4. *Still open.* DO-49 (several Payment instances) is unchanged. A crash at other steps is not covered by this entry.

- **DO-68 Financial audit delivery across processes (2026-11-13, VERIFIED FOR DEVELOPMENT AND SIMULATION within the scope below, pending the Owner's review; the Owner's accelerated-closure GO of 2026-11-13, batch 3; test evidence only: no code, migration, catalog or behavior change; not production-certified).** Before this entry, refund, dispute, recovery and loss audit intents were observed in the producers' outboxes, and only 14 of the 65 Billing and Payment catalog actions were asserted in a live `audit_record` (the audit-producer suites and the DO-73, DO-74, R3, R3-F1 and O-2 certifications).
  1. *The run.* The last case of `s0c14-overlap-certification` (real Auth, two Billing processes, Payment and audit-service, real RabbitMQ, simulation provider) reads every audit intent Billing and Payment committed during the whole suite (`outbox` rows named `audit.*`) and requires: each was published by its producer's relay; each reached the live audit-service exactly once, under its own source and event id, as the action its outbox recorded; and the refund, dispute, recovery, loss and reconciliation families the suite drives are among them. Audit's dead-letter queue may hold only the suite's existing item 7 identity probe (a raw `{}`, stored redacted as a malformed envelope), never an intent.
  2. *Observed locally (2026-11-13).* 309 intents, 29 actions, all delivered exactly once: among them `refund_case.opened`, `.authorization_relayed`, `.completed`; `refund_attempt.authorized`, `.succeeded`, `.failed`; `refund_authorization.completed`; `payment_dispute.opened`, `.closed`; `recovery_obligation.opened`, `.recovered`; `recovery_payment.recorded`; `recovery_restriction.suspended`, `.suspension_revoked`; `financial_loss.recorded`; `reconciliation_case.opened`, `.resolved`; `subscription_purchase.reversed`; `cash_return_obligation.opened`. Negative control: an intent recorded as published that never reached audit-service fails the case.
  3. *Still open (DO-68 stays PARTIAL).* Catalog actions this suite does not produce are not covered by it, among them `financial_loss.adjusted`, `recovery_obligation.written_off`, `recovery_surplus.*`, `fraud_hold.*`, `payment_dispute.evidence_added`, `.decided`, `provider_fact.associated`, `payment_late_success.recorded` and `payment_capture_mismatch.recorded`. Audit runs in compatibility mode (DO-46); verified provenance is not asserted here. A production comparison of outboxes with `audit_record` (DO-69) is unchanged.

- **DO-49 Payment as two instances on one database (2026-11-13, VERIFIED FOR DEVELOPMENT AND SIMULATION within the scope below, pending the Owner's review; the Owner's accelerated-closure GO of 2026-11-13, batch 5; test evidence only: no code, migration or behavior change; not production-certified).** Before this entry Billing's workers ran as two processes in the S0-C14 suite, while Payment's leases, `SKIP LOCKED` claims and relay had no cross-process multi-instance run.
  1. *The run.* `do49-payment-multi-instance` spawns TWO built payment-service processes on one database and one real RabbitMQ (simulation provider; every worker of both instances running). Labelled set-up, by SQL: notifications left `received` (the state a crash between transactions A and B leaves) and committed capture facts of final payments whose processing was lost (the S0-C12 12(4) fixture shape).
  2. *What is proven.* The same signed capture delivered 8 times at once across both instances: one fact, one stored notification, one succeeded attempt, one `payment.succeeded` and one audit intent. Stuck notifications raced by both instances' webhook retriers: each processed once (one fact, one event). Lost-processing facts raced by both instances' capture reconcilers: one late success, one `payment.late_success.recorded` and one audit intent per fact, the final status never reopened, also after another pass. Every outbox row of the suite reached the broker exactly once (counted per message id). Negative control: one extra publication of an existing message id fails the case.
  3. *Still open (DO-49 stays PARTIAL).* Refund dispatch and allocation, disputes, the attempt resolver and the expiry sweeper run in both instances but are not specifically raced here; lease renewal (claim renewal) is not exercised; a crash of one instance while it holds a claim is not covered (DO-45 covers a single-instance crash of the capture window).

## 2. ADR disposition

Statuses are as found in each file; **no status was changed** by S0-DOC. Accepted ADRs are not edited (ADR workflow: an accepted ADR is
immutable; a later decision is a new ADR). Reciprocal notes on Accepted ADRs need separate, explicit approval.

| ADR | Status | S0 change |
|---|---|---|
| [0007](../adr/0007-out-of-band-cash-payment-confirmation.md) cash confirmation | Accepted | not edited; partly superseded by 0068 when 0068 is Accepted; reciprocal note pending approval |
| [0035](../adr/0035-financial-service-boundaries.md) financial boundaries | Proposed | clarifications C1–C4 added |
| [0036](../adr/0036-money-parties-and-source-references.md) money and parties | Proposed | none (consistent) |
| [0044](../adr/0044-subscription-entitlement-final-model.md) subscription model | Proposed | Revision 1: Part B (B1–B14), marked notes in Part A |
| [0045](../adr/0045-commercial-entitlementkind-compatibility-fields.md) `entitlementKind` | Proposed | Revision 1: wording aligned; no field change |
| [0046](../adr/0046-notification-service-architecture.md) notification | Accepted | none; commercial IN_APP stays excluded (§5) |
| [0049](../adr/0049-audit-trail-architecture.md) audit trail | Accepted | not edited; amended by 0069 when 0069 is Accepted; reciprocal note pending approval |
| [0057](../adr/0057-messaging-conventions.md) messaging | Proposed | S0 revision: §13 and [S0] items in §7 and §8; S0-C1 Audit admission clarification of §13.2 (2026-10-23, §1.5); S0-C2 Notification keyed body commitment, a normative revision of §13.2 (2026-10-23, §1.5); S0-C3 replay verification rollout, a clarification of §13.4 (2026-10-23, §1.5); S0-C4 Payment-first re-emission, a clarification of §13.7 resolving OD-15 for Payment (2026-10-23, §1.5); S0-C5 broker topic permissions, a clarification of §13.1 (2026-10-23, §1.5); S0-C6 S1e consumer enforcement, a clarification of §13.5 resolving the S0-C3 per-consumer refusal semantics (2026-10-23, §1.5) |
| [0060](../adr/0060-company-platform-organization-lifecycle.md) lifecycle | Accepted | not edited; decision note DN-1 recorded here (§3.6) |
| [0067](../adr/0067-auth-authorization-receipts-for-owner-approved-refunds.md) refund receipts | Proposed (new) | new |
| [0068](../adr/0068-no-cash-settlement-for-nawara-sold-products.md) no Nawara cash settlement | Proposed (new) | new; partly supersedes 0007 |
| [0069](../adr/0069-verified-audit-producers-and-audit-contract-v2.md) verified audit producers | Proposed (new) | new; amends 0049; accept with or after 0057 |

ADR number 0066 is skipped: a draft ADR-0066 exists on an unmerged branch. Numbering is re-checked at merge.

## 3. Contract register

### 3.1 Financial facts, refunds and reversal

- **FC-1 Provider facts.** Every distinct provider money movement is committed as an immutable `provider_transaction_fact`
  (identity `(provider, providerTxnId, kind)`) in its own transaction, independently of allocation. Identical redeliveries are the
  same fact. Facts are never refused, edited or deleted. Raw webhooks stay in the existing `webhook_event`.
- **FC-2 Allocation.** A separate transaction, lock order `payment` → `refund_authorization`;
  `intended = min(amount, approvedAmount − allocatedIntended)`, `excess = amount − intended`; a same-row check
  `0 ≤ allocatedIntended ≤ approvedAmount` and a deferred check that the counter equals the sum of allocations. A failed allocation
  leaves the fact `pending` with a reconciliation item. An unmatched fact is associated later only by an append-only association row.
- **FC-3 Completion.** `completedAt` is set once, when the intended allocation reaches the approved amount; `refund.case_completed` is
  emitted once. A completed case refuses every new attempt (`409 refund_case_completed`), even if a reversal fact reopens arithmetic
  room; any further action needs a separate authorization through reconciliation.
- **FC-4 Reversal.** At most one entitlement reversal per purchase; each cause (refund completion, direct final-lost chargeback) is
  appended separately; a second cause changes no entitlement and opens reconciliation. Option D re-lays later paid periods with their
  full duration. An assisted purchase lost at final stage is never reversed. *(Clarified by S0-C14 item 4: a chargeback never reverses an assisted purchase; a completed refund does, under R6D-1.)*
- **FC-5 Balances.** Accounting balances come from facts and are never clamped: `netRetained = captured − refundedNet −
  chargebackNet` may become negative. `available = max(0, netRetained − inFlight − disputeExposure)` is used only to admit a new
  attempt, with `disputeExposure` net of chargeback facts already linked to the dispute. No new refund case while a dispute is open.
- **FC-6 Losses.** A `FinancialLoss` only from recorded facts showing money not retained (an over-return; a direct final-lost
  chargeback write-off, at most one per capture under S0-C10 item 4) or an owner write-off of an unrecoverable recovery obligation; keyed per evidence fact and kind; corrected by
  append-only adjustments. A cause alone opens reconciliation, not a loss.
- **FC-7 Receipts.** As [ADR-0067](../adr/0067-auth-authorization-receipts-for-owner-approved-refunds.md).

### 3.2 Database enforcement (Billing unless stated)

| # | Invariant | Mechanism |
|---|---|---|
| DB-1 | `invoice_entitlement` immutable | row-level trigger refusing UPDATE and DELETE; runtime role has INSERT and SELECT only |
| DB-2 | every non-draft invoice has exactly one routing record | primary key and FK to `invoice`; deferred constraint trigger on `invoice` leaving `draft` |
| DB-3 | valid purpose, target, payer, beneficiary and reference combinations | same-row CHECK on `invoice_entitlement`; `payerType` kept consistent by a composite FK to `invoice(id, payerType)` |
| DB-4 | target agrees with the product | composite FK `(productId, target)` → `product(id, subscriptionTarget)`; no product for recovery |
| DB-5 | beneficiary and Organization agree with the assistance request | composite FK to `assistance_request(id, studentUserId, organizationId)` |
| DB-6 | Organization and currency agree with the recovery obligation | composite FK to `recovery_obligation(id, organizationId, currency)` |
| DB-7 | server-determined beneficiary, references and amounts | application validation under row locks (DB-4 to DB-6 guarantee consistency, not origin) |
| DB-8 | recovery invoice amount equals the outstanding amount at issue | application validation under a lock and a deferred check at issue |
| DB-9 | each effect only in the table matching its purpose | composite FK `(invoiceId, purpose)` to the routing record plus a same-row CHECK on each effect table (`subscription_settlement`, `subscription_purchase`, `recovery_payment`) |
| DB-10 | at most one financial effect per invoice | `UNIQUE(invoiceId)` on each effect table, with DB-9 |
| DB-11 | no Organization period without an Organization settlement | deferred constraint trigger on `subscription` (start changed or end increased) |
| DB-12 | one purchase per assistance request | partial unique index on `subscription_purchase(assistanceRequestId)` |
| DB-13 | one open or uncertain settlement channel per request or obligation | partial unique indexes on `settlement_channel` |
| DB-14 | no second effect from a duplicate delivery | existing `payment_event_receipt` plus provenance (ADR-0057 §13) plus DB-10 and DB-12 |
| DB-15 | Payment payer and purpose pairing (Payment) | same-row CHECK `payerType = 'organization' ⇔ purpose ∈ {assisted_settlement, recovery_settlement}`; immutability trigger |
| DB-16 | no Nawara cash settlement (Payment) | same-row CHECK refusing `settledMethod = 'cash'` with a Company seller |
| DB-17 | refund allocation bounded (Payment) | FC-2 |

Settlement purposes and targets are those of ADR-0044 B2: `organization_subscription` → `organization`; `direct_purchase` and
`assisted_settlement` → `personal`; `recovery_settlement` → `none`.

### 3.3 Cash obligations and restrictions

- **FC-8 Cash.** `cashCollectedAt` (asserted by the school) and `reportedAt` (server time), with `consentAt ≤ cashCollectedAt ≤
  reportedAt`; `settleBy = cashCollectedAt + 72h`; a late report is born overdue; corrections are append-only, owner-only with
  step-up; violations are never erased (`superseded_by_correction`). Student disputes have no cutoff; 7 days is an escalation target
  only. A failed settlement opens a full cash-return obligation, including the school's fee.
- **FC-9 Restrictions.** Derived from open T1 (overdue settlement), T2 (overdue cash return), T3 (recovery after an assisted
  final-lost chargeback) and inactivity (D6). They block **new** assistance requests only; discharge actions stay available *(narrowed by S0-C14 item 7, on one obligation only: a new recovery settlement channel is refused during a refund and chargeback overlap; that collection freeze is not a restriction)*. Each
  clears on verified resolution when no other restriction applies. No persistent repeat-violation state.

### 3.4 Assisted late settlement [S0]

- **L-1** Every verified success on any assisted channel, including a definitively closed one, is recorded and never discarded.
- **L-2** A success on a definitively closed channel creates no purchase and changes no entitlement; a reconciliation case opens.
- **L-3** Default resolution: a full refund of that payment to the school's original card (owner receipt flow); the request keeps its
  cash-return obligation, violations and restrictions.
- **L-4** Exception. A late assisted settlement on a definitively closed channel may be applied as the request's single purchase only
  when **all** of the following hold:
  1. an explicit owner authorization with factor step-up;
  2. an affirmative student attestation that the school's cash was not returned, **or** reliable independent evidence establishing
     that it was not returned;
  3. verification that no `SubscriptionPurchase` already exists for the assistance request;
  4. verification that the cash-return obligation has not been confirmed as returned;
  5. an auditable decision recording the reason code and the supporting evidence.

  Contradictory, unreliable or insufficient evidence means the case stays in reconciliation; no entitlement activation is permitted.
  When L-4 applies, the cash-return obligation closes as `superseded_by_settlement`, violations are kept, and T1 clears for that
  request only.
- **L-5** Never two purchases for one request (DB-12). **L-6** If the cash return is confirmed or a purchase exists, L-4 is refused.
- A late success on a definitively expired direct order creates no automatic purchase; it is recorded and reconciled.

### 3.5 Recovery and over-recovery [S0]

- One open or uncertain channel per recovery obligation; a new channel only after definitive closure *(amended by S0-C14 item 7: and only while no refund and chargeback overlap exists on that obligation)*, for the then-outstanding amount
  and the obligation's currency. Every verified success, including a late one, is a `RecoveryPayment` of the verified captured amount.
  T3 clears only when verified recoveries reach the base amount. *(S0-C14 item 10: an Owner suspension stops T3 applying to one obligation; it clears no debt.)*
- **R-1** An excess is a `recovery_surplus` with status `owed_to_school`: not revenue, not a loss, never deleted, never subscription
  access.
- **R-2** Every surplus opens an owner reconciliation case and stays owed until resolved; it has no expiry.
- **R-3** Resolution: (a) a payment that is entirely surplus is refunded in full to its original method; (b) a partial surplus is
  repaid outside Core, recorded as `external_execution_evidenced` then `recipient_confirmed`; (c) no offsetting against other
  obligations in Core V2.
- **R-4** Deferring electronic partial refunds does not remove or limit the repayment obligation to the school.
- **R-5** A surplus never re-opens or extends T3.

### 3.6 Organization authority and lifecycle (decision note DN-1 on ADR-0060)

DN-1 does not amend ADR-0060.

1. Resolving ADR-0060's OD-L7: an effectively inactive scope (`SUSPENDED` or `ARCHIVED`) accepts no new Pay with School assistance
   request.
2. Existing obligations stay dischargeable through a closed set of Billing and Payment actions: electronic settlement of collected
   cash, recording a full cash return, the student's confirmation or dispute, the school's dispute response, recovery settlement *(narrowed by S0-C14 item 7: starting a NEW channel is refused during a refund and chargeback overlap on that obligation; channels already started and the recording of verified money are not excepted)*, and
   the owner's corrections, resolutions and reconciliation. These are not ordinary administration, not access grants and not
   reactivation; they grant no general administration.
3. Authority is verified live per request; if it cannot be verified the action fails closed with no mutation. The student acts on
   their own obligations and the owner always may; the school actor set is decided at gate V-5.
4. The lifecycle implementation must expose the effective scope state to Billing in the same release that first allows a scope to
   become inactive (gate V-4); until then no scope can be inactive.
5. Lifecycle never changes, cancels or derives from commercial state.

Production hierarchy authority stays with Auth; Organization Service stays non-authoritative; G6 and F7 are unchanged. Billing's
`billing_platform` is a commercial-configuration projection with an immutable `companyId`, written only by the owner after a live
`/auth/platform-access` check; memberships are checked live per request through `/auth/me`; failures are closed (`503`).

### 3.7 Events and idempotency

- ADR-0057 §13 applies to every family: Auth domain events; `invoice.*` and `billing.*`; `payment.*` and `refund.*`; `audit.*`.
  Existing `invoice.created` and `payment.*` version 1 stay compatible (additive fields only).
- Class M idempotency: 90 days ([OD] D7). Permanent keys: `(producer, paymentRequestId)`; `consumeRef`; one attempt per consumption;
  one allocation per fact; one reversal per purchase; one loss per evidence fact and kind; effect tables unique per invoice. Payment's
  current 720-hour ceiling (`payment-config.ts`) is changed at implementation.

### 3.8 Simulation, cash and direct purchase

- **FC-10** Production refuses to boot with the test or simulation provider or harness; every money record and event carries
  `liveMode`; production refuses non-live events; no client-chosen outcomes.
- **FC-11** No cash settlement for Nawara-sold products (ADR-0068, DB-16).
- **FC-12** Direct purchase: authenticated, active, eligible member + an active Platform-scoped product + a configured Platform; no
  membership required; no authorization granted.

### 3.9 Grace

ADR-0044 B13: Organization Subscriptions have exactly 24 hours of grace after `currentPeriodEnd`, computed in UTC and frozen per
period; Personal Subscriptions have none. The current V1 setting `SUBSCRIPTION_GRACE_DAYS` (optional, 1–365 days,
`apps/billing-service/src/config/billing-config.ts`) does not guarantee this and is replaced by a fixed policy (a different concept from the
24-hour grace license of ADR-0008), with a same-row check
`status = 'pending' OR graceUntil = currentPeriodEnd + interval '24 hours'`.

### 3.10 API surface (summary)

New and extended routes, with their DTOs, errors and idempotency classes, were specified in the AR-04.6 contract register; route and
DTO names are confirmed at implementation review. Groups:

- **Auth:** authorization receipts (issue, consume, consumption lookup); new factor-only step-up purposes; the R-6a correction of the
  organization-administrator grant facts.
- **Billing:** Platform commercial configuration; fee caps, delegations and proposals; direct checkout; personal subscriptions and the
  personal entitlement read; assistance requests (consent, decline, cash collection, settlement, corrections, disputes, responses,
  resolutions); cash-return obligations; restrictions; refund cases; holds; recovery obligations and settlement; legal remedies;
  reconciliation cases and financial losses; owner catalog administration (DTOs depend on the catalog values, §6).
- **Payment:** payer, purpose, `liveMode` and scope on payments; `closing` and finality; Organization-payer attempts; refunds;
  disputes (owner reads, evidence, decision); reconciliation items and fact association; simulation harness (non-production only).
- **File:** evidence grants, granted reads and tickets; holds; the ticket reservation lease.
- **Audit:** contract v2; owner Company timeline; operator Platform view; legal holds.
- **Release:** three owner reads (products, releases, policy history).
- **Organization:** none in Core V2; human hierarchy reads deferred until authority activation.
- **Notification:** none in Core V2 (commercial IN_APP excluded).

## 4. Safeguard register [S0]

| Id | Safeguard |
|---|---|
| V-1 | one reversal per purchase; causes appended separately |
| V-2 | provider facts committed independently of allocation |
| V-3 | a completed refund case is permanently closed to new attempts |
| S-4 | the Organization settlement check fires only on period start or extension; direct `activate()` / `renew()` are retired before it is added |
| S-5 | `subscriptionTarget` is independent of `entitlementKind` |
| S-6 | payer, purpose, beneficiary, amount, currency and seller are immutable; an Organization payer only for assisted or recovery purposes, enforced by Billing and Payment independently |
| S-7 | database guard against cash settlement of Nawara-sold payments |
| S-8 | provenance committed before the handler; default-exchange deliveries only against stored rows |
| S-9 | the effective lifecycle state reaches Billing in the release that first allows inactivity |

## 5. Deferral register [DEF]

Out of the initial frozen scope unless separately approved:

- commercial IN_APP notifications (decision C-3; additive later: inbox, Auth tenure, an ADR-0046 amendment);
- partial-amount refunds (D4), including electronic partial over-recovery refunds;
- cash settlement for other sellers (D1);
- the persistent repeat-violation threshold;
- real payment-provider integration (after company registration), including provider idempotency windows, dispute formats and fees;
- human hierarchy reads (until Organization authority activation);
- tax, invoicing entity, credit notes, legal refund windows, limitation periods, retention durations, execution of legal remedies,
  commercial e-mail and SMS, push.

## 6. Implementation gates [GATE]

| Item | Gate |
|---|---|
| V-5 school actor set for discharge in inactive Organizations | before S5 |
| V-4 effective-state contract | before the first lifecycle release and S5 enforcement |
| Premium catalog products, plan durations and prices | before the first catalog configuration (S3) |
| C-4 historical Auth → Audit dead letters | separately authorized inventory, before broker enforcement (S1 rollout) |
| C-5 operator Organization creation | before any operator step-up work (S8) |
| C-6 administrator tenure during suspension | with C-3 |
| PR #319 | on hold; reconciled after S0 and before Organization-related implementation, with separate authorization |
| Accepted-ADR reciprocal notes (0007, 0049, 0060) and every ADR status change | separate explicit approval, one ADR at a time |
| Roadmap, financial-architecture and Billing / Payment SDD updates | separate documentation authorization (§6.1) |
| `G-FIN-RESTORE` Billing and Payment paired restore (S0-C14 item 22) | mandatory, before Billing's production activation |

### 6.1 Future documentation alignment (informational)

These documents are not edited by S0-DOC; each needs its own documentation authorization.

| Document | Stale content |
|---|---|
| [`financial-architecture.md`](./financial-architecture.md) | Nawara cash settlement (`cash submission → review → confirm → payment succeeded`) and Subscription routing by organization and recurring line |
| [Billing design document](../sdd/billing-service.md) | the optional V1 grace (`SUBSCRIPTION_GRACE_DAYS`) versus the fixed Core V2 Organization grace of 24 hours and no Personal grace |
| [Payment design document](../sdd/payment-service.md) | trust-based cash confirmation; no payer and purpose model |
| [`CORE-ROADMAP.md`](../CORE-ROADMAP.md) | no frozen S0 and no S1–S8 stage plan |
| [ADR-0007](../adr/0007-out-of-band-cash-payment-confirmation.md), [ADR-0049](../adr/0049-audit-trail-architecture.md), [ADR-0060](../adr/0060-company-platform-organization-lifecycle.md) | reciprocal notes for ADR-0068, ADR-0069 and DN-1, requiring separate edit authorization |

## 7. Implementation plan (planning only)

| Stage | Content |
|---|---|
| S0 | this freeze |
| S1 | service-kit event security: publisher `user_id`, provenance (observe-only), de-duplication by verified source, re-emission; then gated provisioning and enforcement |
| S2 | independent foundations: Auth receipts, step-up purposes and R-6a; Audit v2 and scope; File grants, holds and lease; Release owner reads |
| S3 | Billing routing, settlement guard, personal ledger, `billing_platform`, fixed grace |
| S4 | Payment finality, provider facts, payer and purpose, simulation adapter and harness (in parallel with S3) |
| S5 | assistance, cash, T1/T2/T3, D6 with V-4 and V-5 |
| S6 | refunds, disputes, recovery, reconciliation, losses (V-1 to V-3, L, R) |
| S7 | Notification inbox and Auth tenure, only if C-3 is approved |
| S8 | Organization changes that depend on authority, without production cutover |

These stages map onto the Core V2 roadmap capabilities ([CORE-ROADMAP](../CORE-ROADMAP.md)): A4 Authentication, A5 Organization, A7
Audit, A8 Notification, A9 File, A10 Billing, A11 Payment, A16 Product Integration. Reconciling the roadmap text with this plan is a
separate documentation task.

## 8. Certification (future; nothing is run now)

Order: individual service certification → Core integration certification → **Final Core Validation, last**, never as part of another
task.

- Every invariant in §3 has a negative test at the database or API level.
- Fault injection at each transaction boundary: after a fact commit; between intent, consumption and `authorized`; between provenance
  and handler; after the handler and before acknowledgement.
- Facts survive allocation failure; a duplicate success becomes excess with no second reversal; a refund plus a chargeback on one
  purchase reverses once.
- A personal or recovery invoice never changes `subscription` on any path; grace is exactly 24 hours for Organizations and absent for
  Personal Subscriptions.
- Broker: forged `user_id`, wrong exchange, injection through the default exchange, tampered body, name or source, and replay without
  a stored row are refused; retries pass; `invoice.created` still flows; broker `user_id` enforcement is proven in S1.
- Production configuration refuses simulation; inactive scopes refuse new requests while every discharge action works for its
  authorized actors; an Auth outage gives `503` with no mutation.

## 9. Known limitations

- V-4 effective-state field not yet defined; V-5 actor set pending.
- RabbitMQ `user_id` enforcement is assumed standard broker behaviour until proven by the S1 certification test.
- Real-provider idempotency windows and debit timing are deferred with the provider.
- Accepted ADRs 0007, 0049 and 0060 carry no reciprocal notes yet; the relationships are recorded in 0068, 0069 and this record.
- S0-C14 item 17: an unresolved recovery obligation can have no new collection route during an overlap. This is neither forgiveness nor a final financial resolution. It is an INTERIM development
  and simulation policy and an explicit BLOCKER for real-money readiness until a separately approved resolution policy exists (the Owner's decision, 2026-11-06). D9 and D15 stay unresolved.

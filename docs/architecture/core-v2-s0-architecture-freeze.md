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
| D6 | No new Pay with School requests while the Organization is inactive; settlement, full cash return, disputes, reconciliation and recovery remain dischargeable |
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
  full duration. An assisted purchase lost at final stage is never reversed.
- **FC-5 Balances.** Accounting balances come from facts and are never clamped: `netRetained = captured − refundedNet −
  chargebackNet` may become negative. `available = max(0, netRetained − inFlight − disputeExposure)` is used only to admit a new
  attempt, with `disputeExposure` net of chargeback facts already linked to the dispute. No new refund case while a dispute is open.
- **FC-6 Losses.** A `FinancialLoss` only from recorded facts showing money not retained (an over-return; a direct final-lost
  chargeback write-off) or an owner write-off of an unrecoverable recovery obligation; keyed per evidence fact and kind; corrected by
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
  final-lost chargeback) and inactivity (D6). They block **new** assistance requests only; discharge actions stay available. Each
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

- One open or uncertain channel per recovery obligation; a new channel only after definitive closure, for the then-outstanding amount
  and the obligation's currency. Every verified success, including a late one, is a `RecoveryPayment` of the verified captured amount.
  T3 clears only when verified recoveries reach the base amount.
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
   cash, recording a full cash return, the student's confirmation or dispute, the school's dispute response, recovery settlement, and
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

# Core V2 F-SINT-1: making the frozen L-4 path reachable (proposal)

- **Decision (2026-11-01):** the Owner approved LS-1 to LS-10. The approved record is **S0-C8** in the
  [S0 freeze record](./core-v2-s0-architecture-freeze.md) §1.5 with register BIL-23 H, BIL-32 G, BIL-33 G and EVT-10; where this
  proposal and S0-C8 differ, S0-C8 governs. LS-7 is recorded as a policy addition. **Implemented for development and simulation only by #434 and #435, with real-event evidence in #436;
  closure: the [S-INT certification record](./core-v2-s-int-certification.md) §6.** The rest of this document is the proposal as written.
- **Status (as written):** PROPOSED, for Owner review. Prepared 2026-11-01 under the Owner's F-SINT-1 decision (Option A, documentation proposal
  only), on `main` at `480f94826cd31f00ed8a46865b765f493eae2682` (the PR #431 merge; Core CI push run `41321579398` green).
- **What it is:** an approval-ready draft of one S0 clarification (S0-C8) and of the contract changes it needs in the
  [contract register](./core-v2-d-a2-contract-register.md) (BIL-23, BIL-32, BIL-33, EVT-10), with the trace, the design, the
  migrations it would need, the failure handling, the PR sequence and the real-event acceptance tests that replace the S-INT G4 fixture.
- **What it is not:** an edit of the [S0 freeze record](./core-v2-s0-architecture-freeze.md) or of the register (both are unchanged
  by this document; the approved text is applied by a later documentation PR), an implementation authorization, a migration, an ADR
  edit or an ADR status change (ADR-0044 Part B, ADR-0045 and ADR-0069 stay Proposed), an S-INT verdict or a production change.
  Nothing here is implemented.
- **Baseline preserved:** the S-INT pinned SHA `8f74d04` and its evidence (`~/nawara-evidence/s-int-2026-11-01-8f74d04/`) are
  unchanged; F-SINT-1 stays open until the corrective work and a fixture-free G4 rerun.

## 1. The finding (F-SINT-1)

S0 §3.4 L-4 lets the Owner apply "a late assisted settlement on a definitively closed channel" as the request's single purchase. In
the merged implementation that path cannot be reached by real events.

| Step | Source on `main` | Effect |
|---|---|---|
| L-4 applies only to an `assistance_late_settlement` | Billing `src/late-settlements/`, `0040` guard; register BIL-32 F | the only L-4 input |
| That row is created only from an applied `payment.succeeded` of a `paid` payment request | `0030` / `0040` `billing_assistance_late_settlement_guard`; `payment-request.repository.ts` (S5b E-7) | needs a success Payment never sends after its final state |
| A channel closes only on a final unsuccessful Payment outcome | `0030` channel update guard (`assistance_settlement_channel_closed_final`) | closed ⇒ Payment's payment is `failed`, `cancelled` or `expired` |
| Payment's final states have no outgoing transition | Payment `payment-state-machine.ts` (S4c) | a later provider success is `payment_late_success` plus EVT-10, never `payment.succeeded` |
| A deadline obligation opens only when no channel is open or uncertain | `cash-return-sweep.ts` (`DUE`) | the S-INT G4 fixture (an obligation while a channel is in flight) is a state the sweep forbids |
| An assisted late success becomes a refund-only `late_success` case | `src/reconciliation/late-success.service.ts`; `0042` resolution guard (`late_settlement_applied` only on `late_assisted_settlement`) | the reachable real case is never L-4-eligible |
| A purchase needs an applied `payment.succeeded` receipt | `0022` `receiptId NOT NULL`, `0040` `billing_subscription_purchase_insert_guard` (S0 DB-9, DB-10, DB-14) | a late success cannot evidence a purchase |

Every stage met its own approved contract; together they leave frozen L-4 with no reachable input, and no approved contract limits L-4.
The register states that S0 governs where they differ. The Owner accepted this as a required functional gap (Option A, 2026-11-01).

## 2. What S0 already decides (unchanged)

- **L-1** every verified success on an assisted channel, including a definitively closed one, is recorded, never discarded.
- **L-2** such a success creates no purchase and changes no entitlement; a reconciliation case opens.
- **L-3** the default resolution is a full refund of that payment to the school's original card (Owner receipt flow); the request keeps
  its cash-return obligation, violations and restrictions.
- **L-4** the exception, only with all five conditions (Owner authorization with factor step-up; the student's attestation or reliable
  independent evidence that the cash was not returned; no existing purchase; the cash return not confirmed; an auditable decision with a
  reason code and evidence). Contradictory, unreliable or insufficient evidence keeps the case in reconciliation. When applied, the
  obligation closes `superseded_by_settlement`, violations are kept, T1 clears for that request only.
- **L-5** never two purchases for one request (DB-12). **L-6** a confirmed cash return or an existing purchase refuses L-4.
- A late success on a definitively expired **direct** order creates no automatic purchase (unchanged; L-4 stays assisted-only).
- S4c finality, FC-1 (immutable provider facts), DB-9, DB-10, DB-12 and the invariant of DB-14, ADR-0057 §13 and S0-C1 to S0-C7.

## 3. Proposed S0-C8 (draft text for S0 §1.5)

> **S0-C8 Reachable late assisted settlement (DRAFT, not approved; S0 §3.4 L-1 to L-6, §3.2 DB-14; F-SINT-1).** S0 §3.4 is
> unchanged. A *late assisted settlement* (L-4's input) is either (a) the S5b E-7 record of an applied `payment.succeeded` that could
> not apply, or (b) Payment's verified late success (EVT-10 or Payment's PAY-12 read) of a payment whose routing purpose is
> `assisted_settlement`, recorded by Billing once per late success and per capture fact, when Payment's payment ended `failed`,
> `cancelled` or `expired`, Billing's payment request ended in the same state, that channel is definitively `closed`, the captured
> amount and currency equal the channel invoice's total, the capture fact is identified, and no late assisted settlement exists for
> the invoice. Payment's final state is never reopened, no `payment.succeeded` is produced, and nothing is purchased on receipt (L-2).
> The default remains the full refund of that captured movement (L-3), executed as Payment's capture-specific refund of that fact.
> L-4 applies to (b) exactly as to (a): the same route, Auth `late_settlement_apply` receipt with factor step-up, attestation or
> evidence paths, refusals and atomic commit. For DB-14, a purchase applied under L-4 from (b) is evidenced by that recorded late
> success instead of a `payment.succeeded` receipt; each late success evidences at most one effect: one late assisted settlement,
> one recovery payment, or one `late_success` reconciliation case. DB-9, DB-10 and DB-12 are unchanged. This clarification implements
> and activates nothing and changes no ADR status.

### 3.1 Clarification, not a change of frozen policy

| Item | Classification | Why |
|---|---|---|
| (b) as an L-4 input | clarification | L-1 and L-4 already name "a definitively closed channel"; (b) is exactly that success |
| DB-14 evidence alternative | clarification of a mechanism | the invariant (no second effect from one delivery) is kept and extended to late successes; DB-9, DB-10, DB-12 unchanged |
| Capture-specific execution of the L-3 refund | clarification | L-3 already requires a full refund of "that payment"; after S4c finality the only Payment path that returns it is R6H-5's |
| Invoice `open → paid` at the application (§6, LS-3) | clarification inside L-4 | the invoice records the sale L-4 authorizes; Payment and its request stay final |
| New refusal `chargeback_recorded` (LS-7) | **policy addition** (narrows L-4) | stricter than S0; offered for Owner decision, not assumed |

**Not proposed (each would materially alter frozen policy):** reopening a final Payment state; emitting `payment.succeeded` for a late
success; any automatic purchase; relaxing or substituting any of L-4's five conditions; extending L-4 to direct purchases or recovery;
making L-4 the default instead of L-3; any change to DB-10 or DB-12 uniqueness; changes to Auth's receipt bindings.

## 4. Trusted evidence identifiers

| Identifier | Owner | Meaning | Already exists |
|---|---|---|---|
| `lateSuccessId` | Payment `payment_late_success.id` | one verified success after the payment ended; EVT-10's id is derived from it | yes (S4c, S6h-P) |
| `factId` | Payment `provider_transaction_fact` (`capture`) | the immutable captured movement, identity `(provider, providerTxnId, kind)` (FC-1); null only when the provider gave no reference | yes (S4d) |
| `paymentId`, `attemptId`, `paymentStatus`, `amount`, `currency`, `recordedAt` | Payment, EVT-10 payload | the payment (kept final), the attempt, its terminal state, the verified captured amount, Payment's instant | yes |
| `payment_late_success` (Billing) | Billing, PK `lateSuccessId`, `factId UNIQUE` | Billing's verified-only record (S0-C6) from the event or Payment's read | yes (S6h-B) |
| `lateSettlementId` | Billing `assistance_late_settlement.id` | the L-4 input; the Auth `late_settlement_apply` receipt binds it | yes (row); new source (b) |
| `captureFactId` on refund cases | Billing `refund_case`, Auth `refund` binding | the capture a refund returns (R6H-5) | yes |

The provider evidence never changes: Payment's fact and late success are append-only; Billing's records are append-only copies bound by
`lateSuccessId` and `factId`, checked against the payment request Billing itself sent (`payment_late_success_payment` guard).

## 5. Proposed event-to-purchase sequence

1. **Payment ends the payment.** The attempt fails or the payment expires or is cancelled (S4c). Payment emits its final event.
   Billing's payment request reaches the same final state (event, or Billing's reconciliation read); the channel follows to `closed`
   (`billing_assistance_channel_follow_request`). The channel never reopens. Unchanged.
2. **The provider reports a capture.** Payment verifies it (signed webhook or status check), records the capture fact (FC-1) and a
   `payment_late_success`, emits `payment.late_success.recorded` v1 (EVT-10). The payment stays final. Unchanged.
3. **Billing records it (L-1).** Verified-only consumption (S0-C6), or Payment's PAY-12 read if the event is lost; one
   `payment_late_success` per `lateSuccessId` and per `factId` (existing). Unchanged.
4. **Billing classifies it, once (changed).** Under the payment request's row lock, by the invoice's immutable routing (DB-1):
   - `recovery_settlement` → `recovery_payment` (unchanged, S6h-B).
   - `assisted_settlement`, **Billing's payment request not yet final** → no decision; the record waits. The reconciliation worker
     classifies it after Billing's request is final. Never a settlement.
   - `assisted_settlement`, **eligible** (S0-C8 conditions: payment and request `failed` / `cancelled` / `expired`, channel `closed`,
     `factId` present, amount and currency equal to the invoice total, no late assisted settlement for the invoice) →
     `assistance_late_settlement` `{reason: channel_closed, lateSuccessId, receiptId: NULL, settledAt: recordedAt}` and its
     `late_assisted_settlement` reconciliation case (`evidenceKey = lateSettlementId`, `captureFactId = factId`). No `late_success`
     case. No purchase, no entitlement, no obligation change (L-2).
   - `assisted_settlement`, **not eligible** (a second capture of the same invoice, no `factId`, an amount mismatch, a capture of a
     `succeeded` payment) → `late_success` case, refund-only (unchanged).
   - anything else → `late_success` case (unchanged).
5. **The ordinary outcome (L-3).** The Owner opens a `late_assisted_settlement` refund case carrying `captureFactId` (BIL-23); the
   Owner's `refund` receipt binds the capture (R6H-5, Auth unchanged); Payment refunds that capture as `late_capture` (Payment
   unchanged); `refund.case_completed` completes the case with outcome `none` (the request keeps its obligation, violations and
   restrictions); the reconciliation case resolves `refund_completed` (the existing guard already matches `captureFactId`). L-4 is
   then refused (`refund_exists`, R6G-7).
6. **Meanwhile the request continues.** Before `settleBy` the Organization may start a new channel (DB-13); if it settles, a purchase
   exists and L-4 is refused for good (L-6); the late capture is refunded. After `settleBy`, with no channel open or uncertain, the
   sweep opens the deadline obligation (T2) as today. Nothing is fabricated.
7. **The exception (L-4).** The beneficiary attests `cash_not_returned` (BIL-32 Path A) or the Owner supplies File evidence with an
   explicit determination (Path B); the Owner issues the `late_settlement_apply` receipt with factor step-up (AUTH-04 J, unchanged
   binding `{companyId, lateSettlementId, assistanceRequestId, beneficiaryUserId, reasonCode}`) and calls the existing application
   route. Every S6g refusal is re-checked under the existing locks (Organization → request → live obligation → payment request).
   One transaction: the application; the live deadline obligation (if any) `superseded_by_settlement`; the single purchase with
   `lateSuccessId` as its evidence, `settledAt` = Payment's `recordedAt`, `appliedAt` = the application instant (R6G-5); the request
   `settled`; the invoice `paid` (LS-3). The payment request stays final, the channel stays `closed`, Payment is untouched. The
   reconciliation case resolves `late_settlement_applied`.
8. **After the application.** The purchase is refundable only as a Personal purchase (S6g): a `personal_purchase` refund case carrying
   `captureFactId`, executed by Payment's capture-specific refund, with S6d's effects on completion (one reversal; a new
   `refund_completion` obligation). A verified chargeback follows S6e for assisted purchases (never reversed; T3).

## 6. Owner decisions (LS-1 to LS-10)

| # | Decision | Recommendation |
|---|---|---|
| LS-1 | Approve S0-C8 (§3) as an S0 clarification | approve |
| LS-2 | The late settlement's and the applied purchase's `settledAt` | Payment's `recordedAt` (Payment's trusted instant, in EVT-10); never Billing's clock |
| LS-3 | State at application | invoice `open → paid` in the application transaction; the payment request stays final; the channel stays `closed` (closed is final, `0030`) |
| LS-4 | Eligibility of a late success (S0-C8) | as §5 step 4: terminal unsuccessful payment and request, closed channel, `factId` present, exact amount and currency, first recorded per invoice; anything else refund-only |
| LS-5 | A late success before Billing's request is final | wait; classify only after Billing's request is final (never settle on it) |
| LS-6 | L-3 execution and post-application refunds | Billing refund cases (`late_assisted_settlement`, `personal_purchase`) may carry `captureFactId` and run through Payment's capture-specific refund; one non-cancelled refund case per capture fact, whatever its eligibility |
| LS-7 | Refuse L-4 when Billing holds a verified chargeback (`payment_dispute_loss`) on that payment | approve, new reason `chargeback_recorded` (policy addition, §3.1) |
| LS-8 | Existing development or simulation `late_success` cases of assisted purpose | forward-only: they stay refund-only, never reclassified (no production data exists) |
| LS-9 | L-4 before `settleBy`, with no obligation yet | allow, as S6g already does (condition 4 holds: no return exists); the request settles and no obligation is ever opened |
| LS-10 | The PR sequence of §10 | approve; each PR needs its own GO |

## 7. Required constraints and migrations (specification for a later Billing PR; not written now)

One expand-only Billing migration (next number, `0043`), no Payment, Auth or Organization migration:

- `assistance_late_settlement`: `receiptId` becomes nullable; new `"lateSuccessId" uuid UNIQUE REFERENCES payment_late_success`;
  CHECK exactly one of `receiptId`, `lateSuccessId`; CHECK `lateSuccessId IS NOT NULL ⇒ reason = 'channel_closed' AND "settledAt" IS
  NOT NULL`. The insert guard gains a second branch: the late success is of this payment request, `factId` is not null, the payment
  request is `failed` / `cancelled` / `expired` and equals `paymentStatus`, the channel of this invoice is `closed`, amount and currency
  equal the invoice total, `settledAt = recordedAt`. The existing branch (applied `payment.succeeded`, request `paid`) is unchanged.
  Append-only and `invoiceId UNIQUE` (DB-10) unchanged.
- **One effect per late success:** a guard on `assistance_late_settlement`, `recovery_payment` and `reconciliation_case`
  (`late_success`, `evidenceKey`) refusing a second effect for the same `lateSuccessId`, under the payment request's lock.
- `subscription_purchase`: `receiptId` becomes nullable; new `"lateSuccessId" uuid UNIQUE REFERENCES payment_late_success`;
  CHECK exactly one of the two; CHECK `lateSuccessId IS NOT NULL ⇒ purpose = 'assisted_settlement' AND "appliedAt" IS NOT NULL`.
  `billing_subscription_purchase_insert_guard`: the late-success branch requires the matching late settlement (same invoice and
  `lateSuccessId`), the payment request final, the invoice `paid` in this transaction; `billing_assisted_purchase_guard` matches the
  application by `lateSuccessId` instead of `receiptId`. `UNIQUE(invoiceId)` (DB-10) and the partial unique index on
  `assistanceRequestId` (DB-12) unchanged.
- `late_settlement_application` guard: add `chargeback_recorded` if LS-7 is approved; the commit trigger also checks the invoice is
  `paid` when the evidence is a late success. Everything else unchanged.
- `refund_case`: allow `captureFactId` (basis `late_capture`) on `late_assisted_settlement` (with `lateSettlementId`) and on
  `personal_purchase` (with `purchaseId`) when their evidence is a late success, `receiptId` NULL for them only; one non-cancelled case
  per `captureFactId` across eligibilities; the 0041 exclusions between ordinary and capture-specific cases of a payment kept.
- Invoice: the `open → paid` transition allowed for an assisted invoice only in the application transaction (deferred check).
- Runtime role privileges unchanged in kind; no `UPDATE` or `DELETE` on any evidence table.

## 8. Compatibility

| Area | Effect |
|---|---|
| S6g (BIL-32 F) | route, receipt, attestation, evidence, refusals, Option A obligation history and R6G-5 anchoring unchanged; the input set grows by (b) |
| S6h-B (BIL-33 F, EVT-10) | the classifier gains the `assisted_settlement` branch; recovery and every other purpose unchanged; resolutions unchanged |
| S5b E-7 | kept as a defensive path; fail-closed if a `payment.succeeded` ever meets a closed channel |
| R6H-5 capture refunds (Payment, Auth) | reused unchanged; Billing's case shapes extended (§7) |
| S4c, S4d, PAY-12, EVT-10 v1 | unchanged; no new field, no new event |
| Audit | the existing `assistance_late_settlement.*` and `cash_return_obligation.superseded` actions; no new action proposed |
| S-INT harness | G4's first test (a later capture of a `succeeded` payment) stays a `late_success` case, unchanged. The L-4 fixture test is replaced by §11 |
| Billing `late-settlements.e2e-spec.ts` | its E-7 fixture tests may stay as in-process mechanics tests; real-path tests are added |

## 9. Failure handling, retries and idempotency

| Case | Handling |
|---|---|
| Duplicate EVT-10, or the event plus Payment's read | one `payment_late_success` (PK, `factId UNIQUE`); classification idempotent (`lateSuccessId UNIQUE` on each effect, `reconciliation_case_once`) |
| Forged or unverified EVT-10 | refused before any business handler (S0-C6); nothing recorded (S-INT G5 already proves it) |
| Replay | ADR-0057 §13: stored trusted values of the verified original; deterministic event id; a duplicate |
| Another statement of the same `lateSuccessId` | `conflict`, nothing applied, kept for review (existing) |
| Late success before Billing's final request state (out of order) | recorded; classification deferred; the worker completes it once the request is final |
| Crash between record and classification | the reconciliation worker completes it (existing pattern) |
| Two late captures of one invoice | the first recorded is the late settlement; the other is a `late_success` case, refunded by its own capture |
| Delayed past a purchase, a confirmed return or a refund | recorded and classified; L-4 refused by L-6 or R6G-7; refund remains |
| Application retried | class K `Idempotency-Key`; a replay answers the stored application without spending the receipt (existing) |
| Concurrent application and refund case | serialized by the payment request lock; R6G-7 and the per-capture refund uniqueness refuse the loser |
| Auth unavailable | 503, nothing written (S-INT G6 pattern) |

## 10. Smallest independently reviewable PR sequence (each needs its own GO)

| PR | Content | Changes behaviour |
|---|---|---|
| PR-0 (this PR) | this proposal | no |
| PR-1 | after LS-1 to LS-10: S0-C8 in S0 §1.5; register BIL-23, BIL-32, BIL-33, EVT-10 new parts (PROPOSED → approved text); documentation only | no |
| PR-2a | Billing: `0043` part 1 (late settlement from a late success, one-effect guard, refund-case capture shapes), classifier, deferral, Billing tests. Result: eligible late successes become L-4-ready late settlements whose L-3 refund works; no purchase path yet | yes (Billing, simulation) |
| PR-2b | Billing: `0043` part 2 or `0044` (purchase evidence, invoice transition, LS-7 refusal, post-application refunds), Billing tests | yes (Billing, simulation) |
| PR-3 | S-INT harness: §11 tests replace the G4 fixture test; CI | tests only |
| PR-4 | record closure: register parts marked IMPLEMENTED; F-SINT-1 resolution note | no |

If PR-2a or PR-2b finds that Payment, Auth or Organization must change, the work stops for an Owner decision. A fixture-free G4 rerun and
any S-INT verdict need separate authorization after PR-3.

## 11. Real-event G4 acceptance tests (replace the fixture)

Across separately spawned Auth, Billing and Payment with RabbitMQ (simulation), driven only by Payment's signed provider notifications:

1. **L-1, L-2:** an assisted channel's payment expires (Payment's expiry); the request expires and the channel closes; the provider then
   reports the attempt's capture → one `payment_late_success`, one `assistance_late_settlement` (`channel_closed`, `lateSuccessId`,
   `settledAt` = Payment's `recordedAt`), one `late_assisted_settlement` case; no purchase; Payment's payment still `expired`.
2. **L-4, attested, before `settleBy` (fully real):** after test 1, the beneficiary attests; the Owner's TOTP-bound receipt (real
   Auth) applies → one purchase evidenced by the late success, request `settled`, invoice `paid`, case `late_settlement_applied`;
   the payment request stays `expired`, the channel `closed`, Payment's payment `expired`. No obligation exists, so none is
   superseded (the S6g guard already accepts this).
   **L-4 after the deadline:** `consentAt` is server time and `settleBy` is exactly `cashCollectedAt + 72 h`, so the deadline cannot be
   reached in test time. Allowed: a **labelled clock shift**. When the channel is already `closed`, the request's four times are moved
   back 72 h together, which is exactly the state elapsed time produces. The **real sweep** then opens the deadline obligation (T2), and
   the application supersedes it (`superseded_by_settlement`; T1 and T2 cleared for that request only). Not allowed: inserting an
   obligation while a channel is in flight (the former fixture, a state the sweep forbids).
3. **L-3:** the capture-specific refund of the late settlement completes → case `refund_completed`; the request keeps its obligation;
   a later application is refused `refund_exists`.
4. **L-6, L-5:** a new channel settles before the application → `purchase_exists`; a confirmed return → `cash_return_confirmed`; a
   `cash_returned` attestation → `evidence_contradictory`; a second application → `already_applied`; never two purchases.
5. **Duplicates and ordering:** EVT-10 redelivered and Payment's read → one record, one late settlement, one case; EVT-10 processed
   before Billing's final request state → classified only after it; a second late capture of the invoice → a `late_success` case only.
6. **Forgery:** a forged EVT-10 → `untrusted_unverified_original`, nothing recorded (G5 extended).
7. **After application:** the purchase's refund (capture-specific execution) reverses it once and opens a `refund_completion`
   obligation; a chargeback after application follows S6e (no reversal, T3), and with LS-7 a chargeback before it refuses L-4.

## 12. Gates and constraints preserved

S7 and S8 stay outside this S-INT; #319 stays RED; ADR-0044 Part B, ADR-0045 and ADR-0069 stay Proposed and no Accepted ADR is edited;
Owner step-up semantics, Auth receipt bindings and Payment finality are unchanged; R-6a stays required before the earlier of F6/F7 and
the first lifecycle-enabled release; no real provider, no production, no Lab 01, no Stage 22, no deployment, no workflow dispatch;
S-INT is not certified by this document.

## 13. Approval

The Owner decides LS-1 to LS-10. Approval of this proposal approves wording and direction only; PR-1 to PR-4 each need an explicit GO.

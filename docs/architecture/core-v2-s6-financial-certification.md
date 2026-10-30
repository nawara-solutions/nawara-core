# Core V2 S6 financial certification (simulation only)

| | |
|---|---|
| Date | 2026-10-30 |
| Baseline | `main` at `f24b760` (PR #404 merged; S6a to S6h and R6H-5 complete) |
| Authorization | The Owner's "S6 FINANCIAL CERTIFICATION — GO, SIMULATION-ONLY" |
| Scope | Refunds, payment disputes, fraud holds, recovery and surplus, late assisted settlement, reconciliation and `FinancialLoss` |
| Not in scope | Stage 22, production readiness, infrastructure rollout, real providers, Lab 01, deployed broker provisioning, PR #319, S7/S8 |
| **Result** | **CONDITIONAL PASS**: one medium code defect found and corrected in the certification PR (§5.1); one stale test assertion corrected (§5.2); no critical financial or authorization defect remains. The conditions are the open contracts and operational gates of §8, none of which this certification resolves. |

## 1. Method

1. Every S6 suite was re-run on `main` (§2): per-service unit and real-PostgreSQL e2e, the SQL invariant suites with their concurrency races, the
   audit contract, the repository checks, the deployment-script tests and the on-demand real-broker suites.
2. A new **cross-process** certification suite (`test/e2e-real-broker/s6-financial-certification.e2e-spec.ts`) spawns the BUILT auth-service,
   billing-service and payment-service as separate processes over real HTTP and a real RabbitMQ. Every money movement enters through Payment's
   SIGNED provider notification (the webhook pipeline), never a database fixture; the Owner is a real Auth session with a real TOTP step-up and
   real receipts. It covers the S6h and R6H-5 contracts, which no earlier cross-process suite exercised (§3).
3. A static review of the production refusals, the authorization policies and the event contracts (§4).
4. A review of the S6 migrations and constraints (§5).

Historical CI was not taken as proof of cross-service correctness: the defect of §5.1 passed every per-service suite and CI, and was found only
by the cross-process run.

## 2. Test results (certification run on `f24b760`, then on the certification branch)

| Suite | Result |
|---|---|
| payment-service unit / e2e (real PostgreSQL 16, RabbitMQ) | 164 / 366 passed |
| billing-service unit / e2e | 465 / 754 passed |
| auth-service unit / e2e | 363 / 677 passed |
| audit-service unit / e2e | 387 / 652 passed |
| file-service unit / e2e | 284 / 397 passed (5 skipped: optional environment) |
| Payment SQL invariants (incl. 3 concurrency races) | 324 passed, 0 failed |
| Billing SQL invariants (incl. 6 concurrency races) | 536 passed, 0 failed |
| audit-contract | 2316 passed |
| `check:repo` / `check-repo.test` | pass / 187 passed |
| deployment-script tests (`test:deploy`) | 674 passed |
| cross-process audit producers (`test/e2e-audit-producers`) | 26 passed |
| cross-process real broker (`test/e2e-real-broker`, 13 earlier suites) | 38 passed |
| **new** cross-process S6 certification (3 tests) | 1 FAILED on `main` (the defect of §5.1); **3 passed** with the correction |
| real-broker deployment tests (`real-broker.mjs`, `real-broker-topic-grants.mjs`; on demand, not in CI) | 28 / 29 on `main` (the stale assertion of §5.2); **29 / 29** with the correction |

After the corrections: Payment `capture-refunds` 12 / 12, Billing `refund-cases` 46 / 46 (each with a new regression assertion).

## 3. Contract-to-test coverage matrix

Legend: **U** unit, **E** per-service real-PostgreSQL e2e (the real application, its real HTTP routes), **S** SQL invariants, **X** cross-process
(built services, real HTTP, real broker, real Auth), **R** real-broker deployment tests.

### 3.1 Refunds (S6a to S6d, R6H-5)

| Contract | Evidence |
|---|---|
| Owner-only refund case, live Company and Platform authority (BIL-23, R6A-2) | E `billing/refund-cases`; X `s6b-refund-processing` |
| Eligibility from Billing's own records; organization subscriptions excluded (R6A-1) | E `refund-cases`; S S6a |
| Factor-only `refund.authorize` step-up; receipt bound to case, payment, amount, currency, reason (AUTH-01, ADR-0067) | E `auth/authorization-receipts`; X `s6b`, X `s6-certification` |
| Full refund only (D4); amount never a request value | E `payment/refunds`, `refund-cases`; S S6b |
| Durable intent, consumption at Auth, `authorized` with Auth's approver (PAY-07, R6B-1 to R6B-10) | E `payment/refunds`; X `s6b`, X `s6-certification` |
| Lost responses and uncertain Auth outcomes recovered only with the same receipt (R6B-9) | E `payment/refunds`, `capture-refunds` §12 |
| Ambiguous provider dispatch: same key, never completion without verified evidence | E `payment/refunds`, `capture-refunds` §13 |
| Immutable verified refund facts, identity `(provider, txn, kind)` | E `payment/provider-facts`, `refund-allocation`; S S4d, S6b |
| Cumulative FC-2 allocation, excess, deferred sum check, completion once (S6c) | E `refund-allocation`; S S6c; X `s6b` |
| `refund.case_completed` exactly once over the broker; Billing completes once | X `s6b`, X `s6-certification` |
| Purchase reversal once; assisted refund opens the refund-origin cash obligation (S6d) | E `refund-cases` S6d; X `s6b` |
| Capture-specific refunds: exact `captureFactId`, ordinary vs capture-specific never interchangeable (R6H-5) | E `auth/authorization-receipts`, `capture-refunds`, `refund-cases` R6H-5; S R6H-5; **X `s6-certification` §1 (real Auth refuses an ordinary receipt for a capture case)** |
| Per-capture uniqueness; ordinary per-payment rules unchanged; concurrency (R6H-5) | E `capture-refunds` §6, §7; S R6H-5 race and index assertions |
| No purchase reversal for a capture without its own purchase (`capture_refunded`) | E `refund-cases` R6H-5; **X `s6-certification` §1** |

### 3.2 Payment disputes (S6e-D)

| Contract | Evidence |
|---|---|
| Provider-authenticated dispute notifications only; duplicate and contradictory observations preserved | E `payment/disputes`; S S6e-D |
| Open dispute blocks new refund admission; in-flight attempts continue | E `disputes`, `refunds`; X `s6b` (S6e-D test) |
| Final full chargeback: direct purchase reversed once; assisted purchase preserved, recovery obligation instead | E `refund-cases`, `recovery`; X `s6b` (S6e-D test) |
| Partial chargeback: no reversal, no debt (review only) | E `recovery` (S6f exclusions), `recovery` S6h-B; S S6f |
| Owner dispute decision with a dedicated `dispute_decision` receipt | E `disputes`; X `s6b` |

### 3.3 Fraud holds (S6e-H)

| Contract | Evidence |
|---|---|
| Owner with dedicated place / release receipts and File `fraud_evidence` | E `billing/fraud-holds` |
| Exact beneficiary and product isolation; 14-day expiry; exact-duration C-1 compensation; reversals during a hold; no compensation for invalid periods | E `fraud-holds`; S S6e-H |

### 3.4 Recovery and surplus (S6f, S6h-B)

| Contract | Evidence |
|---|---|
| Base-only obligation from a full assisted chargeback; never for a refunded payment | E `recovery`; S S6f |
| Live Organization-administrator authority; never the beneficiary or the Owner | E `recovery` (authority) |
| One open-or-uncertain channel; verified success only; principal / surplus split by the database | E `recovery`; S S6f |
| T1 / T2 / T3 composition; T3 clears exactly once | E `recovery`, `assistance`; S S5d, S6f |
| **Late success** counted once (event, read, re-statement of the fact); never `payment.succeeded`; request keeps its terminal state | E `recovery` S6h-B (certification scenario); **X `s6-certification` §2 (EVT-10 over the broker)** |
| Full-surplus refund (Path A), including a LATE surplus refunded as exactly its capture | E `recovery` Path A, S6h-B |
| External repayment and recipient confirmation (Path B) | E `recovery` Path B |
| No offset, no expiry, no revenue recognition; a surplus never re-opens T3 | E `recovery`; S S6f, S6h-B |

### 3.5 Late assisted settlement (S6g)

| Contract | Evidence |
|---|---|
| No automatic entitlement; original Payment instant preserved | E `late-settlements` |
| Beneficiary attestation or File evidence; Owner application with a dedicated receipt | E `late-settlements` |
| Full entitlement duration from the application; superseded obligation; a later refund opens the correct new obligation | E `late-settlements`; S S6g |
| An unapplied late settlement is a reconciliation case, resolved by its L-4 application | E `late-settlements` (S6h-B test) |

### 3.6 Reconciliation and `FinancialLoss` (S6h-P, S6h-B)

| Contract | Evidence |
|---|---|
| Unmatched verified facts: signature-verified only, grace window, immutable | E `payment/reconciliation`; S S6h-P |
| Owner-authorized association with a dedicated receipt; append-only | E `payment/reconciliation`; S S6h-P |
| Signed per-currency balances, negative values, never clamped | E `payment/reconciliation`; **X `s6-certification` §1** |
| All twelve case types; deterministic identity; concurrent sweepers open once; historical discovery | E `recovery` S6h-B, `late-settlements`; S S6h-B; **X `s6-certification` §1, §2** |
| Resolution only by evidence (database-checked); acknowledgement only for review-only types | E `recovery` S6h-B; S S6h-B |
| Over-return loss = allocation excess only | E `recovery` S6h-B |
| Direct full final-lost chargeback loss; overlap with a refund → case, never double recognition | E `recovery` S6h-B |
| Owner recovery write-off: dedicated receipt, accounting only, T3 stays, later recovery adjusts append-only | E `recovery` S6h-B; S S6h-B |
| Q8: an unanswered authorization stays an open case until a definitive outcome | E `recovery` S6h-B, `payment/reconciliation` |
| PAY-12 read restricted to billing-service (repository policy and config) | U `payment-config`; **X `s6-certification` §3** |

## 4. Financial, security and authorization findings

- **Production refusal (verified).** Every S6 module returns an empty module in production: Billing `RefundModule`, `RecoveryModule`,
  `LateSettlementModule`, `ReconciliationModule`, `AssistanceModule`, `CheckoutModule`; Payment `RefundsModule`, `DisputesModule`,
  `ReconciliationModule` (also unmounted without refunds configured); the simulation module requires simulation enabled AND non-production.
  Payment's configuration refuses `payment.refund.create` and `payment.reconciliation.read` in production configuration.
- **PAY-12** answers billing-service only (cross-process: another service token 403, a user bearer 401); the configuration refuses any other
  holder and any wildcard; `unmatched_fact` is never a producer kind.
- **Receipts.** A capture-specific receipt is never consumed as an ordinary one nor the reverse (real Auth, cross-process); refused receipts stay
  `issued`; no secret appears in any database or outbox (earlier `s6b` suite).
- **Isolation.** Cross-Company and cross-Platform reads are the collapsed 404 (refund cases, recovery, reconciliation cases, losses, Payment
  balances); members and operators are refused (per-service e2e). Cross-Organization isolation of recovery and assistance holds (e2e).
- **EVT-05 / EVT-06.** Billing produces only `invoice.created`: no `billing.*` event exists.
- **No critical financial or authorization defect remains** after the correction of §5.1.

## 5. Defects and corrections

### 5.1 MEDIUM (code defect, corrected): Billing could open a capture-specific case Payment would always refuse

- **Reproduction:** cross-process §1. After a duplicate capture is refunded, Billing accepts a capture-specific case for the LAST capture of
  the settling attempt (201).
- **Root cause:** Payment enforces the R6H-5 rule (the last capture backing the sale is never refunded on its own, `refund_capture_not_eligible`)
  but its capture read (`GET /payment/payments/:id/captures/:factId`) still reported that capture's basis as `duplicate_capture` with refund
  state `none`, so Billing had no way to know.
- **Effect:** no wrong money movement (Payment refuses definitively), but a dead-end refund case that, while open, blocks an ordinary refund of
  the payment until the Owner cancels it; misleading evidence.
- **Contract:** R6H-5 (register PAY-07 H, BIL-23 G: Billing never opens a case its evidence contradicts).
- **Correction:** the capture read states `refundableOnItsOwn` (the rule Payment enforces); Billing refuses `refund_not_eligible` when it is
  false. Regression tests in Payment `capture-refunds`, Billing `refund-cases` and the cross-process suite.

### 5.2 LOW (stale test assertion, corrected; not a product defect)

`scripts/deploy-tests/real-broker-topic-grants.mjs` (on demand, not in CI) expected Billing to receive every non-audit Payment event except
`payment.created`; since S6e-D Payment also publishes `payment.dispute.opened`, which Billing deliberately does not consume. The test now asserts
exactly Billing's bound events, and that the unbound ones are never delivered.

## 6. Provider-event and broker reliability

- Verified-only consumption (S1e): `payment.late_success.recorded`, `refund.case_completed`, `payment.dispute.lost` reach Billing only as
  broker-verified originals or verified replays; their origin is recorded (`payment_event_origin`, cross-process §2).
- Nothing dead-lettered in the cross-process runs; earlier real-broker suites cover dead-letter, replay, consumer recovery and reconciliation.
- Every financial worker is replay-safe (deterministic keys, `ON CONFLICT`, database guards): the refund worker, the allocation leases, the
  refund-effect and dispute-loss workers, the recovery worker and the reconciliation worker; each has a "crash between steps" path tested.
- Topic grants are generated from the contracts; Billing `[45, 7]`, Payment `[23, 0]`; the real-broker grant test passes after §5.2.

## 7. Migrations and historical compatibility

| Service | S6 migrations | Review |
|---|---|---|
| Payment | 0017 to 0022 | expand-only; new columns with safe defaults (`captureSpecific` false; authorization capture derived); uniqueness replaced scope-correctly, never relaxed (ordinary per-payment indexes kept under their names); NULL-logic gaps closed (`IS NOT TRUE`, `COALESCE`) in 0021 and 0022 |
| Billing | 0033 to 0042 | expand-only; append-only ledgers (no update/delete/truncate triggers); resolutions and losses checked against their evidence by the database; `recovery_payment` uniqueness per applied success and per late success |

Historical data: existing refund attempts and authorizations are ordinary (backfilled `captureFactId` from their attempt); existing recovery
payments keep their applied receipts; the reconciliation worker discovers historical evidence (losses, late settlements, unrouted sales,
surpluses) once. Every migration applies on the full chain from an empty database (each service's migration suite).

## 8. Open decision and operational-gate register (not resolved by this certification)

| Item | State | Effect today |
|---|---|---|
| **Q8** (proof of receipt non-consumption, AUTH-03b) | OPEN, fail-closed (R6H-9) | an unanswered authorization stays pending and visible; never released |
| **Partial chargebacks** (financial policy) | OPEN | review-only cases; no reversal, no debt, no loss |
| **V-4** (lifecycle effective-state) | deferred (lifecycle runtime MOVE V3) | D6 not enforced |
| **V-5** (discharge actors in inactive Organizations) | policy approved; S5e runtime deferred | — |
| **OD-R6a** | OPEN | blocks R-6a of S2-Auth only |
| **EVT-05 / EVT-06** (`billing.*` events) | not approved | none produced |
| **Production activation** | gated | every S6 route and worker unmounted in production |
| Payment `PAYMENT_SERVICE_POLICY` must grant `payment.reconciliation.read` to billing-service where reconciliation runs | operational | without it Billing's worker reads nothing (fails closed, logged) |
| Late successes once Payment runs in production | operational gate | Payment records them in any mode; Billing's handler exists only where reconciliation is mounted, so a production Billing would dead-letter them (visible, never silent) until the reconciliation slice is activated there |
| Real-broker deployment tests run on demand, not in CI | operational | §5.2 went unnoticed since S6e-D |

## 9. Residual risks

| Risk | Severity | Note |
|---|---|---|
| A write-off receipt consumed while a concurrent verified recovery changes the outstanding amount | Low | the record is refused (`write_off_not_permitted`); the Owner re-authorizes; no wrong loss |
| A movement matched to an attempt after its unmatched fact was kept | Low | a `fact_conflict`; counted only once associated (S6h-P) |
| Ordinary refund of a sale with two captures of its settling attempt stays refused | Low | fail-closed by design; the duplicate is refunded capture-specifically |
| Unmatched facts invisible to Billing until associated | Low | by design (S6h-P); the Owner sees them in Payment |
| On-demand real-broker suites can go stale | Medium (process) | recommend a scheduled run before any activation |

## 10. Recommendation

**S6 CONDITIONAL PASS (simulation).** Every critical financial invariant is tested at the database, per-service and, for the newest contracts,
cross-process level; the one code defect found is corrected (merge required); the conditions are the open contracts and operational gates of §8,
which this certification documents and does not resolve. Production remains last.

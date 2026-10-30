# Core V2 S4: Payment — stage record

| | |
|---|---|
| Stage | S4 Payment, MANDATORY for development and simulation; production gated (G-2; A11 MOVE V3) ([execution roadmap](./core-v2-s-execution-roadmap.md) §4.4; [ADR-0068](../adr/0068-no-cash-settlement-for-nawara-sold-products.md); [ADR-0035](../adr/0035-financial-service-boundaries.md) C1, C2, C4; [S0](./core-v2-s0-architecture-freeze.md) §3.1, §3.2, §3.7, §3.8) |
| Record created | 2026-10-30, Phase 4 of the Owner's post-S6 plan (documentation and evidence only), on `main` at `18b0089` |
| Why now | Roadmap §2.2 (5) asks for a stage record created at authorization; none was. This record assembles the evidence; it adds no test and changes no behaviour |
| **Verdict** | **CONDITIONAL PASS — development and simulation.** S4a to S4g are merged and every S4 certification-gate criterion has database-level, per-service and, for the money loop, real-broker evidence (§2). **Open:** the S4e Organization-payer creation grant stays inactive (V-5, OD-R6a), no real provider adapter exists (deferred), and Payment's production disposition is MOVE V3. **Operational acceptance: none in scope** (G-2) |

Evidence levels: **L** per-service tests on real PostgreSQL and the SQL invariant suite (`apps/payment-service/db/tests/invariants.sql`)
in `core-ci-passed`; **I** cross-process real-broker suites; **O** an operational environment (none; none in scope).

## 1. Work packages and their merges

| Id | Content | PR (merge) |
|---|---|---|
| S4a | payer, purpose, beneficiary, `liveMode` (always `false`: simulation); DB-15; immutability (S-6); mapping version 2 (DOC-6 written in the Payment SDD and ADD) | #373 (`e93e33f`) |
| S4b | DB-16: no cash settlement of a Company seller | #374 (`5600231`) |
| S4c | closing and finality; no second checkout under uncertainty; durable late-success evidence | #375 (`7e449b0`) |
| S4d | immutable `provider_transaction_fact`, committed independently of its application | #376 (`7672c6d`) |
| S4g | class-M money-command idempotency, 90 days, database clock | #377 (`7925620`) |
| S4f | the `simulation` provider and its harness (OD-06, F-S1 to F-S7); refused in production | #378 (`f164550`) |
| S4e | Organization-payer attempts behind an inactive creation grant (A-1 to A-7) | #379 (`c103b0f`) |

## 2. Certification gate (roadmap §4.4)

| Criterion | Level | Evidence | Status |
|---|---|---|---|
| DB-15 payer / purpose pairing and immutability, bypassing the application | L | `apps/payment-service/test/payment-purpose.e2e-spec.ts` ("straight at the database: DB-15, the B2 pairings, simulation-only mode and immutability"); `organization-payer.e2e-spec.ts`; `invariants.sql` | PASS |
| DB-16 no Company-seller cash, bypassing the application | L | `no-company-cash.e2e-spec.ts`; `invariants.sql` | PASS |
| Identical redelivery yields one fact; contradictions kept as conflicts; facts never edited or deleted | L | `provider-facts.e2e-spec.ts` ("the same capture through the status read and then the webhook (and both again, concurrently) is still one fact"; "raw SQL can neither edit nor delete a fact or a conflict") | PASS |
| Fault injection after a fact commit (facts survive a failed application) | L | `webhooks.e2e-spec.ts` ("the retrier reprocesses an event left stuck in received (simulating a crash between transactions A and B)"); `provider-facts.e2e-spec.ts` (committed, then applied once); `review-adversarial.e2e-spec.ts` R-14 (outbox failure rolls the state change back; the retry commits both); S6 "facts survive allocation failure" ([S6 report](./core-v2-s6-financial-certification.md) §3.1) | PASS |
| Finality: no second checkout while a payment is uncertain; a late success never reopens | L | `review-adversarial.e2e-spec.ts` R-01, R-02; `provider-facts.e2e-spec.ts` (closing; after the workflow ended) | PASS |
| Production configuration refuses the simulation and test providers and the harness | L | `src/config/payment-config.spec.ts` ("refuses to start in production with the simulation provider, or with its secret configured"; the test provider switch); `payment-purpose.e2e-spec.ts` | PASS |
| Every money record and event carries `liveMode`; simulation never presents as live | L | `payment-purpose.e2e-spec.ts` ("the settled event carries purpose and liveMode=false") | PASS |
| `payment.*` version 1 compatibility; pre-S4a records never re-interpreted | L, I | `payment-purpose.e2e-spec.ts` ("a payment created before S4a …"); `review-adversarial.e2e-spec.ts` R-12 (common payload); `test/e2e-real-broker/s4f-simulation-settlement.e2e-spec.ts` | PASS |
| Class-M idempotency of 90 days with permanent uniqueness keys | L | `money-idempotency.e2e-spec.ts` | PASS |
| Organization-payer attempts: live Organization actor, Organization scope, creation grant default-denied and refused in production configuration | L, I | `organization-payer.e2e-spec.ts`; `test/e2e-real-broker/s4e-organization-payer.e2e-spec.ts` | PASS (capability inactive) |
| S3/S4 joint checkpoint | L, I | see the [S3 record](./core-v2-s3-billing.md) §2 (segmented) | PASS (segmented) |
| Payment never calls Billing (C4) | static | `apps/payment-service/src` has no Billing URL or HTTP client (static review, 2026-10-30); `check:repo` forbids cross-service imports | PASS |

## 3. Open, blocked and deferred

| Item | State | Effect |
|---|---|---|
| S4e creation grant `payment.create.organization_payer` | inactive (default-denied, refused in production configuration); assisted and recovery settlement use their own narrow grants (S5b, S6f) | V-5 and OD-R6a open; R-6a no later than V-4 |
| Real payment-provider adapters (Flouci, Konnect, Paymee, Stripe) | DEFERRED (S0 §5) | only `test` and `simulation` exist; both refused in production |
| Payment production enablement | MOVE V3 (G-2; A11) | not deployed |
| Re-emission execution (S1c-3 R2b) | OPEN | S1 record §4 |

## 4. Unresolved contract decisions and their impact

- ADR-0068 and ADR-0035 remain **Proposed** (G-1); ADR-0068's partial supersession of ADR-0007 takes effect only on its acceptance.
- The simulation-adapter decision (OD-06) is resolved: `simulation` beside `test`, mutually exclusive, both refused in production.

## 5. Verdict

**S4: CONDITIONAL PASS (development and simulation).** The conditions are §3: the inactive Organization-payer creation grant, the
deferred real providers and Payment's production disposition. No production claim is made.

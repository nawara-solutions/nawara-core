# Core V2 S5: assistance and cash obligations — stage record

| | |
|---|---|
| Stage | S5 assistance and cash obligations, MANDATORY ([execution roadmap](./core-v2-s-execution-roadmap.md) §4.5; [S0](./core-v2-s0-architecture-freeze.md) §3.3, FC-8, FC-9, DN-1; [ADR-0068](../adr/0068-no-cash-settlement-for-nawara-sold-products.md); [ADR-0035](../adr/0035-financial-service-boundaries.md) C1) |
| Record created | 2026-10-30, Phase 4 of the Owner's post-S6 plan (documentation and evidence only), on `main` at `18b0089` |
| Why now | Roadmap §2.2 (5) asks for a stage record created at authorization; none was. This record assembles the evidence; it adds no test and changes no behaviour |
| **Verdict** | **CONDITIONAL PASS for S5a to S5d — development and simulation. S5 as a whole is NOT certified:** the **S5e runtime is DEFERRED** (the V-5 policy is Owner-approved; the runtime waits for V-4 and OD-R6a), **D6 is not enforced** (V-4), and the gate criterion "inactive scopes refuse new requests while every discharge action works" **cannot be evidenced** until a scope can be inactive (DN-1.4). T3 arrived with S6f. **Operational acceptance: none in scope** |

Evidence levels: **L** per-service tests on real PostgreSQL and `apps/billing-service/db/tests/invariants.sql` in `core-ci-passed`; **I**
cross-process real-broker suites; **O** an operational environment (none; none in scope).

## 1. Work packages and their merges

| Id | Content | PR (merge) |
|---|---|---|
| S5a | assistance requests with frozen terms, decline, cash collection (`consentAt ≤ cashCollectedAt ≤ reportedAt`, `settleBy = cashCollectedAt + 72h`, a late report born overdue); Owner D-1 to D-12 | #380 (`058e336`) |
| S5b | the assisted settlement channel (DB-5, DB-13); the full cash-return obligation, the Organization's fee included; Owner E-1 to E-13 | #381 (`e7cbafd`) |
| S5c | factor-only assistance step-up purposes (Auth, H-1); cash-return confirmation, beneficiary disputes without cutoff, the Organization's response, append-only Owner timestamp corrections and the nonfinancial resolution (H-1 to H-7, J-1 to J-6) | #382 (`8b2021f`), #383 (`6c1d525`) |
| S5d | the restriction framework: T1 and T2 block NEW requests only, clear on verified resolution; no persistent repeat-violation state (S5D-1 to S5D-8) | #384 (`954dc02`) |
| S5e (policy) | the Owner-approved V-5 inactive-Organization discharge policy (V5-1 to V5-9) | #385 (`a299def`), documentation only |
| T3 | recovery restriction wired into the S5 framework | S6f, #397 (`a50f612`) |

## 2. Certification gate (roadmap §4.5)

| Criterion | Level | Evidence | Status |
|---|---|---|---|
| FC-8 time-order negative tests | L | `apps/billing-service/test/assistance.e2e-spec.ts` ("time order (FC-8): before the consent or in the future is 422 cash_collection_time_invalid"); database CHECKs | PASS |
| `settleBy` exactly 72 hours; overdue derived from the database clock, never stored | L | `assistance.e2e-spec.ts`; `assistance-restrictions.e2e-spec.ts` ("the exact boundary: at settleBy it does not apply, one microsecond later it does") | PASS |
| An Auth outage gives `503` with no mutation | L | `assistance.e2e-spec.ts` ("fails closed … nothing is written"), `assistance-resolution.e2e-spec.ts`, `assistance-restrictions.e2e-spec.ts` | PASS |
| Restriction clearing rules (T1, T2); kinds only; no stored restriction state | L | `assistance-restrictions.e2e-spec.ts` (T1 and T2 clearing, several obligations, "no restriction state is ever stored") | PASS |
| Restrictions never block discharge | L | `assistance-restrictions.e2e-spec.ts` ("an Organization under both T1 and T2 can still perform every authorized discharge action, and verified Payment success still applies") | PASS |
| The database refuses a request into a restricted Organization whatever path inserts it; races without deadlock | L | `assistance-restrictions.e2e-spec.ts` (direct insert; four race tests) | PASS |
| Cash alone never activates and never settles (ADR-0068, ADR-0035 C1) | L, I | `assistance.e2e-spec.ts` ("nothing financial created"), `assistance-resolution.e2e-spec.ts` ("nothing financial is created"); settlement only by a verified Payment success: `assisted-settlement.e2e-spec.ts`, `test/e2e-real-broker/s5b-assisted-settlement.e2e-spec.ts` | PASS |
| DB-5, DB-12, DB-13 | L | `assisted-settlement.e2e-spec.ts`; `invariants.sql` | PASS |
| Violations never erased; corrections append-only; lifecycle never derived from commercial state (DN-1.5) | L | `assistance-resolution.e2e-spec.ts` (append-only corrections; evidence kept); `assistance-restrictions.e2e-spec.ts` (violation evidence kept) | PASS |
| **Inactive scopes refuse new requests while every discharge action works for its authorized actors** | — | no scope can be inactive until V-4 delivers the effective lifecycle state (DN-1.4, S-9); there is nothing to test against | **DEFERRED (V-4)** |
| **D6** inactivity restriction | — | reserved kind with no source; no lifecycle state is inferred (S5D-7) | **DEFERRED (V-4)** |
| **S5e** DN-1 discharge actions in inactive scopes, live authority per request | — | V-5 policy approved (#385); runtime not implemented | **DEFERRED (V-4, OD-R6a; V5-9)** |
| Production refusal | L | every S5 module unmounted in production and refused by the service (`assistance-restrictions.e2e-spec.ts` "production mounts nothing of S5d"; the S5a to S5c suites) | PASS |

## 3. Open, blocked and deferred

| Item | State | Effect |
|---|---|---|
| **S5e** runtime | DEFERRED until V-4 and OD-R6a (V5-9) | the V-5 policy is recorded; nothing runs |
| **V-4** effective-state contract (ADR-0060 lifecycle runtime MOVE V3; chain: OD-R6a → PR #319 reconciliation (S8) → F6 / F7 → ADR-0060 L2 / L3) | DEFERRED | D6 not enforced; every S5 feature is valid only while no scope can be inactive (S0 §3.6.4) |
| **OD-R6a** | OPEN | gates S5e and any activation of the assistance features |
| `resolved_by_owner`, monetary corrections, voiding a report, obligation cancellation (H-2 limited, J-2) | not implemented by decision | — |
| `cash_not_returned` and `collection_not_made` disputes have no resolution in S5c (J-1) | by decision | they stay open |
| Production | NOT IN SCOPE | nothing mounted in production |

## 4. Unresolved contract decisions and their impact

- ADR-0068 and ADR-0035 remain **Proposed** (G-1); ADR-0007's reciprocal note (DOC-8) is not written.
- Lifecycle (V-4) is the decisive dependency: until it exists, S5's inactive-scope behaviour can be neither implemented nor certified,
  and an activation of assistance in production would be unsafe the moment a scope could become inactive.

## 5. Verdict

**S5a to S5d: CONDITIONAL PASS (development and simulation). S5: NOT CERTIFIED as a stage** while S5e and D6 stay DEFERRED and the
inactive-scope criterion has no evidence. This record does not change that by redefining the criterion.

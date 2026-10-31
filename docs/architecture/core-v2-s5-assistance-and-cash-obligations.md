# Core V2 S5: assistance and cash obligations — stage record

| | |
|---|---|
| Stage | S5 assistance and cash obligations, MANDATORY ([execution roadmap](./core-v2-s-execution-roadmap.md) §4.5; [S0](./core-v2-s0-architecture-freeze.md) §3.3, FC-8, FC-9, DN-1; [ADR-0068](../adr/0068-no-cash-settlement-for-nawara-sold-products.md); [ADR-0035](../adr/0035-financial-service-boundaries.md) C1) |
| Record created | 2026-10-30, Phase 4 of the Owner's post-S6 plan (documentation and evidence only), on `main` at `18b0089` |
| Why now | Roadmap §2.2 (5) asks for a stage record created at authorization; none was. This record assembles the evidence; it adds no test and changes no behaviour |
| **Verdict** | **CONDITIONAL PASS — development and simulation, pre-lifecycle scope (S0-C7).** Effective on the Owner's merge of this record (roadmap §2.2 (5)); it replaces the earlier "S5 NOT CERTIFIED" (§7). S5a to S5d meet their criteria; the pre-lifecycle invariant is evidenced by T-A1 to T-A4 (#411, #412, #414, #415). **Not certified, and not claimed:** any lifecycle runtime behaviour. V-4, S5e and D6 are not implemented or activated, and the S0 §8 criterion "inactive scopes refuse new requests while every discharge action works for its authorized actors" stays a **blocking** criterion of the first lifecycle-enabled release (S0-C7 items 2 and 3). **Operational acceptance: none in scope** |

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

*Superseded on 2026-10-31 by §7 (S0-C7, owner-approved):* **S5: CONDITIONAL PASS — development and simulation, pre-lifecycle scope.** The
criterion is not redefined: S0-C7 keeps it verbatim and makes it a blocking criterion of the first lifecycle-enabled release.

## 7. Update (2026-10-31): certification under S0-C7

S0-C7 ([S0 record](./core-v2-s0-architecture-freeze.md) §1.5, owner-approved 2026-10-30, in effect since T-A1 to T-A4 merged) certifies
S5 for Core V2 on its S5a to S5d criteria and on evidence that no Core V2 path can produce, store, read or act on an inactive Company,
Platform or Organization.

| S0-C7 item 1 evidence | Merge | What it proves |
|---|---|---|
| T-A1 `apps/auth-service/test/pre-lifecycle-invariant.e2e-spec.ts` | #411 (`7cc86d1`) | Auth holds no hierarchy lifecycle column, constraint, table or enum; no route changes one (Owner probes are `404`); the Organization read is `{id, platformId}` |
| T-A2 `apps/organization-service/test/pre-lifecycle-invariant.e2e-spec.ts` | #412 (`6b0150b`) | organization-service, authoritative in test: no lifecycle column; the reference read is exactly the three anchors; eight lifecycle fields refused (`400`, no mutation) on every update route and at creation |
| T-A4 `apps/billing-service/test/pre-lifecycle-invariant.e2e-spec.ts` | #414 (`31eebe1`) | Billing behaves identically for a contract reference and one carrying a non-contract `effectiveStatus: 'SUSPENDED'`: creation, decline, cash collection, settlement, dispute, response, T1/T2 and T3; `inactive` stays reserved and is never produced; a mutation that consumes the field fails 5 of 7 tests |
| T-A3 kit `organization-reference.spec.ts` and `check:repo` `checkPreLifecycleInvariant` | #415 (`abb39f4`) | the kit exposes only the three anchors; the guard rejects 20 forbidden lifecycle changes (schema, routes, ports, the reference contract, consumption, the reserved kind) and accepts 7 legitimate ones, on every CI run |

**Reclassification of §2 (frozen criteria unchanged):**

| Criterion | Before | Under S0-C7 |
|---|---|---|
| Inactive scopes refuse new requests while every discharge action works for its authorized actors | DEFERRED (V-4) | **Retained verbatim; a blocking criterion of the first lifecycle-enabled release** (item 2). In Core V2: the pre-lifecycle invariant (item 1), evidenced above |
| D6 inactivity restriction | DEFERRED (V-4) | with the first lifecycle-enabled release (item 3); `inactive` reserved with no source (T-A3, T-A4) |
| S5e DN-1 discharge in inactive scopes | DEFERRED (V-4, OD-R6a; V5-9) | with the first lifecycle-enabled release (item 3), with V5-2 activation and the applicable OD-R6a certification (D-2); V5-9 unchanged |
| Every other §2 criterion | PASS | PASS (unchanged evidence) |

**S-INT entry classification** ([roadmap](./core-v2-s-execution-roadmap.md) §5, D-3): every applicable development-level criterion is
PASS; the remaining conditions are dispositioned (c): S0-C7 items 2 and 3, D-2, and the Owner's H-2, J-1 and J-2 limits; production is (a).
See the [condition matrix](./core-v2-stage-condition-matrix.md). No development-level item is OPEN without a disposition. S5's eligibility for S-INT is decided by the Owner's approval of the
S-INT readiness record.

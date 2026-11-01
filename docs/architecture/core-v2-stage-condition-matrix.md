# Core V2 S1–S6: remaining conditions under the S-INT entry rule

| | |
|---|---|
| Record | 2026-10-31, documentation only, on `main` at `e96c00d` (PRs #410 to #416 merged) |
| Rule applied | [Execution roadmap](./core-v2-s-execution-roadmap.md) §5 "S-INT entry: individual certification" (the Owner's decision D-3, 2026-10-30) |
| What this is | The classification of every remaining condition of the S1 to S6 stage records, and the list of what is still OPEN at development level. It promotes no verdict and authorizes no S-INT: the S-INT readiness record lists these conditions for the Owner's approval |

Categories (D-3): **(a)** production or operational gate · **(b)** Lab-only verification · **(c)** a deferral approved in S0 §5, an S0-C
clarification, an Owner-recorded disposition or a Core roadmap disposition · **(d)** an open decision whose implemented behaviour is
fail-closed and tested, with its decision id · **OPEN** a development-level item none of (a) to (d) covers: it keeps its stage uncertified
for S-INT entry until it is dispositioned.

## 1. Certification-gate status per stage

| Stage | Gate criteria (roadmap §4) at development level | Record |
|---|---|---|
| S1 | all PASS; the real-systemd half of OD-BRK-2b-L is Lab-only (b) | [S1](./core-v2-s1-event-security.md) |
| S2 | all PASS (R-6a is a work package, dispositioned by D-2) | [S2](./core-v2-s2-independent-foundations.md) |
| S3 | all PASS, the S3/S4 joint checkpoint now in one cross-process run (#410) | [S3](./core-v2-s3-billing.md) |
| S4 | all PASS, the joint checkpoint as S3 | [S4](./core-v2-s4-payment.md) |
| S5 | S5a to S5d PASS; the inactive-scope criterion assigned to the first lifecycle-enabled release by S0-C7, evidenced pre-lifecycle by T-A1 to T-A4 | [S5](./core-v2-s5-assistance-and-cash-obligations.md) |
| S6 | all PASS (simulation) | [S6](./core-v2-s6-financial-certification.md) |

## 2. Remaining conditions and their classification

| Stage | Condition | Category | Basis |
|---|---|---|---|
| S1 | S1-R production rollout (identity, observe-only, narrowed grants, enforcement per consumer) | (a) | roadmap §4.1 S1-R |
| S1 | C-4, AP-R, NP-K, G-7 | (a) | roadmap §7 |
| S1 | S1c-3 R2b Payment re-emission execution | (c) | D-5 (a): before S1-R enforcement and production re-emission, not before S-INT |
| S1 | S1c-3 R3 Auth and Organization re-emission | (c) | S0-C4 (Auth and Organization undecided, G-7 / M3) |
| S1 | S1c-3 R4 production re-emission workflow | (a) | roadmap §4.1 S1c |
| S1 | OD-15 for producers other than Payment | (d) | re-emission is impossible for them; `check:repo` "producer re-emission foundation" guard |
| S1 | OD-BRK-2b-2 installation; OD-BRK-3 (Billing, before its first deployment); OD-BRK-4, OD-BRK-5 | (a) | ADR-0057 §8 "OD-BRK-0" |
| S1 | OD-BRK-2b-L real-systemd half | (b) | BLOCKED — HARDWARE MAINTENANCE (Nawara Lab 01); never reported as passed |
| S2 | R-6a (AUTH-08), DOC-1 not in the repository | (c) | D-2: OPEN, due before the earlier of F6/F7 and the first lifecycle-enabled release; not V3 |
| S2 | Audit Organization-reference scope rows | (c) | D-4: bound to Organization authority activation (ADR-0069 decision 4); not an S0 §5 deferral |
| S2 | Q8 proof of receipt non-consumption | (d) | Q8: an unanswered authorization stays pending, never released (S6 report §3.6) |
| S2 | Q9 receipt token provisioning and caller admission records | (a) | operational |
| S2 | Production: Auth digest deployment (M3, G-7); Audit 0004+ (M9, G-7, AP-R); File (M8, DG-2); Release | (a) / (c) | roadmap dispositions (Release MOVE V3) |
| S3 | **BIL-12** `GET /billing/me/personal-subscriptions` | **OPEN** | register: "whether this read is in initial scope"; not built and not tested, so it is not (d); needs an Owner disposition (in scope: implement; out of scope: record) |
| S3 | OD-05 catalog VALUES | (a) | the capability is built (D-CAT-1); values gate real catalog configuration only |
| S3 | EVT-05 `billing.subscription.*` | (d) | not in Billing's event contract; the broker refuses Billing any ungranted key (S1d-3 `real-broker-topic-grants.mjs`) |
| S3 | Invoice legal content (B-001, B-006, B-007, B-028) | (c) / (a) | S0 §5 (tax, invoicing entity); production only |
| S3 | DG-4 Billing production disposition; OD-BRK-3 | (a) | Core roadmap |
| S4 | Organization-payer creation grant inactive (V-5, OD-R6a) | (d) | default-denied and refused in production configuration (`organization-payer.e2e-spec.ts`); R-6a timing per D-2 |
| S4 | Real payment-provider adapters | (c) | S0 §5 |
| S4 | Payment production enablement | (c) | Core roadmap A11 MOVE V3 |
| S4 | S1c-3 R2b | (c) | D-5 (a) |
| S5 | S0 §8 inactive-scope criterion | (c) | S0-C7 item 2: a blocking criterion of the first lifecycle-enabled release |
| S5 | V-4, S5e, D6, V5-2 activation | (c) | S0-C7 item 3; V5-9 unchanged |
| S5 | OD-R6a | (c) | D-2 |
| S5 | `resolved_by_owner`, monetary corrections, report voiding, obligation cancellation; no resolution for `cash_not_returned` / `collection_not_made` | (c) | the Owner's H-2 (limited), J-1, J-2 |
| S6 | Q8 | (d) | as S2 |
| S6 | Partial chargebacks | (d) | review-only, no reversal, debt or loss (`recovery.e2e-spec.ts` exclusions) |
| S6 | EVT-06 `billing.recovery.*` | (d) | as EVT-05 |
| S6 | BIL-35 legal remedies record | (c) | S0 §5 (execution of legal remedies) |
| S6 | Real provider; production activation of every S6 module; `PAYMENT_SERVICE_POLICY` reconciliation grant; late successes in a production Billing | (c) / (a) | S0 §5; S6 report §8 |
| S6 | Real-broker deployment suites on demand, not in CI | (a) | a recurring or required run is a separate Owner decision |

## 3. OPEN at development level

| Stage | Item | Effect | Decision needed |
|---|---|---|---|
| S3 | BIL-12 (personal-subscriptions read for the member) | S3 does not meet the S-INT entry rule until dispositioned | the Owner records BIL-12 either as outside Core V2's initial scope (category (c)) or as a work package to implement and test |

No other development-level criterion, invariant test or work package of S1 to S6 is OPEN, BLOCKED or NOT STARTED without a disposition.

## 4. Not changed by this record

No S0 requirement, no frozen contract, no production or operational gate (none is marked complete), no ADR status, no code.

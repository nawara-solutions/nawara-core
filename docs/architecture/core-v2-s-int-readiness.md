# Core V2 S-INT: readiness record

| | |
|---|---|
| Status | **PROPOSED readiness record, for the Owner's review and approval.** Documentation only |
| Prepared | 2026-11-01, on `main` at `085a75008678fb9a5f70cc0bce65e2aa51c7ea42` (the #429 merge) |
| Baseline CI | `main` push run `41309502612` (Core CI), 2026-11-01 13:04–13:11 UTC: **24 of 24 jobs succeeded**, none skipped or missing (§2) |
| Rule applied | [Execution roadmap](./core-v2-s-execution-roadmap.md) §5 "S-INT entry: individual certification" (the Owner's D-3, 2026-10-30) |
| Scope | **S1 to S6.** S7 and S8 are excluded from Core V2's S-INT by the Owner's explicit decision of 2026-11-01 (§5) |

**What this record is not.**

- **Eligible for S-INT authorization does not mean S-INT execution is authorized.** Execution needs this record approved by the Owner
  (merged) and then its own, separate Owner authorization (execution roadmap §5 "Approval").
- **S-INT development certification is not production readiness.** S-INT certifies cross-service paths on simulation, in disposable
  environments; every production, operational, security and lifecycle gate of §8 stays in force. It is not Final Core Validation.
- It promotes no stage verdict, accepts no ADR, changes no S0 text and no code.

## 1. Baseline

`main` at `085a750` contains, among the S-track records:

| PR | Content | Merge |
|---|---|---|
| #416 | S0-C7 governance (S5 pre-lifecycle certification) | `e96c00d` |
| #417 | S1 to S6 stage records and the [condition matrix](./core-v2-stage-condition-matrix.md) | `c49bd59` |
| #423, #424, #425 | BIL-12: contract, implementation, record | `b5614e1`, `65aaaf1`, `c620de4` |
| #426 | F-INV-1: the invoice list paged at microsecond precision | `e3b8133` |
| #427 | S7/S8 scope decision and V3 carry-over | `841a837` |
| #428, #429 | test-only fixes that restored a green `main` after `841a837` (BIL-12 read-only fingerprint; File ticket settlement wait) | `533e4c9`, `085a750` |

`main` at `841a837` was red (Billing and File tests; both test defects, fixed by #428 and #429). **No part of this record relies on that
baseline.**

## 2. Evidence and its freshness

**Fresh at `085a750` (run `41309502612`, every CI run executes them):**

| CI job | Suites | Result |
|---|---|---|
| Real RabbitMQ loops (`npm run test:e2e -w @nawara/e2e-real-broker`, `test/e2e-real-broker/*.e2e-spec.ts`) | `s3s4-joint-checkpoint`, `s4e-organization-payer`, `s4f-simulation-settlement`, `s5b-assisted-settlement`, `s6b-refund-processing`, `s6-financial-certification`, `a3m6-billing-consumer-refusals`, `stage4-real-broker`, `stage4-real-broker-consumer-recovery`, `stage4-real-broker-dlq-replay`, `stage4-real-broker-reconciliation`, `stage12-7-real-broker-subscription`, `stage16-5-auth-notification`, `stage21c2-auth-outbox-durability`, `stage21c3-certification` | 15 files, 47 tests passed |
| Stage 10.1 Auth/Organization wire contract (`test/e2e-auth-organization`) | `stage10-1-auth-organization-wire-contract`, `stage21c2-ownership-export-import` | 2 files, 9 tests passed |
| Core shared platform integration (`test/e2e-audit-producers`) | `shared-platform`, `closure`, `auth`, `billing`, `payment`, `file`, `organization`, `release`, `release-owner`, `owner-audit-x` | 10 files, 26 tests passed |
| Per-service unit, e2e and SQL invariant suites; images; least-privilege roles; repository checks | every service and library | passed |

**Not run by CI (freshness limit):** the five real-broker deployment suites of `npm run test:deploy:real-broker`
(`scripts/deploy-tests/real-broker.mjs`, `real-broker-topic-grants.mjs`, `real-broker-notification-topology.mjs`,
`real-broker-topology-containment.mjs`, `real-broker-consumers.mjs`), the last of which drives the S1e-5 integrated provenance
certification (`test/e2e-real-broker/certification/s1e5-integrated-provenance.cert-spec.ts`). They run only on demand
([runbook](../runbooks/real-broker-certification.md); workflow `real-broker-certification.yml`, dispatch only). Their last recorded run is
at `18b0089` (2026-10-30); Auth (#419) and Billing (#424, #426) changed since. **They are not fresh at `085a750`.**

**Correction to the earlier readiness analysis (conversation, 2026-11-01):** it described the cross-process suites as running on demand.
Only the five deployment suites above do; the 27 suites of the table run in every CI run.

**Coverage limits of the fresh evidence**, from the suites' own scenarios: `s6b-refund-processing` refunds an attempt under a real-Auth
receipt but does not complete the refund case and reverse the purchase across processes; no cross-process suite covers recovery and
surplus, the L-4 late-settlement application, the assisted final-lost chargeback with its recovery obligation, the BIL-12 member read,
forgery and replay of the `refund.*` and dispute-loss families, Auth outages beyond checkout, the production-configuration boot refusal,
or the S0-C7 pre-lifecycle invariant across Organization Service, Auth and Billing. Those are Phase 2 (§7).

## 3. S1 to S6: eligibility under D-3

D-3: a stage qualifies when its record is merged, every certification-gate criterion is PASS at development level (L or I), and every
remaining condition is (a) a production or operational gate, (b) a Lab-only verification, (c) an approved deferral, S0-C clarification,
Owner-recorded disposition or roadmap disposition, or (d) an open decision whose implemented behaviour is fail-closed and tested.

| Stage | Record and verdict | Gate criteria (development) | Remaining conditions (category) | OPEN / BLOCKED | Eligible |
|---|---|---|---|---|---|
| **S1** event security | [S1](./core-v2-s1-event-security.md), CONDITIONAL PASS (development) | all PASS | S1-R, C-4, AP-R, NP-K, G-7, R4, OD-BRK-2b-2 to OD-BRK-5 (a); R2b (c, D-5); R3 (c, S0-C4); OD-15 for other producers (d) | OD-BRK-2b-L real-systemd half **BLOCKED — HARDWARE MAINTENANCE** (Lab 01): **(b)** by the Owner's disposition 1 (§4) | **Yes** |
| **S2** independent foundations | [S2](./core-v2-s2-independent-foundations.md), CONDITIONAL PASS (development) | all PASS | R-6a (c, D-2); Q8 (d); Q9 and the production items (a / c) | Audit Organization-reference scope rows **BLOCKED until F7**: **(c)** D-4, confirmed by disposition 2 | **Yes** |
| **S3** Billing | [S3](./core-v2-s3-billing.md), CONDITIONAL PASS (development, simulation) | all PASS, including the joint checkpoint (#410) and BIL-12 (#424) | OD-05, DG-4, OD-BRK-3, BIL-12 production mounting (a); invoice legal content (c / a); EVT-05 (d) | none (F-INV-1 resolved, §6) | **Yes** |
| **S4** Payment | [S4](./core-v2-s4-payment.md), CONDITIONAL PASS (development, simulation) | all PASS | Organization-payer grant inactive (d); real adapters, production MOVE V3, R2b (c) | none | **Yes** |
| **S5** assistance and cash obligations | [S5](./core-v2-s5-assistance-and-cash-obligations.md) §7, CONDITIONAL PASS (development, simulation, pre-lifecycle, S0-C7) | S5a to S5d PASS; pre-lifecycle invariant T-A1 to T-A4 (#411, #412, #414, #415) | the S0 §8 inactive-scope criterion, V-4, S5e, D6, V5-2, OD-R6a, the H-2 / J-1 / J-2 limits (c) | none: eligibility is **pre-lifecycle only** (disposition 3) | **Yes** |
| **S6** refunds, disputes, recovery, losses | [S6](./core-v2-s6-financial-certification.md), CONDITIONAL PASS (simulation) | all PASS | Q8, partial chargebacks, EVT-06 (d); BIL-35, real provider, production (c / a); the real-broker deployment suites on demand (a) | none | **Yes** |

**Result: S1 to S6 are each eligible for S-INT authorization under D-3.** No verdict is promoted by this record. The full classification
of every condition is the [condition matrix](./core-v2-stage-condition-matrix.md) §2.

## 4. Owner dispositions applied (2026-11-01)

1. **S1:** the real-systemd half of OD-BRK-2b-L is a Lab-only operational verification, not an S1 development certification gate. The
   hardware block remains; it is never reported as passed.
2. **S2:** Audit Organization-reference scope rows follow D-4 and depend on F7 authority activation.
3. **S5:** eligibility is pre-lifecycle only, under S0-C7. V-4, S5e, D6 and the original S0 §8 inactive-scope test stay mandatory for
   the first lifecycle-enabled release.
4. **S7 and S8:** outside the scope of this S-INT (§5).
5. **Proposed ADRs:** S-INT may test implemented behaviour governed by Proposed ADRs without accepting them or changing their status
   (§9).

## 5. Scope: S1 to S6; S7 and S8 excluded

By the Owner's S7/S8 scope decision of 2026-11-01 (#427): S7 is excluded from Core V2 (C-3 commercial IN_APP carried to the
[V3 roadmap](../CORE-V3-ROADMAP.md); C-6 open, deferred with the lifecycle work; DG-3 unchanged and independent); S8 is excluded from this
S-INT (C-5 and human hierarchy reads deferred with their F6/F7 dependencies). Their requirements stay in their sources and in the V3
roadmap rows; [execution roadmap](./core-v2-s-execution-roadmap.md) §4.7, §4.8, §5; [contract register](./core-v2-d-a2-contract-register.md)
NOT-01, AUTH-09, ORG-00. **The final Core V2 S-INT covers S1 to S6.**

## 6. Findings

- **F-INV-1** (the invoice list skipped invoices sharing a millisecond across a page boundary): **RESOLVED** by #426 (`e3b8133`), an
  exact-microsecond cursor; test evidence `apps/billing-service/test/invoice-list-pagination.e2e-spec.ts` and
  `src/common/pagination.spec.ts`. The [S3 record](./core-v2-s3-billing.md) §3 and the [condition matrix](./core-v2-stage-condition-matrix.md)
  §3.1 record it resolved.
- **Test defects found by `main` at `841a837`** (BIL-12 read-only fingerprint; File ticket settlement wait): fixed by #428 and #429, test
  only. No product defect.

## 7. Execution plan (for a later, separate authorization)

### 7.1 Protocol and environment

- **One pinned SHA.** Every Phase 1 and Phase 2 run is at the same commit, recorded with each result; a change to the code under test
  restarts the run at a new pinned SHA. The candidate is `085a750` or a later green `main` named in the execution authorization.
- **Fresh build.** A new worktree at that SHA; `npm ci`; `libs/service-kit` and `libs/audit-contract` built before dependent tests (a
  stale `dist/` is never evidence); each service built.
- **Disposable infrastructure only.** Local containers created for the run and removed afterwards by a separately authorized step:
  PostgreSQL 16 (`postgres:16-alpine`) and RabbitMQ 3.13 with management (`rabbitmq:3.13-management-alpine`), the versions CI uses; broker
  identities and topic grants from the repository's generators. Node 22.
- **Simulation only.** The test and simulation payment providers; no real provider, no production credential, no deployed broker, no
  Lab 01, no production access. Tokens and receipts are generated for the run.
- **No workflow dispatch** unless the execution authorization names it (the on-demand certification workflow included).
- **Failures are investigated, not rerun into green.** A failure is reported with its root cause before any change.
- **Record.** Results go to the S-INT certification record (`core-v2-s-int-certification.md`), with the SHA, the environment, every
  suite's result and every limitation; it is merged only by the Owner.

### 7.2 Phase 1: regression of the existing cross-process evidence at the pinned SHA

| Suite set | Command |
|---|---|
| the 15 real-broker e2e suites | `npm run test:e2e -w @nawara/e2e-real-broker` |
| the 2 Auth/Organization wire-contract suites | `npm run test:e2e -w @nawara/e2e-auth-organization` |
| the 10 shared-platform producer suites | `npm run test:e2e:audit-producers` |
| the 5 real-broker deployment suites, including the S1e-5 integrated provenance certification | `npm run test:deploy:real-broker` (locally, on the disposable infrastructure) |
| every per-service unit, e2e and SQL invariant suite, and `npm run check:repo` | as CI |

### 7.3 Phase 2: new cross-service scenarios G1 to G8

All over real HTTP between the built services, a real RabbitMQ and real PostgreSQL, on simulation.

| Id | Scenario | Proves |
|---|---|---|
| G1 | Direct purchase, then the member's own BIL-12 read | checkout → attempt → verified fact → `payment.succeeded` → purchase; BIL-12 equals B6 for the member at one instant; no access decision depends on BIL-12 |
| G2 | Completed direct refund | an Owner receipt from the real Auth → Payment refund → `refund.case_completed` over the broker → reversal; B6 and BIL-12 become invalid; exactly once under redelivery |
| G3 | Assisted final-lost chargeback, recovery and surplus | the assisted purchase keeps its entitlement (B10); the recovery obligation and T3; a recovery settlement through Payment; recovered at the base amount; a surplus case recorded and resolved as frozen (B8) |
| G4 | Late assisted settlement | EVT-10 late success recorded once; the L-4 application with an Owner receipt creates the one purchase; contradictions refused. **Real-event criteria (S0-C8 item 11, 2026-11-01):** driven only by Payment's signed provider notifications. (1) A capture after the payment expired gives one late success, one late settlement (`lateSuccessId`, `settledAt` = Payment's `recordedAt`) and one `late_assisted_settlement` case; no purchase; Payment, request and channel stay final. (2) An attested L-4 application before `settleBy` gives one purchase, the invoice `paid` and the request `settled`, with no obligation. (3) After `settleBy` (only by a labelled clock shift once the channel is closed; never an inserted obligation), the real sweep opens the obligation and the application supersedes it. (4) L-3: the capture-specific refund completes the case, and L-4 is then refused `refund_exists`. (5) Refusals: `purchase_exists`, `cash_return_confirmed`, `evidence_contradictory`, `chargeback_recorded`, `already_applied`. (6) Duplicate event plus read, and out-of-order delivery: one record, one effect, classification only after finality; a second capture of the invoice is refund-only. (7) A forged late success records nothing. (8) After application, a refund reverses the purchase once and opens a `refund_completion` obligation |
| G5 | Event forgery, replay and duplicates per financial family | `payment.*`, `refund.*`, dispute losses and late successes: forged `user_id`, the default exchange, a tampered body and a replay without a stored row are refused before any state change; verified duplicates apply once |
| G6 | Auth outage on every human-authority path | checkout, BIL-12, assistance, Owner receipts and refund cases answer `503` (or their documented fail-closed code) and write nothing; recovery after Auth returns |
| G7 | Production-configuration refusal of simulation | each built service started with `NODE_ENV=production` and a simulation provider or harness refuses to start (FC-10); with a valid production configuration the simulation-only modules (checkout, BIL-12, assistance, refunds, recovery, late settlements, reconciliation) are not mounted |
| G8 | S0-C7 pre-lifecycle invariant across processes | Organization Service's reference read carries exactly the three anchors; Auth and Billing behave identically for a reference carrying a non-contract lifecycle field; no path produces or acts on an inactive scope |

**Out of S-INT:** the inactive-scope full path (first lifecycle-enabled release, S0-C7 items 2 and 3); S7 and S8 (§5); PR #319's
proposed behaviour (§8); every production path.

## 8. Gates and constraints preserved

- **PR #319** (organization-service idempotent creation replay): classified **RED** under A5.4-G1 (the change alters the ADR-0062
  first-Platform route, `POST /organization/admin/platforms`, and the Organization creation route, a "hierarchy provisioning change", A5
  record §9.1). **No RED exception is approved; it is not rebased, merged, closed or replaced; Owner step-up semantics are unchanged; its
  proposed runtime behaviour is not part of the S-INT baseline.** Any later step is a separate Owner decision.
- **Production and operational:** S1-R, C-4, AP-R, NP-K, G-7; OD-BRK-2b-2 to OD-BRK-5; Q9; M1 to M13 (G6, G7, F6, F7 and the post-F7 backup;
  the Auth, Organization, Audit and File production deployments); DG-2, DG-3, DG-4, DG-7; OD-05 catalog values; invoice legal content
  (B-001, B-006, B-007, B-028); Billing's production activation (BIL-12 and every simulation-only module stay unmounted in production).
- **Real providers:** none exists; real-provider integration stays deferred (S0 §5); Payment and Release production enablement stay
  MOVE V3.
- **Lifecycle:** the lifecycle runtime stays MOVE V3; V-4, S5e, D6, V5-2 and the S0 §8 inactive-scope criterion stay with the first
  lifecycle-enabled release (S0-C7).
- **R-6a (OD-R6a):** required Core V2 work before the earlier of F6/F7 and the first lifecycle-enabled release (D-2). S-INT does not
  waive it.
- **Lab 01:** off for hardware maintenance; the OD-BRK-2b-L real-systemd half stays BLOCKED and is never reported as passed.
- **Final Core Validation** stays the absolute last validation and is never part of S-INT.

## 9. Proposed ADRs exercised, not accepted

S-INT exercises implemented behaviour governed by **ADR-0044 Part B** (subscription and entitlement final model) and **ADR-0045**
(commercial entitlement-kind compatibility fields), both **Proposed**, and relies on the D-4 disposition recorded through **ADR-0069**
(Proposed). Exercising them in S-INT does not accept them or change their status (G-1; the Owner's disposition 5); every ADR status change
stays a separate, explicit approval, one ADR at a time.

## 10. Approval

This record is approved only by the Owner's merge. After that merge, S-INT execution (§7) still needs its own Owner authorization,
naming the pinned SHA and any workflow it allows. Until then nothing in §7 is run.

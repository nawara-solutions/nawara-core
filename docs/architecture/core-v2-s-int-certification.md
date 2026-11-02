# Core V2 S-INT: certification record

| | |
|---|---|
| Status | **PROPOSED, for the Owner's review.** It takes effect only by the Owner's merge. Documentation only |
| **Proposed verdict** | **CONDITIONAL PASS (development and simulation, S1 to S6, pre-lifecycle).** §9 |
| Pinned baseline | `main` at `3e73097aefee9feb59ae01294c3648fa8a295192` (the #446 merge), tree `2d2c23781426272560b3d5fae5d0107a36f976cd` |
| CI at the pin | `main` push run `41483154672` (Core CI): **24 of 24 jobs succeeded** |
| Local run | 2026-11-02, 16:54:19Z to 18:17:26Z: Phase 1 **33 of 33 steps**; Phase 2 **21 files, 86 of 86 tests**. No failure, retry or abort |
| Rules applied | [Readiness record](./core-v2-s-int-readiness.md) §7; [execution roadmap](./core-v2-s-execution-roadmap.md) §5 |
| Scope | S1 to S6. S7 and S8 are outside this S-INT, with their V3 carry-over (§10) |

**What this record is not.** It is not production readiness, a production certification, a stage verdict promotion, an ADR acceptance or
Final Core Validation. Nothing here was run against production, a real payment provider or Lab 01. It changes no code. It authorizes no
deployment or activation.

## 1. Baseline

`main` at the pin contains every record and correction this certification relies on:

| PR | Content | Merge |
|---|---|---|
| #430 | S-INT readiness record | `8f74d04` |
| #431 | First G1 to G8 harness | `480f948` |
| #433, #434, #435, #436 | S0-C8: reachable L-4 record, Billing classification and application, real-event G4 | `532b732`, `fc1487c`, `fa51dd3`, `4df4bfc` |
| #437 | S0-C9 contracts | `5913678` |
| #439 | Billing capture-bound dispute handling | `ee8ede4` |
| #442 | Payment late-capture dispute attribution | `1ffcf7d` |
| #443 | Real-event S0-C9 scenarios | `e6892e8` |
| #444, #445, #446 | Evidence completeness and the last §7.3 clauses (test only) | `4174bdc`, `768724c`, `3e73097` |
| #440, #441 | Test-only corrections: a date-dependent invariant and an S6b race | `7b56e11`, `dd5f87d` |

The source tree was verified clean at the pinned SHA at the start and the end of the run, with the same tree hash.

## 2. Environment and protocol

- Fresh detached worktree at the pin; fresh `npm ci`; every library and service built before any test.
- Node v22.18.0 (the repository's required runtime), npm 10.9.3, PostgreSQL 16.15, RabbitMQ 3.13.7.
- **New** disposable containers, verified empty before the run. Older containers held leftover databases, queues and messages, so they
  were not reused.
- Sequential execution. A memory watchdog sampled every 10 seconds and would have aborted below 400 MB available; the minimum was 2,524 MB.
- Simulation only: no real provider, production credential, deployed broker, workflow dispatch or Lab 01.
- Evidence (kept outside the public repository): `~/nawara-evidence/s-int-final-2026-11-02-3e73097/`: `MANIFEST.txt`, every log, per-test
  results (`phase2-real-broker.json`, `phase2-per-test.tsv`), `memory.log`, the runners and `SHA256SUMS` (48 files; its own SHA-256 begins `63eb9a14feb49247`).

**Earlier runs are not the evidence for this verdict.** Runs at `8f74d04`, `8c50c6b`, `e6892e8` (interrupted by low host memory during the
deployment suites, so it has no result for them or for Phase 2) and `4174bdc` (complete and green, then superseded by #446) are history only.

## 3. Phase 1: results at the pin

Every step exited 0.

| Step | Result |
|---|---|
| `check:repo` | passed |
| `test:repo` | 190 of 190 |
| `test:deploy` | 674 of 674 |
| service-kit: unit, integration | 721 passed and 2 skipped (723); 197 of 197 |
| audit-contract: unit, integration | 2,316 of 2,316; 10 of 10 |
| auth-service: unit, e2e, SQL invariants | 377; 693; 283 passed, 0 failed |
| payment-service: unit, e2e, SQL invariants | 164; 381; 333 passed, 0 failed |
| billing-service: unit, e2e, SQL invariants | 482; 836; 536 passed, 0 failed |
| organization-service: unit, e2e, SQL invariants | 155; 271; 56 of 56 |
| notification-service: unit, e2e | 339; 382 |
| file-service: unit, e2e | 284; 397 passed and 5 skipped (402) |
| audit-service: unit, e2e | 387; 652 |
| release-service: unit, e2e | 94; 239 |
| Real-broker suites | 21 files, 86 of 86 |
| Auth/Organization wire-contract suites | 2 files, 9 of 9 |
| Shared-platform producer suites | 10 files, 26 of 26 |
| **The five on-demand deployment real-broker suites**, including the S1e-5 integrated certification | **61 of 61** |

**Skips.** The 2 service-kit skips are a deliberate helper probe and appear in CI too. The 5 file-service skips need S3 credentials that the
local run did not provide; CI runs those suites against MinIO at this SHA, where file-service e2e passed 432 of 432.

**CI at the same SHA, for the cross-process jobs:** real-broker 21 files, 86 of 86; wire contract 2 files, 9 of 9; shared platform 10 files, 26
of 26. CI does not run the five deployment suites: the local run above is their only evidence at this SHA.

## 4. Phase 2: G1 to G8

A second full real-broker run, with per-test results: 21 files, 86 of 86, none skipped. Each row names the suite under
`test/e2e-real-broker/` that proves it across real, separately spawned, built processes.

| Criterion (readiness §7.3) | Proven by |
|---|---|
| **G1** direct purchase, then BIL-12 | `s3s4-joint-checkpoint`: checkout to purchase; BIL-12 equals B6 |
| **G2** completed direct refund | `s6b-refund-processing`: real receipt, refund, event, reversal, B6 and BIL-12 invalid; **the exact message redelivered: one effect, one reversal** (#446) |
| **G3** assisted loss, recovery, surplus | `s-int-assisted-loss-recovery` (B10, base-only obligation, T3, recovery, surplus recorded); `s-int-evidence-completeness` (the surplus refunded under a real receipt and **resolved once**) |
| **G4** (1) capture after expiry | `s-int-evidence-completeness`: Payment's real sweeper, one late settlement and case, nothing sold, all final |
| **G4** (2) L-4 before `settleBy` | `s-int-assisted-loss-recovery` |
| **G4** (3) L-4 after `settleBy` | `s-int-assisted-loss-recovery`: labelled clock shift, real sweep, the obligation superseded |
| **G4** (4) L-3, then L-4 refused | `s-int-evidence-completeness`: capture-specific refund completes, `refund_completed`, `refund_exists`, receipt unspent |
| **G4** (5) refusals | `s-int-evidence-completeness`: `evidence_contradictory`, `cash_return_reported`, `cash_return_confirmed`, `purchase_exists`, `already_applied`. `s-int-late-capture-disputes`: `chargeback_recorded` |
| **G4** (6) duplicates and order | `s-int-evidence-completeness`: event plus read, one record; a really lost event recovered from the read; out-of-order deferral, then one classification; **a second capture is refund-only** (#446) |
| **G4** (7) forged late success | `s-int-assisted-loss-recovery`, dead-lettered, nothing recorded |
| **G4** (8) refund after L-4 | `s-int-evidence-completeness`: one reversal, `refund_completion` obligation, T2 for that Organization only |
| **G4** S0-C9 item 10 (1) to (5), (8) | `s-int-late-capture-disputes`: dispute before L-4, loss after L-4, `chargeback_returned`, partial chargeback, out-of-order attribution or conflict, Payment's final state unchanged |
| **G5** per financial family | `s-int-evidence-completeness`, for `payment.succeeded`, `payment.failed`, `refund.case_completed`, `payment.dispute.lost`, `payment.late_success.recorded`: **forged `user_id`** refused by the broker (#446), default exchange with no stored row, tampered body, verified contradiction, verified duplicate; all with an unchanged state fingerprint |
| **G5** forged identity | `s3s4-joint-checkpoint`, `s6b-refund-processing`, `s-int-assisted-loss-recovery`, `s-int-late-capture-disputes`, `a3m6-billing-consumer-refusals` |
| **G5** S0-C9 item 10 (6), (7) | `s-int-late-capture-disputes`: forged, duplicate and replayed dispute notifications and events; capture, amount and currency mismatches |
| **G6** Auth outage | `s3s4-joint-checkpoint`, `s6b-refund-processing`, `s-int-assisted-loss-recovery`, `s-int-evidence-completeness`: checkout, BIL-12, assistance, refund case, recovery read, L-4 and Payment's attempt answer 503 and write nothing; **after a real Auth restart the same actors and the same unspent receipt complete the operations** |
| **G7** production refuses simulation | `s-int-production-refusal`: Billing and Payment refuse to start; simulation-only modules answer 404 |
| **G8** pre-lifecycle invariant | `s-int-pre-lifecycle-real-auth`, real Organization Service and real Auth: identical behaviour for an Organization whose answers carry a non-contract field. `s-int-organization-reference`: the real reference read, three anchors |
| Roadmap §5: assisted failure and cash return | `s5b-assisted-settlement` |

## 5. Security, authorization, isolation and fail-closed evidence

- **Provider authenticity:** forged signatures are refused and store nothing; duplicate and replayed notifications give no second effect.
- **Broker provenance:** Billing accepts a financial event only under the broker-verified `payment-service` identity. Refusals happen before
  any handler runs, with a closed reason (`untrusted_unverified_original`, `untrusted_replay_no_provenance`, `untrusted_replay_mismatch`,
  `untrusted_verified_conflict`).
- **Human authority:** every actor's bearer is verified live by the real Auth. The Owner acts with a real TOTP step-up and a real receipt,
  bound to one operation. A receipt for another application is refused and stays unspent; a member and a missing token are refused (the operator case is per-service).
- **Financial isolation:** a chargeback is bound to one capture and never moves to another capture of the payment. One captured movement has
  at most one return. Payment's final state never reopens. T2 and T3 restrict only the Organization concerned.
- **Fail closed:** Auth down, an unverifiable dispute exposure, and a held or conflicting dispute notification all answer 503 or a refusal and
  write nothing. Receipts are not spent by a refusal.
- **Production refusal:** Billing and Payment refuse to start with simulation configured.

## 6. Findings resolved

- **F-SINT-1 (L-4 unreachable from real events): RESOLVED.** Owner decision S0-C8, implemented by #434 and #435. G4 no longer uses a fixture:
  three failed attempts really end the payment, a signed late success drives the application.
- **F-SINT-2 (a dispute of a late capture could not be attributed): RESOLVED.** Owner decision S0-C9, implemented by #439 and #442, proven by #443
  with capture-specific attribution, EVT-03 `captureFactId` and `captureBasis`, and the exposure read.
- **Evidence gaps found by audit: CLOSED.** Option A (the Owner, 2026-11-02) rejected per-service substitutes for §7.3. #444 and #446 added the
  cross-process tests, and a further audit before this verdict found the three clauses #446 closes.
- **Test defects, no product defect:** a date-dependent invariant (#440); an S6b race (#441); a dispute-loss race that asserted one of two valid
  verified paths (#445). None weakened a financial assertion.

**Product defects found by the final run: none.**

## 7. Shortcuts: what was not observed in real time

Each is labelled in its test. **A passing shortcut proves the behaviour after that state is reached. It does not prove the elapsed timing.**

| Shortcut | What really ran | Not observed |
|---|---|---|
| A 73-hour clock shift on an assistance request (triggers bypassed in that one session) | Billing's real sweep, real obligations, real refusals | A real 72-hour wait; clock skew |
| A payment's `expiresAt` moved into the past | Payment's real sweeper and its events | A real expiry window |
| The webhook retry counter set to 9 of 10 | The provider's signed redelivery, the terminal `capture_unverified` conflict | The roughly 85-minute real backoff to the bound. The real retrier was observed attributing a held notification only within tens of seconds |
| `ACCESS_TOKEN_TTL_SEC` at its maximum | Real login and verification | Token expiry during a long operation |
| Delivery control: Billing stopped, messages removed or re-sent in reverse, with exact bytes under Payment's real identity | Real consumers, real read recovery | A real network partition or a broker failure in production topology |
| An Auth restart on one host | A real process stop and start with its database | A multi-instance outage or a failover |

## 8. Fixtures and stand-ins

- **Seeded by SQL (setup, not behaviour under test):** Auth's Company, Owner, users and memberships (plus Platform and Organizations, except in
  `s-int-pre-lifecycle-real-auth`); Billing's Platform configuration and catalog.
- **Organization reference read:** a stand-in in most suites. The real service answers only in `s-int-organization-reference` and
  `s-int-pre-lifecycle-real-auth`.
- **Auth stand-in:** `s-int-organization-reference`, `s4e-organization-payer`, `s4f-simulation-settlement`, `s5b-assisted-settlement` and
  `stage12-7-real-broker-subscription` use one, and prove nothing about Auth. The cash-return path also runs with the real Auth in `s-int-evidence-completeness`.
- **Test activation:** Organization Service's activation and Auth's `hierarchy-retire` ran only on disposable databases. **This is not F6 or F7.**
- **The non-contract field relay:** no Core V2 service produces a lifecycle field, so a test relay adds it. G8 shows how consumers treat an unexpected
  field. It does **not** exercise an inactive scope.
- **Simulation provider only:** no real provider's behaviour, statement format, timing or dispute process is proven.

**Corrections to earlier statements.** The headers of the earlier S-INT suites called the reference read the only fixture; they now state the
SQL seeding. The local evidence attached to #443 was run on Node 24, not the required Node 22; every result in this record is Node 22.

## 9. Proposed verdict: CONDITIONAL PASS

**Basis.** Every §7.3 criterion, and the roadmap §5 paths in scope, has cross-process evidence at one pinned SHA (§3, §4), with no failed test and
no open development-level finding. S1 to S6 entered under D-3 (readiness record §3). The conditions below are not development-level
criteria; they stay in force.

**Why not PASS.** S-INT certifies development and simulation only. Everything in §10 stays open, and the limits of §7, §8 and §11 stand.

**This verdict does not promote any S1 to S6 stage verdict, and it does not claim production readiness.**

## 10. Conditions and exclusions preserved

- **Scope:** S7 and S8 stay outside this S-INT, with their V3 carry-over.
- **PR #319 stays RED.** No exception; not part of this baseline.
- **Proposed ADRs stay Proposed:** ADR-0044 Part B, ADR-0045 and ADR-0069. They were exercised, not accepted.
- **R-6a (OD-R6a)** stays due before the earlier of F6/F7 and the first lifecycle-enabled release.
- **Authority:** F6 and F7 are not activated. Organization Service is not authoritative outside disposable tests. Audit Organization-reference
  scope rows stay blocked until F7.
- **Lifecycle:** the runtime stays MOVE V3. V-4, S5e, D6, V5-2 and the S0 §8 inactive-scope criterion stay with the first lifecycle-enabled release.
- **Real providers:** none exists. Integration stays deferred. Payment and Release production enablement stay MOVE V3.
- **Lab 01:** off for hardware maintenance. The OD-BRK-2b-L real-systemd half stays **BLOCKED** and is not reported as passed.
- **Production and operational gates:** S1-R, C-4, AP-R, NP-K, G-7; OD-BRK-2b-2 to OD-BRK-5; Q9; M1 to M13; DG-2, DG-3, DG-4, DG-7; OD-05
  catalog values; invoice legal content (B-001, B-006, B-007, B-028); Billing's production activation. The full classification is the
  [condition matrix](./core-v2-stage-condition-matrix.md), unchanged.
- **The five deployment suites** stay on demand, outside CI.
- **Final Core Validation (Stage 22)** stays the absolute last validation.

## 11. Remaining limitations

Not defects under the approved contracts; each is a known limit for the later audit and production work.

1. **Dispute exposure visibility** ([register](./core-v2-d-a2-contract-register.md) PAY-09 H): a notification naming no attempt, not yet matched to an attempt, or
   unreadable (`malformed_dispute`) does not appear in a payment's exposure.
2. **The retry bound counts processings, not time:** provider redeliveries use it up, so a burst can reach the terminal conflict before 85 minutes.
3. **A terminal conflict has no implemented clearing path:** the exposure stays `unresolved`, which fails closed but needs the explicit
   reconciliation S0-C9 item 8 names.
4. **Exposure is per payment:** a chargeback of one capture also refuses L-4 for another capture of that payment.
5. **G5 attacks ran on five event families.** `payment.expired`, `payment.cancelled` and `payment.dispute.opened` pass through the same consumer
   trust decision but were not individually attacked.
6. **Per-service evidence remains, by scope, for:** G3 surplus Path B (needs File); G4 capture after `cancelled`.
7. **G6:** Owner receipt issuance is at Auth itself, so its outage case is simply unreachable; consumption while Auth is down is what was tested.
8. **Host limits:** one host, 11 GB of memory, sequential. No load, soak or capacity result exists.

## 12. Next

By the Owner's direction, the next milestone is the complete Logic and Architecture Audit, before any production-readiness work. This record starts
nothing by itself.

## 13. Approval

This record is approved only by the Owner's merge.

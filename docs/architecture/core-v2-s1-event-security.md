# Core V2 S1: event security — stage record

| | |
|---|---|
| Stage | S1 event security, MANDATORY ([execution roadmap](./core-v2-s-execution-roadmap.md) §4.1; [S0 freeze](./core-v2-s0-architecture-freeze.md); [ADR-0057](../adr/0057-messaging-conventions.md) §8, §13; [ADR-0069](../adr/0069-verified-audit-producers-and-audit-contract-v2.md)) |
| Record created | 2026-10-30, Phase 4 of the Owner's post-S6 plan ("STAGE CERTIFICATION RECORDS — DOCUMENTATION AND EVIDENCE ONLY"), on `main` at `18b0089` |
| Why now | Roadmap §2.2 (5) asks for a stage record created at authorization; none was. This record assembles the evidence of the merged work packages; it adds no new test and changes no behaviour |
| **Verdict** | **CONDITIONAL PASS — development (repository, CI, local and disposable real-broker evidence).** The S1 code certification gate is met by evidence (§2). **Operational acceptance is NOT STARTED:** S1-R, the production rollout, has not begun, and its gates C-4, AP-R, NP-K and G-7 are OPEN. S1c-3 R2b and R4, OD-BRK-2b-2 and OD-BRK-3 to OD-BRK-5 are OPEN; the real-systemd half of OD-BRK-2b-L is **BLOCKED — HARDWARE MAINTENANCE** (§4). Nothing here is production evidence or an ADR acceptance (ADR-0057 and ADR-0069 stay Proposed) |

Evidence levels: **L** per-service and library tests on real PostgreSQL / RabbitMQ in `core-ci-passed`; **I** cross-process or
disposable-broker suites (`test/e2e-real-broker` in CI; `npm run test:deploy:real-broker` on demand, locally and through the manual
[`real-broker-certification.yml`](../runbooks/real-broker-certification.md) workflow); **O** an operational environment (none).

## 1. Work packages and their merges

| Id | Content | PR (merge) | State |
|---|---|---|---|
| S0 / roadmap / contracts | frozen architecture, execution roadmap, D-A2 receipt contract and register | #320 (`b33b6e4`), #321 (`42f3f8b`), #322 (`22492b6`) | merged (documentation) |
| S1a | publisher sets AMQP `user_id` from its own connection | #323 (`856d0b7`) | merged |
| S1b | observe-only provenance: Billing ← Payment | #324 (`105f5f6`) | merged |
| S1b-2 | Audit provenance behind admission (S0-C1) | #325 (`ecd5b3b`), #326 (`5b0f42d`) | merged |
| S1b-3 | Notification keyed `bodyMac` provenance (S0-C2) | #327 (`a8b0321`), #328 (`ab6e9d6`) | merged |
| S1c-1 | observe-only replay classification (S0-C3) | #329 (`b393ff0`), #330 (`86b07d2`) | merged |
| S1c-3 R1, R2a | restricted re-emission foundation; Payment's inert eligibility dry run (S0-C4) | #331 (`de8323d`), #332 (`1c7fd83`), #333 (`8bd8a32`) | merged; **R2b, R4 OPEN; R3 DEFERRED** |
| S1d-0 to S1d-3 | generated, exact topic grants; provisioning code; disposable real-broker certification (S0-C5) | #334 (`d34ec1e`), #335 (`01a6e33`), #336 (`5c5d63e`), #337 (`efb1028`) | merged; production grants **not** narrowed |
| S1e-0 to S1e-4 | trust decisions and per-consumer enforcement: Billing verified-only, Audit compatibility / strict, Notification verified-only (S0-C6) | #338 (`375de58`), #339 (`56c9b0c`), #340 (`dd07f2a`), #341 (`b91b7bf`), #342 (`c1e5ad9`) | merged; nothing enabled in production |
| OD-BRK-0, 1, 2a | dead-letter privacy decisions D1–D3; kit topology with no broker dead-lettering; Notification behind a verified topology gate | #343 (`eaa8e93`), #344 (`750eb21`), #345 (`f772376`) | merged |
| OD-BRK-2b-1, R, I, A, W | scheduled topology monitor and containment; signed recovery; transactional installation; alert carrier; watchdog hardening | #346 (`cc04e69`), #347 (`ae6f9c9`), #348 (`304064f`), #349 (`b776c4b`), #350 (`682a958`) | merged; **implemented, not installed** (OD-BRK-2b-2) |
| S1e-5 | integrated real-broker and PostgreSQL certification | #406 (`32e3450`); [report](./core-v2-s1e5-integrated-certification.md) | **CERTIFIED for local evidence** |
| Phase 3 | the five real-broker deploy suites runnable on demand in GitHub Actions | #408 (`18b0089`) | merged; first run in §3 |

## 2. Certification gate (roadmap §4.1) and the validation protocol (§2.2)

| Criterion | Level | Evidence | Status |
|---|---|---|---|
| Broker `user_id` enforcement proven; a forged or mismatched `user_id` refused | L, I | `libs/service-kit/test/rabbitmq-publisher-identity.int-spec.ts` (CI, real RabbitMQ); S1e-5 "Auth publishing a Payment event is refused by the broker (403)" | PASS |
| Wrong exchange and injection through the default exchange refused | I | S1e-5 §2: default-exchange forgeries `replay_no_provenance`, no `user_id` `unverified_original`, refused before any receipt or state change; one injector reaches every work queue and no strict consumer processes it | PASS |
| Tampered body, name or source refused (permanent `provenance_conflict`) | L, I | `rabbitmq-event-provenance.int-spec.ts`, `event-keyed-provenance.spec.ts`; S1e-5 contradictions `verified_conflict`, mismatched body refused | PASS |
| Replay without a stored row refused; verified replay idempotent; tampered `occurredAt` settles at the stored instant | L, I | `event-replay-classification.spec.ts`, `trust-decisions.spec.ts`; S1e-5 Billing, Audit and Notification rows | PASS |
| Retries pass; transient failures held, never dead-lettered | L, I | `rabbitmq-dlq-retry.int-spec.ts`, `rabbitmq-consumer-recovery.int-spec.ts`; S1e-5 "a provenance-store outage holds the delivery … which then settles once" | PASS |
| `invoice.created` still flows; `payment.*` v1 compatible | L, I | Billing `invoices.e2e-spec.ts`; `libs/service-kit/test/rabbitmq-publisher-identity.int-spec.ts` (`invoice.created` over a real broker under a verified identity); `test/e2e-real-broker/s4f-simulation-settlement.e2e-spec.ts` (`payment.*` → Billing) | PASS |
| Fault injection between provenance and handler, and after the handler before acknowledgement | I | S1e-5: a real broker redelivery after the process is killed mid-handler is applied once; a provenance-store outage holds and requeues | PASS |
| No historical event labelled verified; provenance never backfilled | L, I | S1e-5 Audit strict: "nothing historical promoted"; `check:repo` event-provenance opt-in guard | PASS |
| Generated topic grants equal the catalogs; no `.*`, no bare `audit\.` | L, I | `check:repo` generated-grant checks; `real-broker-topic-grants.mjs` (S1d-3; S6 §5.2 correction) | PASS |
| Notification dead letters never hold a plaintext code (OD-BRK-0 items 1, 2, 4, 5, 10) | I | S1e-5 §2 (the former certification failure, resolved by OD-BRK-1/2a) | PASS |
| Notification containment (OD-BRK-2b), real-broker half | I | `real-broker-topology-containment.mjs` (local 14/14 at OD-BRK-2b-L L0; in every `test:deploy:real-broker` run) | PASS |
| Notification containment (OD-BRK-2b), real-systemd half | O-like (lab host) | needs Nawara Lab 01 | **BLOCKED — HARDWARE MAINTENANCE** |
| Protocol: CI `core-ci-passed`, libraries rebuilt before dependent tests | L | every PR above merged with a green `core-ci-passed` (repository ruleset) | PASS |

## 3. Real-broker deploy suites on GitHub Actions (first run)

The first run of [`real-broker-certification.yml`](../runbooks/real-broker-certification.md): run 41115166440 on `main` at `18b0089`,
**SUCCESS**, all five suites, 61 / 61 tests, no disposable container left (integration evidence on a disposable GitHub-hosted runner, not
operational evidence). Full evidence and the run-page summary defect are in the
[S6 report addendum](./core-v2-s6-financial-certification.md#11-addendum-2026-10-30-ci-stability-and-on-demand-real-broker-evidence).

## 4. Open, blocked and deferred

| Item | State | Effect |
|---|---|---|
| **S1-R** production rollout (identity → observe-only → narrowed grants → C-4 → enforcement per consumer) | NOT STARTED; each step its own Owner authorization and a production action | no S1 behaviour is active in production |
| **C-4** historical Auth → Audit dead letters: inventory and disposition | OPEN | blocks S1-R enforcement |
| **AP-R** Audit provenance retention | OPEN | blocks any production deployment of Audit provenance |
| **NP-K** Notification provenance keys | OPEN | blocks any production deployment of Notification provenance |
| **G-7** G6 baseline fingerprints | OPEN | no S-stage Auth / Organization / Audit image in production before M3 or a refresh |
| **S1c-3 R2b** Payment re-emission execution | OPEN (separately authorized) | only the inert dry run (R2a) exists |
| **S1c-3 R3** Auth and Organization re-emission | DEFERRED (G-7 / M3; undecided) | — |
| **S1c-3 R4** production re-emission workflow | OPEN (CI and production authorization) | — |
| **OD-BRK-2b-2** installation of the monitor and containment | OPEN | implemented, not installed |
| **OD-BRK-2b-L** real-systemd half | BLOCKED — HARDWARE MAINTENANCE (Lab 01) | never reported as passed |
| **OD-BRK-3** Billing off the shared dead-letter exchange (before its first deployment) | OPEN | Billing still uses the fanout (development only) |
| **OD-BRK-4** Audit's production queue migration; **OD-BRK-5** fanout retirement | OPEN | the shared fanout stays while anything depends on it |
| **OD-15** for producers other than Payment | OPEN | — |

## 5. Unresolved contract decisions and their impact

- ADR-0057 (§13) and ADR-0069 remain **Proposed** (G-1); this record does not accept them.
- OD-15 is resolved for Payment only (S0-C4); every other producer's re-emission, including recovery of an Audit event refused at
  admission, is undecided.
- Notification history retention and key retirement (NP-K) and Audit provenance retention (AP-R, P-A2) are product / legal decisions
  that gate production, not development.

## 6. Verdict

**S1: CONDITIONAL PASS (development).** Every S1 certification-gate criterion has local and integration evidence except the
real-systemd half of OD-BRK-2b-L (BLOCKED — HARDWARE MAINTENANCE). The conditions are §4: the operational rollout S1-R and its gates,
the remaining re-emission slices and the dead-letter work packages. S1 is **not** operationally accepted.

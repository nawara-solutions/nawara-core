# Core V2 G8: ADR status and trust-model reflection (2026-11-18)

| | |
|---|---|
| Status | **Governance record only.** It reflects decisions the Owner has already approved and facts on `main`. It approves nothing, accepts no ADR and changes no status, code, migration, configuration or behaviour |
| Baseline | `main` at `c4990f7` (PR #519 merged; main Core CI 44286960368, FULL 30/30) |
| Authorization | The Owner's "NEXT BATCH: GOVERNANCE AND FINANCIAL SAFETY PREPARATION", Phase 1 (2026-11-18) |
| Observations | G8 of the 2026-11-16 decision groups: DO-10 (ADR-0035), DO-11 (ADR-0032, ADR-0057, ADR-0067; also F-22), DO-12 (replay enforcement per consumer; P-11) |

An ADR becomes `Accepted` only by the Owner's explicit decision. That a decision is implemented is never, by itself, an acceptance (S0 record §2:
"Statuses are as found in each file"). Every ADR below stays `Proposed`; each received only a dated status note pointing here.

## 1. ADR status

| ADR | Status (unchanged) | Approved so far (by the Owner, recorded) | Implemented on `main` | Open dependencies (preserved) |
|---|---|---|---|---|
| [0032](../adr/0032-database-per-service-on-a-shared-server.md) database per service | Proposed | Nothing beyond the ADR's own text; the S0 freeze did not revise it | One database and one login role per service, per-service migrations and `DATABASE_URL` | **DO-5**: a tested restore. The ADR itself calls backups and a tested restore "an unresolved production blocker for every database"; `production-readiness.md` still records facts checked on 2026-09-19 |
| [0035](../adr/0035-financial-service-boundaries.md) financial boundaries | Proposed | S0 clarifications C1–C4 (2026-10-21), already in the ADR | Billing and Payment as separate services with no back-call; Payment's only Auth call is receipt consumption (C4) | Who computes invoice tax (financial-architecture item 10). `accounting-service` is not built (FUTURE; CLAUDE.md) |
| [0057](../adr/0057-messaging-conventions.md) messaging | Proposed | A3M.1 (OD-A3M-1, writing only), the S0 revision (§13, [S0] items), S0-C1 to S0-C6, OD-BRK-0 (D1–D3), OD-BRK-1, OD-BRK-2a/2b slices, each recorded in the ADR as "not an acceptance" | §13 provenance and S1e per-consumer enforcement (S1a to S1e-4); S1e-5 integrated certification passed **for local evidence only** (2026-10-30) | **OD-BRK-4** (Audit queue migration) and OD-BRK-5 (shared-fanout retirement): OD-BRK stays open. **A3M F1–F7** as recorded in the A3M record §13.4 (F1, F2 medium and open). **S1e-5**: no production certification; S1-R, AP-R, NP-K, C-4, G-7 and OD-BRK-2b-2/3/4/5 stay open. §13.7 re-emission beyond Payment (S0-C4 resolved OD-15 for Payment only). DO-12 / P-11 (§3 below) |
| [0067](../adr/0067-auth-authorization-receipts-for-owner-approved-refunds.md) refund receipts | Proposed | Direction (P0 C-1) and wording at S0 (2026-10-21); amendment R6H-5 (`captureFactId`); each further receipt operation in the receipts contract §17a–§17g | Auth receipts (#351, #352), Payment consumption and recovery (#388), and the operations below | **F-22**: the ADR's text covers the refund operation only. **DO-62**: the central receipt audit actions carry no operation or target. Its 2026-10-21 note "Nothing in it is implemented" is historical (§2) |

## 2. ADR-0067: what its text does not yet cover (F-22, DO-62)

Auth issues **ten** receipt operations (`apps/auth-service/src/receipts/receipt-binding.ts`), each approved by the Owner in the receipts contract
([core-v2-d-a2-auth-authorization-receipts.md](./core-v2-d-a2-auth-authorization-receipts.md)); the ADR states only the first:

| Operation | Audience | Contract |
|---|---|---|
| `refund` | payment-service | §5 to §15; R6H-5 `captureFactId` (§17f) |
| `dispute_decision` | payment-service | §17a (R6E-3) |
| `fraud_hold_place`, `fraud_hold_release` | billing-service | §17b (H-2) |
| `recovery_surplus_external` | billing-service | §17c (R6F-5) |
| `late_settlement_apply` | billing-service | §17d (R6G-1, R6G-3) |
| `provider_fact_associate` | payment-service | §17e (R6H-3) |
| `recovery_write_off` | billing-service | §17e (R6H-8) |
| `recovery_restriction_suspend`, `recovery_restriction_revoke` | billing-service | §17g (S0-C14 items 10, 11) |

The ADR's decision 1 names one audience (`payment-service`); two audiences exist. The central audit actions `authorization_receipt.*` carry no
operation or target (DO-62; F-24 is the related approved deferral). Revising the ADR's text is the F-22 decision; it is not made here.

## 3. DO-12: replay enforcement per consumer (P-11 unchanged)

ADR-0057 §13.4 is the rule; S0-C6 states how each consumer applies it. Facts on `main` (code, not configuration of any running system):

| Consumer (queue) | Events consumed | Trust policy in code | Unverified original | Verified replay | Replay without verified match | Lookup failure |
|---|---|---|---|---|---|---|
| Billing (`payment-event-consumer.ts`) | Payment events | `strictEnforcement` (fixed in code; no mode switch) | refuse | process with the trusted tuple (H6) | refuse | hold |
| Notification (`intake/event-consumer.ts`) | the producer events in its `EVENT_MAP` | `strictEnforcement` (fixed in code; keyed body commitment, S0-C2) | refuse | process | refuse (`replay_unverifiable`: own reason) | hold |
| Audit (`ingestion/audit-consumer.ts`) | every producer's audit events | `AUDIT_PROVENANCE_ENFORCEMENT`: `compatibility` (default) or `strict` | compatibility: ingest as unverified; strict: refuse | process | compatibility: a replay matching only an unverified observation, or with no stored observation, is ingested as unverified; a mismatch is refused; strict: refuse | hold |

- No other service subscribes to events (Auth, Organization, File, Payment and Release only publish).
- **Enforce versus observe.** Billing and Notification enforce. Audit enforces admission always and enforces provenance only in `strict`; in
  `compatibility` it records unverified provenance and ingests (S0-C6 H1, Audit's temporary phase). The configuration of any deployed Audit is
  not read or asserted here.
- S0-C6's table lists Audit `replay_no_provenance` as "refuse (historical dead letters: after the C-4 disposition)"; in the compatibility
  phase the code ingests it as unverified (`trust-policy.ts`, `decideReplayTrust`), which the code documents as part of that phase. This is
  recorded, not changed; it ends with the compatibility phase (C-4, P-11).
- **P-11** (replay enforcement beyond these consumers, and the exit from Audit's compatibility phase) stays an open policy gate. This table
  widens nothing.

## 4. Not changed by this record

No ADR status, no ADR decision text, no Accepted ADR, no code, migration, configuration, broker permission or workflow. DO-5, OD-BRK-4,
A3M F1–F7, S1e-5, F-22, DO-62, P-11 and every other unresolved dependency stay open. Acceptance recommendations are for the Owner's review
and are not recorded here as decisions.

## 5. The Owner's G8 direction (2026-11-19) and what this record does with it

| ADR | Owner direction | Done here | Held, and why |
|---|---|---|---|
| 0032 | Accept the architectural approach; DO-5 (tested restore) stays a production blocker | nothing to its status | **Held.** The status change needs its own pull request: ADR status changes are "one ADR at a time, never in bulk" ([README](../adr/README.md) §Status lifecycle), "each in its own pull request with Core CI" (A5 record; S0 record "every ADR status change: separate explicit approval, one ADR at a time") |
| 0035 | Accept limited to C1–C4; tax treatment and `accounting-service` stay outstanding | nothing to its status | **Held**, for the same rule |
| 0057 | Keep `Proposed`, every open dependency intact | the DO-12 per-consumer enforcement note; the index row corrected | none |
| 0067 | Amend the refund-only description to the actual operation and audience matrix; F-22 and DO-62 stay open | Amendment 1 (descriptive: ten operations, two audiences); the index row corrected; status `Proposed` | none |

`Accepted` is never a production certification (README: "It does not imply that every consequence is implemented"). DO-5, F-22, DO-62,
P-11, OD-BRK-4/5, A3M F1–F7 and the S1e-5 production certification stay open.


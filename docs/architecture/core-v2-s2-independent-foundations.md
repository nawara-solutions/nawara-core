# Core V2 S2: independent foundations — stage record

| | |
|---|---|
| Stage | S2 independent foundations, MANDATORY: four tracks S2-Auth, S2-Audit, S2-File, S2-Rel ([execution roadmap](./core-v2-s-execution-roadmap.md) §4.2; [contract register](./core-v2-d-a2-contract-register.md)) |
| Record created | 2026-10-30, Phase 4 of the Owner's post-S6 plan (documentation and evidence only), on `main` at `18b0089` |
| Why now | Roadmap §2.2 (5) asks for a stage record created at authorization; none was. This record assembles the evidence of the merged work; it adds no test and changes no behaviour |
| **Verdict** | **CONDITIONAL PASS — development.** S2-File and S2-Rel: PASS (development). S2-Auth: receipts, `AUTH_SERVICE_POLICY` and the factor-only purposes PASS; **R-6a (AUTH-08) OPEN** (OD-R6a; DOC-1 not written). S2-Audit: contract v2, verified classification, scoped reads, holds and the AUD-07 rule PASS; Organization-reference scope rows **BLOCKED until F7**. **Operational acceptance NOT STARTED** for every track (M3/G-7 for Auth, M9/G-7/AP-R for Audit, M8/DG-2 for File, Release production MOVE V3) |

Evidence levels: **L** per-service tests on real PostgreSQL in `core-ci-passed`; **I** cross-process suites; **O** an operational
environment (none).

## 1. Work packages and their merges

| Track | Slice | PR (merge) |
|---|---|---|
| S2-Auth | S2-Auth.1 receipt domain (ADR-0067) | #351 (`3ee6082`) |
| S2-Auth | S2-Auth.2 AUTH-01/02/03 routes, inbound `SERVICE_TOKENS` + `AUTH_SERVICE_POLICY` | #352 (`3d913f0`) |
| S2-Audit | S2-Audit.1 contract v2, verified delivery, trusted scope | #353 (`288ea25`) |
| S2-Audit | S2-Audit.2 receipt audit actions with Company scope and `approvedBy` | #354 (`bebf6c7`) |
| S2-Audit | S2-Audit.3 Owner Company and operator Platform reads (AUD-03, AUD-04) | #355 (`e027920`) |
| S2-Audit | S2-Audit.4 Owner legal holds | #356 (`54d5bf9`) |
| S2-Audit | S2-Audit.5 AUD-07: only broker-verified records in the Owner Organization read | #357 (`388a27e`) |
| S2-Rel | S2-Release.1 REL-01/02/03 Owner reads | #358 (`dbfe882`) |
| S2-File | S2-File.1 to S2-File.4: evidence grants, granted reads and tickets, holds, ticket leases | #359 (`50212d5`), #360 (`8b2f709`), #361 (`f5dadf7`), #362 (`a8ab2c5`) |
| Later S2-Auth purposes used by S5 / S6 | assistance, dispute, fraud-hold, recovery, late-settlement, association / write-off step-ups and receipts | #382, #391, #393, #396, #398, #400, #402 |
| CI stability | deterministic receipt fault injection; bootstrap port isolation (test-only) | #407 (`2029fd6`) |

## 2. Certification gate (roadmap §4.2) per track

### 2.1 S2-Auth

| Criterion | Level | Evidence | Status |
|---|---|---|---|
| Only digests of the secret and the canonical binding stored; plaintext returned once; 10-minute lifetime (database clock) | L | `apps/auth-service/test/authorization-receipts.e2e-spec.ts`, `authorization-receipt-routes.e2e-spec.ts` ("201 with the secret once, no-store …"; "secret handling") | PASS |
| Negative test for every refusal: `receipt_issued_response_lost`, `receipt_already_consumed`, a different `consumeRef`, `authority_revoked`, wrong audience, expired | L | `authorization-receipt-routes.e2e-spec.ts` (AUTH-01 issuance, AUTH-02 consumption, AUTH-03 lookup blocks) | PASS |
| Consumption is one conditional update and the commit point; `approvedBy` only from Auth's consumption | L, I | same suites; `test/e2e-real-broker/s6b-refund-processing.e2e-spec.ts`, `s6-financial-certification.e2e-spec.ts` (real Auth) | PASS |
| Fault injection between issue and response, and between consumption and its response | L | `authorization-receipt-routes.e2e-spec.ts` "fault injection" block, made deterministic by #407 (scoped to the receipt write; regression tests that fail against the former helper) | PASS |
| Issuance, consumption and voiding audited (local and central) | L | `authorization-receipt-central-audit.e2e-spec.ts` | PASS |
| `AUTH_SERVICE_POLICY` deny-by-default; only admitted callers | L | `authorization-receipt-routes.e2e-spec.ts` (policy), `src/receipts/service-policy.spec.ts` | PASS |
| Factor-only purposes (TOTP or passkey, never the secret key) | L | `step-up.e2e-spec.ts`, `step-up-verify.e2e-spec.ts`, `assistance-step-up.e2e-spec.ts`, `legal-hold-step-up.e2e-spec.ts` | PASS |
| **R-6a** organization-administrator grant facts (AUTH-08) | — | not implemented: its specification (DOC-1) is not in the repository | **OPEN (OD-R6a)** |

### 2.2 S2-Audit

| Criterion | Level | Evidence | Status |
|---|---|---|---|
| Versions 1 and 2 accepted; a version-1 event for a version-2 action refused; new columns nullable, history never rewritten | L | `apps/audit-service/test/contract-v2.e2e-spec.ts`; `libs/audit-contract` tests | PASS |
| Verified-producer classification over S1 provenance; production refuses `liveMode = false` | L, I | `contract-v2.e2e-spec.ts`; `src/ingestion/ingestion.service.ts` (`non_live_record`); S1e-5 Audit rows | PASS |
| Scope applied before any limit; cursors bound to actor, scope, filters and window; filters never widen scope | L | `scoped-query.e2e-spec.ts`, `owner-query.e2e-spec.ts` | PASS |
| Every human read recorded, `503` when it cannot be | L | `owner-query.e2e-spec.ts` ("FAIL CLOSED: if the read cannot be recorded … 503"), `query.e2e-spec.ts` (same, `accountability_unavailable`); `scoped-query.e2e-spec.ts` (every page recorded; Auth unanswerable → 503, nothing recorded) | PASS |
| Legal holds: append-only; the retention role skips held records; no normal role deletes | L | `legal-hold.e2e-spec.ts` (#356) | PASS |
| Append-only controls on `audit_record` unchanged | L | existing audit-service e2e and migration suites | PASS |
| Organization-reference scope rows | — | Audit has no Organization reference; Auth is the hierarchy authority before F7 | **BLOCKED until F7** |

Note: the register's AUD-05 entry still reads "OPEN route" although #356 implemented Owner legal holds; reconciling that entry is a
register change, not made here.

### 2.3 S2-File

| Criterion | Level | Evidence | Status |
|---|---|---|---|
| A grant never widens Organization scope; purpose-bound; revocable | L | `apps/file-service/test/evidence-grants.e2e-spec.ts`, `granted-reads.e2e-spec.ts` | PASS |
| A held file cannot be deleted (every deletion path) | L | `evidence-holds.e2e-spec.ts` | PASS |
| Tickets single-purpose, bounded, single-use under a lease, fail-closed | L | `ticket-leases.e2e-spec.ts` | PASS |

### 2.4 S2-Rel

| Criterion | Level | Evidence | Status |
|---|---|---|---|
| Three Owner reads verified live (ADR-0050) | L | `apps/release-service/test/owner-reads.e2e-spec.ts` | PASS |

## 3. Open, blocked and deferred

| Item | State | Effect |
|---|---|---|
| **OD-R6a** / DOC-1 (R-6a specification) | OPEN; **D-2, 2026-10-30:** not a dependency of the S1 to S6 pre-lifecycle certification scope; due before the **earlier** of Organization authority activation (F6/F7) and the first lifecycle-enabled release; not V3 | blocks S2-Auth's R-6a work package only; its one current consumer (organization-service `org_admin`) is unreachable while organization-service is not authoritative; DOC-1 content is not decided |
| **Q8** proof of receipt non-consumption (AUTH-03b) | OPEN, fail-closed | an unanswered authorization stays pending, never released (S6 §8) |
| Auth receipt token provisioning and caller admission records (Q9) | OPEN (operational) | — |
| Audit Organization-reference scope rows | BLOCKED until F7; **D-4, 2026-10-30:** bound to Organization authority activation (ADR-0069 decision 4; the kit reference contract), not deferred to V3, **not** an S0 §5 human hierarchy-read deferral | the Owner Organization read shows only broker-verified records (AUD-07); not an S2 certification-gate criterion |
| **AUD-05** register entry | stale (implementation merged in #356) | documentation only |
| Production: Auth digest deployment (M3, G-7); Audit 0004 and later (M9, G-7, AP-R); File (M8, DG-2); Release (MOVE V3) | NOT STARTED | nothing of S2 runs in production |
| Unexplained Auth "sequential replays" `401` (observed once in Phase 2, not reproduced in 47 runs) | OPEN (test observation) | recorded in the [runbook](../runbooks/real-broker-certification.md) §4 and the S6 addendum |

## 4. Unresolved contract decisions and their impact

- ADR-0067 and ADR-0069 remain **Proposed** (G-1); ADR-0049's reciprocal note (DOC-8) is not written.
- OD-R6a leaves the organization-administrator grant facts uncorrected; every Organization-actor check uses live `/auth/me`
  membership facts instead (S4e A-2 model), valid only while no scope can be inactive.
- OD-13 / Q11 (AUD-05 caller and route) are recorded open in the register although holds are implemented under H1–H7.

## 5. Verdict

**S2: CONDITIONAL PASS (development).** S2-File and S2-Rel pass; S2-Auth passes except R-6a (OPEN); S2-Audit passes except the
Organization-reference scope rows (BLOCKED until F7). No track is operationally accepted.

## 6. Update (2026-10-31): S-INT entry classification

Under the S-INT entry rule ([roadmap](./core-v2-s-execution-roadmap.md) §5, D-3) every S2 certification-gate criterion is PASS at
development level (§2). R-6a and the Audit Organization-reference scope rows are dispositioned by D-2 and D-4 (c); Q8 is fail-closed and
tested (d); Q9 and every production enablement are (a). See the [condition matrix](./core-v2-stage-condition-matrix.md). No development-level item is OPEN without a disposition. **The verdict
is unchanged (CONDITIONAL PASS, development):** R-6a stays OPEN with its D-2 deadline; no Organization authority activation is claimed.

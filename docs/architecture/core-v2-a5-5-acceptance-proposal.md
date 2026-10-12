# Core V2 A5.5: acceptance criteria (ADOPTED 2026-10-12)

- **Status:** **ADOPTED by the owner on 2026-10-12 (§5): C1–C6 are binding A5.5 acceptance criteria; C7 is adopted as a mandatory
  production safety boundary.** History: first draft 2026-10-12 (PR #298); revised into a decision-ready form on 2026-10-12 after a
  review against the authoritative sources (§1; PR #299). Documentation only. **A5.5 itself is not started and A5 is not certified**:
  adoption changes no gate, certifies nothing, and authorizes no implementation or production step. A5.4 RED work stays gated until F7.
- **Why:** the [A5 record](core-v2-a5-organization.md) §9 defines A5.5's acceptance as "the criteria A5.3 fixes". A5.3's closure
  (§10.5) records the decided architecture and the A5.4 prerequisites, but states no explicit A5.5 criteria. These criteria are derived
  from:
  - A5.3 and ADR-0059 to ADR-0063 (with ADR-0064 and ADR-0065, which refine ADR-0061);
  - the A5.4-G1 governance (§9.1) and the narrow RED exception (§9.3);
  - the A5.4 acceptance in §9 (focused tests and mutants, service regression, `test:e2e:auth-organization`);
  - the [V2 validation protocol](core-v2-a-baseline-and-change-safety.md#8-v2-per-capability-validation-protocol);
  - the validation rules of §12;
  - the closest certification precedent, A4.9 ([A4 record](core-v2-a4-authentication.md) §16 and §18).
- **What A5.5 is:** a **records-based certification** (§9 A5.5 row) of the completed Organization V2 implementation. It is **not** a
  substitute for G6, G7, F6 or F7, not a production activation, and not A19 or Final Core Validation (§3).

## 1. Review of the first draft

| # | Classification | Finding | Change in §2 |
|---|---|---|---|
| C1 Source implementation completion | **CLARIFY** | Necessary and grounded (§9 A5.4, §10.5, A5.4-G1). The scope baseline was ambiguous: §10.5 also lists "later" and "still deferred" items, and the roadmap's A5 row names memberships and invitations, which A5 keeps in Auth unchanged (§6). The governance-traceability clause duplicated C3's approval-disposition clause. | Fixes the baseline (ADR decisions plus the §10.5 prerequisites; "still deferred" items excluded unless the owner adds them); requires a disposition per item; takes over approval traceability, including the NOT VERIFIED items. |
| C2 Focused regression and contracts | **CLARIFY** (minor) | Necessary; restates the V2 protocol and §12; measurable from PR records. It needed an explicit evidence format, the shared-library rule, and a statement that it is per pull request, not a new campaign. | Adds the completion matrix (A4.9 §18.1 format) and the shared-library rule; states that no new campaign is run. |
| C3 Security and hierarchy-authority acceptance | **CLARIFY** | Necessary, but it mixed functional security properties (testable on `main`) with production-gate evidence (the G6 readiness matrix, O7 monitoring "before activation") and approval dispositions. It also omitted lifecycle and provisioning correctness (ADR-0060, ADR-0062). | Limited to properties shown by tests and static checks; G6 evidence moved to C4; approval dispositions moved to C1; lifecycle and provisioning added. |
| C4 Required post-F7 evidence | **CLARIFY + DEFER TO PRODUCTION GATE (partly)** | F7 is a real dependency: A5.4's RED work depends on F7 (§9), and A5.5 depends on A5.4. But the post-F7 backup, R3's production installation, the R2 packaged-image probe and any deployment are production-track conditions with their own authorizations; §12 says no production step is part of A5. | Requires the *records* of F7 and G6, not their execution. The post-F7 backup, R2 probe and R3 installation are recorded as status, with any breach of their own conditions treated as a blocking finding. |
| C5 Independent review | **CLARIFY** | Necessary, and it is the A5 practice (A5.4-A2 design acceptance item 7; A5.4-A5 design §14; R3 carrier §15 and §17). The draft's grounding, "A13–A15 practice", is not supported by those records, and A14 notes that a sole owner cannot provide independent human review. | Grounding corrected; required content and the finding threshold defined; independence limit stated. |
| C6 Explicit owner certification | **CLARIFY** (minor) | Necessary (§9 "records-based"; every closed V2 stage ends with a certification record and merge). The record's contents and the closing mechanism were unstated. | Defines the certification record (A4.9 §18 format) and closure by the merge of the certification pull request. |
| C7 Production gates and deployments | **DEFER TO PRODUCTION GATE** (kept as a boundary, not a criterion) | Correct but not an acceptance test: it states what A5.5 never executes. Kept under its number so references stay valid. | Reworded as a boundary statement; adds R3 and A19 exclusions. |

No criterion is removed or merged; C1–C7 keep their numbers. No established decision, ADR or gate is changed.

## 2. Criteria (adopted 2026-10-12)

Evidence kinds follow A4.9: **CI** (Core CI of a merged pull request), **local** (runs recorded during the stage, not rerun),
**repository** (the content of `main`), **record** (a dated governance record), **production record** (a record of a separately authorized
production checkpoint; A5.5 reads it and never runs it).

### C1 Scope completion and authorization traceability

**Criterion.** Every item of the A5 scope baseline is either implemented on `main` or dispositioned by a dated owner record. Every RED
change merged for A5 has its required authorizations recorded.

- **Scope baseline:**
  - each decision of ADR-0059 to ADR-0063, as refined by ADR-0064 and ADR-0065;
  - each "Future A5.4 prerequisite" of §10.5;
  - each A5.4 task row of §9.2.
- **Excluded unless the owner adds it:** the §10.5 "Still deferred" items (for example multi-company onboarding, OD-S1 steward
  provisioning, E3 propagation) and the A6 deferrals (ADR-0022's surviving decisions, ADR-0024).
- **Unchanged items:** the roadmap's memberships, invitations and join codes stay in Auth (§6, 🟢 "existing, no implementation"). The
  record states that they are unchanged.
- **Disposition values:** implemented, deferred to a named later stage, or withdrawn. Each non-implemented disposition is a dated owner
  record.
- **Authorization traceability:** each RED merge (the A5.4-G1 item 4 exception, the §9.3 exception, and post-F7 RED work) cites its
  recorded authorizations. Every open NOT VERIFIED approval is dispositioned by the owner, either by a dated confirmation or by an
  accepted governance finding. These include PR #287's §9.3 A.2 item 5 and PR #291's RED-exception merge approval.

**Evidence:** a scope register in the certification record (item, ADR, pull request and merge commit, or disposition record). **Verify:**
read `main` and the records. **Depends on:** A5.4 (and through it F7, for RED work).

### C2 Per-change validation evidence

**Criterion.** Every A5 implementation pull request met the V2 protocol and §12 when it merged:
- focused tests with negative controls (deliberate mutants detected, then restored);
- the affected services' lint, typecheck, unit, e2e and database suites;
- `test:e2e:auth-organization`;
- the shared-library rule when `libs/service-kit` or `libs/audit-contract` changed (fresh `dist/`, dependent suites);
- audit-contract changes consumer-first;
- `check:repo` (including `checkAuthOrganizationBoundary` and `checkRepairAuditProducerScope`) and `test:repo`, plus `test:deploy`
  when deploy scripts changed;
- full Core CI green, with `core-ci-passed`.

**Evidence:** a completion matrix with the pull request, merge commit, `core-ci-passed` run and status (A4.9 §18.1 format), and each
pull request's recorded focused, mutation and regression evidence. A5.0–A5.3 and the merged pre-F7 GREEN, YELLOW and exception work are
reused, not rerun, as are the A1, A2, A3M, A4 and A15 certifications. **Verify:** GitHub and the pull request records. **Not required:** a
new integrated or platform-wide test campaign (that is A19 or Final Core Validation).

### C3 Security, authority and lifecycle correctness

**Criterion.** Tests or static checks on `main` show each of the following, cited by test name or check:
1. **One active authority and no local-authority fallback** at every source and marker combination (ADR-0040, ADR-0063).
2. **Auth's never-call boundary** holds (ADR-0063 §5; A5.4-T1).
3. **Fail-closed readiness:** the `hierarchy_authority` reasons, R1 and R4 (ADR-0063 §4).
4. **Owner rules:** exactly one active Owner, controlled transfer and exceptional recovery with their step-up purposes, and refusals for
   non-Owners (ADR-0059).
5. **Lifecycle:** Company, Platform and Organization transitions are allowed and refused per ADR-0060, behind their default-off gates,
   with the backfill and the read-only `verify`.
6. **Reference repair:** the eligibility rules (source `organization-service` and marker `org_authoritative`; the O15 answers), step-up
   consumption with the O8 conservative fallback, and the mandatory audit records (ADR-0061, ADR-0064, ADR-0065).
7. **Provisioning:** the initial-hierarchy and first-Platform sequencing (ADR-0062).

**Evidence:** a guarantee-to-test table (A4.9 §18.3 format). **Verify:** read the tests on `main`; CI from C2. **Depends on:** C1's
implemented items. Items dispositioned as deferred under C1 are listed as not applicable.

### C4 Production-track dependencies (recorded, not executed)

**Criterion.** The certification record cites the production records that A5.4 depends on, and states the status of the related
production conditions. **A5.5 executes none of them.**

- **Required records:**
  - the G6 certification, including R1's `hierarchy_authority` readiness matrix confirmed with the certified digest set (A5.4-G1
    items 3 and 4);
  - the F7 completion and post-activation verification in the cutover record.
- **Status only. These are conditions of their own production steps, not A5.5 conditions; a recorded breach is a blocking finding under
  C5:**
  - the post-F7 Auth and Organization backup and its verification (§7);
  - the R2 packaged-image probe (LOW 1), required before any rehearsal that drills a backup taken under a freeze
    ([R2 review](core-v2-a5-r2-restore-drill-review.md));
  - R3's installation on the production host before each Auth deployment containing the check (ADR-0063 §4 item 10). R3's nonproduction
    certification is reused, not repeated;
  - O7 monitoring before reference-repair activation (ADR-0064 clarification);
  - which A5 capabilities are deployed or activated. **Activation is not an A5.5 condition** (§12; V2 protocol: production activation is
    a separate, gated checkpoint).

**Evidence:** references to the production records. **Verify:** read the records. **Depends on:** G6 and F7.

### C5 Independent review

**Criterion.** One independent review of the A5 evidence set (C1 to C4) is recorded, by a reviewer other than the author of the
reviewed work, with its findings classified. Its verdict is PASS or PASS WITH FINDINGS, and no blocking finding is open. A finding is
blocking when it shows one of the following:
- a missing required authorization;
- a failed criterion;
- a security defect;
- a breached production-track condition.

Non-blocking findings are either closed or accepted by the owner as dated limitations.

**Evidence:** the review record (scope, method, findings, verdict, what was not run). **Verify:** the record is present and its blocking
findings are closed. **Limit:** with a sole owner, independence means a separate review (for example a separate review session) rather
than a second human approver (A14 record). The certification states this limit.

### C6 Owner certification and traceable record

**Criterion.** The owner gives an explicit, dated certification of A5, recorded in an A5.5 section of the A5 record. That section
contains:
- the scope register (C1);
- the completion matrix (C2);
- the guarantee-to-test table (C3);
- the production-record references (C4);
- the review verdict (C5);
- what was not run;
- the accepted limitations;
- the open risks carried forward.

The roadmap is updated in the same pull request. A5 is certified and closed when that certification pull request merges with green Core
CI (the A2, A4 and A15 precedent). **Verify:** the merged record and roadmap.

### C7 Boundary: production gates, deployments and final validation (not an acceptance test)

A5.5 records production evidence and never executes it. Each of the following keeps its own explicit owner authorization:
- the G6 baseline refresh;
- G6;
- the pre-G7 backup;
- backup verification and the backup schedule;
- G7, F6 and F7;
- the post-F7 backup and its verification;
- every deployment, R3 production installation and activation;
- the R2 probe and any restore drill.

A5.5 does not repeat R3's demonstration, does not run an A19 or Final Core Validation campaign, and opens no callers (A16).

## 3. Scope boundaries

| A5.5 includes | A5.5 excludes |
|---|---|
| Records-based certification of the implemented Organization V2 scope (C1 to C3) | Implementing any A5 feature (A5.4) |
| Reading and citing G6, F7 and other production records (C4) | Executing G6, G7, F6, F7, backups, drills, deployments or activations (C7) |
| Reusing per-PR CI and recorded local evidence | New integrated or platform-wide test campaigns (A19, Final Core Validation) |
| Reusing R3's nonproduction certification | Repeating R3's demonstration or its production installation |
| Dispositioning NOT VERIFIED approvals (C1) | Rewriting existing certification evidence |
| Stating unchanged Auth memberships, invitations and join codes | Roles, permissions and policy (A6); audit semantics (A7); product callers (A16); the §10.5 "Still deferred" items unless added by the owner |

## 4. Optional interim checkpoint (owner choice)

Unchanged from the first draft. **Adopted 2026-10-12 as an option, progress-only** (§5): the owner may record a **non-certifying "A5 pre-F7
checkpoint"**; none is recorded by the adoption itself. It would list:
- A5.0 to A5.3 complete;
- the merged pre-F7 exceptions (A5.4-A2, A5.4-A3, A5.4-A5, R2);
- R3 certified for nonproduction;
- the open NOT VERIFIED items.

It grants no A5 certification. Without it, A5 stays OPEN until C1 to C6 are met.

## 5. Owner decision record

| Field | Entry |
|---|---|
| Decision | **C1–C6: ADOPTED** as binding A5.5 acceptance criteria, as written in §2. **C7: ADOPTED AS PRODUCTION SAFETY BOUNDARY** (mandatory; not an acceptance test) |
| Interim checkpoint (§4) | adopted as an option, **progress-only, never A5 certification**; no checkpoint is recorded by this decision |
| Amendments | none |
| Date and owner | 2026-10-12, project owner (explicit decision, recorded in this documentation pull request) |
| Effect | §2 is A5.5's binding acceptance; the A5 record §9 A5.5 row and the roadmap reference it (same pull request). **A5.5 is not started, A5 is not certified**, A5.4 RED work stays gated until F7, and nothing is implemented, deployed or activated. R3 stays CERTIFIED — PASS WITH LIMITATIONS (NONPRODUCTION), unchanged |

## 6. What this decision does not do

- It closes or certifies nothing.
- It authorizes no implementation, merge, deployment or production step.
- It changes no ADR, governance decision or gate.

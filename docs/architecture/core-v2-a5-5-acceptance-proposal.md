# Core V2 A5.5: acceptance criteria (PROPOSAL FOR OWNER DECISION)

- **Status:** **PROPOSAL FOR OWNER DECISION, not binding.** Written 2026-10-12, documentation only. **A5.5 stays pending**, and
  nothing here changes A5's state or any gate.
- **Why:** the [A5 record](core-v2-a5-organization.md) §9 defines A5.5's acceptance as "the criteria A5.3 fixes". A5.3's closure
  (§10.5) records the decided architecture and the A5.4 prerequisites, but it states no explicit A5.5 criteria. This proposal derives
  them from:
  - A5.3 and ADR-0059 to ADR-0063;
  - the A5.4-G1 governance (§9.1);
  - the A5.4 acceptance in §9 (focused tests and mutants, service regression, `test:e2e:auth-organization`);
  - the [V2 validation protocol](core-v2-a-baseline-and-change-safety.md#8-v2-per-capability-validation-protocol);
  - the validation rules of §12.
- **Owner choices:** accept, amend or reject each group. The proposal also offers an optional interim checkpoint (§2).

## 1. Proposed criteria

| Group | Proposed criterion | Grounding |
|---|---|---|
| **C1 Source implementation completion** | Every ADR-0059 to ADR-0063 decision is either implemented on `main` or explicitly deferred by a dated owner record. This includes lifecycle, owner transfer and recovery, reference repair, provisioning and first Platform, and authority modes and CLI convergence. Every A5.4 task in §9.2 is closed or dispositioned, as is every "Future A5.4 prerequisite" in §10.5. No RED item merged without its recorded authorizations. | §9 A5.4, §10.5, A5.4-G1 |
| **C2 Focused regression and contracts** | Each implementing pull request meets the V2 protocol: focused tests with mutation checks, the affected services' suites, `test:e2e:auth-organization`, `check:repo` (including the Auth → Organization boundary and the repair producer-scope checks), audit-contract changes consumer-first, and full Core CI green (`core-ci-passed`). The certification reuses the A1, A2, A3M, A4 and A15 evidence and does not repeat it. | §9, §12, V2 protocol |
| **C3 Security and hierarchy-authority acceptance** | The evidence must show all of the following: one active authority at every step and no local-authority fallback (ADR-0040, ADR-0063); the `hierarchy_authority` readiness matrix confirmed in G6 with the certified digest set (A5.4-G1 item 4); the reference-repair proof-inaccessibility evidence and O7 monitoring before activation (§9.3 A.4, ADR-0064); step-up and Owner-only rules enforced (ADR-0059, ADR-0061); and every open NOT VERIFIED approval (PR #287 item 5, PR #291) dispositioned by the owner. | ADR-0040, 0059–0065; §9.3 |
| **C4 Required post-F7 evidence** | F7 is complete and verified (cutover record), and the post-F7 Auth and Organization backup is taken and verified by a restore drill. Auth is ready in its post-F7 state (source `organization-service`, marker `org_authoritative`). If a backup taken under a freeze is drilled, the R2 path has its packaged-image probe ([R2 review](core-v2-a5-r2-restore-drill-review.md)). R3 is installed on the production host before every Auth deployment containing the check. | §7, ADR-0063 §4 items 9–10 |
| **C5 Independent review** | One independent review record of the A5 evidence set: implementation, tests, the post-F7 evidence and the governance records. | the A13–A15 certification practice |
| **C6 Explicit owner certification** | A dated owner certification of A5, stating the accepted limitations, recorded in the A5 record and the roadmap. | §9 A5.5 ("records-based") |
| **C7 Production gates and deployments (prerequisites, not A5.5 work)** | The protected sequence is G6 baseline refresh → G6 → pre-G7 backup → backup verification and schedule → G7 → F6 → F7 → post-F7 backup and verification. Each step, and every deployment, keeps its own explicit owner authorization. A5.5 records their evidence and never executes them. Final Core Validation is not part of A5; it is reserved for the end (Stage 22 / A19). | roadmap G6 section; §7, §12 |

## 2. Optional interim checkpoint (owner choice)

The owner may record a **non-certifying "A5 pre-F7 checkpoint"**. It would list:
- A5.0 to A5.3 complete;
- the merged pre-F7 exceptions (A5.4-A2, A5.4-A3, A5.4-A5, R2);
- R3 certified for nonproduction;
- the open NOT VERIFIED items.

It would grant no A5 certification. Without such a decision, A5 stays OPEN until C1 to C6 are met.

## 3. What this proposal does not do

- It makes no criterion binding.
- It closes or certifies nothing.
- It authorizes no implementation, merge, deployment or production step.
- It changes no ADR or gate.

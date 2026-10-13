# Nawara Core V3 roadmap: work deferred from Core V2

- **Status:** DEFERRED. Nothing in this document is authorized, implemented, deployed or activated by being listed here. Each item
  starts only with its own owner authorization, after the Core V2 release
  ([V2 release scope](CORE-ROADMAP.md#core-v2-release-scope-the-nawara-drive-pilot)) unless the owner decides otherwise.
- **Origin:** the owner direction of 2026-10-13: Core V2 is the minimal, production-safe Core needed to launch Nawara Drive; Core V3
  holds what the first client delivery does not need. The authoritative status and direction stay in the
  [Core roadmap](CORE-ROADMAP.md); this document is the deferred backlog.
- **Traceability:** every item keeps its original stage or substage ID and points to the record that defines it. The original
  requirements are not changed or erased: an item moved here keeps its full original definition in its source record and the original
  V2 stage table of the [Core roadmap](CORE-ROADMAP.md#core-v2-future--planned).

## Rules

1. **Moved, not waived.** A V3 item is still required where its source says so; only its timing changed. Accepted ADRs stay binding.
2. **Gates unchanged.** Items that need the post-F7 state still need it. Nothing here bypasses G6, G7, F6, F7 or ADR-0062.
3. **No silent pull-forward.** Moving an item back into V2 is an owner decision recorded in the Core roadmap.
4. **Validation.** Each item is certified on its own by the
   [V2 validation protocol](architecture/core-v2-a-baseline-and-change-safety.md#8-v2-per-capability-validation-protocol), which also
   applies to V3. Final Core Validation stays the single, last platform-wide validation; whether a further full validation follows V3
   is a later owner decision.
5. **Pending decisions.** Items marked *pending DG-n* move to V3 only if the owner decides that way; the decision gates are listed in
   the [Core roadmap](CORE-ROADMAP.md#owner-decision-gates-unresolved-nothing-here-is-approved).

## Deferred backlog

| Original ID / source | Item | Reason deferred | Dependency to start | Security implication of deferring |
|---|---|---|---|---|
| A3M.8 ([A3M record](architecture/core-v2-a3m-messaging.md)) | Production messaging beyond the pilot: outbox and de-duplication retention activation, further broker identities and topology changes | the pilot needs only the existing Auth → Audit relay and File Service's audit relay (V2) | each item separately authorized | retention stays unscheduled; tables grow but no data is exposed |
| A3M finding F1 ([A3M record](architecture/core-v2-a3m-messaging.md)) | Forged events to Notification (*pending DG-3*) | only relevant once Notification consumes in production | Notification enablement | **must be resolved before Notification is activated**; it stays a V2 item if DG-3 brings Notification into the pilot |
| A4 production checkpoints ([A4 record](architecture/core-v2-a4-authentication.md) §15, §18.7) | JWT signing-key ring activation and its minimum-image gate | the pilot runs on the existing signing configuration | the Auth digest deployment (V2) | key rotation stays the existing procedure until the ring is activated |
| A5.4 / ADR-0059 ([ADR](adr/0059-company-ownership-transfer-and-exceptional-owner-recovery.md)) | Company Ownership transfer and exceptional Owner recovery (steward), with OD-S1 (*pending DG-8*) | advanced lifecycle | F7 | a lost single Owner blocks hierarchy administration until implemented; the mitigation is decision DG-8 |
| A5.4 / ADR-0060 ([ADR](adr/0060-company-platform-organization-lifecycle.md)) | Company, Platform and Organization lifecycle runtime and migrations (suspend, archive; E1–E5), the existing Company's backfill to `ACTIVE` | advanced lifecycle; ADR-0062 §4 applies E4 "once implemented" | F7 | no suspension of an Organization through Core during the pilot; access is withdrawn through memberships |
| A5.4 / ADR-0061, ADR-0064, ADR-0065 ([A3 design](architecture/core-v2-a5-4-a3-reference-repair-design.md)) | Activation of the merged reference-repair route (A5.4-A3) and its diagnostics; O7 operational monitoring | repair is not needed to create and use the first Platform and Organization | F7, O7 monitoring | the route stays merged and inactive |
| A5.4 / ADR-0063 §11 ([ADR](adr/0063-post-f7-authority-mode-cli-and-recovery-convergence.md)) | The post-F7 authority-mode CLI convergence, command retirement, the diagnostic CLI and `EnvReader` convergence, except what F6/F7 themselves need | convergence work | F7 | none for the pilot; the F6/F7 runbooks govern the transition |
| A5.4-AS1 ([A5 record](architecture/core-v2-a5-organization.md) §9.2) | audit-service acceptance of the `steward` user kind | follows ADR-0059 | ADR-0059 implementation | none until stewards exist |
| A5.4-K1 ([A5 record](architecture/core-v2-a5-organization.md) §9.2) | service-kit runtime `adminTier` fail-closed validation | hardening beyond the pilot's callers | A5 governance | caller policies stay validated by the existing parsers |
| A5 §10.5 "still deferred" ([A5 record](architecture/core-v2-a5-organization.md)) | Multi-company onboarding; OD-S1 steward provisioning (with ADR-0059); OD-L5, OD-L6 and OD-L7; E3 lifecycle propagation; hierarchy retention and erasure; factor-only MFA for Platform and Organization creation. **Not moved:** the provisioning-credential retirement and the `allowedPlatforms` extension tooling are V2 (M5, ADR-0062), and the F6 transitional readiness behavior is rehearsed in G6 (M1) | one operating Company serves the pilot | F7 | multi-company stays not operationally ready (ADR-0062); Platform and Organization creation keeps the existing Owner step-up |
| A6 ([roadmap table](CORE-ROADMAP.md#core-v2-future--planned)); ADR-0022, ADR-0024 | Roles, permissions and policy evaluation in Core; ownership-aware and cross-service enforcement | Drive owns its business roles (ADR-0029); Core's membership and platform-access check serve the pilot | A5 | **tenant isolation is not deferred**: V2 item M12 tests it |
| A7 | Audit retention, querying, correlation and cross-service coverage beyond the existing producers | basic Audit and its backup stay in V2 (M9) | M9 | accountability for existing producers continues |
| A8 (*pending DG-3*) | Notification: templates, channels, delivery, preferences, product contracts and its production enablement | not a pilot dependency unless DG-3 says so | DG-3; F1 | no email or SMS from Core during the pilot |
| A9 (register P9, [17.10 record](architecture/stage-17/stage-17-10-focused-certification.md) §10) | Tuning File Service defaults against real traffic; later File features | needs real traffic first | M8 | the certified defaults apply |
| A10 (*pending DG-4*); ADR-0044 | Billing: plans, subscriptions, invoices, entitlements and their production enablement | pilot billing may be manual | DG-4 | none; no client access decision depends on Billing unless DG-4 says so |
| A11 | Payment: real gateway adapters (Flouci, Konnect, Paymee, Stripe) and production enablement | only the test provider exists; the client pays outside Core | A10 | none until enabled; webhook security is certified per adapter |
| A12.7–A12.9, A12.10 beyond M10 ([A12 record](architecture/core-v2-a12-observability.md)) | Further observability scope; production dashboards, metrics collection and alerting beyond the pilot minimum | the pilot keeps readiness and backup-failure alerting (V2) | M10 | detection limited to the V2 minimum |
| A13 | Restore automation and further DR automation beyond the V2 backups and drills | V2 keeps the backups, schedule and restore drills the pilot needs | M2, M3, M8, M9 | none for the pilot's data |
| A16 (other products) | Product integration for Nawara School, Flow and future products; ADR-0043 (Proposed) | the pilot needs only the Drive slice (M11) | M11 | — |
| A17 (other products) | Product readiness beyond the Drive pilot | — | M13 | — |
| A18 | Performance: load testing, pools, caching, scaling, capacity | pilot scale | the V2 release | capacity limits are the certified defaults |
| A19 (beyond the pilot gate; *pending DG-7*) | The full V2 release certification across all original stages | the pilot gate certifies the pilot scope (M13) | DG-7 | — |
| Release service (Stage 20.x) | Production enablement of release metadata and client compatibility | not a pilot dependency | the V2 release | none |

## Not V3 and not V2

`accounting-service`, `location-service`, `search-service` and `analytics-service` stay **FUTURE / IDEA / REQUIRES SEPARATE SCOPE
DECISION**, as before ([Core roadmap](CORE-ROADMAP.md#core-v2-future--planned)). AI stays outside Core (ADR-0055).

# Core V2 A5.4-AC1 batch 2: reference-repair failure and incident audit (decision record)

- **Status:** DECIDED IN PRINCIPLE (2026-10-10) by the architecture owner: four audit-policy decisions for ADR-0061 reference repair.
  Documentation only. **The audit catalog is not changed by this record**, and it authorizes no declaration, producer, schema change,
  deployment or activation. The exact action names and shapes in §2 and §4 are **proposals** for the AC1 batch 2 declaration task,
  which needs its own YELLOW authorization.
- **Authority.** [ADR-0061](../adr/0061-auth-hierarchy-reference-repair-and-diagnostics.md) governs the repair, **partly superseded** by
  [ADR-0064](../adr/0064-reference-repair-failure-and-incident-audit.md) (Accepted 2026-10-10): its §6 central-outbox-first step no
  longer applies to infrastructure failures (decision D2). ADR-0064 also records D1, D3 and D4 as new policy. [ADR-0040](../adr/0040-organization-ownership-migration-decisions.md) decision 1
  governs immutable anchors. Where this record and an Accepted ADR differ, the ADR governs.
- **Builds on:** the [AC1 batch 1 record](core-v2-a5-4-ac1-repair-audit-contract.md) (merged as PR #271; declarations merged as
  PR #272), whose open items §5 and §8 this record closes in principle.
- **Class.** Declarations of the actions below are **YELLOW** (additive, producer-less). Every producer is **RED**: the repair
  runtime (A5.4-A3), the resolve/place split (A5.4-A2) and any change to the existing first-touch `ensure`.

## 1. The four decisions

| # | Case | Decision |
|---|---|---|
| D1 | collapsed `404` after the step-up is consumed (nonexistent, outside Auth's scope, another Company); the `local`-mode `404` is refused before step 3 and writes no record | a **separate central action**, one fixed reason, `organizationId` `null`, the verified Owner as actor; never `hierarchy.reference_repair_denied` |
| D2 | operational failure (`503`) | **no central record**: Auth's local failure audit, a structured log and a bounded metric; no new outcome and no new central action |
| D3 | anchor (parent-link) mismatch | a **separate central security-integrity incident**, with a system actor and one bounded operation code; for repair and for first-touch `ensure` |
| D4 | the central write of a denial fails | **best effort**: the refusal stands, local evidence and telemetry are recorded, the limitation is accepted |

Unchanged: contract version 1; user kinds `member`, `owner`, `operator`; outcomes `succeeded`, `denied`; the 56 cataloged actions.

## 2. D1: collapsed `404`

**Proposed action:** `hierarchy.reference_repair_unresolved`.

| Field | Proposed value | Why |
|---|---|---|
| producer, category | `auth-service`, `security` | as batch 1 |
| actor | a verified user of kind `owner` only | only the active Owner reaches step 5 (ADR-0061 §4 steps 1 and 3) |
| outcome | `denied` | the request was refused; it did not fail for an operational reason |
| resource | `company`, `platform` or `organization`: the type and id the caller requested, not verified to exist | the requested target |
| subject | none | |
| `organizationId` | rule `none`: always present and `null` | never places the record in an Organization's scope |
| changes | `reason`: code, required, one value only: `unresolved` | one fixed reason for all three cases |

- **Naming.** The catalog's `<noun>.<operation>_denied` form is taken by the batch 1 denial, which you ruled must not be reused;
  `unresolved` states what the caller learns (the id did not resolve for them) and nothing more. `not_found` is avoided because, for
  another Company's entity, it would state something false in the evidence.
- **Concealment.**
  - The three cases give the same `404`, the same body, the same action, reason and fields; nothing in the record distinguishes them.
  - ADR-0061 §8's accepted timing difference is unchanged; nothing here adds a new signal.
  - **Visibility:** with `organizationId` `null` the record is platform-level. Organization-scoped readers never see it, and an
    Owner's Audit-X read (one Organization of their Company) cannot return it. Only platform readers holding the `security`
    category can, and they already read across Companies by design. The probed Company's own view therefore shows nothing.
- **Behavior preserved:** the step-up stays consumed (step 3 precedes the lookup); no reference row is placed.
- **Write mode:** best effort, as a refusal (D4).

## 3. D2: operational failures

The cases: authority unavailable, timeout, redirect, oversized or malformed answer, credential missing or refused, parent missing at
the authority, placement refused by the database, the success audit intent unwritable (ADR-0061 §5).

- **Response:** `503 hierarchy_unavailable`, unchanged. Any placement transaction rolls back; the step-up stays consumed.
- **No central record:** no `denied` record (that would mislabel an infrastructure failure as an authorization refusal), no new
  `failed` outcome (a production schema change for audit-service, outside AC1) and no new central action.
- **Auth's local failure audit** (`AuditService.tryRecord`, `apps/auth-service/src/audit/audit.service.ts`), outcome `failure`.
  *Proposed:* local type `hierarchy.reference_repair.failed`; metadata `kind` (`company`, `platform`, `organization`) and `reason`
  from a closed list: `authority_unavailable`, `authority_timeout`, `authority_redirect`, `authority_response_invalid`,
  `credential_missing`, `credential_refused`, `parent_missing`, `placement_refused`, `audit_intent_unwritable`; the actor id and target id. The local
  sanitizer already drops credential-like keys and long strings; the key `reason` is used because keys containing `code` are dropped.
- **Structured log:** *proposed* `hierarchy_reference_repair_failed kind=… reason=…` at warning level, ids and reason code only.
- **Metric:** *proposed* a counter through the kit's bounded metrics (`libs/service-kit/src/metrics`), labelled by `kind` only; the
  failure reason stays in the log and the local audit. The kit's label policy (`label-policy.ts`) forbids a `reason` label, and any
  new label name would be a reviewed change to that file. Metrics are off in production until a separately authorized rollout (A12);
  the log is the operational signal until then.
- **Never recorded:** credentials, tokens, upstream response bodies or headers, hostnames, URLs, names, and any authoritative
  hierarchy content.
- **Retry and idempotency:** a client retries with a new step-up; placement is idempotent (`ON CONFLICT DO NOTHING`), so a retry
  after recovery converges, and a repair that had already placed the row answers `placed: false`.
- **ADR wording:** the accepted ADR-0061 §6 recorded every failure "first [through] a new transaction to the central outbox". D2
  **partly supersedes** that requirement through ADR-0064 (2026-10-10): the central step no longer applies, for
  infrastructure failures only. ADR-0061 itself is unchanged; ADR-0064 §4 states the effective rules for implementers.

## 4. D3: anchor mismatch

An anchor is a reference row's immutable parent link (Platform → Company, Organization → Platform). Ids are never reused and parent
links are immutable on both sides by trigger (ADR-0040 decision 1; Auth migration `0001`; organization-service migration `0004`), so a
mismatch is never a legitimate concurrent change: it means a reused id or tampered data.

**Proposed action:** `hierarchy.reference_anchor_mismatch_detected`.

| Field | Proposed value | Why |
|---|---|---|
| producer, category | `auth-service`, `security` | |
| actor | system, process code `hierarchy_anchor_detection` | the detecting process, as the existing incidents (`refresh_reuse_detection`, `webauthn_clone_detection`); the triggering user did not cause it |
| outcome | `denied` | the operation was refused on an integrity ground, as those incidents |
| resource | `platform` or `organization`: the entity whose cached anchor disagreed | a Company has no parent link, so it has no anchor (`hierarchy-reference.ts`, `place`) |
| subject | none | |
| `organizationId` | rule `none`: present and `null` | |
| changes | `operation`: code, required, one of `reference_repair`, `join_code_creation`, `invitation_creation`, `platform_assignment_grant` | the detecting path (the repair route and the three first-touch callers of `ensure`; the fourth caller, `bootstrap-owner`, ensures only a Company, which has no anchor) |

- **Correlation:** the kit envelope's correlation id links the record to the request; nothing else is added.
- **Never included:** either side's parent ids, names or any authoritative hierarchy payload.
- **Behavior preserved:** `503`, fail closed; the cached anchor is never overwritten; the existing error log
  `hierarchy_anchor_mismatch` and its alert rule stay (organization-production runbook §6.3). Neither batch 1 action is written for
  this condition.
- **Write mode:** best effort (ADR-0061 §6: "recorded through the same best-effort failure path"). The placement transaction in which
  the mismatch is detected rolls back; the incident intent is written afterwards in its own transaction, never in the failed one.
- **RED:** recording it from first-touch `ensure` changes existing Auth runtime and is RED-gated, separately from the repair route.

## 5. D4: denial and refusal audit writes

Applies to `hierarchy.reference_repair_denied` and, by the same reasoning, to D1 and D3 records.

- **Best effort.** The central intent is written in its own transaction to Auth's outbox. If that write fails, Auth's local audit
  records the refusal (`tryRecord`, outcome `denied`), then a structured log; the response is the same refusal (`403`, or the
  collapsed `404`) either way. An audit failure never turns a refusal into a success and never changes the status, body or timing
  class of the response.
- **No application retry** of the outbox write: it would delay the response. Once an intent is in the outbox, the kit relay retries
  publication, and audit-service stores each `(sourceService, eventId)` once, so a republished intent is absorbed as a duplicate.
- **Durability limitation, accepted:** if both the outbox write and the local audit write fail, only the log remains, and a refusal
  can go without durable evidence. ADR-0061's acceptance (item 1) already accepts this for failures.
- **Success is different:** `hierarchy.reference_repaired` stays in the same transaction as the placement or the no-op; if its intent
  cannot be written, the transaction rolls back and the request answers `503` (ADR-0050 decision 9; ADR-0061 §4 step 7).
- **Against the precedent:** organization-service writes `hierarchy.admin_operation_denied` fail closed with its `403`
  (`apps/organization-service/src/admin/admin.controller.ts`). D4 differs on purpose for Auth's repair refusals; ADR-0061 states no
  failure mode for refusals, so no ADR wording conflicts. ADR-0064 records it as new policy.

## 6. Consumer-first order and classification

| Step | Class |
|---|---|
| declare `hierarchy.reference_repair_unresolved` and `hierarchy.reference_anchor_mismatch_detected` (AC1 batch 2) | YELLOW: its own development authorization and merge approval |
| deploy an audit-service image carrying all four repair-related actions | DEPLOY, separately authorized; timing to be set with the G6 baseline refresh |
| step-up purpose `hierarchy.reference.repair` (A5.4-A1) | YELLOW, inert |
| resolve/place split (A5.4-A2); repair route and its producers (A5.4-A3) | RED |
| mismatch recording in first-touch `ensure` | RED |
| any emission | only after the audit-service deployment; the repair route has runtime effect only after F6/F7 |

A5.4-G1 lists the reference-repair runtime as RED: closing these decisions does not unblock A2 or A3, which wait for their gate or a
separately approved governance amendment.

## 7. Acceptance criteria for the later work

**Declarations (AC1 batch 2):** the 56 existing entries unchanged; the catalog grows to 58 with exactly the two proposed names;
constants unchanged; each shape validates and the invalid combinations are refused (actor, outcome, organization, reasons and
operation codes outside their lists, subject, extra keys, `steward`); producer-less (*update 2026-10-10, A5.4-A3 O2:* now enforced by
the repository check `checkRepairAuditProducerScope` (`scripts/lib/checks.mjs`, run by `npm run check:repo`), which replaced the library assertion); catalog document regenerated; audit-service's
every-action suites pass.

**D1:** the three `404` cases give byte-identical responses and identical records; `organizationId` `null`; step-up consumed; no
placement; the probed Company's Organization-scoped view and its Owner's Audit-X read show nothing.

**D2:** each failure gives `503` with no placement and the step-up consumed; no central record; one local `failure` record and one log
line with ids and a listed reason only; no secret, URL, upstream body or hierarchy content anywhere.

**D3:** a mismatch in repair and in each first-touch path gives `503`, leaves the cached row unchanged, logs the alert, and writes at
most one incident record with the decided shape; neither batch 1 action is written.

**D4:** with the outbox write failing, a denial still answers its refusal unchanged and leaves a local record; with both failing, a log
line; never a success; a republished intent is stored once.

## 8. Still open

- The exact local audit type, reason list, log line and metric name (§3) are proposals, fixed in the A5.4-A3 design.
- The exact action names and the operation-code list (§2, §4) are fixed by the AC1 batch 2 declaration task.
- `parent_missing` stays an operational failure in this record. **Flagged for later investigation:** a child whose parent the
  authority does not show may indicate an integrity problem at the authority (ADR-0064 §5).
- The governance route for A2 and A3 (F7, or a specific amendment).
- The timing of the audit-service deployment relative to the G6 refresh.

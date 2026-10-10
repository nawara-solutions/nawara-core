# 0064. Reference-repair failure and incident audit

- **Status:** Accepted (2026-10-10, by the architecture owner: A5.4-AC1 batch 2 decisions D1 to D4, recorded in the
  [batch 2 decision record](../architecture/core-v2-a5-4-ac1-batch2-decisions.md); written as a separate ADR at the owner's direction of
  2026-10-10) <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-10-10
- **Deciders:** Anwar (project owner)

> **Partly supersedes [ADR-0061](./0061-auth-hierarchy-reference-repair-and-diagnostics.md)** (Accepted 2026-10-09): **§6 only, and
> only its central-outbox-first step for infrastructure failures** (§3 below). Every other requirement of ADR-0061 stands unchanged:
> repair authority, the repair sequence and step-up consumption (§3, §4), the response rules (§5), same-transaction success audit and the
> rest of §6, lifecycle (§7) and diagnostics. ADR-0061's text is left unchanged; its reciprocal "Partially superseded by ADR-0064"
> marker is a separate, separately authorized step. Until it is added, the [ADR index](./README.md) records the relationship.
>
> **Implements and activates nothing.** No catalog action is declared by this ADR; the two action names below are proposals fixed by a
> separately authorized YELLOW declaration task. Every producer (the repair runtime A5.4-A3, the resolve/place split A5.4-A2, any change
> to first-touch `ensure`) stays RED under A5.4-G1.

## Context

ADR-0061 §6 requires, for every failed repair: "**Failure after rollback:** recorded separately and best-effort — first a new transaction
to the central outbox, then, if that fails, Auth's local audit (`tryRecord`), then a structured log." Its acceptance (item 1) accepted
that failures have no guaranteed durable central evidence. It names central actions for "repair success, repair refusal and anchor
mismatch" but specifies no record for the collapsed `404`, no shape for the mismatch record and no write mode for refusals.

AC1 batch 1 (merged, PR #272) declared `hierarchy.reference_repaired` and `hierarchy.reference_repair_denied`. The audit contract has
two outcomes only (`succeeded`, `denied`), and audit-service enforces them in a database CHECK. An infrastructure failure is neither:
recording it as `denied` would mislabel it as an authorization refusal, and a new `failed` outcome would be a production schema change.

## Options considered

1. **Keep the central-first chain for every failure:** needs a `failed` outcome (a schema change in audit-service) or mislabels
   failures as denials. Rejected.
2. **Infrastructure failures recorded locally only; refusals and the mismatch recorded centrally, best effort (chosen).**
3. **Record nothing centrally for any unsuccessful repair:** loses the accountability of refusals and the security signal of a
   mismatch. Rejected.

## Decision

### 1. The decisions

| # | Decision | Relation to ADR-0061 |
|---|---|---|
| D1 | a collapsed `404` after the step-up is consumed gets its own central action, one fixed reason, no organization, the verified Owner as actor | **new policy**: §6 specified no such record; supersedes nothing |
| D2 | infrastructure failures are recorded through Auth's local audit, a structured log and a bounded metric, with **no central record** | **partial supersession** of §6 (§3 below) |
| D3 | a parent-link (anchor) mismatch gets its own central security-incident action with a system actor and one bounded operation code | **new policy**: §6 named the action, not its shape; supersedes nothing |
| D4 | the central write of a refusal (and of the D1 and D3 records) is best effort | **new policy**: §6 is silent on refusals (its best-effort chain is written for failures after rollback; a refusal precedes any transaction); supersedes nothing |

### 2. Proposed actions (fixed by the declaration task)

| | D1: `hierarchy.reference_repair_unresolved` | D3: `hierarchy.reference_anchor_mismatch_detected` |
|---|---|---|
| producer, category | `auth-service`, `security` | `auth-service`, `security` |
| actor | a verified user of kind `owner` only | system process `hierarchy_anchor_detection` |
| outcome | `denied` | `denied` |
| resource | `company`, `platform` or `organization`: the requested type and id, not verified to exist | `platform` or `organization`: the entity whose cached anchor disagreed (a Company has no anchor) |
| `organizationId` | always present and `null` | always present and `null` |
| changes | `reason`: one value, `unresolved` | `operation`: one of `reference_repair`, `join_code_creation`, `invitation_creation`, `platform_assignment_grant` |

No new outcome, actor kind or contract version. Details, including concealment and visibility: the batch 2 record §2 and §4.

### 3. What is superseded, and what replaces it

- **Original accepted requirement (ADR-0061 §6):** every failed repair is recorded first through a new transaction to the central
  outbox, then Auth's local audit, then a structured log.
- **Superseded, in part:** the first, central-outbox step **for infrastructure failures only**: the `503` cases of ADR-0061 §5 other
  than the parent-link mismatch (authority unavailable, timeout, redirect, oversized or malformed response, Auth's credential missing or
  refused, parent missing at the authority, placement refused by the database, the same-transaction audit intent unwritable).
- **Replacement:** Auth's local audit (outcome `failure`), a structured log and a bounded metric; ids, the actor and a reason code only.
- **Not superseded:** the rest of §6, including the success rule, the mismatch alert, the audit-contract prerequisite, the diagnostics
  and the accepted limitation that failures have no guaranteed durable central evidence.

### 4. Effective audit requirements (ADR-0061 as partly superseded; action names are proposals until declared)

| Case | Response | Central audit | Local evidence |
|---|---|---|---|
| success (placed, or already present) | `200` | `hierarchy.reference_repaired`, **same transaction** as the placement or the no-op; if it cannot be written, everything rolls back and the answer is `503` | – |
| refusal with a verified user (no authority; missing or invalid step-up) | `403` | `hierarchy.reference_repair_denied`, **best effort**, its own transaction | Auth local audit (`denied`), then a structured log, if the central write fails |
| collapsed `404` after the step-up is consumed | `404` | D1 action, **best effort** | as for a refusal |
| parent-link mismatch (repair and first-touch `ensure`) | `503` | D3 action, **best effort**, written after the failed transaction rolls back | as for a refusal; the alert log stays |
| infrastructure failure (§3) | `503` | **none**: no `denied` record, no new outcome | Auth local audit (`failure`), a structured log and a bounded metric |
| refused before step 3 without a verified user, `400`, `429`, the `local`-mode `404` | unchanged | none | unchanged |

- Every row reached after step 3 keeps the step-up consumed (ADR-0061 §5); the rows refused before it consume nothing.
- A central write failure never changes a response: a refusal stays a refusal, a `503` stays a `503`, and the collapse of ADR-0061 §5
  holds. There is no application retry of an outbox write; the kit relay retries publication, and audit-service stores each
  `(sourceService, eventId)` once.
- Nothing recorded centrally, locally or in logs carries credentials, tokens, upstream bodies or headers, URLs or authoritative
  hierarchy content.

### 5. Flag for later investigation: `parent_missing`

"Parent missing at the authority" is classified as an infrastructure failure, as ADR-0061 §5 groups it with operational `503`s and names
only the parent-link mismatch a security event. It may also indicate an integrity problem at the authority (a child whose parent the
authority does not show). That classification is **flagged for later investigation**; this ADR does not change it.

### 6. Relationships

- [ADR-0061](./0061-auth-hierarchy-reference-repair-and-diagnostics.md): partly superseded (§3 only); otherwise unchanged.
- [ADR-0050](./0050-platform-administration-and-verified-human-authority.md) decision 9 (same-transaction audit of mutations):
  preserved; the success rule is unchanged, and failures are not mutations.
- [ADR-0049](./0049-audit-trail-architecture.md): preserved; no outcome, actor kind or contract version is added.
- [ADR-0040](./0040-organization-ownership-migration-decisions.md) decision 1 and gate G4 (anchor alert): preserved.
- [ADR-0063](./0063-post-f7-authority-mode-cli-and-recovery-convergence.md) §7 (the diagnostic): unaffected.

## Consequences

- **Easier:** infrastructure failures need no audit-contract or schema change; refusals and integrity incidents keep central
  accountability; implementers have one effective table (§4).
- **Harder or given up:** infrastructure failures leave no central record; a refusal's central record can be lost when both the outbox
  and the local audit writes fail.
- **Follow-up (each separately authorized):** the AC1 batch 2 declarations (YELLOW); ADR-0061's reciprocal supersession marker; the
  exact local audit type, reason list, log line and metric in the A5.4-A3 design; the `parent_missing` investigation.

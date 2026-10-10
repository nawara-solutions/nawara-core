# Core V2 A5.4-AC1: reference-repair audit contract (decision record)

- **Status:** DECIDED (2026-10-10) by the architecture owner, for the first producer-less batch of ADR-0061 audit actions. This is a
  documentation record: **the contract library is not changed by it**, and it authorizes no implementation, merge or deployment.
- **Class.** A5.4-AC1 is **YELLOW** under the Accepted A5.4-G1 governance ([A5 record](core-v2-a5-organization.md) §9.1): additive,
  producer-less audit-contract declarations. A5.4-AS1 (the `steward` user kind and audit-service's database CHECK) stays **RED**.
- **Authority.** [ADR-0061](../adr/0061-auth-hierarchy-reference-repair-and-diagnostics.md) §4 to §6 govern the repair and its audit;
  [ADR-0049](../adr/0049-audit-trail-architecture.md) governs the contract, with its catalog rules (A7, A11, A13, A50) recorded in the
  [Stage 18.1 decisions](stage-18/stage-18-1-decisions-and-roadmap.md); [ADR-0050](../adr/0050-platform-administration-and-verified-human-authority.md)
  decision 9 governs same-transaction audit. Where this record and an Accepted ADR differ, the ADR governs.
- **Context:** the [A5.4-D1 specification](core-v2-a5-4-implementation-specifications.md) §5.4 and §7.1.

## 1. What does not change

The contract stays at **version 1**. No actor kind (`member`, `owner`, `operator`), outcome (`succeeded`, `denied`), actor type,
category or producer is added, and **none of the 54 existing actions is edited, renamed or removed**. The library's `contract.ts`,
`validate.ts` and `screen.ts` are not touched by AC1. The AC1 implementation touches only `catalog.ts`, the regenerated
`docs/architecture/audit-event-catalog.md`, and tests (including the hard-coded action counts of §6); the test helper
`testing.ts` needs no change.

## 2. The accepted contract (two actions)

| | `hierarchy.reference_repaired` | `hierarchy.reference_repair_denied` |
|---|---|---|
| Producer | `auth-service` | `auth-service` |
| Category | `security` | `security` |
| Actor | a verified user of kind `owner` only | a verified user of kind `member`, `owner` or `operator` |
| Outcome | `succeeded` | `denied` |
| Resource type | `company`, `platform` or `organization` (the requested entity, by its UUID) | the same |
| Subject | none | none |
| `organizationId` | the resource id when the resource is an Organization; `null` for a Company or a Platform (the catalog's existing `resource` rule) | always `null` (the existing `none` rule) |
| Changes | `placed`: boolean, required | `reason`: code, required, one of `no_authority`, `step_up_required` |
| Purpose | the active Company Owner repaired a hierarchy reference in Auth: a validated reference row was placed, or it was already present | a verified user was refused a reference repair: no authority, or no valid fresh step-up |

- **One success action for placement and no-op.** ADR-0061 §4 step 7 audits an already-present reference "the same way, recording
  that nothing was placed": `placed: true` or `placed: false`.
- **The denial reveals nothing about another Company.** It carries no organization (the field is present and `null`, as the validator
  requires), only the resource type and id the caller requested (the id is not verified to exist), the actor and one of two reasons. Neither reason depends on whether the id
  exists or where.
- **What the denial covers.** The refusals of ADR-0061 §5's first row that have a verified user: not the active Owner
  (`no_authority`), and a missing or invalid step-up (`step_up_required`). An unauthenticated request has no verified actor and is not
  centrally audited, as for `hierarchy.admin_operation_denied`. A malformed identifier (`400`) and a rate-limit refusal (`429`) are not
  authorization refusals and are not mapped.
- **Fit with the current validator, checked against the code:** the `resource` and `none` organization rules exist; the reason values
  match the code grammar and already appear in `hierarchy.admin_operation_denied`; a boolean change of shape `value` exists; both names
  follow the action grammar and are under the length limit.

## 3. Transaction ordering

- **Success:** the central audit intent is written in the **same transaction** as the placement or the no-op (ADR-0050 decision 9;
  ADR-0061 §4 step 7, §6). If it cannot be written, the transaction rolls back and the request answers `503`. The step-up was consumed
  earlier in its own committed transaction, so a rollback neither restores it nor leaves a success record.
- **Denial:** a denial happens before the step-up is consumed, so there is nothing to roll back. **The write mechanism and its
  failure mode are not decided here:** ADR-0061 §6 specifies none for refusals, and the existing precedent,
  `hierarchy.admin_operation_denied` in organization-service, writes the record with the `403` and fails the request if it cannot
  (`apps/organization-service/src/admin/admin.controller.ts`). Best effort or fail closed is decided with A5.4-A3 (§8).

## 4. Consumer-first ordering

1. The catalog declares the two actions (AC1, YELLOW): a separately authorized development task, then a separately approved merge.
2. An audit-service image containing them is deployed to production (**DEPLOY**, separately authorized). Production runs an image
   that predates the immutable builds, which the deploy workflow refuses, so this needs a first digest deployment of audit-service.
3. Only then may Auth emit them, as part of the repair runtime (A5.4-A3, **RED**, behind its own gates and F6/F7).

An action that reached the older audit-service would be refused as unknown and kept in its dead-letter queue for replay after the
upgrade (ADR-0049 A50); this is a safety net, not a substitute for the order above.

## 5. ADR-0061 compliance and what stays open

ADR-0061 §6 requires central actions for "repair success, repair refusal and anchor mismatch", and best-effort recording of failed
repairs: **first a new transaction to the central outbox**, then Auth's local audit, then a structured log. Its acceptance (item 1)
accepts that failures have no guaranteed durable central evidence; it does not make Auth's local audit or a log the intended first
channel.

This batch covers success and the authorization refusals. It does **not** cover:

| Case | Status |
|---|---|
| collapsed `404` after the step-up is consumed (nonexistent, outside Auth's scope, another Company) | **OPEN.** Not mapped to the denial action in AC1. Its central best-effort record needs its own contract decision; a single reason that never distinguishes the three cases would be required (ADR-0061 §5, §8) |
| operational failure (`503`: authority unavailable or malformed, parent missing, placement refused, intent unwritable) | **OPEN.** Neither existing outcome fits: `denied` would mislabel it as an authorization refusal, and a new outcome would change audit-service's database CHECK (outside AC1) |
| anchor (parent-link) mismatch, in repair and in first-touch `ensure` | **OPEN.** A security event; the actor (the triggering user, who may be an Owner, an Operator or an Organization administrator of kind `member`, or a process code as in the existing incident actions) is not decided |

**No conflict with ADR-0061 today.** ADR-0061 requires these records of the **repair runtime**, and its acceptance item 2 blocks any
implementation or activation until "the audit contract and the production Audit Service … support the repair actions". Deferring
them from AC1 therefore weakens nothing, provided that **A5.4-A3 (the repair runtime) and any ADR-0061 mismatch or failure recording,
including in first-touch `ensure`, are not implemented or activated until the three open cases have a central contract or an explicit
owner decision**. A log alone, or Auth's local audit alone, does not satisfy the
central-audit design of ADR-0061 §6.

## 6. Tests required of the AC1 implementation

| # | Test | Proves |
|---|---|---|
| 1 | every one of the 54 existing entries deep-equal to its state on `main`; the catalog has exactly 56 actions, the two new names being the only additions | no existing entry changed |
| 2 | `USER_KINDS`, `AUDIT_OUTCOMES`, `ACTOR_TYPES`, `AUDIT_CATEGORIES`, `CORE_PRODUCERS`, `AUDIT_CONTRACT_VERSION` and `SUPPORTED_AUDIT_VERSIONS` equal their values on `main` | constants and version unchanged |
| 3 | a success event validates with `placed: true` and with `placed: false`, for each resource type, with the organization rule applied; the Organization case is a hand-built payload, because the sample helper uses the first resource type | success contract |
| 4 | a denial validates for each of `member`, `owner`, `operator` and each of the two reasons, with `organizationId: null` | denial contract |
| 5 | refused: success by a `member`, `operator`, service or system actor; success with outcome `denied`, without `placed`, or with a non-null organization on a Company or Platform; denial with outcome `succeeded`, a reason outside the two, or a non-null organization; either with a subject, an unknown change key, or a `steward` kind | invalid combinations |
| 6 | no file under `apps/` references either name | producer-less |
| 7 | the regenerated `docs/architecture/audit-event-catalog.md` equals the rendered catalog (the existing test) | catalog document |
| 8 | audit-service's existing suites, which iterate over every cataloged action, pass with the two new ones: the mapper unit test, the contract-persistence e2e (minimal and complete events persisted against the real schema, so the database CHECKs accept them) and the broker ingestion e2e; plus the query filter by a new action | consumer compatibility |
| 9 | the existing `validate`, `adversarial` and `dead-letter-screen` suites pass unchanged; `catalog-corrections.spec.ts` (`toHaveLength(54)`) and audit-service's `ingestion-broker.e2e-spec.ts` (53 bus actions, 24 for auth-service, and its test title) are updated **as counts only** (to 56, 55 and 26); auth-service and organization-service build and pass; `npm run check:repo`; full Core CI | no change to existing event behavior |

**What a merge would change.** The library is built into the auth-service, organization-service and audit-service images. For every
existing event their behavior is identical (tests 1, 2, 9). An audit-service built from the merge additionally accepts the two new
actions at ingestion and as a query filter: that is the intended consumer-first change, and it takes effect only through the separately
authorized deployment of §4.

## 7. Prerequisites for a merge (framework, not authorization)

- A separately authorized YELLOW development task (the change above, with the tests of §6).
- Evidence that no deployed image's behavior changes (tests 1, 2, 8, 9).
- The approved image-pinning policy: the **accepted certified digest-set policy** (A5.4-G1 item 3) is that framework. It authorizes no
  specific merge, digest selection or deployment.
- An explicit merge approval.

## 8. Open decisions

- The central audit contract for the collapsed `404`, for operational failures and for anchor mismatch (§5); they block A5.4-A3 and any
  ADR-0061 failure or mismatch recording, not AC1.
- The denial's write mechanism and failure mode, best effort or fail closed (§3); decided with A5.4-A3.
- Whether a `failed` outcome is ever wanted (a database change; not AC1).
- The later AC1 batches: Owner transfer (names), lifecycle (after OD-L6), an Owner-bootstrap action (ADR-0062 §9).
- Steward actions and the `steward` kind: A5.4-AS1, RED, after OD-S1.

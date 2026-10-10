# 0065. Reference repair: pre-F7 development order and repair step-up consumption

- **Status:** Accepted (2026-10-10, by the architecture owner: formal acceptance of ADR-0065 and A5 §9.3, with the three clarifications recorded in the acceptance note below) <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-10-10
- **Deciders:** Anwar (project owner)

> **Acceptance note (2026-10-10, architecture-owner acceptance).** The owner accepted this ADR. The Proposed-era note below and the
> body are kept unchanged as history; where they say "Proposed", "if accepted" or "nothing in it is in force", this note governs.
> **Acceptance implements and authorizes nothing:** no A2 or A3 development, commit, pull request, merge, deployment, audit emission or
> activation; each stays separately authorized (§1; [A5 record](../architecture/core-v2-a5-organization.md) §9.3). The owner confirmed
> three clarifications:
> 1. **Uncertain consumption outcome (§5).** If the outcome of the consume transaction is unknown, including a connection lost at or
>    after commit, Auth answers `503`, performs no hierarchy lookup and no reference placement, does not assume the proof remains
>    available, and does not automatically retry the consume with the same proof. The database-enforced single-use semantics are
>    preserved: a proof is consumed at most once, by the atomic statement. A confirmed invalid, expired, consumed, wrong-Owner,
>    wrong-session, wrong-purpose or wrong-method proof keeps the documented `403`. A repair that fails after an acknowledged consumption never restores
>    the consumed proof.
> 2. **S1 clarifies ADR-0042 Amendment 1 A.1 (§4); it does not partly supersede it.** The Auth-local reference-repair purpose is
>    excluded from the generic service-facing verification path and keeps every A.1 property: single use, session binding, purpose
>    binding, short lifetime, server-generated proof. No existing step-up contract for any other purpose changes. (§4's offer of a
>    partial-supersession alternative is closed by this choice.)
> 3. **No central repair audit while Auth's source is `local`.** While `AUTH_HIERARCHY_SOURCE` is `local`, the reference-repair route
>    emits no new central repair-audit action: no success record and no denial record, **including for a non-Owner request refused with
>    `403`**. This holds when the implementation is merged but not activated. Existing, unrelated audit producers are unchanged, and the
>    rule does not permit omitting separately required local diagnostics or existing security records.
>
> **Relationships now in effect.** This ADR partly supersedes [ADR-0061](./0061-auth-hierarchy-reference-repair-and-diagnostics.md) (the
> scope of §3 only) and clarifies [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md) Amendment 1 A.1; both carry
> a dated reciprocal note. It extends the infrastructure-failure cases of
> [ADR-0064](./0064-reference-repair-failure-and-incident-audit.md) (§5) and supersedes nothing there. Clarification 3 is a
> mode-conditional restriction: while `AUTH_HIERARCHY_SOURCE` is `local`, ADR-0064 §4's refusal row
> (`hierarchy.reference_repair_denied`, best effort) is not emitted, consistent with that table's `local`-mode `404` entry; the row is
> unchanged and applies in the Organization-authoritative mode.

> **Proposed; nothing in it is in force.** The architecture owner agreed in principle (2026-10-10) with the directions recorded below
> (C1-a, S1, S2, and `503` for a failed consumption). That agreement authorized this documentation only: it does not accept this ADR,
> accept the A5.4-G1 exception it supports ([A5 record](../architecture/core-v2-a5-organization.md) §9.3), authorize any development,
> merge, deployment, emission or activation, or change ADR-0061 or ADR-0042.
>
> **If accepted, partly supersedes [ADR-0061](./0061-auth-hierarchy-reference-repair-and-diagnostics.md)**: only the implementation-order
> condition of its acceptance note item 2, and only for local implementation and merge (§3). **If accepted, clarifies
> [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md) Amendment 1 A.1** (the step-up verification path): one
> Auth-local purpose is excluded from service verification (§4). ADR-0061 and ADR-0042 are not edited; their reciprocal markers would be
> separate steps.

## Context

ADR-0061's acceptance note, item 2, says: "**Before any implementation or activation:** the audit contract and the production Audit
Service must support the repair actions through separately authorized consumer-first changes; `ensure` must be safely split into resolve
and place; security, concurrency, audit and failure-path tests must pass; and the F6/F7 authority prerequisites must be met."

Read literally, no repair code may be written before the production audit-service is deployed with the repair actions and F6/F7 have
completed. Separately, ADR-0061's status block and its §10 heading keep "runtime effect" blocked until F6/F7. The proposed A5.4-G1 exception (§9.3) would allow dormant A2/A3 code to be developed and merged before F7, so G6 can rehearse
it. Accepted ADRs are immutable ([ADR index](./README.md)): permitting that order needs a new ADR, not a reading of the old one.

Two security points of the repair runtime are also undecided by ADR-0061: whether the generic `POST /auth/step-up/verify` may consume a
repair proof (today it can consume any listed purpose), and how the repair consumes its proof so that it is committed before any lookup
(ADR-0061 §4 step 3; Auth's existing `consume()` runs in the caller's transaction and is undone on rollback).

## Options considered

1. **Keep the literal order (C1-b):** no A3 merge before the audit-service deployment, no A3 code before F6/F7. Safe, but repair cannot
   be rehearsed in G6 and waits for the whole production track.
2. **Narrow exception for local implementation and merge only (C1-a, chosen if accepted)**, every other condition kept.
3. **Drop the ordering condition entirely.** Rejected: production emission and activation must stay behind the consumer and F6/F7.

## Decision (if accepted)

### 1. Five stages, each separately authorized

| Stage | Before this ADR | With this ADR |
|---|---|---|
| 1. local implementation | blocked by ADR-0061 acceptance item 2 | allowed, under the A5.4-G1 §9.3 exception and its own authorization |
| 2. merge into `main` | blocked | allowed, under its own RED-exception merge approval and the G6 timing rule of §9.3 |
| 3. production deployment of an image containing the code | blocked | **unchanged**: separately authorized, through the certified digest set |
| 4. production audit emission | blocked until the audit-service supports the actions | **unchanged**: only after an audit-service deployment declaring all four repair actions |
| 5. F6/F7 activation | blocked until F6/F7 | **unchanged**: only with Auth's source `organization-service` after F6/F7 |

No stage authorizes the next.

### 2. The conditions of ADR-0061 acceptance item 2, stage by stage

| Condition of item 2 | Stages 1 and 2 (local implementation, merge) | Stages 3 to 5 (deployment, emission, activation) |
|---|---|---|
| the audit contract supports the repair actions | met (declared, PRs #272 and #274) | required |
| the **production Audit Service** supports them (consumer-first deployment) | **lifted** for these stages | **required**, unchanged: before any deployment of the repair runtime that could emit, and before activation |
| `ensure` safely split into resolve and place | **required** (the split is A2, done first) | required |
| security, concurrency, audit and failure-path tests pass | **required** | required |
| the F6/F7 authority prerequisites | **lifted** for these stages | **required**, unchanged |

### 3. Superseded scope

Only this: in ADR-0061 acceptance item 2, the "before any implementation" **timing** of two conditions (the production Audit Service
deployment and the F6/F7 prerequisites) no longer applies to **local implementation (stage 1) and merge (stage 2)** of the dormant repair
runtime under an accepted A5.4-G1 exception. Every condition of item 2 still applies to stages 3 to 5, and the split and the tests also
apply to stages 1 and 2. ADR-0061's "runtime effect … blocked until F6/F7" (its status block and §10) is unchanged and governs stages 3
to 5; dormant code with Auth's source `local` has no runtime effect. Nothing else in ADR-0061, or in ADR-0064, changes.

### 4. S1: generic step-up verification refuses the repair purpose

- `POST /auth/step-up/verify` refuses the purpose `hierarchy.reference.repair` **before any consuming statement**, so the proof stays
  unconsumed and usable by the repair route.
- **Answer:** the endpoint's existing refusal, `403 step_up_required`, the same answer it gives today for an unknown purpose, a wrong
  purpose or an invalid proof (`StepUpService.consume`), so the refusal reveals nothing new. It writes the same local denial record as
  those refusals.
- **Unchanged:** every other purpose and its behavior; the endpoint's authentication (`401` without a bearer); service authentication.
- **Relation to ADR-0042 Amendment 1 A.1:** a **clarification**. A.1 defines this endpoint as validating and consuming a proof "for the
  session and purpose" and names no list of purposes; the repair purpose did not exist when A.1 was written, and no existing consumer is
  affected. This ADR narrows the endpoint for that one Auth-local purpose. If the owner prefers, it can instead be recorded as a narrow
  partial supersession of A.1; the effect is the same.
- **Documentation follow-up (with the RED A3 change that implements S1):** the endpoint's API description, a dated note on ADR-0042, and
  the comment on the purpose in `apps/auth-service/src/owner/step-up.service.ts`, which today says the generic verify can still consume it.

### 5. S2: dedicated repair consumption

Used only by the repair route; Auth's existing `consume()` stays unchanged for every other purpose.

- **One atomic statement** that consumes the proof only if, at that moment, it belongs to this Owner and this session, has this purpose,
  is unused and unexpired, **and its method is allowed for the purpose**. A proof that fails any of these is not consumed.
- **Its own transaction, committed before any hierarchy lookup** (ADR-0061 §4 step 3). A later `404`, `503` or placement rollback never
  restores it.
- **Concurrency:** of two requests presenting the same proof, exactly one consumes it.
- **Outcomes:**

  | Situation | Answer | Lookup | Evidence |
  |---|---|---|---|
  | proof missing, invalid, expired, already used, wrong Owner, session, purpose or method | `403 step_up_required` | none | the refusal row of ADR-0064 §4 (`hierarchy.reference_repair_denied`, best effort) |
  | consumption **confirmed committed** | continue | yes | – |
  | the consume transaction **confirmed failed** (rolled back) | `503 hierarchy_unavailable` | none | ADR-0064 infrastructure-failure evidence: Auth local audit (`failure`), log, metric; no central record |
  | the outcome is **uncertain** (for example the connection lost at commit) | `503 hierarchy_unavailable` (fail closed) | none | bounded local evidence as above, with a distinct reason code |

  The "confirmed failed" and "uncertain" rows are **new infrastructure cases**: they are added to the infrastructure failures of ADR-0064
  §3 (and to the `503` rows of ADR-0061 §5), and ADR-0064 §4's infrastructure row applies to them. This extends those lists; it
  supersedes nothing.

- **An uncertain outcome is not proof of consumption, and not proof of its absence.** Auth never proceeds on it and never retries the
  consumption. If the client re-presents the same proof in a new request, that request's atomic statement decides: a proof already
  consumed is refused (`403`), one not consumed may be consumed then. The client may instead obtain a fresh proof.
- **No new endpoint behavior beyond the repair route and S1.** Both are part of the RED A3 change and need its separate authorization.

### 6. Unchanged protections

No first-touch mismatch recording; no new production hierarchy authority; no source or marker change; no migration or
organization-service change; no deployment or emission authorization; no G6, G7, F6 or F7 bypass; A2 and A3 independently authorized; no
automatic advancement between stages.

## Consequences

- **Easier (if accepted):** dormant repair code can be in the certified digest set and rehearsed in G6; the repair proof cannot be
  burned by a calling service; consumption semantics are fixed before implementation.
- **Harder or given up:** repository code exists before its consumer is deployed (mitigated by stages 3 to 5 staying gated and the
  route being inert with source `local`); the generic verification endpoint gains one refused purpose.
- **Follow-up (each separately authorized):** acceptance of this ADR and of §9.3; the reciprocal markers in ADR-0061 and ADR-0042; the S1
  documentation follow-up; then A2 and A3 under their own authorizations.

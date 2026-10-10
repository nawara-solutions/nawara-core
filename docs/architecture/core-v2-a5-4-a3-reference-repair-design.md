# Core V2 A5.4-A3: reference repair route with S1 and S2 (design and test plan)

- **Status:** DESIGN AND TEST PLAN (2026-10-10), on `main` at `d5a8cbb` (the PR #279 merge). Documentation only: the first of the
  seven separate authorizations of the accepted A2/A3 exception ([A5 record](core-v2-a5-organization.md) §9.3, A.2 item 1). **It
  authorizes no code, test, commit of code, pull request, merge, deployment, audit emission or activation.** Local A3 development is a
  separate authorization (A.2 item 3) and must not start while a blocking decision of §11 is open.
- **Implementation status (2026-10-10): IMPLEMENTED LOCALLY, NOT MERGED (§11.7).** Slices A to D exist as four local commits on the
  branch `feature/core-v2-a5-4-a3-reference-repair`, under authorizations 3 and 4 of §9.3 A.2. They are not pushed, not in a pull
  request, not merged, not deployed and not activated; A3 is not certified by CI and the RED-exception merge conditions are not met.
- **Owner rulings (2026-10-10):** the seven blocking decisions O1, O2, O3, O4, O5, O11 and O12 are **ruled** (§11.1). The rulings
  are documentation: they implement nothing and authorize no development. **A3 stays blocked** until the O2 prerequisite task is
  merged, the remaining prerequisites of §11.2 are met and local A3 development is separately authorized.
- **Owner rulings (2026-10-10), second set:** the names and file boundaries of **O10** are ruled, and the O2 prerequisite task is
  classified **GREEN with two additional merge conditions** (§11.3). Documentation only: neither O2 nor A3 is implemented or
  authorized by it.
- **Owner rulings (2026-10-10), third set:** the remaining decisions are recorded in §11.5: O6, O9, O13, O14 and O15, the
  cached-Platform classification and the local diagnostics. For O7 the metric is deferred for local implementation, merge and the
  deployment of inert code, and it is **not waived for activation**; O8 is ruled with the conservative fallback and must be shown
  by tests; an unreadable marker answers `503 hierarchy_unavailable`. §11.5 also corrects this document's earlier statement about
  the authority marker.
  Documentation only: A3 development is not authorized.
- **Owner rulings (2026-10-10), fourth set:** the contract points of the repair service (slice C of the implementation) are
  recorded in §11.6: records for a refused non-Owner in each source and marker state (C2), a cached and authorized target under marker
  `frozen` (C3), the final evidence policy for every outcome under `frozen`, three narrow test-file permissions for the slice C change (C1, C4), and the correction of test TA8 (C5).
  Documentation only: slice C development is not authorized by it.
- **Class.** A5.4-A3 is **RED**, permitted only inside §9.3's narrow exception.
- **Authority.** [ADR-0061](../adr/0061-auth-hierarchy-reference-repair-and-diagnostics.md) as partly superseded by
  [ADR-0064](../adr/0064-reference-repair-failure-and-incident-audit.md) and
  [ADR-0065](../adr/0065-reference-repair-pre-f7-development-and-step-up-consumption.md);
  [ADR-0042](../adr/0042-service-token-scopes-and-administrative-authorization.md) Amendment 1 A.1 as clarified by ADR-0065;
  [ADR-0050](../adr/0050-platform-administration-and-verified-human-authority.md) decisions 7, 8, 9 and 14;
  [ADR-0040](../adr/0040-organization-ownership-migration-decisions.md) decisions 1 and 2; §9.1 (A5.4-G1) and §9.3 of the A5 record.
  Where this document differs from them, they govern. **This document decides nothing that they leave open**: every such point is
  listed in §11 with alternatives and a recommendation for the architecture owner.
- **Context:** the [A5.4-D1 specification](core-v2-a5-4-implementation-specifications.md) §5; the
  [A2 design](core-v2-a5-4-a2-ensure-split-design.md) and its merged implementation (PR #279); the audit contracts of the
  [AC1 batch 1](core-v2-a5-4-ac1-repair-audit-contract.md) and [batch 2](core-v2-a5-4-ac1-batch2-decisions.md) records.
- **Labels.** *DECIDED* cites the accepted text. *PROPOSED* is this document's proposal inside what the ADRs leave to the A3 design.
  *OPEN* needs an owner decision (§11).

## 1. Scope

A3 adds one Owner-only repair operation to Auth, the restriction of the generic step-up verification for one purpose (S1), and the
dedicated proof consumption the repair uses (S2).

| In A3 (§9.3 A.1) | Not in A3 |
|---|---|
| the repair route and its service (ADR-0061 §4, §5) | recording an anchor mismatch from first-touch `ensure` (a separate RED decision) |
| S1 and S2 (ADR-0065 §4, §5) | any change to `StepUpService.consume` or to another purpose |
| the producers of the four repair actions, **for the repair path only** | any audit-catalog, `libs/service-kit` or `libs/audit-contract` change |
| one A5.4-T1 allow-list entry, for the repair operation | any other T1 entry |
| focused security and integration tests | any migration, schema, marker or source change; any organization-service change |
| the S1 documentation follow-up (ADR-0065 §4) | the diagnostic CLI (A5.4-A4); lifecycle; owner transfer |

A3 is developed, committed and merged separately from A2 (already merged) and from everything else.

## 2. Current state (read on `d5a8cbb`)

- **The split exists.** `HierarchyReference.ensure` (`apps/auth-service/src/hierarchy/hierarchy-reference.ts`) calls a private,
  read-only `resolve` and a private `placeChain`. Neither is reachable from another class. `ensure` stops at the first cached ancestor
  and never compares a cached ancestor with the authority.
- **The client hides its failure reason.** `OrganizationDirectoryClient.get` logs a reason (`timeout`, `network`, `status_<n>`,
  `not_authoritative`, `redirect_refused`, `oversized`, `malformed`) and throws one uniform `503 hierarchy_unavailable`. `place` logs
  `hierarchy_anchor_mismatch` and throws the same `503`. A caller cannot tell these cases apart today.
- **Authentication.** `AuthGuard` answers `401` for a missing or invalid bearer, an inactive user or an inactive session, and `403`
  when the route's `@Actors(...)` list does not include the user's kind. It writes no record.
- **Step-up.** `STEP_UP_METHODS` lists `hierarchy.reference.repair` as `['totp', 'webauthn']` (A5.4-A1). `StepUpService.consume` runs
  in the caller's transaction, checks the method **after** the consuming statement, and on refusal writes a local
  `owner.step_up.consume` `denied` record. `POST /auth/step-up/verify` (`auth.controller.ts`) calls it for any listed purpose, so a
  service can burn a repair proof today.
- **Existing tests that state today's behavior.** `test/reference-repair-step-up.e2e-spec.ts` asserts that the generic endpoint
  consumes a repair proof exactly once, and uses that endpoint for its binding tests; `src/owner/step-up-purposes.spec.ts` asserts that
  no application source outside an allow-list names the purpose. The first necessarily changes with A3 (ruled: §11.1, O1); the second is expected to stay
  unchanged, because the purpose literal is kept inside `step-up.service.ts` (§11.3).
- **Where the "producer-less" tests live.** `libs/audit-contract/test/reference-repair-catalog.spec.ts` and
  `reference-repair-batch2.spec.ts` each assert that no source file under `apps/` names the repair actions (the batch 2 test also covers `libs/` outside the contract
  library). They are test files of
  the shared library: excluded from the images (`.dockerignore`), but under `libs/audit-contract/**`, a path that triggers the image
  builds of all three services. Any producer in Auth makes them fail (ruled: §11.1, O2).
  *Update (2026-10-10, the O2 task):* the two assertions are relocated, in one change, into the repository check `checkRepairAuditProducerScope` (`scripts/lib/checks.mjs`, run by `npm run check:repo`);
  see §11.4. The description above is the state this document was written on.
- **Audit.** The four repair actions are declared and producer-less (catalog of 58 actions, contract version 1). Auth writes central
  intents through `CentralAudit.write(q, …)` inside a transaction, and local records through `AuditService.record` / `tryRecord`
  (`auth_audit_event`; the type must match `^[a-z_]+(\.[a-z_]+)+$`, so a new local type needs no migration).
- **Rate limiting.** `ThrottleService.hit(bucket, raw)` writes `auth_throttle`; buckets are configuration (`RateBucket`), and the
  table accepts any name matching `^[a-z_.]+$`.
- **Production** Auth runs with source `local`. Production audit-service predates the four actions.

## 3. API contract and authorization

### 3.1 Route — path and names RULED (§11.3, O10); the semantics are DECIDED

`POST /auth/admin/hierarchy-references/{kind}/{id}/repair` (the OpenAPI form of `:kind/:id`, §11.3), with the Owner's bearer and the header `x-step-up-token`.

- `kind` is `platform` or `organization` only (ADR-0061 §3: "for platforms and organizations"). A Company is placed only as the parent
  of a repaired Platform. The catalog's `company` resource type stays unused by A3.
- No request body. Nothing the client sends states a Company, an owner, a role or an authorization result.
- **`200`** body: `{ "kind": "<kind>", "id": "<id>", "placed": <boolean> }` and nothing else (ADR-0061 §4 step 8). ADR-0061 says "whether a row was placed"; its
  meaning is ruled (§11.5, O13): `true` only when this request inserted the **target's** row; `false` when that row already
  existed (cached, or placed by a concurrent request), including when this request inserted only a missing parent.
- Errors use Auth's existing codes only: `unauthenticated` (`401`), `forbidden` and `step_up_required` (`403`), `validation_error`
  (`400`), `rate_limited` (`429`), `not_found` (`404`), `hierarchy_unavailable` (`503`). **No new error code.**
- OpenAPI: `@ApiOperation`, `@ApiResponse` for each status, `@ApiHeader` for the proof, as the repository convention requires.

### 3.2 Who may call it — DECIDED

Only the active Company Owner, with a fresh factor-only proof for `hierarchy.reference.repair` (ADR-0061 §3). No Operator, Member,
Organization administrator, recovery steward, service token or vendor authority. The capability is Auth's own (ADR-0050 decision 7);
it adds no second owner, no shared admin database (decision 8) and no privileged recovery tool (decision 14).

### 3.3 Order of checks — DECIDED, with one implementation consequence

| Step | Check | Refusal | Source |
|---|---|---|---|
| 1a | valid bearer, active user, active session | `401` | ADR-0061 §4 step 1; `AuthGuard` |
| 1b | the user is the Owner | `403 forbidden` | ADR-0061 §5; §9.3 A.4 ("a non-Owner `403`, before anything else") |
| 1c | Auth's source is `organization-service` **and** the authority marker is `org_authoritative` (§11.5, O15) | collapsed `404`, the route does nothing more (a missing or unreadable marker: `503 hierarchy_unavailable`, §11.5) | ADR-0061 §4 step 1 and its last paragraph, as clarified 2026-10-10 |
| 2a | `kind` and `id` are well formed | `400` | ADR-0061 §4 step 2 |
| 2b | per-actor and per-address rate limits | `429` | ADR-0061 §4 step 2 |
| 3 | consume the proof (S2, §6) | `403 step_up_required`, or `503` | ADR-0061 §4 step 3; ADR-0065 §5 |
| 4 to 8 | resolve, authorize, place, audit, respond (§4) | `404`, `503` | ADR-0061 §4 |

**The order is DECIDED; the mechanism that achieves it is RULED (§11.1, O11): the repair service performs the checks.** Steps 1b and 1c come before validation, and a refused
non-Owner needs a central record in the Organization-authoritative mode (ADR-0064 §4). Nest runs guards, then pipes, then the handler,
so a plain `@Actors('owner')` guard with a `ParseUUIDPipe` gives neither the record nor the order. With
source `local` an Owner gets the collapsed `404` even for a malformed id or a missing proof, and nothing is validated, counted or
consumed.

**"The Owner" (PROPOSED reading of "active Company Owner", ADR-0061 §3):** a user of kind `owner` that the guard accepts as active,
with an `owner` row giving its Company. A user of kind `owner` without such a row is refused `403` as having no authority; the repair
must not reuse `AssignmentService.ownerCompany`'s `404` for that case. ADR-0059's owner lifecycle is not implemented; when it is, this
check follows it.

**A refusal the central record cannot describe** (a non-Owner, or a missing proof, with a malformed id or an unknown `kind`): the
denial action needs a resource type and a UUID. What is recorded then is RULED (§11.1, O3): the local denial record only.

The Owner's Company is read from the `owner` row of the authenticated user.

## 4. Sequence and transaction boundaries (steps 4 to 8)

| Step | What happens | Transaction |
|---|---|---|
| 3 | the proof is consumed (S2) | its own, committed before anything below |
| 4 | **resolve, read-only** | none; reads on the pool and calls to Organization Service |
| 5 | **authorize:** the resolved Company is the Owner's Company; otherwise the collapsed `404` | none |
| 6, 7 | **place and audit:** the reference-write gate, the rows parents first with `INSERT … ON CONFLICT DO NOTHING` and the anchor re-read, then the `hierarchy.reference_repaired` intent | **one** transaction; any failure rolls everything back |
| 8 | respond `200` | – |

- **Resolve for a cached target (DECIDED, ADR-0061 §4 step 4):** no Organization Service call. The Company is read through the target's
  local, immutable parent links. Authorized: `200` with `placed: false` and the success intent; not authorized: the collapsed `404`.
  *PROPOSED detail:* the success intent is written in a transaction that contains only that intent (no reference-write gate, no
  reference statement).
- **Resolve for an uncached target:** fetch the target and each uncached parent with the existing hardened client and its response
  validation; place nothing. A target unknown to Organization Service, or outside Auth's scope there, gives the collapsed `404`.
- **Cached-ancestor comparison (DECIDED as a requirement; its reading is RULED as the literal one, §11.1 O5):** "for any ancestor already cached,
  compare the local parent link with the authority's". This is new behavior, in the repair path only. `ensure` keeps stopping at the
  first cached ancestor.
- **Nothing is placed before step 5 succeeds.** The repair never calls `ensure`, `firstTouchPlatform` or `firstTouchOrganization`.
- **How the repair reaches the two steps is RULED (§11.1, O4): one repair entry method; both steps stay private.** The reference statements, the gate and the anchor
  re-read stay those of `HierarchyReference.place`, and `ensure` keeps the trace recorded in
  `test/fixtures/hierarchy-ensure-trace.main.json`.
- **Source `organization-service` with a marker that is not Organization-authoritative (corrected 2026-10-10; §11.5, O15).** With
  marker `frozen` the database refuses the reference write and the repair answers `503` (reason `placement_refused`). With marker
  `local` the database would **accept** the write, so the repair is not eligible at all: step 1c answers the collapsed `404`. This
  bullet previously said the database refuses the write in both cases, which was wrong for `local`.
- **Lifecycle (DECIDED, ADR-0061 §7):** a repair is permitted while the entity or an ancestor is suspended or archived. It grants
  nothing and is never lifecycle evidence.

## 5. S1: the generic verification refuses the repair purpose — DECIDED (ADR-0065 §4)

- `POST /auth/step-up/verify` refuses `hierarchy.reference.repair` **before any consuming statement**: the proof stays unconsumed.
- The answer is the endpoint's existing `403 step_up_required`, with the same local `owner.step_up.consume` `denied` record that
  `consume` writes for its own refusals. Authentication (`401` without a bearer) and every other purpose are unchanged.
- **PROPOSED placement:** the check sits in the verification path (the endpoint, or a small method used only by it), not inside
  `StepUpService.consume`, whose semantics must not change (§9.3 A.5).
- The proof keeps every property of ADR-0042 Amendment 1 A.1: single use, session binding, purpose binding, short lifetime,
  server-generated.
- **Documentation follow-up, part of the A3 change:** the endpoint's API description and the comment on the purpose in
  `step-up.service.ts`. The dated note on ADR-0042 already exists (added with ADR-0065's acceptance).
- **S1 is not mode-conditional in ADR-0065.** It therefore changes one answer of a deployed image while Auth's source is `local`, and
  it changes existing tests. That meets the wording of two automatic stop conditions; see §11, O1, ruled in §11.1.

## 6. S2: dedicated atomic consumption — DECIDED (ADR-0065 §5), mechanism PROPOSED

Used only by the repair route. `consume()` is untouched.

- **One statement (PROPOSED form):** an `UPDATE owner_step_up SET "consumedAt" = <now> WHERE id = <proof> AND "ownerId" = <owner> AND
  "sessionFamilyId" = <session> AND purpose = 'hierarchy.reference.repair' AND method = ANY(<allowed methods>) AND "consumedAt" IS
  NULL AND "expiresAt" > <now> RETURNING id`. The method is part of the condition, so a wrong-method proof is **not** consumed (unlike
  `consume()`).
- **Its own transaction (the mechanism the O8 contract of §11.5 assumes; conditional with it):** sent as a single autocommit statement on the pool, outside `DbService.tx`. One statement is one
  transaction; no hierarchy lookup has started. An explicit `BEGIN … COMMIT` is the alternative; it adds a second point (the `COMMIT`)
  where the outcome can be lost and no benefit.
- **A missing or malformed proof** is refused without any statement.

| Outcome | How it is known | Answer | Lookup | Evidence |
|---|---|---|---|---|
| **consumed** (confirmed committed) | the autocommit statement **completed** and returned one row | continue to step 4 | yes | – |
| **confirmed rejection** | the statement completed and returned no row (missing, invalid, expired, used, wrong Owner, session, purpose or method) | `403 step_up_required` | none | `hierarchy.reference_repair_denied`, reason `step_up_required`, best effort (§8) |
| **confirmed failed** | the database reported an error for the statement and the conditions of §11.5, O8 hold | `503 hierarchy_unavailable` | none | local failure record, reason `step_up_consume_failed`; no central record |
| **uncertain** | anything else: connection lost, timeout, no reply, a row seen but the statement not completed, an error that does not prove a rollback | `503 hierarchy_unavailable`, fail closed | none | local failure record, reason `step_up_consume_uncertain`; no central record |

- **Uncertain is the default.** Only an explicit short list of database error classes counts as "confirmed failed"; everything not on
  it is "uncertain". Both answer `503` and both stop before any lookup, so a misclassification changes a reason code and nothing else.
  The classification is ruled in §11.5, O8, which governs; the table above is a summary.
- **Never:** proceeding on an uncertain outcome; retrying the consumption with the same proof; restoring a consumed proof after a
  later `404`, `503` or rollback. A client that re-presents the proof gets the verdict of that new request's statement.
- **Concurrency:** two requests with the same proof race on one row; the database lets exactly one statement match.

## 7. Outcomes: response, placement, proof and records

Organization-authoritative mode. "Central" is an intent in Auth's outbox for audit-service. Existing writes that are **not** new with
A3 are marked *baseline*.

| Case | Response | Reference rows | Proof | Central record | Local record |
|---|---|---|---|---|---|
| no or invalid bearer, inactive user or session | `401` | none | untouched | none | none |
| authenticated, not the Owner | `403 forbidden` | none | untouched | `hierarchy.reference_repair_denied`, `no_authority`, best effort | only if the central write fails (§8) |
| malformed `kind` or `id` | `400` | none | untouched | none | none |
| rate limit exceeded | `429` | none | untouched | none | the throttle counter (*baseline mechanism*) |
| proof missing, invalid, expired, used, or wrong Owner, session, purpose or method | `403 step_up_required` | none | not consumed | `hierarchy.reference_repair_denied`, `step_up_required`, best effort | only if the central write fails |
| consumption confirmed failed, or uncertain | `503` | none | unknown or unconsumed | **none** | failure record (§8) |
| target unknown, outside Auth's scope, or in another Company | collapsed `404`, identical | none | consumed | `hierarchy.reference_repair_unresolved`, reason `unresolved`, best effort | only if the central write fails |
| target cached and authorized | `200`, `placed: false` | none | consumed | `hierarchy.reference_repaired`, same transaction | – |
| target placed | `200`, `placed: true` | target, and any missing parent | consumed | `hierarchy.reference_repaired`, same transaction | – |
| concurrent repairs of one id | each `200`; exactly one `placed: true` | one row each | each its own proof, consumed | one success record per request | – |
| authority unavailable, timeout, redirect, oversized or malformed answer, credential missing or refused | `503` | none | consumed | **none** | failure record |
| parent missing at the authority | `503` | none | consumed | **none** | failure record |
| placement refused by the database | `503` | none (rolled back) | consumed | **none** | failure record |
| the success intent cannot be written | `503` | none (rolled back) | consumed | **none** | failure record |
| parent-link (anchor) mismatch | `503` | none; the cached row is never changed | consumed | `hierarchy.reference_anchor_mismatch_detected`, `operation: reference_repair`, best effort, after the rollback | the existing `hierarchy_anchor_mismatch` error log and alert; local record only if the central write fails |

- **Collapsed `404` (DECIDED):** the three cases return the same status and body and write the same record, with the requested kind
  and id, `organizationId` `null`, and no field that distinguishes them. The accepted timing difference of ADR-0061 §8 is unchanged.
  The body equals Auth's existing `notFound()` answer, which is also what the route returns with source `local`.
- **Residual risk, ACCEPTED by the owner (§11.1, O12).** ADR-0061 orders resolve (step 4) before authorize (step 5). A failure during resolve
  (an authority failure, a missing parent, or a cached-ancestor mismatch) therefore answers `503` before the Company is known, including
  when the id belongs to another Company. For such ids "identical `404`" holds only when resolve completes, and a `503` caused by a
  missing parent or a link disagreement reveals that the id exists. ADR-0061 §8 names a timing difference only.
- **Record fields (catalog rules):** the success record's `organizationId` is the target id for an Organization and `null` for a
  Platform. The mismatch record's resource is the entity whose cached anchor disagreed, which may be an ancestor of the requested
  target; its `organizationId` is `null`.
- **A record never changes a response** (ADR-0064 §4): a failed central or local write leaves the refusal, the `404` or the `503`
  as it is. Only the success record is different: if its intent cannot be written, the placement rolls back and the answer is `503`.
- **Records carry** ids, the actor, a reason or operation code. Never credentials, tokens, upstream bodies or headers, URLs, names,
  or either side's parent ids.

## 8. Refusal records, failure diagnostics and reason codes

### 8.1 Best-effort central records (denied, unresolved, anchor mismatch) — DECIDED (ADR-0064 D4)

Each is written in **its own transaction**, after any failed transaction has rolled back, with no application retry. If that write
fails: a local `AuditService.tryRecord` with outcome `denied`, then a structured log. **Denial-audit failure behavior:** the request
still answers its refusal, unchanged in status, body and timing class; never a success; if both writes fail only the log remains, an
accepted limitation.

*Local fallback types (recorded: §11.5):* `hierarchy.reference_repair.denied` (metadata `kind`, `reason`),
`hierarchy.reference_repair.unresolved` (metadata `kind`), `hierarchy.reference_repair.anchor_mismatch` (metadata `kind`, `operation`).
The third replaces the earlier proposal `hierarchy.reference_anchor_mismatch.detected`.

### 8.2 Infrastructure failures — DECIDED (ADR-0064 D2; ADR-0065 §5); record type and log line recorded (§11.5); reason list PROPOSED

One local record, one log line, optionally one metric. No central record.

- **Local record:** type `hierarchy.reference_repair.failed`, outcome `failure`, the actor id, the target id, metadata `kind` and
  `reason`. (The metadata key is `reason`: the local sanitizer drops keys containing `code`.)
- **Log:** `hierarchy_reference_repair_failed kind=<kind> id=<requested-id> reason=<reason>` at warning level (§11.5).
- **Metric: deferred (§11.5, O7).** Auth defines no application counter today, and adding one needs a shared-library change.

**Closed reason list (PROPOSED; ADR-0064's nine plus ADR-0065's two):**

| Reason | Case |
|---|---|
| `authority_unavailable` | network failure, or an unexpected status from Organization Service. Mapping the authority's "not authoritative" answer (`409`) here is this design's own proposal, not ADR-0064's |
| `authority_timeout` | the deadline passed |
| `authority_redirect` | a redirect was refused |
| `authority_response_invalid` | oversized or malformed answer |
| `credential_missing` | Auth has no Organization Service credential |
| `credential_refused` | Organization Service answered `401` or `403` |
| `parent_missing` | the authority shows a child without its parent (still flagged for investigation, ADR-0064 §5) |
| `placement_refused` | the database refused the reference write (for example a frozen hierarchy) |
| `audit_intent_unwritable` | the success intent could not be written |
| `step_up_consume_failed` | S2: the consume statement confirmed failed |
| `step_up_consume_uncertain` | S2: the consume outcome is unknown |

A reason outside the list is a defect: the code maps every failure to one of these, with `authority_unavailable` as the default for an
unclassified authority failure. Producing these reasons needs the repair path to learn *why* the client or the placement failed, which
today only a log line states: §11, O6.

### 8.3 Anchor mismatch — DECIDED (ADR-0064 D3), for the repair path only

Detected at the anchor re-read after a conflicting insert (existing) and at the new cached-ancestor comparison at
resolve (§11.1, O5).
Both answer `503`, change nothing, keep the existing error log (and so the existing alert), and write the incident record with the
system actor `hierarchy_anchor_detection` and `operation: reference_repair`. The record is written by the repair service, never by
`HierarchyReference.place`, so first-touch recording stays unchanged (§9.3 A.1). The three other operation codes stay unused.

## 9. Audit producers and consumer-first prerequisites — DECIDED

- A3 adds producers for exactly the four declared actions, in the repair service only. The catalog, the contract version, the
  outcomes and the actor kinds do not change; `libs/audit-contract` is not edited.
- **Producer-less until authorized.** Until A3 is merged, no file under `apps/` names the four actions (the existing AC1 tests
  assert it). Adding the producers makes those two assertions false; they are tests of the shared library, so how they are
  changed is ruled in §11.1, O2: a separate prerequisite task, before A3 (implemented as the repository check of §11.4).
- **Consumer first.** No production emission before an audit-service image declaring all four actions is deployed, separately
  authorized (§9.3 A.3). Production audit-service predates them: the AC1 batch 1 record (§4, citing ADR-0049 A50) describes an action reaching it as
  refused and kept in its dead-letter queue: a safety net, not a plan.
- **What keeps the merged code from emitting:** only the `local` source. With it the route stops at step 1c, before any producer
  (§10). Auth's central audit relay is independent of `AUTH_EVENTS` and already runs in production
  (`apps/auth-service/src/audit/central-audit.ts`), so once Auth's source is `organization-service` a repair intent is relayed at
  once. **Activation must therefore not precede the audit-service deployment** that declares the four actions (§9.3 A.5: "at
  activation, the deployed audit-service image does not declare the four actions" is a stop condition).

## 10. Local-mode inertness and automatic stop conditions

### 10.1 Inert modes: source `local`, and source `organization-service` with marker `local` — DECIDED (ADR-0061 §4; ADR-0065 clarification 3; §9.3 A.4)

| Caller | Answer | The route writes |
|---|---|---|
| unauthenticated | `401` | nothing |
| authenticated non-Owner | `403` | nothing: no central record, no local record |
| Owner, any `kind`, any id (well formed or not), any proof (valid, invalid, absent) | the collapsed `404`, byte-identical in every case | nothing |
| the same Owner request with source `organization-service` and marker `local` (§11.5, O15) | the same collapsed `404` | nothing |

"Nothing" means: no proof consumption (`consumedAt` stays NULL), no throttle row, no reference row, no outbox row, no central or
local audit record, no marker or authority change, and **zero** Organization Service calls. Reads done by the guard are the existing
ones. The inertness is decided at step 1c on every request, by the configured source and, when the source is
`organization-service`, by the authority marker (one additional read; §11.5, O15, which also covers the `frozen` and unreadable
markers).

S1 is the one A3 behavior that is **not** confined to the repair route and is not mode-conditional (§5; ruled in §11.1, O1).

### 10.2 Automatic stop conditions (§9.3 A.5, unchanged)

Work stops and is reported if: an existing hierarchy, first-touch, bootstrap, step-up or verify test changes behavior, or the A2
equivalence tests fail; T1 needs any entry other than the repair operation; a migration, schema or organization-service change becomes
necessary; a `libs/service-kit` or `libs/audit-contract` change becomes necessary; an audit-catalog change becomes necessary;
`consume()` semantics would have to change; S1 or S2 needs more than ADR-0065 describes; the route is reachable, consumes a proof or
writes anything with source `local`, or any observable behavior of a deployed image changes with source `local`; a merge would change
the certified digest set without an authorized re-rehearsal; at activation the deployed audit-service does not declare the four
actions; the scope of §9.3 A.1 would have to grow.

Whether A3 adds stop conditions of its own is the owner's choice (§11, O14); this document adds none to the accepted list.

## 11. Open decisions for the architecture owner

The table records the questions, the alternatives considered and this document's recommendations. **O1, O2, O3, O4, O5, O11 and
O12 were ruled by the architecture owner on 2026-10-10 (§11.1)**, and **O10, for its names and paths, on the same day (§11.3)**; their rows are kept as the
record of what was considered. **O6, O7, O8, O9, O13, O14 and O15 were ruled on the same day (§11.5).** O8's classification must
still be demonstrated by tests, and O7's metric is required before activation.

| # | Question | Alternatives | Recommendation |
|---|---|---|---|
| **O1** | **S1 and the stop conditions.** S1 (unconditional in ADR-0065 §4) changes `POST /auth/step-up/verify` for one purpose with source `local`, and A3 necessarily edits existing assertions: the A1 test "the generic endpoint consumes the proof exactly once" and its binding tests, and the A1 "no application source names the purpose" test (all in Auth). The binding tests would keep passing after S1 for the wrong reason (S1's `403`, not the binding), so they must be re-pointed at the repair route and S2, not left as they are. §9.3 A.5 stops work when "any existing … step-up or verify test changes behavior" or "any observable behavior of a deployed image changes with source `local`", and the merge condition of §9.1 is "no changed behavior in deployed images". | (a) The owner records that S1 and these named test updates are the intended, bounded exception to those two conditions, everything else unchanged. (b) S1 becomes mode-conditional (refuse only with source `organization-service`): needs a dated ADR-0065 note, and leaves a repair proof burnable in `local` mode, where the route is inert anyway. (c) S1 ships as its own earlier change with its own authorization. | **(a)**, as an explicit written ruling before development, naming the tests. It matches ADR-0065 as accepted. No consumer uses the purpose, so no caller is affected. |
| **O2** | **The producer-less tests are in the shared library.** Adding the four producers in Auth makes two assertions in `libs/audit-contract/test/` fail. §9.3 A.5 stops work when "a change in `libs/service-kit` or `libs/audit-contract` becomes necessary (it changes all three service digests)". The files are tests, excluded from the images, but the path triggers all three image builds. | (a) The owner rules that editing only those two test assertions (to "named only by Auth's repair service") is not a library change in the sense of A.5, and accepts that the merge rebuilds the three images; the pull request states whether the rebuilt digests matter to the certified set. (b) A separately authorized YELLOW change first relaxes or relocates those assertions, before A3. (c) A3 does not add the producers; they come later in their own change. | **(b)**: it keeps A3 free of any `libs/` path and keeps the stop condition literal. (a) is workable only with an explicit written ruling. Not (c): ADR-0064's records are part of the repair's security design. |
| **O3** | **A refused non-Owner or missing proof with a malformed id or an unknown `kind`.** Step 1b precedes validation, and the central denial needs a resource type and a UUID. | (a) `403`, with a local `denied` record only, when the kind or id cannot be recorded centrally. (b) `403`, no record at all in that case. (c) validate first, so the answer is `400` (changes ADR-0061's order). | **(a)**. The ADR order holds, and the refusal still leaves evidence. |
| **O4** | **How the repair reaches resolve and place** (private since A2). | (a) One new method on `HierarchyReference`, used only by the repair service, that runs resolve, then a caller-supplied authorization, then place plus a caller-supplied same-transaction step; the two steps stay private. (b) Make `resolve` and `placeChain` callable by the repair service. | **(a)**: the class itself guarantees "nothing placed before authorization". It needs `place` to report whether it inserted, with `ensure`'s trace unchanged. |
| **O5** | **Reading of the cached-ancestor comparison** (ADR-0061 §4 step 4), for an **uncached** target only: a cached target makes no Organization Service call under either reading (§4, TP2). | (a) Literal: fetch each cached Platform ancestor from the authority as well and compare its Company link with the local one; a cached Company needs no fetch. One extra call at most. (b) Compare only what the already-fetched rows allow, with no extra fetch, which compares nothing new. | **(a)**: it is the only reading in which the comparison detects anything. Confirm that the extra call is intended. |
| **O6** | **How the repair learns the failure reason and the mismatch**, which the client and `place` only log today. | (a) Internal, typed failure causes inside `hierarchy-reference.ts`, read only by the repair path; `ensure`'s log lines, `503` and trace unchanged (the golden fixture proves it). (b) One coarse reason, `authority_unavailable`, for every authority failure. | **(a)**; fall back to (b) if (a) cannot be done without changing `ensure`'s trace. |
| **O7** | **The failure metric** (ADR-0064 D2 names "a bounded metric"). | (a) Add a counter labelled `kind` in A3, if it needs no `libs/service-kit` change. (b) Defer the metric to the metrics rollout; log and local record only. | **(b)** unless (a) is confirmed kit-free; ADR-0064 then needs the owner's word that the metric may follow later. |
| **O8** | **"Confirmed failed" classification list** for S2 (§6). | (a) A short allow-list of database error classes, reviewed in the implementation. (b) No such class: every consume error is "uncertain". | **(a)**, with uncertain as the default. |
| **O9** | **Rate limits.** | (a) Two new buckets, per Owner and per address, in Auth's configuration. (b) Reuse `step_up_owner` and `step_up_ip`. | **(a)**, limits set by the owner; (b) would let repairs exhaust the step-up budget. |
| **O10** | **Names:** the route path (§3.1), the local record types (§8), the log line; and, for the O2 task, the file paths. | as proposed, or the owner's choice | ruled 2026-10-10 for the names and paths only: see §11.3 (the local record types and the log line stay PROPOSED) |
| **O11** | **Mechanism for the order of checks** (§3.3): security-relevant, because it decides where the Owner check and the denial record live. | (a) The route admits any authenticated actor (`@Actors()`); the repair service performs 1b, 1c and 2a in order, with no `ParseUUIDPipe`. (b) Dedicated guards for the Owner check and the source check, the denial written by a guard, interceptor or filter, and validation kept in pipes behind them. | **(a)**: one place holds the whole order and it is easy to test; (b) spreads the sequence over framework hooks whose order is implicit. Either way test TL2 and TA2 fix the observable order. |
| **O12** | **`503` before authorization for another Company's id** (§7). | (a) Accept and record it as a residual risk next to ADR-0061 §8's timing difference (a dated note or the A3 pull request, as the owner prefers). (b) Require the collapsed `404` whenever resolve fails before the Company is known to be the Owner's: hides the signal, but turns real outages into `404` for the Owner's own entities and changes ADR-0061 §5. | **(a)**: it follows the accepted sequence; the caller is an authenticated Owner who spent a factor and is rate limited. It is still more than a timing difference: an outage gives `503` for any id, but a missing parent or a link disagreement gives `503` only for an id that exists, so such a `503` tells the caller that the id exists with an anomalous reference state, and it leaves an incident record. This goes beyond ADR-0061 §8's timing-only residual risk and needs the owner's explicit acceptance. |
| **O13** | **Meaning of `placed`** in the response and in the success record (§3.1). | (a) The target's row was inserted by this request. (b) Any row (target or parent) was inserted by this request. | **(a)**: it answers the question the Owner asked and is unambiguous under concurrency. |
| **O14** | **A3-specific stop conditions**, in addition to §9.3 A.5. | (a) Add: stop if producing a reason code or the mismatch record would require changing what `ensure` logs, returns or throws, or the golden fixture; stop if a new error code or rate-limit bucket would need a migration. (b) Rely on A.5 as accepted. | **(a)**, recorded by the owner; both are already implied by A.5's first and third conditions. |
| **O15** | **Source `organization-service` with a marker that is not Organization-authoritative**: the proof is consumed, then the write is refused (`503`). | (a) No special case (ADR-0061 §5 keeps the proof consumed on every `503`). (b) A read-only pre-check before step 3 that answers `503` without consuming. | **(a)**; (b) adds a new early exit to the accepted sequence. **Superseded for marker `local` by the ruling of §11.5:** the request is not eligible and answers the collapsed `404` with nothing consumed. Alternative (a) stands for marker `frozen` only. |

### 11.1 Owner rulings of 2026-10-10 on the seven blocking decisions

Recorded from the architecture owner's rulings. Each is subject to exact conformance with the Accepted ADRs, **supersedes no
Accepted ADR**, implements nothing and authorizes no development, test change, merge, deployment, emission or activation.

**O1 — S1, the Auth-local restriction of the generic verification (alternative (a)).** The narrow S1 behavior of ADR-0065 §4 is
approved. For the purpose `hierarchy.reference.repair` only, the generic endpoint `POST /auth/step-up/verify`:

- answers `403 step_up_required`;
- does not consume the proof;
- keeps the existing local denial-audit mechanism (the `owner.step_up.consume` `denied` record its refusals already write);
- emits no new central audit event, and adds no outbox row and no hierarchy write.

This endpoint is **not** the repair route. The repair route stays fully inert while `AUTH_HIERARCHY_SOURCE` is `local` (§10.1), and
§9.3 A.4's "no local audit record" concerns that route. **No other local-mode stop condition is weakened.** Only these existing A1
test changes are permitted, as far as S1 requires:

| File | Test (exact name) | Permitted change |
|---|---|---|
| `apps/auth-service/test/reference-repair-step-up.e2e-spec.ts` | `documented, unchanged generic behavior: POST /auth/step-up/verify consumes the proof exactly once` | replaced by the S1 assertion (`403`, proof not consumed) |
| same | `a proof is bound to its owner: another owner cannot consume it` | re-pointed at the repair route and S2 (its second half expects `204` from the generic endpoint) |
| same | `a proof is bound to its session: another session of the same owner cannot consume it` | re-pointed: it would still pass after S1, but vacuously, on S1's `403` instead of the binding |
| same | `a proof is bound to its purpose, in both directions` | re-pointed, likewise |
| same | `a proof expires with the existing step-up lifetime` | re-pointed, likewise |
| `apps/auth-service/src/owner/step-up-purposes.spec.ts` | `no application source outside the allow-list names the purpose: no route, consumer or producer exists for it` | its allow-list gains exactly the application files that implement S1 (and, once A3 is separately authorized, the repair files that must name the purpose). Under the later O10 ruling the literal is kept inside `step-up.service.ts`, so no change to this test is expected; any addition would be a deliberate, reviewed change listed in the pull request (§11.3) |

The remaining tests of those two files are not to change. **Compatibility with the images actually deployed must be demonstrated
before any RED-exception merge**; the ruling does not presume it (§14 item 11).

**O2 — producer-scope enforcement (alternative (b)).** The current producer-less assertions are to be relocated into an equivalent,
phase-aware repository check, as a **separate prerequisite task**, before A3. That task needs its own development, review, CI and
merge authorization; **none is granted here**. **The governance class of that task was not ruled with this ruling**: the word "YELLOW" in
the alternative recorded in the table above is not adopted. (The class was ruled afterwards: GREEN with two merge conditions, §11.3.) Its requirements:

- the exact application paths are fixed first, through O10 (since ruled: §11.3);
- there is never an interval without producer-scope enforcement;
- the existing audit actions and the consumer-first safeguards are kept;
- any producer outside an explicit allow-list is detected, and tests that deliberately violate the allow-list prove the rejection;
- the check is effective before and after A3;
- no audit-contract semantics, catalog entry or deployed producer changes;
- the task proves whether its test and script changes alter any runtime image contents, and it preserves the G6 timing requirements (since made a mandatory merge condition, with verifiable evidence that
  no shipped runtime image contents change: §11.3, condition 2).

**O3 — a refusal the central record cannot describe (alternative (a)).** An authenticated caller refused during authorization keeps the
existing `403`. When a malformed id or an unknown kind cannot satisfy the central denial contract: no UUID or kind is fabricated;
nothing about another Company's resources is revealed; ADR-0064's local denial-audit fallback applies; the accepted audit ordering and
failure handling are kept; no invalid central record is emitted. With source `local` the route stays inert.

**O4 — the internal repair entry (alternative (a)).** One narrowly scoped repair entry method on `HierarchyReference`, introduced only
during separately authorized A3 implementation. `resolve` and `placeChain` stay private. The method must guarantee: no hierarchy
placement before authorization; read-only resolution before the authorized placement; the success audit intent in the placement
transaction; a determinable placed or no-op result; detectable integrity mismatches; and `ensure`'s behavior and the A2 golden traces
unchanged. Resolution and placement are never exposed as a public HTTP API.

**O5 — cached-ancestor integrity (alternative (a), the literal reading).** For an Organization with a cached Platform ancestor, the
repair fetches that Platform from Organization Service and compares its Company link with the cached relationship. An unavailable,
missing or inconsistent authoritative parent is handled by the accepted failure and integrity rules (§7). The one point left unruled
is a cached Platform that the authority does not show: how it is classified among those rules (for example the `parent_missing`
failure, or an integrity incident) is **not ruled here** and stays OPEN for the A3 implementation design (since ruled as `parent_missing`: §11.5). The cached relationship is never silently trusted. `ensure` keeps its lookup
sequence: the comparison belongs to the repair path only.

**O11 — where Owner authorization lives (alternative (a)).** The HTTP route may admit authenticated users. The repair service itself
checks the hierarchy source and the Owner authority in the accepted order (§3.3), refuses non-Owners, applies the approved
denial-audit behavior, keeps the collapsed response semantics, and prevents any unauthorized lookup or placement. A route-level Owner
decorator that would prevent the required denial recording is not relied on alone. Tests cover a Member, an Operator, the Owner and
unauthenticated callers (§12.1, §12.2).

**O12 — residual privacy risk (alternative (a)).** The `503` for an integrity anomaly found before the Company can be established is
accepted, as the Accepted ADR-0061 resolution sequence dictates. **Recorded residual risk:** for an uncached id that belongs to another
Company, a `503` caused by a parent missing at the authority or by a parent-link disagreement tells the calling Owner that the id
exists. Preserved: Owner-only authorization, one-time step-up consumption, rate limiting, the existing logging and audit
restrictions, and no additional resource detail in any response. **This ruling is not a general acceptance of cross-company
disclosure**: it covers this case only, and no Accepted ADR is superseded by it.

### 11.2 What still blocks A3

- **The O2 prerequisite task**, separately authorized, developed, reviewed and merged (§11.1, O2), under its class and merge
  conditions (§11.3). The names it needs are ruled (§11.3, O10). It is implemented and merged (PR #283, §11.4), so this
  prerequisite is met.
- **What the rulings of §11.5 still require, later:** for O8, focused tests demonstrating the classification before the A3
  implementation is accepted; for O7, the metric or an owner-approved equivalent monitoring capability **before activation**. No
  architecture-owner decision recorded in §11 remains open.
- **The separate authorization for local A3 development** (§13, authorization 3), and every later authorization.
- Every automatic stop condition of §9.3 A.5 (§10.2), unchanged apart from the bounded O1 test list above.

### 11.3 Owner rulings of 2026-10-10 on O10 and on the O2 task

Recorded from the architecture owner's rulings. Documentation only: they supersede no Accepted ADR, widen nothing in §9.3 A.1, and
authorize no O2 or A3 development, merge, deployment, emission or activation. **No name below exists in the code today.**

**O10 — names and file boundaries.**

| Item | Ruled name |
|---|---|
| HTTP route | `POST /auth/admin/hierarchy-references/:kind/:id/repair` |
| Route resource kinds | `platform` and `organization` only |
| Controller | `ReferenceRepairController`, in `apps/auth-service/src/hierarchy/reference-repair.controller.ts` |
| Service | `ReferenceRepairService`, in `apps/auth-service/src/hierarchy/reference-repair.service.ts` |
| Internal entry (O4) | `HierarchyReference.repairReference(kind, id, steps)` |
| Response | `ReferenceRepairResponseDto`, in `apps/auth-service/src/hierarchy/dto.ts` |
| S2 | `StepUpService.consumeForReferenceRepair(...)` |
| S1 | `StepUpService.verifyForService(...)` |
| New tests | `apps/auth-service/test/reference-repair.e2e-spec.ts`, `apps/auth-service/test/reference-repair-local.e2e-spec.ts`, `apps/auth-service/test/reference-repair-proof.e2e-spec.ts` |
| Existing S1-related tests | keep their locations (the two files named under O1 in §11.1; the paths are not separately ruled here) |

- **The repair-purpose literal is kept inside `step-up.service.ts`.** O1's permission for the sixth named test (§11.1) is unchanged;
  with the literal kept there, that test's allow-list is expected to need no change.
- **`resolve` and `placeChain` are not exported** and stay private (§11.1, O4).
- These names introduce no A3 behavior. Method names, the T1 entry text and the wiring are implementation detail of the separately
  authorized A3 change. **The local record types and the log line were not ruled** by this ruling (they have since been recorded:
  §11.5).

**The O2 task — class.** O2 is **GREEN** under A5.4-G1 (A5 record §9.1): it consists only of static repository checks, tests and
documentation, with no runtime change. Two additional merge conditions are mandatory:

1. a **separate, explicit architecture-owner approval** before O2 is merged;
2. **verifiable evidence that the O2 diff does not modify shipped application or runtime image contents**, checked against the actual
   build inputs or the produced images, not asserted from file extensions or `.dockerignore` alone. Rebuilt images are not claimed to
   have identical digests unless that is independently demonstrated.

No deployment or activation is authorized. O2 stays a separate prerequisite task before A3, with its own development authorization.

**The O2 task — the replacement check.** It must:

- scan the agreed source extensions under `apps/` and `libs/`;
- exclude the audit-contract declaration directory, according to the existing catalog rules;
- detect the four protected repair audit action names (`hierarchy.reference_repaired`, `hierarchy.reference_repair_denied`,
  `hierarchy.reference_repair_unresolved`, `hierarchy.reference_anchor_mismatch_detected`);
- use exact literal allow-list paths, never broad directories or globs;
- keep the one producer path separate from the three test paths;
- reject a mention anywhere outside those paths;
- assert that the allow-list is unchanged unless deliberately reviewed;
- include negative mutation tests;
- demonstrate parity with both existing producer-less assertions;
- be introduced in the same change that removes the superseded assertions;
- remain effective before and after A3.

| Allow-list | Approved future path |
|---|---|
| producer (one) | `apps/auth-service/src/hierarchy/reference-repair.service.ts` |
| tests (three) | `apps/auth-service/test/reference-repair.e2e-spec.ts`, `apps/auth-service/test/reference-repair-local.e2e-spec.ts`, `apps/auth-service/test/reference-repair-proof.e2e-spec.ts` |

**These paths are enforcement boundaries, not an authorization to produce the events.** Producing them is A3, which stays blocked.

**G6 and deployment boundaries for O2.**

- O2 may trigger the three image-build workflows; it must not deploy any image.
- Image content compatibility must be proven (condition 2).
- No certified digest-set selection is authorized.
- O2 itself does not require a G6 execution.
- A3's implementation and merge timing stay subject to the G6 baseline refresh rules (§15).

### 11.4 The O2 task as implemented (2026-10-10; GREEN; merged as PR #283)

**A check relocation, not an audit producer activation.** Nothing produces the four actions, and nothing in an application changes.

- **What moved.** The two producer-less assertions were removed from `libs/audit-contract/test/reference-repair-catalog.spec.ts` and
  `reference-repair-batch2.spec.ts`, and replaced, in the same change, by the repository check `checkRepairAuditProducerScope` (`scripts/lib/checks.mjs`, run by `npm run check:repo`), with its tests in `scripts/check-repo.test.mjs`. There is no committed state without
  the protection.
- **What it enforces.** Every file under `apps/` and `libs/` with a source extension (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.mjs`,
  `.cjs`, `.json`), except the contract library `libs/audit-contract/` that declares the actions, may not name any of the four
  actions. The only exceptions are the four exact paths of §11.3: one producer and three test files. A path that merely resembles one
  of them is refused. The allow-list is asserted as a literal by the test.
- **Equal or wider than before.** The first replaced assertion read `apps/` and four extensions for two actions; the second read
  `apps/` and `libs/` and eight extensions for the other two. The check applies the wider reading to all four, and matches each name
  without its `hierarchy.` prefix. A parity test runs the old logic beside the new one.
- **Before and after A3.** Today the four paths do not exist and nothing names the actions, so the check enforces exactly the
  producer-less state. After a separately authorized A3 it still refuses every other file.
- **The four paths are enforcement boundaries only.** They authorize no file, no producer and no emission. **A3 remains blocked**
  (§11.2).
- **Class and merge conditions (§11.3).** GREEN. Its merge still needs the owner's separate explicit approval and the evidence that
  no shipped runtime image contents change. That evidence is produced with the change and stated in its pull request: for each of
  the three Dockerfiles, the files it copies from the real build context compared between the base and the change, and local builds
  of the three images at both. Two facts it must not gloss over: `scripts/` and nested `docs/` files **are** in the build context
  (`.dockerignore` does not exclude them), and no Dockerfile copies them; and the images built by CI carry a revision label, so
  their digests differ from their predecessors' whatever their contents.
- **Unchanged:** the catalog, the contract version, the validator, audit-service, every deployed producer, every deployment and
  activation permission, and the G6 timing rules (§15).

### 11.5 Owner rulings of 2026-10-10 on the remaining decisions

Recorded from the architecture owner's rulings. Documentation only: they implement nothing, widen nothing in §9.3 A.1, and authorize
no A3 development, merge, deployment, emission or activation. O7 and O8 carry later requirements: monitoring before activation,
and certainty tests before the implementation is accepted.

**O6 — typed failure causes (closed).** The repair path learns why a lookup or a placement failed through **module-private, typed
failure causes** inside `hierarchy-reference.ts`, readable only by the repair path. `ensure()` keeps its exception status, its code,
its log lines and the A2 golden fixture **byte-identically**. `HierarchyReference` produces no repair audit action: the records are
written by the repair service.

**O9 — rate limits (closed; the values are initial defaults).** Two buckets in Auth's configuration:

| Bucket | Initial default |
|---|---|
| `reference_repair_owner` | 5 requests per 300 seconds, per Owner |
| `reference_repair_ip` | 20 requests per 300 seconds, per address |

They apply **only after the request has passed the inertness gate** (step 1c), so no throttle row is written while the route is
inert. The order of the authorization checks (§3.3) is unchanged. **Residual risk, recorded:** a non-Owner is refused at step 1b,
before these limits; each such refusal writes one best-effort denial record, so an authenticated non-Owner can cause denial records
at a rate bounded only by Auth's existing baseline request limiter.

**O13 — `placed` (closed).** `placed` is `true` only when **this request inserts the target reference row**. A target that already
exists gives `false`. Inserting a parent alone does not make it `true`. Under concurrency the value follows the insert outcome the
database reports to each request.

**O14 — stop conditions (closed).** In addition to §9.3 A.5, A3 work stops, and is reported, if it would require: changing `ensure()`
behavior or the golden traces; a new migration for a rate-limit bucket or a failure code; a shared-library change that is not
approved; relaxing the `local`-mode inertness or the audit producer scope.

**O15 — authority-marker safety (closed).** The repair is eligible only when
**`AUTH_HIERARCHY_SOURCE` is `organization-service` AND the authority marker is `org_authoritative`**.

- **Source `organization-service`, marker `local`:** the agreed collapsed `404`. The proof is neither validated nor consumed; no
  repair audit record is written; no hierarchy reference is written; no repair rate-limit attempt is counted. This is the same inert
  behavior as source `local` (§10.1).
- **Marker `frozen`:** unchanged. The request proceeds as ADR-0061 §5 describes and the database refuses the placement: `503`, with
  the proof consumed. (A target that is already cached and authorized needs no placement and keeps its `200`: §11.6, C3.)
- **Marker missing, malformed, unreadable or otherwise indeterminate (ruled):** the request **fails closed** with
  **`503`, code `hierarchy_unavailable`**, and the marker is **never** treated as `org_authoritative`. The marker check comes
  before any repair-specific proof validation, proof consumption, rate-limit count and hierarchy write, so none of them happens.
  The marker is read only when the source is `organization-service`: with the source `local` the route is inert without reading it.
  ADR-0061 §5 has no row for this case, and none of its rows is changed by it.
- **The four marker cases, kept distinct:**

  | Marker (source `organization-service`) | Outcome |
  |---|---|
  | `local` | the collapsed `404`; nothing validated, consumed, counted or written |
  | `frozen` | the existing behavior and order of ADR-0061: the request proceeds, the database refuses the placement, `503` with the proof consumed (a cached and authorized target, which needs no placement, keeps its `200`: §11.6, C3) |
  | `org_authoritative` | eligible, subject to every other check |
  | missing, malformed, unreadable or indeterminate | for an Owner, `503 hierarchy_unavailable`; nothing validated, consumed, counted or written (a non-Owner is refused `403` first: §11.6, C2) |
- **Correction of this document.** §4 previously said that, with a marker that is not Organization-authoritative, "the database
  refuses the reference write". That is true for `frozen` only. With marker `local` the database guard of migration
  `0008_hierarchy_authority.sql` accepts every hierarchy insert, so a placement would be written as an ordinary local row. §4 and
  §10.1 are corrected; the marker check at step 1c is what prevents it.
- **Related exposure in `ensure()`, not changed here.** The existing first-touch `ensure()` does not read the marker: with source
  `organization-service` and marker `local` it places whatever Organization Service returns. Today that is prevented in practice only
  by Organization Service answering "not authoritative". It is recorded as a **separate F6 follow-up** (the A5 record §9.2);
  `ensure()` is not modified by A3.
- ADR-0061 carries a dated clarification of "Organization-authoritative mode"; its decision text is unchanged.

**A cached Platform that the authority does not show (closed).** Classified as **`parent_missing`**: `503`, the proof consumed, the
local failure record, no central record. No anchor-mismatch incident is written: an absent Platform is not a link that disagreed.

**Local diagnostics (recorded; field names verified against the code).**

| Local type | Outcome | Metadata |
|---|---|---|
| `hierarchy.reference_repair.failed` | `failure` | `kind`, `reason` |
| `hierarchy.reference_repair.denied` | `denied` | `kind`, `reason` |
| `hierarchy.reference_repair.unresolved` | `denied` | `kind` |
| `hierarchy.reference_repair.anchor_mismatch` | `denied` | `kind`, `operation` |

Warning line: `hierarchy_reference_repair_failed kind=<kind> id=<requested-id> reason=<reason>`.

Verified on `main` at `564a30f`:
- **Table (`auth_audit_event`, migration `0003`).** The four types match the type pattern `^[a-z_]+(\.[a-z_]+)+$`; the outcomes are
  among `success`, `failure`, `denied`; `actorId`, `targetId` and `sessionFamilyId` are nullable `uuid` columns, so a requested id
  that is not a UUID is recorded as a null target; `metadata` must stay under 2048 bytes, and three short codes do.
- **Sanitizer (`sanitizeMetadata`).** It drops any metadata key matching
  `pass|secret|code|token|key|assert|challenge|credential|otp|proof|cookie|authorization|hash`, and any string longer than 120
  characters. The keys `kind`, `reason` and `operation` pass. Values are not filtered by name, so reasons such as
  `credential_missing` and `step_up_consume_failed` are stored. A key such as `reasonCode` or `proofState` would be dropped silently
  and must not be used.
- **Privacy.** Records and the log line carry ids, the kind and a closed code only. **No bearer, step-up proof, credential or
  upstream response content appears in a record or a log line**, and no name, URL or parent id. The requested id may belong to another
  Company; it stays in Auth's own log and local audit, which only the deployment's operators read.
- **Still to confirm in implementation:** that every producing call site uses only these keys (a test reads the stored rows). The
  schema is final in its names and not yet proven by a test.

**O7 — the failure metric (ruled: deferred for implementation, merge and inert deployment; NOT waived for activation).**

- **Fact.** `installMetrics` in `libs/service-kit` creates the metrics registry internally and exports no accessor; no Core service
  defines an application counter. Adding the counter of ADR-0064 §3 needs a `libs/service-kit` change, which §9.3 A.5 makes a stop
  condition for A3. `libs/service-kit` is not modified, and no metric is implemented by A3.
- **Deferred for:** A3's local implementation; A3's merge; the deployment of repair code that is otherwise inert or not activated.
- **Not waived for production activation.** Before the repair capability is activated, one of these is required:
  - **A.** the intended metric, with appropriate operational monitoring; or
  - **B.** a separately reviewed, equivalent monitoring capability, with the owner's explicit approval.
- **Always mandatory:** the local failure record and the warning line above, from the first implementation.
- **Expected path:** the V2 A12 observability workstream (roadmap stages A12.7 to A12.10; A12.10 is production observability, not
  started, and A12.7 to A12.9 have no defined scope yet), when the service-kit exposes application counters through a separately
  authorized shared-library change.
- **Compatibility.** ADR-0064 §3 requires the local audit record, the structured log and a bounded metric. Nothing is removed from
  that requirement: the first two exist from the first implementation, and the third must exist, or have an approved equivalent,
  before any activation, which is when infrastructure failures of the repair can first occur in production. The existing activation
  gates (§9.3 A.2 item 7, A.3 and A.5) are unchanged; this adds a condition to activation and removes none. ADR-0064 carries a dated
  clarification; its decision text is unchanged. This ruling authorizes no activation.

**O8 — classifying the proof consumption (ruled, with the conservative fallback; its tests are required before A3 is accepted).**

S2 runs **one statement in autocommit**, outside any explicit transaction (§6). This differs on purpose from
`StepUpService.consume`, which runs inside the caller's transaction and is undone by its rollback (ADR-0061 §4 step 3).

| Outcome | What must be observed | Answer |
|---|---|---|
| **Confirmed consumption** | the statement completed and returned exactly one row | continue |
| **Invalid or rejected proof** | the statement completed and returned no row; or the proof is absent or malformed, in which case no statement is sent | `403 step_up_required` |
| **Confirmed no consumption** | **all** of: the database itself answered this statement with an error report; that report's severity is `ERROR` (the session survives), never `FATAL` or `PANIC`; its status code is not one that leaves completion unknown; and the statement was the single autocommit statement, so its implicit transaction is the one the error aborted | `503`, reason `step_up_consume_failed` |
| **Uncertain consumption** | anything else: a connection error; a client-side deadline (Auth's pool sets one); a lost acknowledgment; a `FATAL` or `PANIC` report, including a server shutdown, whatever its status code; a status code that means completion is unknown; any error that is not a database error report | `503`, reason `step_up_consume_uncertain` |

- **A status code alone never confirms a failure.** A broad class is not evidence: a `FATAL` report carries a status code too, and it
  can arrive after the statement's effects were committed.
- **Uncertain is the default**, and both failure rows answer `503` with no lookup, no placement and no retry of the consumption, so a
  misclassification changes a reason code and nothing else.
- **Consistency.** ADR-0061 §4 step 3 (consumed in its own committed transaction, before any lookup) and ADR-0065 §5 and its
  acceptance clarification 1 are followed as written.
- **What is not yet demonstrated.** The fields exist: the database client reports a severity and a status code on a database error, and
  `DbService.query` passes that error through unchanged. That the client behaves as the table assumes in each case has **not been
  demonstrated by a test**; this task changed no code and ran none.
- **Smallest missing implementation contract.** A3 must demonstrate, with tests against a real PostgreSQL, each row of the table:
  a server-reported `ERROR` (for example a statement cancelled by the server's own timeout) leaves the proof unconsumed and is
  classified "confirmed no consumption"; a client-side deadline, a dropped connection and a terminated session are classified
  "uncertain", whether or not the database applied the statement. **Conservative fallback (ruled):** whenever there is not
  enough evidence that the consume operation definitely did not commit, the result is classified **uncertain**. If the
  "confirmed no consumption" row cannot be demonstrated, it is not used and every consume error is "uncertain".
- **Never report a proof as unused after an ambiguous result.** Neither a response, a record nor a log line may say or imply that
  the proof remains available when the outcome is uncertain.
- **Required before A3 implementation acceptance:** focused tests that demonstrate the classification, row by row. This document
  implements no consumption logic.

### 11.6 Owner rulings of 2026-10-10 on the repair service's contract points

Recorded from the architecture owner's rulings, after the read-only contract investigation that followed implementation slices A
(`StepUpService.consumeForReferenceRepair`) and B (`HierarchyReference.repairReference`), which exist as local, unmerged commits. Documentation only: they supersede no
Accepted ADR, widen nothing in §9.3 A.1 beyond the three test lines named below, and authorize no slice C development.

**C2 — an authenticated non-Owner.** The answer is `403` in every state; the order of the authorization checks (§3.3) is unchanged.
What differs is the repair-specific audit record:

| State | Response | Repair audit record |
|---|---|---|
| source `local` | `403` | none |
| source `organization-service`, marker `local` | `403` | none |
| source `organization-service`, marker `frozen` | `403` | none |
| source `organization-service`, marker `org_authoritative` | `403` | the central denial, best effort, with the local fallback (§8.1) |
| source `organization-service`, marker unreadable | `403` | none |

- With the source `organization-service`, the marker may be read to decide whether a record is written. A failure to read it does not
  change the `403` and results in no repair write.
- This concerns **repair-specific** audit records only. It suppresses no existing, unrelated authentication or security evidence.

**C3 — a cached and authorized target while the marker is `frozen`.** The existing ADR-0061 behavior applies (§5, "already cached and
authorized"): `200` with `placed: false`; the valid proof is consumed; the accepted success record is written in its transaction; no
hierarchy reference is inserted or updated. This holds **only** when the target is already cached and authorized, so that nothing
needs placing. For an uncached target whose placement the frozen guard refuses, the existing `503` with the proof consumed is
unchanged. Frozen-mode write permissions are not broadened: the database guard of migration `0008` covers the hierarchy tables, and
no hierarchy write statement is issued on the cached path (it only reads the target's links).

**The frozen marker: final evidence policy (ruled 2026-10-10; closes the Owner-path question left open above C2 and C3).** With the
source `organization-service` and the marker `frozen`, every mandatory repair record and diagnostic of ADR-0064 is **kept**, except
the two denial records, which ADR-0065 ties to the Organization-authoritative mode, read with ADR-0061's definition of that mode
(source `organization-service` and marker `org_authoritative`). Responses, the order of checks and the proof
semantics are unchanged throughout.

| Outcome under `frozen` | Response and proof | Repair evidence | Basis |
|---|---|---|---|
| non-Owner | `403`; proof untouched | **no** repair-specific denial record | C2; ADR-0065 acceptance note (the refusal row "applies in the Organization-authoritative mode"); ADR-0061 clarification of that mode |
| Owner, proof rejected | `403 step_up_required`; proof not consumed | **no** repair-specific denial record | the same texts |
| cached and authorized target | `200`, `placed: false`; proof consumed | the success record, in the same transaction as the authorized no-op; no hierarchy insert or update | C3; ADR-0061 §4 step 7 and §5; ADR-0050 decision 9 |
| unresolved target | the collapsed `404`; proof consumed | the central unresolved action, **best effort**, with the existing local fallback if the central write fails | ADR-0064 D1 and §4 |
| placement refused by the database | `503`; proof consumed | the Auth-local failure record and the structured warning; nothing is changed or overwritten after the refusal | ADR-0061 §5 (the frozen example); ADR-0064 D2 and §3 |
| infrastructure failure | the applicable fail-closed answer (`503`); proof consumed when the failure follows step 3 (a failure of the consumption itself: §11.5, O8) | the Auth-local failure record and the structured warning | ADR-0064 D2 and §3 |
| anchor (parent-link) mismatch | `503`; proof consumed; nothing placed or overwritten | the security-incident action, best effort, after the rollback; the existing alert log line stays | ADR-0064 D3 and §4; ADR-0061 §6; for the repair path only (§9.3 A.1) |

- **The frozen marker does not make the repair inert.** Only the source `local` and the marker `local` do (§10.1). ADR-0061's order
  under `frozen` is unchanged: the proof is consumed before the lookup, and a refused placement comes after it.
- **A mismatch stays a security incident.** It is never reclassified as an ordinary infrastructure failure, and it is never emitted
  for first-touch `ensure()` (§9.3 A.1).
- **The metric stays deferred (§11.5, O7)**, and its condition stays mandatory: before any production activation, the metric with
  operational monitoring or an owner-approved equivalent.
- **No audit action is added or removed**, no ADR-0064 requirement is weakened, and no frozen-mode hierarchy write is permitted: the
  database guard is unchanged and the cached path issues no hierarchy write statement.
- **Existing generic authentication and security evidence is not suppressed** by any row above.
- **This is not permission to activate the repair**, to implement the repair service, or to emit anything: each stays separately
  authorized (§13).

**C1 — the T1 test literal (permission for the slice C change, when it is separately authorized).** In
`scripts/check-repo.test.mjs`, the assertion that lists the approved operations may gain exactly the fifth one, the hierarchy
reference repair. The other four entries are not altered and no enforcement is weakened. The implementation side stays the one
accepted T1 entry in `scripts/lib/checks.mjs`.

**C4 — the two caller-list assertions (same condition).** One narrow update in each of
`apps/auth-service/src/hierarchy/hierarchy-reference-repair.spec.ts` and `apps/auth-service/test/reference-repair-proof.e2e-spec.ts`:
each exact list of files allowed to name the method may add `apps/auth-service/src/hierarchy/reference-repair.service.ts` (written
relative to `src/` in the assertions). No other
caller is allowed, and neither list becomes a directory pattern.

**C5 — test TA8 corrected (§12.2).** With a malformed id and no proof: an eligible, authenticated Owner gets `400`; an authenticated
non-Owner gets `403`; an Owner in an inert state gets the collapsed `404`. The accepted order of validation and authorization is
unchanged; the earlier wording of TA8 expected `403` for the Owner, which contradicted that order.

**None of C1, C4 and C5 is a source or test change made now.** They are permissions and a documentation correction; the files are
touched only by a separately authorized slice C change.

### 11.7 Implementation status (2026-10-10): local, RED-governed, not merged

**What exists.** Four local commits on `feature/core-v2-a5-4-a3-reference-repair`, each separately authorized under §9.3 A.2 items 3 and
4, plus one authorized merge of `main` (bringing in PR #286's rulings). They are **not pushed, not in a pull request, not merged, not
deployed and not activated.** Production Auth runs with source `local` (§2), so even a deployed image containing this code would be
inert (§10.1).

| Slice | Commit | What it adds |
|---|---|---|
| A | `eedfa1e` | `StepUpService.consumeForReferenceRepair` (S2): one autocommit statement checking the proof, the owner, the session, the purpose, an allowed method, unused and unexpired; four outcomes (O8) |
| B | `89a21af` | `HierarchyReference.repairReference(kind, id, steps)` (O4): read-only resolve, the caller's authorization, placement with the caller's record in one transaction; the cached-ancestor comparison (O5); module-private failure causes (O6); `placed` from the target's insert (O13) |
| C | `04fe865` | the route, `ReferenceRepairController`, `ReferenceRepairService`, `ReferenceRepairResponseDto`; the two rate-limit buckets (O9); the one A5.4-T1 entry; the C1 and C4 test lines; integration tests |
| D | `fa32acd` | `StepUpService.verifyForService` (S1): the generic verification refuses the repair purpose without consuming the proof; the five A1 test changes of O1 and the one slice A test |

**Traceability (contract → implementation).**

| Contract | Where it is implemented | Evidence |
|---|---|---|
| Route `POST /auth/admin/hierarchy-references/:kind/:id/repair`, kinds `platform` and `organization`; `200` body exactly `{ kind, id, placed }`; existing error codes only; OpenAPI operation, every status, the `x-step-up-token` header, `@ApiProperty` on the response | `hierarchy/reference-repair.controller.ts`, `hierarchy/dto.ts` | integration tests; review |
| Order of checks (§3.3): authentication; the Owner from the database; source and marker; validation; rate limits; the proof; resolve, authorize, place | `hierarchy/reference-repair.service.ts` | integration tests; mutation checks |
| Source `local` and marker `local` inert (§10.1; O15); the marker not read with source `local` | `reference-repair.service.ts` | `test/reference-repair-local.e2e-spec.ts` |
| Marker missing, malformed, multiple or unreadable: `503 hierarchy_unavailable` before anything (§11.5) | `reference-repair.service.ts` | the same spec (test doubles: §11.7 limitations) |
| Owner and Company from the database; only an explicit `true` authorizes placement | `reference-repair.service.ts`; `hierarchy-reference.ts` | integration and unit tests |
| S2 and O8: one autocommit statement; `consumed`, `rejected`, `not_consumed` (a server-reported `ERROR` only), `uncertain` otherwise | `owner/step-up.service.ts` | `test/reference-repair-proof.e2e-spec.ts`: real statement timeout, cancel, terminate, stalled and cut connections |
| S1 (O1): the generic verification refuses the repair purpose, no consumption, the existing local denial record | `owner/step-up.service.ts` (`verifyForService`), `auth/auth.controller.ts` | `test/reference-repair-step-up.e2e-spec.ts` |
| O9: `reference_repair_owner` 5 per 300 s, `reference_repair_ip` 20 per 300 s, counted after the inertness gate | `config/app-config.ts`; the service | integration tests |
| Success record in the placement transaction; rollback when it cannot be written (ADR-0050 decision 9) | `hierarchy-reference.ts`; the service | integration test with the record write failing |
| C2 denials; O3 unrecordable input recorded locally; D1 unresolved; D2 failures with the closed reasons plus `auth_database_unavailable`; D3 anchor-mismatch incident; D4 best effort | the service | integration tests |
| Frozen evidence policy (§11.6) including the cached-target exception (C3) | the service; `hierarchy-reference.ts` | integration tests under marker `frozen` |
| O2: the four actions named only in the repair service and the approved tests; T1: one new entry | `scripts/lib/checks.mjs` | `npm run check:repo` |
| A2: `ensure()` and its golden fixture unchanged | `hierarchy-reference.ts` | the golden spec, unchanged fixture checksum |

**Local evidence.** The Auth unit suite (299 tests) and integration suite (558 tests), the Auth–Organization suite and the repository
checks passed locally, the integration tests against an isolated local PostgreSQL (run results, not reproduced in the repository). Temporary source mutations of each slice were caught
by its tests. Independent design-conformance reviews of each slice and of the four commits together found the implementation
conforming. This is local evidence only; it is not CI certification.

**Known limitations (as implemented; no remediation is committed here).**

- `auth_database_unavailable` labels any error that slice B does not classify after the proof is consumed: in practice a failure of
  Auth's own database while reading the cache, but also any other unclassified error on that path.
- A database failure before the proof (at the Owner lookup or the rate-limit write) answers `500`, with the service's generic error log
  and no repair-specific record; nothing is consumed.
- A database failure inside the placement transaction keeps the classification `placement_refused`, and any failure of the
  cached-target transaction (opening it or writing the record) is labelled `audit_intent_unwritable`, as slice B classifies them.
- A missing marker row, an unexpected marker value and several marker rows cannot exist in the database (migration `0008`); those
  cases are tested with controlled test doubles.
- The O7 failure metric is not implemented; it remains an activation condition (§11.5, O7).

**Not yet complete.**

- The commit of this documentation (slice E).
- Push and the pull request.
- GitHub CI certification of A3 (`core-ci-passed` on the pull request).
- Compatibility with the images actually deployed, demonstrated before any RED-exception merge (§11.1, O1).
- The G6 timing statement and condition (§15).
- The owner's RED-exception merge approval (§9.3 A.2 item 5) and the image-pinning framework.
- Image selection, production deployment (A.2 item 6).
- The audit-service deployment declaring the four actions; F6 and F7 with Auth's source `organization-service`; the O7 monitoring
  condition; activation (A.2 item 7).

Carried forward, not A3 decisions: mismatch recording from first-touch `ensure` (separate RED); the `parent_missing` investigation;
the timing of the audit-service deployment against the G6 refresh; the diagnostic CLI (A5.4-A4).

## 12. Test plan

Real PostgreSQL and the real application for every integration test; the stand-in Organization Service of the existing suites,
**configured** (URL and token) in every `local`-mode test so that "zero calls" is evidence. Central and outbox assertions read the
database with the real event writer. Expected *baseline* writes are captured on `main` before the change and committed as literals,
as A2 did; anything beyond them is a repair-related write and must be exactly what §7 lists.

### 12.1 Source `local`: inertness (§9.3 A.4)

| # | Test | Proves |
|---|---|---|
| TL1 | unauthenticated `401` (no bearer, an invalid bearer, a service token); Operator, Member and Organization administrator `403` | steps 1a, 1b |
| TL2 | Owner: byte-identical `404` (status, body, headers that are not per-request) for a valid proof, an invalid proof, no proof, a malformed id, an unknown `kind`, an existing id, another Company's id | step 1c precedes everything |
| TL2b | the same requests with source `organization-service` and marker `local` (§11.5, O15): the same byte-identical `404`; the TL3 checks hold (nothing consumed, counted or written; zero Organization Service calls). With marker `frozen` and an uncached target: `503`, proof consumed (TF1); a cached and authorized target is TL2d | the marker is part of the inertness gate |
| TL2d | marker `frozen`, every outcome (§11.6, the frozen evidence policy): a **cached and authorized** target answers `200` with `placed: false`, the proof consumed, the success record written and **no** hierarchy write statement; an **uncached** target whose placement is refused answers `503` with the proof consumed, no row, one local failure record (`placement_refused`) and the warning line; an **unresolved** target answers the collapsed `404` with the proof consumed and one unresolved record (local fallback if the central write fails); an **infrastructure failure** answers `503` with one local failure record and the warning line; an **anchor mismatch** answers `503` with the proof consumed, nothing placed or overwritten, the incident record and the alert log line; a **rejected proof** answers `403` with the proof not consumed and **no** repair denial record; a **non-Owner** answers `403` with no repair record | under `frozen` ADR-0064's evidence is kept, except the two denial records |
| TL2e | a refused **non-Owner** in each state (§11.6, C2): `403` every time; a repair record only with marker `org_authoritative`; with the marker unreadable the answer is still `403` and nothing is written | denial records follow eligibility; the order of checks is unchanged |
| TL2c | the marker is missing, malformed or cannot be read, with source `organization-service` (§11.5, O15), for an Owner: `503 hierarchy_unavailable` (a non-Owner still gets `403`, TL2e); nothing is validated, consumed, counted, looked up or placed, and no repair record is written. With source `local` and the same broken marker, the route still answers its inert `404` without reading the marker | an indeterminate marker is never treated as Organization-authoritative |
| TL3 | after TL1 and TL2: the proof's `consumedAt` is NULL; `auth_throttle`, `outbox`, `auth_audit_event`, `company`, `platform`, `organization`, `hierarchy_authority` and its event table are unchanged (counts and the hierarchy content digest); the stand-in records zero calls | no new write, no emission, no proof consumption |
| TL4 | after TL2, the generic `POST /auth/step-up/verify` refuses that proof (`403`) and its `consumedAt` is still NULL | the proof is not burned by either endpoint |
| TL5 | the three first-touch operations and `bootstrap-owner` behave as on `main` (the A2 integration spec, unchanged) | existing behavior with `local` |

### 12.2 Authorization and proofs (source `organization-service`)

| # | Test | Proves |
|---|---|---|
| TA1 | Owner with a valid proof repairs an uncached Platform, and an uncached Organization (Company cached; nothing cached) | success |
| TA2 | Operator, Member, Organization administrator, and a user of kind `owner` without an `owner` row: `403`, nothing placed, proof untouched, one `reference_repair_denied` (`no_authority`) with marker `org_authoritative`; no repair record in any other state (TL2e; §11.6, C2) | non-Owner refusal |
| TA3 | inactive user or session, no bearer: `401`, no record | unauthenticated |
| TA4 | proof absent; malformed; expired; already used; issued to another Owner; to another session of the same Owner; for another purpose; a repair proof row whose method is not allowed (inserted directly, as a fixture): each `403 step_up_required`, **not consumed**, no Organization call, one `reference_repair_denied` (`step_up_required`) with marker `org_authoritative`; no repair denial record under `frozen` (TL2d) | S2 rejections |
| TA5 | a proof for another purpose stays usable for that purpose after being refused here | no cross-purpose burn |
| TA6 | a secret-key-only step-up cannot be issued for the purpose (existing A1 test, unchanged) | factor-only |
| TA7 | malformed id or `kind`: `400`; rate limit: `429`; neither consumes the proof | step 2 |
| TA8 | a malformed id or an unknown `kind`, with no proof (corrected 2026-10-10, §11.6 C5): an **Owner** in the eligible state gets `400` (validation, step 2a, precedes the proof check); an authenticated **non-Owner** gets `403` (step 1b precedes validation), with the local denial record only and no central record when the marker is `org_authoritative` (§11.1, O3), and no repair record in any other state (§11.6, C2); an Owner in an inert state gets the collapsed `404` | the order of checks; O3 |

### 12.3 S1 and S2

| # | Test | Proves |
|---|---|---|
| TS1 | `POST /auth/step-up/verify` with a valid repair proof: `403 step_up_required`, `consumedAt` NULL, one local `owner.step_up.consume` `denied` record, and the proof then works on the repair route | S1 |
| TS2 | every other purpose on that endpoint behaves as on `main` (the existing suites, unchanged apart from O1's named tests) | no other purpose changed |
| TS3 | **replay:** a second request with a consumed proof gets `403`, even when the first ended in `404` or `503` | single use; never restored |
| TS4 | **concurrency:** two simultaneous requests with one proof (released together by a barrier): exactly one passes step 3, the other gets `403`; one consumption in the table | atomic statement |
| TS5 | **confirmed no consumption** (§11.5, O8): the consume statement answered by the database with a report of severity `ERROR` and a status code that does not leave completion unknown (for example the server's own statement timeout). *Method for TS5, TS6 and TF1's unwritable intent:* a test double of Auth's database pool, substituted through the application's dependency injection, that raises the chosen error or drops the connection at the chosen statement; no production code path exists only for tests: `503`, no Organization call, no placement, one local record `step_up_consume_failed`, no central record | S2 failure |
| TS6 | **uncertain** (§11.5, O8; a `FATAL` or `PANIC` report, a completion-unknown status code and a client-side deadline are uncertain too)**:** the connection dropped after the statement is sent (three variants: before the database applied it; after it applied it and before any reply; after the row was returned and before the statement completed): `503`, no Organization call, no placement, no retry of the statement, local record `step_up_consume_uncertain`; re-presenting the proof gives `403` when it had been applied, and proceeds when it had not | fail closed; no assumption |
| TS7 | `StepUpService.consume` is byte-identical to `main`, and its existing tests pass unedited | generic semantics unchanged |

### 12.4 Resolution, placement and privacy

| # | Test | Proves |
|---|---|---|
| TP1 | placement: rows parents first, one transaction, the success intent in the same transaction, `placed: true`; response has exactly `kind`, `id`, `placed` | steps 6 to 8 |
| TP2 | no-op: cached and authorized target gives `200`, `placed: false`, zero Organization calls, one success intent, no reference statement | cached target |
| TP3 | **collapsed `404`** (resolve completes; the failures before authorization answer `503` and are TF1 and TF3, as ruled in §11.1, O12)**:** unknown id, id outside Auth's scope, another Company's uncached id, another Company's cached id: byte-identical responses; nothing placed (including parents); proof consumed; one `reference_repair_unresolved` each, identical apart from the requested kind and id, `organizationId` `null` | privacy |
| TP4 | another Company's Owner cannot learn or place anything, and an Organization-scoped audit read of the probed Company shows nothing | concealment |
| TP5 | concurrent repairs of one id by two proofs (barrier): each `200`, one row, exactly one `placed: true`; a variant where one request inserts only the missing parent reports `placed: false` (§11.5, O13) | idempotence |
| TP6 | repair under a suspended or archived ancestor succeeds and grants nothing; a later grant still runs its own checks | lifecycle |
| TP7 | the repair never calls `ensure`; the read routes and every authentication path make zero Organization calls | boundaries |

### 12.5 Operational failures and anchor mismatch

| # | Test | Proves |
|---|---|---|
| TF1 | one test per reason of §8.2 except the two step-up reasons, which are TS5 and TS6 (authority down, timeout, redirect, oversized, malformed, `401`/`403` from the authority, no credential, parent missing, frozen hierarchy, success intent unwritable): `503`, nothing placed, proof consumed, one local `failure` record and one log line with the listed reason, **no** central record | D2 |
| TF2 | no record or log contains a token, URL, upstream body, name or parent id (asserted on the stored rows and captured logs) | hygiene |
| TF3 | mismatch at the anchor re-read, and at the cached-ancestor comparison: `503`, cached row unchanged, existing error log present, one `reference_anchor_mismatch_detected` with the system actor and `operation: reference_repair`, written after the rollback; neither batch 1 action written; the same under marker `frozen` (TL2d) | D3 |
| TF4 | **denial-audit failure:** with the outbox write failing, each refusal (`403`, `404`, mismatch `503`) is unchanged and leaves the local record (for the `403` refusals, only with marker `org_authoritative`: under `frozen` they write no repair record at all); with both failing, a log line; never a success | D4 |
| TF5 | success-intent failure rolls the placement back and answers `503` | ADR-0050 decision 9 |
| TF6 | a first-touch mismatch still writes **no** central record (unchanged) | scope of A3 |

### 12.6 Compatibility and static checks

| # | Test | Proves |
|---|---|---|
| TC1 | the A2 golden-trace spec passes with the fixture **byte-identical** (same checksum as on `main`), together with its mutation tests | `ensure` unchanged |
| TC2 | every existing Auth unit and integration suite and `test:e2e:auth-organization` pass; the only edited assertions are the six named under O1 (§11.1), each listed in the pull request; the A1 binding tests are re-pointed at the repair route so they still test the binding | existing behavior |
| TC3 | `npm run check:repo`: exactly one new T1 entry, the repair operation; the never-call list unchanged | boundary |
| TC4 | **producer scope:** the repository check of §11.4 (which replaced the two library assertions) refuses any mention of the four actions outside the four approved paths, with tests that deliberately violate its allow-list. A3 must pass that check unchanged, and a test asserts the anchor-mismatch action is written only with `operation: reference_repair` | producer scope |
| TC5 | every event the repair writes validates against the declared catalog entry (the contract's validator), for each kind and outcome, including `organizationId` for an Organization and a mismatch whose resource is an ancestor | contract fit |
| TC6 | mutation checks: removing the step 1c test, moving the placement before step 5, consuming inside the placement transaction, or adding a distinguishing field to the `404` record is caught by a test | the tests have teeth |
| TC7 | audit-service's suites that iterate over every action pass unchanged | consumer compatibility |

## 13. Separation of stages

The **five stages** of ADR-0065 §1 are local implementation, merge, production deployment, production audit emission, and F6/F7
activation. No stage authorizes the next.

The **seven separate authorizations** of §9.3 A.2:

| # | Authorization | State for A3 |
|---|---|---|
| 1 | design documents and test plans | this document |
| 2 | local A2 development | done (A2) |
| 3 | local A3 development | **granted per slice and done** for slices A to D (§11.7); slice E documentation in progress |
| 4 | each commit and each pull request | **granted for the four local slice commits only**; no push and no pull request yet |
| 5 | a RED-exception merge approval per pull request | not granted |
| 6 | each deployment of an image containing the code | not granted |
| 7 | audit emission and activation, after their prerequisites | not granted |

| Stage | What it does | What it does not do |
|---|---|---|
| implementation | code and tests exist locally | nothing reaches `main` |
| merge | the code is in the next auth-service build | no deployment (Auth build ≠ deploy); the route stays inert with source `local` |
| deployment | a certified digest runs in production, source still `local` | no emission, no repair: step 1c answers `404` |
| emission | permitted only once the audit-service declaring the four actions is deployed; it begins in practice when Auth's source becomes `organization-service`, because Auth's central audit relay already runs | not started by any of this work |
| activation | F6 and F7 switch Auth's source; the route becomes usable by the Owner | – |

## 14. Evidence required before an A3 RED-exception merge

1. The diff touches only: the repair route and service, `hierarchy-reference.ts`, `step-up.service.ts`, the verify endpoint, Auth's
   wiring and configuration, the one T1 entry in `scripts/lib/checks.mjs`, Auth tests, and documentation (API description, status
   rows). No migration, no organization-service or catalog change, no workflow change, and no `libs/` change other than what the
   O2 ruling allows: none (§11.1, O2: the relocation is a separate, earlier task).
2. The `local`-mode proof of §12.1 passing.
3. Every row of §7 reproduced by a test (§12.2 to §12.5), including S2 concurrency, replay and the uncertain outcome.
4. The A2 golden fixture byte-identical and its spec passing (TC1); every existing suite passing with only the six
   test changes named under O1 (TC2).
5. `check:repo` passing with exactly one new T1 entry (TC3).
6. The mutation checks of TC6.
7. Recorded owner decisions for O1 to O15 (§11.1, §11.3, §11.5); the O8 classification demonstrated by focused tests, with the
   conservative fallback applied wherever non-commit is not proven; and the O2 prerequisite task merged (done: PR #283). The O7
   metric is not a merge condition; it is an activation condition (§11.5).
8. An independent design-conformance review against ADR-0061, ADR-0064, ADR-0065 and §9.3, with no required finding open.
9. Full Core CI green on the pull request.
10. The G6 timing statement of §15 in the pull request.
11. The merge conditions of §9.3 A.2 item 5, **with evidence of compatibility with the images actually deployed** (§11.1, O1: the
    ruling does not presume it; it must be demonstrated before any RED-exception merge), the
    certified digest-set policy as framework, and the owner's separate **RED-exception merge approval**.

## 15. G6 timing and the certified digest set

- A3's own code changes the auth-service image only: no audit-service, organization-service or library source changes. The O2
  prerequisite task may touch tests under `libs/audit-contract/**` and repository scripts; it must provide verifiable evidence that no shipped
  runtime image contents change (condition 2 of §11.3) and preserve the G6 timing requirements (§11.1, O2).
- **Merged before the G6 baseline refresh**, A3 is in the auth-service digest that G6 selects and rehearses: inert with source
  `local` (the §12.1 evidence), then exercised after the rehearsed activation.
- **Merged after the refresh**, it changes the certified set, and a separately authorized re-rehearsal is required (§9.1 item 3).
- The audit-service digest in the certified set must declare all four actions (PRs #272, #274). Its production deployment comes
  before any emission; its timing against the refresh stays an open owner item.
- A2 is already merged (`d5a8cbb`) and is subject to the same rule. Whether the refresh follows that merge is not recorded here
  and stays OPEN until the certified digest set is selected.
- This document authorizes no G6 refresh or rehearsal, no digest selection, no deployment and no authority transition. The G6 plan
  and the active runbooks are not changed.

## 16. What this document does not do

It writes no code and no test. It changes no ADR and resolves no open decision. It authorizes nothing: not local A3 development, not a
commit of code, a pull request, a merge, a deployment, an emission or an activation.

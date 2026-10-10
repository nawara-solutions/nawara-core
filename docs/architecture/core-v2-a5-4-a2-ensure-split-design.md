# Core V2 A5.4-A2: `ensure` resolve/place split (design and test plan)

- **Status:** DESIGN AND TEST PLAN (2026-10-10), on `main` at `ce845d9` (the PR #277 merge). Documentation only: the first of the
  seven separate authorizations of the accepted A2/A3 exception ([A5 record](core-v2-a5-organization.md) §9.3, A.2 item 1). **It
  authorizes no code, test, commit of code, pull request, merge, deployment or activation.** Local A2 development is a separate
  authorization (A.2 item 2).
- **Class.** A5.4-A2 is **RED**, permitted only inside §9.3's narrow exception.
- **Authority.** [ADR-0061](../adr/0061-auth-hierarchy-reference-repair-and-diagnostics.md) (as partly superseded by
  [ADR-0064](../adr/0064-reference-repair-failure-and-incident-audit.md) and
  [ADR-0065](../adr/0065-reference-repair-pre-f7-development-and-step-up-consumption.md)),
  [ADR-0040](../adr/0040-organization-ownership-migration-decisions.md) decision 1,
  [ADR-0042](../adr/0042-service-token-scopes-and-administrative-authorization.md), and §9.3. Where this document differs, they govern.
- **Context:** the [A5.4-D1 specification](core-v2-a5-4-implementation-specifications.md) §5.1 and §5.2.

## 1. Scope

**A2 is a behavior-preserving refactor of one method.** ADR-0061 §4 requires that the combined `ensure` "must not be reused in a way
that places references before authorization" and that the implementation "splits it into a resolve step and a place step, keeping the
combined behavior for the existing first-touch callers". ADR-0065 §2 keeps that split required before the repair route. A2 is that
split and nothing else.

| In A2 | Not in A2 (A3 or separately decided) |
|---|---|
| inside `HierarchyReference` (`apps/auth-service/src/hierarchy/hierarchy-reference.ts`): a read-only resolve step and a place step, composed by `ensure` | the repair route, controller or service |
| tests that prove `ensure` behaves exactly as before | the repair-only comparison of a cached ancestor's parent link (ADR-0061 §4 step 4) |
| | any step-up purpose use, proof consumption or change to `/auth/step-up/verify` (S1, S2) |
| | any audit producer, outbox row or central record |
| | recording an anchor mismatch from first touch |
| | any change to the first-touch callers, the owner bootstrap, the client, the marker, the source, migrations, organization-service or the A5.4-T1 policy |

A2 adds **no** capability, caller, route, permission or emission. It does not make reference repair exist.

## 2. Current behavior to preserve (read on `ce845d9`)

`ensure(kind, id)`:

1. a malformed id → `false`, with no query and no call;
2. the target already cached (`SELECT 1 FROM <kind> WHERE id = $1`) → `true`, with no call;
3. no Organization Service credential → warn `hierarchy_reference_unavailable reason=no_credential`, `503 hierarchy_unavailable`;
4. **fetch, outside any transaction:** the target, then each parent in turn (Organization → Platform → Company), **stopping at the
   first ancestor already cached**; a missing target → `false`; a missing parent → warn `reason=parent_missing`, `503`; any client
   failure → `503` (the client logs its own reason);
5. **place, in one transaction:** set the reference-write flag, then for each fetched row, parents first, `INSERT … ON CONFLICT (id) DO
   NOTHING`; for a Platform or an Organization, re-read the parent link and, if it differs from the authority's, log
   `hierarchy_anchor_mismatch` at error level and throw `503`;
6. a refused write (for example a frozen hierarchy) → warn `reason=reference_write_refused`, `503`; an HTTP error thrown inside the
   transaction is rethrown unchanged;
7. → `true`.

Callers, unchanged by A2: `firstTouchOrganization` and `firstTouchPlatform` (which call `ensure` **only when the source is
`organization-service`** and return `true` otherwise), used by join-code creation, invitation creation and the platform-assignment
grant; and `bootstrap-owner`, which ensures a Company.

## 3. Design

### 3.1 Functions

| Function | Visibility | Responsibility | Database | Organization Service |
|---|---|---|---|---|
| `ensure(kind, id)` | public, **signature and behavior unchanged** | steps 1 to 3, then `resolve`, then `place`, then step 7 | as today | as today |
| `resolve(kind, id)` (new) | **private** | step 4 exactly: returns the fetched chain (parents first), or `null` when the target does not exist; throws `503` as today | **reads only** (the cached-ancestor checks) | the same `get` calls, in the same order |
| `placeChain(chain)` (new) | **private** | steps 5 and 6 exactly: one transaction, the reference-write flag, the per-row placement; the `kind` in the refused-write log is the **target's** kind (the last element of the chain), as today | the same statements, in the same order | none |
| `place(q, kind, row)` (existing) | private, unchanged | one row: the insert and the anchor re-read | unchanged | none |

- **The chain is never empty.** When `resolve` returns a chain, its last element is the target, so `placeChain` always opens its
  transaction on at least one row, as today.
- **Private on purpose.** A2 exposes nothing new: no class outside `HierarchyReference` can call the two steps. The barrier is
  TypeScript's `private`, a compile-time rule; the A5.4-T1 check does not inspect the methods of the client module itself. How A3's repair
  reaches them (visibility, or a dedicated method) is an A3 design decision under its own authorization; it would also need its A5.4-T1
  entry.
- **The client.** The Organization Service client is optional on the class. `ensure` keeps its existing no-credential check (step 3)
  before calling `resolve`, which receives or reads the already-checked client; no new null path and no wider access is introduced.
- **Inputs and outputs.** `resolve` takes the already-validated kind and lowercase id and returns `Array<{ kind, row }>` in placement
  order, or `null`. `placeChain` takes that array. No new type leaves the module.
- **Failure semantics** are those of §2, statement for statement: the same return values, the same `503 hierarchy_unavailable`, the
  same log lines at the same levels, the same point at which each is produced.
- **Transaction boundary** unchanged: fetches outside any transaction; all placements in one transaction; nothing committed when any
  placement fails.
- **No new diagnostics.** A2 adds no log line, metric, audit record or error code.

### 3.2 What must not change

The order of steps 1 to 3 before any fetch; the cached-ancestor stop (no fetch of an ancestor that is cached); that a cached ancestor's
link is **not** compared in `ensure`; the `ON CONFLICT DO NOTHING` idempotency; the anchor re-read and its log; the client and its
hardening; `firstTouchOrganization`, `firstTouchPlatform`, `fromOrganizationService`, `reportSource`; the injected dependencies.

### 3.3 Source `local`: why A2 is inert there

With `AUTH_HIERARCHY_SOURCE` `local`, as in production today, `firstTouchOrganization` and `firstTouchPlatform` return `true` without
calling `ensure`, so neither new step runs on any HTTP path.

The command line is different: `bootstrap-owner` calls `ensure` whenever it is given a Company id, **whatever the source**
(`apps/auth-service/src/cli/owner-tools.ts`). Without a credential it fails closed unless the Company is already cached; with one, it can
place the Company reference row even with source `local`. That is today's behavior, and A2 keeps it. **For A2, "inert" therefore means
"unchanged", not "unreachable":** A2 adds no path and changes no condition under which `ensure` runs.

### 3.4 Step-up, audit and endpoints

A2 touches no endpoint, no DTO and no response. It uses no step-up purpose and consumes no proof; S1 and S2 are A3. It writes no
audit record and no outbox row; `ensure` writes none today.

## 4. Mandatory safety design: what the tests must prove with source `local`

A2 introduces no repair capability, so these tests prove that **A2 adds nothing**; A3's own inaccessibility proof (§9.3 A.4) stays
required for A3.

| Must hold with source `local` | Test |
|---|---|
| no reference placement on any HTTP path | run join-code creation, invitation creation and a platform-assignment grant on the real application: the row counts and the content digest of `company`, `platform` and `organization` are unchanged, and the Organization Service stub records **zero** calls |
| no new central audit event | the audit intents written by those three operations, read from Auth's outbox table, equal the committed expected list (action names and counts) |
| no new outbox row | the outbox rows written by those operations equal the committed expected list, by event name and count (rows are counted whether or not the relay has already published them) |
| no proof consumption beyond today's | each operation consumes exactly one step-up, for its existing purpose (`join_code.create`, `admin_invitation.create`, `platform_assignment.grant`); no `hierarchy.reference.repair` proof is required or consumed |
| no authority or marker change | `hierarchy_authority` (mode and timestamps) and the count of `hierarchy_authority_event` rows are unchanged |
| the command-line path is unchanged | `bootstrap-owner` with a Company id and source `local`: the same single Company reference row and the same outcome as on `main`, and nothing else written; the statements themselves are compared by the unit trace of the Company scenario (§5.1) |

Requirements for these tests to mean anything:
- the application is started with `AUTH_HIERARCHY_SOURCE=local` **and** a configured `ORGANIZATION_SERVICE_URL` and
  `ORGANIZATION_SERVICE_TOKEN` pointing at the stub, so a call would be possible and "zero calls" is real evidence;
- the outbox and audit-intent assertions read the database tables with the real event writer (the harness's `realEvents` option), not
  the recording bus, which writes no row;
- "equal to `main`" is not computed at test time: the expected lists are **captured once on `main` before the refactor and committed
  as literals**.

These comparisons separate **existing, unrelated Auth writes** (the join code, invitation or assignment row, their audit intents, the
step-up they already consume) from anything new: the expectation is "identical to `main`", not "no write at all". Every automatic stop
condition of §9.3 A.5 stays in force; for A2 the relevant ones are any behavior change in an existing hierarchy, first-touch, bootstrap,
step-up or verify test, a failing equivalence test, and any need for a T1 entry, a migration, an organization-service or a shared-library
change.

## 5. Test plan

### 5.1 Unit tests (no database, no network)

A fake database and a fake client that **record every statement and every call in order**:

1. **Trace equivalence.** For each scenario of §5.3 that a fake database can express, the recorded trace equals a **golden trace
   recorded from `main` before the refactor** and committed as a fixture. The trace records, in order: each client call; each SQL
   statement (text and parameters); each transaction open, commit and rollback; each logger call with its **level** and message; and the
   final outcome (the return value, or the thrown status and code). Inputs are fixed (fixed UUIDs, a deterministic clock, scripted
   statement results), so nothing in the trace is random. The same committed harness runs unchanged against `main` and the refactor.
2. **`resolve` is read-only.** In every scenario the statements issued during `resolve` are `SELECT` only, and no transaction is opened.
3. **`placeChain` makes no call** to the client and opens exactly one transaction.
4. **Composition.** `ensure` calls `resolve` once and `placeChain` at most once, and never `placeChain` when `resolve` returns `null`
   or throws. Tests 2 to 4 reach the private steps through a test spy on the instance; no production visibility is widened for them.

How the unit harness works, with no production change: `HierarchyReference` is constructed directly with a fake database, the
configuration and a fake client (its constructor takes exactly those). The fake database implements the two methods `ensure` uses,
`query` and `tx`; its `tx` runs the callback and records the transaction's open, commit, or rollback and rethrow itself, so the trace
proves ordering and statements, while real transaction semantics stay proven by the integration suites. Log calls are captured with
Nest's `Logger.overrideLogger` and a recorder that keeps `log`, `warn` and `error` apart, restored after each test.

Log **levels** (warning or error) are provable only here: the integration harness's capturing logger does not separate them.

### 5.2 Integration tests (real PostgreSQL; the existing Organization Service stub)

The existing suites must pass **unchanged, with no edit to their assertions**:
`hierarchy-reference.e2e-spec.ts` (first touches, the unknown Organization, every unavailable case, the missing parent, the anchor
mismatch, the authentication paths never calling, the frozen hierarchy, the fresh-environment bootstrap), `hierarchy-authority.e2e-spec.ts`,
the suites that exercise the owner bootstrap (`owner-tools.e2e-spec.ts`, `cli.e2e-spec.ts`, `concurrency.e2e-spec.ts`,
`runtime-role.e2e-spec.ts`), `onboarding.e2e-spec.ts`, `admin-invitation.e2e-spec.ts`, `platform-authz.e2e-spec.ts`,
`bootstrap.e2e-spec.ts` (the HTTP process start: general regression only, not owner-bootstrap evidence), and the cross-service
`test:e2e:auth-organization`.

New integration tests: the source-`local` table of §4; scenario 12 (concurrent first touches) and scenario 13 (a second bootstrap
run), which no existing suite covers. Scenario 3 (no credential) has no existing test either and is covered by the unit trace.

### 5.3 Scenarios (unit trace and integration)

| # | Scenario | Expected |
|---|---|---|
| 1 | malformed id | `false`; no statement, no call |
| 2 | target cached | `true`; one `SELECT`; no call |
| 3 | no credential | `503`; warn `no_credential`; no call |
| 4 | uncached Organization, nothing cached | calls: Organization, Platform, Company; one transaction placing Company, Platform, Organization; `true` |
| 5 | uncached Organization, Platform cached | calls: Organization only; the cached Platform is **not** fetched or compared; one row placed |
| 6 | uncached Platform, Company cached | calls: Platform only; one row placed |
| 7 | target unknown to the authority | `false`; nothing placed |
| 8 | parent missing at the authority | `503`; warn `parent_missing`; nothing placed |
| 9 | each client failure: `409`, `5xx`, timeout, redirect, oversized, malformed, `401`/`403` | `503`; nothing placed |
| 10 | anchor mismatch (a concurrent row with another parent) | `503`; error log `hierarchy_anchor_mismatch`; the cached row unchanged; the transaction rolled back (the existing test asserts the first three; the rollback and the log level are asserted by the unit trace) |
| 11 | frozen hierarchy, on a single-row chain (a Company) **and on a multi-row chain** (an Organization target with its Platform and Company uncached, refused at the first insert) | `503`; warn `reference_write_refused kind=<the target's kind>` (`organization` for the multi-row case, never the first row's kind); nothing placed (the existing test covers a Company and the `503`; the warning and the multi-row case are asserted by the unit trace) |
| 12 | concurrent first touches of the same id (integration only) | both succeed; one row |
| 13 | bootstrap with a Company id | the Company reference placed once; a second run returns `created: false` (an owner exists) and places nothing, the row being cached |

### 5.4 Negative security cases

- no class other than `HierarchyReference` can reach `resolve` or `placeChain`: they are `private`, enforced by the compiler
  (typecheck and build). The A5.4-T1 check neither proves nor enforces this, since it does not scan the client module's own methods;
  it is simply unaffected, and must pass with its policy unchanged (the same four approved operations);
- no placement can happen without a successful fetch from the authority in the same call (scenarios 7 to 9);
- the authentication paths still never call Organization Service (the existing test);
- no client-supplied value is ever placed (rows come only from the authority's answer).

### 5.5 Single-use proof constraints

Not applicable to A2: it consumes no proof. The regression check is that the existing step-up and verify suites pass unchanged
(`step-up.e2e-spec.ts`, `step-up-verify.e2e-spec.ts`, `reference-repair-step-up.e2e-spec.ts`).

### 5.6 Checks to run

auth-service typecheck, lint, build, unit and the full e2e suite; `test:e2e:auth-organization`; `npm run check:repo`; `npm run
test:repo`; `git diff --check`; commitlint; an independent security and design-conformance review. Not the Final Core Validation.

## 6. Evidence required before a RED-exception merge

1. The source diff touches only `hierarchy-reference.ts`; the rest is Auth test files (the unit spec, the golden-trace fixture, the new
   integration tests) and the status rows of the A5 record and the roadmap; no migration, no organization-service, shared-library, catalog,
   workflow or check-script change.
2. The golden-trace fixture recorded from `main`, and the trace-equivalence test passing.
3. Every existing suite of §5.2 passing with **no assertion edited**, and each automatic stop condition of §9.3 A.5 checked and not
   triggered.
4. The source-`local` table of §4 passing.
5. `check:repo` passing with the A5.4-T1 policy unchanged.
6. A mutation check: at least one deliberate deviation (for example comparing a cached ancestor, placing before the fetch completes, or
   logging the first row's kind instead of the target's in the refused-write warning) is caught by the tests.
7. The independent review, with no required finding open.
8. Full Core CI green on the pull request.
9. The G6 timing condition of §7 stated in the pull request, with a confirmation that no G6 baseline refresh has yet selected the
   certified digest set, or that a re-rehearsal is authorized.
10. The merge conditions of §9.3 A.2 item 5: evidence that **no observable behavior of a deployed image changes** (items 2 to 4, with
    source `local` and with source `organization-service`); the image-pinning condition, which is the accepted certified digest-set
    policy of §9.1 item 3 (a framework, not a merge or deployment approval); and the owner's separate **RED-exception merge approval**.

## 7. G6 dependency

- **Before G6:** A2 may be developed (its own authorization) and merged (its own RED-exception merge approval) under §9.3. A2 never
  depended on ADR-0065's lifting of the Audit Service and F6/F7 timing: it emits nothing and has no runtime effect to gate (§9.3 A.3).
- **Still blocked:** deploying an image containing A2 (separately authorized, through the certified digest set); any activation. A2 has
  no emission to gate.
- **Certified digest set.** `ensure` is code the G6 rehearsal runs (the F4 owner bootstrap, and the first touches after activation).
  A2 changes the auth-service image, so it must be merged **before the G6 baseline refresh** that selects the certified digest set, so
  G6 rehearses the refactored code; merged after that selection, it changes the set and needs a separately authorized re-rehearsal.
- **Needs additional authorization:** local development; each commit and pull request; the merge; any deployment; anything of A3.

The G6 plan and the active runbooks are not changed by this document.

## 8. Open points (none blocks the A2 design)

- How A3 reaches the two steps (visibility or a dedicated repair method): an A3 design decision.
- The exact name of the place step (`placeChain` is illustrative).
- Whether the golden trace compares SQL text exactly or normalized whitespace: fixed when the fixture is recorded.

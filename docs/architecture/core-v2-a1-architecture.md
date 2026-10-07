# Core V2 A1: architecture

- **Status:** RECORD of A1.0 discovery (read-only, approved by the owner) and **A1.1 architecture decisions and ADR governance
  reconciliation**, written 2026-10-07 on `main` at `f4faf98` (PR #218 merge), and **A1.2: the consolidated conventions ADR**
  ([ADR-0056](../adr/0056-core-architecture-and-api-conventions.md), **Accepted** by the architecture owner on 2026-10-07; ADR-0034
  superseded; §8, §9), **A1.3: caller-policy convergence** (five services on the kit parser; **closed on `main`**, PR #220, merge
  `5e90601`; §10), **A1.4: architecture guards** (repository checks only; **closed on `main`**, PR #221, merge `21edab9`; §11) and
  **A1.5: certification** (records only; **complete locally, owner review pending**; §12). **A1 is OPEN** until the A1.5 PR is
  merged. A1.1, A1.2 and A1.5 change documentation only; A1.3 changes the five services' policy parsers, their tests and one runbook;
  A1.4 changes the repository checks and their tests only. No kit, Auth, infrastructure, workflow or package change, and no production
  action.
- **Scope of A1** ([roadmap](../CORE-ROADMAP.md) A1; [V2-A record](core-v2-a-baseline-and-change-safety.md) §4, §5, §7): service
  boundaries and dependency direction; the standard bootstrap and service-kit adoption; the Auth convergence target; the common request
  context; the contract compatibility and migration strategy; Q-ADR-1 and the review of Proposed ADRs; Core-wide DTO conventions; route
  naming (with A16); the caller-policy parser migration (with A6); the ADR-0054 D10 policy for new code.
- **Not A1:** secrets and configuration lifecycle (A2); messaging conventions and outbox retention F12 (A3); authentication features
  and Auth code convergence (A4); Organization authority (A5, F6, F7); authorization semantics (A6); S21-4 outbound redirect hardening
  (A14 residual); S21-5 broker readiness (A3 / A12); F9, ADD drift, templates and test-environment follow-ups (A15); production
  observability (A12.10); product contracts (A16).

## 1. A1.0 findings (summary)

- **Dependency direction holds.** Services depend only on `@nawara/service-kit` and `@nawara/audit-contract`; no application imports
  another; the libraries import no application; `service-kit` does not import `audit-contract`. `audit-contract` mirrors the kit's
  event grammar and `NewEvent` shape deliberately (comment references, a dev-only dependency, a test keeps them identical).
- **Runtime calls.** Audit, Organization and Release call Auth; Auth calls Organization; Payment calls Auth and Organization; Billing
  calls Auth, Organization and Payment; File and Notification call no service. The Auth ↔ Organization pair is the **intentional
  pre-F6 transition state** (Auth still owns the hierarchy; Organization is implemented, not authoritative) and stays until A5 / F6 / F7.
- **Conventions in practice.** Most of ADR-0034 is implemented: a singular service prefix with plural resources, no `/v1`, root
  `/health` and `/ready`, OpenAPI at `/docs`, `X-Request-Id` / `X-Correlation-Id`, `Idempotency-Key`, `?limit&cursor` → `{ items,
  nextCursor }`. ADR-0054 defines the error contract. Responses use camelCase, UUID v4 ids, ISO-8601 timestamps, explicit `null` and
  `as const` string unions. Validation is strict everywhere (unknown fields rejected, errors localized) through two mechanisms:
  `class-validator` (auth, file, payment, release) and hand-written parsers (audit, billing, notification, organization). No written
  DTO convention exists. ADR-0034's "pagination helpers" were never added to the kit; pagination is per service.
- **Kit adoption.** Seven services use `configureApp`. Auth wires its bootstrap explicitly (the kit's request context, metrics and
  localized validation pipe; its own configuration loader; `AuthExceptionFilter` extending the kit filter) and keeps `/auth/health`
  (D5).
- **Caller policy.** The kit's `parseCallerPolicy` (ADR-0052) is used by Billing and Payment. Organization, Notification, File, Audit
  and Release have hand-written parsers: deny by default, an entry required for every registered caller, fail-closed `ConfigError` at
  startup, but **no duplicate-key detection** (plain `JSON.parse`), so a duplicated caller entry silently overrides the earlier one.
- **Routes.** The routes flagged earlier (`/notification/notifications`, File's routes) follow ADR-0034's pattern; `/file/t/:token` is a
  capability URL.

## 2. Owner decisions (A1.1, approved 2026-10-07)

| ID | Question | Decision | Rationale | Scope and non-goals | Phase |
|---|---|---|---|---|---|
| **OD-A1-1** (Q-ADR-1) | When does an ADR become Accepted? | **A: on the architecture owner's explicit approval.** Merge alone, implementation, tests, deployment or another ADR building on it are not approval | matches the recorded practice of ADR-0040, 0041, 0042, 0050–0055; keeps "Accepted" meaningful | applied in [`docs/adr/README.md`](../adr/README.md) (workflow and status lifecycle). No approval board or ceremony. No bulk promotion | A1.1 |
| **OD-A1-2** | The authoritative source of Core API and architecture conventions | **B: one consolidated, current conventions ADR (A1.2) that supersedes ADR-0034** | ADR-0034 is Proposed, partly amended (ADR-0054) and silent on DTOs, D10 and dependency rules; one current source is needed by A15 and A16 | A1.1 records the decision only. ADR-0034 stays Proposed and is marked superseded only once the A1.2 ADR exists and is Accepted | A1.2 |
| **OD-A1-3** | Migrate the five hand-written caller-policy parsers to the kit? | **A: migrate in A1.3**, Organization, Notification, File, Audit, Release, one service per change | uniform fail-closed parsing and shared duplicate-key detection | keep every environment-variable name, caller identity and scope / authorization semantic exactly; authorization semantics stay A6 | A1.3 |
| **OD-A1-4** | Auth bootstrap and configuration convergence | **A: A1 defines the target; the Auth code convergence belongs to A4** | Auth merges build images, and production Auth has drifted from its recorded digest: no Auth churn inside A1 | no Auth code change in A1; D5-compatible behaviour (`/auth/health`) preserved; the divergence is not an A1 implementation task | target: A1.2; code: A4 |
| **OD-A1-5** | ADR-0054 D10 for new code | **A: new code may echo only request property names from client-derived input in error messages** | codifies the existing safe rule | the three documented English-only exceptions (Organization `unknown query parameter`, Payment currency and provider ids, Billing snapshot key paths; [error-localization guide](core-error-localization.md) §8) stay unchanged; no existing error contract changes | A1.2 |
| **OD-A1-6** | A retryable signal in HTTP error bodies | **A: none.** The convention is HTTP 503 with a stable `*_unavailable` code (for example `hierarchy_unavailable`) for an unavailable upstream | no consumer needs a field; the 503 + code pair already distinguishes the case | ADR-0054's envelope unchanged; reconsidered only if A3, A16 or a real consumer shows a concrete need | A1.2 |

## 3. Review of every Proposed ADR (A1.1)

Rule (OD-A1-1): only an explicit owner approval makes an ADR Accepted. No Proposed ADR has a recorded explicit owner approval: every
ADR's `Deciders: Anwar (project owner)` line is authorship (it appears on Accepted, Proposed and Superseded ADRs alike), and no
other record states an approval of these ADRs. **No status is changed by A1.1.**

Classification: **A** keep Proposed; **B** ready for acceptance on an existing explicit owner decision; **C** superseded on
authoritative evidence; **D** defer the status change (outside A1).

| ADR | Title (short) | Implementation | Explicit owner approval | Superseding ADR | Class | Status after A1.1 / reason |
|---|---|---|---|---|---|---|
| 0017 | Single owner per Company, CLI force-reset | single owner implemented; the CLI force-reset tool was never implemented and is not to be built (ADR forward note) | none | amended by 0024, 0050 | D | Proposed. Auth / Company ownership: A4 / A5 |
| 0018 | RabbitMQ via `@golevelup/nestjs-rabbitmq` | RabbitMQ implemented; its own forward note (2026-09-24, ADR-0046 rule 17) records that no Core service uses `@golevelup/nestjs-rabbitmq` any more (the kit's `RabbitMqEventBus`, `amqplib`) | none | — | A | Proposed. The title and decision text still name the library and no amendment or superseding ADR exists: A3 reconciles it before any acceptance |
| 0020 | Organization entity, platform-scoped management | implemented in Auth | none | amended by 0024 | D | Proposed. Hierarchy: A5 |
| 0021 | Payment platform-scope check | implemented scaffold | none | — | D | Proposed. A6 / A11 |
| 0022 | Company and Platform entities | implemented in Auth | none | amended by 0024 (supersedes 0009, 0016) | D | Proposed. A5 |
| 0023 | Platform-access check, operator login decoupling | implemented | none | amended by 0024 (supersedes 0011, 0014) | D | Proposed. A4 / A5 |
| 0024 | Database-enforced tenancy and authorization integrity | implemented in Auth | none | — | D | Proposed. A5 / A6 |
| 0026 | Authentication is not entitlement | implemented (login / refresh not gated on licenses) | none | — (supersedes 0005; partly 0004, 0006) | A | Proposed. See §4. Acceptance needs the owner |
| 0028 | Join codes, membership, organization-admin authority | implemented | none | — | D | Proposed. A5 / A6 |
| 0029 | Organization admin invitations | implemented | none | — | D | Proposed. A5 / A6 |
| 0030 | Multi-organization membership, REVOKED | implemented | none | partly supersedes 0001 | D | Proposed. A5 |
| 0031 | organization-service as future hierarchy owner | Organization implemented, not authoritative; mechanism deliberately not designed | none (the amendment records the owner's direction on scope, not acceptance) | — (0039 builds on it and decides its O9 mechanism; 0031's text is unchanged) | D | Proposed. A5 / F6 |
| 0032 | Database per service on a shared server | implemented | none | — | A | Proposed. A1-relevant; acceptance needs the owner (the A1.2 ADR restates the boundary rule) |
| 0034 | Service-kit and one set of API conventions | largely implemented; error convention amended by 0054 | none | to be superseded by the A1.2 ADR (OD-A1-2) | A | Proposed until the A1.2 ADR exists and is Accepted |
| 0035 | Financial service boundaries | implemented (billing, payment) | none | — | D | Proposed. A10 / A11 |
| 0036 | Money, parties, source references | implemented | none | — | D | Proposed. A10 / A11 |
| 0037 | Reliable events: outbox and inbox | implemented and certified (built on by Accepted 0046, 0049) | none | — | A | Proposed. A3 owns its content; acceptance needs the owner |
| 0038 | Entitlement lives in billing-service | implemented | none | partly by 0044 | D | Proposed. A10 |
| 0039 | Organization ownership and migration authority | implemented in part | none | partly by Accepted 0040 (already marked) | D | Proposed (partly superseded). A5 / F6 |
| 0043 | Product-specific entry context | not implemented ("draft; not approved") | none | — | D | Proposed. A16 |
| 0044 | Subscription and Entitlement final model | implemented (Stage 12.1–12.7) | none | — | D | Proposed. A10 |
| 0045 | Commercial `entitlementKind` fields | existing fields recorded | none | — | D | Proposed. A10 |

**Owner-acceptance candidates** (implemented, relied on, no recorded approval; each needs its own explicit owner approval, one at a
time): 0026, 0032, 0037, 0018 after A3 reconciles its library choice, and the Organization, Auth and financial ADRs when their stages (A3, A4, A5, A10, A11) reach them.

## 4. ADR-0004, 0006, 0008 and 0026

- **0026** (Proposed, implemented) says it supersedes **0005 in full**, the **login / refresh usage** of 0004 and 0006's
  `subscription_invalid` contract, and leaves 0004's **registration-time** license check and the license ownership of 0006, 0007 and
  0008 unchanged (that ownership was later moved to billing by 0038 / 0044, and 0035 amends 0026's ownership statement and narrows
  0006; all three are Proposed).
- **No explicit owner approval of 0026 exists** (case B). 0026 stays **Proposed**, and **0004, 0006 and 0008 stay Accepted**: they are
  at most partly superseded, and only once 0026 is Accepted. 0008 is not superseded by 0026 at all.
- **Recorded inconsistency:** 0005 is already marked `Superseded by ADR-0026` while 0026 is Proposed. The same pattern exists for
  0009, 0016 (→ 0022), 0011, 0014 (→ 0023) and the Accepted 0001 (`partially superseded by ADR-0030`, Proposed). 0004 and 0006 also
  carry `Amended by ADR-0026` banners: those are amendment notes, not status changes, and their status stays Accepted. These markers
  stay as historical record; under OD-A1-1 supersession becomes formal when the newer ADR is Accepted
  ([`docs/adr/README.md`](../adr/README.md), status lifecycle).
- **When the owner accepts 0026:** mark 0004 and 0006 `Partially superseded by ADR-0026` (login / refresh usage, `subscription_invalid`),
  and leave 0008 as it is.

## 5. A1 targets (recorded; not implemented)

- **Caller policy (A1.3).** Organization, Notification, File, Audit and Release move to the kit's `parseCallerPolicy`. Unchanged:
  environment-variable names, caller identities, scopes and authorization semantics. Gained: uniform fail-closed parsing and
  duplicate-key detection. One service per change, each under the V2 validation protocol (focused tests and mutants, service
  regression, CI). Organization and Audit merges build images (build ≠ deploy).
- **Auth (target in A1.2, code in A4).** Auth's bootstrap converges on the kit's standard bootstrap and configuration loading, keeping
  `/auth/health` (D5), the localized validation pipe and its `AuthExceptionFilter` contract.
- **Errors.** ADR-0054 unchanged. No retryable field. An unavailable upstream answers 503 with a stable `*_unavailable` code.
- **D10.** New code echoes only request property names from client-derived input; the three documented exceptions stay.
- **Pagination.** No kit pagination helper: it is not needed for architectural correctness (the contract `?limit&cursor` → `{ items,
  nextCursor }` is what matters). A15 may consider one if templates or generators show a real need.
- **Unchanged boundaries.** Applications → `service-kit` / `audit-contract` only; never library → application, application →
  application, or product logic in a Core library. The Auth ↔ Organization runtime dependency stays until A5 / F6 / F7.

## 6. A1.2 handoff: the consolidated conventions ADR

**One ADR**, "Core architecture and API conventions", which supersedes ADR-0034 once Accepted. It states the current rules for:
service boundaries and database per service; dependency direction; request and response DTOs (camelCase fields, UUID identifiers,
ISO-8601 timestamps, explicit `null` in responses, `as const` string-union enums); pagination (`?limit&cursor` → `{ items, nextCursor }`,
bounded `limit`); strict unknown-field rejection, and the validation **contract** as distinct from the validation **mechanism**
(`class-validator` or a hand-written parser); route naming (a singular service prefix, plural resources, `POST …/:id/<verb>` actions,
`/<service>/admin/…`), route compatibility (existing V1 routes stay; new endpoints follow the convention; breaking changes go to
`/v2/<prefix>` with a migration plan) and the capability-URL exception (`/file/t/:token`); versioning; `Idempotency-Key`; request and
correlation ids; the HTTP error envelope (ADR-0054) and the 503 `*_unavailable` convention; ADR-0054 D10 for new code; `/health`,
`/ready`, `/docs` and the separate metrics listener; the Auth convergence target; the caller-policy convergence target; and the generic
consumer boundary for AI workloads (ADR-0055: a future `nawara-ia` is one more registered caller) and products (ADR-0041, ADR-0050).

## 7. Phases

```text
A1.0  discovery                                   ✅ complete (owner-reviewed)
A1.1  decisions, ADR governance                   ✅ closed on main (PR #219, merge 88e11b8); owner-approved
A1.2  consolidated conventions ADR (ADR-0056)    ✅ closed on main (PR #219, merge 88e11b8); ADR-0056 Accepted, ADR-0034 superseded
A1.3  caller-policy migration (five services)     ✅ closed on main (PR #220, merge 5e90601; §10)
A1.4  repository guards                           ✅ closed on main (PR #221, merge 21edab9; §11)
A1.5  certification                               ✅ complete locally (§12); owner review pending
```

A1 is OPEN. Unchanged: A3.6 and A3.7 deferred; A12.10 not started; G4 and G6 deferred; G7, F6 and F7 locked; Final Core Validation
absolute last.

## 8. A1.2: ADR-0056 (2026-10-07)

- **Created:** [ADR-0056 "Core architecture and API conventions"](../adr/0056-core-architecture-and-api-conventions.md), status
  **Proposed**: under OD-A1-1 it becomes Accepted only on the architecture owner's explicit approval, which is pending.
- **Content:** the §6 handoff, each rule labelled [CURRENT] (normative and implemented), [COMPAT] (existing behaviour kept), [TARGET]
  (agreed, not implemented: caller-policy migration in A1.3, Auth bootstrap convergence in A4) or [DEFERRED] (another stage).
- **Verified against the code before writing:**
  - `nextCursor: string | null`, `null` on the last page (Audit, Billing, Organization);
  - `Idempotency-Key` required where read (`idempotency_key_required`, `idempotency_key_reused`): File upload, Notification send,
    Organization creates and admin writes, Payment cancel and attempts; Payment create, Billing creates and Release register
    deduplicate by natural key instead;
  - the kit's outbound clients forward request and correlation ids;
  - every service serves OpenAPI at `/<service>/docs`, only when `SWAGGER_PASSWORD` is set, behind basic authentication;
  - `/health` is liveness and `/ready` runs dependency checks and answers 503 while draining; `/auth/health` is a readiness-style
    database check (D5);
  - unknown query parameters are rejected by Audit, Organization and Release; Billing's invoice list ignores unknown keys
    (recorded as [COMPAT]);
  - provider webhooks take a raw, signature-authenticated body ([COMPAT]).
- **Design-conformance review** (read-only) found eight factual errors in the first draft. All were corrected in the documentation
  only: the docs path and its condition; the idempotency list; the query-parameter list; the optional `code` and `requestId` fields;
  Auth outside `configureApp`; Auth's verb routes, `GET /` and the unprefixed probes as [COMPAT]; `/auth/health` as readiness-style;
  caller policy decided in ADR-0042 and adopted through ADR-0052.
- **ADR-0034:** **not** marked superseded. It carries a forward note stating that ADR-0056 is intended to supersede it once Accepted.
  The formal `Superseded by ADR-0056` change happens after the owner accepts ADR-0056.
- **Next:** A1.3 (caller-policy migration), after the owner's review of A1.2. A1 stays open.

## 9. A1.2 owner acceptance (2026-10-07)

- **ADR-0056 Accepted.** The architecture owner explicitly approved and accepted ADR-0056 in the A1.2 architecture-owner review. This
  is the approval OD-A1-1 requires; its status line records date and source. No other ADR received approval: the 22 Proposed ADRs
  reviewed in §3 (including 0018, 0026, 0032 and 0037) keep their status.
- **ADR-0034 Superseded by ADR-0056.** Under OD-A1-1 supersession is formal once the superseding ADR is Accepted, so ADR-0034's status is
  now `Superseded by ADR-0056`; its text is kept unchanged as history, with a forward note pointing to ADR-0056 as the current
  convention. (The §3 table shows ADR-0034 as it stood at A1.1.)
- **Owner confirmations:**
  1. OpenAPI: the convention is the implemented one: `/<service>/docs`, mounted only when `SWAGGER_PASSWORD` is configured, behind
     basic authentication (ADR-0056 §10).
  2. Unknown query parameters: rejection is the rule for **new** endpoints (unless an explicit contract says otherwise); it is not a
     retroactive migration requirement, and existing endpoints (Billing's invoice list included) keep their behaviour (ADR-0056 §4).
- **Documentation drift (follow-up, not fixed here):** `CLAUDE.md` ("Tech conventions") still says OpenAPI is mounted at `GET /docs`
  via `SwaggerModule.setup('docs', …)`; the verified implementation is `/<service>/docs` as above. To be corrected in a later
  documentation change; no code is changed to match the stale text. (Corrected by A1.5, §12.)
- **Next (at the time):** A1.3 (caller-policy migration). Since closed on `main` (§10); current state in §7 and §12.

## 10. A1.3: caller-policy convergence (2026-10-07, local)

- **Owner decision OD-A1-3a = A:** Organization adopts the kit's strict validation as is (no lenient mode, no kit option).
- **Done:** Release, Audit, File, Notification and Organization (in that order) parse their policy with the kit's `parseCallerPolicy`
  (ADR-0052, ADR-0056 §11); each service keeps only its own dimension checks, inside the kit's `entry` callback. **Unchanged:** the
  wrapper classes and their public methods, the static `parse` signatures, the downstream representations, the environment-variable
  names (`RELEASE_SERVICE_POLICY`, `AUDIT_SERVICE_POLICY`, `FILE_SERVICE_POLICY`, `NOTIFICATION_SERVICE_POLICY`, `SERVICE_POLICY`),
  caller identities, scope vocabularies and authorization semantics. Repeated values inside a list keep their previous treatment
  (refused where a service refused them; tolerated as a set in Notification and Organization). No `libs/service-kit` change was needed.
- **Stricter, by decision:**
  - all five: a repeated JSON key at any depth (top level, caller, entry property, nested map) refuses to boot; before, `JSON.parse`
    silently kept the last one;
  - Organization only: an extra top-level key and an unknown entry property (anything other than `capabilities` / `allowedPlatforms`)
    now refuse to boot; before, both were ignored. The other four already refused them.
- **Wording only:** kit messages replace a few service messages (an unknown property is no longer echoed; a caller name outside the
  caller-name pattern prints as `<invalid caller name>`; Organization's "explicit policy entry" / "registered token" become "explicit
  entry" / "registered service token"). Five test expectations were adjusted to the new wording; each case is still refused.
- **Fixtures:** every repository-owned policy (`scripts/smoke-core-image.sh`, `docker-compose.yml`, `apps/organization-service/.env.example`,
  `deploy/register-caller.sh`'s generated shapes, every unit and e2e fixture) already conforms; each smoke document and the Organization
  generated shapes are pinned by an equivalence test.
- **Production policy NOT inspected.** Whether the live Organization `SERVICE_POLICY` conforms is unknown. The
  [Organization runbook](../runbooks/organization-production.md) §2 now carries a pre-deploy check: the candidate image's own parser
  reads the server's `.env` and prints only `OK` / `REFUSED`, never the value. It must pass before the first deploy of an image that
  contains A1.3. (A refused policy fails closed: the replacement never becomes ready and the previous container is restored.)
- **Evidence (local):**
  - focused suites: Release 31, Audit 47, File 71, Notification 119, Organization 33, all pass;
  - mutation controls (service-local, restored byte-for-byte): with duplicates normalized away before the kit, every raw duplicate-key
    test failed in all five services; with no registered callers passed to the kit, the deny-by-default tests failed in all five;
  - unit suites: Release 93, Audit 243, File 266, Notification 324, Organization 155; typecheck and lint clean for the changed files;
  - e2e suites: Release 225, Audit 435 (7 skipped), File 296 (35 skipped), Notification 324, Organization 262; shared suites
    audit-producers 26, auth-organization 9, real-broker 23. Audit, Notification and Organization e2e ran on a throwaway PostgreSQL 16
    and RabbitMQ 3.13: the local Compose broker could not finish booting (too many leftover test queues for its file-handle limit), and
    the Compose database hosts an `organization` database that the Organization suite's safety guard refuses to touch. One Audit timing
    test (`owner-operational`, Auth refused/unresolvable within budget) failed once under load, then passed in isolation and in a full
    rerun;
  - `npm run check:repo` passes; `npm run test:repo` 104/104.
- **Blast radius when merged:** the Organization and Audit merges build images and stop (build ≠ deploy); Release, File and
  Notification run Core CI image smoke only. Auth is untouched (no kit or package change).
- **A1.4 guard candidates (reported, not implemented):** no hand-written parsing of `*_SERVICE_POLICY` / `SERVICE_POLICY` outside
  `parseCallerPolicy` (for example, no `JSON.parse` in a service's policy module); every caller-policy wrapper delegates to the kit;
  the existing `check:repo` architecture-boundary checks (application → application, library → application) stay as they are.
- **Closed on `main`:** after owner review, five commits (one per service, Organization with the runbook and this record) merged as
  PR #220 (`5e90601`) with every CI check green.

## 11. A1.4: architecture guards (2026-10-07, local)

- **A1.4.0 discovery** (read-only, owner-reviewed) found the caller-policy architecture unguarded and the cross-service import rule
  **partially** guarded: ordinary `import … from`, `import type` and `export … from` were refused, but side-effect imports,
  dynamic `import()`, `require()` and bare workspace-package specifiers (`billing-service/…`, which npm workspaces resolve) were not.
  No current code used a missed form. **Owner decision OD-A1-4a = Option 1:** close those gaps in A1.4 by reusing the A12.2a
  syntax-aware collector.
- **Caller-policy guard** (`scripts/lib/checks.mjs`, run by `npm run check:repo`):
  - an explicit inventory, `CALLER_POLICY_MODULES`, of the seven consumers, each bound to its variable: Billing
    (`BILLING_SERVICE_POLICY`), Payment (`PAYMENT_SERVICE_POLICY`), Organization (`SERVICE_POLICY`), Notification, File, Audit and Release
    (`<SERVICE>_SERVICE_POLICY`). Auth has no caller policy and is not governed. A missing inventoried module is a violation;
  - each module must import `parseCallerPolicy` by name (not aliased, not type-only) from `@nawara/service-kit`, call it with
    `variable: '<its variable>'` (the environment-variable binding is part of the inventory, not a second guard), and must not call
    `JSON.parse`, `JSON['parse']` or `parseJsonStrict` itself. Inspection is syntax-aware: a comment or string that mentions a parser is
    not a call. Wrapper shapes (classes, or Billing / Payment's functions) are not constrained;
  - **completeness:** a non-test file under `apps/<service>/src/` that uses `parseCallerPolicy` or reads a `…SERVICE_POLICY` variable
    (`reader.get / required / optional`, `process.env`) fails unless its service has an inventory entry, so a new consumer cannot appear
    ungoverned. Unrelated `JSON.parse` (cursors, HTTP bodies, events, templates, the kit) is untouched.
  - Not static, by design: duplicate-key rejection and Organization's OD-A1-3a strictness are runtime behaviour of the kit parser, kept
    by the kit's and the services' tests; delegation is what the guard enforces.
- **Dependency direction (ADR-0056):** the A12.2a collector is generalized into one syntax-aware pass per source file
  (`sourceFacts`), shared by the metrics-client guard, the cross-service guard and the completeness rule. Application → other
  application and library → application imports are now refused in every static module-loading form (import, type import,
  re-export, side-effect import, dynamic `import()`, `require`, `import x = require`, `createRequire`, `require.resolve`), including
  bare workspace-package specifiers. The package names come from each `apps/<dir>/package.json`, never from a naming scheme, and
  the runner fails closed if none is found. A library import now has its own message. The audit-contract direction rule is unchanged
  and keeps its input. Mentions in comments or strings are no longer treated as imports.
- **Evidence (local):**
  - `npm run test:repo` 111/111 (104 before; 7 new tests: the inventory against the real modules, the module guard's pass and fail
    matrix, the missing module, completeness, the collector, app → app and library → application in every form with pass controls,
    and the runner's wiring);
  - `npm run check:repo` passes on the real repository, about 1.4 s (as before);
  - mutation controls, restored byte-for-byte:
    - with `JSON.parse` not detected, the call no longer required, an inventory variable changed (`check:repo` red too), `import()`
      or `require()` not collected, bare workspace packages ignored, completeness off, or library → application allowed, `test:repo`
      is red;
    - so it is when the runner stops passing the workspace packages or stops checking the inventory.
- **Residual (owner review, as for A12.2a):** a fully computed module specifier, or a policy parser moved into another file of a
  governed service while the governed module keeps a decoy call, cannot be decided statically; the services' raw-JSON duplicate-key
  tests still fail if parsing bypasses the kit.
- **Unchanged:** no application, kit, Auth, workflow, Compose, package or `CLAUDE.md` change; no runtime behaviour change, so the A1.3
  runtime campaign is not repeated. The `CLAUDE.md` OpenAPI drift (§9) stays for A1.5.
- **Closed on `main`:** after owner review, one commit (`42b6a8d`) merged as PR #221 (`21edab9cd65992d1804653f70712d72bb74bcb21`)
  with every CI check green.

## 12. A1.5: certification (2026-10-07, local)

Records only: A1.5 certifies the merged A1 work from its recorded evidence and repeats no runtime campaign, because it changes no code,
check or configuration. The code certified is what #220 and #221 merged with CI green; `main` has not changed since (`21edab9`).

| Phase | Deliverable | PR / merge | Owner decisions | Runtime change | Evidence relied on | Accepted boundaries |
|---|---|---|---|---|---|---|
| A1.0 | discovery (§1) | records only | none | none | read-only discovery, owner-reviewed | none |
| A1.1 | decisions and ADR governance: Q-ADR-1, review of every Proposed ADR (§2, §3) | #219 / `88e11b8` | OD-A1-1 to OD-A1-6 | none | the review; CI green | status changes one ADR at a time |
| A1.2 | [ADR-0056](../adr/0056-core-architecture-and-api-conventions.md) conventions; ADR-0034 superseded (§8, §9) | #219 / `88e11b8` | ADR-0056 Accepted; OpenAPI at `/<service>/docs`; unknown query parameters refused on new endpoints only | none | design-conformance review (8 corrections); CI green | the `CLAUDE.md` OpenAPI drift, corrected here |
| A1.3 | five caller-policy parsers on the kit's `parseCallerPolicy` (§10) | #220 / `5e90601` | OD-A1-3a = A | **yes, configuration grammar:** a repeated JSON key refuses to boot (all five); Organization also refuses an extra top-level key and an unknown entry property | focused 31 / 47 / 71 / 119 / 33; unit, service e2e and shared suites; mutation controls; CI green | the live Organization `SERVICE_POLICY` was not inspected: the runbook pre-deploy check is required before the first Organization deploy containing A1.3 |
| A1.4 | caller-policy and dependency-direction guards in `check:repo` (§11) | #221 / `21edab9` (commit `42b6a8d`) | OD-A1-4a = Option 1 | none | `test:repo` 111/111, `check:repo`, ten guard mutations caught; CI green | fully computed module specifiers; a parser moved to another file behind a decoy call |
| A1.5 | this certification: the `CLAUDE.md` OpenAPI bullet, the ADR-0056 §11 label, the roadmap and the V2-A record | this branch, not merged | OD-A1-5a = yes (ADR-0056 §11 `[TARGET: A1.3]` → `[CURRENT]`, decision and status unchanged); OD-A1-5b = yes (V2-A record later status) | none | `check:repo`; `test:repo` 111/111; link, naming and status checks | none new |

- **Exit criteria:** governance merged and consistent; ADR-0056 Accepted; ADR-0034 Superseded (no other ADR status changed in A1);
  caller-policy convergence merged; the seven consumers enforced; dependency-direction guards merged; the A1.4 boundaries recorded;
  the `CLAUDE.md` OpenAPI drift corrected; this record, the roadmap and the V2-A record accurate; `check:repo` and `test:repo` pass;
  no runtime change in A1.5; the certification PR's CI green; the owner merges it. **Only then is A1 Architecture certified and closed
  on `main`.**
- **Not claimed:** A1 certification closes **A1 Architecture** only. It does not claim Core V2 complete, production readiness, G4,
  G6, G7, F6, F7, A12.10, A19 or Final Core Validation. (A1 Architecture is not "V2-A.1", which is the earlier documentation
  formalization stage.)
- **Status:** A1.5 complete locally, owner review pending. **A1 is OPEN.**

# Stage 20.2: release-service foundation and domain

- **Status:** PASSED on `feat/release-service-foundation` (awaiting review; not committed).
- **Base:** `main` @ `1b5625a` (Stage 20.1 merged, PR #131; [ADR-0051](../../adr/0051-release-management-and-client-compatibility.md) Accepted).
- **Scope:** the service foundation, the domain schema and its invariants, SemVer, and persistence primitives.
- **No business route:** registration is 20.3, administration 20.4, the compatibility read 20.5.

## 1. Patterns reused

The new-service pattern is audit-service's Stage 18.2 foundation (commit `cc2cebb`):
- NestJS 12 + the kit (`loadBaseConfig`, `EnvReader`, `configureApp`, `HealthModule`, `DbModule`, `kitMigrationsDir`);
- the least-privilege runtime-role guard;
- the silent-socket bound;
- the Node 22 alpine two-stage image (non-root, migrations travel with the image, never applied at startup);
- vitest unit and E2E configs with `describeWithEnv`;
- `infra/postgres/init` roles, `verify.sh`, `.env.example`, Compose, the CI test and image matrices, the smoke script and the
  generic-term source check.

There is no new framework, ORM, migration tool, logger or test framework. The one new dependency is `semver`, the npm reference
implementation, already present transitively, so precedence isn't hand-written.

**OpenAPI** is not mounted yet. It follows the audit precedent: documentation is mounted with the first API, in 20.3, and no business
route is invented to populate it. **Outbox and rate-limit tables** arrive with the standard kit migrations (`kit_0001`, `kit_0002`), and
nothing uses them yet.

## 2. Domain (`db/migrations/0001_release_domain.sql`)

```text
product ─1:N─ component ─1:N─ release               (registered → published → withdrawn)
                        └─1:N─ compatibility_policy  (append-only; policyVersion 1, 2, 3 … per client component)
```

| Table | Key columns | Constraints | Triggers | Privileges (runtime role) |
|---|---|---|---|---|
| `product` | `id` uuid PK, `key`, `createdAt` | `product_key_unique`, `product_key_valid` | no UPDATE / DELETE / TRUNCATE | SELECT, INSERT |
| `component` | `id`, `productId` FK, `key`, `kind`, `createdAt` | `component_product_key_unique (productId, key)`, `component_kind_valid` (`backend, web, desktop, mobile_ios, mobile_android`) | no UPDATE (kind immutable) / DELETE / TRUNCATE | SELECT, INSERT |
| `release` | `id`, `componentId` FK, `version`; `major` / `minor` / `patch` / `prerelease` **generated from `version`**; `buildId`, `sourceRevision`, `notesRef`; `status`, `registeredAt`, `publishedAt`, `withdrawnAt` | `release_component_version_unique`, `release_version_semver`, shape checks (build, revision, notes), `release_status_valid`, `release_status_timestamps`, `release_published_after_registered` | `release_born_registered`; `release_identity_immutable` (kit `forbid_column_change`); `release_lifecycle`; `release_withdrawal_keeps_minimum`; no DELETE / TRUNCATE | SELECT, INSERT, UPDATE |
| `compatibility_policy` | `id` identity, `componentId` FK, `policyVersion`, `minimumVersion` (+ generated parts), `createdAt` | `compatibility_policy_component_version_unique`, `compatibility_policy_version_positive`, `compatibility_policy_minimum_stable` | `compatibility_policy_append` (client kinds only; next version only, else `40001`; minimum ≤ latest); no UPDATE / DELETE / TRUNCATE | SELECT, INSERT |

Index `release_latest_idx`: on `(componentId, major DESC, minor DESC, patch DESC)`, where the release is published and has no
pre-release.

## 3. Invariants and where they are enforced

| Invariant | Database | Application |
|---|---|---|
| Product key unique and well-formed | unique + check | early `invalid` |
| Component `(product, key)` unique; bounded kinds | unique + check | early `invalid` / `conflict` on a different kind |
| Component kind immutable | trigger + revoked UPDATE | – |
| Release `(component, version)` unique | unique | idempotent registration; a different identity is a `conflict` |
| Release identity immutable | kit trigger `forbid_column_change` | – |
| Lifecycle `registered → published → withdrawn` only | `release_born_registered`, `release_lifecycle`, `release_status_timestamps` | state-idempotent moves; `invalid_transition` |
| Registered → withdrawn refused | lifecycle trigger + timestamps check | `invalid_transition` |
| No deletion | triggers (even for the owner) + revoked DELETE / TRUNCATE | – |
| Policy append-only | trigger (even for the owner) + revoked UPDATE / DELETE | – |
| Policy version sequence (optimistic concurrency) | trigger (`40001`) + unique | `policy_conflict` |
| Canonical SemVer (no `v`, no leading zeros, ≤ 15 digits, no build metadata, ≤ 128 characters) | `release_semver_valid` | the same regex + `semver.valid` |
| Latest = highest published, not-withdrawn, no pre-release | the partial index serves the query | `latestRelease()` |
| Minimum ≤ latest on a policy change | `compatibility_policy_append` | `invariant_violation` |
| Minimum ≤ latest on a withdrawal | `release_withdrawal_keeps_minimum` | `invariant_violation` |
| No write skew between a policy change and a withdrawal | transaction advisory lock per component, on both paths | – |

**Lifecycle reading.** ADR-0051 defines the linear `registered → published → withdrawn`, so a registered-only release **cannot be
withdrawn**. This is implemented exactly, not broadened. Whether 20.4 needs to withdraw registered builds (for example one in store
review) is a question for that stage.

## 4. SemVer

- **Library:** `semver` 7.x for precedence (§11 of the specification is tested).
- **Canonical form:** the same regex as the database, plus `semver.valid(v) === v`, so nothing is normalized silently.
- **Pre-releases:** they order below their release, and are never "latest". A minimum version is stable (no pre-release).
- **Build metadata:** refused. The native identity goes in `buildId` (iOS build number, Android `versionCode`, a build number) and
  `sourceRevision` (Git SHA). Neither is ever compared.
- **Database comparison:** on the generated columns, `(major, minor, patch)`, which is exact for stable versions (the only ones latest
  and minimum involve).
- **Bug found and fixed during implementation:** PostgreSQL computes generated columns *after* BEFORE triggers, so the policy trigger
  derives the parts from the text. It also leaves malformed values to the shape constraint, so they are reported as what they are.

## 5. Persistence primitives (`ReleaseStore`, internal)

Every method takes the caller's transaction client, so 20.3 and 20.4 write their audit intent in the same transaction. Refusals are
bounded codes: `invalid`, `conflict`, `invalid_transition`, `invariant_violation`, `policy_conflict`, `not_found`.

| Area | Methods |
|---|---|
| Transactions | `tx` |
| Products | `ensureProduct`, `findProduct` |
| Components | `ensureComponent`, `findComponent` |
| Releases | `registerRelease` (idempotent), `findRelease`, `publishRelease`, `withdrawRelease` (both state-idempotent), `latestRelease` |
| Compatibility policy | `currentPolicy`, `appendPolicy(expectedVersion)` |

## 6. Tests

| Suite | Command | Result |
|---|---|---|
| Unit: configuration, SemVer (spec precedence, canonical forms, native identifiers refused), socket bound | `npm test -w release-service` | 35 / 35 |
| E2E, real PostgreSQL 16: health, readiness, routes (none), database loss and recovery, shutdown | `npm run test:e2e -w release-service` | 5 |
| E2E: schema invariants as the **runtime role**, plus the owner-level trigger layer, plus a two-session write-skew test | same | 19 |
| E2E: persistence primitives, incl. 8 concurrent registrations and concurrent policy changes | same | 8 |
| E2E total | | 32 / 32 |
| Typecheck, lint (0 findings), build | `typecheck`, `lint`, `build` | pass |
| Repository checks, and the check script's own tests | `check:repo`, `test:repo` | pass, 17 / 17 |

**Production image and provisioning:**
- **Image:** `docker build -f apps/release-service/Dockerfile`, then `scripts/smoke-core-image.sh release-service`. Result: SMOKE
  PASSED (uid 1000, `/health` 200, `/ready` 503 without a database).
- **Provisioning:** a Postgres initialized by `infra/postgres/init` with `.env.example`. `infra/postgres/verify.sh`: all
  least-privilege checks passed. `npm run migrate -w release-service` as `release_migrator` applied 4 migrations. The image runs as
  `release_app` with `/ready` 200, and `/release` is 404.

**Mutation check (13 mutants).** 10 were killed:
- identity immutability removed;
- lifecycle reversal allowed;
- withdrawal invariant removed;
- policy minimum ≤ latest removed;
- the policy sequence removed;
- the advisory lock removed;
- backend policy allowed;
- latest including pre-releases;
- latest including registered-only releases;
- registration conflict ignored.

The 3 survivors are layered or equivalent: the timestamp check is also covered by the lifecycle trigger; the policy trigger is also
covered by revoked privileges (an owner-level test was then added and kills it); the `semver.valid` equality is also covered by the
canonical regex. All sources were restored and hash-verified.

## 7. Scope verification

**Not built:**
- no business HTTP route;
- no CI registration or publication;
- no service tokens;
- no human administration, Auth verification or step-up;
- no public compatibility endpoint, cache or ETag;
- no audit actions (outbox tables exist; nothing writes them);
- no channels, deployments, environments or artifacts;
- no binaries, signing or updater;
- no feature flags, configuration or maintenance mode;
- no analytics;
- no entitlement;
- no Stage 21 work.

**Neither changed nor run:**
- no other service's code;
- Full Core Validation not run.

Shared registrations only: `.env.example`, Compose, `infra/postgres` init and verify, the CI matrices, the smoke script, the generic-term
check, `package-lock.json`, `CLAUDE.md` and the `core-architecture` service table.

## 8. Follow-ups (not implemented)

- **20.3:**
  - an ADR-0042 caller policy for CI (`release.register` / `release.publish`, per product);
  - mount OpenAPI;
  - audit catalog actions `release.registered` / `release.published` through the outbox, in the store's transaction;
  - a `release` routed prefix.
- **20.4:**
  - withdrawal and minimum changes by the verified owner with step-up (the store primitives are ready; `policy_conflict` is the
    optimistic-concurrency answer);
  - decide whether a *registered* release may be withdrawn (ADR-0051 says no today).
- **20.5:**
  - the decision read (`update` / `reason`, input errors) over `latestRelease`, `findRelease` and `currentPolicy`;
  - the public rate limit (kit `kit_rate_limit`) and cache.
- **20.6:** counters and runbooks for the new service.
- **21.x:** production database provisioning (the `release` roles), backups, CI release credentials (P-R1). This is carried, not
  solved.
- **Note:** `CLAUDE.md`'s "planned services" sentence is stale for already-built services (billing, file, audit). It was not rewritten
  here, since that is out of scope.

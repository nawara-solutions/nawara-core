# Stage 20.1: Release management, architecture and decisions

- **Status:** **DECISION REQUIRED.** The architecture is proposed in
  [ADR-0051](../../adr/0051-release-management-and-client-compatibility.md) (Proposed); four owner decisions (§18) must be answered
  before Stage 20.2.
- **Branch:** `feat/release-management-architecture`, from `main` @ `f568194` (Stage 19 closed; Stage 19.6 merged, PR #130).
- **Implementation:** none; this stage is investigation and architecture only.

## 1. Current-state inventory (repository evidence)

| Area | What exists | Evidence |
|---|---|---|
| Release / version / channel / minimum version / feature flag / maintenance | **nothing** in any runtime | a search over `apps/*/src`, `libs/*/src` (only "channel" as a notification or AMQP channel); billing entitlement is explicitly "no feature flags" (`billing-service/src/domain/entitlement.ts`) |
| Package versions | placeholders: services `0.0.1`, kit `0.1.0`, `@nawara/audit-contract` `1.0.0` (npm only, not a release identity) | `apps/*/package.json` |
| Build identity | Auth images tagged `sha-<git sha>`, promoted by the `:production` tag; the other services are built in CI but not deployed | `.github/workflows/auth-service-*.yml`, `core-ci.yml` |
| Health metadata | `/health`, `/ready` deliberately "leak no versions" | `libs/service-kit/src/health/health.controller.ts:8` |
| API versioning | no version segment in v1; additive only; a breaking change becomes `/v2/<prefix>` | `core-architecture.md` conventions |
| Event versioning | the `version` header; Audit accepts N and N−1 during a rollout; Audit is deployed before its producers (A50) | ADR-0049 A50 |
| Migrations | the kit runner, checksums, history refusal; `/ready` not ready while a release's migration is pending | `production-readiness.md` |
| "Platform" | a **Company's product line** (Company → Platform → Organization), a tenant-hierarchy anchor | ADR-0022; `organization-service` migration `0001` |
| Client technology | no decision in Core; Tauri and browser are possible clients (ADR-0041 decision 6); products own client choice | ADR-0041 |
| Items already labelled "Stage 20" | backups and a restore drill (RPO / RTO); O2 (`/ready` and RabbitMQ); O1 (the stale-resend window); outage log thresholds; `CONCURRENTLY` for large index builds; migrate-before-deploy ordering; the connection budget; restart policy, rolling deploy and init process; O7 (a stale Auth deploy variable); production RabbitMQ and `AUTH_EVENTS=on` | `core-validation.md` §17.2 and §13.5.1; `production-readiness.md`; Stage 16.1 §5 |

The last row matters. Earlier stages used "Stage 20" for **deployment and production engineering**. This stage defines Release
Management as metadata and compatibility, so those items need a new home (D3).

## 2. Core V1 requirements

- **R1:** a client (web, desktop, mobile) can learn, without logging in, whether its version is supported, has an update available, or
  must update.
- **R2:** release identity is recorded once and is immutable: which versions of which component exist, and when each became available.
- **R3:** a broken or compromised client release can be withdrawn, and a minimum supported version raised, by an accountable actor, with
  central audit evidence.
- **R4:** CI can register and publish releases without a human bearer and without impersonating anyone.
- **R5:** everything is product-independent (Drive, School, future products), and no hot-path dependency is added.

## 3. Non-goals (Core V1)

- building, deploying, rolling back or migrating software (CI/CD);
- storing or serving binaries, installers, store submissions or updater manifests;
- holding signing keys;
- per-user version tracking and adoption analytics;
- tenant-specific release targeting;
- feature flags, remote configuration and maintenance mode;
- AI model, prompt and RAG registries;
- commercial entitlement, and authorization.

## 4. Platform (target) model

```text
                          PRODUCT (registry key, e.g. "drive"; not Core's tenant "Platform")
                                 │
       ┌───────────────┬─────────┴───────┬────────────────┬──────────────────┐
       ▼               ▼                 ▼                ▼                  ▼
   backend            web            desktop         mobile_ios        mobile_android       (+ ai later)
 (traceability     (server-deployed  (installed;      (installed;       (installed;
  only; no          bundle; "reload"  Tauri or other   store)            store)
  client check)     not "install")    technology)
```

- **Backend:** components registered for traceability and audit (version, build identity). No compatibility decision; the API prefix
  convention governs API generations.
- **Web:** a first-class kind. The "version" is the deployed bundle a browser tab runs. Below the minimum means *reload*, never *install*.
  No installed-version, updater or store concept.
- **Desktop:** an installed client. Tauri is a possible technology, recorded at most as descriptive metadata, never a kind or a column.
  Update delivery stays with the updater or distribution infrastructure.
- **Mobile:** `mobile_ios` and `mobile_android` are separate kinds, because their store and version semantics differ. Store publishing
  is not Core's.
- **AI:** the `ai` kind can be added later for AI *software* components. Model, prompt, RAG and index versions are AI configuration
  metadata owned by ai-service (Stage 36+), not releases.
- **Web ≠ desktop ≠ Tauri.** A product may have any combination of kinds, one component per deployable or installable unit (for
  example Drive: `backend`, `admin-web`, `student-ios`, `student-android`).

## 5. Domain model options

| | Option A, minimal (**recommended**) | Option B, richer |
|---|---|---|
| Entities | Product, Component, Release, CompatibilityPolicy | A plus ReleaseArtifact, Deployment, Environment, Channel |
| Web | ✓ (reload semantics) | ✓ |
| Desktop / mobile | ✓ (decision only; the native updater or store delivers) | ✓, plus artifact references |
| Backend | ✓ (traceability) | ✓, plus deployment history (duplicates CI) |
| AI extension | a new target kind | same |
| Multi-product | ✓ | ✓ |
| Complexity | low | high: artifacts, signatures and deployments are CI and distribution facts; channels have no V1 need |

**Product vs component.** Both are needed, minimally. Clients check a *component*, and products group components for administration and
policy authority (a CI credential is scoped per product). Core V1 needs **no product-level release** (a "Drive 2.4" bundle): components
release independently, and a coordinated bundle is added only for a proven cross-component need. **No coordinated Core release** either:
Core services already deploy independently (A50 ordering, additive APIs).

## 6. Service and persistence decision

- **A dedicated `release-service`** (D1), with its own PostgreSQL database and the kit standard:
  - health, readiness, migrations;
  - outbox for the audit intent;
  - rate limit;
  - OpenAPI at `/docs`.
- **Justification:**
  - independent authority and data;
  - consumers in every product;
  - its own security boundary (CI credentials, a small human policy surface);
  - a cacheable, high-volume public read that must not load another service.
- **Rejected:**
  - hosting it in organization-service (tenant hierarchy), Auth (identity) or Billing (commercial). Each would become a second owner of
    an unrelated domain;
  - a static CDN manifest (no authority, no audit, no withdrawal without a rebuild). It remains a possible *delivery optimization* in
    front of the service later.
- **Persistence (architecture level):**
  - `product` (unique key);
  - `component` (unique `(product, key)`, `targetKind`, immutable);
  - `release` (unique `(component, version)`; version, target, buildId and revision immutable once published; `status` transitions
    `registered → published → withdrawn` only, enforced by a trigger);
  - `compatibility_policy` (append-only versions; the current row per component);
  - kit outbox and rate limit.
  - Indexes serve "the latest published release per component" and "the current policy per component".
  - Concurrency: registration is idempotent on `(component, version)`; policy changes use optimistic versioning.
  - Retention: release metadata is kept (small and evidential).

## 7. Versioning

- **Canonical:** SemVer 2.0 `MAJOR.MINOR.PATCH` with an optional pre-release, used for every comparison.
- **Native identifiers** stay native in `buildId`, and are never compared:
  - iOS `CFBundleVersion`;
  - Android `versionCode`;
  - desktop and web build numbers;
  - Git SHA.
- `sourceRevision` (Git SHA) is optional traceability.
- **API versions are not release versions.** The API prefix convention remains the API compatibility mechanism.

## 8. Environments and channels

- **Releases are environment-independent facts.** Each environment (development, staging, production, as Core deploys today) runs its
  **own** release-service, and CI in each environment registers there. No environment column, no Deployment entity.
- **Channels: none in Core V1** (D4). Mobile store tracks and CI provide pre-release distribution. Channels would only make sense for
  installed targets, and are added when a product proves the need.

## 9. Compatibility model

The decision is per client component (web, desktop, iOS, Android):

| Decision | When | Client action |
|---|---|---|
| `update_required` | the version is below the minimum supported, or it is a withdrawn release | web: reload; installed: block and update |
| `update_available` | at or above the minimum, and below the latest **published** release | offer an update |
| `supported` | at or above the latest published (or nothing newer published) | none |
| `unsupported` | an unknown component, or a malformed version | treated as a client or configuration error, never guessed |

- **Latest ≠ minimum.** "A newer version exists" never forces an update; only the minimum (a compatibility or security policy) and
  withdrawal do.
- **Minimum supported version** applies to web, desktop and mobile. It does not apply to backends.
- **Web staleness** (an old tab after a deploy): the web client checks on start and periodically (for example on focus, or when an API
  answers an unknown-route or `/v2` refusal). `update_required` means reload.
  - **Deferred options:** a build hash in an HTTP header, service-worker update flows.
  - **Tradeoff:** a check period adds read load, bounded by caching.
- **Installed clients** check at start and on resume. They honour a cached `update_required` offline. The update itself is the native
  updater or store.

## 10. Security and authority

| Operation | Caller | Authentication | Authorization |
|---|---|---|---|
| Register a release; publish a release | CI | service token (ADR-0033) | an ADR-0042 policy: `release.register` / `release.publish`, per product |
| Withdraw a release; change the minimum supported version | a human | own Auth bearer, verified live, plus a factor step-up (ADR-0050) | the owner of the configured operating Company (D2); no operator power (P-S1) |
| Compatibility read | any client | none | none: public, minimal, rate-limited |

- **Is release administration an operator capability?** Not in Core V1. Operators have no independent factor (P-S1), and ADR-0050
  decision 4 applies.
- **A service never impersonates a human.** CI evidence names the CI service; human actions name the verified owner.

## 11. Audit

| Action | Category | Organization | Actor |
|---|---|---|---|
| `release.registered` | administrative | none | service (CI) |
| `release.published` | administrative | none | service (CI) |
| `release.withdrawn` | security | none | user owner |
| `compatibility_policy.changed` | security | none | user owner (and optionally a service, if the owner allows CI to raise minimums) |

Every action is written in the same transaction through the outbox, and the catalog is extended in 20.3 / 20.4 (additive, A50). The
public reads are **not** audited: they carry no user identity and are high-volume.

## 12. Boundaries and integrations

- **CI/CD:** builds, tests, packages, publishes to stores and CDNs, deploys, rolls back and migrates. It *then* registers and publishes
  in release-service. Rollback of a backend or web deploy is CI's job, and the release record is unchanged. Installed clients cannot be
  downgraded, so a bad installed release is **withdrawn** (forcing `update_required`) and fixed forward.
- **Artifacts and signing:** not stored; no keys. At most an opaque `notesRef`. Artifact references are deferred until an updater
  integration needs them.
- **Database migrations:** no migration metadata in V1. The kit runner and `/ready` gate deploys, and migrate-before-deploy ordering is
  a CI or production concern (21.x).
- **File service:** not used for binaries.
- **Notification:** not used in V1. Update prompts are client UI driven by the compatibility decision.
- **Commercial and authorization:** a supported version grants nothing. Entitlement stays in Billing, and authorization stays in each
  service.
- **Offline desktop:** release metadata may be cached, but the commercial licence and offline use are not Stage 20 (Commercial V2 / ADR-0041
  guardrails).

## 13. Failure semantics and caching

- **Compatibility read unavailable:** fail **open**. Clients keep their last cached decision, or proceed; a cached `update_required`
  stays binding. No product API waits on release-service.
- **Registration and administration:** fail **closed**. CI retries, and registration is idempotent.
- **Caching:** `Cache-Control: public, max-age` short (minutes) with an `ETag`, CDN-friendly, low-cardinality keys `(component, version)`.
  A required update propagates within the TTL, an accepted tradeoff. There is no per-user data, so responses are shareable.

## 14. Observability (future, bounded)

- Counters by `targetKind × decision`, and registration and publication outcomes.
- No version, component, user or IP labels beyond the closed kinds.
- An unsupported-client spike is an alertable signal.

## 15. Privacy

The compatibility decision needs no user identifier. release-service stores no personal data: only component keys, versions, build
identifiers, and actor ids in audit evidence.

## 16. Shared-capability findings (for 21.C, not Stage 20)

| Capability | Finding | Classification |
|---|---|---|
| Remote configuration / capability discovery | no generic need proven; products configure themselves | 21.C candidate (Option D: after Core V1 unless 21.C proves otherwise) |
| Feature flags | none exist; Billing entitlement explicitly excludes them | 21.C candidate; deferred |
| Maintenance mode | a real client need (planned downtime); not release metadata | 21.C candidate |
| Client capability discovery (which features a server supports) | the API prefix convention covers V1 | 21.C candidate |

## 17. Stage 20 decomposition (proposed)

The provisional sequence was challenged. Security is not a separate late stage: each substage carries its own authority. A combined
hardening stage precedes certification.

| Stage | Purpose | Scope | Depends on | Must not |
|---|---|---|---|---|
| **20.1** | architecture and decisions | this record, ADR-0051 | none | implement |
| **20.2** | service foundation and domain | the `release-service` skeleton (kit, config, health, migrations, CI job, image); schema and invariants (uniqueness, immutability trigger, status transitions, SemVer parsing and comparison); repository | D1 accepted | expose APIs; add audit actions |
| **20.3** | registration and lifecycle (automation) | CI service-token policy (`release.register` / `release.publish`); register (idempotent) and publish; the audit catalog `release.registered` / `.published`; outbox | 20.2 | human authority; public reads |
| **20.4** | compatibility policy and human administration | minimum-version policy and withdrawal by the verified owner (ADR-0050 pattern, step-up); `compatibility_policy.changed`, `release.withdrawn` | 20.3, D2 | operator powers; channels |
| **20.5** | client compatibility API | the public decision endpoint, caching and ETag, rate limit, fail-open client guidance, a web / installed-client integration guide | 20.4 | authenticated user data; a hot path |
| **20.6** | security, privacy and operational hardening | adversarial review, counters, alertable signals, runbooks, deployment order | 20.5 | new features |
| **20.7** | focused certification and closure | the Stage 19.6 pattern | 20.6 | Full Core Validation |

## 18. Owner decisions required

| # | Decision | Recommendation |
|---|---|---|
| D1 | Create `release-service` (a new deployable, its own database), adding it to the planned-services list | yes |
| D2 | The human authority for withdrawal and minimum-version changes | the owner of the configured operating Company, with a factor step-up (ADR-0050 pattern). Alternative: CI-only, with approval in the CI system (weaker human accountability) |
| D3 | Move the §17.2 "Stage 20" deployment and production items (backups and restore, rolling deploy, restart policy, init, the connection budget, `CONCURRENTLY`, migrate-before-deploy, O1, O2, log thresholds, O7, production RabbitMQ / `AUTH_EVENTS`) to **Stage 21.x Production Prerequisite Closure** | yes: they are CI/CD and production engineering, not release metadata |
| D4 | No release channels in Core V1 | yes: defer until a product proves the need |

## 19. Decision table

| Decision | Options | Recommendation | Reason | Status |
|---|---|---|---|---|
| Dedicated service? | none (CDN manifest) / inside an existing service / `release-service` | `release-service` | independent authority, data, consumers, security boundary | DECISION REQUIRED (D1) |
| Product vs component? | component only / product + component / + product release | product + component; no product release | clients check components; products scope authority | DECIDED (proposed) |
| Version model? | SemVer / CalVer / build numbers / SHA | SemVer canonical + opaque native `buildId` + optional `sourceRevision` | comparable, and native identifiers kept | DECIDED (proposed) |
| Environment ownership? | a release field / a deployment entity / one service per environment | one service per environment | releases are environment-independent; matches Core | DECIDED (proposed) |
| Channels? | none / installed-only / all | none in V1 | no demonstrated need; stores provide tracks | DECISION REQUIRED (D4) |
| Web compatibility? | none / minimum version + reload / build-hash header | minimum version + reload; the header deferred | real stale-tab problem, no installer semantics | DECIDED (proposed) |
| Desktop compatibility? | decision only / + artifacts and updater manifest | decision only | the updater is distribution | DECIDED (proposed) |
| Mobile compatibility? | decision only / + store integration | decision only (iOS and Android as separate kinds) | stores are distribution | DECIDED (proposed) |
| AI release metadata? | in Release / separate | separate (ai-service, Stage 36+); `ai` kind reserved | model and prompt versions are configuration | DEFERRED |
| CI/CD identity? | human bearer / service token + policy | service token, ADR-0042 capabilities, per product | no impersonation | DECIDED (proposed) |
| Human authority? | operator / owner of the operating Company / CI-only | the owner of the operating Company, with step-up | ADR-0050; P-S1 | DECISION REQUIRED (D2) |
| Audit events? | none / four actions | the four actions, organization none | accountability | DECIDED (proposed) |
| Artifact storage? | release-service / File / external | external distribution infrastructure | not a CDN or signer | DECIDED (proposed) |
| Configuration / capability management? | A / B / C / D | D (after Core V1), revisited in 21.C | no generic V1 need proven | DEFERRED (21.C) |
| Feature flags? | V1 / defer | defer | no V1 need | DEFERRED (21.C) |
| Maintenance mode? | in Release / separate / defer | not Release; 21.C candidate | a different concern | DEFERRED (21.C) |
| Stage 20 register items | keep in Stage 20 / move to 21.x | move to 21.x | deployment engineering | DECISION REQUIRED (D3) |

## 20. Production prerequisites (preliminary register)

| # | Prerequisite | Destination |
|---|---|---|
| P-R1 | CI credentials for release registration (provisioning, rotation) | 21.x (with P-S2) |
| P-R2 | a release approval policy (who approves publication and withdrawal) | owner / 21.x |
| P-R3 | signing infrastructure per ecosystem (Apple, Android, desktop updater, Windows) | 21.x / products |
| P-R4 | store and CDN distribution accounts and pipelines | products / 21.x |
| P-R5 | TLS and public exposure of the compatibility endpoint (CDN in front) | 21.x (with P-S3) |
| P-R6 | monitoring and alert routing for release signals | 21.x (with P-A4 / P-S5) |
| P-R7 | the reassigned §17.2 deployment items (D3) | 21.x |

## 21. Open decisions

D1 to D4 (§18). Everything else is decided in ADR-0051 (Proposed) or deferred with a destination. The architecture is **ready for
Stage 20.2 once D1 to D4 are answered and ADR-0051 is accepted**.

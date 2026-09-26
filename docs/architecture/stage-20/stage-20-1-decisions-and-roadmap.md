# Stage 20.1: Release management, architecture and decisions

- **Status:** **PASSED** (2026-09-26).
  - Owner decisions D1 to D4 were approved (§18), and the compatibility result model was finalized after a final review (§9).
  - [ADR-0051](../../adr/0051-release-management-and-client-compatibility.md) is **Accepted**.
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

## 9. Compatibility model (final)

**The final review.** The first proposal used one status, `supported | update_available | update_required | unsupported`. It
conflated two things:
- `supported` meant "at the latest release", although an older release above the minimum is also supported;
- `unsupported` mixed a policy verdict with bad input.

Separating *support* from *update* is right conceptually. In this policy, however, the two are **not independent**: an update is
required exactly when the release is not supported (below the minimum, or withdrawn). The options compared:

| Representation | States it can express | Verdict |
|---|---|---|
| one overloaded status (first proposal) | 4, with misleading names | rejected |
| two fields `{support: supported \| unsupported, update: none \| available \| required}` | 6, of which 3 must never occur (supported + required, unsupported + none, unsupported + available) | rejected: representable invalid states, and clients could disagree |
| **one field `update: none \| available \| required`**, support derived, bad input an error | exactly the 3 valid states | **chosen** |

**Input errors** are never a decision and never "compatible":
- `invalid_version`: malformed;
- `unknown_component`: the component does not exist;
- `unknown_release`: a well-formed version that is not a registered release of that component. CI registers every shipped web and
  installed build.

**Decision for a known release:**

| `update` | When | Web | Desktop | iOS / Android |
|---|---|---|---|---|
| `required` + `reason` (`withdrawn` \| `below_minimum`) | the release is withdrawn, or its version is below the minimum | stop using the loaded build: **reload** the deployed web application (never "install") | block until updated through the updater | block until updated through the store |
| `available` | not required, and a newer latest release exists | optional refresh prompt | optional update offer | optional store prompt |
| `none` | not required, and nothing newer is published | – | – | – |

- **Supported ⟺ `update` ≠ `required`**. With minimum `2.0.0` and latest `3.0.0`, version `2.5.0` is supported, with
  `update: available`.
- A newer release alone never forces an update. Only the minimum and withdrawal force one.
- **"Latest"** is the highest published, not-withdrawn release **without a pre-release tag** (no channels, so a pre-release is never
  everyone's latest). A registered-but-unpublished version, such as a build in store review, is a known release. A client running it
  above the latest gets `none`.
- **A withdrawn release above the latest** (`2.0.0` withdrawn, latest `1.0.0`) stays `required` / `withdrawn`. `latestVersion` may then
  be lower than the client's own, and it is never a downgrade target for installed clients: they stay blocked until a fix-forward
  release is published. A web client reloads the deployed build, and redeploying an older web build is CI's rollback.
- **Invariant: minimum ≤ latest published.** It is enforced on policy changes **and on withdrawals**: a withdrawal that would leave the
  minimum above the new latest is refused until the minimum is lowered. This prevents a lockout with nothing to update to.
- **Response:** `{ update, reason?, latestVersion, minimumVersion }`. These are public release facts, with no user data.
- **Caching:** short max-age, and an `ETag` over the policy version and the latest release.
- **Failure:**
  - service unreachable → fail open, using the cached decision (a cached `required` stays binding);
  - an input error is definitive and never compatible (installed clients handle it as `required`; web reloads);
  - registration and administration fail closed.
- **Web staleness** (an old tab after a deploy): check on start and periodically. `required` means reload. A build-hash header and
  service-worker flows are deferred options.
- **Installed clients** check at start and on resume, and honour a cached `required` offline. The native updater or store delivers the
  update.

## 10. Security and authority

| Operation | Caller | Authentication | Authorization |
|---|---|---|---|
| Register a release; publish a release | CI | service token (ADR-0033) | an ADR-0042 policy: `release.register` / `release.publish`, per product |
| Withdraw a release; change the minimum supported version | a human | own Auth bearer, verified live, plus a **mandatory** factor step-up (ADR-0050) | the verified owner of the configured operating Company (**D2, approved**); operators have no Release Management authority in Core V1 |
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

## 17. Stage 20 decomposition (final)

The provisional sequence was challenged. Authority travels with each capability instead of sitting in one late "security" stage, and one
combined hardening stage precedes certification.

| Stage | Purpose | Scope | Depends on | Must not |
|---|---|---|---|---|
| **20.1** | Architecture & decisions | the inventory, ADR-0051 (Accepted), D1–D4, the compatibility model, the D3 register reassignment | none | implement |
| **20.2** | Service foundation & domain | the `release-service` skeleton (kit config, health, readiness, migrations, OpenAPI, Dockerfile, CI job, production image); schema and invariants (unique keys, the immutability trigger, `registered → published → withdrawn`, append-only policy, minimum ≤ latest, SemVer parsing and precedence, "latest" excluding pre-releases); the repository; the CLAUDE.md and core-architecture service lists | ADR-0051 (D1) | expose APIs; add audit actions; channels |
| **20.3** | Release registration & lifecycle (automation) | the CI service-token policy (`release.register`, `release.publish`, per product); idempotent registration; publication; audit catalog `release.registered`, `release.published`; outbox | 20.2 | human authority; public reads; deploying anything |
| **20.4** | Compatibility policy & human administration | minimum-version changes and withdrawal by the verified owner of the operating Company with a mandatory factor step-up (ADR-0050 pattern); the invariant on both; audit `compatibility_policy.changed`, `release.withdrawn` | 20.3 (D2) | operator authority; channels |
| **20.5** | Client compatibility API | the public decision endpoint (`update`, `reason`, input errors), cache and `ETag`, rate limit, fail-open guidance; an integration guide for web, desktop, iOS and Android | 20.4 | user data; a hot-path dependency; per-user tracking |
| **20.6** | Security, privacy & operational hardening | adversarial review, bounded counters, alertable signals, runbooks, deployment order | 20.5 | new features |
| **20.7** | Focused certification & closure | the Stage 19.6 pattern | 20.6 | Full Core Validation; Stage 21 work |

## 18. Owner decisions (approved 2026-09-26)

| # | Decision | Owner answer |
|---|---|---|
| D1 | a dedicated `release-service` with its own PostgreSQL database | **APPROVED** |
| D2 | withdrawal and minimum-version / compatibility-policy changes: the verified owner of the configured operating Company, with their own bearer, live verification and a mandatory factor step-up. CI stays a service identity and never impersonates a human. Operators get no Release Management authority in Core V1 | **APPROVED** |
| D3 | the deployment and production items labelled "Stage 20" move to **Stage 21.x Production Prerequisite Closure** (backups, rolling deployment, restart policy, the connection budget, `CONCURRENTLY`, migrate-before-deploy and equivalent concerns). Release Management is not a deployment engine | **APPROVED**; applied to `core-validation.md` §17.2 (with a dated note) and `production-readiness.md` |
| D4 | no release channels in Core V1; the architecture stays extensible (a channel would later scope "latest" and the policy per component) | **APPROVED** |

## 19. Decision table

| Decision | Options | Recommendation | Reason | Status |
|---|---|---|---|---|
| Dedicated service? | none (CDN manifest) / inside an existing service / `release-service` | `release-service` | independent authority, data, consumers, security boundary | DECIDED (D1) |
| Product vs component? | component only / product + component / + product release | product + component; no product release | clients check components; products scope authority | DECIDED |
| Version model? | SemVer / CalVer / build numbers / SHA | SemVer canonical + opaque native `buildId` + optional `sourceRevision` | comparable, and native identifiers kept | DECIDED |
| Environment ownership? | a release field / a deployment entity / one service per environment | one service per environment | releases are environment-independent; matches Core | DECIDED |
| Channels? | none / installed-only / all | none in V1 | no demonstrated need; stores provide tracks | DECIDED (D4) |
| Web compatibility? | none / minimum version + reload / build-hash header | minimum version + reload; the header deferred | real stale-tab problem, no installer semantics | DECIDED |
| Compatibility result shape? | one overloaded status / two fields / one `update` field + input errors | one `update` field (`none` / `available` / `required` + `reason`); support derived; input errors separate | no representable invalid state; unambiguous | DECIDED (final review) |
| Desktop compatibility? | decision only / + artifacts and updater manifest | decision only | the updater is distribution | DECIDED |
| Mobile compatibility? | decision only / + store integration | decision only (iOS and Android as separate kinds) | stores are distribution | DECIDED |
| AI release metadata? | in Release / separate | separate (ai-service, Stage 36+); `ai` kind reserved | model and prompt versions are configuration | DEFERRED |
| CI/CD identity? | human bearer / service token + policy | service token, ADR-0042 capabilities, per product | no impersonation | DECIDED |
| Human authority? | operator / owner of the operating Company / CI-only | the owner of the operating Company, with step-up | ADR-0050; P-S1 | DECIDED (D2) |
| Audit events? | none / four actions | the four actions, organization none | accountability | DECIDED |
| Artifact storage? | release-service / File / external | external distribution infrastructure | not a CDN or signer | DECIDED |
| Configuration / capability management? | A / B / C / D | D (after Core V1), revisited in 21.C | no generic V1 need proven | DEFERRED (21.C) |
| Feature flags? | V1 / defer | defer | no V1 need | DEFERRED (21.C) |
| Maintenance mode? | in Release / separate / defer | not Release; 21.C candidate | a different concern | DEFERRED (21.C) |
| Stage 20 register items | keep in Stage 20 / move to 21.x | move to 21.x | deployment engineering | DECIDED (D3) |

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

None. D1 to D4 are approved, and the compatibility model is final. The architecture is **ready for Stage 20.2**, which has not started.

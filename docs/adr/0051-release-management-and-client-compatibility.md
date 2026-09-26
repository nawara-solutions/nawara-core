# 0051. Release management and client compatibility

- **Status:** Proposed <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X --> (**draft; not approved.** Nothing here takes effect, and
  nothing is implemented, until the architecture owner accepts it and answers the owner decisions of the
  [Stage 20.1 record](../architecture/stage-20/stage-20-1-decisions-and-roadmap.md) §18.)
- **Date:** 2026-09-26
- **Deciders:** Anwar (project owner), approval pending

> Related: [ADR-0050](./0050-platform-administration-and-verified-human-authority.md) (verified human authority; no central admin),
> [ADR-0049](./0049-audit-trail-architecture.md) (audit trail), [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md)
> (service-token policies), [ADR-0041](./0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md) (client neutrality),
> [ADR-0034](./0034-shared-service-kit-and-api-conventions.md) (service kit and API conventions). Evidence: the Stage 20.1 record.

## Context

Nawara products (Nawara Drive first; Nawara School and others later) will ship **backends, web applications, desktop applications
(Tauri is one possible technology) and mobile applications (iOS, Android)**, and later AI capabilities. Clients need a product-independent
answer to one question: *is this client version still supported, and should it update?* Operators need a trustworthy record of which
versions exist and which are withdrawn.

Repository evidence (Stage 20.1 inventory):
- **No release concept exists.** There is no release, version, channel, minimum version, feature flag or maintenance concept in any
  runtime. Package versions are placeholders (`0.0.1`). Images are tagged `sha-<git sha>` and `:production` (Auth deploy only). Health
  endpoints deliberately expose no version.
- **Compatibility conventions already exist** and must not be duplicated:
  - API: no version segment in v1, additive changes only, and a breaking change becomes `/v2/<prefix>`;
  - events: the `version` header, with N and N−1 accepted (A50);
  - migrations: checksummed and gated by `/ready`.
- **"Platform" already has a meaning in Core:** a Company's product line (ADR-0022). The release target must not be called "platform".
- **Earlier registers label about ten deployment and production items "Stage 20"** (`core-validation.md` §17.2): backups, rolling deploy,
  restart policy, the connection budget, `CONCURRENTLY`, migrate-before-deploy, and others. Those are CI/CD and production work, not
  release metadata.

## Options considered

**Where the capability lives**
1. **A static compatibility manifest per client, published by CI to a CDN** (no Core service). Cheapest, and cache-friendly. But it gives
   no authority model, no audited human action, no withdrawal without a rebuild, and no product-independent API.
2. **Inside an existing service** (organization-service, Auth, billing). Rejected: releases are global software facts, not tenant
   hierarchy, identity or commercial state, and adding them would make a second owner of an unrelated domain.
3. **A dedicated `release-service` with its own database** (recommended). It has an independent authority (release metadata and
   compatibility policy), independent data, several consumers (every product client), a distinct security boundary (CI credentials and
   a small human administration surface) and a high-volume, cache-friendly public read.

**Domain model**
- *A, minimal (recommended):* Product, Component, Release, CompatibilityPolicy.
- *B, richer:* A plus ReleaseArtifact, Deployment, Environment, Channel. Rejected for Core V1: artifacts, deployments and environments
  are CI/CD and distribution facts; channels have no demonstrated V1 need.

## Decision (proposed)

1. **Release management is metadata and compatibility, never delivery.** It is not CI/CD, a deployment engine, an artifact store or
   CDN, a signing service, an authorization engine, an entitlement check, analytics or a generic admin service.
2. **A dedicated `release-service`** (Option 3) with its own database and the standard kit. **No normal product request depends on it
   synchronously**; clients call it occasionally, and backends never call it on a request path.
3. **Domain (model A):**
   - **Product:** a product-independent registry key, e.g. `drive`. It is not Core's tenant Platform and has no foreign key to the
     hierarchy.
   - **Component:** a releasable unit of a product: `{product, key, targetKind}`. `targetKind` is one of `backend | web | desktop |
     mobile_ios | mobile_android`, extensible to `ai` later. Technology such as Tauri is not a kind: it is at most descriptive component
     metadata.
   - **Release:** an **immutable** declaration that version *V* of a component exists, with:
     - canonical `version`;
     - optional opaque `buildId` (the native build number, `versionCode` or Git SHA) and `sourceRevision`;
     - optional `notesRef`;
     - `status`: `registered → published → withdrawn` (no draft or deprecated states).
   - **CompatibilityPolicy (per client component):** `minimumSupportedVersion`, versioned. Every change is a new row, and every
     change is audited.
4. **Versions:** canonical **SemVer 2.0** for comparison (MAJOR.MINOR.PATCH, with an optional pre-release). Native identifiers stay native
   in `buildId` and are never compared. `(component, version)` is unique; a published version, its build identity and its target are
   immutable.
5. **Environments are not data:** each environment runs its own release-service (as every Core service). There is no `environment` column
   and no Deployment entity.
6. **Channels: none in Core V1.** Store tracks (TestFlight, Play testing) and CI already provide pre-release distribution. They are added
   only for a demonstrated need, and only for installed targets.
7. **Compatibility decision** (for web, desktop and mobile components; backends are registered for traceability only):

   | Decision | When |
   |---|---|
   | `update_required` | the version is below the minimum supported, or it is a withdrawn release |
   | `update_available` | the version is at or above the minimum, and below the latest published release |
   | `supported` | the version is at or above the latest published release, or at or above the minimum with nothing newer published |
   | `unsupported` | an unknown component, or a malformed version (never a guess) |

   Only published releases count as "latest". The client decides how to act: a web client reloads, an installed client opens its own
   updater or store. A web version below the minimum means "reload"; there is no installed-version or updater concept for web. API
   compatibility stays the prefix convention: when a backend drops a client generation, the release owner raises that client's minimum.
   Nothing is inferred from SemVer.
8. **Authority** (owner decision D2, see the record):
   - **automation** (CI) registers and publishes releases with a **narrow service credential**: an ADR-0042 policy with capabilities
     `release.register` and `release.publish`, per product. It never names a human.
   - **human policy actions** (withdraw, change the minimum supported version) are taken with the ADR-0050 pattern: the human's own
     bearer, verified live by release-service through Auth, plus a factor step-up. The authority holder is the Company owner of the
     deployment's **operating Company** (configured), recommended; no new role and no operator power (P-S1).
9. **Audit:** `release.registered`, `release.published`, `release.withdrawn` and `compatibility_policy.changed`. Each is security or
   administrative, with organization `none`, and the actor is the CI service or the verified owner. They are written in the same
   transaction through the outbox (Stage 18).
10. **Public compatibility read:**
    - unauthenticated (clients may be pre-login);
    - rate-limited;
    - minimal: the decision, the latest published version, and the minimum;
    - never registered-but-unpublished data, and never user data;
    - `Cache-Control` with a short max-age and an `ETag`. A required update therefore propagates within the TTL.
11. **Failure semantics:**
    - **Compatibility read unavailable:** clients fail **open**. They use their last cached decision, or proceed, because product use
      never depends on it. A cached `update_required` stays binding.
    - **Registration and administration unavailable:** fail **closed**, and CI retries (idempotent on `(component, version)`).
12. **Out of scope:**
    - artifacts, binaries and signing keys (distribution infrastructure: stores, updater manifests, CDN);
    - deployments and rollback execution (CI/CD);
    - per-user version tracking (analytics);
    - tenant-specific targeting;
    - feature flags, remote configuration and maintenance mode (Stage 21.C);
    - AI model, prompt and RAG versions (ai-service, Stage 36+: AI configuration metadata, not software releases);
    - commercial entitlement.

## Consequences

- **Easier:** one product-independent answer for every client type; audited withdrawals and minimum-version changes; no hot-path
  dependency; web kept separate from installed clients; Tauri stays a technology, not a domain concept.
- **Harder:** a new deployable, with its own database, CI credential provisioning and a public read endpoint to operate. Products must
  call it and honour cached decisions. Environments need one release-service each.
- **Follow-up:**
  - the Stage 20 decomposition in the record;
  - the reassignment of the §17.2 "Stage 20" deployment items to Stage 21.x (owner decision D3);
  - new audit catalog actions (Stage 20.3 / 20.4);
  - CLAUDE.md and core-architecture service lists updated when the service is built.

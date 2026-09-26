# 0051. Release management and client compatibility

- **Status:** Accepted <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X --> (2026-09-26, by the owner, after the Stage 20.1 review:
  D1–D4 approved and the compatibility model finalized, see the [Stage 20.1 record](../architecture/stage-20/stage-20-1-decisions-and-roadmap.md).
  **Acceptance is a decision about architecture only:** nothing is implemented until the Stage 20.2+ implementation stages are authorized.)
- **Date:** 2026-09-26
- **Deciders:** Anwar (project owner). D1–D4 were decided by the architecture owner on 2026-09-26.

> Related: [ADR-0050](./0050-platform-administration-and-verified-human-authority.md) (verified human authority; no central admin),
> [ADR-0049](./0049-audit-trail-architecture.md) (audit trail), [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md)
> (service-token policies), [ADR-0041](./0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md) (client neutrality),
> [ADR-0034](./0034-shared-service-kit-and-api-conventions.md) (service kit and API conventions). Evidence: the Stage 20.1 record.

## Context

Nawara products (Nawara Drive first; Nawara School and others later) will ship **backends, web applications, desktop applications
(Tauri is one possible technology) and mobile applications (iOS, Android)**, and later AI capabilities. Clients need a product-independent
answer to one question: *may this client version keep running, and should it update?* Operators need a trustworthy record of which
versions exist and which are withdrawn.

Repository evidence (Stage 20.1 inventory):
- **No release concept exists.** There is no release, version, channel, minimum version, feature flag or maintenance concept in any
  runtime. Package versions are placeholders (`0.0.1`). Images are tagged `sha-<git sha>` and `:production` (Auth deploy only). Health
  endpoints deliberately expose no version.
- **Compatibility conventions already exist** and must not be duplicated:
  - API: no version segment in v1, additive changes only, and a breaking change becomes `/v2/<prefix>`;
  - events: the `version` header, with N and N−1 accepted (A50);
  - migrations: checksummed and gated by `/ready`.
- **"Platform" already has a meaning in Core:** a Company's product line (ADR-0022). The release target is called a *kind*, never a
  "platform".
- **Earlier registers labelled deployment and production engineering "Stage 20"** (`core-validation.md` §17.2): backups, rolling deploy,
  restart policy, the connection budget, `CONCURRENTLY`, migrate-before-deploy, and others.

## Options considered

**Where the capability lives**
1. **A static compatibility manifest per client, published by CI to a CDN** (no Core service). It gives no authority model, no audited
   human action, and no withdrawal without a rebuild. It remains a possible delivery optimization in front of the service.
2. **Inside an existing service** (organization-service, Auth, Billing). Rejected: releases are global software facts, not tenant
   hierarchy, identity or commercial state.
3. **A dedicated `release-service` with its own database.** Chosen (D1).

**Domain model:** *A, minimal* (Product, Component, Release, CompatibilityPolicy); chosen. *B, richer* (plus ReleaseArtifact, Deployment,
Environment, Channel); rejected for Core V1, because those are CI/CD and distribution facts, and channels have no V1 need (D4).

**Compatibility result:**
- *(i)* One overloaded status (`supported`, `update_available`, `update_required`, `unsupported`). Rejected: `supported` meant "at
  latest", and `unsupported` mixed a policy verdict with bad input.
- *(ii)* Two fields: support (`supported` / `unsupported`) and update (`none` / `available` / `required`). Rejected. In this policy
  they are not independent (`required` ⟺ not supported), so two fields admit states that must never exist (supported + required,
  unsupported + none or available).
- *(iii)* **One update decision, with support derived and bad input an explicit error.** Chosen: the smallest representation that is
  unambiguous and cannot express an invalid state.

## Decision

1. **Release management is metadata and compatibility, never delivery.** It is not CI/CD, a deployment engine, an artifact store or
   CDN, a signing service, an authorization engine, an entitlement check, analytics or a generic admin service. **The deployment and
   production items formerly labelled "Stage 20" belong to Stage 21.x Production Prerequisite Closure** (D3).
2. **A dedicated `release-service`** with its own PostgreSQL database and the standard kit (D1). **No normal product request depends on
   it synchronously**: clients call it occasionally, and backends never call it on a request path.
3. **Domain:**
   - **Product:** a product-independent registry key (e.g. `drive`). It is not Core's tenant Platform, and has no foreign key to the
     hierarchy.
   - **Component:** a releasable unit `{product, key, kind}`. The kind is one of `backend | web | desktop | mobile_ios | mobile_android`,
     extensible (`ai` reserved). A technology such as Tauri is at most descriptive metadata, never a kind.
   - **Release:** an **immutable** declaration that version *V* of a component exists, with:
     - canonical `version`;
     - opaque `buildId` (native build number, `versionCode` or Git SHA) and `sourceRevision`, optional;
     - optional `notesRef`;
     - `status`: `registered → published → withdrawn`.
   - **CompatibilityPolicy (per client component):** `minimumVersion`, append-only versioned, every change audited. **Invariant:** the
     minimum never exceeds the latest published release. It is enforced on every policy change **and every withdrawal**: a withdrawal
     that would leave the minimum above the new latest is refused until the minimum is lowered (itself audited). This prevents a
     lockout where every client is required to update and no release exists to update to.
4. **Versions:** SemVer 2.0 for comparison. Native identifiers stay native and are never compared. `(component, version)` is unique; a
   published version, its build identity and its kind are immutable. **"Latest" is the highest published, not-withdrawn release without
   a pre-release tag** (no channels, so a pre-release never becomes everyone's latest).
5. **Environments are not data:** each environment runs its own release-service. There is no Deployment entity.
6. **No release channels in Core V1** (D4). The model stays extensible: a channel would scope "latest" and the policy per component
   later, without changing the decision semantics.
7. **Compatibility decision** (web, desktop, iOS and Android components; backends are registered for traceability only). The input is a
   component and the client's version.
   - **Input errors, which are never a decision:**
     - `invalid_version`: malformed;
     - `unknown_component`: the component does not exist;
     - `unknown_release`: a well-formed version that is not a registered release of that component. Every shipped build (installed or
       deployed web) is registered by CI.
   - **For a known release, one field `update`:**

     | `update` | When | Web client | Installed client (desktop, iOS, Android) |
     |---|---|---|---|
     | `required` (with `reason`: `withdrawn` or `below_minimum`) | the release is withdrawn, or its version is below the minimum | stop using the loaded build: reload the deployed web application | block use until updated through the native updater or store |
     | `available` | not required, and a newer latest release exists | optional: suggest a refresh | optional: offer the update |
     | `none` | not required, and nothing newer is published | – | – |

     - **Supported ⟺ `update` ≠ `required`.** It is derived, never sent as a second field.
     - A newer release alone never forces an update; only the minimum and withdrawal do.
     - The response also carries `latestVersion` and `minimumVersion` (public release facts, no user data).
     - **A withdrawn release above the latest** (for example, `2.0.0` withdrawn while `1.0.0` is the latest) is still `required` /
       `withdrawn`. `latestVersion` can then be lower than the client's own version, and it is **never a downgrade target for installed
       clients**. Installed clients update only to a version greater than their own, so they stay blocked until a fix-forward release is
       published; that is the intended outcome for a withdrawn, possibly compromised, build. A web client reloads whatever is deployed,
       and redeploying the older web build is CI's rollback.
8. **Authority** (D2):
   - **Automation:** CI registers and publishes with a **narrow service credential**, an ADR-0042 policy with the `release.register` /
     `release.publish` capabilities, per product. It never impersonates a human.
   - **Humans:** withdrawal and minimum-version changes are taken by the **verified owner of the configured operating Company**, with
     their own bearer verified live through Auth and a **mandatory factor step-up** (the ADR-0050 pattern).
   - **Operators:** no Release Management authority in Core V1.
9. **Audit:**

   | Action | Category | Actor |
   |---|---|---|
   | `release.registered`, `release.published` | administrative | the CI service |
   | `release.withdrawn`, `compatibility_policy.changed` | security | the verified owner |

   Organization `none`; written in the same transaction through the outbox. Public reads are not audited.
10. **The public compatibility read** is unauthenticated (clients may be pre-login), rate-limited and minimal. It never returns
    registered-but-unpublished data other than the caller's own release, and never user data. `Cache-Control` is a short max-age with an
    `ETag` (over the policy version and the latest release); a new `required` therefore propagates within the TTL.
11. **Failure semantics:**
    - **Compatibility service unreachable:** fail **open**. The client keeps its last cached decision, or proceeds if it has none; a
      cached `required` stays binding.
    - **Input errors (a definitive answer):** never treated as compatible. Clients handle them as "cannot verify this build" (installed:
      as `required`; web: reload).
    - **Registration and administration:** fail **closed**; CI retries (idempotent on `(component, version)`).
12. **Out of scope:**
    - artifacts, binaries and signing keys (distribution infrastructure);
    - deployment and rollback execution (CI/CD);
    - per-user version tracking;
    - tenant-specific targeting;
    - feature flags, remote configuration and maintenance mode (Stage 21.C);
    - AI model, prompt and RAG versions (ai-service, Stage 36+);
    - commercial entitlement; authorization.

## Consequences

- **Easier:**
  - one product-independent, unambiguous client answer, with no invalid states;
  - audited withdrawals and minimum changes;
  - no hot-path dependency;
  - web kept separate from installed clients;
  - Tauri stays a technology;
  - deployment engineering has an explicit home (21.x).
- **Harder:**
  - a new deployable with its own database, CI credential provisioning and a public read to operate;
  - CI must register every shipped build (otherwise clients receive `unknown_release`);
  - products must honour cached decisions;
  - one release-service per environment.
- **Follow-up:**
  - Stage 20.2–20.7 (the record, §17);
  - four audit catalog actions (20.3 / 20.4);
  - the CLAUDE.md and core-architecture service lists updated when the service is built (20.2);
  - Stage 21.x takes the reassigned deployment items.

# Architecture Decision Records (ADR)

An ADR captures one significant, hard-to-reverse architectural decision: the context that
forced it, the options considered, the choice made, and its consequences. Once accepted, an
ADR is **immutable** — if a decision changes later, write a new ADR that **supersedes** the
old one rather than editing it. This keeps a truthful history of _why_ the system looks the
way it does.

## When to write one

Write an ADR for anything that would be expensive to reverse or confusing to a future
contributor without the reasoning, e.g.:

- Choosing a datastore, message broker, or framework
- Splitting or merging a service
- Adopting a monorepo tool, a testing strategy, an auth strategy
- Any decision recorded in this project's root architecture doc (if it has one) that needs
  the _why_, not just the _what_

Don't write one for reversible, low-stakes choices (e.g. a lint rule, a variable name) — use
a PR description or code comment instead.

## Naming

```
NNNN-short-kebab-title.md
```

Numbers are sequential and never reused, even if an ADR is later superseded or rejected.

## Workflow

1. Copy [`template.md`](./template.md) to `NNNN-short-kebab-title.md` (next sequential number).
2. Fill it in with status `Proposed`.
3. Get it reviewed in the PR that introduces the decision (or the PR that first acts on it).
4. When the **architecture owner explicitly approves the decision**, set status to `Accepted`, with the date and where the approval is
   recorded (for example "Accepted (2026-09-26, by the owner, Stage 19.1 decision D1)").
5. If a later decision replaces this one, set this one's status to `Superseded by ADR-000X` (or `Partially superseded by ADR-000X`
   for part of it) and link both directions.

## Status lifecycle (Core V2 A1.1, owner decision OD-A1-1 / Q-ADR-1)

| Status | Meaning |
|---|---|
| `Proposed` | written and reviewable; not yet approved. An ADR may already be implemented, merged and relied on while Proposed |
| `Accepted` | the architecture owner has **explicitly approved** the decision, recorded in the ADR's status line. It does not imply that every consequence is implemented |
| `Superseded by ADR-000X` / `Partially superseded by ADR-000X` | a later ADR replaces all or part of the decision; both ADRs link to each other so the history stays traceable |
| `Deprecated` | the decision no longer applies and nothing replaces it |
| `Rejected` | considered and not adopted |

- **Merge is not approval.** Merging the PR that adds or acts on an ADR does not make it Accepted.
- **Implementation is not approval.** Code, passing tests or a deployment that follow an ADR do not make it Accepted, and neither
  does another ADR building on it. The `Deciders` field names who decides, not that they have approved.
- **Supersession takes effect when the superseding ADR is Accepted.** Older ADRs already marked (partially) superseded or amended by
  an ADR that is still `Proposed` (for example 0009, 0016 → 0022) keep that marker as historical record; the supersession becomes
  formal when the newer ADR is Accepted. The markers pointing to ADR-0026 (0005; 0004 and 0006) and to ADR-0030 (0001) became formal
  with those ADRs' acceptance on 2026-10-09 (Core V2 A5.2), and those pointing to ADR-0023 (0011 and 0014, each **partly** superseded)
  with ADR-0023's acceptance on 2026-10-09 (A5.2-I). ADR-0059 (accepted 2026-10-09, A5.3) partly supersedes ADR-0050 (Accepted) and
  ADR-0017 (Proposed, marker only) and amends ADR-0024 (Proposed, forward note); merged as PR #258. ADR-0060 (accepted 2026-10-09, A5.3
  OD-A5-1) partly supersedes ADR-0040 (decision 2 only) and ADR-0050 (the decision 12 lifecycle bullet) and clarifies ADR-0042 (decision
  5); until its pull request is merged, these relationships are recorded on its branch only.
- Status changes are made one ADR at a time, never in bulk. The current review of every Proposed ADR is in the
  [A1 record](../architecture/core-v2-a1-architecture.md) §3; the Organization ADRs reviewed in Core V2 A5.2 are in the
  [A5 record](../architecture/core-v2-a5-organization.md) §11.

## Index

| #   | Title | Status |
| --- | ----- | ------ |
| [0001](./0001-generic-organization-id-scoping-claim.md) | Generic `organizationId` as the multi-tenancy scoping claim | Accepted (partly superseded by 0030, formal 2026-10-09) |
| [0002](./0002-jwt-access-token-with-rotating-refresh-token.md) | JWT access token + DB-backed refresh token with rotation & reuse detection | Accepted |
| [0003](./0003-postgresql-typeorm-persistence.md) | PostgreSQL + TypeORM as auth-service's persistence | Accepted |
| [0004](./0004-synchronous-fail-closed-license-validation.md) | Synchronous, fail-closed license validation against payment-service for B2B registration | Accepted (partly superseded by ADR-0026 and ADR-0028, 2026-10-09) |
| [0005](./0005-bounded-time-license-subscription-revalidation.md) | Bounded-time license and subscription re-validation on login and refresh | Superseded by ADR-0026 |
| [0006](./0006-per-user-subscription-reservation-on-license-lapse.md) | Per-user subscription reservation on organization license lapse | Accepted |
| [0007](./0007-out-of-band-cash-payment-confirmation.md) | Out-of-band cash payment confirmation via Admin role | Accepted |
| [0008](./0008-automatic-grace-license-on-license-lapse.md) | Automatic 24-hour grace license on organization license lapse | Accepted |
| [0009](./0009-platform-scoped-admin-accounts.md) | Platform-scoped Admin accounts (platformId, owner/operator tiers) | Accepted |
| [0010](./0010-owner-secret-key-login-with-device-alerting.md) | Owner permanent secret-key login with new-device alerting | Partially superseded by ADR-0025 |
| [0011](./0011-operator-time-boxed-login-code.md) | Time-boxed operator login code with business-day gating | Accepted (partly superseded by ADR-0023, business-day gating only, 2026-10-09) |
| [0012](./0012-owner-managed-operator-schedule-and-blocking.md) | Owner-managed operator profile, schedule, and block/unblock | Accepted |
| [0013](./0013-operator-session-ceiling.md) | Hard 8-hour session ceiling for operator refresh-token rotation | Accepted |
| [0014](./0014-schedule-anchored-operator-duration.md) | Schedule-anchored operator login-code and session duration | Accepted (partly superseded by ADR-0023, platform-calendar combination only, 2026-10-09) |
| [0015](./0015-two-phase-operator-contact-confirmation.md) | Two-phase operator contact confirmation before first login | Accepted |
| [0016](./0016-first-owner-bootstrap-command.md) | One-time bootstrap command for a platform's first owner account | Accepted |
| [0017](./0017-single-owner-with-secret-key-force-reset.md) | Single owner per Company, permanently, with a CLI secret-key force-reset tool | Proposed (force-reset CLI never built; withdrawn from Core V1 by ADR-0050; partly superseded by ADR-0059, 2026-10-09: permanence and no-transfer only) |
| [0018](./0018-rabbitmq-as-async-message-broker.md) | RabbitMQ as the async message broker, via `@golevelup/nestjs-rabbitmq` | Proposed |
| [0019](./0019-twilio-as-sms-gateway-provider.md) | Twilio as the SMS gateway provider | Accepted (2026-09-24, Stage 16.8 acceptance note) |
| [0020](./0020-organization-entity-and-platform-scoped-management.md) | Organization entity and platform-scoped organization management | Proposed |
| [0021](./0021-payment-service-platform-scoped-authorization.md) | Synchronous, fail-closed platform-scope check for payment-service's organization-scoped admin actions | Proposed |
| [0022](./0022-company-and-platform-entities-with-operator-assignment.md) | Company and Platform entities, with many-to-many operator↔platform assignment | Proposed |
| [0023](./0023-platform-access-check-and-operator-login-decoupling.md) | Generic platform-access check, and decoupling operator login/session gating from any Platform's calendar | Accepted (2026-10-09, A5.2-I owner authorization; three passages revised before acceptance) |
| [0024](./0024-database-enforced-tenancy-and-authorization-integrity.md) | Database-enforced tenancy and authorization integrity (Owner/Operator subtypes, mandatory FKs, DB-level assignment uniqueness) | Proposed |
| [0025](./0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md) | Owner login with password + second factor; secret key as step-up and recovery credential | Accepted (2026-09-26, Stage 19.1 D1; amended by 0050) |
| [0026](./0026-authentication-is-not-entitlement.md) | Authentication is not entitlement: auth-service stops gating login/refresh on licenses and subscriptions | Accepted (2026-10-09, A5.2-E owner authorization; decisions 2 and 4 revised before acceptance) |
| [0027](./0027-service-layer-security-model.md) | Service-layer security model: cool-down recovery, enrollment rules, live authorization, shared security state, key management | Accepted (2026-09-26, Stage 19.1 D1; amended by 0050) |
| [0028](./0028-organization-join-codes-membership-and-organization-admin.md) | Organization join codes, membership and organization-admin authority | Accepted (2026-10-09, A5.2-F owner authorization; registration license sentences revised before acceptance; partly superseded by ADR-0030, 2026-10-09) |
| [0029](./0029-organization-admin-invitations.md) | Organization admin invitations: privileged provisioning, and where administration authority lives | Accepted (2026-10-09, A5.2-G owner authorization; partly superseded by ADR-0030, 2026-10-09) |
| [0030](./0030-multi-organization-membership-and-revoked-state.md) | Multi-organization membership: one identity, many memberships, and the REVOKED state | Accepted (2026-10-09, A5.2-H owner authorization; two sentences revised before acceptance) |
| [0031](./0031-organization-service-intended-owner-of-the-hierarchy.md) | organization-service is the intended future owner of Company, Platform and Organization (mechanism deferred) | Accepted (2026-10-09, A5.2-D owner authorization; partly superseded by ADR-0039) |
| [0032](./0032-database-per-service-on-a-shared-server.md) | Database per service on a shared PostgreSQL server | Proposed |
| [0033](./0033-service-to-service-authentication-and-user-identity.md) | Service-to-service authentication, and how services identify the end user | Accepted (2026-09-26, Stage 19.1 D1) |
| [0034](./0034-shared-service-kit-and-api-conventions.md) | A small shared service-kit library, and one set of API conventions | Superseded by ADR-0056 (2026-10-07) |
| [0035](./0035-financial-service-boundaries.md) | Financial service boundaries: billing, payment and accounting | Proposed |
| [0036](./0036-money-parties-and-source-references.md) | Money, explicit parties and generic source references | Proposed |
| [0037](./0037-reliable-events-outbox-inbox.md) | Reliable events: RabbitMQ with a transactional outbox and an inbox | Proposed |
| [0038](./0038-entitlement-in-billing-service.md) | Entitlement (licenses and subscriptions) lives in billing-service | Proposed (schema superseded in part by 0044; ownership principle stands) |
| [0039](./0039-organization-ownership-and-cross-service-migration-authority.md) | Organization ownership and cross-service migration authority: finalizes ADR-0031's deferred O9 mechanism | Accepted (2026-10-09, A5.2-C owner authorization; partly superseded by ADR-0040) |
| [0040](./0040-organization-ownership-migration-decisions.md) | Organization ownership migration: Auth's reference model, cutover mechanism, one-way door and import | Accepted (2026-09-20; Amendments 1 and 2; production gates in decision 7; partly superseded by ADR-0060, decision 2 only, 2026-10-09) |
| [0041](./0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md) | Administrative capabilities are domain-owned, client-neutral APIs (no client technology decided) | Accepted (2026-09-26, Stage 19.1 D1) |
| [0042](./0042-service-token-scopes-and-administrative-authorization.md) | Service-token scopes, hierarchy validation and administrative authorization (BD-4) | Accepted (Amendment 1, 2026-09-20; Amendment 3, 2026-09-26: `auth-service` no longer admitted to Payment) |
| [0043](./0043-product-specific-entry-context-and-licensed-organization-participation.md) | Product-specific entry context and licensed organization participation: products declare their own entry model; Flow's organization participation is licensed, not universal | Proposed |
| [0044](./0044-subscription-entitlement-final-model.md) | Subscription and Entitlement final model: one organization-scoped Subscription, no License/UserSubscription split | Proposed (records already-merged Stage 12.1-12.7) |
| [0045](./0045-commercial-entitlementkind-compatibility-fields.md) | Commercial `entitlementKind` compatibility fields: kept as compatibility/event fields, never entitlement authority | Proposed |
| [0046](./0046-notification-service-architecture.md) | Notification service architecture: Notification → Delivery → Attempt, persisted versioned templates, canonical event intake, ambiguity and secret policy | Accepted (2026-09-24, Stage 16.9 acceptance note) |
| [0047](./0047-resend-as-the-email-provider.md) | Resend as the notification email provider (direct HTTPS, request idempotency keys) | Accepted (2026-09-24) |
| [0048](./0048-file-service-architecture.md) | File Service architecture: generic immutable file objects, proxy streaming, storage port, caller policies and product-issued access tickets | Accepted (2026-09-24, Stage 17.1) |
| [0049](./0049-audit-trail-architecture.md) | Security and business audit trail: producer-owned cataloged audit events through the transactional outbox, append-only records, tenant-safe query | Accepted (2026-09-25, Stage 18.1; amended by 0050) |
| [0050](./0050-platform-administration-and-verified-human-authority.md) | Platform administration: domain-owned capabilities, verified human authority through Auth (no delegation in Core V1), owner-only security interventions | Accepted (2026-09-26, Stage 19.1; partly superseded by ADR-0059, 2026-10-09: Stage 19 scope passages only, and by ADR-0060, 2026-10-09: the decision 12 lifecycle bullet only) |
| [0051](./0051-release-management-and-client-compatibility.md) | Release management and client compatibility: a dedicated release-service for release metadata and client compatibility, never delivery | Accepted (2026-09-26, Stage 20.1; D1–D4 approved) |
| [0052](./0052-core-v1-capability-closure.md) | Core V1 capability closure: a shared caller-policy mechanism in the service-kit, enforced Payment and Billing admission with Organization-scope verification, durable Auth domain events through Auth's outbox | Accepted (2026-09-26, Stage 21.C.1; Q1–Q6 resolved) |
| [0053](./0053-core-v1-production-rabbitmq.md) | Core V1 production RabbitMQ: one private node on the VPS, per-service least-privilege identities, audit-service deployed before Auth relays | Accepted (2026-09-27, RB-1 approved; RB-2) |
| [0054](./0054-localized-error-messages-and-stable-error-codes.md) | Error responses: a stable machine `code` and a server-localized `message` (EN / FR / AR) | Accepted (2026-10-01, Core V1 refactor R1; #161) |
| [0055](./0055-ai-service-repository-boundary.md) | AI service repository boundary: the AI runtime lives outside `nawara-core` (future `nawara-ia`); the Core scaffold is removed | Accepted (2026-10-06, owner decision; #208) |
| [0056](./0056-core-architecture-and-api-conventions.md) | Core architecture and API conventions: **the current Core convention** (consolidated; supersedes 0034) | Accepted (2026-10-07, by the architecture owner, A1.2) |
| [0057](./0057-messaging-conventions.md) | Messaging conventions: envelope, naming, versioning, delivery, de-duplication, retry and dead letters, catalogs (reconciles 0018 and 0037) | Proposed |
| [0058](./0058-access-token-signing-key-ring.md) | Access-token signing key ring: HS256 keys selected by `kid`, the existing `JWT_SECRET` as a kid-less legacy key, no fallback, staged rotation with a stated rollback boundary | Accepted (2026-10-08, by the architecture owner, A4.6) |
| [0059](./0059-company-ownership-transfer-and-exceptional-owner-recovery.md) | Company ownership transfer and exceptional owner recovery: exactly one active Owner, pending → active → retired, recovery stewards, default-off activation gates | Accepted (2026-10-09, A5.3 owner authorization; nothing implemented or activated; OD-S1 deferred) |
| [0060](./0060-company-platform-organization-lifecycle.md) | Company, Platform and Organization lifecycle: ACTIVE, SUSPENDED, ARCHIVED; effective state from ancestors; Organization Service authority; E4 + E1 + E5 enforcement; no deletion | Accepted (2026-10-09, A5.3 OD-A5-1 owner authorization; nothing implemented or activated) |
| [0061](./0061-auth-hierarchy-reference-repair-and-diagnostics.md) | Auth hierarchy-reference repair and diagnostics: Owner-only repair with factor step-up (resolve, authorize, then place), audit and mismatch alerts, read-only diagnostics | Accepted (2026-10-09, A5.3 OD-A5-4 owner authorization; nothing implemented or activated) |
| [0062](./0062-initial-hierarchy-provisioning-and-first-platform-sequencing.md) | Initial hierarchy provisioning and first-Platform sequencing: Company-only pre-activation hierarchy, first Platform after the verified post-F7 backup, Auth scope change control, provisioning-credential retirement, initial ACTIVE state | Proposed (2026-10-09, A5.3 OD-A5-2 policy direction; nothing implemented, provisioned or activated) |

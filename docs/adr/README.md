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
4. On merge, set status to `Accepted`.
5. If a later decision replaces this one, set this one's status to `Superseded by ADR-000X`
   and link both directions.

## Index

| #   | Title | Status |
| --- | ----- | ------ |
| [0001](./0001-generic-organization-id-scoping-claim.md) | Generic `organizationId` as the multi-tenancy scoping claim | Accepted (partly superseded by 0030) |
| [0002](./0002-jwt-access-token-with-rotating-refresh-token.md) | JWT access token + DB-backed refresh token with rotation & reuse detection | Accepted |
| [0003](./0003-postgresql-typeorm-persistence.md) | PostgreSQL + TypeORM as auth-service's persistence | Accepted |
| [0004](./0004-synchronous-fail-closed-license-validation.md) | Synchronous, fail-closed license validation against payment-service for B2B registration | Accepted |
| [0005](./0005-bounded-time-license-subscription-revalidation.md) | Bounded-time license and subscription re-validation on login and refresh | Superseded by ADR-0026 |
| [0006](./0006-per-user-subscription-reservation-on-license-lapse.md) | Per-user subscription reservation on organization license lapse | Accepted |
| [0007](./0007-out-of-band-cash-payment-confirmation.md) | Out-of-band cash payment confirmation via Admin role | Accepted |
| [0008](./0008-automatic-grace-license-on-license-lapse.md) | Automatic 24-hour grace license on organization license lapse | Accepted |
| [0009](./0009-platform-scoped-admin-accounts.md) | Platform-scoped Admin accounts (platformId, owner/operator tiers) | Accepted |
| [0010](./0010-owner-secret-key-login-with-device-alerting.md) | Owner permanent secret-key login with new-device alerting | Partially superseded by ADR-0025 |
| [0011](./0011-operator-time-boxed-login-code.md) | Time-boxed operator login code with business-day gating | Accepted |
| [0012](./0012-owner-managed-operator-schedule-and-blocking.md) | Owner-managed operator profile, schedule, and block/unblock | Accepted |
| [0013](./0013-operator-session-ceiling.md) | Hard 8-hour session ceiling for operator refresh-token rotation | Accepted |
| [0014](./0014-schedule-anchored-operator-duration.md) | Schedule-anchored operator login-code and session duration | Accepted |
| [0015](./0015-two-phase-operator-contact-confirmation.md) | Two-phase operator contact confirmation before first login | Accepted |
| [0016](./0016-first-owner-bootstrap-command.md) | One-time bootstrap command for a platform's first owner account | Accepted |
| [0017](./0017-single-owner-with-secret-key-force-reset.md) | Single owner per Company, permanently, with a CLI secret-key force-reset tool | Proposed |
| [0018](./0018-rabbitmq-as-async-message-broker.md) | RabbitMQ as the async message broker, via `@golevelup/nestjs-rabbitmq` | Proposed |
| [0019](./0019-twilio-as-sms-gateway-provider.md) | Twilio as the SMS gateway provider | Accepted (2026-09-24, Stage 16.8 acceptance note) |
| [0020](./0020-organization-entity-and-platform-scoped-management.md) | Organization entity and platform-scoped organization management | Proposed |
| [0021](./0021-payment-service-platform-scoped-authorization.md) | Synchronous, fail-closed platform-scope check for payment-service's organization-scoped admin actions | Proposed |
| [0022](./0022-company-and-platform-entities-with-operator-assignment.md) | Company and Platform entities, with many-to-many operator↔platform assignment | Proposed |
| [0023](./0023-platform-access-check-and-operator-login-decoupling.md) | Generic platform-access check, and decoupling operator login/session gating from any Platform's calendar | Proposed |
| [0024](./0024-database-enforced-tenancy-and-authorization-integrity.md) | Database-enforced tenancy and authorization integrity (Owner/Operator subtypes, mandatory FKs, DB-level assignment uniqueness) | Proposed |
| [0025](./0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md) | Owner login with password + second factor; secret key as step-up and recovery credential | Proposed |
| [0026](./0026-authentication-is-not-entitlement.md) | Authentication is not entitlement: auth-service stops gating login/refresh on licenses and subscriptions | Proposed |
| [0027](./0027-service-layer-security-model.md) | Service-layer security model: cool-down recovery, enrollment rules, live authorization, shared security state, key management | Proposed |
| [0028](./0028-organization-join-codes-membership-and-organization-admin.md) | Organization join codes, membership and organization-admin authority | Proposed |
| [0029](./0029-organization-admin-invitations.md) | Organization admin invitations: privileged provisioning, and where administration authority lives | Proposed |
| [0030](./0030-multi-organization-membership-and-revoked-state.md) | Multi-organization membership: one identity, many memberships, and the REVOKED state | Proposed |
| [0031](./0031-organization-service-intended-owner-of-the-hierarchy.md) | organization-service is the intended future owner of Company, Platform and Organization (mechanism deferred) | Proposed |
| [0032](./0032-database-per-service-on-a-shared-server.md) | Database per service on a shared PostgreSQL server | Proposed |
| [0033](./0033-service-to-service-authentication-and-user-identity.md) | Service-to-service authentication, and how services identify the end user | Proposed |
| [0034](./0034-shared-service-kit-and-api-conventions.md) | A small shared service-kit library, and one set of API conventions | Proposed |
| [0035](./0035-financial-service-boundaries.md) | Financial service boundaries: billing, payment and accounting | Proposed |
| [0036](./0036-money-parties-and-source-references.md) | Money, explicit parties and generic source references | Proposed |
| [0037](./0037-reliable-events-outbox-inbox.md) | Reliable events: RabbitMQ with a transactional outbox and an inbox | Proposed |
| [0038](./0038-entitlement-in-billing-service.md) | Entitlement (licenses and subscriptions) lives in billing-service | Proposed (schema superseded in part by 0044; ownership principle stands) |
| [0039](./0039-organization-ownership-and-cross-service-migration-authority.md) | Organization ownership and cross-service migration authority: finalizes ADR-0031's deferred O9 mechanism | Proposed (partly superseded by ADR-0040, which is Accepted) |
| [0040](./0040-organization-ownership-migration-decisions.md) | Organization ownership migration: Auth's reference model, cutover mechanism, one-way door and import | Accepted (2026-09-20; Amendments 1 and 2; production gates in decision 7) |
| [0041](./0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md) | Administrative capabilities are domain-owned, client-neutral APIs (no client technology decided) | Proposed |
| [0042](./0042-service-token-scopes-and-administrative-authorization.md) | Service-token scopes, hierarchy validation and administrative authorization (BD-4) | Accepted (Amendment 1, 2026-09-20) |
| [0043](./0043-product-specific-entry-context-and-licensed-organization-participation.md) | Product-specific entry context and licensed organization participation: products declare their own entry model; Flow's organization participation is licensed, not universal | Proposed |
| [0044](./0044-subscription-entitlement-final-model.md) | Subscription and Entitlement final model: one organization-scoped Subscription, no License/UserSubscription split | Proposed (records already-merged Stage 12.1-12.7) |
| [0045](./0045-commercial-entitlementkind-compatibility-fields.md) | Commercial `entitlementKind` compatibility fields: kept as compatibility/event fields, never entitlement authority | Proposed |
| [0046](./0046-notification-service-architecture.md) | Notification service architecture: Notification → Delivery → Attempt, persisted versioned templates, canonical event intake, ambiguity and secret policy | Accepted (2026-09-24, Stage 16.9 acceptance note) |
| [0047](./0047-resend-as-the-email-provider.md) | Resend as the notification email provider (direct HTTPS, request idempotency keys) | Accepted (2026-09-24) |
| [0048](./0048-file-service-architecture.md) | File Service architecture: generic immutable file objects, proxy streaming, storage port, caller policies and product-issued access tickets | Accepted (2026-09-24, Stage 17.1) |

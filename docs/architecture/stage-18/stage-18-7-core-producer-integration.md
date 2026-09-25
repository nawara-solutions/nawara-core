# Stage 18.7 — Core producer integration

- **Status:** implemented and validated on `feat/audit-core-producer-integration` (awaiting review; not committed).
- **Scope:** every Core producer writes its cataloged actions as central audit intent through `@nawara/audit-contract`'s
  `AuditEventWriter`, into its own transactional outbox, IN THE SAME TRANSACTION as the business change; the service-kit relay publishes
  it to RabbitMQ; audit-service (18.5) stores it; the 18.6 API reads it. Sub-stages, in order: 18.7.1 Payment, 18.7.2 Billing, 18.7.3
  Organization, 18.7.4 File, 18.7.5 the Auth outbox foundation, 18.7.6 Auth's actions, 18.7.7 closure.
- **Not in scope (and not present):** retention, erasure, DLQ privacy (18.8), the operational campaign (18.9), certification (18.10),
  Stage 19 administration, any Stage 21 refactor, Final Core Validation. No synchronous HTTP to Audit anywhere.
- **Frozen design followed:** [ADR-0049](../../adr/0049-audit-trail-architecture.md), [SDD](../../sdd/audit-service.md),
  [Stage 18.1](./stage-18-1-decisions-and-roadmap.md) (A9 system actors, A11 organization from the resource, A19 producer readiness, A20
  source, A33 correlation, A50 versioning). Five narrowly scoped **catalog corrections** (G1–G5, §3), decided by the owner.

## 1. Baseline

`main` at `0fbfa0a` (the Stage 18.6 merge, PR #120); working tree clean except the untracked `docs/reports/` (untouched). PostgreSQL
16.15 and RabbitMQ 3.13.7 (throwaway containers) for every real test; VersityGW v1.8.0 (the CI S3 test server) for File's S3 suites.

## 2. The one pattern

```text
BEGIN
  business change (+ its own history: billing_transition, admin_actor_event, auth_audit_event, …)
  AuditEventWriter.write(q, input)          → contract validation (fail closed), SAVEPOINT guard (refuses outside a transaction)
    → OutboxService.enqueue(q, audit.<action>)   ON CONFLICT (id) DO NOTHING
COMMIT
        → kit OutboxRelay (poll, publisher confirm, retry with backoff, drain at shutdown) → RabbitMQ → audit-service
```

- **Actor:** from the producer's verified context only — the service-token caller; the Auth-verified user with the kind from Auth's
  identity or database (never a token claim, header or body); or a cataloged system process (A9). An uncataloged actor throws: the
  change rolls back (no evidence is guessed).
- **Organization:** from the persisted row the change wrote or locked (payment, invoice, product seller, membership, join code, file…),
  read back with `RETURNING` where the request named one; never a request value. API responses are unchanged.
- **Event ids:** deterministic (uuid v5 of entity + action [+ revision / reason]) where a change can be retried (Payment, Billing, File
  deletion and incidents), so a retry writes once; random elsewhere (each successful change is a new fact).
- **Correlation:** the kit request context (same grammar as the contract, so always valid) or an explicit, validated id; navigation only.
- **Identifiers and codes only:** no names, amounts, references, contact data, IPs, keys, tokens or provider codes (tested per producer).

## 3. Catalog corrections G1–G5 (discovered during real producer integration)

Each is a gap between the theoretical 18.4 catalog and a real, pre-existing producer model, evidenced by code or the persisted model.
None broadens anything else (a snapshot test pins the rest: `libs/audit-contract/test/catalog-corrections.spec.ts`).

| # | Action(s) | 18.4 rule | Evidence | Correction |
|---|---|---|---|---|
| G1 | `payment.succeeded`, `payment.failed` | actors: service; system `payment_webhook` | an Auth-verified user starts and syncs attempts (`attempts.controller.ts` `@Post()` / `@Post(':attemptId/sync')`) and a provider answer settles the payment in that user's request (`attempt.service.ts` start → `settlePaymentAfterFailure`, sync → `payment.succeeded`); `AttemptResolver.drainOnce` settles unknown attempts as Payment's own process | + `user` (the already-valid kinds), + system `payment_attempt_resolver`; only these two actions |
| G2 | `payment_request.cancelled` | actors: user, service | `payment-request.repository.ts` `applyPaymentEvent` (`requestTo === 'cancelled'`) completes the cancellation when Payment reports it, and the reconciler does the same from a synthetic, deterministic event (`deterministicEventId(…, 'reconciliation')`) | + system `payment_event_consumer`, `payment_reconciler`; only this action |
| G3 | `invoice.issued` / `.discarded` / `.paid`, `payment_request.created` / `.cancelled` | organization `required` | `invoice."organizationId"` is nullable (`0003_invoice.sql:16`); it is set exactly when the seller is an organization (`invoice_organization_matches_seller`); a user seller's invoice has none | `optional`, from the persisted invoice only |
| G4 | `product.created` / `.archived`, `price.created` / `.retired` | organization `none` | a product's seller is `user`, `organization` or `company` (`0002_product_price.sql:18`); an organization seller's catalog is that organization's | `optional`: the seller organization when the seller is one, else null |
| G5 | `organization.updated` | users `owner`, `operator` | Organization's own authorization grants `org_admin` to a `member` who administers that organization (`authorization-evaluator.ts:40`; covered by `admin.e2e-spec.ts` "an org-admin member of THAT organization succeeds") | + `member`; `organization.created` and every platform/company action still refuse it |

**A50 verification (the version stays 1):** every correction only widens an accepted set — a new actor kind or process for named actions,
`required`/`none` → `optional`. Every payload valid under 18.4 is still valid; no field, type or shape changes; no stored row changes. A50
classifies that as additive: the version is unchanged. The rollout rule is unchanged too — audit-service (with the newer catalog) deploys
before the producers; until then a newly valid event is dead-lettered and replayed after the upgrade, never lost. The catalog doc is
regenerated (`npm run catalog:doc -w @nawara/audit-contract`). Regression tests pin: the newly valid cases; that new actors are refused
everywhere else; that G3/G4 organizations are UUID or null (a malformed or listed value is refused, the key stays mandatory); that
subscriptions stay `required` and platform actions `none`; that exactly 16 actions accept a `member` (the 13 of 18.4 + G1 + G5).

## 4. Producer integration matrix

| Service | Catalog actions owned | Existing mutations found | Integrated | Inactive / deferred | Outbox | Relay | Real E2E |
|---|---|---|---|---|---|---|---|
| payment-service | 5 | 5 | 5 | 0 | kit (existing) | kit (existing) | pipeline + closure |
| billing-service | 11 | 11 | 11 | 0 | kit (existing) | kit (existing) | pipeline + closure |
| organization-service | 7 | 7 | 7 | 0 | kit (tables existed, unused) | **new**: `OrganizationAuditModule` (kit `EventsModule`) | pipeline + closure |
| file-service | 2 | 2 (deletion; download + reconcile detection) | 2 | 0 | kit (tables existed, unused) | **new**: `FileAuditModule` | pipeline + closure (+ CLI) |
| auth-service | 24 | 24 | 24 | 0 | **new**: migration `0010` (the kit table) | **new**: `AuditRelayModule` (kit, on Auth's pool) | pipeline + closure |
| notification-service | 0 | — | — | — | — | — | nothing cataloged: no audit-worthy action in V1 |
| audit-service | 1 (18.6 `platform_query.executed`) | 1 | (18.6) | 0 | — | — | closure (self-audit visible) |

No blocker remains. Every catalog action maps to a real, pre-existing mutation; none was invented, none needed an artificial code path.

## 5. Action-level matrix

Transaction boundary is the business change's own transaction unless stated. "In-service" = the service's own audit E2E on real
PostgreSQL; "pipeline" = built service → RabbitMQ → live audit-service.

| Action | Producer | Business mutation | Actor source | Organization source | Resource | Subject | Changes | Boundary | E2E proven |
|---|---|---|---|---|---|---|---|---|---|
| `payment.created` | payment | `PaymentService.create` | service caller | payment row | payment | — | — | create tx | in-service, pipeline, closure |
| `payment.cancelled` | payment | `PaymentService.cancel` | service caller | payment row | payment | — | — | cancel tx | in-service |
| `payment.expired` | payment | `ExpirySweeper` | system `payment_expiry_sweep` | payment row | payment | — | — | sweep tx | in-service |
| `payment.succeeded` | payment | `AttemptService.sync` / resolver / webhook (`applyStatus`) | user (+ Auth kind) / service / `payment_attempt_resolver` / `payment_webhook` | payment row | payment | — | `settled_method` (row) | settlement tx | in-service (user, resolver) |
| `payment.failed` | payment | start / sync / resolver (`settlePaymentAfterFailure`) | as above | payment row | payment | — | — | settlement tx | in-service (user at start and sync) |
| `invoice.issued` | billing | `InvoiceRepository.issue` | `TransitionContext` | invoice row (G3) | invoice | — | — | issue tx | in-service, pipeline |
| `invoice.discarded` | billing | `InvoiceRepository.discard` | `TransitionContext` | invoice row (G3) | invoice | — | — | discard tx | in-service |
| `invoice.paid` | billing | `applyPaymentEvent` | `payment_event_consumer` / `payment_reconciler` | invoice row | invoice | — | — | event tx | in-service |
| `payment_request.created` | billing | `PaymentRequestRepository.create` | service / user (`withVerifiedKind`) | invoice row | payment_request | — | `invoice_id` | create tx | in-service, pipeline |
| `payment_request.cancelled` | billing | `cancelUnsent` / `applyPaymentEvent` | service / consumer / reconciler (G2) | invoice row (joined) | payment_request | — | `invoice_id` | cancel / event tx | in-service |
| `subscription.activated` | billing | `applySuccessfulPayment` (pending → active) | consumer / reconciler | subscription row | subscription | — | `product_id`, `price_id` | event tx | in-service |
| `subscription.renewed` | billing | `applySuccessfulPayment` (active / grace) | consumer / reconciler | subscription row | subscription | — | `period_end` from → to | event tx (id + revision) | in-service |
| `product.created` / `.archived` | billing | `ProductRepository.create` / `archive` | service caller | product seller (G4) | product | — | — | create (savepoint) / archive tx | in-service, pipeline, closure |
| `price.created` / `.retired` | billing | `PriceRepository.create` / `retire` | service caller | product seller (G4) | price | — | `product_id` | tx | in-service, pipeline |
| `company.created` / `.updated` | organization | `CompanyRepository` | service caller | none | company | — | — | write tx (real writes only) | in-service, pipeline, closure |
| `platform.created` / `.updated` | organization | `PlatformRepository` (service + admin routes) | service caller / Auth-verified human | none | platform | — | — | write tx + `admin_actor_event` | in-service, pipeline |
| `organization.created` / `.updated` | organization | `OrganizationRepository` (service + admin routes) | service caller / human (G5 for update) | self | organization | — | — | write tx + `admin_actor_event` | in-service, pipeline |
| `hierarchy.admin_operation_denied` | organization | `AdminController` refusals (5 sites) | Auth-verified human | the target when it is an organization | company / platform / organization | — | `operation`, `reason` | one tx with the local denial | in-service, pipeline |
| `file.deleted` | file | `FileRepository.requestDeletion` (AVAILABLE → DELETING) | owner service caller | file row | file | — | — | deletion tx | in-service, pipeline, closure |
| `file.integrity_incident` | file | download detection; reconcile CLI | `file_download_integrity_check` / `file_reconciliation` | file row | file | — | `reason` | own short tx (detection changes no row); id per (file, reason) | in-service, pipeline (download + CLI) |
| `membership.approved` / `.rejected` | auth | `MembershipService.decide` | guard actor (DB kind) | locked membership row | membership | the member | `authority` | decide tx + local | in-service, pipeline, closure |
| `membership.revoked` | auth | `MembershipService.revoke` | guard actor | membership row | membership | the member | `authority`, `was_admin` (row) | tx + local | in-service |
| `membership.admin_granted` / `_revoked` | auth | `MembershipService.setAdmin` | owner | `RETURNING` | membership | the member | — | tx (step-up) + local | in-service |
| `membership.admin_provisioned` | auth | `InvitationService.accept` | the member just created (row kind) | invitation / new membership row | membership | — | `invitation_id` | accept tx + local | in-service |
| `join_code.created` / `.revoked` | auth | `OnboardingService.create` / `revoke` | guard actor | `RETURNING` | join_code | — | `authority` | tx + local | in-service |
| `admin_invitation.created` / `.revoked` | auth | `InvitationService.create` / `revoke` | guard actor | `RETURNING` | admin_invitation | — | `authority` | tx + local | in-service |
| `operator.created` | auth | `OperatorAdminService.create` | owner (proven by its owner row) | none | user | — | — | tx (step-up) + local | in-service |
| `account.disabled` / `.enabled` | auth | `OperatorAdminService.setBlocked` | owner | none | user | — | — | tx + local | in-service (+ atomicity) |
| `platform_assignment.granted` / `.revoked` | auth | `AssignmentService.grant` / `revoke` | owner | none | platform_assignment | the operator | `platform_id` (row) | tx + local | in-service |
| `owner.password_changed`, `owner.secret_key_rotated`, `owner.factor_removed` | auth | `OwnerController` | guard actor | none | user / factor | — | — | tx (step-up) + local | in-service |
| `owner.factor_enrolled` | auth | `EnrollmentService.finish` | owner (factor rows belong to an owner) | none | factor (confirmed id) | — | `method` | tx + local | in-service (TOTP, passkey) |
| `owner.recovery_started` / `_completed` / `_cancelled` | auth | `RecoveryService` | owner (row kind) | none | user | — | — | tx + local (cancel now one tx) | in-service |
| `session.refresh_reuse_detected` | auth | `RefreshTokenService.rotate` (reuse branch) | system `refresh_reuse_detection` | none | user | — | — | the revoking tx | in-service, pipeline |
| `owner.webauthn_clone_suspected` | auth | `FactorService.verifyWebauthn` (clone signal) | system `webauthn_clone_detection` | none | factor | the owner | — | own short tx after the revoke (never poisons it) | in-service |
| `platform_query.executed` | audit | 18.6 platform read | the reading service | none | — | — | — | the read's tx | closure |

## 6. Auth outbox foundation (18.7.5)

- **Schema:** migration `0010_audit_outbox.sql` creates exactly the kit's `outbox` table, index and immutability trigger (byte-identical
  to `kit_0001`), nothing else (no inbox, no rate-limit table). Its down migration refuses while an unpublished event exists.
- **Tested:** fresh database (the E2E template), the production-upgrade paths of `migrations.e2e-spec.ts`, and `db/tests/run.sh` M12
  (upgrade of a populated 0009 database, immutability, name shape, guarded rollback, re-apply) on PostgreSQL 16.
- **Relay:** the kit `EventsModule` (OutboxService + OutboxRelay: poll, publisher confirm, retry with backoff, drain in
  `beforeApplicationShutdown`, bus closed after, pool last) — Auth's `DbService` is provided under the kit `DbService` token (one pool).
  It uses the kit default exchange (the one audit-service binds), not the legacy `AUTH_EVENTS` exchange.
- **Independent of `AUTH_EVENTS`:** that flag now governs only the legacy fire-and-forget events; audit evidence is always written and
  relayed. `RABBITMQ_URL` is required in production (fail closed); outside production its absence selects the in-memory bus. The CLI
  runs no relay (`auditRelay: false`).
- **Coexistence:** each action's local `auth_audit_event` row and its central intent share the transaction; the local row keeps the IP,
  session family and metadata, the central copy never does (tested). Legacy fire-and-forget events are unchanged; central audit never
  rides them (tested: no `audit.*` key on the legacy bus).

## 7. Relay operations (Organization, File, Auth — new relays)

Same kit relay as Payment and Billing: 1 s poll, batches, publisher confirms (`RABBITMQ_CONFIRM_TIMEOUT_MS`, default 5000),
`RABBITMQ_HEARTBEAT_S`; a broker outage never affects a request (rows wait, `attempts` / `lastError` record the retries); a broker that is
unreachable at boot never gates startup or readiness (File's process test boots against an unreachable broker); shutdown drains the
in-flight batch before the pool closes (Auth test). Signals: `outbox_publish_failure`, `outbox_relay_pass_failure`,
`worker_drain_timeout` (warn logs). Compose and the smoke script pass `RABBITMQ_URL` to Organization, File and Auth.

## 8. Evidence

| Suite | Result |
|---|---|
| `@nawara/audit-contract` unit / integration | 895 / 10 |
| `@nawara/service-kit` unit / integration (unchanged) | 132 / 110 |
| audit-service unit / E2E (ingestion, query, append-only) | 224 / 345 |
| payment-service unit / E2E | 92 / 128 |
| billing-service unit / E2E | 321 / 263 |
| organization-service unit / E2E / db invariants | 140 / 243 / 56 |
| file-service unit / E2E (S3 suites included) | 258 / 314 |
| auth-service unit / E2E / db tests | 119 / 337 / M1–M12 pass |
| notification-service unit (no change) | 311 |
| real pipeline (`test/e2e-audit-producers`: 5 producers + closure) | 13 / 13 |
| Docker build + production smoke (audit, payment, billing, organization, file, auth) | 6 / 6 |
| `check:repo`, lint, typecheck | pass |

**Cross-producer closure (18.7.7):** one action per producer through ONE broker into ONE audit-service; the 18.6 organization read returns
exactly the tenant's evidence (and nothing for another organization), the platform read every producer, and the platform read is itself
recorded. The same event id published by two producers is two records (key = source + id); the same producer re-sending it with different
evidence is dead-lettered and the stored record is untouched.

**Payload sizes:** 194–447 bytes serialized across the 50 actions (largest: `membership.revoked` complete), against the contract's 4 KiB
payload and 1 KiB `changes` bounds.

## 9. Mutation testing

20 required mutations, each applied, run against the suites that must catch it, restored and hash-verified (all 15 target files match
their pre-campaign SHA-256; every dist rebuilt from the restored sources afterwards). **20 / 20 killed.** M3 (Payment's user kind taken
from a header on the attempt-START route) first survived — the G1 tests exercised the sync route only; a start-path test was added
(owner kind, header ignored) and M3 is killed. M10, M14 (a forbidden fact added to `changes`) are killed by the contract refusing the
payload (defended) and observed by the tests as a failed change; M17 (duplicate idempotence removed) is also defended by the unique key.

## 10. Deferred findings

- **Production prerequisite:** the deployed Auth (`apps/auth-service/deploy/provision-and-deploy.sh`) runs without a broker today. It
  now needs `RABBITMQ_URL`; the deploy script refuses early (before migrating or stopping anything) without it. A broker for that host is
  an owner decision.
- **Production prerequisite:** deploy audit-service (with the G1–G5 catalog) before the producers (A50 rollout rule).
- **Test depth (18.9):** `payment_webhook` as the actor of `payment.succeeded` / `.failed` is wired through the shared `applyStatus` path
  but not asserted end to end (no signed webhook fixture in the audit suite).
- **18.8:** retention and DLQ privacy of these events (unchanged here).
- **Stage 21:** the per-producer `CORRELATION` regex and uuid-v5 helper are duplicated (Payment, Billing, File); a kit helper is a
  refactor, deliberately not done here.

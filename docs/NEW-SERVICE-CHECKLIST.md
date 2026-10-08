# New Core service checklist

What to check when adding a service to Nawara Core, during implementation and in review. Each line says what to do and links the
rule; the rule itself lives there. Tags say when a line applies:

- **[REQUIRED]** every service;
- **[IF DATABASE]** it owns data;
- **[IF CALLED BY SERVICES]** other services call it with a service token;
- **[IF MESSAGING]** it publishes or consumes events;
- **[IF AUDITABLE]** it records accountability events;
- **[IF IMAGE/DEPLOYABLE]** it is meant for production.

A recent service to read alongside this list: `apps/release-service` (no Auth-specific legacy). **Do not copy Auth**: its own bootstrap,
error filter, migration runner and configuration loader are an accepted legacy case that A4 converges.

## 1. Before coding

- [REQUIRED] The capability is generic: an unrelated future app could use it as it is. Product-specific logic belongs in the product's
  repository, not in Core ([CLAUDE.md](../CLAUDE.md) "keep services generic"; [ADR-0056](adr/0056-core-architecture-and-api-conventions.md)
  §1). `npm run check:repo` refuses product terms in every service's source and migrations.
- [REQUIRED] It owns its data and talks to other services only over their APIs and events, never their database or source
  ([ADR-0056](adr/0056-core-architecture-and-api-conventions.md) §1–2; enforced by `check:repo`).
- [REQUIRED] Design documents as [`docs/README.md`](README.md) "When to write what" says: an ADD for how the new service fits the
  system, an ADR when it splits a service or introduces a new cross-service decision. Routine work inside accepted conventions needs
  no new ADR.

## 2. Workspace and bootstrap

- [REQUIRED] `apps/<name>-service`, an npm workspace with the usual scripts: `build`, `lint`, `typecheck`, `test`, `test:e2e`,
  `start`, `start:dev`, `start:prod` (copy them from another service's `package.json`).
- [REQUIRED] Start through the kit's `configureApp` ([ADR-0056](adr/0056-core-architecture-and-api-conventions.md) §12;
  [kit README](../libs/service-kit/README.md) "Wiring a service").
- [REQUIRED] Errors through the kit's filter, each with a stable `lower_snake_case` `code`
  ([ADR-0054](adr/0054-localized-error-messages-and-stable-error-codes.md) D3–D4; ADR-0056 §9).

## 3. Configuration

- [REQUIRED] One loader, `src/config/<name>-config.ts`, reading through the kit's `EnvReader`: `NAME` or `NAME_FILE`, trimmed,
  value-free errors; keys and roles through the kit helpers ([A2 record](architecture/core-v2-a2-configuration-and-secrets.md)). Nothing
  else reads `process.env` (`check:repo`).
- [REQUIRED] Production refusals tested in the loader's spec (an unset `NODE_ENV` is production).
- [REQUIRED] Every variable in the README's Configuration table (`check:repo` checks literal names). Secrets and rotation:
  [secret rotation runbook](runbooks/secret-rotation.md).

## 4. HTTP and API

- [REQUIRED] Routes under `/<service>/…`, resources, DTOs, validation, pagination, idempotency, request context and errors as
  [ADR-0056](adr/0056-core-architecture-and-api-conventions.md) §3–9 says for new endpoints. Never rename an existing route.
- [REQUIRED] `GET /health` (liveness) and `GET /ready` (dependencies), from the kit (ADR-0056 §10).
- [REQUIRED] OpenAPI at `/<service>/docs`, mounted only when `SWAGGER_PASSWORD` is set, behind basic authentication (ADR-0056 §10).

## 5. Localization

The convention exists: [ADR-0054](adr/0054-localized-error-messages-and-stable-error-codes.md) and the
[error localization guide](architecture/core-error-localization.md). For a new service:

- [REQUIRED] `src/messages.ts` (`defineMessages`): one entry per error message with `en`, `fr` and `ar` text; `messages.spec.ts`
  checks it with `catalogProblems`; `test/localization.e2e-spec.ts` covers languages, `code`, `Content-Language` and `Vary`.
- [REQUIRED] Only the error `message` is localized. Never `code`, `statusCode`, `error`, machine statuses, property names, enums,
  routes, event or audit names. A code is never derived from text, and a catalog key is never a response field.
- Languages: `en` (default and fallback), `fr`, `ar`; regional tags resolve to their base language (`fr-FR` → `fr`).
- Each new or changed error: the guide's checklist (§12).

## 6. Security and admission

- [IF CALLED BY SERVICES] Service-token admission with a deny-by-default caller policy parsed by the kit's `parseCallerPolicy`
  (ADR-0056 §11; [ADR-0033](adr/0033-service-to-service-authentication-and-user-identity.md),
  [ADR-0042](adr/0042-service-token-scopes-and-administrative-authorization.md),
  [ADR-0052](adr/0052-core-v1-capability-closure.md)), and the module registered in `CALLER_POLICY_MODULES` in
  `scripts/lib/checks.mjs`.
- [IF CALLED BY SERVICES] Negative tests: unknown caller, missing scope, published development token refused in production.

## 7. Persistence

- [IF DATABASE] Its own database with a migrator role and a runtime role
  ([ADR-0032](adr/0032-database-per-service-on-a-shared-server.md)): add it to `infra/postgres/init/01-service-databases.sh`, its two
  passwords to the root `.env.example`, and its services to `docker-compose.yml`.
- [IF DATABASE] Explicit, forward-only migrations in `db/migrations`, applied by `nawara-migrate` (`npm run migrate`), never at start
  ([kit README](../libs/service-kit/README.md) "Migrations").
- [IF DATABASE] Production refuses a superuser, owner or admin runtime role (kit `assertRuntimeDatabaseRole`), with its test.
- [IF DATABASE] End-to-end tests on a scratch database (`createTestDatabase`, gated by `TEST_DATABASE_ADMIN_URL`).

## 8. Messaging

- [IF MESSAGING] The kit's `RabbitMqEventBus`; events written in the transaction of their change through the outbox and its relay
  ([ADR-0037](adr/0037-reliable-events-outbox-inbox.md); [kit README](../libs/service-kit/README.md) "Events" and "Dead letters").
  Production requires a broker; elsewhere the in-memory bus is used.
- [IF MESSAGING] Broker suites gated by `TEST_RABBITMQ_URL`; they delete the queues and exchanges they declare.
- Messaging conventions still being designed (versioning, retry and DLQ policy across services) belong to A3, not to this list.

## 9. Audit

- [IF AUDITABLE] Accountability events through `@nawara/audit-contract`'s `AuditEventWriter`, in the change's transaction, each
  in the reviewed catalog ([ADR-0049](adr/0049-audit-trail-architecture.md);
  [audit contract README](../libs/audit-contract/README.md)). Not every service produces audit events: audit-service is the sink.

## 10. Observability

- [REQUIRED] Logs, request context and metrics come from the kit (metrics on a separate listener, off by default;
  [A12 record](architecture/core-v2-a12-observability.md)).
- [REQUIRED] Local monitoring: a scrape job in `infra/observability/prometheus/prometheus.yml`, and the service in
  `LOCAL_SCRAPE_JOBS` and `CORE_JOBS` in `scripts/lib/checks.mjs` (dashboards).

## 11. Tests

- [REQUIRED] Unit tests, the configuration spec, the localization tests, and whichever of the integration tests above apply.
  What to run and when: [developer guide](DEVELOPMENT.md) §4.
- [REQUIRED] Deterministic by construction: a suite skipped for missing infrastructure never runs its body (use the
  `describeWithEnv` helper of `test/support/env.ts`), and fails in CI when its configuration is missing; tests delete the external
  resources they create; no wall-clock gap is a correctness condition; clients close before a scratch database is dropped. No
  retries as a flake fix ([A15 record](architecture/core-v2-a15-developer-experience.md) §6).

## 12. CI and image

- [REQUIRED] Add the workspace to the `node` matrix of `.github/workflows/core-ci.yml`, with its integration suite (`check:repo`
  refuses a workspace missing from it).
- [REQUIRED] A `Dockerfile` on the pinned `node:22-alpine` base (`check:repo`), the service in the `images` matrix of the same workflow
  (`check:repo`), and its production-shaped configuration in `scripts/smoke-core-image.sh`.
- [IF IMAGE/DEPLOYABLE] Becoming production-bound is separate, owner-authorized work: an immutable image workflow and an exact-digest
  deploy workflow on the existing pattern, registered in `scripts/check-repo.mjs` (`IMAGE_BUILDS`, `DIGEST_DEPLOYMENTS`,
  `CONFIRMED_OPERATIONS`) ([A0 record](architecture/core-v2-a0-immutable-deployments.md),
  [A14 record](architecture/core-v2-a14-supply-chain.md), [digest deployments](runbooks/digest-deployments.md)).

## 13. Documentation

- [REQUIRED] `apps/<name>-service/README.md`: what it owns and never will, its API, its Configuration table, how to run and test it.
- [REQUIRED] The service in [CLAUDE.md](../CLAUDE.md)'s service list and the [roadmap](CORE-ROADMAP.md).

## 14. Before the pull request

- [REQUIRED] The validation ladder of the [developer guide](DEVELOPMENT.md) §4, including `npm run check:repo && npm run test:repo`;
  then Core CI, which is the gate.

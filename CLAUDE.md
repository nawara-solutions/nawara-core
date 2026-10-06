# CLAUDE.md

This file gives Claude (via Claude Code) context on the Nawara Core project. Read this first before making changes.

## Shared AI-Agent Workflow Standard

Branch naming, commit message format, PR conventions, and the ADR/ADD/SDD/TDD design-doc
process are defined once for all Nawara Solutions projects in
[`../ai-standard/README.md`](../ai-standard/README.md). This repo's `/branch`, `/commit`,
`/pr`, `/design-doc` commands and its `design-conformance`/`docs-writer`/`tech-lead` agents are
symlinks into that shared source — editing one of them from here edits it for `nawara-drive` and
`nawara-daycare` too. See `CONTRIBUTING.md` (itself a symlink into `ai-standard/`) for the
full conventions.

## Git Workflow Permissions

- NEVER create a branch, commit, push, or open a PR unless explicitly asked. Ask first, then act.
- Commit subject lines must be <= 100 characters (commitlint enforced).
- Use `/branch`, `/commit`, `/pr` for all version-control work rather than ad-hoc git commands
  — see `CONTRIBUTING.md`.

## Start here: the roadmap

Read [`docs/CORE-ROADMAP.md`](docs/CORE-ROADMAP.md) before any change: it is the authority for the current Core V1 checkpoint,
the planned Core V2 roadmap, the V1/V2 boundary and the Nawara Admin relationship. Core V2 baseline, G6 labels, scope and the V2
validation protocol: [`docs/architecture/core-v2-a-baseline-and-change-safety.md`](docs/architecture/core-v2-a-baseline-and-change-safety.md).

## Production safety: Auth build ≠ deploy

Since V2-A.2, a merge to `main` touching `apps/auth-service/**`, `libs/service-kit/**`, `package.json`, `package-lock.json` or
`.github/workflows/auth-service-docker-build.yml` **builds** a revision-labelled Auth image (`sha-<commit>`, index digest in the run
summary) and **never deploys**; since V2 A0 organization-service and audit-service follow the same model (`<service>-image.yml` builds,
`<service>-deploy.yml` deploys an exact digest; `docs/runbooks/digest-deployments.md`). Production Auth changes only through an explicit, owner-authorized `auth-service-deploy.yml` run that
deploys an exact index digest (`docs/runbooks/auth-service-deploy.md`); `:production` and `:latest` are frozen and deprecated. Never
dispatch a deployment without that authorization. `main` is protected by a repository ruleset (V2-A.3 / A3.3): every change needs a
pull request with a green `core-ci-passed` check on an up-to-date branch; direct pushes, force pushes and deletion are blocked. Never
edit, disable or bypass the ruleset without explicit owner authorization. Every production SSH workflow (deploys, broker provisioning,
credential rotation, backup) is dispatch-only and waits for approval of the protected `production` environment (V2-A.3 / A3.5); never
approve or dispatch one without owner authorization, and never add a production SSH job without that environment. G6 is deferred; G7, F6 and F7 are
locked; Final Core Validation is the absolute last full validation and is never run as part of another task.

## What this project is

**Nawara Core** is the shared microservices repo for **Nawara Solutions**, an organization building multiple apps (starting with **Nawara Drive**, a driving-school platform). This repo holds services generic enough to be reused by *any* future Nawara Solutions app — not just Nawara Drive.

## Hard rule: keep services generic

Nothing in this repo should reference Nawara Drive-specific concepts (students, instructors, driving lessons, exams, etc.). If a piece of logic only makes sense for the driving-school domain, it belongs in the `nawara-drive` repo instead, not here. When in doubt, ask: "would an unrelated future app (e.g. a delivery app, a booking app) find this useful as-is?" If not, it doesn't belong in Core.

## Services in this repo

1. **auth-service** (NestJS/TypeScript) — registration, login, JWT + refresh tokens, role-based access control. Generic `User` concept only — no app-specific roles baked in beyond a generic `role: string`.
2. **notification-service** (NestJS/TypeScript) — dispatches notifications based on generic events (`{userId, channel, template, data}`). No knowledge of what triggered the notification. Implemented and certified for email (Resend) and SMS (Twilio); push (FCM) is not built. Not in production.
3. **payment-service** (NestJS/TypeScript) — payment processing only: how money was paid and the payment state (payments, attempts, cash workflow, refunds, webhooks). Gateway adapters (Flouci, Konnect, Paymee, Stripe) live behind a common interface so adding a gateway doesn't touch business logic. It is not the billing or accounting system (see below). Implemented (attempts, webhooks, outbox, reconciliation) with only the `test` provider; no real gateway adapter exists yet. Design: `docs/architecture/financial-architecture.md`. Not in production.

**AI is not a Core service** (ADR-0055): the AI runtime (providers, models, prompts, inference and its deployment) belongs to the separate future `nawara-ia` repository. Core removed its `ai-service` scaffold; an AI integration uses Core's platform contracts (identity, authorization, scope, correlation, audit), each designed when a real requirement exists.

**`organization-service`** (NestJS/TypeScript) — Company, Platform, Organization. **Implemented (ADR-0039 Stage 9; ownership and service-authorization mechanisms in Stage 10.1) but NOT yet authoritative:** auth-service still owns these entities, and authority is activated only by an explicit, gated operation that has not been performed anywhere (see `apps/organization-service/README.md` and `docs/architecture/stage-10/stage-10-1-implementation.md`). Service-token API with an explicit per-caller policy; never owns users or membership.

**`release-service`** (NestJS/TypeScript) — release metadata and client compatibility for any Nawara product (ADR-0051): Product, Component (`backend | web | desktop | mobile_ios | mobile_android`), immutable Release (`registered → published → withdrawn`), append-only CompatibilityPolicy. Never delivery: not CI/CD, a deployment engine, an artifact store, a signer, authorization, entitlement or analytics. **Stage 20.3: CI automation only** on the Stage 20.2 domain: a service token plus a per-product `RELEASE_SERVICE_POLICY` (`release.register`, `release.publish`) registers and publishes releases, idempotently, with audit intent in the same transaction. **Stage 20.4:** the owner of the configured operating Company (own Auth bearer, verified live, plus a factor step-up consumed through Auth) withdraws releases and changes minimum versions; no operator route. **Stage 20.5:** a public, read-only compatibility decision (`update` = required / available / none) for web, desktop, iOS and Android clients: no identity, rate-limited, short-lived cache with an ETag; it never updates, reloads or deploys anything.

**`billing-service`** (NestJS/TypeScript) — what is owed: products, prices, invoices, payment requests, and the organization-scoped Subscription and its derived Entitlement (ADR-0044). Implemented; service-token API only; not in production.

**`file-service`** (NestJS/TypeScript) — file metadata, ownership, access control and lifecycle behind a storage port (ADR-0048). Implemented and certified; storage provider still open (O2); not in production.

**`audit-service`** (NestJS/TypeScript) — append-only accountability records ingested from Core producers over RabbitMQ (ADR-0049). Implemented, certified and in production (the Auth → Audit relay).

**Later services (FUTURE / IDEA / REQUIRES SEPARATE SCOPE DECISION; not committed V2 scope; see `docs/architecture/core-architecture.md` and `docs/architecture/financial-architecture.md`):** `accounting-service` (double-entry ledger, tax), `location-service`, `search-service`, `analytics-service`. Do **not** create user, membership, role, permission, invoice, cash, tax, ledger, wallet or subscription services.

## Architecture principles

- **Database-per-service.** No service queries another's database directly. Cross-service data needs go through that service's API or async events.
- **API is the only contract.** Consuming apps (Nawara Drive, future apps) never import this repo's code — they call these services' REST/gRPC APIs over the network, exactly as an external client would.
- **Async events for side effects.** Use RabbitMQ for things like "payment completed → notify user" rather than direct synchronous calls between services where avoidable.
- **Independent deployability.** Changes to one service should never require redeploying another.

## Tech conventions

- TypeScript services: NestJS, following Nest's module/controller/service/DTO structure.
- Every service exposes interactive API docs via OpenAPI, mounted at `GET /docs`. For NestJS
  services, this is `@nestjs/swagger` (`DocumentBuilder` + `SwaggerModule.setup('docs', ...)` in
  `main.ts`) — every controller method gets `@ApiOperation`/`@ApiResponse`, every DTO field gets
  `@ApiProperty`.
- `libs/service-kit` holds **technical infrastructure only** shared by Core services (configuration, logging, request ids, errors, health, service authentication, database and migrations, outbox/inbox). It must never contain business logic; `npm run check:repo` enforces part of this.
- `libs/audit-contract` holds the shared audit event contract and catalog used by Core producers and audit-service. There is no `libs/shared-types`. Services in this repo can import libs; external apps (Nawara Drive) only talk over HTTP, never via these libs directly.
- Services consume `libs/service-kit` and `libs/audit-contract` through their built `dist/`: after changing either, build the libraries before running dependent tests. Stale `dist/` is never valid evidence.
- Each service has its own `docker-compose` entry and its own database/migrations.

## Consumers

- **nawara-drive** (`/home/anwar/Desktop/nawara-solutions/nawara-drive`) — the
  driving-school app (admin dashboard, mobile app, and app-specific services like
  exam/booking/content). Consumes this repo's services via API only.
- **daycare** (`/home/anwar/Desktop/nawara-solutions/daycare`) — the daycare management
  platform. It currently has its own local `auth`/`notification`/`license` services
  (kept domain-agnostic on purpose); `nawara-core` is their eventual shared-service
  destination, not a current dependency.

Both are separate git repos. This repo doesn't need to read either app's code — only
track their *contract* needs (what endpoints/events they'd call) when that comes up.

## When helping in this repo

- Default to NestJS patterns for the TS services unless told otherwise.
- Flag it if a requested change would leak Nawara Drive-specific logic into a Core service — that's the one thing this repo needs to stay disciplined about.
- Prefer adding a new generic capability over special-casing one app's needs.

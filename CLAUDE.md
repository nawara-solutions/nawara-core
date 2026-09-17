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

## What this project is

**Nawara Core** is the shared microservices repo for **Nawara Solutions**, an organization building multiple apps (starting with **Nawara Drive**, a driving-school platform). This repo holds services generic enough to be reused by *any* future Nawara Solutions app — not just Nawara Drive.

## Hard rule: keep services generic

Nothing in this repo should reference Nawara Drive-specific concepts (students, instructors, driving lessons, exams, etc.). If a piece of logic only makes sense for the driving-school domain, it belongs in the `nawara-drive` repo instead, not here. When in doubt, ask: "would an unrelated future app (e.g. a delivery app, a booking app) find this useful as-is?" If not, it doesn't belong in Core.

## Services in this repo

1. **auth-service** (NestJS/TypeScript) — registration, login, JWT + refresh tokens, role-based access control. Generic `User` concept only — no app-specific roles baked in beyond a generic `role: string`.
2. **notification-service** (NestJS/TypeScript) — dispatches push (FCM), SMS, and email based on generic events (`{userId, channel, template, data}`). No knowledge of what triggered the notification.
3. **payment-service** (NestJS/TypeScript) — gateway-agnostic billing engine. Supports arbitrary "products" (subscriptions, one-time charges, licenses) via a generic `Product`/`Charge` model, not hardcoded to Nawara Drive's school-license/student-subscription split. Gateway adapters (Flouci, Konnect, Paymee, Stripe) live behind a common interface so adding a gateway doesn't touch business logic.
4. **ai-service** (Python/FastAPI) — generic LLM-backed chat/Q&A/content-generation service. Each calling app supplies its own prompt config and knowledge base reference; this service has no built-in domain knowledge.

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
  `@ApiProperty`. FastAPI's `ai-service` gets this for free at the same path with no extra setup.
- Python service: FastAPI, typed with Pydantic models.
- Shared code that's safe to publish to consuming apps (DTOs, types) goes in `libs/shared-types` — but remember, consuming *services in this repo* can import libs; external apps (Nawara Drive) still only talk over HTTP, never via these libs directly.
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

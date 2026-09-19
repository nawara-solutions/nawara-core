# 0034. A small shared service-kit library, and one set of API conventions

- **Status:** Proposed
- **Date:** 2026-09-19
- **Deciders:** Anwar (project owner)

> Auth-service is **not** migrated onto the kit; it keeps its own implementations. The kit copies proven patterns from
> it (fail-closed configuration, health, event publisher, plain-SQL migrations) without importing Auth code.

## Context

Six new services need the same baseline: configuration validation, logging, request and correlation ids, error format,
health and readiness, security headers, a service-token guard, database access and migrations. Inventing these six
times invites drift; sharing too much couples deployments and creates a hidden monolith.

## Options considered

1. **A small `libs/service-kit` workspace package used by the new services.** Chosen.
2. *Copy the foundation into each service.* Rejected: six copies to keep consistent.
3. *One large shared library of business helpers.* Rejected: it would become a monolith by another name.

## Decision

- `libs/service-kit` (npm workspace `libs/*`) contains **infrastructure only, no domain code and no vendor SDK**:
  config helpers, request/correlation-id middleware, JSON logger with redaction, error filter, health/readiness with a
  dependency-check registry, graceful shutdown, `helmet` and size limits, baseline rate limit, the service-token guard,
  an Auth client port, pagination helpers, a `pg` database module and a plain-SQL migration runner.
- **API conventions** for every Core service:
  - Public prefix is the singular domain noun (`/organization`, `/file`, `/audit`, `/location`, `/search`,
    `/analytics`), matching `/auth` and `/payment`.
  - No version segment in v1; only additive changes; a breaking change is published as `/v2/<prefix>`.
  - Errors: Nest's default `{ statusCode, message, error }` plus `requestId`; validation failures are 400.
  - Lists: `?limit=&cursor=` returning `{ items, nextCursor }`, allow-listed `sort` and filters.
  - `Idempotency-Key` on resource-creating `POST`s.
  - `X-Request-Id` and `X-Correlation-Id` are accepted, generated when absent, logged, returned and propagated.
  - `GET /health` (alive) and `GET /ready` (dependencies) at the root; OpenAPI at `GET /docs`.
- Kit changes are reviewed as breaking for all dependents; a service pins nothing beyond the workspace version.

## Consequences

- Consistency without artificial per-service layers; a fix lands once.
- Every kit change can affect six services: it needs its own tests and a conservative change policy.
- Two implementations of the same patterns (Auth's and the kit's) exist until Auth is deliberately migrated, if ever.
- Follow-ups when accepted: add `libs/*` to the root `package.json` workspaces (today only `apps/*`); update
  `CLAUDE.md` (its services list names four services and its shared-library line mentions `libs/shared-types`).

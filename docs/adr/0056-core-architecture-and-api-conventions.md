# 0056. Core architecture and API conventions

- **Status:** Accepted (2026-10-07, by the architecture owner, Core V2 A1.2 architecture-owner review; explicit approval under OD-A1-1). Supersedes [ADR-0034](./0034-shared-service-kit-and-api-conventions.md)
- **Date:** 2026-10-07
- **Deciders:** Anwar (project owner, architecture owner)

> **Supersedes [ADR-0034](./0034-shared-service-kit-and-api-conventions.md)** as the single current source of Core architecture and
> API conventions (owner decision OD-A1-2, [A1 record](../architecture/core-v2-a1-architecture.md) §2; formal since this ADR's
> acceptance on 2026-10-07). With the acceptance the owner also confirmed two points stated below: OpenAPI is at `/<service>/docs` only
> when enabled and protected (§10), and rejecting unknown query parameters is the rule for new endpoints only, not a migration of
> existing ones (§4). This ADR **consolidates** decisions
> that exist (ADR-0034 as amended by [ADR-0054](./0054-localized-error-messages-and-stable-error-codes.md), the A12 observability
> record, the A1.1 owner decisions) and the conventions the code already follows. It invents no new platform and changes no code.

## Context

Core's conventions are spread over ADR-0034 (Proposed, partly amended), ADR-0054 (errors), the service-kit and per-service practice.
A1.0 discovery ([A1 record](../architecture/core-v2-a1-architecture.md) §1) found the practice largely consistent but undocumented in
one place: DTO rules, D10 for new code, the dependency rules and the 503 convention were written nowhere, and A15 (templates) and A16
(product integration) need one source. A1.1 decided to write that source as one ADR (OD-A1-2).

## Decision

Every rule below is labelled:

- **[CURRENT]**: normative and implemented today;
- **[COMPAT]**: existing stable behaviour deliberately kept, an exception to a [CURRENT] rule;
- **[TARGET]**: an agreed convergence that is **not** implemented yet, with the stage that implements it;
- **[DEFERRED]**: owned by another stage; recorded here only to mark the boundary.

New endpoints and new code follow the [CURRENT] rules. Existing V1 contracts are not changed by this ADR.

### 1. Service boundaries and data ownership

- **[CURRENT]** Each Core service owns its domain: Auth (identity, sessions, factors, grants), Organization (Company, Platform,
  Organization), Audit (accountability records), Release (releases, client compatibility), File (file metadata, access, lifecycle),
  Payment (how money moved), Billing (what is owed, Subscription / Entitlement), Notification (delivery). Domain and business logic
  stays inside its owning service.
- **[CURRENT]** Database per service: each service owns its schema, migrations and database user; no service reads or writes another
  service's database. Cross-service data goes through the owning service's API or its events. (The physical layout, one shared
  PostgreSQL server, is [ADR-0032](./0032-database-per-service-on-a-shared-server.md).)
- **[CURRENT]** Shared libraries hold generic infrastructure and shared platform contracts only: configuration, logging, request
  context, errors, health, metrics, service authentication and caller admission, database access and migrations, events, outbox and
  inbox (`libs/service-kit`), and the audit event contract (`libs/audit-contract`). They never own a service's business domain.
- **[DEFERRED: A5 / F6 / F7]** Auth still owns the Company / Platform / Organization hierarchy; Organization is implemented but not
  authoritative. The transfer of authority is not decided or described here.

### 2. Dependency direction

- **[CURRENT] Source dependencies.** Applications depend on `@nawara/service-kit` and `@nawara/audit-contract`. Forbidden: a library
  importing an application; one application importing another application's source; product business logic in a Core library.
  `audit-contract` may mirror kit types (it keeps the kit's event grammar, guarded by a test) and has no runtime dependency on the kit.
  A1.0 found no violation and no source-dependency cycle.
- **[CURRENT] Runtime integration** between services is allowed and is not a source dependency: synchronous HTTP with service
  authentication ([ADR-0033](./0033-service-to-service-authentication-and-user-identity.md), [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md))
  and asynchronous events ([ADR-0037](./0037-reliable-events-outbox-inbox.md)).
- **[COMPAT]** The two-way Auth ↔ Organization runtime dependency is the intentional pre-F6 transition state ([DEFERRED: A5 / F6 / F7]).

### 3. Request and response data

- **[CURRENT]** JSON field names are camelCase.
- **[CURRENT]** Identifiers are UUID strings where the domain uses a UUID identity (generated server-side, `randomUUID()`).
- **[CURRENT]** Timestamps are ISO-8601 strings (UTC, `toISOString()`).
- **[CURRENT]** Enum-like values are stable string values (string unions in code); no numeric codes.
- **[CURRENT]** Request and response shapes are explicit per endpoint and documented in the service's OpenAPI.
- **[CURRENT] Optional vs null.** *Optional* in a request means the caller may omit the property where that endpoint's contract allows
  it. *Null* in a response is the explicit representation of absence for a field the response contract defines: such fields are
  present with `null`, not omitted. Missing, `undefined` and `null` are not interchangeable. There is no universal rule for `null` in
  requests: each endpoint's contract states whether `null` is accepted (for example to clear a value).
- **[COMPAT]** Historical endpoints keep their stable shapes even where they differ from these rules; a change to them is breaking (§5).

### 4. Validation

- **[CURRENT] Contract:** JSON request bodies of DTO endpoints reject unknown fields, enforce types and bounds, and fail with 400 and a
  localized error ([ADR-0054](./0054-localized-error-messages-and-stable-error-codes.md)). Client-supplied ids are accepted only if they
  match their safe pattern.
- **[CURRENT] Mechanism is free:** the kit's `LocalizedValidationPipe` (`class-validator`, whitelist and forbid-non-whitelisted) or a
  service's own strict parser. The architecture requires the contract, not a library.
- **[COMPAT]** Unknown **query** parameters: Audit, Organization and Release reject them (400); Billing's invoice list validates the
  filters it knows and ignores other keys; Notification and Payment have no query-parameter endpoints. Existing endpoints keep their
  behaviour. **New** list and search endpoints reject unknown query parameters (this rule is not retroactive).
- **[COMPAT]** Provider webhooks (`/payment/webhooks/…`) accept the provider's raw body, authenticated by its signature only; they are
  not DTO endpoints.

### 5. Routes, compatibility and versioning

- **[CURRENT] Route shape:** `/<service>/<plural resources>`, where `<service>` is the singular service noun (`/auth`, `/organization`,
  `/billing`, `/payment`, `/file`, `/audit`, `/release`, `/notification`). Collections `/<service>/<things>`; members `…/<things>/:id`;
  nested resources only where the parent scopes the child (`/payment/payments/:paymentId/attempts`).
- **[CURRENT] Actions:** where a state transition is not a natural resource representation, `POST …/<things>/:id/<verb>` (for example
  `archive`, `issue`, `cancel`, `publish`, `withdraw`, `revoke`, `approve`). Not a licence for arbitrary verb URLs: prefer resources.
- **[CURRENT] Human administration:** `/<service>/admin/…` (or an owner-scoped segment such as `/audit/owner/…`), authorized per request
  by the owning service ([ADR-0041](./0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md),
  [ADR-0050](./0050-platform-administration-and-verified-human-authority.md)). Service-facing routes share the same prefixes and are
  separated by service authentication and caller policy, not by a path segment.
- **[COMPAT] Capability URL:** `/file/t/:token` is a short-lived capability URL: the token is the authorization, so the path is opaque
  and deliberately not resource-shaped. This exception is specific to capability URLs.
- **[COMPAT] Existing names stay:** every existing V1 route is stable, including `/notification/notifications`, File's routes, Auth's
  verb-style authentication routes under `/auth/…` (login, verification, enrolment, recovery, step-up) and Auth's root `GET /`; new
  routes follow the convention.
- **[CURRENT] Exempt from the prefix:** the kit's probes `GET /health` and `GET /ready` are unprefixed (§10).
- **[CURRENT] Versioning:** no version segment exists or is used. Only additive changes are made to an existing route; a breaking change
  is introduced as `/v2/<prefix>`, with a migration plan and a V2 design, never by changing an existing route in place. Events carry a
  `version` header; event versioning belongs to A3.

### 6. Lists and pagination

- **[CURRENT]** Paginated lists take `?limit=<n>&cursor=<opaque>` and answer `{ "items": [...], "nextCursor": "<opaque>" | null }`;
  `nextCursor` is `null` when there is no next page; `limit` is bounded per endpoint (verified in Audit, Billing and Organization:
  `nextCursor: string | null`). Cursors are opaque to clients. Sorting and filtering are allow-listed per endpoint.
- **[CURRENT]** No shared pagination helper is required; each service implements the contract. Tooling may be reconsidered by A15.

### 7. Idempotency

- **[CURRENT]** Naturally idempotent operations (reads, deletes of a named resource) need no key.
- **[CURRENT]** Where a creating or state-changing request must not take effect twice and has no natural business key, the endpoint
  requires an `Idempotency-Key` header: missing → `idempotency_key_required`; the same key with a different request →
  `idempotency_key_reused`; replaying the same request returns the already-created result instead of acting again. Today the header
  is required on File's upload (`POST /file/files`), Notification's send, Organization's creates and admin writes, and Payment's
  cancel and attempt endpoints.
- **[CURRENT]** Where the business defines its own deduplication, that mechanism is the idempotency contract instead of a header:
  Payment's create (by `paymentRequestId`), Billing's creates (natural keys; `Idempotent-Replayed` on a replay), Release's register (by
  version), provider webhooks (by provider event id) and consumers (by event id in an inbox). Not every creating endpoint is
  idempotent (for example `POST /file/uploads/tickets`); its contract says so.

### 8. Request and correlation context

- **[CURRENT]** `X-Request-Id` (one request) and `X-Correlation-Id` (one business operation across services and events) are accepted
  when they match the safe id pattern, generated otherwise, echoed on the response, attached to every log line, and returned as
  `requestId` in error bodies (the kit's request-context middleware).
- **[CURRENT]** Outbound service calls through the kit clients forward them; events carry the correlation id in their headers (outbox,
  event bus).
- **[DEFERRED: A12]** Distributed tracing (W3C trace context) is not adopted (A12 decision D8).

### 9. Errors

- **[CURRENT]** [ADR-0054](./0054-localized-error-messages-and-stable-error-codes.md) is authoritative: the body is `{ statusCode,
  message, error, code?, requestId? }`. `code` is the stable machine contract, present whenever the thrower supplies one and mandatory
  for new errors (ADR-0054); `requestId` is present when a request context exists; `message` is localized (EN / FR / AR, English
  byte-compatible). This ADR introduces no other envelope.
- **[COMPAT]** Existing code-less errors stay code-less (ADR-0054); error-code naming debt and any global registry are a later V2 item.
- **[CURRENT] Upstream unavailable** (OD-A1-6): an unavailable upstream that a request depends on answers **HTTP 503** with a stable
  `*_unavailable` code (for example `hierarchy_unavailable`). There is **no** retryable field; a 503 is not a promise that a retry is
  safe. A retryability contract is added only if A3, A16 or a real consumer demonstrates the need.
- **[CURRENT] D10 for new code** (OD-A1-5): an error message never echoes a client-derived value except a **request property name**.
- **[COMPAT]** The three documented English-only messages that echo another client-derived value (Organization's unknown query
  parameter, Payment's currency and provider id, Billing's snapshot key paths) stay as they are
  ([error-localization guide](../architecture/core-error-localization.md) §8).

### 10. Probes, documentation and metrics

- **[CURRENT]** `GET /health` is liveness: it reports the process is up, checks no dependency and keeps answering while the service
  drains. `GET /ready` runs the named dependency checks and answers 503 when one fails or while draining. They are not interchangeable.
- **[COMPAT]** Auth also keeps `GET /auth/health` (decision D5): a public, database-checking readiness-style probe kept for the
  deployment tooling, not a liveness probe.
- **[CURRENT]** OpenAPI is served at `GET /<service>/docs` (with its JSON document) by every Core service, mounted only when
  `SWAGGER_PASSWORD` is configured and then behind basic authentication; without it the documentation is not mounted.
- **[CURRENT]** Metrics are served only by the separate metrics listener (`METRICS_PORT`), never by the application listener, and are off
  by default ([A12 record](../architecture/core-v2-a12-observability.md), decision D1a).

### 11. Service identity and caller admission

- **[CURRENT]** Services authenticate to each other and identify the end user as decided in ADR-0033 and ADR-0042; each service admits a
  caller only through an explicit, deny-by-default caller policy (decided in ADR-0042; its shared kit mechanism and adoption in
  [ADR-0052](./0052-core-v1-capability-closure.md)).
- **[TARGET: A1.3]** Organization, Notification, File, Audit and Release move from their own policy parsers to the kit's
  `parseCallerPolicy` (OD-A1-3): uniform fail-closed parsing and duplicate-key detection, with no change to environment-variable names,
  caller identities, scopes or authorization semantics.
- **[DEFERRED: A6]** Authorization semantics (what an admitted caller may do, ownership-aware checks).

### 12. Bootstrap

- **[CURRENT]** Every Core service except Auth starts through the kit's standard bootstrap (`configureApp`: request context, metrics,
  security headers, bounded JSON body, localized validation, the uniform error filter, shutdown admission). Auth assembles the same kit
  parts explicitly in its `main.ts`.
- **[TARGET: A4]** Auth's explicit bootstrap and its own configuration loader converge on the kit's where compatible (OD-A1-4). Kept:
  `/auth/health` (D5), its localized validation and its `AuthExceptionFilter` contract. Not implemented in A1.

### 13. Consumers: products and AI workloads

- **[CURRENT]** Core exposes generic platform contracts (identity, organization context, authorization, files, notifications, billing
  and payment, audit, release compatibility). Product business contracts (Admin, Drive, School, a future ERP) stay in the products'
  repositories; Core holds no product-specific domain rule ([ADR-0041](./0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md)).
- **[CURRENT]** The AI runtime is not a Core service ([ADR-0055](./0055-ai-service-repository-boundary.md)). A future `nawara-ia`
  workload integrates like any other caller: its own service identity and its own caller-policy entry. Core defines no AI-specific
  protocol or abstraction.
- **[CURRENT]** Authentication is not entitlement: authenticating never depends on a license or subscription
  ([ADR-0026](./0026-authentication-is-not-entitlement.md), implemented; its acceptance is pending).
- **[DEFERRED: A16]** Product integration contracts and the opening of product callers.

## Options considered

1. **Accept ADR-0034 as amended and add a small gap ADR**: two partial sources, one of them stale on errors and silent on DTOs and D10.
2. **One consolidated ADR (chosen, OD-A1-2)**: one current source, each rule marked by whether it is implemented, a compatibility
   exception, a target or another stage's.

## Consequences

- New endpoints, new services and A15 templates follow the [CURRENT] rules; reviews cite this ADR.
- Existing stable contracts are unaffected; [COMPAT] items stay until a deliberate, versioned V2 change.
- [TARGET] items are implemented by their stages (A1.3, A4) and verified there; this ADR does not claim them.
- A1.4 may enforce the source-dependency rules and the route prefix in `check:repo`.
- ADR-0034 is marked `Superseded by ADR-0056` (done on this ADR's acceptance, 2026-10-07).

## Relationship to other ADRs

| ADR | Relationship |
|---|---|
| [0032](./0032-database-per-service-on-a-shared-server.md) database per service | **incorporates** its convention (§1); 0032 stays the source for the physical layout |
| [0033](./0033-service-to-service-authentication-and-user-identity.md) service authentication | **references** (§2, §11) |
| [0034](./0034-shared-service-kit-and-api-conventions.md) kit and API conventions | **supersedes** (formal on acceptance, 2026-10-07) |
| [0037](./0037-reliable-events-outbox-inbox.md) outbox and inbox | **references** (§2, §7, §8); event conventions stay with A3 |
| [0041](./0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md) domain-owned admin APIs | **references** (§5, §13) |
| [0042](./0042-service-token-scopes-and-administrative-authorization.md) service-token scopes | **references** (§2, §11) |
| [0050](./0050-platform-administration-and-verified-human-authority.md) verified human authority | **references** (§5) |
| [0052](./0052-core-v1-capability-closure.md) shared caller policy | **references** (§11); the A1.3 target completes its adoption |
| [0054](./0054-localized-error-messages-and-stable-error-codes.md) errors | **references**; authoritative for the envelope (§9) |
| [0055](./0055-ai-service-repository-boundary.md) AI boundary | **references** (§13) |

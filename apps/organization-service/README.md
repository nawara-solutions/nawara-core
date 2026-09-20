# organization-service

> **Status: implemented, but NOT yet authoritative.** This service exists and is independently testable. The **ownership
> migration from auth-service has not occurred**: auth-service is still the sole authority for `Company`, `Platform` and
> `Organization` and its tables, endpoints and behaviour are unchanged. Nothing reads from, or writes to, this service in any
> Core flow today. Making it authoritative is the later stage defined by
> [ADR-0039](../../docs/adr/0039-organization-ownership-and-cross-service-migration-authority.md) (bootstrap/import, verification,
> write freeze, cutover) and is **not** done here.

The intended owner of the organizational hierarchy ([ADR-0031](../../docs/adr/0031-organization-service-intended-owner-of-the-hierarchy.md)):

```
Company 1 → N Platform 1 → N Organization
```

Design: [SDD](../../docs/sdd/organization-service.md). Built on `@nawara/service-kit` like billing-service and payment-service.

## What it owns, and what it never will

| Owns | Never owns |
|---|---|
| `Company` (`id`, `name`) | `User`, credentials, sessions, MFA, recovery (auth-service) |
| `Platform` (`id`, `companyId`, `name`, optional `key`) | `OrganizationMembership`: the user ↔ organization link (auth-service, ADR-0030) |
| `Organization` (`id`, `platformId`, `name`, `taxCode`, `address`, `phone`, `type`) | billing, payment, accounting, products, prices, invoices, entitlements |

`Organization` reaches its company **only through its platform**; there is no `Organization → Company` link anywhere (table,
API or response). `Organization.type` is a generic, opaque string this service never interprets (ADR-0020).

## API

Public prefix `/organization` (ADR-0034). OpenAPI at `GET /organization/docs`, behind basic auth, mounted only when
`SWAGGER_PASSWORD` (16+ characters) is set. `GET /health` (alive) and `GET /ready` (database + migrations) at the root.

| | Companies | Platforms | Organizations |
|---|---|---|---|
| create | `POST /organization/companies` | `POST /organization/platforms` | `POST /organization/organizations` |
| read | `GET …/companies/:id` | `GET …/platforms/:id` | `GET …/organizations/:id` |
| list | `GET …/companies` | `GET …/platforms?companyId=` | `GET …/organizations?platformId=` |
| update | `PATCH …/companies/:id` (name) | `PATCH …/platforms/:id` (name) | `PATCH …/organizations/:id` (name, taxCode, address, phone, type) |

* **`Platform.key`** is auth-service's optional public slug (`^[a-z][a-z0-9-]{1,39}$`, unique when present). It is **returned** by the
  platform routes, as Auth returns it, but **no request can set or change it** (create and update refuse it): Auth has no route that
  writes it either, so no writer is invented here. The database accepts it, which is what lets an existing value be carried over later.
* **No delete, no archive, no status.** No existing decision establishes them (ADR-0039 lists lifecycle semantics as deferred), so
  none exists: there are no `DELETE` routes, and every foreign key is `ON DELETE RESTRICT`.
* **Parents are immutable.** `Platform.companyId` and `Organization.platformId` cannot be changed: refused with a 400 in the API
  and by a database trigger underneath. `id` and `createdAt` are frozen by trigger too.
* **A parent must exist.** Creating a platform under an unknown company is `404 company_not_found`; an organization under an
  unknown platform is `404 platform_not_found`. The database foreign key is the authority (no racy pre-check).
* **The service generates ids** (random UUIDs) and timestamps. A request carrying `id`, `createdAt`, `updatedAt` or any unknown
  field is a 400. The database, however, accepts an explicit id and original timestamps (see "Migration readiness").
* **Creates require `Idempotency-Key`** (ADR-0034): these entities have no natural key, and names are deliberately not unique.
  An identical replay returns the same resource (`200` + `Idempotent-Replayed: true`); the same key with a different body is `422`.
  A create that fails does not consume its key.
* **Lists** are `?limit=&cursor=` (`limit` 1 to 100, default 20), newest first, returning `{ items, nextCursor }`; unknown or
  repeated parameters are `400 invalid_query`. Cursors keep microsecond precision so imported rows never skip a page boundary.
* Errors are the kit's `{ statusCode, message, error, requestId }` plus a stable `code`.

## Authorization: service tokens only (ADR-0033)

Every route is `@UseGuards(ServiceTokenGuard)`, deny by default. A caller presents `Authorization: Bearer <service token>`; the
service stores only SHA-256 digests (`SERVICE_TOKENS=<caller>:<digest>`, at most two per caller for rotation) and compares in
constant time. Anything else is one generic `401`.

* **A user's bearer is never accepted**, and there is no Auth client, no Auth URL and no outbound HTTP call anywhere in the service.
  So this service cannot be reached by, and cannot become a dependency of, login/refresh/`/auth/me`.
* **Human (owner/operator) access is deliberately not implemented.** Who may create a company, and how an operator's platform
  assignment applies to these entities, is not decided (auth security review F23; ADR-0020's routes were never built), and the
  live platform-access check lives in auth-service against *its* copy of the hierarchy. The safe boundary is service-only.
* **Service scopes are not invented.** Which service may create or change which records is open (B-029 / O-13 / O-14, ADR-0039), so
  every registered caller currently has the same access. Register only callers that should have it. The calling service is
  written to the log on every change (`company_created id=… caller=…`).
* `userId`, `role`, `permissions`, `organizationId`, `platformId`, `companyId` sent by a client are never authorization data:
  extra fields are refused, identity-looking headers are ignored.

## Database

Own database `organization` (ADR-0032), two roles from `infra/postgres/init`: `organization_migrator` (owns the schema, used only
by the explicit migration step) and `organization_app` (DML only, used by the service; production refuses a superuser or
`*_migrator` login). No query, foreign key, extension or shared table touches auth-service, billing-service or payment-service.

Migrations (plain SQL, kit runner, **never at startup**; `/ready` fails while any is pending):

```bash
MIGRATION_DATABASE_URL=postgres://organization_migrator:…@host:5432/organization npm run migrate -w organization-service
```

| File | |
|---|---|
| `kit_0001…0003` | the kit's outbox/inbox, rate-limit and generic trigger functions (applied first; outbox/inbox are unused here: no events) |
| `0001_company_platform_organization.sql` | the three tables, keys, `NOT NULL`/non-blank checks, indexes, immutability triggers |
| `0002_idempotency_key.sql` | header-based idempotency for the three creates |
| `0003_platform_key.sql` | `platform.key`, reproduced from auth-service migration 0004 (nullable `text`, format check, `UNIQUE`); additive, keeps existing rows |

## Migration readiness (nothing is migrated)

Stage 10 will import auth-service's existing hierarchy **with the same ids**. This service is built so that is *possible*, and does
not do it: `id` is `uuid PRIMARY KEY DEFAULT gen_random_uuid()` (an explicit id is accepted; nothing overrides it), `createdAt` and
`updatedAt` are ordinary defaulted columns (original timestamps can be kept), and the schema has no rule an existing Auth row could
violate (names are not unique; the value checks equal Auth's, and `platform.key` is carried with Auth's own format check and
unique constraint, added in 0003 after the first version of this service omitted it). `db/tests/invariants.sql` and `test/migrations.e2e-spec.ts` prove
an imported chain is representable and then served and edited through the normal API. **There is no importer, verifier, freeze,
authority record or ownership-rollback tooling here**; the public API never accepts a client-chosen id.

## Running it

```bash
cp .env.example .env                                   # (repo root) dev passwords for the per-service databases
docker compose --profile db up -d --wait postgres
docker compose --profile db run --rm organization-service npm run migrate
docker compose --profile db up -d organization-service
```

* `infra/postgres/init` only runs on an **empty** volume: an existing local Postgres volume has no `organization` database. Recreate
  the volume (`docker compose down -v`) or create the database and both roles by hand as that script does.
* Compose leaves `SERVICE_TOKENS` empty (every call refused) because no caller is registered. To try it, generate a pair with
  `generateServiceToken()` from `@nawara/service-kit`, give the caller the token and set `ORGANIZATION_SERVICE_TOKENS=<caller>:<digest>`.

## Tests

```bash
npm run build -w @nawara/service-kit                    # the service consumes the kit's built output
npm test -w organization-service                        # unit: config, input validation, pagination, OpenAPI, static boundary
TEST_DATABASE_ADMIN_URL=postgres://postgres:pw@127.0.0.1:5432/postgres npm run test:e2e -w organization-service   # real PostgreSQL
PGHOST=127.0.0.1 PGUSER=postgres PGPASSWORD=pw npm run test:db -w organization-service                            # psql invariants
npm run lint -w organization-service && npm run typecheck -w organization-service && npm run build -w organization-service
```

Locally a missing PostgreSQL skips the e2e suites with a notice; with `CI=true` it is a failure. The e2e suites cover the three
entities (create/read/list/update, invalid and conflicting data, idempotency, pagination), security (deny-by-default over every
route, user-token refusal, tampering, attribution), health/readiness/graceful shutdown, migrations/integrity/import
representability, and the runtime-role privileges.

## Deferred (not decided here; do not infer)

Ownership migration and its cutover/rollback (ADR-0039), the cutover-detection mechanism, what Auth's own hierarchy endpoints
become afterwards, service-token scopes (B-029/O-13/O-14), organization-payer authority (B-026/O-18), platform currency
administration (B-036), organization lifecycle semantics (archive/deactivate/suspend), human-facing authorization for these
entities, and any organization events (none until a concrete consumer needs them).

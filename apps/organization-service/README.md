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

## Authorization: authentication, then policy (ADR-0033, ADR-0042)

**Authentication** is unchanged: `ServiceTokenGuard` proves *which service* called (SHA-256 digests in `SERVICE_TOKENS`, at most two per
caller, constant-time compare, one generic `401`). It says nothing about what the caller may do. **Authorization** is a separate,
deny-by-default policy (`SERVICE_POLICY`), enforced by `ServicePolicyGuard` on every route:

* Each route declares the **one capability** it needs (`@RequireCapability`); a route that declares none is refused. Capabilities:
  `hierarchy.reference.read` (ids and parents only), `hierarchy.read` (full read), `hierarchy.provision` (create a Company). `hierarchy.write`
  (create or update a Platform or Organization through a service credential) **cannot be assigned**: no accepted decision names a holder, so
  those routes answer `403` to every service. Changing a Company's name has no holder either (OPEN-4).
* **Platform is the scope.** A reading credential carries an **explicit** `allowedPlatforms` (possibly empty). There is no wildcard and no
  implicit all-Platform access. This service resolves `organizationId -> platformId` from its own hierarchy and evaluates the set:
  `allowedPlatforms = [P1, P2]`, `O17 -> P2` is answered, `O99 -> P7` is a collapsed `404`. **A client never supplies the scope**: a
  query, body or header claiming a platform, scope or caller changes nothing.
* `GET /organization/reference/organizations/{id}` is the reference read: `{ organizationId, platformId, companyId }` and nothing else.
* **Provisioning is a dedicated identity**: `hierarchy.provision` alone, outside Platform scope, on `POST /organization/companies` only. It
  reads nothing and writes nothing else.
* The service **refuses to start** if a registered caller has no policy entry, names an unregistered caller, lists a non-UUID platform, tries
  to combine provisioning with anything else, or tries to assign `hierarchy.write`. The unrestricted policy used by the older test suites is a
  fixture that production refuses.
* Rate limiting (where present) is abuse protection and is **not** authorization.
* A user's bearer is never accepted as a **service** credential, and every service-token route makes no outbound call: login, refresh and
  `/auth/me` cannot depend on this service. The one bounded exception is the **human-admin module** (`src/admin/`, ADR-0042 decision 6):
  `POST /organization/admin/platforms`, `PATCH /organization/admin/platforms/:id`, `POST /organization/admin/organizations`,
  `PATCH /organization/admin/organizations/:id`. It forwards the caller's OWN bearer to Auth (`GET /auth/grants`, and `POST /auth/step-up/verify`
  for the two sensitive creates), evaluates authority server-side against this service's own hierarchy (owner: same company; operator: assigned
  platform; organization administrator: that organization, updates only) and records every mutation and denial in `admin_actor_event`. It needs
  `AUTH_SERVICE_URL`. The client supplies no role, ownership, assignment or scope. Operator step-up is **not built**, so operators are denied
  the two sensitive creates (fail closed). `boundary.spec.ts` allows Auth access only under `admin/`.
* Denials of the service-token routes are logged as `service_authorization_denied caller=… capability=… reason=…` (never a secret).

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

## Ownership transition (ADR-0040, Stage 10.1): mechanisms exist, authority is NOT active anywhere

Migration `0004_ownership_transition.sql` is **inert**: it adds one state row (`ownership_state`, starting `PREPARED`, not authoritative), an
append-only audit (`ownership_event`), the import record, and an id ledger. It moves no data and no authority.

| Phase | Meaning | Authoritative |
|---|---|---|
| `PREPARED` | provisioned, nothing verified | no |
| `VERIFIED` | an import (existing) or the first Company (fresh) verified by digest | no |
| `FROZEN` | a snapshot taken **under Auth's freeze** was imported and verified (existing environments only) | no |
| `ACTIVATABLE` | approval recorded (who, and the rehearsal reference) | no |
| `ACTIVE` | **ACTIVATE AUTHORITY**: the one explicit switch | yes |
| `RETIRED` | Auth's hierarchy writes retired (the mirror); nothing ever moves back | yes |

* Only the operations login, through `npm run ownership`, changes the state. The runtime role can read it and cannot change it, write the
  audit, or delete or truncate a hierarchy row. **Starting, deploying, migrating, a health check or importing never activates authority.**
* Until `ACTIVE`, every hierarchy write and every service read is refused with `409 not_authoritative`. The exceptions are the fresh
  environment's first-Company bootstrap (the provisioning identity) and Auth's full read for `ensure`.
* **One-way door:** after `ACTIVE` the database refuses every backward transition, and a rollback is refused (`rollback_after_activation`);
  it would need reconciliation, which is not designed. **I1:** an id is never reused (the ledger). **I2(a):** parents never change. **I2(b):**
  once authoritative no role deletes or truncates a hierarchy row. These are migration invariants, not a lifecycle policy.

```bash
export OWNERSHIP_ADMIN_DATABASE_URL=postgres://organization_migrator:...@host/organization   # never the runtime role
npm run ownership -- status
# Existing environment (Auth holds the hierarchy):
npm run ownership -- declare-class --class existing --actor NAME
npm run ownership -- import --file snapshot.json --actor NAME            # compare-and-insert; repeatable; never activates
#   (auth-service: hierarchy-freeze, then hierarchy-export --final; import that file; the phase becomes FROZEN)
npm run ownership -- approve --reference REHEARSAL-REF --actor NAME      # records the approval; still not active
npm run ownership -- activate --confirm ACTIVATE-AUTHORITY --actor NAME  # production also needs OWNERSHIP_PRODUCTION_ACTIVATION=enabled
npm run ownership -- retire --evidence "..." --actor NAME                 # after auth-service: hierarchy-retire
# Fresh environment (nothing to import or freeze): declare-class --class fresh, create the first Company through the provisioning
# identity, verify --expect-digest <content digest>, approve, activate.
npm run ownership -- rollback --reason "..." --actor NAME                 # BEFORE activation only
```

The snapshot is deterministic and checksummed (`libs/service-kit` `sealSnapshot`); `pg_dump` remains the backup tool only. An import that
finds a differing row, or a row this service holds that the snapshot lacks, **aborts** and changes nothing; nothing is ever updated or
deleted. Every attempt, rejected ones included, is an `ownership_event` row and a structured log line (`ownership_import_started`,
`ownership_import_succeeded`, `ownership_import_failed`, `ownership_activation_requested`, `ownership_activation_succeeded`,
`ownership_activation_rejected`, `ownership_retirement_completed`, `ownership_rollback_rejected`, `ownership_snapshot_verified`).

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

## Not implemented, or not decided (do not infer)

The operator step-up contract (Auth side), Auth's reference-cache `ensure` and its first-touch flows, the Billing and Payment reference
clients, production deployment, database roles and backups, monitoring and the production rehearsal (ADR-0040 gates G1 to G7:
**none is met**), lifecycle semantics beyond I1 and I2, service events, organization-payer authority (B-026/O-18) and platform currency
administration (B-036). See `docs/architecture/stage-10/stage-10-1-implementation.md`.

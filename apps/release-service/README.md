# release-service

Release management for Nawara Core ([ADR-0051](../../docs/adr/0051-release-management-and-client-compatibility.md)): **release metadata
and client compatibility, never delivery**. It is not CI/CD, a deployment engine, an artifact store or CDN, a signing service,
authorization, entitlement or analytics. No product request path calls it synchronously.

**Stage 20.2 (this state): foundation and domain only.** The service has health and readiness, its own database with the domain schema
and its invariants, and internal persistence primitives. **There is no business HTTP route yet:**
- CI registration and publication are Stage 20.3;
- owner withdrawal and minimum-version administration are 20.4;
- the public compatibility read is 20.5.

## Domain

```text
product ─1:N─ component ─1:N─ release               (registered → published → withdrawn)
                        └─1:N─ compatibility_policy  (append-only, versioned 1, 2, 3 … per client component)
```

- **Product:** a release-registry key (`^[a-z][a-z0-9-]{0,62}$`). It is not Billing's commercial product and not Core's tenant Platform.
- **Component:** `(product, key)` is unique. The kind is one of `backend | web | desktop | mobile_ios | mobile_android` and never
  changes. Desktop is technology-neutral (Tauri is not a kind); `ai` is reserved for later.
- **Release:** `(component, version)` is unique.
  - The version is canonical SemVer 2.0 with an optional pre-release and **no build metadata**. Native build identities go in `buildId`
    and are never compared.
  - The identity (`componentId`, `version`, `buildId`, `sourceRevision`, `notesRef`, `registeredAt`) is immutable.
  - The only moves are registered → published → withdrawn. There is no reverse move and no deletion; a registered release cannot be
    withdrawn.
- **Latest:** the highest published, not-withdrawn release without a pre-release tag.
- **Compatibility policy:**
  - client components only;
  - a stable minimum version;
  - append-only;
  - the next `policyVersion` only (optimistic concurrency);
  - **minimum ≤ latest**, enforced on every policy change and every withdrawal. Both paths are serialized per component by a
    transaction-scoped advisory lock.

Every invariant is enforced by PostgreSQL, in two layers: revoked privileges and refusing triggers. The service's own checks only reject
bad input early with a bounded code.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `production` | unset means production |
| `PORT`, `LOG_LEVEL`, `BODY_LIMIT_KB`, `CORS_ORIGINS`, `TRUST_PROXY`, `HTTP_DRAIN_TIMEOUT_MS` | kit defaults | the Core HTTP baseline |
| `DATABASE_URL` | **required** | the runtime role `release_app`; production refuses `postgres`, `root` and `*_migrator` |
| `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | kit defaults | |
| `MIGRATION_DATABASE_URL` | – | the migrator (`release_migrator`), read only by `npm run migrate` |

Nothing else is configured yet. Service tokens (20.3), Auth verification (20.4) and the public-read cache and rate limit (20.5) arrive
with the stages that use them.

## Run and test

```bash
npm run build -w @nawara/service-kit && npm run build -w release-service
npm test -w release-service                                          # unit
TEST_DATABASE_ADMIN_URL=postgres://postgres:…@127.0.0.1:5433/postgres npm run test:e2e -w release-service   # real PostgreSQL 16
MIGRATION_DATABASE_URL=postgres://release_migrator:…@127.0.0.1:5433/release npm run migrate -w release-service
```

With Compose: `docker compose --profile db run --rm release-service npm run migrate`, then
`docker compose --profile db up -d release-service` (port 3007). `/health` is liveness, and `/ready` checks the database and migrations.

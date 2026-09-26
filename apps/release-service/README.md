# release-service

Release management for Nawara Core ([ADR-0051](../../docs/adr/0051-release-management-and-client-compatibility.md)): **release metadata
and client compatibility, never delivery**. It is not CI/CD, a deployment engine, an artifact store or CDN, a signing service,
authorization, entitlement or analytics. No product request path calls it synchronously.

**State: Stage 20.4.** Built on the Stage 20.2 foundation (own database, the domain schema and its invariants, persistence primitives):
- CI registers and publishes releases, with a service token and a per-product policy (20.3);
- the owner of the configured operating Company withdraws releases and changes minimum versions, with their own Auth bearer and a factor
  step-up (20.4);
- the public compatibility read is 20.5.

## Automation API (Stage 20.3)

CI is a **service identity** (ADR-0033 token; ADR-0042 policy in this service). It never impersonates a human, and no human, owner or
operator token is accepted: a user bearer is not a service token (401).

| Operation | Route | Capability | Success | Retry |
|---|---|---|---|---|
| Register | `POST /release/products/{product}/components/{component}/releases` `{kind, version, buildId?, sourceRevision?, notesRef?}` | `release.register` for `{product}` | 201, `registered` (the component is created on first use with its kind) | same identity: 200 + `Idempotent-Replayed: true`, nothing written |
| Publish | `POST /release/products/{product}/components/{component}/releases/{version}/publish` | `release.publish` for `{product}` | 200, `registered → published` | already published: 200 + `Idempotent-Replayed: true`, nothing written |

Refusals:
- **401:** no, malformed or unknown token.
- **403:**
  - `operation_not_allowed`: the caller holds the capability for no product;
  - `product_not_allowed`: not for this product. An unknown product gives the same answer. Both are decided from configuration before
    any lookup or body validation.
- **400:** `validation_error`: a malformed key, kind, version, build id, revision or notes reference, or any unexpected field (an
  environment, channel, artifact, organization, flag, status …).
- **404:** `release_not_found` (publish only).
- **409:**
  - `component_kind_conflict`;
  - `release_conflict`: the same version with a different identity, never overwritten;
  - `invalid_transition`: a withdrawn release is never republished.

Every change writes its audit intent in the **same transaction** through the kit outbox (`release.registered`, `release.published`):
- the actor is the CI service;
- the record is platform-level, with changes limited to identifiers and the kind;
- an idempotent retry writes nothing.

The kit relay publishes the intent to RabbitMQ after commit. A broker or audit-service outage never fails a registration; the intent
waits in the outbox.

OpenAPI is at `/release/docs`, behind basic auth, and is mounted only when `SWAGGER_PASSWORD` is set.

## Owner administration (Stage 20.4)

Human only (ADR-0051 decision 8, ADR-0050):
- the caller's **own** Auth bearer, verified live (`GET /auth/grants`), must be the **owner of `RELEASE_OPERATING_COMPANY_ID`**;
- each operation needs a **factor step-up**. Its purpose is `release.withdraw` or `compatibility_policy.change`: TOTP or passkey, never
  the secret key, obtained from `POST /auth/admin/step-up`. It is sent as `x-step-up-token`, and release-service verifies and consumes it
  through Auth (`POST /auth/step-up/verify`).
- Operators, members, another Company's owner and CI service tokens are refused. A service token is never forwarded to Auth.

| Operation | Route | Result |
|---|---|---|
| Withdraw | `POST /release/admin/products/{product}/components/{component}/releases/{version}/withdraw` | `published → withdrawn`, `release.withdrawn` recorded. Already withdrawn: 200 `changed:false`. Refusals: 409 `invalid_transition` (registered, never published); 409 `would_break_minimum` (lower the minimum first) |
| Change the minimum | `POST /release/admin/products/{product}/components/{component}/compatibility-policy` `{minimumVersion, expectedPolicyVersion}` | the next policy version is appended, `compatibility_policy.changed` recorded. The minimum must be a published, not withdrawn, stable release of the component. The same minimum: 200 `changed:false`. Refusals: 409 `policy_conflict` / `invalid_minimum` / `policy_not_applicable` (backend) |

- **Preconditions** are checked before the step-up is consumed, so a refusal never spends it.
- **A no-op** (already withdrawn; the same minimum) still requires and spends a valid step-up, as in Stage 19.2.
- **Consumption happens in Auth**, so a mutation that fails afterwards needs a new step-up.
- **Auth failures** fail closed: 503 `auth_timeout` / `auth_unavailable`. One `AUTH_TIMEOUT_MS` budget covers every Auth call of the request.

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
| `SERVICE_TOKENS` | empty (nobody can call) | `<caller>:<sha256 of the token>`, at most two per caller (rotation); the caller keeps the raw token |
| `RELEASE_SERVICE_POLICY` | required when `SERVICE_TOKENS` is set | `{"callers":{"<caller>":{"products":{"<product>":["release.register","release.publish"]}}}}`. Deny by default: every caller needs an entry, every entry a token; product keys only (no wildcard); only these two capabilities exist |
| `RABBITMQ_URL` | required in production | the audit relay's broker (publish only; nothing is consumed). Elsewhere, absent = in-memory bus |
| `RABBITMQ_CONFIRM_TIMEOUT_MS`, `RABBITMQ_HEARTBEAT_S` | kit defaults | |
| `SWAGGER_USERNAME`, `SWAGGER_PASSWORD` | `docs`, – | OpenAPI behind basic auth; the password must have 16+ characters |

| `AUTH_SERVICE_URL`, `RELEASE_OPERATING_COMPANY_ID` | – | Stage 20.4, **both or neither** (the owner routes exist only with both). The URL is a plain `http(s)` origin: no credentials, query or fragment. The Company is a UUID |
| `AUTH_TIMEOUT_MS` | 3000 (100–30000) | one Auth budget per owner request |

Nothing else is configured yet. The public-read cache and rate limit arrive in 20.5.

## Run and test

```bash
npm run build -w @nawara/service-kit -w @nawara/audit-contract && npm run build -w release-service
npm test -w release-service                                          # unit
TEST_DATABASE_ADMIN_URL=postgres://postgres:…@127.0.0.1:5433/postgres npm run test:e2e -w release-service   # real PostgreSQL 16
MIGRATION_DATABASE_URL=postgres://release_migrator:…@127.0.0.1:5433/release npm run migrate -w release-service
```

With Compose: `docker compose --profile db run --rm release-service npm run migrate`, then
`docker compose --profile db up -d release-service` (port 3007). `/health` is liveness, and `/ready` checks the database and migrations.

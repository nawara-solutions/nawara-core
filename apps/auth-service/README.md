# auth-service

Identity, authentication, sessions and tenant/platform **access scope** for Nawara Solutions apps.
It does **not** own licenses/subscriptions/billing (payment-service) or business roles/permissions
(platform services) — authentication is not entitlement (ADR-0026).

- Design: `docs/sdd/auth-service.md`, ADR-0024…0027. Security review and route matrix:
  `docs/security/auth-service-security-review.md`.
- Schema of record: `db/migrations/*.sql` (applied in order; each has a documented rollback in `db/migrations/down/`).
- API docs: `GET /auth/docs` (Swagger UI) and `/auth/docs-json`, behind HTTP basic auth. Mounted only when
  `SWAGGER_PASSWORD` (>= 16 chars) is set; `SWAGGER_USERNAME` defaults to `docs`. Under `/auth` so it is
  reachable through the path-routed gateway.

## Run

```bash
cp .env.example .env         # local development ONLY; generate every secret: openssl rand -base64 32
# apply db/migrations/0001..0003 to your database, then:
npm run start:dev -w auth-service
```

The process **refuses to start** if any secret is missing, weak or duplicated. Secrets come from the
environment or from files (`NAME_FILE=/run/secrets/name`); see `.env.example` and the key-management
section of the security review. Set `AUTH_EVENTS=off` to run without RabbitMQ.

## Operations

```bash
npm run build -w auth-service
# create the ONE first owner (idempotent; refuses if an owner exists; mints no key, enrolls no factor)
BOOTSTRAP_COMPANY_NAME=... BOOTSTRAP_OWNER_EMAIL=... BOOTSTRAP_OWNER_PASSWORD=... npm run cli -w auth-service -- bootstrap-owner
# TOTP encryption-key rotation: add the new key to TOTP_ENCRYPTION_KEYS, make it active, then
npm run cli -w auth-service -- reseal-totp-keys     # remove the old key only when "still under an old key: 0"
```

The bootstrap password is a **one-time credential**: deliver it out of band; the owner's first sign-in
only allows enrolling a second factor.

## Tests

```bash
npm test -w auth-service                 # unit
npm run test:e2e -w auth-service         # integration: real PostgreSQL, real migrations
npm run test:db -w auth-service          # SQL invariants, concurrency race, migration safety (needs psql)
npm run test:all -w auth-service         # unit + integration
```

The integration tests start a throw-away local PostgreSQL if binaries are installed, or use
`TEST_DATABASE_ADMIN_URL` (e.g. a CI service container).

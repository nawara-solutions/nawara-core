# auth-service

Identity, authentication, sessions and tenant/platform **access scope** for Nawara Solutions apps.
It does **not** own commercial state — Subscription and effective entitlement belong to billing-service
(ADR-0044), payment processing and settlement to payment-service — nor business roles/permissions
(platform services): authentication is not entitlement (ADR-0026).

- Design: `docs/sdd/auth-service.md`, ADR-0024…0027. Security review and route matrix:
  `docs/security/auth-service-security-review.md`.
- Schema of record: `db/migrations/*.sql` (applied in order; each has a documented rollback in `db/migrations/down/`).
- API docs: `GET /auth/docs` (Swagger UI) and `/auth/docs-json`, behind HTTP basic auth. Mounted only when
  `SWAGGER_PASSWORD` (>= 16 chars) is set; `SWAGGER_USERNAME` defaults to `docs`. Under `/auth` so it is
  reachable through the path-routed gateway.

## Run

```bash
cd apps/auth-service
cp .env.example .env         # local development ONLY; generate every secret: openssl rand -base64 32
set -a; . ./.env; set +a     # nothing loads .env for you: export it into this shell before starting
(cd ../.. && npm run build:libs && npm run build -w auth-service)   # the shared libraries, and Auth: its migration runner is the built CLI
MIGRATION_DATABASE_URL=postgres://auth_migrator:…@127.0.0.1:5433/auth npm run migrate   # every migration in db/migrations, as the schema owner
npm run start:dev
```

**`NODE_ENV` must be set for a local run** (the template sets `NODE_ENV=development`). Unset, it means **production** (V2 A2.3): the
service then demands the production settings (WebAuthn origins, the runtime database role, a broker) and refuses to start without them.
The service never reads a `.env` file itself; the configuration comes from the process environment only (Compose, `docker run
--env-file`, or the `set -a` line above). Shell quoting and the rest of the shared setup: [developer guide](../../docs/DEVELOPMENT.md#2-first-run).

The process **refuses to start** if any secret is missing, weak or duplicated. Secrets come from the
environment or from files (`NAME_FILE=/run/secrets/name`); see `.env.example` and the key-management
section of the security review.

**Domain events (Stage 21.C.2, ADR-0052; `src/events/`):** every Auth domain event (codes, security alerts, membership notices,
registrations) is written to Auth's transactional outbox **in the same transaction as its change** and published by the same kit relay as
the audit evidence below (at least once; Notification de-duplicates on the event id). The former fire-and-forget publisher is gone.
`AUTH_EVENTS=off` writes no domain-event row; committed rows are always relayed. The three code-bearing events' rows are deleted once
published or once the code has expired (`CodeEventPurge`, migration `0011`), and a code is never logged.

**Hierarchy source (Stage 21.C.2, ADR-0040; `src/hierarchy/hierarchy-reference.ts`):** `AUTH_HIERARCHY_SOURCE=local` (the default) keeps
Auth's tables authoritative, as today. After the 21.x cutover, `organization-service` makes them a validated reference cache: a join code,
an admin invitation or a platform assignment for an entity Auth has not seen places it by `ensure` from Organization Service (Auth's own
full-read credential, `ORGANIZATION_SERVICE_URL` / `ORGANIZATION_SERVICE_TOKEN`), bounded and fail closed (`503 hierarchy_unavailable`).
Login, refresh, `/auth/me`, registration, join and consume never call Organization Service.

**Central audit (Stage 18.7.5 / 18.7.6, ADR-0049; `src/audit/central-audit.ts`):** Auth's 24 catalog actions write their central audit
intent through `AuditEventWriter` into Auth's own transactional outbox (migration `0010`, the kit's outbox table exactly), in the SAME
transaction as the Auth change and its local `auth_audit_event` row; the kit relay (on Auth's own pool) publishes it to RabbitMQ with
publisher confirms and retries. It is **independent of `AUTH_EVENTS`**: `RABBITMQ_URL` is **required in production** (the process
refuses to start without it; the deploy script checks it before touching anything), and outside production its absence selects an
in-memory bus. The local `auth_audit_event` trail is unchanged and keeps what central audit never receives (IP, session family,
metadata). The CLI writes no central event and never runs a relay. See the
[Stage 18.7 record](../../docs/architecture/stage-18/stage-18-7-core-producer-integration.md).

## Environment

Read once at startup by `src/config/app-config.ts` through the kit's `EnvReader` (V2 A4.2), as in every other Core service; a missing
or invalid value stops the process, and no error repeats a value. This table is the reference for Auth's variables;
[`.env.example`](./.env.example) is a local-development template. Rotation: [secret rotation runbook](../../docs/runbooks/secret-rotation.md).

HTTP bootstrap (V2 A4.4): `src/main.ts` and the e2e tests start Auth through one pipeline, `src/http/configure-auth-app.ts`, which is the
kit's `configureApp` with Auth's `AuthExceptionFilter`. Auth keeps two settings of its own: CORS runs before the body parser (a body
refused while parsed, 400 or 413, still carries an allowed origin's CORS headers), and URL-encoded bodies are parsed as well as JSON,
both under `BODY_LIMIT_KB` (100 KB by default, the former limit). **With no `CORS_ORIGINS` there is no CORS at all**: before A4.4 an
unconfigured Auth answered `Access-Control-Allow-Origin: *`. CORS never allows credentials. The API docs (`/auth/docs`, `/auth/docs-json`,
`src/docs/mount-docs.ts`) are mounted only with `SWAGGER_PASSWORD`, behind Basic authentication.

Reading rules (the kit's, since A4.2):
- **Every variable** may be given as `NAME_FILE=/path` instead of `NAME` (secrets marked **file** should be). Setting **both** is
  refused at startup (`set NAME or NAME_FILE, not both`); before A4.2 the file silently won.
- Surrounding whitespace is removed from the value, from the `_FILE` path and from the file's content; a blank value counts as unset
  and takes the default. A direct secret with surrounding whitespace is therefore accepted (it was refused before A4.2).
- Integers are plain signed decimals only: `1e3`, `0x10` or `5.0` are refused (they were accepted before A4.2).
- A malformed `TOTP_ENCRYPTION_KEYS` entry is reported with the kit's wording (`must be "id:base64[,id:base64]" with ids of 1 to 32 …`).
- Unknown variables are ignored, as before (a stale `PAYMENT_SERVICE_*` entry has no effect).

| Variable | Required | Default | Secret | Meaning |
|---|---|---|---|---|
| `NODE_ENV` | no | `production` | no | `development`, `test` or `production`; unset means production |
| `PORT`, `LOG_LEVEL`, `CORS_ORIGINS`, `TRUST_PROXY_HOPS` (or the older `TRUST_PROXY`), `BODY_LIMIT_KB`, `HTTP_DRAIN_TIMEOUT_MS`, `METRICS_*` | no | 3000, `info`, none, 0, 100, 5000, off | no | HTTP baseline (same rules as the kit); CORS takes exact origins only |
| `DATABASE_URL` | yes | none | **yes, file** (password) | the runtime role `auth_app`; in production `postgres`, `root`, `auth`, `*_migrator` and `*_admin` are refused, also when read from `DATABASE_URL_FILE` |
| `DB_POOL_MAX`, `DB_CONNECTION_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | no | 10, 5000, 30000, 60000, statement + 5000 | no | bounded database limits |
| `JWT_SECRET` | yes, unless the ring is set with a ring key active | none | **yes, file** | the **legacy** HS256 key: canonical base64 of at least 32 bytes. Signs kid-less tokens when it is the active key (`JWT_ACTIVE_KEY_ID` unset or `legacy`) and verifies kid-less tokens while set (ADR-0058) |
| `JWT_SIGNING_KEYS` | no (set together with `JWT_ACTIVE_KEY_ID`) | none | **yes, file** | optional HS256 key ring `id:base64[,id:base64]`, at most 3 keys; ids of 1 to 32 letters, digits, `_` or `-` (public: they appear in token headers), `legacy` reserved in any case; keys follow `JWT_SECRET`'s rules and differ from it, every pepper and every TOTP key. A token with a `kid` is verified with that ring key only |
| `JWT_ACTIVE_KEY_ID` | no (set together with `JWT_SIGNING_KEYS`) | `legacy` | no (public id) | the key that signs: a ring id (header `{"alg":"HS256","kid":"<id>"}`) or `legacy` (`JWT_SECRET`, header `{"alg":"HS256"}`). Each rotation step is an owner-authorized change; an image without the ring cannot verify ring-signed tokens (ADR-0058 rule 8) |
| `JWT_ISSUER`, `JWT_AUDIENCE`, `ACCESS_TOKEN_TTL_SEC`, `REFRESH_TOKEN_TTL_SEC` | no | `nawara-auth`, `nawara`, 900, 14 days | no | token claims and lifetimes (access 30 to 3600 s) |
| `OPERATOR_CODE_PEPPER`, `SECRET_KEY_PEPPER`, `THROTTLE_KEY_PEPPER`, `JOIN_CODE_PEPPER` | yes | none | **yes, file** | HMAC peppers, canonical base64 of at least 32 bytes, all distinct. **Not rotatable transparently** (see the rotation runbook) |
| `TOTP_ENCRYPTION_KEYS`, `TOTP_ENCRYPTION_ACTIVE_KEY_ID` | yes | none | **yes, file** | key ring `id:base64(32 bytes)[,…]` and the id used for new secrets; no repeated id or key |
| `TOTP_ISSUER`, `TOTP_EPOCH_TOLERANCE_SEC`, `BCRYPT_COST` | no | `Nawara`, 30, 12 | no | factor and password parameters |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `WEBAUTHN_RP_NAME` | **in production** | `localhost`, `http://localhost:3000`, `Nawara` | no | passkeys: https origins under the RP id |
| `CHALLENGE_TTL_SEC`, `STEP_UP_TTL_SEC`, `RECOVERY_COOLDOWN_SEC`, `RECOVERY_REQUEST_TTL_SEC`, `RECOVERY_ENROLLMENT_TTL_SEC` | no | 600, 300, 1 day, 7 days, 1800 | no | owner ceremonies (step-up at most 900 s) |
| `WORK_TIMEZONE`, `OPERATOR_FALLBACK_SESSION_SEC`, `OPERATOR_CONFIRMATION_TTL_SEC` | no | `UTC`, 8 h, 8 h | no | operator sessions |
| `INVITATION_MIN_MINUTES`, `INVITATION_DEFAULT_MINUTES`, `INVITATION_MAX_MINUTES`, `CONTACT_CODE_TTL_SEC` | no | 15, 1440, 10080, 900 | no | onboarding lifetimes |
| `REQUIRE_CONTACT_VERIFICATION` | no | `false` | no | exactly `true` or `false` |
| `RATE_<BUCKET>_LIMIT`, `RATE_<BUCKET>_WINDOW_SEC`, `BASELINE_RATE_LIMIT_PER_MINUTE` | no | per bucket (see `rate` in `app-config.ts`), 100 | no | throttling; buckets such as `LOGIN_IP`, `LOGIN_IDENTIFIER`, `REFRESH_IP`, `STEP_UP_OWNER` |
| `AUTH_EVENTS` | no | `on` | no | exactly `on` or `off`: whether domain-event rows are written (production keeps `off`) |
| `RABBITMQ_URL`, `RABBITMQ_CONFIRM_TIMEOUT_MS`, `RABBITMQ_HEARTBEAT_S` | URL **in production** | none, 5000, kit default | **yes, file** (URL password) | the outbox relay's broker (audit evidence, independent of `AUTH_EVENTS`); `RABBITMQ_URL_FILE` is accepted |
| `AUTH_HIERARCHY_SOURCE`, `ORGANIZATION_SERVICE_URL`, `ORGANIZATION_SERVICE_TOKEN`, `ORGANIZATION_SERVICE_TIMEOUT_MS` | no | `local`, none, none, 2000 | token: **yes, file** | Auth's Organization Service client; URL and token are set together |
| `SWAGGER_USERNAME`, `SWAGGER_PASSWORD` | no | `docs`, none | password: **yes, file** | API docs; mounted only with a password of at least 16 characters (the kit's `readDocsCredentials`) |

## Organization onboarding (join codes)

An organization hands a user a **join code**; the app never sends an organization id, platform or role.
`POST /auth/onboarding/resolve {joinCode}` returns the server-derived context (platform, organization, audience,
`requiresSubscription`, `requiresOrganizationApproval`); `POST /auth/register {joinCode, email|phone, password}`
creates a `kind=member` with an `active` (auto) or `pending` (needs approval) membership. Only an `active`
membership grants organization access, evaluated from current rows on every request.

- Organization administration (create/revoke codes, approve/reject, grant org admin) is authorized per request:
  Owner (company), Operator (assigned platform) or a member holding an active org-admin membership. Owners need a
  step-up for codes and admin grants. See `docs/adr/0028-*`.
- `JOIN_CODE_PEPPER` is required (generate it like the other secrets). `REQUIRE_CONTACT_VERIFICATION` defaults to
  `false` and must stay off until a channel delivers verification codes (events are published, nothing delivers them).
- **Administrator invitations** (ADR-0029) provision privileged people: an Owner (factor step-up) or an existing
  organization admin creates a single-use, revocable invitation (duration chosen by the admin within a server-enforced
  range, default 24 h, 15 min to 7 days; `INVITATION_*_MINUTES`), delivered out of band; `POST
  /auth/onboarding/invitations/accept` creates the account with the organization-management capability. The invitation
  is not a join code, a license or a session. First administrator: an Owner creates the first invitation.
- **One identity, many organizations** (ADR-0030). A member is one account with N memberships; the platform is
  derived from the organization, never stored on the user, and tokens carry no organization or business role.
  `POST /auth/onboarding/join {joinCode}` lets a signed-in member join another organization (one contact is one
  account). A membership goes `pending → active | rejected` and `active → revoked` (final states); revoking affects
  only that organization. `GET /auth/me` returns `memberships[]`. The join code's audience is an opaque label on the
  membership; Auth attaches no business meaning to it.
- `CORS_ORIGINS` must be exact http(s) origins (no `*`, no paths); anything else stops the service at startup.
- **WebAuthn (owner passkeys).** The browser origin, the RP ID and the API host are three different things:

  | | Production (owner decision) |
  |---|---|
  | Browser origin running `navigator.credentials.*` (`WEBAUTHN_ORIGINS`) | `https://admin.nawara-solutions.com` (the owner admin UI) |
  | RP ID scoping every credential (`WEBAUTHN_RP_ID`) | `nawara-solutions.com` |
  | Auth API (not a WebAuthn origin) | `https://core-api.nawara-solutions.com/auth` |

  In production both settings are required, every origin must be an exact `https://` origin, and its host must be the RP ID or a
  subdomain of it (checked at startup). The deploy script writes these values for a new installation only; an existing `.env` is
  never overwritten. Changing an origin under the same RP ID keeps enrolled passkeys; **changing the RP ID does not** (each passkey
  is bound to the RP ID it was created for). If passkeys exist when the RP ID changes, the owner signs in with TOTP, enrolls a new
  passkey from the admin UI, then removes the old one; no database change is needed. TOTP, the secret key and recovery never depend
  on these settings.
- Auth has no commercial dependency: registration and join never check subscription, license or entitlement state,
  and Auth calls no other service to decide them. `requiresSubscription` is stored and returned as an onboarding
  hint for the app only; it carries no backend authority.

## Operations

```bash
npm run build -w auth-service
# create the ONE first owner (idempotent; refuses if an owner exists; mints no key, enrolls no factor)
# Do not type the password inline (it would stay in the shell history and in the process list): read it without echo (bash).
read -rs -p 'owner password: ' BOOTSTRAP_OWNER_PASSWORD && export BOOTSTRAP_OWNER_PASSWORD && echo
BOOTSTRAP_COMPANY_NAME=... BOOTSTRAP_OWNER_EMAIL=... npm run cli -w auth-service -- bootstrap-owner
unset BOOTSTRAP_OWNER_PASSWORD
# TOTP encryption-key rotation: add the new key to TOTP_ENCRYPTION_KEYS, make it active, then
npm run cli -w auth-service -- reseal-totp-keys     # remove the old key only when "still under an old key: 0"
```

How the two CLIs read their inputs (V2 A4.3):
- `npm run migrate` (`dist/cli/migrate.js`) needs `MIGRATION_DATABASE_URL` or `MIGRATION_DATABASE_URL_FILE` (the schema owner; never
  both), read through the kit's `EnvReader` (trimmed; blank is unset). There is **no fallback to `DATABASE_URL`** (the runtime role):
  without a migration URL it stops with `migration failed: MIGRATION_DATABASE_URL is required (the schema owner, not the runtime role)`.
  Its last line, `migrations: N applied, M already applied, K checksum(s) recorded`, is read by the restore drill: keep it exact.
- `npm run cli` (`dist/cli/main.js`) loads the service configuration (so `AUTH_EVENTS` is forced off for the CLI only; a CLI never
  writes domain events) and reports a configuration error as one line, exit 1. `bootstrap-owner` reads `BOOTSTRAP_COMPANY_NAME`,
  `BOOTSTRAP_OWNER_EMAIL` and `BOOTSTRAP_COMPANY_ID` through `EnvReader` (`_FILE` accepted, never both, trimmed). The password is taken
  **exactly** as given: `BOOTSTRAP_OWNER_PASSWORD` verbatim (surrounding whitespace is part of it), or `BOOTSTRAP_OWNER_PASSWORD_FILE`
  (the file's content without its final line break), never both. Exit codes: 0 when the owner is created, 1 when an owner already
  exists (`an owner already exists: nothing changed`) or on any refusal.

### Hierarchy authority (ADR-0040): the ownership transition from auth-service's side

Migration `0008` adds `hierarchy_authority` and write guards on `company`, `platform` and `organization`. It is **inert** (mode `local`).

```bash
npm run cli -w auth-service -- hierarchy-status | hierarchy-verify               # content digest, comparable with organization-service
npm run cli -w auth-service -- hierarchy-export --out snapshot.json --actor NAME # deterministic, checksummed; preparation runs are repeatable
npm run cli -w auth-service -- hierarchy-freeze --actor NAME                     # lock, then marker: NO hierarchy write at all
npm run cli -w auth-service -- hierarchy-export --final --out final.json --actor NAME   # only under the freeze
npm run cli -w auth-service -- hierarchy-unfreeze --actor NAME                   # only before the switch
npm run cli -w auth-service -- hierarchy-retire --actor NAME --evidence "..."    # the mirror, after organization-service ACTIVATE AUTHORITY
```

After `hierarchy-retire` (`org_authoritative`) auth-service is a non-authoritative reference cache: no free write, no delete, no reparenting;
only the reference-cache protocol may place a validated row. **There is no way back.** In this mode `bootstrap-owner` never creates a
Company: it needs `BOOTSTRAP_COMPANY_ID` and an existing validated reference row. The reference-cache `ensure` itself is **not implemented yet**.

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
`TEST_DATABASE_ADMIN_URL` (e.g. a CI service container): [developer guide](../../docs/DEVELOPMENT.md#6-test-environment).

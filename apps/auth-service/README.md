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
cp .env.example .env         # local development ONLY; generate every secret: openssl rand -base64 32
# apply db/migrations/0001..0007 to your database, then:
npm run start:dev -w auth-service
```

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
- Auth has no commercial dependency: registration and join never check subscription, license or entitlement state,
  and Auth calls no other service to decide them. `requiresSubscription` is stored and returned as an onboarding
  hint for the app only; it carries no backend authority.

## Operations

```bash
npm run build -w auth-service
# create the ONE first owner (idempotent; refuses if an owner exists; mints no key, enrolls no factor)
BOOTSTRAP_COMPANY_NAME=... BOOTSTRAP_OWNER_EMAIL=... BOOTSTRAP_OWNER_PASSWORD=... npm run cli -w auth-service -- bootstrap-owner
# TOTP encryption-key rotation: add the new key to TOTP_ENCRYPTION_KEYS, make it active, then
npm run cli -w auth-service -- reseal-totp-keys     # remove the old key only when "still under an old key: 0"
```

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
`TEST_DATABASE_ADMIN_URL` (e.g. a CI service container).

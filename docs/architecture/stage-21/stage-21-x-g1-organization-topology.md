# Stage 21.x G1: Organization Service production topology and deployment path

- **Status:** implemented (repository side); **G1 approval pending** (ADR-0040 G1: "documented and approved").
- **Scope:** ADR-0040 gate **G1** (topology) and the deployment half of **F1**. It moves **no authority**: nothing here runs an
  ownership command, registers a caller implicitly, or touches Auth's hierarchy source.
- **Environment class:** production is **fresh** (0 Company, Platform, Organization and Owner rows; Auth hierarchy mode `local`),
  so the cutover follows ADR-0040 A2.5's fresh path **F1–F7**, not E0–E7.
- **Related:** [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md) (gates, fresh path, A2.6),
  [ADR-0053](../../adr/0053-core-v1-production-rabbitmq.md) (broker, identities), [runbook](../../runbooks/organization-production.md).

## 1. Topology

```text
            Internet ── Cloudflare ── Traefik (deploy_edge)
                                          │ /auth only (unchanged)
  deploy_edge ──────────────── nawara-core-auth-service ── nawara-core-auth-db
                                          │ (Auth also joins the internal network)
  nawara-core-internal (--internal) ──────┼── nawara-core-rabbitmq ── nawara-core-audit-service / -audit-db
                                          │     ▲ audit.* (identity organization-service)
                                          ├── nawara-core-organization-service   :3000, no Traefik, no published port
                                          │        ├─▶ Auth → Org: http://nawara-core-organization-service:3000 (Bearer, caller auth-service)
                                          │        └─◀ Org → Auth: http://nawara-core-auth-service:3000 (admin/ routes only; the human's own bearer)
                                          └── nawara-core-organization-db   (organization_migrator / organization_app; volume)
```

| Element | Decision |
|---|---|
| Location | the current Core VPS (no new host, no orchestrator) |
| Exposure | **internal only** (ADR-0042 decision 6; ADR-0040 G1): network `nawara-core-internal` only, no Traefik, no published port; asserted on the running container by the deploy |
| Database | own PostgreSQL (ADR-0032): `nawara-core-organization-db`, database `organization`, volume `nawara-core-organization-db-data`, internal network only |
| Health | Docker health = `GET /ready` (database + migrations). Readiness never depends on authority (`PREPARED` is healthy) nor on the broker (audit evidence waits in the outbox) |
| Broker | the existing ADR-0053 identity `organization-service` (producer: configure/write `nawara.events`, topic write `^audit\.`); audit-service is already bound, so the ADR-0053 ordering rule holds |
| Auth → Organization | `ORGANIZATION_SERVICE_URL` / `ORGANIZATION_SERVICE_TOKEN` (caller `auth-service`); client: 2 000 ms default timeout, `redirect: 'manual'` (3xx refused), **16 KiB** response cap, database reference cache, fail closed (`503 hierarchy_unavailable`) |
| Organization → Auth | `AUTH_SERVICE_URL=http://nawara-core-auth-service:3000`; only the `admin/` routes, forwarding the human's own bearer; Organization holds **no** Auth credential |

## 2. Database roles and the roles-before-migrations invariant

| Role | Purpose |
|---|---|
| `organization_admin` | the container's bootstrap superuser; used by the deploy for role SQL and read-only facts only |
| `organization_migrator` | owns the database and schema; applies the migrations; the ownership CLI's `OWNERSHIP_ADMIN_DATABASE_URL` login |
| `organization_app` | the runtime: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`; default DML, then narrowed by the migrations |

Migrations `0004` and `0005` narrow `organization_app` **only if it exists** (`IF EXISTS … THEN REVOKE`). Migrating first would silently
leave the runtime able to write the ownership state. The deploy therefore runs: database → roles → default privileges → **migrations** →
**privilege assertions** → service. The assertion (fail closed, before any container is started or swapped) requires:

| Table | organization_app must NOT hold | must hold |
|---|---|---|
| `ownership_state`, `ownership_event`, `ownership_import_run`, `hierarchy_id_ledger` | INSERT, UPDATE, DELETE, TRUNCATE | SELECT (`ownership_state`) |
| `company`, `platform`, `organization` | DELETE, TRUNCATE | SELECT, INSERT (`company`) |
| `admin_actor_event` | UPDATE, DELETE, TRUNCATE | INSERT |

and none of the elevated role attributes. This is the technical control **G3** certifies.

## 3. Migrations (G2 classification)

| Migration | Content | Classification | Separate approval? |
|---|---|---|---|
| `0001_company_platform_organization` | tables, immutability triggers | expand-only (new tables) | no |
| `0002_idempotency_key` | idempotency table | expand-only | no |
| `0003_platform_key` | `platform.key` column + format check | expand-only (additive column) | no |
| `0004_ownership_transition` | ownership state row (`PREPARED`), append-only records, id ledger, guards, runtime revokes | **inert** (moves no authority, copies no data) | no |
| `0005_admin_actor_record` | append-only admin actor record, runtime revokes | expand-only | no |

No statement in `0001`–`0005` drops, deletes or rewrites data. They are applied by the **manual** deploy workflow (never automatic,
never at startup), with the kit runner's advisory lock and checksums; `/ready` is 503 while any is pending. G2 remains a gate: any
future non-inert migration needs its own approval.

## 4. Deployment path

`organization-service-deploy.yml`: `workflow_dispatch`, `main` only, the shared `production-deploy-core-api` queue (never cancelled).
It builds `…/nawara-core-organization-service:sha-<commit>`, then streams that image's `deploy/provision-and-deploy.sh` over the
`DEPLOY_SSH_*` channel (`deploy.nawara-solutions.com`). Server state: `$HOME/nawara-core/organization-service` (0700): `db.env`,
`roles.env`, `.env` (0600), `callers/` (0700, 0600 tokens). Container swap with `-previous-<time>` kept; rollback on an unready or
exposure-breaking replacement. The run ends with a **read-only** report of the ownership phase.

**Deploying is not activating.** A deploy never runs `ownership` (declare-class, verify, approve, activate, retire), never sets
`OWNERSHIP_PRODUCTION_ACTIVATION`, never registers a caller, never writes `SERVICE_TOKENS`/`SERVICE_POLICY`, never touches Auth.
Tested in `scripts/deploy-tests/organization-deploy.test.mjs`.

## 5. Callers (F1 and F4, explicit operator steps)

`deploy/register-caller.sh` (typed `CONFIRM="register <caller>"`) generates a token on the server (`callers/<caller>.token`, 0600,
never printed), then rebuilds `SERVICE_TOKENS` (sha-256 digests) and `SERVICE_POLICY` from the registered callers:

| Caller | Step | Policy |
|---|---|---|
| `provisioning` | F1 | `{"capabilities":["hierarchy.provision"]}` (alone, outside Platform scope; F2's first Company) |
| `auth-service` | F4 | `{"capabilities":["hierarchy.read"],"allowedPlatforms":[]}` (the Company read `ensure` needs; no Platform yet) |

The Auth deploy gives Auth `ORGANIZATION_SERVICE_URL` + `ORGANIZATION_SERVICE_TOKEN` only once `callers/auth-service.token` exists,
and **never** writes `AUTH_HIERARCHY_SOURCE` (unset = `local`): switching it is F6's mirror. Registered tokens are never rotated by the
tool. After F7, each new Platform must be added to `auth-service`'s `allowedPlatforms` before Auth can `ensure` its Organizations.

## 6. Gate mapping

```text
WP-1 (planning label) ─▶ G1 topology (this record) ─▶ F1 provisioning (deploy + declare-class fresh + provisioning caller)
G2  migration classification (§3; gate stays)       G3  roles-before-migrations + privilege assertion (§2; certify later)
G4  signals: /health, /ready, phase report, hierarchy_* and outbox relay logs (build later)
G5  back up: the DB volume, db.env, roles.env, .env, callers/ (build and drill later)
G6  production-like rehearsal of F1–F7          G7  `ownership approve --reference …` (after T1, below)
```

**WP-4 (deactivation / zero-write rollback): REMOVED.** ADR-0040 A2.6: in a fresh environment, after activation "there is no
zero-write window and no ownership rollback". Safety before activation comes from the phase guard
(`PREPARED → VERIFIED → ACTIVATABLE → ACTIVE`), `verify` (F5), `approve` (G7), the typed `activate --confirm ACTIVATE-AUTHORITY`, the
per-run `OWNERSHIP_PRODUCTION_ACTIVATION=enabled`, and a runtime role that cannot write the state (§2).

## 7. Boundaries and gates

- **F1–F5:** correctable inside the inactive environment (A2.6 "before activation").
- **F6 ACTIVATE AUTHORITY:** a hard boundary. There is **no fresh-environment authority rollback**.
- **T1 (human-approved Stage 21.x gate):** the Auth → RabbitMQ → Audit relay evidence may stay pending during G1–G5; it **must be
  captured and certified before G7 and before F6**. No artificial audited action is allowed. The natural opportunity is F4 (the
  bootstrapped owner's first factor enrollment, `owner.factor_enrolled`). `AUTH_EVENTS` stays off.
- **Later decisions (before F7, not blocking G1):** how humans reach Organization's `admin/` routes while exposure stays internal
  (ADR-0041 undecided); ADR-0040 OPEN-5 (Platforms / Organizations before or after activation; currently after).

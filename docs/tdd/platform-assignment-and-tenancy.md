# Tenancy integrity, Owner/Operator model, PlatformAssignment, owner step-up and operator sessions — schema, authorization and test plan

- **Status:** Draft <!-- Draft | Reviewed | Implemented -->
- **Author:** Anwar (project owner)
- **Related SDD:** [docs/sdd/auth-service.md](../sdd/auth-service.md) — "Authorization architecture & database integrity"
- **Related ADRs:** [0025](../adr/0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md), [0026](../adr/0026-authentication-is-not-entitlement.md), [0024](../adr/0024-database-enforced-tenancy-and-authorization-integrity.md) (this
  TDD's decision), [0022](../adr/0022-company-and-platform-entities-with-operator-assignment.md),
  [0023](../adr/0023-platform-access-check-and-operator-login-decoupling.md),
  [0020](../adr/0020-organization-entity-and-platform-scoped-management.md)
- **Ticket/issue:** _none yet_

## Problem

The reviewed `auth-service` data model left its most important invariants to application code
(nullable, FK-less `User.organizationId`; a service-layer-only "one active `PlatformAssignment`"
rule; ambiguous owner/operator identity; unforgeable-in-theory but forgeable-in-practice
`role: 'admin'`). ADR-0024 moves them into the database. This TDD is the concrete plan: the schema
migration, the authorization query the services must implement, and the tests that prove the
invariants. It does not redesign anything else.

> **Update 2026-09-18:** the service is now implemented (`apps/auth-service/src`) and the service-level
> cases below are covered by integration tests that run against a real PostgreSQL
> (`apps/auth-service/test/*.e2e-spec.ts`, 115 tests) plus 34 unit tests. Where this document still says
> "Specified", read "**Executed (e2e)**" **except** the items listed under *Known gaps*. The security
> findings, matrices and evidence are in
> [`docs/security/auth-service-security-review.md`](../security/auth-service-security-review.md).

## Approach

### Migration

`apps/auth-service/db/migrations/0001_identity_tenancy_platform_assignment.sql` — greenfield,
transactional, **refuses to run** if any of its tables already exist (there is no legacy data to
repair; see the SDD's "Migration" for the expand/contract procedure and per-condition
abort/repair rules that apply if one is ever found). When TypeORM is introduced (ADR-0003), this
file is the source for the initial `MigrationInterface` (`queryRunner.query(sql)`), unchanged —
the partial indexes, composite FKs and triggers are not expressible as entity decorators, so the
SQL, not the entities, is the schema of record; entities map onto it.

### Migration `0002`

`0002_owner_operator_hardening_and_owner_step_up.sql` (rollback: `db/migrations/down/`). Preflights
every new constraint against existing rows, reports all violations at once and aborts before changing
anything; the one destructive step (`user.trialEndsAt`) needs an explicit acknowledgement
(`SET auth.ack_trial_ends_at_moved = 'on'`) after the values were exported to `payment-service`.

### Authorization query

`PlatformAssignmentService.checkAccess(actorId, platformId)` implements the SQL in the SDD
verbatim (semantically identical to `pg_temp.platform_access` in the test file), and
`resolvePlatformForOrganization(organizationId)` is the only place a platform is derived.
`GET /auth/platform-access/:platformId` and the in-process organization-management checks both call
`checkAccess`; no controller computes access itself.

### Write paths and error mapping

| Write | Behavior |
|---|---|
| Grant | resolve owner from `sub` (must be `kind='owner'`, active) → operator and platform must be in the owner's company → `INSERT` with server-derived `assignedBy`/`companyId`; `23505` → `409` |
| Revoke | `UPDATE … SET active=false, revokedAt=now(), revokedBy=<owner> WHERE operatorId AND platformId AND active`; 0 rows → `404`; never `DELETE` |
| Issue operator code | one transaction: `UPDATE … SET supersededAt=now()` for the live `(operator, purpose)` row, **then** `INSERT` (never a single CTE) |
| Create owner/operator | one transaction: `User` row (`kind`) + subtype row (deferred constraint rejects a half-created identity) |
| `POST /auth/register` | always `kind='member'`; `role: 'admin'` → `400`; DTO whitelist rejects `platformId`/`kind`/`adminTier` |

## Files/components affected

| Path | Change |
|---|---|
| `apps/auth-service/db/migrations/0001_…sql` | new — reference schema (verified against PostgreSQL 16) |
| `apps/auth-service/db/migrations/0002_…sql`, `down/0002_…down.sql` | new — immutability, subtype-delete guard, code/session enforcement, owner factors + step-up, drops `trialEndsAt` (ADR-0025/0026) |
| `apps/auth-service/db/tests/invariants.sql`, `run.sh` | new — 151 DB-level assertions + 12-way concurrent-grant race + 0002 migration-safety scenarios |
| `docs/sdd/auth-service.md`, `docs/add/auth-service.md` | model, UML, flows, constraints, migration updated |
| `docs/adr/0024-…md`, `0025-…md`, `0026-…md` (+ amendment notes on 0004/0005/0006/0009/0010/0011/0016/0017/0020/0022/0023) | new decisions |
| _future_ `src/users/*`, `src/admin/*`, `src/platforms/*` | implement the services/guards to the SDD; add the service-level tests below |

## Edge cases

- **Concurrent grant + revoke.** A revoke that races a grant either finds the active row (revokes
  it) or finds none (`404`); a grant that races a revoke inserts a new row once the old one is
  inactive. Both orders leave at most one active row (the index) and full history (append-only).
- **Owner blocked mid-session.** `checkAccess` reads `isActive` on the *current* row, so a blocked
  owner/operator is denied on the next request although the JWT is still valid.
- **Assignment to a platform the owner's company does not own** → `404` (composite FK is the
  backstop → `23503`).
- **Operator with no schedule** → available; must not be treated as denied (test in the service
  suite: `NO_SCHEDULE_CONFIGURED` ⇒ allowed).
- **Second owner** → `23505` on `owner_single_per_company_v1`; bootstrap/CLI exit non-zero.
- **Migration refuses on a populated database** — verified (guard aborts, lists tables).

## Data migration

None for existing data (greenfield). See the SDD "Migration" table for the legacy-upgrade rules
(detect → report → repair only deterministic cases → abort otherwise).

## Test plan

### How to run what exists today

```bash
# needs a reachable PostgreSQL >= 14; PG* env vars select the server. Drops its scratch DBs.
apps/auth-service/db/tests/run.sh
```

Result at time of writing (PostgreSQL 16.3, migrations `0001` + `0002`): **151 schema assertions
pass, 0 fail; the 12-way concurrent-grant race passes; the four migration-safety scenarios pass**
(a refused `0002` reports every violation and leaves the schema untouched; `trialEndsAt` data blocks
the drop until acknowledged; an acknowledged run preserves existing rows; rollback then re-apply
round-trips). Sanity checks performed: with the partial unique index removed the suite fails on case
N; and each `0002` guard (company immutability, subtype-delete guard, session-ceiling checks, code
consume checks, digest-format checks, step-up guard/short-lived/same-owner) was removed in turn and
its tests failed, so the tests detect the defects they claim to.

### Required cases

Legend — **DB**: executed today by `db/tests/invariants.sql`/`run.sh`. **SVC**: service/guard
behavior, specified below, *not yet implemented or run*.

| # | Case | Where | Proof |
|---|---|---|---|
| A | Organization cannot be created without a Platform | DB | `organization` insert with NULL / nonexistent `platformId` → `23502` / `23503`; same for `platform` without company |
| B | A normal user cannot be created without an Organization | DB | member with NULL `organizationId` → `23514`; owner/operator carrying an `organizationId` → `23514` |
| C | User cannot reference a nonexistent Organization | DB | `23503` |
| D | `platformId` cannot be an alternative platform relation | DB + SVC | DB: no `platformId` column on `user`/`owner`/`operator` (`information_schema`), insert naming it → `42703`. SVC: `POST /auth/register {platformId}` → `400` (DTO whitelist); JWT never contains `platformId` |
| E | Operator without an assignment is DENIED | DB (query) + SVC | `DENY_NO_ACTIVE_ASSIGNMENT`; SVC: `GET /auth/platform-access/:p` → `403`/collapsed |
| F | Operator with an active assignment is allowed (subject to permissions) | DB (query) + SVC | `ALLOW_OPERATOR`; SVC: permission step remains the resource service's |
| G | Revoked assignment immediately DENIES | DB (query) | revoke → very next `platform_access` and `resource_access` → `DENY_NO_ACTIVE_ASSIGNMENT`; revoke requires `revokedBy` an owner |
| H | Operator on Platform A cannot access Platform B | DB (query) | `DENY_NO_ACTIVE_ASSIGNMENT` for Drive while assigned School |
| I | Owner accesses Platform A with no assignment | DB (query) | `ALLOW_OWNER` |
| J | Owner accesses Platform B with no assignment | DB (query) | `ALLOW_OWNER` |
| K | Operator cannot create a `PlatformAssignment` | DB + SVC | DB: operator as `assignedBy` → `23503`, self-assign → `23503`. SVC: `POST /auth/admin/operators/:id/platform-assignments` with an operator token → `403` (`AdminTierGuard`) |
| L | Normal user cannot create one | DB + SVC | DB: member as `assignedBy` → `23503`. SVC: member token → `403` |
| M | Non-owner cannot create one | DB + SVC | DB: assignee must be an operator (member/owner target → `23503`). SVC: no-token `401`, member/operator `403` |
| N | Concurrent grants cannot create two active rows | DB | `run.sh`: 12 racers, each first *checks* (finds none), then inserts → exactly 1 succeeds, 11 `23505`, 1 active row |
| O | Revoked assignment remains in history | DB | revoked row retained with `revokedAt` + `revokedBy`; `DELETE` → `23514`; reactivation → `23514` |
| P | Re-grant creates a NEW row | DB | history for (ahmed, School) = 2 rows (1 revoked, 1 active); grant fields immutable |
| Q | Member of Org A cannot access Org B | DB (query) + SVC | own org → true; same-platform Org B → false; other-platform Org D → false |
| R | Resource → Organization → Platform → Assignment | DB (query) | `resource_access`: School A → ALLOW; Drive D → DENY; unknown org → `DENY_ORGANIZATION_NOT_FOUND`; assignment covers every org in the platform; `user_platform` view resolves user → org → platform → company |
| S | A client-supplied `platformId` cannot bypass authorization | **SVC only** | see below |
| T | An owner is never restricted by assignment logic | DB (query) | owner has 0 assignment rows, still `ALLOW_OWNER`; an owner cannot even be an assignment's `operatorId` (`23503`) |

Additional DB-level assertions (all in `invariants.sql`): `role = 'admin'` is unforgeable
(member with `admin` → `23514`); operators can never hold a password; owner/operator subtype
attach only to the matching `kind`, `kind` immutable, half-created owner rejected at commit;
second owner in a company rejected; secret-key columns set together; cross-company grants rejected
(owner of company 2, operator of company 1 → platform of company 2); org/platform immutability and
non-deletion; `platform_non_working_day.platformId` FK + shape CHECK; `UNIQUE(userId, dayOfWeek)`,
`UNIQUE(userId, date)`, `UNIQUE(userId, fingerprintHash)`, no overnight schedule; only operators can
own schedules/time-off/codes and only owners `admin_device`; one live code per `(operator,
purpose)`, supersede-not-delete retained, `attemptCount` ≤ 5, consumed⊕superseded; refresh-token
hash uniqueness, self-FK, replaced ⇒ revoked, linear (single successor) chain; blocked operator →
`DENY_ACCOUNT_INACTIVE` (distinct from "no assignment").

### Service-level specifications (SVC — to implement with the services; not run yet)

Each is written as Given / When / Then against the Nest app with a real PostgreSQL (the vitest e2e
config already exists; add `pg`/TypeORM when persistence lands).

- **S — client-supplied `platformId` cannot bypass authorization.**
  Given operator Ahmed assigned only to School, and a School-A resource.
  When he calls `POST /auth/admin/organizations {platformId: <Drive>}` → `403`.
  When he calls `GET /auth/admin/organizations?platformId=<Drive>` → returns none of Drive's
  organizations (the filter can only narrow his own assigned set). When he calls
  `GET /auth/admin/platform/calendar?platformId=<Drive>` → `404`.
  When he sends `platformId: <School>` in a request whose *resource* belongs to Drive → still
  denied, because the platform is derived from the resource (`Organization.platformId`), never from
  the body/query/JWT. A forged `platformId` claim in a self-signed token fails signature check.
- **D (SVC).** `POST /auth/register` with `role: 'admin'` → `400`; with `platformId`/`kind`/
  `adminTier` → `400`; a registered user's JWT has no `adminTier` and cannot reach any
  `RolesGuard` route.
- **K/L/M (SVC).** `AdminTierGuard` rejects operator/member tokens before any DB work;
  a valid owner token whose `Owner` row belongs to company X cannot grant on company Y's platform
  (`404`); `assignedBy` in the body is ignored/rejected — the stored value equals the token's `sub`.
- **G (SVC).** Revoke via `DELETE …/platform-assignments/:platformId`; the *same* operator access
  token (unexpired) is then denied by `GET /auth/platform-access/:platformId` on the next call, and
  the operator's other assignments and session remain valid.
- **N (SVC).** Fire N parallel `POST …/platform-assignments` for one pair → exactly one `201`, the
  rest `409`, one active row.
- **Availability (SVC).** `OperatorAvailabilityService` returns the typed reasons in the SDD:
  zero schedule rows → `NO_SCHEDULE_CONFIGURED` **and allowed** (not denied); schedule present but
  no row today → `DAY_OFF`; time-off → `TIME_OFF`; outside hours → `OUTSIDE_WORKING_HOURS`; blocked
  → `ACCOUNT_INACTIVE`; unconfirmed contact → `CONTACT_UNCONFIRMED`; expired
  `sessionExpiresAt` → `SESSION_EXPIRED` (`401`). None of these may be reported as another.
- **Refresh rotation (SVC).** Presenting a replaced/revoked token revokes the whole family and
  returns `401`; `sessionExpiresAt` is copied unchanged along the chain (operator sessions).
- **Login codes (SVC).** A new request supersedes (not deletes) the previous live code; only the
  newest live, unexpired, `attemptCount < 5`, unconsumed code authenticates; the raw code is never
  persisted or logged.
- **Device (SVC).** `ipAddress`/`userAgent` come from the request, never the body; an owner
  secret-key login from a new normalized-UA fingerprint records an `AdminDevice` and alerts;
  `Device` and `AdminDevice` are never merged.
- **Calendar (SVC).** `POST`/`DELETE` are owner-only and company-scoped; `GET` requires owner or an
  operator with an active assignment to that platform.

## Rollout

Design-only until persistence is introduced. Because no schema has shipped, there is no
backward-compatibility burden: the first real migration is `0001`. Two follow-ups are required
before the services are built, and are the reason the SDD status is back to *Draft*: (1) review of
ADR-0024's reserved `role: 'admin'` decision with any consumer that used `admin` as a member role,
and (2) re-review of the SDD sections changed for this ADR. Not done here: adding
`typeorm`/`pg` and wiring `db/migrations` into a migration runner, and a CI job that runs
`db/tests/run.sh` against a PostgreSQL service container.


## Test matrix for the owner / operator / member requirements (migration `0002`)

**Executed** = run by `db/tests` (database behavior). **Executed (e2e)** = run by `test/*.e2e-spec.ts` against the real service and database.

### Owner

| Requirement | Status |
|---|---|
| Owner can access Platform A / Platform B | **Executed** (`ALLOW_OWNER` for both, no assignment rows) |
| Owner needs no `PlatformAssignment`; cannot even be an assignment's operator | **Executed** |
| Owner cannot access another Company's Platform | **Executed** (`DENY_OTHER_COMPANY`) |
| Second factors exist and are well-formed (TOTP ciphertext only; passkey public material only; unique `credentialId`; owner-only) | **Executed** |
| Step-up is short-lived (≤15 min), single-use, same-owner factor, immutable, undeletable, owner-only | **Executed** |
| Secret key is not storable in plaintext (only a 64-hex digest) | **Executed** (storage); "never returned after issuance" — *specified* |
| Owner authenticates normally (password → `mfa_required` → factor → tokens; no tokens on password alone) | **Executed (e2e)** |
| Sensitive operations refuse without a valid step-up (missing/expired/consumed/other-owner/other-purpose/other-session), and a failed operation does not burn the step-up | **Executed (e2e)** |
| Rotation accepts only TOTP/passkey step-up, not the secret key | **Executed (e2e)** |
| Recovery revokes factors and sessions and spends the key | **Executed (e2e)** |
| Owner can perform allowed company-level operations | **Executed (e2e)** for grant/revoke/create-operator/factor/secret-key/password; other company-level operations do not exist yet |

### Operator

| Requirement | Status |
|---|---|
| Code stored only as a digest (raw 6-digit code unstorable) | **Executed** (HMAC-with-pepper is *specified*) |
| Code cannot be consumed after expiry / after lockout (5 attempts) | **Executed** |
| One live code per (operator, purpose); consumed code frees the slot; history retained (supersede, never delete) | **Executed** |
| Operator sessions carry a ceiling; no refresh token can exceed it; owners/members cannot carry one | **Executed** |
| Access to an assigned platform; denial for an unassigned one; denial after revocation; per-platform isolation | **Executed** (reference query) |
| Request code → verify → temporary session; wrong code `401`; expired code `401`; access-token `exp` clamped to the ceiling; next-day code needed; no code per API request | **Executed (e2e)** |
| Revocation works even while an older, unexpired token still exists (live assignment check on every platform-scoped call) | **Executed (e2e)** (`platform-authz.e2e-spec.ts`: same token, revoked assignment ⇒ `404`) |
| Zero schedule rows ⇒ available (fail-open) is returned as `NO_SCHEDULE_CONFIGURED`, never as denial | **Executed (e2e)** |

### Member

| Requirement | Status |
|---|---|
| Member needs email **or** phone and a password; neither/none rejected | **Executed** |
| Exactly one Organization; platform derived via Organization; cannot access another Organization | **Executed** |
| No `platformId`, no subscription/license/trial/plan/billing column on `user`/`organization`/`platform`/`company`/owner/operator | **Executed** |
| Login authenticates with email/phone + password and makes **no** `payment-service` call, even when the license lapsed or `payment-service` is down | **Executed (e2e)** |
| Platform-specific permissions stay outside Auth (`role` opaque; `admin` reserved) | **Executed** (reserved value) + design |

### Tenancy attacks (all must fail)

| Attack | Status |
|---|---|
| Owner of Company A → Platform of Company B | **Executed** (denied) |
| Operator of Company A → Platform of Company B | **Executed** (denied) |
| Assignment for Company A → Operator of Company B | **Executed** (`23503`) |
| Assignment for Company A → Platform of Company B | **Executed** (`23503`) |
| `revokedBy` an Owner of another Company | **Executed** (`23503`) |

### Database integrity

`Owner.companyId`, `Operator.companyId`, `Platform.companyId`, `Organization.platformId` immutable;
subtype integrity on INSERT *and* DELETE (deleting an Owner/Operator row while the user remains is
rejected at commit; deleting both together commits); one Owner per Company; active-assignment
uniqueness (race included); append-only assignment history; same-company `assignedBy`/`revokedBy` —
all **Executed**.

### Known gaps in this test evidence

- No browser/real-authenticator interop: WebAuthn is verified against a *software* ES256 authenticator
  (`test/helpers/authenticator.ts`) that produces cryptographically valid responses; real devices and
  attestation formats other than `none` are untested.
- TOTP is verified against `otplib` itself (RFC 6238 vectors are the library's responsibility).
- No load/soak test of the rate limiter; the numbers are unmeasured defaults.
- `session_replication_role = replica` and `TRUNCATE` bypass triggers/FKs; the protection is database
  privilege management, which is not tested here.
- Notification delivery, the RabbitMQ transport, payment-service and the endpoints listed as
  "designed but not implemented" (security review §G) have no tests because they do not exist.

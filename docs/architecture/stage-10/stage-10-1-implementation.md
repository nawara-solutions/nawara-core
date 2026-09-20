# Stage 10.1 implementation: what is built, what is verified, what remains

- **Status:** implementation record. **Authority is not activated in any environment, no production data was touched, no cutover was
  performed, and no production gate (ADR-0040 G1 to G7) is met.** The implementation is **incomplete**: the list of remaining work
  is in section 4.
- **Date:** 2026-09-20
- **Governing decisions:** [ADR-0039](../../adr/0039-organization-ownership-and-cross-service-migration-authority.md), [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md) (Accepted, Amendments 1 and 2), [ADR-0041](../../adr/0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md), [ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md) (Accepted, Amendments 1 and 2), the [owner sheet](./stage-10-bd4-owner-decisions.md).

## 1. What is implemented

| Area | Implementation | Where |
|---|---|---|
| **Snapshot integrity** | deterministic canonical JSON, per-table and whole-artifact SHA-256, offline verification; identical data gives identical bytes; the artifact never records a time | `libs/service-kit/src/snapshot/`, tests in `libs/service-kit/test/snapshot.spec.ts` |
| **Export (auth-service)** | one `REPEATABLE READ` snapshot, canonical bytes, `--final` only under the freeze, refused once auth-service is only a reference cache | `apps/auth-service/src/hierarchy/` |
| **Freeze and mirror (auth-service)** | migration `0008` (inert): marker `local`, `frozen`, `org_authoritative`; triggers refuse all hierarchy writes when frozen, and allow only the reference-cache protocol (never a delete, never an anchor change) when `org_authoritative`; **no way back** | `db/migrations/0008_*.sql` (+ down that refuses once not local), CLI `hierarchy-*` |
| **`bootstrap-owner` (auth-service)** | in the authoritative mode it never creates a Company: it needs `BOOTSTRAP_COMPANY_ID` and an existing validated reference row | `src/cli/owner-tools.ts` |
| **Import (organization-service)** | validation before any write (integrity, shape, values, duplicate ids, cross-table ids, relationships); one-transaction compare-and-insert; a differing row or an extra destination row **aborts**; never updates or deletes; repeatable; verified by content digest afterwards | `src/ownership/hierarchy-snapshot.ts`, `ownership-admin.ts` |
| **State machine** | `PREPARED`, `VERIFIED`, `FROZEN`, `ACTIVATABLE`, `ACTIVE`, `RETIRED` (a fresh environment skips `FROZEN`); illegal transitions, missing evidence, a changed environment class and every backward move after `ACTIVE` are refused **by the database** | migration `0004_ownership_transition.sql` |
| **Explicit activation** | `approve` records who and the rehearsal reference; `activate` needs `ACTIVATABLE`, the confirmation `ACTIVATE-AUTHORITY` and an unchanged content digest; in production also `OWNERSHIP_PRODUCTION_ACTIVATION=enabled` for that run. Deployment, startup, migration, health checks, connections and import never activate | `ownership-admin.ts`, CLI `npm run ownership` |
| **One-way door** | no backward transition after `ACTIVE`; `rollback` is refused with the audit row and the log event `ownership_rollback_rejected`; there is no "force" path | migration `0004`, `ownership-admin.ts` |
| **I1** | `hierarchy_id_ledger`: an id is never reused, even after a schema owner discards a prepared row | migration `0004` |
| **I2(a)** | parents never change (existing triggers), verified again | migration `0001`, tests |
| **I2(b)** | the runtime role cannot delete or truncate; once authoritative no role can | migration `0004` |
| **Application guard** | while not authoritative every hierarchy write and every service read is `409 not_authoritative`; only the fresh first-Company bootstrap and Auth's full read for `ensure` are allowed | `src/ownership/ownership.service.ts` |
| **Audit and observability** | append-only `ownership_event` (actor, operation, environment, correlation id, from and to phase, snapshot digest, outcome); structured events `ownership_snapshot_verified`, `ownership_import_started`, `ownership_import_succeeded`, `ownership_import_failed`, `ownership_activation_requested`, `ownership_activation_succeeded`, `ownership_activation_rejected`, `ownership_retirement_completed`, `ownership_rollback_rejected`; no secret is logged | `ownership-admin.ts` |
| **Service authorization** | startup-validated `SERVICE_POLICY`: capabilities per caller, explicit `allowedPlatforms` (no wildcard), `hierarchy.write` unassignable, provisioning a dedicated identity alone and outside scope; `ServicePolicyGuard` after authentication; every route declares one capability | `src/authorization/` |
| **Platform scope** | Organization Service resolves organization to platform and evaluates the credential's explicit set; reads and lists are filtered; out of scope is a collapsed `404`; a client never supplies the scope | `src/authorization/`, `src/reference/` |
| **Provisioning** | `hierarchy.provision` on `POST /organization/companies` only; the first Company of a fresh, still inactive environment is created through it | controllers, `OwnershipService` |
| **Least privilege (schema side)** | the runtime role has no write on the ownership tables and no delete or truncate on the hierarchy (conditional on the conventional `organization_app` role); the CLI requires the operations login; the service still refuses a superuser or migrator runtime login in production | migration `0004`, `organization-config.ts` |
| **Repository guards** | `npm run check:repo` now fails if the two golden snapshot fixtures differ, or if an invoice or payment migration carries a `platformId` | `scripts/lib/checks.mjs` |

## 2. What was verified, and how

Against a real PostgreSQL 16 (scratch cluster, `TEST_DATABASE_ADMIN_URL`):

| Suite | Result |
|---|---|
| service-kit unit | 58 passed (includes 10 new snapshot tests) |
| organization-service unit | 97 passed |
| organization-service e2e | 204 passed (168 existing, kept; 36 new) |
| organization-service database invariants (`test:db`) | 47 of 47 |
| auth-service unit | 59 passed |
| auth-service e2e | 239 passed (230 existing, 9 new) |
| billing-service unit, e2e | 227 passed; 156 passed and 1 skipped (as before) |
| payment-service unit, e2e | 52 passed; 107 passed |
| repository checks | `check:repo` passes; `test:repo` 15 of 15 |
| lint and typecheck | clean for organization-service, auth-service and the kit |

The built `npm run ownership` CLI was run against a scratch database: migrations applied, an import refused before the class was
declared, an import audited, and activation refused before approval. The **Auth CLI commands were type-checked and their operations
tested as functions, but the Auth process was not run end to end** (it needs the full Auth secret configuration).

Tests that changed with the accepted architecture (none was weakened): the exact migration and table lists, the exact route set (the reference
read), the exact config keys, the OS-01 table-set invariant, the unreachable-database health specs (they opt out of the authoritative
setup), and the Stage 9 boundary tripwire, which now allows the ownership machinery **only** inside the ownership module and its CLI.
The older suites run against an authoritative service and the unrestricted test-fixture policy; the new suites use the real parser.

Known environment note: a full parallel run of Auth's e2e suite prints between 1 and 6 `57P01` "terminating connection" teardown errors
against an external cluster. It occurs **without** the new specs as well; every test passes.

## 3. The flows

Existing environment: `declare-class existing`, then `import` preparation snapshots (repeatable), `hierarchy-freeze`, `hierarchy-export --final`,
`import` (phase `FROZEN`), `approve`, `activate`, `hierarchy-retire`, `retire`. Fresh environment: `declare-class fresh`, the first Company through
the provisioning identity, `verify --expect-digest`, `approve`, `activate` (nothing to freeze or import). Rollback exists only before
activation. See the READMEs of the two services and ADR-0040 Amendment 2, A2.5 and A2.6.

## 4. Not implemented (follow-up required)

1. **Human administration in Organization Service:** the Auth read endpoint for the caller's own grant facts, the Organization Service
   evaluator (owner, operator, organization administrator) and the human routes, and the sensitive-operation flags.
2. **Operator step-up (DEC-1):** the operator-sensitive purposes, the session binding, the short window, the authenticated request route and the
   verify-and-consume endpoint in Auth. The operator working code is **not** reused as it is.
3. **Auth's reference cache:** `ensure(id)` (Company, Platform, Organization; parents first; validated; fail closed), Auth's outbound client
   to Organization Service, its first-touch flows in the six administrative paths, and the cache-write guard beyond the database guard already
   present. Until then a fresh environment cannot complete its Auth-side bootstrap.
4. **The durable actor record** for Organization Service writers (ADR-0042 decision 9): denials are logged only.
5. **Production readiness (BD-7, gates G1 to G7):** the production topology and its approval; a deployment workflow and gated migrations for
   Organization Service; production database roles for both services (**Auth's production runtime is still a superuser**); the backup job and a
   restore verified on the real volume; monitoring and alerts; the rehearsal plan and one successful production-like rehearsal with recorded
   evidence; the approver. **None of it exists.**
6. **A cross-service integration test** (Auth exports, Organization Service imports) beyond the shared golden fixture and its repository check.
7. Billing and Payment reference clients (the callers of the reference read) are not built; they stay off until the cutover verification.

## 5. Decisions taken as implementation choices (for review)

Not architecture, and not approved by the owner beyond the accepted ADRs: `SERVICE_POLICY` as a JSON environment variable; the phase names
`PREPARED` to `RETIRED` mapped onto ADR-0040's `inactive` and `active`; the state row in Organization Service and the marker in Auth; the
`nawara.write_mode` and `nawara.reference_write` transaction settings; the write gate exempting the table owner and superuser (the runtime role
is the gated one); the operations login taken from `OWNERSHIP_ADMIN_DATABASE_URL`; `403 forbidden` for a denied capability with the reason only
in the log; the CLI flag names. The `platform_id` guard, the fixture check and the boundary tripwire changes are repository checks, not decisions.

# Core V2 A4: authentication

- **Status:** RECORD of the A4.0 discovery (read-only, owner-reviewed, 2026-10-08, on `main` at `16476f9`, the PR #242 merge that
  closed A3M.7) and of **A4.1: the A4 architecture record** (**prepared; pending CI and owner merge**). **A4 is OPEN.** No A4
  implementation exists yet; nothing in §§6–10 is implemented unless it is labelled **[CURRENT]**.
- **Labels.** **[CURRENT]**: true on `main` today. **[TARGET]**: approved by an owner decision, implemented by the named stage.
  **[PENDING DESIGN]**: approved in direction only; the named stage must design it and the owner must review it before code.
- **Scope of A4** ([roadmap](../CORE-ROADMAP.md) Core V2 table): sessions, MFA/TOTP, recovery, WebAuthn, cookies, rate limits, service
  authentication, account lifecycle and security. OD-A4-1 narrows it to **converging the existing Auth implementation on the shared kit**
  and **a JWT signing-key ring** (§4, §5).
- **Production.** A4 deploys nothing (OD-A4-7). Every merge touching Auth or the kit builds a revision-labelled Auth image (V2-A.2,
  build ≠ deploy); production Auth changes only through a separately authorized digest deployment (§11, §17).

## 1. Capability inventory (A4.0, verified on `main` at `16476f9`)

Paths are relative to `apps/auth-service/`.

| Capability | State | Evidence | Tests (`test/`) | ADR |
|---|---|---|---|---|
| Access JWT | implemented | `src/tokens/token.service.ts`: HS256 with `JWT_SECRET`, algorithm, issuer (`JWT_ISSUER`, default `nawara-auth`) and audience (`JWT_AUDIENCE`, default `nawara`) pinned on verify; claims `sub`, `role`, `sid`, optional `adminTier`; lifetime `ACCESS_TOKEN_TTL_SEC` (900, 30–3600) clamped to an operator's session ceiling; **no `kid`** | `tokens.e2e-spec.ts` | 0002 |
| Rotating refresh tokens, family revocation, reuse detection | implemented | `src/tokens/refresh-token.service.ts`: 256-bit random token, SHA-256 stored; one-time use; reuse of a rotated or revoked token revokes the whole family; ceiling copied forward | `tokens.e2e-spec.ts`, `concurrency.e2e-spec.ts` | 0002 |
| Live session validation | implemented | `src/auth/auth.guard.ts`: every protected route re-reads the user (kind, `isActive`) and requires the session family to be active | `tokens.e2e-spec.ts`, `hardening.e2e-spec.ts` | 0002, 0033 |
| Logout | implemented | `POST /auth/logout` revokes the refresh family (`src/auth/auth.service.ts`) | `tokens.e2e-spec.ts` | 0002 |
| Owner login and MFA (TOTP, WebAuthn, secret-key step-up) | implemented | `src/owner/` (factor, enrollment, step-up, challenge, webauthn, secret-key services); TOTP secrets encrypted with an id-keyed key ring (`src/crypto/totp-cipher.ts`) | `owner-auth.e2e-spec.ts`, `step-up.e2e-spec.ts`, `step-up-verify.e2e-spec.ts`, `webauthn.e2e-spec.ts` | 0025 |
| Owner recovery | implemented | `src/owner/recovery.service.ts`: password and secret key, cool-down, enrollment token; never a session | `recovery.e2e-spec.ts` | 0025 |
| Operator login and sessions | implemented | `src/operator/`: time-boxed code, schedule-anchored ceiling, block and unblock | `operator.e2e-spec.ts` | 0012, 0013, 0015, 0023 |
| WebAuthn | implemented (owners) | `@simplewebauthn/server`; production refuses an origin outside the RP ID (`src/config/app-config.ts`) | `webauthn.e2e-spec.ts` | 0025 |
| Rate limiting | implemented | 29 configurable buckets (`RateBucket` in `src/config/app-config.ts`), keyed with `THROTTLE_KEY_PEPPER` (`src/throttle/throttle.service.ts`), plus a baseline `ThrottlerGuard` (`BASELINE_RATE_LIMIT_PER_MINUTE`) | `hardening.e2e-spec.ts` | 0025 |
| Account lockout | throttling only | per-identifier buckets act as a soft lockout; no lockout state | `hardening.e2e-spec.ts` | – |
| Service authentication | implemented | other services authenticate users through Auth live (kit `libs/service-kit/src/service-auth/auth-client.ts`: `/auth/me`, `/auth/platform-access`); Auth calls Organization with a service token | `grants.e2e-spec.ts`, `platform-authz.e2e-spec.ts` | 0033, 0042 |
| Contact verification | implemented | `src/onboarding/contact-verification.service.ts`; `REQUIRE_CONTACT_VERIFICATION` (default false) | `onboarding.e2e-spec.ts` | – |
| Suspend and restore, operator block | implemented | `src/members/member-security.service.ts` (owner, factor step-up, closed reason list, revokes every session); `src/operator/operator-admin.service.ts` | `member-security.e2e-spec.ts`, `operator.e2e-spec.ts` | 0050 |
| Password change | owners only | `POST /auth/admin/password/change` (step-up) | `owner-auth.e2e-spec.ts` | 0025 |
| Member password reset | **absent** | no route or service | – | none |
| Cookie sessions | **absent** | tokens in response bodies; CORS `credentials: false` | – | none |
| Account deletion | **absent** (suspension exists) | no delete path | – | none |
| Authentication events | implemented; **off in production** | outbox events (`src/events/event-catalog.ts`), `AUTH_EVENTS`, `src/events/code-event-purge.ts` | `domain-events-outbox.e2e-spec.ts`, `events-real-broker.e2e-spec.ts` | 0052, 0057 |

Members authenticate with a password only; MFA is an owner capability (ADR-0025). Only Auth signs and verifies user JWTs: no other
service holds `JWT_SECRET` or verifies a user token locally (ADR-0033).

## 2. Binding decisions and existing guarantees

Accepted ADRs take precedence over this record.

| ADR (Accepted) | What A4 must respect |
|---|---|
| [0002](../adr/0002-jwt-access-token-with-rotating-refresh-token.md) | short-lived access JWT plus a database-backed refresh token rotated on every use, with family reuse detection |
| [0025](../adr/0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md) | owner MFA, secret-key step-up and the cool-down recovery path |
| [0033](../adr/0033-service-to-service-authentication-and-user-identity.md) | services **do not verify user tokens locally**; they ask Auth; service calls use per-pair service tokens; asymmetric signing with a key endpoint was considered and not chosen |
| [0042](../adr/0042-service-token-scopes-and-administrative-authorization.md) | service-token scopes and administrative authorization |
| [0056](../adr/0056-core-architecture-and-api-conventions.md) §12 | **[TARGET: A4]** Auth's bootstrap and configuration loader converge on the kit's where compatible, keeping `/auth/health`, localized validation and the `AuthExceptionFilter` contract |

### 2.1 Non-regression requirements [CURRENT, preserved by every A4 stage]

- `GET /auth/health`: 200 when the database answers, 503 `{ status: 'unavailable' }` otherwise (`src/health/health.controller.ts`).
- Localized validation errors in en, fr and ar (`LocalizedValidationPipe`, ADR-0054), English by default.
- `AuthExceptionFilter` (`src/errors.ts`): the kit's `{ statusCode, message, error, code?, requestId }` shape, plus any extra field on
  the exception's own response (today `reason: 'session_ceiling_reached'`), after `code` and before `requestId`; opaque 500s.
- The JWT: claims, issuer, audience, HS256, expiry and the session-ceiling clamp; `invalid_token` on any verification failure.
- Refresh-token rotation, family revocation on reuse, the session ceiling, logout.
- The live session check in `AuthGuard`.
- Owner MFA (TOTP, WebAuthn), step-up and recovery, as ADR-0025 states.
- The 29 throttling buckets: names, `RATE_<NAME>_LIMIT` / `RATE_<NAME>_WINDOW_SEC` variables and defaults.
- Service authentication contracts (`/auth/me`, `/auth/platform-access/:platformId`, the Organization client).
- `AUTH_EVENTS` semantics (exactly `on` or `off`; governs only whether domain-event rows are written; never the relay) and the
  mandatory code-event purge (`CodeEventPurge`).
- Production refusals: published development keys, weak or non-canonical keys, cross-purpose key reuse, the runtime database role
  (`assertRuntimeDatabaseRole` plus the `auth` owner), WebAuthn RP and https origins, `RABBITMQ_URL` required, strict `NODE_ENV`,
  `AUTH_EVENTS` and `REQUIRE_CONTACT_VERIFICATION` values. Configuration errors never echo a value.

## 3. Work inherited from earlier stages

| Source | Item |
|---|---|
| ADR-0056 §12; [A1](core-v2-a1-architecture.md) OD-A1-4 | Auth bootstrap and configuration loader convergence |
| [A2](core-v2-a2-configuration-and-secrets.md) §10.4, §10.6 | `SecretSource` → `EnvReader`; `_FILE` for `DATABASE_URL` and `RABBITMQ_URL`; the `NAME` + `NAME_FILE` rule; the JWT verification key ring; Auth docs credentials and CLIs on the kit helpers |
| [A15](core-v2-a15-developer-experience.md) §4, §7 | Auth's CLIs and loader; `GENERICITY_LEGACY_EXEMPT` until A4 converges Auth |
| [New-service checklist](../NEW-SERVICE-CHECKLIST.md) | Auth's filter, migration runner and loader are an accepted legacy case that A4 converges |
| [A3M](core-v2-a3m-messaging.md) §9 | Auth's emission, `AUTH_EVENTS` semantics and code purge are A4's; their production activation is A3M.8 |

## 4. Owner decisions (approved 2026-10-08)

| Id | Decision |
|---|---|
| OD-A4-1 | Scope: converge the existing Auth implementation and add a JWT signing-key ring. No cookie sessions, member password reset or other new authentication feature |
| OD-A4-2 | Adopt `EnvReader`'s rule: setting both `NAME` and `NAME_FILE` is refused; compatibility tests first |
| OD-A4-3 | Remove the unused `SecretSource` abstraction only where equivalent test injection and configuration behaviour are preserved |
| OD-A4-4 | Support `AuthExceptionFilter` through an explicit, reusable `configureApp` extension |
| OD-A4-5 | Narrow the genericity exemption to the two existing immutable migrations; never edit a historical migration |
| OD-A4-6 | A symmetric HS256 key ring with `kid`, legacy `JWT_SECRET` support and a staged rotation procedure; implementation (A4.7) follows the separately reviewed A4.6 design |
| OD-A4-7 | No production Auth deployment during A4; a merged stage may build an image, never deploy it |
| OD-A4-8 | Review ADR-0023 and ADR-0026 for possible acceptance; ADR-0017 stays with A5; no ADR status changes without separate authorization |

## 5. Out of scope

| Capability | Where it belongs |
|---|---|
| Cookie sessions, a backend-for-frontend | A16 (product integration) |
| Member password reset or self-service recovery | a product requirement first (A16); delivery needs A8 and `AUTH_EVENTS` (A3M.8, blocked by F1) |
| Account deletion or erasure | the erasure policy (P-A3), A7 and A13 legal decisions |
| Member MFA, account lockout state, new login methods | not proposed (OD-A4-1) |
| Enabling `AUTH_EVENTS` in production | A3M.8, after F1 (P-A1 / A14) |
| Authorization semantics | A6 |
| Organization authority, ADR-0017 | A5 |
| Local JWT verification by other services, asymmetric signing | excluded by ADR-0033 |
| Deploying Auth | a separate, owner-authorized checkpoint (§17) |

## 6. Configuration convergence (A4.2) [TARGET]

**[CURRENT]** `src/config/app-config.ts` reads secrets through `EnvSecretSource` and every other setting from `process.env` directly:

| Behaviour | Auth `EnvSecretSource` | Kit `EnvReader` (`libs/service-kit/src/config/config.ts`) |
|---|---|---|
| `NAME` and `NAME_FILE` both set | the file wins | refused: `set NAME or NAME_FILE, not both` |
| Trimming | file content only | the value, the `_FILE` path and the content |
| Empty value | unset | unset |
| Unreadable file | `NAME_FILE is set but the file cannot be read` | the same message |
| `_FILE` for `DATABASE_URL`, `RABBITMQ_URL`, `ORGANIZATION_SERVICE_URL`, `WEBAUTHN_*` | not supported (read directly) | supported |
| TOTP key ring | hand-written parser | `readKeyRing` (same format and id rule) |
| Docs credentials | `SWAGGER_PASSWORD` ≥ 16, username `docs` | `readDocsCredentials` (same rules) |
| Injection seam | `loadConfig(env, src: SecretSource)` | `new EnvReader(env, readFile)` |

**[TARGET]** requirements:
1. **Characterization first.** Before any change, tests pin every current variable, default, bound, production refusal and error message.
2. Every value is read through `EnvReader` and the kit helpers; `DATABASE_URL` and `RABBITMQ_URL` gain `_FILE` support.
3. Both `NAME` and `NAME_FILE` set is refused (OD-A4-2), with a test per secret.
4. `SecretSource` and `EnvSecretSource` are removed only when tests can still inject files and environments as today (OD-A4-3).
5. Unchanged: variable names, defaults and bounds; `TRUST_PROXY=true` meaning one hop (`loadTrustProxyHops`); unknown keys ignored
   (no strict unknown-key refusal); every production refusal of §2.1; no value ever echoed.
6. The error text of a refusal may change only where a test documents the new text and no operator procedure depends on the old one.

## 7. CLI convergence (A4.3) [TARGET]

**[CURRENT]** `src/cli/migrate.ts` reads `MIGRATION_DATABASE_URL` from `process.env` (no `_FILE`); `src/cli/main.ts` reads the
`BOOTSTRAP_*` variables directly and forces `AUTH_EVENTS=off`; failures are reported with the kit's `describeCliFailure`. The migration
runner is already the kit's (`runMigrations` with `src/db/migrations.ts` options `fileTransaction: 'strip'`, `strictHistory`,
`adoptLegacyChecksums`).

**[TARGET]** both CLIs read through `EnvReader` (`MIGRATION_DATABASE_URL_FILE` supported, both forms refused); the F4 bootstrap rules
(`BOOTSTRAP_COMPANY_NAME` required, an empty Auth database) and every refusal message stay; the migration options stay; nothing is
printed that is a value.

## 8. Bootstrap and exception filter (A4.4) [TARGET]

**[CURRENT]** `src/main.ts` assembles the kit parts itself: shutdown admission, request context, metrics, `helmet`, the localized
validation pipe, `AuthExceptionFilter`, the JSON logger, CORS without credentials, the trust-proxy hop count, shutdown hooks, and the
docs behind basic authentication. Nest's default body parser applies (100 KB). The kit's `configureApp`
(`libs/service-kit/src/bootstrap.ts`) installs the same parts but hard-codes `KitExceptionFilter`.

**[TARGET]** (OD-A4-4):
- `ConfigureAppOptions` gains an explicit, reusable way to supply the exception filter (a `KitExceptionFilter` subclass); every other
  service keeps today's default.
- Auth starts through `configureApp` with `bodyParser: false` and `BODY_LIMIT_KB` (kit default 100, equal to today's limit).
- Kept: `/auth/health`, the kit `HealthModule`, `AuthExceptionFilter`'s extra-field pass-through, CORS `credentials: false`, the
  baseline `ThrottlerGuard`, metrics, documentation mounted only with `SWAGGER_PASSWORD` (moved to a `src/docs/mount-docs.ts` like
  the other services).
- A kit change: the kit is rebuilt and every service using `configureApp` is regression-tested (§14).

## 9. Genericity exemption (A4.5) [TARGET]

**[CURRENT]** `GENERICITY_LEGACY_EXEMPT = new Set(['auth-service'])` (`scripts/lib/checks.mjs`) removes all of Auth from the
product-term check. Without it the check would report three places:
- `db/migrations/0004_organization_join_codes_and_membership.sql` (a comment);
- `db/migrations/0007_multi_organization_membership.sql` (a comment);
- `src/onboarding/dto.ts` (an OpenAPI example).

**[TARGET]** (OD-A4-5):
- The OpenAPI example is reworded; this is documentation text, not a contract.
- The service-wide exemption becomes an exemption for exactly the two migration files, which are applied and checksum-enforced
  (`strictHistory`) and are never edited.
- `test:repo` proves both directions: a product term elsewhere in Auth is reported, and the two files are not.

## 10. JWT key ring (A4.6 design, A4.7 implementation) [PENDING DESIGN]

**[CURRENT]** one HS256 secret, `JWT_SECRET`, held only by Auth; no `kid`. Replacing it ends every live access token (at most
`ACCESS_TOKEN_TTL_SEC` later); refresh tokens are opaque database rows and are unaffected.

**Direction (OD-A4-6):** a symmetric HS256 key ring with `kid`. Asymmetric signing is out of scope: no other service verifies user
tokens (ADR-0033).

A4.6 must design, and the owner must review before A4.7 starts:
- **Algorithm:** HS256 pinned on sign and verify; `none` and every other algorithm refused.
- **Key ids:** format, where they come from, and that a token's `kid` selects exactly one configured key. An unknown or retired `kid`
  is `invalid_token`, never a fallback to another key.
- **Legacy compatibility:** the existing `JWT_SECRET` keeps working with an unchanged production `.env`. A token without `kid` verifies
  only against the legacy key, and only while that key is configured.
- **Configuration:** variable names, `_FILE` support, distinctness from every pepper and TOTP key, the production refusals, and no
  value in any message or log.
- **Staged rotation:** (1) deploy with the ring containing the current key, still active; (2) add the new key; (3) activate it;
  (4) retire the old key after the longest access-token lifetime plus clock tolerance. Each step is a separate, authorized change.
- **Rollback:** an image without key-ring support verifies only with `JWT_SECRET`; rollback is safe while the active key is still
  `JWT_SECRET` and **unsafe once another key is active** (tokens signed with it would fail). The runbook states this limit.
- **Preserved:** claims, issuer, audience, expiry, the session-ceiling clamp, refresh-token semantics, the live session check.
- **Tests:** per-`kid` sign and verify, legacy token, unknown and retired `kid`, algorithm confusion, distinct-key and production
  refusals, the rotation sequence and the rollback boundary.
- A4 never selects, generates or activates a production signing key.

## 11. Deployment readiness (A4.8) [TARGET]

**[CURRENT]** production Auth runs `sha256:26164d42…5eaf`, the last automatic deployment (`97f78cb`, observed read-only on 2026-10-02;
[cutover record](stage-21/stage-21-x-cutover-record.md)). Every Auth change merged since then is built and not deployed, including
A2.3's stricter configuration parsing. A future deployment therefore carries all of it.

A future deployment needs its own explicit approval and a compatibility review covering:
- **Strict parsing:** exact `NODE_ENV`, `AUTH_EVENTS` (`on` / `off`), `REQUIRE_CONTACT_VERIFICATION` (`true` / `false`), published
  development keys refused, runtime database role.
- **`NAME` and `NAME_FILE` conflicts:** refused after A4.2. The deploy script writes direct values only
  (`deploy/provision-and-deploy.sh` `ensure`).
- **`TRUST_PROXY=true`:** the deploy script writes it; it must keep meaning one hop.
- **Unknown and stale keys:** `PAYMENT_SERVICE_TOKEN` and `PAYMENT_SERVICE_URL` may remain in a server `.env` (`ensure` never
  removes a key); Auth must keep ignoring unknown keys. Removing them is a separate production action.
- **JWT:** the existing `JWT_SECRET` must be accepted unchanged (§10).
- **WebAuthn:** `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` (production: `nawara-solutions.com`, `https://admin.nawara-solutions.com`)
  stay valid under the same startup checks.
- **Secret-safe validation:** A4.8 adds a configuration-check CLI that loads the configuration and prints only success or the
  `ConfigError` text, never a value, plus a runbook for a names-only audit of the server `.env` (owner-run).
- **Rollback:** limited once a new JWT key is active (§10).

## 12. Stages

| Stage | Objective | Branch | Decision or design gate | Deploy |
|---|---|---|---|---|
| A4.0 | discovery | – | owner review ✅ | no |
| A4.1 | this record; roadmap structure | `feature/core-v2-a4-1-authentication-record` | OD-A4-1 to -8 ✅ | no |
| A4.2 | configuration convergence (§6) | `feature/core-v2-a4-2-auth-config-convergence` | OD-A4-2, -3 ✅ | no |
| A4.3 | CLI configuration (§7) | `feature/core-v2-a4-3-auth-cli-config` | none | no |
| A4.4 | bootstrap convergence, kit filter option (§8) | `feature/core-v2-a4-4-auth-bootstrap` | OD-A4-4 ✅ | no |
| A4.5 | genericity exemption narrowing (§9) | `feature/core-v2-a4-5-auth-genericity` | OD-A4-5 ✅ | no |
| A4.6 | JWT key-ring design (§10) | `feature/core-v2-a4-6-jwt-key-ring-design` | owner review of the design; an ADR if the design changes a binding decision | no |
| A4.7 | JWT key-ring implementation (§10) | `feature/core-v2-a4-7-jwt-key-ring` | A4.6 reviewed and merged | no |
| A4.8 | deployment-readiness tooling (§11) | `feature/core-v2-a4-8-auth-deploy-readiness` | none | no |
| A4.9 | A4 local certification (§16) | `feature/core-v2-a4-9-certification` | – | no |

Each stage is one pull request from `origin/main`, merged by the owner with green Core CI. No stage mixes unrelated features.

## 13. Dependencies and acceptance criteria

| Stage | Depends on | Done when |
|---|---|---|
| A4.1 | A4.0 | this record and the roadmap structure are merged |
| A4.2 | A4.1 | characterization tests merged first in the stage; every value read through `EnvReader`; `_FILE` for `DATABASE_URL` and `RABBITMQ_URL`; both forms refused; §2.1 production refusals and §6 item 5 unchanged; `SecretSource` removed only with equivalent injection (OD-A4-3) |
| A4.3 | A4.2 | both CLIs on `EnvReader`; `MIGRATION_DATABASE_URL_FILE` works; F4 bootstrap rules and refusal messages unchanged |
| A4.4 | A4.2 | the kit option exists and is tested; Auth starts through `configureApp`; every §2.1 HTTP contract passes its existing e2e tests unchanged; other services' behaviour unchanged |
| A4.5 | A4.1 | the exemption names only the two migrations; `test:repo` shows both directions; no migration edited |
| A4.6 | A4.2 | the design of §10 is written and owner-reviewed; any change to a binding decision is an ADR |
| A4.7 | A4.6 | §10's tests pass; legacy `JWT_SECRET` works unchanged; no key generated or activated |
| A4.8 | A4.2, A4.7 | the configuration-check CLI never prints a value (tested); the deploy runbook lists §11's review |
| A4.9 | A4.2 to A4.8 | §16 met |

## 14. Validation per stage

The [V2 validation protocol](core-v2-a-baseline-and-change-safety.md#8-v2-per-capability-validation-protocol) applies,
proportionately:

| Stage | Checks |
|---|---|
| A4.1, A4.6 (documentation) | `check:repo`, `git diff --check`, link and path checks |
| A4.2, A4.3 | Auth lint and typecheck; `src/config/app-config.spec.ts` with deliberate mutants on the new rules; e2e `secrets`, `owner-tools`, `smoke`, `health-readiness`. No broker, cross-service or kit-dependent runs: neither the kit nor events change |
| A4.4 (kit change) | kit build with fresh `dist/`; kit tests; Auth e2e `error-codes`, `auth-localization`, `logging`, `health-readiness`, `smoke`; the e2e suites of the other services that use `configureApp`; `test:e2e:auth-organization`. No broker campaign: messaging is unchanged |
| A4.5 | `test:repo` with fixtures for both directions; `check:repo` |
| A4.7 | Auth unit; e2e `tokens`, `owner-auth`, `step-up`, `operator`, `concurrency`; mutants for algorithm confusion, unknown `kid` and the legacy fallback |
| A4.8 | CLI tests; `test:deploy` only if a deploy script changes |
| A4.9 | records-based; the merged pull requests' CI is the evidence |

Reused, not repeated: the A1, A2, A15 and A3M evidence. Not part of A4: G6, production checks, Final Core Validation.

## 15. Open risks and responsibilities

| Risk | Owner |
|---|---|
| The first Auth deployment after A4 carries every change since `97f78cb` | owner, at the deployment checkpoint (§11, §17) |
| A loader change could refuse production's configuration at startup | A4.2 (characterization), A4.8 (configuration check), owner review before deploy |
| Rollback is unsafe once a new JWT key is active | A4.6 runbook; owner at each rotation step |
| F1 (forged Auth events to Notification) | P-A1 / A14; `AUTH_EVENTS` stays off (A3M.8) |
| Peppers cannot be rotated (A2 accepted limitation) | recorded; A4 does not change it |
| Passkeys enrolled under the former RP ID no longer work | product integration (re-enrollment UI) |
| ADR-0023 and ADR-0026 remain Proposed | owner review (OD-A4-8) |
| ADR-0017 | A5 |

## 16. Local certification criteria (A4.9)

1. A4.2 to A4.8 are closed on `main` with green Core CI, each meeting §13.
2. ADR-0056 §12's `[TARGET: A4]` is shown met: Auth uses the kit's configuration reader and `configureApp`.
3. Every §2.1 guarantee is shown unchanged by the existing tests.
4. The JWT key ring works with the legacy `JWT_SECRET` and no production key was generated or activated.
5. No Auth deployment occurred; `AUTH_EVENTS` unchanged; F1 and F2 untouched; ADR statuses unchanged unless separately authorized.
6. The A4.9 record lists what was not run and the open risks of §15.

## 17. Production Auth deployment: excluded

A4 certifies the repository and local evidence only. Deploying an Auth image built from A4, introducing or activating a new JWT signing
key, cleaning a server `.env`, and enabling `AUTH_EVENTS` are each a separate, owner-authorized production checkpoint under the
[Auth deployment runbook](../runbooks/auth-service-deploy.md) and the protected `production` environment. G6 stays deferred; Final Core
Validation stays the absolute last validation.

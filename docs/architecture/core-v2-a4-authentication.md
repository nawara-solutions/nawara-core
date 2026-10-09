# Core V2 A4: authentication

- **Status:** RECORD of the A4.0 discovery (read-only, owner-reviewed, 2026-10-08, on `main` at `16476f9`, the PR #242 merge that
  closed A3M.7) and of **A4.1: the A4 architecture record** (PR #243). A4.2 to A4.5 are merged (PRs #244 to #247, `main` at
  `e039ed6`); their sections keep the text they were approved with. **A4.6** (§10 design,
  [ADR-0058](../adr/0058-access-token-signing-key-ring.md)) is merged (PR #248, `8d62b3f`), and ADR-0058 is **Accepted** (2026-10-08,
  PR #249). **A4.7** (§10 implementation, §10.11) is merged (PR #250, `f95956b`); **A4.8** (§11, §11.1) is merged (PR #251,
  `d3dd2fd`). **A4.9** (§18, local certification) is merged (PR #252,
  `f90787a`; 24 of 24 required checks, including `core-ci-passed` and the real-image check of §18.5): **A4 is CLOSED and locally
  certified on repository and CI evidence.** **Nothing in A4 is deployed**: production Auth still runs the pre-A4 image, no JWT key ring is configured anywhere, and every
  production step stays a separate, owner-authorized checkpoint (§17).
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

## 10. JWT key ring (A4.6 design, A4.7 implementation) [TARGET: A4.7, implemented in §10.11]

Designed in A4.6 under the owner's decisions of §10.2 and stated as [ADR-0058](../adr/0058-access-token-signing-key-ring.md)
(**Accepted** on 2026-10-08 by a separate, explicit owner decision after the design was merged). Nothing in §10.3–§10.9 is
implemented until A4.7 merges. **No production key is generated, delivered, activated or retired by this design, by A4.7 or by any A4
stage (§10.10).**

### 10.1 Current behaviour [CURRENT]

- `src/tokens/token.service.ts` signs with jose `SignJWT`, protected header exactly `{"alg":"HS256"}` (no `kid`, no `typ`), claims
  `sub`, `role`, `sid`, optional `adminTier`, `iss`, `aud`, `iat`, `exp`; `exp` is `ACCESS_TOKEN_TTL_SEC` (default 900, 30–3600) clamped
  to the session ceiling.
- It verifies with `jwtVerify(token, JWT_SECRET, { algorithms: ['HS256'], issuer, audience, currentDate })` (no clock tolerance), then
  requires string `sub`, `sid` and `role`. Any failure is `401 invalid_token`. `AuthGuard` then re-reads the user (active, tier) and
  requires the `sid` session to be live.
- `JWT_SECRET` (or `JWT_SECRET_FILE`) is read by the kit's `readKey`: canonical standard base64, at least 32 bytes, in production no
  published development key and no non-random key; `assertDistinctKeys` keeps it distinct from the four peppers and every TOTP key.
  Errors name the variable, never the value.
- One key, held only by Auth (ADR-0033). Replacing it rejects every live access token; refresh tokens are opaque database rows and are
  unaffected, so clients recover by refreshing.

### 10.2 Owner decisions (A4.6, approved 2026-10-08)

| Id | Decision |
|---|---|
| D1 | `JWT_SIGNING_KEYS` and `JWT_ACTIVE_KEY_ID`, with the reserved active value `legacy` meaning `JWT_SECRET` |
| D2 | A shared, optional key-ring parser in `libs/service-kit` (A4.7) that preserves every existing kit behaviour |
| D3 | ADR-0058, Access-token Signing Key Ring, written with status Proposed |
| D4 | The JWT signing ring holds at most three keys |
| D5 | The legacy key is retired no earlier than 3600 s + 5 min after the last token signed with it, subject to §10.8 |
| D6 | The Auth provisioning script is corrected in A4.8, before any production retirement of `JWT_SECRET` |
| D7 | No per-key verification metric in A4.7 |

### 10.3 Configuration [TARGET: A4.7]

| Variable | Role |
|---|---|
| `JWT_SECRET` | unchanged; the **legacy key**: signs when the active id is `legacy`, verifies kid-less tokens while set |
| `JWT_SIGNING_KEYS` | optional ring `id:base64[,id:base64]`, at most 3 entries (D4) |
| `JWT_ACTIVE_KEY_ID` | a ring id, or `legacy`; required exactly when `JWT_SIGNING_KEYS` is set |

All three accept `NAME_FILE` through `EnvReader`; `NAME` and `NAME_FILE` together are refused, as for every Auth variable.

| `JWT_SECRET` | `JWT_SIGNING_KEYS` | `JWT_ACTIVE_KEY_ID` | Result |
|---|---|---|---|
| set | – | – | **today's behaviour**, byte for byte (an unchanged production `.env`) |
| – | – | – | refused: `JWT_SECRET` is required (the existing refusal) |
| any | set | – | refused: `JWT_SIGNING_KEYS and JWT_ACTIVE_KEY_ID must be set together` |
| any | – | set | refused: the same message |
| set | set | `legacy` | signs with `JWT_SECRET` (kid-less); ring keys verify only |
| – | set | `legacy` | refused: `JWT_ACTIVE_KEY_ID is legacy but JWT_SECRET is not set` |
| set | set | a ring id | signs with that key; `JWT_SECRET` still verifies kid-less tokens |
| – | set | a ring id | signs with that key; kid-less tokens are refused (legacy retired) |
| any | set | not `legacy`, not in the ring | refused: `JWT_ACTIVE_KEY_ID does not name a key in JWT_SIGNING_KEYS` |

Key-material rules, all at startup:
- Ring ids follow the kit's key-ring id rule (1–32 of `A-Z a-z 0-9 _ -`). `legacy` is **reserved**: refused as a ring id in any letter
  case (`JWT_SIGNING_KEYS must not use the reserved key id legacy`). Ids are public (they appear in every token header) and must not
  encode anything secret; a date-style id such as `k2026-10` is the convention.
- No repeated id, no repeated key, more than 3 entries refused (`JWT_SIGNING_KEYS must hold at most 3 keys`).
- Every ring key passes the same rules as `JWT_SECRET`: canonical standard base64, at least 32 bytes, and in production neither a
  published development key nor non-random.
- **Distinctness:** one `assertDistinctKeys` call covers `JWT_SECRET` (when set), every ring key, the four peppers and every TOTP key
  (`<NAME> must differ from <NAME> (one key, one purpose)`).
- **No value is ever echoed:** every refusal names variables and rules only, never a value, decoded bytes, a fingerprint or a key id
  taken from the value. The quoted texts are the intended ones; A4.7 may adjust wording only where a test pins the final text.
- **Shared parser (D2):** the kit gains an optional ring reader next to `readKeyRing`, reusing its id rule and `decodeKey`. Existing
  helpers (`readKeyRing`, `readKey`, `readOptionalKey`, `decodeKey`, `assertDistinctKeys`) keep their behaviour and messages; any new
  rule, such as the entry cap, is an opt-in option, so Notification's and Auth's TOTP rings are unaffected. The `legacy` and pairing
  rules are Auth's, not the kit's.

### 10.4 Signing and token compatibility [TARGET: A4.7]

- HS256 only.
- Active `legacy`: protected header exactly `{"alg":"HS256"}`, byte-compatible with today's tokens and with an image that has no ring.
- Active ring id: `{"alg":"HS256","kid":"<id>"}`.
- No other header parameter is added. Claims, `iss`, `aud`, `iat`, `exp`, the session-ceiling clamp and `expiresIn` are unchanged.
- No other service is affected: none verifies user tokens (ADR-0033); clients treat the token as an opaque bearer.

### 10.5 Verification [TARGET: A4.7]

1. `algorithms: ['HS256']` stays pinned; a header `alg` other than `HS256` is refused before any key is chosen (`none`, `HS384`,
   `HS512`, any asymmetric algorithm).
2. The key is chosen from the protected header that jose verifies (jose's key-resolver form), never from a separately parsed header:
   - no `kid` → the legacy key if `JWT_SECRET` is set, otherwise refused;
   - a `kid` that is not a string, breaks the id rule, equals `legacy` in any case, or names no configured key → refused.
3. The token is verified with **that one key only**. There is **no fallback** to the active key, the legacy key or any other key.
4. Keys carried or referenced by the header (`jwk`, `jku`, `x5u`, `x5c`) are never used; unknown `crit` parameters stay refused (jose).
5. Issuer, audience, expiry (no added clock tolerance) and the `sub` / `sid` / `role` checks are unchanged; `AuthGuard`'s live checks
   are unchanged.
6. Every failure is the existing `401 invalid_token`; nothing about the token, its `kid` or the chosen key is logged.

**Unknown and retired keys:** a retired key is one removed from configuration, so its tokens fall under "names no configured key". No
separate denylist exists.

**Downgrade:** the protected header is part of the HMAC input, so removing or changing a `kid` invalidates the signature unless the
attacker holds the key it would then select. The only downgrade target is the legacy key, for kid-less tokens; §10.8 bounds how long it
stays configured.

### 10.6 Staged rotation [TARGET: procedure; every step owner-authorized]

Each step is a separate configuration change and Auth restart, authorized by the owner at that step. Steps 1 and 2 stay separate even
though Auth runs one container, so the procedure stays correct with more than one instance.

| Step | Change | Signs with | Verifies | Image rollback to a pre-ring image |
|---|---|---|---|---|
| 0 | deploy the A4.7 image, `.env` unchanged | `JWT_SECRET`, kid-less | kid-less | safe |
| 1 | add `JWT_SIGNING_KEYS=<new>:…`, `JWT_ACTIVE_KEY_ID=legacy` | `JWT_SECRET`, kid-less | kid-less; `<new>` | safe |
| 2 | `JWT_ACTIVE_KEY_ID=<new>` | `<new>` | kid-less; `<new>` | **rejects every `<new>` token** until clients refresh |
| 3 | wait (§10.8) | `<new>` | as step 2 | as step 2 |
| 4 | remove `JWT_SECRET` | `<new>` | `<new>` only | needs `JWT_SECRET` restored, and still rejects `<new>` tokens |

A later rotation repeats steps 1–4 between ring keys: add the next key (active unchanged), activate it, wait the same delay measured
from the activation, remove the previous key. **Emergency:** a compromised key is removed (and, if it was active, another key activated)
in one change; its tokens are rejected at once and clients refresh.

### 10.7 Rollback boundaries [TARGET]

- **Image rollback** to an image without the ring is safe only while the active key is `legacy` (steps 0–1). After step 2 it rejects
  every token signed with a ring key until clients refresh; after step 4 it also needs `JWT_SECRET` restored. An image without the ring
  ignores `JWT_SIGNING_KEYS` and `JWT_ACTIVE_KEY_ID` (Auth ignores unknown keys, §6 item 5).
- **Configuration rollback** (active back to `legacy` or to the previous ring key, the newer key kept in the ring) is safe at every step
  before the previous key is removed. A return to `legacy` restarts the §10.8 delay.
- **Sessions:** no rollback touches refresh tokens, families, the session ceiling or logout. A rejected access token is recovered by a
  refresh, which signs with the then-active key.

### 10.8 Legacy-key retirement (step 4) conditions [TARGET]

`JWT_SECRET` is removed from production only when **all** hold:
1. At least **3600 s + 5 min** have passed since the last token signed with it, that is, since the restart that made a ring key active,
   with no return to `legacy` since (D5). 3600 s is the largest accepted `ACCESS_TOKEN_TTL_SEC`, so the rule does not depend on the
   configured lifetime.
2. The A4.8 provisioning change is merged (D6): `apps/auth-service/deploy/provision-and-deploy.sh` no longer generates `JWT_SECRET` when the ring is
   configured, so a later provisioning cannot silently reintroduce a legacy key.
3. A4.8's configuration check (§11) passes on the target configuration without `JWT_SECRET`, printing no value.
4. The owner authorizes the step explicitly, acknowledging the §10.7 image-rollback limit after retirement.

### 10.9 A4.7 test-first contract [TARGET: A4.7]

Tests are written first and fail before the implementation.

- **Kit** (`libs/service-kit/test/key-material.spec.ts`): the optional ring reader (unset → none; format, id rule, repeats, opt-in
  entry cap, production rules); the existing `readKeyRing` and helper tests unchanged and green.
- **Configuration** (`src/config/app-config.spec.ts`): the legacy-only `.env` and `JWT_SECRET_FILE` load as today; every row of the
  §10.3 table; the reserved id in each letter case; malformed entry, short key, repeated id or key, more than 3 keys; each ring key
  equal to `JWT_SECRET`, a pepper or a TOTP key; production published and non-random keys; `NAME` + `NAME_FILE` for both new variables;
  no value, decoded key or id in any error (the existing `refused` pattern).
- **Tokens** (new `src/tokens/token.service.spec.ts`, fixed clock):
  - active `legacy`: header exactly `{"alg":"HS256"}`; a plain `jwtVerify(token, JWT_SECRET)`, standing for a pre-ring image, accepts it;
  - active ring id: header carries the `kid`; the token verifies;
  - a legacy token verifies while `JWT_SECRET` is set and is refused once it is removed;
  - refused: unknown `kid`, retired `kid`, `kid` `legacy`, non-string `kid`, a legacy-signed token labelled with a ring `kid`, a ring
    token with its `kid` removed, `alg` `none`, `HS384` / `HS512` signed with a configured key;
  - the rotation sequence of §10.6: a token minted at each step checked against each later step; the rollback boundary (a step-2
    token refused by a legacy-only verifier, accepted at step 1 configuration);
  - claims, issuer, audience, expiry and the session-ceiling clamp unchanged.
- **e2e:** `tokens.e2e-spec.ts` gains an unknown-`kid` forgery and follows the new configuration shape; `owner-auth`, `step-up`,
  `step-up-verify`, `operator` and `concurrency` pass unchanged.
- **Mutants** (each must fail a test): drop the algorithm pin; fall back to another key for an unknown `kid`; verify a kid-less token
  with a ring key; accept `kid` `legacy`; drop the entry cap; drop a ring key from the distinctness check.
- **Unchanged by A4.7:** the provisioning script, the rotation runbook, every production `.env`; no key generated or activated.

### 10.10 Production: not authorized

This design, ADR-0058 and A4.7 authorize **no** production key generation, delivery, activation or retirement and no deployment. Each
rotation step of §10.6 and the first deployment of a ring-capable image are separate, owner-authorized production checkpoints (§17)
under the protected `production` environment.

### 10.11 A4.7 implementation (merged, PR #250)

Implemented as designed in §10.3–§10.5, test-first as §10.9 states; production is unchanged (no image deployed, no ring configured).

| Part | Implementation |
|---|---|
| Kit (D2) | `readOptionalKeyEntries(reader, name, rules, { maxEntries? })` in `libs/service-kit/src/config/key-material.ts`: undefined when unset; `readKeyRing`'s id rule, key rules, repeat checks and messages; the cap only when requested (`<NAME> must hold at most <n> keys`). `readKeyRing` and the other helpers are unchanged |
| Configuration | `src/config/app-config.ts`: `jwt.legacyKey` (`JWT_SECRET`, optional), `jwt.ring` (`JWT_SIGNING_KEYS`, empty when unset), `jwt.activeKeyId` (`JWT_ACTIVE_KEY_ID`, or `legacy`); the §10.3 table with the quoted messages; ring keys in the one `assertDistinctKeys` call |
| Tokens | `src/tokens/token.service.ts`: the active key signs (`{"alg":"HS256"}` for `legacy`, `{"alg":"HS256","kid":"<id>"}` for a ring key); jose's key resolver selects exactly one key from the verified protected header, with no fallback; `algorithms: ['HS256']` kept |
| Tests | kit `key-material.spec.ts`; Auth `app-config.spec.ts`, new `token.service.spec.ts` (characterization first, then the ring, the §10.6 rotation matrix and the image-rollback boundary); `tokens.e2e-spec.ts` (unknown and `legacy` kids, a ring app with `JWT_SECRET` retired) |

**Left to A4.8 by A4.7** (now §11.1): the provisioning-script change (D6), the configuration-check CLI and the rotation runbook; the
A4.6 acceptance-review follow-ups: an emergency procedure for a compromised legacy key before D6 is in use, never reusing a retired key
value, measuring the §10.8 delay from the last Auth instance, and the exact script path `apps/auth-service/deploy/provision-and-deploy.sh`.
Every production step stays an owner-authorized checkpoint (§10.10).

## 11. Deployment readiness (A4.8) [TARGET]

**[CURRENT]** production Auth runs `sha256:26164d42…5eaf`, the last automatic deployment (`97f78cb`, observed read-only on 2026-10-02;
[cutover record](stage-21/stage-21-x-cutover-record.md)). Every Auth change merged since then is built and not deployed, including
A2.3's stricter configuration parsing. A future deployment therefore carries all of it.

A future deployment needs its own explicit approval and a compatibility review covering:
- **Strict parsing:** exact `NODE_ENV`, `AUTH_EVENTS` (`on` / `off`), `REQUIRE_CONTACT_VERIFICATION` (`true` / `false`), published
  development keys refused, runtime database role.
- **`NAME` and `NAME_FILE` conflicts:** refused after A4.2. The deploy script writes direct values only
  (`apps/auth-service/deploy/provision-and-deploy.sh` `ensure`).
- **`TRUST_PROXY=true`:** the deploy script writes it; it must keep meaning one hop.
- **Unknown and stale keys:** `PAYMENT_SERVICE_TOKEN` and `PAYMENT_SERVICE_URL` may remain in a server `.env` (`ensure` never
  removes a key); Auth must keep ignoring unknown keys. Removing them is a separate production action.
- **JWT:** the existing `JWT_SECRET` must be accepted unchanged (§10.3).
- **JWT provisioning (D6):** `apps/auth-service/deploy/provision-and-deploy.sh` `ensure`d `JWT_SECRET`, generating one whenever it
  was absent. A4.8 generates it only when **none** of the six JWT variable forms is present (`JWT_SECRET`, `JWT_SECRET_FILE`,
  `JWT_SIGNING_KEYS`, `JWT_SIGNING_KEYS_FILE`, `JWT_ACTIVE_KEY_ID`, `JWT_ACTIVE_KEY_ID_FILE`), refuses a duplicate or malformed JWT
  line before changing anything, and documents the §10.6 rotation procedure in
  [`docs/runbooks/secret-rotation.md`](../runbooks/secret-rotation.md) §4 (§11.1). No production retirement of `JWT_SECRET` before this
  change (§10.8).
- **WebAuthn:** `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` (production: `nawara-solutions.com`, `https://admin.nawara-solutions.com`)
  stay valid under the same startup checks.
- **Secret-safe validation:** A4.8 adds a configuration-check CLI that loads the configuration and prints only success or the
  `ConfigError` text, never a value, plus a runbook for a names-only audit of the server `.env` (owner-run).
- **Rollback:** limited once a new JWT key is active (§10.7).

### 11.1 A4.8 implementation (merged, PR #251)

Local tooling and documentation only; no production deployment, key change or workflow change.

| Part | Implementation |
|---|---|
| Provisioning (D6) | `apps/auth-service/deploy/provision-and-deploy.sh` generates `JWT_SECRET` only when **none** of `JWT_SECRET`, `JWT_SECRET_FILE`, `JWT_SIGNING_KEYS`, `JWT_SIGNING_KEYS_FILE`, `JWT_ACTIVE_KEY_ID`, `JWT_ACTIVE_KEY_ID_FILE` is present (wider than "when `JWT_SIGNING_KEYS` is configured": a `_FILE` form or a lone active id also means the keys are managed deliberately). Before anything changes, a JWT variable declared twice or not as a plain `NAME=value` line (leading whitespace, `export`, a space before `=`, a bare name) is refused, reporting line numbers and names only. The shell never repairs a JWT configuration; the loader decides |
| Configuration check | `src/config/config-check.ts` (`checkConfig`, pure) and `src/cli/check-config.ts` (`node dist/cli/check-config.js`): the service's `loadConfig`, one value-free line (`configuration valid; JWT: <mode and counts>` or `configuration invalid: <rule>`), exit 0 or 1; no connection, nothing generated |
| Deploy ordering | the runtime role's password and the `.env` are completed **before** the migrations (neither depends on them; the role is still created and granted after them), then `docker run --rm --network none --env-file .env <image> dist/cli/check-config.js`; a refusal stops the deploy before any migration and before the running service is touched |
| Runbooks | [rotation runbook](../runbooks/secret-rotation.md) §4 (steps 0–4, rollback, the waiting period from the last instance, retirement, ring-to-ring rotation, never reusing keys or ids, older images, emergencies, owner checkpoints); [deploy runbook](../runbooks/auth-service-deploy.md) §2 (the check, the §11 compatibility review, a names-only `.env` audit) and §3 |
| Tests | `config-check.spec.ts`; `scripts/deploy-tests/auth-deploy.test.mjs` with the fake Docker CLI (generation guard for each JWT shape, duplicate and malformed JWT lines refused before any change, the check's image, network, env-file and position before migrations and the stop, a refusal changing nothing, no secret printed) |

**Not preventable by A4.8:** an older image brings its own deploy script (before A4.8: regenerates an absent `JWT_SECRET`, no check)
and an image before A4.7 cannot verify ring tokens. A gate refusing such a digest once a ring is configured would be a workflow and
production-policy change requiring separate authorization; until then the image floor is the owner's check at dispatch
([rotation runbook](../runbooks/secret-rotation.md) §4.11).

## 12. Stages

| Stage | Objective | Branch | Decision or design gate | Deploy |
|---|---|---|---|---|
| A4.0 | discovery | – | owner review ✅ | no |
| A4.1 | this record; roadmap structure | `feature/core-v2-a4-1-authentication-record` | OD-A4-1 to -8 ✅ | no |
| A4.2 | configuration convergence (§6) | `feature/core-v2-a4-2-auth-config-convergence` | OD-A4-2, -3 ✅ | no |
| A4.3 | CLI configuration (§7) | `feature/core-v2-a4-3-auth-cli-config` | none | no |
| A4.4 | bootstrap convergence, kit filter option (§8) | `feature/core-v2-a4-4-auth-bootstrap` | OD-A4-4 ✅ | no |
| A4.5 | genericity exemption narrowing (§9) | `feature/core-v2-a4-5-auth-genericity` | OD-A4-5 ✅ | no |
| A4.6 | JWT key-ring design (§10) | `feature/core-v2-a4-6-jwt-key-ring-design` | D1–D7 ✅ (§10.2); ADR-0058 written as Proposed; owner review of the design | no |
| A4.7 | JWT key-ring implementation (§10) | `feature/core-v2-a4-7-jwt-key-ring` | A4.6 reviewed and merged | no |
| A4.8 | deployment-readiness tooling (§11) | `feature/core-v2-a4-8-jwt-deployment-readiness` (planned as `…-a4-8-auth-deploy-readiness`) | D6 (§10.2) | no |
| A4.9 | A4 local certification (§16, §18) | `feature/core-v2-a4-9-local-certification` (planned as `…-a4-9-certification`) | – | no |

Each stage is one pull request from `origin/main`, merged by the owner with green Core CI. No stage mixes unrelated features.

## 13. Dependencies and acceptance criteria

| Stage | Depends on | Done when |
|---|---|---|
| A4.1 | A4.0 | this record and the roadmap structure are merged |
| A4.2 | A4.1 | characterization tests merged first in the stage; every value read through `EnvReader`; `_FILE` for `DATABASE_URL` and `RABBITMQ_URL`; both forms refused; §2.1 production refusals and §6 item 5 unchanged; `SecretSource` removed only with equivalent injection (OD-A4-3) |
| A4.3 | A4.2 | both CLIs on `EnvReader`; `MIGRATION_DATABASE_URL_FILE` works; F4 bootstrap rules and refusal messages unchanged |
| A4.4 | A4.2 | the kit option exists and is tested; Auth starts through `configureApp`; every §2.1 HTTP contract passes its existing e2e tests unchanged; other services' behaviour unchanged |
| A4.5 | A4.1 | the exemption names only the two migrations; `test:repo` shows both directions; no migration edited |
| A4.6 | A4.2 | the design of §10 and ADR-0058 (Proposed) are written and owner-reviewed; no Accepted ADR changed |
| A4.7 | A4.6 | §10.9's tests pass; existing kit key-material behaviour unchanged; legacy `JWT_SECRET` works unchanged; no key generated or activated |
| A4.8 | A4.2, A4.7 | the configuration-check CLI never prints a value (tested); the deploy runbook lists §11's review; the provisioning script no longer generates `JWT_SECRET` when the ring is configured (D6); the rotation runbook states §10.6–§10.8 |
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
| A4.7 (kit change, D2) | kit build with fresh `dist/`; kit tests (`key-material`, `development-keys`); Auth unit (`app-config`, `token.service`); e2e `tokens`, `owner-auth`, `step-up`, `step-up-verify`, `operator`, `concurrency`; Notification's configuration tests (a `readKeyRing` user); the §10.9 mutants |
| A4.8 | CLI tests; `test:deploy` for the provisioning change (D6) |
| A4.9 | records-based; the merged pull requests' CI is the evidence |

Reused, not repeated: the A1, A2, A15 and A3M evidence. Not part of A4: G6, production checks, Final Core Validation.

## 15. Open risks and responsibilities

| Risk | Owner |
|---|---|
| The first Auth deployment after A4 carries every change since `97f78cb` | owner, at the deployment checkpoint (§11, §17) |
| A loader change could refuse production's configuration at startup | A4.2 (characterization), A4.8 (configuration check), owner review before deploy |
| Image rollback rejects ring-signed tokens once a new JWT key is active | §10.7; the rotation runbook (A4.8); owner at each rotation step |
| A re-provisioning reintroduces a generated `JWT_SECRET` after retirement | mitigated in the repository by A4.8 (D6, six-variable guard, duplicate and malformed JWT lines refused; PR #251); effective in production only once an A4.8 (or later) image is deployed |
| An image older than A4.8 is redeployed after a ring is configured (its script regenerates `JWT_SECRET`, runs no check; before A4.7 it cannot verify ring tokens) | owner at dispatch (rotation runbook §4.11). A workflow-side minimum-image gate needs **separate authorization** and is a prerequisite before any production ring activation (§18.7, D5) |
| Retained `-previous-*` containers and `.env` backups keep old JWT keys | rotation runbook §4.6, §4.10; owner at retirement and after an emergency |
| The real Auth image's `dist/cli/check-config.js` (A4.8 review F5) | resolved: the A4.9 core-image smoke (§18.5) passed in PR #252's CI (run 37851334577) and runs on every Auth image build in Core CI |
| ADR-0058 acceptance | resolved: Accepted by the owner on 2026-10-08 |
| F1 (forged Auth events to Notification) | P-A1 / A14; `AUTH_EVENTS` stays off (A3M.8) |
| Peppers cannot be rotated (A2 accepted limitation) | recorded; A4 does not change it |
| Passkeys enrolled under the former RP ID no longer work | product integration (re-enrollment UI) |
| ADR-0023 and ADR-0026 remain Proposed | owner review (OD-A4-8), **carried forward open** by A4.9 (D4); statuses unchanged |
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

## 18. A4.9: local certification (2026-10-08; closed on `main`, PR #252, merge `f90787a`)

- **Owner decisions:** D1 = the real Auth image's configuration check joins the existing core-image smoke (§18.5); D2 = one defensive
  test of the check's non-`ConfigError` path; D3 = ADR-0056 is **not** edited (its §12 `[TARGET: A4]` is shown met here, §18.4);
  D4 = the OD-A4-8 review of ADR-0023 and ADR-0026 is **carried forward open**, statuses unchanged; D5 = a workflow-side minimum-image
  gate (§15) needs **separate authorization** and is a prerequisite before any production JWT ring activation; it is not built here.
- **What changed:** this record, the [roadmap](../CORE-ROADMAP.md), `scripts/smoke-core-image.sh` (auth-service only) and one test in
  `apps/auth-service/src/config/config-check.spec.ts`. No runtime, workflow, deploy-script, migration or ADR change.
- **Kinds of evidence:** **CI** = Core CI on the merged pull request (`core-ci-passed` and the 23 other required checks); **local** =
  runs recorded during the stage (not re-run here); **production** = none: A4 deployed, generated and activated nothing.

### 18.1 Completion matrix

Every A4 pull request merged with 24 of 24 checks passing, `core-ci-passed` included (verified on GitHub on 2026-10-08):

| Stage | Done when (§13) | Pull request, merge | `core-ci-passed` run | Status |
|---|---|---|---|---|
| A4.1 | this record and the roadmap structure merged | #243, `ddafe69a42b006a2b0f86ffee1f85aa391b9150c` | 37790834331 | ✅ merged |
| A4.2 | configuration through `EnvReader`, characterization first, production refusals unchanged | #244, `dd35aac8bdff3bc1a2915bb9b3741f88f86b5da5` | 37794123750 | ✅ merged |
| A4.3 | both CLIs on `EnvReader`, F4 bootstrap rules unchanged | #245, `b066cc4175c26cfbc6993cb353aa9a1bd6bca084` | 37797728378 | ✅ merged |
| A4.4 | kit filter option; Auth starts through `configureApp`; §2.1 HTTP contracts unchanged | #246, `73397a631364e7be7c4ce4b051becae4fc6edfa2` | 37831705512 | ✅ merged |
| A4.5 | the exemption names only the two migrations | #247, `e039ed628798e6394d59627faa5e2e63f07d2eeb` | 37836294708 | ✅ merged |
| A4.6 | §10 and ADR-0058 written and owner-reviewed | #248, `8d62b3fb2afe176b04b9ecdc33c79b56b30ef614` | 37838534960 | ✅ merged |
| (ADR-0058) | acceptance, by explicit owner authorization | #249, `5964697b29a4b895d0cb4fb41445f809b865daf6` | 37841230733 | ✅ Accepted |
| A4.7 | §10.9 tests, kit behaviour unchanged, legacy `JWT_SECRET` unchanged, no key generated | #250, `f95956b90927d9ea46bab046580d3919efd811e1` | 37844836922 | ✅ merged |
| A4.8 | value-free check CLI, deploy runbook review, D6, rotation runbook | #251, `d3dd2fdb7c1c869e2efb47336043e707f1891a47` | 37849083293 | ✅ merged |
| A4.9 | §16 met (§18.2) | #252, `f90787aa52760d50dbe510354293f1a203ce8644` | 37851334577 | ✅ merged; A4 certified |

Across A4 (`16476f9`..`d3dd2fd`) only `apps/auth-service/**`, three kit files (`bootstrap.ts`, `config/key-material.ts`, `index.ts`),
documentation, `scripts/**` and ADR-0058 (with its index row) changed: no other service, audit contract, workflow or migration.

### 18.2 Certification criteria (§16)

| # | Criterion | Evidence | Kind | Result |
|---|---|---|---|---|
| 1 | A4.2 to A4.8 closed on `main` with green Core CI, each meeting §13 | §18.1 | CI | **met** |
| 2 | ADR-0056 §12 `[TARGET: A4]`: Auth uses the kit's configuration reader and `configureApp` | §18.4 | CI, repository | **met** |
| 3 | every §2.1 guarantee shown unchanged by existing tests | §18.3 | CI | **met** |
| 4 | the key ring works with the legacy `JWT_SECRET`; no production key generated or activated | §18.5; no production run (§18.6) | CI, local | **met** |
| 5 | no Auth deployment; `AUTH_EVENTS` unchanged; F1 and F2 untouched; ADR statuses unchanged unless authorized | no `auth-service-deploy.yml` run since 2026-09-30 and no production workflow run during A4 (last: core backup 2026-10-04); the deploy script's `AUTH_EVENTS off` line unchanged; no audit, notification or event-contract change (§18.1); only ADR-0058's status changed, by explicit authorization (#249) | GitHub, repository | **met** |
| 6 | this record lists what was not run and the open risks | §18.6, §18.7 | record | **met** |
| – | (D1) the real Auth image contains and runs `dist/cli/check-config.js` as the deploy does | §18.5 | CI of PR #252 (run 37851334577, job `core image (auth-service)`) | **met** (verified; recorded UNVERIFIED until that run passed) |

### 18.3 The §2.1 guarantees and the tests that show them

All files run in Core CI's `auth-service` job (`npm test` and `npm run test:e2e` with PostgreSQL and RabbitMQ; CI sets
`TEST_RABBITMQ_URL`, so the broker-gated `events-real-broker` suite runs). `e2e` is `apps/auth-service/test/`, `unit` is
`apps/auth-service/src/`. Each mapping below was checked against the test's content, not its name.

| Guarantee | Tests |
|---|---|
| `GET /auth/health` 200, or 503 `unavailable` | e2e `health-readiness.e2e-spec.ts` |
| localized validation errors en / fr / ar, English by default | e2e `auth-localization.e2e-spec.ts` |
| the error shape and field order (`reason` after `code`, before `requestId`), opaque 500s | e2e `auth-localization.e2e-spec.ts` (exact key order including `reason`; a 500 per locale); the kit's `localization.spec.ts` |
| the JWT: claims, issuer, audience, HS256, expiry, session-ceiling clamp, `invalid_token` | unit `tokens/token.service.spec.ts` (characterization and ring); e2e `tokens.e2e-spec.ts` |
| refresh rotation, family revocation on reuse, the session ceiling, logout | e2e `tokens.e2e-spec.ts`, `concurrency.e2e-spec.ts`, `operator.e2e-spec.ts` (`session_ceiling_reached`) |
| the live session and user check in `AuthGuard` | e2e `tokens.e2e-spec.ts` (inactive user, revoked session), `member-security.e2e-spec.ts` |
| owner MFA (TOTP, WebAuthn), step-up, recovery (ADR-0025) | e2e `owner-auth.e2e-spec.ts`, `webauthn.e2e-spec.ts`, `step-up.e2e-spec.ts`, `step-up-verify.e2e-spec.ts`, `recovery.e2e-spec.ts` |
| the 29 throttling buckets, their variables and defaults | unit `config/app-config.spec.ts` ("every default, including all 29 rate buckets"); e2e 429 cases in `tokens`, `owner-auth`, `operator`, `recovery`, `onboarding`, `admin-invitation`, `client-address` |
| service authentication contracts | e2e `platform-authz.e2e-spec.ts` (`/auth/me`, `/auth/platform-access/:platformId`), `grants.e2e-spec.ts`, `hierarchy-reference.e2e-spec.ts` (the Organization client); the cross-service `stage10-1-auth-organization-wire-contract.e2e-spec.ts` (CI job `test:e2e:auth-organization`) |
| `AUTH_EVENTS` semantics and the code-event purge | unit `config/app-config.spec.ts` (exactly `on` / `off`); e2e `domain-events-outbox.e2e-spec.ts` (`CodeEventPurge`, rows only when on), `events-real-broker.e2e-spec.ts` |
| production refusals; no value echoed | unit `config/app-config.spec.ts` (published and non-random keys, cross-purpose reuse, runtime role, WebAuthn RP and https origins, `RABBITMQ_URL`, strict `NODE_ENV`, `AUTH_EVENTS`, `REQUIRE_CONTACT_VERIFICATION`, the `refused` helper's no-value assertion), `config/config-check.spec.ts`; e2e `secrets.e2e-spec.ts`, `runtime-role.e2e-spec.ts` |

### 18.4 ADR-0056 §12: configuration and bootstrap convergence

- **Configuration:** `apps/auth-service/src/config/app-config.ts` reads every value through the kit's `EnvReader` (`NAME` or
  `NAME_FILE`, both refused, trimmed) and the kit's key helpers (`readKey`, `readOptionalKey`, `readKeyRing`, `readOptionalKeyEntries`,
  `assertDistinctKeys`); `src/cli/migrate.ts` reads through `EnvReader` (guarded by `check:repo`'s operator-CLI rule).
- **Bootstrap:** `src/main.ts` starts through `src/http/configure-auth-app.ts`, which calls the kit's `configureApp` with Auth's filter
  option (A4.4); the e2e application uses the same pipeline.
- ADR-0056 itself is not edited (D3).

### 18.5 JWT key ring and deployment readiness

| Evidence | Kind |
|---|---|
| unit `token.service.spec.ts` (16: legacy header byte-exact, a plain `jwtVerify` standing for an image without the ring, `kid` selection, no fallback, unknown / retired / reserved / malformed / non-string `kid`, header-carried keys, algorithm confusion, the §10.6 rotation matrix and the image-rollback boundary) | CI |
| unit `app-config.spec.ts` (the §10.3 table, reserved id in every case, cap of 3, distinctness, production rules, `_FILE`); kit `key-material.spec.ts` (`readOptionalKeyEntries`, `readKeyRing` unchanged); Notification's configuration tests | CI |
| e2e `tokens.e2e-spec.ts` (unknown and `legacy` kids refused; a ring app with `JWT_SECRET` retired) | CI |
| unit `config-check.spec.ts` (9, including D2's non-`ConfigError` path); `scripts/deploy-tests/auth-deploy.test.mjs` with the fake Docker CLI (the six-variable guard, duplicate and malformed JWT lines refused before any change, the check's image, network and position before migrations and the stop, no secret printed) | CI (`test:deploy`) |
| 8 of 8 security mutants caught (A4.7); the six focused Auth e2e suites (76 tests); the built CLI smoke (8 cases); the runbook's `.env` editing procedure run on a throwaway file (A4.8) | local |
| **real image** (D1): `scripts/smoke-core-image.sh` runs `dist/cli/check-config.js` in the built `auth-service` image as the deploy does (`--rm --network none --entrypoint node`, the image's working directory): the valid production configuration gives `configuration valid; JWT: legacy only (JWT_SECRET signs and verifies)`, a pepper equal to `JWT_SECRET` is refused with exit 1, no configuration value appears | CI of PR #252 (run 37851334577): **passed** |

### 18.6 Not run

Final Core Validation; the G6 production-like recovery drill; any production check, deployment, key generation, activation, rotation or
retirement; `AUTH_EVENTS` or A3M.8 activation; the on-demand real-broker deploy certification (`test:deploy:real-broker`); local Docker
image builds and image smoke runs (the real-image evidence is the CI core-image job); a broad local platform campaign (the merged pull
requests' CI is the evidence, §14). Nothing from A2, A3M, A15 or earlier stages was re-run.

### 18.7 Open risks after A4

The §15 table, in particular: the first Auth deployment after A4 carries every change since `97f78cb` and needs its own compatibility
review (deploy runbook §2); a production JWT ring must not be activated before the minimum-image gate is separately authorized and in
place (D5), and every rotation step follows the [rotation runbook](../runbooks/secret-rotation.md) §4 with the owner's authorization;
retained containers and `.env` backups keep old keys; the OD-A4-8 review stays open (D4). Production readiness has **not** been
operationally proven: A4 is certified on repository, CI and local evidence only.

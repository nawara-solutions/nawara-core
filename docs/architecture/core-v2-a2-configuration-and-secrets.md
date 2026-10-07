# Core V2 A2: configuration and secrets

- **Status:** RECORD of A2.0 discovery and A2.1.0 design (both read-only, owner-reviewed, 2026-10-07, on `main` at `321ec0b`, the
  PR #222 merge), of **A2.1: service-kit configuration hardening** (**closed on `main`**: PR #223, merge `b6a8402`; §4) and of
  **A2.2: seven-service adoption** (**closed on `main`**: PR #224, merge `975d848`; §6) and of **A2.3: targeted Auth hardening**
  (**complete locally, owner review pending**; §7). **A2 is OPEN.** A2.4 to A2.6 are not started.
- **Scope of A2** ([roadmap](../CORE-ROADMAP.md) A2): typed and validated configuration; environment separation; secret lifecycle and
  rotation; deployment contracts. **Not A2:** Auth loader convergence and JWT key-ring verification (A4); the Organization ownership
  CLI and its production gate (A5 / F6 / F7); production credential restriction (A3.6 / A3.7); production deploy-script changes
  (separately authorized YELLOW work).

## 1. A2.0 findings (summary)

- Every service loads its configuration in one function at startup and fails closed with a value-free `ConfigError`; **no runtime
  source reads `process.env`** (the CLIs and tests do). Seven services build on the kit (`loadBaseConfig`, `EnvReader`); Auth has its own
  loader (convergence: ADR-0056 §12, A4).
- Gaps: `EnvReader` treated whitespace as a value (`int` turned `" "` into 0 where `min` is 0); four divergent key-material parsers
  (two silently dropped invalid base64 characters); the production database-role guard copied eight times and missing the `*_admin`
  bootstrap superusers the deploy scripts create; the Swagger rule copied seven times; published development keys refused in production
  only by Notification; lenient Auth booleans and an Auth `NODE_ENV` default of `development` (image-mitigated); `.gitignore` and
  `.dockerignore` not covering `.env.*`; Auth settings undocumented; no rotation matrix.
- **No G6 dependency.** GREEN: kit, adoption, hygiene, documentation, guards. YELLOW: activation in the deployed services (Auth,
  Organization, Audit) and any deploy-script change. RED: none.

## 2. Owner decisions

| Id | Decision |
|---|---|
| OD-A2-1 | **A:** targeted Auth security hardening in A2.3; Auth loader convergence stays A4 |
| OD-A2-2 | **A:** one service-kit catalog of published development secrets (fingerprints), refused in production |
| OD-A2-3 | **Yes:** consolidate key material, the production database-role guard and the Swagger credential rule in the kit |
| OD-A2-4 | **A:** `EnvReader` removes surrounding whitespace globally; whitespace-only is unset |
| OD-A2-5 | **Yes, bounded:** operational CLIs may adopt `EnvReader` later; the Organization ownership CLI is excluded (A5 / F6 / F7) |
| OD-A2-6 | `_FILE` is the target production secret delivery; no production deploy-script change during GREEN A2 work |
| OD-A2-7 | **Yes:** A2 writes a rotation matrix; JWT key-ring verification is A4; the non-rotatable peppers are documented, not redesigned |
| OD-A2.1-a | **Approved:** integers use an explicit signed decimal grammar (`[+-]?[0-9]+`), then the existing safe-integer and range checks |
| OD-A2.1-b | **Approved:** `NAME` and `NAME_FILE` both set is refused (`set NAME or NAME_FILE, not both`); neither is silently preferred |

## 3. A2.1.0 design (summary)

Normalization belongs in `EnvReader.get` (the `_FILE` path already trimmed, so no secret delivered as a file could carry surrounding
whitespace; env values now match). Shared primitives: strict canonical key material and key rings, a fingerprint catalog, the
database-role guard with `*_admin`, the docs-credential reader. No new dependency (`node:crypto`, `Buffer`).

## 4. A2.1: service-kit configuration hardening (2026-10-07, local)

- **`EnvReader`** (`libs/service-kit/src/config/config.ts`): surrounding whitespace removed from `NAME`, from the `NAME_FILE` path and
  from the file's content; empty after that = unset (so `required` fails, `optional` and typed readers fall back to their defaults, and
  **whitespace can never become 0**). `NAME` + `NAME_FILE` both set → `ConfigError`, decided before any file is read. `int` accepts
  only `[+-]?[0-9]+` (refusing `1e3`, `0x10`, `1.5`, `5.0`, `NaN`, `Infinity`, a bare sign), then the safe-integer and range checks.
- **Key material** (`config/key-material.ts`): `decodeKey`, `readKey`, `readOptionalKey`, `readKeyRing`, `assertDistinctKeys`, rules
  `KeyRules { isProduction; minBytes? (32); exactBytes? }`. Standard base64 only, canonical (padding optional but exact; re-encoding must
  match); decoded minimum or exact size; ring ids `[A-Za-z0-9_-]{1,32}`, no repeated id or key, the active id must exist; one key, one
  purpose. **Production only:** a published development key is refused, and so is a key with fewer than 12 distinct byte values in its
  first 32 bytes (Notification's Stage 16.9 rule, unchanged).
- **Published development secrets** (`config/development-keys.ts`): 12 SHA-256 fingerprints, no plaintext: 11 keys (decoded bytes:
  `JWT_SECRET`, the four Auth peppers, `TOTP_ENCRYPTION_KEYS`, the two File keys, the three Notification keys, Notification's three
  previous fingerprints included) and one textual token (`PAYMENT_SERVICE_TOKEN`, UTF-8 text). Runtime API: `isPublishedDevelopmentSecret`;
  the catalog itself is exported only from `@nawara/service-kit/testing` (for tests and the A2.5 guard).
- **Database role** (`config/db-role.ts`): `assertRuntimeDatabaseRole(url, { isProduction, alsoForbidden? })`, production only, refuses
  `postgres`, `root`, `*_migrator` and **`*_admin`** (case-sensitive), plus a service's own owner role; malformed URLs and encodings are
  a `ConfigError`; the URL is never echoed.
- **Docs credentials** (`config/docs-credentials.ts`): `readDocsCredentials` keeps the `docs` username default and the 16-character
  minimum; an unset or blank password means no documentation.
- **Errors:** every failure is a `ConfigError` naming the variable and the rule, never a value, decoded bytes, a fingerprint, a URL or a
  file's content (asserted per helper).
- **Application tests encoding the old semantics (owner-authorized test-only update):** two expectations refused surrounding whitespace
  that OD-A2-4 now normalizes: `NOTIFICATION_EMAIL_FROM = ' Lead <a@b.example>'` and `FILE_STORAGE_PROVIDER = 's3 '`. They now prove
  "normalize, then validate" (both accepted after normalization), while header injection (CR/LF), malformed senders and genuine
  provider typos stay refused. **No application runtime source changed.**
- **Evidence (local):** kit build; kit unit suite 36 files; focused 113 tests (5 files); the 8 services' configuration specs and unit
  suites green; eleven negative controls (whitespace, integer grammar, `NAME`/`NAME_FILE`, strict base64, decoded size, duplicate id and
  material, published-key refusal, low-entropy refusal, `*_admin`, the Swagger minimum, an echoed secret), each red when weakened and
  restored byte-for-byte; `check:repo`, `test:repo`.
- **Production classification:** the implementation is GREEN. The `EnvReader` change applies to every service that uses it as soon as
  its image is rebuilt (the kit change makes the Auth, Organization and Audit image workflows **build** on merge; nothing deploys).
  Activation in the deployed services is **YELLOW: PRODUCTION VERIFICATION DEFERRED**. Before an owner-authorized deployment of an
  affected service, a value-free `OK` / `REFUSED` compatibility check of its configuration is required. No G6 dependency.

## 5. Boundaries and next phases

- **A2.2:** adopt the helpers in Billing, Payment, Organization, Notification, File, Audit and Release, one service at a time.
- **A2.3:** targeted Auth hardening: strict `AUTH_EVENTS` and `REQUIRE_CONTACT_VERIFICATION`, a fail-safe `NODE_ENV`, a value-free CORS
  error, published-key refusal, TOTP duplicate-id refusal, the database-role helper with `auth`.
- **A2.4:** `.gitignore` / `.dockerignore`, templates, environment reference, rotation matrix, CLIs (OD-A2-5).
- **A2.5:** repository guards. **A2.6:** certification.

```text
A2.0  discovery                         ✅ complete (owner-reviewed)
A2.1.0  kit design                      ✅ complete (owner-reviewed)
A2.1  service-kit hardening             ✅ closed on main (PR #223, merge b6a8402)
A2.2.0  adoption plan                   ✅ complete (owner-reviewed)
A2.2  seven-service adoption            ✅ closed on main (PR #224, merge 975d848; §6)
A2.3.0  Auth discovery                  ✅ complete (owner-reviewed)
A2.3  targeted Auth hardening           ✅ complete locally; owner review pending (§7)
A2.4 – A2.6                             not started
```

A2 is OPEN. Unchanged: A3.6 and A3.7 deferred; A12.10 not started; G4 and G6 deferred; G7, F6 and F7 locked; Final Core Validation
absolute last.

## 6. A2.2: seven-service adoption (2026-10-07, local)

- **Owner decisions:** OD-A2.2-1 = A (a service holding token digests refuses, in production, the digest of a published development
  token: the kit's `assertNoPublishedServiceTokens`, the callee side; the caller refuses the raw token); OD-A2.2-2 = A (the
  candidate-image configuration checks below).
- **Kit addition (additive):** `assertNoPublishedServiceTokens(entries, { isProduction })`. A service-token digest is exactly the token's
  catalog fingerprint, so no plaintext is needed; the catalog stays off the runtime entry point; the error names the caller only.

| Service | Database role | Docs credentials | Keys | Published-secret refusal | Deployed |
|---|---|---|---|---|---|
| Billing | kit helper | kit helper | none | `PAYMENT_SERVICE_TOKEN` (caller, raw) | no: GREEN |
| Payment | kit helper | kit helper | none | `SERVICE_TOKENS` digests (callee) | no: GREEN |
| Organization | kit helper | kit helper | none | none (no published value) | **yes: YELLOW** |
| Audit | kit helper | kit helper | none | none | **yes: YELLOW** |
| Release | kit helper | kit helper | `RELEASE_RATE_LIMIT_KEY` (`readOptionalKey`; still required in production, random elsewhere) | none (not published) | no: GREEN |
| File | kit helper | kit helper | request-hash and rate-limit keys, previous keys (`readKey`, `decodeKey`, `assertDistinctKeys`) | both keys | no: GREEN |
| Notification | kit helper | kit helper | secret ring, request-hash and destination-limit keys and their previous keys (`readKeyRing`, `readKey`, `readOptionalKey`, `decodeKey`, `assertDistinctKeys`) | ring, request-hash, destination-limit keys (now from the kit catalog) | no: GREEN |

- **Pure deduplication:** the docs credentials (all seven); the purpose separation of Notification and File (same rule, kit wording);
  Notification's published-key and low-entropy refusals (now the kit's, same three fingerprints).
- **Intentional hardening:** production refuses a `*_admin` bootstrap superuser as the runtime database user (all seven; a malformed
  user encoding is a `ConfigError`); canonical standard base64 for every key (Notification, File, Release); production refusal of
  published development keys and of non-random keys in File and of non-random keys in Release; File's previous keys may not repeat;
  Billing refuses the published raw token and Payment its published digest, in production only.
- **Deleted copies:** seven database-role constants and checks, seven docs rules, Notification's fingerprint list, `checkKey`,
  `keyMaterial`, `secretKeyRing` and purpose loop, File's and Release's private decoders.
- **Tests:** each service's configuration spec gains the `*_admin` refusal and its hardening cases; test fixtures that used a constant
  (non-random) key under production defaults now use random keys (Release `release-config.spec.ts` and `http-server.spec.ts`, File
  `file-config.spec.ts`); the kit test that proved the A2.1 migration from Notification's own list now checks the catalog directly.
  Untouched: Auth, the Organization ownership CLI, Audit backup and retention, File storage configuration.
- **Evidence (local):** per service, the configuration spec and unit suite green, and negative controls (the database-role call bypassed
  for all seven; Billing's token refusal; Payment's digest refusal; Release's old alphabet-only decoding; File's production key refusals;
  Notification's lenient decoding), each red when weakened and restored byte-for-byte; the kit control (digest refusal bypassed) the same.
- **Production (YELLOW, PRODUCTION VERIFICATION DEFERRED):** Organization and Audit activate the `*_admin` refusal and the A2.1
  normalization with their next owner-authorized deploy. Mitigation (OD-A2.2-2, documented, not run): the candidate image's own loader
  reads the server's `.env` and prints only `OK` or `REFUSED` ([Organization runbook](../runbooks/organization-production.md) §2;
  [digest deployments](../runbooks/digest-deployments.md) §2 for Audit), proven locally against synthetic configurations (`*_app`: OK;
  `*_admin`, a malformed policy: REFUSED). No G6 dependency; RED: none.

## 7. A2.3: targeted Auth hardening (2026-10-07, local)

- **Owner decisions:** OD-A2.3-1 = A (Auth re-exports the kit's `ConfigError`: one class for every configuration error; the CLI's
  `describeCliFailure` already treats it as safe); OD-A2.3-2 = A (an unset `NODE_ENV` is production, as in every other Core service);
  OD-A2.3-3 = A (the Auth pre-deploy check below, in A2.3).
- **Inside Auth's own loader** (`apps/auth-service/src/config/app-config.ts`): its `SecretSource` (the KMS plug-in point) is kept, and
  only the targeted items change:

| Setting | Before | After |
|---|---|---|
| `NODE_ENV` | unset = development | kit `oneOf`: unset or blank = production; only development / test / production (surrounding whitespace removed) |
| `AUTH_EVENTS` | anything but `off` = on | only `on` (default) / `off`; anything else refused |
| `REQUIRE_CONTACT_VERIFICATION` | only `true` = true, anything else silently false | only `true` / `false` (default false); anything else refused |
| `CORS_ORIGINS` | error repeated the rejected entry | the kit's `parseCorsOrigins` (same rule), no echo |
| `JWT_SECRET`, four peppers | lenient base64, at least 32 bytes | kit `decodeKey`: canonical base64, at least 32 bytes; production refuses a published or non-random key |
| `TOTP_ENCRYPTION_KEYS` | a repeated id silently replaced the earlier key; lenient base64 | repeated id refused; each key `decodeKey` (exactly 32 bytes, production refusals); active id required |
| domain separation | one generic "must be distinct" | kit `assertDistinctKeys`, naming the two variables |
| `DATABASE_URL` user (production) | `postgres`, `root`, `auth`, `*_migrator` | kit `assertRuntimeDatabaseRole` + `alsoForbidden: ['auth']`: also `*_admin`; a malformed encoding is a `ConfigError` |
| unreadable `NAME_FILE` | the operating-system error (with the path) escaped | `NAME_FILE is set but the file cannot be read` |

- **Boundaries.** A4 keeps: loader convergence (`SecretSource` versus `EnvReader`, `readKeyRing`, `readDocsCredentials`, `_FILE` for
  `DATABASE_URL` / `RABBITMQ_URL`, global trimming and the `NAME` + `NAME_FILE` rule), the JWT verification key ring, rotation and key
  ids. A2.4 keeps: templates (`NODE_ENV=development` for local runs), the stale `PAYMENT_SERVICE_TOKEN` the Auth deploy script still
  provisions, the rotation matrix (peppers are not rotatable), the environment reference, CLI hygiene. `SWAGGER_PASSWORD` and
  `ORGANIZATION_SERVICE_TOKEN` are unchanged. No kit, deploy-script, workflow or package change.
- **Tests:** the configuration spec grows from 74 to 97 (every grammar above, never-echo checks including a credentialed CORS URL and a
  sensitive `_FILE` path, each published Auth secret refused in production and kept in development, the TOTP cases, the roles); two
  expectations moved from the generic "distinct" text to the named messages. Every e2e and shared-suite fixture already uses
  `NODE_ENV=test` and random canonical keys; the CI image smoke uses the production shapes, which pass.
- **Evidence (local):** configuration spec 97, unit suite 141, typecheck, changed-file lint; eight negative controls (development default,
  lenient `AUTH_EVENTS`, lenient contact verification, CORS echo, production key rules off, TOTP overwrite, `auth` role allowed, raw
  `_FILE` error), each red when weakened and restored byte-for-byte; `check:repo`, `test:repo`.
- **Production (YELLOW, PRODUCTION VERIFICATION DEFERRED):** Auth is deployed; every row above activates at its next owner-authorized
  deploy. The values `provision-and-deploy.sh` writes pass; a hand edit may not. Mitigation (OD-A2.3-3, documented, not run):
  [Auth deploy runbook](../runbooks/auth-service-deploy.md) §2, the candidate image's `loadConfig()` over the server's `.env`, printing
  only `OK` or `REFUSED`; proven locally against synthetic configurations (deploy-script shapes: OK; `AUTH_EVENTS=false`,
  `REQUIRE_CONTACT_VERIFICATION=1`, an `auth_admin` or `auth` user, a repeated TOTP id, the published `JWT_SECRET`: REFUSED). A merge
  builds the Auth image (`auth-service-docker-build.yml`); deployment stays manual. No G6 dependency; RED: none.

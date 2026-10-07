# Core V2 A2: configuration and secrets

- **Status:** RECORD of A2.0 discovery and A2.1.0 design (both read-only, owner-reviewed, 2026-10-07, on `main` at `321ec0b`, the
  PR #222 merge), of **A2.1: service-kit configuration hardening** (**closed on `main`**: PR #223, merge `b6a8402`; §4) and of
  **A2.2: seven-service adoption** (**closed on `main`**: PR #224, merge `975d848`; §6) of **A2.3: targeted Auth hardening**
  (**closed on `main`**: PR #225, merge `6e86ab0`; §7), of **A2.4: configuration hygiene, templates and secret rotation**
  (**closed on `main`**: PR #226, merge `0854abd17714b7b686aafdc8c221d99bbc48e18c`; §8) and of **A2.5: configuration and secret
  repository guards** (**complete locally, owner review pending**; §9). **A2 is OPEN.** A2.6 (certification) is not started.
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
A2.3  targeted Auth hardening           ✅ closed on main (PR #225, merge 6e86ab0; §7)
A2.4.0  hygiene discovery               ✅ complete (owner-reviewed)
A2.4  hygiene, templates, rotation      ✅ closed on main (PR #226, merge 0854abd; §8)
A2.5.0  repository-guard discovery      ✅ complete (owner-reviewed)
A2.5  repository guards                 ✅ complete locally; owner review pending (§9)
A2.6  certification                     not started
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

## 8. A2.4: configuration hygiene, templates and secret rotation (2026-10-07; closed on `main`, PR #226, merge `0854abd`)

- **Owner decisions:** OD-A2.4-1 = C (the root `.env.example` is the Compose development template, the four existing service
  templates stay, and each service README's Environment / Configuration table is the per-service variable reference; no template is
  added for symmetry); OD-A2.4-2 = A (the ignore convention below); OD-A2.4-3 = A (the Auth deploy script stops provisioning the two
  unused Payment settings); OD-A2.4-4 = B (CLI adoption deferred).
- **Finding that shaped the model:** no service loads a `.env` file itself (no loader, no `--env-file`); configuration reaches a
  service only through its process environment. A per-service `.env` therefore does nothing until it is exported, and with an unset
  `NODE_ENV` a service is in production mode.
- **Ignore policy.** `.gitignore`: `.env`, `.env.*`, `!.env.example`, at any depth (before: only `.env`, so `.env.local` or
  `.env.production` could be committed). `.dockerignore`: `**/.env`, `**/.env.*` (before: none, so a local `apps/<service>/.env`
  reached a build-stage layer). The five tracked `.env.example` templates stay tracked.
- **Stale Auth settings.** `apps/auth-service/deploy/provision-and-deploy.sh` no longer ensures `PAYMENT_SERVICE_TOKEN` and
  `PAYMENT_SERVICE_URL` (Auth has had no Payment client since ADR-0042 Amendment 3). The `ensure` helper only adds a missing entry, so an
  entry already in a server `.env` is neither removed nor rewritten: cleaning it is a separate production action, not done here.
- **Documentation model.**

| What | Where |
|---|---|
| a service's variables (required, default, secret, `_FILE`) | its README Environment / Configuration table: added for Auth, Payment and Organization; Billing's corrected (the `*_admin` refusal, `_FILE` for every value, the published token) |
| local development values | the root `.env.example` (header states: Compose template, published development values refused in production) |
| running a service locally | the READMEs: export the `.env` (`set -a; . ./.env; set +a`) and keep `NODE_ENV=development`; quote values the shell would split |
| rotation, the pepper and JWT limits, handling secrets while operating, the database-role and broker-identity model | [secret rotation runbook](../runbooks/secret-rotation.md) (new), which links the existing service procedures instead of copying them |
| decisions and status | this record |

- **`_FILE` today.** The seven kit-based services accept `NAME` or `NAME_FILE` for every variable and refuse both together. Auth: its
  secrets through its secret source (the file wins when both are set) and its kit-read settings like the kit; `DATABASE_URL`,
  `RABBITMQ_URL` and the rest by name only. The CLIs by name only. Production still delivers a plain `--env-file`: no `_FILE` delivery is
  activated.
- **Secret handling in documentation.** The Auth README no longer shows the bootstrap owner password typed inline (it is read without
  echo); the rotation runbook warns against printing a secret to read it back (the `grep ^SWAGGER_` hint in the Auth deploy script's
  comment is such a command; the script is not changed for it).
- **Deferred, with owners.** Operational CLIs on the kit's reader: a follow-up (A15); Auth's CLIs: A4; the Audit retention CLI: outside
  this scope (A13 is closed); the Organization ownership CLI: A5 / F6 / F7. Unchanged and recorded: the Auth deploy script still writes
  the older `TRUST_PROXY=true` (one hop; changing what new installations get would be a behaviour change). Out-of-scope follow-up: the
  Auth deploy command in `core-rabbitmq-production.md` §1 is shown without its digest input.
- **Evidence (local):** `git check-ignore` assertions (real and local environment files ignored at the root and under `apps/`; the
  templates trackable); a static evaluation of `.dockerignore` with Docker's pattern rules (environment files excluded, source and deploy
  scripts kept); `npm run test:deploy` 316 passed, with a new Auth test (a fresh `.env` has neither Payment setting; an existing entry is
  kept); three negative controls, each red when weakened and restored byte-for-byte (the `.env.*` rule removed; the Docker rules removed;
  one stale `ensure` restored); document links; `check:repo`; `test:repo`.
- **Production:** GREEN. No runtime behaviour changes; nothing was deployed, rotated or removed from a server. A merge builds the Auth
  image (`.dockerignore` and `apps/auth-service/**` are in its path filter); deployment stays manual. RED: none; no G6 dependency.
- **Left for A2.5:** permanent repository guards (the ignore policy, template completeness against the development-secret catalog, the
  `process.env` boundary, coverage of the environment reference).

## 9. A2.5: configuration and secret repository guards (2026-10-07, local)

Permanent guards in the existing repository checker (`scripts/lib/checks.mjs`, wired by `scripts/check-repo.mjs`, tested in
`scripts/check-repo.test.mjs`; `npm run check:repo` and `npm run test:repo`, both already steps of Core CI). No runtime source, loader,
template, Compose file, Dockerfile, deploy script or workflow changed.

- **Owner decisions:** OD-A2.5-1 = B (README coverage for high-confidence literal names only; no registry of computed names);
  OD-A2.5-2 = A (tracked basenames `.env`, `.env.*` and `*.env` are refused; only `.env.example` is allowed); OD-A2.5-3 = A (the
  development-secret catalog and the templates agree in both directions, with no fixed count).

| Guard | Prevents | Mechanism | Input |
|---|---|---|---|
| Git ignore behaviour (`checkEnvIgnorePolicy`) | a real or local environment file becoming committable; a template becoming ignored | Git's own evaluation, `git check-ignore --no-index`, on representative paths (user-level excludes switched off) | `.gitignore` |
| Docker context (`checkDockerContext`) | an environment file entering an image build context | a static evaluator of Docker's ignore rules (`**`, `*`, `?`, `!`, last match wins); no daemon | `.dockerignore` |
| Tracked environment files (`checkTrackedEnvFiles`) | a committed `.env`, `.env.local`, `prod.env`, … | basename rule over `git ls-files` (the index, so an ignored local file on disk never fails the check) | the Git index |
| Development-secret catalog (`checkDevelopmentSecretCatalog`) | a published secret production would accept; a stale catalog entry | SHA-256 of each secret-shaped template value compared with the fingerprints in `development-keys.ts`, both directions | tracked `.env.example` files + the catalog source |
| Templates (`checkEnvTemplates`) | a template without its development-only warning; a root variable Compose no longer consumes | opening comment contains "development only"; each root variable is referenced as `${NAME…}` by a Compose file | tracked templates + `docker-compose*.yml` |
| `process.env` boundary (in `checkSource`) | configuration read outside the loader | the shared `sourceFacts` parser pass plus a path allowlist | non-test `apps/*/src`, `libs/*/src` |
| README coverage (`checkReadmeEnvironmentCoverage`) | an undocumented configuration variable | literal names read by a service's source must appear in its README | each service's non-test, non-CLI `src` + its README |

- **Secret shapes (by value, never by variable name):** canonical base64 of 32 decoded bytes or more (also inside an `id:key` ring);
  a generated base64url token of 43 characters or more; a 64-hex token digest, which must itself be a catalog fingerprint. Local
  database passwords and short development credentials are not key material and are outside the catalog, as in A2.1. The guard reads
  the catalog source as text and hashes the template values itself: it repeats no value and no fingerprint.
- **`process.env` boundary:** allowed only in `apps/<service>/src/config/*-config.ts`, `libs/service-kit/src/config/base-config.ts`,
  `apps/<service>/src/cli/**` and `libs/service-kit/src/cli/**`. Detected forms: `process.env` (any use), `process['env']`,
  `globalThis.process.env`, `const { env } = process`, `({ env } = process)` and `import { env } from 'node:process'`; comments,
  strings and types are not reads. Inventory at introduction: 468 non-test source files, 18 files reaching the environment (8 service
  loaders, the kit base loader, 5 service CLIs, 4 kit CLIs), **0 outside the boundary**. The CLIs stay allowed: their convergence is
  A15 (generic), A4 (Auth) and A5 / F6 / F7 (Organization ownership).
- **README coverage:** literal names are the first argument of an `EnvReader` method on `reader` (or Auth's `src`), a name passed to a
  known helper (`readKey`, `readOptionalKey`, `readKeyRing`, `decodeKey`, Auth's `int` / `required` / `secretBytes`, Notification's
  `matching` / `providerUrl`) and `env.X`. Outside by design: computed names (Auth `RATE_<rule>_LIMIT` / `_WINDOW_SEC`, File
  `FILE_<kind>_RATE_PER_CALLER` / `_PER_ORGANIZATION`), the kit's base variables (read in the kit, documented as groups), CLIs, and the
  reverse direction (a README may name another service's variables). Coverage at introduction: Auth 52, File 47, Notification 41,
  Billing 22, Payment 15, Audit 12, Release 12, Organization 8 literal names, all documented.
- **Documentation correction (found by A2.5.0):** eight variables were read but not named in their README. Billing now lists
  `RABBITMQ_CONFIRM_TIMEOUT_MS`, `RABBITMQ_HEARTBEAT_S`, `BILLING_RATE_LIMIT_INVOICE_CREATE_PER_MINUTE` and
  `BILLING_RATE_LIMIT_PAYMENT_REQUEST_CREATE_PER_MINUTE`; File names `FILE_STORAGE_CONNECT_TIMEOUT_MS`, `FILE_STORAGE_IDLE_TIMEOUT_MS`,
  `FILE_STORAGE_REQUEST_TIMEOUT_MS` and `FILE_DELETE_RETRY_MAX_SECONDS` explicitly (they were written as a wildcard and a suffix).
  Defaults and bounds are those of the loaders; no loader changed.
- **Diagnostics:** deterministic and value-free. Each names a path and a variable or rule; no template value, decoded key,
  fingerprint or URL is printed, and the tests assert it on generated fixture secrets.
- **Non-goals:** no `_FILE` guard (the split between the kit and Auth's `SecretSource` is A4's convergence; a guard would freeze it
  or force A4 early); no static production-refusal guard (the runtime tests of the kit, Auth, File, Notification, Billing and Payment
  already prove each refusal against the published values; the catalog guard closes the one structural gap they cannot see); no
  general secret scanner (A14); no template-per-service rule; no service-template ↔ loader matching.
- **Note on §4:** the guard reads the catalog as source text, not through `@nawara/service-kit/testing`, so `check:repo` needs no
  built `dist/`.
- **Evidence (local):** `test:repo` 120 passed (111 before; 9 new fixture tests, including a runner-wiring test); `check:repo` green
  on the real repository. Negative controls, each red when mutated and restored byte-for-byte: the `.env.*` ignore rule removed; the
  Docker rules removed; one catalog fingerprint removed (diagnostic names the variable only); a `process.env` read added to a runtime
  file; one newly documented variable removed from each README; each guard disconnected from the runner. Cost: `check:repo` 1.39 s →
  1.44 s, `test:repo` 2.48 s → 2.73 s.
- **Production:** GREEN. Checker, tests and documentation only; nothing was deployed, rotated or inspected. RED: none; no G6
  dependency.
- **Next:** A2.6, the A2 certification (reconciliation of A2.0 to A2.5, open-blocker review, proportional final validation). A2
  stays OPEN until then.

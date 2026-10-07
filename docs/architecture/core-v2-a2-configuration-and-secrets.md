# Core V2 A2: configuration and secrets

- **Status:** RECORD of A2.0 discovery and A2.1.0 design (both read-only, owner-reviewed, 2026-10-07, on `main` at `321ec0b`, the
  PR #222 merge) and of **A2.1: service-kit configuration hardening**, **complete locally, owner review pending** (§4). **A2 is OPEN.**
  A2.2 to A2.6 are not started.
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
A2.1  service-kit hardening             ✅ complete locally; owner review pending
A2.2 – A2.6                             not started
```

A2 is OPEN. Unchanged: A3.6 and A3.7 deferred; A12.10 not started; G4 and G6 deferred; G7, F6 and F7 locked; Final Core Validation
absolute last.

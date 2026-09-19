# auth-service — security review and implementation report

- **Date:** 2026-09-18
- **Canonical references:** the migrations in `apps/auth-service/db/migrations/` (schema of record),
  [ADR-0026](../adr/0026-authentication-is-not-entitlement.md) (data model / entitlement boundary),
  [ADR-0027](../adr/0027-service-layer-security-model.md) (service-layer model). The PDFs
  `auth-service-data-model.pdf` and `auth-service-data-model-adr-0024.pdf` describe superseded models;
  `auth-service-data-model-adr-0026.pdf` predates migration `0003` (see the regenerated
  `auth-service-data-model-adr-0027.pdf`). None of them is implementation authority.
- **How to run the evidence:** `npm run test:all -w auth-service` (unit + integration, real PostgreSQL) and
  `npm run test:db -w auth-service` (SQL invariants, concurrency race, migration safety).

## 0. Baseline: what existed

`auth-service` was a 148-line Nest scaffold (liveness route, throttler, RabbitMQ publisher) plus the SQL
schema and design documents. **There was no authentication, authorization, session, MFA, recovery or
operator code in the repository to audit.** This report therefore covers (a) weaknesses found in the
*design* while implementing it, (b) the implementation, and (c) what is still not done. Nothing below is
claimed unless a test, migration or run supports it. `payment-service` is likewise only a scaffold.

## A. Findings

| # | Sev | Component | Finding → impact | Fix | Tests | Remaining |
|---|---|---|---|---|---|---|
| F1 | **Critical** | Owner recovery (ADR-0025 as written) | "password + key ⇒ revoke factors, enroll a new one" is an **instant takeover** of the company's highest-privilege identity by anyone holding two commonly co-stored values, with no delay or chance to react | Recovery is a **request with a cool-down** (default 24 h): `start` changes nothing and alerts; owner can cancel; `complete` needs the token **and the key again**, revokes, spends the key, issues **only an enrollment token** (ADR-0027 §1). DB makes cool-down immutable and the record undeletable | `recovery.e2e-spec.ts` (9), `invariants.sql` REC | Attacker with password + key who stays unnoticed for the whole cool-down still wins (inherent; see D) |
| F2 | **Critical** | Enrollment | An owner with zero *confirmed* factors always got `enrollment_required` from a **password alone**. After a factor was revoked (clone detection, recovery completion) anyone with the password could plant their own factor, bypassing key and cool-down. Found while writing the passkey clone test; my first recovery test even asserted the vulnerable behaviour | Password-only enrollment only if the owner has **never** had a factor; otherwise `recovery_required`. Tokens minted before the first confirmed factor die permanently; factor revocation kills outstanding enrollment tokens | `recovery.e2e-spec.ts`, `webauthn.e2e-spec.ts`, `owner-auth.e2e-spec.ts` | Bootstrap window (below) |
| F3 | High | Session/JWT | Revocation was "immediate" only for `PlatformAssignment` lookups; a disabled user, revoked session or expired operator ceiling would have kept working until token expiry | `AuthGuard`: DB-authoritative `kind`, `isActive`, active session family on **every** protected route; claims can't promote (adminTier must equal DB kind) | `tokens.e2e-spec.ts`, `platform-authz.e2e-spec.ts`, `operator.e2e-spec.ts` | Downstream services verifying JWTs locally see revocation only after the access TTL (≤ 60 min, default 15) — they must use the live check |
| F4 | High | Operator code storage (ADR-0011) | Bare `SHA-256` of a 6-digit code is recovered by a 10^6 offline search if the table leaks | HMAC-SHA-256 with a pepper held outside the DB; DB refuses non-64-hex values | `operator.e2e-spec.ts`, `crypto.spec.ts`, SQL OPC | — |
| F5 | High | Brute force | DB `attemptCount ≤ 5` per code doesn't stop spreading guesses across operators, IP rotation, or free probing of `request-code` | Bucketed DB-backed limiter: per operator (**independent of IP**), per IP, **global**; success clears the per-operator counter; windows self-expire | `operator.e2e-spec.ts`, `owner-auth`, `recovery`, `tokens` | Per-operator lockout can be used to *annoy* a specific operator for one window (accepted; window is short and configurable) |
| F6 | High | TOTP | No replay protection: an observed code is valid for ~90 s | Time step accepted at most once per factor (`lastUsedCounter`, atomic) | `owner-auth.e2e-spec.ts` | A step-up straight after a login in the same 30-s step must wait for the next code (UX, by design) |
| F7 | High | Register | Client-supplied `role` could be `admin` (ADR-0024) | Reserved value rejected; DTO whitelist rejects `kind/adminTier/platformId/companyId`; DB CHECK | `members-payment.e2e-spec.ts` | — |
| F8 | Medium | Pre-existing `EventsPublisherService` | `publish()` promise never handled ⇒ a broker failure is an unhandled rejection (crash) or a silently dropped security alert | `.catch` with log of the routing key only | oxlint clean | Events are fire-and-forget; no outbox/retry |
| F9 | Medium | Register / payment | Fail-closed relied on the payment *client* mapping errors; any other error became `500` | Caller enforces `503` for **any** failure | `members-payment.e2e-spec.ts` | — |
| F10 | Medium | Refresh | A merely *revoked* token (logout) was treated as "reuse" (false theft alarms, noisy audit) | Only a **rotated-out** token is reuse → family revoked + audited; revoked → plain refusal | `tokens.e2e-spec.ts` | — |
| F11 | Medium | Passwords | bcrypt silently truncates >72 bytes | 10–72 byte policy, never truncate; `hash` async | `crypto.spec.ts`, `members-payment` | — |
| F12 | Medium | Payment design | `payment-service` status endpoints are documented as protected only by "network-level trust" | Auth sends a service bearer token and fails closed; contract in §F | — | **Unresolved:** requires implementation on the payment side; no service-to-service auth exists there |
| F13 | Medium | JWT | HS256 requires the signing key on every verifier | Kept (single verifier today); documented | — | Move to EdDSA/RS256 before other services verify locally |
| F14 | Low | Schedule | "Zero schedule rows = unrestricted" means a new operator can work any day/hour with an 8 h ceiling until a schedule is set | Preserved, documented, returned as an explicit reason | `operator.e2e-spec.ts` | Deliberate |
| F15 | Info | ADD | Mermaid `graph LR` failed to parse (**pre-existing**; unquoted dotted-edge label containing `.`) — unrelated to security or the data model | Label quoted; both diagrams now render | parser check | — |

## B. Authentication matrix

| Actor | Authentication | MFA / step-up | Session | Scope |
|---|---|---|---|---|
| **Member** | email **or** phone + password (bcrypt); generic `401`; rate limited | none (platform may add its own) | access JWT (≤60 min, default 15) + rotating refresh (14 d); family-level reuse detection | own Organization → its Platform → Company; `role` opaque to auth |
| **Owner** | email/phone + password → **`mfa_required`** → TOTP or passkey (UV required) → tokens. Never tokens from a password alone. Secret key is **not** a login credential | second factor at login; **step-up** (TOTP / passkey / secret key per purpose) for grant, revoke, create, rotate key, factor change, password change | same tokens + `sid`; a step-up is bound to the session | all platforms where `Owner.companyId = Platform.companyId`; no PlatformAssignment |
| **Operator** | **no password.** One-time working code (HMAC-stored, 6 digits, CSPRNG) delivered out of band | none at login; owner-only actions are not available | temporary: access `exp` and refresh `expiresAt` clamped to the shift ceiling (or flat fallback); a new code each working day | only platforms with a **current active** PlatformAssignment, checked live per request |

## C. Authorization matrix

| Resource | Owner | Operator | Member |
|---|---|---|---|
| Company | own company (via `Owner.companyId`) | none | none |
| Platform in own company | **allow**, no assignment | **allow only** with an active assignment | none |
| Platform in another company | deny (`404`) | deny (`404`) | deny |
| Organization | every org under own platforms | orgs under assigned platforms | own org only (`membership`) |
| Grant / revoke assignment | **yes** + step-up; `assignedBy`/`revokedBy` derived from the session | no (`403`) | no (`403`) |
| Business permissions (student, teacher, manager…) | not auth's concern | not auth's concern | not auth's concern — platform services decide |

Resolution order for platform-scoped requests: `resource → organization → platform → actor's
Owner.companyId / active PlatformAssignment → allow|deny`; the platform is **never** taken from the
client. Denials (missing, other company, not assigned) are one collapsed `404`.

## D. Recovery model

| Situation | Path |
|---|---|
| Normal owner login | password → `mfa_required` → TOTP **or** passkey → session |
| **Bootstrap** (never enrolled) | CLI creates owner + company, **no key, no factor**. First sign-in → `enrollment_required` (restricted token, single use) → enroll TOTP/passkey → first session. Rotate the secret key later (factor step-up). *The bootstrap password is one-time; deliver out of band.* |
| Lost **one** factor (another remains) | log in with the other; step-up with it (`owner.factor.remove`, `owner.factor.enroll`); the last factor can never be removed |
| Lost **TOTP** / lost **passkey** and it was the only factor | secret-key recovery (below); there is no password-only path |
| **Secret-key recovery** | `start` (password + key) → **cool-down** (alerts; owner may cancel from a working session; nothing changes) → `complete` (recovery token + key again) → all factors/sessions revoked, key spent, **enrollment token only** → enroll a new factor → session |
| Suspected clone of a passkey | assertion rejected, that passkey revoked, audited; if it was the only factor → recovery |
| Factor replacement (planned) | enroll the new one (needs step-up once a factor exists), then remove the old one (step-up) |
| Key leaked, factors intact | ADR-0017 ops CLI reset, or rotate via factor step-up; a leaked key cannot rotate itself |
| Forgotten **password** | **not implemented** in-band (would need an out-of-band reset); ops path only |

What an attacker can do holding… **password only:** reach the MFA challenge, nothing else · **key only:** nothing (password required; the key can't satisfy factor-only step-ups) · **password + key:** *start* recovery, then must stay unnoticed for the whole cool-down · **password + contact channel:** no bearer path (no email/SMS reset exists) · **a stolen live session:** cannot recover, cannot rotate the key, change the password, add/remove factors (each needs a *factor* step-up); can still act within the scope the session already has until it ends.

## E. Key management

Everything enters through `src/config/app-config.ts`; **no defaults; the process refuses to start** if any secret is missing, < 32 random bytes, malformed, or shared between purposes. Values are read from `NAME` or a mounted file `NAME_FILE` (K8s/Docker secret, Vault/KMS sidecar). Never in the database, never logged (tests assert this across logs, audit, events and all security tables).

| Secret | Purpose | Algorithm | Source | Lifetime / rotation | Stored form |
|---|---|---|---|---|---|
| `JWT_SECRET` | sign/verify access tokens | HMAC-SHA-256 (HS256), iss/aud pinned, alg allow-list | env / file | rotate → all access tokens invalid (≤ TTL); refresh continues | — |
| `TOTP_ENCRYPTION_KEYS` (ring) + `_ACTIVE_KEY_ID` | seal TOTP shared secrets | AES-256-GCM, 96-bit random nonce, AAD `ownerId|factorId`, key id stored per row | env / file (KMS-backed loader can replace it) | add key → activate → `reseal-totp-keys` → verify 0 rows on old id → remove | ciphertext `v1‖nonce‖ct‖tag` + `secretKeyId` |
| `OPERATOR_CODE_PEPPER` | operator code digest | HMAC-SHA-256 over `operatorId‖purpose‖code` | env / file | rotating invalidates live codes only (≤ 1 shift) | 64-hex |
| `SECRET_KEY_PEPPER` | owner secret-key digest | HMAC-SHA-256 over `ownerId‖key` | env / file | rotating invalidates every key → all owners must re-issue (needs factor step-up) — **plan carefully** | 64-hex |
| `THROTTLE_KEY_PEPPER` | rate-limit keys | HMAC-SHA-256 | env / file | any time (counters reset) | 64-hex |
| `JOIN_CODE_PEPPER` | organization join codes and member contact-verification codes (distinct HMAC domain labels) | HMAC-SHA-256 | env / file (generated by the deploy script) | rotating invalidates every issued join code and any pending verification code; re-issue codes | 64-hex |
| `PAYMENT_SERVICE_TOKEN` | auth → payment bearer | opaque, ≥ 32 chars in prod | env / file | with payment-service | — |
| Passwords | member/owner login | bcrypt (`bcryptjs`), cost 12 (config), per-hash salt, 10–72 bytes | — | — | bcrypt string |
| Refresh / challenge / enrollment / recovery tokens | bearer credentials | 256-bit CSPRNG; **SHA-256** of the token stored (already high entropy) | `crypto.randomBytes` | single use / rotating | 64-hex |
| Operator code | daily working code | `crypto.randomInt` 0–999 999 | CSPRNG | shift end / flat 8 h; single use | HMAC digest |
| Owner secret key | step-up / recovery | 256-bit CSPRNG, base32 groups | CSPRNG | until rotated/spent | HMAC digest |
| TOTP | second factor | RFC 6238, HMAC-SHA-1 (authenticator-app interoperable), 6 digits, 30 s, ±1 step, replay-protected | otplib | — | encrypted secret |
| WebAuthn | passkeys | `@simplewebauthn/server`; UV required; RP ID/origins from config; counter regression ⇒ clone suspicion | — | — | public key only |

All cryptography is from Node `crypto`, `bcryptjs`, `jose`, `otplib`, `@simplewebauthn/server`; no primitive is hand-written. **Infrastructure prerequisites:** provision these secrets from a secret manager; store the TOTP key ring with backup (losing the active key makes every TOTP factor unreadable ⇒ all owners need recovery); set `TRUST_PROXY` only behind a proxy you control; restrict the DB role (no `session_replication_role`, no `TRUNCATE`).

## F. Payment integration (review of the Auth ↔ Payment boundary)

**Principle held:** Auth answers *who and which authenticated context*; Payment answers *what entitlement*; platform services answer *what business action*. Verified by tests: no license/subscription/trial/plan/billing column in any auth table; no such claim in any token; login/refresh **never** call payment-service (including when it is down or the license lapsed); no cross-service FK.

**Contract (what each side must do):**

1. **Auth → Payment (registration only, ADR-0004/0026):** `GET /payment/licenses/:organizationId/status` with `Authorization: Bearer <PAYMENT_SERVICE_TOKEN>`; timeout 3 s; **any** failure ⇒ `503` (fail closed); unknown/unlicensed ⇒ the same generic `403`.
2. **Platform service → Payment (point of use):** use the `organizationId`/`userId` from a **verified** token and the same service credential; **decide fail-open vs fail-closed per capability** (paid features fail closed; core read access may degrade) and document it in that service. A platform service that forgets the check fails **open**.
3. **Propagation / staleness:** entitlement is never cached by Auth. Consumers may cache a positive answer for a short TTL (recommended ≤ 60 s) and must re-check on cancellation/refund events; `payment-service` should emit license/subscription state-change events (ADR-0006/0008) for that.
4. **Expiry / cancellation / refund:** these change payment state only. Identity, sessions and `PlatformAssignment` are untouched; the *platform* decides what a lapse blocks.
5. **Who may ask:** payment-service must authenticate its callers (service credential) and should authorize that the asking platform serves the organization in question (ADR-0021 uses auth's `GET /auth/organizations/:id` for this — **not implemented**).

**Findings:** F12 (payment status endpoints have no service-to-service authentication in their own design) — Auth-side credential and fail-closed handling are implemented; the payment-side enforcement does not exist because the service is a scaffold. **Deployment prerequisite.**

## G. Route / security matrix

Classes: **public** · **public + challenge** (opaque single-use token) · **member** · **owner** · **operator** · **owner|operator** · **+ step-up** · **enrollment token**. Every non-public route is behind `AuthGuard` (live). All bodies are DTO-validated with `forbidNonWhitelisted`. Unknown/foreign resources are a collapsed `404`.

| Route | Class | Rate limit bucket(s) | Notes |
|---|---|---|---|
| `GET /` | public | baseline | liveness |
| `GET /auth/docs`, `/auth/docs-json` | HTTP basic auth | none (guard runs before Nest; long generated password) | not mounted unless `SWAGGER_PASSWORD` is set; constant-time compare |
| `POST /auth/register` | public | `register_ip` | kind=member only; `admin` reserved; org must exist + be licensed (payment, fail closed) |
| `POST /auth/login` | public | `login_ip`, `login_identifier` | owner ⇒ challenge, never tokens; generic `401` |
| `POST /auth/refresh` | public (refresh token) | `refresh_ip` | rotation; reuse ⇒ family revoked |
| `POST /auth/logout`, `GET /auth/me` | any authenticated | baseline | |
| `GET /auth/organizations/:id/membership` | member | baseline | **ACTIVE** membership of own org ⇒ 204, else 404 (pending/rejected are not admitted) |
| `POST /auth/onboarding/resolve` | public | `join_code_resolve_ip`, `join_code_resolve_global` | one generic 404 for every bad code; reason audited only |
| `POST /auth/register` | public | `register_ip` + the resolve buckets | body is `{joinCode, contact, password}` only; organization, platform, audience come from the code |
| `POST /auth/contact/request-code`, `/verify` | member | `contact_request_user`, `contact_verify_user`, `contact_verify_ip` | gates access only when `REQUIRE_CONTACT_VERIFICATION=true` |
| `GET/POST /auth/organizations/:id/join-codes`, `.../:codeId/revoke` | owner (step-up) \| operator \| org admin | `join_code_manage_actor` | plaintext returned once |
| `GET /auth/organizations/:id/memberships`, `POST .../:mid/approve\|reject` | owner \| operator \| org admin | `membership_op_actor` | one transaction, conditional UPDATE; nobody decides their own |
| `POST/DELETE /auth/organizations/:id/memberships/:mid/admin` | owner + step-up (factor only) | `membership_op_actor` | org admins cannot use THIS route to mint admins (they can invite one via an invitation, see below) |
| `POST /auth/onboarding/invitations/resolve`, `.../accept` | public | `invitation_resolve_ip`, `invitation_resolve_global`, `invitation_accept_ip` | one generic 404/403; accept is single-use and atomic; no license asked |
| `POST/GET /auth/organizations/:id/admin-invitations`, `.../:invId/revoke` | owner (step-up, factor only) \| org admin; operators refused | `invitation_manage_actor` | plaintext returned once; server computes expiry |
| `POST /auth/admin/login/owner/webauthn-options` | public + challenge | `owner_verify_ip`, `owner_verify_owner` | |
| `POST /auth/admin/login/owner/verify` | public + challenge | same | TOTP/passkey; 5 attempts kill the challenge |
| `POST /auth/admin/enroll/{totp,totp/confirm,webauthn/options,webauthn}` | enrollment token | `factor_enroll_owner` | only for never-enrolled or recovery-issued; single use |
| `GET/POST /auth/admin/factors…`, `POST …/factors/totp/confirm`, `POST …/factors/webauthn` | owner | `factor_enroll_owner` | confirm/register need step-up `owner.factor.enroll` once a factor exists |
| `DELETE /auth/admin/factors/:id` | owner + step-up `owner.factor.remove` | | never the last factor |
| `POST /auth/admin/step-up/webauthn-options`, `POST /auth/admin/step-up` | owner | `step_up_owner`, `step_up_ip` | purpose allow-list; key rejected for factor-only purposes |
| `POST /auth/admin/secret-key/rotate` | owner + step-up (factor only) | | key returned once |
| `POST /auth/admin/password/change` | owner + step-up (factor only) | | ends all other sessions |
| `POST /auth/admin/recovery/start` | public (password + key) | `recovery_ip`, `recovery_identifier` | opens cool-down; changes nothing |
| `POST /auth/admin/recovery/complete` | public (recovery token + key) | same | after cool-down; enrollment token only |
| `POST /auth/admin/recovery/cancel` | owner | | |
| `POST /auth/admin/login/operator/request-code` | public | `operator_request_ip`, `_identifier` | always `204` |
| `POST /auth/admin/login/operator/verify-code` | public | `operator_verify_{identifier,ip,global}` | generic `401`; shift-clamped session |
| `POST /auth/admin/operators/confirm` | public | `operator_confirm_ip`, `operator_verify_identifier` | idempotent, no oracle |
| `POST /auth/admin/operators` | owner + step-up `operator.create` | | company from the owner |
| `POST /auth/admin/operators/:id/{block,unblock}` | owner | | emergency control, deliberately **no** step-up |
| `GET /auth/platform-access/:platformId` | owner\|operator | baseline | live decision |
| `GET /auth/admin/organizations/:id` | owner\|operator | baseline | resource→org→platform |
| `POST/DELETE /auth/admin/operators/:id/platform-assignments[/:platformId]` | owner + step-up | | `assignedBy`/`revokedBy`/`companyId` derived, never accepted |
| `GET /auth/admin/operators/:id/platform-assignments` | owner | | history |

**Designed but not implemented:** device registration, `POST /auth/organizations/validate`, organization/platform CRUD, operator profile/schedule/time-off/calendar endpoints, `GET /auth/organizations/:id` (payment's platform-scope lookup), owner password reset, notification-service consumers.

## H. Rate limits (all configurable: `RATE_<BUCKET>_LIMIT` / `_WINDOW_SEC`)

Defaults are conservative starting points, not measured values: login 60/15 min per IP and 10/15 min per identifier · owner verify 8/5 min per owner, 30/5 min per IP · step-up 10/5 min · factor enroll 10/h · recovery 5/h per identifier, 10/h per IP · operator code request 5/h per identifier · operator verify **10/15 min per operator (IP-independent)**, 40/15 min per IP, **600/min global** · refresh 120/15 min per IP. Counters are shared across instances (Postgres), keyed by HMAC.

## I. Audit events (`auth_audit_event`, append-only, secret-free, ≤ 2 KB)

`auth.login`, `owner.login`, `owner.login.password`, `owner.step_up`, `owner.step_up.consume`, `owner.factor.enrolled|removed`, `owner.webauthn.clone_suspected`, `owner.secret_key.rotated`, `owner.password.changed`, `owner.recovery.start|complete|cancel`, `operator.code.request|issued`, `operator.login`, `operator.contact.confirmed`, `operator.create`, `platform_assignment.grant|revoke`, `session.refresh_reuse_detected`, `account.disabled|enabled`. Metadata keys that look like credentials are dropped by the sanitizer; tests confirm no raw secret appears in logs, audit rows, broker events (other than the deliberate operator-code delivery) or any security table.

## J. Test evidence

| Suite | Count | What it proves |
|---|---|---|
| Unit (`src/**/*.spec.ts`) | 55 (last full run, 2026-09-18) | AES-GCM (tamper, AAD binding, nonces, rotation), HMAC encoding, CSPRNG code/key shape & distribution, bcrypt policy, config fail-closed and `_FILE` secrets, timezone/DST shift maths, audit redaction |
| Integration (`test/*.e2e-spec.ts`, real PostgreSQL) | 175 in 14 files (last full run, 2026-09-18; includes concurrency, hardening and onboarding specs) | owner MFA/TOTP/replay/attempts, real WebAuthn crypto (origin, RP, signature, UV, replay, counter/clone), step-up (purpose, session, expiry, single use, rollback), recovery abuse, enrollment, operator codes/lockout/throttling/shift ceiling/refresh ceiling/timezone/fail-open, live authorization incl. **revocation with a stale token**, tenancy attacks, assignment races, refresh rotation/reuse, `isActive`, payment boundary, secrets never leaked, bootstrap CLI, TOTP key rotation |
| Database (`db/tests/run.sh`) | 227 assertions (0 failing) + 12-way race + migration scenarios M1–M6 | every schema invariant (ADR-0024/0025/0026 and migration `0003`) |
| Mutation check | 16 service guards + 9 database guards | each guard removed in turn ⇒ the matching tests fail |

## K. Remaining risks and prerequisites

**Unresolved / accepted**
1. Recovery residual (D): password + key + a full unnoticed cool-down. Consider an out-of-band confirmation channel (ADR-0027 open question).
2. Bootstrap window: the bootstrap password is one-time; whoever enrolls first owns the account.
3. Downstream JWT verification sees revocation only after the access TTL; HS256 forces secret distribution to verifiers.
4. payment-service has no service-to-service authentication yet (F12); platform services may forget the entitlement check (fails open).
5. Not implemented: owner password reset, notification delivery (events only; raw one-time codes travel over the broker — short queue TTL, no payload logging), pruning of `auth_throttle`/`owner_auth_challenge`, CI job for the DB/e2e suites, device registration, org/platform CRUD and the other endpoints listed under G.
6. Timing side channel: `request-code` does more work for an eligible operator than for an unknown one (the response is identical; latency is not).
7. `session_replication_role = replica` and `TRUNCATE` bypass triggers/FKs — enforce by database privileges.
8. Rate-limit numbers are unmeasured defaults.

**Infrastructure prerequisites:** secret manager for the six secrets (JWT, three peppers, join-code pepper, TOTP key ring) + payment token; backed-up TOTP key ring; https origins and RP ID for WebAuthn; proxy configuration (`TRUST_PROXY`) if applicable; a PostgreSQL role without replication/truncate rights; a notification-service consumer for `admin.*` events; a scheduled prune job.

## L. Addendum: organization onboarding and a deadlock found in review (2026-09-18)

- **Join codes, membership, org admins (ADR-0028).** New attack surface: code enumeration (rate limited per IP
  and globally, 50-bit codes, one generic answer), client-chosen organization/audience (rejected by the
  validation pipe; resolved server-side), code over-use (atomic conditional UPDATE plus a CHECK), cross-company
  codes (composite FK), pending members reaching the organization (active membership required, from current
  rows), illegal membership moves (trigger). Evidence: `test/onboarding.e2e-spec.ts` (36 tests), SQL groups
  `JC`/`MEM`/`CV`/`PK` and migration scenarios M5/M6.
- **F16 (High) — WebAuthn counter compare-and-set deadlocked.** The fix for a racing clone assertion revoked the
  passkey over a second connection while the first held a row lock, so the request hung forever. Found by the
  forced-interleaving test; fixed by revoking on the same connection. `test/webauthn.e2e-spec.ts` now passes.
- **Open:** verification codes and approval notices have no delivery channel (event only), so
  `REQUIRE_CONTACT_VERIFICATION` must stay off in production; teacher approval does not re-check the
  organization license (contract undecided).

## M. Addendum: admin invitations (2026-09-18, ADR-0029)

- **New attack surface and controls.** Privilege provisioning by guessing (60-bit random code, per-IP and global
  throttles, one generic answer), replay and races (single conditional UPDATE plus a database trigger; 8
  simultaneous acceptances give exactly one account), wrong-person interception (optional HMAC contact binding, a
  mismatch does not consume it), long-lived credential (server-computed expiry inside a configured 15 min to 7 day
  range, DB 30-day backstop), credential confusion (own table and HMAC domain; a join code is not an invitation and
  the reverse), reserved-role abuse (`admin` refused), session confusion (invitation lifetime is independent of the
  session).
- **Residual risks.** An organization admin can mint further admins on their session alone (no member step-up
  exists); delivery of the code is out of band and unbuilt; recovery policy for an organization with no admin is
  undefined; acceptance asks no license (deliberate, ADR-0029).

## N. Addendum: multi-organization membership and audit (2026-09-19, ADR-0030)

Every row below is derived from the code (`organizationAuthority`, controller `@Actors`, `STEP_UP_METHODS`) and
verified by a named test. **No permission is invented.** "404" is the collapsed answer (no such resource, not yours,
not allowed: indistinguishable). "403" is the actor-kind refusal of the guard, which reveals nothing about a resource.

### N1. Authorization matrix

| Operation | Owner (own company) | Operator (assigned platform) | Org admin (that organization) | Active member | Pending member |
|---|---|---|---|---|---|
| Create organization | **No route in Auth** (no actor can; provisioned outside the API) | none | none | none | none |
| Create platform | **No route in Auth** (`platform.create` step-up purpose is reserved, unused) | none | none | none | none |
| Create join code | yes, factor or secret-key step-up `join_code.create` | yes, no step-up | yes, no step-up | 404 | 404 |
| Revoke join code | yes, step-up `join_code.revoke` | yes | yes | 404 | 404 |
| Approve / reject membership | yes, no step-up | yes | yes | 404 | 404 |
| Revoke membership (ADR-0030) | yes | yes | yes, **not another admin** (404), never self | 404 | 404 |
| Grant / revoke org admin | **Owner only**, factor-only step-up (`organization.admin.*`) | 403 | 403 | 403 | 403 |
| Create / revoke admin invitation | yes, factor-only step-up | **404** (refused) | yes, session only | 404 | 404 |
| Create operator | yes, step-up `operator.create` | 403 | 403 | 403 | 403 |
| Assign / revoke operator platform | yes, step-up `platform_assignment.*` | 403 | 403 | 403 | 403 |

Evidence: `test/tenant-isolation.e2e-spec.ts` (19 routes x 4 actor kinds), `test/members-payment.e2e-spec.ts`,
`test/admin-invitation.e2e-spec.ts`, `test/multi-membership.e2e-spec.ts`, `test/platform-authz.e2e-spec.ts`.

### N2. Tenant-isolation matrix (Company A actor against Company B resource)

| Resource | Application check | Database constraint | Test | Result |
|---|---|---|---|---|
| Organization / membership list / decisions | `organizationAuthority` from the organization's platform's company | composite FKs company→platform→organization | tenant-isolation (19 routes) | uniform 404, identical to a nonexistent id, no state change |
| Membership by id under another organization's URL | `WHERE id AND "organizationId"` | `membership_organization_fk`, `UNIQUE(userId, organizationId)` | tenant-isolation | 404 |
| Join code / admin invitation | id scoped by organization | composite FK to organization and platform | tenant-isolation | 404 |
| Operator and assignment | owner's company must match operator's | composite FK, assignment same-company guard | tenant-isolation, `platform-authz` | 404 |
| Member reads another organization | active membership row of THAT organization | none needed | multi-membership | 404 |
| Audit log | no API | append-only guard | (no route to test) | not reachable |

### N3. Concurrency matrix (all run against real PostgreSQL)

| Scenario | Mechanism | Test | Observed |
|---|---|---|---|
| Two people redeem a one-use code | conditional `UPDATE ... usedCount < maxUses` | concurrency, multi-membership (6 users, max 2) | exactly 2 |
| Same user joins twice at once | `UNIQUE(userId, organizationId)`, tx rollback | multi-membership | 1 membership, 1 use spent |
| Simultaneous approve/reject/revoke of one membership | row lock + conditional UPDATE + trigger | members-payment, multi-membership (8 revokes) | 1 winner, others 409, 1 audit event |
| Revoke while the member's requests are in flight | live check per request | multi-membership | no 5xx; refused after commit |
| Admin acts while being revoked | flag cleared in the same statement | multi-membership | no 5xx; authority gone |
| Grant vs revoke of the admin capability | single-row UPDATE, audit only on change | multi-membership (3 rounds) | one serial order, audit count matches |
| Operator assignment revoked while operating | live `check` per request | multi-membership | no 5xx; 404 after commit |
| Two acceptances of one invitation | conditional consume | admin-invitation | exactly 1 |
| Two logins consuming one step-up / recovery | conditional consume | step-up, recovery | exactly 1 |
| WebAuthn counter replay | compare-and-set on one connection | webauthn | 1 winner (see F16) |

Mutation checks (each guard broken on purpose, the tests must fail): revoke without the row lock and status
predicate (3 failures), revoke without clearing the admin flag (3 failures), duplicate join not mapped to 409 (2),
redeem without the `maxUses` predicate (1). All restored; the unmutated spec passes.

### N4. Findings of this audit

- **F17 (Medium, fixed) — a business label on the identity.** `user.role` held the join code's audience and flowed
  into the JWT. It cannot describe several memberships and invites consumers to trust an Auth-issued business role.
  Now `member` (neutral), enforced by `user_role_is_kind_neutral`; the label lives on the membership.
- **F18 (Medium, fixed) — a person needed one account per organization.** Structural (`user.organizationId`). Now N
  memberships; `POST /auth/onboarding/join`.
- **F19 (Low, fixed) — no way to remove a member.** `revoked` state and route added.
- **F20 (Low, fixed) — `CORS_ORIGINS` accepted `*`, paths and bare hosts unvalidated.** Now startup fails
  (`ConfigError`) unless every entry is an exact http(s) origin. Unit test added.
- **F21 (Low, fixed during implementation) — missing FK.** Dropping the user's organization column left
  `membership.organizationId` without a foreign key; caught by the SQL suite and added (`membership_organization_fk`).
- **F22 (Medium, open) — operators and org admins decide memberships, create join codes and revoke without step-up.**
  Deliberate (ADR-0028: operators have no second factor; members have none); an admin cannot revoke another admin
  and cannot grant the flag. Mitigations: audit on every action, per-actor throttle (`membership_op_actor`; the join route adds `membership_join_user`, 10/hour). Needs a decision on MFA for
  operators before broader use.
- **F23 (Info) — no API creates an organization or a platform.** The ADD describes an `OrganizationManagementService`
  (`POST/PATCH /auth/admin/organizations`) that does **not exist in the code**: only `GET /auth/admin/organizations/:id`
  does. Only the owner CLI creates a company. Where the
  business creates them (platform services, SQL, a future admin API) is undecided; nothing was invented here.

### N5. Production checklist

| Item | State |
|---|---|
| Schema, constraints, migrations with rollback, SQL invariant suite | READY (verified on scratch PostgreSQL 16; migrations tested on data) |
| Authentication, MFA, step-up, sessions, throttling, live authorization | READY |
| Tenant isolation and 404 hiding | READY (tested) |
| Deploy of `0006`/`0007` on merge | NEEDS VERIFICATION (watch `schema_migrations`; breaking token/`/auth/me` shape) |
| CI that runs the suites; deploy that cannot mask a failed script (`-euo pipefail`, concurrency group) | **BLOCKER** (classified, not built by choice) |
| Backup and **tested** restore | **BLOCKER** — never tested; needs a restore drill on the real volume |
| Least-privilege database role (app connects as a superuser) | **BLOCKER** |
| Production WebAuthn origin/RP id, first-owner bootstrap | **BLOCKER** (operational configuration) |
| Event delivery (verification codes, invitations, approval notices) | BLOCKER for enabling `REQUIRE_CONTACT_VERIFICATION`; NEEDS IMPLEMENTATION |
| Pruning of throttle/challenge rows | NEEDS IMPLEMENTATION (deferred) |
| Owner password reset, device registration, payment-service authentication | NEEDS IMPLEMENTATION (deferred) |
| Operator/org-admin step-up (F22), organization/platform creation path (F23) | NEEDS DECISION |

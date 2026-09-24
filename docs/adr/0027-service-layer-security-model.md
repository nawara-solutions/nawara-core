# 0027. Service-layer security model: cool-down recovery, enrollment rules, live authorization, shared security state, key management

- **Status:** Proposed
- **Date:** 2026-09-18
- **Deciders:** Anwar (project owner)

> **Forward note (2026-09-24):** [ADR-0046](./0046-notification-service-architecture.md) (Proposed) designs the notification
> service that consumes the code-carrying events below. It does not adopt a RabbitMQ message TTL: a TTL would move expired codes
> into the dead-letter queue, or purge unseen messages. Instead Notification enforces each code's `expiresAt`: an expired code is
> never sent, even when replayed from the DLQ, and it never logs payloads.

> **Amends [ADR-0025](./0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md)** on two points:
> owner recovery is no longer an immediate "password + secret key ⇒ factors replaced" action, and
> password-only enrollment is restricted to a never-enrolled owner. Implements the parts of
> [ADR-0024](./0024-database-enforced-tenancy-and-authorization-integrity.md),
> [ADR-0025](./0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md) and
> [ADR-0026](./0026-authentication-is-not-entitlement.md) that the database cannot enforce. Migration
> `0003` supplies the state it needs. Every other decision in those ADRs stands.

## Context

ADR-0024/0025/0026 fixed the *data model* and the intended flows. Turning them into a running service
(`apps/auth-service`, until now only a scaffold) forced several decisions the ADRs left open, and
exposed two real weaknesses in ADR-0025 as written:

1. **Recovery was an instant takeover.** "Password + secret key ⇒ revoke all factors, return an
   enrollment token" means anyone who obtains those two values (they are often stored together, e.g.
   in one password manager) can immediately replace the owner's second factor and become the owner —
   the single most privileged identity — with no delay and no chance for the real owner to react.
2. **A password alone could enroll a factor.** An owner with zero *confirmed* factors was always
   offered `enrollment_required`. That is right for a never-enrolled, bootstrapped owner. It is wrong
   after a factor existed and was revoked (clone detection, recovery completion): anyone holding just
   the password could then plant their own factor and bypass the secret key and any cool-down.
3. **State the design assumed but the schema lacked:** a replay counter for TOTP, single-use
   WebAuthn/login challenges, a place for recovery requests, shared rate-limit counters (correct across
   instances), and an audit trail.
4. **"Revocation takes effect immediately"** (ADR-0022/0023) was only true for `PlatformAssignment`
   lookups. Nothing stated what happens to an already-issued access token when a user is disabled, a
   session is revoked, or an operator's ceiling passes.
5. **No secure home for secrets** (TOTP encryption key, HMAC peppers, JWT key).

## Decision

### 1. Owner recovery is a cool-down *request*, never an immediate change

- `POST /auth/admin/recovery/start {identifier, password, secretKey}` — verifies **both** (dummy work
  when the account is unknown; one generic `401`), then creates a **pending** `owner_recovery_request`
  with `availableAt = now + RECOVERY_COOLDOWN_SEC` (default 24 h) and alerts the owner
  (`admin.owner_recovery_requested`). **Nothing is revoked, spent or issued.** MFA and existing
  sessions carry on unchanged. One pending request per owner; a new start supersedes the old.
- The real owner, alerted, cancels from any session that still has a working factor
  (`POST /auth/admin/recovery/cancel`).
- `POST /auth/admin/recovery/complete {recoveryToken, secretKey}` — only after the cool-down, and it
  needs the one-time recovery token **and the secret key again**. It revokes every factor and every
  session, **spends** the key (`secretKeyHash := NULL`), and returns **only an enrollment token** —
  never a session. The DB makes the cool-down immutable (it cannot be shortened by an `UPDATE`) and the
  request undeletable.
- A session is created only after a **new factor is confirmed** through that enrollment token.

What an attacker can do with X: password only → the MFA challenge, nothing more; secret key only →
cannot start (password needed); password **and** key → can *start*, then must remain unnoticed for the
whole cool-down; a stolen live session → cannot recover at all, and every account-changing action needs
a factor step-up (the key is not accepted for factor changes, rotation or password change). The
**residual risk** — an attacker who has password + key and stays unnoticed for the full cool-down wins —
is inherent to any recovery that does not use a second out-of-band party, and is documented as such.

### 2. Password-only enrollment exists only for the never-enrolled owner

- `beginLogin` returns `enrollment_required` **only** if the owner has *never* had a confirmed factor.
  If one ever existed and none is confirmed now, it returns `recovery_required` (no token).
- An enrollment token is honoured only while the owner has zero confirmed factors **and** the token was
  minted *after* the owner's first confirmed factor (or no factor ever existed). A token minted earlier
  is a bootstrap token and dies the moment a factor exists — however that factor later came to be
  revoked (even by a direct `UPDATE`). Revoking factors also kills outstanding enrollment tokens.
- The bootstrap password is therefore a **one-time credential**: deliver it out of band, and the owner
  must enroll before anyone else learns it. That window is an accepted, documented residual risk.

### 3. Authorization is evaluated against current state; revocation is immediate on auth-service's own routes

Every protected auth-service route runs `AuthGuard`: verifies the JWT (HS256 only; issuer/audience
pinned), then loads the **database** row and requires `isActive`, that the token's `adminTier` claim
equals the database `kind` (a token can never promote a member), and that the session (refresh family)
is still active. Consequences, stated explicitly:

- disabled user, logout, family revocation, reuse detection, block, recovery completion, password
  change and an operator's session ceiling all take effect on the **next request**;
- platform access is **never** read from a claim (the token carries no platform/company claim at all):
  `GET /auth/platform-access/:platformId` and the organization lookup re-query the current
  `PlatformAssignment`/`Owner` state every time (ADR-0022/0023);
- **downstream services** that verify the JWT locally see revocation only after the access-token TTL
  (default 15 min, max 60). That is exactly why they must call the live platform-access check rather
  than trust claims, and why the TTL is short.

### 4. Shared security state lives in the auth database (migration `0003`)

`owner_auth_challenge` (single-use login/enrollment/WebAuthn/step-up challenges, ≤30 min, digest-only
tokens), `owner_recovery_request`, `auth_throttle` (fixed-window counters keyed by HMAC of the
identifier/IP — correct across instances, no raw PII, self-expiring so nobody is locked out
permanently), `auth_audit_event` (append-only, size-capped, secret-free by construction), plus
`owner_auth_factor.secretKeyId` and `lastUsedCounter` (key rotation; a TOTP time step is accepted at
most once). No new datastore is introduced; if Redis is added later the throttle can move without
changing callers.

### 5. Keys and secrets

All secrets enter through one loader (`src/config/app-config.ts`), from `NAME` or a mounted file
`NAME_FILE` (the Kubernetes/Docker-secret/Vault-agent convention). There are **no defaults**; a missing,
short, duplicated or malformed secret stops the process. Five independent secrets: `JWT_SECRET`,
`OPERATOR_CODE_PEPPER`, `SECRET_KEY_PEPPER`, `THROTTLE_KEY_PEPPER`, and a **key ring** of AES-256-GCM
keys `TOTP_ENCRYPTION_KEYS` (`id:base64`, one marked active). TOTP secrets are sealed with AES-256-GCM,
a fresh 96-bit nonce, AAD binding owner and factor, the key id stored beside the ciphertext (the key
itself never in the database). Rotation: add key → make it active → `reseal-totp-keys` → confirm zero
rows remain under the old id → remove it. A KMS/HSM plugs in behind the same loader. Full inventory in
`docs/security/auth-service-security-review.md`.

### 6. Smaller decisions

- **Data access:** the service uses `pg` with parameterized SQL rather than TypeORM entities (ADR-0003
  named TypeORM). The schema of record is SQL (partial indexes, composite FKs, triggers are not
  expressible as entities) and security-critical operations need explicit transactions (step-up
  consumption commits with the operation it authorizes). Recorded as a deliberate deviation.
- **Step-up token = the `owner_step_up` row id** (UUIDv4, 122 bits). It is not a bearer credential: it is
  honoured only together with a live access token of *that owner and that session*, for *that purpose*,
  once, unexpired — all checked in one atomic `UPDATE … RETURNING` inside the operation's transaction.
- **Operator working code:** HMAC-SHA-256 with a pepper over `(operatorId, purpose, code)`; throttled
  per operator (independent of IP), per IP and globally; wrong guesses commit their attempt count;
  every failure is the same `401`. `request-code` always answers `204`.
- **Owner secret key:** 256-bit CSPRNG, stored as `HMAC-SHA-256(pepper, ownerId ‖ key)`; it satisfies
  grant/revoke/create step-ups but **never** factor-only purposes.
- **Refresh tokens:** a *rotated-out* token presented again is a theft signal (family revoked, audited);
  a merely *revoked* token (logout, block…) is just refused.
- **Payment:** `PaymentClient` is an injected port; the caller enforces fail-closed; login/refresh never
  call it (tested).

## Consequences

**Good** — the two ADR-0025 weaknesses are closed; every security rule that matters is exercised by a
test against a real PostgreSQL (and each critical guard was verified by mutation); secrets have one
loader and a documented rotation; revocation semantics are explicit instead of implied.

**Costs / risks**

- Recovery now takes at least the cool-down (default 24 h). If the owner really lost everything and the
  cool-down is unacceptable, ops must intervene (ADR-0017's CLI reset covers the key; account
  recovery has no faster in-band path by design).
- Live authorization costs 2 indexed reads per protected auth-service request.
- `auth_throttle` and `owner_auth_challenge` grow; a pruning job is needed (not built).
- Raw one-time operator codes transit the broker (`admin.operator_code_issued`) — the notification
  service must consume promptly, not log payloads, and the queue should have a short message TTL.
- Bootstrap enrollment relies on delivering the bootstrap password securely.

## Open questions

- Should recovery additionally require an out-of-band confirmation (e.g. a link to the *contact* on
  file) so the cool-down is not the only defence?
- HS256 needs the signing key on every verifier; moving to an asymmetric algorithm (EdDSA/RS256) with
  published keys would let downstream services verify without holding a signing secret.
- Whether `/docs` (Swagger) should be disabled or authenticated in production.
- The registration-time license check (ADR-0026 item 4) still couples onboarding to `payment-service`.

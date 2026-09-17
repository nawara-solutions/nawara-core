# 0010. Owner permanent secret-key login with new-device alerting

- **Status:** Accepted
- **Date:** 2026-09-16
- **Deciders:** Anwar (project owner)

## Context

Per ADR-0009, a platform's top-level administrator (`adminTier: "owner"`, scoped by
`platformId`) needs a way to log in that isn't tied to remembering or periodically rotating
a password. Today the only login path for any account, Admin included, is
`POST /auth/login` with `{email, password}` (per ADR-0002). A permanent, human-chosen
password is exactly the kind of low-entropy, rarely-rotated credential this owner login
wants to avoid depending on day to day.

At the same time, a credential that *never* expires is a real security exposure if it
leaks: unlike a short-lived access token or a rotating refresh token (per ADR-0002), a
static secret has no natural mechanism forcing it to become stale, so leakage has an
unbounded blast-radius window unless something else detects misuse. There is currently no
concept anywhere in this repo of a static/permanent server-issued credential, nor any
device-anomaly-alerting mechanism for account security purposes (the existing `Device`
entity, described below, exists for a different purpose).

## Options considered

1. **Block login outright from an unrecognized device** — the strictest response to an
   unrecognized device fingerprint. Rejected: this is not what was asked for (a passive
   alerting signal, not an enforcement mechanism), and it risks locking out a legitimate
   owner logging in from a genuinely new machine with no recovery path designed for that
   case.
2. **Require a second factor (e.g. a TOTP authenticator app) in addition to the secret key**
   — a materially stronger security posture. Rejected as bigger scope than requested: no
   TOTP (or any other MFA) infrastructure exists anywhere in this repo today (MFA is one of
   `docs/add/auth-service.md`'s five explicitly-deferred v1 features), and building it would
   be a separate, larger decision on its own.
3. **A trust-based, high-entropy secret key plus passive device-fingerprint alerting, with
   self-service rotation via the existing password login as the recovery path (chosen).**
   Detects and reports anomalies without blocking legitimate access, and reuses the existing
   password-login flow as the "break glass" recovery mechanism rather than designing a new
   one.

## Decision

We chose **Option 3**. Concretely:

- `User` gains `secretKeyHash: string | null` and `secretKeyIssuedAt: timestamp | null`.
  The key is hashed with **SHA-256, not bcrypt**. This is a deliberate departure from how
  `User.passwordHash` is hashed (bcrypt, per `docs/add/auth-service.md`'s non-functional
  constraints): a secret key is a high-entropy, server-generated value, not a low-entropy,
  human-chosen password, so it doesn't need bcrypt's deliberate slowness to resist brute
  force — a fast, deterministic hash is sufficient once the input space is large enough.
  The same reasoning applies to ADR-0002's refresh tokens, which are likewise persisted only
  as a hash rather than a bcrypt digest — though ADR-0002 itself doesn't name a specific hash
  algorithm or spell out this entropy-based rationale; this ADR states it explicitly for
  `secretKeyHash`/`fingerprintHash`.
- Exactly one active key per owner — a 1:1 relationship on `User` itself, no history table
  in v1. Rotating the key overwrites both `secretKeyHash` and `secretKeyIssuedAt`
  atomically, instantly invalidating the old key. This mirrors the "old token is fully
  superseded" semantics of refresh-token rotation (ADR-0002) — but deliberately **not** its
  rotation-reuse-detection bookkeeping (`familyId`, revoke-on-reuse), since there is no
  reuse-detection need here: an owner rotating their own key is always a legitimate,
  self-initiated action, not something that can be "replayed" the way a stolen refresh token
  can.
- New endpoint **`POST /auth/admin/login/secret-key`** — no authentication required (this
  *is* the login). Body `{secretKey}`. Looked up as `WHERE secretKeyHash = hash(input) AND
  adminTier = 'owner'` — the same hash-then-lookup shape `RefreshTokenService` already uses
  for refresh tokens. `platformId` is derived from the matched row; it is never supplied by
  the caller, so a caller cannot claim a platform they don't hold the key for. Returns
  `200 {accessToken, refreshToken, expiresIn}` on a match, a generic `401` otherwise.
- New endpoint **`POST /auth/admin/secret-key/rotate`** — Bearer-authenticated,
  `adminTier: owner` only, enforced by a new **`AdminTierGuard`**, parallel in shape to the
  existing `RolesGuard`, checking the `adminTier` JWT claim with no database round-trip (per
  ADR-0009). No request body. Returns the new raw key exactly **once**:
  `200 {secretKey, issuedAt}` — it is never retrievable again after this response; only its
  hash is ever persisted. Rotation is deliberately reached through the **existing**
  email+password login, not through the secret-key login itself — this is exactly why the
  secret key does not replace password login for owners: password login remains the
  recovery path an owner falls back to if their secret key is compromised, so they can log
  in and rotate it out from under an attacker.
- New **`AdminDevice`** entity for anomaly detection, deliberately **not** a reuse of the
  existing `Device`/`DevicesModule` (per `docs/add/auth-service.md`'s "Design rationale:
  device/network fingerprinting"). Two structural mismatches rule reuse out: `Device` is
  keyed by a client-generated `installId` established during an app's first-launch flow —
  a secret-key login has no such app/install context to draw one from — and a `Device` row
  starts deliberately unlinked to any user until one registers or logs in from it, whereas
  an admin-security device record is meaningless unlinked; it must always be tied to a
  specific owner from the moment it's created.
  - `AdminDevice {id, userId FK -> User, fingerprintHash (SHA-256 of the normalized
    User-Agent header), ipAddress (last-seen, informational only), firstSeenAt, lastSeenAt}`,
    with `UNIQUE(userId, fingerprintHash)`.
  - IP address is deliberately **excluded** from the identity hash — only the User-Agent
    contributes to `fingerprintHash`. An owner on a mobile connection or dynamic residential
    IP would otherwise trigger a false "new device" alert on every IP change, drowning the
    one signal that actually matters (a genuinely new machine/browser) in noise. IP is still
    carried in the resulting alert as context, just not as part of the device's identity.
    This is an accepted weak-fingerprint tradeoff for v1, stated explicitly here, not a gap
    to silently fix later.
- Flow on secret-key login: hash the normalized User-Agent header, look up `AdminDevice` for
  the matched owner.
  - **Found** → update `lastSeenAt`/`ipAddress` on the existing row, proceed to issue
    tokens.
  - **Not found** → insert a new `AdminDevice` row, publish a new event
    `admin.secret_key_login_from_new_device = {userId, platformId, channel: "email",
    destination, ipAddress, userAgent, timestamp}`, and **still issue tokens**. This is
    detect-and-alert only, not a block — an explicit requirement, not an oversight: no
    blocking mechanism was asked for, and adding one would be over-engineering beyond what
    was requested (see Options considered, option 1).
- Also publish **`admin.secret_key_rotated = {userId, platformId, timestamp}`** on every
  rotation. This is a small addition beyond the literal ask: if an attacker who has already
  compromised an owner's session rotates the key themselves (e.g. to lock the real owner
  out while keeping their own access), the real owner should still be told a rotation
  happened. This closes the loop the original "find a way to know when it's leaked" concern
  implies, rather than only covering the new-device case.

**Prominent departure from existing event shape:** unlike the existing `user.registered`
event (`{userId, role, organizationId, timestamp}` — no contact info at all),
`admin.secret_key_login_from_new_device` carries `destination`/`channel` inline. This is
deliberate, not an oversight. Per this repo's database-per-service principle, only
`auth-service` owns `User.email`/`User.phone`; `notification-service` has no independent way
to resolve a bare `userId` to a contact address, and this alert is time-critical — waiting on
a separate synchronous lookup back into `auth-service` would add a dependency and latency to
what's meant to be an urgent security notification.

## Consequences

- Gives platform owners a login option that doesn't depend on remembering or rotating a
  human-chosen password, while keeping password login alive specifically as the recovery
  path for a compromised secret key.
- `AdminTierGuard` becomes a new, generic, reusable authorization primitive (checking
  `adminTier` off the JWT with no DB round-trip) that ADR-0011's owner-only endpoints also
  depend on.
- The device-fingerprint signal here is deliberately weak (User-Agent only, no IP, no
  client-side install identifier) — the same explicitly-accepted tradeoff style
  `docs/add/auth-service.md`'s existing `Device` design already uses for `installId` being
  "self-reported and trivially reset." A sufficiently sophisticated attacker who spoofs the
  legitimate owner's User-Agent produces no alert at all; this is accepted for v1, not solved.
  Brute-forcing a SHA-256 preimage (finding an input that hashes to an already-stored digest)
  is not treated as a practical attack path here for `secretKeyHash`, since that hashed input
  is a high-entropy, server-generated value, not an adversarially chosen low-entropy one the
  way a password would be — the same reasoning that justifies skipping bcrypt above. This
  doesn't extend to `fingerprintHash`, whose input (a User-Agent string) is not high-entropy;
  that field's security relies on the alert being informational, not on the hash resisting a
  targeted preimage search.
- No history of past secret keys is kept (single active key, overwritten on rotation) — if a
  future need arises to audit past keys (e.g. "which key was active when this action
  happened"), that's new scope this ADR doesn't cover.
- Sharpens, but does not resolve, the existing open question of how Admin accounts are
  provisioned out-of-band (ADR-0001, sharpened further by ADR-0009): whatever that mechanism
  is, it must now also generate and hand off an owner's very first secret key at creation
  time, since there is no in-band way for an owner to obtain their first key otherwise.
- `docs/add/auth-service.md`'s existing "Rate limiting is an undesigned gap" bullet now
  explicitly also covers secret-key brute force at `POST /auth/admin/login/secret-key` — a
  high-entropy secret key resists guessing far better than a password, but the endpoint is
  still unauthenticated and unthrottled in this design.

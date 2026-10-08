# 0058. Access-token signing key ring

- **Status:** Proposed
- **Date:** 2026-10-08
- **Deciders:** Anwar (project owner, architecture owner)

> **Core V2 A4.6** ([A4 record](../architecture/core-v2-a4-authentication.md) §10). The owner approved the design decisions D1–D7 and the
> writing of this ADR; its acceptance is a separate, explicit decision. It implements the direction of OD-A4-6 and changes no Accepted
> ADR: [ADR-0002](./0002-jwt-access-token-with-rotating-refresh-token.md) (short-lived access JWT, rotating refresh token) and
> [ADR-0033](./0033-service-to-service-authentication-and-user-identity.md) (only Auth verifies user tokens) stay as they are. Where this
> ADR and an Accepted ADR differ, the Accepted ADR wins until this one is Accepted. Nothing here is implemented yet (A4.7), and nothing
> here authorizes generating, delivering or activating a production key.

## Context

Auth signs access tokens with one HS256 secret, `JWT_SECRET`, and verifies them with the same secret. Tokens carry no `kid`. Replacing
the secret rejects every live access token at once; clients recover by refreshing, because refresh tokens are opaque, hashed database
rows that no signing key touches. There is no overlap window, so a planned rotation is a visible outage of up to `ACCESS_TOKEN_TTL_SEC`
(900 s in production, at most 3600 s) for every client that does not refresh on a 401, and a compromised key can only be replaced the
same way.

Only Auth holds the key and verifies user tokens (ADR-0033); every other service asks Auth live. A rotation therefore concerns Auth's
configuration alone: no consumer, contract or event changes.

**Threat model.** The attacker can present any byte string as a bearer and can read every issued token (including its header). The
concerns are: algorithm confusion (`none`, another HMAC size, an asymmetric `alg`); a `kid` that selects no key, a retired key or a key
chosen by the attacker; downgrading a token to a weaker or leaked key by removing or changing its `kid`; header parameters that bring
their own key (`jwk`, `jku`, `x5u`, `x5c`); configuration that silently weakens verification (a missing, duplicated, reused or
non-random key); and secret values leaking through configuration errors or logs. A valid signature is necessary but never sufficient:
`AuthGuard` still re-reads the user and requires the token's session (`sid`) to be live.

## Options considered

1. **A symmetric HS256 ring selected by `kid`, with the existing `JWT_SECRET` as a kid-less legacy key** — keeps ADR-0002 and ADR-0033,
   needs no key distribution, gives an overlap window, and an unchanged `.env` behaves exactly as today. Rollback to an image without
   the ring is bounded (see Decision 8).
2. **Asymmetric signing (ES256 / EdDSA) with a key endpoint (JWKS)** — what local verification by other services would need; ADR-0033
   rejected local verification, so it adds a public endpoint and key-pair management for no consumer. Rejected.
3. **Verify against every configured key in turn, without `kid`** — no header change, but a token is accepted by whichever key matches,
   which defeats retirement ordering, lets a leaked old key keep minting tokens as long as it is configured, and multiplies the work for
   an invalid token. Rejected.
4. **Give the legacy key a reserved `kid` and stamp it on every token** — uniform headers, but tokens signed with the legacy key would
   differ from today's, so an image without the ring could not be rolled back to without rejecting them. Rejected.
5. **Keep a single key and accept outage-style rotation** — the status quo; no overlap window and no staged retirement. Rejected.

## Decision

We choose **option 1**.

1. **Variables (D1).** `JWT_SECRET` stays, unchanged, as the **legacy key**. Two new optional variables form the ring:
   `JWT_SIGNING_KEYS` (`id:base64[,id:base64]`) and `JWT_ACTIVE_KEY_ID` (a ring id, or the reserved value `legacy`, meaning
   `JWT_SECRET`). Both accept `_FILE` through the kit's `EnvReader`; setting `NAME` and `NAME_FILE` is refused.
2. **Valid combinations.** Neither ring variable set: today's behaviour exactly (`JWT_SECRET` required, signs and verifies). Both set:
   the ring is active. Exactly one set: refused. `JWT_ACTIVE_KEY_ID=legacy` requires `JWT_SECRET`. `JWT_SECRET` may be absent only when
   the ring is set and its active id is not `legacy`; kid-less tokens are then refused.
3. **Key material.** Ring ids follow the kit's key-ring id rule (1–32 letters, digits, `_` or `-`); `legacy` is reserved and refused as
   a ring id in any letter case; ids and keys never repeat; the ring holds **at most three** keys (**D4**). Every key is canonical
   standard base64 of at least 32 bytes and, in production, is neither a published development key nor non-random. Every ring key is
   distinct from `JWT_SECRET`, every Auth pepper and every TOTP encryption key. Errors name the variable and the rule, never a value,
   decoded bytes or a fingerprint.
4. **Shared parser (D2).** A4.7 adds an **optional** key-ring parser to `libs/service-kit` alongside `readKeyRing`, reusing its id rule
   and key checks. `readKeyRing`, `readKey`, `decodeKey`, `assertDistinctKeys` and the rules every other service relies on keep their
   behaviour and messages; any new rule (such as the entry cap) is opt-in.
5. **Signing.** HS256 only. When the active key is `legacy`, the protected header is exactly `{"alg":"HS256"}` (no `kid`, as today).
   When it is a ring id, the header is `{"alg":"HS256","kid":"<id>"}`. Claims, issuer, audience, `iat`, `exp` and the session-ceiling
   clamp are unchanged; no `typ` or other header is added.
6. **Verification.** Algorithms are pinned to HS256 and a header `alg` other than HS256 is refused. The key is selected from the protected
   header, then the token is verified with **that one key only**: no `kid` → the legacy key if configured, else refused; a `kid` that is
   not a string, breaks the id rule, is `legacy`, or names no configured key → refused. There is **never** a fallback to another key.
   Keys embedded or referenced by the header are never used. Issuer, audience, expiry (no added clock tolerance) and the claim checks
   stay. Every failure is the existing `401 invalid_token`.
7. **Rotation.** Each step is a separate, owner-authorized configuration change followed by a restart: (0) deploy the ring-capable image
   with an unchanged `.env`; (1) add the new key, active still `legacy`; (2) activate the new key; (3) wait; (4) retire the old key by
   removing it. Later rotations repeat (1)–(4) between ring keys; the previous ring key is removed no earlier than the delay of rule 9,
   measured from the restart that activated its successor.
8. **Rollback boundary.** An image without the ring verifies only kid-less tokens with `JWT_SECRET`. Rolling back to it is safe while the
   active key is `legacy` (steps 0–1). Once a ring key is active, rolling back the **image** rejects every token signed with it until
   clients refresh; rolling back the **configuration** (active back to `legacy`, the ring key kept) stays safe. After the legacy key is
   retired, an image rollback also needs `JWT_SECRET` restored.
9. **Legacy retirement delay (D5).** `JWT_SECRET` is removed no earlier than **3600 s + 5 min after the last token signed with it**,
   that is, after the restart that last made a ring key active (a return to `legacy` restarts the count). The fixed 3600 s is the
   largest accepted `ACCESS_TOKEN_TTL_SEC`, so the rule holds whatever the configured lifetime. Retirement additionally needs the
   operational conditions of the A4 record §10 (including D6) and the owner's explicit authorization.
10. **Provisioning (D6).** Auth's provisioning script generates `JWT_SECRET` whenever it is absent; it must stop doing so when the ring
    is configured. A4.8 makes that change; no production retirement of `JWT_SECRET` happens before it is merged and in use.
11. **Metrics (D7).** No per-key verification metric in A4.7. Retirement relies on the delay of rule 9, not on observed traffic.
12. **Production.** This ADR authorizes no production key generation, delivery, activation or retirement, and no deployment.

## Consequences

- **Compatibility.** An unchanged production `.env` gives byte-identical tokens and identical verification; deploying a ring-capable
  image is behaviour-neutral until a ring is configured. An image without the ring ignores the two new variables.
- **Sessions and refresh tokens.** Refresh tokens, family rotation, reuse detection, the session ceiling and logout are untouched. An
  access token rejected because its key was retired or because of an image rollback is recovered by a normal refresh, which signs with
  the current active key. The live user and session check in `AuthGuard` is unchanged.
- **Security.** Keys can be rotated with an overlap window; a compromised key is removed without waiting. Stripping or changing a `kid`
  invalidates the HMAC unless the attacker holds the key it would select, so the only downgrade target is the legacy key, and rule 9
  bounds how long it stays configured.
- **Harder.** A wrong rotation order (retiring a key too early, rolling back an image after activation) rejects live access tokens; the
  procedure and its limits must be followed per step, by the owner.
- **A4.7** implements rules 1–6 and 11 test-first (A4 record §10.9), adds the optional kit parser (rule 4), and generates or activates
  no key. **A4.8** changes the provisioning script (rule 10) and documents the rotation procedure in the rotation runbook. Any
  production step is a later, owner-authorized checkpoint.
- No other service, contract, event or migration changes.

## Relationship to other ADRs

- [ADR-0002](./0002-jwt-access-token-with-rotating-refresh-token.md) (Accepted): kept; its short-lived access JWT is HS256 in the
  implementation, and this ADR only adds key selection to it. Its statement that services verify the token locally was replaced, for
  Core services, by ADR-0033.
- [ADR-0033](./0033-service-to-service-authentication-and-user-identity.md) (Accepted): kept; Auth remains the only holder and verifier,
  which is why a symmetric ring suffices and option 2 is rejected.
- [ADR-0056](./0056-core-architecture-and-api-conventions.md) (Accepted): shared libraries hold generic infrastructure such as
  configuration (§1), and Auth's configuration loader converges on the kit's (§12, `[TARGET: A4]`); rules 1, 3 and 4 follow that.
- [ADR-0025](./0025-owner-mfa-login-with-secret-key-step-up-and-recovery.md) (Accepted): owner MFA, step-up and recovery are unaffected;
  the TOTP key ring is a separate purpose whose keys must stay distinct from every JWT key.

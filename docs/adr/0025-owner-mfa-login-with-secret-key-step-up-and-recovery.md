# 0025. Owner login with password + second factor; secret key as step-up and recovery credential

- **Status:** Accepted (2026-09-26, by the owner, Stage 19.1 decision D1 after R1; see the note at the end)
- **Date:** 2026-09-18
- **Deciders:** Anwar (project owner)

> **Extended by [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md) Amendment 1 (2026-09-20):** the step-up mechanism is extended to operators for sensitive Organization Service operations. Every owner purpose in this ADR is unchanged and remains valid for owner operations. The allow-list gains **one new owner purpose**, for creating an Organization (ADR-0042 Amendment 1, A.2); nothing here is superseded.

> **Amended by [ADR-0027](./0027-service-layer-security-model.md)** on two points: (1) **recovery is no longer immediate** — `start` (password + key) opens a cool-down request that changes nothing; `complete` (recovery token + key, after the cool-down) revokes factors/sessions, spends the key and returns only an enrollment token; (2) **password-only enrollment is limited to an owner who has never had a factor** — afterwards a password yields `recovery_required`. The rest of this ADR stands.

> **Amended by [ADR-0050](./0050-platform-administration-and-verified-human-authority.md)** (2026-09-26, Stage 19.1 R1; on the following point only): the ADR-0017 reset CLI that this ADR calls "unchanged" and names for "key leaked, factors intact" **was never implemented and is not part of Core V1**. A leaked key is handled in-band by `owner.secret_key.rotate` with a TOTP or passkey step-up; lost factors by the cool-down recovery (ADR-0027). Direct database manipulation is not an approved recovery procedure, so the Costs sentence "the ops CLI/DB access remains the last resort" no longer describes an approved path: an owner who has lost the password (recovery needs password + key) has no approved recovery in Core V1, a recorded limitation (Stage 19.1 record, P-S4).

> **Supersedes the login mechanism of [ADR-0010](./0010-owner-secret-key-login-with-device-alerting.md)**
> (`POST /auth/admin/login/secret-key`). ADR-0010's new-device alerting, SHA-256 hashing rationale
> and rotation endpoint are retained, re-purposed as described below. **Amends**
> [ADR-0016](./0016-first-owner-bootstrap-command.md) (first-login path of a bootstrapped owner) and
> [ADR-0017](./0017-single-owner-with-secret-key-force-reset.md) (the reset CLI keeps its purpose,
> its credential's role changes).

## Context

ADR-0010 made the owner's permanent secret key **the** way an owner logs in: `POST
/auth/admin/login/secret-key {secretKey}`, no identity, no password, no second factor. The key was
chosen so the highest-privilege account would not depend on a human-chosen, periodically rotated
password. That has three problems now that the owner is company-wide (ADR-0022):

1. **One bearer secret is the whole account.** Anyone who obtains the key (shoulder-surf, chat
   paste, backup, log) is the owner of every platform in the company. New-device alerting only
   *tells* the owner afterwards (ADR-0010 explicitly never blocks).
2. **A long-lived static secret as the daily credential is the wrong shape.** It is typed on every
   login, so it is exposed constantly; nothing rate-limits *identity*, because there is none in the
   request.
3. **It cannot express "prove you are still you" for a dangerous action.** Every sensitive
   operation (grant/revoke platform access, rotate the key) is authorized by a session that was
   opened with the same single secret.

The business requirement is: normal, secure authentication for the owner; the secret key kept, but
as a **high-assurance step-up / recovery** credential, not a daily one.

## Options considered

1. **Keep secret-key login, add rate limits.** Rejected: still a single static factor as the daily
   credential.
2. **Password only for the owner.** Rejected: the owner controls every platform; a single
   phishable factor is not acceptable for the highest-privilege identity.
3. **Password + second factor (TOTP and/or passkey/WebAuthn) for login; secret key for step-up and
   recovery (chosen).** Standard shape: something you know + something you have for entry; a
   separate high-entropy credential kept offline for re-verification and account recovery.
4. **Passkey-only.** Attractive, but excludes environments without a platform authenticator and
   leaves no recovery story; TOTP fallback is cheap. Passkey stays a first-class option under 3.

## Decision

### Owner login: email/phone + password + second factor

1. `POST /auth/login {email? | phone?, password}` — the same endpoint as members (ADR-0025 does not
   add a parallel owner login). If the account's `kind` is `owner`, a correct password does **not**
   yield tokens; it yields `200 {status: "mfa_required", challengeToken, methods: [...]}`. The
   `challengeToken` is short-lived, single-purpose, carries no API authority, and is bound to the
   owner id. An owner with **no confirmed factor** gets `{status: "enrollment_required",
   enrollmentToken}`, which is valid only for factor-enrollment endpoints (this is how a
   freshly bootstrapped owner, ADR-0016, gets in for the first time).
2. `POST /auth/admin/login/owner/verify {challengeToken, method, code | assertion}` verifies a TOTP
   code against the owner's confirmed `OwnerAuthFactor`, or a WebAuthn assertion (signature over the
   challenge; `signCount` must strictly increase when the authenticator reports one). On success it
   issues the normal access + refresh tokens and runs the existing new-device check
   (`AdminDevice`, now on **every** owner login, publishing
   `admin.owner_login_from_new_device`; still alert-only — a User-Agent fingerprint is a weak
   signal, never an authentication factor).
3. The owner's access thereafter is what ADR-0022 already defines: `User.kind = 'owner'` and
   `Owner.companyId = Platform.companyId`. **No platform-specific key is ever entered.**

New storage (`OwnerAuthFactor`, migration `0002`): `type` (`totp | webauthn`); for TOTP an
**encrypted** shared secret (`secretCiphertext`, application-level AEAD with a key held outside the
database — a TOTP secret must be recoverable to verify a code, so it cannot be hashed, and it is
never stored in plaintext); for WebAuthn `credentialId` (globally unique), `publicKey`, `signCount`
(public material only). A factor is unusable until `confirmedAt` is set, and can be revoked.
Only an `Owner` can hold factors (FK to `Owner`).

### The secret key: step-up and recovery, never daily login

`Owner.secretKeyHash` / `secretKeyIssuedAt` are kept (SHA-256 of a high-entropy server-generated key,
returned once, never stored or logged in plaintext — the database now also refuses any value that is
not a 64-hex digest). Its roles:

- **Step-up (high assurance).** For an operation on the sensitive list, the owner re-verifies inside
  their session: `POST /auth/admin/step-up {purpose, method, credential}` with `method` one of
  `secret_key | totp | webauthn` (which methods are acceptable is per purpose, table below). On
  success the service inserts an `OwnerStepUp` row and returns a **step-up token** (`typ: step_up`,
  `stepUpId`, `purpose`, `exp`). The sensitive endpoint requires it in `X-Step-Up-Token` alongside
  the Bearer token, and, **in the same database transaction as the operation**, checks the row
  (right owner, right `purpose`, unexpired, not consumed, same session) and marks it consumed. So a
  step-up is single-use, operation-bound, session-bound and **at most 15 minutes** long (the database
  rejects anything longer). One access-token claim is added to make session binding possible:
  `sid` (the refresh-token family id) on owner tokens.
- **Recovery.** `POST /auth/admin/recovery {email|phone, password, secretKey}` for an owner who has
  lost every factor: on success it revokes all of the owner's factors and sessions, invalidates the
  used key (`secretKeyHash` cleared until a new one is issued), and returns an `enrollmentToken`.
  Rate-limited, always alerts, and (like every owner login) recorded against `AdminDevice`.
  ADR-0017's CLI reset covers the opposite case (key leaked, factors intact) and is unchanged.

Sensitive operations and the step-up they require (configurable via one server-side allowlist,
`STEP_UP_REQUIRED_PURPOSES`; purposes not on it behave as before):

| Purpose | Endpoint | Acceptable methods |
|---|---|---|
| `platform_assignment.grant` | `POST /auth/admin/operators/:id/platform-assignments` | totp, webauthn, secret_key |
| `platform_assignment.revoke` | `DELETE …/platform-assignments/:platformId` | totp, webauthn, secret_key |
| `owner.secret_key.rotate` | `POST /auth/admin/secret-key/rotate` | **totp, webauthn only** — a leaked key must not be able to rotate itself |
| `owner.factor.enroll` / `owner.factor.remove` | factor management | totp, webauthn (the *other* factor); the last factor cannot be removed |
| `platform.create` | `POST /auth/admin/platforms` | totp, webauthn, secret_key |
| `operator.create` | `POST /auth/admin/operators` | totp, webauthn, secret_key |

Deliberately **not** step-up: normal platform/organization access, reads, operator **block/unblock**
(an emergency control must stay fast), operator schedule/time-off edits.

`assignedBy` and `revokedBy` remain derived from the authenticated owner, never from a request body;
the step-up proves *re-verification*, it does not replace that derivation.

### What this amends

- **ADR-0010:** `POST /auth/admin/login/secret-key` is removed. `AdminDevice` alerting applies to all
  owner logins and to recovery. Rotation now requires step-up. Hashing rationale unchanged.
- **ADR-0016:** a bootstrapped owner (password only, no secret key, no factor) signs in via
  `enrollment_required`, enrolls a factor, and only then can issue the first secret key (rotation
  needs a factor step-up). Bootstrap still never mints a key.
- **ADR-0017:** unchanged behavior. The reset CLI still overwrites the secret key out-of-band and revokes sessions; enrolled factors are left in place.

## Consequences

**Good**

- No single static secret opens the owner account; phishing the password alone yields nothing.
- Dangerous operations need fresh proof, bounded in time, scope and session, with an audit trail
  (`OwnerStepUp` is immutable and undeletable).
- The secret key keeps a real, narrow job (step-up and recovery) instead of two overlapping ones.
- Members, operators and every downstream service are unaffected.

**Costs / risks**

- New moving parts: TOTP/WebAuthn libraries, an encryption key for TOTP secrets (must be provisioned
  and rotatable — **not solved here**), enrollment UX, a `sid` claim on owner tokens.
- Recovery is a powerful path (password + key ⇒ new factors); it is rate-limited and alerting, but it
  is the weakest link and deserves its own review before implementation.
- If the only owner loses password *and* factors *and* key there is still no in-band recovery
  (unchanged from ADR-0017; the ops CLI/DB access remains the last resort).
- The DB proves the *shape* of factors and step-ups (short-lived, single-use, same-owner, undeletable);
  that a TOTP code or a WebAuthn assertion is actually valid is service logic **not yet implemented**.

## Open questions

- Whether recovery should also require an out-of-band confirmation (email link) and a cool-down.
- Where the TOTP encryption key lives (KMS vs environment secret) and its rotation procedure.
- Whether step-up should be per-operation-instance (bind the token to the target ids) rather than
  per-purpose; per-purpose is used here because the DB row is generic and the consumption is
  transactional with the operation.

## Note (2026-09-26, Stage 19.1 — acceptance)

Accepted by the owner under Stage 19.1 decision D1, after a conformance check of the running code ([Stage 19.1 record](../architecture/stage-19/stage-19-1-decisions-and-roadmap.md) §14.1)
and the R1 amendment above. No decision changes. Verified: `POST /auth/login` answers an owner with `mfa_required`,
`enrollment_required` or `recovery_required`; TOTP (sealed secret) and passkey factors; `owner_step_up` is single-use, session- and
purpose-bound and at most 15 minutes (database CHECK); `x-step-up-token`; factor-only purposes refuse the secret key; new-device alerting
on owner login; operator block/unblock without step-up. Historical, not current: the allow-list is named `STEP_UP_METHODS` in code (not
`STEP_UP_REQUIRED_PURPOSES`) and has gained purposes from ADR-0028, ADR-0029 and ADR-0042; the `platform.create` route is hosted by
organization-service (`POST /organization/admin/platforms`, ADR-0042), which verifies the step-up through `POST /auth/step-up/verify`,
not by Auth; recovery follows ADR-0027; and the Consequences sentence "not yet implemented" about TOTP / WebAuthn validity is obsolete
(both are verified by the service).

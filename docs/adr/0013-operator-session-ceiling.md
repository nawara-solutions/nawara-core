# 0013. Hard 8-hour session ceiling for operator refresh-token rotation

- **Status:** Proposed
- **Date:** 2026-09-17
- **Deciders:** Anwar (project owner)

## Context

ADR-0011's "8 hours" describes exactly one thing: how long an issued **login code**
(`AdminOperatorCode.expiresAt`, anchored at code issuance) remains redeemable via
`verify-code`. It says nothing about how long the **session** that results from successfully
redeeming that code should last. Per ADR-0002, a successful login (of any kind) issues a
refresh token that can be rotated indefinitely, subject only to reuse-detection — there is
today no upper bound at all on how long an operator's granted access can be extended by
repeatedly refreshing.

The business requirement is that an operator's entire granted access must end exactly 8 hours
after they log in (i.e., after a successful `verify-code`), with no way to extend that window
by refreshing, and the client should be able to show a "5 minutes left" warning using only
information it already has — no new backend push mechanism is in scope (confirmed with the
project owner).

It's important to state plainly, and separately from the decision below: this ADR's 8-hour
session ceiling and ADR-0011's 8-hour code-redemption window are **two different windows that
happen to share a duration**, anchored at two different moments — the code's *issuance*
versus the session's *login (verify-code success)*. Conflating these would be a mistake; that
distinction, and the fact that it needs its own reasoning rather than a one-line edit to
ADR-0011, is exactly why this is its own ADR.

## Options considered

1. **Enforce the ceiling only client-side** — trust the frontend to log the operator out at
   the 8-hour mark, with no backend enforcement at all. Rejected: trivially bypassable by
   anyone crafting requests directly against the API (e.g. via `curl` or a modified client),
   which defeats the purpose of a hard security boundary.
2. **A shorter-lived refresh token family with no explicit ceiling field, relying on the
   family's own `RefreshToken.expiresAt`.** Rejected: `RefreshToken.expiresAt` (per ADR-0002)
   already means something else — that one specific token's own short validity window before
   it must be rotated, not the whole session's lifetime. Reusing it for both meanings would
   conflate two different lifetimes that need to vary independently (a token's own short TTL
   vs. the session's overall ceiling).
3. **An explicit `sessionExpiresAt` ceiling, set once at login and copied forward unchanged
   across every rotation in that token family, checked before reuse-detection (chosen).**
   Models the ceiling as its own concept, additive to ADR-0002's existing rotation model, with
   zero behavior change for every other login path.

## Decision

We chose **Option 3**. Concretely:

- `RefreshToken` gains `sessionExpiresAt: timestamp | null`. **Null** for every refresh token
  issued by every path other than operator verify-code (registration, password login,
  secret-key login) — this is a purely additive column with zero behavior change to ADR-0002's
  existing unbounded rotation for regular users and owners. It is set exactly once, at
  `OperatorCodeService.verifyCode()` success, to `now + 8h`.

  > **Note (added, not part of the original decision):** the flat 8h duration described here
  > is amended by [ADR-0014](./0014-schedule-anchored-operator-duration.md) — it now applies
  > only as a fallback for an operator with no configured `OperatorSchedule`; a scheduled
  > operator's session ceiling is anchored to their own shift end instead.

  On every subsequent rotation
  within that token family, the value is copied forward **unchanged** — never recomputed from
  "now." This is what makes it a fixed ceiling anchored to the original login moment, rather
  than a sliding window an operator could extend indefinitely by refreshing repeatedly.
- `RefreshTokenService.issue()` gains an optional `sessionExpiresAt` parameter. Every caller
  except the operator verify-code path omits it (defaulting to `null`).
- `RefreshTokenService.rotate()` gains one new check, and its **ordering relative to the
  existing reuse-detection check matters**: the ceiling check must run **before** the existing
  revoked/reuse check. If `sessionExpiresAt` is set and `now >= sessionExpiresAt`: revoke the
  token family (a clean, expected session-end revocation, not a theft signal) and return
  `401 {reason: "session_ceiling_reached", message: "Your 8-hour session has ended. Please
  request a new login code to continue."}`.

  This ordering is a correctness requirement, not a stylistic preference: if the ceiling check
  ran *after* the reuse-detection check instead, a token that legitimately hit its ceiling
  would get marked revoked by the ceiling check first, and then any retry of that same request
  (e.g. a client that doesn't immediately give up) would find an already-revoked token and get
  misclassified by the *existing* reuse-detection logic as a **reused/stolen** token — a false
  positive that treats a normal, expected session end as a security incident.
- This `session_ceiling_reached` response is a distinct, informative reason code — unlike the
  blocked-operator case in ADR-0012, which deliberately stays generic. This is fine here, and
  not a new enumeration risk, for a different reason than ADR-0012's: the caller already
  possesses a previously-valid, real refresh token for a real account. Telling them precisely
  why it stopped working leaks nothing new about anyone else's account, and materially helps
  the client decide to start a fresh login rather than treat the failure as a transient error
  worth blindly retrying.
- `TokenService.signAccessToken()` gains an optional explicit-expiry parameter. For every
  non-operator caller, behavior is unchanged: `exp = now + <normal TTL>`. For operator-issued/
  rotated tokens specifically, every issuance computes
  `exp = min(now + <normal TTL>, sessionExpiresAt)`. For most of the 8-hour session this just
  equals the normal short TTL, since the ceiling is far away — but on the final rotation
  before the ceiling, `exp` gets clamped down to the ceiling itself, meaning that final token's
  own standard JWT `exp` claim *is* the true session ceiling. This matters concretely: a client
  reading the token's own expiry needs no new backend field to implement the "5 minutes left"
  warning and auto-logout — this satisfies the confirmed requirement that the warning be a
  purely client-side concern, with no new push mechanism.
- Re-entry after the ceiling is reached is only possible via a fresh `request-code`/
  `verify-code` cycle — itself still gated by `OperatorAvailabilityService.isOperatorAvailable`
  (per ADR-0012), so an operator can't re-enter outside their own working window just because
  their old session happened to expire mid-shift-boundary.

## Consequences

- Changes `RefreshTokenService.rotate()` and `TokenService.signAccessToken()` — both shared,
  general-purpose methods used by every login path in `auth-service` — but in a way that is
  fully backward compatible and inert for every non-operator caller, via the
  `null`/omitted-parameter default.
- Builds on ADR-0002, whose rotation/reuse-detection model this ADR extends for one specific
  token class (operator-issued tokens), and on ADR-0011/ADR-0012, whose operator-login flow
  (`OperatorCodeService.verifyCode()`) is the only caller that ever sets the ceiling.
- Gives the client everything it needs to implement an accurate "session ending soon" warning
  and auto-logout purely from the final token's own `exp` claim, with no new backend push
  mechanism.
- Introduces a second, distinct meaning for "8 hours" in the operator-login design
  (code-redemption window vs. session ceiling) that future readers must not conflate — this
  ADR exists specifically to keep that distinction explicit and separately documented from
  ADR-0011.
- Accepted observability tradeoff: once a family's ceiling has passed, a stale token replayed
  by an attacker (a genuine theft-replay, not a normal client retry) is classified the same
  way as a legitimate expected session end (`session_ceiling_reached`), since the ceiling check
  runs before reuse-detection regardless of which kind of token is presented. This doesn't
  create an authorization bypass — access is denied either way — but it does mean a real
  post-ceiling theft-replay no longer gets the structured "reused/stolen" security-event log
  entry ADR-0002 otherwise records. Not solved here.
- Open question, not resolved here: whether the 8-hour session-ceiling duration should become
  configurable per platform in the future, rather than a hardcoded constant shared by every
  platform.

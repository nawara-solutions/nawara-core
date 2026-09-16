# 0004. Synchronous, fail-closed license validation against payment-service for B2B registration

- **Status:** Proposed
- **Date:** 2026-09-16
- **Deciders:** Anwar (project owner)

## Context

This system supports two registration modes. Individual/direct registration is
unaffected by this decision. The second mode is B2B: the platform's own `Admin` user (a
generic `role: "admin"` account, not scoped to any organization) generates a
time-limited license for an organization after that organization pays; end users
belonging to that organization must, before they can register, provide the
organization's id/key, and registration must be blocked unless that organization
currently holds a valid (non-expired) license.

Per this repo's root `CLAUDE.md` description of `payment-service`'s generic
`Product`/`Charge` model, license/billing data is explicitly `payment-service`'s domain,
not `auth-service`'s — `CLAUDE.md` already calls out "licenses" as an example `Product`
type `payment-service` is meant to support. So `auth-service` needs a way to answer
"does organization X currently have a valid license?" at the exact moment a user is
trying to validate an organization id or complete a B2B registration, without owning
that data itself.

## Options considered

1. **A synchronous REST call from `auth-service` to `payment-service`** made at both
   validation time and registration time, which fails closed — any error, timeout, or
   explicit invalid/expired response results in the registration or validation attempt
   being rejected.
2. **The same synchronous call, but failing open on error** (i.e., allowing
   registration to proceed if `payment-service` can't be reached) — rejected as too
   risky, since it would let users register under an organization whose license status
   is actually unknown, potentially one that never paid or whose license already lapsed.
3. **Asynchronous replication**: `payment-service` publishes
   `license.issued`/`license.expired`-style domain events, and `auth-service` maintains
   its own locally cached read-model of license validity to avoid a live call on the
   request path — this removes the live dependency but introduces eventual-consistency
   risk (a license that just expired might not be reflected in the cache yet,
   temporarily allowing registrations it shouldn't) and is meaningfully more
   infrastructure (event consumption, a local cache/table, staleness handling) than this
   system needs at its current scale.
4. **Skip a separate validation step entirely and perform the license check only inline
   inside the registration endpoint itself** — this is a strictly worse user experience,
   since a user could fill out an entire registration form before discovering their
   organization id was invalid.

## Decision

We chose **Option 1**. Concretely, this is a two-step flow:
`POST /auth/organizations/validate` accepts an `organizationId` and calls
`payment-service`'s (assumed, not yet finalized) `GET /payment/licenses/:organizationId/status`
endpoint; on a successful response the client is allowed to proceed to the normal
registration form. `POST /auth/register`, when called with an `organizationId`,
independently re-validates the license status server-side before creating the user — it
never trusts that an earlier `/organizations/validate` call succeeded, closing the
time-of-check-to-time-of-use gap between the two calls. Any failure or timeout reaching
`payment-service` during either call results in a `503` and the registration/validation
attempt is rejected.

## Consequences

- This is `auth-service`'s first live synchronous dependency on another `nawara-core`
  service. That is judged acceptable because it's an API call — consistent with this
  repo's "API is the only contract" principle — rather than any kind of direct database
  coupling.
- It does introduce a genuine new availability coupling: if `payment-service` is down,
  no new B2B registrations can complete. Existing users' login, token refresh, and
  logout are entirely unaffected, since none of those flows touch `payment-service`.
- The call needs an explicit request timeout (recommend on the order of a few seconds)
  so a slow `payment-service` doesn't hang registration indefinitely.
- The exact shape of `payment-service`'s license-status endpoint is currently only
  assumed by `auth-service`, not finalized — this must be reconciled once
  `payment-service` has its own design documents for its License/Organization model.

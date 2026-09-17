# 0008. Automatic 24-hour grace license on organization license lapse

- **Status:** Accepted
- **Date:** 2026-09-16
- **Deciders:** Anwar (project owner)

## Context

`docs/add/payment-service.md` carries this open question: "Whether `License` should support a
grace period between expiry and actually triggering suspension/logout (e.g. a few days of
leeway)." `docs/sdd/payment-service.md` carries the same open question in slightly broader form:
"Whether `License`/`UserSubscription` should support a grace period before a lapse actually
triggers suspension." Today, `LicenseLapseService.
handleExpiry` treats every lapse identically and immediately: it sets `License.status =
'expired'`, publishes `license.expired`, and suspends every `UserSubscription` under that
organization (freezing their remaining time per `ADR-0006`). An organization whose payment is
merely late by a short window — a delayed bank transfer, a cash payment awaiting Admin
confirmation per `ADR-0007`, a renewal submitted but not yet processed — is locked out exactly as
hard and exactly as fast as one that never intends to pay again, with every user under it logged
out (per `ADR-0005`) the moment their access token needs revalidation. There is currently no way
to distinguish "just renewed" from "still on their very first, never-yet-lapsed license" once a
lapse happens, and no mechanism to give an organization a bridge window before the existing
suspend/lock-out mechanics engage.

## Options considered

1. **A multi-day grace period before suspension is actually triggered** — the literal wording of
   the pre-existing open question: delay the existing expire/suspend flow by some number of days
   after the license's real `expiresAt` passes. Considered, but a longer, delay-based window
   makes "when does enforcement actually happen" fuzzier and doesn't map cleanly onto a single,
   predictable license row — it would need either a second timestamp on `License` or a
   separately-tracked delay window, without changing what actually happens once that window
   closes.
2. **Require Admin action to grant grace on a case-by-case basis** — rejected: it defeats the
   purpose of an uninterrupted-work bridge if continuity depends on the Admin being available and
   choosing to click something at the exact moment a license lapses. The whole point is to buy
   time automatically, not to add a second manual step.
3. **Unlimited or repeating grace, re-granted on every detection sweep** — rejected: this would
   mean an organization could simply never actually be locked out (each sweep would just extend
   grace again), which undermines the entire point of license enforcement existing at all.
4. **A single, automatic, exactly-24-hour grace license, granted at most once per renewal cycle
   (chosen).** On first lapse since the last real payment, automatically issue a fixed 24-hour
   grace window with no Admin involvement; if that window also elapses, fall through to the
   existing expire/suspend behavior unchanged. Chosen because it requires no change to the
   existing suspend/resume mechanics, gives a hard and predictable cutoff, and is enforceable
   without any new table or counter (see Decision).

## Decision

We chose **Option 4**. `License` gets a new `type: "standard" | "grace"` field, defaulting to
`"standard"`. Because `License.organizationId` is already unique (one row per organization), no
new table or counter is needed to enforce "grace granted at most once per renewal cycle" —
`LicenseLapseService` only has to inspect the current row's `type` before deciding whether to
auto-grant grace.

`LicenseLapseService.handleExpiry` branches on the lapsing `License`'s `type`:

- **`type = 'standard'`** (first lapse since the last real payment): do **not** set
  `status = 'expired'` and do **not** suspend any `UserSubscription`. Instead, set
  `type = 'grace'`, `expiresAt = now + 24h`, and leave `status = 'active'`. Publish a new event
  `license.grace_issued = { organizationId, ownerId, expiresAt, timestamp }` — this one
  deliberately carries `expiresAt`, unlike `license.expired`/`license.reactivated`, so the
  organization's admin knows exactly when the window closes. Externally, via the existing
  `GET /payment/licenses/:organizationId/status` endpoint `auth-service` already calls, the
  license still reads as fully valid during grace — `auth-service` needs zero changes for this
  feature.
- **`type = 'grace'`** and the 24-hour window has also now elapsed: proceed with the **existing**
  flow, unchanged — `status = 'expired'`, publish `license.expired`, suspend every
  `UserSubscription` under the org (per `ADR-0006`). `type` stays `'grace'`. This is exactly what
  prevents an infinite grace loop: the row is no longer `status = 'active'`, so the existing
  idempotent sweep-selection (`WHERE status = 'active'`, per `docs/sdd/payment-service.md`'s
  Important flows section, flow (g)) naturally skips it on any repeat run — no extra guard code
  required.

**Reset rule:** whichever future mechanism issues a real license — a gateway purchase or an
Admin-confirmed cash payment per `ADR-0007` — must unconditionally write `type = 'standard'`
alongside the new `status = 'active'` / `expiresAt` / `chargeId`. This is the only place `type`
ever reverts to `'standard'`, which is what makes "one grace period per renewal cycle" true: a
real payment arriving mid-grace simply upgrades the same row early, with no special-casing
needed.

This decision is scoped to organizations/`License` rows only. `UserSubscription` is unaffected —
an individual subscription lapsing on its own still follows its existing status model
(`active → expired`) unchanged; nothing about this ADR touches that.

## Consequences

- Organizations get an automatic, unattended 24-hour bridge on their first lapse per renewal
  cycle, with no Admin step and no change to `auth-service`'s license-status contract
  (`ADR-0004`).
- The existing expire/suspend/notify mechanics (`ADR-0006`) are entirely unchanged — grace is
  purely a precondition inserted before that flow runs, not a rewrite of it.
- Enforcing "at most one grace per cycle" adds no new table, counter, or migration beyond the
  single `License.type` column, because `License` already has a unique `organizationId`.
- The 24-hour window is anchored to *detection time* (when `LicenseLapseService` notices the
  lapse), not to the license's original `expiresAt`. If the still-undecided lapse-detection sweep
  cadence (an existing separate open question in `docs/add/payment-service.md`/
  `docs/sdd/payment-service.md`) turns out to be coarser than roughly an hour, "exactly 24 hours"
  cannot be honored precisely — grace could run meaningfully longer than 24h depending on when
  within a sweep interval the lapse actually occurred. A sub-hourly sweep cadence is recommended
  once that open question is resolved, if this precision matters in practice.
- The successful-`Charge`-issuance mechanism (out of scope here and in `ADR-0007`, and in both
  `docs/add/payment-service.md` and `docs/sdd/payment-service.md`) now has one more required
  field to set (`type = 'standard'`) whenever it is eventually designed and built — flagged as a
  requirement on that future work, not solved by this ADR.

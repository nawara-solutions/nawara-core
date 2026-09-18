# 0021. Synchronous, fail-closed platform-scope check for payment-service's organization-scoped admin actions

- **Status:** Proposed
- **Date:** 2026-09-18
- **Deciders:** Anwar (project owner)

## Context

Every platform-scoped Admin (`role: 'admin'`) has owner and operator tiers sharing equal rights
over the organizations belonging to platforms they have access to (per `ADR-0020`). Per
`ADR-0007`, `payment-service` gates three of its own endpoints —
`POST /payment/charges/:chargeId/cash/confirm`, `POST /payment/charges/:chargeId/cash/reject`,
and `GET /payment/charges?method=cash&status=pending` — behind its own local `RolesGuard`, which
checks only that the caller's JWT carries `role: 'admin'`. Nothing in that guard, or anywhere
else in `payment-service`, checks *which* platform the acting admin has authority over against
*which* platform the target `Charge`'s `organizationId` belongs to.

Until now this was structurally impossible to check. Per `ADR-0001`, `organizationId` has always
been a fully opaque string everywhere it appears, including on `payment-service`'s own
`Charge`/`License`/`UserSubscription` rows (per `ADR-0004`/`ADR-0006`/`ADR-0007`) — nothing
anywhere recorded which platform a given `organizationId` belonged to, so there was no data to
check against even in principle. `ADR-0020` changes that: it introduces a first-class
`Organization` entity in `auth-service`, with a non-null `platformId` field (per `ADR-0022`, a
real foreign key to a first-class `Platform` entity, not an opaque string), and states
explicitly that `organizationId` everywhere it already appears — including on
`payment-service`'s rows — now refers to this entity's `id`. `ADR-0020`'s own Consequences name
the resulting gap directly and defer it to this ADR by number.

Concretely, the gap: an admin can, today, call `POST /payment/charges/:chargeId/cash/confirm`
(or `.../reject`, or the pending-cash listing) against a `Charge` whose `organizationId` belongs
to an organization under a platform that admin has no authority over, and `payment-service` has
no way to notice — its `RolesGuard` only checks the generic `role: 'admin'` claim, which is
identical for every admin regardless of which platform(s) they administer.

**This ADR was originally written, and the general shape of its mechanism settled with the
project owner, against a model where every admin's JWT carried a single `platformId` claim**
(owner or operator alike, per `ADR-0009`) that could be compared directly against a resolved
`Organization.platformId`. **`ADR-0022` and `ADR-0023`, written after this ADR but settled and
rewritten in first, remove that claim entirely** — an owner's access is company-wide by
construction (`adminTier: 'owner'` alone implies it, per `ADR-0022`); an operator's access to a
specific platform is now a live, revocable `PlatformAssignment` row that must be checked at
request time, since it can be revoked mid-session and a stale JWT claim could never reflect
that (per `ADR-0022`). `ADR-0023` is what supplies the concrete, reusable mechanism for that
live check: a new `auth-service` endpoint, `GET /auth/platform-access/:platformId`, designed
specifically so any downstream service — `payment-service` chief among the concrete examples
`ADR-0023` itself gives — can confirm a calling admin's platform access without ever comparing
against a JWT claim. This revision updates this ADR's mechanism to use that endpoint instead of
a claim comparison, without changing anything about *which* `payment-service` endpoints this
check applies to, or the fail-closed response contract `payment-service` itself presents to its
own callers (see Decision).

The general shape of the mechanism — a synchronous, fail-closed cross-service check,
structurally mirroring `ADR-0004`'s already-accepted pattern but in the reverse call direction
(`payment-service` calling `auth-service`, instead of `auth-service` calling `payment-service`)
— remains settled with the project owner for the same reason `ADR-0020` itself pre-settled
several of its own modeling questions before writing its own Options considered: reusing an
existing, already-accepted verification style for a structurally identical problem is preferable
to inventing a new one. This also keeps this repo's database-per-service principle intact:
`payment-service` never queries `auth-service`'s database directly, only its API, exactly as
`auth-service` already does the reverse for `payment-service`'s license/subscription data.

What genuinely remained open, and is what Options considered evaluates, is *how* payment-service
resolves and enforces that check: whether via a live lookup at the moment of each admin action
(the literal mirror of `ADR-0004`), or by resolving and storing the platform relationship once,
up front, and never calling out to `auth-service` again for it.

## Options considered

1. **Do nothing — leave the gap as-is.** `payment-service` continues gating its three admin
   endpoints on the bare `role: 'admin'` claim only. Rejected: this is a real, exploitable
   cross-tenant authorization gap, now that `ADR-0020` has given `organizationId` a platform to
   actually check against — an admin with authority over one platform can approve, reject, or
   enumerate cash payments belonging to organizations under a platform they have no legitimate
   authority over. Leaving it unaddressed is not a neutral choice once the fix is this cheap;
   `ADR-0020`'s own Consequences already named this ADR as the planned follow-up specifically
   because leaving it open was judged unacceptable.
2. **Denormalize `platformId` onto `payment-service`'s own rows at write time**, instead of a
   live lookup. Concretely: `Charge` (and, transitively, the `License`/`UserSubscription` rows it
   creates) would gain a new `platformId` column, resolved once via a single `auth-service` call
   at the moment a `Charge` is created (cash request or, eventually, gateway purchase), and every
   later admin action would compare against that stored value with a plain, indexed local query —
   no live cross-service call on the admin-action path at all. This is not a strawman: it is
   exactly the same pattern `ADR-0006` already used for `UserSubscription.organizationId` itself
   ("denormalized from the JWT at purchase time specifically so `LicenseLapseService` can find
   every subscription under a lapsing organization using only `payment-service`'s own data"), and
   it would cleanly solve the one real weak spot in Option 3 below: filtering
   `GET /payment/charges?method=cash&status=pending` by platform would become a single indexed
   `WHERE platformId = ?` clause instead of a batch of live lookups. **Rejected for this
   decision, though not permanently foreclosed:** it requires a three-entity schema change
   (`Charge`, and by extension the still-undesigned issuance step that would need to propagate
   the same value onto `License`/`UserSubscription`) for what is fundamentally an authorization
   concern, not a business-data concern — a materially bigger change than the two read-only
   lookups Option 3 needs, for a service that is still an unimplemented scaffold with no
   existing rows to migrate. It also introduces a staleness risk Option 3 doesn't have: nothing
   in `ADR-0022` states that `Organization.platformId` is immutable after creation, so a
   denormalized copy could in principle drift from the source of truth if that value is ever
   changed — a live lookup, by contrast, is always correct as of the moment it's asked, and, for
   an operator's own access specifically, a stored value could never reflect a `PlatformAssignment`
   revoked after the `Charge` was created regardless of `Organization.platformId`'s own
   mutability. Given the project owner's decision to reuse `ADR-0004`'s established live-check
   pattern rather than introduce a new one, and given `payment-service` has no existing data to
   migrate today, this option is deferred rather than adopted — see Consequences for the specific
   cost this deferral accepts.
3. **A synchronous, fail-closed, two-call lookup against `auth-service` at the moment of each
   organization-scoped admin action (chosen).** Structurally the mirror of `ADR-0004`: before
   performing the action, `payment-service` resolves the target `organizationId`'s `platformId`
   via a live call to `auth-service` (`GET /auth/organizations/:id`, per this ADR's original
   Decision), then confirms the calling admin currently has access to that platform via a second
   live call (`GET /auth/platform-access/:platformId`, per `ADR-0023`), rejecting the action if
   either call fails to confirm access, or if either call itself fails. No new schema, no
   denormalized field, no migration — the tradeoff is a live dependency on every affected
   request instead of a one-time write-time cost, the same tradeoff `ADR-0004` already accepted
   for `auth-service`'s own login/refresh path.

## Decision

We chose **Option 3**. Concretely:

### Existing `auth-service` endpoint (unchanged by this revision): `GET /auth/organizations/:id`

A narrow, read-only endpoint distinct from `ADR-0020`'s four owner/operator-facing CRUD
endpoints (`POST`/`GET`/`GET :id`/`PATCH :id` under `/auth/admin/organizations`) — `ADR-0020`
never designed a service-to-service lookup, only CRUD scoped to an owner/operator acting within
their own platform access. The calling principal here is structurally different: it's
`payment-service` itself, relaying an admin's request, not an owner or operator browsing their
own platform's organization list.

- **Route:** `GET /auth/organizations/:id` — deliberately under `/auth/organizations/...`, not
  `/auth/admin/organizations/...`, mirroring the existing `POST /auth/organizations/validate`
  (`ADR-0004`) route family rather than being folded into `ADR-0020`'s admin-CRUD namespace, since
  its purpose and caller are both unrelated to that CRUD surface.
- **Auth:** Bearer, `role: admin` (the existing, generic `RolesGuard` — the same guard `ADR-0020`
  reuses for its own four endpoints, not `AdminTierGuard`; both owner and operator tokens are
  valid callers here, since both tiers already trigger the `payment-service` admin actions this
  endpoint supports).
- **Lookup:** by `id` alone, with no platform predicate on this call itself (per `ADR-0022`,
  there is no longer a single caller-claimed `platformId` to filter by at this step) — the
  identical, unscoped-by-caller lookup `ADR-0020`'s own `GET /auth/admin/organizations/:id`
  performs before it separately authorizes the result against the caller's own access. This
  endpoint reuses that same `OrganizationManagementService.findOneOrNotFound(id)` method, not a
  new persistence code path. **This endpoint itself performs no admin-access authorization at
  all** — it purely resolves `id → platformId`; confirming that the *specific calling admin* has
  authority over the resolved platform is `payment-service`'s own next step, against
  `ADR-0023`'s separate endpoint (see below). This is a deliberate, cleaner separation of concerns
  than this ADR's original design had: resolving "what platform does this organization belong to"
  and confirming "does this admin have access to that platform" are now two independent
  questions, each answered by its own single-purpose endpoint, rather than one endpoint trying to
  answer both by comparing against a JWT claim it no longer has.
- **Response:** `200 {id, platformId}` on a match — deliberately **not** the full `Organization`
  record (`name`, `taxCode`, `address`, `phone`, `type`). `payment-service` has no legitimate use
  for any of `Organization`'s business fields — it only ever needs to learn which platform the
  organization belongs to, then check access to that platform separately — so this endpoint
  returns the minimum needed to answer that question, rather than reusing `ADR-0020`'s full
  `OrganizationResponseDto` shape. `404` if `:id` doesn't resolve to any organization at all.

### New in this revision: `payment-service` also calls `ADR-0023`'s `GET /auth/platform-access/:platformId`

Having resolved the target organization's `platformId` via the call above, `payment-service`
makes a second, sequential call — forwarding the same admin JWT — to `ADR-0023`'s
`GET /auth/platform-access/:platformId`:

- **`200`** — the calling admin (owner or operator) currently has access to this platform.
  `payment-service` proceeds with its own action.
- **`404`** — per `ADR-0023`'s own Decision, this is the collapsed response for "no such
  platform" and "a real platform this specific admin simply has no active access to," from
  `auth-service`'s point of view. **`payment-service` translates this into its own, unchanged
  `403` response to its own caller** (see "Fail-closed response shapes" below) — only the
  mechanism `payment-service` uses to detect the access failure has changed from this ADR's
  original design (a JWT-claim comparison) to this two-call chain; the contract
  `payment-service` presents to *its own* callers is identical to what this ADR originally
  specified.
- **Any other failure** (timeout, network error, unexpected status) — treated identically to a
  failure on the first call: `payment-service`'s own `503` fail-closed response (see below).

**Authentication choice, unchanged from this ADR's original design: reuse the calling admin's
own already-verified JWT, not a new service-to-service credential**, for *both* calls above.
`payment-service` forwards, unchanged, the same `Authorization: Bearer <token>` header it already
received and already verified locally (via its own `JwtAuthGuard`/`RolesGuard`, per `ADR-0007`)
on the endpoint whose admin action triggered this check. This is recommended over minting a
separate service-to-service credential (a shared secret or similar), reasoned through explicitly
rather than simply asserted:

- The admin's JWT already carries exactly what both checks need — a `role: 'admin'` claim (to
  pass the first call's `RolesGuard`) and, for the second call, the caller's own identity
  (`sub`) and `adminTier`, which `auth-service` uses internally to decide `200` (owner, or an
  operator with an active assignment) versus `404` (an operator with none) — with nothing extra
  to smuggle across the service boundary via a new mechanism. Notably, **neither call needs a
  `platformId` claim from the JWT at all** — the first call doesn't take one as input, and the
  second call takes the platform id as a **path parameter**, not a claim, precisely because
  `ADR-0022` removed that claim from every admin's token.
- Every `payment-service` endpoint this ADR applies to (see below) already requires this same
  admin JWT to reach the handler in the first place, per `ADR-0007`'s existing
  `JwtAuthGuard`/`RolesGuard`. Forwarding it costs nothing structurally — it's already in hand by
  the time either check needs to run.
- It keeps the authorization chain traceable to a single, real principal: `auth-service` sees and
  authorizes the exact same caller who initiated the `payment-service` action, rather than
  authorizing `payment-service` as a generic, undifferentiated system principal acting "on behalf
  of" an unspecified admin — a materially weaker model.
- A dedicated service-to-service credential (a static shared secret, mTLS, or similar) would be a
  second, new kind of secret to provision, store, and rotate, compounding `ADR-0007`'s own
  already-open "no secret-distribution mechanism yet" gap (`payment-service` still has no
  solved story for even obtaining the JWT-signing secret it needs to verify tokens locally) rather
  than avoiding new infrastructure the way `ADR-0004`/`ADR-0007` already chose to when a simpler
  option was structurally sufficient. There is no scenario in which `payment-service` needs to
  make either call *without* an admin's own token already in hand, so a separate credential
  would add cost without adding any real capability.

### Which `payment-service` endpoints this applies to

Unchanged from this ADR's original design — re-reading `payment-service`'s existing and assumed
endpoints with the question "is this an admin acting on an arbitrary target organization, or a
caller already scoped to their own organization by their own JWT claim" produces three distinct
groups:

**Gets the check — organization-scoped admin actions targeting an arbitrary organization,
identified via a path/body value the caller doesn't inherently control:**

- **`POST /payment/charges/:chargeId/cash/confirm`** — the acting admin must have current
  platform access (owner: unconditional; operator: an active `PlatformAssignment`, per
  `ADR-0022`/`ADR-0023`) to the platform the `Charge.organizationId` belongs to.
- **`POST /payment/charges/:chargeId/cash/reject`** — same check, same reasoning.
- **`GET /payment/charges?method=cash&status=pending`** — same underlying question, applied as a
  *filter* rather than a single gate: since this endpoint returns rows across potentially many
  organizations at once, the check resolves every **distinct** `organizationId` present in the
  matched result set (deduplicated — one `GET /auth/organizations/:id` call per unique
  organization, not per row) to its `platformId`, then, for each **distinct** resulting
  `platformId`, one `GET /auth/platform-access/:platformId` call — excluding any row whose
  organization's platform the caller doesn't currently have access to, before returning the
  list. This is a two-tier deduplication (by organization, then by platform), a slightly larger
  batched cost than this ADR's original single-tier deduplication (by organization only, since a
  JWT-claim comparison needed no second network call at all) — see Consequences for the added
  cost this shape carries and why it wasn't avoided by excluding this endpoint instead.

**Does not get the check, reasoned through explicitly:**

- **`POST /payment/charges/cash`** — this is a self-service endpoint, not an admin action: per
  `ADR-0007`, its `organizationId` comes from the **caller's own JWT `organizationId` claim**,
  never a path or body parameter, and it carries no `role: admin` requirement at all (any
  authenticated caller whose JWT proves membership in the org being billed can call it). This is
  precisely the "already implicitly scoped" case: the caller can only ever act on the one
  organization their own token already proves membership in, so a cross-platform admin-privilege
  question simply doesn't arise — no admin identity, and hence no `adminTier`/access question,
  is present in this flow at all (unchanged from this ADR's original reasoning; only the specific
  claim named, `platformId`, no longer exists to have been absent in the first place). Applying
  this ADR's check here would be a category error, not extra safety.
- **`GET /payment/licenses/:organizationId/status`** (`ADR-0004`) — despite taking
  `organizationId` as a path parameter, this endpoint's only caller today is `auth-service`
  itself, calling on behalf of an anonymous prospective registrant (`POST
  /auth/organizations/validate`) or an ordinary end user's own login/refresh (`ADR-0004`/
  `ADR-0005`) — never an authenticated platform admin. Per the ADD/SDD, this endpoint "carr[ies]
  no separate authentication of [its] own beyond whatever network-level trust exists between
  `nawara-core` services" — there is no admin JWT anywhere in this call chain to check platform
  access against. This ADR's check requires an acting admin principal to check access for; this
  call has none, so the check has nothing to attach to. (The same reasoning excludes
  `GET /payment/subscriptions/:userId/status`, `payment-service`'s other unauthenticated internal
  read endpoint, for the identical reason — it isn't organization-scoped at all, let alone
  admin-scoped.)

### Fail-closed response shapes

Following `ADR-0004`'s own fail-closed reasoning — an error validating a check trumps letting a
security hole through — and its convention of a distinct status code per distinct cause, rather
than collapsing every failure into one generic response. **These response shapes, to
`payment-service`'s own callers, are unchanged from this ADR's original design** — only the
upstream mechanism (`auth-service` side) that produces the underlying success/failure signal has
changed, per the two-call chain above:

- **Genuine platform-access denial** (the organization lookup succeeds but the subsequent
  platform-access check returns `404` — meaning the calling admin currently has no access to the
  organization's platform — or the organization lookup itself returns `404`, meaning it doesn't
  exist at all) → `payment-service` returns **`403 { statusCode: 403, message: "You do not have
  authority over this organization." }`** to its own client, and performs **no mutation**. This
  is deliberately a distinct code from the plain `404` `ADR-0007` already returns for "this
  `chargeId` doesn't exist" — the two remain semantically different failures (a truly-unknown
  charge, versus a real charge this admin has no authority over) — and deliberately **not**
  `ADR-0023`'s own collapsed-404 pattern at the `auth-service` layer: unlike an `Organization`'s
  or a `Platform`'s existence (which `auth-service`'s own endpoints treat as sensitive to
  disclose across an access boundary), a `Charge`'s existence was never treated as sensitive by
  `ADR-0007` in the first place (which already returns a plain `404` for an unknown `chargeId`
  with no attempt to mask which ids exist) — extending platform-scoping to this endpoint doesn't
  retroactively need to adopt a masking posture `ADR-0007` never had. `payment-service`
  deliberately collapses "organization not found" and "organization found, but caller has no
  platform access to it" into the same `403`, for the identical reason `auth-service`'s own
  endpoints collapse the equivalent cases into a single `404`: neither distinction is safe to
  reveal to a caller with no legitimate reason to learn which is true.
- **Lookup failure** (timeout, network error, an unexpected non-`200`/`404` response, or any
  other error reaching `auth-service`, on **either** of the two calls) → `payment-service`
  returns **`503 { statusCode: 503, message: "Unable to verify organization; please try again."
  }`**, and performs no mutation — the exact `503`-on-infrastructure-failure convention `ADR-0004`
  already established for the reverse-direction call. Both calls need an explicit timeout on the
  order of a few seconds each, mirroring `ADR-0004`'s own recommendation, so a slow `auth-service`
  doesn't hang an admin action indefinitely; the two calls run sequentially (the second depends on
  the first's result), so the worst-case added latency for this check is now the sum of both
  timeouts, not one.
- **List filtering** (`GET /payment/charges?method=cash&status=pending`) has a different failure
  shape from the two single-target actions above, stated explicitly because it matters: if
  *any* of the batched per-organization or per-platform lookups needed to filter a given page
  fails or times out, the **entire request** fails closed with the same `503` shape above, rather
  than silently returning a partial list with the unresolved organizations' rows omitted.
  `ADR-0004`'s reasoning ("an error validating trumps a security hole") has a direct corollary
  here: for this specific endpoint — `ADR-0007`'s stated only way for an Admin to discover
  pending cash requests, given no dashboard exists anywhere in this repo — an error validating
  trumps a silently incomplete result. An admin who sees a shorter list than actually exists,
  with no indication anything was omitted, is a worse outcome than an explicit `503`. A genuine
  access denial, by contrast, is not a failure for this endpoint: a row belonging to a platform
  the caller has no access to is simply, correctly, left out of the response — there is no error
  to surface for that case.

## Consequences

- Closes the specific gap `ADR-0020`'s own Consequences named as this ADR's job: an admin can no
  longer confirm, reject, or discover (via the pending-cash listing) a cash payment belonging to
  an organization under a platform they have no current access to.
- **This is a simplification over what this ADR's original design would have needed once
  `ADR-0022`/`ADR-0023` landed, not an added complexity, despite adding a second network call.**
  The original design compared two values `payment-service` already had in hand from a single
  lookup (the caller's own JWT `platformId` claim, and the resolved organization's `platformId`)
  — a single call plus a local comparison. Under `ADR-0022`'s model, that comparison is no longer
  expressible at all (there is no caller-side `platformId` claim to compare against, for either
  tier), so `payment-service` would otherwise need two *different* code paths — one for "is the
  caller the owner of this org's platform" (checkable via `adminTier` alone) and a separate,
  bespoke one for "does this operator have an active assignment to this org's platform." Instead,
  `payment-service` now makes two sequential calls to two **generic**, already-designed
  `auth-service` endpoints (`GET /auth/organizations/:id`, then `GET
  /auth/platform-access/:platformId`) and applies the identical fail-closed wrapper to both,
  regardless of which tier the caller is — `auth-service`'s own endpoint already branches on
  `adminTier` internally (per `ADR-0023`), so `payment-service` never needs to know or care which
  tier it's dealing with.
- **`payment-service`'s three admin cash endpoints now have a hard runtime dependency on
  `auth-service` being reachable, across two sequential calls instead of one**, in addition to
  `auth-service`'s own pre-existing hard runtime dependency on `payment-service` (per `ADR-0004`/
  `ADR-0005`) — the two services are now mutually, synchronously dependent on each other for
  different flows. If `auth-service` is down or slow, no cash-payment confirmation, rejection, or
  pending-cash listing can complete, even though none of those actions touch any data
  `auth-service` owns beyond a `platformId` lookup and a `PlatformAssignment` check. This is the
  exact same category of tradeoff `ADR-0004` already accepted for the original direction of this
  dependency, applied here in reverse and now doubled in call count, and is accepted for the same
  reason: an unenforceable authorization gap is judged worse than a new availability coupling.
- **This ADR does not cache or denormalize `platformId` (or platform-access results) onto
  `License`/`Charge`/`UserSubscription` rows themselves** (see Option 2, deferred rather than
  adopted) — every affected request performs two live lookups, not a stored comparison. The
  clearest cost of this choice falls on `GET /payment/charges?method=cash&status=pending`:
  filtering that endpoint by platform access now requires up to one `auth-service` call per
  **distinct** organization present in the result page (to resolve `platformId`), plus up to one
  more per **distinct** resulting `platformId` (to check access) — a real and growing cost as
  pending-cash volume grows, and a strictly larger batched cost than this ADR's original
  single-tier design, since a platform-access check is now a separate call per distinct platform
  rather than a free local comparison. This is the same volume concern the ADD/SDD already flag
  as this endpoint's open pagination question, now compounded further by this revision. If that
  cost, or the mutual availability coupling above, ever proves unacceptable, denormalizing
  `platformId` onto `payment-service`'s own rows at write time (Option 2) is the named, concrete
  follow-up — not a new problem this ADR leaves undiscovered.
- Adds `auth-service`'s first endpoint whose only realistic caller is another `nawara-core`
  service acting on behalf of an already-authenticated end principal, rather than a browser/app
  client or a fully anonymous/internal system call — a new category alongside `ADR-0004`'s
  `POST /auth/organizations/validate` (anonymous) and `ADR-0020`'s admin-CRUD (owner/operator UI)
  — `GET /auth/platform-access/:platformId` (`ADR-0023`) now shares this same category with
  `GET /auth/organizations/:id`.
- `docs/add/payment-service.md` and `docs/sdd/payment-service.md` are updated (in a separate,
  later pass, not this dispatch) to describe this new two-call outbound dependency, the new
  `PlatformScopeService`/`OrganizationLookupClient` components, and the guard added to each
  affected endpoint. `docs/sdd/auth-service.md` already carries `GET /auth/organizations/:id`'s
  contract (attributed to this ADR) and gains `GET /auth/platform-access/:platformId`'s contract
  attributed to `ADR-0023`, not this ADR, since `ADR-0023` is what designed it.
- Explicitly out of scope, named plainly rather than silently dropped: any retrofit of this same
  platform-scoping check onto the still-undesigned gateway purchase/checkout flow or the
  `Charge → License`/`UserSubscription` issuance step (both already flagged as open in the ADD)
  — whoever designs those must independently decide whether, and how, they need an equivalent
  check, since neither exists yet for this ADR to reason about concretely.

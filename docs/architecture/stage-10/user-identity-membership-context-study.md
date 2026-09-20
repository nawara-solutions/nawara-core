# Stage 10: User identity, organization membership, and multi-context architecture study

- **Status:** Study (no implementation, no runtime/schema/ADR-status change). Refines, and partly revises, the
  direction of [the Auth/Flow-subscription/membership study](./stage-10-auth-flow-subscription-and-membership-study.md),
  in light of a scenario that study did not test: one User holding an organization role and an independent
  product-consumer role **at the same time**.
- **Date:** 2026-09-20

Every claim is tagged **[FACT]** (read directly from code/migration), **[DECISION — Accepted]** / **[DECISION —
Proposed]** (an ADR, status as written), **[INFERENCE]** (this study's reasoning from facts, not itself a
decision), **[RECOMMENDATION]** (this study's proposal, not accepted architecture), or **[OPEN QUESTION]** (the
owner must answer it; nothing in the repository does).

## 1. Executive summary

The worker+consumer scenario (Ahmed: a Driver delivery worker for Organization A *and* an independent Nawara Flow
consumer, as one identity) is the sharpest test this architecture has faced, and it produces one decisive
**[INFERENCE]**: `User.kind` is **single-valued** — one row, one `kind`, enforced by the same deferred trigger that
requires a matching subtype row (`owner`, `operator`, or ≥1 `organization_membership` for `member`). A single-valued
field structurally **cannot** represent "this person is simultaneously a Driver worker and a Flow consumer" — that
is two concurrent facts about one identity, not one classification of it. This is a stronger argument against
`User.kind = consumer` than the cost/style concerns raised in the prior study, and it is why this study's own
instructions correctly forbid that path.

The evidence supports **Model E** (§13): a generic `User` carrying only its stable, singular `kind`, with
`OrganizationMembership[0..N]` and product subscriptions/capabilities as separate, additive, per-product facts —
and **no** durable "active context" anywhere in identity, token, or (new) session state. Context is a
**request-time, resource-derived, always-reverified** concept, exactly as organization authorization already works
today (§6-7): nothing new needs inventing here, because Auth's existing authorization model already *is*
context-per-request, just not yet exercised for a context that has no `organizationId` in the URL at all (the Flow
consumer case).

**Nothing in this study is implemented.** It supersedes none of ADR-0028/0030/0031/0038/0041/0042/0043 and revises
only the *tentative, explicitly-not-a-decision* recommendation in the prior study's §18 (a new `User.kind`), which
this study's own evidence now argues against.

## 2. Current architecture

**[FACT]**, restated from the two prior studies and re-verified in this pass:

- `Company 1 → N Platform 1 → N Organization`; `Platform` is Core's generic "product/app" concept
  (core-architecture.md §1, `Proposed`).
- `User.kind ∈ {member, owner, operator}`, one value per row, enforced by a single deferred trigger
  (`user_require_subtype()`, `apps/auth-service/db/migrations/0001_identity_tenancy_platform_assignment.sql:143-145`,
  extended by `0007_multi_organization_membership.sql:117-127`).
- Three, and only three, identity-creation entrypoints exist, **verified this pass**:
  1. `POST /auth/register` → `User(kind=member)` + `organization_membership`, one transaction
     (`auth.service.ts:53-99`).
  2. `bootstrapOwner` (CLI) → `User(kind=owner)` + `Owner`, one transaction, no membership
     (`apps/auth-service/src/cli/owner-tools.ts:17-43`).
  3. **New this pass:** `OperatorAdminService.create()` (`apps/auth-service/src/operator/operator-admin.service.ts:21-30`)
     → `User(kind=operator)` + `operator` row, inside an owner's step-up-gated transaction, **no membership** —
     a third, independent precedent (alongside owner bootstrap) that identity creation and organization membership
     are already separate operations in this codebase for two of three kinds.
- Sessions are `refresh_token` rows keyed by `familyId` (the `sid` claim), **[FACT, new this pass]**
  `apps/auth-service/db/migrations/0001_...sql:247-263`: columns are `id, userId, tokenHash, familyId, revokedAt,
  expiresAt, replacedByTokenId, sessionExpiresAt (operator only), createdAt`. **No organization, platform, or
  context column exists on this table.** A `device` table (`installId`-keyed, `userId`-linked) exists separately
  and independently from session families — a user may already have many devices and many concurrent session
  families with no shared state between them.
- **[DECISION — Proposed, ADR-0025]** Owner step-up (`OwnerStepUp` row) is bound to `sid` (the session family),
  single-purpose, single-use, ≤15 minutes — the repository's only existing precedent for **session-scoped,
  transient, re-verified server state** that is neither permanent identity nor a token claim. It is a useful shape
  reference for §11, not a context mechanism itself.
- **[DECISION — Proposed, ADR-0028/0030]** Organization keys resolve to organization/platform/audience server-side
  and never carry role/permission; membership is read live per request, never cached in a token.
- **[DECISION — Proposed, ADR-0038, unbuilt]** billing-service is the designated owner of `organization_license`
  and `user_subscription` — the two independent entitlement facts Flow needs.

## 3. `User.kind` analysis

Per the requested audit dimensions, **[FACT]** for each:

| Dimension | Finding |
|---|---|
| Where stored | `"user".kind`, a Postgres enum column, `apps/auth-service/db/migrations/0001_...sql:70+` (`CREATE TABLE "user"`). |
| Where created | Set once, at row insert, by exactly the three entrypoints in §2. Immutability is DB-enforced, not just conventional: migration `0001_identity_tenancy_platform_assignment.sql:164-165` attaches a `forbid_column_change('kind')` trigger to `"user"`, and no application code attempts to update it either (`UPDATE "user" SET kind` does not occur anywhere in `apps/auth-service/src`). |
| Where validated | The deferred trigger `user_require_subtype()` requires a matching subtype fact per kind at commit; `organization_membership`'s composite FK (`userId, userKind → user(id, kind)`, CHECK `userKind = 'member'`) structurally prevents a non-member row. |
| Where used | `auth.guard.ts:53` loads `kind` on every authenticated request; `platform-access.service.ts` branches on it (owner/operator only); `auth.service.ts:212` branches `/auth/me`'s `memberships` field on it; `login()` branches owner vs. member/operator handling. |
| Authorization dependency | Indirect only: `kind` gates *which* authorization mechanism applies (membership vs. `PlatformAssignment` vs. company-wide owner), never a permission itself. |
| Authentication dependency | Yes — `login()` branches its challenge flow by `kind` (owner gets MFA challenge; member/operator get direct tokens or a distinct operator flow). |
| Membership dependency | One-directional: `kind=member` requires ≥1 membership; `kind=owner/operator` structurally *cannot* have one. |
| `/auth/me` dependency | Yes, directly (`u!.kind === 'member' ? memberships.list(...) : []`). |
| Session dependency | None found — `session.service.ts` signs `{sub, role, adminTier, sid}`; `role` is the neutral constant (`member` for members, `admin` for owner/operator per ADR-0030), not `kind` itself, and carries no context. |
| Registration dependency | Total — each entrypoint hard-codes its own `kind`; no registration path lets a caller choose it. |
| Owner/operator behavior dependency | Total — `platform-access.service.ts`'s entire authority model is a `kind`-branch (owner: company-wide; operator: `PlatformAssignment`; member: never, by this check). |

**[INFERENCE]** `User.kind` today is **not** a single clean category from the audit's five candidate meanings — it
is closest to **(2) account/lifecycle classification with (3) authorization-mechanism selection folded in**: it
answers "which authentication flow and which authority-derivation mechanism applies to this row," not "what can
this person do" (that is still `audience`, `PlatformAssignment`, and membership `isOrganizationAdmin`, all
separate). It is explicitly **not** (4) organization relationship — ADR-0030 already moved that fully to
`organization_membership`. It is **structurally single-valued and immutable post-creation**, which is the load-bearing
fact for §12-13.

## 4. `OrganizationMembership` analysis

**[FACT]**, consolidated from all three prior research passes:

- Schema: `organization_membership(userId, organizationId, status, audience, isOrganizationAdmin, userKind CHECK
  ='member', revokedAt, revokedBy, ...)`, `UNIQUE(userId, organizationId)`, composite FK `(userId, userKind) →
  user(id, kind)`.
- State machine (DB-enforced, `membership_guard` trigger, ADR-0030): `pending → active|rejected`, `active →
  revoked`; identity fields frozen after creation; `admin` flag clears in the same statement as revoke.
- Creation: only via `POST /auth/register` (with account creation) or `POST /auth/onboarding/join` (existing
  member, additional org) — both go through join-code redemption, both fail-closed on licensing.
- No deletion, ever — history is the audit anchor (ADR-0030).
- Authorization reads: `organizationAuthority()` and `memberBelongsTo()` (`platform-access.service.ts:76-110`),
  both live, per-request, both filter `kind='member'` — never cached, never derived from a token.
- The ≥1-membership requirement is enforced by exactly one deferred trigger branch (§2), added by migration
  `0007`, and is **not** read or relied upon by any authorization check itself (every check re-derives from current
  rows regardless of how many exist, including zero) — see the prior study's §3 table for the full
  security/business-rule/architecture-decision/implementation-choice breakdown, unchanged by this pass.

## 5. Zero-membership evidence

**[FACT]**, re-confirmed and extended this pass:

- Owner and Operator rows have **zero** `organization_membership` rows today, by construction (the composite FK
  makes it physically impossible), for the entire life of every existing owner/operator account. This is not a
  hypothetical — it is the current state of every owner and operator row in the database.
- `/auth/me` already returns `memberships: []` for both, unconditionally, with no downstream consumer (billing-service,
  payment-service — the only two verified callers) asserting non-emptiness.
- Login, refresh, logout, the request guard, and session issuance never query `organization_membership`, for any
  `kind`.
- **Conclusion [INFERENCE], sharper than the prior study's:** zero-membership identities are not a proposed future
  state to evaluate for feasibility — they are the **existing, working, load-bearing behavior of two of Auth's
  three identity kinds**. The only kind that cannot have zero memberships is `member`, by one deliberate trigger
  branch. The architecture question is not "can this work" (demonstrably yes) but "should a *fourth* shape of
  zero-membership identity be `kind=member`-like, `kind=owner/operator`-like, or something else entirely" — which
  is exactly what §12-13 resolve.

## 6. Identity vs. context analysis

**[INFERENCE]**, the study's central distinction, built from §2-5's facts:

```
Identity   = the "user" row + its kind. Created once. Stable. Never selected, never switched.
Membership = a durable, server-recorded fact ("this identity belongs to this organization"). 0..N. Additive.
Context    = which fact the CURRENT REQUEST is being evaluated against. Not stored anywhere as "the" context.
             Re-derived, per request, from the resource in the URL/body — already true for organization
             authorization today (core-architecture.md §6: "organization comes from the resource in the
             request... never from a token claim").
```

This is not a new principle this study invents — it is the **existing** organization-authorization model
(ADR-0030 decision: "no organization, platform or business role in the token... derives the context from the
resource in the URL and the live membership row"), simply **not yet named as a general pattern** or extended to a
context that has no organization in the URL (Flow's consumer browsing/purchasing, which may have no
`organizationId` in the request at all, or one per item browsed).

**Critical principle preserved [FACT confirms INFERENCE]:** "context selection is not authorization" is already
true today — resolving a join code (ADR-0028) or landing on an organization-scoped URL never itself grants
anything; every route re-checks `organizationAuthority`/`memberBelongsTo` live. Nothing in this study's proposed
extension (a consumer context with no organization at all) weakens this, because it adds no new trust input; it
only says a request can be valid with **zero** organization facts in play (a Flow consumer route), which the guard
already tolerates today (an owner/operator route already has zero organization facts in play).

## 7. Organization context

**[FACT/INFERENCE]** Already fully specified by existing, if `Proposed`, decisions — this study adds nothing new
here, only names it as "organization context" for symmetry with §8:

```
Authenticated User → organization key resolved (ADR-0028, discovery only) → server checks
OrganizationMembership (live, per request) → server checks capability (audience, isOrganizationAdmin,
organizationAuthority) → organization-scoped functionality authorized.
```

**[INFERENCE]** The scenario "User A obtains Organization B's key but has no membership in B": resolving the key
(`POST /auth/onboarding/resolve`) succeeds — it is public, discovery-only, and reveals only
platform/organization/audience/hints (ADR-0028). Using it to **register or join** creates a `pending` or `active`
membership through the normal, licensed, rate-limited path; it never bypasses membership creation. Using it to
**access** organization-scoped functionality without ever redeeming it is refused at the first live membership
check — the key is discovery, never a bearer credential (ADR-0028 §10, already decided). No change needed.

## 8. Consumer context

**[RECOMMENDATION, not decided]** By direct analogy to §7, and using only mechanisms that already exist:

```
Authenticated User → (no organization key required) → server checks an active product-level fact
(a billing user_subscription, per ADR-0038, not yet built) → consumer-level functionality authorized.

Authenticated User → browses/selects Organization X → server checks Organization X's product-level fact
(a billing organization_license for the Flow product, per ADR-0038) → server checks the User's subscription →
organization-specific consumer functionality authorized (NOT organization_membership).
```

**[INFERENCE]** This requires **no new Core concept**: it is the same "authenticated + live server-checked fact"
shape as §7, substituting a billing entitlement fact for a membership fact. It requires **no** organization key at
all for the pure user-level case (§8's first line) — consistent with ADR-0043's "Flow is platform-wide at entry."

## 9. Organization key semantics

**[DECISION — Proposed, ADR-0028, unchanged]** Confirmed, not revised: the key is discovery/context-resolution
only. This study's contribution is only to state explicitly, per the request, what it must **never** independently
grant, cross-checked against actual code:

| Must never grant | Verified |
|---|---|
| Worker/organization access | **[FACT]** `onboarding.resolve()`/`lookup()` (`onboarding.service.ts:88-104`) returns only platform/organization/audience/hints; it performs no membership write. |
| Admin access | **[FACT]** `isOrganizationAdmin` is set only by a separate, step-up-gated owner grant (ADR-0028) — never by key resolution. |
| Organization membership | **[FACT]** Membership is created only inside `register()`/`join()`'s transaction, after licensing and code-redemption checks — resolving alone writes nothing. |
| Platform authority | **[FACT]** Unrelated code path (`platform-access.service.ts`); keys are never read there. |
| Product permissions | **[FACT]** `audience` is opaque to Auth (ADR-0028/0030); Auth interprets no product permission from it. |

## 10. Organization membership vs. consumer relationship

**[INFERENCE]**, directly answering the request's "where should the consumer relationship conceptually belong":

`organization_membership` encodes a specific, heavyweight bundle of facts that a Flow purchase/order relationship
does not have and should not acquire: an approval workflow (`pending/active/rejected/revoked`), an `audience`
label, eligibility for the org-admin capability grant path (ADR-0028/0029), and inclusion in
`organizationAuthority`'s authority evaluation. Modeling "Ahmed bought from Organization B" as a membership would
silently make Ahmed eligible, by construction, for every membership-gated mechanism Driver/School built for actual
organizational belonging — a capability leak, not a convenience.

**[RECOMMENDATION]** The consumer/purchase/order relationship belongs to the **product domain** (Nawara Flow,
outside this repository), not to Core, for the same reason CLAUDE.md already keeps Driver/School's business
concepts out of Core: "would an unrelated future app (a delivery app, a booking app) find this useful as-is?" — a
generic `ConsumerRelationship` entity is not obviously reusable in the way `organization_membership` is (every
platform needs "who belongs here"; not every platform needs "who bought what from whom," which is closer to an
order/invoice line, already billing-service's domain under ADR-0038). This study does **not** invent or specify
such an entity, per its scope fence.

## 11. Context persistence / switching analysis

Evaluated per the four requested models, against the evidence in §2 (no context column exists anywhere today):

| Model | Security | Session/token impact | Multi-device (§ scenario 12) | Client neutrality | Verdict |
|---|---|---|---|---|---|
| **A — client-only, sent per request, server validates every time** | Strongest: no server state to go stale or leak across devices; matches how organization context already works (resource-derived) | None — no new token/session field | Trivially correct: each device sends its own current selection | Fully neutral — any client can send a resource id | **[RECOMMENDATION]** Preferred |
| **B — session-associated (stored against the `familyId`/session row)** | Weaker: a stale session-stored context could outlive the reason it was set; needs its own revocation/staleness story | Adds a mutable column to `refresh_token` or a new table, and a write on every switch | Naturally per-device already (`familyId` is already per-device/session) — but couples "which org am I looking at" to session lifecycle, which ADR-0030 deliberately avoided for exactly this staleness reason | Neutral, but adds server state a client must remember to update | Workable but strictly worse than A for no added guarantee, since every operation is re-authorized server-side regardless |
| **C — token/context claims** | **Rejected outright** — this is exactly what ADR-0030 already reversed ("a token would then bind one organization and a stale token would outlive a revocation") and what core-architecture.md §6 already forbids ("organization... never from a token claim") | Reintroduces the stale-token problem ADR-0030 explicitly solved | A refreshed token on one device would not reflect a switch made on another | Fine technically, bad architecturally | **[INFERENCE]** Contradicts an existing decision; not a live option |
| **D — per-operation, request carries its own target** | Same as A in substance — "per operation" and "client-only, sent per request" are the same shape once you require server validation every time | None | Same as A | Same as A | Equivalent to A |

**[RECOMMENDATION]** Model A/D (they collapse to one model): the client names its target (an organization id, or
"consumer/no organization") **on each request that needs one**, exactly as organization-scoped routes already work;
the server validates live every time; nothing is stored as "the" active context anywhere — not in the `User` row,
not in the session/`refresh_token` row, not in the access token. This requires **zero** schema change to persist
context, because nothing needs to persist: it is re-derived every time, the same way `organizationAuthority`
already re-derives authority every time.

**Should context survive logout/login or token refresh?** **[INFERENCE]** Under Model A/D, this question mostly
dissolves — there is no server-side "context" to survive or not; a client that wants a remembered "last-viewed
organization" convenience stores that **client-side** (already how any UI would remember a last-used filter), and
it is re-validated on first use after any refresh regardless. Multiple concurrent sessions/devices (scenarios 11-12)
are already structurally independent today (separate `familyId` rows, separate `device` rows) and need no new
coordination under this model.

## 12. `User.kind` alternatives

**[INFERENCE]**, directly using §3's finding: `kind` is single-valued and immutable-after-creation. Testing it
against future pressure (`driver`, `student`, `teacher`, `parent`, `customer`, ...) and against the worker+consumer
scenario specifically:

> **Does a person being a Flow consumer represent a fundamental identity classification, or a product
> capability/context?**
>
> **[INFERENCE, answer]:** A product capability/context. The decisive evidence is that Ahmed must be *both*
> "Driver worker for Organization A" *and* "Flow consumer" **simultaneously**, as the same `sub` claim, the same
> row. `User.kind` has exactly one value. Making `consumer` a `kind` value would force a choice Ahmed does not have
> to make in the real scenario the study was asked to model — it would need `kind='member'` (for his Driver
> membership) *and* `kind='consumer'` (for Flow) at once, which the schema cannot express without either a second
> `User` (explicitly forbidden) or turning `kind` into a set instead of a scalar (which stops it being the kind of
> classification the rest of the system — the trigger, the login branch, `platform-access.service.ts` — already
> depends on being singular and exhaustive). This is a **structural**, not merely stylistic, argument, stronger
> than "would become a global persona taxonomy" alone (though that concern is also valid and independently raised
> in the task's own framing).

**[RECOMMENDATION]** Consumer status is a **capability/context fact** (§8), checked per-request against a
billing-owned entitlement, never a `User.kind` value. `member | owner | operator` stays exactly as it is.

## 13. Architecture models A–E

**Model A — mandatory membership (current state).** Cannot express Flow's platform-wide entry at all without
membership (the status quo the two prior studies already examined).

**Model B — optional membership (`User.kind=member` with 0..N).** Rejected by the prior study on semantic grounds
(§14 there) — this study adds no new argument for it and does not revisit that conclusion.

**Model C — `User.kind` includes `consumer`.** **Rejected by this study**, on the structural single-valuedness
argument in §12 — a strictly stronger objection than the prior study's semantic-muddling concern, because it shows
the model cannot even express the scenario it needs to (worker + consumer, concurrently), not merely that it is an
inelegant way to express it.

**Model D — generic User + product subscriptions/capabilities, no separate runtime-context concept named.**
Correct as far as it goes (matches §8-10) but incomplete: it doesn't yet say how a request declares *which*
context (an organization, or none) it means, which §11 needs answered explicitly.

**Model E — generic User + runtime/request-time context (recommended).**

```
User                                          (stable identity, kind unchanged, §3)
├── OrganizationMembership[0..N]              (§4, unchanged — Driver/School)
├── product subscription/access facts         (§8 — billing-owned, ADR-0038, e.g. Flow user_subscription)
└── product capability facts                  (audience, isOrganizationAdmin, PlatformAssignment — unchanged)

Per request (never persisted as "the" context — Model A/D from §11):
└── target = an organization (from the URL/body, existing pattern) OR none (consumer-level route)
      └── server re-derives: membership? subscription? organization participation (organization_license)?
            capability? → authorize or refuse, live, every time.
```

**[RECOMMENDATION]** Model E is the direction this study supports. It requires **no** new identity concept, **no**
new session/token field, and **no** schema change to *represent* context — only (separately, later, an owner
decision) billing-service actually building the `user_subscription`/`organization_license` tables ADR-0038 already
designed, so there is something for a consumer-level request to check.

**Evaluation against the 21 criteria:** Model E scores no worse than the current architecture on every criterion
already satisfied today (identity purity, authentication simplicity, multi-organization support, client
neutrality, migration safety, database integrity, API stability — none of these are touched), and is the only
model that satisfies "worker + consumer users" (criterion 8) and "avoidance of global persona taxonomy" (criterion
21) without contradiction, per §12's structural argument. No numeric scorecard is given, per the request.

## 14. Scenario analysis

All twelve scenarios, resolved under Model E:

| # | Scenario | Resolution |
|---|---|---|
| 1 | Flow-only consumer, 0 memberships | Authenticated + active `user_subscription` (billing) → consumer-level Flow access. No membership needed. |
| 2 | Organization worker | Authenticated + active `organization_membership` with an `audience`/capability the product interprets as "delivery." Unchanged today. |
| 3 | Worker + consumer | One User; `kind=member` (from the Driver membership, unaffected by Flow); a separate, independent `user_subscription` row for Flow. Both facts coexist because neither lives on `kind`. |
| 4 | Worker + customer of another org | Same as 3, plus: consumer-level access to Organization B checked via B's `organization_license` (if Flow-participating) and Ahmed's subscription — **not** a second membership. |
| 5 | Admin + consumer | Admin authority via `organizationAuthority`/`isOrganizationAdmin` for A, entirely independent of the Flow subscription fact — two unrelated checks, correct outcome by construction (neither can leak into the other, since they read different tables). |
| 6 | Multiple orgs + consumer | N membership rows (one per org, exactly as ADR-0030 already supports) + one subscription row. No new mechanism. |
| 7 | Organization key without membership | Resolves (discovery only, §9); grants nothing; using it to *act* requires the normal join/registration path. |
| 8 | Loses membership, keeps Flow consumer access | `organization_membership.revokedAt` set; `user_subscription` (a separate table, separate lifecycle owned by billing) is untouched — this is only true because the two facts are architecturally independent, which is exactly what this study recommends preserving. |
| 9 | Consumer becomes worker | Existing `POST /auth/onboarding/join` creates the membership; the existing subscription is untouched — again, only correct because they're independent facts, not a state transition on one shared field. |
| 10 | Worker stops working, stays consumer | Same as 8. |
| 11 | Multiple sessions, different context per session | Already structurally supported (§2: independent `familyId` rows); under Model A/D (§11) each request just names its own target — no cross-session coordination needed or attempted. |
| 12 | Multiple devices, different context per device | Already structurally supported (`device` table, independent of `familyId`); same answer as 11. |

## 15. Security analysis

**[FACT confirms, restated for this study's scope]:**

- Consumer context grants **no** organization admin/worker/membership/platform authority — under Model E these are
  checked against entirely separate tables (`organization_membership` vs. a future `user_subscription`); there is
  no code path by which resolving one could satisfy the other, because neither check reads the other's table.
- Organization context (landing on, or naming, an organization) grants nothing by itself — every existing
  organization-scoped route already re-derives authority live (§6-7); this is unchanged, and Model E adds no new
  trust input that could weaken it.
- Server-derived facts remain authoritative throughout: nothing in this study proposes trusting a client-supplied
  `organizationId`, `platformId`, `role`, `permission`, `membership`, `subscription`, or `capability` — every fact
  above is a live database read, consistent with core-architecture.md §6's existing, unmodified rule.

## 16. Registration architecture

**[RECOMMENDATION]**, matching the prior study's direction and this task's explicit fence against a
product-conditional `/auth/register`:

```
Organization onboarding (Driver/School — unchanged):
  POST /auth/register {joinCode, ...} → User(kind=member) + OrganizationMembership, one transaction.

Consumer onboarding (Flow — NOT specified or implemented here, only the shape argued for):
  A separate entrypoint → User(kind=member, unchanged — no new kind, per §12) → no membership created →
  (separately, later, once ADR-0038 is built) a billing-service call creates the user_subscription.
```

**[INFERENCE]** Because §12 rules out a new `kind`, a Flow-only consumer is simply a `kind=member` User with **zero**
memberships at creation time — which reopens, rather than resolves, the exact question the prior study flagged as
its one open architectural fork: the `member` branch of the deferred trigger (§2, §4) still requires ≥1 membership
at commit. **This study does not resolve that fork.** It only narrows the shape of the eventual answer: whatever
new entrypoint creates a membership-less consumer, it does **not** need a new `kind` to do so — it needs the
`member`-branch invariant itself relaxed, or a materially different subtype path for this one case. That is
unavoidably still an Auth migration decision, deferred to the owner (§22), just no longer entangled with a
`User.kind` taxonomy question.

## 17. Client-neutral implications

**[FACT/INFERENCE]** Nothing in Model E is client-shaped: "target = an organization, or none" (§11) is expressed
as a resource identifier or its absence in a request, exactly like every existing organization-scoped route — no
`isTauri`, `clientType`, or client-specific business concept is introduced, consistent with ADR-0041's already-
accepted client-neutrality principle (restated for administration, and by ADR-0043 for entry, and now for context
selection by this study — the same rule, applied a third time, not a new one).

## 18. ADR impact

| ADR | Classification | Reasoning |
|---|---|---|
| ADR-0010 | UNCHANGED | Already superseded in its login mechanism by ADR-0025; its device-alerting/hashing/rotation pieces are untouched by this study. |
| ADR-0025 | UNCHANGED | Its `sid`-bound step-up shape is cited (§2) as a useful precedent, not modified. |
| ADR-0028 | UNCHANGED | Organization-key semantics (§9) fully confirmed, not revised. |
| ADR-0030 | UNCHANGED | Multi-organization membership model confirmed; its ≥1-membership trigger is the one open item, already flagged by the prior study, not newly changed here. |
| ADR-0038 | UNCHANGED, but its acceptance is now motivated by two independent studies (this one and the prior) | Both `user_subscription` and `organization_license` are load-bearing for Model E's consumer-context checks. |
| ADR-0040, ADR-0042 | UNCHANGED | No interaction found. |
| ADR-0041 | UNCHANGED | Its client-neutrality rule is extended by inference (§17), not amended. |
| ADR-0043 | UNCHANGED, cross-reference recommended | Its "how a Flow-only identity exists" open item is **narrowed** by this study (a `kind` question becomes a membership-invariant question) — see §22. Its own status, decisions, and text otherwise stand. |
| Prior study (`stage-10-auth-flow-subscription-and-membership-study.md`) | **REQUIRES AMENDMENT** (of its own tentative recommendation, not any ADR) | Its §18 recommendation ("a new, generic `User.kind`... following the existing subtype pattern") is superseded by this study's §12 structural finding. It was explicitly labeled `[INFERENCE — recommendation, not a decision]` there, so nothing accepted is being reversed — only a still-open recommendation is being corrected before it could mislead an owner decision. |

**No new ADR is drafted by this study.** The remaining open item (relaxing, or adding an alternative to, the
`member`-branch membership invariant) is exactly the fork the prior study already named and deferred; this study
sharpens its shape but does not turn it into a proposal, per its own scope fence ("Do NOT add `consumer` to
`User.kind`... Do NOT remove or change the OrganizationMembership invariant").

## 19. Migration implications

**Not designed here — evidence-backed implications only, as requested, for a hypothetical future change:**

- Current Users (all three kinds) are unaffected by anything in this study: no existing row, trigger branch, or
  table is touched.
- If a future ADR relaxes or adds an alternative to the `member`-branch invariant (§16), an
  **expand → verify → migrate → contract** shape fits the evidence: expand (add the new path without touching the
  existing branch), verify (existing registration/join continue exercising the untouched branch, per the shared
  `register()` test helper already always supplying `joinCode`), migrate (new consumer accounts use the new path),
  contract (only if/when the old path is ever deprecated — no evidence suggests it should be; Driver/School keep
  needing it).
- No rollback hazard is introduced by Model E itself, since it adds no schema; the only schema-touching decision
  remains the deferred one in §16.

## 20. Future product implications

**[INFERENCE]** Model E generalizes past Flow without further Core change: any future product needing
"platform-wide entry, per-product entitlement, optional per-organization relationship" (a delivery app, a booking
app — the same test CLAUDE.md already applies) reuses the identical shape — `organization_membership` if it needs
real organizational belonging, a billing entitlement if it needs a product-level subscription, live per-request
authorization either way. No product-specific concept is added to Core by this study.

## 21. Recommendation

**[RECOMMENDATION]**

1. Keep `User.kind` exactly as it is (`member | owner | operator`); do not add `consumer` (§12 — structural
   argument, not merely stylistic).
2. Adopt Model E's separation conceptually: identity (stable) / membership (0..N, additive) / product
   subscription-and-capability facts (additive, billing-owned per ADR-0038) / request-time context (never
   persisted, Model A/D from §11).
3. Treat context selection as already-solved by the existing organization-authorization pattern; extend it, when
   Flow is built, to requests with no organization at all (a pure consumer-level check) rather than inventing a
   parallel mechanism.
4. Leave the `member`-branch membership invariant exactly where the prior study left it: a real, narrow, deferred
   owner decision (§22), now understood as independent of any `User.kind` question.
5. Accept and schedule ADR-0038 (unchanged recommendation from the prior study, reinforced here: both the user- and
   organization-level entitlement facts Model E's consumer-context checks depend on live there).

## 22. Open owner decisions

> **2026-09-20 update:** item 1 below is decided — see
> [the member-membership-invariant owner decision](./member-membership-invariant-owner-decision.md).
> **ACCEPTED:** `member → OrganizationMembership [0..N]`. Not implemented; the *how* (exact trigger change,
> registration entrypoint) remains future work. Items 2-4 remain open.

Only genuine decisions, none silently made:

1. ~~Whether, or how, to relax or bypass the `member`-branch ≥1-membership invariant for a future Flow-consumer
   registration path (unresolved by both this study and the prior one — the one recurring open fork).~~ Decided
   above: relax it, to `[0..N]`.
2. Whether ADR-0038 should be accepted and scheduled now.
3. Whether a Flow consumer-to-organization interaction record (an order, a saved relationship — §10) belongs to the
   Flow product repository entirely, or needs any Core-level touchpoint (this study's evidence points to "entirely
   product-owned," but the owner may know of a cross-product need this study cannot see).
4. Whether the prior study's tentative `User.kind=consumer` recommendation should be formally retired in that
   document (a documentation housekeeping decision, not an architectural one) or left as historical context with
   this study's cross-reference.

## 23. Implementation prerequisites

**[INFERENCE]** Before any of this is implemented (not authorized by this study):

- An owner decision on item 1 above (the membership-invariant fork), since it is the only piece requiring an Auth
  migration.
- ADR-0038's acceptance and build-out in billing-service (currently 11 migrations, none of them entitlement —
  §8/prior study §8), since Model E's consumer-context checks have nothing to read until then.
- A concrete Flow product design (outside this repository) that defines what "consumer-level" vs.
  "organization-specific consumer" capabilities actually are — this study only makes room for that distinction, it
  does not populate it.

---

## Baseline

- **Branch:** `feat/organization-ownership-transition`.
- **HEAD:** `1eddeac`, unchanged; no commits made this session or this task.
- **Working tree:** carries this session's full chain of study/ADR work (three prior studies plus this one, plus a
  companion ADR), none of it committed. This task's own contribution: one new file
  (`docs/architecture/stage-10/user-identity-membership-context-study.md`) and small cross-reference edits to two
  already-uncommitted files from earlier in this session (`docs/architecture/stage-10/stage-10-auth-flow-subscription-and-membership-study.md`
  §18, `docs/adr/0043-...md`'s existing update note) plus two rows in `docs/architecture/README.md`. No runtime,
  schema, or unrelated file touched.
- **`git status --short`:** 3 modified (`docs/adr/README.md`, `docs/architecture/README.md`,
  `docs/architecture/core-architecture.md`), 4 untracked (`docs/adr/0043-...md`, and three files under
  `docs/architecture/stage-10/`) — all from this session's work, nothing pre-existing or unrelated.
- **`git diff --stat`:** 3 files changed, 7 insertions(+) (the tracked-file edits only; new files don't appear in
  `diff --stat` until staged).

## Validation

| Command | Result |
|---|---|
| `npm run check:repo` | PASS |
| `npm run test:repo` | PASS (15/15) |
| `git diff --check` | PASS (no whitespace errors) |

## Runtime impact

**NONE.** This is a documentation-only study. No migration, schema, API, or runtime code was modified.

```
STAGE 10 USER IDENTITY / MEMBERSHIP / CONTEXT STUDY COMPLETE
```

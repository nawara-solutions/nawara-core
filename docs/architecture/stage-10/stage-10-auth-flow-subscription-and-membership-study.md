# Stage 10: Auth, Nawara Flow subscription, and organization participation — study

- **Status:** Study (no implementation, no runtime or schema change). Does not accept, amend, or supersede any ADR.
  Feeds a future decision on [ADR-0043](../../adr/0043-product-specific-entry-context-and-licensed-organization-participation.md)'s
  open item ("how a Flow-only consumer identity is represented in Auth").
- **Date:** 2026-09-20

Every claim below is tagged: **[VERIFIED]** (read directly from code/migration in this repository),
**[ACCEPTED DECISION]** (an ADR with status `Accepted`), **[PROPOSED DECISION]** (an ADR with status `Proposed`,
not yet binding), **[INFERENCE]** (this study's reasoning from verified facts, not itself a decision), or
**[OPEN DECISION]** (nothing in the repository answers this; the owner must).

## 1. Executive summary

Nawara Flow's stated entry model — a consumer subscribes to Flow and uses it before naming any organization,
then interacts with whichever organizations are separately licensed for Flow — introduces two dimensions Core has
never had to separate before: **a user-level product subscription** and **an organization-level product
participation/license**, both independent of **organization membership**.

The audit found:

- **[VERIFIED]** Auth's ordinary authentication path (login, refresh, logout, the request guard, session issuance)
  never queries `organization_membership`. Only `POST /auth/register`, `POST /auth/onboarding/join`, and the
  membership/authorization-check endpoints do.
- **[VERIFIED]** `/auth/me` already returns `memberships: []` for every Owner and Operator today, unconditionally.
  A zero-membership response shape is not new; it already exists for two of Auth's three `User.kind` values.
- **[VERIFIED]** Owner and Operator identities already exist with **zero** rows in `organization_membership`,
  structurally: the same database trigger that requires a `member` to hold ≥1 membership also requires an `owner`
  to hold exactly one `owner` row and an `operator` to hold exactly one `operator` row — three parallel branches of
  one function, not a membership-specific special case.
- **[VERIFIED]** The one and only place a "no organization at all" User is currently impossible is the `member`
  branch of that same trigger, attached to `POST /auth/register`'s mandatory `joinCode`.
- **[PROPOSED DECISION]** Billing-service (ADR-0038, status `Proposed`, **not yet built** — no `user_subscription`
  or `organization_license` table exists in `apps/billing-service` today) is already the *designated* owner of
  both "organization license" and "user subscription" as generic entitlement concepts. This means the two
  independent dimensions Nawara Flow needs — user subscription and organization participation — **already have an
  intended owner in an existing, if unbuilt, decision.** No new service or new Core concept is implied by
  sections 2-3 of the request that started this study.
- **[VERIFIED]** No downstream service (billing-service, payment-service) asserts that a caller's `memberships`
  array is non-empty. The shared `HttpAuthClient.getIdentity()` in `libs/service-kit` validates only that
  `memberships` is an array; an empty array already passes.

**Bottom line [INFERENCE]:** the architecture does not need a new "consumer" relationship type invented from
scratch, and does not need a synthetic organization. It needs one narrow, deliberate decision about Auth's
`User.kind` enum (§18), plus acceptance and implementation of ADR-0038's already-proposed entitlement boundary.
Nothing here should be implemented from this study alone.

## 2. Existing architecture (what already governs this area)

- **[VERIFIED]** `Company 1 → N Platform 1 → N Organization`; `Platform` is the generic model of "a
  product/app" (core-architecture.md §1, itself `Proposed`; restated by [ADR-0043](../../adr/0043-product-specific-entry-context-and-licensed-organization-participation.md), also `Proposed`). The hierarchy shape is implemented in the auth-service schema today, which is why this is `[VERIFIED]` rather than tied to either document's still-`Proposed` status.
- **[VERIFIED]** `User.kind` is `member | owner | operator` in the actual `user_kind` enum and migrations (ADR-0009 is `Superseded by ADR-0022`; ADR-0022 and ADR-0030, which refined it, are both `Proposed`) — the enum as built matches what these documents describe, but none of them is `Accepted`. A member's
  business role is the membership's opaque `audience` label, never a `User` field.
- **[PROPOSED DECISION]** Organization keys (join codes) are context-resolution mechanisms, never identity or role
  ([ADR-0028](../../adr/0028-organization-join-codes-membership-and-organization-admin.md)).
- **[PROPOSED DECISION]** Multi-organization membership: one User, many `organization_membership` rows, no
  organization/platform/role in the token ([ADR-0030](../../adr/0030-multi-organization-membership-and-revoked-state.md)).
- **[PROPOSED DECISION]** organization-service is the intended, not-yet-authoritative owner of Company/Platform/Organization
  ([ADR-0031](../../adr/0031-organization-service-intended-owner-of-the-hierarchy.md); cutover mechanism [ADR-0040](../../adr/0040-organization-ownership-migration-decisions.md),
  **Accepted**, not performed). `organization_membership` is never in scope for this migration — it stays in Auth
  under every version of this decision (organization-service README: "Never owns: `OrganizationMembership`").
- **[PROPOSED DECISION]** Entitlement (organization license, user subscription) is billing-service's, not Auth's,
  not payment's ([ADR-0038](../../adr/0038-entitlement-in-billing-service.md)).
- **[PROPOSED DECISION]** Client neutrality for administration ([ADR-0041](../../adr/0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md));
  service-token Platform scope for hierarchy validation ([ADR-0042](../../adr/0042-service-token-scopes-and-administrative-authorization.md), **Accepted**).
- **[PROPOSED DECISION]** Product-specific entry context: Driver and School require organization context at entry,
  Flow does not ([ADR-0043](../../adr/0043-product-specific-entry-context-and-licensed-organization-participation.md)).
  ADR-0043 explicitly left "how a Flow-only identity exists in Auth" undecided; this study is that examination.

## 3. Verified Auth membership invariant

**[VERIFIED]** The invariant is enforced by exactly one place: a single deferred database trigger, not application
code, not a documented business rule stated anywhere outside that trigger and its migration comment.

- Trigger attachment, `apps/auth-service/db/migrations/0001_identity_tenancy_platform_assignment.sql:143-145`:
  ```sql
  CREATE CONSTRAINT TRIGGER user_require_subtype
    AFTER INSERT ON "user" DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION user_require_subtype();
  ```
- Function body, extended by `apps/auth-service/db/migrations/0007_multi_organization_membership.sql:116-127`
  (`CREATE OR REPLACE FUNCTION user_require_subtype()`), three parallel branches:
  - `kind='owner'` → an `owner` row must exist.
  - `kind='operator'` → an `operator` row must exist.
  - `kind='member'` → **added by migration 0007**: `NOT EXISTS (SELECT 1 FROM organization_membership WHERE "userId" = NEW.id)` raises `23514`.
- `organization_membership` is structurally scoped to members only: `"userKind" ... CHECK ("userKind" = 'member')`
  and a composite FK `("userId","userKind") REFERENCES "user"(id, kind)` (`0007:44,59-62`) — an owner or operator
  row cannot physically appear in this table.
- Corroborating comment, `apps/auth-service/src/users/users.service.ts:56-59`: *"A member identity. It carries NO
  organization and NO business role... The database refuses (deferred) a member that ends a transaction without
  at least one membership."*

**Separating the categories the request asked for:**

| Category | Verdict |
|---|---|
| Security requirement | No. Nothing security-relevant reads or depends on "≥1 membership" as a security boundary — every authorization check that matters (`organizationAuthority`, `memberBelongsTo`, `platform-access.service.ts`) re-checks live, per-request, per-resource membership; none of them would behave differently or less safely if a member could transiently have zero memberships. **[VERIFIED]** via `apps/auth-service/src/platform/platform-access.service.ts`. |
| Business rule | Yes, but a narrow one: "a `member` account is, by definition, a member of at least one organization" — a naming/semantics rule, not a business requirement about Flow. |
| Architecture decision | Yes — this specific branch was added deliberately by ADR-0030 (status `Proposed`), for the Driver/School-shaped world that existed before Flow's requirements were known. |
| Implementation choice | The *mechanism* (a deferred DB trigger) is an implementation choice; the *rule* it encodes is the ADR-0030 decision above. |
| Convenience assumption | No evidence of this; the trigger is deliberate, tested implicitly through the shared `register()` helper in `multi-membership.e2e-spec.ts`, and explained in a code comment. |

**[VERIFIED — caveat, corrected]** It is [ADR-0028](../../adr/0028-organization-join-codes-membership-and-organization-admin.md)
(not ADR-0030) that cites migration scenarios "M5/M6"; they exist as named scenarios in
`apps/auth-service/db/tests/run.sh:89-109`. On inspection, M5/M6 test migration-0004 backfill and
rollback-refusal behavior, not the ≥1-membership invariant itself. No test was found that isolates "creating a
member with zero memberships is rejected" as its own assertion — the invariant is exercised only implicitly (every
test's shared helper always supplies a `joinCode`). This is a minor documentation/test-naming gap, not a
contradiction: the trigger's existence and text is directly verified from the migration SQL, which is stronger
evidence than a test name would be.

## 4. Registration analysis

**[VERIFIED]** `POST /auth/register` (`apps/auth-service/src/auth/auth.service.ts:53-99`):

1. `onboarding.lookup(joinCode)` — a bad/expired/revoked/exhausted code → `403` (generic).
2. `payment.isOrganizationLicensed(...)` — fail-closed → `403`/`503`.
3. **Single DB transaction** (lines 76-85): spend the join-code use, create the `User(kind=member)` row, create the
   `organization_membership` row, write audit records, issue a session. All in one commit.

There is **no** code path in `auth.service.ts` that creates a `kind=member` User without also creating a
membership in the same transaction. `RegisterDto.joinCode` (`apps/auth-service/src/auth/dto.ts:9`) has no
`@IsOptional()`.

**[VERIFIED]** The only other account-creation entrypoint is `bootstrapOwner`
(`apps/auth-service/src/cli/owner-tools.ts:17-43`, ADR-0016): creates `User(kind=owner) + Owner` in one
transaction, with **no membership involved at all** — direct precedent that a Nawara identity can already be
created without ever touching `organization_membership`, just not today for `kind=member`.

**[INFERENCE]** `POST /auth/register` was designed, top to bottom, as an **organization-onboarding** flow (join
code in, licensed-organization check, membership out), not as a generic "create a Nawara identity" flow. It is not
that generic account creation was considered and rejected — it was never the problem ADR-0028/ADR-0030 were
solving. This matters: extending it to a Flow-only path is not "loosening an existing generic rule," it is adding
a second, narrower entrypoint next to a purpose-built one.

## 5. `/auth/me` analysis

**[VERIFIED]** `apps/auth-service/src/auth/auth.service.ts:212`:
```ts
memberships: u!.kind === 'member' ? await this.memberships.list(userId) : [],
```
For every Owner and every Operator, `/auth/me` **already, today, unconditionally** returns `memberships: []`. No
assertion of non-emptiness exists anywhere in `me()` or elsewhere in the auth-service codebase (verified by a
full-tree search for non-empty-array assertions on this field — none found).

**[VERIFIED]** Consumers: `libs/service-kit/src/service-auth/auth-client.ts:53-60`, `HttpAuthClient.getIdentity()`
parses the `/auth/me` response and validates only `typeof b.id === 'string'`, `typeof b.isActive === 'boolean'`,
and `Array.isArray(b.memberships)` — **not** that the array is non-empty. `billing-service` and `payment-service`'s
`service-or-user.guard.ts` (both services, same shape) check only `identity.isActive`, never membership count.

**Conclusion [INFERENCE]:** the `/auth/me` **response contract** already supports a zero-membership User; nothing
downstream would break if a `kind=member` (or a new kind) User could have `memberships: []`. The contract does not
need to change for this reason. What is missing is only the ability to *create* such a User in the first place
(§3-4), not the ability to *represent* one.

## 6. Authentication-path independence analysis

**[VERIFIED]**, file by file:

- `login()` (`auth.service.ts:158-181`) queries only `"user"`; no membership query.
- `refreshSession()` (`183-196`) calls `refresh.rotate()` + `users.findById()` + `sessions.access()`; no membership query.
- `logout()` (`198-200`) revokes the refresh token only.
- `auth.guard.ts:53` loads `SELECT id, kind, role, "isActive" FROM "user" WHERE id = $1` — never touches membership.
- `session.service.ts` signs `{sub, role, adminTier, sid}` — no organization/membership claim, consistent with
  ADR-0030's "no organization, platform or business role in the token."
- `platform-access.service.ts` (the Owner/Operator platform-access check) joins `user → owner` and
  `user → platform_assignment`; it never joins `organization_membership`. Its own comment states members are
  "never" evaluated by this check ("members are scoped by Organization, not by this check").

**Conclusion [INFERENCE]:** the ordinary authentication path (login/refresh/logout/guard/session) has **zero**
dependency on membership existing, for any `User.kind`, today. Allowing a zero-membership identity would not touch
any of these files, and creates **no** new synchronous dependency on organization-service — the "no synchronous
cycle" guardrail [ADR-0041](../../adr/0041-administrative-capabilities-are-domain-owned-client-neutral-apis.md)
decision 7 states (client → organization-service → Auth → organization-service) and the source request both flag
is already structurally impossible to introduce here, because none of this code path reads organization data at all.

## 7. Flow entry model (restated from ADR-0043, not re-decided here)

**[PROPOSED DECISION, unchanged]** Nawara Flow is platform-wide at entry: a consumer authenticates and enters Flow
without naming an organization; an organization context is established later, per interaction, or for
administration (ADR-0043 decisions 4-6). This study does not revisit that decision; it examines what it requires
of Auth.

## 8. Flow user subscription model

**[PROPOSED DECISION, existing]** ADR-0038 already designates billing-service as owner of `user_subscription`, a
generic entitlement concept: *"billing-service owns... `user_subscription`... Entitlement changes only from events:
a `payment.succeeded` for an invoice line of an entitlement product activates or extends it... billing-service
exposes an entitlement-status API (`{ valid, expiresAt }`...)."* This is written generically — it is not
Flow-specific, and nothing about it requires the subscribing user to hold any `organization_membership`. A "Nawara
Flow subscription" is, architecturally, **one `user_subscription` row whose product is a Flow-billed product**,
scoped by `userId` alone.

**[VERIFIED — status]** `apps/billing-service` has **no** `user_subscription`, `organization_license`, or
entitlement table today, despite being otherwise well-built-out: 11 migrations exist
(`0001_currency` through `0011_payment_request_correlation_id`, covering currency, product/price, invoicing,
invoice numbering, payment requests, payment-event receipts, a billing-transition step, platform currency, product
producers, and payment-request correlation ids) — entitlement is simply not among them. ADR-0038 is design, not
implementation. This means **no new Core concept is required**
for a user-level Flow subscription — the decision already exists and is unbuilt, which is a build-order and
acceptance question, not an architecture gap.

**[INFERENCE]** For billing-service to issue a `user_subscription` for a user who has no `organization_membership`
anywhere, billing-service's caller-identity check (today: `service-or-user.guard.ts`, `identity.isActive` only)
already asks nothing more than "is this an active Nawara User" — consistent with §6's finding that this dimension
needs no organization context at all.

## 9. Organization Flow participation model

**[PROPOSED DECISION, existing + INFERENCE]** The same ADR-0038 boundary already carries `organization_license`
("one active per organization; `standard` or `grace`"). Combined with the verified fact that `Organization`
is single-parented to exactly one `Platform` (implemented in the schema; described by ADR-0031 and restated by
ADR-0043 decision 9, both `Proposed`), *"Organization X
participates in Flow"* reduces to: **an `Organization` row exists under the Flow `Platform`, and it holds an
active `organization_license` for a Flow product.** No new relationship, table, or service is implied. This
directly extends the finding already recorded in the [product entry context study §3](./stage-10-product-entry-context-study.md#3-what-platform-already-means-and-how-it-maps-to-products).

**[VERIFIED — status]** Also unbuilt today (same migrations check as §8). `apps/organization-service` itself has
**zero** concept of participation/license/entitlement/flow/subscription (grepped across its entire `src`; the only
hit is an unrelated string literal in a boundary test). This is correct and expected under ADR-0038 — participation
is a billing fact about an organization, not an organization-service fact, so organization-service should not
carry it, and the audit confirms it does not.

## 10. Membership vs. consumer relationship analysis

This is the central conceptual distinction the request asks for, and the evidence supports keeping it sharp:

```
User ←(0..N)→ OrganizationMembership → Organization      "is a member of"
User ←(0..1 per product)→ user_subscription (billing)      "has purchased/subscribed to a product"
Organization ←(0..1 per product)→ organization_license (billing)  "this org participates in a product"
User ↔ Organization, mediated by a Flow interaction         "is a customer/consumer of" — NOT modeled today, and does not need to be
```

**[INFERENCE]** A Flow consumer buying from, or browsing, Organization X does **not** need an
`organization_membership` row, and creating one would be semantically wrong: `organization_membership` means
"this person belongs to this organization's staff/student/teacher/admin roster," carries approval workflow
(`pending`/`active`/`rejected`/`revoked`), an `audience` label, and — critically — the org-admin capability grant
path (ADR-0028/ADR-0029). None of that describes "a consumer bought something from a licensed provider." Modeling
Flow consumption as membership would silently grant Flow consumers a seat in Driver/School's authority model
(`organizationAuthority`), which is exactly the "Scenario 9/10-style" leak the source request's security section
warns against.

**[OPEN DECISION]** Whether a Flow **interaction** (e.g., an order, a booking, a saved relationship with a
provider) needs to be recorded as a fact at all, and if so, where it lives, is a Flow product-domain question —
not a Core one, and not decided by this study. Core's job is only to make sure nothing forces that fact to be
`organization_membership`.

## 11. Flow administration analysis

**[VERIFIED, restated from ADR-0028/ADR-0042]** Organization-scoped administration already has a live-authorization
mechanism independent of the entry model: `organizationAuthority` (owner / operator / org_admin, evaluated per
request from the organization in the URL, never from a token) and service-token Platform scope. A Flow
administrator for Organization X would use exactly this mechanism — an **active, `active`-status**
`organization_membership` with the organization-management capability (or an Owner/Operator's existing authority) —
which is unaffected by whether *other*, ordinary Flow consumers have zero memberships.

**[INFERENCE]** This produces a clean split: a Flow **consumer** never needs `organization_membership`; a Flow
**administrator** for a specific organization does, exactly as Driver/School org-admins do today. "Flow
subscription = active" and "Flow administrator for Organization X" are answered by two different, independently
verifiable facts (a `user_subscription` row and an `organization_membership` row respectively) — never conflate
one into implying the other.

## 12. Driver/School implications

**[VERIFIED/INFERENCE]** Nothing here weakens Driver/School's existing model. `organizationAuthority` and
`memberBelongsTo` already re-derive authorization live, per request, per resource, from current
`organization_membership` rows — they do not, and would not, treat "the User is authenticated" as sufficient. A
zero-membership User attempting to reach a Driver/School organization-scoped route would hit exactly the same
"no active membership for this organization → 404" path a member with an unrelated organization's membership hits
today. Allowing zero-membership identities to exist does not by itself grant them anything; it only makes existing
resource-scoped checks return "no" instead of never being reachable.

## 13. Security scenarios

| # | Scenario | Verdict | Basis |
|---|---|---|---|
| 1 | Flow subscription active, 0 memberships — can enter Flow? | Yes, by design (§7-8) | ADR-0043, §8 |
| 2 | No Flow subscription — Flow user-level features? | No, gated by billing's entitlement-status API | ADR-0038 |
| 3 | Provider X not Flow-licensed, user has active subscription — org-specific Flow features for X? | No — subscription ≠ participation (§9-10) | Distinct facts, distinct owners |
| 4 | Provider X licensed, user has 0 memberships — org-specific *consumer* capabilities? | Whatever Flow's consumer-facing API defines, authorized by subscription + participation, **not** by membership | §10; not decided further — Flow product concern |
| 5 | Same as 4, but user *is* a member of X | Different fact, different (stronger) authority — e.g. staff-only views | `organizationAuthority`/`audience`, unaffected by this study |
| 6 | User is admin for X | Authorized via `organizationAuthority`, independent of Flow subscription entirely | §11 |
| 7 | 0 memberships, tries Driver | Refused: no active membership for the requested organization → collapsed 404 | §12, `memberBelongsTo` |
| 8 | 0 memberships, tries School | Same as 7 | §12 |
| 9 | Client supplies an arbitrary `organizationId` | Never trusted; every check re-derives from the DB (core-architecture.md §6: "never trusted without server-side verification") | Unchanged, [VERIFIED] |
| 10 | Client supplies an organization key | Resolves server-side to org/platform/audience only; never auto-grants membership or permission (ADR-0028) | Unchanged, [VERIFIED] |
| 11 | Flow subscription expires | Entitlement-status API (`{valid, expiresAt}`) reflects it on next check; Auth identity is untouched — "authentication is not entitlement" (ADR-0026) | [PROPOSED DECISION] ADR-0026 |
| 12 | Organization X drops Flow participation | Its `organization_license` lapses; consumers lose org-specific Flow access on next check; X's existence and any *other* product's organization row (e.g. under Driver) are unaffected (§9) | [INFERENCE] |
| 13 | X never participated in Flow | No `organization_license` for the Flow product exists for X's Flow-platform row (or no such row exists at all) → Flow cannot resolve X as a participant | §9 |
| 14 | User interacts with 10 Flow organizations | Zero `organization_membership` rows needed — participation is checked per-organization against billing's license facts, not against a membership table (§9-10) | [INFERENCE] |

## 14. Options A/B/C

### Option A — Zero-membership Users allowed for `kind=member`

Relax the `member` branch of `user_require_subtype()` (§3) so a member can commit with zero memberships, or make
`POST /auth/register`'s `joinCode` optional.

- **Security:** no loss — §3's table already shows the invariant is not a security boundary.
- **DB/registration:** smallest possible schema/code change (remove one `EXISTS` check; make one DTO field optional).
- **`/auth/me`, login, refresh, session:** no change needed at all (§5-6 already support this shape).
- **Cost:** `kind=member` would stop meaning "member of ≥1 organization" everywhere else it's assumed by that name
  — in comments (`users.service.ts:56-59`), in ADR-0030's own vocabulary ("one identity, many memberships"), and
  in any future reader's mental model. It **reuses** the audience-carrying, approval-workflow-carrying membership
  machinery for something (a Flow consumer) that is not that at all (§10). **[INFERENCE]** This is the cheapest
  option and the most semantically muddled one.

### Option B — Membership stays mandatory; Flow consumers get some other org-shaped fixture

Evaluated explicitly per the request, without recommending it:

- A synthetic/default "consumer organization" that every Flow user is auto-membered into: **rejected on inspection**
  — it would fabricate a fake `organization_membership` (with a fake `audience`, fake approval state, and,
  worse, exposure to `organizationAuthority`'s admin-grant path unless specially excluded everywhere), pollute
  billing and audit (every Flow consumer action would be attributable to "membership in Org 0"), and create a
  permanent migration/rename hazard if Flow later needs real per-organization consumer facts. This is exactly the
  outcome the source request's scope fence pre-emptively forbids, and the inspection confirms why.
- A "non-organization membership type": would require its own new schema and its own new trigger branch anyway —
  no simpler than Option C, and still overloads the word "membership" for something that is not organizational.
- **[INFERENCE]** Option B does not avoid a schema change; it just spends that change on a worse abstraction than
  Option C.

### Option C — A new `User.kind` value, following the existing subtype pattern (recommended direction, not decided)

**[INFERENCE]** The trigger already treats "every `User.kind` needs its own subtype-defining fact" as the norm —
`owner` needs an `owner` row, `operator` needs a `operator` row, `member` needs ≥1 `organization_membership` row.
A fourth kind (name TBD by the owner — e.g. `consumer`) with its **own** subtype table (or simply *no* required
subtype row at all, i.e. a fourth, empty branch in the same function) fits this existing pattern exactly:

- Does **not** touch the `member` branch, the membership trigger, or `organization_membership` in any way — zero
  risk to Driver/School's existing guarantees, zero change to ADR-0030.
- `POST /auth/register`'s `joinCode`-mandatory contract is **unchanged**; a new, separate entrypoint (e.g.
  `POST /auth/register/consumer` or similar — naming and route ownership is an owner decision, not this study's)
  creates the new kind, mirroring how `bootstrapOwner` is already a separate entrypoint from member registration.
- `/auth/me`, login, refresh, guard, session: **already work unmodified** for a new kind, by the same evidence as
  §5-6 (they already branch or are indifferent on `kind`).
- Keeps "member" meaning exactly what every existing ADR, comment, and test already assumes it means.
- Stays CLAUDE.md-generic: "a User who can exist and transact without belonging to any organization" is not a
  Nawara Flow concept — a delivery app or a booking app would want the identical shape. The new kind should be
  named and specified generically (Core never encodes "Flow" into Auth), consistent with how `member`/`owner`/`operator`
  are already product-agnostic.

**Cost:** genuinely the only option requiring an Auth migration; requires the owner to name and scope a new
identity subtype, which is more design work up front than Option A.

## 15. Compatibility analysis

- **[VERIFIED]** No consumer of `/auth/me` (billing-service, payment-service — the only two found calling it) reads
  anything from `memberships` that would break on an empty array; neither asserts non-emptiness.
- **[VERIFIED]** No consumer distinguishes `User.kind` values today beyond `isActive`/`id` — `service-or-user.guard.ts`
  in both services treats any active identity the same way. A new `kind` value would not require changes there
  unless a service later wants to special-case it.
- **[INFERENCE]** Existing Owners/Operators/Members are entirely unaffected by any of Options A/B/C — none of them
  touch existing rows, existing triggers for `owner`/`operator`, or the shape of `/auth/me` for those kinds.

## 16. Migration implications (if Option C, or A, is later chosen — not performed here)

- Existing Users, of every kind, are unaffected: the change is additive (a new branch/kind), not a relaxation of
  an existing one (for Option C) or a narrow, isolated relaxation of one existing branch (for Option A).
- No existing membership row is read, altered, or removed.
- No existing owner/operator row is affected — those branches of the trigger are untouched either way.
- Rollback: dropping a newly-added, unused trigger branch or DTO field is low-risk in either option, since no
  production data would yet depend on it at the point such a migration ships (Flow does not exist yet).
- **Not designed here.** No SQL, no DTO change, no migration file is produced by this study, per its scope fence.

## 17. Future Entitlement boundary

**[PROPOSED DECISION, existing]** ADR-0038 already states the boundary this study's request asks it to "record
what the future Entitlement architecture will need to distinguish":

| Concept | Owner (per ADR-0038) | Scope | Built today? |
|---|---|---|---|
| User Flow subscription | billing-service, `user_subscription` | `userId` only | No |
| Organization Flow participation | billing-service, `organization_license` | `organizationId` (Flow-platform-scoped) | No |
| "Is this Flow capability available" evaluation | Whichever service exposes the capability (Flow itself, outside Core) reads billing's entitlement-status API | Per-request | N/A — Flow is outside Core |
| Product-specific capability semantics (what a "consumer" vs "provider" vs "manager" can do inside Flow) | Flow product, not Core (CLAUDE.md; restated by ADR-0028/ADR-0030's "product roles stay product-owned") | — | N/A |

**Nothing here is a new decision.** The only genuinely open architectural question this study surfaces that is
**not** already answered by an existing (even if unbuilt) decision is §18 below.

## 18. Recommended architectural direction

> **2026-09-20 update:** item 3 below (a new, generic `User.kind`) is **superseded** by the
> [user identity, membership and context study](./user-identity-membership-context-study.md), which found the
> worker+consumer scenario (one User holding an organization role and an independent product-consumer role at the
> same time) makes any single-valued `User.kind` structurally unable to express the requirement — not just an
> inelegant fit. Items 1, 2, 4 and 5 below stand unchanged; that later study's Model E replaces item 3.

**[INFERENCE — recommendation, not a decision]**

1. Do not touch `organization_membership`, its trigger branch, or `POST /auth/register`'s `joinCode` requirement.
   Driver/School's guarantees, and everything ADR-0030 built, stay exactly as they are (rules out Option A).
2. Do not create a synthetic/default organization or a non-organizational "membership" (rules out Option B, for
   the reasons in §14 — this matches the source request's own scope fence, arrived at independently here from the
   evidence).
3. The narrowest, most consistent change — **if and when the owner decides Flow should actually be built** — is a
   new, generic `User.kind` value following the existing owner/operator/member subtype pattern (Option C), created
   through its own registration entrypoint, leaving every existing kind, route, and invariant untouched.
4. Separately, and not blocked on decision 3: **accept and schedule ADR-0038** (organization license + user
   subscription in billing-service). It already answers "who owns Flow subscription" and "who owns Flow
   participation" generically; nothing about Flow requires a new entitlement decision, only implementing the one
   that already exists.
5. Keep the three facts — authenticated, Flow-subscribed, organization-participating — and the fourth,
   per-organization relationship fact (§20 note below) — as four independently-checkable predicates, never
   collapsed into one boolean, consistent with how `organizationAuthority` already keeps identity, membership
   status, and capability flags separate today.

## 19. Owner decisions required

> **2026-09-20 update:** item 1 below is decided — see
> [the member-membership-invariant owner decision](./member-membership-invariant-owner-decision.md).
> **ACCEPTED:** `member → OrganizationMembership [0..N]`, i.e. *not* Option C (a new `User.kind`, already superseded
> by the identity/context study on structural grounds) and *not* Option A as this study defined it (keep `[1..N]`
> mandatory). Not implemented. Items 2-5 below remain open.

1. ~~Whether a new `User.kind` (Option C) is the direction to pursue at all, versus not building Flow's org-less
   entry model yet.~~ Decided above — no.
2. If so: its name, its registration entrypoint, and whether it needs any subtype table of its own or none.
3. Whether ADR-0038 should be accepted and scheduled now that a concrete consumer (Flow) motivates it, independent
   of decision 1.
4. Whether a Flow **consumer-to-organization interaction** (§10, e.g. an order or booking) needs to be recorded as
   a fact anywhere in Core, or is entirely a Flow product-domain concern outside this repository.
5. Naming/route ownership for a new registration path, if decision 1 is yes (this study deliberately does not
   propose a route name or owning module beyond "separate from `/auth/register`").

## 20. Explicit non-goals / what must not be changed yet

- No change to `POST /auth/register`, `/auth/me`, login, refresh, logout, sessions, or the request guard.
- No change to any Auth migration, trigger, or constraint.
- No relaxation of the `organization_membership` ≥1 invariant for `kind=member` **as an implementation act** — the
  *future direction* (relaxing it to `[0..N]`) is now owner-accepted (§19 update above), but nothing is migrated,
  triggered, or coded here or since.
- No synthetic, default, or "consumer" organization created anywhere.
- No second `User` entity or second membership system.
- No Entitlement Service, Flow subscription, Flow billing, or Flow organization-participation implementation.
- No change to organization-service, billing-service, or payment-service runtime.
- No change to ADR-0039, ADR-0040, ADR-0042, or Stage 10.1's production gates.
- ADR-0043 is not accepted, amended in substance, or superseded by this study (see §21).

## 21. ADR-0043 status

**[INFERENCE]** ADR-0043 remains correctly `Proposed`. This study does not surface any reason it cannot eventually
proceed toward acceptance — nothing found here contradicts its decisions (1-12). It still correctly defers the
exact question this study examines. A minimal cross-reference from ADR-0043's "Not decided here" section to this
study is added (see the diff), since this study is the examination ADR-0043 said would be needed; ADR-0043's own
text, status, and decisions are otherwise unchanged.

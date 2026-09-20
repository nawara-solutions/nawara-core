# Stage 10: Flow consumer and organization participation study

- **Status:** Study (no implementation, no runtime/schema/ADR-status change). Builds on four already-completed
  documents in this chain, most directly the accepted
  [member-membership-invariant owner decision](./member-membership-invariant-owner-decision.md) and the
  [identity/membership/context study](./user-identity-membership-context-study.md)'s Model E.
- **Date:** 2026-09-20

Tags: **[FACT]** (read directly from code/repo structure), **[DECISION — Proposed/Accepted]** (an ADR, status as
written, or the owner decision already recorded), **[INFERENCE]** (reasoning from facts), **[RECOMMENDATION]**
(this study's proposal, not accepted architecture), **[OPEN QUESTION]** (the owner must answer it).

## 1. Executive summary

The question this study was asked — what does Flow need to *represent* for a consumer who doesn't belong to the
organizations they interact with — has a prior, structural answer this study surfaces as its main finding: **most
of what "Flow consumer" needs does not belong in `nawara-core` at all.** CLAUDE.md's hard rule ("nothing here may
contain a concept that belongs to one product's business domain... would an unrelated future app find this useful
as-is?") already governs this exactly the way it governs Nawara Driver's students/instructors/exams — Flow is a
product, not a Core service, and this repository's only working precedent for a product with real domain complexity
(`nawara-drive`) confirms it in writing: its own `CLAUDE.md` states its "domain-specific services
(user/booking/exam/content)... stay here," in `nawara-drive`'s own repo, consuming `nawara-core`'s generic services
"only over HTTP/gRPC, never imported as code."

Applying that precedent: a `FlowConsumer`-shaped entity, if one is needed at all, is owned by Flow's own future
backend (a repository that does not yet exist, exactly as `nawara-drive` didn't exist before Nawara Drive was
built), referencing Auth's `userId` and organization-service's `organizationId` as **opaque identifiers** — never a
new table in this repo. What *does* belong in Core, and is already either decided or under an existing open
decision, is: the identity itself (Auth, already resolved by the accepted `[0..N]` membership decision), and the
entitlement facts (billing-service, ADR-0038, Proposed/unbuilt) that answer "does this user have Flow access" and
"does this organization participate in Flow." Everything else this study was asked to model — the consumer↔
organization relationship, browsing, favoriting, ordering, purchasing — is Flow product-domain state with no
uniform shape Core could usefully standardize (unlike organization membership, which *does* have a uniform shape
across products, which is why it correctly lives in Core).

## 2. Existing repository evidence

**[FACT]**:

- `Company 1 → N Platform 1 → N Organization`; `Platform` is Core's generic "product/app" concept
  (core-architecture.md §1). Nawara Driver, School, and Flow are each a `Platform` row.
- `nawara-drive/CLAUDE.md` ("Apps in this repo" / "Related repo — Nawara Core" sections, read this pass): three
  apps exist there today (`backend`, `desktop`, `mobile`); its README proposes further NestJS services
  (`user-service`, `booking-service`, `exam-service`, `content-service`) to live **in that repo**. Its own text:
  *"`nawara-core` is unrelated to this project's own domain-specific services (user/booking/exam/content) — those
  stay here."* and Core services are consumed *"only over HTTP/gRPC, never imported as code."*
- No `nawara-flow` repository exists yet (only `nawara-drive` and `daycare` are listed as consumers in this repo's
  own `CLAUDE.md`). Flow is design-stage only, same as Nawara Driver was before `nawara-drive` was created.
- **[DECISION — Accepted, this session]** `member → OrganizationMembership [0..N]` — the future direction is
  accepted; not implemented (member-membership-invariant owner decision).
- **[DECISION — Proposed, ADR-0043]** Flow is platform-wide at entry; organization context established later.
- **[DECISION — Proposed, unbuilt, ADR-0038]** billing-service owns `organization_license` (per organization, per
  product) and `user_subscription` (per user, per product) — the two entitlement facts this study needs and does
  not redesign.
- **[FACT]** core-architecture.md §1: *"Product services keep `userId`, `organizationId` and `platformId` as
  **opaque references**. They never create a second authentication identity."* This is the existing rule that
  answers most of this study's ownership question by itself.

## 3. Accepted architectural constraints

Restated, not reopened, per this task's own instruction — all from prior work in this chain:

- `User.kind ∈ {member, owner, operator}`; no `consumer` value, ever (identity/context study §12, structural: a
  single-valued `kind` cannot represent simultaneous organization-role + consumer-role).
- `member → OrganizationMembership [0..N]` (accepted direction; not implemented).
- Zero membership grants no organization authority; organization authorization is always a live, server-derived
  check (`organizationAuthority`/`memberBelongsTo`, unaffected by anything in this study).
- One universal User may simultaneously belong to, work for, and administer organizations, and use Flow as a
  consumer — no second identity, ever.
- Consumer relationships are not modeled as `OrganizationMembership` (identity/context study §10).
- Organization keys resolve context; they are never an authorization credential (ADR-0028).
- Client-supplied `organizationId`/role/permission/platformId/capability are never trusted (core-architecture.md §6).
- Auth owns identity, credentials, sessions, MFA, recovery, and `OrganizationMembership` — nothing else.
- ADR-0038 is not accepted or implemented by this study. Flow runtime is not implemented by this study.

## 4. Terminology

To keep the required distinction explicit throughout (per this task's "critical distinction"):

| Term | What it is | Owner |
|---|---|---|
| User identity | The universal, stable Auth identity | Auth |
| `OrganizationMembership` | "Belongs to this organization's roster" (staff/student/teacher/admin-shaped, approval workflow, `audience`) | Auth |
| Flow consumer access | "Is this user allowed to use Flow at all right now" | billing-service (`user_subscription`, ADR-0038) — a **fact**, not a Core entity |
| Flow subscription | The commercial/billing record backing consumer access | billing-service (ADR-0038) |
| Organization Flow participation | "Is this organization available to Flow consumers" | billing-service (`organization_license`, ADR-0038), scoped to an `Organization` row under the Flow `Platform` |
| Product/provider relationship | "This organization, as seen by Flow" (menu, services, availability) | Flow's own future backend — pure product domain |
| Order/purchase | A transaction between a consumer and a provider | Flow's own future backend (for the commercial interaction shape) + payment-service (for how money moved, per existing service boundaries) |

## 5. Required scenarios

Resolved under the recommended direction (§15), using only already-decided or already-designated-owner mechanisms:

| # | Scenario | Resolution |
|---|---|---|
| 1 | No organizations, Flow consumer | `member`, `OrganizationMembership=[]` (accepted §3), active `user_subscription` (billing, once built) → Flow's own backend grants consumer-level access. No Core entity needed beyond the identity + the subscription fact. |
| 2 | Belongs to A, consumes from B | Two unrelated facts: `OrganizationMembership(A)` (Auth) and a Flow-domain order/relationship with B (Flow's own backend). Neither implies the other. |
| 3 | Works for A, also consumes from A | Same as 2, just both facts happen to name the same organization — still two independent facts, no special-casing required or invented. |
| 4 | Multiple memberships + multiple consumer relationships | N `OrganizationMembership` rows (already supported, ADR-0030) + N Flow-domain order/relationship records (Flow's own backend) — no cardinality limit implied by Core on either side. |
| 5 | Flow consumer access suspended | A billing-owned fact (`user_subscription` inactive/expired) — Auth identity and any `OrganizationMembership` rows are untouched; this is exactly ADR-0026's "authentication is not entitlement" applied to Flow. |
| 6 | Organization participates, zero consumers yet | `organization_license` active, zero Flow-domain order/relationship rows referencing it — a normal empty state, nothing Core needs to represent specially. |
| 7 | Organization stops participating, historical interactions remain | `organization_license` lapses (billing); historical orders/relationships in Flow's own backend are untouched — **[OPEN QUESTION, Flow product decision]** whether Flow still *shows* historical interactions with a now-unavailable provider; not a Core concern either way, since Core holds none of that history. |
| 8 | No active Flow subscription | Same as scenario 5 — Flow-level access denied by billing's entitlement-status check; identity unaffected. |
| 9 | Flow access, zero `OrganizationMembership` | The now-accepted baseline case (§3) — this is scenario 1's identity shape restated. |
| 10 | Switching organization context vs. consumer context | Request-time only, never persisted (identity/context study §11, Model A/D) — unchanged, restated not redecided. |
| 11 | Multiple concurrent sessions/devices | Already structurally independent today (`refresh_token.familyId`, separate `device` rows) — unaffected by anything Flow-specific, since context is never session-state (§11 above). |
| 12 | Purchases from multiple organizations | Same as scenario 4 — N independent Flow-domain relationships, no Core cardinality constraint, no `OrganizationMembership` created by any of them. |

**[INFERENCE]** Every scenario resolves using facts already assigned an owner by existing (even if unbuilt)
decisions, plus product-domain state this study locates outside Core (§7). None requires a new Core entity, a new
`User.kind`, or a change to `OrganizationMembership`'s shape beyond the already-accepted cardinality decision.

## 6. Model comparison

| | A — Flow-owned `FlowConsumer` | B — generic `User` state | C — fully derived, no persistent identity | D — generic Core-level consumer entity | E — product-owned domain, Core supplies only opaque identity + entitlement facts |
|---|---|---|---|---|---|
| Ownership | Ambiguous as stated — see below | Auth (wrong owner) | No owner needed for the derived parts; real Flow-specific state still needs one | A new, speculative Core owner | Flow's own future backend (correct owner, by precedent) |
| Lifecycle | Ties consumer lifecycle to whichever service holds the table | Tangled with Auth's identity lifecycle — exactly what ADR-0030 already moved *away* from for membership | Clean — no lifecycle to manage for facts that are just queries over subscription/order data | Speculative — no real second consumer of it exists yet | Clean — Flow's own domain, Flow's own lifecycle rules |
| Authorization | Would require Core to expose a Flow-specific authorization primitive it has no business owning | Violates "operation authorization belongs to the service that owns the operation" (core-architecture.md §6) | Fine — authorization reads billing's entitlement fact live, same shape as every other live check in this repo | Same problem as A, worse (generic = vaguer) | Fine — same as C, but any Flow-specific state (preferences, saved carts) lives with Flow, not derived |
| Persistence | If placed in Core: violates CLAUDE.md's genericity rule outright | N/A (no persistence — it's a `User` field) | Minimal — nothing persisted beyond what billing/Flow already need to persist for their own reasons | Speculative persistence for a shape with no second consumer to validate it against | Persisted only where Flow's own domain needs it (orders, favorites, etc.) |
| Subscription handling | Would duplicate or shadow billing's `user_subscription` | N/A | Correct — reads billing directly, no shadow copy | Would also duplicate billing | Correct — same as C |
| Organization interaction | Would need to model browse/favorite/order — Flow business logic, wrong repo | N/A | N/A (out of scope for a "derived-only" model — real interaction data still needs a home) | Same problem, worse (Core, not even Flow's repo) | Correctly scoped to Flow's own backend |
| Historical data | Same ownership problem as above | N/A | Weak — "fully derived, no persistence" cannot represent history (an order that happened, a relationship that used to exist) once the live subscription/participation fact changes | Same problem as A | Flow's own backend keeps its own history; nothing Core needs to retain |
| Multi-session | Unaffected either way (context is request-time regardless of model, §5 scenario 11) | Unaffected | Unaffected | Unaffected | Unaffected |
| Revocation | Access revocation is a billing fact (subscription lapses) regardless of where the "consumer" entity lives — models A/D don't actually solve revocation better than C/E | N/A | Naturally correct — revocation is just the entitlement fact changing, nothing to un-persist | Same as A | Same as C |
| Client neutrality | Neutral in principle, but if hosted in Core it invites the exact "who calls this API" ambiguity ADR-0041 was written to prevent for administration | Neutral | Neutral | Neutral | Neutral |
| Cross-service dependencies | If in Core: Core would depend on knowing Flow's business shape — backwards dependency, contradicts "Core never interprets what a platform is" | None | Minimal (reads billing) | Same problem as A | Correct direction — Flow depends on Core, never the reverse |
| Migration complexity | High if ever corrected later (moving a live product's data out of Core into its own service is exactly the costly direction migrations should avoid) | Low now, high later (repeats the exact mistake ADR-0030 already fixed for membership/`audience`) | Low | Same as A | Low — nothing to migrate later, because it was never in the wrong place |
| Risk of premature generic infrastructure | **High**, if placed in Core | High (repeats a fixed mistake) | Low | **Highest** — an entity with no second real consumer to validate its shape against, the textbook premature-genericization case | Low — no infrastructure is added to Core at all |

**[INFERENCE]** Models A and D both fail the same test CLAUDE.md already applies to Driver-specific concepts:
neither is "useful as-is" to an unrelated future app in the *concrete* shape this study was asked to design (order
history, favorites, browsing) — those are genuinely Flow-shaped, not generically product-shaped, unlike
`OrganizationMembership`, which *is* uniform enough across products to justify living in Core (every platform needs
"who belongs here," with the same approval-workflow shape; not every platform needs "orders," and the ones that do
need wildly different order shapes). Model B is already excluded by §3's accepted constraints. **Model E — the
product-owned direction, informed by C's "derive what you can, persist only what you must" discipline — is the one
this study's evidence supports.**

## 7. Flow consumer ownership

**[RECOMMENDATION]** Split cleanly along the boundary this repository already uses for every other product:

```
Auth (this repo)          → User identity, OrganizationMembership. Unchanged.
billing-service (this repo, ADR-0038, unbuilt) → user_subscription (Flow access), organization_license
                                                    (Flow participation). Owner already designated, not built.
Flow's own future backend (a repo that does not exist yet, like nawara-drive before it was built)
                           → everything else this study asked about: the "FlowConsumer" shape if one is needed
                             at all, browse/favorite/follow/cart/order/purchase/booking, provider-facing views,
                             and any Flow-specific consumer state — referencing userId/organizationId as opaque
                             identifiers only, consistent with nawara-drive's own stated intention for its
                             (not-yet-built) booking-service/exam-service.
```

**[OPEN QUESTION]** Whether a `FlowConsumer`-shaped row is needed at all, or whether Flow's own domain can get by
with Model C's "derive from subscription + orders" approach, is a Flow product-design decision for Flow's own
(future) repository — not decided here, and not this repository's decision to make.

## 8. Organization participation

**[DECISION — Proposed, restated not redecided]** Already resolved by the product-entry-context study and the
Auth/Flow-subscription study: participation is *"an `Organization` row exists under the Flow `Platform`, and it
holds an active `organization_license` for a Flow product"* (billing-service, ADR-0038). No Flow-specific
participation table, no Entitlement Service, and no change to organization-service (which correctly has **zero**
concept of participation/license today — verified in the Auth/Flow-subscription study — and should stay that way;
participation is a commercial fact, not a hierarchy fact). An arbitrary organization-service organization does
**not** become visible to Flow merely by existing — visibility requires the billing-owned license fact, which
Flow's own backend would query (once ADR-0038 is built), never derive from organization-service alone.

## 9. Consumer ↔ organization relationship

**[RECOMMENDATION]** Not persistent, not generic, not Core's. Per §6/§7: browse/favorite/follow/cart/order/purchase/booking
are exactly the domain interactions this task itself suggests as the alternative to "a persistent relationship" —
and the evidence supports that alternative. **A persistent `FlowConsumer ↔ Organization` relationship is not needed
as a Core concept**; if Flow's own backend wants one (e.g., a "favorited providers" list), that is entirely its own
schema, its own migration, its own lifecycle — outside this repository, exactly as `nawara-drive`'s own booking
records are outside this repository. Buying from Organization B must not, and under this recommendation does not,
create `OrganizationMembership(User, B)` — nothing in Core proposes or implies that, and no code path today creates
membership from anything other than the join-code registration/join flow (ADR-0028).

## 10. Subscription/access relationship

**[DECISION — Proposed, restated]** `user_subscription` (billing, ADR-0038) is the single fact answering "may this
user use Flow at all." It is evaluated independently of `OrganizationMembership` (identity/context study §8) and
independently of any specific organization — a user's Flow access is one fact, not one fact per organization they
might interact with. Per-organization availability is the separate `organization_license` fact (§8). Neither is
built yet; this study does not build them, only confirms the boundary already assigned to them is correct and
sufficient for everything this study was asked to model.

## 11. Context model

**[DECISION — established, restated]** Unchanged from the identity/context study §11: request-time only, never
persisted in the `User` row, a session, or a token. A request names its target (an organization, or none for a
pure consumer-level operation); the server re-derives every relevant fact live every time. Nothing about Flow's
consumer/organization interactions changes this — if anything, it is the clearest possible case *for* this model,
since a consumer browsing ten organizations in one session is exactly the "many independent contexts, one
identity, nothing persisted" shape that model was built for.

## 12. Registration architecture

**[DECISION — established, restated]** A dedicated Flow consumer registration entrypoint, separate from
`/auth/register`, is preferable to a product-conditional `/auth/register` — already the direction implied by the
accepted `[0..N]` decision (member-membership-invariant owner decision §6) and consistent with how `bootstrapOwner`
and `OperatorAdminService.create()` are already separate from member registration. **Not implemented here or
anywhere yet** — no route, module, or request shape is designed by this study.

## 13. Security analysis

**[FACT/INFERENCE]**, each item checked against what already exists or is recommended, not newly invented:

| Concern | Analysis |
|---|---|
| Organization key theft/sharing | Unchanged risk profile from ADR-0028 — a key resolves context, is rate-limited, and is never a bearer authorization credential; nothing about Flow changes this. |
| Forged organization/consumer context | Impossible under the request-time model (§11) — there is no persisted context to forge; every check re-derives live. |
| Consumer impersonation | Prevented the same way every other impersonation risk is prevented today: bearer-token authentication via Auth, verified live per request (`auth.guard.ts`) — Flow adds no new identity mechanism. |
| Stale session context | Not applicable — no context is session-state to go stale (§11). |
| Organization deactivation | An organization-service/billing fact; Flow's own backend must re-check participation live on each relevant request, the same discipline Auth already applies to membership — this is a requirement *on Flow's future design*, not something Core enforces for it. |
| Flow participation revocation | Same as organization deactivation — a billing (`organization_license`) fact, re-checked live, not cached. |
| Consumer suspension | A billing (`user_subscription`) fact, re-checked live — mirrors exactly how a revoked `organization_membership` is re-checked live today (ADR-0030), not a new pattern. |
| Concurrent sessions | Already structurally independent (§5 scenario 11); nothing Flow-specific changes this. |
| Cross-organization access | Unaffected — `organizationAuthority`/`memberBelongsTo` remain the only source of organization-scoped authority, and neither is touched by Flow consumer access. |
| Client-side authority claims | Unchanged core-architecture.md §6 rule: no client-supplied organization/role/permission/capability is ever trusted; this extends, by the same principle, to any client-supplied "Flow consumer" or "subscription active" claim — always a server-derived fact. |

**Organization keys must not become bearer authorization** — confirmed unchanged; nothing in this study proposes
or implies otherwise.

## 14. Client neutrality

**[DECISION — Proposed, ADR-0041, restated]** Unaffected: no client type, technology, or install
identifier gates any Flow-related authorization fact under this study's recommendation, exactly as ADR-0041 already
requires for administration and as the identity/context study already extended to entry context generally. Mobile,
web, and Tauri clients of a future Flow product would all call the same Flow backend API, which would call the same
Core APIs (Auth's `/auth/me`, billing's entitlement-status endpoint once built) — no client-specific business rule
anywhere in this chain.

## 15. Recommended direction

**[RECOMMENDATION]**

1. Core (this repository) adds **nothing** for Flow consumer/organization-participation modeling beyond what is
   already designated: Auth's identity + `OrganizationMembership[0..N]` (accepted), and billing-service's
   `user_subscription`/`organization_license` (ADR-0038, still to be accepted/built).
2. A `FlowConsumer`-shaped entity, if Flow's product design needs one at all, belongs in Flow's own future backend
   repository — not `nawara-core` — referencing `userId`/`organizationId` as opaque identifiers, following the same
   convention `nawara-drive`'s own CLAUDE.md states for its (not-yet-built) domain services.
3. The consumer↔organization relationship (browse/favorite/order/purchase/etc.) is Flow product domain state with
   no uniform cross-product shape; it is not modeled here and should not be modeled in Core later either, absent
   concrete evidence of a second, differently-shaped product needing the identical relationship (the bar
   `OrganizationMembership` already cleared and this has not).
4. This confirms and narrows, rather than reopens, every constraint in §3.

## 16. Open decisions

1. Whether a `FlowConsumer`-shaped entity is needed at all in Flow's own future backend, or whether Model C's
   fully-derived approach suffices there — a Flow product-design decision, not this repository's.
2. Whether historical Flow interactions with an organization that later stops participating remain visible to the
   consumer (§5 scenario 7) — a Flow product-design decision.
3. Whether/when ADR-0038 is accepted and scheduled (recurring across every study in this chain; still open).
4. Whether/when a `nawara-flow` repository is created at all, and by extension whether Flow is built (not
   authorized or assumed by this study).

## 17. ADR impact

| ADR | Classification |
|---|---|
| ADR-0020, ADR-0028, ADR-0030, ADR-0031 | UNCHANGED — organization/membership model confirmed, not touched. |
| ADR-0038 | UNCHANGED — not accepted, not implemented, its designated ownership boundary confirmed sufficient for everything this study needed. |
| ADR-0040, ADR-0041, ADR-0042 | UNCHANGED — no interaction found beyond restating ADR-0041's (still `Proposed`) client-neutrality rule. |
| ADR-0043 | UNCHANGED — this study is consistent with, and does not amend, its entry-context decisions. |

**No new ADR is proposed.** This study's main finding (most of "Flow consumer" belongs outside this repository) is
a scope clarification using CLAUDE.md's existing, already-written rule, not a new architectural decision requiring
its own ADR.

## 18. Explicit non-goals

Not done by this study, consistent with its instructions: no runtime code, migration, or schema change; no
`consumer` added to `User.kind`; no change to the `OrganizationMembership` trigger; no Flow tables or APIs created;
no registration, subscription, or organization-licensing implementation; no Entitlement Service; ADR-0038 not
accepted; Billing/Payment/Auth/Organization Service behavior unchanged; no deployment/Compose change; nothing
committed.

---

## Validation

| Command | Result |
|---|---|
| `npm run check:repo` | PASS |
| `npm run test:repo` | PASS (15/15) |
| `git diff --check` | PASS |
| `git status --short` | 3 modified (`docs/adr/README.md`, `docs/architecture/README.md`, `docs/architecture/core-architecture.md`), 6 untracked (this file, ADR-0043, and four prior stage-10 studies) — all documentation, all from this session's chain |
| `git diff --stat` | 3 files changed, 9 insertions(+) — tracked-file edits only |

**Confirmed:** only files under `docs/` changed. No file under `apps/`, `libs/`, `packages/`, `infra/`, `compose/`,
or any migrations directory was touched.

```
STAGE 10 FLOW CONSUMER / ORGANIZATION PARTICIPATION STUDY COMPLETE
```

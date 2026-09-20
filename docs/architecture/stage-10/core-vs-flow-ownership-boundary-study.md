# Stage 10: Core vs. Flow ownership boundary study

- **Status:** Study (no implementation, no runtime/schema/ADR-status change). Systematically re-derives, and
  narrows, the [Flow consumer/organization-participation study](./flow-consumer-and-organization-participation-study.md)'s
  central finding using a concept-by-concept genericity test, rather than assuming it.
- **Date:** 2026-09-20

Tags: **[FACT]** (read directly from code/repo), **[DECISION — Accepted/Proposed]** (an ADR or the recorded owner
decision, status as written), **[INFERENCE]** (reasoning from facts), **[RECOMMENDATION]** (this study's proposal),
**[OPEN QUESTION]** (the owner must answer it), **[HYPOTHETICAL]** (Flow does not exist; stated for completeness,
not as a claim about anything built).

## 1. Executive summary

Applying one test — *"could an unrelated Nawara product use this capability meaningfully, without Flow-specific
semantics?"* — to every concept this task asked about produces a clean, three-tier answer, not a binary
Core/Flow split:

1. **Genuinely Core** (clears the genericity test today, already has an owner): `User`, `OrganizationMembership`,
   `organization_license`/`user_subscription` (billing, ADR-0038, unbuilt), the Organization/Platform/Company
   hierarchy, and the existing organization-admin authority mechanism (`organizationAuthority`, reused, not
   duplicated, by Flow administration).
2. **Genuinely Flow** (fails the test — no cross-product reuse case exists, or the concept requires Flow-specific
   business rules Core has no basis to encode): consumer profile/preferences/addresses, catalog, products (in
   Flow's sense — see §5's naming-collision warning), favorites, cart, orders, bookings, delivery, reviews, and the
   consumer↔organization relationship itself.
3. **A composite, not a single fact** (the study's one genuinely new finding, beyond restating the prior study):
   "organization participates in Flow" is not one fact with one owner. It decomposes into at least three layers —
   *exists* (organization-service), *has an active commercial license* (billing, ADR-0038), and *is operationally
   discoverable/enabled* (Flow's own configuration state, which no Core service can compute) — and the task's
   suggested fourth layer, "entitled to capability Y," **does not currently exist as a separate owned fact**:
   ADR-0038's entitlement-status API (`{valid, expiresAt}`) already *is* the computed answer from the commercial
   license, not a distinct concept with a different owner. Inventing a fourth layer now would be speculative, not
   evidence-based.

Nothing here is implemented. No repository file outside `docs/` is touched.

## 2. Existing architectural constraints

Restated, not reopened — every item below is either an already-`Accepted` decision or an unmodified `Proposed` ADR,
verified this pass:

- **[DECISION — Accepted]** `User.kind ∈ {member, owner, operator}`; no `consumer` value, ever (identity/context
  study, structural argument: a single-valued `kind` cannot represent simultaneous organization-role +
  consumer-role).
- **[DECISION — Accepted, this session]** `member → OrganizationMembership [0..N]` (member-membership-invariant
  owner decision). Zero memberships grant zero organization authority; authorization stays live and server-derived.
- **[DECISION — Proposed, ADR-0028]** Organization keys resolve context only — never authentication, authorization,
  role, permission, or a service credential.
- **[FACT]** Ownership today: Auth (`User`, credentials, sessions, MFA/recovery, `OrganizationMembership`);
  organization-service (Company/Platform/Organization, **implemented but not authoritative** — auth-service's
  tables remain the live source until the ADR-0039/0040 cutover, which has not occurred); billing-service (financial/commercial
  ownership per ADR-0035/0038, largely **unbuilt** for entitlement specifically — see §3); payment-service (money
  movement). None of these boundaries move in this study.

## 3. Repository evidence

**[FACT]**, verified this pass, consolidating and re-checking prior passes' findings:

- `apps/billing-service/db/migrations/` has 11 migrations (currency, product/price, invoice, invoice line, invoice
  numbering, payment request, payment-event receipt, billing-transition, platform currency, product producer,
  payment-request correlation id) — **no** `organization_license` or `user_subscription` table. An explicit
  tripwire test (`apps/billing-service/test/migrations.e2e-spec.ts`) asserts these two table names are **not**
  present, in a dedicated test block separate from the file's `STAGE_2_TABLES` positive-list check — confirming
  their absence is deliberate/tracked, not an oversight.
- `apps/organization-service/src` has **zero** concept of participation/license/entitlement/Flow/subscription — the
  only hit for any of those terms anywhere in its `src` tree is an unrelated regex literal in a boundary test
  (`boundary.spec.ts`) that explicitly *guards against* the service ever referencing a `license`-shaped
  table/column. This is itself evidence the current architecture already treats "participation" as **not**
  organization-service's concern.
- `Organization.platformId` is a single, immutable FK (`apps/organization-service/README.md`) — an organization
  existing under one `Platform` (e.g., Driver) does not make it exist under another (e.g., Flow); a real-world
  organization participating in both needs two separate `Organization` rows.
- **[FACT]** `nawara-drive/CLAUDE.md` ("Apps in this repo" / "Related repo — Nawara Core"): domain-specific services
  (its README's proposed `user-service`, `booking-service`, `exam-service`, `content-service`) are stated to belong
  in that repo, consumed by nothing in `nawara-core`; Core services are consumed by it "only over HTTP/gRPC, never
  imported as code." **[FACT, corrected from the prior study's overclaim]** none of those services are built yet
  (`nawara-drive/apps/` today has only `backend`, `desktop`, `mobile`) — this is nawara-drive's stated convention
  for its own future services, not a working example to point to, but the written rule is real regardless of
  whether it has been exercised yet.
- No `nawara-flow` repository exists. Every "Flow" reference in this repository is documentation only.
- ADR statuses (verified against each ADR's own `Status:` line, not assumed): ADR-0028, 0030, 0031, 0038, 0041,
  0043 are **`Proposed`**. ADR-0040 and ADR-0042 are **`Accepted`**. This confirms the validation checklist's
  expectations exactly (§ Validation below).

## 4. Genericity rule

Applied literally, per this task's instruction, to every concept in §5 — not asserted, shown:

> **Test:** could an unrelated Nawara product (a delivery app, a booking app, a different vertical entirely) use
> this capability meaningfully and substantially, without Flow-specific semantics, **today, with the shape it
> would already have to take for Flow**?

`OrganizationMembership` passes trivially — it already serves Driver and School with the identical shape (approval
workflow, opaque `audience`, live authorization) that Flow would need for its own org-admin surface. `user_subscription`/`organization_license`
(ADR-0038) pass because they were **designed generically from the start**, before Flow was conceived — the
Auth/Flow-subscription study already found this. Everything in §5's "Genuinely Flow" column fails because its
*shape* is inescapably Flow-specific: an "order" that works for a delivery product and a "booking" that works for a
driving-school product are not the same shape reused, they are two different domain models that happen to share a
word.

## 5. Concept-by-concept ownership matrix

| Concept | Owner | Status | Genericity test result |
|---|---|---|---|
| `User` | Auth | Implemented | N/A — already the universal identity, not evaluated against Flow specifically |
| `OrganizationMembership` | Auth | Implemented (`[0..N]` accepted) | **Passes** — identical shape already serves 2 products |
| Flow consumer identity | *Not a separate entity* | — | Fails as a distinct concept — it is just Auth's `User`, referenced opaquely by Flow (§6) |
| Flow consumer profile | Flow | Not built | Fails — preferences/UI state has no cross-product uniform shape |
| Flow subscription | Billing (`user_subscription`) | ADR-0038, Proposed, unbuilt | **Passes** — designed generically, pre-dates Flow |
| Organization Flow participation | *Composite, no single owner* | — | Decomposes; see §7 |
| Organization Flow license | Billing (`organization_license`) | ADR-0038, Proposed, unbuilt | **Passes** — same reasoning as Flow subscription |
| Provider | *Not a separate entity* | — | It is `Organization`, viewed from Flow; Flow adds its own provider-facing data separately |
| Product (Flow sense) | Flow | Not built | Fails, **and** name-collides with billing-service's own `product` table (a billable line item, e.g. a subscription plan) — these must never be conflated; Flow's catalog item and billing's `product` are different concepts that happen to share a word, exactly like "order"/"booking" above |
| Catalog | Flow | Not built | Fails — Flow-specific business data |
| Favorite | Flow | Not built | Fails — no cross-product reuse case |
| Cart | Flow | Not built | Fails |
| Order | Flow (interaction shape) + Payment (money movement, existing mechanism) | Not built | The commercial-record shape fails (Flow-specific); the *payment* of it reuses payment-service exactly as any product would (core-architecture.md's existing "product services → billing/payment" pattern) |
| Purchase | Same split as Order | Not built | Same reasoning |
| Booking | Flow | Not built | Fails — directly analogous to Nawara Drive's own booking concept, already excluded from Core by the same rule |
| Consumer ↔ organization relationship | Flow | Not built | Fails the task's own bar ("strong evidence... genuinely reusable across multiple unrelated products") — no such evidence found; explicitly **not** `OrganizationMembership` |
| Consumer preferences | Flow | Not built | Fails |
| Consumer addresses | Flow | Not built | **[OPEN QUESTION]** — a generic "address book" is the one item in this matrix that *might* clear the bar for a future product (a booking app plausibly reuses "an address belonging to a user"), but no second product needs it today; genericizing now would be exactly the "reuse alone" mistake this task instructs against |
| Delivery relationship | Flow | Not built | Fails — squarely Flow/delivery business logic |
| Flow permissions | Flow (consumer-side) | Not built | Fails — opaque to Core, same principle as the existing `audience` label |
| Flow roles | Flow (consumer-side); reuses Core (org-admin side) | — | Consumer-side roles fail the test; an org's "who administers our Flow presence" role is the **same** shape as Driver/School's org-admin, so it reuses `isOrganizationAdmin`/`organizationAuthority` rather than needing a new concept |
| Flow admin capabilities | Reuses Auth's existing `organizationAuthority`/org-admin mechanism | Implemented (generically) | **Passes** — not because a new Core concept was created, but because an existing one already fits without modification |

## 6. Flow consumer model comparison

Re-run against the task's own five models (A-E), not merely citing the prior study's conclusion:

| | A — Core `FlowConsumer` | B — Flow-owned consumer relationship | C — fully derived, no persistent entity | D — hybrid (generic Core primitive + Flow owns semantics) | E — (repository-justified alternative) |
|---|---|---|---|---|---|
| Ownership | Core (wrong — fails §4's test) | Flow | No entity to own | Core owns a *primitive*, Flow owns *meaning* | Not needed — §6 conclusion below |
| Genericity | Fails outright | N/A (not claiming to be generic) | N/A | The "primitive" would need to be generic enough to justify existing — nothing proposed clears that bar (unlike `OrganizationMembership`, which already did) | — |
| Reuse by other products | None demonstrated | N/A | N/A | Speculative — no second product wants this shape today | — |
| Authorization | Would require Core to expose a Flow-specific authorization primitive it has no business owning (violates core-architecture.md §6, "operation authorization belongs to the service that owns the operation") | Correct — Flow authorizes its own operations, reading Core's identity/entitlement facts | Correct, same as B | The primitive itself needs authorization rules Core can't write generically | — |
| Lifecycle | Tied to Core's release/migration cadence for a product that isn't Core's | Flow's own | N/A | Split lifecycle — the exact anti-pattern ADR-0030 already moved away from for membership/`audience` | — |
| Subscription | Would duplicate or shadow billing's `user_subscription` | Correctly reads it, doesn't own it | Correctly reads it | Same duplication risk as A, milder | — |
| Revocation | No better than C/E at this — revocation is a billing fact regardless of where a "consumer" row lives | Correct — Flow re-checks the billing fact live | Correct, trivially (nothing to un-persist) | No advantage over B/C | — |
| Historical data | Same ownership problem as A | Flow's own history, Flow's own retention rules | Weak on its own — "fully derived" can't retain history once the live fact changes (an order that happened must be recorded *somewhere*) | Doesn't solve this either — history is still Flow-shaped, not primitive-shaped | — |
| Cross-service dependencies | Backwards — Core would depend on knowing Flow's business shape | Correct direction (Flow depends on Core) | Correct direction | Correct direction for the primitive, but the primitive is unjustified (see genericity) | — |
| Failure modes | A Flow-specific bug could require a Core deploy | Isolated to Flow's own deploy | Isolated | Partially isolated — a "primitive" would still need Core coordination for changes | — |
| Migration | High cost if later corrected (moving product data out of Core is the outcome ADR-0030 already avoided repeating) | Low — nothing to migrate later | Low | Medium — a wrongly-shaped primitive is itself a future migration | — |
| Operational complexity | Adds Flow-shaped operational load to Core's on-call/release surface | None added to Core | None added to Core | Some added to Core, for a primitive that may never see a second user | — |
| Risk of Core becoming product-specific | **High** | None | None | **Moderate** — the exact "generic just in case" trap this task warns against | — |

**[INFERENCE]** Model E resolves to: **there is no fifth model** — the evidence converges on Model B/C combined
(Flow owns all consumer domain state; what little needs deriving is derived live from billing's already-generic
`user_subscription` fact), which is exactly what the prior study called Model E under different numbering. This
study's contribution is showing Model D (the "obvious middle ground") fails on inspection too: no concrete
candidate "generic reusable primitive" survives the genericity test once actually named (§5 already tried — the
closest candidate, consumer addresses, is flagged open, not adopted).

## 7. Organization participation model

**[INFERENCE, this study's central new finding]** The task's suggested five-way split (exists / participates /
commercial license / discoverable / operationally enabled) maps onto **evidence-backed layers as follows** — not
five independent facts, but three real ones plus one the task suggests that does not currently exist:

| Layer | Owner | Status |
|---|---|---|
| Organization **exists** | organization-service (`Organization` row, single-parented to a `Platform`) | Implemented, not yet authoritative (ADR-0039/0040 cutover pending) |
| Organization **has an active commercial license for Flow** | billing-service (`organization_license`, scoped to the `Organization` row under the Flow `Platform`) | ADR-0038, Proposed, unbuilt |
| Organization **is entitled** (i.e., the license is currently valid) | **Same billing fact as above** — ADR-0038's entitlement-status API (`{valid, expiresAt}`) *computes* this from the license record; it is not a separately-owned concept. **[INFERENCE]** the task's illustrative "Billing vs. Entitlement" split is a useful conceptual distinction but does **not** correspond to two different owners in this repository's actual, even if unbuilt, design — inventing a second owner for it now would not be evidence-based. | Same as above |
| Organization **is discoverable/operationally enabled in Flow** | Flow's own domain | **[HYPOTHETICAL]** — no Core service can compute this: it requires Flow-specific state (has the provider finished onboarding? do they have a non-empty catalog? have they self-toggled "open"? did Flow's own moderation clear them?) that has no cross-product uniform shape and is not derivable from anything organization-service or billing-service holds. Flow would **gate** this on the billing entitlement fact (can't be discoverable without an active license) but the discoverability/operational state itself is Flow's record. |

**[RECOMMENDATION]** Do not create a fourth Core-level "entitlement" owner distinct from billing's existing
`organization_license`/entitlement-status mechanism unless a concrete, evidence-backed need for capability-grained
entitlement (e.g., "licensed for feature Y but not Z") emerges later — nothing in this repository today shows that
need.

## 8. Billing / Entitlement / Flow boundary

**[INFERENCE]**, direct consequence of §7:

```
Billing (this repo, ADR-0038, unbuilt)
  → "Is there an active commercial license/subscription?" — one binary-ish fact (valid/expired),
    computed from organization_license / user_subscription. This already IS what "Entitlement" means
    in this repository's current design; no separate Entitlement owner exists or is proposed.

Flow (future repo, does not exist)
  → "Given that commercial fact, is this organization operationally available to consumers right now?"
    A strictly Flow-owned, Flow-configured state. Billing has no basis to compute this — it doesn't
    know what "operationally available" means for Flow specifically, any more than it would for a
    hypothetical delivery app's "restaurant is currently open" toggle.
```

No API or schema is invented here — this only assigns ownership to concepts, consistent with this task's
instruction not to invent APIs.

## 9. Consumer ↔ organization relationship analysis

**[RECOMMENDATION, restated and re-justified]** No generic `ConsumerOrganizationMembership` is warranted. The
task's own bar — "strong evidence... genuinely reusable across multiple unrelated products" — is not met by
browse/search/favorite/follow/view/cart/order/purchase/booking/delivery/review: no second product in this
repository's evidence base (only `nawara-drive` exists as a real precedent) needs an identical shape for any of
these. `OrganizationMembership` cleared this bar because "who belongs to this organization's roster, with an
approval workflow" is *already* proven reusable (Driver and School use the identical shape today); nothing on this
list has an equivalent existing second user. A purchase must never become an `OrganizationMembership` — nothing in
this repository's code creates membership from anything other than the join-code registration/join flow
(ADR-0028), and this study does not propose changing that.

## 10. Worker + consumer scenarios

**[FACT/INFERENCE]** Re-verified, no new Core capability required for any of the three shapes the task lists:

```
User, OrganizationMembership→A (delivery capability), Flow consumer behavior interacting with B
  → two independent facts: an Auth membership row, and Flow-domain records referencing A's and B's
    organizationId opaquely. No Core change needed — this already works today, structurally, because
    membership and Flow-domain state were never coupled to begin with.

User, OrganizationMembership→[A, B], Flow consumer behavior
  → same as above, with N membership rows (already supported, ADR-0030) instead of one.

User, zero memberships, Flow consumer behavior only
  → possible only because of the accepted [0..N] decision (§2); before that decision, this User could
    not exist as kind=member at all. This is the one scenario that DID require a Core decision — already
    made, not reopened here.
```

## 11. Context analysis

**[DECISION — established, restated]** Context is **request metadata, not a domain concept**, and needs no Core
representation beyond what already exists: a request names its target (an organization, or none), the server
re-derives every relevant fact live, nothing is persisted in the `User` row, a session, or a token
(identity/context study §11, Model A/D). This conclusion is unchanged by this study; Flow's consumer/organization
interactions are, if anything, the clearest case for it (§10's scenarios all resolve without any session- or
token-level context).

## 12. Registration implications

**[INFERENCE]** The task's hypothesis —

```
Flow client → Flow registration → Auth User(kind=member) → zero OrganizationMembership allowed
  → Flow-specific consumer state
```

— is **confirmed, not rejected**, as consistent with every accepted decision in this chain: `kind=member` with zero
memberships is now a valid identity shape (§2); a dedicated Flow registration entrypoint, separate from
`/auth/register`, was already the recommended direction (member-membership-invariant owner decision §6); and
"Flow-specific consumer state" living outside Core is this study's own §5-§9 conclusion. **No endpoint is designed
or implemented by confirming this hypothesis** — confirming the *shape* is not the same as building the *thing*.

## 13. Security model

**[FACT/INFERENCE]**, each item assigned to whichever service is actually authoritative for it today or by
already-accepted design:

| Concern | Authoritative service | Basis |
|---|---|---|
| Forged organization context | N/A — impossible under the request-time model (§11); nothing persists to forge | Auth (mechanism), unaffected by Flow |
| Forged consumer context | Same — no persisted consumer context exists to forge | N/A |
| Organization key leakage | Unaffected — keys never carry authorization (ADR-0028) | Auth |
| Cross-organization access | Prevented by `organizationAuthority`/`memberBelongsTo`, live per request | Auth |
| Consumer impersonation | Prevented by bearer-token authentication, verified live (`auth.guard.ts`) — Flow adds no new identity mechanism | Auth |
| Stale access | Not applicable to context (nothing cached); entitlement facts are re-checked live by whichever service reads them | Billing (for subscription/license), Auth (for membership) |
| Revoked organization participation | Billing re-evaluates `organization_license` live; Flow (once built) must re-check on each relevant request, not cache it | Billing |
| Revoked consumer access | Billing re-evaluates `user_subscription` live, same discipline | Billing |
| Subscription expiration | Same as above — `{valid, expiresAt}`, checked live | Billing |
| Concurrent sessions | Already structurally independent (separate `refresh_token.familyId` rows) — unaffected by Flow | Auth |
| Multiple devices | Already structurally independent (separate `device` rows) — unaffected by Flow | Auth |
| Client-side authority claims | Never trusted — core-architecture.md §6's rule extends, by the same principle, to any future client-supplied "Flow consumer" or "subscription active" claim | Every service, uniformly |
| Service-to-service authorization | Flow's own future backend, calling Auth/Billing, would use the existing per-caller service-token mechanism (ADR-0033) — Flow is simply one more caller, no new mechanism | Auth/Billing (as callees), via the existing service-token model |

## 14. Client neutrality

**[DECISION — Proposed, ADR-0041, restated]** Unaffected: no client type (Tauri, browser, mobile, desktop) or
store (Play Store, App Store) gates any fact in this study's model. A future Flow backend would expose one API to
every client, calling Core's APIs the same way regardless of caller platform — identical to how Auth's existing
routes already work for Driver's desktop/mobile clients today.

## 15. Recommended ownership boundary

```text
                              Nawara Core (this repository)
                                        │
        ┌───────────────┬──────────────┼──────────────┬────────────────────┐
        │               │              │              │                    │
      Auth      Organization Service  Billing       Payment          (no Entitlement
        │               │        (ADR-0038,      money movement      service — §7
      User        Company/Platform/  unbuilt)     (implemented)       finds this is
        │           Organization  organization_                        already billing's
 OrganizationMembership    │       license /                           job, not a
   [0..N], live         (exists)   user_subscription                    fourth owner)
   authorization
        │               │              │              │
        └───────────────┴──────┬───────┴──────────────┘
                                │ opaque userId / organizationId,
                                │ service-token-authenticated API calls (ADR-0033),
                                │ never a shared database, never imported code
                                ▼
                    Nawara Flow  (future repo — does NOT exist yet, [HYPOTHETICAL])
                                │
        ┌───────────────────────┼───────────────────────┐
        │                       │                       │
   Consumer domain        Provider domain          Order/Purchase domain
   (profile, favorites,   (catalog, products —     (cart, order, booking,
    addresses,             name-distinct from       delivery, review — money
    preferences)            billing's own            movement still goes
                             `product` table;         through Payment, the
                             operational/              commercial record
                             discoverability           stays Flow's own)
                             toggle)
        │                       │                       │
        └───────────────────────┴───────────────────────┘
                                │
                 All Flow-owned business rules & the
                 consumer ↔ organization relationship —
                 NOT OrganizationMembership, NOT a Core entity
```

## 16. Concepts that explicitly must NOT enter Core

`FlowConsumer` (any shape); consumer profile/preferences; favorites; cart; orders/purchases/bookings as commercial
records; delivery relationships; Flow's product/catalog concept; Flow-specific permissions/roles for consumers;
`ConsumerOrganizationMembership` or any generic consumer↔organization relationship; any Flow-specific business
rule; anything that would require Core to know what "operationally available in Flow" means.

## 17. Concepts that genuinely belong in Core

`User` and its identity/session/credential machinery (Auth, unchanged); `OrganizationMembership` at `[0..N]`
(Auth, accepted); `organization_license`/`user_subscription` (billing, ADR-0038, still to be built); the
Company/Platform/Organization hierarchy (organization-service, already implemented); the existing
`organizationAuthority`/org-admin authority mechanism, reused as-is for Flow's own organization-administration
surface, requiring no new Core concept.

## 18. Open decisions

1. Whether ADR-0038 should be accepted and scheduled (recurring across every study in this chain).
2. Whether a generic "address book" concept ever clears the genericity bar for Core once (if ever) a second product
   genuinely needs the identical shape (§5) — not decided, not recommended either way, flagged only.
3. Whether/when a `nawara-flow` repository is created at all (not authorized or assumed by this study).
4. Whether Flow ever needs capability-grained entitlement beyond ADR-0038's binary valid/expired model (§7) — no
   evidence for this today; flagged so it isn't silently assumed later either way.

## 19. ADR impact

| ADR | Classification |
|---|---|
| ADR-0028, ADR-0030, ADR-0031 | UNCHANGED |
| ADR-0038 | UNCHANGED — not accepted, not implemented; its boundary confirmed sufficient, no fourth "Entitlement" owner introduced |
| ADR-0040, ADR-0042 | UNCHANGED (both remain `Accepted`, untouched) |
| ADR-0041 | UNCHANGED (remains `Proposed`) — its client-neutrality rule restated, not amended |
| ADR-0043 | UNCHANGED — consistent with, does not amend |

**No new ADR is proposed.** This study's findings are a systematic application of CLAUDE.md's existing genericity
rule, not a new architectural decision.

## 20. Explicit non-goals

No runtime code, schema, or migration change; no `consumer` `User.kind`; no `OrganizationMembership` change beyond
the already-accepted `[0..N]`; no Flow tables, APIs, services, or repository created; no registration, subscription,
or licensing implementation; no Entitlement Service; ADR-0038 not accepted; Billing/Payment/Auth/Organization
Service behavior unchanged; no Compose/deployment change; nothing committed.

---

## Validation

| Command | Result |
|---|---|
| `npm run check:repo` | PASS |
| `npm run test:repo` | PASS (15/15) |
| `git diff --check` | PASS |
| `git status --short` | Documentation only — confirmed below |
| `git diff --stat` | Documentation only — confirmed below |

**Confirmed:** ADR-0038 status still `Proposed`/unimplemented (verified against its own `Status:` line and
`apps/billing-service`'s tripwire test); ADR-0041 status still `Proposed`; ADR-0042 status still `Accepted`; the
member `[0..N]` decision remains `Accepted` (`member-membership-invariant-owner-decision.md`); no `consumer`
`User.kind` introduced (no `apps/auth-service` file touched by this study). No file outside `docs/` was modified.

```
STAGE 10 CORE VS FLOW OWNERSHIP BOUNDARY STUDY COMPLETE
```

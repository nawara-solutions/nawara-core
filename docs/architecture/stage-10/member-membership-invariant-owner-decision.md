# Stage 10: member-membership-invariant owner decision

- **Status:** **OWNER DECISION ACCEPTED** (2026-09-20) **and IMPLEMENTED** (2026-09-20, migration `0009_member_zero_membership.sql`).
  No ADR-status change accompanies this decision. The Flow consumer registration entrypoint itself remains
  unbuilt and out of scope — only the underlying Auth invariant that would block it is relaxed.
- **Decider:** Anwar (project owner).
- **Resolves:** the one recurring open item across
  [the product entry context study](./stage-10-product-entry-context-study.md §4),
  [the Auth/Flow-subscription study](./stage-10-auth-flow-subscription-and-membership-study.md §19),
  [the identity/membership/context study](./user-identity-membership-context-study.md §22), and this document's own
  prior draft (which framed the choice and required an owner decision).

Tags: **[FACT]** (read directly from code/migration, unchanged by this decision), **[DECISION — Proposed/Accepted]**
(an existing ADR, status as written), **[INFERENCE]** (reasoning from facts).

## 1. Decision

```text
ACCEPTED

member → OrganizationMembership [0..N]
```

A `User.kind = 'member'` account may legitimately exist with **zero** `organization_membership` rows. This
decision is **accepted and implemented** (migration `0009_member_zero_membership.sql`, §8) and has since been
**independently audited** (read-only security/regression audit, verdict `PASS WITH FINDINGS`, zero
security/authorization/migration/architecture blockers). What remains unbuilt is the production Flow registration
entrypoint that would actually create such a member (§6, §13) — the underlying Auth identity capability this
invariant governs is what has changed, not any Flow-facing surface. It is required to support the
already-established Flow requirement that a consumer authenticates and uses the product before joining any
organization (ADR-0043).

This decision does **not** mean:
- `member = consumer` — a member with zero memberships is not a new kind of thing; it is the same `member` kind,
  simply permitted a narrower membership count than before.
- Every member is a consumer.
- Zero membership constitutes authorization for anything (§5).

It only changes the **allowed cardinality** of the `User ↔ OrganizationMembership` relationship for `kind=member`,
from `[1..N]` to `[0..N]`.

## 2. Previous invariant

**[FACT]**, verified against the actual migration, not documentation:

```text
member   → OrganizationMembership [1..N]   (DB-enforced)
owner    → OrganizationMembership [0]       (structurally — cannot hold one)
operator → OrganizationMembership [0]       (structurally — cannot hold one)
```

Enforced by a single deferred trigger: `apps/auth-service/db/migrations/0001_identity_tenancy_platform_assignment.sql:143-145`
(`CREATE CONSTRAINT TRIGGER user_require_subtype AFTER INSERT ON "user" DEFERRABLE INITIALLY DEFERRED`), whose
function body (`apps/auth-service/db/migrations/0007_multi_organization_membership.sql:117-127`) raises `23514` if
a `kind='member'` row commits with no matching `organization_membership` row. This trigger fires on the `"user"`
table itself, for every insert, from any code path — it was not, and could not be, bypassed by any application-level
workaround; only editing the trigger function changes this.

## 3. Accepted invariant

```text
member   → OrganizationMembership [0..N]   (accepted direction; not yet implemented)
owner    → OrganizationMembership [0]       (unchanged)
operator → OrganizationMembership [0]       (unchanged)
```

Owner and Operator are unaffected — they already have this shape today, structurally, and nothing about this
decision touches their branches of the trigger.

## 4. Why the decision is required

**[INFERENCE]**, established across the three prior studies and re-confirmed here: given two already-settled
constraints — (a) `User.kind` stays `member | owner | operator`, no `consumer` value is added (identity/context
study §12, structural: a single-valued `kind` cannot represent a User holding an organization role and an
independent product-consumer role at once), and (b) no synthetic/default organization is created to satisfy the
existing `[1..N]` invariant (auth-flow-subscription study §14, rejected on inspection) — there is **no** mechanism
by which a Flow-only consumer (an authenticated User with no organization at all) can come into being under the
previous `[1..N]` invariant. Relaxing the cardinality is therefore the only remaining lever consistent with what
has already been decided, not a new architectural preference introduced by this document.

## 5. Security implications

**[FACT]**, verified against actual authorization code, unaffected by this decision either way:

- **Zero membership does not grant organization access.** `organizationAuthority()` and `memberBelongsTo()`
  (`apps/auth-service/src/platform/platform-access.service.ts:76-110`) require a live, `active`-status
  `organization_membership` row to grant anything; absence is the default-deny case today and remains so. A member
  with zero memberships attempting a Driver/School organization-scoped route hits the same "no active membership →
  collapsed 404" path a member with an unrelated organization's membership already hits.
- **Organization operations still require:** authenticated User **+** target organization **+** valid, active
  membership **+** required product capability, where applicable — unchanged.
- **Client claims remain untrusted.** Nothing about this decision changes core-architecture.md §6's rule that
  `organizationId`, `platformId`, `role`, `permissions` (and, by the same principle, any future "consumer
  authority" claim) are never trusted without server-side verification.
- **Consumer access stays a separate, independently-evaluated fact**, never implied by, or converted into,
  `organization_membership`. This decision does not create a `ConsumerMembership` or any generic Core relationship
  for consumer/purchase interactions (identity/context study §10) — that question, if it ever needs an answer,
  stays a Flow product-domain concern.
- No authorization check anywhere reads "does this User have ≥1 membership" as a precondition; the invariant was
  always a database-integrity/naming rule, never a security boundary (established in the auth-flow-subscription
  study §3 and re-verified in every study since).

## 6. Registration implications

**[FACT — updated 2026-09-20]** `POST /auth/register`'s `joinCode` remains unconditionally mandatory
(`RegisterDto.joinCode`, `apps/auth-service/src/auth/dto.ts:9`, unchanged), serving Driver/School exactly as it did
before. No product-conditional logic was added to it. The implementation added a **test-only** fixture
(`memberNoOrg`, `apps/auth-service/test/helpers/app.ts`) proving a zero-membership member can now be created — but
**no production HTTP entrypoint** creates one. A future Flow-specific registration entrypoint is still a **separate**
route, not designed here, mirroring the pattern already used by `bootstrapOwner` (owner) and
`OperatorAdminService.create()` (operator).

## 7. Existing-user implications

**[FACT/INFERENCE]** No existing row is affected. Every current `member` row already satisfies `≥1 membership`
(enforced at the time it was created and permanently since — memberships are never deleted, ADR-0030). Relaxing the
invariant going forward does not retroactively touch any existing member, owner, or operator row. No conversion,
backfill, or migration of existing data is implied or required by this decision.

## 8. Database migration implications

**[FACT — updated 2026-09-20]** Implemented as `apps/auth-service/db/migrations/0009_member_zero_membership.sql`
(and its down migration, `down/0009_member_zero_membership.down.sql`), following the expand/verify/migrate/contract
shape this section originally called for:

```text
expand   → migration 0009 relaxes the `member` branch of user_require_subtype(); the registration entrypoint
           itself is NOT added (still deliberately out of scope — see §6)
verify   → db/tests/invariants.sql test 'B' and db/tests/run.sh's new M11 scenario prove a zero-membership
           member can be created and that rollback correctly refuses while one exists; the full existing
           283-assertion invariant suite and M1-M10 migration scenarios pass unchanged
migrate  → not applicable yet — no production caller creates a zero-membership member (no entrypoint exists)
contract → not applicable; the [1..N] path for Driver/School (POST /auth/register) is permanent, untouched
```

Full checklist status: (1) invariant updated — **done**; (2) existing data verified — **done** (no existing member
has zero memberships; migration touches no row); (3) registration path — **not done, out of scope**; (4) tests
updated — **done** (DB invariant suite, migration round-trip test, new e2e spec); (5) authorization behavior
verified — **done** (e2e proves zero-membership member denied everywhere); (6) `/auth/me` verified — **done**
(returns `memberships: []`, no code change needed); (7) downstream services verified — **done** (billing-service,
payment-service, organization-service, service-kit all pass typecheck/lint/unit tests unmodified); (8) regression
tested — **done** (full auth-service e2e suite: 19 files, 248 tests, all pass).

## 9. Relationship to `User.kind`

**[FACT/DECISION — already settled, not reopened]** `User.kind` stays `member | owner | operator`. This decision
changes nothing about `User.kind` — it is orthogonal: the cardinality change is on `organization_membership`, a
different table entirely. `kind` remains immutable post-creation (DB-enforced by a `forbid_column_change('kind')`
trigger, migration `0001:164-165`) and single-valued, exactly as the identity/context study established. No new
kind is added by this decision, now or implied for later.

## 10. Relationship to `OrganizationMembership`

This decision is entirely **about** `OrganizationMembership`'s cardinality relative to `member`, and nothing else
about it changes: its schema (`status`, `audience`, `isOrganizationAdmin`, the approval state machine), its
creation paths (`POST /auth/register`, `POST /auth/onboarding/join`), its live-per-request authorization role, and
its permanence (never deleted) are all unaffected. A member may still hold one, several, or (now, in the accepted
future direction) zero memberships — all three are valid states:

```text
member, OrganizationMembership = []                                    (new — accepted direction)
member, OrganizationMembership = [Organization A]                       (existing, unchanged)
member, OrganizationMembership = [Organization A, Organization B, ...]  (existing, unchanged — ADR-0030)
```

## 11. Relationship to Flow consumer access

**[INFERENCE]** This decision makes a zero-membership `member` identity **possible**; it does not itself define
what a Flow consumer can *do*. Flow consumer capability/subscription (a billing-owned fact, ADR-0038) is evaluated
entirely independently of membership count — a User's Flow access is never derived from, nor does it imply, any
`organization_membership` row. This mirrors the identity/context study's Model E and is unchanged by this decision.

## 12. Relationship to ADR-0038

**Not accepted, not implemented, not touched by this decision.** ADR-0038 (entitlement: `organization_license`,
`user_subscription` in billing-service) remains a fully separate decision gate. The boundary stays:

```text
Billing → product subscription/license facts (ADR-0038, still Proposed, still unbuilt)
Auth    → User identity, authentication, OrganizationMembership (this decision touches only the last of these)
Flow    → future product-specific consumer behavior (not designed here)
```

No subscription table, license table, or Billing code is created or modified by this decision.

## 13. Deferred implementation work

**[FACT — updated 2026-09-20]** The Auth invariant itself (migration 0009) is now implemented — see §8. Explicitly
**still not** done, all left to future, separately-scoped work:

- Flow consumer registration endpoint (route, request/response shape, owning module) — still no production
  entrypoint creates a zero-membership member; the capability exists at the identity-model level only.
- Flow consumer subscription model; Flow organization participation/license model.
- Billing subscription/license implementation (ADR-0038 acceptance and build-out — **not accepted by this task**).
- Consumer purchase/order model (whether and where it's recorded — identity/context study §10, still open).
- Organization key lifecycle changes (none implied — ADR-0028 semantics unchanged).
- Flow UI/client behavior; Tauri/browser client architecture.
- Any consumer ↔ organization Core touchpoint beyond what already exists.
- Product-specific authorization implementation; Nawara Flow itself, in any form.

## 14. Owner decision status

```text
OWNER DECISION ACCEPTED
```

**What remains settled and closed by this decision:** the cardinality question (`[1..N]` → `[0..N]` for `member`)
is resolved. **What remains open:** every item in §13 — this decision authorizes a future direction, not a future
implementation plan, timeline, or endpoint design.

---

## Validation

**[FACT — updated 2026-09-20, implementation task]**

| Command | Result |
|---|---|
| `npm run check:repo` | PASS |
| `npm run test:repo` | PASS (15/15) |
| auth-service `typecheck` / `lint` / `build` | PASS |
| auth-service unit tests | PASS (59/59) |
| auth-service e2e tests (19 files, incl. new `member-zero-membership.e2e-spec.ts`) | PASS (248/248) |
| auth-service DB invariant suite (`db/tests/run.sh`) | PASS (283 assertions, M1-M11) |
| service-kit / billing-service / payment-service / organization-service typecheck/lint/unit | PASS, unaffected |
| `git diff --check` | PASS |

## Runtime impact

**Auth's identity model changed** (the accepted, now-implemented cardinality relaxation). **Everything else is
unchanged**: no other service's runtime, schema, or API changed; no Flow capability was implemented; ADR-0038 was
not accepted.

```
STAGE 10 MEMBER MEMBERSHIP INVARIANT — OWNER DECISION ACCEPTED AND IMPLEMENTED
```

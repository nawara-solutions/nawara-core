# 0024. Database-enforced tenancy and authorization integrity (Owner/Operator subtypes, mandatory FKs, DB-level assignment uniqueness)

- **Status:** Proposed
- **Date:** 2026-09-18
- **Deciders:** Anwar (project owner)

> **Amends** (does not replace) [ADR-0009](./0009-platform-scoped-admin-accounts.md),
> [ADR-0011](./0011-operator-time-boxed-login-code.md),
> [ADR-0016](./0016-first-owner-bootstrap-command.md),
> [ADR-0017](./0017-single-owner-with-secret-key-force-reset.md),
> [ADR-0020](./0020-organization-entity-and-platform-scoped-management.md),
> [ADR-0022](./0022-company-and-platform-entities-with-operator-assignment.md) and
> [ADR-0023](./0023-platform-access-check-and-operator-login-decoupling.md) on the specific
> points listed under "Decision → What this amends". Every other decision in those ADRs stands.

## Context

A review of the (still unimplemented) `auth-service` data model, as it stood after ADR-0020 –
ADR-0023, found integrity and authorization gaps that all share one root cause: **fundamental
invariants were assigned to application code, or left implicit, when the database could enforce
them.** Concretely:

1. **`User.organizationId` was nullable with no foreign key** (ADR-0001, ADR-0020). Nothing
   stopped a normal user from having no organization, or a nonexistent one — even though
   `Organization` is now an `auth-service` table, so a real FK is trivially available and the
   "cross-service boundary" reason for leaving it loose (ADR-0020) no longer applies inside this
   database.
2. **"At most one active `PlatformAssignment` per `(operatorId, platformId)`" was explicitly a
   service-layer invariant** (ADR-0022). Two concurrent grants both pass a "does one exist?"
   check and both insert. This is the table the whole operator authorization boundary rests on.
3. **`PlatformAssignment.assignedBy` was only an FK to `User.id`**, and so were `operatorId` and
   `platformId` independent of each other's company. Nothing at the database level said the
   assigner is an *owner*, the assignee an *operator*, or that all three belong to the same
   company. A row could even be inserted (or its `assignedBy` rewritten) after the fact.
4. **"Is this identity an Owner or an Operator?" had several sources of truth**: `role = 'admin'`,
   `adminTier`, `secretKeyHash IS NOT NULL`, `contactVerifiedAt`, `organizationId IS NULL`.
   Owner-only and operator-only columns sat on every `User` row, and nothing prevented
   impossible combinations (an operator with a password, an owner with `contactVerifiedAt`, a
   `role: 'admin'` row with `adminTier: null`).
5. **`role: 'admin'` was both the management marker and an unconstrained client-supplied
   string.** `POST /auth/register` accepts `role` from the request body (ADR-0001: opaque), and
   the "either tier" endpoints (`AdminOrganizationController`, `GET /auth/platform-access/…`,
   `GET /auth/admin/platform/calendar`) are gated by `RolesGuard('admin')`. A self-registered user
   who sends `role: "admin"` therefore passes that guard with `adminTier: null` — a privilege
   escalation waiting for the guard's inner branch to fall through the wrong way. It also
   collides with platform-defined roles (a school's own "Administrator" is legitimately an
   ordinary member role).
6. **The owner had no explicit relationship to the company** — only a bootstrap env var
   (ADR-0016), so "the target platform belongs to the owner's company" (ADR-0022) had nothing to
   be checked against.
7. **`PlatformNonWorkingDay.platformId` was a loose string with no FK**, and
   **`AdminOperatorCode` issuance physically deleted the previous code** (ADR-0011), destroying
   security-audit history.

None of this needs a new architecture. `Company → Platform → Organization → User`, owner
company-wide access, operator access via `PlatformAssignment`, refresh-token rotation, schedules,
device tracking and the cross-service boundary are all kept exactly as ADR-0001…0023 designed
them. This ADR moves invariants into the schema and removes the ambiguous identity semantics.

## Options considered

### For Owner/Operator identity

1. **Keep `adminTier` on `User`, add validation in the service layer.** Smallest change. Rejected:
   it is exactly the "invariants in application code" failure this ADR exists to remove;
   owner-only and operator-only columns stay on every row and every impossible combination is
   representable.
2. **Keep `adminTier` on `User` and add a dense set of CHECK constraints** (`adminTier = 'owner'
   OR secretKeyHash IS NULL`, …). Enforceable, but the nullable columns for both tiers remain on
   one wide table, `OperatorSchedule`/`AdminOperatorCode`/`AdminDevice` still FK to a generic
   `User` (so an owner could own a schedule), and there is still no natural home for
   `Owner.companyId`.
3. **`User` + `Owner` + `Operator` subtype tables, with a `User.kind` discriminator and composite
   FKs (chosen).** The classic "shared primary key + discriminator" pattern: the database itself
   refuses a subtype row on a user of the wrong kind, an operator-only table can only reference
   an operator, and each subtype has a natural home for its own fields (`Owner.companyId`,
   `Owner.secretKeyHash`, `Operator.contactVerifiedAt`).

### For where a normal user's platform comes from

1. **Store `platformId` on `User` and validate it matches `Organization.platformId`.** Rejected
   (and explicitly forbidden by ADR-0022): two sources of truth that a CHECK cannot compare
   across tables.
2. **Derive it only via `User → Organization → Platform` (chosen)**, exposed as a single
   database view so no query has to re-invent the join and nothing is tempted to denormalize it.

### For the `PlatformAssignment` uniqueness invariant

1. **Service-layer check-then-insert** (ADR-0022's stance). Rejected: a textbook race.
2. **Serialize grants with a transaction-level lock** (advisory lock / `SELECT … FOR UPDATE` on the
   operator row). Correct, but every future write path must remember to take it.
3. **A partial unique index `(operatorId, platformId) WHERE active` (chosen).** Enforced for every
   writer, including ones that don't exist yet; the service just maps `23505` to `409`.

### For cross-company consistency of an assignment

1. **A trigger that looks up the three companies on insert.** Works, but is procedural logic that
   is easy to bypass with `session_replication_role` or forget on a copy of the table.
2. **A redundant `PlatformAssignment.companyId` pinned by three composite FKs (chosen)** —
   `(operatorId, companyId) → Operator`, `(platformId, companyId) → Platform`,
   `(assignedBy, companyId) → Owner`. Declarative, no procedural code; the column can never
   diverge because the FKs force it to equal each parent's company. It is documented as a
   redundant-by-design integrity column and is never read for authorization.

## Decision

### `User` becomes a pure identity with one authoritative discriminator

`User.kind` — `'member' | 'owner' | 'operator'`, `NOT NULL`, immutable — replaces `adminTier`. It is
the **only** source of truth for what an identity is. The JWT's `adminTier` claim (ADR-0009/0022,
unchanged on the wire) is derived from it at token issuance: `owner`/`operator` for those kinds,
absent for `member`. Every guard keys off that claim; nothing else (not `role`, not the presence
of `secretKeyHash`, not a null `organizationId`) is consulted to decide "is this an owner?".

Two new subtype tables share `User.id` as their primary key, and are attached with a composite
FK `(userId, kind) → User(id, kind)` where `kind` is pinned by a CHECK, so a row can only ever
attach to a user of the matching kind and `kind` cannot change beneath it:

- **`Owner`** — `userId`, `companyId` (**`NOT NULL` FK → `Company.id`**), `secretKeyHash`,
  `secretKeyIssuedAt` (both null or both set). This is the explicit Owner → Company relationship
  ADR-0022 lacked.
- **`Operator`** — `userId`, `companyId` (NOT NULL FK → `Company.id`, the company whose owner
  manages this operator), `contactVerifiedAt`.

`OperatorSchedule`, `OperatorTimeOff` and `AdminOperatorCode` reference `Operator.userId`;
`AdminDevice` references `Owner.userId`; `PlatformAssignment` references `Operator` and `Owner`.
An owner therefore cannot have a schedule, a member cannot hold a login code, and an operator cannot
have a secret key or an admin device — by foreign key, not convention. A deferred constraint
trigger rejects, at commit, a `User` whose `kind` is `owner`/`operator` but which has no subtype
row.

`User`-level CHECKs enforce the rest of the identity shape:

| Rule | Constraint |
|---|---|
| A member always has exactly one organization; owners/operators never do | `(kind = 'member') = (organizationId IS NOT NULL)` |
| `role = 'admin'` is reserved for management identities | `(kind = 'member') = (role <> 'admin')` |
| Operators never have a password; everyone else does | `(kind = 'operator') = (passwordHash IS NULL)` |
| Every identity has a contact; non-operators need an email | `email IS NOT NULL OR phone IS NOT NULL`; `kind = 'operator' OR email IS NOT NULL` |

**`role = 'admin'` is now a reserved value** for owners and operators. `POST /auth/register`
rejects it with `400` (the DB CHECK is the backstop, mapped from `23514`), and a platform that
wants its own "administrator" concept must use a different string (`school_admin`,
`administrator`, …) — auth-service still treats every other `role` value as opaque. This closes
the privilege-escalation gap above while keeping the existing `role: 'admin'` JWT contract that
other services already read.

### Mandatory tenancy foreign keys

- `Platform.companyId` — `NOT NULL`, FK → `Company.id`, `ON DELETE RESTRICT`.
- `Organization.platformId` — `NOT NULL`, FK → `Platform.id`, `ON DELETE RESTRICT`.
- `User.organizationId` — FK → `Organization.id`, `NOT NULL` **exactly when `kind = 'member'`**.
  The invariant is not weakened for members; owners/operators are represented explicitly as a
  different kind rather than as members with a missing organization.
- There is **no** `User.platformId`, and none may be added. A member's platform is
  `organization → platform` and is exposed by the `user_platform` view
  (`userId, organizationId, platformId, companyId`) so the join is written once.
- `Organization.platformId`, `Platform.companyId` and `User.kind` are immutable (trigger). There is
  no designed operation for moving an organization between platforms; if one is ever wanted it is
  a deliberate, audited migration, not an `UPDATE`.

### `PlatformAssignment`: DB-enforced, append-only

Columns: `id`, `operatorId`, `platformId`, `companyId` (integrity column, above), `assignedBy`,
`assignedAt`, `revokedAt?`, `revokedBy?`, `active`, `createdAt`, `updatedAt`. **`revokedBy` is new**:
without it a revocation is unattributed, which is a gap against "who currently has access, and who
took it away" (audit). It is nullable-with-`revokedAt` (`revokedAt IS NULL ⇔ revokedBy IS NULL`).

- FKs: `(operatorId, companyId) → Operator(userId, companyId)`, `(platformId, companyId) →
  Platform(id, companyId)`, `(assignedBy, companyId) → Owner(userId, companyId)`, and the same
  for `revokedBy`. `Operator.userId` and `Owner.userId` are themselves FKs to `User.id`, so all
  three ids are real FKs to `User`/`Platform`, and additionally guarantee *role* (assigner is an
  owner, assignee an operator) and *company* (all in the same company).
- **`CREATE UNIQUE INDEX … ON platform_assignment (operatorId, platformId) WHERE active`.** Under
  concurrent grants exactly one `INSERT` commits; the others fail with `23505`, which the service
  maps to `409`. This index also serves the live authorization lookup.
- `CHECK (active = (revokedAt IS NULL))` — the two can never disagree.
- **Append-only, enforced by a trigger:** `DELETE` is rejected; the only permitted `UPDATE` is the
  one-way revocation (`active: true → false`, setting `revokedAt`/`revokedBy`); grant fields
  (`operatorId`, `platformId`, `companyId`, `assignedBy`, `assignedAt`) are immutable; a revoked
  row can never be reactivated. Re-granting always inserts a **new** row.
- `assignedBy` is derived from the authenticated identity, never from the request (unchanged from
  ADR-0022, now with a database backstop: it must be an owner of the platform's company).

Owners never get `PlatformAssignment` rows (an owner's `operatorId` cannot even be inserted: it
would have to be an `Operator`). Owner authorization is `Owner.companyId = Platform.companyId`.

### Owner cardinality is policy, not architecture

ADR-0017's "exactly one owner, permanently" is now enforced by **one** unique index,
`Owner(companyId)`, named `owner_single_per_company_v1`. It is the only thing that limits a
company to one owner; the schema, the guard, and every authorization query already treat owners as
"any `Owner` row whose `companyId` matches". Allowing several owners later is dropping that index
(plus the product decisions ADR-0017 defers), with no authorization redesign.

### `AdminOperatorCode`: superseded, not deleted

Adds `supersededAt`. Issuing a new code for `(operatorId, purpose)` **sets `supersededAt` on the
previous live code** and then inserts the new one — two sequential statements in one transaction
(a single data-modifying CTE does not order them, and the index below would still see the old
row). A partial unique index `(operatorId, purpose) WHERE consumedAt IS NULL AND supersededAt IS
NULL` guarantees at most one live code per pair, and `CHECK (consumedAt IS NULL OR supersededAt
IS NULL)` keeps `consumedAt` meaning exclusively "verified". `attemptCount` gets `CHECK (0..5)`.
Verification still only considers the one live, unexpired row with `attemptCount < 5`, so the
authentication behavior of ADR-0011/0015 is unchanged; only the history is retained.

### `PlatformNonWorkingDay`: owned by auth-service, now with a real FK

`auth-service` owns `Platform`, and no other service owns per-platform working-day data or has
asked for it. Deleting the table would remove three shipped-design endpoints for no gain and
strand consumers that ADR-0023 explicitly left free to read it, so it stays, is documented as
**platform-level reference data owned by auth-service** (not consulted by any auth-service login
or session decision — ADR-0023), and `platformId` becomes `uuid NOT NULL` FK → `Platform.id`.
If a platform-specific service later needs richer calendar rules, extracting the table there is
a data move plus an endpoint proxy; auth-service is not the long-term home for business calendars.
Its endpoints are now authorized against the `Platform` row (owner: platform in own company;
operator on `GET`: live active assignment; otherwise the collapsed `404`), closing a hole where
`GET /auth/admin/platform/calendar?platformId=` was open to *any* admin for *any* platform.

### Authorization is server-derived from the resource

Unchanged in shape from ADR-0022/0023, now stated as the one canonical rule (detail in the SDD's
"Authorization flow"): the platform is always derived as
`resource → organization → platform`, never accepted from the client; the actor is resolved from
the authenticated `sub`; owners are checked against `Owner.companyId = Platform.companyId`,
operators against an *active* `PlatformAssignment` and an active account, members against their
own `organizationId`. Denial reasons (missing platform, other company, inactive account, no
assignment) are distinct internally and collapse to one external response.

### "No schedule configured" is a documented, intentional fail-open

Unchanged behavior (ADR-0011/0012), now an explicit invariant: **no `OperatorSchedule` rows means
"no schedule restriction", not "configuration failure"**. It must never be read as "denied".
`OperatorAvailabilityService` returns a typed reason so the following are never conflated:
`NO_SCHEDULE_CONFIGURED` (allowed), `DAY_OFF` (schedule has no row for today), `TIME_OFF`,
`OUTSIDE_WORKING_HOURS`, `ACCOUNT_INACTIVE`, `CONTACT_UNCONFIRMED`; and, from other layers,
`PLATFORM_ASSIGNMENT_REVOKED/ABSENT` (authorization, per request) and `SESSION_EXPIRED` (token
layer).

### What this amends

- **ADR-0009:** `User.adminTier` → `User.kind` + `Owner`/`Operator` tables (the `adminTier` JWT claim
  is retained, derived from `kind`); `role: 'admin'` becomes reserved.
- **ADR-0011:** `AdminOperatorCode` issuance no longer deletes the previous code (supersede
  instead); `AdminOperatorCode.userId` → `Operator.userId`.
- **ADR-0016:** the "null `organizationId` ⇒ skip license/subscription checks" short-circuit is
  keyed on `kind <> 'member'` (equivalent, since the CHECK makes the two identical, but no longer
  an implicit convention); the bootstrap command creates the `User(kind='owner')` **and** its
  `Owner` row in one transaction, taking a `Company` (not `platformId`) as its scope.
- **ADR-0017:** "one owner per company" is the `owner_single_per_company_v1` index (droppable);
  `secretKeyHash`/`secretKeyIssuedAt` live on `Owner`, and the reset CLI updates `Owner`.
- **ADR-0020:** `User.organizationId` gains a real FK and is `NOT NULL` for members; the
  "no existence-validation of `organizationId`" carve-out for `POST /auth/register` no longer
  applies **inside auth-service** (an unknown organization is now rejected by the database with
  `23503`, which `POST /auth/register` maps to the same generic `403` it already returns for
  "no valid license", so existence is never revealed). `payment-service`'s own tables still hold an opaque `organizationId`
  with no FK, exactly as before.
- **ADR-0023:** `GET /auth/platform-access/:platformId` no longer answers `200` unconditionally for
  an owner: an owner is allowed iff the platform exists in the owner's own company
  (`Owner.companyId = Platform.companyId`) and the account is active, otherwise the collapsed
  `404`; an operator additionally must be active. Operator login/session decoupling from platform
  calendars is unchanged.
- **ADR-0022:** the "service-layer, not a database constraint" paragraph is reversed (partial
  unique index, above); `assignedBy` FK target tightened to `Owner`; `revokedBy`/`companyId` added;
  owner ↔ company is explicit.

## Consequences

**Good**

- The invariants that matter for security — no orphan organizations, no tenantless members, no
  double active grant, no cross-company grant, no operator-as-assigner, no history deletion — hold
  for every writer, present and future, including ad-hoc SQL and buggy code.
- One authoritative answer to "owner or operator?" and one to "which platform is this user on?".
- `role: 'admin'` can no longer be forged through self-registration.
- Multiple owners later is a one-index change, not an authorization redesign.

**Costs / risks**

- More tables and composite keys, and one intentionally redundant column
  (`PlatformAssignment.companyId`). Its risk is nil (the FKs pin it) but a reader may want to
  "clean it up"; the SDD and the migration comment say why not.
- Creating an owner/operator is now a two-row insert (`User` + subtype) that **must** run in one
  transaction (enforced at commit by the deferred trigger). A naive single-statement helper will
  fail loudly rather than corrupt data.
- Reserving `role = 'admin'` is a small, deliberate hard-code in an otherwise role-agnostic
  service. Any existing consumer that used `admin` as its own member role must rename it.
- `user_kind` is a Postgres enum; adding a fourth kind is a (cheap) migration, deliberately: a new
  kind of identity is a security-model change that should not happen by accident.
- The service must map `23505` → `409`, `23503` → `403`/`404`, `23514` → `400` on the write
  paths above (exact table in the SDD), and treat any unmapped one as a `500` (an invariant
  violation the service failed to pre-empt is a bug worth surfacing).

## Open questions

- Should `Operator.companyId` be dropped in favor of "operators belong to whichever company's
  owner created them" being derived from an audit column? Kept explicit here because composite
  FKs need a real column; revisit only if multi-company operators are ever wanted (an operator
  serving two companies would need a join table, which would also be a security-model decision).
- `isActive` for owners: ADR-0017 says the owner row is never deactivated in-band. Not enforced
  by a CHECK here (it is a lifecycle rule, not a structural one); the access query still honors
  `isActive` for every management identity, so a manually deactivated owner is denied.
- Whether `PlatformAssignment` should carry a per-assignment permission set. Out of scope
  (Platform-specific permissions stay in each platform's own service per the "platform-agnostic
  auth" rule); noted because `PlatformAssignment` is the natural place to hang one if a
  cross-platform capability list is ever wanted.

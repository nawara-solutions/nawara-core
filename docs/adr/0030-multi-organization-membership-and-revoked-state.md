# 0030. Multi-organization membership: one identity, many memberships, and the REVOKED state

- **Status:** Proposed
- **Date:** 2026-09-19
- **Deciders:** Anwar (project owner)

> **Supersedes in part** the one-organization-per-member rule of
> [ADR-0001](./0001-generic-organization-id-scoping-claim.md) and
> [ADR-0024](./0024-database-enforced-tenancy-and-authorization-integrity.md) (the `user.organizationId` column,
> `user_org_iff_member`, the `(userId, organizationId)` composite foreign key and the `user_platform` view).
> **Amends** [ADR-0028](./0028-organization-join-codes-membership-and-organization-admin.md) (the membership state
> machine gains `revoked`; the join code's audience label moves from `user.role` to the membership) and
> [ADR-0029](./0029-organization-admin-invitations.md) (an invitation's type is stored on the membership, not on the
> user). Migrations `0006` and `0007`.

## Context

auth-service is a shared, platform-independent service. Nawara Drive, a school, a clinic or a delivery app are
**examples of platforms**; Auth must contain nothing that only one of them needs. Until now the model tied a member
to **exactly one organization** structurally: `user.organizationId` was mandatory for members and the membership
row was bound to it by a composite foreign key. Two consequences the audit found:

1. A person who belongs to an organization on platform A and another on platform B needs **two accounts** (two
   passwords, two e-mails). There is no flow for an existing user to join a second organization, and the unique
   contact makes registering again a 409.
2. `user.role` stored the join code's **audience label** ("teacher", "student", ...): a platform-specific business
   word on the identity, copied into the JWT `role` claim. It cannot be right for a person who is a "teacher" in one
   organization and a "driver" in another, and it invites consumers to trust an Auth-issued business role.

Also missing: a way to **remove** an admitted member. `active` was a dead end, so a departed member or a removed
administrator could not be expressed, only deactivated as a whole user (`user.isActive`), which is the wrong scope.

Forces: keep `User.kind` at `member | owner | operator`; no `User.platformId`; keep `user.isActive` (account
disabled) distinct from `membership.status` (this organization); keep join codes and admin invitations as designed;
authorization must stay live (read from the database on every request), never cached in a token.

## Options considered

**Identity shape**
1. *Keep one organization per user, document "use two accounts".* Rejected: does not meet the requirement, and
   pushes identity reconciliation onto every platform.
2. *A `user_organization` join table beside the existing column.* Rejected: two sources of truth.
3. **One user, N `organization_membership` rows; the membership is the only link to an organization.** Chosen. The
   platform and company are **derived** (membership → organization → platform → company), never stored on the user.

**Where the business label lives**
1. *Keep it on `user.role`.* Rejected (see Context).
2. **On the membership as an opaque `audience`**, copied from the join code's audience or the invitation's type,
   frozen after creation. The user's `role` becomes the neutral constant `member` (still `admin` for owners and
   operators). Auth never interprets `audience`; platforms do.

**Removing a member**
1. *Delete the row.* Rejected: destroys history, and the row is the audit anchor.
2. *Set `user.isActive = false`.* Rejected: it ends the person's access to **every** organization.
3. **A `revoked` status, final, with `revokedAt`/`revokedBy`.** Chosen.

**Session/token context**
1. *Put the current organization in the JWT.* Rejected: a token would then bind one organization and a stale token
   would outlive a revocation.
2. **No organization, platform or business role in the token.** Authorization derives the context from the
   **resource in the URL** and the **live membership row**. Sessions are user-wide.

## Decision

### Data model
```
Company 1─N Platform 1─N Organization 1─N OrganizationMembership N─1 User(kind = member)
User(kind = member | owner | operator)      -- no organization, platform or business role on the user
```
- `organization_membership`: `UNIQUE (userId, organizationId)` (one row per pair, history kept), new
  `audience` (label CHECK, never the reserved `admin`), `userKind` (= `member`), `revokedAt`, `revokedBy`.
- Foreign keys: `(userId, userKind) → user(id, kind)` (only a member can have a membership) and
  `organizationId → organization(id)` (added explicitly, since the old composite key carried it).
- `user`: drop `organizationId`, `user_org_iff_member`, `user_id_organization_uk`, `user_organization_idx`, view
  `user_platform`. New CHECK `user_role_is_kind_neutral`: members are `member`; owners and operators are `admin`.
- View `member_platform` replaces `user_platform`: one row per membership with organization, platform and company.
- A **deferred constraint trigger** requires every member to have at least one membership at commit (rows are never
  deleted, so this holds for the life of the account).

### State machine (database-enforced by `membership_guard`)
```
pending ──approve──▶ active ──revoke──▶ revoked (final)
   └────reject────▶ rejected (final)
```
Identity fields (user, organization, audience, join code / invitation) are frozen; a decision cannot be rewritten;
the admin flag exists only while `active` and is **cleared in the same statement** that revokes; `revoked` needs
`revokedAt` and `revokedBy`. `rejected` and `revoked` are final: re-application is deferred (documented).
`user.isActive` and `membership.status` stay independent: a disabled account is refused by the guard before any
membership is read; a revoked membership never affects the account or the other memberships.

### Joining another organization
`POST /auth/onboarding/join {joinCode}` (member session): the same lookup, fail-closed license check, atomic
single-use redemption and membership creation as registration, in one transaction. A second membership in the same
organization is a 409 that rolls the spent use back. Rate limited per user (`membership_join_user`, default 10 per hour, `RATE_MEMBERSHIP_JOIN_USER_*`) and per client
address, audited. Registering with a contact that already has an account stays a 409: **one contact, one account**.

### Revoking
`POST /auth/organizations/:id/memberships/:membershipId/revoke`. Same authority as approve/reject (Owner, an
Operator assigned to the platform, an organization admin), with these limits: only an `active` membership (else
409), nobody revokes their own membership, and an **organization admin cannot revoke another administrator**
(collapsed 404; an Owner can). One row lock plus a conditional `UPDATE ... WHERE status = 'active'`; audit
`membership.revoked`; event `membership.revoked`. Operators and org admins act without step-up, as for approve
and reject (ADR-0028); this is recorded as a residual risk below.

### Token, `/auth/me` and the guard
Access-token claims for every kind: `sub, sid, role, iss, aud, iat, exp`; **no** `organizationId`. The guard loads
`id, kind, role, isActive`. `/auth/me` returns `memberships[]` (organization, platform, status, audience,
`isOrganizationAdmin`) read from current rows. This is a **breaking change** of the token and `/auth/me` shapes; the
only known consumer is Auth itself.

### Consequences for consuming services and apps
A token no longer says which organization the caller acts for. A service that bills or serves an organization (for
example payment-service, ADR-0007/0021, whose docs still mention a JWT `organizationId` claim) must take the
organization from the request or resource and confirm the caller's active membership through auth-service
(`GET /auth/me`, or a per-organization check when one is added). No payment-service code reads that claim today, so
nothing breaks now; those documents are marked as superseded in this respect by this ADR. Tokens issued before the
deploy keep working until they expire (15 min by default); they carry an `organizationId` that nothing reads.

## Multi-platform identity analysis
1. **Can one user belong to organizations on different platforms?** Yes: memberships are independent rows.
2. **Where is the platform stored on the user?** Nowhere. It is derived through the membership.
3. **Same person, two organizations of one company?** Yes; two rows, possibly different labels.
4. **Does approval in A affect B?** No. Every decision is per membership; a token needs no change.
5. **Does an admin flag in A give authority in B?** No. `organizationAuthority` reads the row of the organization in
   the URL only. Tested (`multi-membership.e2e-spec.ts`).
6. **Does revoking in A end the session?** No: sessions are user-wide; only access to A ends, on the next request.
7. **Can an Operator of platform A see membership in platform B?** No; live authorization is per platform.
8. **Duplicate accounts by contact?** Prevented: contact is unique; joining is the path. Reconciling two existing
   accounts is out of scope.
9. **A platform-specific role in Auth?** No. `audience` is an opaque label; permissions stay in the platform.
10. **Disabling a person?** `user.isActive = false` ends everything; revoking a membership ends one organization.

## Consequences

- Easier: one login across platforms; removal without deleting history; the token no longer goes stale on
  membership changes; Auth carries no business role.
- Harder: consumers must read `/auth/me` (or ask Auth per organization) instead of trusting a token claim; the
  migration is a **breaking change**; the down migration **refuses** when any user has more than one membership or a
  revoked one, and it cannot drop the enum value (PostgreSQL). Migration `0006` is forward-only for that reason.
- Deploy: merging triggers `0006`/`0007` automatically; verify `schema_migrations` and `/auth/me` after the deploy.
- Follow-ups: forward notes on ADR-0001, ADR-0024, ADR-0028, ADR-0029 (done); SDD/ADD/security review updated.
- The `audience` is frozen: a wrong label cannot be corrected (revoke and re-admit is impossible too, since both
  end states are final). A correction path is deferred.
- **Residual risks / deferred:** operators and org admins revoke without step-up; re-application after
  rejection/revocation; invitation acceptance by an existing user; reconciling duplicate accounts.

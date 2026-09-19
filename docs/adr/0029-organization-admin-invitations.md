# 0029. Organization admin invitations: privileged provisioning, and where administration authority lives

- **Status:** Proposed
- **Date:** 2026-09-18
- **Deciders:** Anwar (project owner)

> **Forward note (2026-09-19):** acceptance now stores `invitationType` as the membership's `audience`; the user's `role` is the neutral `member`. See [ADR-0030](./0030-multi-organization-membership-and-revoked-state.md).


> **Extends** [ADR-0028](./0028-organization-join-codes-membership-and-organization-admin.md) (join codes,
> membership, the organization-management capability) and **narrows one statement of it**: ADR-0028 says an org
> admin cannot mint other admins; that remains true of the flag grant/revoke route, but an org admin **can** now
> invite one through this ADR's invitation (see "First-admin bootstrap"). It also resolves ADR-0028's unresolved
> question 6 (the first administrator). Relies on
> [ADR-0024](./0024-database-enforced-tenancy-and-authorization-integrity.md) (reserved `admin` role) and
> [ADR-0007](./0007-out-of-band-cash-payment-confirmation.md). Migration `0005`.

## Context

auth-service is a **shared, platform-independent** service for every Nawara Solutions platform. Nawara Drive is
only the current example. Auth owns identity, authentication, sessions, MFA, membership and organization access
scope. Each platform owns its own business roles and permissions (for Nawara Drive: student, teacher, admin).

ADR-0028 delivered generic onboarding through **join codes** and an **Auth-owned, generic organization-management
capability** (`isOrganizationAdmin`) that lets someone approve memberships and manage codes. What is missing is a
safe way to **create the first administrator of an organization**, and further administrators, without anyone
becoming an administrator merely by knowing an organization id, name, code or license number.

Forces:

- A join code is a normal onboarding credential; it must never be able to provision a privileged person.
- The literal role `admin` is reserved for owners and operators: consumers read the JWT `role: admin` claim as
  "management identity" (migration 0001, ADR-0024). A member can never carry it.
- An organization can pay for its license only through an org-scoped request that needs an existing member
  (ADR-0007), so the first administrator cannot be gated on a license.
- Authorization must not be duplicated across Auth and platform services.

## Options considered

**Credential**
1. *Reuse a join code with an "admin" audience.* Rejected: a normal, shareable credential must not provision
   privilege, and the audience is client-visible context.
2. *A predictable code such as `12345_admin`.* Rejected.
3. **A dedicated invitation: random, single-use, revocable, server-expiring, audited.** Chosen.

**What consuming it grants inside Auth** (confirmed by the project owner)
1. **An active membership with the existing generic organization-management capability, plus an opaque
   platform-defined label.** Chosen: one authorization system; Auth can protect its own membership operations.
2. *Membership and label only.* Rejected: approving members would have to be delegated to the platform, which
   needs service-to-service authentication that does not exist yet.

**Who may invite** (confirmed): Owners (with a factor step-up) and existing organization admins.
**Binding** (confirmed): optional, to the intended person's e-mail or phone.

## Decision

### Credential and lifecycle
`organization_admin_invitation` (separate table, own routes, own HMAC domain label under the existing
`JOIN_CODE_PEPPER`, no new secret). 12 CSPRNG characters (60 bits), shown `XXXX-XXXX-XXXX`; the plaintext is returned
once and only its HMAC is stored. Validity: `now < expiresAt AND revokedAt IS NULL AND consumedAt IS NULL`.
There is no stored status: it is derived (`consumed`, `revoked`, `expired`, `active`).

- **Single use.** Acceptance is one conditional `UPDATE ... WHERE consumedAt IS NULL AND revokedAt IS NULL AND
  expiresAt > now` inside the registration transaction; the database trigger and CHECKs make a second
  consumption, a consume-after-expiry, or a consumed-and-revoked invitation impossible. Two simultaneous
  acceptances: exactly one wins and the loser's user creation rolls back.
- **Revocation** is immediate and final (`revokedAt`/`revokedBy`); an invitation is never deleted or revived,
  so history stays for investigation.
- **Duration.** The admin sends `expiresInMinutes`; the server enforces a configured range (default 24 h,
  minimum 15 min, maximum 7 days: `INVITATION_DEFAULT_MINUTES`, `INVITATION_MIN_MINUTES`, `INVITATION_MAX_MINUTES`;
  the maximum is configurable up to the 30-day database ceiling)
  and stores the absolute `expiresAt = serverNow + minutes`. A client-supplied `expiresAt` is rejected. A
  database CHECK is a hard 30-day backstop.
- **Invitation lifetime is not session lifetime.** Once consumed the invitation is dead; the new administrator
  gets a normal session with the normal TTLs. Verified by a test that the session outlives the dead invitation.

### Provisioning result
Acceptance creates a `kind = member` (never a new `User.kind`), an **ACTIVE** membership with
`isOrganizationAdmin = true` and `invitationId` (provenance; a membership is admitted by a join code **or** an
invitation, never both), and a normal session. `role` is the invitation's opaque `invitationType` label.

### The reserved word `admin`
The literal `admin` cannot be the label (DTO and database CHECK), because a member with that role would look like
a management identity to every service that reads the JWT claim. A platform that wants an "admin" business role
names it with any other label (`org_admin`, `manager`, ...) and maps it itself.

### First-admin bootstrap
An **Owner of the organization's company** creates the first invitation for an organization, with a fresh
**factor** step-up (TOTP or passkey, never the bare secret key), and delivers it out of band. The invitee accepts;
from then on existing organization admins can invite more (no step-up mechanism exists for members, so their
session alone authorizes it: a documented residual risk mitigated by single use, revocation, audit, rate limits and
optional contact binding). Operators are **not** authorized to provision administrators. Knowing an organization
id, name, code or license number grants nothing.

### No license question at acceptance
Unlike join-code registration, accepting an invitation does **not** ask payment-service for a license. The
organization cannot pay for a license before it has a member (ADR-0007), so requiring one here would deadlock the
first administrator. The inviter, who is already authorized inside the organization (an Owner of its company or an
existing admin), vouches for it. Entitlement is still enforced by Payment and the platform at the point of use.

### Contact binding
Optionally the inviter names an e-mail or phone; only an HMAC is stored (no PII at rest). Acceptance must then use
exactly that contact after normalization. A mismatch is the same generic 403 and does **not** consume the invitation.

### Endpoints, limits, audit
| Route | Access |
|---|---|
| `POST/GET /auth/organizations/:id/admin-invitations`, `POST .../:invId/revoke` | owner (step-up) or org admin |
| `POST /auth/onboarding/invitations/resolve` | public, rate limited, one generic 404 |
| `POST /auth/onboarding/invitations/accept` | public, rate limited, generic 403 |

Buckets: resolve spends `invitation_resolve_ip` and `invitation_resolve_global`; accept spends `invitation_accept_ip`
**and** the two resolve buckets (it accepts a code); create and revoke spend `invitation_manage_actor`.
Audit (secret-free): `onboarding.admin_invitation.created|resolved|resolve_failed|consumed|revoked`; failure
reasons (`unknown`, `malformed`, `expired`, `revoked`, `consumed`, `contact_mismatch`) are audited, never returned.
Expiry is a state, not a background event.

### Where authorization lives (the single decision)
```
Auth (generic, platform-independent)         Platform service (e.g. Nawara Drive)
  identity, authentication, MFA, sessions       business role names and permissions
  membership (pending/active/rejected)          what a "student", "teacher" or "admin" may do
  generic organization-management capability    workflows, documents, camera, dashboards
    (protects join codes, membership decisions,
     invitations only)
  opaque labels it carries but never interprets
```
There is **one** authorization system for *membership and onboarding operations* (Auth) and one for *business
actions* (the platform). The platform reads Auth's facts ("active membership of organization X", "carries the
management capability", the opaque label) and applies its own rules. Auth hard-codes no student/teacher/admin.

### Events
Acceptance publishes `user.registered` (with `role` = the invitation label) and `membership.admin_provisioned` on the
existing bus. **Nothing delivers them yet** (no broker or notification consumer); no event carries the code. An
outbox is the recommended design once delivery exists.

### Registration state
No `RegistrationIntent` table: acceptance is a single transaction and nothing must persist between steps.

## Consequences

- Privileged provisioning is a separate, auditable, revocable credential; a leaked join code cannot create an
  administrator, and a used or revoked invitation is dead immediately.
- The database enforces the invariants (composite FK, single use, lifetime bounds, immutability, provenance).
- Platform independence is preserved: labels are opaque and only `admin` is reserved.
- **Narrowing of ADR-0028:** an org admin can now provision another admin (via an invitation), where ADR-0028 only
  let an Owner do so. This is deliberate (confirmed by the project owner) and is the documented residual risk
  below.
- Terms in the design brief map to the existing names: `audience` = onboarding type; audit events use the
  database-enforced dotted form; `isOrganizationAdmin` names a **capability**, not a business role.

### Unresolved questions (no invention; a decision is needed)
1. **Delivery of the invitation** to the invitee (out-of-band today; an outbox-backed event later). Nothing sends it.
2. **Second-factor for org-admin actions.** Should minting an administrator by an org admin need a stronger
   proof than the session (a fresh password, or a member step-up)? Not built.
3. **Recovering an organization with no administrator left** (all admins gone): an Owner can issue a new
   invitation; a policy for who is allowed and how it is reviewed is not defined.
4. **License policy for administrators** after acceptance (what the platform does when the organization is
   unlicensed) is the platform's and Payment's decision.

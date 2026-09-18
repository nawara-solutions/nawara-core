# 0028. Organization join codes, membership and organization-admin authority

- **Status:** Proposed
- **Date:** 2026-09-18
- **Deciders:** Anwar (project owner)

> **Extends** [ADR-0020](./0020-organization-entity-and-platform-scoped-management.md),
> [ADR-0024](./0024-database-enforced-tenancy-and-authorization-integrity.md),
> [ADR-0026](./0026-authentication-is-not-entitlement.md) and
> [ADR-0027](./0027-service-layer-security-model.md). **Replaces the client-supplied
> `organizationId` + `role` registration contract that ADR-0004 assumed** (ADR-0005 is already superseded by
> ADR-0026); the registration-time license question to payment-service (ADR-0004 as narrowed by ADR-0026) is
> unchanged. ADR-0004 carries a forward note. Migration `0004`.

## Context

A person opens a platform app (for example Nawara Drive) and must first say which organization they
belong to. Two onboarding paths are needed:

- **student**: register, verify contact, then payment-service decides entitlement;
- **teacher**: register, verify contact, membership `pending`, the organization approves, `active`.

Constraints already in the repository:

- `User.kind` is `member | owner | operator`. Business roles (student, teacher, manager, ...) belong to
  the platform application, not to Auth. CLAUDE.md forbids driving-school concepts in Core.
- A member has **exactly one organization**, enforced by the database (`user_org_iff_member`).
- Until now `POST /auth/register` accepted `organizationId` and `role` **from the client**.
- Authentication is not entitlement (ADR-0026): payment-service owns licenses, subscriptions, trials.
- Auth has Owners (company-wide staff) and Operators (staff assigned to platforms), but **no
  organization-level administrator**.
- Nothing delivers messages yet (notification-service is a scaffold, RabbitMQ is not deployed).

## Options considered

**How the client names the organization**
1. *Organization id (or `12345_student`) as the credential.* Rejected: an id is an identifier, not a
   secret. It is enumerable, permanent, and the audience would be client-chosen.
2. **A join code that the server resolves** to (organization, platform, audience). Chosen.

**Where "waiting for approval" lives**
1. *`User.isActive = false`.* Rejected: it conflates "this account is invalid" with "the organization has
   not accepted this person", and would lock a pending teacher out of authenticating at all.
2. **A separate membership row with a status.** Chosen.

**Student / teacher as `User.kind`.** Rejected: business roles stay outside Auth.

**Who administers an organization (approve, reject, manage join codes)**
1. *Only Owner/Operator (company staff).* Smallest change, but a school would have no self-service.
2. *Nawara Drive owns it and calls Auth.* Needs service-to-service authentication that is not designed.
3. **Auth-owned organization-admin capability on the membership, granted by an Owner with step-up.**
   Chosen (confirmed by the project owner). Authorization stays in one place; no new `User.kind`.

**Audience values**
1. *Hard-code `student` and `teacher` in Auth.* Rejected: it puts domain concepts in Core.
2. **`audience` is an opaque label; behaviour comes from two flags on the code.** Chosen.

## Decision

### Join code
- `organization_join_code` resolves server-side to `organizationId`, `platformId`, `audience`,
  `requiresApproval`, `requiresSubscription`. The client sends **only** the code.
- 10 CSPRNG characters (50 bits), displayed `XXXXX-XXXXX` with an optional cosmetic prefix. Stored as
  `HMAC-SHA-256(JOIN_CODE_PEPPER, normalized code)`; the plaintext is shown once, at creation.
  `JOIN_CODE_PEPPER` is a new entry in the existing secret mechanism (same loader, distinct from every
  other secret) because reusing another pepper would break purpose separation.
- Expiry (default 30 days, maximum 365, never permanent), optional `maxUses`, `usedCount`, revocation.
  Redemption is **one conditional UPDATE** inside the registration transaction; the database CHECK
  `usedCount <= maxUses` is the backstop.
- A composite FK `(organizationId, platformId) -> organization(id, platformId)` makes a code that
  names a foreign platform, and therefore a foreign company, impossible. The target, hash, audience,
  flags and limits are immutable; a revoked code can never be revived; codes are never deleted.
- `audience` is an opaque label matching `^[a-z][a-z0-9_-]{0,31}$`. **`admin` stays reserved** (ADR-0024: a member
  can never carry that role), so it is refused at creation by the DTO and by a database CHECK; otherwise such a
  code could be created but never redeemed. `requiresApproval` decides whether the new membership starts
  `pending` or `active`. `requiresSubscription` is **only a hint returned to the app**; Auth stores no
  subscription state and decides no entitlement.

### Registration
`POST /auth/register` takes `{ joinCode, email|phone, password }`. `organizationId`, `platformId`, `role`,
`audience` and every other property are rejected by the validation pipe. In one transaction it spends a
use of the code, creates a `kind=member` user (`role` is the opaque audience label) and creates the
membership. A bad, expired, revoked or exhausted code and an unlicensed organization give the same
generic 403. payment-service is asked once whether the organization is licensed (fail closed).

### Membership
`organization_membership(userId, organizationId, status)`, `status` in `pending | active | rejected`:
- unique per `(userId, organizationId)`; a composite FK to `"user"(id, organizationId)` means a
  membership can only name the member's own organization;
- a trigger allows only `pending -> active | rejected`, freezes identity fields and forbids deletion;
- only `active` grants organization access, decided from **current rows on every request**, never from a
  token claim. `pending` and `rejected` are authenticated but not admitted; `User.isActive` stays true;
- existing members are backfilled as `active` by migration `0004`.

Registration state machine:

```
join code -> resolved -> registered (account created, membership pending|active)
   student:  active -> [payment-service decides entitlement]
   teacher:  pending -> approve -> active
                    \-> reject  -> rejected   (final; revocation/suspension are future scope)
```

### Organization administration
Authority is evaluated per request from the target organization (`organizationAuthority`):

| Authority | Condition |
|---|---|
| owner | the organization's platform is in the owner's company |
| operator | an active `PlatformAssignment` on the organization's platform |
| org_admin | an ACTIVE membership of **this** organization with `isOrganizationAdmin` |

Everything else is one collapsed 404. Approve/reject is one transaction (row lock plus a conditional
`UPDATE ... WHERE status='pending'`), so simultaneous decisions leave exactly one winner and a 409 for the
loser; nobody decides their own membership. Owners need a step-up for two groups of actions. Creating or revoking
join codes accepts a TOTP, a passkey or the secret key. Granting or revoking the org-admin flag is a privilege
grant and accepts a factor only (TOTP or passkey), never the bare secret key. An org admin cannot mint other
admins. Operators and org admins have no step-up mechanism and act on their session alone. The flag can only sit on an active membership (database CHECK).

### Contact verification
`member_contact_verification` mirrors operator codes (6-digit CSPRNG code, HMAC-stored, 5 attempts, one live
code per member, rate limited) and publishes a delivery event. It **gates organization access, and the approval of an
applicant (a 409 while their contact is unverified), only when `REQUIRE_CONTACT_VERIFICATION=true`**, which stays
**off in production** until a channel exists.

### Rate limiting and audit
New DB-backed buckets: `join_code_resolve_ip`, `join_code_resolve_global`, `join_code_manage_actor`,
`membership_op_actor`, `contact_request_user`, `contact_verify_user`, `contact_verify_ip`. Registration also
spends the resolve buckets because it accepts a code. Audit events (`onboarding.join_code.created|revoked|
used|resolve_failed`, `membership.requested|approved|rejected`, `organization.admin.granted|revoked`,
`member.contact.*`) carry ids and labels only, never a code, password or token.

### Endpoints

| Route | Access |
|---|---|
| `POST /auth/onboarding/resolve` | public, rate limited |
| `POST /auth/register` | public, rate limited |
| `POST /auth/contact/request-code`, `/verify` | authenticated member |
| `GET /auth/me` (adds `membership`) | authenticated |
| `GET /auth/organizations/:id/membership` | member; 204 only when `active` |
| `GET .../memberships`, `POST .../memberships/:id/approve\|reject` | owner, operator, org admin |
| `POST/GET .../join-codes`, `POST .../join-codes/:codeId/revoke` | owner (step-up), operator, org admin |
| `POST/DELETE .../memberships/:id/admin` | owner + step-up only |

## Consequences

- The client can no longer choose an organization, platform, audience or role; a leaked organization id is
  worthless. The old `register` body is a **breaking change** (no deployed caller).
- Membership is a real object, so approvals, rejections and history are auditable, and multi-organization
  support later relaxes one constraint deliberately.
- The database enforces the integrity rules (composite FKs, unique keys, CHECKs, triggers), verified by the
  SQL suite (`JC`, `MEM`, `CV`, `PK` groups) and migration scenarios M5/M6.
- `audience` being an opaque label keeps Core generic; the platform maps labels to business roles.
- **Deviation from the brief, on purpose:** "student"/"teacher" are usable values, not reserved names (only
  `admin` is reserved), and behaviour comes from the code's flags. This keeps the CLAUDE.md rule that Core has no domain concepts.

### Notification requirement (no delivery yet)
On `membership.requested`, `membership.approved|rejected` and `member.contact_verification_requested`, an
event is published on the existing bus. **Nothing delivers it** until notification-service and a broker
exist. When they do, prefer a transactional **outbox** (write the event in the same transaction as the state
change) over a separate publish, so a crash cannot lose an approval notice. Not built now.

### Unresolved questions (not guessed; a product/architecture decision is needed)
1. **Student checkout:** which payment-service endpoint starts the student's subscription, and how the app
   learns the outcome. Auth returns the hint only.
2. **Teacher approval and the organization license:** whether approving a teacher must re-check the
   organization's license with payment-service (this ADR does not add that call), and the failure policy.
3. **Delivery channel** for verification codes and approval notices (notification-service design).
4. **Should `requiresSubscription` come from payment-service** per platform product instead of being stored
   on the code?
5. **Membership revocation and suspension** (removing a teacher) and **multiple organizations per user**:
   deliberately out of scope; the state machine and the one-organization key are the two places to extend.
6. **First organization administrator:** bootstrapped by an Owner approving the registration of the intended
   person (through any code whose `requiresApproval` is true, e.g. a `manager` audience) and then granting the
   flag; no self-service path exists.

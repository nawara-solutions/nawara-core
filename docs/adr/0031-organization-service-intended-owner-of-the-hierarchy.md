# 0031. organization-service is the intended future owner of Company, Platform and Organization

- **Status:** Proposed (amended 2026-09-19 on the project owner's direction: the mechanism is deliberately **not** designed)
- **Date:** 2026-09-19
- **Deciders:** Anwar (project owner)

> **Amends [ADR-0020](./0020-organization-entity-and-platform-scoped-management.md)** for the long term only. ADR-0020 chose that
> auth-service owns the Organization entity and rejected a dedicated `organization-service`; this ADR records that
> organization-service is the *intended* future owner instead, but changes **nothing today**. It builds on
> [ADR-0024](./0024-database-enforced-tenancy-and-authorization-integrity.md) and
> [ADR-0030](./0030-multi-organization-membership-and-revoked-state.md), neither of which is changed. An earlier draft of this
> ADR described a tenancy-anchor design (an Auth provisioning route, a `provisioning` state, reconciliation); the project owner
> withdrew it: **no anchor tables, synchronization or adoption flow are designed here.**

## Context

The organizational hierarchy is:

```
Company 1 → N Platform
Platform 1 → N Organization
```

An organization reaches its company only through its platform (`Organization → Platform → Company`); there is **no**
`Company → Organization` link and no separate multi-company tenancy model. auth-service's schema already has exactly this
shape (`platform.companyId`, `organization.platformId`; the view `member_platform` derives the company). auth-service also
**needs** these tables today: owners are company-scoped, operators are assigned to platforms, memberships and join codes
reference organizations, all through database foreign keys and composite keys (ADR-0024). Only the owner-bootstrap tool
creates a company; no route creates a platform or an organization (finding F23 of the auth security review, still open).

The Core architecture assigns organization lifecycle, metadata, settings and policies to a separate `organization-service`.

## Options considered

1. **Record organization-service as the intended future owner; change nothing now; decide the cross-service mechanism when it
   is built.** Chosen, on the project owner's direction.
2. *Design a tenancy anchor in Auth, provisioned by organization-service, with ordered creation and reconciliation.* Withdrawn:
   it invents synchronization and adoption flows before organization-service exists.
3. *Move Company, Platform and Organization out of Auth now.* Rejected: it reworks Auth's foreign keys and breaks the frozen
   Auth data model.

## Decision

- **Intended owner:** organization-service will own creation, lifecycle, metadata, settings and policies of **Company**,
  **Platform** and **Organization**, and the Company → Platform → Organization relationships. It will not duplicate users,
  credentials, sessions or **membership**, which stay in auth-service.
- **Today:** auth-service's hierarchy tables stay exactly as they are and remain what Auth enforces. No Auth data-model change,
  no new Auth route, no replication, no new table.
- **Not decided (and not to be invented):** how Auth references these entities across a service boundary once
  organization-service exists; whether Auth keeps local rows, calls an API or consumes events; how existing rows move or are
  adopted; creation ordering and failure handling. **When organization-service is implemented, work stops and a separate ADR
  decides.** Until then organization-service is not on the critical path of any other service.
- **Interim rule for other services:** they hold opaque `organizationId`/`platformId`/`companyId`. They validate a *user's*
  organization context with Auth (`GET /auth/me` returns `memberships[]` with the platform). Where there is no user context
  (for example a product service creating an obligation for an organization), the source that validates the
  organization → platform → company relationship is **an open decision**; the only implemented lookup today is Auth's
  `GET /auth/admin/organizations/:id`, limited to owners and operators.
- The hierarchy invariant above is non-negotiable and applies to every service.

## Consequences

- No work, migration or risk now; the frozen Auth model is untouched.
- Ownership is split until organization-service exists: the intended owner is not yet the owner. That is a documented gap, not
  a designed state.
- Nothing else depends on organization-service, so the financial services can proceed.
- Finding F23 stays open.

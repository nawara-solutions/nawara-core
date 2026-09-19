# 0031. Organization ownership: organization-service owns the organization, Auth keeps a tenancy anchor

- **Status:** Proposed
- **Date:** 2026-09-19
- **Deciders:** Anwar (project owner)

> **Amends [ADR-0020](./0020-organization-entity-and-platform-scoped-management.md) and reverses part of it.**
> ADR-0020 chose that auth-service owns the whole Organization entity and **rejected a dedicated
> `organization-service`** (its Option 1, as a fairly simple CRUD entity). This ADR now adopts that rejected option for
> the organization's profile, settings and lifecycle, because the Core architecture assigns them to a separate
> service. Auth keeps only the tenancy anchor described below. ADR-0020 needs a one-line "Amended by ADR-0031" note
> (added). It builds on
> [ADR-0024](./0024-database-enforced-tenancy-and-authorization-integrity.md) and on the multi-organization
> membership model ([ADR-0030](./0030-multi-organization-membership-and-revoked-state.md)), neither of which is changed. Finding F23 of the auth security review
> (no route creates an organization) is closed **for organizations only** once the anchor route exists; there is still
> no platform-creation path (open decision O9).

## Context

Today auth-service's database holds `company`, `platform` and `organization`. Membership rows reference `organization`
through database foreign keys, and tenant isolation is enforced by composite keys company → platform → organization
(ADR-0024). No route creates an organization and no service owns its profile, settings or lifecycle. The Core
architecture assigns organization lifecycle and configuration to a separate `organization-service`, while Auth's data
model is frozen and Auth must remain the sole owner of identity and membership.

Forces: one owner per entity; no duplicated membership state; no cross-service database access; no change to Auth's
schema; a crash between two systems must not leave an orphan or a half-created organization.

## Options considered

1. **organization-service owns the organization; Auth keeps its existing row as a minimal tenancy anchor, created
   idempotently by id through one new Auth route.** Chosen.
2. *Auth stays the only writer; organization-service is read-mostly.* Rejected: "organization creation" stays in Auth,
   contradicting the ownership table.
3. *Move the organization out of Auth and replicate it back by events.* Rejected for now: it reworks Auth's foreign
   keys and breaks the frozen data-model rule.

## Decision

- organization-service owns the **organization record**: id, opaque `platformId`, name, profile fields (opaque to
  Core), settings, policies and **status** (`provisioning → active ⇄ suspended → deactivated`).
- Auth owns only the **anchor**: the existing `organization` row that memberships and tenancy checks need
  (`id`, `platformId`, `name`). Because Auth's schema is frozen, that table **keeps its legacy profile columns**
  (`taxCode`, `address`, `phone`, `type`). After this decision they are **not authoritative and not maintained by
  Core**: organization-service holds the profile. Whether Auth still writes them at provisioning (copying `name` only,
  or the profile too) is a detail for the anchor-route design; either way there must be no second writer of profile
  data. Removing those columns is a future Auth migration, not part of this decision.
- **Creation order:** (1) organization-service creates the row as `provisioning` with a client-supplied or generated
  id and an idempotency key; (2) it calls Auth's anchor route (service-token authenticated, **idempotent by id**,
  retried with backoff); (3) on success it sets `active` and publishes `organization.created`. A crash between (1) and
  (2) leaves a retryable `provisioning` row; a repeated (2) is a no-op. An anchor is never created without an
  organization-service row.
- Organization-service stores **no** user, credential, session or membership data. Who may act for an organization is
  asked of Auth live (ADR-0033).
- The Auth route is **additive** (no schema change) and lands in its own small Auth PR.
  Until then organization-service talks to an `AuthAnchorClient` port with a test double.
- **Platform and company** lifecycle is not part of this decision (open decision O9 in the Core architecture); Auth
  keeps them.

## Consequences

- One owner per entity is achieved without touching Auth's foreign keys.
- Two systems now hold an organization id; consistency depends on the ordered, idempotent creation above and on a
  reconciliation check (organizations stuck in `provisioning`).
- Suspending or deactivating an organization in organization-service does **not** by itself revoke memberships in
  Auth. Whether a suspended organization blocks member access must be decided and implemented explicitly (Auth would
  need to learn the status); until then it is a documented gap.
- Follow-up: the Auth anchor route; an ADD/SDD for organization-service; reconciliation job.

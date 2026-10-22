# 0069. Verified audit producers, audit contract v2 and scoped human reads (amends ADR-0049)

- **Status:** Proposed <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X -->
- **Date:** 2026-10-21
- **Deciders:** Anwar (project owner, architecture owner)

> **Core V2 S0 (2026-10-21).** The architecture owner approved this decision's direction (P0 decisions D-2/D-3 and the Audit design)
> and its wording at the Core V2 S0 freeze ([S0 record](../architecture/core-v2-s0-architecture-freeze.md)). That is not an
> acceptance of this ADR: its status stays `Proposed` until the owner changes it explicitly. It **amends** the Accepted
> [ADR-0049](./0049-audit-trail-architecture.md), which is not edited here; its status line and a reciprocal note change only with
> separate, explicit approval. It depends on [ADR-0057](./0057-messaging-conventions.md) §13 (Proposed) and is to be accepted with or
> after it. Nothing in it is implemented.

## Context

ADR-0049 (Accepted) states that, until per-service broker identities exist, a producer's identity on the bus is asserted, and that
Audit binds each action to its catalog producer by the asserted `source` header. Per-service broker users exist
(`infra/rabbitmq/provision.sh`), but every producer can publish any `audit.*` name and no publisher sets the AMQP `user_id`, so the
asserted identity cannot be trusted for financial accountability. Core V2 also needs Company- and Platform-level human
investigation (Owner and operator), which ADR-0049's Organization-scoped reads cannot provide without inferring ownership.

## Options considered

1. **Keep the asserted identity.** Rejected: forgeable accountability for refunds, disputes and recovery.
2. **Cryptographic signing of audit payloads.** Rejected: key custody and rotation with no gain over broker-enforced identity plus
   first-intake provenance (ADR-0057 §13).
3. **Broker-verified producers, an additive contract v2, and trusted scope for human reads (chosen).**

## Decision

ADR-0049 decisions 1 to 11 are preserved. In addition:

1. **Verified producers.** A producer publishes with its own broker username as AMQP `user_id`; Audit treats an `audit.*` event as
   producer-verified only if broker user = `sourceService` = the catalog owner of the action, under ADR-0057 §13. Topic-write
   permissions are limited to each producer's own actions.
2. **Contract v2 (additive).** New optional fields `platformId`, `companyId`, `liveMode`, `requestedBy`, `approvedBy`,
   `verifiedBy {service, mechanism, ref}` and `via`; Audit stores `producerIdentityVerified` and `replayed`. Versions 1 and 2 are
   both accepted; a version-1 event for an action introduced in version 2 is refused. History is never rewritten; new columns are
   nullable.
3. **Human actors.** A human appears as `approvedBy` only from the recording service's own verification (for example, Auth's
   consumption of an authorization receipt, [ADR-0067](./0067-auth-authorization-receipts-for-owner-approved-refunds.md)), never from
   a request body.
4. **Trusted scope.** Human-facing reads select only records that have a trusted scope row: from the Organization reference, or from a
   broker-verified producer allowed to assert a Company or Platform for that action. Records without one stay readable only by
   service callers with `read_platform`. Ownership is never inferred, including from the existence of a single Company.
5. **Human reads.** An Owner Company timeline and an operator Platform view apply scope before any limit; cursors are bound to actor,
   scope, filters and window; `correlationId` and resource filters never widen scope; every read is itself recorded, and a read that
   cannot be recorded fails with `503` (as today).
6. **Legal holds** are append-only events; the retention role skips held records; no normal role can delete.
7. **Non-live records.** Production Audit refuses `liveMode = false`.

## Consequences

- Financial and security accountability rests on broker-verified producer identity instead of an asserted header.
- Audit gains nullable columns and two insert-only tables (scope rows, legal-hold events); the production `audit_record` keeps its
  append-only guarantees (no update of existing rows).
- Historical records stay as they are: unverified, and without scope unless one comes from a trusted basis.
- Follow-up: implementation and certification under separate authorization (S0 record, stages S1 and S2); historical Auth → Audit
  dead letters are a pending owner decision before enforcement.

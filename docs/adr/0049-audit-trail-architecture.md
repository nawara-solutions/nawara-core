# 0049. Security and business audit trail architecture

- **Status:** Accepted (2026-09-25, by the owner, after the Stage 18.1 review)
- **Date:** 2026-09-25
- **Deciders:** Anwar (project owner)
- **Related:** [ADR-0032](./0032-database-per-service-on-a-shared-server.md) (database per service), [ADR-0033](./0033-service-to-service-authentication-and-user-identity.md)
  (service tokens), [ADR-0034](./0034-shared-service-kit-and-api-conventions.md) (service-kit, API conventions), [ADR-0037](./0037-reliable-events-outbox-inbox.md) (outbox / inbox), [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md)
  (caller policy, producer admission), [ADR-0048](./0048-file-service-architecture.md) (callers vs users). Design detail:
  [audit-service SDD](../sdd/audit-service.md). Decisions, inventory, threat model and roadmap:
  [Stage 18.1](../architecture/stage-18/stage-18-1-decisions-and-roadmap.md).

> **Amended by [ADR-0050](./0050-platform-administration-and-verified-human-authority.md)** (2026-09-26, Stage 19.1; for one read path only; the rest of this ADR stands): A6, A36b and A57 are amended so that a Company **owner**, with their own bearer, may read the records of **one organization of their own Company** per request. Audit verifies the owner and the organization through **Auth only** (never organization-service), and records `platform_query.executed` with the verified owner as actor, in the read's transaction, failing closed. Ingestion and service-token reads stay Auth-free. Null-organization records stay service-only. Not implemented until Stage 19.3.

## Context

Core needs cross-platform accountability evidence: who changed a membership, suspended an organization, revoked an operator's
assignment, deleted a file, or moved a subscription to grace. Evidence exists today only in fragments, each authoritative for its own
domain: Auth's append-only `auth_audit_event` (security, with IPs, no organization column, written in the business transaction),
Organization's `admin_actor_event`, Billing's enforced `billing_transition`. The Core ADD already reserves an `audit-service` fed by
events, never a synchronous dependency, with Auth keeping its local audit. The kit provides a transactional outbox, an at-least-once
RabbitMQ bus with retry and dead-letter queues, and an inbox; Billing and Payment use them; Organization, Notification and File have the
outbox table but emit nothing; Auth publishes fire-and-forget with no outbox.

The risks run both ways: an audit trail that is a copy of logs and domain tables (noisy, sensitive, unbounded, a cross-tenant database),
or one that silently loses the security evidence it exists for, or couples every business action to Audit's availability.

## Options considered

1. **Synchronous HTTP ingestion.** Rejected: Audit's outage would fail business actions, or evidence would be lost between commit and
   call; contradicts the ADD's events-only rule.
2. **Audit consumes existing domain events and infers audit meaning.** Rejected: domain events carry no verified actor, sometimes carry
   contact data, and Audit would own business meaning.
3. **Producer-owned audit events through the transactional outbox and RabbitMQ (chosen).**
4. **Centralize domain histories into Audit.** Rejected: domains keep their authority (billing_transition, auth_audit_event).

## Decision

1. `audit-service` stores **accountability evidence**, not logs, metrics or domain history; domains remain the authorities of their
   state and history; Audit never reconstructs business truth (A1–A5, A62–A64).
2. The **owning service** decides audit-worthiness against a selection rule and emits a cataloged event; Audit validates, stores,
   retains and serves queries (A7, A17).
3. **Delivery:** the kit outbox in the **same transaction** as the change, relayed to `nawara.events` as `audit.<action>`, consumed from
   one durable queue with the kit retry / DLQ. The business action succeeds while Audit is down, and cannot commit without its audit
   intent. Producers without an atomic outbox (Auth today) do not emit centrally until they have one (A16–A19).
4. **Envelope:** the kit envelope unchanged, with a canonical audit payload (action, actor, organization, resource, subject, outcome,
   bounded changes, causation) (A14).
5. **Identity and idempotency:** (`sourceService`, `eventId`) unique; duplicates are no-ops; a conflicting duplicate is dead-lettered
   (A15, A48).
6. **Actors:** `user` (with `userKind` member / owner / operator), `service`, `system`; actor ≠ source service; only verified actors
   (A9, A10). **Organization** is resource-derived; null is platform-level, never a wildcard (A11).
7. **Storage:** its own database, one append-only `audit_record` table, runtime `INSERT` / `SELECT` only; no cryptographic tamper
   evidence in V1 (trigger-based future) (A23–A26, A45, A46).
8. **Data minimization:** no free-form metadata, catalog-bounded changes, no secrets (producer duty + Audit defenses), identifiers only,
   no IP / user agent centrally (A27–A32).
9. **Query:** service-token callers with a deny-by-default policy; organization scope (exactly one organization) vs platform scope;
   bounded filters, keyset pagination, time windows, rate limits; platform queries recorded; no synchronous Auth dependency (A35–A40,
   A57, A66).
10. **Retention:** per category, purged only by a separate maintenance role; durations and erasure policy are owner / legal decisions
    (A41, A42). No partitioning or archive in V1, with stated triggers (A43, A44).
11. **Producer order:** Payment, Billing, Organization, File, then Auth after it adopts the kit outbox (A70).

## Consequences

- Business availability never depends on Audit; evidence of cataloged actions is durable from the business commit.
- Every producer gains a small obligation: catalog entries and one outbox write per audited action; Organization, File and Notification
  need a relay (File a bus); Auth needs an outbox before it can contribute (its local audit keeps the evidence meanwhile).
- Until per-service broker identities exist (production prerequisite), a producer's identity on the bus is asserted; the catalog binding
  limits the damage and the residual is stated.
- Records are eventually consistent (seconds normally); queries promise no read-after-write.
- Follow-up: the audit-service SDD, the catalog document (18.4), Stages 18.2–18.10; owner decisions on retention durations, erasure
  policy and broker identity.

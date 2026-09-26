# 0052. Core V1 capability closure: a shared caller-policy mechanism, enforced Payment and Billing admission, durable Auth domain events

- **Status:** Accepted <!-- Proposed | Accepted | Rejected | Superseded by ADR-000X --> (2026-09-26, Stage 21.C.1: the architecture owner
  approved the design and resolved Q1 to Q6, recorded under "Owner resolutions" below. **Acceptance is a decision about architecture only:
  nothing is implemented.** Implementation is Stage 21.C.2; the Organization authority cutover is Stage 21.x.)
- **Date:** 2026-09-26
- **Deciders:** Anwar (project owner, architecture owner)

> **Related:** [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md) receives **Amendment 3** as a consequence of Q1.
> None of these is modified:
> - [ADR-0018](./0018-rabbitmq-as-async-message-broker.md) (Auth's fire-and-forget events);
> - [ADR-0033](./0033-service-to-service-authentication-and-user-identity.md) (service tokens);
> - [ADR-0034](./0034-shared-service-kit-and-api-conventions.md) (the service-kit);
> - [ADR-0037](./0037-reliable-events-outbox-inbox.md) (outbox and inbox; still Proposed, see "Dependency on ADR-0037");
> - [ADR-0039](./0039-organization-ownership-and-cross-service-migration-authority.md) and
>   [ADR-0040](./0040-organization-ownership-migration-decisions.md) (the Organization cutover);
> - [ADR-0046](./0046-notification-service-architecture.md) (D19: the Auth outbox deferral);
> - [ADR-0049](./0049-audit-trail-architecture.md) (Core-only audit producers).
>
> The full design, matrices and evidence are in the
> [Stage 21.C.1 design record](../architecture/stage-21/stage-21-c-1-capability-closure-design.md).

## Context

Stage 21 found **S21-1**: Payment and Billing authenticate service callers (ADR-0033), but they do not authorize them.
- Any registered token can create payments, invoices, products and prices.
- Any registered token can read any Organization's entitlement.
- The Organization named in a request is checked for uuid shape only.
- ADR-0042 already decided the answer: a per-target caller policy, deny by default, first-party producer admission (D3, AD-2), Platform
  scope (AD-3) and hierarchy validation (decision 5, A.3). None of it is built in Payment or Billing.

Five services (Organization, Notification, File, Audit and Release) already enforce an ADR-0042 caller policy. Each has its own
hand-written parser of the same `{"callers":{…}}` envelope, and none of them detects duplicate JSON keys. Their rules differ slightly:
- only some reject unknown properties or extra top-level keys;
- only some reject duplicate list values;
- one echoes configuration values in its errors.

Auth publishes its domain events fire-and-forget (ADR-0018; F14; ADR-0046 D19 deferred the outbox). Read from the source:
- An event can be lost after its transaction commits.
- One event (`admin.operator_confirmation_code_issued`) is queued **before** its transaction commits, so a rollback can still send it.
- Production runs with `AUTH_EVENTS=off`.

Auth already runs the service-kit outbox and relay for its audit evidence (migration `0010`, Stage 18.7.5).

The Organization authority cutover (ADR-0039, ADR-0040) is **not purely operational**. Auth's reference cache (`ensure`, an outbound
client to Organization Service, first-touch calls, the cache-write guard) and a cross-service export/import test are not implemented
(Stage 10.1 record §4, items 3 and 6).

The owner decided in Stage 21.C:
- **C1:** the Organization cutover is required for Core V1 and runs in 21.x.
- **C2:** product-owned Core Audit producers are post-V1.
- **C3:** a durable Auth outbox is required for Core V1.
- Also decided: no new Core V1 microservice.

## Options considered

**A. The caller-policy mechanism**
1. *A sixth and seventh hand-written parser (Payment, Billing).* Rejected: the same mechanics copied again, and the drift above grows.
2. *A caller-policy or authorization service with a central policy store.* Rejected: a runtime network dependency on every call, a second
   authority, and it contradicts ADR-0042 decision 2 (policy lives in each target).
3. *A small service-kit utility for the generic mechanics only; each service keeps its own dimensions and decisions.* **Chosen.**

**B. Validating an asserted Organization before the cutover**
1. *A service-facing hierarchy read in Auth.* Rejected by ADR-0042 Amendment 1 A.3: Auth exposes no service-facing validation endpoint.
2. *A temporary "trust the producer" mode that is switched off at cutover.* Rejected: AD-5 forbids any switch that disables hierarchy
   validation. It would also be an architecture to throw away.
3. *One contract from day one: always the Organization Service reference read. It fails closed while that service is not authoritative;
   a non-production fixture is refused in production.* **Chosen.** It is ADR-0042 A.3 as written.

**C. Durable Auth domain events**
1. *Keep fire-and-forget.* Rejected by C3.
2. *A central outbox service.* Rejected: Core has none; every producer keeps its outbox in its own database (the implemented kit
   pattern).
3. *Auth's existing kit outbox and relay for its domain events too; the legacy publisher is removed.* **Chosen.**

## Decision

1. **Caller-policy mechanism in `libs/service-kit`.** The kit owns only the generic mechanics:
   - the envelope;
   - the two-way cross-check against `SERVICE_TOKENS`;
   - deny by default;
   - rejection of unknown and duplicate keys;
   - explicit lists with no wildcard;
   - secret-safe startup errors;
   - an optional guard that checks one named operation for service callers.

   Services keep everything domain-specific: vocabularies, Platform scope, templates, products and operation names. **Shared mechanism ≠
   shared authorization policy.** Existing services may adopt the kit later (21.R2); nothing forces them to.
2. **Payment and Billing enforce ADR-0042 on this mechanism.**
   - **Payment:** `billing-service` may use `payment.create`, `payment.read` and `payment.cancel` (AD-2).
     - `auth-service` has **no** Payment authority (ADR-0042 Amendment 3).
     - No service may start or sync an attempt.
     - Every other service caller is denied.
   - **Billing:** it adopts the mechanism with its operations enumerated and **no caller admitted in V1** (ADR-0042 A.3), so its
     service-token surface is explicitly deny by default. A caller is admitted only through an explicit D3 policy and configuration
     decision.
   - Rate limiting stays and remains separate from authorization.
3. **Organization scope follows ADR-0042 decision 5, A.3 and A.5.**
   - **Which requests:** an Organization named by a service caller on a create, and the Organization in the entitlement read's path.
   - **How it is resolved:** through Organization Service's reference read (`GET /organization/reference/organizations/:id`), with a
     process-local memo of positive results only (permitted while I1 holds, ADR-0042 Amendment 2).
   - **How it is checked:** the target requires the resolved Platform to be inside the caller's explicit `allowedPlatforms`.
   - **Failure:** when Organization Service is unavailable or not yet authoritative, Organization-bearing creates and the entitlement read
     fail closed with **`503 hierarchy_unavailable`**, and no mutation occurs.
   - **No bypass:** there is no production bypass. The non-production fixture resolver cannot be enabled in production.
   - **Reads:** reads of a target's own records keep their existing object-level rules and never call Organization Service.
4. **Auth domain events go through Auth's existing transactional outbox.**
   - **Write path:** each event row is written in the same transaction as its change; nothing is emitted to the broker before the
     commit. Rows are relayed by the one kit relay Auth already runs and deduplicated by the consumer's existing identity check
     (`sourceService`, `sourceEventId`).
   - **Legacy publisher:** it is removed, so there is no dual emission.
   - **`AUTH_EVENTS`** (Q4): it controls **whether Auth writes its domain-event outbox rows**.
     - Enabled: qualifying events are written transactionally.
     - Disabled: no new rows are written.
     - Committed rows are always relayed.
     - Toggling never duplicates an event.
     - Production enablement is Stage 21.x.
5. **One-time-code events are sensitive, short-lived outbox data (Q3).** The rows of `member.contact_verification_requested`,
   `admin.operator_code_issued` and `admin.operator_confirmation_code_issued`:
   - are written atomically with their Auth transaction and published by the existing relay;
   - are **deleted after successful publication**, and **deleted unpublished once their code has expired**, by a bounded, observable
     (counts-only) purge that never touches any other row;
   - never appear in logs, metrics, errors, DLQ diagnostics or operational tooling output, and are never copied into Audit.

   **Storage:** plaintext codes are never kept as event history. There is no separate secrets store and no new service. One expand-only
   partial index migration is approved **only if** the implementation proves it is the minimal migration needed for a safe, efficient
   purge.
6. **Organization cutover prerequisites are 21.C.2 code (Q2, work package G):**
   - the Auth reference cache and `ensure` behaviour;
   - a hardened client to Organization Service;
   - the first-touch calls in the identified Auth administrative paths;
   - the Auth write guard;
   - the cross-service export/import certification test;
   - any minimal supporting code that ADR-0039/0040 prove necessary.

   The cutover itself is **not** redesigned and **not** performed in 21.C.2. It is Stage 21.x, under ADR-0040's gates G1 to G7.
7. **No new microservice, no new Audit action, and no broker contract change.** Product-owned Core Audit evidence stays post-V1 (C2).

## Owner resolutions (2026-09-26)

| ID | Question | Resolution |
|---|---|---|
| Q1 | `auth-service` admission to Payment | **REMOVE VIA ADR AMENDMENT**: ADR-0042 Amendment 3. The development Auth → Payment credential is retired in the 21.C.2 configuration work |
| Q2 | Cutover code gaps | **YES**: WP-G is added to 21.C.2 (Decision 6). The cutover itself is not performed there |
| Q3 | One-time-code events | **YES**: through the durable outbox, as sensitive short-lived data (Decision 5) |
| Q4 | `AUTH_EVENTS` | **KEEP**, with the new meaning in Decision 4 |
| Q5 | Billing admission | **CONFIRMED**: no service caller is admitted to Billing in Core V1; Billing still adopts the mechanism; Organization verification applies to its Organization-bearing operations |
| Q6 | Pre-cutover behaviour | **CONFIRMED**: production Organization-bearing creates fail closed (`503 hierarchy_unavailable`, no mutation) until Organization Service is authoritative. This is an intentional transition state |

## Dependency on ADR-0037 (recorded; not blocking)

ADR-0037 (outbox and inbox) is still **Proposed**. This ADR does **not** accept it and does not depend on any unresolved ADR-0037
decision:
- the outbox, relay and inbox it describes are implemented in the service-kit and certified;
- Accepted ADR-0046 and ADR-0049 already build on them;
- Auth's outbox table (`0010`) already exists.

Its "payloads contain no secret" line concerns its financial event catalog. The one-time-code exception for Auth's events was already
accepted by ADR-0046 and is bounded by Decision 5.

**Formally accepting ADR-0037 is carried to the 21.R1 architecture and quality review.**

## Consequences

- **Easier:**
  - S21-1 closes with no token redesign.
  - Every policy-enforcing service validates configuration the same way.
  - Auth's security alerts survive a broker outage or a crash.
  - No event can be emitted twice by two publishers.
  - The Organization cutover becomes executable in 21.x.
- **Harder, or given up:**
  - Payment and Billing creates depend synchronously on Organization Service for Organizations they have not seen before, which is the
    accepted ADR-0042 consequence.
  - Before the cutover, production Billing-to-Payment collection for Organization sellers is unavailable (Q6).
  - Codes wait up to one relay poll (about 1 s) before being published.
  - A code sits in Auth's database in plaintext only until it is published or it expires. Before, it was never stored in plaintext.
  - WP-G is a significant (Class C) Auth change.
- **Follow-up:**
  - 21.C.2 implements work packages A to G; 21.C.3 certifies them.
  - 21.x performs the cutover and the production configuration.
  - Once implemented: F14 and ADR-0046 D19 close; production-readiness is updated; the payment SDD (O-13 to O-15) and billing SDD
    (B-029) gates are updated.

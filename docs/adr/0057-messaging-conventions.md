# 0057. Messaging conventions

- **Status:** Proposed
- **Date:** 2026-10-08
- **Deciders:** Anwar (project owner, architecture owner)

> **Core V2 A3M.1** ([A3M record](../architecture/core-v2-a3m-messaging.md)). The owner approved writing this ADR (OD-A3M-1); its
> acceptance is a separate, explicit decision. Until then it is the reviewable statement of the messaging conventions. It reconciles
> [ADR-0018](./0018-rabbitmq-as-async-message-broker.md) and [ADR-0037](./0037-reliable-events-outbox-inbox.md) (both still Proposed)
> and follows the Accepted [ADR-0046](./0046-notification-service-architecture.md) rule 17,
> [ADR-0049](./0049-audit-trail-architecture.md), [ADR-0052](./0052-core-v1-capability-closure.md),
> [ADR-0053](./0053-core-v1-production-rabbitmq.md) and [ADR-0056](./0056-core-architecture-and-api-conventions.md). Where this ADR and
> an Accepted ADR differ, the Accepted ADR wins until this one is Accepted.

## Context

Core services exchange events over RabbitMQ through the service-kit: a transactional outbox and relay on the producer side, the
`RabbitMqEventBus` with retry and dead-letter queues on the consumer side. The behaviour is implemented, tested and partly in production
(the Auth → Audit relay), but its rules are spread over code comments, stage records and two Proposed ADRs that no longer describe it:
ADR-0018 still names `@golevelup/nestjs-rabbitmq` (no service uses it) and defers retry, dead letters and versioning (the kit implements
them); ADR-0037 lists event families nobody emits and says Auth publishes fire-and-forget (it has used the outbox since Stage 21.C.2).
ADR-0056 left event conventions to A3. The A3M.0 discovery (A3M record §1–§3) found the gaps G1–G10 that this ADR answers or records.

Labels, as in ADR-0056: **[CURRENT]** describes what the code does on `main` (2026-10-08, `e2adc20`); **[NEW]** is a convention approved
for work that comes later (A3M.2 onwards), not yet implemented; **[OPEN]** is an unresolved finding.

## Options considered

1. **One consolidated messaging ADR that states the current behaviour and the approved conventions, and reconciles 0018 and 0037 by
   forward notes.** Chosen (OD-A3M-1, OD-A3M-2).
2. *Forward notes on 0018 and 0037 only.* Rejected: neither ADR covers versioning, retry, dead letters, readiness or catalogs, and
   amending two stale documents keeps the conventions scattered.
3. *Rewrite 0018 and 0037 in place.* Rejected: records are never edited away; a departing design supersedes with a new ADR.

## Decision

### 1. Broker, exchange and routing

- **[CURRENT]** RabbitMQ through the kit's `RabbitMqEventBus` (`amqplib`); no other client library. One durable topic exchange,
  `nawara.events`; the **routing key is the event name**, verbatim. Local runs and unit tests may use the kit's `InMemoryEventBus` behind
  the same `EventBus` port. Production: one private node, one vhost, per-service identities (ADR-0053).

### 2. Event naming

- **[CURRENT]** A name is dotted lowercase, at least two segments, matching the kit's `EVENT_NAME`
  (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`), for example `payment.succeeded`. The outbox refuses any other name. Names are flat
  `entity.action`, never service-prefixed. Audit events are `audit.<action>` from the reviewed `@nawara/audit-contract` catalog
  (ADR-0049); no domain event uses the `audit.` prefix.
- **[CURRENT]** A published name is never renamed or reused for a different meaning.

### 3. Envelope

- **[CURRENT]** The AMQP **body is the flat JSON payload** (an object, at most 64 KiB), with no wrapper. Metadata travels in AMQP
  properties and headers:

  | Where | Field | Meaning |
  |---|---|---|
  | property | `messageId` | the event id (unique; the outbox row id) |
  | property | `type` | the event name |
  | property | `contentType`, `timestamp`, `persistent` | `application/json`, the occurrence time in seconds, persistent delivery |
  | header | `eventId` | the event id again |
  | header | `occurredAt` | ISO-8601 occurrence time |
  | header | `correlationId` | optional; the business operation's correlation id (ADR-0056 §8) |
  | header | `source` | the producing service, stamped by its relay |
  | header | `version` | the payload version, an integer (§5) |

  The kit adds `x-nawara-*` annotations on retry, dead-letter and replay copies; producers never set them.
- **[CURRENT]** Payloads carry opaque ids and plain facts only: never secrets, tokens, card or bank data. Events that must carry a
  one-time code for delivery are the documented exception of ADR-0052 decision 5 (their outbox rows are purged, §10).
- **[CURRENT]** `source` is **asserted** by the producer, not verified by the broker: per-service identities and topic grants narrow
  who can publish what (ADR-0053 §4), and the residual (one producer publishing under another's `source` inside its grant) is accepted
  there. A consumer that depends on the producer checks `source` against the producer it expects for that event name (§7).

### 4. Delivery guarantee

- **[CURRENT]** **At least once.** A producer writes the event in its `outbox` **in the same transaction** as the state change
  (`OutboxService.enqueue` takes the transaction's client and never touches the network, so a broker outage never fails a business
  operation). The kit `OutboxRelay` claims unpublished rows (`FOR UPDATE SKIP LOCKED`), publishes with **publisher confirms** and
  stamps a row only once the broker confirmed it; a failed or unconfirmed publish is retried with exponential backoff (ceiling 15 s).
  A confirm timeout means "not known to be stored", so the row is sent again. Consumers therefore receive duplicates and must tolerate
  them (§7).
- **[CURRENT]** The relay publishes without `mandatory`: a message whose routing key no queue is bound to is confirmed and dropped by
  the broker. Deployment order guarantees that a consumer's queue and bindings exist before its producers relay (ADR-0053 §5).
- **[CURRENT]** A producer may supply the event id to make a retried business operation write its event once (the outbox ignores a
  second row with the same id); Billing, File and Payment derive such ids deterministically.

### 5. Versioning

- **[CURRENT]** Every event carries `version` (the outbox default is 1; every event published today is version 1). A consumer that
  receives no `version` header reads it as 1.
- **[NEW]** An **additive** payload change (a new optional field) keeps the version; consumers ignore unknown fields. A **breaking**
  change (a removed, renamed or retyped field, or a changed meaning) is published as **version + 1 under the same name**; the producer
  publishes both versions until every consumer handles the new one, and the transition is planned per event, never by changing a
  published version in place.
- **[NEW]** A consumer **checks `version`** and refuses a version it does not support as a permanent failure (dead-lettered for an
  operator, never retried). Notification does so today (`unsupported_version`); the other consumers adopt it in A3M.2 and A3M.3.

### 6. Producer responsibilities

- **[CURRENT]** Events only through the outbox, in the business transaction; one relay per producing service, stamping its `source`.
- **[NEW]** Each event a service produces is listed in that service's own event catalog (§11).
- **[CURRENT]** An outbox-backed producer stays **ready while the broker is unavailable**: durable local acceptance (the outbox write)
  still works and the backlog is relayed when the broker returns. Payment's broker readiness check is the one exception (finding S21-5);
  aligning it is later A3M work (OD-A3M-4).

### 7. Consumer responsibilities and deduplication

- **[CURRENT]** A consumer owns one or more durable queues and binds only the names it handles. Prefetch is bounded by its database pool
  (`min(10, max(1, floor(poolMax / 2)))` in Audit, Notification and Billing), so a backlog never takes the whole pool.
- **[CURRENT]** Every consumer de-duplicates **durably**: Audit by `(sourceService, eventId)` (`insertOnce`, required by ADR-0049 §5),
  Notification by `(sourceService, sourceEventId)` (after matching the event to its expected source, `mappingFor(source, name)`), Billing
  by `eventId` in `payment_event_receipt` (and it refuses a `source` other than `payment-service` as a conflict). No service uses the
  kit's `InboxService`.
- **Binding today (Accepted ADRs, unchanged by this ADR):** [ADR-0056](./0056-core-architecture-and-api-conventions.md) §7 states, as
  [CURRENT], that a consumer's idempotency contract is its de-duplication "by event id in an inbox"; ADR-0049 §5 requires Audit's
  `(sourceService, eventId)` uniqueness. Those texts govern until changed by an Accepted ADR.
- **[NEW, Proposed]** (OD-A3M-3) The broader policy this ADR proposes: a consumer may use a **domain-specific durable de-duplication
  record** instead of the kit inbox, provided that its identity includes the **event id and a verified source** (the source checked
  against the producer expected for that event name, §3), and that the record **commits atomically, in one transaction, with the business
  effect**. The kit `InboxService` stays available and optional. Under this policy the "inbox" of ADR-0056 §7 would mean any durable
  de-duplication record meeting both conditions. That interpretation is **not in force**: it takes effect only if the owner explicitly
  accepts this ADR (or amends ADR-0056); until then this ADR does not override ADR-0056. Whether each existing consumer meets both
  conditions (for example Billing keys its receipt on `eventId` alone and checks the source separately) is assessed in A3M.3, not assumed.
- **[CURRENT]** **Ordering is not guaranteed** (ADR-0037): redelivery, retry delays and several relay instances reorder events. A
  consumer validates the state it is about to change (for example Billing applies a payment outcome only to a payment request in a state
  that accepts it) and never assumes the previous event arrived first.
- **[CURRENT]** A handler signals "can never succeed as it stands" with `PermanentEventFailure` and a short stable reason code (no payload
  data); any other error is treated as possibly transient.

### 8. Retry and dead letters (as implemented)

- **[CURRENT]** Per consumer queue `Q`, the kit declares `Q` (work queue, `x-dead-letter-exchange = nawara.events.dlx`), `Q.retry` (a
  delay queue with no consumer that expires messages back into `Q`) and `Q.dead` (durable dead-letter queue, bound to the **fanout**
  exchange `nawara.events.dlx`).
- **[CURRENT]** A rejected delivery is retried up to `maxRetries` times (default 3) after `delayMs` (default 5 s) each, through a
  confirmed copy in `Q.retry`; a permanent failure, a malformed message or exhausted retries produce a **confirmed, annotated copy** in
  `Q.dead` (`x-nawara-failure`, `-failure-reason`, `-failure-error`, `-failed-at`, `-consumer`, `-retry-count`), then the original is
  acknowledged. A consumer that must not store untrusted content (Audit) sets a `deadLetterPolicy` that keeps only chosen headers and can
  redact the body (Stage 18.8); for such a consumer, a copy that cannot be confirmed is **held for the retry delay and requeued**, never
  dead-lettered raw (Stage 18.9).
- **[CURRENT]** Operators inspect a `.dead` queue without consuming and replay **one** message into the work queue that the `.dead` name
  implies (`nawara-dlq`); `nawara-check-dlq` and `nawara-check-outbox-lag` report depth and lag; the A12 metrics cover publishes, consumer
  outcomes and outbox lag.
- **[OPEN] G7.** For a consumer **without** a `deadLetterPolicy`, when the annotated copy cannot be confirmed, the bus calls
  `nack(requeue = false)` and lets the broker dead-letter the original through `nawara.events.dlx`. Because that exchange is a fanout
  shared by every `.dead` queue in the vhost, the original would be copied, unannotated, into **every** consumer's dead-letter queue,
  including one whose policy redacts (Audit). This is **unverified**: it is a potential defect until a deterministic multi-consumer broker
  test establishes the behaviour (A3M record §7). It is latent in production today, where Audit is the only consumer. If confirmed, the
  preferred remedy is **R1, code only**: remove the `nack(requeue = false)` fallback and use the bounded hold-and-requeue of Stage 18.9
  for every consumer, keeping each message with its own consumer and the production topology unchanged, after its reliability and
  liveness trade-offs are verified (OD-A3M-5). A topology change (R2 a per-queue dead-letter exchange, R3 a non-fanout one) needs separate
  owner authorization (§12).

### 9. Queue naming

- **[CURRENT]** Existing queue names are fixed and stay as they are: `audit-service.audit` (ADR-0049, ADR-0053), `notification.events`
  (ADR-0053), `billing.payment-events`.
- **[NEW]** A **new** queue is named `<consuming-service>.<purpose>`, using the service's directory name (for example
  `notification-service.events`), in lowercase dotted segments; `.retry` and `.dead` are reserved suffixes the kit adds.

### 10. Retention (OD-A3M-6)

- **[CURRENT]** Published outbox rows and inbox rows are never deleted (production-readiness F12), except Auth's code-bearing event rows,
  which `CodeEventPurge` deletes once published or expired: an **active security control** (ADR-0052 decision 5), not F12 retention, and
  it stays on.
- **[NEW]** Any outbox or de-duplication cleanup is **off by default** and enabled per service only by a separate authorization. A
  producer's outbox retention is never shorter than the period in which it can re-emit a deterministic event id, and a consumer's
  de-duplication retention is never shorter than the producer's: deleting a published row while its business operation can still be
  retried would publish the event again, and only the consumer's de-duplication record would stop the duplicate. No duration is chosen
  here; durations follow the retention / RPO decision (production-readiness §3). Audit record retention is ADR-0049 §10 and A13, never F12.

### 11. Event catalogs (OD-A3M-7)

- **[NEW]** Each producing service keeps a **per-service event catalog** in its own source (name, version, payload fields, intended
  consumers); each consuming service declares the names and versions it handles. A repository guard (`check:repo`) checks consistency
  between them **as text**, without cross-application imports (ADR-0056 §2). Domain event contracts never go into `libs/service-kit`
  (technical infrastructure only); a shared event-contract library would need its own architecture decision. Audit events keep their
  existing catalog in `@nawara/audit-contract`.

### 12. Binding production constraints (ADR-0053)

- **[CURRENT]** The production exchange names (`nawara.events`, `nawara.events.dlx`), the dead-letter exchange's type (fanout), the
  existing queue names and their arguments (`audit-service.audit` with `x-dead-letter-exchange = nawara.events.dlx`) are part of the
  deployed topology. RabbitMQ refuses to re-declare an exchange or queue with a different type or arguments, so changing any of them
  is a **production migration** (drain, re-create, re-provision the grants), never a side effect of a code change.
- **[CURRENT]** Every broker participant needs an ADR-0053 identity with grants derived from what the kit does; a new binding or a new
  publisher widens a grant deliberately. Enabling `AUTH_EVENTS` in production, identities for Billing, Payment or Notification, and any
  retention activation are separately authorized production work.

## Consequences

- One reviewable statement of how Core services exchange events; [CURRENT] rules describe `main`, so this ADR changes no behaviour.
- New work has a convention to follow: versioned payloads with supported-version checks, per-service catalogs and a guard (A3M.2),
  consumer conventions and Payment's readiness (A3M.3), the G7 proof and its remedy (A3M.4), retention design (A3M.5).
- ADR-0018 and ADR-0037 gain forward notes to this ADR; their content and status are unchanged, and their disposition remains an
  explicit owner decision (OD-A3M-2). On acceptance of this ADR the owner may mark them partially superseded.
- G7 stays recorded as open until the broker test establishes it.

## Relationship to other ADRs

| ADR | Relationship |
|---|---|
| [0018](./0018-rabbitmq-as-async-message-broker.md) RabbitMQ (Proposed) | **reconciles**: keeps the exchange, the routing key and the flat body; replaces the client library and the deferral of retry, dead letters and versioning (§1, §5, §8). Supersession only on acceptance |
| [0037](./0037-reliable-events-outbox-inbox.md) outbox and inbox (Proposed) | **reconciles**: keeps the outbox, the headers and at-least-once delivery; proposes generalizing the inbox (§7, on acceptance); its event-family list is historical (§2) |
| [0046](./0046-notification-service-architecture.md) rule 17 | **follows**: the kit bus and the canonical header envelope |
| [0049](./0049-audit-trail-architecture.md) audit trail | **follows**: `audit.<action>`, `(sourceService, eventId)` uniqueness, data minimization, the redacting dead-letter policy |
| [0052](./0052-core-v1-capability-closure.md) decisions 4–5 | **follows**: `AUTH_EVENTS`; code-bearing events and their purge |
| [0053](./0053-core-v1-production-rabbitmq.md) production RabbitMQ | **follows**: topology, identities and deployment order are binding (§12) |
| [0056](./0056-core-architecture-and-api-conventions.md) conventions | **follows**, and does not override: no new HTTP endpoint (readiness and health stay §10); ADR-0056 §7's inbox wording stays binding; the broader de-duplication interpretation of §7 above applies only if this ADR is accepted or ADR-0056 is amended |

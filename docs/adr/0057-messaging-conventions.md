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

> **Core V2 S0 revision (2026-10-21).** §13 (producer authenticity and provenance) and the [S0] items in §7 and §8 were added by the
> Core V2 S0 architecture freeze ([S0 record](../architecture/core-v2-s0-architecture-freeze.md)), which is the decision P-A1 / A14
> that §7 leaves open. The owner approved their direction and wording at S0; nothing in them is implemented, and this ADR's status
> stays `Proposed` until the owner changes it explicitly. Every [CURRENT] statement below still describes `main`.

> **Core V2 S0 clarification (2026-10-23, owner-approved).** The owner approved one normative clarification of §13 for the Audit
> consumer (S1b-2): admission checks before provenance (§13.2, "Audit admission"), with cross-references in §13.4 and §13.8. It changes
> no other consumer, the provenance tuple or §13.3, and it is not an acceptance: this ADR's status stays `Proposed`.

> **Core V2 S0-C2 normative revision (2026-10-23, owner-approved).** For the Notification consumer only, the body element of the §13.2
> tuple is a keyed commitment (HMAC-SHA-256 under a Notification provenance key) instead of an unkeyed SHA-256 (§13.2, "S0-C2"), with
> the consequences in §13.3, §13.4 and §13.8. Every other consumer, S0-C1 and the rest of §13 are unchanged. Nothing is implemented,
> and this is not an acceptance: this ADR's status stays `Proposed`.

> **Core V2 S0-C3 clarification (2026-10-23, owner-approved).** The rollout of §13.4: S1c computes the replay classification in
> observe-only mode and S1e enforces it per consumer ("S0-C3" in §13.4), with the Notification evidence classification it needs (§13.2,
> S0-C2), the open re-emission decision (§13.7) and the key dependency (§13.8). The §13.4 requirement itself is unchanged. Nothing is
> implemented, and this is not an acceptance: this ADR's status stays `Proposed`.

> **Core V2 S0-C4 clarification (2026-10-23, owner-approved; resolves OD-15 for Payment-first only).** The meaning of a §13.7
> re-emission against §13.6, and its Payment-first mechanism, eligibility and serialization requirement ("S0-C4" after §13.7). §13.6 and
> §13.7 are unchanged; the architecture is approved, its implementation is not started and nothing is authorized in production. This is
> not an acceptance: this ADR's status stays `Proposed`.

> **Core V2 S0-C5 clarification (2026-10-23, owner-approved).** How the §13.1 topic-write permissions are generated, which families are
> granted, and what they do not protect ("S0-C5" after §13.1). §13.1 is unchanged; S1d is planned in four slices, nothing is
> implemented, no broker permission is changed and nothing is authorized in production. This is not an acceptance: this ADR's status
> stays `Proposed`.

> **Core V2 S0-C6 clarification (2026-10-23, owner-approved).** The S1e per-consumer enforcement policies that S0-C3 left to S1e: the
> outcome of every trust classification for Billing, Audit and Notification, enforcement before business de-duplication, the trusted
> replay tuple, privacy-safe refusal, and Audit's temporary compatibility phase ("S0-C6" after §13.5). §13.2–§13.5 are unchanged;
> nothing is implemented or enabled, and nothing is authorized in production. This is not an acceptance: this ADR's status stays
> `Proposed`.

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
  operator, never retried). Notification does so today (`unsupported_version`); Billing since A3M.2 (before any receipt or decision).

### 6. Producer responsibilities

- **[CURRENT]** Events only through the outbox, in the business transaction; one relay per producing service, stamping its `source`.
- **[NEW]** Each event a service produces is listed in that service's own event catalog (§11).
- **[CURRENT]** An outbox-backed producer stays **ready while the broker is unavailable**: durable local acceptance (the outbox write)
  still works and the backlog is relayed when the broker returns. Payment, the one exception (finding S21-5), was aligned in A3M.3:
  its broker check is removed; broker trouble shows in the outbox metrics and alerts (`OutboxBacklogAging`, `OutboxStatsStale`) and
  `nawara-check-outbox-lag`, never in a producer's `/ready`. Consumers keep reporting the broker.

### 7. Consumer responsibilities and deduplication

- **[CURRENT]** A consumer owns one or more durable queues and binds only the names it handles. Prefetch is bounded by its database pool
  (`min(10, max(1, floor(poolMax / 2)))` in Audit, Notification and Billing), so a backlog never takes the whole pool.
- **[CURRENT]** Every consumer de-duplicates **durably**: Audit by `(sourceService, eventId)` (`insertOnce`, required by ADR-0049 §5),
  Notification by `(sourceService, sourceEventId)` (after matching the event to its expected source, `mappingFor(source, name)`), Billing
  by `eventId` in `payment_event_receipt`, **where only an `applied` receipt claims the event id** (since A3M.3, migration 0016; G11),
  after refusing a `source` other than `payment-service` before any receipt. No service uses the kit's `InboxService`.
- **[CURRENT]** **Only an applied effect claims an event id** (A3M.3, finding G11): a delivery that does not apply (ignored, deferred,
  conflict) may be recorded, but it never makes a later delivery of the same id a replay; that delivery is decided on its own merits.
  Event ids can be predictable (deterministic ids) and any publisher can set any header, so a record that blocks later deliveries is
  written only once the effect is applied, in the same transaction.
- **[CURRENT]** **The `source` header is asserted, not authenticated.** Checking it (Billing, Notification) filters obvious mistakes;
  it is not producer identity: RabbitMQ does not validate headers, and a consumer identity may publish to any queue through
  `amq.default` (ADR-0053 §4). Integrity rests on each consumer's own facts (Billing applies an outcome only if it matches what Billing
  recorded through its authenticated calls) and on the rule above. Broker-enforced publisher identity (AMQP `user_id`, signing) would be
  new authentication infrastructure and needs its own decision (P-A1 / A14).
- **[S0, not implemented]** That decision is §13: broker-enforced `user_id`, generated topic permissions and first-intake
  provenance. Each consumer's durable de-duplication record keeps the event id **and the verified source** (the OD-A3M-3 conditions
  below), and a consumer that uses the kit `InboxService` keys it by (`source`, `eventId`).
- **[CURRENT]** The per-component idempotency matrix (event identity, atomicity, duplicates, failures, crash recovery, with the test
  behind each row) and the open findings F1 to F7 are in the [A3M record](../architecture/core-v2-a3m-messaging.md) §13. Transport is
  at least once; business effects are idempotent per consumer; an external notification send is never exactly once.
- **Binding today (Accepted ADRs, unchanged by this ADR):** [ADR-0056](./0056-core-architecture-and-api-conventions.md) §7 states, as
  [CURRENT], that a consumer's idempotency contract is its de-duplication "by event id in an inbox"; ADR-0049 §5 requires Audit's
  `(sourceService, eventId)` uniqueness. Those texts govern until changed by an Accepted ADR.
- **[NEW, Proposed]** (OD-A3M-3) The broader policy this ADR proposes: a consumer may use a **domain-specific durable de-duplication
  record** instead of the kit inbox, provided that its identity includes the **event id and a verified source** (the source checked
  against the producer expected for that event name, §3), and that the record **commits atomically, in one transaction, with the business
  effect**. The kit `InboxService` stays available and optional. Under this policy the "inbox" of ADR-0056 §7 would mean any durable
  de-duplication record meeting both conditions. That interpretation is **not in force**: it takes effect only if the owner explicitly
  accepts this ADR (or amends ADR-0056); until then this ADR does not override ADR-0056. Whether each existing consumer meets both
  conditions was assessed in A3M.3: Billing now refuses a wrong source before any receipt and claims the id only on an applied effect.
- **[CURRENT]** **Ordering is not guaranteed** (ADR-0037): redelivery, retry delays and several relay instances reorder events. A
  consumer validates the state it is about to change (for example Billing applies a payment outcome only to a payment request in a state
  that accepts it) and never assumes the previous event arrived first.
- **[CURRENT]** A handler signals "can never succeed as it stands" with `PermanentEventFailure` and a short stable reason code (no payload
  data); any other error is treated as possibly transient. Permanent today: a malformed envelope or payload (`malformed_envelope`,
  `malformed_payload`), an unsupported version (`unsupported_version`), an unexpected source (`wrong_source`, Billing), an identifier
  the database refuses (`invalid_identifier`). Transient: anything else (a lost connection, a deadlock, a timeout). A business outcome
  that changes nothing (ignored, deferred, a state conflict) is not a failure: it is acknowledged and recorded.
- **[CURRENT]** (A3M.6) These refusals are proven over a real broker: Billing dead-letters `unsupported_version` and `wrong_source` once,
  before any receipt; a forged message carrying a genuine Payment event id is recorded as a conflict and does not stop the genuine event
  from applying (G11); Notification dead-letters an unmapped source. The 16-scenario evidence matrix and its one documented limitation
  (a broker restarted mid-flow) are in the [A3M record](../architecture/core-v2-a3m-messaging.md) §15.

### 8. Retry and dead letters (as implemented)

- **[CURRENT]** Per consumer queue `Q`, the kit declares `Q` (work queue, `x-dead-letter-exchange = nawara.events.dlx`), `Q.retry` (a
  delay queue with no consumer that expires messages back into `Q`) and `Q.dead` (durable dead-letter queue, bound to the **fanout**
  exchange `nawara.events.dlx`).
- **[CURRENT]** A rejected delivery is retried up to `maxRetries` times (default 3) after `delayMs` (default 5 s) each, through a
  confirmed copy in `Q.retry`; a permanent failure, a malformed message or exhausted retries produce a **confirmed, annotated copy** in
  `Q.dead` (`x-nawara-failure`, `-failure-reason`, `-failure-error`, `-failed-at`, `-consumer`, `-retry-count`), then the original is
  acknowledged. A consumer that must not store untrusted content (Audit) sets a `deadLetterPolicy` that keeps only chosen headers and can
  redact the body (Stage 18.8). A copy that cannot be confirmed is **held for the retry delay and requeued** to the consumer's own queue,
  never dead-lettered raw: since Stage 18.9 for a consumer with a policy, and since A3M.4 (G7, below) for every consumer.
- **[CURRENT]** Operators inspect a `.dead` queue without consuming and replay **one** message into the work queue that the `.dead` name
  implies (`nawara-dlq`); `nawara-check-dlq` and `nawara-check-outbox-lag` report depth and lag; the A12 metrics cover publishes, consumer
  outcomes and outbox lag.
- **G7: confirmed, remedied in code by A3M.4 (R1).** Before A3M.4, for a consumer **without** a `deadLetterPolicy`, an annotated copy
  that could not be confirmed made the bus call `nack(requeue = false)`, and the broker dead-lettered the original through
  `nawara.events.dlx`, a fanout shared by every `.dead` queue in the vhost. A deterministic multi-consumer broker test reproduced it
  locally (A3M record §7): the **raw** original (body unredacted) reached a bystander consumer's dead-letter queue whose policy
  redacts, and **left its own consumer** (its work and dead-letter queues both empty). The remedy, R1, is code only: that fallback is
  removed, and every consumer holds the delivery for its retry delay and requeues it to its own queue (`dead_letter_deferred`), the
  Stage 18.9 behaviour; the same test now passes as a regression guard. The production topology is unchanged; it was latent in
  production, where Audit (which has a policy) is the only consumer. **Residuals:** the fanout still exists, so a broker-side
  dead-lettering that does not come from the kit (an operator's TTL or max-length policy on a work queue) would still fan out, and a
  consumer identity may publish to `nawara.events.dlx` (ADR-0053 §4); a topology change (R2 a per-queue dead-letter exchange, R3 a
  non-fanout one) needs separate owner authorization (§12). While a dead-letter queue keeps refusing copies, a failing message cycles
  (one prefetch slot per retry delay) instead of being parked; the `DeadLetterCopyFailing` alert reports it (A3M record §7).
- **[S0, not implemented]** A retry (`Q.retry` expires back into `Q` through the default exchange), an operator replay
  (`nawara-dlq`) or any other delivery that arrives through the default exchange carries no broker-verified producer identity. Such a
  delivery is processed only under §13.4; a replay never establishes provenance.

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
- **[CURRENT]** (A3M.5) Consumer de-duplication records are **kept**: a dead-lettered message can be replayed at any later time, so no
  safe deletion horizon exists for them (Billing receipts, Notification intents, Audit records each stay under their own rules). The
  only cleanup that exists is manual: `nawara-outbox-retention`, a dry run unless `--apply`. A row is eligible only when **all** of
  these hold: its service is on the reviewed list (auth-service and organization-service, deny by default), its id is a random
  version-4 uuid, it is published, and it is older than an age the operator must give (no duration is selected here). The `--service`
  argument is an assertion, not authenticated publisher identity: the CLI ties it to the database through the owner role ADR-0032
  provisions. A version-4 id is not in itself evidence of deletion safety (a producer could supply a stable one), so a producer that
  changes how it makes its event ids needs a retention-safety review; `check:repo` catches the direct forms. Nothing schedules the
  command and no automatic cleanup exists; every deletion on a real database is separately authorized
  ([A3M record](../architecture/core-v2-a3m-messaging.md) §14).

### 11. Event catalogs (OD-A3M-7)

- **[NEW]** Each producing service keeps a **per-service event catalog** in its own source (name, version, payload fields, intended
  consumers); each consuming service declares the names and versions it handles. A repository guard (`check:repo`) checks consistency
  between them **as text**, without cross-application imports (ADR-0056 §2). Domain event contracts never go into `libs/service-kit`
  (technical infrastructure only); a shared event-contract library would need its own architecture decision. Audit events keep their
  existing catalog in `@nawara/audit-contract`.
- **A3M.2 status:** implemented as `apps/<service>/src/events/event-catalog.ts` rendered to `apps/<service>/contracts/events.json`
  (auth, payment, billing, notification; Notification's rendered from its intake `EVENT_MAP`), Auth's emission typed from its catalog,
  and `checkEventContracts` in `check:repo` ([A3M record](../architecture/core-v2-a3m-messaging.md) §11). This ADR stays Proposed.

### 12. Binding production constraints (ADR-0053)

- **[CURRENT]** The production exchange names (`nawara.events`, `nawara.events.dlx`), the dead-letter exchange's type (fanout), the
  existing queue names and their arguments (`audit-service.audit` with `x-dead-letter-exchange = nawara.events.dlx`) are part of the
  deployed topology. RabbitMQ refuses to re-declare an exchange or queue with a different type or arguments, so changing any of them
  is a **production migration** (drain, re-create, re-provision the grants), never a side effect of a code change.
- **[CURRENT]** Every broker participant needs an ADR-0053 identity with grants derived from what the kit does; a new binding or a new
  publisher widens a grant deliberately. Enabling `AUTH_EVENTS` in production, identities for Billing, Payment or Notification, and any
  retention activation are separately authorized production work.

### 13. Producer authenticity and provenance (Core V2 S0, not implemented)

13.1 A publisher sets the AMQP `user_id` property to its own broker username; broker users have no impersonation tag, so the broker
refuses a mismatch. Topic-write permissions are generated per producer from the audit catalog and the event-family table: Auth
domain events (auth-service); `invoice.*` and `billing.*` (billing-service); `payment.*` and `refund.*` (payment-service); and each
producer's own `audit.*` actions only. Consumers read exact names (Notification) or their own families.

**S0-C5 — broker topic permissions (S0 clarification, owner-approved 2026-10-23; S1d).**
- **Five layers, each with its own job.** (1) The broker-authenticated connection identity (one user per service, ADR-0053 §4, no
  impersonator tag). (2) Resource permissions: which exchanges and queues an identity may configure, write to and read from. (3) Topic
  permissions on the topic exchange `nawara.events`: which routing keys it may publish (write) and bind (read). (4) The AMQP `user_id`
  check (§13.1, S1a): the broker refuses a `user_id` that differs from the authenticated user; it does **not** require one, so a message
  without `user_id` is accepted and is unverified for its consumers (§13.2 `missing_user_id`). (5) Consumer provenance (§13.2–§13.4),
  observe-only until S1e. Topic permissions decide which keys reach the topic exchange; they authenticate no message that arrives in a
  work queue by any other path, and they never replace (4) or (5).
- **Exact, catalog-driven grants (H1).** A producer's topic-write grant is the exact set of routing keys it is entitled to publish: the
  events its own event contract declares as produced (`apps/<service>/contracts/events.json`, `produces`) and the audit actions the
  audit catalog (`libs/audit-contract`) assigns to it as `producer`, each routed as `audit.<action>`. A consumer's topic-read grant is the
  exact set of binding keys of its reviewed subscriptions (Notification's intake names; Audit's `audit.#`; Billing's consumed Payment
  events). Generated names are escaped and anchored (`^(a\.b|c\.d)$`); a prefix, wildcard or unescaped value never widens a grant, and no
  producer holds every `audit.*` key. The families named in §13.1 state **ownership** (who may ever be granted an event of that family),
  not grants: a family with no declared event (today `billing.*` and `refund.*`) grants nothing, and a declared event is granted only to
  its family owner. The contracts and the catalog are the source of truth; when they are missing, inconsistent, ambiguous (two owners
  for one key) or invalid, generation fails closed. No event is invented to fill a family. A new event is granted only through a reviewed
  permission change provisioned before its producer publishes it.
- **Activated families only (H2).** A declared domain-event family is granted only when an explicit, reviewed activation manifest (or an
  equivalent trustworthy, reviewed configuration) records it as active for that environment; never from a developer's environment, an
  unset flag, a runtime string or an undocumented default, and an unknown activation state fails closed. Today Auth's domain events are
  not active in production (`AUTH_EVENTS=off`; enabling it is separately authorized production work, §12): Auth is granted its audit
  actions only. Activating a family follows this order:
  the event contract is approved; the exact grants are generated and reviewed; they are applied by the separately authorized
  provisioning workflow and verified; only then is the producer's publication enabled (a producer that publishes first is refused by the
  broker and its rows wait in its outbox).
- **Default exchange and shared DLX: retained, residual risk (H3).** Consumers keep `write` on `amq.default` (their retry and
  dead-letter copies and the `nawara-dlq` replay publish through it; the broker also returns an expired `<queue>.retry` message through
  it, which needs no user grant) and on the fanout `nawara.events.dlx` shared by every `<queue>.dead` (§12). Topic permissions do not constrain either: an identity with `amq.default` write can send a message to any
  queue it can name, and one with DLX write can place a message in every consumer's dead-letter queue. S1c's classification observes
  such deliveries and refuses none. S1d is therefore **not** complete broker-level isolation and is never described as preventing queue
  injection. The protection against it is consumer enforcement: S1e stays required, and Billing ← Payment enforcement is fail-closed
  before Billing's first production consumption of Payment events (§13.5, §13.10). Per-consumer retry and dead-letter exchanges, removing
  the `amq.default` and DLX write grants, a dedicated replay identity and their C-4 dead-letter implications are a later, separate
  decision: none is approved here. The replay tooling is unchanged, and a default-exchange replay is never an authenticated original
  publication (§13.4); producer re-emission (§13.7, S0-C4) is a separate, Owner-gated capability.
- **Billing: one identity (H4).** Billing keeps one broker identity for publishing and consuming, granted the union of exactly what it
  needs: topic write on `invoice.created` and its own audit actions; topic read on the Payment events it consumes; the resource
  permissions of a consumer of `billing.payment-events` and of a producer on `nawara.events`. No wildcard. A later topology decision may
  revisit it.
- **Replay identity (H5): deferred** with the H3 hardening; retry and dead-letter behaviour is unchanged.
- **Billing and Payment grants: defined, not provisioned (H6).** Their grants are defined in repository code (S1d-2) and provisioned only
  by the separately authorized rollout (S1-R): no production user, credential, permission or deployment follows from S1d. Payment is a
  producer only (no topic read): its declared events `payment.created`, `payment.cancelled`, `payment.succeeded`, `payment.failed`,
  `payment.expired` and its own audit actions. That complete producer catalog is not the S0-C4 re-emission allow-list, which excludes
  `payment.created`. A re-emission (R2b) publishes through Payment's own identity under these ordinary grants: it needs no wildcard,
  impersonation, cross-service publisher or wider exchange permission. The proposed `payment.event_reemitted` audit action is not
  registered and receives no grant until its catalog change is approved and rolled out.
- **Generator (S1d-1).** Reads the contracts and the audit catalog's producer ownership; applies the approved activation state; emits
  exact, escaped, anchored write and read grants, kept distinct, deterministically; refuses a duplicate or ambiguous owner, an invalid
  event name, an unknown activation state and any wildcard or prefix; supports Billing's combined identity and Payment's producer-only
  one. `npm run check:repo` fails when the provisioning code (S1d-2) drifts from it. Generated grants never invent or activate a
  production family.
- **Rollout and rollback (S1-R).** The narrowed permissions are a production action (§12, §13.10), separately authorized through the
  protected production approval, with: the generated expected grants; an inventory of the current grants before provisioning; a review
  of every right added and removed; verification of the activation state; verification of the grants afterwards; and monitoring of
  outbox lag, Audit delivery and retry and dead-letter depth. Rolling back to an earlier provisioning that grants more is **not** a safe
  default: restoring a broader permission is a security-impacting exception needing its own authorization; a missing grant is corrected
  by adding exactly that grant. The rollback procedure is reviewed separately.
- **Certification (S1d-3, disposable broker).** An approved exact key publishes; another producer's audit action or domain event, an
  unknown key and another exchange are refused; a forged `user_id` is refused; ordinary relay publication, Audit and Notification
  delivery and Billing's Payment intake still work; retry and dead-letter paths still work; the default-exchange injection residual is
  characterized, not reported as fixed; a Payment R1 re-emission stays within Payment's grants; an unknown activation state widens
  nothing; a new family needs a reviewed permission change.

13.2 On a first delivery through `nawara.events`, a consumer verifies broker `user_id` = `headers.source` = the family owner of the
event name, routing key = message type = envelope name, and a well-formed `eventId`. It then commits
`event_provenance(source, eventId, name, routingKey, bodySha256, producerUserId, verified, firstSeenAt)` (for Notification, the keyed
body commitment of S0-C2 below replaces `bodySha256`) in its own database, in a
transaction of its own, **before** the handler runs. A stored row that differs from the delivery is a permanent
`provenance_conflict`.

**Audit admission (S0 clarification, owner-approved 2026-10-23).** The Audit consumer (`audit-service.audit`) may refuse a delivery
before provenance is recorded, through deterministic, side-effect-free admission checks run after the kit's envelope checks and in
this order: the body bytes are canonical (they equal the serialization of their parsed value); the audit contract's
catalog-independent confidentiality screen passes (the dead-letter body screen of
[Stage 18.8](../architecture/stage-18/stage-18-8-security-privacy-retention.md)); and the complete applicable audit-contract validation
succeeds. No admission check treats a caller-controlled field (such as `headers.source`) as authenticated identity: producer
verification stays as stated above, from the broker `user_id` and the catalog owner. A failed check, including any exception, is a
permanent refusal: the handler does not run, the delivery is never sent to `Q.retry`, and no provenance row and no persistent digest of
its body is kept; its dead-letter copy follows the existing privacy-safe dead-letter rules, redacted where they require it, and a copy
that cannot be confirmed is held and requeued as those rules already require (never `Q.retry`). Admission
applies to deliveries through `nawara.events` and through the default exchange alike. An admitted delivery through `nawara.events`
commits its provenance before the handler runs, as stated above, and §13.3 applies unchanged. A delivery refused at admission has no
original provenance row, so it can never become eligible as a verified replay (§13.4); recovering a legitimate event refused for lack
of catalog knowledge needs a separately designed and authorized mechanism consistent with §13.7. While Audit provenance is
observe-only, the existing replay of such a dead letter after a catalog upgrade (Stage 18.1 A50) is unchanged. This paragraph applies to
Audit only; it changes no other consumer.

**S0-C2 — Notification keyed body commitment (S0 normative revision, owner-approved 2026-10-23).** Three Auth events consumed by
Notification carry a six-digit one-time code, and Notification already holds every other field of their bodies. An unkeyed SHA-256 of
such a body lets anyone who can read Notification's database recover the code by trying the 10⁶ candidates, which the code's sealing
and purge in Notification (and its keyed hash in Auth) exist to prevent. Therefore:
- **Scope.** For the Notification consumer (`notification.events`), and for every event it consumes (today the nine Auth events
  `member.contact_verification_requested`, `admin.operator_code_issued`, `admin.operator_confirmation_code_issued`,
  `admin.owner_recovery_requested`, `admin.owner_recovery_completed`, `admin.owner_login_from_new_device`, `membership.approved`,
  `membership.rejected` and `membership.revoked`), the body element of the tuple is the keyed commitment below instead of `bodySha256`.
  Every other consumer keeps `bodySha256` unless separately revised; S0-C1 is unchanged. No event, version, payload, producer or
  transport contract changes.
- **Commitment.** `bodyMac` = HMAC-SHA-256, under the Notification provenance key identified by `bodyMacKeyId`, of the complete raw
  body bytes exactly as delivered (no parsing, canonicalization, redaction or field selection: the code and every other byte are
  covered, so any changed byte gives a different commitment except with negligible probability). `bodyCommitmentVersion` names the
  construction (version 1: HMAC-SHA-256 over the raw body bytes with a dedicated key of at least 256 bits from a CSPRNG). Notification's
  tuple is `event_provenance(source, eventId, name, routingKey, bodyCommitmentVersion, bodyMacKeyId, bodyMac, producerUserId, verified,
  firstSeenAt)`: the keyed value is never stored, named or described as a SHA-256 digest, and Notification never computes or stores an
  unkeyed digest of a body as an alternative, a diagnostic or a fallback.
- **Keys.** The provenance keys form a dedicated Notification key ring, separate from the code-sealing ring (`NOTIFICATION_SECRET_KEYS`)
  in purpose and custody, with one explicit active key id. Key material is held outside the application database and is never
  committed, logged, published, put in a metric, an event, a pull-request description or a test report; a key id is a non-secret label.
  A new commitment uses the active key and records its id.
- **Comparison.** A delivery is compared with a stored observation (a duplicate, a conflict, conflict-evidence de-duplication and the
  §13.4 match) by recomputing its commitment under the stored row's `bodyCommitmentVersion` and `bodyMacKeyId` and comparing in constant
  time; two commitments made under different keys are never compared directly, so a rotation can never create a false conflict, and a
  changed body can never pass as identical. The uniqueness, unverified-first, append-only and conflict rules above apply unchanged.
- **Fail closed.** A missing, malformed or unusable active key keeps the consumer from becoming ready. A commitment that cannot be
  computed during a delivery is a failed provenance commit (§13.3): no intake, no acknowledgement as handled, no unkeyed fallback, and
  never the body or a key in a log. When a stored row's key cannot be resolved, the comparison has no result: the delivery is never a
  duplicate, a match or a verified replay, the stored row is never changed, and no unkeyed comparison replaces it. A key that is
  temporarily unavailable (a configuration or key-service fault, recoverable) is handled like a failed commit (§13.3, held and requeued,
  with an operational signal) until it is restored; a key that was deliberately retired (§13.8) is not an outage: its rows are
  unverifiable, and the delivery's observation, committed under the active key, is appended to the conflict evidence against the stored
  row (never as a duplicate, never as verified authority), and is otherwise treated like any other conflict in the consumer's current
  mode (observe-only in S1b-3). Such evidence records why it was kept (S0-C3, owner-approved 2026-10-23; implemented with S1c by an
  additive Notification migration, without rewriting earlier rows): `differs` when the body was compared under the stored row's own key
  and found different, `unverifiable` when that key was retired so no comparison was possible. A retired key is never evidence that the
  content changed, and a temporarily unavailable key or an unknown commitment version produces no evidence at all (it is a failed
  commit, above). Telling the two apart
  from configuration (for example a recorded list of retired key ids) is an implementation detail of S1b-3, reviewed with it; neither
  case loses data or loops unobserved.
- **Confidentiality.** This protects Notification's retained provenance against offline code guessing by an attacker who can read
  Notification's database but not its provenance keys. It does not address other exposures: Notification's dead-letter queue may still
  hold plaintext code-bearing bodies (the accepted SRE residual of the Notification SDD §13.1, unchanged), and broker access policies,
  Auth's payloads and code delivery are unchanged; any hardening of those is separate work.

13.3 If that commit fails, the handler does not run: the delivery is held and requeued, so it keeps its original identity. It is never
sent to `Q.retry`. For Notification (S0-C2), a commitment that cannot be computed, or a stored key that is temporarily unavailable, is
such a failure.

13.4 A delivery through the default exchange (a retry, a replay, an injection) is processed only if a stored row matches
(`source`, `eventId`), `name` and `bodySha256`; downstream code uses the stored tuple, never the delivery's metadata (for its staged
rollout, observe-only in S1c and enforced from S1e, see S0-C3 below). Otherwise it
is a permanent `unverified_provenance` failure, which a replay cannot turn into a verified event. An Audit delivery refused at
admission (§13.2) never has a stored row, so a later default-exchange delivery of it is never a verified replay. For Notification
(S0-C2) the body element of the match is the keyed commitment, recomputed under the stored row's version and key id; a row whose key is
retired or cannot be resolved never matches, so it can never establish a verified replay.

**S0-C3 — rollout of §13.4 (S0 clarification, owner-approved 2026-10-23).** The rule above is the mandatory end state and is not
weakened: a default-exchange delivery is eligible for processing as a verified replay only when it matches an eligible stored original
observation under the applicable consumer policy. It is reached in two separately authorized stages:
- **S1c, observe-only.** For every default-exchange delivery of a provenance-enabled consumer, the consumer computes the replay
  classification below from its stored provenance and reports it as a bounded operational signal. It introduces no refusal: the
  consumer's existing acceptance and refusal behaviour (including Audit's admission, §13.2) is unchanged, and a delivery that continues
  to be processed is not thereby verified. The S1b guarantees for original deliveries (commit before the handler, §13.3; Audit admission;
  Notification's key readiness) are unchanged.
- **S1e, enforcement.** Only an approved per-consumer enforcement policy acts on the classification; its refusal semantics (which outcome
  is refused, permanently or after holding) are decided with S1e and are not defined here. Financial consumers follow §13.5 and §13.10
  and must enforce before their production activation; observe-only mode is never a basis for enabling a financial consumer in
  production.

The classification (closed set; implementation-facing names, proposed with S1c):

| Classification | Meaning |
|---|---|
| `replay_matched_verified` | the delivery matches the stored **verified** original observation (`source`, `eventId`, `name` and the body element) |
| `replay_matched_unverified` | it matches only a stored **unverified** original observation; it stays unverified |
| `replay_no_provenance` | no stored original observation exists for it (for example an Audit delivery refused at admission, or a historical event) |
| `replay_mismatch` | a stored original observation exists, but the delivered name or body does not match it |
| `replay_unverifiable` | Notification only: the stored commitment's key was legitimately retired (§13.8), so no comparison is possible |
| `replay_lookup_failure` | the verification could not be completed: the database, a temporarily unavailable key or an unknown commitment version |

The delivery's `source` header and message id are lookup keys only, never identity: trust comes from the stored original observation,
whose `verified` was established from the broker `user_id` on the original delivery. A delivery matching an unverified original inherits
**unverified**; a delivery matching only conflict evidence, rather than the stored original observation, is never verified; a verified
original observation keeps its validity when a different, conflicting observation is recorded later. `replay_unverifiable` and
`replay_lookup_failure` are never a successful verification, and the operational signal keeps a failure to verify apart from a verified
mismatch. No classification is a new processing permission.

13.5 Financial consumers (billing-service for `payment.*` and `refund.*`) never process an unverified event. Other consumers may
accept one only during an explicitly configured compatibility phase, and must record it as unverified.

**S0-C6 — S1e consumer enforcement (S0 clarification, owner-approved 2026-10-23; resolves the per-consumer refusal semantics S0-C3
left to S1e).** §13.2–§13.5 are the rule and stay unchanged; this states how each consumer applies them. Nothing here is implemented.
- **Trust before business processing.** A consumer's trust decision for a delivery (verified original, verified replay match, or a
  refusal or hold below) is durable before its business handler runs, and the handler is never invoked otherwise. No handler claims a
  business de-duplication slot (Billing's `payment_event_receipt`, Audit's first-writer record, Notification's first-writer intake row)
  before that decision: a forged or unverified delivery can therefore never pre-empt a later genuine event of the same id. Provenance
  OBSERVATIONS are separate from business de-duplication: an unverified observation stays as append-only evidence even when its
  processing is refused, and nothing is deleted, rewritten, promoted or backfilled (§13.6).
- **The stored verified record is authoritative (S0-C4).** A delivery is evaluated against the consumer's stored VERIFIED observation of
  its (source, event id), not against an aggregate "conflict": a verified delivery that matches it, or arrives where none exists yet
  (including after an earlier unverified observation), is verified; a verified delivery that contradicts a stored verified observation is
  a permanent refusal, never reconciled; a conflict that involves only unverified evidence never by itself invalidates a verified
  delivery. The kit exposes this as a decision, not only as the observe-only `conflict` record (S1e-1).
- **Outcomes.** Every refusal below is permanent and goes through the consumer's privacy-safe dead-letter path; a refusal is never
  acknowledged as processing; a hold keeps the ORIGINAL delivery (held for the retry delay and requeued, as §13.3), bounded, with no tight
  loop and no copy to `<queue>.retry`.

  | Delivery | Billing | Audit | Notification |
  |---|---|---|---|
  | Verified original | process | process | process |
  | Verified broker duplicate (redelivery) | process; receipts de-duplicate | process; de-duplicates | process; de-duplicates |
  | Verified original after an earlier unverified observation | process (no contradicting verified evidence) | same | same |
  | Verified original contradicting the stored verified observation | refuse | refuse | refuse |
  | Unverified original (no `user_id`, another identity, wrong source or owner) | refuse | compatibility phase only (below), else refuse | refuse |
  | Replay matching the stored verified observation (`replay_matched_verified`) | process, with the trusted tuple | process | process |
  | Replay matching only an unverified observation | refuse | compatibility phase only, else refuse | refuse |
  | Replay with no stored observation (`replay_no_provenance`) | refuse | refuse (historical dead letters: after the C-4 disposition) | refuse |
  | Replay with a different name or body (`replay_mismatch`) | refuse | refuse | refuse |
  | Replay under a legitimately retired key (`replay_unverifiable`) | n/a | n/a | refuse, privacy-safe, distinct reason |
  | Transient lookup or commit failure (`replay_lookup_failure`, a failed §13.3 commit) | hold | hold | hold |
  | Conflicting verified evidence | refuse | refuse | refuse |
- **Lookup failure is a hold, never a decision (H3).** When the trust decision cannot be established because of a recoverable failure
  (a database timeout or lost connection, a temporarily unavailable Notification key), the delivery is held and requeued with bounded
  backoff: it is neither processed nor acknowledged, and an infrastructure failure is never treated as proof of forgery. Only an
  authoritative negative decision is refused permanently. The existing outbox, retry and dead-letter privacy guarantees are unchanged.
- **Billing: verified only, from its first production deployment.** Billing never has an observe-only, compatibility or bypass mode in
  production, and no runtime flag disables its financial provenance enforcement; it refuses to start consuming when enforcement cannot
  initialize. A forged or unverified event never reaches `applyPaymentEvent` and never claims a receipt; a verified redelivery and an
  authentic producer re-emission (§13.7, S0-C4) stay idempotent through the receipts, the deterministic event ids and the terminal-state
  rules. No operator override admits an unverified financial event.
- **Billing's trusted replay tuple (H6).** The body commitment covers the body bytes only, and Billing today takes financial inputs from
  delivery headers (at least `occurredAt` as the settlement instant, and `version`). A replay may copy an authentic body and change its
  headers, so for a verified-match replay every value that can affect a financial outcome is taken from what was committed from the
  verified original publication, never from the replay's headers (§13.4 "the stored tuple"). S1e-2 first inventories every field Billing's
  handler reads (at least `occurredAt`, the version, the producer identity, the event name and id, and correlation identifiers where they
  matter), and its additive migration stores exactly those values with each verified observation as immutable data: existing rows and
  body commitments stay; no unverified observation is rewritten or promoted; no historical value is invented (a row recorded before that
  migration has none); a stored verified value is never overwritten. A replay whose trusted values are unavailable has no financial effect
  and is refused with an explicit fail-closed reason. The original event identity, the receipts and the terminal-state rules apply as before.
- **Audit (H1, S0-C1 unchanged).** Admission (canonical bytes, the Stage 18.8 confidentiality screen, the complete contract) stays FIRST:
  before any provenance record, digest, enforcement decision or business processing; a refused delivery is permanent, has no provenance
  row and keeps the redacting dead-letter policy. Audit alone may run a **temporary, explicitly configured compatibility phase** while it
  is already in production: an admitted unverified delivery may be processed and is recorded as unverified; nothing historical becomes
  verified; admission is never bypassed; accepted and refused compatibility outcomes stay observable (bounded metrics). No other consumer
  can enable it, Billing in particular. The phase ends only when, in order: authenticated publisher identity is deployed and verified for
  Audit's producers; the C-4 historical Auth → Audit dead letters are dispositioned or gated by the approved recovery procedure; the
  relevant S1-R prerequisites and Audit's privacy, retention and admission gates (AP-R, M9, G-7) are met; strict enforcement is tested
  against the actual producers; and the Owner authorizes the transition. Returning to compatibility afterwards is a separately approved
  security-impacting exception.
- **Notification (H2, H4, H5; S0-C2 unchanged).** Verified-only from its first production deployment: no observe-only or compatibility
  mode, and no unverified Auth event reaches business processing. The keyed commitment stays authoritative: no unkeyed fallback; a
  missing or temporarily unavailable key is a hold (it never permits acceptance); a key that was LEGITIMATELY RETIRED makes a replay
  `replay_unverifiable`, which is a permanent refusal with its own reason (not a hold, not a match). A refused delivery of a code-bearing
  event (`member.contact_verification_requested`, `admin.operator_code_issued`, `admin.operator_confirmation_code_issued`) never keeps
  its plaintext code: its dead-letter copy is redacted or safely replaced (Audit's Stage 18.8 convention is the reference), keeping only
  non-sensitive diagnostic metadata; no code appears in a metric, log or error; no new sensitive store, longer code retention or re-emission
  of such events (S0-C4) results. A permanent privacy-safe refusal is never used in place of the hold a recoverable key failure requires.
- **Monitoring (rollout requirement).** Refusals by bounded reason, holds and requeues, dead-letter depth, Audit delivery health, Billing
  financial-event lag, Notification delivery health, and evidence that legitimate redeliveries and replays still succeed; never a payload.
- **Implementation and rollout.** S1e-1 (kit: decision-bearing provenance results, stored-verified precedence, per-consumer policy applied
  before the handler, hold and refusal outcomes, trusted-tuple support, no observe-only path for a financial consumer); S1e-2 (Billing);
  S1e-3 (Audit, including the compatibility phase and its exit); S1e-4 (Notification); S1e-5 (real RabbitMQ and PostgreSQL
  certification). Each is separately authorized; none enables anything in production. Production follows S1-R, with AP-R, NP-K, M9, G-7,
  C-4 and G6/F7: Billing enters production with strict enforcement certified, Notification with strict enforcement and its keys
  (NP-K), and strict Audit enforcement never precedes verified upstream publisher identity and the C-4 disposition. OD-BRK, R2b and R4
  are unaffected.

13.6 No historical event is ever labelled verified, and provenance is never backfilled. (An authorized §13.7 re-emission is a new
authenticated publication, not a backfill: S0-C4 below §13.7.)

13.7 A producer whose event ids are deterministic may re-emit one named outbox row, under owner authorization and with an audit
record, through its own broker connection; consumers de-duplicate it. Producers with random ids (auth-service) can re-emit only while
their published rows are retained. The mechanism (route or command), its caller and its audit record are an open decision (OD-15 of the
[contract register](../architecture/core-v2-d-a2-contract-register.md)); nothing re-emits until it is decided (S0-C3). S0-C4 below
decides it for Payment-first only; every other producer stays undecided.

**S0-C4 — §13.7 re-emission, Payment-first (S0 clarification, owner-approved 2026-10-23; OD-15 resolved for Payment only).**
- **Meaning (with §13.6).** An authorized re-emission is a **new authenticated publication** of the producer's own immutable outbox
  row, not a retrospective verification of the earlier publication. Each consumer observes it like any delivery through `nawara.events`
  (§13.2): where §13.2 holds it may establish a **new** verified observation. It never rewrites, deletes, replaces or promotes an
  earlier observation (an earlier unverified one stays unverified; an authoritative verified one stays authoritative), never claims that
  the earlier publication was authenticated, and an approval reference is never producer identity. §13.6 is unchanged by this.
- **Mechanism.** A restricted command run inside the producing service's own trusted environment (no route, no new service): it selects
  ONE existing, published, immutable outbox row of that producer by its id and expected name, and republishes it through the producer's
  own broker connection (its §13.1 `user_id`) to `nawara.events` with the original event id, name, routing key, version, `occurredAt`,
  correlation id and body. No caller supplies, replaces or constructs event content; no outbox row is ever modified (the relay's
  published-row immutability is unchanged); it is not a general publishing facility and never publishes for another producer. Any
  shared Core code is a library behind each producer's own allow-listed entry point, never a generic publisher. A re-emission is a
  delivery through `nawara.events` (an original delivery for §13.2), not a default-exchange replay in the sense of §13.4.
- **Authority.** The Owner only. An Owner approval through the protected production execution gate is the authorization, and it must be
  bound to the producer, the exact event (outbox) id, the event name, the reason, the approval reference, the execution environment and
  the operation; a caller-supplied argument (`--service`, an actor or an approval reference) is never by itself authentication or
  authorization. No Platform Operator, Organization operator or user inherits it. The production execution mechanism is separately
  authorized.
- **Payment-first eligibility (all required).** Producer payment-service; an existing outbox row that is already published and
  unchanged; event name and version explicitly allow-listed: `payment.succeeded`, `payment.failed`, `payment.cancelled`,
  `payment.expired`, each version 1 (as declared by payment-service's event contract); serialization pipeline version 1 established for
  the row (below); the same event id and the same serialized body as the original; publication through payment-service's authenticated
  broker identity; the Owner approval above; a durable attempt record and producer audit evidence written before publication (below);
  consumers' de-duplication unchanged. Ineligible: unpublished, missing or purged rows; any other name or version (no wildcard;
  payment-service's audit events only once their catalog actions and compatibility are verified and allow-listed); an unknown or
  incompatible serialization version; a row whose content cannot be reproduced exactly; any caller-provided payload; a known
  contradiction with an authoritative verified observation; anything created solely for recovery. Auth and Organization re-emission stay
  undecided (and need G-7 / M3 first).
- **Code-bearing events never.** `member.contact_verification_requested`, `admin.operator_code_issued` and
  `admin.operator_confirmation_code_issued` (ADR-0052 decision 5) are never eligible for any producer: no expired or deleted code is
  reconstructed, no code-bearing row is retained longer to allow recovery, and no command exports, logs, copies or replays such a body.
- **Serialization pipeline version 1.** The original body is not the application object's serialization: `OutboxService.enqueue`
  stores the payload as PostgreSQL `jsonb`, the relay reads the row, node-postgres parses `jsonb` with `JSON.parse`, the relay passes
  that parsed payload as the envelope payload, and the bus publishes exactly `JSON.stringify` of it. Version 1 is that pipeline. A
  re-emission must reuse the same shared serialization path as the relay (never a separately built, semantically equivalent body), so
  byte identity holds by construction for a row published by version 1. The message id, type, routing key and headers (`eventId`,
  `source` = the producer's own service name, `occurredAt` from the row, `correlationId`, `version`) and the AMQP timestamp are likewise
  built from the row by that same relay and bus path, never by separate code. Eligibility needs evidence that the row was published by
  version 1 (source-history evidence, exact-byte fixtures, byte-for-byte regression tests, a guard that fails on any change to the
  pipeline, an explicit version-compatibility policy); where the publishing version cannot be established, the row is ineligible
  (fail closed: no best-effort reconstruction). Any incompatible change to the pipeline is a new, explicitly versioned pipeline with its
  own reviewed compatibility decision. A publish-time body digest is a possible later hardening, not required for Payment-first.
- **Existing provenance (§13.2 store behaviour, unchanged).** The stores keep at most one verified and one unverified observation per
  (consumer, source, event id), append-only, with conflict evidence beside them; a difference between them is recorded as that evidence
  and never replaces either. No observation: the re-emission may establish the verified one. A
  verified observation with the same content: a duplicate, and business de-duplication applies. An unverified observation: a separate
  verified observation may be added; the unverified one stays intact and is never promoted; conflict evidence is kept. A verified
  observation with different content: a security conflict, never resolved or overwritten; recovery is blocked when this is known before
  publication, and when a consumer detects it, it stays an observable conflict to investigate.
- **Attempts, audit and outcomes.** The recovery intent (the approval evidence, producer and event references, reason) is recorded
  durably in the producer, append-only, together with its producer-specific audit evidence written through the producer's own outbox,
  BEFORE publication, so an unavailable Audit never loses the authorization trail; the outcome is recorded afterwards, without
  rewriting the intent: confirmed, unroutable, failed, or uncertain (a lost publisher confirmation is never reported as a failure).
  A database commit and a broker confirmation are not atomic; a repeated request republishes the same event id and body and relies on
  consumers' de-duplication. Payment's audit action is a proposal for implementation (`payment.event_reemitted`, recording the actor and
  approval reference, producer, source event id, event family, attempt id, reason, outcome and time, never the body, a code, a
  credential or a digest); if chronology needs separate requested and completed facts, the implementation provides them. The audit
  catalog is changed only with that implementation.
- **Broker and finance.** The recovery publish uses publisher confirmation and must detect an unroutable publish; any `mandatory`
  publish capability is narrow and reviewed, never a change to normal publishing. A re-emitted Payment event is the existing immutable
  fact, never a new payment, settlement, receipt, entitlement or override: Billing's receipt uniqueness, Payment's deterministic event
  ids and terminal-state rules and the existing ordering and reconciliation behaviour stay authoritative.
- **Retention.** Only while the original row is retained and unchanged (§13.8, the A3M outbox-retention rules); no payload is retained
  longer, no secret-bearing evidence is added and nothing is backfilled.
- **S1e.** Enforcement evaluates the authoritative stored verified observation: an earlier unverified observation never by itself
  invalidates a later authenticated publication (even when the delivery was reported as a conflict against that unverified
  observation), and conflicting verified evidence is never ignored. This is a requirement on S1e, not its authorization.

13.8 Provenance is retained at least as long as dead-letter retention plus the retry window. This is a minimum, not a requirement
of permanent retention. For Audit (S0 clarification, 2026-10-23), a provenance row or digest must not outlive, and so undermine, the
lawful purge of its Audit record: authorized expiry, erasure and legal holds of Audit provenance need an explicit policy (P-A2 is open),
and the production gate of the [execution roadmap](../architecture/core-v2-s-execution-roadmap.md) (§7, AP-R) applies until then.
For Notification (S0-C2), each provenance key stays available at least as long as this minimum for the rows it committed; that is a
minimum, not a destruction date. A key may be retired only once no still-eligible replay, retained observation that must still be
compared, recovery obligation or retention or hold requirement depends on it, under a separately reviewed operational procedure; its
rows then remain, unverifiable, and can never establish a verified replay. In particular (S0-C3), a key is not retired while a retained
dead letter of an event committed under it may still be replayed; a rotation alone never creates a conflict, and a missing, a
temporarily unavailable and a retired key are never treated alike. Destroying a key does not erase the rows' metadata. No
duration is set here; Notification history retention is an open product / legal decision, and any future erasure policy must be
reconciled with the surviving keyed commitments, key retention and metadata (production gate NP-K of the execution roadmap §7).

13.9 In production, financial and notification consumers refuse an event whose `liveMode` is missing or false.

13.10 Rollout, each step separately authorized: publisher identity → provenance recorded in observe-only mode → narrowed broker
permissions (a production action, §12) → retry queues drained and dead letters inventoried (historical Auth → Audit dead letters are
a pending owner decision) → enforcement per consumer. Billing ← Payment enforcement is on from Billing's first deployment.

## Consequences

- One reviewable statement of how Core services exchange events; [CURRENT] rules describe `main`, so this ADR changes no behaviour.
- New work has a convention to follow: versioned payloads with supported-version checks, per-service catalogs and a guard (A3M.2),
  consumer conventions and Payment's readiness (A3M.3), the G7 proof and its remedy (A3M.4), retention design (A3M.5), real-broker evidence (A3M.6); the local certification record is the
  [A3M record](../architecture/core-v2-a3m-messaging.md) §16 (A3M.7). Certification is not acceptance: this ADR stays Proposed.
- ADR-0018 and ADR-0037 gain forward notes to this ADR; their content and status are unchanged, and their disposition remains an
  explicit owner decision (OD-A3M-2). On acceptance of this ADR the owner may mark them partially superseded.
- G7 is confirmed and remedied in code (A3M.4, R1); the production topology residuals of §8 stay recorded.

## Relationship to other ADRs

| ADR | Relationship |
|---|---|
| [0018](./0018-rabbitmq-as-async-message-broker.md) RabbitMQ (Proposed) | **reconciles**: keeps the exchange, the routing key and the flat body; replaces the client library and the deferral of retry, dead letters and versioning (§1, §5, §8). Supersession only on acceptance |
| [0037](./0037-reliable-events-outbox-inbox.md) outbox and inbox (Proposed) | **reconciles**: keeps the outbox, the headers and at-least-once delivery; proposes generalizing the inbox (§7, on acceptance); its event-family list is historical (§2) |
| [0046](./0046-notification-service-architecture.md) rule 17 | **follows**: the kit bus and the canonical header envelope |
| [0049](./0049-audit-trail-architecture.md) audit trail | **follows**: `audit.<action>`, `(sourceService, eventId)` uniqueness, data minimization, the redacting dead-letter policy |
| [0052](./0052-core-v1-capability-closure.md) decisions 4–5 | **follows**: `AUTH_EVENTS`; code-bearing events and their purge |
| [0053](./0053-core-v1-production-rabbitmq.md) production RabbitMQ | **follows**: topology, identities and deployment order are binding (§12) |
| [0067](./0067-auth-authorization-receipts-for-owner-approved-refunds.md) refund receipts (Proposed) | **related**: Payment's refund effects are published under §13; receipts are not events |
| [0069](./0069-verified-audit-producers-and-audit-contract-v2.md) verified audit producers (Proposed) | **completes**: applies §13 to `audit.*` and amends ADR-0049; to be accepted with or after this ADR |
| [0056](./0056-core-architecture-and-api-conventions.md) conventions | **follows**, and does not override: no new HTTP endpoint (readiness and health stay §10); ADR-0056 §7's inbox wording stays binding; the broader de-duplication interpretation of §7 above applies only if this ADR is accepted or ADR-0056 is amended |

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

13.6 No historical event is ever labelled verified, and provenance is never backfilled.

13.7 A producer whose event ids are deterministic may re-emit one named outbox row, under owner authorization and with an audit
record, through its own broker connection; consumers de-duplicate it. Producers with random ids (auth-service) can re-emit only while
their published rows are retained. The mechanism (route or command), its caller and its audit record are an open decision (OD-15 of the
[contract register](../architecture/core-v2-d-a2-contract-register.md)); nothing re-emits until it is decided (S0-C3).

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

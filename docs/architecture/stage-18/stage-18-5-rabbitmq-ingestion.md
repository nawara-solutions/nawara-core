# Stage 18.5 — RabbitMQ / outbox ingestion

- **Status:** implemented and validated on `feat/audit-rabbitmq-ingestion` (awaiting review; not committed).
- **Scope:** audit-service's ingestion consumer on the kit RabbitMQ bus (queue `audit-service.audit`, binding `audit.#`, the kit's retry
  and dead-letter topology), the pipeline validate → map → idempotent insert → exact-duplicate / conflict decision, the refusal → DLQ
  reason mapping, clock-skew observation, readiness and shutdown integration, broker configuration, Compose and image wiring, tests with
  a real RabbitMQ 3.13 and a real PostgreSQL 16 (in-process, end-to-end through the real outbox relay, container chaos, hardened image).
- **Not in scope (and not present):** the query API (18.6), any change to a real producer or the Auth outbox (18.7), retention (18.8),
  the operational campaign (18.9). **No change to `libs/service-kit`**, `@nawara/audit-contract`, `audit_record` or its repository.
- **Frozen design followed:** [ADR-0049](../../adr/0049-audit-trail-architecture.md) A15–A22, A47–A50, A59–A61, [Stage 18.1 §8](./stage-18-1-decisions-and-roadmap.md),
  [Stage 18.4](./stage-18-4-canonical-contract-catalog.md). No decision reopened.

## 1. Baseline and broker environment

`main` at `0ec67e09e7395a224fe51598b0c0a8b97c30c8d7` (Stage 18.4 merged, PR #118); working tree clean except the untracked `docs/reports/`.

Evidence environment: `rabbitmq:3.13-alpine` (RabbitMQ **3.13.7**, image `sha256:5f33947…`) and `postgres:16-alpine` (PostgreSQL
**16.15**), throwaway containers on loopback ports, removed afterwards. The broker uses the image's default user, as CI does (the kit's
`BrokerProxy` test tool connects as `guest`).

**The Stage 18.4 Erlang-cookie failure, resolved (environment, not repository).** Reproduced deterministically: probing a freshly started
container with `docker exec <c> rabbitmq-diagnostics …` runs the CLI as **root** with `HOME=/var/lib/rabbitmq`; if it runs before the
server has created its `.erlang.cookie`, the CLI creates it root-owned mode 0400, and the server (uid 100) then dies with
`Error when reading /var/lib/rabbitmq/.erlang.cookie: eacces`. Not the host's AppArmor / seccomp, not umask, not the image: the same
container starts cleanly without the early probe, and `docker exec -u rabbitmq …` never triggers it. Fix: readiness is probed from the
host (the server's `Server startup complete` line / the AMQP port), or as `-u rabbitmq`. No security setting was weakened. Compose's
and CI's `rabbitmq-diagnostics` health checks start only after their 10 s interval, which normally follows cookie creation (a slow host
could still race: finding F9).

## 2. Topology

| Element | Value | Source |
|---|---|---|
| Exchange | `nawara.events` (topic, durable) | the kit's shared exchange |
| Routing key | the event type `audit.<action>`, set by the producer's relay from the outbox row, which `AuditEventWriter` derives from the catalog action | never producer-chosen |
| Work queue | `audit-service.audit` (durable; `x-dead-letter-exchange: nawara.events.dlx`) | A20; a constant, not configuration |
| Binding | `audit.#` only | no domain event (`payment.succeeded`, `membership.revoked`) is routed to it (tested) |
| Retry | `audit-service.audit.retry` (durable delay queue; a message's own expiration dead-letters it back to the work queue); kit default **3 retries × 5 s** | the kit |
| Dead letters | `audit-service.audit.dead` (durable, bound to `nawara.events.dlx`); annotated copies: `x-nawara-failure` (`malformed` / `permanent` / `retries_exhausted`), `x-nawara-failure-reason`, `-error`, `-failed-at`, `-consumer`, `x-nawara-retry-count` | the kit |
| Messages | persistent, publisher-confirmed (producer relay and the kit's retry / DLQ copies) | the kit |
| Prefetch | half the pool, 1–10 (**5** with the default `DB_POOL_MAX` 10) | the Stage 15.8 rule (Notification's) |

All three queues and the binding are declared by the consumer when it attaches (idempotent): a fresh broker needs no manual provisioning.
Durability proven by restarting the real broker container: 5 pending messages and 1 dead letter were all still there (§11).

## 3. Consumer pipeline (exact order)

```text
RabbitMQ delivery (prefetch 5)
  └─ kit RabbitMqEventBus.deliver: messageId + type (kit name grammar) + JSON-object body, else PermanentEventFailure('malformed_envelope')
      └─ AuditConsumer.handle: request context (event correlation id if it has the kit grammar, else event:<uuid>)
          └─ IngestionService.ingest
              1. validateAuditEvent(envelope)            @nawara/audit-contract/consumer — the SAME validator the producers' writer runs:
                                                          envelope (id = headers.eventId, UUID; source; occurredAt; version ∈ [1]; correlation),
                                                          event type = "audit." + payload.action, the whole payload, PRODUCER ADMISSION
                                                          (source = catalog[action].producer), category from the catalog
              2. toNewAuditRecord(validated)              the one Stage 18.4 mapping (no second mapper)
              3. AuditRecordRepository.insertOnce(record) ONE autocommit statement: INSERT … ON CONFLICT (sourceService, eventId) DO NOTHING
                                                          RETURNING; recordedAt = the database clock (trigger)
              4. inserted  → counters, clock-skew check → return          → kit ACK
                 duplicate → sameEvidence(stored, record)?
                               yes → return (idempotent success)          → kit ACK
                               no  → PermanentEventFailure('event_id_conflict') → kit: DLQ at once, ACK
              contract refusal / schema refusal → PermanentEventFailure(<reason>) → DLQ at once (never retried)
              any other error (database unreachable, timeout, dropped connection) → rethrown → kit retry (3 × 5 s) → DLQ `retries_exhausted`
```

Nothing is written before validation succeeds; a delivery is acknowledged only after its record is committed or proven already stored
with the same evidence. Delivery semantics: **at-least-once delivery with idempotent, immutable Audit persistence** (never exactly-once).

## 4. Inbox and transaction model (§26–§27)

The kit `InboxService` is **not** used. Its key is `eventId` alone (not `(sourceService, eventId)`), and "already processed" would make a
redelivered event with **different** evidence a silent duplicate — hiding exactly the conflicts A15 requires to be dead-lettered. The
`audit_record` unique constraint `(sourceService, eventId)` is the single idempotency boundary, and it is atomic with the evidence itself:
the record IS the bookkeeping. There is no "mark processed, then insert" window; the one statement either stores the record or finds the
stored one; the ACK follows it. A crash anywhere before the ACK leads to a redelivery that the constraint and `sameEvidence` classify.

## 5. Duplicates and conflicts

- **Exact duplicate** (same source, event id and every evidence field): acknowledged, logged `audit_event_duplicate`, counted; no second
  row, no DLQ, no retry. Covers broker redelivery, relay re-publish, crash after commit, operator replay.
- **Conflict** (same source and event id, any evidence field different: action / category, actor type / id / kind, organization,
  resource, subject, outcome, changes, correlation, causation, occurredAt, schema version — everything `sameEvidence` compares, i.e.
  every stored field except `id` and `recordedAt`): `PermanentEventFailure('event_id_conflict')` → `audit-service.audit.dead`; the stored
  row is never updated, merged or overwritten (the runtime role cannot anyway: 18.3). Tested per field class (11 variants), row compared
  field for field including `recordedAt` before and after.

## 6. Failure classification and DLQ reasons

| Class | Cause | Result | `x-nawara-failure` / `-reason` |
|---|---|---|---|
| malformed (kit) | no message id, unknown type grammar, body not a JSON object (bad JSON, bytes, an array) | DLQ at once | `malformed` / `malformed_envelope` |
| permanent (contract) | every `AuditContractError` of the shared validator | DLQ at once | `permanent` / the refusal code, verbatim |
| permanent (identity) | same identity, different evidence | DLQ at once | `permanent` / `event_id_conflict` |
| permanent (schema) | the table refuses a validated record (a contract / schema drift; never observed) | DLQ at once | `permanent` / `invalid_record` |
| transient | database unreachable or refusing connections, statement / query timeout, dropped connection, any unexpected error | retry 3 × 5 s, then DLQ | `retries_exhausted` / — |

Reason mapping (deterministic; the codes are already stable, lowercase and value-free, so the mapping is the identity, with no
`audit_` prefix since the queue already names the service — the Notification / Billing convention): `invalid_payload`,
`payload_too_large`, `unknown_field`, `sensitive_field`, `sensitive_value`, `unknown_action`, `producer_not_admitted`,
`event_type_mismatch`, `invalid_actor`, `invalid_organization`, `invalid_resource`, `invalid_subject`, `invalid_outcome`, `invalid_changes`,
`invalid_causation`, `invalid_correlation`, `invalid_envelope`, `unsupported_version`, plus `event_id_conflict`, `invalid_record`
(`transaction_required` is the producer writer's and cannot occur here). All satisfy the kit's reason grammar `^[a-z][a-z0-9_]{0,63}$`.

**DLQ content (§29, privacy):** the kit dead-letters an annotated **copy of the original message** (body and headers), so a refused
payload — including one refused *because* it carried a credential-shaped field — sits in `audit-service.audit.dead` until an operator acts.
The annotations themselves carry no payload data. Redesigning every kit DLQ is out of scope; the implication is recorded for 18.8
(finding F3: DLQ access control, a TTL / purge policy, and whether `sensitive_*` refusals should be dead-lettered without their body).

**Kit envelope parsing nuance (F4):** the kit consumer maps a *missing* `version` header to 1 and drops a non-string `correlationId`
header. A message without a version is therefore judged as a version-1 claim (and must then pass every version-1 rule); a present
unsupported version (2, "1", 1.5) is refused. The relay always sets both headers.

## 7. Replay (operators)

The existing kit tool, unchanged: `nawara-dlq list --queue audit-service.audit.dead` (peek, never consumes) and
`nawara-dlq replay --queue audit-service.audit.dead --event-id <id>` (moves ONE message back to `audit-service.audit`, same bytes and ids,
fresh retry budget). The replayed message takes the normal path, so validation, admission, idempotency and conflict detection all apply:

| Replayed message | Outcome (tested with the real broker) |
|---|---|
| `retries_exhausted`, after the database recovered | `consumed`; stored once |
| an event already stored (same evidence) | acknowledged as a duplicate; still one row |
| `event_id_conflict` | `rejected_again` (back in the DLQ with the same reason); the stored row unchanged |
| a contract refusal | `rejected_again` until the producer is fixed; a corrected event is a NEW event (new id) from the producer |

Procedure: inspect (`list`), fix the cause (database, catalog deployment order, producer bug), replay one id, check the exit code
(0 consumed, 2 rejected again, 3 pending, 4 not found). Never edit a dead-lettered payload to make it pass.

## 8. Time

- `recordedAt` is always the audit database's clock (the 18.3 trigger); an event cannot supply it: a `recordedAt` header is ignored, a
  payload field is refused (`unknown_field`); proven with the real broker.
- `occurredAt` is stored exactly as sent. **Clock skew (A22):** a record whose `occurredAt` is more than 5 minutes after its own
  `recordedAt` is stored and observed — `audit_clock_skew … aheadSeconds=N` (warn) and the `clock_skew_future` counter; never
  corrected, never refused. A far-past `occurredAt` (backlog, replay) is normal and shows only in the lag statistics.
- Out-of-order arrival is accepted as is (tested: arrival order ≠ occurrence order).

## 9. Readiness and liveness

`/ready` now requires `database`, `migrations`, **`rabbitmq`** (a fresh connect to the configured broker) and **`audit-ingestion`** (the
consumer attached and in the kit's `consuming` state) — the Notification pattern: audit-service cannot do its primary job without the
broker. `/health` is unchanged (process liveness only; tested 200 with the broker down). Start order: the consumer attaches only after
the database answers and every migration is applied (`/ready` lists `audit-ingestion` while migrations are pending). Broker down at start:
the process stays up, `/ready` 503 (`audit-ingestion`, `rabbitmq`), bounded jittered start retry (250 ms … 5 s), consumption starts when
the broker answers — no crash loop. Broker lost at runtime: the kit detects it (connection close / heartbeat), `/ready` 503, the kit
re-attaches with bounded backoff (500 ms … 30 s), `/ready` 200 again, no restart.

## 10. Shutdown (exact order)

1. SIGTERM → the kit's shutdown state: `/ready` 503 and new HTTP requests refused (Stage 15.5, unchanged).
2. `AuditConsumer` (at shutdown start): the consumer is **cancelled** — no new delivery (a message published during the drain stays in
   the broker: tested) — and in-flight deliveries get the kit's drain bound (5 s) to finish and be settled.
3. A delivery still running then is left **unacknowledged**: the broker redelivers it (to this or another instance): never lost; the
   constraint makes it one row.
4. The bus closes (bounded by 3 × heartbeat at worst); the final `audit_ops_snapshot` line is written.
5. The kit closes the database pool **last**. Its `pool.end()` waits for a checked-out client, so a statement stuck in the database
   holds shutdown until `DB_STATEMENT_TIMEOUT_MS` cancels it (30 s by default; tested with 3 s: total < 12 s). The real shutdown bound
   with a stalled database is therefore the statement timeout (finding F5, a kit property).

## 11. Evidence

*(counts in §12)*

- **End-to-end, all real (§49–§50):** a test producer (own database with the kit outbox and a stand-in business table) writes the row and
  `AuditEventWriter` intent in one transaction; the kit `OutboxRelay` publishes through the kit bus (source `billing-service`);
  audit-service, built as `main.ts` builds it (production bus, default retry), stores the record — every field equal, `occurredAt` =
  the producer transaction's `now()` (ms), `recordedAt` later. ROLLBACK → 0 business rows, 0 outbox rows, 0 published, 0 records. A relay
  re-publish → one record. **Zero HTTP requests** reached audit-service throughout.
- **Real broker, in process:** topology and routing; a valid event field for field; all 49 actions from their five producers; exact
  duplicates; 11 conflict classes; the DLQ matrix (24 hostile / invalid messages: malformed JSON, bytes, array, missing id, uppercase
  id, wrong type sent straight to the queue, another action's type, version 2, missing source, bad occurredAt, bad correlation,
  unknown action, source spoofing, actor, organization, resource, subject, outcome, changes, sensitive field, secret-shaped value,
  category on the wire, recordedAt on the wire, a 1 MiB value), each dead-lettered once with its reason and retry count 0, nothing
  stored, a valid event after them all stored; poison ordering; database outage with retry; retry exhaustion + replay + re-replay; a
  conflicting replay; crash before insert and crash after commit before ACK (the broker connection severed through the kit's
  `BrokerProxy`); a database failure at the insert; 60 identical deliveries across two consumers (1 row, 59 duplicates, 0 DLQ); 20
  concurrent conflicting variants (1 winner, 19 `event_id_conflict`); clock skew; `recordedAt` not suppliable; out-of-order; backpressure
  (40 messages with the table locked: exactly 5 in flight, 35 ready in the broker, then all 40 stored); shutdown with a stuck delivery;
  broker lost at runtime and down at startup; service restart with pending messages; log hygiene.
- **Real container chaos (`npm run test:chaos`, local only):** `docker restart` of the broker with 5 pending messages and 1 dead letter
  → all still there; consumer restarted → 5 rows; broker restarted **under** the running consumer → `/ready` 503, `/health` 200, then
  `/ready` 200 with no restart, a new event stored; exactly one row per event. `docker stop` / `start` of PostgreSQL under the running
  consumer (production retry policy) → transient failures logged, `/ready` 503, recovery inside the retry budget, one row, no DLQ.
- **Production image, hardened** (`--read-only --cap-drop ALL --security-opt no-new-privileges`, uid 1000): migrated by the image as
  `audit_migrator`, ready against the real broker and database as `audit_app`, stored a published event (`file.deleted`,
  `file-service`, `business`), SIGTERM → exit 0 in 67 ms; its log holds no password, `amqp://` or `postgres://` URL. The CI smoke script
  passes (it now provides `RABBITMQ_URL`).

**Performance sanity (§76; not a capacity claim, 18.9 owns that):** the hardened production container on this workstation, 2 000
`payment.created` events published sequentially (as a relay does) in 2.5 s: all 2 000 stored 4.1 s after the first publish, 2 000 rows
(one per event id), container memory 52.7 MiB before, 73.6 MiB peak during the drain, 73.4 MiB after (bounded by the prefetch: the
backlog waits in the broker). One info line per persisted event (2 001 lines): acceptable now, a log-volume point for 18.9.

**Security / logging:** log lines carry the refusal reason, the validated action and source, and the event id only when it is a
canonical UUID; never the payload, a change value, an actor / organization / resource / subject id, a header value that failed
validation, or a credential. Tested: sentinel secret, a 1 MiB value, a JWT, change keys and values, the sample ids and both database
passwords never appear in any log line or kit notice.

**Observability:** an `audit_ops_snapshot` line every 60 s and at shutdown (the File / Notification pattern; Core has no metrics
platform): `received`, `persisted`, `duplicate`, `refused` and `refused_<reason>`, `transient_failure`, `clock_skew_future`, ingestion lag
(count / avg / max of `recordedAt − occurredAt`), `in_flight`, consumer attached / detached. Closed label sets only (never an id,
action or source). Retries, dead-letters, consumer loss / recovery are the kit's existing notices.

## 12. Counts

| Suite | Result |
|---|---|
| audit-service unit (config, HTTP bounds, policy, mapper, ingestion pipeline and classification, wiring) | **158 / 158** (was 142: +14 ingestion, +2 wiring) |
| audit-service E2E, real PostgreSQL 16.15 + real RabbitMQ 3.13.7 (8 files) | **307 / 307** (was 266); of which ingestion over the broker **35**, end-to-end pipeline **3**, foundation / health / process / runtime-role adapted to the new readiness |
| chaos (`test:chaos`, real container restart / stop) | **2 / 2** (run twice) |
| production image: hardened run against the real broker and database + 2 000-event burst; CI smoke script | pass; SMOKE PASSED |
| `@nawara/audit-contract` unit / PostgreSQL integration (unchanged) | 858 / 858; 10 / 10 |
| service-kit unit / integration with the real broker (unchanged; the RabbitMQ suites that could not run in 18.4 now run) | 132 / 132; **15 files, 110 / 110** |
| `check:repo`, its tests; lint; typecheck; builds | pass, 17 / 17; 0; 0; clean |

**Mutations (18; each applied exactly once, run against the unit suite and / or the real-broker e2e tests it must break, restored,
SHA-256 verified; every source identical afterwards):**

| # | Mutation | Result |
|---|---|---|
| M1 | ACK before persistence (handler returns before the insert) | killed (3 real-broker tests) |
| M2 | exact duplicate not an idempotent success | killed (unit 1, broker 1) |
| M3 | conflict treated as exact duplicate | killed (unit 1, broker 11) |
| M4 | conflict overwrites the stored row (`ON CONFLICT DO UPDATE`) | killed (broker 11) |
| M5 | producer admission disabled (in the shared contract) | killed (unit 1) |
| M6 | unknown action acknowledged | killed (unit 1) |
| M7 | unsupported version accepted (read as 1) | killed (unit 1) |
| M8 | permanent failure retried instead of dead-lettered | killed (unit 10, broker 1) |
| M9 | transient database failure acknowledged (lost) | killed (unit 1, broker 1) |
| M10 | event type / action mismatch ignored | killed (unit 1) |
| M11 | category accepted from the wire | killed (unit 1) |
| M12 | `recordedAt` accepted from the wire | killed (unit 1) |
| M12b | the repository sends `recordedAt` = `occurredAt` | **survived — defended**: the 18.3 trigger overwrites `recordedAt` with the database clock; the stored value is unaffected (defense in depth, proven by the tests passing) |
| M13 | source check disabled in ingestion (source taken from the catalog) | killed (unit 1) |
| M14 | consumer keeps accepting deliveries during shutdown | killed (broker 1: the shutdown-start test, added after a first run showed the original shutdown test could not see it) |
| M15 | unbounded prefetch | killed (unit 1, the production wiring) |
| M16 | readiness claims ingestion before the consumer is attached | killed (broker 1) |

Campaign integrity: a first pass wrapped the e2e-only commands in `((…))` (bash arithmetic), so five "kills" (M1, M4, M12b, M14, M16)
were harness errors; they were rerun correctly. The broker then degraded (§14 F10) and those five were rerun a third time on a fresh,
verified-healthy broker (results above). No kill in this table depends on a harness or environment failure.

## 13. Scope proof

- No query API: the routes are still `/health` and `/ready` (foundation suite); no HTTP ingestion route (A16).
- No real producer integration: no file under the auth, organization, billing, payment, file or notification services changed.
- No Auth outbox, no retention / maintenance role / purge. No kit change, no contract change, no `audit_record` change.

## 14. Findings and deferred items

| # | Item | For |
|---|---|---|
| F1 | Per-service broker identity (P-A1). Today every service uses one broker user: catalog admission refuses a `source` that does not own the action (proven: an auth action claimed by `billing-service` → `producer_not_admitted`), but a holder of the shared credentials can still claim the **correct** source for an action. Not closed. | production prerequisite |
| F2 | Real producers (Payment, Billing, Organization relay, File bus + relay, Auth outbox) emit through `AuditEventWriter`. | 18.7 |
| F3 | The DLQ keeps a full copy of each refused message (the kit's format), including one refused as `sensitive_field` / `sensitive_value`: DLQ access control, TTL / purge, and whether sensitive refusals should drop the body. | 18.8 |
| F4 | The kit consumer maps a missing `version` header to 1 and drops a non-string `correlationId` header before the audit validator sees them (a kit property; the relay always sets both). Revisit if a producer outside the kit relay ever publishes. | Stage 21 (kit) |
| F5 | Shutdown with a stalled database is bounded by `DB_STATEMENT_TIMEOUT_MS` (30 s default), not by the 5 s consumer drain: the kit's `pool.end()` waits for a checked-out client. Correct and bounded; a shorter pool-close bound would be a kit change. | 18.9 / Stage 21 |
| F6 | Broker message size: the only bound before parsing is the broker's `max_message_size` (RabbitMQ 3.13 default 128 MiB); the contract refuses anything over its 4 KiB payload after parsing (a 1 MiB value tested). A production broker should set a small `max_message_size` (e.g. 1 MiB). | production prerequisite / 18.9 |
| F7 | Observability: percentiles, queue depth / oldest message in the snapshot, DLQ-depth and lag alert rules, per-event info-log volume. | 18.9 |
| F8 | The operational runbook (DLQ replay is documented in the README and §7; a full runbook with alerts). | 18.9 |
| F9 | Compose's / CI's `rabbitmq-diagnostics` health checks run as root inside the container; on a slow start they could create a root-owned `.erlang.cookie` before the server does (the §1 mechanism). Not observed in CI; `-u rabbitmq` or a host-side probe removes the race. | 18.9 / Stage 21 |
| F10 | Environment: once, about 20 minutes after the chaos restarts, the local RabbitMQ 3.13.7 node's `vm_memory_monitor` began crashing (`badarg` in `init`), after which new connections failed intermittently. A fresh container did not reproduce it (full e2e, chaos, mutations and kit suites re-run on it, log checked clean after each). Not a repository defect; worth watching when 18.9 runs long campaigns. | 18.9 (observe) |
| F11 | `CLAUDE.md` still names `libs/shared-types` and omits `libs/audit-contract` (18.4 F10). | 21.R1 |
| F12 | `audit.platform_query` (catalog + self-recording) with the query API. | 18.6 |

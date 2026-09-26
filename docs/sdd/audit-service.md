# audit-service

- **Status:** Draft (Stage 18.1 design). Stage 18.2: the service foundation (health, readiness, service auth, caller policy):
  [Stage 18.2 record](../architecture/stage-18/stage-18-2-service-foundation.md). Stage 18.3: the append-only `audit_record` and its
  repository: [Stage 18.3 record](../architecture/stage-18/stage-18-3-persistence-append-only.md). Stage 18.4: the shared contract
  `@nawara/audit-contract` (payload, catalog, validator, producer helper): [Stage 18.4 record](../architecture/stage-18/stage-18-4-canonical-contract-catalog.md),
  [catalog](../architecture/audit-event-catalog.md). Stage 18.5: the RabbitMQ ingestion (`audit-service.audit`, `audit.#`, the kit retry /
  DLQ, duplicate / conflict handling, readiness `rabbitmq` + `audit-ingestion`): [Stage 18.5 record](../architecture/stage-18/stage-18-5-rabbitmq-ingestion.md).
  Stage 18.6: the organization / platform reads, cursor pagination, rate limits and the self-audit of platform reads:
  [Stage 18.6 record](../architecture/stage-18/stage-18-6-query-authorization.md). Stage 18.7: every Core producer writes its catalog
  actions through the transactional outbox (Payment, Billing, Organization, File, and Auth after its outbox foundation), catalog
  corrections G1–G5: [Stage 18.7 record](../architecture/stage-18/stage-18-7-core-producer-integration.md). Stage 18.8: dead-letter
  redaction, the retention role and purge mechanism (no duration: P-A2), the limiter purge:
  [Stage 18.8 record](../architecture/stage-18/stage-18-8-security-privacy-retention.md).
- **Owners:** Anwar (project owner)
- **Related ADD:** [core-architecture.md](../architecture/core-architecture.md) (service map: "What happened, who did it, when?"; events
  only, never a synchronous dependency)
- **Related ADRs:** [0049](../adr/0049-audit-trail-architecture.md) (this service), [0032](../adr/0032-database-per-service-on-a-shared-server.md),
  [0033](../adr/0033-service-to-service-authentication-and-user-identity.md), [0034](../adr/0034-shared-service-kit-and-api-conventions.md),
  [0037](../adr/0037-reliable-events-outbox-inbox.md), [0042](../adr/0042-service-token-scopes-and-administrative-authorization.md)
- **Decisions and roadmap:** [Stage 18.1](../architecture/stage-18/stage-18-1-decisions-and-roadmap.md) (A1–A71, the inventory, the threat
  model, the growth model, the 18.2–18.10 plan)

## 1. Responsibility

**Owns:** validation, durable append-only storage, idempotent ingestion, retention and tenant-safe query of **audit records**: statements
by an owning Core service that a cataloged security or business action occurred.

**Does not own:** the meaning of any action (the producer decides), any domain's state or history of record (Billing's
`billing_transition`, Auth's `auth_audit_event`, Organization's `admin_actor_event`, File lifecycle, Notification delivery history stay
authoritative), application logs or metrics, user identity (ids only), administration UI and exports (Stage 19). It never calls Auth,
Organization or a product service.

## 2. Flow

```text
 owning Core service ── one transaction ──┬── domain change
                                          └── outbox row  "audit.<action>"  (kit OutboxService, same client)
                                                     │ COMMIT
                                                     ▼
                                      kit OutboxRelay ──► RabbitMQ nawara.events  (routing key audit.<action>)
                                                                     │
                                                                     ▼ queue audit-service.audit  (audit.#; .retry; .dead)
                                                            audit-service consumer
                                                                     │ validate (contract, catalog, producer, bounds)
                                                                     │ INSERT … ON CONFLICT (sourceService, eventId) DO NOTHING
                                                                     ▼
                                                              audit_record (append-only)
                                                                     │
                                                    service token + AUDIT_SERVICE_POLICY
                                                                     ▼
                                           organization-scope / platform-scope queries (products, Stage 19)
```

## 3. Envelope

The kit envelope, unchanged: headers `eventId` (the producer's outbox id, UUID), `occurredAt` (the producer database clock),
`correlationId`, `source` (the producing service), `version` (the audit payload version, 1); name / routing key `audit.<action>`.

## 4. Payload (contract version 1)

```jsonc
{
  "action": "membership.revoked",               // = the event name without "audit."; catalog-listed
  "actor": { "type": "user", "id": "<uuid>", "userKind": "owner" },   // user | service | system (A9)
  "organizationId": "<uuid>" | null,            // resource-derived; null = platform-level (A11)
  "resource": { "type": "membership", "id": "<uuid>" },
  "subject": { "type": "user", "id": "<uuid>" }, // optional, at most one (A12)
  "outcome": "succeeded",                        // succeeded | denied (catalog-limited)
  "changes": { "status": { "from": "active", "to": "revoked" } },     // optional, catalog keys only (A27, A28)
  "causationId": "<uuid>"                        // optional: the eventId that caused this action
}
```

| Field | Rule |
|---|---|
| `action` | kit name grammar; in the catalog; its catalog producer = the envelope `source` |
| `actor.type` | in the action's allowed set; `user` → `id` UUID + `userKind` ∈ {member, owner, operator}; `service` → `id` = a service name (caller grammar); `system` → `id` = a cataloged process code, no `userKind` |
| `organizationId` | UUID or null, per the action's organization rule (required / none / resource-derived) |
| `resource`, `subject` | `type` = the catalog's; `id` ≤ 128 chars `[A-Za-z0-9._:-]` |
| `outcome` | `succeeded`, or `denied` only where the catalog allows it |
| `changes` | ≤ 8 catalog keys; scalar or `{from, to}` of scalars; strings ≤ 64 safe chars; ≤ 1 KiB serialized; no secret-shaped value |
| whole payload | ≤ 4 KiB; unknown top-level fields refused |

Invalid → `PermanentEventFailure(reason)` → `<queue>.dead` at once, with a bounded reason: `invalid_envelope`, `unknown_action`,
`unsupported_version`, `producer_not_admitted`, `invalid_actor`, `invalid_organization`, `invalid_resource`, `invalid_changes`,
`sensitive_value`, `payload_too_large`, `event_id_conflict`.

**Implemented (Stage 18.4, `libs/audit-contract`); clarifications, no decision changed:** one validator for producers and Audit
(`validateAuditPayload`, `validateAuditEvent`); `organizationId` must be present (null explicitly); `subject`, `changes`, `causationId`
are absent rather than null / empty; every resource / subject id is a lowercase UUID; `code` changes are closed enumerations per action;
the organization rule gains `self` (the resource is the organization) and `resource` (the target when it is an organization); the reason
list is refined to `AUDIT_REFUSALS` (adds `invalid_payload`, `unknown_field`, `sensitive_field`, `event_type_mismatch`, `invalid_subject`,
`invalid_outcome`, `invalid_causation`, `invalid_correlation`; `transaction_required` is the producer helper's). Producers write through
`AuditEventWriter` on their business transaction. The catalog: [audit-event-catalog.md](../architecture/audit-event-catalog.md) (49 actions).

## 5. Data model (conceptual; the table is Stage 18.3)

`audit_record` — one row per accepted event, never updated, never deleted by the runtime.

| Column | Source | Null | Indexed | Notes |
|---|---|---|---|---|
| `id` | Audit (bigint identity) | no | PK | internal; the pagination tie-breaker; never exposed as identity |
| `eventId` | envelope | no | unique with `sourceService` | the external identity |
| `sourceService` | envelope `source` (authenticated per A20 once P-A1 exists) | no | (unique) | service grammar |
| `action` | payload | no | filter | catalog value |
| `category` | catalog | no | filter | security / business / commercial / administrative |
| `schemaVersion` | envelope `version` | no | — | never rewritten |
| `actorType`, `actorId`, `userKind` | payload | `userKind` only for users | (`actorType`, `actorId`, `occurredAt`) | ids only |
| `organizationId` | payload | yes (platform-level) | (`organizationId`, `occurredAt`, `id`) | never a wildcard |
| `resourceType`, `resourceId` | payload | no | (`resourceType`, `resourceId`, `occurredAt`) | |
| `subjectType`, `subjectId` | payload | yes | partial | |
| `outcome` | payload | no | filter | |
| `changes` | payload | yes | no | bounded jsonb |
| `correlationId` | envelope | yes | partial | navigation only (client-choosable) |
| `causationId` | payload | yes | — | |
| `occurredAt` | envelope | no | in the composite indexes | producer clock |
| `recordedAt` | Audit `now()` | no | yes (retention) | Audit clock |

Privileges: owner `audit_migrator`; runtime `audit_app` `INSERT, SELECT` (UPDATE / DELETE revoked from the Core default privileges);
append-only and no-truncate triggers; a separate maintenance role for retention purges past each category's horizon (built in 18.8:
migration `0003`, `audit_retention_policy` shipping empty, `audit_grant_retention`, the `audit_retention_run` ledger; the horizon is
measured on `recordedAt`, never the producer-controlled `occurredAt`).

**Implemented (Stage 18.3, `0001_audit_record.sql`); clarifications, no decision changed:** `id` is `GENERATED ALWAYS` (never
caller-supplied); `actorId` is never NULL (a system actor names its process code); `userKind` exactly for users; `changes` values are
strings of 1–64 `[A-Za-z0-9._:+-]`, integers within ±(2^53 − 1), booleans or null, ≤ 8 keys, ≤ 1 024 bytes of canonical jsonb text;
`recordedAt` is forced to the database clock by a trigger; `occurredAt` must be finite; `causationId` ≠ `eventId`; the mutating
privileges are taken back by `audit_restrict_to_append_only(table)`, the convention for every later append-only table; no fingerprint
column (every field is stored, so exact vs conflicting duplicates are compared field by field, `sameEvidence`).

## 6. Query (Stage 18.6; shape, not frozen routes)

- `GET /audit/organizations/{organizationId}/records` — capability `read_organization`; the path's organization is the only one
  returned; null-organization records never appear.
- `GET /audit/records` — capability `read_platform`; optional `organizationId` or `platform=true` for platform-level records; each call
  recorded as `audit.platform_query`.
- Filters: `action`, `category`, `actorType` + `actorId`, `resourceType` + `resourceId`, `subjectType` + `subjectId`, `sourceService`,
  `outcome`, `correlationId`, `from` / `to` (required; ≤ 92 days organization scope, ≤ 31 days platform scope).
- Pagination: `limit` ≤ 100 (default 50), opaque keyset cursor over (`occurredAt` DESC, `id` DESC); scope re-applied per page.
- Response items: `eventId`, `occurredAt`, `recordedAt`, `action`, `category`, `actor`, `organizationId`, `resource`, `subject`,
  `outcome`, `changes`, `sourceService`, `correlationId`, `causationId`. Identifiers only.
- Errors: kit body; `400 validation_error`, `401`, `403 operation_not_allowed`, `429 rate_limited`; a query never answers 404 for an
  organization without records (an empty page).

**Implemented (Stage 18.6); refinements, no decision changed:** the platform read is `GET /audit/platform/records` (explicit privileged
path) with optional `organizationId` or `platform=true`; filters exactly as above (`action` exact, no prefix in V1); `[from, to)` on
`occurredAt`, both required; the cursor is bound to caller + scope + filters + window (reuse elsewhere is `400 invalid_cursor`);
capabilities are not hierarchical; the recorded platform read is the catalog action `platform_query.executed` (A57's
`audit.platform_query`, renamed to the A13 grammar), written in the read's transaction, fail closed (`503 accountability_unavailable`);
errors add `invalid_scope`, `invalid_cursor`, `window_too_large`, `category_not_allowed`, `source_not_allowed`, `unexpected_body`;
`Cache-Control: no-store`; migration `0002` adds the platform-wide time index.

## 7. Caller policy

`AUDIT_SERVICE_POLICY` (deny by default, validated at boot, the File / Notification pattern): per caller `operations` ⊆
{`read_organization`, `read_platform`}, `categories` (subset), optional `sourceServices` (subset). Producer admission is the catalog
(action → producer), not the HTTP policy.

## 8. Configuration (indicative; fixed in 18.2+)

`DATABASE_URL` (runtime role), `SERVICE_TOKENS`, `AUDIT_SERVICE_POLICY`, `RABBITMQ_URL`, `AUDIT_QUEUE` (default
`audit-service.audit`), consumer prefetch, retry count / delay (kit), query page / window bounds, retention durations per category
(default: never purge until P-A2), clock-skew tolerance (5 min).

**Implemented (Stage 18.5):** `RABBITMQ_URL` (required), `RABBITMQ_CONFIRM_TIMEOUT_MS`, `RABBITMQ_HEARTBEAT_S` (kit bounds). The queue
(`audit-service.audit`), its binding (`audit.#`), the prefetch (half the pool, 1–10) and the retry (kit default 3 × 5 s) are fixed, not
settings; the clock-skew tolerance is the A22 constant (5 min). Readiness adds `rabbitmq` and `audit-ingestion`; `/health` unchanged.
Ingestion uses the audit record's `(sourceService, eventId)` constraint as its only idempotency state (no kit inbox: it would hide
conflicts). Refusal reasons are the contract codes verbatim plus `event_id_conflict`, `invalid_record`; the kit adds `malformed_envelope`
and `retries_exhausted`.

## 9. Observability

`audit_ops_snapshot` / counters in the File pattern: ingested, duplicates, invalid by reason, dead-lettered, clock skew, ingestion lag
(p50 / p95 of `recordedAt − occurredAt`), database failures, queries, `429`s, latency; queue depth and oldest message (broker); outbox lag
at producers (`check-outbox-lag`); DLQ depth (`check-dlq-depth`). Labels from closed sets only.

**Implemented (Stage 18.5):** `audit_ops_snapshot` every 60 s and at shutdown: `received`, `persisted`, `duplicate`, `refused` +
`refused_<reason>`, `transient_failure`, `clock_skew_future`, lag count / avg / max, `in_flight`, consumer state. Percentiles, queue depth
and age in the snapshot, and alert rules are 18.9.

## 10. Open items

Library placement: decided in 18.4 (`libs/audit-contract`). Auth outbox: built in 18.7.5 (migration `0010`, the kit relay). Retention mechanism: built in 18.8. Retention durations and erasure policy (owner / legal); Auth local-audit IP retention and minimization (P-A5, a decision: Stage 18.8 §7); per-service broker identity (P-A1); a broker for the deployed Auth (production prerequisite, Stage 18.7 §AF).

# Stage 18.1 — Security and business audit trail: architecture and decisions

- **Status:** design only, **for human review** (no code, no migration, no dependency, no commit). Decisions are marked **DECIDED**
  (proposed for acceptance with [ADR-0049](../../adr/0049-audit-trail-architecture.md)), **DEFERRED** (a named later stage) or
  **OWNER** (needs an owner / legal / security decision).
- **Documents:** [ADR-0049](../../adr/0049-audit-trail-architecture.md) (Proposed), [audit-service SDD](../../sdd/audit-service.md) (Draft).
- **Principle:** the service that owns a business or security action decides that it is audit-worthy and emits one canonical audit
  event, durably, in the same transaction as the change; `audit-service` validates, stores append-only, and answers tenant-safe queries.
  Audit is accountability **evidence**: never application logging, never a domain's history of record, never business truth.

## 1. Baseline

| Item | Value |
|---|---|
| Starting `main` | `06fa9534018bf4b029361645d66393413a01864b` (Stage 17 closed, PR #114) |
| Branch | `feat/audit-trail-architecture` |
| Working tree | clean except the unrelated untracked `docs/reports/` |
| Services | auth (deployed), organization (built, not authoritative), billing, payment, notification, file; `libs/service-kit` |

## 2. Repository investigation

### 2.1 Audit-like mechanisms that already exist

| Mechanism | Where | Shape | Write path | Read path | Verdict |
|---|---|---|---|---|---|
| `auth_audit_event` | auth migration `0003` | `bigserial id`, `occurredAt`, `type` (dotted, CHECK), `outcome` (`success`/`failure`/`denied`), `actorId`, `targetId`, `sessionFamilyId`, **raw `ip`**, `metadata jsonb < 2 KiB`; append-only trigger; indexes (actor, time), (type, time); **no organization column** | `AuditService.record(e, q)` inside the business transaction (atomic); `tryRecord` best effort on failure paths; credential-like metadata keys dropped, non-primitive / > 120-char values dropped | tests only (no API) | Auth's **local security audit**. The Core ADD already decides it **stays in Auth** (§2, §8). ~37 event types, including high-volume `auth.login` success / failure. |
| `admin_actor_event` | organization `0005` | actor user id + kind (`owner`/`operator`/`member`), session family, `operation`, target type / id, `correlation_id`, outcome (`succeeded`/`denied`/`failed`), reason class, `detail jsonb`; append-only + no-truncate triggers | same transaction as the admin operation | none | organization-local administrative record |
| `ownership_event`, `hierarchy_authority_event` | organization `0004`, auth `0008` | operator / provisioning actions of the ownership migration; append-only | same transaction | none | migration-control evidence (Stage 10) |
| `billing_transition` | billing `0008` (+ `0013` for Subscription) | every Invoice / PaymentRequest / Subscription state change: from / to, revision, **`actorType` ∈ {user, service, system}**, `actorId`, **`causeType` ∈ {request, payment_event, sweep, reconciliation, dispatcher}**, `causeId`, `correlationId`; append-only; a DEFERRED constraint trigger refuses a status change without its history row (BI-19) | same transaction (enforced) | billing internal | **Billing's authoritative domain history.** Its migration states: "a future audit-service receives Billing's events as a central copy and never replaces it." |
| Notification `notification` / `delivery` / `attempt` | notification `0001` | delivery lifecycle | Notification | Notification | delivery history (ADR-0046), **not audit** |
| File lifecycle columns + ops lines | file `0001`–`0003` | lifecycle stamps, tombstones | File | File | lifecycle authority (ADR-0048), **not audit** |

### 2.2 Event and correlation infrastructure (kit)

- **Envelope** (`libs/service-kit/src/events/types.ts`): `EventEnvelope { id, name, payload, headers }`; headers `eventId`, `occurredAt`,
  `correlationId?`, `source`, `version`, plus consumer-set `retryCount` / `replayCount`. Name grammar `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`
  (= routing key). **No `causationId`, no actor, no organization** in the envelope.
- **Outbox** (`kit_0001`): `outbox(id uuid PK, name, payload jsonb object ≤ 64 KiB, correlationId, eventVersion, occurredAt = now(),
  …)`; `OutboxService.enqueue(q, …)` takes the **transaction's** client ("the event exists iff the business change commits"); immutable
  once written; `OutboxRelay` publishes at least once (`FOR UPDATE SKIP LOCKED`, backoff ≤ 15 s, stamps `source` from configuration).
- **Inbox** (`kit_0001`): `inbox("eventId" uuid PK, source, name)`, inserted in the consumer's effect transaction (idempotent).
- **RabbitMQ bus**: topic exchange `nawara.events`, persistent messages, publisher confirms (5 s), per-queue `<queue>.retry` (3 × 5 s)
  and `<queue>.dead`, `PermanentEventFailure` → DLQ at once, prefetch default 5 (≤ 100), reconnect with backoff; operator tools
  `nawara-dlq` (inspect / replay), `check-dlq-depth`, `check-outbox-lag`.
- **Request context**: `requestId` (per hop) and `correlationId` (follows the operation, into outbox rows and event headers).
  **A client may supply `x-correlation-id`** (any 8–128 safe characters): correlation is a join key for logs, never evidence.
- **Broker identity**: every service connects as the same user locally (`guest` in Compose); `source` is a producer-set header. On
  the bus today, a producer's identity is **asserted, not authenticated**.

### 2.3 Producer readiness (who can emit durably today)

| Service | Kit outbox table | Enqueues in business transactions | Relay + RabbitMQ bus | Local audit / history | Readiness |
|---|---|---|---|---|---|
| payment | yes | yes (`payment.created/cancelled/succeeded/failed/expired`) | yes | — | **ATOMIC OUTBOX** |
| billing | yes | yes (`invoice.created`) | yes (also consumes `payment.*`) | `billing_transition` (atomic, enforced) | **ATOMIC OUTBOX** |
| organization | yes (kit migrations applied) | **no** (no event emitted; the ADD's `organization.*` events were never built) | no relay, no bus | `admin_actor_event`, `ownership_event` (atomic) | **OUTBOX-CAPABLE, NOT WIRED** |
| notification | yes | no (D23: outbound events only when a consumer exists — Audit) | bus (consumer) but no relay | delivery history | **OUTBOX-CAPABLE, NOT WIRED** |
| file | yes | no (F24: events when Stage 18 needs them) | **no bus at all** | lifecycle | **OUTBOX-CAPABLE, NOT WIRED** (needs a bus) |
| auth | **no** (not on the kit database layer; D19 deferred) | no; events are **fire-and-forget** (`EventsPublisherService`: logged and dropped on failure; lost between commit and broker) | kit bus, no relay | `auth_audit_event` (atomic) | **NOT YET READY** for a central guarantee (local audit is atomic) |

### 2.4 Authorization infrastructure

Service tokens (SHA-256 digest per caller, two per caller for rotation, ADR-0033); server-side caller policy per target, deny by default
(ADR-0042 decision 2; File `FILE_SERVICE_POLICY`, Notification `SERVICE_POLICY`); **producer admission** (ADR-0042 decision 4: a
documented first-party producer list per target, "Other producers are not admitted unless explicitly authorized"); tokens never carry a
user; organization context comes from the resource, never from a token or a client header (ADD §6); File's precedent (ADR-0048 F15 /
F16): Core authorizes **callers**, products authorize **users**, no synchronous call to Auth.

### 2.5 Findings recorded for other owners (not changed here)

- The ADD §8 says "no event is reliably delivered yet"; Billing and Payment have run the outbox since Stage 12 / 15 (ADD drift; 21.R1).
- ADR-0037 and ADR-0018 are still *Proposed* although their mechanism is in production-shaped use (owner acceptance, not Stage 18).
- `CLAUDE.md` names `libs/shared-types`; it does not exist (21.R1).

## 3. Definition (decisions A1–A6)

| # | Question | Decision | Status |
|---|---|---|---|
| A1 | What is an audit record? | An immutable, attributable statement by the **owning service** that a cataloged security- or business-significant action occurred: **who** (a verified actor), **what** (a cataloged action), **when** (`occurredAt`), **where** (organization context or explicitly platform-level), **on what** (a resource reference), **by which service** (`sourceService`), **linked to** (correlation / causation) — with bounded, cataloged change facts. | DECIDED |
| A2 | What is not? | A log line, a metric, a trace, a request record, a domain's state or history of record, a delivery attempt, a read of ordinary data, a copy of a business object, a free-text note. Anything not in the catalog. | DECIDED |
| A3 | Audit vs logs | Logs: technical, operational, short retention, may be sampled, readable by operators, never a legal record. Audit: selected, durable, append-only, tenant-scoped reads, retention by category. They share only `correlationId` (and the service name) so an investigator can move from a record to the logs of the same operation; no log is ever copied into Audit, and no audit field is required to exist in logs. | DECIDED |
| A4 | Audit vs domain history | A domain's own history stays **its** authority (`billing_transition`, Auth's `auth_audit_event`, Organization's `admin_actor_event`, File lifecycle, Notification attempts). Audit receives a **selected, cross-platform copy** of the actions with accountability value; it never replaces, reconstructs or reconciles domain state, and a domain never reads Audit to decide anything. | DECIDED |
| A5 | Audit vs observability | Observability (logs, `*_ops_snapshot` lines, metrics, alerts) answers "is the system healthy". Audit answers "who did what". Different lifecycle (days vs years), access (operators vs tenant-scoped / privileged), cardinality rules (Audit stores ids; observability labels never do). Audit Service itself has observability (§14). | DECIDED |
| A6 | Audit vs Stage 19 | Stage 18 builds the evidence capability: ingestion, storage, retention, and **service-level** query primitives with caller policy. Stage 19 builds privileged administration (operator consoles, audit viewer UI, cross-organization investigation workflows, export) **on top of** these primitives, as an admitted caller. Nothing in Stage 18 renders UI, resolves display names, or authorizes a human. | DECIDED |

## 4. What is audited (A7, A8)

**Selection rule (A7, DECIDED).** An action is audit-worthy when it changes **(a)** security posture (credentials, factors, recovery,
sessions under attack), **(b)** authority or access (membership, administrative capability, platform assignment, account enablement,
access grants), **(c)** ownership or lifecycle of an important business object (organization, subscription, file deletion), **(d)**
money or commercial state (invoice, payment, subscription, prices), or **(e)** is a privileged administrative intervention (owner /
operator acting on others, bulk or cross-organization operations) — **and** the owning service can attribute it to a verified actor.
Everything else is excluded unless a catalog PR justifies it against this rule (§12, A51).

### 4.1 Candidate inventory (the initial Core catalog is the "V1" column; names follow A13)

| Domain / producer | Action | Actor | Org | Resource | Category | V1 |
|---|---|---|---|---|---|---|
| **Auth** (membership) | `membership.approved`, `membership.rejected`, `membership.revoked` | user (org admin / owner / operator) | required | membership (+ subject user) | business | yes (after Auth outbox) |
| Auth | `membership.admin_granted`, `membership.admin_revoked` | user | required | membership (+ subject user) | security | yes |
| Auth | `membership.admin_provisioned` (invitation consumed) | user (the new admin) | required | membership | security | yes |
| Auth | `join_code.created`, `join_code.revoked`, `admin_invitation.created`, `admin_invitation.revoked` | user | required | join_code / admin_invitation | administrative | yes |
| Auth | `operator.created`, `account.disabled`, `account.enabled` | user (owner) | none (platform) | user | security | yes |
| Auth | `platform_assignment.granted`, `platform_assignment.revoked` | user (owner) | none | platform_assignment (+ subject user) | security | yes |
| Auth | `owner.password_changed`, `owner.secret_key_rotated`, `owner.factor_enrolled`, `owner.factor_removed`, `owner.recovery_started`, `owner.recovery_completed`, `owner.recovery_cancelled` | user (owner) / system | none | user / factor | security | yes |
| Auth | `session.refresh_reuse_detected`, `owner.webauthn_clone_suspected` | system | none | user | security | yes |
| Auth | `user.registered` | user (self) | from the join code | user | business | **no** (volume; onboarding evidence stays local) |
| **Organization** | `company.created`, `company.updated`, `platform.created`, `platform.updated` | user (owner / operator) or service (provisioning) | none | company / platform | administrative | yes (when organization-service emits) |
| Organization | `organization.created`, `organization.updated`, `organization.status_changed` (suspend / activate / deactivate) | user or service | the organization itself | organization | administrative | yes |
| Organization | `hierarchy.admin_operation_denied` (outcome `denied`) | user | as targeted | company / platform / organization | security | yes |
| **Billing** | `subscription.created`, `subscription.activated`, `subscription.renewed`, `subscription.grace_entered`, `subscription.reactivated`, `subscription.expired` | service (payment event) / system (expiry sweep) | required | subscription | commercial | yes |
| Billing | `invoice.issued`, `invoice.discarded`, `invoice.voided`, `invoice.paid` | service / user / system | required | invoice | commercial | yes |
| Billing | `payment_request.created`, `payment_request.cancelled` | service / user | required | payment_request | commercial | yes |
| Billing | `price.created`, `price.retired`, `product.created`, `product.archived` | service | none (platform catalog) | price / product | administrative | yes |
| **Payment** | `payment.created`, `payment.cancelled`, `payment.succeeded` (settlement accepted), `payment.failed`, `payment.expired` | service / system (sweeper) | required | payment | commercial | yes |
| Payment | cash confirmation, refunds, manual adjustments | — | — | — | commercial | **not built** (cataloged when they exist) |
| **File** | `file.deleted` (owner request) | service (the owner service; File never knows the user) | as recorded on the file | file | business | yes |
| File | `file.integrity_incident` (digest / size mismatch, object missing on read) | system | as recorded | file | security | yes |
| File | temporary-file expiry, upload, attach, download, ticket issue / redeem | — | — | — | — | **no** (see §4.2) |
| **Notification** | privileged manual send, template or delivery-policy change | — | — | — | — | **none exists**; cataloged only if such a capability is built |
| **Audit** | `audit.platform_query` (a platform-scope query) | service (the admitted caller) | none | — | security | yes (self-recorded) |

### 4.2 Excluded (A8, DECIDED)

Health and readiness requests; every HTTP request as such; metadata reads; ordinary file uploads, downloads, attach, ticket issuance and
redemption (File owns their lifecycle; rate and probing signals are observability); temporary-file expiry (a technical sweep of an
unattached upload); every notification delivery attempt (Notification owns delivery history); worker retries, relay retries, database
queries; successful routine logins and token refreshes, login failures, code requests and resolve failures (volume and privacy: they
stay in **Auth's local security audit**, which already holds them with the IP); invoice drafts and line edits before issue; limiter
decisions; storage operations; configuration reloads; audit-service's own organization-scoped paginated reads.

## 5. Actor and context (A9–A11)

| # | Question | Decision | Status |
|---|---|---|---|
| A9 | Actor types | `user`, `service`, `system` (Billing's proven vocabulary). **Operator and owner are not separate actor types**: they are Auth users with a generic kind (ADR-0009, ADD §1: `member | owner | operator`); a user actor carries `userKind` ∈ {member, owner, operator} **as it was when acting** (a bounded enum, the privilege context an investigator needs). `service`: `actorId` = the canonical service name (the service-token caller), used when a trusted service acts and no user was verified by the producer (e.g. File deleting on a product's request). `system`: an automated process of the producer (sweeper, expiry, worker, detection); `actorId` = a cataloged process code (e.g. `subscription_expiry_sweep`). An actor is recorded **only as verified by the producer**: a producer never forwards an unverified user id as a `user` actor. | DECIDED |
| A10 | Original actor vs source service | Separate fields: **actor** (who caused it) and **`sourceService`** (who emitted it; authenticated as in §8 / A20). A user action executed later by a worker keeps the **user** as actor when the producer carries the verified id through its own durable state (e.g. an outbox-driven step); otherwise the step is a `system` / `service` actor with **`causationId`** = the `eventId` that caused it, which links it to the user's record. | DECIDED |
| A11 | Organization context | `organizationId` = the organization **recorded on the affected resource in the producer's own database** (never a request header, token claim or client field). `null` = a platform-level record (Company, Platform, owner / operator security, catalog administration). `null` never means "all organizations": platform-level records are invisible to organization-scoped queries (§10). The catalog fixes per action whether the organization is required, forbidden or resource-derived. | DECIDED |

## 6. Resource, action, envelope, identity (A12–A15)

| # | Question | Decision | Status |
|---|---|---|---|
| A12 | Resource reference | `resource: { type, id }` — `type` fixed per action by the catalog, `id` an opaque producer identifier (UUID in every Core domain; ≤ 128 safe characters). Optional `subject: { type, id }` (at most one) when the affected party differs from the resource (the user whose membership changed). No foreign key, no join, no domain schema knowledge in Audit. | DECIDED |
| A13 | Action naming | `<resource_type>.<past_tense_verb>` in the kit event-name grammar, lowercase, machine-readable, never localized, never free text (`membership.revoked`, `subscription.grace_entered`). The catalog is the only source of valid actions; a rename is a new action plus a deprecation, never an edit. Aligned with the existing domain event names where they already exist (`payment.succeeded`). | DECIDED |
| A14 | Envelope | **Reuse the kit envelope unchanged** (`eventId`, `occurredAt`, `correlationId`, `source`, `version` in headers; flat payload). An audit event is a kit event whose name is `audit.<action>` and whose payload is the canonical audit payload (SDD §4): `action`, `actor`, `organizationId`, `resource`, `subject?`, `outcome`, `changes?`, `causationId?`. No second envelope. `version` = the audit contract's payload version (1). The prefix gives one routing binding (`audit.#`) and a broker write permission per producer (A20). Audit events are **separate** from domain events (which may carry contact data for Notification); a transaction that needs both enqueues both. | DECIDED |
| A15 | Event identity | The producer's outbox row id (a UUID generated in its transaction) is the `eventId`. Uniqueness scope **(`sourceService`, `eventId`)**, enforced by a unique index in Audit (no read-then-insert). A duplicate with the same content is a no-op; a duplicate with **different** content is a contract violation: the first record stands, the delivery is dead-lettered with reason `event_id_conflict` (never overwritten). Timestamps are never used for deduplication. | DECIDED |

## 7. Delivery and durability (A16–A19, A47, A48, A65)

**Alternatives (A16):**

| | A. Synchronous HTTP to Audit | **B. Producer outbox → RabbitMQ → Audit (chosen)** | C. Hybrid |
|---|---|---|---|
| Business availability | couples every audited action to Audit (and its database) | independent of Audit and of the broker | two behaviours to reason about |
| Evidence durability | lost if the producer crashes after commit and before the call; or the action fails with Audit | durable from the business commit (same transaction) | depends on path |
| Duplicates | retries create them unless idempotent | at least once; absorbed by A15 | both |
| Fit with Core | violates ADD §4 "events only, never a synchronous dependency" for Audit | reuses the kit outbox, relay, bus, DLQ tools; already run by Billing / Payment | none needed in V1 |

| # | Question | Decision | Status |
|---|---|---|---|
| A16 | Delivery | **B.** One ingestion path: producer outbox (same transaction) → relay → `nawara.events` → Audit's queue → idempotent insert. No HTTP ingestion route in V1 (no producer needs one; it would be a second trust boundary). | DECIDED |
| A17 | Can the business action succeed while Audit is down? | **Yes.** The action and its audit intent commit together; Audit, the broker or Audit's database being down only delays the record (the outbox row waits). Conversely the action **cannot** commit without its audit intent (same transaction): no silent loss. | DECIDED |
| A18 | Producer requirement | Every cataloged action is emitted with `OutboxService.enqueue(q, …)` on the **same transaction client** as the state change. A catalog entry names its producer; a producer without an atomic outbox may not emit that action centrally until it has one. | DECIDED |
| A19 | Producers without an atomic outbox | Classified honestly (§2.3). **Auth**: NOT YET READY — its security evidence remains atomic in `auth_audit_event`; its central events wait for an Auth outbox (D19), which Stage 18.7 schedules; no fire-and-forget audit publishing is allowed as a stop-gap (it would claim a guarantee it lacks). **Organization, Notification, File**: outbox-capable, need a relay (and File a bus) — wired in 18.7. **Billing, Payment**: ready. | DECIDED |
| A47 | Failure semantics | See the table below. | DECIDED |
| A48 | Duplicates | At least once end to end; the unique (`sourceService`, `eventId`) index makes a redelivery, a relay re-publish, a consumer crash after insert and a DLQ replay each produce exactly one record. | DECIDED |
| A65 | Consistency | Eventual: a record appears seconds after the business commit in normal operation (relay poll 1 s + consume), later during an outage (bounded only by recovery). The query API promises no read-after-write; responses may state the ingestion watermark (18.6). | DECIDED |

**Failure semantics (A47):**

| Failure | Business action continues? | Audit intent durable? | Retry safe? | Duplicates possible? | Evidence lost? |
|---|---|---|---|---|---|
| Audit Service down | yes | yes (outbox, then queue) | yes | yes (absorbed) | no |
| Audit's database down | yes | yes (message retried 3×, then `<queue>.dead`, replayable) | yes | yes (absorbed) | no, if the DLQ is replayed (DLQ depth alert, §14) |
| RabbitMQ down | yes | yes (outbox; relay backs off ≤ 15 s) | yes | yes | no |
| Producer crash before commit | the action did not happen | no event, correctly | — | — | nothing to lose |
| Producer crash after commit, before relay | yes | yes (outbox row) | yes | — | no |
| Relay crash between publish and stamp | — | yes | yes | yes (re-publish) | no |
| Consumer crash after insert, before ack | — | yes | yes | redelivery → no-op | no |
| Duplicate delivery / DLQ replay | — | — | yes | → no-op (A15) | no |
| Poison / invalid event | — | dead-lettered at once (`PermanentEventFailure`), never dropped | after a fix, by replay | — | no (it waits in the DLQ) |
| Producer bug: wrong content, valid shape | yes | stored as sent | — | — | no loss; **wrong evidence**: corrected by a later action, never edited (A24) |
| Producer without outbox (Auth today) | yes | **no central guarantee** (local audit only) | — | — | central copy **not emitted** until the Auth outbox exists |
| Outbox row deleted by a producer operator | — | no | — | — | **yes** (outside the threat model: producer database administrators are trusted, §13) |

## 8. RabbitMQ topology and poison events (A20, A49)

| Element | Decision |
|---|---|
| Exchange | the existing topic exchange `nawara.events` |
| Routing key | the event name `audit.<action>` (e.g. `audit.membership.revoked`) |
| Queue | `audit-service.audit` bound to `audit.#` (durable), with the kit's `<queue>.retry` (3 × 5 s) and `<queue>.dead` |
| Consumer | prefetch ≤ the kit default (5), one insert transaction per message; no ordering assumption |
| Poison (A49) | schema / catalog / producer mismatch → `PermanentEventFailure(reason)` → DLQ immediately; database / transient → bounded retry → DLQ |
| Producer authentication | **catalog binding** (V1, application level): an action's producer is fixed in the catalog; an event whose `source` header differs is dead-lettered (`producer_not_admitted`). **Broker identity (production prerequisite P-A1)**: one RabbitMQ user per service with a topic write permission limited to `^audit\.` for admitted producers (and each producer's own domain prefixes), and the AMQP `user-id` message property set by the publisher, which **RabbitMQ validates against the authenticated connection**; Audit maps the validated broker user to `sourceService` and refuses a mismatch with `source`. Until P-A1, `source` is asserted, and the residual is stated (T1). |

## 9. Ordering, time, schema (A21, A22, A34, A50)

| # | Question | Decision | Status |
|---|---|---|---|
| A21 | Ordering | None assumed. Records are ordered for reading by `occurredAt` (then a stable id). No producer sequence number in V1: no query needs a total order per resource, and domains that need one keep their own (Billing `revision`). A per-resource sequence can be added as an optional payload field later without changing stored rows. | DECIDED |
| A22 / A34 | Time | UTC `timestamptz`. `occurredAt` = the producer outbox row's `occurredAt` (its database clock at the business transaction). `recordedAt` = Audit's database `now()` at insert. Never local time; presentation localizes. An `occurredAt` more than 5 minutes after `recordedAt` is **stored as sent** (evidence is never discarded for a clock fault) and counted (`audit_clock_skew`, §14); a far-past `occurredAt` is normal (outage backlog, replay). | DECIDED |
| A50 | Schema evolution | The kit `version` header is the audit payload version. Additive optional fields keep the version; a breaking change is `version + 1`, and Audit accepts `N` and `N − 1` during a rollout. Stored rows keep their `schemaVersion` and are **never rewritten**. Audit is deployed (with the newer catalog) **before** its producers; an unknown action or version is dead-lettered, then replayed after the upgrade. | DECIDED |

## 10. Persistence, immutability, tamper resistance (A23–A26, A45, A46)

| # | Question | Decision | Status |
|---|---|---|---|
| A25 | Database authority | `audit-service` owns its own database (`audit`, roles `audit_migrator` / `audit_app`, ADR-0032); no cross-service key, no join into any product database. | DECIDED |
| A26 | Model | One table `audit_record` (SDD §5): internal `id` (bigint identity, never exposed), `eventId`, `sourceService`, `action`, `category` (from the catalog), `schemaVersion`, `actorType`, `actorId`, `userKind`, `organizationId`, `resourceType`, `resourceId`, `subjectType`, `subjectId`, `outcome`, `changes jsonb` (bounded), `correlationId`, `causationId`, `occurredAt`, `recordedAt`. No event-sourcing platform, no projection tables in V1. | DECIDED |
| A23 | Immutability | Append-only. The runtime role gets `INSERT, SELECT` only (Core's default privileges grant `UPDATE, DELETE` to `*_app`, so the migration revokes them on this table explicitly), plus append-only and no-truncate triggers (the Organization / Auth pattern). | DECIDED |
| A24 | Corrections | Never by editing. Wrong business facts are corrected by the producer's next real action (its own record). A generic "correction" event is **not** in V1 (no case needs it); if one is ever needed it is an additive catalog action referencing the corrected `eventId`. | DECIDED |
| A45 | Database tamper resistance | Guarantee, precisely: **the Audit runtime cannot alter or delete a record** (privileges + triggers; the migrator owns the schema). It does **not** protect against a database superuser, the schema owner, a backup restore, or someone with host access. Retention deletion runs under a separate maintenance role (A41), never the runtime role. | DECIDED |
| A46 | Cryptographic tamper evidence | **Not in V1.** The V1 threat model trusts database administrators (as every Core service does); hash chains or signatures would add key management and a verification process without a consumer. Triggers for adding it: a regulator or customer requirement for independently verifiable logs; an insider-with-database-access threat entering scope; external auditors. Direction then: a per-period hash chain over `(recordedAt, id)` order with periodic anchoring to write-once external storage. | DEFERRED (trigger-based) |

## 11. Metadata, before / after, privacy (A27–A32)

| # | Question | Decision | Status |
|---|---|---|---|
| A27 | Metadata | No free-form metadata. One bounded `changes` object whose **keys are declared per action in the catalog**; ≤ 8 keys; each value a scalar (enum-like string ≤ 64 safe characters, boolean, integer, ISO date, UUID) or `{ from, to }` of scalars; depth ≤ 2; serialized ≤ 1 KiB; the whole audit payload ≤ 4 KiB. Anything else is rejected (dead-lettered `invalid_changes`), never truncated silently. Not indexed. | DECIDED |
| A28 | Before / after | Only producer-selected, cataloged fields as `{ from, to }` (e.g. `role: { from: member, to: admin }`, `status: { from: active, to: grace }`). **No generic object snapshots**, no full rows, no diffs of arbitrary JSON. | DECIDED |
| A29 | Sensitive data | Never: passwords or hashes, OTPs, reset / recovery tokens, bearer or refresh tokens, service tokens, API keys, file tickets, storage keys or credentials, payment credentials, card / bank data, secret keys, WebAuthn assertions, cookies, raw request bodies. **Producer duty**: emit only cataloged keys. **Audit defense**: catalog key allow-list, value grammar, a forbidden-key pattern (Auth's `FORBIDDEN_KEY` family) and secret-shaped value checks (JWT, long base64 / hex) → dead-letter `sensitive_value`, never store. | DECIDED |
| A30 | PII | Identifiers only (UUIDs, service names, process codes). No email, phone, name, address, IP, file name, invoice number or amount text in V1 fields. Amounts / currencies may appear as cataloged `changes` only where commercially necessary (decided per action in 18.4; the V1 catalog needs none). | DECIDED |
| A31 | Actor snapshot | Immutable `actorId` + `userKind` only. Display names / emails are resolved at read time by the consumer (Stage 19) from Auth; a deleted or anonymized user shows as its id. No identity copy in Audit. | DECIDED |
| A32 | IP / user agent | **Not in central audit V1.** Security evidence with IP stays in Auth's local security audit (it already stores the raw IP; its retention is a legal item, P-A5). If Stage 19 needs request origin centrally, it would be an optional, keyed (HMAC) client reference with its own shorter retention — a later decision. | DECIDED |

## 12. Correlation, catalog, categories, severity, localization (A33, A51–A54)

| # | Question | Decision | Status |
|---|---|---|---|
| A33 | Correlation | `correlationId` from the kit context (outbox → header), stored and indexed; `causationId` (the `eventId` of the event that caused a consumer-driven action) in the audit payload. `requestId` is per hop and stays in logs, joinable through `correlationId`. Because a client can choose `x-correlation-id`, correlation is a **navigation aid, never evidence**: it is bounded (the kit's safe grammar), never used for authorization or deduplication. | DECIDED |
| A51 | Catalog governance | One reviewed catalog: action → producer, category, resource / subject types, organization rule (required / none / resource-derived), allowed actor types, allowed `changes` keys, outcome set, since-version. Stored as data + types in a small dedicated contract library (direction: `libs/audit-contract`, technical contract only, validated by `check:repo`; the exact placement is an 18.4 decision) and documented in `docs/architecture/audit-event-catalog.md`. A new action = a catalog PR justified against A7. Producers and Audit validate against the same catalog. | DECIDED (placement: 18.4) |
| A52 | Categories | Bounded: `security`, `business`, `commercial`, `administrative`, **derived from the catalog** (never producer-supplied). Uses: retention class (A41), caller visibility (a product caller may be denied `security`), query filter. | DECIDED |
| A53 | Severity | **None.** No consumer exists; alerting on audit content belongs to a security-monitoring capability (later), and severity would duplicate the action. | DECIDED |
| A54 | Localization | Actions, codes and stored values are language-neutral identifiers; English / French / Arabic (RTL) rendering is presentation (Stage 19 / products). Never a sentence in storage. | DECIDED |

## 13. Query, authorization, retention (A35–A44, A55–A57, A66)

| # | Question | Decision | Status |
|---|---|---|---|
| A35 | Filters | Bounded, each index-backed: action (or an action prefix within the catalog), actor (`actorType` + `actorId`), resource (`resourceType` + `resourceId`), subject, source service, category, outcome, `occurredAt` range, `correlationId`. No free text, no arbitrary JSON filters, no sorting choice. | DECIDED |
| A36 | Pagination | Keyset on (`occurredAt` DESC, `id` DESC) with an opaque cursor; scope and filters are re-applied on every page (a tampered cursor cannot widen scope, so it needs no signature). A late record with an older `occurredAt` appears in its time position (A65). A future export path may page by (`recordedAt`, `id`) with a settle margin. | DECIDED |
| A37 | Indexes | V1: unique (`sourceService`, `eventId`); (`organizationId`, `occurredAt` DESC, `id` DESC); (`actorType`, `actorId`, `occurredAt` DESC); (`resourceType`, `resourceId`, `occurredAt` DESC); (`subjectType`, `subjectId`, `occurredAt` DESC) partial where present; (`correlationId`) partial; (`recordedAt`) for retention. Action / category are filters inside these. Six to seven index writes per insert are affordable at the estimated rates (§15); re-checked with plans in 18.3 / 18.9. | DECIDED |
| A38 | Tenant-safe query | Two capabilities: **organization scope** — exactly one `organizationId` per request, required, results filtered to it (never null-organization records); **platform scope** — may query null-organization and any organization, only for callers granted it (Stage 19's admin service, a security tool). No list of organizations, no wildcard, no "all" value. | DECIDED |
| A39 | Read authority | V1: trusted internal services only, via service token + caller policy. Products call Audit **after** authorizing their user against their own resource (the File / ADR-0048 pattern); Audit does not authenticate end users. | DECIDED |
| A40 | Caller policy | The kit service auth plus `AUDIT_SERVICE_POLICY` (deny by default): per caller `operations` ⊆ {`read_organization`, `read_platform`}, allowed `categories`, optional allowed `sourceServices`. Ingestion needs no HTTP policy (bus only) but has its own **producer admission list** (the catalog's producer per action, ADR-0042 decision 4). | DECIDED |
| A36b | No synchronous Auth dependency | Audit never calls Auth or Organization on a query or an ingestion. | DECIDED |
| A41 | Retention | Per category, configurable durations; a purge job deletes records past their category's horizon in bounded batches, as a separate **maintenance role** whose privilege the append-only trigger admits only for rows past their horizon. The durations themselves are **legal / owner decisions** (P-A2); the defaults ship "never purge" until set. | DECIDED (mechanism) · OWNER (durations) |
| A42 | Erasure tension | Audit holds pseudonymous identifiers, no contact data; erasing a person's identity in Auth leaves audit records pointing at an id that resolves to nothing, which is the intended minimization. Whether a legal erasure request must also remove or re-pseudonymize audit records, and for how long evidence must be kept against such a request, is **for legal / privacy policy** (P-A3). The mechanism (a maintenance-role redaction of `actorId` / `subjectId` to a tombstone value, recorded as its own `audit.record_redacted` action) is reserved, not built. | OWNER |
| A43 | Partitioning | **No** in V1 (§15). Design stays partition-ready: retention by time; if partitioned later by `recordedAt` month, the dedupe key moves to a small receipt table `(sourceService, eventId)` because a partitioned unique index must include the partition key. Trigger: ≈ 50 M rows, or daily purges beyond ≈ 100 k rows. | DECIDED |
| A44 | Archiving | **No** in V1 (no volume, no requirement). Trigger: retention longer than online storage budget allows, or a legal hold requirement; direction: export closed partitions to write-once object storage (File's provider class). | DEFERRED |
| A55 | Future admin UI | The query contract returns exactly what a viewer needs (time, actor ref, action, resource ref, organization, source, correlation, `changes`), identifiers only; Stage 19 resolves names and renders. | DECIDED |
| A56 | Export | Not in V1. Keyset paging keeps it possible; export will be a platform-scope, rate-limited, **audited** operation (Stage 19). | DEFERRED |
| A57 | Auditing audit access | Platform-scope queries are recorded by Audit itself (`audit.platform_query`: caller service, filters' shape, not results); organization-scope paginated reads are **not** recorded (recursion, noise) — they appear in technical logs with bounded fields. Exports and cross-organization investigations (Stage 19) are recorded by their initiator with the verified operator. | DECIDED |
| A66 | Query range | Page size ≤ 100 (default 50); an organization-scope query requires a time window ≤ 92 days (the cursor walks within it); platform-scope ≤ 31 days; unbounded scans only through a future export path. Per-caller and per-(caller, organization) rate limits with the kit limiter. | DECIDED |

## 14. Threat model (A58), abuse (A59), backpressure (A60), observability (A61)

| # | Threat | Prevention | Detection | Assumption | Residual | Later |
|---|---|---|---|---|---|---|
| T1 | Producer impersonation on the bus | catalog-bound producer per action; `source` must match | DLQ `producer_not_admitted`; counters | broker credentials not leaked | until P-A1, any holder of broker credentials can publish with another service's `source` for actions cataloged to it | P-A1 per-service broker users + validated `user-id` |
| T2 | Forged actor | only the producer sets the actor, from its verified context; catalog actor-type set | review of producer code (18.7) | admitted producers are trustworthy first-party code | a compromised producer can lie within its own actions | — |
| T3 | Forged organization | resource-derived by the producer (A11); never a request field | — | producer resolves it from its own rows | a producer bug records the wrong tenant | 18.7 tests per producer |
| T4 | Forged resource | catalog-fixed resource type; id grammar | — | as T2 | as T2 | — |
| T5 | Duplication | unique (`sourceService`, `eventId`) | duplicate counter | — | none | — |
| T6 | Loss | same-transaction outbox; DLQ never drops | outbox lag, DLQ depth, ingestion lag | producers without outbox not cataloged (A19) | Auth central events until its outbox; an operator deleting outbox rows | 18.7 Auth outbox |
| T7 | Replay (re-sending an old event) | idempotency by id; a new id with old content is a new, correctly attributed record | — | — | a producer can re-emit facts (its own evidence) | — |
| T8 | Cross-organization query | one organization per request, scope re-applied per page, null excluded | query logs | the caller authorized its user for that organization | a product that authorizes wrongly reads its own tenants' data (as with File, R5) | 18.6 tests |
| T9 | Unauthorized platform query | `read_platform` capability only by policy | `audit.platform_query` records | — | a stolen platform-capable token | Stage 19 hardening |
| T10 | Secrets in metadata | catalog keys, value grammar, secret-shape checks | DLQ `sensitive_value` counter | — | a secret disguised as a legitimate enum value | 18.8 fuzz |
| T11 | Oversized metadata | ≤ 1 KiB `changes`, ≤ 4 KiB payload (kit outbox caps 64 KiB) | DLQ | — | none | — |
| T12 | Log injection | ids / codes in logs only, grammar-checked; no payload values logged | log scans (18.8) | — | none | — |
| T13 | Record modification | runtime `INSERT`/`SELECT` only + triggers | — | DB superuser trusted | superuser / owner / restore | A46 trigger |
| T14 | Record deletion | same; retention only by maintenance role past horizon | purge counters | as T13 | as T13 | — |
| T15 | Timestamp manipulation | `recordedAt` from Audit's clock; `occurredAt` from the producer database | clock-skew counter | producer databases keep sane clocks | a producer can backdate within its own actions | — |
| T16 | Queue poisoning | validation → immediate DLQ; bounded retry | DLQ depth alert | — | a flood of invalid events fills the DLQ | P-A1 limits who can publish |
| T17 | DLQ neglect | `check-dlq-depth` alert rule; runbook | alert | someone is on call (P-A4) | evidence delayed while neglected | 18.9 |
| T18 | High-volume DoS by a producer | catalog selection rule; bounded payload; consumer prefetch | ingestion rate, queue depth | producers are first-party | a buggy producer floods; business is unaffected, records are delayed | 18.9 per-source rate signal |
| T19 | Query scraping | page ≤ 100, time windows, per-caller / per-org limits | rate counters | — | a caller within its budget | — |
| T20 | Correlation-ID abuse | never evidence or authorization; grammar-bounded | — | — | a client can make unrelated records share a correlation id | — |
| T21 | Malicious Unicode / action strings | ASCII grammar for action, codes, ids, `changes` keys and values | DLQ | — | none | — |
| T22 | SQL / filter injection | parameterized SQL, whitelisted filters, no dynamic columns | — | — | none | — |
| T23 | Retention bypass | purge only by maintenance role; runtime cannot delete | purge report | — | a mis-set duration | P-A2 |
| T24 | Unauthorized export | no export in V1 | — | — | — | Stage 19 (audited) |

**A59 — abuse:** ingestion is **never rate-limited by dropping**: backpressure is the queue (a slow consumer only delays), and the
payload bounds plus producer admission limit what one producer can do. Query APIs use the kit limiter per caller and per (caller,
organization), `429 rate_limited`, as File does.

**A60 — backpressure:** producer outbox → broker queue → consumer; business operations never wait for Audit. Signals: queue depth and
oldest-message age (`audit-service.audit`), DLQ depth, producer outbox lag (`check-outbox-lag`), ingestion lag (`recordedAt −
occurredAt`, p95 per interval), consumer failures.

**A61 — observability:** an `audit_ops_snapshot` / counters line in the File / Notification pattern: ingested, duplicates, invalid (by
bounded reason), DLQ-routed, clock-skew, database failures, ingestion lag, query count / latency / `429`s. **Never** `actorId`,
`organizationId`, `resourceId`, `eventId`, correlation id or caller-supplied values as labels.

## 15. Growth (A67), partitioning, indexes

Assumptions (the V1 catalog, no logins, no reads): a typical organization produces ≈ 20 audit records a day (membership decisions ≈ 2,
invoices / payment requests ≈ 10, payments ≈ 6, file deletions ≈ 2, subscription / organization changes < 1); platform-level security
and administration add ≈ 50 a day in total. Row ≈ 0.5 KiB heap + ≈ 0.5 KiB across the V1 indexes ≈ **1 KiB / record**.

| Organizations | Records / day | Records / year | Storage / year | Peak insert rate (×10 of average) |
|---|---|---|---|---|
| 10 | ≈ 250 | ≈ 0.09 M | ≈ 0.1 GiB | < 1 / s |
| 100 | ≈ 2 050 | ≈ 0.75 M | ≈ 0.7 GiB | < 1 / s |
| 1 000 | ≈ 20 000 | ≈ 7.3 M | ≈ 7 GiB | ≈ 2–3 / s |
| 10 000 | ≈ 200 000 | ≈ 73 M | ≈ 70 GiB | ≈ 25 / s |

Conclusion: a single table with B-tree indexes serves V1 and the 1 000-organization horizon comfortably (the File certification's
500 000-row plans were sub-millisecond on the same class of indexes). Partitioning (A43) and archiving (A44) have explicit triggers
instead of being built now.

## 16. Cross-service boundaries (A62–A64) and Stage 19 (A6)

- **Billing / Payment (A62):** Audit records that a commercial action occurred; Billing (invoice, Subscription, `billing_transition`) and
  Payment (payment, attempts) remain the only authorities of commercial state. Audit is never read to decide a price, a payment state, an
  entitlement or an accounting entry, and accounting never consumes audit records.
- **File (A63):** Audit may hold `file.deleted` and `file.integrity_incident` with the file id and organization; never bytes, names,
  storage keys, tickets, digests or the lifecycle of record (File's tombstone remains the lifecycle evidence).
- **Notification (A64):** no Notification / Delivery / Attempt copy; only a future privileged notification capability would be
  cataloged.
- **Auth:** keeps its local security audit (logins, failures, IPs) as authority for authentication forensics; central audit receives the
  authority / security changes of §4.1 once Auth has an outbox.
- **Organization:** keeps `admin_actor_event` / `ownership_event`; central audit receives the hierarchy actions of §4.1.

## 17. Naming and prefix (A68, A69)

`audit-service` (the ADD's name, the `<noun>-service` convention); database `audit`; routes under `/audit` (the Core prefix pattern:
`/file`, `/billing`); **no** API naming change (21.R1 / 21.R2).

## 18. Roadmap (A69) and producer order (A70)

The proposed decomposition holds, with two changes: the contract / catalog precedes ingestion (both producers and the consumer need it),
and producer integration is split by readiness because Auth needs an outbox first.

| Stage | Scope | Notes |
|---|---|---|
| 18.1 | architecture and decisions | this record, ADR-0049, SDD |
| 18.2 | service foundation: `audit-service` on the kit (config, health / ready, service auth, `AUDIT_SERVICE_POLICY` skeleton, DB provisioning `audit_migrator` / `audit_app`, image, Compose, CI) | no domain yet; **done**: [18.2 record](./stage-18-2-service-foundation.md) |
| 18.3 | persistence: `audit_record`, append-only privileges and triggers, indexes, the retention role's hook (no purge yet), repository with idempotent insert, plans at scale | **done**: [18.3 record](./stage-18-3-persistence-append-only.md) (the maintenance role's hook is documented, not built: 18.8) |
| 18.4 | canonical contract and catalog: the contract library, payload validation (shared by producers and Audit), the initial Core catalog (§4.1), the catalog document, producer helper over the kit outbox | **done**: [18.4 record](./stage-18-4-canonical-contract-catalog.md) (placement: `libs/audit-contract`; 49 actions, [catalog](../audit-event-catalog.md)) |
| 18.5 | ingestion: the RabbitMQ consumer (`audit.#`), validation, producer admission, idempotency, DLQ reasons, clock-skew handling, with a test producer | **done**: [18.5 record](./stage-18-5-rabbitmq-ingestion.md) |
| 18.6 | query and authorization: organization / platform scope, filters, keyset pagination, limits, `audit.platform_query` | **done**: [18.6 record](./stage-18-6-query-authorization.md) (`platform_query.executed`; index `0002`) |
| 18.7 | producer integration, in order: **(a) Payment, (b) Billing** (outbox ready; commercial evidence), **(c) Organization** (relay + bus; hierarchy administration), **(d) File** (bus + relay; two actions), **(e) Auth: adopt the kit outbox (D19), then its §4.1 actions** (highest security value, largest and riskiest change to a deployed service — its local audit keeps the evidence meanwhile), Notification: nothing to integrate in V1 | **done**: [18.7 record](./stage-18-7-core-producer-integration.md) (sub-stages 18.7.1–18.7.7; all 50 actions wired; catalog corrections G1–G5; Auth migration `0010`) |
| 18.8 | security, privacy, retention: sensitive-value defenses and fuzzing, retention purge with the maintenance role, threat verification (§14), log / cardinality scans | **done**: [18.8 record](./stage-18-8-security-privacy-retention.md) (DLQ redaction; retention mechanism, migration `0003`, no duration: P-A2 open; limiter purge; P-A5 raised as a decision) |
| 18.9 | operational hardening: lag / DLQ / queue signals, runbook, backlog and outage probes, plans with volume | **done**: [18.9 record](./stage-18-9-operational-hardening.md) (DLQ-confirm hold; broker / dead-letter counters and a log budget in `audit_ops_snapshot`; fault-injected outages, crash windows, backlog, retention interruption) |
| 18.10 | focused certification | **done**: [18.10 record](./stage-18-10-focused-certification.md) — **Stage 18 CLOSED** (production prerequisites P-A1–P-A8 stay open); Stage 22 stays the Core validation |

**Why this producer order (A70):** readiness first (no outbox work for Payment / Billing proves the pipeline end to end), then the
producers that only need wiring (Organization, File), then Auth, whose change is structural (a kit outbox in a deployed service not yet on
the kit database layer); security evidence for Auth is not at risk meanwhile because `auth_audit_event` is atomic.

## 19. Production prerequisites (A71)

| # | Prerequisite | Why |
|---|---|---|
| P-A1 | Per-service RabbitMQ users, topic write permissions (`^audit\.` only for admitted producers), publisher `user-id` validated by the broker | producer authentication on the bus (T1) |
| P-A2 | Retention durations per category (security, business, commercial, administrative) | legal / owner (A41) |
| P-A3 | Erasure / pseudonymization policy for audit records | legal / privacy (A42) |
| P-A4 | Alert routing for DLQ depth, ingestion lag, clock skew, invalid-event rate | T17 |
| P-A5 | Retention of Auth's local security audit (raw IPs) | privacy; already an open Core item (core-validation F12) |
| P-A6 | RabbitMQ in production (ADR-0018 / ADR-0037 production deployment) | the ingestion path depends on it |
| P-A7 | Backups of the `audit` database with a restore that preserves append-only guarantees | evidence durability |
| P-A8 | `AUDIT_SERVICE_POLICY` entries for real readers (products, Stage 19 admin service) | A40 |

## 20. Open questions (genuinely unresolved)

1. **Owner:** retention durations (P-A2) and the erasure policy (P-A3).
2. **Owner / security:** whether per-service broker identity (P-A1) is required before production or accepted as a stated residual for
   the first deployment.
3. **18.4:** placement of the contract library (`libs/audit-contract` vs the kit) — a packaging choice, not an architecture change.
4. **18.7:** whether Auth's outbox adoption is a sub-stage of 18.7 or its own stage (size to be measured against the Auth code base).

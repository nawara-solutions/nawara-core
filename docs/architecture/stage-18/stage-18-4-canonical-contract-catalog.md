# Stage 18.4 — Canonical audit contract and event catalog

- **Status:** implemented and validated on `feat/audit-contract-catalog` (awaiting review; not committed).
- **Scope:** the shared producer-facing audit contract (`libs/audit-contract`, `@nawara/audit-contract`): the canonical V1 payload, the
  initial Core catalog (49 actions), the one runtime validator shared by producers and audit-service, the transactional producer helper
  over the kit outbox, the contract → persistence mapping in audit-service, the generated catalog document, tests (unit, adversarial,
  real PostgreSQL), dependency-direction checks.
- **Not in scope (and not present):** the RabbitMQ consumer (18.5), query routes (18.6), any change to a real producer or the Auth outbox
  (18.7), retention (18.8). No change to `audit_record`, its privileges, triggers, indexes or repository (18.3 frozen), nor to the kit.
- **Frozen design followed:** [ADR-0049](../../adr/0049-audit-trail-architecture.md) (Accepted), [SDD §3–§5](../../sdd/audit-service.md),
  [Stage 18.1](./stage-18-1-decisions-and-roadmap.md) A7–A15, A21–A33, A50–A54, A64, [Stage 18.3](./stage-18-3-persistence-append-only.md).
  No decision reopened; no persistence incompatibility found.

## 1. Baseline

`main` at `a31d667834b11ccfbb3ba5fa162439caa53fe388` (Stage 18.3 merged, PR #117); working tree clean except the untracked
`docs/reports/` (untouched). Inspected: the kit envelope (`events/types.ts`), `OutboxService`, `OutboxRelay`, `InboxService`, the RabbitMQ
consumer's envelope parsing, `kit_0001` (outbox `occurredAt DEFAULT now()`), the request-context correlation grammar, every service's
mutating routes, Auth's local audit types, Organization's `admin_actor_event`, Billing's transitions and actors, Payment's statuses and
outbox events, File's deletion and integrity paths.

## 2. Contract location (A51: the placement decision)

| Option | Producers need no audit-service internals | Audit uses the same validator | No cycle / right direction | Verdict |
|---|---|---|---|---|
| `libs/service-kit` | yes | yes | puts an audit/domain catalog (`membership.revoked` → Auth, `security`) into generic transport infrastructure; every kit consumer ships it | **rejected** (the kit's boundary, §4 of the brief; `check:repo` keeps domain concepts out of the kit) |
| `libs/shared-types` (named by `CLAUDE.md`) | yes | yes | a catch-all "shared types" package with no single reason to exist; it does not exist (18.1 finding, 21.R1) | **rejected** (not created for stale documentation) |
| types inside audit-service, copied by producers | no (copies drift) | no | — | **rejected** (two validators, §27) |
| **`libs/audit-contract` (`@nawara/audit-contract`)** | yes | yes | depends on nothing; producers and audit-service depend on it; the kit never does | **chosen** |

Dependency graph (verified: the package's `src` imports only its own files; `check:repo` enforces the direction; no cycle):

```text
 payment / billing / organization / file / auth (18.7) ──► @nawara/audit-contract ◄── audit-service (".", "./consumer")
 @nawara/audit-contract  ──(tests only)──►  @nawara/service-kit, pg
 @nawara/service-kit  ──✗──►  @nawara/audit-contract            (refused by check:repo)
 @nawara/audit-contract/src  ──✗──►  any package                 (refused by check:repo)
 "./consumer" outside audit-service, "./testing" outside tests    (refused by check:repo)
 any service ──✗──► apps/audit-service/src/…                    (the existing cross-service import rule)
```

The kit `OutboxService` and `Queryable` are consumed **structurally** (`AuditOutbox<Q>`, `AuditQueryable`): the typecheck proves the kit's
classes satisfy them (the integration suite passes a real `OutboxService` and a `pg` client).

## 3. Public API

| Entry | Exports |
|---|---|
| `@nawara/audit-contract` | `AuditEventWriter`, `validateAuditPayload`, `AuditContractError`, `AUDIT_REFUSALS`; `AUDIT_CATALOG` (read-only `Map`), `AUDIT_ACTIONS`, `CORE_PRODUCERS`, `catalogEntry`, `actionsOwnedBy`; `AUDIT_CONTRACT_VERSION` (1), `SUPPORTED_AUDIT_VERSIONS` ([1]), `AUDIT_CATEGORIES`, `ACTOR_TYPES`, `USER_KINDS`, `AUDIT_OUTCOMES`; types `AuditPayload`, `AuditActor` (`UserActor` / `ServiceActor` / `SystemActor`), `AuditReference`, `ChangeValue`, `AuditEventInput<A>`, `AuditChangesOf<A>`, `AuditResourceTypeOf<A>`, `AuditOutcomeOf<A>`, `AuditSubjectOf<A>`, `CatalogEntry`, `ChangeSpec`, `AuditWriteOptions`, `AuditWriteResult`, `AuditQueryable`, `AuditOutbox`, `AuditOutboxEvent` |
| `@nawara/audit-contract/consumer` (audit-service only) | `validateAuditEvent`, `ValidatedAuditEvent`, `AuditEnvelopeInput` |
| `@nawara/audit-contract/testing` (tests only) | `sampleAuditPayload`, `sampleActor`, `sampleActions`, `SAMPLE_IDS` |

Internal (not exported): grammars, the sensitive-data lists, the jsonb size model, the catalog-document renderer. audit-service keeps its
own `toNewAuditRecord` (its persistence is its own; no producer can reach it).

## 4. Canonical payload (V1) and the envelope

```jsonc
// kit envelope: id = headers.eventId (outbox UUID) · name = "audit.<action>" · headers.source · headers.occurredAt · headers.correlationId? · headers.version = 1
{
  "action": "membership.revoked",                                  // catalog key; name = "audit." + action, exactly
  "actor": { "type": "user", "id": "<uuid>", "userKind": "owner" }, // | { "type": "service", "id": "<service>" } | { "type": "system", "id": "<process code>" }
  "organizationId": "<uuid>" | null,                                // ALWAYS present (null = platform-level, never "all")
  "resource": { "type": "membership", "id": "<uuid>" },
  "subject": { "type": "user", "id": "<uuid>" },                    // absent when none (never null)
  "outcome": "succeeded",                                           // | "denied" where cataloged
  "changes": { "authority": "owner", "was_admin": false },          // absent when none (never {} or null)
  "causationId": "<uuid>"                                           // optional
}
```

| Fact | Where | Who sets it |
|---|---|---|
| `eventId` | envelope `id` = `headers.eventId` | the producer's outbox (`randomUUID()` in its transaction); optionally a producer-chosen UUID for a retried operation (`AuditWriteOptions.eventId`) |
| event type | envelope `name` = `audit.<action>` | derived by the writer from the action; the consumer refuses any other name (`event_type_mismatch`) |
| `sourceService` | `headers.source` | the relay, from the producer's configured service name; the writer is built with the same name and refuses actions it does not own |
| `occurredAt` | `headers.occurredAt` | the outbox row's `now()` = the business transaction's database time (proved equal in the integration suite); never the consumer's time |
| `correlationId` | `headers.correlationId` | the kit request context by default, or `AuditWriteOptions.correlationId`; optional; navigation only |
| version | `headers.version` | the writer (always 1); not repeated in the payload |
| `category` | nowhere on the wire | the catalog, at validation time (a payload `category` is `unknown_field`) |
| `causationId` | payload | the producer, when a consumer-driven step records the event that caused it (the kit envelope has no causation; changing it for Audit alone was not justified — A14) |

## 5. Actor, organization, resource, subject, outcome

- **Actor (A9):** `user` = a verified Auth user id (lowercase UUID) + `userKind` ∈ the action's allowed kinds; `service` = a service name
  (the kit caller grammar) where the action allows service actors; `system` = one of the action's listed process codes (e.g.
  `payment_expiry_sweep`). No `operator` or `owner` actor type; `userKind` only on users (the types make other shapes unrepresentable, the
  validator refuses them at runtime).
- **Organization (A11):** rule per action — `required` (UUID), `none` (null), `optional` (UUID or null as recorded on the resource: File,
  Payment), `self` (equals `resource.id`: `organization.*`), `resource` (equals the target when it is an organization, null otherwise: the
  hierarchy denial). The key must be present even when null (platform scope is never the accident of a forgotten field). **Trust
  boundary:** the helper cannot prove the organization is the resource's; the producer must read it from its own row (T3).
- **Resource / subject (A12):** `{ type, id }`, type fixed by the catalog (one type per action, three for the hierarchy denial), id a
  lowercase UUID (every Core resource id is a UUID; canonical case means PostgreSQL stores exactly what was sent). At most one subject,
  `forbidden` / `required` with a fixed type; no arrays, no graphs.
- **Outcome:** `succeeded` everywhere except three intentional security entries whose outcome is `denied`: `session.refresh_reuse_detected`,
  `owner.webauthn_clone_suspected`, `hierarchy.admin_operation_denied`. No generic `request.denied`; routine authentication failures
  stay in Auth's local audit (A8).

## 6. Changes model and sensitive data

- Per action, an allow-list of keys (`^[a-z][a-z0-9_]{0,31}$`), each `{ type, shape, required }`: `code` (a **closed enumeration**,
  `^[a-z][a-z0-9_.]{0,63}$`), `uuid`, `boolean`, `integer` (bounds, ±(2^53 − 1)), `timestamp` (UTC, milliseconds, a real instant);
  shape `value` or `transition` (`{ from, to }` exactly, `from ≠ to`). ≤ 8 keys; the jsonb text length PostgreSQL computes (`": "`,
  `", "`) ≤ 1 024 bytes, modeled exactly (equality proved against PostgreSQL); whole payload ≤ 4 KiB. Absent when there is nothing,
  never `{}`. In V1, 20 actions carry changes, using 12 keys: `authority`, `was_admin`, `invitation_id`, `platform_id`, `method`,
  `operation`, `reason`, `product_id`, `price_id`, `period_end`, `invoice_id`, `settled_method`. No amount, currency, name, contact, IP,
  storage key, ticket, snapshot or free text anywhere.
- **Sensitive-data defense, layered.** (1) Primary: closed key sets at every level and per-action change allow-lists — an arbitrary
  `password` key can never be valid. (2) Before any structural rule, every key at every level is checked against credential /
  secret / contact concepts (fragments after normalization: `password`, `secret`, `token`, `apikey`, `authorization`, `cookie`,
  `credential`, `ticket`, `storagekey`, `signedurl`, `cardnumber`, `email`, `phone`, `ipaddress`, `useragent`, `session`, …; short
  whole words: `otp`, `pin`, `cvv`, `ip`, `jwt`, `sid`, `key`, `name`, …) → `sensitive_field`; every string leaf against secret shapes
  (JWT, ≥ 32 hex, long mixed base64 runs; UUIDs excluded) → `sensitive_value`. (3) ASCII grammars refuse control, bidirectional and
  confusable characters. Not claimed: detection of a secret disguised as a valid enum value (T10 residual) — the enumerations make that
  practically impossible for `code` changes.
- **Canonicalization:** none. Nothing is trimmed, lowercased, coerced (`"true"`, `"123"` are refused), repaired or dropped. The validator
  returns a NEW deep-frozen payload built from validated primitives (a getter, a replaced prototype, a class instance or a symbol key is
  refused; mutating the caller's object afterwards cannot change what was validated or written).

## 7. The initial catalog (49 actions)

Full table (actors, organization, resource, subject, outcomes, changes, purpose): the generated
[`audit-event-catalog.md`](../audit-event-catalog.md). Why each is central (A7) — and why it is **currently real**:

| Producer | Actions | Why central | Existing code path |
|---|---|---|---|
| auth-service (24; emits after its outbox, 18.7) | `membership.approved / rejected / revoked` | access to a tenant granted or removed by an identified administrator | `MembershipService.decide / revoke` |
| | `membership.admin_granted / admin_revoked` | privilege grant with step-up, owner only | `MembershipService.setAdmin` |
| | `membership.admin_provisioned` | a new organization administrator exists (invitation consumed) | `InvitationService` consume |
| | `join_code.created / revoked`, `admin_invitation.created / revoked` | ways into a tenant (and into its administration) opened or closed | `OnboardingService`, `InvitationService` |
| | `operator.created`, `account.disabled / enabled` | privileged cross-organization staff accounts | `OperatorAdminService` |
| | `platform_assignment.granted / revoked` | operator authority over a platform | `AssignmentService` |
| | `owner.password_changed`, `owner.secret_key_rotated`, `owner.factor_enrolled / factor_removed`, `owner.recovery_started / completed / cancelled` | the most privileged account's credentials, factors and takeover window | `owner.controller`, `EnrollmentService`, `RecoveryService` |
| | `session.refresh_reuse_detected`, `owner.webauthn_clone_suspected` (denied) | detected credential theft / cloned authenticator | `RefreshTokenService`, `FactorService` |
| organization-service (7) | `company.created / updated`, `platform.created / updated`, `organization.created / updated` | tenant hierarchy administration | companies (service token), admin (owner / operator) and platform / organization routes |
| | `hierarchy.admin_operation_denied` (denied) | a human refused hierarchy administration (no authority / no step-up) | `AdminController` denial records |
| billing-service (11) | `subscription.activated / renewed` | an organization's paid entitlement begins or extends | `SubscriptionRepository.applySuccessfulPayment` (payment event consumer, reconciler) |
| | `invoice.issued / discarded / paid` | a legal claim created, abandoned, settled | invoice routes, payment event handling |
| | `payment_request.created / cancelled` | collection requested / withdrawn | payment-request routes |
| | `product.created / archived`, `price.created / retired` | what the platform charges | catalog routes |
| payment-service (5) | `payment.created / cancelled / succeeded / failed / expired` | money requested, settled, failed, lapsed | `PaymentService`, `AttemptService`, webhooks, `ExpirySweeper` (the existing outbox writes) |
| file-service (2) | `file.deleted` | irreversible loss of a stored document, on its owner service's request | `DeletionService` |
| | `file.integrity_incident` | stored content contradicts its record (tampering or loss) | download integrity checks, `reconcile-core` |
| notification-service | **none** | no privileged Notification capability exists (A64) | — |

**Rejected / deferred candidates:**

| Candidate | Why not in V1 |
|---|---|
| `organization.status_changed` | no organization status exists (the repository explicitly has "no delete, no status") — cataloged when built |
| `subscription.created` | always created in the same transaction as its first activation (`applySuccessfulPayment`): no separate accountability fact |
| `subscription.grace_entered`, `subscription.expired`, `subscription.reactivated`, cancellation scheduling / termination | repository methods with **no caller** (no sweeper, no route): cataloged with the sweeper / route that performs them |
| `invoice.voided` (issued → void) | not allowed by the state machine (B-015) |
| `invoice.created`, draft edits | drafts are excluded (A8); Billing's history keeps them |
| `payment_request.*` beyond created / cancelled (sending, requested, paid, failed, expired, rejected) | dispatcher / gateway mechanics; Billing's `billing_transition` is authoritative |
| payment attempts, cash confirmation, refunds, manual adjustments | attempts are Payment's own history; the others are not built |
| `user.registered`, logins, refresh, code requests, resolve failures, step-up, contact verification, `owner.totp.key_unavailable` | volume and privacy: Auth's local security audit (A8, with the IP) |
| owner recovery **failures / cooldown denials** | routine authentication failures (local audit); only the state changes are central |
| ownership migration (`ownership_event`, `hierarchy_authority_event`) | one-time migration-control evidence, kept locally (Stage 10) |
| File upload, attach, download, ticket issue / redeem, temporary expiry | ordinary activity; File's lifecycle is authoritative (A8, A63) |
| Notification send / cancel, delivery attempts | delivery history, no privileged capability (A64) |
| `audit.platform_query` | the query API does not exist yet: cataloged with it in 18.6 |
| any `request.denied` for 403s | Audit is not request logging |

## 8. Runtime validation and refusal codes

`validateAuditPayload(payload, sourceService)` (producer and consumer) and `validateAuditEvent(envelope)` (consumer: envelope + payload).
Order: plain JSON object → layer-2 scan (sensitive keys, secret-shaped strings, non-JSON values, width ≤ 16, depth ≤ 3) → top-level
allow-list → action (grammar, ≤ 100, catalog, looked up in a `Map`) → producer ownership → actor → resource → organization → subject →
outcome → changes → causation → size.

Codes (`AUDIT_REFUSALS`; stable, lowercase, never carrying the refused value; 18.5 uses them as `PermanentEventFailure` reasons):
`invalid_payload`, `payload_too_large`, `unknown_field`, `sensitive_field`, `sensitive_value`, `unknown_action`, `producer_not_admitted`,
`event_type_mismatch`, `invalid_actor`, `invalid_organization`, `invalid_resource`, `invalid_subject`, `invalid_outcome`,
`invalid_changes`, `invalid_causation`, `invalid_correlation`, `invalid_envelope`, `unsupported_version`, `transaction_required` (writer
only). They follow the SDD §4 list (`event_id_conflict` stays 18.5's, decided by `sameEvidence`), split where 18.4 needed precision.

## 9. Producer helper

`new AuditEventWriter({ sourceService: config.serviceName, outbox })`, then `await writer.write(tx, input, { eventId?, correlationId? })`:

1. validate (no statement is sent for an invalid event);
2. `SAVEPOINT nawara_audit_intent` / `RELEASE` on `tx`: SQLSTATE 25P01 (outside a transaction block: a pool, an autocommit client) →
   `transaction_required`; any other error propagates unchanged;
3. `outbox.enqueue(tx, { name: 'audit.<action>', payload: <canonical>, version: 1, id?, correlationId? })` on **the same client**.

It never begins, commits, rolls back or publishes; there is no `emit()` convenience. A service that owns no action (Notification, Audit)
cannot even construct a writer. The helper proves structure, ownership and policy — never business truth (actor authorization, the
resource's organization, that the change happened): the producer's duty, reviewed per producer in 18.7.

## 10. Persistence mapping

`apps/audit-service/src/persistence/audit-record.mapper.ts` `toNewAuditRecord(ValidatedAuditEvent) → NewAuditRecord`: field for field,
nothing derived or defaulted (`eventId`, `sourceService`, `schemaVersion`, `occurredAt`, `correlationId` from the envelope; `category` from
the catalog; everything else from the canonical payload; `subject` / `changes` / `causationId` → `null` when absent; `recordedAt` never
mapped). 18.5's consumer: `validateAuditEvent` → `toNewAuditRecord` → `AuditRecordRepository.insertOnce` (+ `sameEvidence` for
`event_id_conflict`). Producer-side code cannot reach it.

## 11. Versioning and rollout

`version` (envelope) = contract version 1; `SUPPORTED_AUDIT_VERSIONS = [1]`; any other value, including `"1"` and 1.5, is
`unsupported_version` (never reinterpreted); an action's `since` must not exceed the event's version. Additive changes (a new action, an
optional key) keep version 1; a breaking change is version 2 with audit-service accepting N and N − 1 during the rollout (A50).
**Rollout order: audit-service with the new catalog first, producers second.** A producer ahead of audit-service produces dead letters
(`unknown_action`), replayed after the upgrade — never lost, never stored as "unknown". No feature flag: the order is a deployment rule.
Sub-millisecond precision of `occurredAt` is not carried (the kit relay reads the row into a JavaScript `Date`): a kit property, recorded.

## 12. Evidence

| Suite | Result |
|---|---|
| contract unit (`libs/audit-contract`, vitest): catalog completeness and ownership (per action), the §39 matrix for every action (table-driven), adversarial (§40), envelope, writer, catalog document equality | **858 / 858** |
| contract integration, real PostgreSQL 16.15 (`postgres:16-alpine`) + real kit `OutboxService` / `OutboxRelay` / `InMemoryEventBus` | **10 / 10** |
| audit-service unit (incl. the mapper for every action × minimal / complete) | **141 / 141** (was 42) |
| audit-service E2E, real PostgreSQL 16.15 (incl. `contract-persistence`: 98 cases, every action × 2, runtime role) | **266 / 266** (was 166) |
| service-kit unit / PostgreSQL integration suites (kit unchanged) | 132 / 132; 8 files, 64 / 64 |
| `check:repo`; its tests | pass; 17 / 17 (a new dependency-direction test) |
| lint (audit-contract, audit-service), typecheck, build (audit-contract, audit-service) | 0 warnings; clean |
| production image (`docker build` + `scripts/smoke-core-image.sh`) | SMOKE PASSED (uid 1000, `/health` 200 stable, `/ready` 503 without a database); image contains `libs/audit-contract/dist` only (49 actions load) |

**Transaction atomicity (real PostgreSQL):** business write + helper + ROLLBACK → 0 / 0 rows; + COMMIT → 1 / 1; a business failure after
the audit write → 0 / 0; pool and autocommit client → `transaction_required`, 0 rows; an invalid event inside the transaction → nothing
written. **Outbox row:** `audit.file.deleted`, `eventVersion` 1, a v4 UUID id, the given correlation id, `occurredAt` = the transaction's
`now()`, payload deep-equal to the canonical payload with exactly its six keys (no source, category, event type, time, storage, ticket).
A producer-chosen `eventId` written twice → one row. **Relay:** the kit relay (source = the configured name) publishes it; the received
envelope passes `validateAuditEvent` unchanged; the same envelope with `source` = another service → `producer_not_admitted`.

**Persistence compatibility:** every one of the 49 actions, minimal and complete, validates, maps and inserts as `audit_app` into the
frozen 18.3 table with no constraint refusal, round-trips every field (actor kind, organization, resource, subject, outcome, changes,
correlation, causation, schema version, `occurredAt` exactly as sent including a far-past one), `recordedAt` from Audit's clock, and a
redelivery returns `duplicate` with `sameEvidence` true. The contract's jsonb length model equals PostgreSQL's `octet_length(jsonb::text)`
on edge objects (≥ 1 024 bytes included) and every cataloged sample.

**Mutations (20; each applied exactly once, run, restored, SHA-256 verified; all 11 sources identical afterwards):**

| # | Mutation | Result |
|---|---|---|
| M1 | unknown action accepted | killed (1) |
| M2 | producer ownership disabled | killed (100) |
| M3 | payload `category` accepted | killed (50) |
| M4 | wrong resource type accepted | killed (57) |
| M5 | forbidden-subject check removed | **survived — equivalent**: the subject is still refused by the type check (a forbidden rule has no type); the explicit check stays as intent |
| M5a | subject type and forbidden rule ignored | killed (49) |
| M5b | required subject may be omitted | killed (8) |
| M6 | unknown change key accepted | killed (49) |
| M7 | required change may be omitted | killed (3) |
| M8 | wrong change type accepted | killed (3) |
| M9 | unknown top-level field ignored | killed (103) |
| M10 | sensitive key accepted | killed (48) |
| M11 | event type / action mismatch accepted | killed (1) |
| M12 | helper opens its own transaction (`BEGIN` instead of the guard) | killed (unit 3, PostgreSQL 1: the rollback proof) |
| M13 | `sourceService` caller-controlled | killed (1) |
| M14 | transaction guard removed | killed (unit 3, PostgreSQL 1) |
| M15 | organization rule `none` ignored | killed (22) |
| M16 | user kind not checked | killed (21) |
| M17 | catalog edited without regenerating the document | killed (1) |
| M18 | mapper drops `causationId` | killed (49) |

## 13. Scope proof

- No RabbitMQ consumer: audit-service has no `EventsModule`, no subscription, no `RABBITMQ_URL`; the only bus use is the kit
  `InMemoryEventBus` inside the contract's test.
- No query API: audit-service's routes are still `/health` and `/ready` only.
- No producer integration: no file under `apps/{auth,organization,billing,payment,file,notification}-service` changed; no service imports
  `@nawara/audit-contract` except audit-service.
- No Auth outbox, no retention, no maintenance role, no kit change (`libs/service-kit` byte-identical to `main`), no change to
  `audit_record` or its migration.

## 14. Findings and deferred items

| # | Item | For |
|---|---|---|
| F1 | Organization-service is not yet authoritative for Company / Platform / Organization (Auth still owns them, Stage 10): its `company.*`, `platform.*`, `organization.*` actions must be emitted by whichever service is authoritative when 18.7 integrates; the catalog names organization-service (18.1 A70) — revisit if authority is not activated first | 18.7 |
| F2 | Auth's `RecoveryService.cancel` and Organization's denial records are written without a business transaction today; the helper requires one (wrap the state change / denial record and the audit write in one transaction) | 18.7 |
| F3 | `file.integrity_incident` is detected on the download path (repeatable): emit once per file and reason (deterministic `eventId`), or rate-bound it, to keep a hostile download loop from flooding Audit (T18) | 18.7 |
| F4 | Billing's system actor id is `null` in `billing_transition`; the audit process codes (`payment_event_consumer`, `payment_reconciler`) must be set by the producer, and `causationId` = the Payment event id for consumer-driven steps | 18.7 |
| F5 | The DLQ reason for each refusal code, `event_id_conflict`, clock-skew counting | 18.5 |
| F6 | `audit.platform_query` joins the catalog with the query API (producer: audit-service itself) | 18.6 |
| F7 | Fuzzing of the validator and log / cardinality scans | 18.8 |
| F8 | Per-service broker identity (P-A1): until then `source` is asserted on the bus; the catalog binding limits damage (T1) | production prerequisite |
| F9 | The kit RabbitMQ integration suites could not run locally (the broker image fails to start in this Docker host: Erlang cookie `eacces`); the kit is unchanged and CI runs them | environment |
| F10 | `CLAUDE.md` still names the non-existent `libs/shared-types`; it now also omits `libs/audit-contract` | 21.R1 |

## 15. Documentation

New: this record, [`audit-event-catalog.md`](../audit-event-catalog.md) (generated), `libs/audit-contract/README.md`. Updated: the
18.1 roadmap row, the SDD (status, §4 implemented note, §10), the SDD index, `core-architecture.md`, `apps/audit-service/README.md`.

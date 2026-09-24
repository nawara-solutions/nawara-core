# Stage 16.4 — Notification persistence and template versioning

- **Status:** implemented and validated (2026-09-24), pending review
- **Decision:** [ADR-0046](../../adr/0046-notification-service-architecture.md) rules 2, 5, 7, 9 and 12; D5, D7 and D18 in the
  [Stage 16.1 register](./stage-16-1-decisions-and-roadmap.md); the data model, state machines and templates in the
  [notification-service SDD](../../sdd/notification-service.md) §3–§6.
- **Scope:** the database, the five tables and their invariants, the template catalog and its publication. There is no event
  consumer (16.5), no send API (16.6), no worker (16.7) and no provider (16.8). The service still sends nothing.

## 1. Database infrastructure (reused, nothing new in the kit)

- **Provisioning** (`infra/postgres/init/01-service-databases.sh`, as for every Core service):
  - the `notification` database;
  - `notification_migrator` (owns the schema, DDL, used only by `npm run migrate`);
  - `notification_app` (CONNECT and DML through default privileges; no superuser, no CREATE, no other database).

  `infra/postgres/verify.sh` covers both roles, and CI runs it. `.env.example` and Compose carry the dev passwords.
- **Runtime:**
  - the kit `DbModule` with the kit's bounded `DB_*` limits: pool 10, connect 5 s, `statement_timeout` 30 s,
    `idle_in_transaction` 60 s, client query deadline 35 s;
  - `application_name = notification-service`;
  - `/ready` = `database` + `migrations` (the kit checks);
  - the pool closes last at shutdown.

  `DATABASE_URL` is required. In production a `postgres`, `root` or `*_migrator` user is refused at startup (ADR-0032, as for
  Billing and Organization). There is no lock timeout, because the kit has none; none was invented.
- **Migrations:** the kit runner (advisory lock, checksums, one transaction per file, no-op rerun) with `kit_0001`–`kit_0003`,
  then:
  - `0001_notification_schema.sql`: the five tables, their constraints, triggers and indexes;
  - `0002_publish_templates_v1.sql`: the generated V1 catalog.

  The image carries both directories. Migrating with the runtime credentials fails (`permission denied for schema public`).

## 2. Model

```text
notification_template 1 ─< notification_template_version ─┐ (pinned: id + channel + locale)
        │ (id, category)                                    │
        ▼                                                   ▼
notification ─────────────────────────────1:N──────► notification_delivery 1 ─< notification_delivery_attempt
(the immutable intent, ONE recipient, no status)     (one per channel)          (one per provider call)
```

### 2.1 `notification`

- **Columns:** the SDD §3.1 columns exactly.
- **Identity:** a CHECK sets exactly the identity fields of the source kind:
  - `event` → `sourceEventId`;
  - `api` → `idempotencyKey` + `requestHash` (a SHA-256).

  Two partial unique indexes enforce them: `(sourceService, sourceEventId) WHERE sourceKind = 'event'` and
  `(sourceService, idempotencyKey) WHERE sourceKind = 'api'`. Both columns are NOT NULL within their kind, so no NULL can slip
  through a unique index.
- **Category:** `(templateId, category)` is a foreign key to the template, so the copied category can never disagree.
- **One recipient:** a generic reference (`recipientType` + `recipientId`, both or neither), never contact data.
  - There is no recipient list, audience or segment. A multi-recipient operation creates one notification per recipient.
  - `organizationId` is nullable (platform-level notifications).
- **No stored status:** it is derived from the deliveries (SDD §5.1).
- **`data`:** a JSON object of the NON-secret variables, ≤ 8 KB.
- **Secrets:** `secretCiphertext` and `secretKeyId` are both set or both NULL, bounded.
- **Immutability:** every column except the secret pair, which can only be purged to NULL (never set later or replaced), and
  the cancel stamp, which is set once.

### 2.2 `notification_delivery`

- **Columns:** the SDD §3.2 columns exactly.
- **Uniqueness:** `UNIQUE (notificationId, channel)`: one delivery per channel.
- **The pinned version:**
  - `(templateVersionId, channel, locale)` is a foreign key to the version's `(id, channel, locale)`, so a delivery always has
    its version's channel and locale;
  - an insert trigger refuses a version of another template.
- **The destination snapshot:** required for EMAIL / SMS and NULL for IN_APP; ≤ 320 characters, no control character.
  - It is stored verbatim: no normalization, no country prefix.
  - Its format (E.164 for SMS, D20) is validated at intake (16.5), which records an invalid one as `FAILED invalid_destination`.
    A DB CHECK would make that impossible.
- **State:**
  - created `PENDING` only (a trigger);
  - "scheduled", "queued" and "retry" are `PENDING` + `nextAttemptAt`;
  - CHECKs tie the state fields to the status: `nextAttemptAt` ⇔ `PENDING`, `leaseUntil` ⇔ `SENDING`, `sentAt` ⇔ `SENT`,
    `failedAt` ⇔ `FAILED`, `completedAt` ⇔ terminal, and `FAILED` needs a bounded `failureCode` (never provider text).
- **Guards:**
  - the transition trigger allows exactly the frozen matrix (§3 below);
  - a terminal delivery is final in **every** field (a second trigger);
  - `updatedAt` follows every update;
  - identity, channel, destination, version and locale are immutable.

### 2.3 `notification_delivery_attempt`

- **Columns:** the SDD §3.3 columns.
- **Uniqueness:** `UNIQUE (deliveryId, attemptNumber)`.
- **Lifecycle:** inserted `STARTED` only; completed exactly once to `ACCEPTED`, `RETRYABLE_FAILURE`, `TERMINAL_FAILURE` or
  `AMBIGUOUS` (`completedAt` ⇔ final); then immutable. The identity columns never change.
- **What it holds:** attempt history, one row per call. It is delivery evidence, not the platform Audit Service. There is no raw
  response, request or body.

### 2.4 Templates

- **`notification_template`:**
  - `key` matches the SDD pattern and is unique among platform templates (a partial unique index on `organizationId IS NULL`);
  - `category` is `SECURITY`, `TRANSACTIONAL` or `OPTIONAL`;
  - `ownerScope` is `platform`; `organization` is reserved, with `organizationId` set exactly when the scope is `organization`;
  - the identity and category are immutable.
- **`notification_template_version`:**
  - **Uniqueness:** `UNIQUE (templateId, channel, locale, version)`.
  - **Email:** a one-line subject is required and HTML is optional.
  - **SMS:** a body only, plus `smsMaxSegments` (1–10).
  - **Checksum:** SHA-256 of the canonical content.
  - **Permanence:** every column is immutable, and a delete is refused (a trigger).
  - **Active version:** the highest version per `(template, channel, locale)`.
- **What is never stored:** rendered bodies (D18), provider payloads and credentials. There is no preference, recipient-list,
  campaign or push-device table.

## 3. Delivery transition matrix (database-enforced)

| From | Allowed to |
|---|---|
| `PENDING` | `SENDING`, `CANCELLED`, `EXPIRED` |
| `SENDING` | `SENT`, `PENDING`, `FAILED`, `UNCONFIRMED`, `EXPIRED` |
| `SENT`, `FAILED`, `UNCONFIRMED`, `EXPIRED`, `CANCELLED` | nothing (final) |

Cancellation in the database is `PENDING → CANCELLED` only. A delivery already `SENDING` cannot be cancelled here; the
cancel-vs-claim race and the fact that a provider call in flight cannot be recalled are the 16.6 / 16.7 contract (SDD §9.3).

## 4. Templates: format, check, publication

- **Files** (`apps/notification-service/templates/`):
  - `catalog.json` (`requiredLocales`);
  - `<key>/template.json` (category, description);
  - one immutable file per version: `<key>/<CHANNEL>.<locale>.v<N>.json` (variables, subject, bodyText, bodyHtml,
    smsMaxSegments).
- **Language:** `{{variableName}}` only. Every other `{{`, `}}`, a triple brace, logic, helpers, partials or whitespace inside
  braces is refused.
- **Variables:** the SDD §6.2 closed types (`string`, `integer`, `datetime`, `code`, `url`).
  - `secret: true` is a **flag** (SDD §6.2), not a type, and only on a `code` or a `string`.
  - `string`, `code` and `url` need a `maxLength` (≤ 2048).
  - Unknown types and properties, bad names and duplicates are refused. A JSON object has unique keys.
- **The publish check** (`src/templates/catalog.ts`, run by the generator and by a unit test):
  - the placeholders equal the declared variables (none undeclared, none unused);
  - the email subject is one line;
  - the HTML has no script, active or remote-loading element, event handler, `javascript:` URL or remote resource;
  - an SMS has no subject or HTML, and its **worst case** fits `smsMaxSegments`: each variable at its maximum length, in the
    worst encoding. A datetime or free string counts as UCS-2; `Intl` can emit U+202F, and a datetime is bounded at 40 characters,
    which the 16.7 renderer must respect;
  - versions are numbered 1..n without gaps;
  - every declared channel has every `requiredLocales` locale;
  - the active versions of one template share one variable schema, because an intent's data is validated once for all its
    deliveries;
  - `IN_APP` is not publishable in V1.
- **Publication:**
  - `npm run templates:migration -- <name>` generates the next `NNNN_publish_templates_<name>.sql` from the catalog: one
    `INSERT` per template and version, deterministic ids and checksums. It writes the file itself; a local editor extension was
    found printing to every Node process's stdout.
  - The kit runner checksums the file, and the rows are immutable.
  - A **drift test** proves the committed publishing migrations contain exactly what the catalog generates.
  - There is no runtime admin API or editor.
- **The V1 catalog (PROVISIONAL copy, D7):** the nine templates of the SDD §7.1 Auth mapping, EMAIL and SMS each, in `en`:

  | Template | Category | SMS worst case |
  |---|---|---|
  | `identity.contact_verification_code` | SECURITY | 2 segments |
  | `identity.operator_login_code` | SECURITY | 2 segments |
  | `identity.operator_confirmation_code` | SECURITY | 2 segments |
  | `identity.owner_recovery_requested` | SECURITY | 3 segments |
  | `identity.owner_recovery_completed` | SECURITY | 3 segments |
  | `identity.owner_new_device_login` | SECURITY | 3 segments |
  | `membership.approved` | TRANSACTIONAL | 1 segment |
  | `membership.rejected` | TRANSACTIONAL | 1 segment |
  | `membership.revoked` | TRANSACTIONAL | 1 segment |

  Every `code` is `secret: true`, `maxLength` 12. The copy text and the default locale remain **product inputs before production
  enablement** (D7). A copy change is a new version file and a new migration.

## 5. Deviations from the Stage 16.1 roadmap row (owner-directed)

The 16.4 row also listed "the renderer, variable schema and locale resolution". This stage builds the variable **schema** and its
validation, the template syntax parser (used by the publish check) and the SMS size computation. Moved:

| Item | Moves to | Why |
|---|---|---|
| Variable **value** validation | 16.5 | runs at intake |
| Locale resolution and `NOTIFICATION_DEFAULT_LOCALE` | 16.5 | resolution pins the version at intake; startup refuses a default that is not in the published `requiredLocales` |
| The renderer | 16.7 | rendering happens in the worker |

Secret sealing (`NOTIFICATION_SECRET_KEYS`, AES-256-GCM) stays at intake (16.5): 16.4 only provides and guards the storage columns.

## 6. Indexes (each with its access path; no duplicate)

| Index | Access path |
|---|---|
| `notification_pkey`, `notification_delivery_pkey`, `notification_delivery_attempt_pkey`, `notification_template_pkey`, `notification_template_version_pkey` | by id |
| `notification_event_identity_unique` (partial) | event idempotency (16.5) |
| `notification_api_identity_unique` (partial) | API idempotency (16.6) |
| `notification_source_created_idx` | a caller's notifications (16.6) |
| `notification_organization_created_idx` (partial) | an organization's notifications |
| `notification_secret_expiry_idx` (partial) | the secret purge scan (16.7) |
| `notification_delivery_channel_unique` | deliveries of a notification (leading `notificationId`) |
| `notification_delivery_due_idx` (partial, `PENDING`) | the due claim (16.7) |
| `notification_delivery_lease_idx` (partial, `SENDING`) | the expired-lease scan (16.7) |
| `notification_delivery_attempt_number_unique` | attempt history of a delivery |
| `notification_template_platform_key_unique` (partial) | a template by key |
| `notification_template_version_identity_unique` | the active version of (template, channel, locale) |
| `notification_template_id_category_unique`, `notification_template_version_id_channel_locale_unique` | targets of the composite foreign keys |

**Retention scans:** durations are open (D10, §17 of the SDD). No retention index is added until a rule exists. Deletes must go
attempts → deliveries → notification, since no cascade exists.

**Measured** on a throwaway database with 200 000 notifications, 200 000 deliveries (9 957 `PENDING`, 1 879 `SENDING`, 188 164
`SENT`) and 190 043 attempts:

| Query | Time | Plan |
|---|---|---|
| Due claim (`FOR UPDATE SKIP LOCKED`, LIMIT 20) | 0.76 ms | `notification_delivery_due_idx` |
| Expired leases | 0.22 ms | `notification_delivery_lease_idx` |
| Event idempotency | 0.45 ms | index |
| Deliveries of a notification | 0.10 ms | index |
| Attempt history | 0.04 ms | index |
| Caller reads | 0.26 ms | index |
| Active template version | 0.09 ms | sequential scan of an 18-row table |

Guarded status updates cost about 76 µs per row, triggers included.

## 7. Evidence

| Proof | Where | Result |
|---|---|---|
| syntax (11 refusals), variable schema (11 refusals), SMS size, catalog check (18 refusals + control), the V1 catalog (9 templates × 2 channels, secrets flagged), deterministic ids / checksums, **drift guard** | `src/templates/templates.spec.ts` | pass |
| config: `DATABASE_URL` required / non-PostgreSQL refused; `postgres` / `root` / `*_migrator` refused in production; kit `DB_*` bounds | `src/config/notification-config.spec.ts` | pass (unit total 68) |
| chain from an empty database (kit + `0001` + `0002`), no-op rerun, exact tables, exact indexes, internal foreign keys only, no cascade, no rendered / payload / status columns, exact triggers, published rows = catalog with recomputed checksums | `test/migrations.e2e-spec.ts` | 7 / 7 |
| intent (one recipient, nullable organization, no status, identities, 12-way concurrent event insert → 1 row, API identity, category FK, bounds, immutability, purge-only, cancel once); delivery (starts PENDING, per-channel unique, verbatim destination, version pin, **all 42 transitions: 8 allowed, 34 refused**, terminal final, state fields, failure code, no cascade); attempt (lifecycle, 8-way concurrent duplicate → 1, identity); templates (immutable, no delete, new version, uniqueness, email / SMS shape, key unique) | `test/persistence.e2e-spec.ts` | 35 / 35 |
| `/ready` 503 `migrations` → 200 after migrating; database lost after startup → 503 `database`, `/health` 200, recovery logged; sessions named `notification-service`, all closed at shutdown; prompt shutdown with the database unreachable | `test/health.e2e-spec.ts` | 4 / 4 |
| migrator / runtime separation: ready as the runtime role; the runtime role does the work (intent → delivery → attempt → SENT, purge) but cannot CREATE / ALTER / DROP / TRUNCATE, disable, drop or replace a trigger, set `session_replication_role`, create a role; bound by every invariant | `test/runtime-role.e2e-spec.ts` | 13 / 13 |
| foundation, drain, built process (database down: live, 503, SIGTERM; missing / non-PostgreSQL / superuser / migrator URL refused) | `test/foundation.e2e-spec.ts`, `test/process.e2e-spec.ts` | pass (E2E total 87) |
| provisioning: a fresh PostgreSQL from the real init script creates `notification`; `verify.sh --with-kit-migrations` passes for all six services | local probe container | pass |
| image: migrate AS the migrator from the image (`0001`, `0002` applied); the runtime credentials cannot migrate; boot as `notification_app` → `/ready` 200, uid 1000; `docker stop` → exit 0 in 62 ms, 0 sessions left; 0 password occurrences in logs; `smoke-core-image.sh` passes | local | pass |
| mutations: `SENT → PENDING` allowed (matrix + terminal guard weakened) → 2 tests fail; `bodyText` of a version made mutable → 1 test fails; the event-identity index made non-unique → 2 tests fail | persistence spec | killed, restored |

## 8. Carried over, unchanged

- **D20 E.164:** no country assumption and no `+216` default; destinations are stored verbatim. Validation at intake (16.5),
  producer normalization before SMS production.
- **D21 (unpeppered rate-limit keys):** open. No limiter or destination key exists yet; it must be resolved before destination
  limits (16.7).
- **D19 Auth outbox:** deferred.
- **Providers:** D2 (email-vendor ADR) and D3 (ADR-0019 acceptance) before 16.8.
- **Retention (D10):** durations open; the schema is retention-ready (timestamps, the no-cascade delete order).
- **Kit error-message logging (16.3 finding):** the persistence triggers raise ids and states only, never a destination or data.
  The provider-error mapping remains required by 16.8 / 16.9.
- **Attachments:** File Service (Stage 17).

**Local development note:** an existing local PostgreSQL volume predates the `notification` database; the init script runs only on
an empty volume. Add the two `NOTIFICATION_*` passwords from `.env.example` to `.env`, then recreate the volume, or create the
database and roles by hand the way `01-service-databases.sh` does.

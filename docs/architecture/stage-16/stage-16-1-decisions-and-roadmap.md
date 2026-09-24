# Stage 16.1 — Notification: decisions and frozen roadmap

- **Status:** Draft, for review (2026-09-24)
- **Architecture:** [ADR-0046](../../adr/0046-notification-service-architecture.md)
- **Design:** [notification-service SDD](../../sdd/notification-service.md)
- **Baseline:** Core certified in Stage 15.9 (`core-validation.md` §13.9, §17); `main` at `f57bd5c`
- **Scope:** documentation only. No code, migrations, dependencies or Auth changes were made in 16.1.

## 1. Decision register

Status values:
- **DECIDED:** frozen for implementation.
- **DEFERRED:** has an owner and a target; not needed to start implementation.
- **RECOMMEND:** a decision needing the owner's formal acceptance.

| # | Decision | Rationale | Alternatives considered | Status / target |
|---|---|---|---|---|
| D1 | **Channels:** EMAIL + SMS real; IN_APP in the model, not implemented; PUSH and others later | Auth identities are email **or** phone, and every Auth delivery event can use either | SMS only; + push | DECIDED |
| D2 | **Email provider:** no vendor chosen. The architecture requirements are frozen (§2), and a vendor-selection ADR is required **before 16.8**. The test provider stands in until then | no repository evidence (volume, region, sender domain, budget) to pick a vendor responsibly | pick a popular vendor now | DEFERRED: owner (project owner), before 16.8 → **DECIDED 2026-09-24 (16.8): Resend, [ADR-0047](../../adr/0047-resend-as-the-email-provider.md)** |
| D3 | **SMS:** Twilio behind the SMS port (ADR-0019) | nothing in the repository argues against it; the port keeps a regional aggregator open | a regional aggregator now (no evaluation exists) | RECOMMEND: accept ADR-0019 (owner) → **ACCEPTED 2026-09-24 (16.8): ADR-0019, Messaging Service SID, direct HTTPS** |
| D4 | **Auth events:** Auth publishes the canonical kit envelope through the kit `RabbitMqEventBus.publish` (persistent, confirmed); payloads unchanged; still fire-and-forget for the caller | one canonical format; Class B | a tolerant parser in Notification (rejected: two formats, no event identity); an Auth outbox now (D19) | IMPLEMENTED in 16.2 ([record](./stage-16-2-auth-event-envelope.md)) |
| D5 | **Secret codes at rest:** AES-256-GCM, a key ring from configuration, the key id per row, purged at terminal state or `expiresAt`; never logged; never in a rendered body | a code must be recoverable to send it, and must not outlive its use | plaintext; send inside the consumer without persisting (loses retry, backoff and the durable intent) | DECIDED |
| D6 | **Ambiguity:** a code may be resent **once**, with the same code, never after `expiresAt`; anything else ends `UNCONFIRMED`, not resent | a duplicate code is harmless, a duplicate alert is not | resend always; never resend | DECIDED |
| D7 | **Templates:** persisted `template` → immutable `template_version` (channel × locale × version, variable schema, checksum), platform-owned, published by migrations, pinned per delivery. **Locales:** requested → base language → `NOTIFICATION_DEFAULT_LOCALE` | traceability, immutability, future organization overrides without redesign | templates only in code | DECIDED. The **copy text and the default locale value** are PRODUCT inputs needed before production enablement (not before 16.4, which can use provisional copy) |
| D8 | **Billing / Payment → Notification:** deferred; no synchronous Auth lookup | their events carry a payer id only, and no contact-resolution contract exists | an Auth contact route now; producers adding destinations | DEFERRED: product / architecture, after Stage 16 |
| D9 | **Preferences:** not in V1; template `category` (`SECURITY` / `TRANSACTIONAL` / `OPTIONAL`) is recorded now; where preferences are stored is decided with the first `OPTIONAL` template | V1 messages are security or transactional | build preferences now | DEFERRED: product |
| D10 | **Retention durations** of intents, deliveries, attempts | policy, not engineering | invent durations | DEFERRED: product / legal / SRE (added to the core-validation §17.1 register) |
| D11 | **DLQ / code TTL:** no RabbitMQ TTL (it would dead-letter or purge codes unseen); `expiresAt` is enforced by Notification; an expired replay is recorded `EXPIRED`, never sent; no kit change | honours the 15.7 "never purge unseen" rule and ADR-0027's intent | a queue TTL; a DLQ TTL | DECIDED |
| D12 | **Readiness:** database + migrations + RabbitMQ consumer; providers excluded; O2 stays open | follow the certified Core pattern | a provider in readiness | DECIDED (O2 stays SRE) |
| D13 | **Abuse / cost:** kit `RateLimitService` at claim time per destination+channel and per caller+template; an API intake limit per caller; exceeded → `FAILED rate_limited`, never retried | defence in depth; producers' throttles stay primary | no limit; retry-until-allowed (rejected: unbounded) | DECIDED. The values are set in 16.7 |
| D14 | **Senders / provider configuration:** platform-wide in V1 | no multi-sender requirement exists | per-organization now | DEFERRED: product |
| D15 | **Generic send API:** yes. Service token, per-caller policy (templates, channels, organization mode), `Idempotency-Key`, `202`; plus GET status and cancel; no raw content | future producers need it; the policy prevents a spam primitive | events only | DECIDED |
| D16 | **Scheduling:** V1, API only (`scheduledAt` = the first due time, bounded ahead); events immediate | a small cost now, and avoids a later API change | domain-ready only | DECIDED |
| D17 | **Priority:** not in V1; added later as ordering with aging only, never bypassing security, limits or idempotency | a field with no observable effect is noise | a 4-level priority now | DEFERRED: until a bulk producer exists |
| D18 | **Rendered content:** never stored; the pinned version + non-secret data + purged secrets reconstruct the message | personal data and secrets minimised | store bodies; store snapshots | DECIDED (reopened only by a legal requirement) |
| D19 | **Auth transactional outbox:** not required for V1; a follow-up | a code loss is recoverable (re-request); Class C for certified Auth | an outbox now | DEFERRED: engineering, before production enablement of Auth delivery if the risk is not accepted |
| D20 | **Phone format:** Notification requires E.164 and fails a non-E.164 SMS destination `invalid_destination`; the producer (Auth: `+?[0-9]{8,15}`) must normalize | guessing a country code is unsafe | a default country code in Notification | **RESOLVED for Notification intake (16.5)**: E.164 enforced, invalid → `FAILED invalid_destination`, no default country. Auth-side normalization: DEFERRED, Auth / product, **before SMS production enablement** |
| D21 | **Rate-limit key privacy:** kit keys are an unpeppered SHA-256; phone keys are enumerable | classified as personal data now | peppered keys | DEFERRED: kit follow-up (Class B) → **RESOLVED 2026-09-24 (16.9): HMAC-SHA-256 under a dedicated key (`NOTIFICATION_DESTINATION_LIMIT_KEY`)** |
| D22 | **Recipient time zone** for datetime variables: the platform time zone in V1 | no recipient time zone exists anywhere | per recipient | DEFERRED: product |
| D23 | **Outbound `notification.*` events:** not in V1; kit outbox only when a consumer exists (Audit, Stage 18) | no consumer; no fire-and-forget publishing | publish now | DEFERRED: Stage 18 |
| D24 | **Push device identity:** owned by Auth (the devices design); Notification never owns devices | the ownership rule (Auth owns user and device identity) | a device table in Notification | DECIDED (Push itself deferred) |
| D25 | **API request hash is keyed:** `HMAC-SHA-256(NOTIFICATION_REQUEST_HASH_KEY, canonical body)`, secrets included; replaces the unkeyed SHA-256 of the Payment pattern for Notification only | a body can hold a low-entropy code beside fields stored in clear: an unkeyed digest would let a database reader recover a live code | unkeyed SHA-256 (rejected, unsafe); excluding secrets from the hash (rejected, weakens idempotency) | DECIDED (owner, 2026-09-24), IMPLEMENTED in 16.6. Key rotation / versioning: 16.9 |

## 2. Email-provider requirements (D2)

The vendor ADR must show:
- a transactional API with a message id in the response, or SMTP with a message id;
- an idempotency key or a client reference field, if any (it affects D6's duplicate risk);
- documented failure classes (4xx terminal vs 5xx/429 retryable, and rate-limit headers);
- a sandbox or test mode that makes no real delivery;
- sender-domain verification (SPF / DKIM / DMARC);
- delivery-status webhooks (for a future use; not V1);
- deliverability in Tunisia / MENA and for the planned locales, including Arabic;
- a cost model at the expected volume;
- data-processing location and terms (personal data);
- a simple HTTPS API (no heavy SDK required, which keeps the image small).

The adapter implements the §8.4 port. Nothing in Notification depends on the vendor.

## 3. Frozen implementation roadmap

Each sub-stage is its own reviewed PR, following the repository workflow.

**Progress:** 16.1 ✅ · 16.2 ✅ ([record](./stage-16-2-auth-event-envelope.md)) · 16.3 ✅ ([record](./stage-16-3-service-foundation.md)) ·
16.4 ✅ ([record](./stage-16-4-persistence-and-templates.md)) · 16.5 ✅ ([record](./stage-16-5-notification-event-intake.md)) ·
16.6 ✅ ([record](./stage-16-6-notification-send-api.md)) · 16.7 ✅ ([record](./stage-16-7-notification-delivery-engine.md); the
destination limit `notif_dest` of D13 is deferred with D21, see its §13) · 16.8 ✅ ([record](./stage-16-8-email-sms-providers.md);
D2 → Resend, ADR-0047; D3 → ADR-0019 accepted) · 16.9 ✅ ([record](./stage-16-9-security-operations.md); D21 resolved:
HMAC-keyed `notif_dest`; ADR-0046 accepted) · 16.10 ⏳. Items moved between rows (owner-directed, each record says why):
- 16.3 → 16.4: `DbModule` and database provisioning (done in 16.4);
- 16.3 → 16.5: the kit bus and the key ring;
- 16.3 → 16.6: the caller policy (done in 16.6, with OpenAPI);
- 16.4 → 16.5: variable **value** validation, locale resolution and `NOTIFICATION_DEFAULT_LOCALE` (done in 16.5, with the kit bus
  and the key ring);
- 16.4 → 16.7: the renderer (done in 16.7);
- 16.7 → open (D21): the `notif_dest` destination limit; `notif_caller_template` is built.

| Sub-stage | Objective | Scope | Depends on | Production files likely affected | Tests | Exit criteria | Non-goals |
|---|---|---|---|---|---|---|---|
| **16.2 Auth event envelope** | Auth events consumable by the kit consumer | Auth `EventsPublisherService` publishes through the kit `RabbitMqEventBus.publish` (the envelope, persistent, confirm); remove `@golevelup/nestjs-rabbitmq` from Auth if unused; payloads unchanged | D4 | `apps/auth-service/src/events/*`, `app.module.ts`, `package.json` | Auth unit / E2E; a new `test/e2e-real-broker` case: a kit consumer receives Auth events with `eventId` / `source` / `version`; Auth–Organization E2E | the kit consumer accepts every Auth delivery event; Auth regression green | an Auth outbox (D19); changing `AUTH_EVENTS` in production |
| **16.3 Service foundation** | the certified skeleton | replace the starter: config (bounds, relationships, policy parse, key ring), `configureApp`, health / ready, `DbModule`, `ServiceAuthModule`, the kit bus (no subscription yet), Dockerfile, Compose, database provisioning, README | 16.1 | `apps/notification-service/**`, `docker-compose.yml`, `infra/postgres/init/01-service-databases.sh` | config unit; boot E2E; image smoke | boots ready on the kit; non-root; natural shutdown | business logic |
| **16.4 Persistence + templates** | schema and templates | migrations for the five tables with triggers and indexes (SDD §3); the template file format; the publish check; the provisional V1 templates for the mapped Auth events; the renderer, variable schema and locale resolution | 16.3 | `db/migrations/*`, `src/templates/*`, `templates/**` | real-PostgreSQL integration (constraints, triggers, immutability); renderer / escaping / fallback / SMS-segment unit | the migration chain is clean; the publish check passes; rendering is deterministic | delivery, providers |
| **16.5 Event intake + idempotency** | Auth events → intents | the kit subscription `notification.events`; the mapping registry (SDD §7.1); validation; the sealed secrets; one-transaction intake; duplicate / poison handling | 16.2, 16.4 | `src/intake/*`, `src/secrets/*` | E2E on the in-memory bus; real broker: duplicate, poison → DLQ, replay; mutation: the unique source key | one intent per event; poison dead-lettered; no plaintext code at rest | sending |
| **16.6 Generic send API** | service callers | POST (`202`), GET status, cancel; the caller policy; `Idempotency-Key` + hash; scheduling bounds; the API intake limit | 16.4 | `src/api/*`, `src/policy/*` | E2E: the auth matrix (missing / invalid / malformed / user-shaped / other service → 401 / 403, 0 writes), policy, replay / mismatch, cross-caller 404, cancel idempotency | the contracts in SDD §7.2 hold | list / search API; user routes |
| **16.7 Delivery engine** | a reliable send loop | the `ChannelProvider` port; the test provider (scenarios); claim / lease / renewal; attempts committed before the call; retry / backoff / jitter / max / expiry; the ambiguity policy; cancel-vs-claim; rate limits; the secret purge; the startup relationships; default values from measurement | 16.5, 16.6 | `src/delivery/*`, `src/providers/test-provider.ts`, config | integration; ≥ 20-iteration races (2–4 workers); failure scenarios; mutation proofs (`SKIP LOCKED`, lease guard, expiry, ambiguity cap, purge) | no double claim; bounded retries; codes never after expiry; purge proven | real providers |
| **16.8 Email + SMS providers** | real delivery behind flags | the Twilio SMS adapter (ADR-0019 accepted); the email adapter (the D2 ADR accepted); failure mapping; secrets from the environment; production refuses the test provider; E.164 enforcement | 16.7, D2, D3 | `src/providers/*` | adapter contract tests against a local stub HTTP server (no real calls in CI); an opt-in manual live smoke | adapters map every documented response class | webhooks / delivery status; push |
| **16.9 Security / observability / shutdown** | hardening | log names and the redaction test; the destination hint; the drains wired (consumer, delivery, purge); a readiness check; operator docs (backlog query, DLQ runbook for codes) | 16.7 | `src/**`, README, `production-readiness.md` | the sensitive log scan; shutdown E2E (hung provider); readiness E2E | no personal data or secrets in logs; bounded shutdown | a metrics platform |
| **16.10 Notification reliability certification** | a focused certification | the §17.3 rows that apply, plus Notification-specific rows (§4); production image; migration chain; a focused Auth re-check; the results in `core-validation.md` | 16.2–16.9 | `scripts/validation/notification-campaigns.mjs` (new; reuses the harnesses) | §4 | every row passes; the regression is green | a Stage-15.9-scale campaign |

## 4. Notification certification (16.10)

**Rows** (the reusable §17.3 contract, focused):
- database refused / frozen during intake and delivery;
- RabbitMQ stopped / frozen / consumer loss;
- consumer idempotency (duplicate / redelivered events, API replay);
- worker concurrency (2 / 4 instances: claims, cancel-vs-claim, lease reclaim);
- provider failure classes (429 / 5xx / refused / terminal / auth fault);
- ambiguous results (timeout-after-accept, worker killed mid-call): at most one resend of a code, `UNCONFIRMED` otherwise;
- secret expiry and purge (never sent after expiry; ciphertext purged; an expired DLQ replay is not sent);
- tenant isolation and service authentication (0 cross-caller reads or writes; the 401 / 403 matrix);
- retry / backoff bounds;
- shutdown / restart in the production container (Node as PID 1, 60 s grace, a hung provider);
- the sensitive log scan (destination, code, body, token);
- resource cleanup;
- production image;
- migration chain.

**Directly affected Core surface:** Auth's publisher (16.2): Auth E2E, a real-broker Auth → Notification test, Auth–Organization
E2E.

**Not rerun:** Stage 15.9. The full platform validation stays the last step after the planned shared services (Notification →
File → Audit → Security / Admin → Release management → Shared-services integration → **final full validation**).

## 5. Deferred items and owners

D2 (email vendor, before 16.8), D3 acceptance (owner), D8, D9, D10, D14, D17, D19, D20 (before SMS production), D21, D22, D23; plus:
- production RabbitMQ and `AUTH_EVENTS=on` (Stage 20 / 22);
- Organization-scoped templates;
- In-App, Push and attachments (after File Service);
- delivery-status webhooks.

## 6. Answers required by Stage 16.1

1. **What is a Notification?** One immutable communication intent: a template, a recipient reference, a locale request, data
   (secrets sealed), a schedule and an expiry, identified by its source.
2. **What is a NotificationDelivery?** The per-channel realisation of an intent: a destination snapshot, a pinned template version
   and locale, the delivery state, retry and lease.
3. **What is a NotificationDeliveryAttempt?** One provider call, recorded `STARTED` before it happens and completed exactly once.
4. **Can one Notification have multiple channels?** Yes: at most one delivery per channel.
5. **What is the idempotency boundary?** Per intent: `(source, eventId)` or `(caller, Idempotency-Key)` + hash. Deliveries are
   created only with their intent, and resends are attempts, not new deliveries.
6. **How is a duplicate event handled?** The unique key holds, nothing is created, and the message is acknowledged.
7. **Where is the destination snapshotted?** `notification_delivery.destination`.
8. **Who owns contacts?** Auth. Notification only receives destinations.
9. **How are templates versioned?** Immutable versions per template, channel and locale, published by migration, pinned per
   delivery.
10. **How is the locale selected?** Requested → base language → platform default, always resolvable.
11. **How are secret codes protected?** AES-256-GCM with a key ring outside the database, plaintext only while sending, purged
    when finished or expired, never logged.
12. **What happens after a provider timeout with an unknown outcome?** The attempt is `AMBIGUOUS`. A code is resent once, never
    after expiry; anything else ends `UNCONFIRMED`.
13. **When is retry allowed?** For retryable classes (429, 5xx, a network failure before sending, provider authentication faults).
14. **When must retry stop?** At a terminal failure, the maximum number of attempts, `expiresAt`, cancellation or a rate limit.
15. **How is expiry enforced?** At claim and just before the provider call. Expired deliveries end `EXPIRED`, including DLQ
    replays.
16. **Is scheduling V1?** Yes, through the API only.
17. **How does cancellation work?** A conditional update moves `PENDING` deliveries to `CANCELLED`. It is idempotent, and a claimed
    delivery gives `409 delivery_in_progress`.
18. **Are preferences V1?** No, deferred. Categories are recorded now.
19. **Is In-App implemented?** No: it is in the model, with an extension table later.
20. **Why is Push deferred?** No device identity or token lifecycle exists yet, and Auth owns devices.
21. **How does Notification stay product-agnostic?** Templates and mappings are data, `check:repo` bans product terms, and it
    never decides why or when.
22. **What is the Auth prerequisite?** The kit envelope through the kit bus: persistent and confirmed.
23. **Is an Auth outbox required now?** No. It is deferred as D19, with the risk accepted.
24. **What is the SMS provider decision?** Twilio behind the port: accept ADR-0019.
25. **What is the email provider status?** Requirements frozen; the vendor ADR is due before 16.8.
26. **What prevents SMS abuse and cost pumping?** The caller policy (templates and channels), per-destination and per-caller rate
    limits, the SMS segment cap, and the producer throttles.
27. **What belongs in logs?** Ids, channel, template and version, provider, class and code, latency, correlation.
28. **What must never be logged?** Destinations, codes and secrets, data, bodies, tokens, credentials, cookies.
29. **What is the tenant and service-auth policy?** Service tokens plus an explicit per-caller policy; reads and cancels only for
    the creator; no raw content.
30. **Which Stage 15 patterns are reused?** The kit bootstrap, database and migrations, the bus with retry and DLQ, `PollLoop`
    drains, claim + lease + `SKIP LOCKED` + renewal, the startup relationships, service tokens and policy, `Idempotency-Key`, the
    provider port, rate limits, the production image and the certification harnesses.
31. **What will 16.2 implement?** Auth's publisher moving onto the kit bus's canonical envelope, and nothing else.
32. **What remains deferred?** §5.

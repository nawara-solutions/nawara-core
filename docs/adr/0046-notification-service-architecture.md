# 0046. Notification service architecture

- **Status:** Proposed
- **Date:** 2026-09-24
- **Deciders:** Anwar (project owner)
- **Related:** [ADR-0018](./0018-rabbitmq-as-async-message-broker.md) (broker), [ADR-0019](./0019-twilio-as-sms-gateway-provider.md)
  (SMS provider), [ADR-0027](./0027-service-layer-security-model.md) (codes on the broker), [ADR-0032](./0032-database-per-service-on-a-shared-server.md)
  (database per service), [ADR-0033](./0033-service-to-service-authentication-and-user-identity.md) (service tokens),
  [ADR-0034](./0034-shared-service-kit-and-api-conventions.md) (service-kit, `Idempotency-Key`), [ADR-0037](./0037-reliable-events-outbox-inbox.md)
  (outbox / inbox), [ADR-0042](./0042-service-token-scopes-and-administrative-authorization.md) (per-caller service policy).
  Design detail: [notification-service SDD](../sdd/notification-service.md). Stage plan:
  [Stage 16.1 decisions and roadmap](../architecture/stage-16/stage-16-1-decisions-and-roadmap.md).

## Context

`notification-service` is the Nest starter scaffolded in the first commit. It has no ADD or SDD (ADR-0019 says so explicitly).
Meanwhile Auth publishes events that exist only to be delivered, and nothing consumes them. These events carry a `destination`
(email or phone) and, for three of them, a raw one-time code:
- the member contact-verification code;
- the operator login and confirmation codes;
- the owner recovery and new-device notices;
- the membership decisions.

Auth keeps `REQUIRE_CONTACT_VERIFICATION` off "until a delivery channel exists". Billing and Payment list notification as a
consumer of their events, but those events identify the payer by id only, and no service can resolve an id to a contact today.

Phase C (Stages 13–15.9) certified the Core patterns a new service must reuse. The ones that matter here:
- the service-kit bootstrap, database and migrations;
- the RabbitMQ bus with confirms, bounded retry and DLQ;
- `PollLoop` workers with a bounded drain;
- claim + lease + `SKIP LOCKED` (the Billing dispatcher and the Payment AttemptResolver);
- service tokens with a per-caller policy;
- `Idempotency-Key`;
- the provider port with failure classes;
- the production image with a 60 s stop grace;
- the §17.3 certification contract.

The Stage 16 investigation found one hard prerequisite: Auth publishes with `@golevelup/nestjs-rabbitmq` and no envelope.
- There is no `messageId` and no `type`.
- There are no `eventId`, `occurredAt`, `source` or `version` headers.
- Messages are non-persistent and get no publisher confirm.
- The kit consumer dead-letters such a message at once as `malformed_envelope`.

A notification service is a sharp tool. It moves personal data and one-time secrets, costs money per SMS, and could become an
internal spam primitive if any caller could send anything to anyone.

## Options considered

1. **Delivery state on the notification row** (one channel and one destination per notification; the investigation's first
   sketch). Simple, but one message on two channels becomes two unrelated notifications. There is no place for a later In-App
   delivery, and "the notification" and "the delivery" blur.
2. **Notification → Delivery → Attempt** (chosen): a communication intent, one delivery per channel, and append-oriented attempt
   evidence per provider call.
3. **A generic workflow engine** (rules deciding when and whether to notify, digesting, preferences). Rejected: it moves the
   *why* and the *when* into Notification and makes it product-aware.
4. **Templates only in code** (the investigation's first sketch). Deterministic, but a template change leaves no persistent
   trace of which version produced a past message, and it cannot grow into organization overrides.
5. **Accept Auth's current messages** with a tolerant parser in Notification. Rejected: two event formats, no event identity, no
   deduplication.

## Decision

We build `notification-service` as **Option 2** on the certified Core patterns, with these rules.

**1. Boundary.**
- Producers decide *why* and *when*; Notification decides *how* and *where*.
- Notification owns:
  - the notification intent, its channel deliveries, template rendering and template versions, localization;
  - delivery scheduling and cancellation;
  - attempts, retry and backoff, and the ambiguity policy;
  - provider integration, delivery status and operational delivery history.
- Notification does not own users, contacts, organizations, memberships, entitlement, invoices, payments, product concepts, audit
  history, push-device identity or files.
- It is product-agnostic, and `check:repo`'s product-term rule already applies to `apps/notification-service/src/`.

**2. Domain model.** `notification` (the immutable intent) 1 → N `notification_delivery` (one per channel) 1 → N
`notification_delivery_attempt` (one per provider call, append-oriented).
- The notification has **no stored aggregate status**: its status is derived from its deliveries.

**3. Channels.**
- Real in Stage 16: **EMAIL** and **SMS**.
- **IN_APP** is part of the channel vocabulary and the model, but not implemented.
- **PUSH** and others are later additions. A new channel is a new enum value plus an optional channel-specific extension table,
  never new nullable columns on the generic tables.

**4. Recipient and destination.**
- A notification references its recipient generically (`recipientType`, `recipientId`), for example `user` / the Auth user id,
  and never owns contact data.
- Each delivery **snapshots the destination actually used**.
- Notification never calls Auth to resolve a contact. Billing / Payment → Notification is deferred until a recipient-resolution
  decision exists.

**5. Templates.**
- They are persisted: `notification_template` (a stable key, category, platform scope) 1 → N `notification_template_version`
  (per channel and locale; immutable once published; carries a variable schema and a checksum).
- V1 templates are platform-owned and published through checksummed migrations.
- The schema keeps a nullable owner scope for future organization overrides, with no editor and no override API in Stage 16.
- Each delivery pins the exact template version it renders.

**6. Rendering.**
- A minimal, logic-free interpolation (`{{variable}}` only: no expressions, helpers, loops or code).
- Variables are validated against the version's schema at **intake**: required, typed, bounded, no unknown variable.
- The HTML part of an email escapes every variable.

**7. Localization.** The locale fallback is deterministic:
- the requested locale;
- then its base language (`fr-TN` → `fr`);
- then the platform default locale (configuration).
Publishing refuses a template that lacks the platform default locale, so resolution never fails at runtime. Organization default
locales are a future layer between the request and the platform default.

**8. Intake.** Two paths, one transaction each, and **no provider call inside intake**:
- **Events:** the kit `RabbitMqEventBus` consumer. A mapping declares producer + event name → template, channel, recipient,
  destination and secret fields. Only Core producers use event intake.
- **The API:** `POST /notification/notifications`, service token + `Idempotency-Key` → `202`.

**9. Idempotency.**
- A logical notification is unique per `(sourceService, sourceEventId)` (events) or per `(caller, idempotencyKey)` + request hash
  (the API).
- A delivery is unique per `(notificationId, channel)`.
- An attempt is unique per `(deliveryId, attemptNumber)`.
- The provider reference is the **delivery id**, so an idempotent provider deduplicates a resend.

**10. Delivery engine.**
- A `PollLoop` worker claims due deliveries with `FOR UPDATE SKIP LOCKED`, sets a lease, commits, and records a STARTED attempt
  **before** the provider call.
- It calls the provider **outside any transaction**, bounded by the provider timeout, then records the outcome.
- Startup enforces lease ≥ 2 × provider timeout (the Stage 15.8 relationship).

**11. Retry and ambiguity.** Retryable failures back off exponentially up to a ceiling and a maximum number of attempts, and never
after `expiresAt`.
- **The contract:** exactly-once internal intent, at-least-once processing, best-effort external deduplication. We never claim
  exactly-once provider delivery.
- **After an ambiguous outcome** (a timeout after the request was sent, or a worker that died mid-call):
  - a notification carrying a one-time code may be resent **once**, with the same code, and never after `expiresAt`;
  - any other notification is not resent automatically: the delivery ends `UNCONFIRMED`.

**12. Secrets.**
- Template variables declared `secret` (one-time codes) are stored AES-256-GCM encrypted: a key ring from configuration, the key
  id stored beside the ciphertext, the key never in the database (Auth's TOTP key-ring pattern).
- They exist in plaintext only while rendering and sending, and are **purged** once every delivery is terminal or `expiresAt` has
  passed.
- No rendered body is ever stored.
- No destination, code, body, token or credential is ever logged.

**13. Tenant and service authorization.**
- Every Stage 16 route is service-only (`ServiceTokenGuard`).
- An explicit **per-caller policy** (configuration, ADR-0042 style) lists the templates, channels and organization scope a caller
  may use.
- A caller reads and cancels **only the notifications it created**.
- `organizationId` is nullable (platform-level notifications) and is never trusted beyond the caller's policy.
- There is no raw-content send: callers name a template.

**14. Abuse and cost.** The kit `RateLimitService` applies per-destination-and-channel and per-caller-and-template limits at
delivery time. An exceeded limit ends the delivery `FAILED` (`rate_limited`) and is not retried. This is defence in depth: the
producers' throttles (Auth's code throttles) stay primary.

**15. Scheduling and cancellation.**
- **Scheduling is implemented in V1:** the API accepts `scheduledAt`. A delivery due later is simply `PENDING` with a future due
  time; there is no separate state.
- **Cancellation** moves `PENDING` deliveries to `CANCELLED` with a conditional update. It is idempotent, and it loses cleanly to
  a worker that has already claimed the delivery.
- Events are immediate.

**16. Not in V1:**
- priority: deliveries run in due-time order until a producer with bulk traffic exists;
- preferences: template **category** (`SECURITY`, `TRANSACTIONAL`, `OPTIONAL`) is recorded now, so that future preferences can
  suppress only `OPTIONAL`;
- outbound `notification.*` events: a future extension, and only through the kit outbox;
- attachments: future references to File Service ids;
- In-App and Push delivery.

**17. Auth prerequisite (Stage 16.2; implemented, see [the Stage 16.2 record](../architecture/stage-16/stage-16-2-auth-event-envelope.md)).**
- Auth's publisher emits the canonical kit envelope by delegating to the kit's `RabbitMqEventBus.publish`:
  - `messageId` = `eventId`, `type` = the event name;
  - `persistent`;
  - headers `eventId`, `occurredAt`, `source: auth-service`, `version: 1`, `correlationId`;
  - a publisher confirm.
- Payloads are unchanged, and publishing stays fire-and-forget from Auth's request path.
- **An Auth transactional outbox is not required for Stage 16.** It is a recorded follow-up, and the risk is accepted: a code lost
  to a broker failure is re-requested by the user.

**18. Readiness and operations.** Readiness, shutdown, the image and certification follow the certified Core:
- `/ready` checks the database, migrations and the RabbitMQ consumer, never an external provider (a provider outage is a retry
  state); O2 stays open;
- shutdown is a bounded drain;
- a production image like Billing's;
- a focused §17.3 certification, not a new Stage 15.9.

## Consequences

**Easier**
- One intent can fan out to several channels, and In-App or Push later need no redesign.
- Every past message is traceable to a pinned template version.
- A duplicate event or retried request never creates a second intent.
- A provider outage is a bounded retry, not an incident.

**Harder**
- The five tables, the version pinning and the secret purge are more than a single-row model.
- Template content now needs a migration per copy change: the price of immutability and traceability.
- Ambiguity can still produce one extra SMS or email. The cost is accepted and documented.

**Accepted risks**
- Auth events stay non-transactional (an outbox is a follow-up).
- Codes transit the broker and can sit in the DLQ until an operator replays them. Replaying an expired one records it `EXPIRED`
  and never sends it.
- The kit rate limiter stores an unpeppered hash of the destination.

**Follow-up**
- Stage 16.2: the Auth envelope (implemented and validated; [record](../architecture/stage-16/stage-16-2-auth-event-envelope.md)).
- ADR-0019 to be accepted (Twilio behind the SMS port).
- **A separate email-provider ADR before Stage 16.8.** No vendor is chosen here, and the test provider stands in until then.
- D20: phone numbers in E.164 at the producer before SMS is enabled in production.
- Retention durations go to the Phase C register.
- The Billing / Payment recipient-resolution decision.
- Production RabbitMQ and `AUTH_EVENTS=on` (Stage 20 / 22).

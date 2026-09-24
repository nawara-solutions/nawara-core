# Stage 16.2 — Auth canonical event envelope

- **Status:** implemented and validated (2026-09-24), pending review
- **Decision:** [ADR-0046](../../adr/0046-notification-service-architecture.md) rule 17, D4 in the
  [Stage 16.1 register](./stage-16-1-decisions-and-roadmap.md); design in the
  [notification-service SDD §14](../../sdd/notification-service.md#14-auth-prerequisite-stage-162).
- **Scope:** Auth's event transport only. No Notification code, no Auth outbox (D19), no payload change, no phone normalization (D20).

## 1. What changed

Auth's `EventsPublisherService` (`apps/auth-service/src/events/`) now publishes through the kit's `RabbitMqEventBus.publish`, the
same bus the Billing and Payment outbox relays use. `@golevelup/nestjs-rabbitmq` and `amqp-connection-manager` are removed from Auth.
No Core service uses them any more.

| File | Classification | Change |
|---|---|---|
| `src/events/events-publisher.service.ts` | Auth event transport / envelope | builds the canonical envelope, delegates to the kit bus, fire-and-forget, sequential, bounded backlog, bounded shutdown drain |
| `src/events/events.module.ts` | Auth event transport / envelope | provides the kit `RabbitMqEventBus` (exchange `nawara.events`, confirm timeout, notices to the Nest logger) instead of `RabbitMQModule` |
| `src/app.module.ts` | Auth configuration | passes the validated broker settings to `EventsModule.register` |
| `src/config/app-config.ts`, `.env.example` | Auth configuration | `RABBITMQ_CONFIRM_TIMEOUT_MS` (default 5000, 100–60000), the Billing / Payment variable and bounds; read only while events are enabled |
| `package.json`, `package-lock.json` | Auth configuration (dependencies) | removes `@golevelup/nestjs-rabbitmq`, `amqp-connection-manager`; nothing added |

The `EventBus` port (`publish(routingKey, payload): void`) and every call site are unchanged. `AUTH_EVENTS`, `RABBITMQ_URL` and
their defaults are unchanged. Production still runs `AUTH_EVENTS=off` (`deploy/provision-and-deploy.sh`) until Stage 20 / 22.

## 2. The envelope (existing payload + canonical envelope = version 1)

| AMQP property / header | Value |
|---|---|
| exchange / routing key | `nawara.events` (durable topic) / the event name, verbatim as before |
| `messageId` | the event id: a new UUIDv4 per publish |
| `type` | the event name |
| `timestamp` | `occurredAt`, in seconds |
| `deliveryMode` | 2 (persistent) |
| `contentType` | `application/json` |
| header `eventId` | the same event id (one identity, never a second one) |
| header `occurredAt` | ISO-8601 UTC, the moment `publish` was called |
| header `source` | `auth-service` (Auth's service and logger name) |
| header `version` | `1` |
| header `correlationId` | the request's correlation id (kit request context); absent outside a request |
| body | the payload exactly as the call site builds it |

Every message is acknowledged by a publisher confirm within `RABBITMQ_CONFIRM_TIMEOUT_MS`.

## 3. Event inventory (from the `bus.publish(...)` call sites)

All twelve events keep their payload and are published with `source: auth-service`, `version: 1`, routing key = name.

| Event | Call site | Notification consumer (SDD §7.1) |
|---|---|---|
| `member.contact_verification_requested` | `onboarding/contact-verification.service.ts` | yes (one-time code) |
| `admin.operator_code_issued` | `operator/operator-code.service.ts` | yes (one-time code) |
| `admin.operator_confirmation_code_issued` | `operator/operator-code.service.ts` | yes (one-time code) |
| `admin.owner_recovery_requested` | `owner/recovery.service.ts` | yes (security alert) |
| `admin.owner_recovery_completed` | `owner/recovery.service.ts` | yes (security alert) |
| `admin.owner_login_from_new_device` | `owner/admin-device.service.ts` | yes (security alert) |
| `membership.approved` / `membership.rejected` | `membership/membership.service.ts` | yes (decision) |
| `membership.revoked` | `membership/membership.service.ts` | yes (decision) |
| `user.registered` | `auth/auth.service.ts`, `onboarding/invitation.service.ts` | no |
| `membership.requested` | `auth/auth.service.ts` | no |
| `membership.admin_provisioned` | `onboarding/invitation.service.ts` | no |

No service consumes any Auth event today, so the change is additive (Class B).

## 4. Caller semantics and residual windows

- **Fire-and-forget, unchanged.** `publish` returns at once and never throws. A publish that fails (broker down, connection lost,
  confirm timeout) is logged `event_publish_failure eventId=… name=… error=… [code=…]` and **not retried**. The Auth request
  has already committed and answered. A broker outage therefore never fails or slows an Auth request (measured: request < 2 s
  while the broker was stalled or unreachable).
- **Sequential.** Publishes run one at a time, in call order. The kit bus opens its connection and confirm channel lazily, and it is
  built for one sequential publisher (the outbox relay). Two concurrent first publishes could each open a connection. Serializing
  keeps one connection and one confirm channel whatever the request concurrency.
- **Bounded memory.** At most 1000 events wait unconfirmed. Past that an event is dropped and logged
  `event_publish_dropped … reason=backlog_full`.
- **Bounded shutdown.** At shutdown (after HTTP stops admitting requests) the publisher waits up to 5 s for queued events, drops
  the rest (`event_publish_drain_timeout`, `reason=shutting_down`), then closes the bus. Closing is bounded by the kit's 3 ×
  heartbeat (about 30 s at the default 10 s) when the broker is silent. That fits the 60 s stop grace; it applies only while events
  are enabled.
- **Each publish is bounded:**
  - the connect timeout is 5 s;
  - opening a channel on a silent broker is bounded by the heartbeat;
  - the confirm is bounded by `RABBITMQ_CONFIRM_TIMEOUT_MS`.
- **No Auth outbox (D19, deferred and accepted).** The window is still there: the database commit, then the publish. A broker
  outage, a crash before the confirm, a full backlog or a shutdown drop loses the event. The publisher confirm only proves that
  the broker stored a message; it does not close that dual-write window. A code lost this way is re-requested by the user (Auth's
  throttles apply), and a lost notice stays lost. A confirm timeout means "unconfirmed", not "not sent", so a consumer can still
  receive that event. Consumers deduplicate on `eventId` (Stage 16.5).

## 5. Security

- The kit bus logs no payload: its notices carry ids, names, queue names and failure classes only.
- The Auth publisher logs event id, name and failure class (`describeFailure`, never the error message).
- The broker URL (credentials) is never logged.
- The real-broker tests scan every captured log line for:
  - the one-time codes, email and phone destinations and IP address actually published;
  - the owner password;
  - the broker password;
  - Auth's peppers and JWT secret.

  **0 leaks.**
- Codes still transit the broker and can sit in a DLQ (accepted in ADR-0027 / ADR-0046; `expiresAt` is enforced by Notification).

## 6. Evidence

| Proof | Where | Result |
|---|---|---|
| envelope contract, payload preservation (6 shapes), id uniqueness (500), sequencing, fire-and-forget, failure logging without payload, backlog bound, shutdown drain and bound | `apps/auth-service/src/events/events-publisher.service.spec.ts` | 14 / 14 |
| `RABBITMQ_CONFIRM_TIMEOUT_MS` default and bounds | `apps/auth-service/src/config/app-config.spec.ts` | pass |
| real Auth flows (operator code, owner new-device alert, membership approval, plus `user.registered` / `membership.requested`) → real RabbitMQ → kit consumer: accepted, no DLQ, `deliveryMode` 2, headers, payload byte-identical to what the service published | `apps/auth-service/test/events-real-broker.e2e-spec.ts` | pass (3 consecutive runs) |
| all 12 event names accepted by the kit consumer, unique ids, stable source / version | same | pass |
| negative control: a pre-16.2 message (no `messageId` / `type`) is dead-lettered `malformed` by the same consumer | same | pass |
| confirm stall (broker frozen): request < 2 s, `PublisherConfirmTimeoutError` at the 500 ms bound | same | pass |
| connection severed, broker unreachable: request < 2 s, failure logged; publishing resumes on reconnect without restarting Auth | same | pass |
| shutdown with a frozen broker: bounded (~30 s) | same | pass |
| mutation M1: envelope id removed → the real consumer dead-letters every Auth event (0 accepted, 14 dead) | real-broker e2e | killed, restored |
| mutation M2: `source` `auth` → contract tests fail | unit | killed, restored |

## 7. Carried over, unchanged

- **E.164 (D20):** Auth still accepts `+?[0-9]{8,15}`. 16.2 publishes `destination` as it is: nothing is normalized and no default
  country is assumed. Canonical E.164 at the producer remains required before SMS is enabled in production.
- **Auth outbox (D19):** deferred (§4).
- **Production broker, `AUTH_EVENTS=on`:** Stage 20 / 22.
- **`RABBITMQ_HEARTBEAT_S`:** not added to Auth. The kit default (10 s) applies; add the variable if Auth's heartbeat ever needs
  tuning.

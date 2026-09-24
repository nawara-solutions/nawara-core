# 0018. RabbitMQ as the async message broker, via `@golevelup/nestjs-rabbitmq`

- **Status:** Proposed
- **Date:** 2026-09-17
- **Deciders:** Anwar (project owner)

> **Forward note (2026-09-19):** [ADR-0037](./0037-reliable-events-outbox-inbox.md) builds on this decision: the project owner accepted RabbitMQ for the financial services and added message headers, a transactional outbox and an inbox. This ADR's production-deployment deferral still holds.

> **Forward note (2026-09-24):** Stage 16.2 ([ADR-0046](./0046-notification-service-architecture.md) rule 17) moved Auth, the last user
> of `@golevelup/nestjs-rabbitmq`, onto the service-kit `RabbitMqEventBus` and its canonical header envelope. No Core service uses
> `@golevelup/nestjs-rabbitmq` any more; the exchange (`nawara.events`) and the routing-key convention (event name verbatim) are unchanged.
- **GitHub issue:** https://github.com/nawara-solutions/nawara-core/issues/17

## Context

`CLAUDE.md`'s "Architecture principles" section states, as a flat assertion never run through
this repo's own ADR process: "**Async events for side effects.** Use RabbitMQ for things like
'payment completed → notify user' rather than direct synchronous calls between services where
avoidable." That sentence names a specific technology choice — a message broker — without ever
having gone through this repo's own stated bar for when a decision needs one.
`docs/adr/README.md`'s own "when to write one" criteria lists, first, exactly this kind of
decision: "Choosing a datastore, message broker, or framework." No ADR for the broker choice has
ever existed, and neither has any decision about exchange/queue naming, routing-key convention,
message-body shape, or client library — every one of those is a separate, equally-undecided
question sitting underneath the one-line assertion in `CLAUDE.md`.

The gap is not hypothetical. `docs/add/auth-service.md`'s "Communication & data flow" section
already documents a concrete list of ten async events this design depends on, none of which can
actually be published today:

> - **`user.registered`** — `{ userId, role, organizationId, timestamp }`, published after a
>   successful registration so `notification-service` can react (e.g. send a welcome message)
>   without `auth-service` taking on a direct dependency on `notification-service` or knowing
>   anything about notification channels/templates.
> - **`admin.operator_registered`** — `{ operatorId, platformId, ownerId, channel:
>   "email"|"phone", timestamp }` (per ADR-0011), published when an owner creates an operator
>   account, so `notification-service` can send a welcome message the same way it does for
>   `user.registered`.
> - **`admin.operator_code_issued`** — `{ userId, platformId, channel: "email"|"sms",
>   destination, code, expiresAt, timestamp }` (per ADR-0011), published every time
>   `POST /auth/admin/login/operator/request-code` succeeds on a working day. As of ADR-0014,
>   `expiresAt` is the operator's own scheduled shift end (or `now + 8h` if unscheduled), not a
>   flat 8-hour value.
> - **`admin.operator_confirmation_code_issued`** — `{ userId, platformId, channel:
>   "email"|"sms", destination, code, expiresAt, timestamp }` (per ADR-0015), published when
>   `POST /auth/admin/operators` creates a new operator, carrying a `purpose: 'confirmation'`
>   code with a flat `now + 8h` expiry. Distinct from `admin.operator_code_issued`, which only
>   ever carries a `purpose: 'login'` code.
> - **`admin.operator_contact_confirmed`** — `{ operatorId, platformId, timestamp }` (per
>   ADR-0015), published when `POST /auth/admin/operators/confirm` successfully matches a
>   confirmation code. No `ownerId` — the confirming actor is the operator, not the owner,
>   unlike `admin.operator_blocked`/`admin.operator_unblocked` below.
> - **`admin.secret_key_login_from_new_device`** — `{ userId, platformId, channel: "email",
>   destination, ipAddress, userAgent, timestamp }` (per ADR-0010), published when an owner
>   logs in via secret key from a fingerprint `AdminDeviceService` hasn't seen before.
> - **`admin.secret_key_rotated`** — `{ userId, platformId, timestamp }` (per ADR-0010),
>   published on every secret-key rotation.
> - **`admin.operator_blocked`** — `{ operatorId, platformId, ownerId, timestamp }` (per
>   ADR-0012), published when an owner blocks an operator (`POST
>   /auth/admin/operators/:id/block`). `ownerId` gives an incidental, minimal "who did it"
>   record — not a substitute for a real audit log, which remains deferred (see Open
>   questions).
> - **`admin.operator_unblocked`** — `{ operatorId, platformId, ownerId, timestamp }` (per
>   ADR-0012), published when an owner unblocks an operator.

Immediately under that list, the same document states the gap in its own words:

> **Infrastructure gap:** no RabbitMQ broker, exchange/queue naming convention, or client
> library exists anywhere in this repo yet — every event above is a design recommendation, not
> a component that can be built today without that follow-up infra work landing first.

This is not unique to `auth-service`. `docs/adr/0006-per-user-subscription-reservation-on-license-lapse.md`
independently flags the identical gap for `payment-service`'s own events
(`license.expired`, `license.reactivated`, `subscription.suspended`, `subscription.resumed`):
"all currently undeliverable in practice — no RabbitMQ broker, exchange/queue convention, or
client library exists anywhere in this repo yet (same gap already flagged in `auth-service`'s
design docs)." Two independent design documents, for two different services, have now each
separately named the same undesigned dependency rather than resolving it once at the
architecture level, which is exactly the kind of shared, cross-cutting decision an ADR exists
to settle.

No naming/message-format convention has ever been decided anywhere in this repo — not the
exchange type, not the routing-key scheme, not the message-body shape, not which client library
a NestJS service should use to talk to the broker.

## Options considered

1. **Kafka.** A high-throughput, partition-based log well suited to streaming workloads with
   many consumers replaying history. Rejected: the operational overhead — a coordination layer
   (ZooKeeper or KRaft), partition management, and a realistic minimum broker count for genuine
   durability — is disproportionate to what this repo actually needs right now: a handful of
   low-volume, admin/lifecycle events (a user registered, a code was issued, a key was rotated),
   not a high-throughput streaming pipeline. Choosing Kafka here would mean carrying
   infrastructure complexity sized for a problem this repo doesn't have.
2. **Redis pub/sub, or Redis Streams.** Rejected on two different grounds depending on the
   variant. Plain Redis pub/sub has no durability at all — a subscriber that happens to be down
   when a message is published loses it permanently — which is unacceptable for a
   time-critical, sole-delivery-mechanism event like `admin.operator_code_issued` (the login
   code itself travels only in the event payload; there is no other channel through which an
   operator ever receives it). Redis Streams adds a meaningful amount of that missing
   durability, but doing so means reinventing a subset of what a real message broker already
   provides natively, for a piece of infrastructure (Redis) this repo has no other use for yet
   — adopting it here would mean introducing a new stateful dependency solely to approximate
   what a broker already does out of the box.
3. **A cloud-managed broker (e.g. AWS SQS/SNS, or an equivalent).** Would remove the operational
   burden of running a broker at all. Rejected: every other piece of infrastructure this repo
   has actually stood up — the VPS, Traefik, the GHCR-based Docker deploy pipeline — is
   self-hosted-VPS-first. Introducing a cloud-vendor-managed broker for just this one piece
   breaks that consistency and adds a second deployment model and a second set of
   vendor-specific credentials to manage, for no clear benefit at this project's current scale.
4. **RabbitMQ, self-hosted on the same VPS model as everything else (chosen).** A mature,
   widely-used broker purpose-built for exactly the fan-out, topic-based pub/sub shape this
   design's events already need, with an operational footprint appropriate to this project's
   actual event volume.

Client library, considered as part of the same decision since it directly shapes how every
NestJS service in this repo will talk to the broker:

- **Raw `amqplib`.** The underlying Node AMQP client everything else in the Node ecosystem is
  ultimately built on. Rejected as the direct choice: using it as-is would mean every one of
  the four services in this repo hand-rolling its own connection lifecycle, channel management,
  and reconnection logic — real, duplicated effort repeated four times for a concern that has
  nothing to do with any one service's actual business logic.
- **`@nestjs/microservices`'s RMQ transport.** The official NestJS-maintained option. Rejected:
  it's built around a request/response RPC pattern between a fixed, known set of microservices
  — not the fan-out, topic-exchange pub/sub shape this design's events actually need (an
  unbounded, decoupled set of future consumers subscribing to routing-key patterns on a shared
  exchange, with publishers that never know who's listening). Adopting it here would mean
  fighting the abstraction to make it do something it isn't shaped for.
- **`@golevelup/nestjs-rabbitmq` (chosen).** NestJS-idiomatic — dependency-injection-friendly,
  decorator-based publish/subscribe (`@RabbitSubscribe`, `amqpConnection.publish(...)`) — and it
  owns connection/channel lifecycle and reconnection internally, removing the exact duplicated
  effort the raw-`amqplib` option would otherwise spread across every service. It is also the
  de facto community standard for this specific shape of problem (topic-exchange pub/sub from a
  NestJS app), which matters for a small team: broadly-used, well-documented conventions are
  cheaper to onboard onto and debug than a bespoke wrapper around `amqplib`.

## Decision

We chose **RabbitMQ**, self-hosted via a Docker container for local development now, with
production deployment explicitly deferred (see Consequences) — and **`@golevelup/nestjs-rabbitmq`**
as the client library every NestJS service in this repo uses to talk to it. Concretely:

- **One durable topic exchange, named `nawara.events`, shared across every publishing service
  in this repo** — not one exchange per service. A single shared namespace matches how the
  events are already named in the existing docs: flat `entity.action` names
  (`user.registered`, `admin.operator_code_issued`, `license.expired`), never
  service-prefixed. Splitting the exchange per service would fight that existing naming
  convention for no benefit, since nothing about these events is meant to be
  service-private.
- **Routing key = the event name, verbatim** — exactly as already documented in
  `docs/add/auth-service.md`, `docs/sdd/auth-service.md`, and ADR-0006. No new naming scheme is
  invented here; this ADR only formalizes what the existing design docs already assume. For
  example: `user.registered`, `admin.operator_code_issued`, `admin.secret_key_rotated`,
  `admin.operator_blocked`, and (from ADR-0006) `license.expired` and
  `subscription.suspended` are all, verbatim, the routing keys those events publish under —
  there is no separate "event type" field distinct from the routing key.
- **Message body = the payload shape each event already documents, as JSON, with no added
  envelope.** A publisher sends exactly the flat, primitive-payload object already specified for
  that event (e.g. `admin.operator_code_issued`'s `{ userId, platformId, channel, destination,
  code, expiresAt, timestamp }`) as the AMQP message body. No generic wrapper such as `{type,
  timestamp, data}` is introduced. This is deliberate: the existing docs already specify flat,
  primitive-payload shapes per event, and wrapping them in a generic envelope would duplicate
  information the transport already carries for free — the routing key already *is* the event
  type, and AMQP's own message properties (`timestamp`, `contentType: application/json`) already
  carry the metadata an envelope's `type`/`timestamp` fields would otherwise re-encode inside the
  body. Adding an envelope on top would be pure duplication for no benefit.
- **Each consuming service declares and owns its own durable queue**, bound to whichever
  routing-key pattern(s) it cares about — e.g. a hypothetical future `notification-service`
  declaring a `notification-service.events` queue bound to `#` (everything) or to specific
  patterns like `admin.*`. Publishers never declare a queue and never know who, if anyone, is
  listening; they only know about the one shared exchange. This keeps publishers and consumers
  decoupled in the way async events are supposed to be — a new consumer can start listening
  without any publisher-side change.

Explicitly **out of scope** for this ADR, stated plainly rather than left implicit: dead-letter-
queue policy, retry/backoff strategy for messages a consumer fails to process, and message
schema versioning. These are real needs that will matter once real consumers and real production
traffic exist, but designing them now — against zero consumers and zero traffic — would be
premature; there is nothing yet to validate those choices against.

## Consequences

- Closes the process gap named in Context: this decision, previously a flat, undesigned
  assertion in `CLAUDE.md`, now has a real ADR, consistent with `docs/adr/README.md`'s own
  stated criteria for when one is required.
- Every one of the ten events `docs/add/auth-service.md` already lists (quoted in full above),
  plus ADR-0006's four `payment-service` events, now has its exact wire format decided: which
  exchange, what routing key, and what the message body looks like on the wire. None of those
  events' own shapes are redesigned here — this ADR only settles how an already-decided payload
  actually travels from publisher to consumer.
- **Local-dev-only for now is a deliberate, stated choice, not an oversight.** Production
  deployment of RabbitMQ is explicitly out of scope for this ADR and is tracked as a separate
  future step, to be taken once `notification-service` (or any other consumer) has a real
  implementation that would actually consume from it. Shipping a production broker with zero
  consumers would be pure standing infrastructure cost with no corresponding benefit yet.
- Introduces this repo's **first `docker-compose.yml`** — previously none existed anywhere in
  `nawara-core`. Per-service persistent stores that don't exist yet either (e.g. a Postgres
  instance for `auth-service`, per ADR-0003, once that service has a real implementation to back)
  can be added to the same file later as those services mature; that is not blocked by, or a
  prerequisite for, this ADR.
- Adds a new production dependency, `@golevelup/nestjs-rabbitmq`, to every NestJS service in
  this repo that publishes or consumes events — a small, additive dependency footprint, not a
  structural change to any service's existing module boundaries.
- Every publishing service now needs, at minimum, connection configuration (a RabbitMQ URL) to
  reach the broker — this repo's existing "no secret-distribution mechanism yet" gap (already
  flagged in `docs/add/auth-service.md`'s non-functional constraints) now also covers broker
  credentials, not just the JWT signing key. Not a new gap, a wider surface on an existing one.
- Dead-letter handling, retry/backoff, and schema versioning remain undesigned, as stated in
  Decision — real follow-up work once this repo has actual consumers whose failure modes can be
  observed and designed against, rather than guessed at now.

# 0053. Core V1 production RabbitMQ: one private node, per-service identities, audit-service before Auth

- **Status:** Accepted (2026-09-27, RB-1 decisions approved by the project owner; implemented as RB-2)
- **Date:** 2026-09-27
- **Deciders:** project owner (RB-1: broker location, private network, per-service identities, audit-service first)

## Context

Since Stage 18.7 every Core producer writes its audit evidence to its own transactional outbox and the kit relay publishes it to
RabbitMQ (`nawara.events`), and Auth, Organization, File, Release, Billing, Payment, Audit and Notification all refuse to start in
production without `RABBITMQ_URL`. Production RabbitMQ was an open prerequisite (P-A6, Stage 18.1 §19; still open at Stage 19.6), so
the first Auth deployment after Stage 18.7 stopped at the deploy script's `RABBITMQ_URL` check (by design: nothing was changed).
Per-service broker identity (P-A1) was an open owner / security question.

One property of the relay decides the deployment order. It publishes to the topic exchange **without `mandatory`**, and marks the outbox
row published once the broker **confirms** it. An `audit.*` message for which no queue is bound is confirmed by RabbitMQ and dropped. So
if Auth relayed before `audit-service.audit` existed and was bound to `audit.#`, its central audit evidence would be lost for good (its
local audit row survives). This was reproduced against a real broker (`scripts/deploy-tests/real-broker.mjs`).

## Options considered

1. **Broker location:** (a) one node on the current Core VPS; (b) a dedicated broker VPS; (c) a managed AMQP service. (b) and (c) add
   cost, a cross-host network path that needs TLS, and operations Core V1 does not need; the load is small (audit evidence, later a few
   domain events).
2. **Identity:** (a) one shared Core-wide user; (b) one user per service with the narrowest grants the kit's AMQP operations allow. (a)
   lets any service impersonate any producer on the bus (T1) and read any queue.
3. **Audit topology before Auth:** (a) deploy the real audit-service first and let its consumer declare and bind its queue; (b) pre-declare
   the queue by hand; (c) make the relay publish `mandatory`. (b) duplicates the queue arguments and a mismatch prevents audit-service from
   starting later (the queue is `x-dead-letter-exchange`-bound); (c) changes runtime code for an ordering that deployment can enforce.

## Decision

1a, 2b and 3a.

1. **One RabbitMQ node on the Core VPS**, `rabbitmq:3.13.7-alpine` pinned by digest (the 3.13.7 the local compose broker and the
   real-broker suites run), without the management plugin. Container `nawara-core-rabbitmq`, fixed hostname (the node's data directory
   is keyed by it), named volume `nawara-core-rabbitmq-data` for `/var/lib/rabbitmq`, `--restart unless-stopped`, health = the `rabbit`
   app running, its AMQP listener up and no resource alarm. One vhost, `nawara-core`.
2. **Private network.** A Docker network created `--internal`, `nawara-core-internal`, holds the broker, audit-service and its database.
   The broker publishes no port (neither 5672 nor 15672), has no Traefik route and is attached to that network only. A service that must
   also be reached by Traefik (Auth) joins both networks and pins Traefik to `deploy_edge` (`traefik.docker.network`).
3. **Secrets** are generated on the server (`$HOME/nawara-core/rabbitmq`, 0700 / 0600), never in GitHub, never printed, never on a
   command line (passwords reach `rabbitmqctl` on stdin). A non-guest default administrator is set, so `guest` never exists; no service
   uses the administrator. Each service's `RABBITMQ_URL` is written to `clients/<service>.env`, which only its own deploy script reads.
4. **Per-service identities (narrows P-A1 / threat T1; does not close it)**, grants derived from what the kit bus does (`rabbitmq-event-bus.ts`):

   | Identity | configure | write | read | topic `nawara.events` write / read |
   |---|---|---|---|---|
   | auth-service, organization-service, file-service, release-service (producers) | `nawara.events` | `nawara.events` | none | `^audit\.` / none |
   | audit-service (consumer of `audit-service.audit`) | `nawara.events`, `nawara.events.dlx`, its queue, `.retry`, `.dead` | `amq.default`, `nawara.events.dlx`, its three queues | exchanges + its three queues | none / `^audit\.` |
   | notification-service (consumer of `notification.events`) | same shape for its queues | same shape | same shape | none / exactly its intake bindings |

   Billing and Payment publish and consume domain events whose grants are defined when they are deployed; until then the provisioning
   refuses them. Auth's grant is `audit.*` only because production runs `AUTH_EVENTS=off`: enabling domain events (Stage 21.x) widens it
   deliberately, and until then a domain-event publish is refused by the broker and the row waits in the outbox (nothing is lost).
   **Limits (accepted residuals):** configure on the exchange (the kit declares it) also allows deleting it; write on `amq.default`
   (retry and dead-letter copies) lets a consumer address any queue by name; the broker does not validate a publisher `user-id` against
   the event's `source` header (Audit's catalog binding still dead-letters a mismatched producer). In particular the four audit-only
   producers share the same `^audit\.` grant, so one of them can still publish under another's `source`; P-A1's broker-side publisher
   validation (Stage 18.1 §19) remains open, and this ADR accepts that residual for the first deployment.
5. **Order: broker, then audit-service, then Auth.** audit-service's deploy succeeds only when its container is ready (database,
   migrations, broker and the ingestion consumer attached) **and** the broker shows `audit-service.audit` declared with its dead-letter
   exchange, `.retry`, `.dead`, a consumer and the `nawara.events -> audit.#` binding. Auth's deploy refuses, before migrating or stopping
   anything, unless that binding exists on the broker. The order is machine-checked (`scripts/deploy-tests/`).
6. **Persistence.** Queues are durable and messages persistent (kit). Until a relay's publish is confirmed, the producer's outbox is the
   source of truth; after the confirm the broker holds the only copy until the consumer persists it, hence the volume. Losing the volume
   loses at most confirmed-but-unconsumed messages.

## Consequences

- Auth can be deployed again (with PR #141's hostnames) once the broker is provisioned and audit-service deployed:
  `docs/runbooks/core-rabbitmq-production.md`.
- New production pieces: `infra/rabbitmq/provision.sh` with `core-rabbitmq-provision.yml`, `apps/audit-service/deploy/` with
  `audit-service-deploy.yml`. Both are manual and run from `main` only, in the shared production queue.
- audit-service has no public route and no reader (every read is refused until P-A8 names real readers).
- Every future broker participant needs an identity here first; adding a binding to Notification needs a new grant.
- Follow-ups: backups (P-A7), DLQ and lag alerting (P-A4), retention (P-A2 / P-A3), enabling `AUTH_EVENTS` (Stage 21.x), a deliberate
  RabbitMQ upgrade path beyond 3.13.

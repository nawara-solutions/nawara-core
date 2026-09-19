# 0037. Reliable events: RabbitMQ with a transactional outbox and an inbox

- **Status:** Proposed
- **Date:** 2026-09-19
- **Deciders:** Anwar (project owner)

> **Builds on [ADR-0018](./0018-rabbitmq-as-async-message-broker.md)** (RabbitMQ, topic exchange `nawara.events`; still *Proposed*).
> The project owner accepted RabbitMQ for the financial services on 2026-09-19; this ADR adds message headers, an outbox and an inbox.
> ADR-0018 needs a back-pointer; its "production deployment deferred" still holds. auth-service's fire-and-forget publisher is unchanged.

## Context

Accounting must neither miss nor double-count `payment.succeeded`. Today RabbitMQ runs only in the local `docker-compose.yml`, not in production, and events are published
fire-and-forget, so delivery is not guaranteed. Notifications must never be a synchronous requirement of a payment.

## Options considered

1. **Transactional outbox in producers plus an inbox (dedupe by `eventId`) in consumers, over RabbitMQ.** Chosen.
2. *Outbox only, broker undecided.* Rejected: the broker is needed for the flows to work end to end.
3. *Synchronous HTTP between the three services.* Rejected: an unavailable accounting service would block payments.

## Decision

- A service writes each event to its `outbox` table **in the same transaction** as the state change. A relay publishes
  unsent rows to `nawara.events` (routing key = event name) and marks them sent; it retries, so delivery is **at least once**.
- Message headers carry `eventId` (unique), `occurredAt`, `correlationId` and the producing service; the payload keeps the flat,
  documented shape.
- A consumer records `eventId` in its `inbox` in the same transaction as its effect (unique constraint), so processing is
  **idempotent**: a redelivered `payment.succeeded` creates one journal entry.
- Events are named `invoice.*`, `payment.*`, `cash_payment.*`, `refund.*`, `license.*`, `subscription.*` (the old design's `charge.cash_requested` becomes `cash_payment.requested`); payloads contain no
  secret and no card or bank data.
- Local and test runs use an in-memory bus behind the same port; production needs RabbitMQ deployed (a separate approval).

## Consequences

- No lost or duplicated financial effect on crash or redelivery.
- Eventual consistency between services, and an operational relay to monitor.
- Extra tables and a relay in each financial service; ordering across events is not guaranteed, so consumers validate state.

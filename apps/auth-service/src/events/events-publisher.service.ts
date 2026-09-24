import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { describeFailure, getRequestContext, type EventBus as KitEventBus, type EventEnvelope } from '@nawara/service-kit';
import type { EventBus } from '../common/ports.js';

/** The kit `RabbitMqEventBus` this publisher delegates to (provided by `EventsModule`). */
export const KIT_EVENT_BUS = Symbol('KIT_EVENT_BUS');

/** Canonical envelope identity of every Auth event (Stage 16.2, ADR-0046 rule 17): the existing payloads are version 1. */
export const AUTH_EVENT_SOURCE = 'auth-service';
export const AUTH_EVENT_VERSION = 1;

/** Events accepted but not yet confirmed by the broker. Past it a new event is dropped (logged) rather than held in memory without bound. */
export const MAX_PENDING_PUBLISHES = 1000;
/** Bound on waiting, at shutdown, for the events still queued to be confirmed before the bus is closed. */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 5000;

/**
 * Publishes Auth's events to the shared `nawara.events` topic exchange (ADR-0018) in the canonical Core envelope, through the kit's
 * `RabbitMqEventBus.publish` (Stage 16.2): `messageId` = the event id, `type` = the routing key = the event name, headers
 * `eventId`, `occurredAt`, `source`, `version`, `correlationId`, persistent, and a bounded publisher confirm. The payload is published
 * unchanged, exactly the shape each event documents in the ADD/SDD.
 *
 * Fire-and-forget for the caller, as before: `publish` returns at once and never throws, so an Auth request never waits on or fails
 * because of the broker. There is no Auth outbox (D19, deferred): an event whose publish fails, or that is not confirmed, is logged
 * and NOT retried, and an event can be lost between the database commit and the broker. Publishes run one at a time, in call order:
 * the kit bus is built for a single sequential publisher (the outbox relay), and sequential publishing keeps one connection and one
 * confirm channel whatever the request concurrency.
 *
 * Log lines carry the event id, the event name and the failure class only: payloads can hold contact details and one-time codes and
 * must never reach a log.
 */
@Injectable()
export class EventsPublisherService implements EventBus, OnApplicationShutdown {
  private readonly log = new Logger(EventsPublisherService.name);
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private closing = false;

  constructor(@Inject(KIT_EVENT_BUS) private readonly bus: KitEventBus) {}

  publish(routingKey: string, payload: object): void {
    const id = randomUUID(); // one identity per event: the envelope id, the `eventId` header and the AMQP `messageId`
    const event: EventEnvelope = {
      id,
      name: routingKey,
      payload: payload as Record<string, unknown>,
      headers: {
        eventId: id,
        occurredAt: new Date().toISOString(),
        correlationId: getRequestContext()?.correlationId,
        source: AUTH_EVENT_SOURCE,
        version: AUTH_EVENT_VERSION,
      },
    };
    if (this.closing) return this.drop(event, 'shutting_down');
    if (this.pending >= MAX_PENDING_PUBLISHES) return this.drop(event, 'backlog_full');
    this.pending++;
    this.tail = this.tail
      .then(() => (this.closing ? this.drop(event, 'shutting_down') : this.bus.publish(event)))
      .catch((e: unknown) => {
        // Stage 14.7: a stable name and the failure class. There is no outbox here (D19): this event is not retried.
        this.log.error(`event_publish_failure eventId=${event.id} name=${event.name} ${describeFailure(e)} — auth events are fire-and-forget (no outbox): not retried`);
      })
      .finally(() => {
        this.pending--;
      });
  }

  /** Waits (bounded) for the queued events, then closes the bus. Runs after the HTTP server has stopped admitting requests. */
  async onApplicationShutdown(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const drained = await Promise.race([
      this.tail.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), SHUTDOWN_DRAIN_TIMEOUT_MS);
      }),
    ]).finally(() => clearTimeout(timer));
    this.closing = true; // anything still queued is dropped instead of opening a new connection on a closed bus
    if (!drained) this.log.warn(`event_publish_drain_timeout pending=${this.pending} timeoutMs=${SHUTDOWN_DRAIN_TIMEOUT_MS} — queued auth events are dropped (no outbox)`);
    await this.bus.close();
  }

  private drop(event: EventEnvelope, reason: 'shutting_down' | 'backlog_full'): void {
    this.log.error(`event_publish_dropped eventId=${event.id} name=${event.name} reason=${reason} pending=${this.pending} — auth events are fire-and-forget (no outbox): not retried`);
  }
}

import { Injectable, Logger } from '@nestjs/common';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { describeFailure } from '@nawara/service-kit';
import { EVENTS_EXCHANGE } from './events.constants.js';

/**
 * Generic publisher for this repo's shared `nawara.events` topic exchange (per ADR-0018).
 * Routing key = the event name verbatim (e.g. `user.registered`); the payload is published
 * as-is, matching the shape each event already documents in the ADD/SDD — no added envelope.
 */
@Injectable()
export class EventsPublisherService {
  private readonly log = new Logger(EventsPublisherService.name);

  constructor(private readonly amqpConnection: AmqpConnection) {}

  /**
   * Fire-and-forget by design (callers never block on the broker), but a publish that FAILS must not
   * become an unhandled rejection. Only the routing key is logged — payloads can carry contact
   * details or one-time codes and must never reach a log.
   */
  publish(routingKey: string, payload: object): void {
    this.amqpConnection.publish(EVENTS_EXCHANGE, routingKey, payload).catch((e: unknown) => {
      // Stage 14.7: a stable name and the failure class. There is no outbox here yet (F14): this event is not retried.
      this.log.error(`event_publish_failure routingKey=${routingKey} ${describeFailure(e)} — auth events are fire-and-forget (no outbox): not retried`);
    });
  }
}

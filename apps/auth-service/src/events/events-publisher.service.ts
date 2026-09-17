import { Injectable } from '@nestjs/common';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { EVENTS_EXCHANGE } from './events.constants.js';

/**
 * Generic publisher for this repo's shared `nawara.events` topic exchange (per ADR-0018).
 * Routing key = the event name verbatim (e.g. `user.registered`); the payload is published
 * as-is, matching the shape each event already documents in the ADD/SDD — no added envelope.
 */
@Injectable()
export class EventsPublisherService {
  constructor(private readonly amqpConnection: AmqpConnection) {}

  publish(routingKey: string, payload: object): void {
    this.amqpConnection.publish(EVENTS_EXCHANGE, routingKey, payload);
  }
}

/** Time source. Injected so session ceilings, expiries and shifts are testable without sleeping. */
export interface Clock {
  now(): Date;
}
export const CLOCK = Symbol('CLOCK');
export class SystemClock implements Clock {
  now() {
    return new Date();
  }
}

/** Async event bus (RabbitMQ in production, per ADR-0018). Payloads MUST NOT contain secrets. */
export interface EventBus {
  publish(routingKey: string, payload: object): void;
}
export const EVENT_BUS = Symbol('EVENT_BUS');
export class NoopEventBus implements EventBus {
  publish() {
    /* events disabled */
  }
}

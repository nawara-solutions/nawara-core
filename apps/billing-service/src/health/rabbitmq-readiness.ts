import amqp from 'amqplib';
import type { ReadinessRegistry, RabbitMqEventBus } from '@nawara/service-kit';

/**
 * The kit registers database/migrations readiness automatically but has no broker check (it doesn't assume one is
 * configured). Two checks, because they answer different questions:
 *  - `rabbitmq`: a cheap connect-and-close proves the broker is reachable;
 *  - `rabbitmq-consumer`: every consumer of the event bus is actually attached to its queue. A reachable broker does not
 *    prove this: a consumer whose channel was lost stays down until it has been re-established, and while it is down
 *    Billing receives no Payment events (the reconciler is then the only way a settlement reaches Billing).
 * Readiness therefore reports not-ready while a consumer is reconnecting; the HTTP API itself does not depend on it.
 */
export function registerRabbitmqReadiness(registry: ReadinessRegistry, url: string, bus?: RabbitMqEventBus): void {
  registry.register('rabbitmq', async () => {
    const conn = await amqp.connect(url, { timeout: 2000 });
    await conn.close();
  });
  if (bus) {
    registry.register('rabbitmq-consumer', async () => {
      if (bus.consumerStatus().some((c) => c.state !== 'consuming')) throw new Error('consumer not attached');
    });
  }
}

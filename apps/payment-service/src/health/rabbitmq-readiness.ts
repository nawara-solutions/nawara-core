import amqp from 'amqplib';
import type { ReadinessRegistry } from '@nawara/service-kit';

/**
 * The kit registers database/migrations readiness automatically but has no broker check (it doesn't assume one is
 * configured). A cheap connect-and-close proves the broker is reachable without needing access to the event bus's
 * own (lazily-opened, private) connection.
 */
export function registerRabbitmqReadiness(registry: ReadinessRegistry, url: string): void {
  registry.register('rabbitmq', async () => {
    const conn = await amqp.connect(url, { timeout: 2000 });
    await conn.close();
  });
}

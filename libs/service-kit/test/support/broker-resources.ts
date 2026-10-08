import amqp from 'amqplib';
import { afterAll } from 'vitest';
import { deadQueueName, retryQueueName } from '../../src/events/dead-letter.js';

/**
 * V2 A15.3: the broker resources one test file declares, deleted when the file ends. The kit's bus declares DURABLE exchanges and
 * queues (a consumer queue brings its `.retry` and `.dead` queues, an exchange its `.dlx`), so a uniquely named resource that is never
 * deleted stays on the broker forever; on a developer's long-lived broker that accumulated to over a thousand queues. Ownership is
 * explicit: only names registered here are deleted (no wildcard, nothing another suite declared). Deleting a resource that was never
 * declared, or is already gone, is a no-op on RabbitMQ, so a partly completed test cleans up too.
 *
 * Call once at module level; register each name where it is created (`owned.exchange(\`nawara.events.x${uniq()}\`)`). Deletion goes
 * to `TEST_RABBITMQ_URL` directly (never through a test's proxy, which a test may have severed).
 */
export function ownedBrokerResources(): { exchange: (name: string) => string; queue: (name: string) => string } {
  const exchanges = new Set<string>();
  const queues = new Set<string>();
  afterAll(async () => {
    const url = process.env.TEST_RABBITMQ_URL;
    if (!url || (exchanges.size === 0 && queues.size === 0)) return;
    const conn = await amqp.connect(url);
    try {
      const ch = await conn.createChannel();
      for (const q of queues) for (const name of [q, retryQueueName(q), deadQueueName(q)]) await ch.deleteQueue(name);
      for (const e of exchanges) for (const name of [e, `${e}.dlx`]) await ch.deleteExchange(name);
      await ch.close();
    } finally {
      await conn.close();
    }
  });
  return {
    exchange: (name) => (exchanges.add(name), name),
    queue: (name) => (queues.add(name), name),
  };
}

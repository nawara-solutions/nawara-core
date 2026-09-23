#!/usr/bin/env node
// Stage 15.3 crash-window consumer (test-only child process). Consumes one queue with the kit's RabbitMqEventBus + InboxService, the same
// path every Core consumer uses, and records each business effect in `effect`. With CRASH_WINDOW set it SIGKILLs itself on the first
// delivery at a precise point, so the parent can prove what the broker and the inbox do afterwards:
//   A  delivery received, before the database transaction
//   B  inside the transaction, after the effect row is written, before COMMIT
//   C  after COMMIT, before the handler returns (so before the ack)
// Every delivery is announced on stdout as `delivery <eventId>` (physical delivery count for the parent).
import { DbService, InboxService, RabbitMqEventBus } from '../../../libs/service-kit/dist/index.js';

const { DATABASE_URL, RABBITMQ_URL, EXCHANGE, QUEUE, CRASH_WINDOW } = process.env;
const die = () => process.kill(process.pid, 'SIGKILL');
const db = new DbService({ url: DATABASE_URL, max: 2 });
const inbox = new InboxService();
const bus = new RabbitMqEventBus({ url: RABBITMQ_URL, exchange: EXCHANGE });
let crashed = false;
await bus.subscribe({
  queue: QUEUE,
  bindings: ['validation.#'],
  handler: async (event) => {
    process.stdout.write(`delivery ${event.id}\n`);
    const crash = CRASH_WINDOW && !crashed;
    if (crash && CRASH_WINDOW === 'A') die();
    await inbox.handle(db, event, async (q) => {
      await q.query('INSERT INTO effect (event_id) VALUES ($1)', [event.id]);
      if (crash && CRASH_WINDOW === 'B') die();
    });
    if (crash && CRASH_WINDOW === 'C') die();
    crashed = true;
  },
});
process.stdout.write('ready\n');
process.on('SIGTERM', async () => {
  await bus.close();
  await db.onApplicationShutdown();
  process.exit(0);
});

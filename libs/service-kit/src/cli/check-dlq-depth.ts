#!/usr/bin/env node
import amqp from 'amqplib';

/**
 * Operational DLQ-depth check (Stage 5 hardening): reports the message count on one or more dead-letter queues
 * without consuming, reprocessing or deleting anything. Exits 1 if any named queue is non-empty, so it can be run
 * from a cron, a manual runbook step, or wired into an external check — deliberately NOT a metrics platform: a plain
 * queue-depth read is the smallest mechanism that answers "is anything stuck in a DLQ right now?" (`RabbitMqEventBus`
 * names a consumer's dead-letter queue `${queue}.dead`, e.g. `billing.payment-events.dead`.)
 *
 * Usage: nawara-check-dlq --queue billing.payment-events.dead [--queue ...]
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const queues: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--queue' && args[i + 1]) queues.push(args[++i]!);
    else throw new Error(`unknown argument: ${args[i]}`);
  }
  if (queues.length === 0) throw new Error('at least one --queue <name> is required');
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL is required');

  const conn = await amqp.connect(url);
  let stuck = 0;
  try {
    for (const name of queues) {
      // A fresh channel per queue: `checkQueue` closes its channel on a 404 (queue not yet declared), which would
      // otherwise poison the remaining checks in the loop. A 404 also emits an 'error' event on the channel IN
      // ADDITION to rejecting the call (amqplib) — unhandled, that crashes the whole process, so it must be listened
      // for too, not just caught here (same gotcha the real-broker E2E suite's own queue helpers guard against).
      const ch = await conn.createChannel();
      ch.on('error', () => undefined);
      try {
        const { messageCount } = await ch.checkQueue(name);
        console.log(`${name}: ${messageCount} message(s)`);
        if (messageCount > 0) stuck++;
      } catch {
        console.log(`${name}: queue does not exist yet (nothing has dead-lettered)`);
      } finally {
        await ch.close().catch(() => undefined);
      }
    }
  } finally {
    await conn.close().catch(() => undefined);
  }
  if (stuck > 0) {
    console.error(`${stuck} dead-letter queue(s) have messages — needs manual review`);
    process.exit(1);
  }
}

main().catch((e: unknown) => {
  console.error(`dlq depth check failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  process.exit(1);
});

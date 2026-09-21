#!/usr/bin/env node
import amqp from 'amqplib';
import { formatDeadLetter, inspectDeadLetters, outputToken as q, replayDeadLetter } from '../events/dlq-tools.js';

/**
 * Operator tool for a consumer's dead-letter queue. Output is one `key=value` line per fact, so it can be read by a person or grepped.
 * The broker URL comes ONLY from `RABBITMQ_URL` (never an argument, never printed).
 *
 *   nawara-dlq list   --queue billing.payment-events.dead [--limit 50] [--field paymentRequestId ...]
 *   nawara-dlq replay --queue billing.payment-events.dead --event-id <id> [--wait-seconds 10]
 *
 * `list` never consumes: depth comes from the queue, messages are peeked and handed back. `replay` moves ONE message back to its
 * consumer's work queue unchanged; the consumer then validates and de-duplicates it like any delivery. Exit codes for `replay`:
 * 0 consumed, 2 rejected again (still in the DLQ), 3 still pending, 4 not found in the DLQ; 1 any error.
 */
const EXIT = { consumed: 0, rejected_again: 2, pending: 3, not_found: 4 } as const;

function parse(argv: string[]): { command: string; opts: Map<string, string[]> } {
  const [command, ...rest] = argv;
  if (command !== 'list' && command !== 'replay') throw new Error('usage: nawara-dlq <list|replay> --queue <name>.dead ...');
  const opts = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const value = rest[++i];
    if (!flag.startsWith('--') || value === undefined) throw new Error(`invalid argument: ${flag}`);
    opts.set(flag.slice(2), [...(opts.get(flag.slice(2)) ?? []), value]);
  }
  return { command, opts };
}

const one = (opts: Map<string, string[]>, name: string): string | undefined => opts.get(name)?.[0];
async function main(): Promise<void> {
  const { command, opts } = parse(process.argv.slice(2));
  const queue = one(opts, 'queue');
  if (!queue) throw new Error('--queue <name>.dead is required');
  const url = process.env.RABBITMQ_URL;
  if (!url) throw new Error('RABBITMQ_URL is required');

  const conn = await amqp.connect(url);
  try {
    if (command === 'list') {
      const limit = Number(one(opts, 'limit') ?? 50);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be a positive integer');
      const result = await inspectDeadLetters(conn, queue, { limit, fields: opts.get('field') ?? [] });
      console.log(`dlq_depth queue=${q(queue)} depth=${result.depth ?? 'not_declared'} shown=${result.messages.length}`);
      for (const m of result.messages) console.log(formatDeadLetter(m));
      return;
    }
    const eventId = one(opts, 'event-id');
    if (!eventId) throw new Error('--event-id <id> is required');
    const waitSeconds = Number(one(opts, 'wait-seconds') ?? 10);
    if (!Number.isFinite(waitSeconds) || waitSeconds < 0) throw new Error('--wait-seconds must be a non-negative number');
    console.log(`dlq_replay_started queue=${q(queue)} event=${q(eventId)}`);
    const r = await replayDeadLetter(conn, queue, eventId, { waitMs: waitSeconds * 1000 });
    console.log(`dlq_replay_result outcome=${r.outcome} event=${q(r.eventId)} target=${r.target} replays=${r.replayCount}`);
    process.exitCode = EXIT[r.outcome];
  } finally {
    await conn.close().catch(() => undefined);
  }
}

main().catch((e: unknown) => {
  console.error(`nawara-dlq failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  process.exit(1);
});

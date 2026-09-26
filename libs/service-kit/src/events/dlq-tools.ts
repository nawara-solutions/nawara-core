import type { Channel, ChannelModel, ConsumeMessage, GetMessage } from 'amqplib';
import { HEADER, counter, retryQueueName, withoutBrokerHistory } from './dead-letter.js';

/**
 * Operator tooling for a consumer's dead-letter queue (`<queue>.dead`): inspect it without consuming anything, and replay ONE
 * message back into its consumer. Deliberately small and broker-level: no business logic, no database, no HTTP surface. Whoever holds
 * the broker credentials (`RABBITMQ_URL`) can run it, exactly like `nawara-check-dlq` and `rabbitmqctl`.
 *
 * Replay republishes the SAME bytes with the SAME message id, type and headers (so the event id, payment request id and correlation id
 * are untouched) into the consumer's WORK queue, so the message takes the normal consumer path: the consumer's own validation and its
 * own de-duplication decide what happens. It never edits a payload and never targets any queue but the one the `.dead` name implies.
 */

export interface DeadLetterInfo {
  position: number;
  eventId: string | null;
  eventName: string | null;
  correlationId: string | null;
  failure: string | null;
  failureReason: string | null;
  failureError: string | null;
  retryCount: number;
  replayCount: number;
  failedAt: string | null;
  /** Stage 18.8: the body was replaced by a redaction document (never replayable). */
  bodyRedacted: boolean;
  /** Only the top-level payload fields the operator asked for by name, scalars only and truncated. Empty by default: payloads are not dumped. */
  fields: Record<string, string | number | boolean | null>;
}

export interface Inspection {
  queue: string;
  depth: number | null; // null: the queue does not exist yet, so nothing has ever been dead-lettered
  messages: DeadLetterInfo[];
}

export type ReplayOutcome =
  /** Left the work and retry queues and did not return to the DLQ inside the window. The consumer ACKNOWLEDGED it: applied, ignored (already applied) and deferred/conflict receipts all look like this: its own log line and receipt say which. */
  | 'consumed'
  /** Came back to the DLQ after the replay (with a new failure annotation): the consumer rejected it again. It is still recoverable there. */
  | 'rejected_again'
  /** Still queued or being retried when the window ended. */
  | 'pending'
  /** No message with that event id is in the DLQ (never dead-lettered, already replayed, or already removed). Nothing was changed. */
  | 'not_found'
  /** Stage 18.8: the dead-letter copy's body was redacted (it carries nothing to replay); it stays in the DLQ, unchanged. */
  | 'not_replayable';

export interface ReplayResult {
  outcome: ReplayOutcome;
  queue: string;
  target: string;
  eventId: string;
  replayCount: number;
}

/**
 * Stage 21.C.2 (ADR-0052 decision 5): a field whose NAME marks a secret is never shown, even when asked for by name. Some dead-lettered
 * events legitimately carry a one-time code for delivery (Auth's code events in Notification's queue); an operator inspecting the queue
 * sees `redacted`, never the value.
 */
export const SECRET_FIELD_NAME = /(^|[_-])(code|otp|pin)$|secret|token|password|passphrase|credential|ciphertext|key$/i;

const describe = (queue: string, position: number, msg: GetMessage | ConsumeMessage, fieldNames: string[]): DeadLetterInfo => {
  const h = msg.properties.headers ?? {};
  const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const fields: DeadLetterInfo['fields'] = {};
  if (fieldNames.length > 0) {
    try {
      const body = JSON.parse(msg.content.toString('utf8')) as Record<string, unknown>;
      for (const name of fieldNames) {
        const v = body?.[name];
        if (v !== undefined && SECRET_FIELD_NAME.test(name)) fields[name] = 'redacted';
        else if (typeof v === 'string') fields[name] = v.slice(0, 128);
        else if (typeof v === 'number' || typeof v === 'boolean' || v === null) fields[name] = v;
      }
    } catch {
      // an unparseable body simply has no fields to show
    }
  }
  return {
    position,
    eventId: str(msg.properties.messageId),
    eventName: str(msg.properties.type),
    correlationId: str(h.correlationId),
    failure: str(h[HEADER.failure]),
    failureReason: str(h[HEADER.failureReason]),
    failureError: str(h[HEADER.failureError]),
    retryCount: counter(h[HEADER.retryCount]),
    replayCount: counter(h[HEADER.replayCount]),
    failedAt: str(h[HEADER.failedAt]),
    bodyRedacted: h[HEADER.bodyRedacted] !== undefined,
    fields,
  };
};

/** A channel whose 404s (queue not declared yet) reject the call AND emit 'error': without a listener that would crash the process. */
async function quietChannel(conn: ChannelModel): Promise<Channel> {
  const ch = await conn.createChannel();
  ch.on('error', () => undefined);
  return ch;
}

async function depthOf(conn: ChannelModel, queue: string): Promise<number | null> {
  const ch = await quietChannel(conn);
  try {
    return (await ch.checkQueue(queue)).messageCount;
  } catch {
    return null;
  } finally {
    await ch.close().catch(() => undefined);
  }
}

export function requireDeadQueue(queue: string): string {
  if (!queue.endsWith('.dead') || queue.length <= '.dead'.length) throw new Error('--queue must be a dead-letter queue name (<consumer queue>.dead)');
  return queue.slice(0, -'.dead'.length);
}

/**
 * Lists up to `limit` messages of a dead-letter queue, oldest first, WITHOUT consuming them: they are fetched unacknowledged and handed
 * straight back (`nack` with requeue) so the queue is left as it was (the broker marks them `redelivered`, nothing else changes).
 */
export async function inspectDeadLetters(conn: ChannelModel, queue: string, opts: { limit?: number; fields?: string[] } = {}): Promise<Inspection> {
  requireDeadQueue(queue);
  const depth = await depthOf(conn, queue);
  if (depth === null) return { queue, depth: null, messages: [] };
  const ch = await quietChannel(conn);
  const messages: DeadLetterInfo[] = [];
  try {
    const limit = Math.min(opts.limit ?? 50, depth);
    for (let i = 0; i < limit; i++) {
      const msg = await ch.get(queue, { noAck: false });
      if (!msg) break;
      messages.push(describe(queue, i + 1, msg, opts.fields ?? []));
    }
    ch.nackAll(true);
  } finally {
    await ch.close().catch(() => undefined); // anything still unacknowledged goes back to the queue
  }
  return { queue, depth, messages };
}

/**
 * Replays ONE dead-lettered message: finds the first message whose id is `eventId`, republishes it to the consumer's work queue (confirmed by
 * the broker), and only then removes it from the DLQ. If the republish fails the message stays in the DLQ. Then watches, for at most
 * `waitMs`, what became of it.
 */
export async function replayDeadLetter(conn: ChannelModel, queue: string, eventId: string, opts: { waitMs?: number; pollMs?: number } = {}): Promise<ReplayResult> {
  const target = requireDeadQueue(queue);
  const depth = await depthOf(conn, queue);
  const base = { queue, target, eventId };
  if (!depth) return { ...base, outcome: 'not_found', replayCount: 0 };

  const ch = await quietChannel(conn);
  const out = await conn.createConfirmChannel();
  out.on('error', () => undefined);
  let replayCount = 0;
  try {
    let found: GetMessage | undefined;
    for (let i = 0; i < depth; i++) {
      const msg = await ch.get(queue, { noAck: false });
      if (!msg) break;
      if (msg.properties.messageId === eventId) {
        found = msg;
        break;
      }
    }
    if (!found) {
      ch.nackAll(true);
      return { ...base, outcome: 'not_found', replayCount: 0 };
    }
    if (found.properties.headers?.[HEADER.bodyRedacted] !== undefined) {
      ch.nackAll(true);
      return { ...base, outcome: 'not_replayable', replayCount: counter(found.properties.headers?.[HEADER.replayCount]) };
    }
    const h = withoutBrokerHistory(found.properties.headers);
    for (const k of [HEADER.failure, HEADER.failureReason, HEADER.failureError, HEADER.failedAt, HEADER.consumer]) delete h[k];
    replayCount = counter(h[HEADER.replayCount]) + 1;
    h[HEADER.replayCount] = replayCount;
    h[HEADER.replayedAt] = new Date().toISOString();
    h[HEADER.retryCount] = 0; // a replay gets a fresh retry budget
    let returned = false;
    out.on('return', () => (returned = true));
    out.sendToQueue(target, found.content, {
      persistent: true,
      mandatory: true,
      contentType: found.properties.contentType,
      messageId: found.properties.messageId,
      type: found.properties.type,
      timestamp: found.properties.timestamp,
      headers: h,
    });
    await out.waitForConfirms();
    if (returned) throw new Error(`the work queue ${target} does not exist: nothing was replayed`);
    ch.ack(found); // only now does the DLQ give the message up
    ch.nackAll(true); // everything scanned past goes back
  } finally {
    await out.close().catch(() => undefined);
    await ch.close().catch(() => undefined);
  }

  // What became of it? Bounded and read-only: peek the DLQ and read queue depths.
  const deadline = Date.now() + (opts.waitMs ?? 10_000);
  const poll = opts.pollMs ?? 300;
  let idleSince: number | undefined;
  for (;;) {
    const again = await inspectDeadLetters(conn, queue, { limit: 200 });
    if (again.messages.some((m) => m.eventId === eventId && m.replayCount >= replayCount && m.failedAt !== null)) return { ...base, outcome: 'rejected_again', replayCount };
    const work = await depthOf(conn, target);
    const retry = await depthOf(conn, retryQueueName(target));
    if (!work && !retry) {
      // gone from both queues: give it one more poll (an in-flight rejection lands in the DLQ a moment after) before calling it consumed
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 1000) return { ...base, outcome: 'consumed', replayCount };
    } else {
      idleSince = undefined;
    }
    if (Date.now() >= deadline) return { ...base, outcome: 'pending', replayCount };
    await new Promise((r) => setTimeout(r, poll));
  }
}


/**
 * One operator-facing token. Header values are written by whoever published the message, so what reaches a terminal is reduced to
 * printable ASCII without spaces (no control or escape sequences, no line breaks that could forge another `dlq_message` line) and cut short.
 */
export const outputToken = (v: string | number | boolean | null | undefined): string => (v === null || v === undefined ? '-' : String(v).replace(/[^\x21-\x7e]/g, '_').slice(0, 128));

export function formatDeadLetter(m: DeadLetterInfo): string {
  const fields = Object.entries(m.fields).map(([k, v]) => ` ${outputToken(k)}=${outputToken(v)}`).join('');
  return `dlq_message position=${m.position} event=${outputToken(m.eventId)} name=${outputToken(m.eventName)} correlationId=${outputToken(m.correlationId)} classification=${outputToken(m.failure)} reason=${outputToken(m.failureReason)} error=${outputToken(m.failureError)} retries=${m.retryCount} replays=${m.replayCount} failedAt=${outputToken(m.failedAt)}${m.bodyRedacted ? ' body=redacted' : ''}${fields}`;
}

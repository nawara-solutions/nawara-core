import amqp, { type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { ERROR_NAME, HEADER, REASON_CODE, counter, deadQueueName, retryQueueName, safeToken, withoutBrokerHistory, type FailureClass } from './dead-letter.js';
import { EVENT_NAME, PermanentEventFailure, type DeadLetterDecision, type EventBus, type EventEnvelope, type EventSubscription } from './types.js';

export interface RabbitMqOptions {
  url: string;
  /** Shared topic exchange, as in ADR-0018. */
  exchange?: string;
  connectTimeoutMs?: number;
  /** Backoff between attempts to re-establish a consumer whose connection or channel was lost. Bounded; defaults 500 ms to 30 s. */
  consumerReconnect?: { baseDelayMs?: number; maxDelayMs?: number };
  /**
   * Automatic retry of a handler that rejected with a possibly-transient error: up to `maxRetries` further attempts (default 3), each
   * after `delayMs` (default 5000) in the durable `<queue>.retry` delay queue, then the message is dead-lettered. `maxRetries: 0`
   * dead-letters on the first failure. A `PermanentEventFailure` is never retried.
   */
  retry?: { maxRetries?: number; delayMs?: number };
  /**
   * Stage 15.8: unacknowledged deliveries per consumer channel (default 5, 1 to 100). Every delivery is handled concurrently and a handler
   * usually holds one database client, so the prefetch is also how many pool clients the consumer can take at once: with prefetch equal to
   * the pool (10 / 10) a backlog took the whole pool and HTTP requests queued behind it (Billing read p50 5.9 → 37.6 ms) for no faster
   * drain. Keep it at most half the service's `DB_POOL_MAX`.
   */
  prefetch?: number;
  /**
   * Operational notices, each a complete `event_name key=value` line (consumer lost / recovered, retry / dead-letter, confirm and drain
   * timeouts, settle failed), with the level it deserves: `info` for a recovery, `error` for a terminal dead-letter, `warn` otherwise.
   * Never carries a URL, credential or payload.
   */
  onNotice?: (message: string, level: NoticeLevel) => void;
  /**
   * Bound on waiting for the broker's publisher confirm (default 5000 ms), for publishes and for retry/dead-letter copies. Past it
   * the publish FAILS and the confirm channel is discarded. A timeout means "not confirmed", not "not sent": the caller (the outbox
   * relay) keeps the event pending and publishes it again, so a duplicate is possible and consumers deduplicate (at least once).
   */
  confirmTimeoutMs?: number;
  /** Bound on waiting, when a consumer is closed, for deliveries its handler is still processing (default 5000 ms). */
  drainTimeoutMs?: number;
  /**
   * Stage 15.3 (I9): the AMQP heartbeat THIS client requests, in seconds (default 10). The negotiated value is the smaller of this and the
   * broker's proposal, or this one when the broker proposes 0 (heartbeats off), so the bound no longer depends on broker configuration.
   * amqplib tears the connection down after two missed intervals (observed ~3 x heartbeat), rejecting every channel operation still
   * waiting on a silent broker (channel open, declare, consume, cancel). `0` disables it: a test-only negative control; configuration
   * (`RABBITMQ_HEARTBEAT_S`) refuses it.
   */
  heartbeatS?: number;
}

/** Stage 15.3: the kit's requested heartbeat and the range configuration accepts (RabbitMQ: 5-20 s is optimal; under 5 s false positives). */
export const DEFAULT_RABBITMQ_HEARTBEAT_S = 10;
export const RABBITMQ_HEARTBEAT_BOUNDS = { min: 5, max: 60 } as const;
/** Stage 15.8: see `RabbitMqOptions.prefetch`. Half the default database pool (10). */
export const DEFAULT_PREFETCH = 5;

/** amqplib 2.0.1 never settles a channel or connection close that is waiting for its close-ok when the connection dies (Stage 15.3). */
const abandonAfter = (p: Promise<unknown>, ms: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.then(() => undefined, () => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/** Like `abandonAfter`, but says whether `p` settled (true) or the bound was reached first (false). */
const settledWithin = (p: Promise<unknown>, ms: number): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.then(() => true, () => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * Stage 15.5 (F-H): destroys the TCP/TLS socket under an amqplib connection that Core has given up on. amqplib 2.0.1 ends every
 * connection (close-ok received, heartbeat timeout, socket error) with `stream.end()`: a half-close that keeps the socket open until the
 * PEER closes too. A silent broker never does, so the socket stays in FIN_WAIT2 as a live handle and keeps Node's event loop alive: as
 * PID 1 in a container (which ignores the signal Nest re-raises after its shutdown) the process never exits. amqplib exposes no public
 * way to destroy the transport; `ChannelModel.connection.stream` is the socket itself (connect.js passes the net/tls socket, a Duplex,
 * to `new Connection`). This is the ONE place that relies on that shape, guarded so another amqplib version degrades to a no-op
 * (and `rabbitmq-transport-disposal.int-spec` fails) instead of throwing.
 */
export function destroyTransport(connection: ChannelModel): boolean {
  const stream = (connection as unknown as { connection?: { stream?: { destroy?: () => void; destroyed?: boolean } } }).connection?.stream;
  if (!stream || typeof stream.destroy !== 'function') return false;
  if (!stream.destroyed) stream.destroy();
  return true;
}

/** Thrown when the broker does not confirm a publish in time. The message may or may not have been stored by the broker. */
export class PublisherConfirmTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`publisher confirm not received within ${timeoutMs} ms`);
    this.name = 'PublisherConfirmTimeoutError';
  }
}

export type NoticeLevel = 'info' | 'warn' | 'error';

// Message ids reach a log line: anything that is not a short, predictable token (a malformed or foreign message) is not echoed.
const MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const messageIdOf = (id: unknown): string => safeToken(id, MESSAGE_ID, '-');

/** Waits `ms`, or less if `signal` aborts first (already aborted: returns at once). Never rejects. */
function holdUnless(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

interface DeadLetterCopy {
  content: Buffer;
  contentType: string | undefined;
  messageId: string | undefined;
  type: string | undefined;
  headers: Record<string, unknown>;
  redacted: boolean;
}

/**
 * Stage 18.8: the dead-letter copy a subscription's `deadLetterPolicy` allows. Only the headers it returns (string / finite number values)
 * survive; a redacted body is a kit document carrying nothing of the original but its size; a policy that throws redacts (fail closed).
 */
function deadLetterCopy(sub: EventSubscription, msg: ConsumeMessage, event: EventEnvelope | undefined, failure: FailureClass, reason: string | undefined): DeadLetterCopy {
  let decision: DeadLetterDecision;
  try {
    decision = sub.deadLetterPolicy!({ event, failure, ...(reason ? { reason } : {}) });
  } catch {
    decision = { body: 'redacted', headers: {} };
  }
  const headers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(decision.headers ?? {})) {
    if (typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) headers[k] = v;
  }
  // The kit's own replay bookkeeping always survives (validated), so `nawara-dlq replay` still recognizes a copy rejected again.
  const original = msg.properties.headers ?? {};
  const replays = counter(original[HEADER.replayCount]);
  if (replays > 0) headers[HEADER.replayCount] = replays;
  const replayedAt = original[HEADER.replayedAt];
  if (typeof replayedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(replayedAt)) headers[HEADER.replayedAt] = replayedAt;
  const safeId = typeof msg.properties.messageId === 'string' && MESSAGE_ID.test(msg.properties.messageId) ? msg.properties.messageId : undefined;
  const safeType = typeof msg.properties.type === 'string' && EVENT_NAME.test(msg.properties.type) ? msg.properties.type : undefined;
  if (decision.body === 'original') {
    return { content: msg.content, contentType: msg.properties.contentType, messageId: msg.properties.messageId, type: msg.properties.type, headers, redacted: false };
  }
  const document = { redacted: true, failure, ...(reason ? { reason } : {}), bodyBytes: msg.content.length };
  return { content: Buffer.from(JSON.stringify(document)), contentType: 'application/json', messageId: safeId, type: safeType, headers, redacted: true };
}

export type ConsumerState = 'consuming' | 'reconnecting' | 'closed';
export interface ConsumerStatus {
  queue: string;
  state: ConsumerState;
}

/** One consumer subscription and the state needed to re-establish it. */
interface ConsumerHandle {
  sub: EventSubscription;
  state: ConsumerState;
  channel?: Channel;
  consumerTag?: string;
  timer?: NodeJS.Timeout;
  attempts: number;
  closed: boolean;
  /** Deliveries whose handler (and settlement) is still running: awaited, bounded, before the channel is closed. */
  inFlight: Set<Promise<void>>;
  /** Stage 18.9: aborted when the consumer stops, so a delivery held before a requeue (below) settles at once instead of waiting. */
  stopping: AbortController;
}

/**
 * RabbitMQ implementation of the EventBus port: one durable topic exchange, persistent messages with publisher confirms,
 * durable consumer queues with a dead-letter queue. Connections are opened lazily and re-opened after a failure, so a
 * broker outage surfaces only as a failed publish that the outbox relay retries.
 *
 * A consumer is SUPERVISED: when its channel or connection is lost, or the broker cancels the consumer, it is re-created
 * (channel, topology, prefetch, consume) with bounded exponential backoff until `close()`. The FIRST `subscribe()` still
 * fails fast, so a service that cannot reach the broker at start does not pretend to be consuming. Redelivery after a
 * recovery is expected (at least once): consumers deduplicate.
 *
 * A handler that rejects is retried a bounded number of times through `<queue>.retry` (a durable delay queue that expires back into
 * `<queue>`), then dead-lettered to `<queue>.dead` with annotations (failure class, retry count, time); a permanent failure skips the
 * retries. The message is republished with its original id, type and headers (so the event and correlation ids never change) and
 * acknowledged only after the broker has confirmed the copy.
 */
export class RabbitMqEventBus implements EventBus {
  private readonly exchange: string;
  private readonly prefetch: number;
  private connection?: ChannelModel;
  private publisher?: ConfirmChannel;
  private readonly consumers = new Set<ConsumerHandle>();
  private readonly url: string;
  /**
   * How long a close/cancel may wait before it is abandoned: the heartbeat's worst-case detection (3 intervals). By then a silent
   * connection has been torn down, and a close still pending will never settle. Abandoning is safe: the transport is closed or dead and
   * is never reused (a new connection is opened on demand).
   */
  private readonly closeBoundMs: number;
  /** Settles when the current connection closes, however it closes (Stage 15.5): a close/cancel waiting on a dead connection stops there. */
  private connectionClosed?: Promise<void>;
  /** `p`, or the moment the current connection is gone (amqplib never settles a channel operation that waited on a connection that died). */
  private untilConnectionGone(p: Promise<unknown>): Promise<unknown> {
    return this.connectionClosed ? Promise.race([p, this.connectionClosed]) : p;
  }

  constructor(private readonly opts: RabbitMqOptions) {
    this.exchange = opts.exchange ?? 'nawara.events';
    this.prefetch = opts.prefetch ?? DEFAULT_PREFETCH;
    if (!Number.isInteger(this.prefetch) || this.prefetch < 1 || this.prefetch > 100) throw new Error('RabbitMqEventBus prefetch must be an integer between 1 and 100');
    const heartbeatS = opts.heartbeatS ?? DEFAULT_RABBITMQ_HEARTBEAT_S;
    const url = new URL(opts.url);
    url.searchParams.set('heartbeat', String(heartbeatS)); // amqplib reads the client's requested heartbeat from the URL
    this.url = url.toString();
    this.closeBoundMs = 3 * (heartbeatS || DEFAULT_RABBITMQ_HEARTBEAT_S) * 1000;
  }

  private async connect(): Promise<ChannelModel> {
    if (this.connection) return this.connection;
    const conn = await amqp.connect(this.url, { timeout: this.opts.connectTimeoutMs ?? 5000 });
    const reset = () => {
      if (this.connection === conn) {
        this.connection = undefined;
        this.publisher = undefined;
      }
    };
    conn.on('error', reset);
    this.connectionClosed = new Promise<void>((resolve) => conn.once('close', () => resolve()));
    conn.on('close', (err?: unknown) => {
      reset();
      // Stage 15.5 (F-H): closed by an error (heartbeat timeout, socket error, a close forced by the broker): the connection is dead and
      // is never reused, and amqplib only half-closed its socket. Destroy the transport so a silent peer cannot keep it (and the process)
      // alive. A clean close (close-ok from a healthy broker) is left to amqplib's graceful FIN.
      if (err) destroyTransport(conn);
    });
    this.connection = conn;
    return conn;
  }

  private async publishChannel(): Promise<ConfirmChannel> {
    if (this.publisher) return this.publisher;
    const ch = await (await this.connect()).createConfirmChannel();
    await ch.assertExchange(this.exchange, 'topic', { durable: true });
    const reset = () => {
      if (this.publisher === ch) this.publisher = undefined;
    };
    ch.on('error', reset);
    ch.on('close', reset);
    this.publisher = ch;
    return ch;
  }

  async publish(event: EventEnvelope): Promise<void> {
    try {
      const ch = await this.publishChannel();
      ch.publish(this.exchange, event.name, Buffer.from(JSON.stringify(event.payload)), {
        persistent: true,
        contentType: 'application/json',
        messageId: event.id,
        type: event.name,
        timestamp: Math.floor(new Date(event.headers.occurredAt).getTime() / 1000),
        headers: { ...event.headers },
      });
      await this.confirmed(ch, `eventId=${messageIdOf(event.id)} name=${event.name}`);
    } catch (e) {
      this.publisher = undefined;
      throw e;
    }
  }

  /**
   * Waits for the broker's confirms, bounded. On timeout the channel is discarded so a late confirm can never be misattributed.
   * `subject` identifies the message in the timeout notice (Stage 14.7).
   */
  private async confirmed(ch: ConfirmChannel, subject: string): Promise<void> {
    const timeoutMs = this.opts.confirmTimeoutMs ?? 5000;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ch.waitForConfirms(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new PublisherConfirmTimeoutError(timeoutMs)), timeoutMs);
        }),
      ]);
    } catch (e) {
      if (e instanceof PublisherConfirmTimeoutError) {
        if (this.publisher === ch) this.publisher = undefined;
        // Unconfirmed is NOT undelivered: the broker may have stored it. The caller does not treat it as sent (at least once).
        this.notice(`rabbitmq_confirm_timeout ${subject} timeoutMs=${timeoutMs} outcome=unconfirmed — delivery state unknown (the broker may have stored it); not treated as sent, so it is sent again (at least once)`);
        void ch.close().catch(() => undefined);
      }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Per-consumer state, for readiness: `consuming` only while the consumer is actually attached to its queue. */
  consumerStatus(): ConsumerStatus[] {
    return [...this.consumers].map((h) => ({ queue: h.sub.queue, state: h.state }));
  }

  async subscribe(sub: EventSubscription) {
    const handle: ConsumerHandle = { sub, state: 'reconnecting', attempts: 0, closed: false, inFlight: new Set(), stopping: new AbortController() };
    this.consumers.add(handle);
    try {
      await this.attach(handle);
    } catch (e) {
      this.consumers.delete(handle);
      throw e;
    }
    return { close: () => this.stopConsumer(handle) };
  }

  /** Opens a channel, declares the topology and starts consuming. Throws (after releasing the channel) if any step fails. */
  private async attach(h: ConsumerHandle): Promise<void> {
    const sub = h.sub;
    const ch = await (await this.connect()).createChannel();
    try {
      // Loss detection is wired BEFORE anything else so no failure can fall between two steps. `error` is always followed by `close`.
      ch.on('error', () => this.notice(`rabbitmq_channel_error queue=${sub.queue}`));
      ch.on('close', () => this.consumerLost(h, ch));
      const dlx = `${this.exchange}.dlx`;
      await ch.assertExchange(this.exchange, 'topic', { durable: true });
      await ch.assertExchange(dlx, 'fanout', { durable: true });
      await ch.assertQueue(deadQueueName(sub.queue), { durable: true });
      await ch.bindQueue(deadQueueName(sub.queue), dlx, '');
      await ch.assertQueue(sub.queue, { durable: true, arguments: { 'x-dead-letter-exchange': dlx } }); // arguments unchanged: redeclaring an existing queue with different ones fails
      // Delay queue: nothing consumes it; a message's own `expiration` dead-letters it through the default exchange back into the work queue.
      await ch.assertQueue(retryQueueName(sub.queue), { durable: true, arguments: { 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': sub.queue } });
      for (const b of sub.bindings) await ch.bindQueue(sub.queue, this.exchange, b);
      await ch.prefetch(this.prefetch);
      const { consumerTag } = await ch.consume(sub.queue, (msg) => {
        // A null message is the BROKER cancelling this consumer (queue deleted, node failover): the channel is still open but
        // nothing will ever be delivered on it, so treat it as a loss and rebuild.
        if (!msg) {
          this.consumerLost(h, ch);
          return;
        }
        const delivery: Promise<void> = this.deliver(ch, msg, sub, h.stopping.signal).finally(() => h.inFlight.delete(delivery));
        h.inFlight.add(delivery);
      });
      if (h.closed) throw new Error('consumer closed while attaching');
      h.channel = ch;
      h.consumerTag = consumerTag;
      h.state = 'consuming';
      h.attempts = 0;
    } catch (e) {
      await abandonAfter(ch.close(), this.closeBoundMs); // bounded: the re-attach loop must never hang on a dead connection
      throw e;
    }
  }

  private consumerLost(h: ConsumerHandle, ch: Channel): void {
    if (h.closed || h.channel !== ch) return; // deliberate close, or a stale channel that was already replaced
    h.channel = undefined;
    h.consumerTag = undefined;
    h.state = 'reconnecting';
    this.notice(`rabbitmq_consumer_lost queue=${h.sub.queue}`);
    void ch.close().catch(() => undefined); // free a channel that is open but no longer consuming
    this.scheduleReconnect(h);
  }

  private scheduleReconnect(h: ConsumerHandle): void {
    if (h.closed || h.timer) return;
    const base = this.opts.consumerReconnect?.baseDelayMs ?? 500;
    const max = this.opts.consumerReconnect?.maxDelayMs ?? 30_000;
    const ceiling = Math.min(max, base * 2 ** Math.min(h.attempts, 20));
    const delay = Math.round(ceiling / 2 + (Math.random() * ceiling) / 2); // jitter: instances do not reconnect in lockstep
    h.timer = setTimeout(() => {
      h.timer = undefined;
      if (h.closed) return;
      this.attach(h).then(
        () => this.notice(`rabbitmq_consumer_recovered queue=${h.sub.queue}`, 'info'),
        () => {
          h.attempts += 1;
          this.notice(`rabbitmq_consumer_reconnect_failed queue=${h.sub.queue} attempt=${h.attempts}`);
          this.scheduleReconnect(h);
        },
      );
    }, delay);
  }

  private async stopConsumer(h: ConsumerHandle): Promise<void> {
    h.closed = true;
    h.stopping.abort();
    h.state = 'closed';
    if (h.timer) clearTimeout(h.timer);
    h.timer = undefined;
    this.consumers.delete(h);
    const ch = h.channel;
    h.channel = undefined;
    if (ch) {
      // 1. No new deliveries. 2. Let the ones already being handled finish and settle (bounded). 3. Close the channel.
      if (h.consumerTag) await abandonAfter(this.untilConnectionGone(ch.cancel(h.consumerTag)), this.closeBoundMs);
      if (h.inFlight.size > 0) {
        const drainMs = this.opts.drainTimeoutMs ?? 5000;
        let timer: NodeJS.Timeout | undefined;
        const outcome = await Promise.race([
          Promise.allSettled([...h.inFlight]).then(() => 'drained' as const),
          new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), drainMs);
          }),
        ]);
        if (timer) clearTimeout(timer);
        // Unsettled deliveries are redelivered by the broker once the channel closes (at least once; consumers deduplicate).
        if (outcome === 'timeout') this.notice(`rabbitmq_consumer_drain_timeout queue=${h.sub.queue} inFlight=${h.inFlight.size}`);
      }
      await abandonAfter(this.untilConnectionGone(ch.close()), this.closeBoundMs);
    }
  }

  private notice(message: string, level: NoticeLevel = 'warn'): void {
    this.opts.onNotice?.(message, level);
  }

  private async deliver(ch: Channel, msg: ConsumeMessage, sub: EventSubscription, stopping?: AbortSignal): Promise<void> {
    const h = msg.properties.headers ?? {};
    const retryCount = counter(h[HEADER.retryCount]);
    let event: EventEnvelope | undefined;
    try {
      const id = msg.properties.messageId;
      const name = msg.properties.type;
      if (typeof id !== 'string' || typeof name !== 'string' || !EVENT_NAME.test(name)) throw new PermanentEventFailure('malformed_envelope');
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(msg.content.toString('utf8'));
      } catch {
        throw new PermanentEventFailure('malformed_envelope');
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new PermanentEventFailure('malformed_envelope');
      const replayCount = counter(h[HEADER.replayCount]);
      event = {
        id,
        name,
        payload,
        headers: {
          eventId: id,
          occurredAt: String(h.occurredAt ?? ''),
          correlationId: typeof h.correlationId === 'string' ? h.correlationId : undefined,
          source: String(h.source ?? ''),
          version: Number(h.version ?? 1),
          ...(retryCount > 0 ? { retryCount } : {}),
          ...(replayCount > 0 ? { replayCount } : {}),
        },
      };
      await sub.handler(event);
    } catch (e) {
      await this.onFailure(ch, msg, sub, event, e, retryCount, stopping);
      return;
    }
    this.settle(() => ch.ack(msg), sub);
  }

  /** A failed delivery ends in exactly one of: a confirmed copy in `<queue>.retry`, or a confirmed copy in `<queue>.dead`, then an ack. */
  private async onFailure(ch: Channel, msg: ConsumeMessage, sub: EventSubscription, event: EventEnvelope | undefined, error: unknown, retryCount: number, stopping?: AbortSignal): Promise<void> {
    const maxRetries = this.opts.retry?.maxRetries ?? 3;
    const delayMs = this.opts.retry?.delayMs ?? 5000;
    const permanent = error instanceof PermanentEventFailure;
    const errorName = safeToken(error instanceof Error ? error.name : undefined, ERROR_NAME, 'Error');
    const who = `queue=${sub.queue} event=${messageIdOf(msg.properties.messageId)} correlationId=${messageIdOf(event?.headers.correlationId)}`;

    if (!permanent && retryCount < maxRetries) {
      try {
        await this.republish(retryQueueName(sub.queue), msg, { [HEADER.retryCount]: retryCount + 1 }, String(delayMs));
        this.notice(`event_retry_scheduled ${who} attempt=${retryCount + 1}/${maxRetries} delayMs=${delayMs} error=${errorName}`);
        this.settle(() => ch.ack(msg), sub);
        return;
      } catch {
        // could not schedule the retry (broker trouble): fall through, the message is dead-lettered rather than lost or looped on
      }
    }

    const failure: FailureClass = event === undefined ? 'malformed' : permanent ? 'permanent' : 'retries_exhausted';
    if (failure === 'retries_exhausted') this.notice(`event_retry_exhausted ${who} retries=${retryCount} error=${errorName}`);
    const reason = permanent ? safeToken((error as PermanentEventFailure).reason, REASON_CODE, 'unspecified') : undefined;
    const outcome = `${who} classification=${failure}${reason ? ` reason=${reason}` : ''} retries=${retryCount} error=${errorName}`;
    const copy = sub.deadLetterPolicy ? deadLetterCopy(sub, msg, event, failure, reason) : undefined;
    try {
      await this.ensureDeadQueue(ch, sub);
      await this.republish(deadQueueName(sub.queue), msg, {
        [HEADER.failure]: failure,
        ...(reason ? { [HEADER.failureReason]: reason } : {}),
        [HEADER.failureError]: errorName,
        [HEADER.failedAt]: new Date().toISOString(),
        [HEADER.consumer]: sub.queue,
        [HEADER.retryCount]: retryCount,
        ...(copy?.redacted ? { [HEADER.bodyRedacted]: 'true' } : {}),
      }, undefined, copy);
      this.notice(`event_dead_lettered ${outcome}${copy?.redacted ? ' body=redacted' : ''}`, 'error');
      this.settle(() => ch.ack(msg), sub);
    } catch {
      if (copy) {
        // Stage 18.8: a consumer with a dead-letter policy never lets the broker dead-letter the untouched original: requeued instead
        // (redelivered, re-handled idempotently, dead-lettered through the policy once the broker confirms again).
        // Stage 18.9: RabbitMQ redelivers a requeued message at once, so while the copy keeps failing an immediate requeue is a tight
        // loop. The delivery is HELD (unacknowledged, occupying one prefetch slot) for the retry delay first: at most `prefetch`
        // deferrals per delay, whatever the fault lasts. A stopping consumer ends the hold at once (shutdown stays bounded; the
        // unacknowledged message is redelivered to the next instance either way).
        this.notice(`event_dead_letter_deferred ${outcome} delayMs=${delayMs} — the copy could not be confirmed; requeued after the delay`, 'error');
        await holdUnless(delayMs, stopping);
        this.settle(() => ch.nack(msg, false, true), sub);
        return;
      }
      // the annotated copy could not be confirmed: the broker's own dead-lettering (the queue was just re-declared and bound) still moves the original, unannotated
      this.notice(`event_dead_lettered ${outcome} annotated=false`, 'error');
      this.settle(() => ch.nack(msg, false, false), sub);
    }
  }

  /**
   * The dead-letter queue and its binding are declared when the consumer attaches, but an operator can delete the queue while the consumer runs.
   * A message dead-lettered into a missing queue is dropped by the broker, so the queue is re-declared (idempotent) before every dead-lettering.
   */
  private async ensureDeadQueue(ch: Channel, sub: EventSubscription): Promise<void> {
    try {
      await ch.assertQueue(deadQueueName(sub.queue), { durable: true });
      await ch.bindQueue(deadQueueName(sub.queue), `${this.exchange}.dlx`, '');
    } catch {
      // a closed channel or a broker fault: the republish that follows reports it and the caller falls back
    }
  }

  /**
   * Publishes a copy of `msg` straight to a queue (default exchange) on the confirm channel and resolves once the broker has accepted it.
   * Same body, message id, type, timestamp and headers, plus `annotations`; `mandatory` so a missing queue is an error, not a silent drop.
   */
  private async republish(queue: string, msg: ConsumeMessage, annotations: Record<string, unknown>, expiration?: string, copy?: DeadLetterCopy): Promise<void> {
    const ch = await this.publishChannel();
    let returned = false;
    const onReturn = (m: { properties: { messageId?: unknown } }) => {
      if (m.properties.messageId === msg.properties.messageId) returned = true;
    };
    ch.on('return', onReturn);
    try {
      ch.sendToQueue(queue, copy ? copy.content : msg.content, {
        persistent: true,
        mandatory: true,
        contentType: copy ? copy.contentType : msg.properties.contentType,
        messageId: copy ? copy.messageId : msg.properties.messageId,
        type: copy ? copy.type : msg.properties.type,
        timestamp: msg.properties.timestamp,
        headers: { ...(copy ? copy.headers : withoutBrokerHistory(msg.properties.headers)), ...annotations },
        ...(expiration ? { expiration } : {}),
      });
      await this.confirmed(ch, `eventId=${messageIdOf(msg.properties.messageId)} target=${queue}`); // bounded; a basic.return, if any, arrives before the confirm
    } catch (e) {
      this.publisher = undefined;
      throw e;
    } finally {
      ch.off('return', onReturn);
    }
    if (returned) throw new Error('unroutable');
  }

  /**
   * Acknowledging on a channel that closed while the handler ran throws. That is not a failure of the event: an unacknowledged
   * message is redelivered by the broker after the consumer is re-established, and consumers deduplicate.
   */
  private settle(fn: () => void, sub: EventSubscription): void {
    try {
      fn();
    } catch {
      this.notice(`rabbitmq_settle_failed queue=${sub.queue} — the broker will redeliver`);
    }
  }

  async close(): Promise<void> {
    for (const h of this.consumers) await this.stopConsumer(h); // safe: stopConsumer removes only the element being visited
    const conn = this.connection;
    const publisher = this.publisher;
    this.publisher = undefined;
    this.connection = undefined;
    // One deadline for the publisher channel AND the connection (Stage 15.5): a broker that ignored the channel close will ignore the
    // connection close too, so it must not get a second full bound.
    const deadline = Date.now() + this.closeBoundMs;
    const connClosed = this.connectionClosed;
    if (publisher) await abandonAfter(connClosed ? Promise.race([publisher.close(), connClosed]) : publisher.close(), this.closeBoundMs);
    if (conn) {
      // Ends as soon as the connection closes, whichever way (close-ok, or the broker vanishing: amqplib then never settles `close()`).
      const closed = connClosed ?? new Promise<void>((resolve) => conn.once('close', () => resolve()));
      if (!(await settledWithin(Promise.race([conn.close(), closed]), Math.max(0, deadline - Date.now())))) {
        // Stage 15.5 (F-H): the bounded close gave up: the connection is abandoned, so its transport must not outlive it.
        destroyTransport(conn);
        this.notice(`rabbitmq_connection_abandoned closeBoundMs=${this.closeBoundMs} — the broker did not answer the close; transport destroyed`);
      }
    }
  }
}

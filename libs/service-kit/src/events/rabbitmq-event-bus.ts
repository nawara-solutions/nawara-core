import amqp, { type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { ERROR_NAME, HEADER, REASON_CODE, counter, deadQueueName, retryQueueName, safeToken, withoutBrokerHistory, type FailureClass } from './dead-letter.js';
import { EVENT_NAME, PermanentEventFailure, type EventBus, type EventEnvelope, type EventSubscription } from './types.js';

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
  /** Operational notices (consumer lost / recovered, retry / dead-letter, settle failed). Never carries a URL, credential or payload. */
  onNotice?: (message: string) => void;
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
  private connection?: ChannelModel;
  private publisher?: ConfirmChannel;
  private readonly consumers = new Set<ConsumerHandle>();

  constructor(private readonly opts: RabbitMqOptions) {
    this.exchange = opts.exchange ?? 'nawara.events';
  }

  private async connect(): Promise<ChannelModel> {
    if (this.connection) return this.connection;
    const conn = await amqp.connect(this.opts.url, { timeout: this.opts.connectTimeoutMs ?? 5000 });
    const reset = () => {
      if (this.connection === conn) {
        this.connection = undefined;
        this.publisher = undefined;
      }
    };
    conn.on('error', reset);
    conn.on('close', reset);
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
      await ch.waitForConfirms();
    } catch (e) {
      this.publisher = undefined;
      throw e;
    }
  }

  /** Per-consumer state, for readiness: `consuming` only while the consumer is actually attached to its queue. */
  consumerStatus(): ConsumerStatus[] {
    return [...this.consumers].map((h) => ({ queue: h.sub.queue, state: h.state }));
  }

  async subscribe(sub: EventSubscription) {
    const handle: ConsumerHandle = { sub, state: 'reconnecting', attempts: 0, closed: false };
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
      await ch.prefetch(10);
      const { consumerTag } = await ch.consume(sub.queue, (msg) => {
        // A null message is the BROKER cancelling this consumer (queue deleted, node failover): the channel is still open but
        // nothing will ever be delivered on it, so treat it as a loss and rebuild.
        if (!msg) {
          this.consumerLost(h, ch);
          return;
        }
        void this.deliver(ch, msg, sub);
      });
      if (h.closed) throw new Error('consumer closed while attaching');
      h.channel = ch;
      h.consumerTag = consumerTag;
      h.state = 'consuming';
      h.attempts = 0;
    } catch (e) {
      await ch.close().catch(() => undefined);
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
        () => this.notice(`rabbitmq_consumer_recovered queue=${h.sub.queue}`),
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
    h.state = 'closed';
    if (h.timer) clearTimeout(h.timer);
    h.timer = undefined;
    this.consumers.delete(h);
    const ch = h.channel;
    h.channel = undefined;
    if (ch) {
      if (h.consumerTag) await ch.cancel(h.consumerTag).catch(() => undefined);
      await ch.close().catch(() => undefined);
    }
  }

  private notice(message: string): void {
    this.opts.onNotice?.(message);
  }

  private async deliver(ch: Channel, msg: ConsumeMessage, sub: EventSubscription): Promise<void> {
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
      await this.onFailure(ch, msg, sub, event, e, retryCount);
      return;
    }
    this.settle(() => ch.ack(msg), sub);
  }

  /** A failed delivery ends in exactly one of: a confirmed copy in `<queue>.retry`, or a confirmed copy in `<queue>.dead`, then an ack. */
  private async onFailure(ch: Channel, msg: ConsumeMessage, sub: EventSubscription, event: EventEnvelope | undefined, error: unknown, retryCount: number): Promise<void> {
    const maxRetries = this.opts.retry?.maxRetries ?? 3;
    const delayMs = this.opts.retry?.delayMs ?? 5000;
    const permanent = error instanceof PermanentEventFailure;
    const errorName = safeToken(error instanceof Error ? error.name : undefined, ERROR_NAME, 'Error');
    const who = `queue=${sub.queue} event=${msg.properties.messageId ?? '-'} correlationId=${event?.headers.correlationId ?? '-'}`;

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
    try {
      await this.ensureDeadQueue(ch, sub);
      await this.republish(deadQueueName(sub.queue), msg, {
        [HEADER.failure]: failure,
        ...(reason ? { [HEADER.failureReason]: reason } : {}),
        [HEADER.failureError]: errorName,
        [HEADER.failedAt]: new Date().toISOString(),
        [HEADER.consumer]: sub.queue,
        [HEADER.retryCount]: retryCount,
      });
      this.notice(`event_dead_lettered ${outcome}`);
      this.settle(() => ch.ack(msg), sub);
    } catch {
      // the annotated copy could not be confirmed: the broker's own dead-lettering (the queue was just re-declared and bound) still moves the original, unannotated
      this.notice(`event_dead_lettered ${outcome} annotated=false`);
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
  private async republish(queue: string, msg: ConsumeMessage, annotations: Record<string, unknown>, expiration?: string): Promise<void> {
    const ch = await this.publishChannel();
    let returned = false;
    const onReturn = (m: { properties: { messageId?: unknown } }) => {
      if (m.properties.messageId === msg.properties.messageId) returned = true;
    };
    ch.on('return', onReturn);
    try {
      ch.sendToQueue(queue, msg.content, {
        persistent: true,
        mandatory: true,
        contentType: msg.properties.contentType,
        messageId: msg.properties.messageId,
        type: msg.properties.type,
        timestamp: msg.properties.timestamp,
        headers: { ...withoutBrokerHistory(msg.properties.headers), ...annotations },
        ...(expiration ? { expiration } : {}),
      });
      await ch.waitForConfirms(); // a basic.return, if any, arrives before the confirm
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
    await this.publisher?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.publisher = undefined;
    this.connection = undefined;
  }
}

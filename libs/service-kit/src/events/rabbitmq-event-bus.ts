import amqp, { type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { EVENT_NAME, type EventBus, type EventEnvelope, type EventSubscription } from './types.js';

export interface RabbitMqOptions {
  url: string;
  /** Shared topic exchange, as in ADR-0018. */
  exchange?: string;
  connectTimeoutMs?: number;
  /** Backoff between attempts to re-establish a consumer whose connection or channel was lost. Bounded; defaults 500 ms to 30 s. */
  consumerReconnect?: { baseDelayMs?: number; maxDelayMs?: number };
  /** Operational notices (consumer lost / recovered / settle failed). Never carries a URL, credential or payload. */
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
      await ch.assertQueue(`${sub.queue}.dead`, { durable: true });
      await ch.bindQueue(`${sub.queue}.dead`, dlx, '');
      await ch.assertQueue(sub.queue, { durable: true, arguments: { 'x-dead-letter-exchange': dlx } });
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
    try {
      const h = msg.properties.headers ?? {};
      const name = msg.properties.type;
      const id = msg.properties.messageId;
      if (typeof id !== 'string' || typeof name !== 'string' || !EVENT_NAME.test(name)) throw new Error('malformed event');
      const event: EventEnvelope = {
        id,
        name,
        payload: JSON.parse(msg.content.toString('utf8')),
        headers: { eventId: id, occurredAt: String(h.occurredAt ?? ''), correlationId: typeof h.correlationId === 'string' ? h.correlationId : undefined, source: String(h.source ?? ''), version: Number(h.version ?? 1) },
      };
      await sub.handler(event);
    } catch {
      this.settle(() => ch.nack(msg, false, false), sub); // dead-lettered for inspection, never dropped silently, never hot-looped
      return;
    }
    this.settle(() => ch.ack(msg), sub);
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

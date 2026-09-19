import amqp, { type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { EVENT_NAME, type EventBus, type EventEnvelope, type EventSubscription } from './types.js';

export interface RabbitMqOptions {
  url: string;
  /** Shared topic exchange, as in ADR-0018. */
  exchange?: string;
  connectTimeoutMs?: number;
}

/**
 * RabbitMQ implementation of the EventBus port: one durable topic exchange, persistent messages with publisher confirms,
 * durable consumer queues with a dead-letter queue. Connections are opened lazily and re-opened after a failure, so a
 * broker outage surfaces only as a failed publish that the outbox relay retries.
 */
export class RabbitMqEventBus implements EventBus {
  private readonly exchange: string;
  private connection?: ChannelModel;
  private publisher?: ConfirmChannel;
  private readonly consumerChannels = new Set<ConfirmChannel>();

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

  async subscribe(sub: EventSubscription) {
    const ch = await (await this.connect()).createConfirmChannel();
    this.consumerChannels.add(ch);
    const dlx = `${this.exchange}.dlx`;
    await ch.assertExchange(this.exchange, 'topic', { durable: true });
    await ch.assertExchange(dlx, 'fanout', { durable: true });
    await ch.assertQueue(`${sub.queue}.dead`, { durable: true });
    await ch.bindQueue(`${sub.queue}.dead`, dlx, '');
    await ch.assertQueue(sub.queue, { durable: true, arguments: { 'x-dead-letter-exchange': dlx } });
    for (const b of sub.bindings) await ch.bindQueue(sub.queue, this.exchange, b);
    await ch.prefetch(10);
    const { consumerTag } = await ch.consume(sub.queue, (msg) => {
      if (!msg) return;
      void this.deliver(ch, msg, sub);
    });
    return {
      close: async () => {
        await ch.cancel(consumerTag).catch(() => undefined);
        this.consumerChannels.delete(ch);
        await ch.close().catch(() => undefined);
      },
    };
  }

  private async deliver(ch: ConfirmChannel, msg: ConsumeMessage, sub: EventSubscription): Promise<void> {
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
      ch.ack(msg);
    } catch {
      ch.nack(msg, false, false); // dead-lettered for inspection, never dropped silently, never hot-looped
    }
  }

  async close(): Promise<void> {
    for (const ch of this.consumerChannels) await ch.close().catch(() => undefined);
    this.consumerChannels.clear();
    await this.publisher?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
    this.publisher = undefined;
    this.connection = undefined;
  }
}

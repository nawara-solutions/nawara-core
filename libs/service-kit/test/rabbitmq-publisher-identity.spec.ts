import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PublisherIdentityUnavailableError, RabbitMqEventBus, type EventBusObservation, type EventEnvelope } from '../src/index.js';

/**
 * Core V2 S1a (ADR-0057 §13.1), without a broker: where the publisher identity comes from, and what happens when there is none. The
 * broker's own refusal of a forged `user_id` is proven against a real RabbitMQ in rabbitmq-publisher-identity.int-spec.ts.
 */
const envelope = (): EventEnvelope => {
  const id = randomUUID();
  return { id, name: 'payment.succeeded', payload: { paymentId: 'p1' }, headers: { eventId: id, occurredAt: new Date().toISOString(), correlationId: 'corr-abcdef12', source: 'payment-service', version: 1 } };
};
const internals = (bus: RabbitMqEventBus) => bus as unknown as { url: string; publisherUserId?: string };

describe('RabbitMqEventBus publisher identity (S1a)', () => {
  it('takes the identity from the URL user, and keeps the credentials out of the URL it connects with', () => {
    const bus = new RabbitMqEventBus({ url: 'amqp://payment-service:s3cret-value@127.0.0.1:1/core' });
    expect(internals(bus).publisherUserId).toBe('payment-service');
    expect(internals(bus).url).not.toContain('payment-service');
    expect(internals(bus).url).not.toContain('s3cret-value');
    expect(internals(bus).url).toContain('127.0.0.1:1/core');
  });

  it('decodes a percent-encoded user exactly once', () => {
    expect(internals(new RabbitMqEventBus({ url: 'amqp://svc%2Da:pw@127.0.0.1:1' })).publisherUserId).toBe('svc-a');
  });

  it('refuses a malformed percent-encoding without echoing the credentials', () => {
    expect(() => new RabbitMqEventBus({ url: 'amqp://svc:bad%zzsecret@127.0.0.1:1' })).toThrow(/malformed percent-encoded/);
    try {
      new RabbitMqEventBus({ url: 'amqp://svc:bad%zzsecret@127.0.0.1:1' });
    } catch (e) {
      expect(String(e)).not.toContain('secret');
    }
  });

  it.each(['amqp://127.0.0.1:1', 'amqp://:only-a-password@127.0.0.1:1'])('a URL without a broker user has no identity: %s', (url) => {
    expect(internals(new RabbitMqEventBus({ url })).publisherUserId).toBeUndefined();
  });

  it('fails a publish without an identity before reaching the broker, and reports it as a failed publish', async () => {
    const observations: EventBusObservation[] = [];
    const bus = new RabbitMqEventBus({ url: 'amqp://127.0.0.1:1', connectTimeoutMs: 200 });
    bus.setObserver((o) => observations.push(o));
    await expect(bus.publish(envelope())).rejects.toBeInstanceOf(PublisherIdentityUnavailableError);
    expect(observations).toEqual([expect.objectContaining({ type: 'publish', outcome: 'failed' })]);
    await bus.close();
  });

  it('never puts the credentials in a publish failure', async () => {
    const bus = new RabbitMqEventBus({ url: 'amqp://payment-service:s3cret-value@127.0.0.1:1', connectTimeoutMs: 200 });
    const err = await bus.publish(envelope()).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String(err)).not.toContain('s3cret-value');
    expect((err as Error).stack ?? '').not.toContain('s3cret-value');
    await bus.close();
  });
});

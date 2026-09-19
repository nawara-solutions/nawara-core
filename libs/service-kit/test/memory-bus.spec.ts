import { describe, expect, it } from 'vitest';
import { InMemoryEventBus, topicMatches, type EventEnvelope } from '../src/index.js';

const ev = (name: string, id = '11111111-1111-4111-8111-111111111111'): EventEnvelope => ({
  id, name, payload: { paymentId: 'p1' }, headers: { eventId: id, occurredAt: new Date().toISOString(), source: 'payment-service', version: 1 },
});

describe('topic matching (AMQP semantics)', () => {
  it.each([
    ['payment.succeeded', 'payment.succeeded', true],
    ['payment.*', 'payment.succeeded', true],
    ['payment.*', 'payment.refund.succeeded', false],
    ['payment.#', 'payment.refund.succeeded', true],
    ['payment.#', 'payment', true],
    ['#', 'anything.at.all', true],
    ['*.succeeded', 'payment.succeeded', true],
    ['invoice.*', 'payment.succeeded', false],
  ])('%s vs %s -> %s', (pattern, name, expected) => expect(topicMatches(pattern, name)).toBe(expected));
});

describe('InMemoryEventBus', () => {
  it('routes by binding, records publications and supports unsubscribe', async () => {
    const bus = new InMemoryEventBus();
    const got: string[] = [];
    const sub = await bus.subscribe({ queue: 'q', bindings: ['payment.*'], handler: async (e) => void got.push(e.name) });
    await bus.publish(ev('payment.succeeded'));
    await bus.publish(ev('invoice.created'));
    await sub.close();
    await bus.publish(ev('payment.failed'));
    expect(got).toEqual(['payment.succeeded']);
    expect(bus.published).toHaveLength(3);
  });

  it('can simulate duplicate delivery, a broker outage and a failing consumer (dead-letter)', async () => {
    const dup = new InMemoryEventBus({ duplicateDelivery: true });
    let n = 0;
    await dup.subscribe({ queue: 'q', bindings: ['#'], handler: async () => void n++ });
    await dup.publish(ev('payment.succeeded'));
    expect(n).toBe(2);

    const bus = new InMemoryEventBus();
    bus.failNextPublishes(1);
    await expect(bus.publish(ev('payment.succeeded'))).rejects.toThrow('broker unavailable');
    await bus.publish(ev('payment.succeeded'));
    expect(bus.published).toHaveLength(1);

    const failing = new InMemoryEventBus();
    await failing.subscribe({ queue: 'q', bindings: ['#'], handler: async () => { throw new Error('nope'); } });
    await failing.publish(ev('payment.succeeded'));
    expect(failing.deadLettered).toHaveLength(1);
  });
});

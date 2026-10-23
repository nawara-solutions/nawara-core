import { describe, expect, it } from 'vitest';
import { assertBrokerDeadLettering } from '../src/events/broker-dead-lettering.js';
import { InMemoryEventBus, RabbitMqEventBus, noBrokerDeadLettering, type EventSubscription } from '../src/index.js';

/** Core V2 OD-BRK-1 (ADR-0057 §8 "OD-BRK-0"): the opt-in topology option and its precondition contract. */
describe('noBrokerDeadLettering', () => {
  it('is frozen, says the effective topology is verified externally, and requires the caller to acknowledge it', () => {
    const o = noBrokerDeadLettering({ effectiveTopologyVerification: 'external' });
    expect(o).toEqual({ mode: 'none', effectiveTopologyVerification: 'external' });
    expect(Object.isFrozen(o)).toBe(true);
    expect(noBrokerDeadLettering({ effectiveTopologyVerification: 'external' })).not.toBe(o);
    for (const bad of [undefined, {}, { effectiveTopologyVerification: 'kit' }, { effectiveTopologyVerification: true }]) {
      expect(() => noBrokerDeadLettering(bad as never), JSON.stringify(bad)).toThrow(/effectiveTopologyVerification: 'external'/);
    }
  });

  it('only an issued value is accepted: a forged or mistyped option never reaches a declaration', async () => {
    expect(() => assertBrokerDeadLettering({ queue: 'q' })).not.toThrow(); // default: unchanged
    expect(() => assertBrokerDeadLettering({ queue: 'q', brokerDeadLettering: noBrokerDeadLettering({ effectiveTopologyVerification: 'external' }) })).not.toThrow();
    for (const forged of [{ mode: 'none', effectiveTopologyVerification: 'external' }, 'none', true, null]) {
      expect(() => assertBrokerDeadLettering({ queue: 'q', brokerDeadLettering: forged }), JSON.stringify(forged)).toThrow(/only a value created by noBrokerDeadLettering/);
    }
    // the bus refuses it at subscribe, before any connection (nothing is declared)
    const bus = new RabbitMqEventBus({ url: 'amqp://nobody:nothing@127.0.0.1:1', connectTimeoutMs: 100 });
    const sub = { queue: 'q', bindings: ['x.y'], handler: async () => undefined, brokerDeadLettering: { mode: 'none', effectiveTopologyVerification: 'external' } } as unknown as EventSubscription;
    await expect(bus.subscribe(sub)).rejects.toThrow(/only a value created by noBrokerDeadLettering/);
    await bus.close();
  });

  it('the in-memory bus (no broker topology) ignores it', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    await bus.subscribe({ queue: 'q', bindings: ['a.b'], handler: async (e) => void seen.push(e.id), brokerDeadLettering: noBrokerDeadLettering({ effectiveTopologyVerification: 'external' }) });
    await bus.publish({ id: 'e1', name: 'a.b', payload: {}, headers: { eventId: 'e1', occurredAt: new Date().toISOString(), source: 's', version: 1 } });
    expect(seen).toEqual(['e1']);
  });
});

import { ConfigError, InMemoryEventBus, RabbitMqEventBus } from '@nawara/service-kit';
import { describe, expect, it } from 'vitest';
import { createEventBus } from './event-bus.js';

describe('createEventBus (audit finding M-03)', () => {
  it('production with a configured broker selects RabbitMQ', () => {
    const bus = createEventBus({ isProduction: true, rabbitmqUrl: 'amqp://user:pw@broker.internal:5672' });
    expect(bus).toBeInstanceOf(RabbitMqEventBus);
    expect(bus).not.toBeInstanceOf(InMemoryEventBus);
  });

  it('production without a broker never falls back to the in-memory bus: it refuses, without echoing anything sensitive', () => {
    expect(() => createEventBus({ isProduction: true, rabbitmqUrl: undefined })).toThrow(ConfigError);
    expect(() => createEventBus({ isProduction: true, rabbitmqUrl: undefined })).toThrow(/RABBITMQ_URL is required in production/);
  });

  it('outside production, no broker means the in-memory bus (development and tests)', () => {
    expect(createEventBus({ isProduction: false, rabbitmqUrl: undefined })).toBeInstanceOf(InMemoryEventBus);
  });

  it('outside production a configured broker is still used', () => {
    expect(createEventBus({ isProduction: false, rabbitmqUrl: 'amqp://guest:guest@localhost:5672' })).toBeInstanceOf(RabbitMqEventBus);
  });
});

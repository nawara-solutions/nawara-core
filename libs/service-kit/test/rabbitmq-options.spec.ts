import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFETCH, RabbitMqEventBus } from '../src/index.js';

describe('RabbitMqEventBus options (Stage 15.8)', () => {
  it('defaults the consumer prefetch to 5 (half the default database pool)', () => {
    expect(DEFAULT_PREFETCH).toBe(5);
    expect(() => new RabbitMqEventBus({ url: 'amqp://127.0.0.1:1' })).not.toThrow();
  });

  it.each([0, -1, 1.5, 101])('refuses a prefetch of %s', (prefetch) => {
    expect(() => new RabbitMqEventBus({ url: 'amqp://127.0.0.1:1', prefetch })).toThrow('prefetch');
  });

  it.each([1, 5, 100])('accepts a prefetch of %s', (prefetch) => {
    expect(() => new RabbitMqEventBus({ url: 'amqp://127.0.0.1:1', prefetch })).not.toThrow();
  });
});

import { describe, expect, it } from 'vitest';
import { deterministicEventId } from './deterministic-id.js';

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('deterministicEventId', () => {
  it('produces a well-formed version-5 UUID', () => {
    expect(deterministicEventId('payment-1', 'payment.created')).toMatch(UUID_V5);
  });

  it('is deterministic: the same inputs always produce the same id', () => {
    const a = deterministicEventId('payment-1', 'payment.succeeded');
    const b = deterministicEventId('payment-1', 'payment.succeeded');
    expect(a).toBe(b);
  });

  it('differs when the aggregate id differs', () => {
    expect(deterministicEventId('payment-1', 'payment.created')).not.toBe(deterministicEventId('payment-2', 'payment.created'));
  });

  it('differs when the event name (transition) differs', () => {
    expect(deterministicEventId('payment-1', 'payment.created')).not.toBe(deterministicEventId('payment-1', 'payment.succeeded'));
  });
});

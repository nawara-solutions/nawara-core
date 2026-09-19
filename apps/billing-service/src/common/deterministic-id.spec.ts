import { describe, expect, it } from 'vitest';
import { deterministicEventId } from './deterministic-id.js';

describe('deterministicEventId', () => {
  it('produces a well-formed version-5 uuid', () => {
    expect(deterministicEventId('11111111-1111-4111-8111-111111111111', 'invoice.created')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is deterministic: the same aggregate and event name always give the same id', () => {
    expect(deterministicEventId('a', 'invoice.paid')).toBe(deterministicEventId('a', 'invoice.paid'));
  });

  it('differs when the aggregate or the event name differs', () => {
    expect(deterministicEventId('a', 'invoice.paid')).not.toBe(deterministicEventId('b', 'invoice.paid'));
    expect(deterministicEventId('a', 'invoice.paid')).not.toBe(deterministicEventId('a', 'invoice.created'));
  });

  it('does not collide when the parts are split differently', () => {
    expect(deterministicEventId('ab', 'c')).not.toBe(deterministicEventId('a', 'bc'));
  });
});

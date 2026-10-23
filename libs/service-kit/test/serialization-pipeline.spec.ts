import { describe, expect, it } from 'vitest';
import { OutboxRelay, SERIALIZATION_PIPELINE_VERSION, eventMessage, outboxEnvelope, type EventEnvelope, type OutboxEnvelopeRow } from '../src/index.js';

/**
 * Core V2 S1c-3 R1 (ADR-0057 §13.7 "S0-C4"): serialization pipeline version 1, pinned byte for byte. The payloads below are what
 * node-postgres returns for a `jsonb` column (PostgreSQL's normalized text, then `JSON.parse`); the real-PostgreSQL half of these fixtures
 * is `reemission.int-spec.ts`. A change to any expected value here is a NEW pipeline version with its own compatibility decision.
 */
const row = (payload: Record<string, unknown>, extra: Partial<OutboxEnvelopeRow> = {}): OutboxEnvelopeRow => ({
  id: '0b4f3c2e-6a59-4d7e-9c51-2f0d8a7b1e33',
  name: 'sample.recorded',
  payload,
  correlationId: 'corr-abcdef12',
  eventVersion: 1,
  occurredAt: new Date('2026-10-23T08:15:30.123Z'),
  ...extra,
});

describe('serialization pipeline v1', () => {
  it('is version 1', () => {
    expect(SERIALIZATION_PIPELINE_VERSION).toBe(1);
  });

  it('builds the envelope from the row, and only from the row and the producer', () => {
    expect(outboxEnvelope(row({ a: 1 }), 'sample-service')).toStrictEqual({
      id: '0b4f3c2e-6a59-4d7e-9c51-2f0d8a7b1e33',
      name: 'sample.recorded',
      payload: { a: 1 },
      headers: { eventId: '0b4f3c2e-6a59-4d7e-9c51-2f0d8a7b1e33', occurredAt: '2026-10-23T08:15:30.123Z', correlationId: 'corr-abcdef12', source: 'sample-service', version: 1 },
    });
    expect(outboxEnvelope(row({ a: 1 }, { correlationId: null, eventVersion: 3 }), 'sample-service').headers).toStrictEqual({
      eventId: '0b4f3c2e-6a59-4d7e-9c51-2f0d8a7b1e33', occurredAt: '2026-10-23T08:15:30.123Z', correlationId: undefined, source: 'sample-service', version: 3,
    });
  });

  // payload as node-postgres returns it  →  exact body bytes
  const fixtures: [string, Record<string, unknown>, string][] = [
    ['key order as PostgreSQL returns it (length, then bytes), not as written', JSON.parse('{"a": 2, "mid": 3, "zeta": 1}'), '{"a":2,"mid":3,"zeta":1}'],
    ['nested objects and arrays', JSON.parse('{"x": {"b": [1, {"d": null, "c": true}], "a": []}, "list": [[], {}]}'), '{"x":{"b":[1,{"d":null,"c":true}],"a":[]},"list":[[],{}]}'],
    ['null kept; a missing property absent', JSON.parse('{"gone": null}'), '{"gone":null}'],
    ['numbers', JSON.parse('{"i": 42, "f": 0.30000000000000004, "neg": -7.5, "big": 1000000000000000000000, "small": 0.000001, "tiny": 1e-7, "zero": 0}'),
      '{"i":42,"f":0.30000000000000004,"neg":-7.5,"big":1e+21,"small":0.000001,"tiny":1e-7,"zero":0}'],
    ['unicode and escapes', JSON.parse('{"q": "say \\"hi\\"\\\\", "nl": "a\\nb\\tc", "u": "é€😀", "ls": "\\u2028", "ctl": "\\u0001"}'),
      '{"q":"say \\"hi\\"\\\\","nl":"a\\nb\\tc","u":"é€😀","ls":" ","ctl":"\\u0001"}'],
    ['timestamps stay the strings they were', JSON.parse('{"at": "2026-10-23T08:15:30.123456Z"}'), '{"at":"2026-10-23T08:15:30.123456Z"}'],
  ];
  for (const [title, payload, bytes] of fixtures) {
    it(`body bytes: ${title}`, () => {
      expect(eventMessage(outboxEnvelope(row(payload), 'sample-service'), 'sample-service').content.equals(Buffer.from(bytes, 'utf8'))).toBe(true);
    });
  }

  it('message identity, routing and properties come from the envelope; user_id only from the caller (the bus)', () => {
    const m = eventMessage(outboxEnvelope(row({ a: 1 }), 'sample-service'), 'broker-user');
    expect(m.routingKey).toBe('sample.recorded');
    expect(m.options).toStrictEqual({
      persistent: true,
      contentType: 'application/json',
      messageId: '0b4f3c2e-6a59-4d7e-9c51-2f0d8a7b1e33',
      type: 'sample.recorded',
      userId: 'broker-user',
      timestamp: 1792743330,
      headers: { eventId: '0b4f3c2e-6a59-4d7e-9c51-2f0d8a7b1e33', occurredAt: '2026-10-23T08:15:30.123Z', correlationId: 'corr-abcdef12', source: 'sample-service', version: 1 },
    });
    expect(m.options).not.toHaveProperty('mandatory'); // the ordinary path never sets it
  });

  it('the relay publishes exactly the pipeline-v1 envelope of each row (unchanged relay behaviour)', async () => {
    const r = { ...row({ zeta: 1, a: 2 }), attempts: 0 };
    const published: EventEnvelope[] = [];
    const statements: string[] = [];
    const q = {
      query: async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' ').trim().slice(0, 40));
        return { rows: sql.includes('SELECT id, name, payload') ? [r] : [], rowCount: 1 };
      },
    };
    const relay = new OutboxRelay({ tx: (fn) => fn(q as never) }, { publish: async (e: EventEnvelope) => void published.push(e), subscribe: async () => ({ close: async () => undefined }), close: async () => undefined }, { source: 'sample-service' });
    expect(await relay.drainOnce()).toStrictEqual({ published: 1, failed: 0 });
    expect(published).toStrictEqual([outboxEnvelope(r, 'sample-service')]);
    expect(published[0]!.headers).toStrictEqual({ eventId: r.id, occurredAt: '2026-10-23T08:15:30.123Z', correlationId: 'corr-abcdef12', source: 'sample-service', version: 1 });
    expect(statements[1]).toMatch(/^UPDATE outbox SET "publishedAt" = now\(\)/);
  });
});

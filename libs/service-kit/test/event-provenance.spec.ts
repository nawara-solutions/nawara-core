import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RabbitMqEventBus, bodySha256, evaluateProvenance, type EventBusObservation, type EventSubscription, type ProvenanceDelivery, type ProvenanceObservation,
  type ProvenanceRecordResult,
} from '../src/index.js';

/**
 * Core V2 S1b (ADR-0057 §13.2, §13.3; observe-only). The verification rules, and the bus's ordering against a recording channel (no
 * broker): the handler runs only after the provenance record resolved; a record that fails holds and requeues the ORIGINAL delivery
 * (no retry copy, no dead letter, no handler); verification and conflicts never change whether the handler runs.
 */
const EXCHANGE = 'nawara.events';
const owners: Record<string, string> = { 'payment.succeeded': 'payment-service', 'member.contact_verification_requested': 'auth-service' };
const ownerOf = (name: string) => owners[name];

const delivery = (over: Partial<ProvenanceDelivery> = {}, headers: Record<string, unknown> = {}): ProvenanceDelivery => {
  const id = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
  return {
    exchange: EXCHANGE, routingKey: 'payment.succeeded', userId: 'payment-service', messageId: id, type: 'payment.succeeded',
    headers: { eventId: id, source: 'payment-service', occurredAt: '2026-10-22T00:00:00.000Z', version: 1, ...headers },
    body: Buffer.from('{"paymentId":"p-1","amount":1200}'), ...over,
  };
};
const observe = (d: ProvenanceDelivery): ProvenanceObservation => {
  const e = evaluateProvenance(d, EXCHANGE, ownerOf);
  if (e.origin !== 'original') throw new Error('expected an original delivery');
  return e.observation;
};

describe('evaluateProvenance (ADR-0057 §13.2)', () => {
  it('verifies a delivery whose broker user_id, source header, catalog owner, routing key, type and event id all agree', () => {
    const o = observe(delivery());
    expect(o).toEqual({
      source: 'payment-service', eventId: '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f', name: 'payment.succeeded', routingKey: 'payment.succeeded', exchange: EXCHANGE,
      bodySha256: createHash('sha256').update('{"paymentId":"p-1","amount":1200}').digest('hex'), producerUserId: 'payment-service', verified: true, reason: 'verified',
    });
  });

  it.each([
    ['missing user_id', delivery({ userId: undefined }), 'missing_user_id'],
    ['an unsafe user_id', delivery({ userId: 'payment service\n' }), 'missing_user_id'],
    ['a wrong publisher identity (another service)', delivery({ userId: 'billing-service' }), 'source_mismatch'],
    ['a forged source header (the header claims the owner, the broker user is someone else)', delivery({ userId: 'notification-service' }), 'source_mismatch'],
    ['a missing source header', delivery({}, { source: undefined }), 'source_mismatch'],
    ['a source header and user_id that agree but are not the family owner', delivery({ userId: 'billing-service' }, { source: 'billing-service' }), 'not_family_owner'],
    ['an event the catalog does not know', delivery({ type: 'payment.created', routingKey: 'payment.created' }), 'unknown_event'],
    ['a routing key that differs from the type', delivery({ routingKey: 'payment.failed' }), 'routing_key_mismatch'],
    ['a type that differs from the routing key', delivery({ type: 'payment.failed' }), 'unknown_event'],
    ['a non-uuid event id', delivery({ messageId: 'evt-1' }, { eventId: 'evt-1' }), 'invalid_event_id'],
    ['an uppercase uuid event id', delivery({ messageId: '6F1C2D3E-4A5B-4C6D-8E7F-0A1B2C3D4E5F' }, { eventId: '6F1C2D3E-4A5B-4C6D-8E7F-0A1B2C3D4E5F' }), 'invalid_event_id'],
    ['a header event id that differs from the message id', delivery({}, { eventId: randomUUID() }), 'invalid_event_id'],
    ['a missing message id', delivery({ messageId: undefined }), 'invalid_event_id'],
  ])('does not verify %s', (_t, d, reason) => {
    const o = observe(d);
    expect(o.verified).toBe(false);
    expect(o.reason).toBe(reason);
  });

  it('a resolver that throws knows no owner: unverified, never a failure', () => {
    const e = evaluateProvenance(delivery(), EXCHANGE, () => {
      throw new Error('boom');
    });
    expect(e.origin === 'original' && e.observation.reason).toBe('unknown_event');
  });

  it('only the configured exchange is an original delivery; the default exchange (retry, replay, injection) and any other are not', () => {
    expect(evaluateProvenance(delivery({ exchange: '' }), EXCHANGE, ownerOf)).toEqual({ origin: 'not_original' });
    expect(evaluateProvenance(delivery({ exchange: 'amq.topic' }), EXCHANGE, ownerOf)).toEqual({ origin: 'not_original' });
    expect(evaluateProvenance(delivery({ exchange: 'nawara.events.dlx' }), EXCHANGE, ownerOf)).toEqual({ origin: 'not_original' });
  });

  it('binds the raw body bytes: a different serialization of the same JSON is a different digest', () => {
    const a = observe(delivery({ body: Buffer.from('{"a":1,"b":2}') }));
    const b = observe(delivery({ body: Buffer.from('{"b":2,"a":1}') }));
    const c = observe(delivery({ body: Buffer.from('{"a":1,"b":2} ') }));
    expect(new Set([a.bodySha256, b.bodySha256, c.bodySha256]).size).toBe(3);
    expect(a.bodySha256).toBe(bodySha256(Buffer.from('{"a":1,"b":2}')));
    expect(a.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stores hostile values only as validated tokens (or empty), so nothing the database could refuse ever reaches it', () => {
    const o = observe(delivery({ messageId: 'x\u0000y', routingKey: 'Payment Succeeded\u0000', userId: 'a'.repeat(65) }, { source: 'evil\u0000service' }));
    expect(o).toMatchObject({ eventId: '', routingKey: '', producerUserId: null, source: '', verified: false });
    const long = observe(delivery({ type: `payment.${'a'.repeat(300)}`, routingKey: `payment.${'a'.repeat(300)}` }));
    expect(long.name).toBe('');
  });
});

type Step = string;
/** The bus's real `deliver` against a recording channel and a scripted store. */
function harness(store: (o: ProvenanceObservation) => Promise<ProvenanceRecordResult>, handler?: () => Promise<void>) {
  const steps: Step[] = [];
  const notices: string[] = [];
  const observations: EventBusObservation[] = [];
  const recorded: ProvenanceObservation[] = [];
  const bus = new RabbitMqEventBus({ url: 'amqp://127.0.0.1:1', exchange: EXCHANGE, retry: { maxRetries: 2, delayMs: 30 }, onNotice: (m) => notices.push(m) });
  bus.setObserver((o) => observations.push(o));
  const internal = bus as unknown as {
    republish: (queue: string) => Promise<void>;
    ensureDeadQueue: () => Promise<void>;
    deliver: (ch: unknown, msg: unknown, sub: EventSubscription, stopping?: AbortSignal) => Promise<void>;
  };
  internal.ensureDeadQueue = async () => undefined;
  internal.republish = async (queue: string) => void steps.push(`republish:${queue.endsWith('.retry') ? 'retry' : 'dead'}`);
  const ch = {
    ack: () => steps.push('ack'),
    nack: (_m: unknown, all: boolean, requeue: boolean) => steps.push(`nack:allUpTo=${all}:requeue=${requeue}`),
  };
  const sub: EventSubscription = {
    queue: 'billing.payment-events',
    bindings: ['payment.#'],
    handler: async () => {
      steps.push('handler');
      await handler?.();
    },
    provenance: {
      ownerOf,
      store: {
        record: async (consumer, o) => {
          expect(consumer).toBe('billing.payment-events');
          steps.push('record:start');
          const r = await store(o);
          recorded.push(o);
          steps.push(`record:${r}`);
          return r;
        },
      },
    },
  };
  const deliver = (d: ProvenanceDelivery = delivery(), stopping?: AbortSignal, withoutProvenance = false) =>
    internal.deliver(
      ch,
      {
        content: d.body,
        fields: { exchange: d.exchange, routingKey: d.routingKey, redelivered: false },
        properties: { messageId: d.messageId, type: d.type, userId: d.userId, headers: d.headers },
      },
      withoutProvenance ? { ...sub, provenance: undefined } : sub,
      stopping,
    );
  return { steps, notices, observations, recorded, deliver };
}

describe('RabbitMqEventBus provenance ordering (observe-only)', () => {
  it('commits the provenance record BEFORE the handler, then acknowledges', async () => {
    let committed = false;
    const h = harness(async () => {
      await new Promise((r) => setTimeout(r, 10));
      committed = true;
      return 'recorded';
    }, async () => expect(committed).toBe(true));
    await h.deliver();
    expect(h.steps).toEqual(['record:start', 'record:recorded', 'handler', 'ack']);
    expect(h.observations.map((o) => (o.type === 'consume' || o.type === 'provenance' ? `${o.type}:${o.outcome}` : o.type))).toEqual(['provenance:recorded_verified', 'consume:processed']);
  });

  it('an unverified, a duplicate or a conflicting observation still runs the handler exactly as before (observe-only)', async () => {
    for (const result of ['recorded', 'duplicate', 'conflict'] as const) {
      const h = harness(async () => result);
      await h.deliver(delivery({ userId: 'billing-service' }));
      expect(h.steps).toEqual(['record:start', `record:${result}`, 'handler', 'ack']);
      expect(h.recorded[0]).toMatchObject({ verified: false, reason: 'source_mismatch' });
      expect(h.observations[0]).toEqual({ type: 'provenance', queue: 'billing.payment-events', outcome: result === 'recorded' ? 'recorded_unverified' : result });
    }
  });

  it('a conflict is reported with bounded facts only (no payload, header or user value)', async () => {
    const h = harness(async () => 'conflict');
    await h.deliver(delivery({ userId: 'evil-user', body: Buffer.from('{"secret":"S3cret-4111"}') }, { source: 'payment-service' }));
    const line = h.notices.find((n) => n.startsWith('event_provenance_conflict'))!;
    expect(line).toBe('event_provenance_conflict queue=billing.payment-events event=6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f verified=false reason=source_mismatch — differs from the provenance already recorded for this event id; recorded as conflict evidence (observe-only)');
    expect(h.notices.join('\n')).not.toMatch(/S3cret|evil-user/);
  });

  it('a record that fails: no handler, no retry copy, no dead letter; the original is held for the retry delay and requeued', async () => {
    const h = harness(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED postgres://u:pw@db/x'), { name: 'DatabaseError' });
    });
    const started = Date.now();
    await h.deliver();
    expect(Date.now() - started).toBeGreaterThanOrEqual(25); // held (bounded) before the requeue: no tight loop
    expect(h.steps).toEqual(['record:start', 'nack:allUpTo=false:requeue=true']);
    expect(h.observations).toEqual([
      { type: 'provenance', queue: 'billing.payment-events', outcome: 'failed' },
      { type: 'consume', queue: 'billing.payment-events', outcome: 'provenance_deferred', redelivered: false },
    ]);
    expect(h.notices).toEqual(['event_provenance_deferred queue=billing.payment-events event=6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f delayMs=30 error=DatabaseError — provenance could not be recorded, so the handler did not run; requeued after the delay']);
    expect(h.notices.join('\n')).not.toMatch(/postgres:|pw@|ECONNREFUSED/);
  });

  it('a stopping consumer ends the hold at once (shutdown stays bounded)', async () => {
    const h = harness(async () => {
      throw new Error('down');
    });
    const stop = new AbortController();
    stop.abort();
    const started = Date.now();
    await h.deliver(delivery(), stop.signal);
    expect(Date.now() - started).toBeLessThan(25);
    expect(h.steps).toEqual(['record:start', 'nack:allUpTo=false:requeue=true']);
  });

  it('a delivery through the default exchange (retry, replay, injection) records nothing and invents no provenance; the handler runs', async () => {
    const h = harness(async () => 'recorded');
    await h.deliver(delivery({ exchange: '', routingKey: 'billing.payment-events', userId: 'billing-service' }));
    expect(h.steps).toEqual(['handler', 'ack']);
    expect(h.observations[0]).toEqual({ type: 'provenance', queue: 'billing.payment-events', outcome: 'not_original' });
  });

  it('a malformed envelope is dead-lettered exactly as before, with no provenance record', async () => {
    const h = harness(async () => 'recorded');
    await h.deliver(delivery({ type: 'NOT AN EVENT' }));
    expect(h.steps).toEqual(['republish:dead', 'ack']);
  });

  it('a handler failure after a committed record follows the ordinary retry path (provenance does not change it)', async () => {
    const h = harness(async () => 'recorded', async () => {
      throw new Error('transient');
    });
    await h.deliver();
    expect(h.steps).toEqual(['record:start', 'record:recorded', 'handler', 'republish:retry', 'ack']);
  });

  it('a subscription without provenance behaves exactly as before (Audit and every consumer that has not opted in)', async () => {
    const h = harness(async () => {
      throw new Error('must not be called');
    });
    await h.deliver(delivery(), undefined, true);
    expect(h.steps).toEqual(['handler', 'ack']);
    expect(h.observations.map((o) => o.type)).toEqual(['consume']);
  });
});

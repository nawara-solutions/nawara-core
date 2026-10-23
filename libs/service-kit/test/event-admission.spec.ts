import { describe, expect, it } from 'vitest';
import {
  RabbitMqEventBus, isCanonicalJsonBody, type DeadLetterInput, type EventAdmission, type EventBusObservation, type EventEnvelope, type EventSubscription,
  type ProvenanceObservation,
} from '../src/index.js';

/**
 * Core V2 S1b-2 (ADR-0057 §13.2 "Audit admission"): the kit's `admission` hook against a recording channel (no broker). It runs on every
 * delivery, on any exchange, after the envelope checks and BEFORE provenance and the handler; anything but an explicit admission is a
 * permanent failure (dead-lettered at once under the policy, with its reason): never a retry, a provenance record or the handler.
 */
const EXCHANGE = 'nawara.events';
const ID = '6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const BODY = Buffer.from('{"action":"payment.succeeded","outcome":"succeeded"}');

interface Delivery { exchange: string; routingKey: string; userId?: string; body: Buffer; type?: string }
const original = (over: Partial<Delivery> = {}): Delivery => ({ exchange: EXCHANGE, routingKey: 'audit.payment.succeeded', userId: 'payment-service', body: BODY, ...over });

function harness(admission: EventSubscription['admission'], opts: { handler?: () => Promise<void>; policy?: boolean } = {}) {
  const steps: string[] = [];
  const observations: EventBusObservation[] = [];
  const policyInputs: DeadLetterInput[] = [];
  const admitted: Array<{ event: EventEnvelope; body: Buffer }> = [];
  const bus = new RabbitMqEventBus({ url: 'amqp://127.0.0.1:1', exchange: EXCHANGE, retry: { maxRetries: 2, delayMs: 30 } });
  bus.setObserver((o) => observations.push(o));
  const internal = bus as unknown as {
    republish: (queue: string, msg: unknown, annotations: Record<string, string | undefined>, expiration?: string, copy?: { redacted: boolean }) => Promise<void>;
    ensureDeadQueue: () => Promise<void>;
    deliver: (ch: unknown, msg: unknown, sub: EventSubscription) => Promise<void>;
  };
  internal.ensureDeadQueue = async () => undefined;
  internal.republish = async (queue, _msg, annotations, _exp, copy) =>
    void steps.push(`republish:${queue.endsWith('.retry') ? 'retry' : 'dead'}:${annotations['x-nawara-failure-reason'] ?? annotations['x-nawara-failure'] ?? ''}${copy?.redacted ? ':redacted' : ''}`);
  const ch = { ack: () => steps.push('ack'), nack: (_m: unknown, _a: boolean, requeue: boolean) => steps.push(`nack:requeue=${requeue}`) };
  const sub: EventSubscription = {
    queue: 'audit-service.audit',
    bindings: ['audit.#'],
    handler: async () => {
      steps.push('handler');
      await opts.handler?.();
    },
    ...(admission ? {
      admission: (event: EventEnvelope, body: Buffer) => {
        steps.push('admission');
        admitted.push({ event, body });
        return admission(event, body);
      },
    } : {}),
    ...(opts.policy === false ? {} : {
      deadLetterPolicy: (input: DeadLetterInput) => {
        policyInputs.push(input);
        return { body: 'redacted' as const, headers: {} };
      },
    }),
    provenance: {
      ownerOf: () => 'payment-service',
      store: {
        record: async (_c: string, _o: ProvenanceObservation) => {
          steps.push('record');
          return 'recorded' as const;
        },
      },
    },
  };
  const deliver = (d: Delivery = original()) =>
    internal.deliver(ch, {
      content: d.body,
      fields: { exchange: d.exchange, routingKey: d.routingKey, redelivered: false },
      properties: { messageId: ID, type: d.type ?? 'audit.payment.succeeded', userId: d.userId, headers: { eventId: ID, source: 'payment-service', occurredAt: '2026-10-23T00:00:00.000Z', version: 1 } },
    }, sub);
  const outcomes = () => observations.flatMap((o) => (o.type === 'consume' ? [o.outcome] : []));
  return { steps, observations, policyInputs, admitted, deliver, outcomes };
}

describe('isCanonicalJsonBody (the bytes the kit publisher writes for their parsed value)', () => {
  it('accepts exactly JSON.stringify output and nothing else', () => {
    expect(isCanonicalJsonBody(Buffer.from(JSON.stringify({ a: 1, b: 'é', c: [true, null], d: { e: -0.5 } })))).toBe(true);
    for (const text of ['{ "a":1}', '{"a":1}\n', '{"a":1.0}', '{"a":1e2}', '{"a":"\\u00e9"}', '{"a":"x","a":"y"}', '{"a":1', 'not json', '', '﻿{"a":1}']) {
      expect(isCanonicalJsonBody(Buffer.from(text)), text).toBe(false);
    }
    // a duplicate key: the parsed value shows only the last one, the bytes carry both
    expect(isCanonicalJsonBody(Buffer.from('{"action":"+21620000009","action":"payment.succeeded"}'))).toBe(false);
    // invalid UTF-8 inside a string is not canonical (decoding replaces it, so the re-encoded bytes differ)
    expect(isCanonicalJsonBody(Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]))).toBe(false);
    expect(isCanonicalJsonBody(new Uint8Array(Buffer.from('{"a":1}')))).toBe(true); // any Uint8Array view
  });
});

describe('RabbitMqEventBus admission (Core V2 S1b-2)', () => {
  it('admitted: admission runs on the raw bytes BEFORE provenance and the handler', async () => {
    const h = harness(() => ({ admitted: true }));
    await h.deliver();
    expect(h.steps).toEqual(['admission', 'record', 'handler', 'ack']);
    expect(h.admitted[0]!.body.equals(BODY)).toBe(true);
    expect(h.admitted[0]!.event).toMatchObject({ id: ID, name: 'audit.payment.succeeded', payload: JSON.parse(BODY.toString()) });
  });

  it('refused: dead-lettered at once with its reason under the policy; no provenance, no handler, no retry', async () => {
    const h = harness(() => ({ admitted: false, reason: 'noncanonical_body' }));
    await h.deliver();
    expect(h.steps).toEqual(['admission', 'republish:dead:noncanonical_body:redacted', 'ack']);
    expect(h.outcomes()).toEqual(['dead_lettered_permanent']);
    expect(h.observations.some((o) => o.type === 'provenance')).toBe(false);
    expect(h.policyInputs).toEqual([expect.objectContaining({ failure: 'permanent', reason: 'noncanonical_body', body: BODY })]);
  });

  it('an exception, a promise or a malformed answer fails CLOSED: `admission_error`, permanent, never retried', async () => {
    const answers: Array<() => unknown> = [
      () => {
        throw new Error('boom postgres://u:pw@db');
      },
      () => Promise.resolve({ admitted: true }),
      () => undefined,
      () => ({ admitted: 'yes' }),
      () => ({ admitted: false }),
      () => ({ admitted: false, reason: 42 }),
    ];
    for (const answer of answers) {
      const h = harness(answer as () => EventAdmission);
      await h.deliver();
      expect(h.steps).toEqual(['admission', 'republish:dead:admission_error:redacted', 'ack']);
    }
  });

  it('a reason that is not a safe code is never written as given', async () => {
    const h = harness(() => ({ admitted: false, reason: 'phone=+21620000009' }));
    await h.deliver();
    expect(h.steps).toEqual(['admission', 'republish:dead:unspecified:redacted', 'ack']);
  });

  it('applies to default-exchange deliveries too (a retry, a replay, an injection): refused ones never reach the handler', async () => {
    const refused = harness(() => ({ admitted: false, reason: 'sensitive_field' }));
    await refused.deliver(original({ exchange: '', routingKey: 'audit-service.audit', userId: 'intruder' }));
    expect(refused.steps).toEqual(['admission', 'republish:dead:sensitive_field:redacted', 'ack']);
    const admitted = harness(() => ({ admitted: true }));
    await admitted.deliver(original({ exchange: '', routingKey: 'audit-service.audit', userId: 'audit-service' }));
    expect(admitted.steps).toEqual(['admission', 'handler', 'ack']); // admitted, and (not original) no provenance record
  });

  it('a malformed envelope never reaches admission (dead-lettered `malformed` as before)', async () => {
    const h = harness(() => ({ admitted: true }));
    await h.deliver(original({ body: Buffer.from('{not json') }));
    expect(h.steps).toEqual(['republish:dead:malformed_envelope:redacted', 'ack']);
  });

  it('without a dead-letter policy a refusal is still permanent (the original copy, as the kit always did for a permanent failure)', async () => {
    const h = harness(() => ({ admitted: false, reason: 'unknown_action' }), { policy: false });
    await h.deliver();
    expect(h.steps).toEqual(['admission', 'republish:dead:unknown_action', 'ack']);
  });

  it('an admitted delivery whose handler fails transiently follows the ordinary retry path (admission does not change it)', async () => {
    const h = harness(() => ({ admitted: true }), {
      handler: async () => {
        throw new Error('transient');
      },
    });
    await h.deliver();
    expect(h.steps).toEqual(['admission', 'record', 'handler', 'republish:retry:', 'ack']);
  });

  it('a subscription without admission behaves exactly as before; every dead-letter policy is now also given the raw bytes', async () => {
    const h = harness(undefined, {
      handler: async () => {
        throw new (await import('../src/index.js')).PermanentEventFailure('refused_for_test');
      },
    });
    await h.deliver();
    expect(h.steps).toEqual(['record', 'handler', 'republish:dead:refused_for_test:redacted', 'ack']);
    expect(h.policyInputs[0]).toMatchObject({ failure: 'permanent', reason: 'refused_for_test', body: BODY });
  });
});

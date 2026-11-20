import { describe, expect, it } from 'vitest';
import {
  BoundedObservationBuffer, DEAD_LETTER_HEADER, PermanentEventFailure, RabbitMqEventBus, type DeadLetterObservation, type DeadLetterObserver,
  type EventSubscription,
} from '../src/index.js';

/**
 * Core V2 DO-43b (the Owner's D43-1, D43-2 and safety requirements 3, 4, 8, 9): the bus's real `deliver` / `onFailure` code against a
 * recording channel (no broker). For every consume outcome, the channel calls (ack, nack and their flags), the copies sent (queue and
 * annotations), the notices and their order are IDENTICAL with no dead-letter observer and with an observer that records, throws, returns
 * a rejected or a never-settling promise, or sits on a saturated buffer whose sink fails. The only difference an observer makes is the
 * diagnostic `x-nawara-dead-letter-attempt` annotation on a dead-letter copy, and only for the opted-in subscription.
 */
type RepublishMode = 'ok' | 'retry-fails' | 'all-fail';
type ObserverKind = 'none' | 'record' | 'throw' | 'reject' | 'hang' | 'saturated';
type Sent = { queue: string; annotations: Record<string, unknown> };

function harness(opts: { republish: RepublishMode; observer: ObserverKind }) {
  const steps: string[] = [];
  const sent: Sent[] = [];
  const observations: DeadLetterObservation[] = [];
  const bus = new RabbitMqEventBus({ url: 'amqp://127.0.0.1:1', retry: { maxRetries: 2, delayMs: 1 }, onNotice: (m) => steps.push(`notice:${m.split(' ')[0]}`) });
  const internal = bus as unknown as {
    republish: (queue: string, msg: unknown, annotations: Record<string, unknown>) => Promise<void>;
    ensureDeadQueue: () => Promise<void>;
    deliver: (ch: unknown, msg: unknown, sub: EventSubscription, stopping?: AbortSignal) => Promise<void>;
  };
  internal.ensureDeadQueue = async () => undefined;
  internal.republish = async (queue, _msg, annotations) => {
    steps.push(`republish:${queue.endsWith('.retry') ? 'retry' : 'dead'}`);
    sent.push({ queue, annotations });
    if (opts.republish === 'all-fail' || (opts.republish === 'retry-fails' && queue.endsWith('.retry'))) throw new Error('copy not confirmed');
  };
  const saturated = new BoundedObservationBuffer<DeadLetterObservation>({ capacity: 1, flushIntervalMs: 1000, sink: async () => { throw new Error('database down'); } });
  saturated.offer({} as DeadLetterObservation); // full from the start: every observation below is dropped and counted
  const observers: Record<Exclude<ObserverKind, 'none'>, DeadLetterObserver> = {
    record: { observe: (o) => { observations.push(o); } },
    throw: { observe: () => { throw new Error('observer failure'); } },
    reject: { observe: (() => Promise.reject(new Error('async observer failure'))) as unknown as DeadLetterObserver['observe'] },
    hang: { observe: (() => new Promise(() => undefined)) as unknown as DeadLetterObserver['observe'] },
    saturated: { observe: (o) => { saturated.offer(o); } },
  };
  const ch = {
    ack: () => steps.push('ack'),
    nack: (_m: unknown, all: boolean, requeue: boolean) => steps.push(`nack:allUpTo=${all}:requeue=${requeue}`),
  };
  const deliver = (handler: () => Promise<void>, msg: Partial<{ type: string; messageId: string | undefined; retryCount: number; replayCount: number; redelivered: boolean; source: string }> = {}, policy = false) =>
    internal.deliver(
      ch,
      {
        content: Buffer.from('{"a":1}'),
        fields: { redelivered: msg.redelivered ?? false },
        properties: {
          messageId: 'messageId' in msg ? msg.messageId : 'msg-1', type: msg.type ?? 'payment.succeeded',
          headers: { ...(msg.retryCount ? { 'x-nawara-retry-count': msg.retryCount } : {}), ...(msg.replayCount ? { 'x-nawara-replay-count': msg.replayCount } : {}), ...(msg.source ? { source: msg.source } : {}) },
        },
      },
      {
        queue: 'audit-service.audit', bindings: ['audit.#'], handler,
        ...(policy ? { deadLetterPolicy: () => ({ body: 'original' as const, headers: {} }) } : {}),
        ...(opts.observer === 'none' ? {} : { deadLetterObserver: observers[opts.observer] }),
      },
    );
  return { steps, sent, observations, deliver, saturated };
}

const ok = async () => undefined;
const transient = async () => { throw new Error('transient'); };
const permanent = async () => { throw new PermanentEventFailure('invalid_record'); };

type Case = { name: string; republish: RepublishMode; handler: () => Promise<void>; msg?: Parameters<ReturnType<typeof harness>['deliver']>[1]; policy?: boolean; transitions: string[] };
const CASES: Case[] = [
  { name: 'processed', republish: 'ok', handler: ok, transitions: [] },
  { name: 'retry scheduled', republish: 'ok', handler: transient, transitions: [] },
  { name: 'dead-lettered: permanent', republish: 'ok', handler: permanent, transitions: ['attempted', 'transfer_confirmed'] },
  { name: 'dead-lettered: malformed', republish: 'ok', handler: ok, msg: { type: 'NOT A VALID NAME' }, transitions: ['attempted', 'transfer_confirmed'] },
  { name: 'dead-lettered: retries exhausted', republish: 'ok', handler: transient, msg: { retryCount: 2 }, transitions: ['attempted', 'transfer_confirmed'] },
  { name: 'retry copy fails -> dead-lettered', republish: 'retry-fails', handler: transient, transitions: ['attempted', 'transfer_confirmed'] },
  { name: 'dead-letter deferred (policy, copy not confirmed)', republish: 'all-fail', handler: permanent, policy: true, transitions: ['attempted', 'transfer_unconfirmed'] },
  { name: 'dead-letter deferred (no policy, copy not confirmed)', republish: 'all-fail', handler: permanent, transitions: ['attempted', 'transfer_unconfirmed'] },
];

/** The copies as sent, without the two values that legitimately differ per run: the wall-clock failure time and the diagnostic attempt id. */
const comparable = (sent: Sent[]) => sent.map((s) => {
  const { [DEAD_LETTER_HEADER.failedAt]: _t, [DEAD_LETTER_HEADER.deadLetterAttempt]: _a, ...rest } = s.annotations;
  return { queue: s.queue, annotations: rest };
});

describe('DO-43b: a dead-letter observer never changes settlement (recording channel, every outcome)', () => {
  for (const c of CASES) {
    it(`${c.name}: identical channel calls, copies and notices for every observer kind`, async () => {
      const base = harness({ republish: c.republish, observer: 'none' });
      await base.deliver(c.handler, c.msg, c.policy);
      for (const kind of ['record', 'throw', 'reject', 'hang', 'saturated'] as const) {
        const h = harness({ republish: c.republish, observer: kind });
        await h.deliver(c.handler, c.msg, c.policy);
        expect(h.steps, kind).toEqual(base.steps);
        expect(comparable(h.sent), kind).toEqual(comparable(base.sent));
      }
      // without an observer, no copy carries the attempt annotation (a non-opted consumer is untouched)
      expect(base.sent.every((s) => !(DEAD_LETTER_HEADER.deadLetterAttempt in s.annotations))).toBe(true);
    });

    it(`${c.name}: observed transitions ${c.transitions.join(' → ') || '(none)'}, ordered around the copy and the settle`, async () => {
      const h = harness({ republish: c.republish, observer: 'record' });
      await h.deliver(c.handler, c.msg, c.policy);
      expect(h.observations.map((o) => o.transition)).toEqual(c.transitions);
      if (c.transitions.length === 0) {
        expect(h.sent.every((s) => !(DEAD_LETTER_HEADER.deadLetterAttempt in s.annotations))).toBe(true);
        return;
      }
      const ids = new Set(h.observations.map((o) => o.attemptId));
      expect(ids.size).toBe(1); // one physical attempt, one id
      const dead = h.sent.filter((s) => s.queue.endsWith('.dead'));
      expect(dead).toHaveLength(1);
      expect(dead[0]!.annotations[DEAD_LETTER_HEADER.deadLetterAttempt]).toBe([...ids][0]); // the copy carries exactly the observed id
      expect(h.sent.filter((s) => s.queue.endsWith('.retry')).every((s) => !(DEAD_LETTER_HEADER.deadLetterAttempt in s.annotations))).toBe(true);
    });
  }

  it('the outcome is observed AFTER the broker answered and BEFORE the original is settled', async () => {
    const order: string[] = [];
    const bus = new RabbitMqEventBus({ url: 'amqp://127.0.0.1:1', retry: { maxRetries: 0, delayMs: 1 } });
    const internal = bus as unknown as { republish: () => Promise<void>; ensureDeadQueue: () => Promise<void>; deliver: (ch: unknown, msg: unknown, sub: EventSubscription) => Promise<void> };
    internal.ensureDeadQueue = async () => undefined;
    let fail = false;
    internal.republish = async () => { order.push('copy'); if (fail) throw new Error('nope'); };
    const sub: EventSubscription = { queue: 'audit-service.audit', bindings: ['audit.#'], handler: permanent, deadLetterObserver: { observe: (o) => { order.push(o.transition); } } };
    const ch = { ack: () => order.push('ack'), nack: () => order.push('nack') };
    const msg = { content: Buffer.from('{}'), fields: { redelivered: false }, properties: { messageId: 'm-1', type: 'audit.file.deleted', headers: {} } };
    await internal.deliver(ch, msg, sub);
    fail = true;
    await internal.deliver(ch, msg, sub);
    expect(order).toEqual(['attempted', 'copy', 'transfer_confirmed', 'ack', 'attempted', 'copy', 'transfer_unconfirmed', 'nack']);
  });

  it('every physical attempt gets a FRESH id, even for the same delivery (a requeued deferral, a redelivery, a replay are separate attempts)', async () => {
    const h = harness({ republish: 'all-fail', observer: 'record' });
    await h.deliver(permanent);
    await h.deliver(permanent, { redelivered: true });
    await h.deliver(permanent, { replayCount: 1 });
    const attempts = new Set(h.observations.map((o) => o.attemptId));
    expect(attempts.size).toBe(3);
    for (const id of attempts) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('an observation is header-only: safe labels kept, unsafe or absent ones become "", no body, no error message', async () => {
    const h = harness({ republish: 'ok', observer: 'record' });
    await h.deliver(permanent, { messageId: 'evt-1', type: 'audit.file.deleted', source: 'file-service', retryCount: 0, replayCount: 2, redelivered: true });
    await h.deliver(ok, { messageId: undefined, type: 'NOT A NAME', source: 'Not A Service' });
    const [a, , b] = h.observations;
    expect(a).toEqual({
      attemptId: expect.any(String), transition: 'attempted', queue: 'audit-service.audit', eventId: 'evt-1', eventName: 'audit.file.deleted', source: 'file-service',
      failure: 'permanent', reason: 'invalid_record', errorClass: 'PermanentEventFailure', retryCount: 0, replayCount: 2, redelivered: true, observedAt: expect.any(Date),
    });
    expect(b).toMatchObject({ eventId: '', eventName: '', source: '', failure: 'malformed', reason: 'malformed_envelope' });
    expect(JSON.stringify(h.observations)).not.toMatch(/"a":1|transient|copy not confirmed/);
  });

  it('a saturated buffer drops and counts every observation; nothing reaches the delivery path', async () => {
    const h = harness({ republish: 'ok', observer: 'saturated' });
    await h.deliver(permanent);
    expect(h.saturated.stats()).toMatchObject({ observedTotal: 1, droppedOverflow: 2, buffered: 1 });
    expect(h.steps.filter((s) => s === 'ack')).toHaveLength(1);
  });
});

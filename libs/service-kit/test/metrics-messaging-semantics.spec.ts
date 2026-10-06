import { describe, expect, it } from 'vitest';
import { PermanentEventFailure, RabbitMqEventBus, type EventBusObservation, type EventSubscription } from '../src/index.js';

/**
 * V2 A12.3 hard rule: the bus observer must not move or alter acknowledgement semantics. The bus's real `deliver` / `onFailure` code
 * runs here against a recording channel (no broker): for EVERY consume outcome, the channel calls (ack, nack, requeue flags), their
 * order relative to the notices, and the notices themselves are identical with no observer, with a recording observer, and with an
 * observer that throws; and each observation is made only AFTER the settle call it reports.
 */
type Step = string;
type RepublishMode = 'ok' | 'retry-fails' | 'all-fail';

function harness(opts: { republish: RepublishMode; observer?: 'record' | 'throw' }) {
  const steps: Step[] = [];
  const observations: EventBusObservation[] = [];
  const bus = new RabbitMqEventBus({
    url: 'amqp://127.0.0.1:1',
    retry: { maxRetries: 2, delayMs: 1 },
    onNotice: (m) => steps.push(`notice:${m.split(' ')[0]}`),
  });
  const internal = bus as unknown as {
    republish: (queue: string) => Promise<void>;
    ensureDeadQueue: () => Promise<void>;
    deliver: (ch: unknown, msg: unknown, sub: EventSubscription, stopping?: AbortSignal) => Promise<void>;
  };
  internal.ensureDeadQueue = async () => undefined;
  internal.republish = async (queue: string) => {
    steps.push(`republish:${queue.endsWith('.retry') ? 'retry' : 'dead'}`);
    if (opts.republish === 'all-fail' || (opts.republish === 'retry-fails' && queue.endsWith('.retry'))) throw new Error('copy not confirmed');
  };
  if (opts.observer === 'record') bus.setObserver((o) => {
    steps.push(`observe:${o.type === 'consume' ? o.outcome : o.type}`);
    observations.push(o);
  });
  if (opts.observer === 'throw') bus.setObserver(() => {
    steps.push('observe:throws');
    throw new Error('observer failure');
  });
  const ch = {
    ack: () => steps.push('ack'),
    nack: (_m: unknown, all: boolean, requeue: boolean) => steps.push(`nack:allUpTo=${all}:requeue=${requeue}`),
  };
  const deliver = (handler: () => Promise<void>, msg: Partial<{ type: string; messageId: string; retryCount: number; redelivered: boolean; body: string }> = {}, policy = false) =>
    internal.deliver(
      ch,
      {
        content: Buffer.from(msg.body ?? '{"a":1}'),
        fields: { redelivered: msg.redelivered ?? false },
        properties: { messageId: msg.messageId ?? 'msg-1', type: msg.type ?? 'payment.succeeded', headers: msg.retryCount ? { 'x-nawara-retry-count': msg.retryCount } : {} },
      },
      { queue: 'billing.payment-events', bindings: ['payment.#'], handler, ...(policy ? { deadLetterPolicy: () => ({ body: 'original' as const, headers: {} }) } : {}) },
    );
  return { bus, steps, observations, deliver };
}

const ok = async () => undefined;
const transient = async () => {
  throw new Error('transient db_down marker-exception-7731');
};
const permanent = async () => {
  throw new PermanentEventFailure('not_a_valid_id');
};

type Case = { name: string; outcome: string; republish: RepublishMode; handler: () => Promise<void>; msg?: Parameters<ReturnType<typeof harness>['deliver']>[1]; policy?: boolean };
const cases: Case[] = [
  { name: 'processed', outcome: 'processed', republish: 'ok', handler: ok },
  { name: 'retry scheduled', outcome: 'retry_scheduled', republish: 'ok', handler: transient },
  { name: 'dead-lettered: permanent', outcome: 'dead_lettered_permanent', republish: 'ok', handler: permanent },
  { name: 'dead-lettered: malformed', outcome: 'dead_lettered_malformed', republish: 'ok', handler: ok, msg: { type: 'NOT A VALID NAME' } },
  { name: 'dead-lettered: retries exhausted', outcome: 'dead_lettered_retries_exhausted', republish: 'ok', handler: transient, msg: { retryCount: 2 } },
  { name: 'retry copy fails -> dead-lettered', outcome: 'dead_lettered_retries_exhausted', republish: 'retry-fails', handler: transient },
  { name: 'dead-letter deferred (policy, copy not confirmed)', outcome: 'dead_letter_deferred', republish: 'all-fail', handler: permanent, policy: true },
  { name: 'dead-letter unannotated (no policy, copy not confirmed)', outcome: 'dead_letter_unannotated', republish: 'all-fail', handler: permanent },
];

describe('ack/nack semantics are unchanged by the observer (V2 A12.3)', () => {
  for (const c of cases) {
    it(`${c.name}: identical channel calls and notices; observed after settling, as "${c.outcome}"`, async () => {
      const none = harness({ republish: c.republish });
      const rec = harness({ republish: c.republish, observer: 'record' });
      const thr = harness({ republish: c.republish, observer: 'throw' });
      for (const h of [none, rec, thr]) await h.deliver(c.handler, c.msg, c.policy);
      const strip = (s: Step[]) => s.filter((x) => !x.startsWith('observe:'));
      expect(strip(rec.steps)).toEqual(none.steps);
      expect(strip(thr.steps)).toEqual(none.steps);
      // the observation is the LAST step: after the ack/nack it reports
      expect(rec.steps.at(-1)).toBe(`observe:${c.outcome}`);
      expect(rec.steps.slice(0, -1).some((s) => s === 'ack' || s.startsWith('nack'))).toBe(true);
      expect(rec.observations).toEqual([expect.objectContaining({ type: 'consume', queue: 'billing.payment-events', outcome: c.outcome })]);
    });
  }

  it('the settle sequence per outcome is the documented one (ack, or nack with/without requeue)', async () => {
    const seq: Record<string, string> = {};
    for (const c of cases) {
      const h = harness({ republish: c.republish });
      await h.deliver(c.handler, c.msg, c.policy);
      seq[c.name] = h.steps.filter((s) => s === 'ack' || s.startsWith('nack')).join(',');
    }
    expect(seq).toEqual({
      processed: 'ack',
      'retry scheduled': 'ack',
      'dead-lettered: permanent': 'ack',
      'dead-lettered: malformed': 'ack',
      'dead-lettered: retries exhausted': 'ack',
      'retry copy fails -> dead-lettered': 'ack',
      'dead-letter deferred (policy, copy not confirmed)': 'nack:allUpTo=false:requeue=true',
      'dead-letter unannotated (no policy, copy not confirmed)': 'nack:allUpTo=false:requeue=false',
    });
  });

  it('handler duration is reported only when the handler ran; redelivery is reported; nothing else from the message', async () => {
    const h = harness({ republish: 'ok', observer: 'record' });
    await h.deliver(ok, { redelivered: true, messageId: 'mid-SECRET-0b6f2c1e', type: 'audit.x0b6f2c1e4a8e4f579d553f0d6e3a1b22' }); // grammar-valid hostile name
    await h.deliver(ok, { type: 'BAD TYPE' });
    expect(h.observations[0]).toEqual({ type: 'consume', queue: 'billing.payment-events', outcome: 'processed', handlerMs: expect.any(Number), redelivered: true });
    expect(h.observations[1]).toEqual({ type: 'consume', queue: 'billing.payment-events', outcome: 'dead_lettered_malformed', handlerMs: undefined, redelivered: false });
    expect(JSON.stringify(h.observations)).not.toMatch(/SECRET|0b6f2c1e|audit\./);
  });

  it('a second observer is refused', () => {
    const h = harness({ republish: 'ok', observer: 'record' });
    expect(() => h.bus.setObserver(() => undefined)).toThrow(/already set/);
  });
});

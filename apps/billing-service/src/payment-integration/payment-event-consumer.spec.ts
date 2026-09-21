import { Logger } from '@nestjs/common';
import { PermanentEventFailure, type EventEnvelope } from '@nawara/service-kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentEventConsumer } from './payment-event-consumer.js';

/**
 * M-07: how the consumer classifies a failure for the bus (permanent = dead-letter at once, anything else = retried a bounded number
 * of times) and how it names a replayed delivery in its logs. The consumer's validation and its use of `applyPaymentEvent` (hence
 * `payment_event_receipt`) are the same for a first delivery, a retry and a replay: only the log event names differ.
 */
const SECRET = 'S3cretPayerNote';
const PRID = '3c8b7a1e-5f57-4c1f-8a0e-0f0a4a2b9d11';
const envelope = (over: Partial<EventEnvelope> = {}, headers: Partial<EventEnvelope['headers']> = {}): EventEnvelope => ({
  id: 'e1111111-1111-4111-8111-111111111111',
  name: 'payment.cancelled',
  payload: {
    paymentId: 'p-1', producer: 'billing-service', paymentRequestId: PRID, sourceType: 'invoice', sourceId: 'inv-1',
    payer: { type: 'user', id: SECRET }, seller: { type: 'organization', id: 'org-1' }, organizationId: 'org-1', currency: 'TND', revision: 0, amount: 1000,
  },
  headers: { eventId: 'e1111111-1111-4111-8111-111111111111', occurredAt: '2026-01-01T00:00:00Z', correlationId: 'corr-1', source: 'payment-service', version: 1, ...headers },
  ...over,
});

describe('PaymentEventConsumer failure classification and replay logging', () => {
  let logs: string[];
  const capture = (level: 'log' | 'warn' | 'error') => vi.spyOn(Logger.prototype, level).mockImplementation((m: unknown) => void logs.push(`${level}: ${String(m)}`));
  const build = (apply: (...a: unknown[]) => Promise<unknown>) => {
    let handler!: (e: EventEnvelope) => Promise<void>;
    const bus = { subscribe: vi.fn(async (sub: { handler: typeof handler }) => { handler = sub.handler; return { close: async () => undefined }; }) };
    const consumer = new PaymentEventConsumer({ applyPaymentEvent: apply } as never, bus as never);
    return { start: () => consumer.onApplicationBootstrap().then(() => handler) };
  };
  beforeEach(() => {
    logs = [];
    capture('log');
    capture('warn');
    capture('error');
  });
  afterEach(() => vi.restoreAllMocks());

  it('a malformed payload is a PermanentEventFailure (never retried)', async () => {
    const handler = await build(vi.fn()).start();
    await expect(handler(envelope({ payload: { paymentId: 1 } }))).rejects.toBeInstanceOf(PermanentEventFailure);
    expect(logs.join('\n')).toContain('payment_event_dead_letter event=e1111111');
    expect(logs.join('\n')).toContain('classification=permanent reason=malformed_payload');
  });

  it('an identifier PostgreSQL refuses (SQLSTATE class 22) is permanent: retrying cannot change it', async () => {
    const dbError = Object.assign(new Error(`invalid input syntax for type uuid: "${SECRET}"`), { code: '22P02' });
    const handler = await build(vi.fn().mockRejectedValue(dbError)).start();
    const failure = await handler(envelope()).catch((e) => e);
    expect(failure).toBeInstanceOf(PermanentEventFailure);
    expect((failure as PermanentEventFailure).reason).toBe('invalid_identifier');
    const text = logs.join('\n');
    expect(text).toContain('payment_event_processing_failure');
    expect(text).toContain(`paymentRequestId=${PRID}`);
    expect(text).toContain('classification=permanent');
    expect(text).not.toContain(SECRET); // neither the DB error's message nor the payload reaches the log
  });

  it.each([
    ['a lost connection', Object.assign(new Error('Connection terminated unexpectedly'), { code: '57P01' })],
    ['a deadlock', Object.assign(new Error('deadlock detected'), { code: '40P01' })],
    ['an unclassified error', new Error('boom')],
  ])('%s is rethrown as it is (transient: the bus retries it a bounded number of times)', async (_name, error) => {
    const handler = await build(vi.fn().mockRejectedValue(error)).start();
    const failure = await handler(envelope({}, { retryCount: 2 })).catch((e) => e);
    expect(failure).toBe(error);
    expect(failure).not.toBeInstanceOf(PermanentEventFailure);
    const text = logs.join('\n');
    expect(text).toContain('classification=transient retry=2');
    expect(text).toContain('correlationId=corr-1');
    expect(text).not.toContain('Connection terminated unexpectedly'); // error messages are not logged, only the error class name
  });

  it('a first delivery, a retry and a replay all go through applyPaymentEvent with the same event id, facts and correlation id', async () => {
    const apply = vi.fn().mockResolvedValue({ outcome: 'applied', detail: null, firstDelivery: true });
    const handler = await build(apply).start();
    await handler(envelope());
    await handler(envelope({}, { retryCount: 1 }));
    await handler(envelope({}, { replayCount: 1 }));
    expect(apply).toHaveBeenCalledTimes(3);
    const [first, retry, replayed] = apply.mock.calls as Array<[string, Record<string, unknown>, { correlationId: string; cause: { type: string; id: string } }]>;
    for (const call of [first, retry, replayed]) {
      expect(call[0]).toBe('e1111111-1111-4111-8111-111111111111');
      expect(call[1]).toMatchObject({ paymentRequestId: PRID, currency: 'TND', amount: 1000, paymentId: 'p-1' });
      expect(call[2].correlationId).toBe('corr-1');
      expect(call[2].cause).toEqual({ type: 'payment_event', id: 'e1111111-1111-4111-8111-111111111111' });
    }
  });

  it('falls back to the existing event-derived correlation id when the message carries none', async () => {
    const apply = vi.fn().mockResolvedValue({ outcome: 'applied', detail: null, firstDelivery: true });
    const handler = await build(apply).start();
    await handler(envelope({}, { correlationId: undefined, replayCount: 1 }));
    expect(apply.mock.calls[0]![2].correlationId).toBe('event:e1111111-1111-4111-8111-111111111111');
  });

  it.each([
    ['applied', 'payment_event_applied', 'payment_event_replay_succeeded'],
    ['ignored', 'payment_event_ignored', 'payment_event_replay_ignored'],
    ['conflict', 'payment_event_conflict', 'payment_event_replay_conflict'],
    ['deferred', 'payment_event_deferred', 'payment_event_replay_deferred'],
  ])('%s outcome: %s normally, %s when the delivery is an operator replay', async (outcome, normal, replayed) => {
    const apply = vi.fn().mockResolvedValue({ outcome, detail: outcome === 'applied' ? null : 'some_detail', firstDelivery: true });
    const handler = await build(apply).start();
    await handler(envelope());
    expect(logs.join('\n')).toContain(`${normal} event=e1111111`);
    logs.length = 0;
    await handler(envelope({}, { replayCount: 2 }));
    const text = logs.join('\n');
    expect(text).toContain(`${replayed} event=e1111111`);
    expect(text).toContain('replays=2');
    expect(text).toContain(`paymentRequestId=${PRID}`);
    expect(text).not.toContain(SECRET);
  });

  it('a replay of an event whose receipt already exists is logged as a duplicate, whatever outcome was recorded, and is not reported as a success', async () => {
    const apply = vi.fn().mockResolvedValue({ outcome: 'applied', detail: null, firstDelivery: false });
    const handler = await build(apply).start();
    await handler(envelope({}, { replayCount: 1 }));
    const text = logs.join('\n');
    expect(text).toContain('payment_event_replay_duplicate event=e1111111');
    expect(text).toContain('recordedOutcome=applied');
    expect(text).not.toContain('payment_event_replay_succeeded');
  });

  it('a replayed message that is still malformed is logged as replay_rejected and stays a permanent failure', async () => {
    const handler = await build(vi.fn()).start();
    await expect(handler(envelope({ payload: {} }, { replayCount: 1 }))).rejects.toBeInstanceOf(PermanentEventFailure);
    expect(logs.join('\n')).toContain('payment_event_replay_rejected event=e1111111');
  });
});

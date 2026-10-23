import { Logger } from '@nestjs/common';
import { InMemoryEventBus, PermanentEventFailure, getRequestContext, type EventEnvelope, type HandlerTrust } from '@nawara/service-kit';
import type { TrustedPaymentEnvelope } from './payment-event-origin.js';
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
  headers: { eventId: 'e1111111-1111-4111-8111-111111111111', occurredAt: '2026-01-01T00:00:00Z', correlationId: 'corr-0001', source: 'payment-service', version: 1, ...headers },
  ...over,
});

describe('PaymentEventConsumer failure classification and replay logging', () => {
  let logs: string[];
  // V2 A12.4.3: a line is its message, then its structured fields and the log context's correlation id, as `key=value`.
  const capture = (level: 'log' | 'warn' | 'error') =>
    vi.spyOn(Logger.prototype, level).mockImplementation((m: unknown, ...rest: unknown[]) => {
      const fields = { ...(rest.find((r) => typeof r === 'object' && r !== null) as Record<string, unknown> | undefined), correlationId: getRequestContext()?.correlationId };
      logs.push(`${level}: ${String(m)} ${Object.entries(fields).map(([k, v]) => `${k}=${String(v)}`).join(' ')}`);
    });
  /**
   * The consumer behind a fake bus. Core V2 S1e-2: its subscription is strict, so the handler is called here as the RabbitMQ bus calls it
   * after accepting a delivery: with the trust of a verified original built from the delivery's own published values (what the kit
   * passes for a broker-verified original). The origin store is a fake recorder.
   */
  const verifiedOriginal = (e: EventEnvelope): HandlerTrust => {
    const f = <T>(v: T | undefined) => (v === undefined ? ({ available: false, reason: 'absent' } as const) : ({ available: true, value: v, from: 'verified_delivery' } as const));
    return {
      decision: 'accept', basis: 'verified_original',
      origin: { from: 'verified_delivery', source: e.headers.source, eventId: e.id, name: e.name, routingKey: e.name, producerUserId: 'payment-service', occurredAt: f(e.headers.occurredAt), version: f(e.headers.version), correlationId: f(e.headers.correlationId) },
    };
  };
  const build = (apply: (...a: unknown[]) => Promise<unknown>, origins: { recordVerified: (t: TrustedPaymentEnvelope) => Promise<string>; find: (id: string) => Promise<TrustedPaymentEnvelope | undefined> } = { recordVerified: async () => 'recorded', find: async () => undefined }) => {
    let handler!: (e: EventEnvelope, trust?: HandlerTrust) => Promise<void>;
    const bus = { subscribe: vi.fn(async (sub: { handler: typeof handler }) => { handler = sub.handler; return { close: async () => undefined }; }) };
    const consumer = new PaymentEventConsumer({ applyPaymentEvent: apply } as never, bus as never, {} as never, origins as never);
    return {
      start: () => consumer.onApplicationBootstrap().then(() => (e: EventEnvelope, trust: HandlerTrust | null = verifiedOriginal(e)) => handler(e, trust ?? undefined)),
      bus,
    };
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
    expect(logs.join('\n')).toContain('payment_event_dead_letter classification=permanent reason=malformed_payload eventId=e1111111');
  });

  it('V2 A3M.2: an unsupported version is a permanent failure before any parsing, receipt or business decision', async () => {
    const apply = vi.fn();
    const handler = await build(apply).start();
    for (const version of [2, 0, Number.NaN]) {
      const err = await handler(envelope({}, { version })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentEventFailure);
      expect((err as PermanentEventFailure).reason).toBe('unsupported_version');
    }
    // even a malformed payload at an unsupported version is refused for its version: the payload is never interpreted
    const err = await handler(envelope({ payload: { paymentId: 1 } }, { version: 2 })).catch((e: unknown) => e);
    expect((err as PermanentEventFailure).reason).toBe('unsupported_version');
    expect(apply).not.toHaveBeenCalled(); // no receipt, no state change
    expect(logs.join('\n')).toContain('payment_event_dead_letter classification=permanent reason=unsupported_version version=2 eventId=e1111111');
    expect(logs.join('\n')).toContain('reason=unsupported_version version=- eventId=e1111111');
    await expect(handler(envelope({}, { version: 2, replayCount: 1 }))).rejects.toBeInstanceOf(PermanentEventFailure);
    expect(logs.join('\n')).toContain('payment_event_replay_rejected replays=1 classification=permanent reason=unsupported_version');
  });

  it('V2 A3M.3 (G11): a source other than payment-service is a permanent failure before any parsing, receipt or decision', async () => {
    const apply = vi.fn();
    const handler = await build(apply).start();
    for (const source of ['evil-service', '', 'billing-service']) {
      const err = await handler(envelope({}, { source })).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(PermanentEventFailure);
      expect((err as PermanentEventFailure).reason).toBe('wrong_source');
    }
    expect(apply).not.toHaveBeenCalled(); // no receipt, no state change
    expect(logs.join('\n')).toContain('payment_event_dead_letter classification=permanent reason=wrong_source eventId=e1111111');
    expect(logs.join('\n')).not.toContain('evil-service'); // the asserted header is never echoed
  });

  it('V2 A3M.2: version 1, the only version Payment publishes, still reaches applyPaymentEvent', async () => {
    const apply = vi.fn(async () => ({ outcome: 'applied', detail: null, firstDelivery: true, subscription: null }));
    const handler = await build(apply).start();
    await handler(envelope());
    expect(apply).toHaveBeenCalledTimes(1);
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
    expect(text).toContain('correlationId=corr-0001');
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
      expect(call[2].correlationId).toBe('corr-0001');
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
    expect(logs.join('\n')).toContain(`${normal}${outcome === 'applied' ? '' : ' detail=some_detail'}${outcome === 'conflict' ? ' — needs manual review' : ''}${outcome === 'deferred' ? ' — the reconciler will complete it' : ''} eventId=e1111111`);
    logs.length = 0;
    await handler(envelope({}, { replayCount: 2 }));
    const text = logs.join('\n');
    expect(text).toContain(`${replayed} replays=2`);
    expect(text).toContain('eventId=e1111111');
    expect(text).toContain(`paymentRequestId=${PRID}`);
    expect(text).not.toContain(SECRET);
  });

  it('a replay of an event whose receipt already exists is logged as a duplicate, whatever outcome was recorded, and is not reported as a success', async () => {
    const apply = vi.fn().mockResolvedValue({ outcome: 'applied', detail: null, firstDelivery: false });
    const handler = await build(apply).start();
    await handler(envelope({}, { replayCount: 1 }));
    const text = logs.join('\n');
    expect(text).toContain('payment_event_replay_duplicate replays=1 recordedOutcome=applied eventId=e1111111');
    expect(text).toContain('recordedOutcome=applied');
    expect(text).not.toContain('payment_event_replay_succeeded');
  });

  it('a replayed message that is still malformed is logged as replay_rejected and stays a permanent failure', async () => {
    const handler = await build(vi.fn()).start();
    await expect(handler(envelope({ payload: {} }, { replayCount: 1 }))).rejects.toBeInstanceOf(PermanentEventFailure);
    expect(logs.join('\n')).toContain('payment_event_replay_rejected replays=1 classification=permanent reason=malformed_payload eventId=e1111111');
  });
  it('V2 A12.4.3: a hostile correlation header is never logged; the business correlation id is exactly what it was', async () => {
    const apply = vi.fn().mockResolvedValue({ outcome: 'applied', detail: null, firstDelivery: true });
    const handler = await build(apply).start();
    const hostile = `corr\n${SECRET} injected`;
    await handler(envelope({}, { correlationId: hostile }));
    expect(apply.mock.calls[0]![2].correlationId).toBe(hostile); // recorded with the receipt as before: logging changes nothing
    const text = logs.join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).toContain('correlationId=event:e1111111-1111-4111-8111-111111111111'); // the validated fallback
  });

  it('V2 A12.4.3: a hostile event id or payment request id is never logged; the delivery is processed exactly as before', async () => {
    const apply = vi.fn().mockRejectedValue(Object.assign(new Error(`invalid input syntax for type uuid: "${SECRET}"`), { code: '22P02' }));
    const handler = await build(apply).start();
    const hostileId = `x y ${SECRET}`;
    const event = envelope({ id: hostileId, payload: { ...envelope().payload, paymentRequestId: `not-a-uuid ${SECRET}` } });
    const failure = await handler(event).catch((e) => e);
    expect(failure).toBeInstanceOf(PermanentEventFailure);
    expect(apply.mock.calls[0]![0]).toBe(hostileId);
    const text = logs.join('\n');
    expect(text).not.toContain(SECRET);
    expect(text).toContain('eventId=[invalid]');
    expect(text).toContain('paymentRequestId=[invalid]');
    expect(text).toContain('correlationId=corr-0001'); // the event's valid correlation id is the log context's
  });

  it('V2 A12.4.3: a valid delivery logs inside its restored context, with useful validated identifiers', async () => {
    const apply = vi.fn().mockResolvedValue({ outcome: 'applied', detail: null, firstDelivery: true });
    const handler = await build(apply).start();
    await handler(envelope({}, { correlationId: 'corr-12345678' }));
    expect(logs.join('\n')).toContain(`payment_event_applied eventId=e1111111-1111-4111-8111-111111111111 eventType=payment.cancelled paymentRequestId=${PRID} correlationId=corr-12345678`);
  });
});

describe('PaymentEventConsumer provenance wiring (Core V2 S1b, observe-only)', () => {
  it('subscribes the same queue and bindings, with a provenance store and the catalog as the only event-owner resolver', async () => {
    let sub!: { queue: string; bindings: string[]; provenance?: { ownerOf(name: string): string | undefined; store: unknown } };
    const bus = { subscribe: vi.fn(async (s: typeof sub) => { sub = s; return { close: async () => undefined }; }) };
    await new PaymentEventConsumer({} as never, bus as never, { tx: vi.fn() } as never, {} as never).onApplicationBootstrap();
    expect(sub.queue).toBe('billing.payment-events');
    expect(sub.bindings).toEqual(['payment.succeeded', 'payment.failed', 'payment.cancelled', 'payment.expired']); // payment.created still not bound
    expect(sub.provenance?.store).toBeDefined();
    for (const name of sub.bindings) expect(sub.provenance?.ownerOf(name)).toBe('payment-service');
    for (const name of ['payment.created', 'refund.succeeded', 'invoice.created', 'audit.payment_succeeded']) expect(sub.provenance?.ownerOf(name)).toBeUndefined();
  });
});

describe('Core V2 S1e-2: Billing is verified-only (ADR-0057 §13.5, "S0-C6")', () => {
  const STORED: TrustedPaymentEnvelope = {
    eventId: 'e1111111-1111-4111-8111-111111111111', name: 'payment.cancelled', source: 'payment-service', version: 1, occurredAt: '2026-01-01T00:00:00.000Z', correlationId: 'corr-original',
  };
  const replayTrust = (over: Partial<Extract<HandlerTrust, { decision: 'accept' }>['origin']> = {}): HandlerTrust => ({
    decision: 'accept', basis: 'verified_replay',
    origin: {
      from: 'stored_verified_observation', source: 'payment-service', eventId: STORED.eventId, name: 'payment.cancelled', routingKey: 'payment.cancelled', producerUserId: 'payment-service',
      occurredAt: { available: false, reason: 'not_stored' }, version: { available: false, reason: 'not_stored' }, correlationId: { available: false, reason: 'not_stored' }, ...over,
    },
  });
  const consumerWith = (apply: ReturnType<typeof vi.fn>, origins: { recordVerified?: (t: TrustedPaymentEnvelope) => Promise<string>; find?: (id: string) => Promise<TrustedPaymentEnvelope | undefined> } = {}) => {
    let handler!: (e: EventEnvelope, trust?: HandlerTrust) => Promise<void>;
    let sub!: { enforcement?: { mode: string; refusedBody?: string }; provenance?: unknown };
    const bus = { subscribe: vi.fn(async (s: typeof sub & { handler: typeof handler }) => { sub = s; handler = s.handler; return { close: async () => undefined }; }) };
    const consumer = new PaymentEventConsumer({ applyPaymentEvent: apply } as never, bus as never, {} as never, { recordVerified: origins.recordVerified ?? (async () => 'recorded'), find: origins.find ?? (async () => STORED) } as never);
    return { start: async () => { await consumer.onApplicationBootstrap(); return { handler, sub }; } };
  };
  const event = (headers: Partial<EventEnvelope['headers']> = {}): EventEnvelope => ({
    id: STORED.eventId, name: 'payment.cancelled',
    payload: { paymentId: 'p-1', producer: 'billing-service', paymentRequestId: PRID, sourceType: 'invoice', sourceId: 'inv-1', payer: { type: 'user', id: 'u' }, seller: { type: 'organization', id: 'o' }, organizationId: 'o', currency: 'TND', revision: 0, amount: 1000 },
    headers: { eventId: STORED.eventId, occurredAt: '2030-12-31T23:59:59.000Z', correlationId: 'corr-forged', source: 'payment-service', version: 1, ...headers },
  });
  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('subscribes with a STRICT policy (never compatibility, no unenforced mode), and the in-memory bus refuses it: Billing then fails to start', async () => {
    const { sub } = await consumerWith(vi.fn()).start();
    expect(sub.enforcement).toMatchObject({ mode: 'strict', refusedBody: 'original_reviewed' });
    expect(Object.isFrozen(sub.enforcement)).toBe(true);
    await expect(new PaymentEventConsumer({} as never, new InMemoryEventBus(), {} as never, {} as never).onApplicationBootstrap()).rejects.toThrow(/needs the RabbitMQ bus/);
  });

  it.each([
    ['no trust decision at all', undefined],
    ['a compatibility (unverified) acceptance', { decision: 'compatibility', basis: 'unverified_original', verified: false } as HandlerTrust],
  ])('%s never reaches applyPaymentEvent (permanent untrusted_no_decision)', async (_t, trust) => {
    const apply = vi.fn();
    const { handler } = await consumerWith(apply).start();
    const err = await handler(event(), trust).catch((e: unknown) => e);
    expect((err as PermanentEventFailure).reason).toBe('untrusted_no_decision');
    expect(apply).not.toHaveBeenCalled();
  });

  it('a verified REPLAY takes settledAt, version and correlation id from the RECORDED original, never from its own headers', async () => {
    const apply = vi.fn().mockResolvedValue({ outcome: 'applied', detail: null, firstDelivery: true, subscription: null });
    const { handler } = await consumerWith(apply).start();
    await handler(event({ occurredAt: '2030-12-31T23:59:59.000Z', correlationId: 'corr-forged', version: 7 }), replayTrust());
    expect(apply).toHaveBeenCalledTimes(1);
    const [eventId, , ctx, settledAt] = apply.mock.calls[0]! as [string, unknown, { correlationId: string; cause: { id: string } }, Date];
    expect(eventId).toBe(STORED.eventId);
    expect(settledAt.toISOString()).toBe(STORED.occurredAt);
    expect(ctx.correlationId).toBe('corr-original');
  });

  it('a verified replay with no recorded original values is refused (untrusted_origin_unavailable): nothing is invented', async () => {
    const apply = vi.fn();
    for (const find of [async () => undefined, async () => ({ ...STORED, name: 'payment.succeeded' }), async () => ({ ...STORED, source: 'billing-service' })]) {
      const { handler } = await consumerWith(apply, { find }).start();
      const err = await handler(event(), replayTrust()).catch((e: unknown) => e);
      expect((err as PermanentEventFailure).reason).toBe('untrusted_origin_unavailable');
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it('a verified original whose values contradict the recorded ones is refused (untrusted_origin_conflict), never overwriting them', async () => {
    const apply = vi.fn();
    const recordVerified = vi.fn(async () => 'contradicts');
    const { handler } = await consumerWith(apply, { recordVerified }).start();
    const err = await handler(event(), verifiedOriginalOf(event())).catch((e: unknown) => e);
    expect((err as PermanentEventFailure).reason).toBe('untrusted_origin_conflict');
    expect(apply).not.toHaveBeenCalled();
  });

  it('a verified original is recorded (its own published values) BEFORE applyPaymentEvent; an unsupported version is refused and records nothing', async () => {
    const order: string[] = [];
    const apply = vi.fn(async () => (order.push('apply'), { outcome: 'applied', detail: null, firstDelivery: true, subscription: null }));
    const recordVerified = vi.fn(async (t: TrustedPaymentEnvelope) => (order.push(`record:${t.occurredAt}:${t.correlationId}`), 'recorded'));
    const { handler } = await consumerWith(apply, { recordVerified }).start();
    await handler(event({ occurredAt: '2026-02-02T02:02:02.002Z', correlationId: 'corr-x' }), verifiedOriginalOf(event({ occurredAt: '2026-02-02T02:02:02.002Z', correlationId: 'corr-x' })));
    expect(order).toEqual(['record:2026-02-02T02:02:02.002Z:corr-x', 'apply']);
    const err = await handler(event({ version: 2 }), verifiedOriginalOf(event({ version: 2 }))).catch((e: unknown) => e);
    expect((err as PermanentEventFailure).reason).toBe('unsupported_version');
    expect(recordVerified).toHaveBeenCalledTimes(1);
  });

  it('a verified original missing the settlement instant or the version is malformed (permanent), never defaulted', async () => {
    const apply = vi.fn();
    const { handler } = await consumerWith(apply).start();
    for (const headers of [{ occurredAt: undefined }, { occurredAt: 'yesterday' }, { occurredAt: '2026-01-01T00:00:00+01:00' }, { version: undefined }]) {
      const e = event(headers as never);
      const err = await handler(e, verifiedOriginalOf(e)).catch((x: unknown) => x);
      expect((err as PermanentEventFailure).reason).toBe('malformed_payload');
    }
    expect(apply).not.toHaveBeenCalled();
  });

  it('a database failure while reading or recording the origin is TRANSIENT (retried by the bus), with no financial call', async () => {
    const apply = vi.fn();
    const failing = new Error('connection lost');
    const { handler } = await consumerWith(apply, { find: async () => { throw failing; }, recordVerified: async () => { throw failing; } }).start();
    expect(await handler(event(), replayTrust()).catch((e: unknown) => e)).toBe(failing);
    expect(await handler(event(), verifiedOriginalOf(event())).catch((e: unknown) => e)).toBe(failing);
    expect(apply).not.toHaveBeenCalled();
  });
});

/** The trust the kit passes for a broker-verified original: its own published values. */
function verifiedOriginalOf(e: EventEnvelope): HandlerTrust {
  const f = <T>(v: T | undefined) => (v === undefined ? ({ available: false, reason: 'absent' } as const) : ({ available: true, value: v, from: 'verified_delivery' } as const));
  return {
    decision: 'accept', basis: 'verified_original',
    origin: { from: 'verified_delivery', source: 'payment-service', eventId: e.id, name: e.name, routingKey: e.name, producerUserId: 'payment-service', occurredAt: f(e.headers.occurredAt), version: f(e.headers.version), correlationId: f(e.headers.correlationId) },
  };
}

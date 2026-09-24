import { Logger, type LoggerService } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryEventBus, runWithRequestContext, type EventBus as KitEventBus, type EventEnvelope } from '@nawara/service-kit';
import { AUTH_EVENT_SOURCE, AUTH_EVENT_VERSION, EventsPublisherService, MAX_PENDING_PUBLISHES, SHUTDOWN_DRAIN_TIMEOUT_MS } from './events-publisher.service.js';

/**
 * Stage 16.2: Auth's publisher emits the canonical kit envelope (ADR-0046 rule 17) through the kit bus, unchanged payloads, still
 * fire-and-forget. The real-broker proof (the kit consumer accepts these events, persistent, confirmed) is
 * `test/events-real-broker.e2e-spec.ts`.
 */

/** A kit bus whose publishes are held until the test settles them. */
class ControlledBus implements KitEventBus {
  published: EventEnvelope[] = [];
  started: EventEnvelope[] = [];
  closed = false;
  private waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  publish(event: EventEnvelope): Promise<void> {
    this.started.push(event);
    return new Promise<void>((resolve, reject) => this.waiters.push({ resolve: () => { this.published.push(event); resolve(); }, reject }));
  }
  settleNext(error?: unknown) {
    const w = this.waiters.shift()!;
    if (error) w.reject(error); else w.resolve();
  }
  async subscribe(): Promise<{ close(): Promise<void> }> { throw new Error('not used'); }
  async close() { this.closed = true; }
}

class CapturingLogger implements LoggerService {
  lines: string[] = [];
  private push = (...a: unknown[]) => { this.lines.push(a.map(String).join(' ')); };
  log = this.push; error = this.push; warn = this.push; debug = this.push; verbose = this.push; fatal = this.push;
}

const flush = () => new Promise((r) => setImmediate(r));

// Representative payloads, with the exact shapes the Auth call sites publish (sensitive values are recognisable test markers).
const CODE = '482913';
const EMAIL = 'leak-probe@example.test';
const PHONE = '+21698765432';
const IP = '203.0.113.77';
const PAYLOADS: Record<string, Record<string, unknown>> = {
  'admin.operator_code_issued': { userId: 'u-1', channel: 'email', destination: EMAIL, code: CODE, expiresAt: '2026-09-24T10:05:00.000Z', timestamp: '2026-09-24T10:00:00.000Z' },
  'member.contact_verification_requested': { userId: 'u-2', channel: 'phone', destination: PHONE, code: CODE, expiresAt: '2026-09-24T10:15:00.000Z' },
  'admin.owner_login_from_new_device': { userId: 'u-3', channel: 'email', destination: EMAIL, ipAddress: IP, timestamp: '2026-09-24T10:00:00.000Z' },
  'admin.owner_recovery_requested': { userId: 'u-3', channel: 'phone', destination: PHONE, availableAt: '2026-09-25T10:00:00.000Z', ipAddress: IP, timestamp: '2026-09-24T10:00:00.000Z' },
  'membership.approved': { userId: 'u-4', organizationId: 'o-1', channel: 'email', destination: EMAIL, timestamp: '2026-09-24T10:00:00.000Z' },
  'user.registered': { userId: 'u-5', role: 'student', organizationId: 'o-1', timestamp: '2026-09-24T10:00:00.000Z' },
};

describe('EventsPublisherService: canonical kit envelope (Stage 16.2)', () => {
  let logger: CapturingLogger;
  beforeEach(() => {
    logger = new CapturingLogger();
    Logger.overrideLogger(logger);
  });
  afterEach(() => {
    Logger.overrideLogger(false);
    vi.useRealTimers();
  });

  it('publishes the canonical envelope: one id (envelope = eventId header), name = routing key, source auth-service, version 1, UTC occurredAt', async () => {
    const bus = new InMemoryEventBus();
    const pub = new EventsPublisherService(bus);
    const before = Date.now();
    pub.publish('admin.operator_code_issued', PAYLOADS['admin.operator_code_issued']);
    await flush();
    expect(bus.published).toHaveLength(1);
    const e = bus.published[0];
    expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(e.headers.eventId).toBe(e.id);
    expect(e.name).toBe('admin.operator_code_issued');
    expect(e.headers.source).toBe('auth-service');
    expect(AUTH_EVENT_SOURCE).toBe('auth-service');
    expect(e.headers.version).toBe(1);
    expect(AUTH_EVENT_VERSION).toBe(1);
    expect(e.headers.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // ISO-8601 UTC, as the kit relay writes it
    const at = Date.parse(e.headers.occurredAt);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(Object.keys(e.headers).sort()).toEqual(['correlationId', 'eventId', 'occurredAt', 'source', 'version']); // nothing Notification-specific
  });

  it('carries the request correlation id when there is one, and none outside a request', async () => {
    const bus = new InMemoryEventBus();
    const pub = new EventsPublisherService(bus);
    runWithRequestContext({ requestId: 'req-00000001', correlationId: 'corr-0000001' }, () => pub.publish('membership.approved', PAYLOADS['membership.approved']));
    pub.publish('membership.approved', PAYLOADS['membership.approved']);
    await flush();
    expect(bus.published.map((e) => e.headers.correlationId)).toEqual(['corr-0000001', undefined]);
  });

  it.each(Object.keys(PAYLOADS))('%s: the payload is published unchanged (no field added, removed, renamed or rewritten)', async (name) => {
    const bus = new InMemoryEventBus();
    const pub = new EventsPublisherService(bus);
    const original = structuredClone(PAYLOADS[name]);
    pub.publish(name, PAYLOADS[name]);
    await flush();
    const e = bus.published[0];
    expect(e.payload).toStrictEqual(original);
    expect(JSON.stringify(e.payload)).toBe(JSON.stringify(original)); // same keys, same order: the bytes the broker receives
  });

  it('every publish gets its own id; source, name and version are stable', async () => {
    const bus = new InMemoryEventBus();
    const pub = new EventsPublisherService(bus);
    for (let i = 0; i < 500; i++) pub.publish('membership.revoked', { userId: `u-${i}` });
    await vi.waitFor(() => expect(bus.published).toHaveLength(500));
    expect(new Set(bus.published.map((e) => e.id)).size).toBe(500);
    expect(new Set(bus.published.map((e) => `${e.name}|${e.headers.source}|${e.headers.version}`))).toEqual(new Set(['membership.revoked|auth-service|1']));
  });

  it('fire-and-forget: publish returns at once while the broker has not confirmed, and publishes run one at a time, in call order', async () => {
    const bus = new ControlledBus();
    const pub = new EventsPublisherService(bus);
    expect(pub.publish('user.registered', { userId: 'a' })).toBeUndefined();
    pub.publish('user.registered', { userId: 'b' });
    await flush();
    expect(bus.started.map((e) => e.payload.userId)).toEqual(['a']); // the second waits for the first: one connection, one confirm channel
    bus.settleNext();
    await flush();
    expect(bus.started.map((e) => e.payload.userId)).toEqual(['a', 'b']);
    bus.settleNext();
    await flush();
    expect(bus.published.map((e) => e.payload.userId)).toEqual(['a', 'b']);
  });

  it('a failed publish never reaches the caller: it is logged with id, name and failure class only (no payload), and the next event still goes', async () => {
    const bus = new ControlledBus();
    const pub = new EventsPublisherService(bus);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      expect(() => pub.publish('admin.operator_code_issued', PAYLOADS['admin.operator_code_issued'])).not.toThrow();
      pub.publish('membership.approved', PAYLOADS['membership.approved']);
      await flush();
      const failed = bus.started[0];
      const err = Object.assign(new Error(`broker said no about ${EMAIL} ${CODE} amqp://guest:guest@broker`), { code: 'ECONNREFUSED' });
      bus.settleNext(err);
      await flush();
      bus.settleNext();
      await flush();
      expect(bus.published.map((e) => e.name)).toEqual(['membership.approved']);
      const line = logger.lines.find((l) => l.includes('event_publish_failure'))!;
      expect(line).toContain(`eventId=${failed.id} name=admin.operator_code_issued`);
      expect(line).toContain('code=ECONNREFUSED');
      const all = logger.lines.join('\n');
      for (const secret of [CODE, EMAIL, PHONE, IP, 'guest:guest', 'broker said no']) expect(all).not.toContain(secret);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it(`holds at most ${MAX_PENDING_PUBLISHES} unconfirmed events: past it an event is dropped and logged, never buffered without bound`, async () => {
    const bus = new ControlledBus();
    const pub = new EventsPublisherService(bus);
    for (let i = 0; i < MAX_PENDING_PUBLISHES + 3; i++) pub.publish('member.contact_verification_requested', PAYLOADS['member.contact_verification_requested']);
    const dropped = logger.lines.filter((l) => l.includes('event_publish_dropped') && l.includes('reason=backlog_full'));
    expect(dropped).toHaveLength(3);
    expect(logger.lines.join('\n')).not.toContain(CODE);
    expect(logger.lines.join('\n')).not.toContain(PHONE);
  });

  it('shutdown waits for queued events to be confirmed, then closes the bus', async () => {
    const bus = new ControlledBus();
    const pub = new EventsPublisherService(bus);
    pub.publish('user.registered', { userId: 'a' });
    pub.publish('user.registered', { userId: 'b' });
    const done = pub.onApplicationShutdown();
    await flush();
    expect(bus.closed).toBe(false);
    bus.settleNext();
    await flush();
    bus.settleNext();
    await done;
    expect(bus.published.map((e) => e.payload.userId)).toEqual(['a', 'b']);
    expect(bus.closed).toBe(true);
    pub.publish('user.registered', { userId: 'late' }); // after close: dropped and logged, never a new connection
    await flush();
    expect(bus.started).toHaveLength(2);
    expect(logger.lines.some((l) => l.includes('event_publish_dropped') && l.includes('reason=shutting_down'))).toBe(true);
  });

  it(`shutdown is bounded (${SHUTDOWN_DRAIN_TIMEOUT_MS} ms) when the broker never confirms: the bus is closed and the queued events are dropped, not published afterwards`, async () => {
    vi.useFakeTimers();
    const bus = new ControlledBus();
    const pub = new EventsPublisherService(bus);
    pub.publish('user.registered', { userId: 'stuck' });
    pub.publish('user.registered', { userId: 'queued' });
    const done = pub.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DRAIN_TIMEOUT_MS);
    await done;
    expect(bus.closed).toBe(true);
    expect(logger.lines.some((l) => l.includes('event_publish_drain_timeout pending=2'))).toBe(true);
    bus.settleNext(new Error('channel closed')); // the stuck publish fails once the bus is closed
    await vi.advanceTimersByTimeAsync(0);
    expect(bus.started.map((e) => e.payload.userId)).toEqual(['stuck']); // the queued one never started
    expect(logger.lines.some((l) => l.includes('event_publish_dropped') && l.includes('reason=shutting_down'))).toBe(true);
  });
});

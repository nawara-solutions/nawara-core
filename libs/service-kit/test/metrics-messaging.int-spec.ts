import { randomBytes, randomUUID } from 'node:crypto';
import amqp from 'amqplib';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { PermanentEventFailure, PublisherConfirmTimeoutError, RabbitMqEventBus, type EventEnvelope, type NoticeLevel } from '../src/index.js';
import { messagingMetrics } from '../src/metrics/messaging-metrics.js';
import { BoundedMetrics } from '../src/metrics/metrics.js';
import { BrokerProxy } from '../src/testing/index.js';
import { describeWithEnv } from './support/env.js';
import { seriesOf } from './support/metrics.js';

/**
 * V2 A12.3, against a REAL RabbitMQ: every publish and consume outcome reaches the messaging metrics with bounded labels only (the
 * consumer's own queue and a closed outcome); the notices are the same with and without the observer; and no value a hostile
 * publisher controls (message id, type / routing key, headers, payload, an exception message) ever reaches the exposition.
 */
const uniq = () => randomBytes(4).toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await sleep(25);
  }
};
const M = {
  uuid: randomUUID(),
  org: `org-${randomUUID()}`,
  user: `usr-${randomUUID()}`,
  email: 'hostile.marker@example.org',
  token: 'eyJhbGciOiJIUzI1NiJ9.SE9TVElMRVRPS0VO.c2ln',
  requestId: 'req-HOSTILE-8812',
  correlationId: 'corr-HOSTILE-4471',
  routing: `probe.hostile${uniq()}`,
  auditType: `audit.x${randomUUID().replace(/-/g, '')}`,
  messageId: `mid-HOSTILE-${uniq()}`,
  exception: 'HOSTILE-EXCEPTION-TEXT-5521',
};
const envelope = (name: string, extra: Partial<EventEnvelope['headers']> = {}): EventEnvelope => ({
  id: randomUUID(),
  name,
  payload: { organizationId: M.org, userId: M.user, email: M.email, token: M.token },
  headers: { eventId: randomUUID(), occurredAt: new Date().toISOString(), correlationId: M.correlationId, source: 'probe', version: 1, ...extra },
});

describeWithEnv('messaging metrics (real RabbitMQ)', ['TEST_RABBITMQ_URL'], (env) => {
  const target = new URL(env.TEST_RABBITMQ_URL);
  let proxy: BrokerProxy;
  const closers: Array<() => Promise<unknown>> = [];
  beforeAll(async () => {
    proxy = new BrokerProxy({ host: target.hostname, port: Number(target.port || 5672) });
    await proxy.start();
  });
  afterAll(async () => {
    proxy.thaw();
    for (const c of closers.reverse()) await c().catch(() => undefined);
    await proxy.sever();
  });

  /** One messaging family per registry, shared by every bus (as MetricsHost does). */
  const families = new WeakMap<BoundedMetrics, ReturnType<typeof messagingMetrics>>();
  const observedBus = (opts: ConstructorParameters<typeof RabbitMqEventBus>[0], metrics: BoundedMetrics | 'none') => {
    const notices: Array<[NoticeLevel, string]> = [];
    const bus = new RabbitMqEventBus({ ...opts, onNotice: (m, l) => notices.push([l, m]) });
    if (metrics !== 'none') {
      if (!families.has(metrics)) families.set(metrics, messagingMetrics(metrics));
      bus.setObserver(families.get(metrics)!);
    }
    closers.push(() => bus.close());
    return { bus, notices };
  };

  it('publish: confirmed, confirm_timeout and failed, with a confirm-latency histogram', async () => {
    const m = new BoundedMetrics();
    const { bus } = observedBus({ url: proxy.url, exchange: `a12.ex${uniq()}`, confirmTimeoutMs: 400, connectTimeoutMs: 1500 }, m);
    await bus.publish(envelope('probe.ok'));
    proxy.freeze();
    await expect(bus.publish(envelope('probe.stalled'))).rejects.toBeInstanceOf(PublisherConfirmTimeoutError);
    proxy.thaw();
    const dead = observedBus({ url: 'amqp://127.0.0.1:1', connectTimeoutMs: 300 }, m);
    await expect(dead.bus.publish(envelope('probe.unreachable'))).rejects.toThrow();
    const body = (await m.render()).body;
    expect(body).toMatch(/^nawara_events_published_total\{outcome="confirmed"\} 1$/m);
    expect(body).toMatch(/^nawara_events_published_total\{outcome="confirm_timeout"\} 1$/m);
    expect(body).toMatch(/^nawara_events_published_total\{outcome="failed"\} 1$/m);
    expect(body).toMatch(/^nawara_event_publish_duration_seconds_count 3$/m);
  });

  it('consume: processed, retry, dead-lettered (permanent, retries exhausted, malformed), consumer up/lost/recovered; notices unchanged', async () => {
    const run = async (metrics: BoundedMetrics | 'none') => {
      const exchange = `a12.ex${uniq()}`;
      const queue = `a12.q${uniq()}`;
      const { bus, notices } = observedBus(
        { url: proxy.url, exchange, connectTimeoutMs: 500, retry: { maxRetries: 1, delayMs: 50 }, consumerReconnect: { baseDelayMs: 50, maxDelayMs: 200 } },
        metrics,
      );
      const seen: string[] = [];
      await bus.subscribe({
        queue,
        bindings: ['probe.#', 'audit.#'],
        handler: async (e) => {
          seen.push(e.name);
          if (e.name === 'probe.permanent') throw new PermanentEventFailure('not_a_valid_id');
          if (e.name === 'probe.transient') throw new Error(M.exception);
        },
      });
      const publisher = new RabbitMqEventBus({ url: env.TEST_RABBITMQ_URL, exchange });
      closers.push(() => publisher.close());
      await publisher.publish(envelope('probe.ok'));
      await publisher.publish(envelope('probe.permanent'));
      await publisher.publish(envelope('probe.transient'));
      await publisher.publish(envelope(M.routing));
      await publisher.publish({ ...envelope(M.auditType), id: M.messageId });
      // a malformed message straight onto the exchange: hostile type, id, headers and body
      const conn = await amqp.connect(env.TEST_RABBITMQ_URL);
      const ch = await conn.createConfirmChannel();
      ch.publish(exchange, 'probe.raw', Buffer.from(`{"email":"${M.email}"`), { messageId: M.messageId, type: `BAD ${M.uuid}`, headers: { correlationId: M.correlationId, 'x-request-id': M.requestId } });
      await ch.waitForConfirms();
      await conn.close();
      await waitFor(() => notices.filter(([, n]) => n.startsWith('event_dead_lettered')).length >= 3);
      await waitFor(() => seen.filter((n) => n === 'probe.ok' || n === M.routing || n === M.auditType).length >= 3);
      await proxy.sever();
      await waitFor(() => notices.some(([, n]) => n.startsWith('rabbitmq_consumer_lost')));
      await proxy.start();
      await waitFor(() => notices.some(([, n]) => n.startsWith('rabbitmq_consumer_recovered')));
      await sleep(100);
      const upWhileConsuming = metrics === 'none' ? '' : (await metrics.render()).body;
      // closed before the next run, so the next run's broker cut is not seen (and counted) by this bus too
      await publisher.close();
      await bus.close();
      return { queue, upWhileConsuming, notices: [...notices].filter(([, n]) => !n.startsWith('rabbitmq_connection_abandoned')) };
    };
    const m = new BoundedMetrics();
    const on = await run(m);
    const off = await run('none');
    // the same notice kinds (level and name) with and without the observer. Exact sequences are proven broker-free in
    // metrics-messaging-semantics.spec.ts; here a delivery unacknowledged at the broker cut may be redelivered (at least once) in either run.
    const kinds = (n: Array<[NoticeLevel, string]>) => [...new Set(n.map(([l, x]) => `${l}:${x.split(' ')[0]}`))].sort();
    expect(kinds(on.notices)).toEqual(kinds(off.notices));
    const body = (await m.render()).body;
    const q = on.queue;
    const count = (outcome: string) => Number(new RegExp(`^nawara_events_consumed_total\\{queue="${q.replace(/\./g, '\\.')}",outcome="${outcome}"\\} (\\d+)$`, 'm').exec(body)?.[1] ?? 0);
    // at least: a delivery unacknowledged at the broker cut may be redelivered and settled again
    expect(count('processed')).toBeGreaterThanOrEqual(3); // probe.ok, the hostile routing key, the audit.<x> name
    expect(count('retry_scheduled')).toBeGreaterThanOrEqual(1);
    expect(count('dead_lettered_permanent')).toBeGreaterThanOrEqual(1);
    expect(count('dead_lettered_retries_exhausted')).toBeGreaterThanOrEqual(1);
    expect(count('dead_lettered_malformed')).toBeGreaterThanOrEqual(1);
    expect(on.upWhileConsuming).toMatch(new RegExp(`^nawara_event_consumer_up\\{queue="${q.replace(/\./g, '\\.')}"\\} 1$`, 'm'));
    expect(body).toMatch(new RegExp(`^nawara_event_consumer_up\\{queue="${q.replace(/\./g, '\\.')}"\\} 0$`, 'm')); // closed
    expect(body).toMatch(new RegExp(`^nawara_event_consumer_losses_total\\{queue="${q.replace(/\./g, '\\.')}"\\} 1$`, 'm'));
    expect(body).toMatch(new RegExp(`^nawara_event_consumer_recoveries_total\\{queue="${q.replace(/\./g, '\\.')}"\\} 1$`, 'm'));
    expect(body).toMatch(/nawara_event_redeliveries_total|nawara_event_handler_duration_seconds_count/);
    // privacy: no hostile value anywhere in the exposition
    for (const [k, v] of Object.entries(M)) expect(body, k).not.toContain(v);
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    // only the code-defined queue and closed outcomes appear as labels
    const queues = new Set(seriesOf(body, 'nawara_events_consumed_total').map((s) => s.queue));
    expect([...queues]).toEqual([q]);
  });
});

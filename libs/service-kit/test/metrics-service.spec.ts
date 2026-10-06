import { describe, expect, it } from 'vitest';
import { InMemoryEventBus, MetricsHost, closedSet } from '../src/index.js';
import { messagingMetrics } from '../src/metrics/messaging-metrics.js';
import { BoundedMetrics } from '../src/metrics/metrics.js';
import { FAILURE_KINDS, outboxMetrics } from '../src/metrics/outbox-metrics.js';
import { PoolMetrics, type PoolSource } from '../src/metrics/pool-metrics.js';
import { seriesOf } from './support/metrics.js';

/** V2 A12.3: the service metric families, the gauge `collect` contract and MetricsHost's observe rules. */
const render = async (m: BoundedMetrics) => (await m.render()).body;

describe('gauge collect (D-5)', () => {
  it('reads at scrape, through the label policy, and contains a throw', async () => {
    const m = new BoundedMetrics();
    let n = 0;
    let fail = false;
    m.gauge({
      name: 'nawara_x',
      help: 'h',
      labels: [closedSet('pool', ['main'])],
      collect: (set) => {
        if (fail) throw new Error('collect failure');
        set({ pool: 'main' }, ++n);
        set({ pool: '0b6f2c1e-4a8e-4f57-9d55-3f0d6e3a1b22' }, 99);
      },
    });
    expect(await render(m)).toMatch(/^nawara_x\{pool="main"\} 1$/m);
    expect(await render(m)).toMatch(/^nawara_x\{pool="main"\} 2$/m);
    expect(await render(m)).not.toContain('0b6f2c1e');
    expect(await render(m)).toMatch(/^nawara_x\{pool="other"\} 99$/m);
    fail = true;
    expect(await render(m)).toMatch(/^nawara_x\{pool="main"\} 4$/m); // four scrapes ran collect before; the last value is kept, scrape succeeds
  });

  it('is never awaited: an async collect cannot delay the scrape, and a value it sets after its first await is ignored', async () => {
    const m = new BoundedMetrics();
    let late = 0;
    let calls = 0;
    m.gauge({
      name: 'nawara_y',
      help: 'h',
      collect: async (set) => {
        if (++calls > 1) return; // later scrapes set nothing, so only the first call's late value could show
        set(undefined, 1); // still synchronous: accepted
        await new Promise((r) => setTimeout(r, 20));
        late++;
        set(undefined, 7); // after the scrape: ignored
      },
    });
    const t = performance.now();
    expect(await render(m)).toMatch(/^nawara_y 1$/m);
    expect(performance.now() - t).toBeLessThan(15);
    await new Promise((r) => setTimeout(r, 50));
    expect(late).toBe(1); // the late set really ran
    const body = await render(m);
    expect(body).toMatch(/^nawara_y 1$/m);
    expect(body).not.toMatch(/^nawara_y 7$/m);
  });

  it('consumes the rejection of an async or thenable collect: no unhandled rejection, the scrape and the process carry on', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const m = new BoundedMetrics();
      m.gauge({ name: 'nawara_r', help: 'h', collect: async () => Promise.reject(new Error('async collect failure')) });
      m.gauge({
        name: 'nawara_d',
        help: 'h',
        collect: async () => {
          await new Promise((r) => setTimeout(r, 5));
          throw new Error('delayed async collect failure');
        },
      });
      // eslint-disable-next-line unicorn/no-thenable -- intentional: a non-Promise thenable is exactly what this proves is contained
      const thenable = { then: (_ok: unknown, fail: (e: unknown) => void) => setTimeout(() => fail(new Error('thenable collect failure')), 5) };
      m.gauge({ name: 'nawara_t', help: 'h', collect: (() => thenable) as never });
      // eslint-disable-next-line unicorn/no-thenable -- intentional: a hostile `then` getter
      const getterThrows = Object.defineProperty({}, 'then', { get: () => { throw new Error('hostile then'); } });
      m.gauge({ name: 'nawara_g', help: 'h', collect: (() => getterThrows) as never });
      for (let i = 0; i < 3; i++) expect(await render(m)).toMatch(/^nawara_r 0$/m);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
      expect(await render(m)).toMatch(/^nawara_t 0$/m);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('refuses a non-function collect', () => {
    expect(() => new BoundedMetrics().gauge({ name: 'nawara_z', help: 'h', collect: 1 as never })).toThrow(/collect must be a function/);
  });
});

describe('messaging metrics', () => {
  it('maps observations to bounded series; hostile and unknown values fold; queue names are capped', async () => {
    const m = new BoundedMetrics();
    const observe = messagingMetrics(m);
    observe({ type: 'publish', outcome: 'confirmed', durationMs: 3 });
    observe({ type: 'publish', outcome: 'evil' as never, durationMs: 3 });
    observe({ type: 'consume', queue: 'billing.payment-events', outcome: 'processed', handlerMs: 12, redelivered: true });
    observe({ type: 'consume', queue: 'billing.payment-events', outcome: 'nope' as never, handlerMs: undefined, redelivered: false });
    observe({ type: 'consume', queue: 'Q WITH SPACES', outcome: 'processed', handlerMs: 1, redelivered: false });
    for (let i = 0; i < 40; i++) observe({ type: 'consume', queue: `q${i}.work`, outcome: 'processed', handlerMs: 1, redelivered: false });
    observe({ type: 'consumer', queue: 'billing.payment-events', state: 'consuming' });
    observe({ type: 'consumer', queue: 'billing.payment-events', state: 'lost' });
    observe({ type: 'consumer', queue: 'billing.payment-events', state: 'recovered' });
    observe({ type: 'settle_failed', queue: 'billing.payment-events' });
    const body = await render(m);
    expect(seriesOf(body, 'nawara_events_published_total')).toEqual([{ outcome: 'confirmed' }, { outcome: 'other' }]);
    const queues = new Set(seriesOf(body, 'nawara_events_consumed_total').map((s) => s.queue));
    expect(queues.size).toBeLessThanOrEqual(17); // 16 code-registered names + other
    expect(queues.has('other')).toBe(true);
    expect(body).not.toContain('Q WITH SPACES');
    expect(body).toMatch(/nawara_events_consumed_total\{queue="billing.payment-events",outcome="other"\} 1/);
    expect(body).toMatch(/^nawara_event_redeliveries_total\{queue="billing.payment-events"\} 1$/m);
    expect(body).toMatch(/^nawara_event_consumer_up\{queue="billing.payment-events"\} 0$/m);
    expect(body).toMatch(/^nawara_event_consumer_losses_total\{queue="billing.payment-events"\} 1$/m);
    expect(body).toMatch(/^nawara_event_consumer_recoveries_total\{queue="billing.payment-events"\} 1$/m);
    expect(body).toMatch(/^nawara_event_settle_failures_total\{queue="billing.payment-events"\} 1$/m);
    expect(body).not.toMatch(/nawara_event_handler_duration_seconds_count\{queue="billing.payment-events"\} 2/); // undefined handlerMs not observed
  });
});

describe('outbox metrics', () => {
  it('sets the aggregate gauges and counts pass failures by bounded kind', async () => {
    const m = new BoundedMetrics();
    const observe = outboxMetrics(m);
    observe({ type: 'stats', pending: 4, retrying: 1, oldestPendingSeconds: 75, at: 1700000000 });
    observe({ type: 'pass_failure', kind: 'db_connection_lost' });
    observe({ type: 'pass_failure', kind: undefined });
    observe({ type: 'pass_failure', kind: 'hostile text from somewhere' as never });
    const body = await render(m);
    expect(body).toMatch(/^nawara_outbox_pending_events 4$/m);
    expect(body).toMatch(/^nawara_outbox_retrying_events 1$/m);
    expect(body).toMatch(/^nawara_outbox_oldest_pending_age_seconds 75$/m);
    expect(body).toMatch(/^nawara_outbox_stats_timestamp_seconds 1700000000$/m);
    expect(seriesOf(body, 'nawara_outbox_relay_pass_failures_total')).toEqual([{ kind: 'db_connection_lost' }, { kind: 'other' }]);
    expect(body).toMatch(/nawara_outbox_relay_pass_failures_total\{kind="other"\} 2/);
    expect(FAILURE_KINDS).toHaveLength(12);
  });
});

describe('pool metrics', () => {
  const source = (stats = { total: 3, idle: 1, waiting: 2 }, max = 10): PoolSource & { fire?: (k: string | undefined) => void } => {
    const s: PoolSource & { fire?: (k: string | undefined) => void } = {
      poolStats: () => stats,
      poolMax: max,
      setPoolObserver: (o) => {
        s.fire = o as never;
      },
    };
    return s;
  };

  it('reads getters at scrape and counts idle-client errors by bounded kind', async () => {
    const m = new BoundedMetrics();
    const pools = new PoolMetrics(m);
    const stats = { total: 3, idle: 1, waiting: 2 };
    const s = source(stats);
    pools.add('main', s);
    let body = await render(m);
    expect(body).toMatch(/^nawara_db_pool_connections\{pool="main"\} 3$/m);
    expect(body).toMatch(/^nawara_db_pool_idle_connections\{pool="main"\} 1$/m);
    expect(body).toMatch(/^nawara_db_pool_waiting_clients\{pool="main"\} 2$/m);
    expect(body).toMatch(/^nawara_db_pool_max_connections\{pool="main"\} 10$/m);
    stats.waiting = 0;
    body = await render(m);
    expect(body).toMatch(/^nawara_db_pool_waiting_clients\{pool="main"\} 0$/m);
    s.fire!('db_connection_lost');
    s.fire!(undefined);
    body = await render(m);
    expect(seriesOf(body, 'nawara_db_pool_errors_total')).toEqual([{ pool: 'main', kind: 'db_connection_lost' }, { pool: 'main', kind: 'other' }]);
  });

  it('a pool whose getter throws does not break the scrape', async () => {
    const m = new BoundedMetrics();
    new PoolMetrics(m).add('main', { poolStats: () => { throw new Error('boom'); }, poolMax: 5 });
    expect(await render(m)).toContain('nawara_db_pool_max_connections');
  });
});

describe('MetricsHost observe rules', () => {
  const enabled = () => {
    const host = new MetricsHost();
    host.attach(new BoundedMetrics(), { close: async () => undefined } as never, Promise.resolve(undefined));
    return host;
  };

  it('is a no-op while metrics are off', () => {
    const host = new MetricsHost();
    let set = 0;
    host.observeEventBus({ setObserver: () => set++ });
    host.observeOutboxRelay({ setObserver: () => set++ });
    host.observePool('main', { poolStats: () => ({ total: 0, idle: 0, waiting: 0 }), poolMax: 1, setPoolObserver: () => set++ });
    expect(set).toBe(0);
  });

  it('observes each source once, ignores the in-memory bus and non-sources, and survives an already-observed source', async () => {
    const host = enabled();
    let calls = 0;
    const bus = { setObserver: () => calls++ };
    host.observeEventBus(bus);
    host.observeEventBus(bus);
    host.observeEventBus(new InMemoryEventBus());
    host.observeEventBus(undefined);
    host.observeEventBus({ setObserver: () => { throw new Error('already set'); } });
    host.observePool('main', { nope: true });
    host.observePool('BAD NAME', { poolStats: () => ({ total: 1, idle: 1, waiting: 0 }), poolMax: 1 });
    expect(calls).toBe(1);
    expect((await host.metrics!.render()).body).not.toContain('BAD NAME');
  });
});

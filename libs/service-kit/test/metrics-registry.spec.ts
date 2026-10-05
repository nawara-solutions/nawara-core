import { describe, expect, it } from 'vitest';
import { closedSet, type LabelName, type LabelSet } from '../src/index.js';
import { BoundedMetrics, LABEL_OVERFLOW_METRIC } from '../src/metrics/metrics.js';
import { seriesOf } from './support/metrics.js';

const outcome = closedSet('outcome', ['ok', 'failed']);

describe('metric registration (V2 A12.2)', () => {
  it('enforces the naming conventions', () => {
    const m = new BoundedMetrics();
    expect(() => m.counter({ name: 'requests_total', help: 'h' })).toThrow(/nawara_/);
    expect(() => m.counter({ name: 'nawara_requests', help: 'h' })).toThrow(/_total/);
    expect(() => m.gauge({ name: 'nawara_things_total', help: 'h' })).toThrow(/must not end in _total/);
    expect(() => m.histogram({ name: 'nawara_latency', help: 'h', buckets: [1] })).toThrow(/_seconds or _bytes/);
    expect(() => m.counter({ name: 'nawara_Bad_total', help: 'h' })).toThrow(/valid/);
    expect(() => m.counter({ name: 'nawara_x_total', help: '' })).toThrow(/help/);
    expect(() => m.counter({ name: 'nawara_x_total', help: 'two\nlines' })).toThrow(/help/);
    expect(() => m.histogram({ name: 'nawara_x_seconds', help: 'h', buckets: [1, 0.5] })).toThrow(/increasing/);
  });

  it('refuses a duplicate metric, including the reserved overflow counter', () => {
    const m = new BoundedMetrics();
    m.counter({ name: 'nawara_x_total', help: 'h' });
    expect(() => m.counter({ name: 'nawara_x_total', help: 'h' })).toThrow(/already registered/);
    expect(() => m.counter({ name: LABEL_OVERFLOW_METRIC, help: 'h' })).toThrow(/already registered/);
  });

  it('refuses a forbidden label name even if a set were forged for it', () => {
    const m = new BoundedMetrics();
    const forged = { name: 'userId', fallback: 'other', resolve: () => 'x' } as unknown as LabelSet;
    expect(() => m.counter({ name: 'nawara_x_total', help: 'h', labels: [forged] })).toThrow(/not created by the kit's label factories/); // A12.2a: refused before its name is even read
    expect(() => m.counter({ name: 'nawara_y_total', help: 'h', labels: [outcome, outcome] })).toThrow(/twice/);
    expect(() => m.counter({ name: 'nawara_z_total', help: 'h', maxSeries: 0 })).toThrow(/budget/);
  });

  it('only declared labels are recorded, each through its set', async () => {
    const m = new BoundedMetrics();
    const c = m.counter({ name: 'nawara_x_total', help: 'h', labels: [outcome] });
    c.inc({ outcome: 'ok', route: '/secret/route', method: 'GET' } as never);
    c.inc({ outcome: 'a@b.example' });
    const body = (await m.render()).body;
    expect(seriesOf(body, 'nawara_x_total')).toEqual([{ outcome: 'ok' }, { outcome: 'other' }]);
    expect(body).not.toContain('/secret/route');
    expect(body).not.toContain('a@b.example');
  });
});

describe('series budget and overflow', () => {
  it('past the budget, new combinations fold into ONE overflow series and are counted', async () => {
    const m = new BoundedMetrics();
    const many = closedSet('event', Array.from({ length: 50 }, (_, i) => `e${i}`));
    const c = m.counter({ name: 'nawara_events_x_total', help: 'h', labels: [many, outcome], maxSeries: 5 });
    for (let i = 0; i < 50; i++) c.inc({ event: `e${i}`, outcome: 'ok' });
    const body = (await m.render()).body;
    const series = seriesOf(body, 'nawara_events_x_total');
    expect(series).toHaveLength(6); // the budget plus the single overflow series
    expect(series).toContainEqual({ event: 'other', outcome: 'other' });
    expect(seriesOf(body, LABEL_OVERFLOW_METRIC)).toEqual([{ metric: 'nawara_events_x_total' }]);
    expect(body).toMatch(/nawara_metrics_label_overflow_total\{metric="nawara_events_x_total"\} 45/);
  });

  it('the overflow counter is bounded by the registered metric names and never overflows itself', async () => {
    const m = new BoundedMetrics();
    const sets = Array.from({ length: 30 }, (_, k) => {
      const c = m.counter({ name: `nawara_m${k}_total`, help: 'h', labels: [closedSet('event', ['a', 'b', 'c'])], maxSeries: 1 });
      for (const e of ['a', 'b', 'c']) c.inc({ event: e });
      return c;
    });
    expect(sets).toHaveLength(30);
    const overflowSeries = seriesOf((await m.render()).body, LABEL_OVERFLOW_METRIC);
    expect(overflowSeries).toHaveLength(30);
    for (const s of overflowSeries) expect(s.metric).toMatch(/^nawara_m\d+_total$/);
  });

  it('resolving and folding never throws on the hot path', () => {
    const m = new BoundedMetrics();
    const c = m.counter({ name: 'nawara_x_total', help: 'h', labels: [outcome], maxSeries: 1 });
    const g = m.gauge({ name: 'nawara_g', help: 'h', labels: [outcome] });
    const h = m.histogram({ name: 'nawara_h_seconds', help: 'h', labels: [outcome], buckets: [0.1, 1] });
    expect(() => {
      for (const v of [undefined, null, 1, {}, 'x'.repeat(10_000), '\u0000']) {
        c.inc({ outcome: v as never });
        g.set({ outcome: v as never }, 1);
        h.observe({ outcome: v as never }, 0.5);
      }
      c.inc(undefined);
    }).not.toThrow();
  });
});

describe('label authenticity and catalog (V2 A12.2a, security review M-1)', () => {
  const register = (labels: readonly LabelSet[]) => new BoundedMetrics().counter({ name: 'nawara_x_total', help: 'h', labels });

  it('refuses a look-alike label set, whatever its name: only the kit factories make label sets', () => {
    for (const name of ['customer', 'tenant', 'foo', 'custom_label', 'arbitrary', 'route', 'method', 'event', 'check', 'outcome']) {
      const forged = { name, fallback: 'other', resolve: (v: unknown) => String(v) } as unknown as LabelSet;
      expect(() => register([forged]), name).toThrow(/not created by the kit's label factories/);
    }
  });

  it('refuses copies, prototypes and proxies of an authentic set, and an authentic set cannot be altered', () => {
    const real = closedSet('route', ['/a']);
    const copy = { ...real } as LabelSet;
    const child = Object.create(real) as LabelSet;
    const proxy = new Proxy(real, { get: (t, k) => (k === 'resolve' ? (v: unknown) => String(v) : Reflect.get(t, k)) });
    for (const s of [copy, child, proxy]) expect(() => register([s])).toThrow(/not created by the kit's label factories/);
    expect(() => {
      (real as { resolve: unknown }).resolve = (v: unknown) => String(v);
    }).toThrow(TypeError);
    expect(real.resolve('/files/t/eyJTOKEN')).toBe('other');
  });

  it('refuses an uncatalogued name at registration even on an authentic-looking path', () => {
    // A set cannot even be built for a non-catalog name; registration checks the catalog again on its own.
    for (const name of ['customer', 'tenant', 'foo', 'custom_label', 'arbitrary']) expect(() => closedSet(name as LabelName, ['a']), name).toThrow(/not a catalogued label name/);
  });

  it('a raw token or email cannot reach the exposition through a forged resolver', async () => {
    const m = new BoundedMetrics();
    const forged = { name: 'route', fallback: '__unmatched__', resolve: (v: unknown) => String(v) } as unknown as LabelSet;
    expect(() => m.counter({ name: 'nawara_y_total', help: 'h', labels: [forged] })).toThrow();
    expect((await m.render()).body).not.toContain('nawara_y_total');
  });

  it('the permissive growing set is not part of the public kit API, and kit internals are not importable by path', async () => {
    const kit = await import('../src/index.js');
    expect('growingSet' in kit).toBe(false);
    expect('lazyClosedSet' in kit).toBe(false);
    expect('isAuthenticLabelSet' in kit).toBe(false);
    for (const deep of ['@nawara/service-kit/dist/metrics/label-policy.js', '@nawara/service-kit/dist/metrics/prom.js', '@nawara/service-kit/dist/metrics/metrics.js']) {
      await expect(import(deep), deep).rejects.toThrow();
    }
  });
});

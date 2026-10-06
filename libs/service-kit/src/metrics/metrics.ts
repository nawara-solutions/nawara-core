import { isAuthenticLabelSet, isCatalogLabelName, isForbiddenLabelName, type LabelName, type LabelSet } from './label-policy.js';
import { Counter, Gauge, Histogram, Registry } from './prom.js';
import { registerRuntimeMetrics } from './runtime.js';

/** Label values for one observation: only the metric's declared labels are read; each goes through its set. */
export type Labels = Readonly<Partial<Record<LabelName, string>>>;

export interface MetricDefinition {
  /** `nawara_<domain>_<subject>[_<unit>]`; a counter ends `_total`, a histogram `_seconds` or `_bytes`. */
  name: string;
  help: string;
  labels?: readonly LabelSet[];
  /** The most distinct label combinations this metric may hold (default 500). Past it, observations fold into one overflow series. */
  maxSeries?: number;
}

export interface HistogramDefinition extends MetricDefinition {
  buckets: readonly number[];
}

/**
 * V2 A12.3 (D-5): a gauge may be refreshed AT SCRAPE by a synchronous `collect` that reads in-memory state (a pool's counters) and
 * reports values through `set`, which resolves labels exactly like the handle does (authentic sets, series budget). It must not do
 * I/O: whatever it returns is ignored (never awaited), and a throw is contained: the gauge keeps its last values and the scrape succeeds.
 * V2 A12.3 (C-1): `set` is honoured only during the synchronous call; a returned promise or thenable has its rejection consumed.
 */
export interface GaugeDefinition extends MetricDefinition {
  collect?: (set: (labels: Labels | undefined, value: number) => void) => void;
}

export interface CounterHandle {
  inc(labels?: Labels, by?: number): void;
}
export interface GaugeHandle {
  set(labels: Labels | undefined, value: number): void;
  inc(labels?: Labels): void;
  dec(labels?: Labels): void;
}
export interface HistogramHandle {
  observe(labels: Labels | undefined, value: number): void;
}

export const DEFAULT_MAX_SERIES = 500;
const MAX_SERIES_BOUND = 5000;
const MAX_LABELS = 4;
const MAX_BUCKETS = 20;
export const LABEL_OVERFLOW_METRIC = 'nawara_metrics_label_overflow_total';
const NAME = /^nawara_[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

/**
 * V2 A12.2: the bounded metrics registry of one service process. It is the only way a Core metric is created: names follow the
 * Prometheus conventions, labels come from the catalog and resolve through their closed sets, and each metric holds at most
 * `maxSeries` label combinations. A combination past that budget is recorded once, under every label's fallback value, and counted in
 * `nawara_metrics_label_overflow_total{metric}`. That counter is created here, outside the public path: its only label is the name of a
 * metric registered here, so it is bounded by the number of metrics and can never overflow itself.
 *
 * It owns a private registry (never the library's global one), so two applications in one process never collide.
 */
export class BoundedMetrics {
  private readonly registry = new Registry();
  private readonly names = new Set<string>();
  private readonly overflow: Counter<string>;

  constructor(opts: { runtime?: boolean } = {}) {
    this.overflow = new Counter({
      name: LABEL_OVERFLOW_METRIC,
      help: 'Observations folded into the overflow series because a metric reached its label-combination budget.',
      labelNames: ['metric'],
      registers: [this.registry],
    });
    this.names.add(LABEL_OVERFLOW_METRIC);
    if (opts.runtime) registerRuntimeMetrics(this.registry);
  }

  counter(def: MetricDefinition): CounterHandle {
    this.validate(def, 'counter');
    const labels = def.labels ?? [];
    const metric = new Counter({ name: def.name, help: def.help, labelNames: labels.map((l) => l.name), registers: [this.registry] });
    const bound = this.binder(def, labels);
    return { inc: (l, by = 1) => metric.inc(bound(l), by) };
  }

  gauge(def: GaugeDefinition): GaugeHandle {
    this.validate(def, 'gauge');
    if (def.collect !== undefined && typeof def.collect !== 'function') throw new Error(`metrics: ${def.name} collect must be a function`);
    const labels = def.labels ?? [];
    const bound = this.binder(def, labels);
    const userCollect = def.collect;
    const metric: Gauge<string> = new Gauge({
      name: def.name,
      help: def.help,
      labelNames: labels.map((l) => l.name),
      registers: [this.registry],
      ...(userCollect
        ? {
            collect() {
              // `set` works only while the collect runs synchronously: a value an async collect reports later is ignored.
              let active = true;
              try {
                const result: unknown = userCollect((l, v) => {
                  if (active) metric.set(bound(l), v);
                });
                // V2 A12.3 (C-1): a collect that returns a promise or any thenable is never awaited, and its rejection is consumed
                // here, so it can neither delay the scrape nor reach the process as an unhandled rejection.
                if ((typeof result === 'object' || typeof result === 'function') && result !== null && typeof (result as PromiseLike<unknown>).then === 'function') {
                  (result as PromiseLike<unknown>).then(undefined, () => undefined);
                }
              } catch {
                // A collect failure never fails the scrape or the service: the gauge keeps its last values.
              } finally {
                active = false;
              }
              // Returns nothing: a collect is never awaited.
            },
          }
        : {}),
    });
    return {
      set: (l, v) => metric.set(bound(l), v),
      inc: (l) => metric.inc(bound(l)),
      dec: (l) => metric.dec(bound(l)),
    };
  }

  histogram(def: HistogramDefinition): HistogramHandle {
    this.validate(def, 'histogram');
    const b = def.buckets;
    if (b.length < 1 || b.length > MAX_BUCKETS || b.some((x, i) => !(x > 0) || !Number.isFinite(x) || (i > 0 && x <= b[i - 1]!))) {
      throw new Error(`metrics: ${def.name} needs 1 to ${MAX_BUCKETS} strictly increasing positive buckets`);
    }
    const labels = def.labels ?? [];
    const metric = new Histogram({ name: def.name, help: def.help, labelNames: labels.map((l) => l.name), buckets: [...b], registers: [this.registry] });
    const bound = this.binder(def, labels);
    return { observe: (l, v) => metric.observe(bound(l), v) };
  }

  /** The Prometheus text exposition of every metric, rendered from in-memory state only. */
  async render(): Promise<{ contentType: string; body: string }> {
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }

  private validate(def: MetricDefinition, type: 'counter' | 'gauge' | 'histogram'): void {
    const { name, help } = def;
    if (typeof name !== 'string' || name.length > 100 || !NAME.test(name)) throw new Error(`metrics: "${String(name)}" is not a valid nawara_ metric name`);
    if (this.names.has(name)) throw new Error(`metrics: ${name} is already registered`);
    if (type === 'counter' && !name.endsWith('_total')) throw new Error(`metrics: counter ${name} must end in _total`);
    if (type !== 'counter' && name.endsWith('_total')) throw new Error(`metrics: ${type} ${name} must not end in _total`);
    if (type === 'histogram' && !/_(seconds|bytes)$/.test(name)) throw new Error(`metrics: histogram ${name} must end in _seconds or _bytes`);
    if (typeof help !== 'string' || help.length === 0 || help.length > 200 || /[\r\n]/.test(help)) throw new Error(`metrics: ${name} needs a one-line help text`);
    const labels = def.labels ?? [];
    if (labels.length > MAX_LABELS) throw new Error(`metrics: ${name} has more than ${MAX_LABELS} labels`);
    const seen = new Set<string>();
    for (const l of labels) {
      // V2 A12.2a: only a set made by the kit's label factories (never a look-alike object), with a catalogued, non-forbidden name.
      if (!isAuthenticLabelSet(l)) throw new Error(`metrics: ${name} uses a label set not created by the kit's label factories`);
      if (!isCatalogLabelName(l.name)) throw new Error(`metrics: ${name} uses the uncatalogued label name "${String(l.name)}"`);
      if (isForbiddenLabelName(l.name)) throw new Error(`metrics: ${name} uses the forbidden label name "${l.name}"`);
      if (seen.has(l.name)) throw new Error(`metrics: ${name} declares the label "${l.name}" twice`);
      seen.add(l.name);
    }
    const max = def.maxSeries ?? DEFAULT_MAX_SERIES;
    if (!Number.isInteger(max) || max < 1 || max > MAX_SERIES_BOUND) throw new Error(`metrics: ${name} needs a series budget between 1 and ${MAX_SERIES_BOUND}`);
    this.names.add(name);
  }

  /** Resolves an observation's labels through their sets and enforces the series budget. Never throws. */
  private binder(def: MetricDefinition, labels: readonly LabelSet[]): (l: Labels | undefined) => Record<string, string> {
    const max = def.maxSeries ?? DEFAULT_MAX_SERIES;
    const seen = new Set<string>();
    const overflowValues: Record<string, string> = Object.fromEntries(labels.map((s) => [s.name, s.fallback]));
    const overflowKey = labels.map((s) => s.fallback).join('\u0000');
    return (l) => {
      if (labels.length === 0) return {};
      const values: Record<string, string> = {};
      for (const s of labels) values[s.name] = s.resolve(l?.[s.name]);
      const key = labels.map((s) => values[s.name]).join('\u0000');
      if (seen.has(key)) return values;
      if (seen.size < max || key === overflowKey) {
        seen.add(key);
        return values;
      }
      this.overflow.inc({ metric: def.name });
      seen.add(overflowKey);
      return overflowValues;
    };
  }
}

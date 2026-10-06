import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import type { EventBusObservation } from '../events/rabbitmq-event-bus.js';
import type { RelayObservation } from '../events/outbox-relay.js';
import { messagingMetrics } from './messaging-metrics.js';
import type { BoundedMetrics } from './metrics.js';
import type { MetricsServer } from './metrics-server.js';
import { outboxMetrics } from './outbox-metrics.js';
import { PoolMetrics, isPoolSource } from './pool-metrics.js';

/**
 * V2 A12.2: holds the application's metrics once `installMetrics` has run (provided by the kit's global `HealthModule`, so every
 * service already has it). It refuses a second installation, gives later instrumentation the registry (`metrics`, undefined while
 * metrics are disabled), and closes the metrics listener in the last shutdown phase, after the application server has drained.
 */
@Injectable()
export class MetricsHost implements OnApplicationShutdown {
  private installed?: { metrics: BoundedMetrics; server: MetricsServer; listening: Promise<AddressInfo | undefined> };
  /** V2 A12.3: what is already observed (each source once), and the metric families, created on first use. */
  private readonly observed = new WeakSet<object>();
  private messaging?: (o: EventBusObservation) => void;
  private outbox?: (o: RelayObservation) => void;
  private pools?: PoolMetrics;

  get metrics(): BoundedMetrics | undefined {
    return this.installed?.metrics;
  }

  /** The metrics listener's address once bound; undefined when metrics are disabled or the listener could not start. */
  async address(): Promise<AddressInfo | undefined> {
    return this.installed?.listening;
  }

  attach(metrics: BoundedMetrics, server: MetricsServer, listening: Promise<AddressInfo | undefined>): void {
    if (this.installed) throw new Error('metrics are already installed for this application');
    this.installed = { metrics, server, listening };
  }

  /**
   * V2 A12.3: observe an event bus (one with `setObserver`: the kit's RabbitMQ bus) for the messaging metrics. A no-op while metrics are
   * off, for anything else (the in-memory bus) and for a bus already observed. `installMetrics` calls it for the kit `EVENT_BUS`; a
   * service whose bus has its own token calls it once, explicitly.
   */
  observeEventBus(bus: unknown): void {
    const metrics = this.metrics;
    if (!metrics || !this.observable(bus, 'setObserver')) return;
    this.messaging ??= messagingMetrics(metrics);
    this.observeOnce(bus, () => (bus as { setObserver(o: (x: EventBusObservation) => void): void }).setObserver(this.messaging!));
  }

  /** V2 A12.3: observe the kit outbox relay (pass failures, the throttled outbox aggregate). Same rules as `observeEventBus`. */
  observeOutboxRelay(relay: unknown): void {
    const metrics = this.metrics;
    if (!metrics || !this.observable(relay, 'setObserver')) return;
    this.outbox ??= outboxMetrics(metrics);
    this.observeOnce(relay, () => (relay as { setObserver(o: (x: RelayObservation) => void): void }).setObserver(this.outbox!));
  }

  /** V2 A12.3: observe a database pool (passive counters read at scrape, idle-client errors). Same rules as `observeEventBus`. */
  observePool(name: string, pool: unknown): void {
    const metrics = this.metrics;
    if (!metrics || !isPoolSource(pool) || this.observed.has(pool)) return;
    this.pools ??= new PoolMetrics(metrics);
    this.observed.add(pool);
    this.pools.add(name, pool);
  }

  private observable(source: unknown, method: string): source is object {
    return !!source && typeof source === 'object' && typeof (source as Record<string, unknown>)[method] === 'function' && !this.observed.has(source);
  }

  private observeOnce(source: object, set: () => void): void {
    this.observed.add(source);
    try {
      set();
    } catch {
      // Already observed by something else: its metrics simply stay as they are.
    }
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.installed) return;
    await this.installed.listening;
    await this.installed.server.close();
  }
}

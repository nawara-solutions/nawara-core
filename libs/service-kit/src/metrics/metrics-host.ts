import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import type { BoundedMetrics } from './metrics.js';
import type { MetricsServer } from './metrics-server.js';

/**
 * V2 A12.2: holds the application's metrics once `installMetrics` has run (provided by the kit's global `HealthModule`, so every
 * service already has it). It refuses a second installation, gives later instrumentation the registry (`metrics`, undefined while
 * metrics are disabled), and closes the metrics listener in the last shutdown phase, after the application server has drained.
 */
@Injectable()
export class MetricsHost implements OnApplicationShutdown {
  private installed?: { metrics: BoundedMetrics; server: MetricsServer; listening: Promise<AddressInfo | undefined> };

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

  async onApplicationShutdown(): Promise<void> {
    if (!this.installed) return;
    await this.installed.listening;
    await this.installed.server.close();
  }
}

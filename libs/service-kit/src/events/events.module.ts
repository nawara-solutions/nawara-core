import { DynamicModule, Global, Inject, Injectable, Module, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService } from '../db/db.service.js';
import { InboxService } from './inbox.service.js';
import { OutboxRelay } from './outbox-relay.js';
import { OutboxService } from './outbox.service.js';
import { EVENT_BUS, type EventBus } from './types.js';

export const EVENTS_OPTIONS = Symbol('EVENTS_OPTIONS');

export interface EventsModuleOptions {
  /** Producing service name (event header). */
  source: string;
  bus: EventBus;
  relay?: { enabled?: boolean; intervalMs?: number; batchSize?: number };
  /**
   * Relay operational signals, each a complete `event_name key=value` line (`outbox_publish_failure`, `outbox_relay_pass_failure`,
   * `worker_drain_timeout`). Never carries a payload, URL or credential.
   */
  onError?: (message: string) => void;
}

/**
 * Runs the outbox relay with the service: starts on bootstrap; on graceful shutdown it DRAINS in `beforeApplicationShutdown`
 * (which Nest runs for every module before any `onApplicationShutdown`), so the in-flight batch keeps the database pool and the
 * broker; the bus itself closes afterwards, in `onApplicationShutdown`.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  readonly relay: OutboxRelay;

  constructor(@Inject(DbService) db: DbService, @Inject(EVENT_BUS) private readonly bus: EventBus, @Inject(EVENTS_OPTIONS) private readonly opts: EventsModuleOptions) {
    this.relay = new OutboxRelay(db, bus, { source: opts.source, batchSize: opts.relay?.batchSize }, opts.onError);
  }

  onApplicationBootstrap(): void {
    if (this.opts.relay?.enabled ?? true) this.relay.start(this.opts.relay?.intervalMs ?? 1000);
  }

  /** Stage 15.5 (F-D): the drain starts at shutdown start, concurrently with the service's other workers; later hooks await it. */
  onModuleDestroy(): void {
    void this.relay.stop();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.relay.stop(); // a drain timeout is reported by the relay itself (`worker_drain_timeout worker=outbox_relay`)
  }

  async onApplicationShutdown(): Promise<void> {
    await this.relay.stop(); // idempotent: the same drain, already finished by beforeApplicationShutdown
    await this.bus.close();
  }
}

@Global()
@Module({})
export class EventsModule {
  static forRoot(options: EventsModuleOptions): DynamicModule {
    return {
      module: EventsModule,
      providers: [{ provide: EVENTS_OPTIONS, useValue: options }, { provide: EVENT_BUS, useValue: options.bus }, OutboxService, InboxService, OutboxRelayService],
      exports: [EVENT_BUS, OutboxService, InboxService, OutboxRelayService],
    };
  }
}

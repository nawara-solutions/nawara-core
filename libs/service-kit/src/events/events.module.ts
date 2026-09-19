import { DynamicModule, Global, Inject, Injectable, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
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
  onError?: (message: string) => void;
}

/** Runs the outbox relay with the service: starts on bootstrap, drains and closes the bus on graceful shutdown. */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly relay: OutboxRelay;

  constructor(@Inject(DbService) db: DbService, @Inject(EVENT_BUS) private readonly bus: EventBus, @Inject(EVENTS_OPTIONS) private readonly opts: EventsModuleOptions) {
    this.relay = new OutboxRelay(db, bus, { source: opts.source, batchSize: opts.relay?.batchSize }, opts.onError);
  }

  onApplicationBootstrap(): void {
    if (this.opts.relay?.enabled ?? true) this.relay.start(this.opts.relay?.intervalMs ?? 1000);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.relay.stop();
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

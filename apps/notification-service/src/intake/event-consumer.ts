import amqp from 'amqplib';
import {
  Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { DbService, DB_OPTIONS, ReadinessRegistry, pendingMigrations, runWithRequestContext, type DbOptions, type EventBus, type EventEnvelope } from '@nawara/service-kit';
import { NOTIFICATION_CONFIG } from '../config/notification-config.token.js';
import type { NotificationConfig } from '../config/notification-config.js';
import { EVENT_MAP, INTAKE_BINDINGS, INTAKE_QUEUE } from './event-map.js';
import { IntakeService } from './intake.service.js';

export const INTAKE_EVENT_BUS = Symbol('INTAKE_EVENT_BUS');
/** A bus that can report whether its consumers are attached (the kit's `RabbitMqEventBus`; tests may inject the in-memory bus). */
type IntakeBus = EventBus & { consumerStatus?: () => Array<{ state: string }> };

/** Bounds of the start loop: waits for the database, the migrations and the default-locale coverage, and for the broker. */
const START_RETRY = { baseMs: 250, maxMs: 5_000 };

/**
 * Runs the event intake consumer (SDD §7.1, §16) on the kit bus, with the Core lifecycle:
 * - START ORDER: the consumer attaches only once the database answers, every migration is applied and every mapped template has a
 *   published version in `NOTIFICATION_DEFAULT_LOCALE` (for EMAIL and SMS), so no event is taken before it can be recorded. Until
 *   then, and while the broker is unreachable, the process stays up, `/ready` answers 503, and the start is retried with bounded
 *   backoff (the first `subscribe` fails fast in the kit; the retry is here).
 * - READINESS: `rabbitmq` (the broker answers a connect) and `event-intake` (the consumer is attached and consuming). The kit already
 *   registers `database` and `migrations`.
 * - SHUTDOWN (Stage 15.5): the consumer is closed at shutdown START (no new delivery; in-flight handlers finish and settle within the
 *   kit's bound) while the pool is still open; the bus closes in `onApplicationShutdown`; the kit closes the pool last.
 * Each handler runs in the event's request context, so the kit's log lines carry its correlation id.
 */
@Injectable()
export class EventConsumer implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly log = new Logger('EventIntake');
  private subscription?: { close(): Promise<void> };
  private closing?: Promise<void>;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private attempts = 0;
  private lastBlocker = '';

  constructor(
    private readonly intake: IntakeService,
    @Inject(INTAKE_EVENT_BUS) private readonly bus: IntakeBus,
    @Inject(DbService) private readonly db: DbService,
    @Inject(DB_OPTIONS) private readonly dbOptions: DbOptions,
    @Inject(ReadinessRegistry) private readonly readiness: ReadinessRegistry,
    @Inject(NOTIFICATION_CONFIG) private readonly config: NotificationConfig,
  ) {}

  onModuleInit(): void {
    this.readiness.register('rabbitmq', async () => {
      const conn = await amqp.connect(this.config.rabbitmqUrl, { timeout: 2000 });
      await conn.close();
    });
    this.readiness.register('event-intake', async () => {
      if (!this.subscription) throw new Error('event intake not started');
      if (this.bus.consumerStatus?.().some((c) => c.state !== 'consuming')) throw new Error('event intake consumer not attached');
    });
  }

  onApplicationBootstrap(): void {
    void this.tryStart();
  }

  /** True once the consumer is attached (tests and the start loop). */
  get started(): boolean {
    return this.subscription !== undefined;
  }

  private async tryStart(): Promise<void> {
    if (this.stopped || this.subscription) return;
    try {
      const blocker = await this.startBlocker();
      if (blocker) throw new Error(blocker);
      const sub = await this.bus.subscribe({ queue: INTAKE_QUEUE, bindings: [...INTAKE_BINDINGS], handler: (e) => this.handle(e) });
      if (this.stopped) {
        await sub.close();
        return;
      }
      this.subscription = sub;
      this.attempts = 0;
      this.lastBlocker = '';
      this.log.log(`event_intake_started queue=${INTAKE_QUEUE} bindings=${INTAKE_BINDINGS.length}`);
    } catch (e) {
      const blocker = e instanceof Error && e.message.startsWith('intake:') ? e.message : `intake:broker_unavailable error=${e instanceof Error ? e.name : 'Error'}`;
      if (blocker !== this.lastBlocker) this.log.warn(`event_intake_waiting reason=${blocker.slice(7)} — retrying; /ready answers 503 until the intake runs`);
      this.lastBlocker = blocker;
      const ceiling = Math.min(START_RETRY.maxMs, START_RETRY.baseMs * 2 ** Math.min(this.attempts++, 10));
      if (!this.stopped) this.timer = setTimeout(() => void this.tryStart(), Math.round(ceiling / 2 + (Math.random() * ceiling) / 2));
    }
  }

  /** Why the intake must not consume yet, or undefined. Never includes a value from the environment or the database. */
  private async startBlocker(): Promise<string | undefined> {
    let rows: Array<{ key: string; channel: string }>;
    try {
      await this.db.ping();
      if ((await pendingMigrations(this.db, this.dbOptions.migrations?.dirs ?? [])).length > 0) return 'intake:migrations_pending';
      rows = (await this.db.query<{ key: string; channel: string }>(
        `SELECT t.key, v.channel FROM notification_template t JOIN notification_template_version v ON v."templateId" = t.id
          WHERE t."organizationId" IS NULL AND v.locale = $1 GROUP BY 1, 2`,
        [this.config.defaultLocale],
      )).rows;
    } catch {
      return 'intake:database_unavailable';
    }
    const covered = new Set(rows.map((r) => `${r.key}|${r.channel}`));
    const missing = EVENT_MAP.flatMap((m) => ['EMAIL', 'SMS'].filter((c) => !covered.has(`${m.template}|${c}`)).map((c) => `${m.template}/${c}`));
    if (missing.length > 0) return `intake:default_locale_not_published missing=${missing.length}`;
    return undefined;
  }

  private handle(event: EventEnvelope): Promise<void> {
    const correlationId = event.headers.correlationId ?? `event:${event.id}`;
    return runWithRequestContext({ requestId: `event:${event.id}`, correlationId }, async () => {
      await this.intake.handle(event);
    });
  }

  /** Stage 15.5: closing starts at shutdown start; the later hooks await the same close. */
  onModuleDestroy(): void {
    this.close().catch(() => undefined);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.close(); // in-flight handlers finish (bounded by the kit) while the database pool is still open
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
    await this.bus.close(); // bounded by the kit (3 x heartbeat at worst)
  }

  private close(): Promise<void> {
    if (!this.closing) {
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
      const sub = this.subscription;
      this.subscription = undefined;
      this.closing = sub ? sub.close() : Promise.resolve();
    }
    return this.closing;
  }
}

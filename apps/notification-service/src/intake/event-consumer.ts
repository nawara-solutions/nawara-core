import amqp from 'amqplib';
import {
  Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  DbService, DB_OPTIONS, PgKeyedProvenanceStore, ReadinessRegistry, assertEnforceable, pendingMigrations, runWithEventContext, strictEnforcement, type DbOptions,
  type EnforcementPolicy, type EventBus, type EventEnvelope, type HandlerTrust,
} from '@nawara/service-kit';
import { NOTIFICATION_CONFIG } from '../config/notification-config.token.js';
import type { NotificationConfig } from '../config/notification-config.js';
import { EVENT_MAP, INTAKE_BINDINGS, INTAKE_QUEUE } from './event-map.js';
import { notificationDeadLetterPolicy } from './dead-letter-policy.js';
import { IntakeService } from './intake.service.js';
import { trustedIntakeEvent } from './trusted-event.js';

export const INTAKE_EVENT_BUS = Symbol('INTAKE_EVENT_BUS');
/** A bus that can report whether its consumers are attached (the kit's `RabbitMqEventBus`; tests may inject the in-memory bus). */
type IntakeBus = EventBus & { consumerStatus?: () => Array<{ state: string }> };

/**
 * Core V2 S1b-3 (ADR-0057 §13.2): the owner of each intake event name, from `EVENT_MAP` (the trusted, server-side mapping, never a message).
 * A name mapped under more than one source has no single owner, so no delivery of it can be verified (fail closed).
 */
const OWNERS: ReadonlyMap<string, string | undefined> = EVENT_MAP.reduce((owners, m) => owners.set(m.name, owners.has(m.name) && owners.get(m.name) !== m.source ? undefined : m.source), new Map<string, string | undefined>());
export const intakeEventOwner = (name: string): string | undefined => OWNERS.get(name);

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
 * - ENFORCEMENT (Core V2 S1e-4, ADR-0057 §13.5, "S0-C6"): verified-only, from the first deployment, always. There is no compatibility,
 *   observe-only or bypass mode and no setting that weakens it. The policy is checked at bootstrap (a subscription that could not be
 *   enforced fails the start of the process); a bus that refuses it (the in-memory bus has no broker identity) leaves the intake waiting,
 *   `/ready` 503, never consuming in another mode.
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
  /** S1e-4: one strict policy, frozen; the object checked at bootstrap is the one `subscribe` receives. */
  private readonly enforcement: EnforcementPolicy = strictEnforcement({ refusedBody: 'dead_letter_policy' });

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
    // S1e-4: refused here (the process does not start), never retried as if the broker were unavailable. Without the key ring there is no
    // store to enforce with: the intake then waits (`provenance_keys_missing`, below), never consuming.
    const keys = this.config.provenanceKeys;
    if (keys) {
      const store = new PgKeyedProvenanceStore(this.db, keys);
      assertEnforceable({ queue: INTAKE_QUEUE, provenance: { keyedStore: store }, enforcement: this.enforcement, deadLetterPolicy: notificationDeadLetterPolicy });
    }
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
      const keys = this.config.provenanceKeys;
      if (!keys) throw new Error('intake:provenance_keys_missing');
      // Core V2 S1b-3 (ADR-0057 §13.2 "S0-C2"): each delivery's provenance is committed in Notification's database, its body only as a
      // KEYED commitment (HMAC-SHA-256 under the provenance ring): three of these events carry a one-time code that an unkeyed digest
      // would expose.
      const sub = await this.bus.subscribe({
        queue: INTAKE_QUEUE, bindings: [...INTAKE_BINDINGS], handler: (e, trust) => this.handle(e, trust),
        provenance: { ownerOf: intakeEventOwner, keyedStore: new PgKeyedProvenanceStore(this.db, keys) },
        // Core V2 S1e-4 (ADR-0057 §13.5, "S0-C6"): the trust decision is durable before `handle`, which runs only for a verified original,
        // its verified redelivery or a replay matching the stored verified observation: a forged or unverified delivery never reaches the
        // intake's `(sourceService, sourceEventId)` de-duplication. A retired key's row is unverifiable (refused); an unavailable key, an
        // unknown commitment version or a database failure is held and requeued, the handler never running.
        enforcement: this.enforcement,
        // ADR-0052 decision 5: every dead-letter copy (a refusal, an intake refusal, a malformed message, an exhausted retry) goes through
        // this policy: a code-bearing event's body is always redacted.
        deadLetterPolicy: notificationDeadLetterPolicy,
      });
      if (this.stopped) {
        await sub.close();
        return;
      }
      this.subscription = sub;
      this.attempts = 0;
      this.lastBlocker = '';
      this.log.log(`event_intake_started queue=${INTAKE_QUEUE} bindings=${INTAKE_BINDINGS.length} enforcement=strict`);
    } catch (e) {
      // S1e-4: a bus that refuses the enforced subscription is named as such, never as an outage; nothing is consumed meanwhile
      const blocker = e instanceof Error && e.message.startsWith('intake:') ? e.message
        : e instanceof Error && e.message.startsWith('enforcement for ') ? 'intake:enforcement_unavailable'
          : `intake:broker_unavailable error=${e instanceof Error ? e.name : 'Error'}`;
      if (blocker !== this.lastBlocker) this.log.warn(`event_intake_waiting reason=${blocker.slice(7)} — retrying; /ready answers 503 until the intake runs`);
      this.lastBlocker = blocker;
      const ceiling = Math.min(START_RETRY.maxMs, START_RETRY.baseMs * 2 ** Math.min(this.attempts++, 10));
      if (!this.stopped) this.timer = setTimeout(() => void this.tryStart(), Math.round(ceiling / 2 + (Math.random() * ceiling) / 2));
    }
  }

  /** Why the intake must not consume yet, or undefined. Never includes a value from the environment or the database. */
  private async startBlocker(): Promise<string | undefined> {
    // Core V2 S1b-3 (S0-C2): no provenance key ring, no consumption (never an unkeyed fallback); a malformed ring already failed at boot.
    if (!this.config.provenanceKeys) return 'intake:provenance_keys_missing';
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

  /**
   * V2 A12.4.3: the log context is restored from VALIDATED event values (a hostile id or correlation header is never echoed).
   * Core V2 S1e-4: intake receives the TRUSTED envelope (`trustedIntakeEvent`); without an accepted decision it is refused before intake.
   */
  private handle(event: EventEnvelope, trust: HandlerTrust | undefined): Promise<void> {
    let trusted: EventEnvelope;
    try {
      trusted = trustedIntakeEvent(event, trust);
    } catch (e) {
      return Promise.reject(e);
    }
    return runWithEventContext(trusted, async () => {
      await this.intake.handle(trusted);
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

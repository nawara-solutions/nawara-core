import amqp from 'amqplib';
import {
  Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  DbService, DB_OPTIONS, PgProvenanceStore, ReadinessRegistry, assertEnforceable, pendingMigrations, runWithRequestContext, type DbOptions, type EventBus, type EventEnvelope,
  type EnforcementPolicy, type HandlerTrust,
} from '@nawara/service-kit';
import { AUDIT_CONFIG } from '../config/audit-config.token.js';
import type { AuditConfig } from '../config/audit-config.js';
import { auditEventOwner } from './admission.js';
import { BrokerNotices } from './broker-notices.js';
import { auditDeadLetterPolicy } from './dead-letter-policy.js';
import { AUDIT_BINDINGS, AUDIT_QUEUE, OPS_SNAPSHOT_INTERVAL_MS } from './ingestion.constants.js';
import { IngestionCounters } from './ingestion-counters.js';
import { IngestionService } from './ingestion.service.js';
import { auditEnforcement, untrustedReason } from './trust-policy.js';

export const AUDIT_EVENT_BUS = Symbol('AUDIT_EVENT_BUS');
/** A bus that can report whether its consumers are attached (the kit's `RabbitMqEventBus`). */
type IngestionBus = EventBus & { consumerStatus?: () => Array<{ state: string }> };

const START_RETRY = { baseMs: 250, maxMs: 5_000 };
const CORRELATION = /^[A-Za-z0-9._:-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Runs the audit ingestion consumer on the kit RabbitMQ bus, with the Core lifecycle (Notification's Stage 16.5 pattern):
 * - START: the consumer attaches only once the database answers and every migration is applied (no event is taken before it can be
 *   stored). Until then, and while the broker is unreachable, the process stays up, `/ready` answers 503, and the start is retried with
 *   bounded, jittered backoff (the kit's first `subscribe` fails fast; the retry is here). After it attached, the kit supervises the
 *   consumer: a lost channel or connection is re-established by itself, with bounded backoff.
 * - READINESS (Stage 18.5): `rabbitmq` (the broker answers a connect) and `audit-ingestion` (the consumer is attached and consuming), on
 *   top of the kit's `database` and `migrations`. Audit cannot do its primary job without them, so `/ready` requires them; `/health`
 *   (liveness) is unchanged and never depends on the broker.
 * - SHUTDOWN (Stage 15.5 order): at shutdown START the consumer is cancelled (no new delivery), in-flight deliveries finish and are
 *   settled within the kit's bound (an unfinished one is left unacknowledged → redelivered: at least once), while the pool is still open;
 *   the bus closes in `onApplicationShutdown`; the kit closes the pool last. `/ready` is 503 from the first moment (the kit's drain).
 * Each delivery runs in a request context whose correlation id is the event's (when it has the kit grammar), so log lines join.
 * - ENFORCEMENT (Core V2 S1e-3, ADR-0057 "S0-C6"): the subscription is always enforced, in the configured mode (`trust-policy.ts`):
 *   the compatibility phase (default) or strict. Its policy is checked at bootstrap: a subscription that could not be enforced as declared
 *   fails the start of the process, never falling back to another mode or to no enforcement.
 */
@Injectable()
export class AuditConsumer implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly log = new Logger('AuditIngestion');
  private subscription?: { close(): Promise<void> };
  private closing?: Promise<void>;
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private snapshotTimer?: NodeJS.Timeout;
  private attempts = 0;
  private lastBlocker = '';
  /** S1e-3: the subscription's provenance and policy, created once: the objects checked at bootstrap are the ones `subscribe` receives. */
  private readonly provenance: { ownerOf: typeof auditEventOwner; store: PgProvenanceStore };
  private readonly enforcement: EnforcementPolicy;

  constructor(
    @Inject(IngestionService) private readonly ingestion: IngestionService,
    @Inject(IngestionCounters) private readonly counters: IngestionCounters,
    @Inject(AUDIT_EVENT_BUS) private readonly bus: IngestionBus,
    @Inject(DbService) private readonly db: DbService,
    @Inject(DB_OPTIONS) private readonly dbOptions: DbOptions,
    @Inject(ReadinessRegistry) private readonly readiness: ReadinessRegistry,
    @Inject(AUDIT_CONFIG) private readonly config: AuditConfig,
    @Inject(BrokerNotices) private readonly notices: BrokerNotices,
  ) {
    this.provenance = { ownerOf: auditEventOwner, store: new PgProvenanceStore(this.db) };
    this.enforcement = auditEnforcement(this.config.provenanceEnforcement); // throws on any other mode: never a fallback
  }

  onModuleInit(): void {
    this.readiness.register('rabbitmq', async () => {
      const conn = await amqp.connect(this.config.rabbitmqUrl, { timeout: 2000 });
      await conn.close();
    });
    this.readiness.register('audit-ingestion', async () => {
      if (!this.subscription) throw new Error('audit ingestion not started');
      if (this.bus.consumerStatus?.().some((c) => c.state !== 'consuming')) throw new Error('audit ingestion consumer not attached');
    });
  }

  onApplicationBootstrap(): void {
    // S1e-3: refused here (the process does not start), not retried as if the broker were unavailable
    assertEnforceable({ queue: AUDIT_QUEUE, provenance: this.provenance, enforcement: this.enforcement, deadLetterPolicy: auditDeadLetterPolicy });
    this.snapshotTimer = setInterval(() => this.snapshot(), OPS_SNAPSHOT_INTERVAL_MS);
    this.snapshotTimer.unref();
    void this.tryStart();
  }

  /** True once the consumer is attached. */
  get started(): boolean {
    return this.subscription !== undefined;
  }

  private async tryStart(): Promise<void> {
    if (this.stopped || this.subscription) return;
    try {
      const blocker = await this.startBlocker();
      if (blocker) throw new Error(blocker);
      const sub = await this.bus.subscribe({
        queue: AUDIT_QUEUE, bindings: [...AUDIT_BINDINGS], handler: (e, trust) => this.handle(e, trust),
        deadLetterPolicy: auditDeadLetterPolicy, // Stage 18.8: refused content is not kept verbatim in the DLQ
        // Core V2 S1b-2 (ADR-0057 §13.2 "Audit admission", S0-C1): every delivery, on any exchange, is admitted (canonical bytes, the Stage
        // 18.8 screen, the full contract) BEFORE provenance; a refusal is dead-lettered at once with no provenance row and no body digest.
        admission: (e, body) => this.ingestion.admit(e, body),
        provenance: this.provenance,
        // Core V2 S1e-3 (ADR-0057 §13.5, "S0-C6"): an admitted delivery's trust decision is durable before `handle`, which runs only for an
        // accepted one (or, in the compatibility phase, an unverified one); refusals are permanent (under the policy above), failures held.
        // Retention: none yet (gate AP-R, P-A2 open).
        enforcement: this.enforcement,
      });
      if (this.stopped) {
        await sub.close();
        return;
      }
      this.subscription = sub;
      this.attempts = 0;
      this.lastBlocker = '';
      this.log.log(`audit_ingestion_started queue=${AUDIT_QUEUE} bindings=${AUDIT_BINDINGS.join(',')} enforcement=${this.config.provenanceEnforcement}`);
    } catch (e) {
      // S1e-3: a bus that refuses the enforced subscription (e.g. one with no broker identity) is named as such, never as an outage, and
      // nothing is consumed in another mode meanwhile
      const blocker = e instanceof Error && e.message.startsWith('ingestion:') ? e.message
        : e instanceof Error && e.message.startsWith('enforcement for ') ? 'ingestion:enforcement_unavailable'
          : `ingestion:broker_unavailable error=${e instanceof Error ? e.name : 'Error'}`;
      if (blocker !== this.lastBlocker) this.log.warn(`audit_ingestion_waiting reason=${blocker.slice(10)} — retrying; /ready answers 503 until ingestion runs`);
      this.lastBlocker = blocker;
      const ceiling = Math.min(START_RETRY.maxMs, START_RETRY.baseMs * 2 ** Math.min(this.attempts++, 10));
      if (!this.stopped) this.timer = setTimeout(() => void this.tryStart(), Math.round(ceiling / 2 + (Math.random() * ceiling) / 2));
    }
  }

  /** Why ingestion must not consume yet, or undefined. Never includes a value from the environment or the database. */
  private async startBlocker(): Promise<string | undefined> {
    try {
      await this.db.ping();
      if ((await pendingMigrations(this.db, this.dbOptions.migrations?.dirs ?? [])).length > 0) return 'ingestion:migrations_pending';
    } catch {
      return 'ingestion:database_unavailable';
    }
    return undefined;
  }

  private handle(event: EventEnvelope, trust: HandlerTrust | undefined): Promise<void> {
    // S1e-3: defence in depth behind the kit's decision; a refusal here happens before ingestion (no record, no de-duplication slot)
    const untrusted = untrustedReason(this.config.provenanceEnforcement, event, trust);
    if (untrusted) return Promise.reject(this.ingestion.refuseUntrusted(untrusted, event));
    const id = typeof event.id === 'string' && UUID.test(event.id) ? event.id : 'unknown';
    const header = event.headers?.correlationId;
    const correlationId = typeof header === 'string' && CORRELATION.test(header) ? header : `event:${id}`;
    return runWithRequestContext({ requestId: `event:${id}`, correlationId }, async () => {
      await this.ingestion.ingest(event);
    });
  }

  private snapshot(): void {
    const s = this.counters.drain();
    const refused = Object.entries(s.refused).map(([k, v]) => `refused_${k}=${v}`).join(' ');
    const b = this.notices.drain();
    const broker = Object.entries(b.counts).map(([k, v]) => `${k}=${v}`).join(' ');
    this.log.log(
      `audit_ops_snapshot received=${s.counts.received} persisted=${s.counts.persisted} duplicate=${s.counts.duplicate} refused=${s.counts.refused}` +
        `${refused ? ` ${refused}` : ''} transient_failure=${s.counts.transient_failure} clock_skew_future=${s.counts.clock_skew_future}` +
        ` lag_count=${s.lag.count} lag_avg_ms=${s.lag.avgMs} lag_max_ms=${s.lag.maxMs} in_flight=${s.inFlight} consumer=${this.subscription ? 'attached' : 'detached'}` +
        ` ${broker} logs_suppressed=${b.suppressed + s.logsSuppressed}`,
    );
  }

  /** Stage 15.5: closing starts at shutdown start; the later hooks await the same close. */
  onModuleDestroy(): void {
    this.close().catch(() => undefined);
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.close(); // in-flight deliveries finish (bounded by the kit) while the database pool is still open
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
    await this.bus.close(); // bounded by the kit (3 × heartbeat at worst)
  }

  private close(): Promise<void> {
    if (!this.closing) {
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
      if (this.snapshotTimer) clearInterval(this.snapshotTimer);
      const sub = this.subscription;
      this.subscription = undefined;
      this.closing = (sub ? sub.close() : Promise.resolve()).finally(() => this.snapshot());
    }
    return this.closing;
  }
}

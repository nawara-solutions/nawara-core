import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { BoundedObservationBuffer, type DeadLetterObservation, type DeadLetterObserver, type ObservationBufferStats } from '@nawara/service-kit';
import { AUDIT_CONFIG } from '../config/audit-config.token.js';
import type { AuditConfig } from '../config/audit-config.js';
import { AUDIT_QUEUE } from '../ingestion/ingestion.constants.js';
import { DeadLetterObservationRepository } from './dead-letter-observation.repository.js';
import type { CoverageKind, NewDeadLetterTransition } from './dead-letter-observation.types.js';

/** The Owner's development defaults (D43-1, D43-8): 1000 observations, a flush every second, a heartbeat every 60 seconds. */
export const OBSERVATION_BUFFER_CAPACITY = 1_000;
export const OBSERVATION_FLUSH_INTERVAL_MS = 1_000;
export const COVERAGE_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Core V2 DO-43c (the Owner's D43-1 to D43-3, D43-8; DEVELOPMENT AND SIMULATION DIAGNOSTICS ONLY): Audit's own dead-letter transfers,
 * observed best effort, and the coverage facts that say when those observations are incomplete. Active only with
 * `AUDIT_DEAD_LETTER_OBSERVATION=enabled` (production refuses it); otherwise it gives no observer and writes nothing.
 *
 * - The consumer passes `observer()` to the kit, which calls it synchronously and never awaits it; it only offers to a bounded buffer
 *   (1000). A background flush (every second) writes batches; a failed flush (the database unavailable) is lost and COUNTED, never retried
 *   on the delivery path. Settlement never depends on any of this.
 * - Coverage, per process instance (a fresh id at every start): `started` (seq 0), a `heartbeat` every 60 s with the buffer's cumulative
 *   counters, and `stopped` after the final flush at a clean shutdown. A crash leaves no `stopped`; a restart is a new instance; a coverage
 *   write that fails is simply absent (the missing heartbeat IS the signal). If `started` could not be written, the next tick retries it
 *   first, so an instance's facts are always one forward sequence.
 * - Header-only: identifiers, codes, counters and times (see the kit's `DeadLetterObservation`); never a body or an error message.
 */
@Injectable()
export class DeadLetterObservationService implements OnApplicationBootstrap, OnApplicationShutdown {
  readonly instanceId = randomUUID();
  private readonly log = new Logger('AuditDeadLetterObservation');
  private readonly buffer?: BoundedObservationBuffer<DeadLetterObservation>;
  private readonly consumers = [AUDIT_QUEUE];
  private timer?: NodeJS.Timeout;
  private seq = 0;
  private startedRecorded = false;
  private stoppedRecorded = false;
  /** Coverage writes are serialized, so seq is assigned in the order the database receives them. */
  private chain: Promise<void> = Promise.resolve();
  private stopping?: Promise<void>;

  constructor(
    @Inject(DeadLetterObservationRepository) private readonly repo: DeadLetterObservationRepository,
    @Inject(AUDIT_CONFIG) private readonly config: AuditConfig,
  ) {
    if (!config.deadLetterObservation) return;
    this.buffer = new BoundedObservationBuffer<DeadLetterObservation>({
      capacity: OBSERVATION_BUFFER_CAPACITY,
      flushIntervalMs: OBSERVATION_FLUSH_INTERVAL_MS,
      sink: (batch) => this.repo.insertTransitions(batch.map((o) => this.row(o))),
      onSinkFailure: (lost, e) => this.log.warn(`audit_dead_letter_observation_lost count=${lost} error=${e instanceof Error ? e.name : 'Error'} — counted in coverage; settlement unaffected`),
    });
  }

  /** The kit observer for Audit's own subscription, or undefined when the diagnostics are disabled (then the bus behaves as before). */
  observer(): DeadLetterObserver | undefined {
    const buffer = this.buffer;
    if (!buffer || this.stopping) return undefined;
    return { observe: (o) => { buffer.offer(o); } };
  }

  stats(): ObservationBufferStats | undefined {
    return this.buffer?.stats();
  }

  onApplicationBootstrap(): void {
    if (!this.buffer) return;
    this.buffer.start();
    void this.record('started');
    this.timer = setInterval(() => void this.record('heartbeat'), COVERAGE_HEARTBEAT_INTERVAL_MS);
    this.timer.unref();
    this.log.log(`audit_dead_letter_observation_enabled instance=${this.instanceId} capacity=${OBSERVATION_BUFFER_CAPACITY} flushMs=${OBSERVATION_FLUSH_INTERVAL_MS} heartbeatMs=${COVERAGE_HEARTBEAT_INTERVAL_MS} — development diagnostics only`);
  }

  /** One heartbeat now (the timer's job; also used by tests instead of waiting 60 s). */
  heartbeat(): Promise<void> {
    return this.record('heartbeat');
  }

  /** Flushes what is buffered now (the timer's job; also used by tests). */
  async flush(): Promise<void> {
    await this.buffer?.flush();
  }

  /**
   * Called by the consumer once it closed (no delivery can dead-letter any more), and again at application shutdown (idempotent): stops the
   * timer, flushes what is left, then records `stopped`. Bounded by the database's own statement deadlines.
   */
  stop(): Promise<void> {
    if (!this.buffer) return Promise.resolve();
    this.stopping ??= (async () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      await this.buffer!.stop();
      await this.record('stopped');
    })();
    return this.stopping;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  private record(kind: CoverageKind): Promise<void> {
    const buffer = this.buffer;
    if (!buffer || this.stoppedRecorded) return Promise.resolve();
    this.chain = this.chain.then(async () => {
      if (this.stoppedRecorded) return;
      try {
        if (!this.startedRecorded) {
          await this.repo.insertCoverage({ ...this.fact('started', 0, buffer.stats()) });
          this.startedRecorded = true;
          if (kind === 'started') return;
        }
        if (kind === 'started') return;
        const seq = this.seq + 1;
        await this.repo.insertCoverage(this.fact(kind, seq, buffer.stats()));
        this.seq = seq;
        if (kind === 'stopped') this.stoppedRecorded = true;
      } catch (e) {
        this.log.warn(`audit_dead_letter_coverage_unrecorded kind=${kind} instance=${this.instanceId} error=${e instanceof Error ? e.name : 'Error'} — the gap is the signal (coverage unknown)`);
      }
    });
    return this.chain;
  }

  private fact(kind: CoverageKind, seq: number, s: ObservationBufferStats) {
    return {
      instanceId: this.instanceId, kind, seq, consumers: this.consumers, observedTotal: s.observedTotal, persistedTotal: s.persistedTotal,
      droppedOverflow: s.droppedOverflow, droppedSink: s.droppedSink, rejectedTotal: s.rejectedTotal, buffered: s.buffered, observedAt: new Date(),
    };
  }

  private row(o: DeadLetterObservation): NewDeadLetterTransition {
    return {
      attemptId: o.attemptId, transition: o.transition, instanceId: this.instanceId, consumer: o.queue, eventId: o.eventId, eventName: o.eventName,
      source: o.source, failure: o.failure, reason: o.reason, errorClass: o.errorClass, retryCount: o.retryCount, replayCount: o.replayCount,
      redelivered: o.redelivered, observedAt: o.observedAt,
    };
  }
}

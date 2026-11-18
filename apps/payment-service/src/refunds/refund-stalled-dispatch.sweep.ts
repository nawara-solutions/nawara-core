import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, type DrainOutcome } from '@nawara/service-kit';
import type { EventContext } from '../events/payment-events.js';
import { RefundSafetyService } from './refund-safety.service.js';

/** How often the sweep looks (technical tuning, not a threshold; the 72-hour threshold is migration 0034's constant, never configuration). */
export const STALLED_DISPATCH_SWEEP_INTERVAL_MS = 300_000;

/** Attempts the database will accept as stalled now (it re-checks every one at insert): stuck, never submitted, 72 h after authorization, not yet escalated. */
const DUE = `SELECT a.id FROM refund_attempt a
  WHERE refund_attempt_dispatch_stuck(a.status, a."submittedAt") AND a."authorizedAt" IS NOT NULL AND now() >= a."authorizedAt" + refund_dispatch_stalled_threshold()
    AND NOT EXISTS (SELECT 1 FROM refund_safety_escalation e WHERE e."refundAttemptId" = a.id AND e.kind = 'dispatch_stalled')
  ORDER BY a."authorizedAt", a.id LIMIT $1`;

/** Escalations whose attempt has left the stuck state and that have no exit observation yet. */
const EXITED = `SELECT e.id FROM refund_safety_escalation e JOIN refund_attempt a ON a.id = e."refundAttemptId"
  WHERE e.kind = 'dispatch_stalled' AND NOT refund_attempt_dispatch_stuck(a.status, a."submittedAt")
    AND NOT EXISTS (SELECT 1 FROM refund_safety_escalation_exit x WHERE x."escalationId" = e.id)
  ORDER BY e.id LIMIT $1`;

const constraintOf = (e: unknown): string | undefined => (e && typeof e === 'object' && 'constraint' in e ? String((e as { constraint?: unknown }).constraint) : undefined);

/**
 * Core V2 G3 (DO-44; the Owner's G3 + G2 GO, package B): a review item for a refund attempt whose dispatch outcome stays unknown — `dispatching` or
 * `unknown`, never acknowledged by the provider (`submittedAt` absent), 72 hours after its authorization. ESCALATION ONLY: the item does not hold the
 * attempt (the dispatch rule reads `dispatch_held` only), never stops the refund worker's same-key retry (R6B-4, R6B-9), and releases, resolves,
 * allocates, cancels and refunds nothing. `authorization_pending` is NOT covered here: S6h's PAY-12 item already shows it after 15 minutes.
 * Each item is its own transaction with its audit intent; a repeat (another instance, a retried pass) writes nothing. Exit observations follow.
 * Mounted only with refunds (never in production).
 */
@Injectable()
export class RefundStalledDispatchSweep {
  private readonly logger = new Logger('PaymentRefundStalledDispatchSweep');
  private readonly loop = new PollLoop(
    () => this.sweepOnce(),
    (e) => this.logger.error(`refund_stalled_dispatch_sweep_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.logger.warn(`worker_drain_timeout worker=refund_stalled_dispatch_sweep drainTimeoutMs=${ms} — shutdown proceeds; the next start sweeps again`),
  );
  private running = false;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(RefundSafetyService) private readonly safety: RefundSafetyService,
  ) {}

  start(intervalMs = STALLED_DISPATCH_SWEEP_INTERVAL_MS): void {
    this.loop.start(intervalMs);
  }

  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  /** One pass. Exposed directly for tests. */
  async sweepOnce(batchSize = 100): Promise<{ escalated: number; exited: number }> {
    if (this.running) return { escalated: 0, exited: 0 };
    this.running = true;
    try {
      let escalated = 0;
      for (const { id } of (await this.db.query<{ id: string }>(DUE, [batchSize])).rows) {
        const ctx: EventContext = { actor: { type: 'system', id: null }, cause: { type: 'refund_worker', id }, correlationId: `refund-stalled:${id}` };
        try {
          const escalation = await this.db.tx((q) => this.safety.escalate(q, { kind: 'dispatch_stalled', refundAttemptId: id, factId: null }, ctx));
          if (escalation) {
            escalated++;
            this.logger.warn(`refund_safety_escalation kind=dispatch_stalled refundAttempt=${id} escalation=${escalation} — review only; the attempt and its retry are unchanged`);
          }
        } catch (e) {
          if (constraintOf(e) === 'refund_safety_escalation_not_due') continue; // it left the stuck state after the read
          this.logger.warn(`refund_stalled_dispatch_escalation_failure refundAttempt=${id} ${describeFailure(e)} — nothing written; the next pass retries`);
        }
      }
      let exited = 0;
      for (const { id } of (await this.db.query<{ id: string }>(EXITED, [batchSize])).rows) {
        const ctx: EventContext = { actor: { type: 'system', id: null }, cause: { type: 'refund_worker', id }, correlationId: `refund-stalled-exit:${id}` };
        try {
          if (await this.db.tx((q) => this.safety.observeStalledExit(q, id, ctx))) exited++;
        } catch (e) {
          if (constraintOf(e) === 'refund_safety_escalation_exit_not_exited') continue;
          this.logger.warn(`refund_stalled_dispatch_exit_failure escalation=${id} ${describeFailure(e)} — nothing written; the next pass retries`);
        }
      }
      return { escalated, exited };
    } finally {
      this.running = false;
    }
  }
}

/** Starts the sweep at bootstrap and drains it at shutdown (the refund worker's lifecycle). */
@Injectable()
export class RefundStalledDispatchSweepService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(@Inject(RefundStalledDispatchSweep) private readonly sweep: RefundStalledDispatchSweep) {}
  onApplicationBootstrap(): void {
    this.sweep.start();
  }
  onModuleDestroy(): void {
    void this.sweep.stop();
  }
  async beforeApplicationShutdown(): Promise<void> {
    await this.sweep.stop();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.sweep.stop();
  }
}

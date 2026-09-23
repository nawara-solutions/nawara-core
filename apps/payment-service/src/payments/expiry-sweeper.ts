import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, OutboxService, PollLoop, describeFailure, type DrainOutcome } from '@nawara/service-kit';
import { jobContext, paymentEvent, type EventContext } from '../events/payment-events.js';
import type { PaymentRow } from './payment.types.js';

/**
 * Expires payments past their `expiresAt` (SDD section 5.1, 12): only when no attempt is open — money in flight, or
 * cash awaiting review, must be resolved first. A payment without `expiresAt` is never swept (O-16, not decided).
 * Same start/stop shape as `AttemptResolver`/`WebhookRetrier`/the kit's `OutboxRelay`.
 */
@Injectable()
export class ExpirySweeper {
  // Stage 14.6: no overlapping passes, and a graceful stop that waits (bounded) for the pass in flight.
  // Stage 14.7: the failure's class, code and kind (a statement timeout, an unreachable database...), never its message; a bounded drain that ran out is reported.
  private readonly loop = new PollLoop(
    () => this.sweepOnce(),
    (e) => this.logger.error(`expiry_sweep_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.logger.warn(`worker_drain_timeout worker=expiry_sweeper drainTimeoutMs=${ms} — shutdown proceeds; the interrupted pass's work is picked up again after restart`),
  );
  private running = false;
  private readonly logger = new Logger(ExpirySweeper.name);

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  start(intervalMs = 5000): void {
    // A whole-pass failure (for example the scan query) must not escape as an unhandled rejection: log it and let the next tick run.
    this.loop.start(intervalMs);
  }

  /** Stops scheduling passes and waits, bounded, for the one in flight (see `PollLoop`). */
  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  async sweepOnce(): Promise<{ expired: number }> {
    if (this.running) return { expired: 0 };
    this.running = true;
    try {
      const { rows } = await this.db.query<{ id: string }>(
        `SELECT id FROM payment WHERE "expiresAt" IS NOT NULL AND "expiresAt" <= now() AND status IN ('created', 'pending')`,
      );
      let expired = 0;
      const ctx = jobContext('expiry_sweep'); // one run, one correlation id
      for (const { id } of rows) if (await this.trySweepOne(id, ctx)) expired++;
      return { expired };
    } finally {
      this.running = false;
    }
  }

  private async trySweepOne(paymentId: string, ctx: EventContext): Promise<boolean> {
    return this.db.tx(async (q) => {
      // Database time is the only clock (SDD section 12): "due" is decided by the database, not by this process's clock.
      const { rows } = await q.query<PaymentRow & { due: boolean }>(
        'SELECT *, ("expiresAt" IS NOT NULL AND "expiresAt" <= now()) AS due FROM payment WHERE id = $1 FOR UPDATE',
        [paymentId],
      );
      const payment = rows[0];
      if (!payment || !payment.expiresAt || !payment.due) return false;
      if (payment.status !== 'created' && payment.status !== 'pending') return false;
      const { rows: open } = await q.query(`SELECT 1 FROM payment_attempt WHERE "paymentId" = $1 AND status IN ('initiated', 'submitted', 'unknown')`, [paymentId]);
      if (open.length > 0) return false; // money in flight must be resolved first (the resolver settles it)
      const { rows: updated } = await q.query<PaymentRow>(`UPDATE payment SET status = 'expired', "closedAt" = now() WHERE id = $1 RETURNING *`, [paymentId]);
      await this.outbox.enqueue(q, paymentEvent('payment.expired', updated[0], ctx, { expiresAt: payment.expiresAt.toISOString() }));
      return true;
    });
  }
}

@Injectable()
export class ExpirySweeperService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly sweeper: ExpirySweeper) {}
  onApplicationBootstrap(): void {
    this.sweeper.start();
  }
  /**
   * Stage 15.5 (F-D): the drain STARTS at shutdown start (Nest runs every onModuleDestroy before any beforeApplicationShutdown), so the
   * service's workers drain concurrently instead of one module after another; `stop()` is idempotent and the later hooks await it.
   */
  onModuleDestroy(): void {
    void this.sweeper.stop();
  }
  /** Drains BEFORE any onApplicationShutdown closes the database pool or the broker (Nest runs every beforeApplicationShutdown first). */
  async beforeApplicationShutdown(): Promise<void> {
    await this.sweeper.stop();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.sweeper.stop(); // idempotent: the same drain, already finished when Nest drives the shutdown
  }
}

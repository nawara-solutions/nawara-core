import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, OutboxService, PollLoop, describeFailure, type DrainOutcome } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import { jobContext } from '../events/payment-events.js';
import { recordQualifyingLateSuccesses } from './late-success-at-finality.js';
import type { PaymentRow } from './payment.types.js';

/** S0-C12 item 7: one pass handles at most this many facts; the rest wait for the next pass (bounded work per pass). */
export const CAPTURE_RECONCILE_BATCH = 100;

/**
 * Core V2 S0-C12 item 7 (register PAY-05 J): the durable, bounded, idempotent completion of the one window no transaction can close. FC-1 and V-2
 * commit a capture fact on its own BEFORE its processing; when that processing is lost (a crash, a failed transaction) on a payment that is, or
 * later becomes, `failed` / `cancelled` / `expired`, this pass records the late success that S0-C12 item 6 would have recorded.
 *   - Durable: it selects from committed records only (no queue to lose); an interrupted pass is simply re-run.
 *   - Bounded: at most `CAPTURE_RECONCILE_BATCH` facts per pass, oldest first; a payment another transaction holds is skipped (`SKIP LOCKED`).
 *   - Idempotent: under the payment lock, through the same helper as the finality writers (no late success for a fact that has one; the fact's
 *     own observation key, `payment_late_success_once`, and its fact's key, `payment_late_success_one_per_fact`; the event and audit ids derived from
 *     the row). Concurrent passes serialize per payment.
 * It never settles, never reopens a final status, and never touches a contested fact, a non-ISO currency or a payment that is not final.
 */
@Injectable()
export class CaptureReconciler {
  private readonly loop = new PollLoop(
    () => this.reconcileOnce(),
    (e) => this.logger.error(`capture_reconcile_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.logger.warn(`worker_drain_timeout worker=capture_reconciler drainTimeoutMs=${ms} — shutdown proceeds; the interrupted pass's work is picked up again after restart`),
  );
  private running = false;
  private readonly logger = new Logger(CaptureReconciler.name);

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PaymentAudit) private readonly audit: PaymentAudit,
  ) {}

  start(intervalMs = 30_000): void {
    this.loop.start(intervalMs);
  }

  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  async reconcileOnce(): Promise<{ recorded: number }> {
    if (this.running) return { recorded: 0 };
    this.running = true;
    try {
      const { rows } = await this.db.query<{ factId: string; paymentId: string }>(
        `SELECT f.id AS "factId", f."paymentId" FROM provider_transaction_fact f JOIN payment p ON p.id = f."paymentId"
          WHERE f.kind = 'capture' AND p.status IN ('failed', 'cancelled', 'expired') AND trim(f.currency) ~ '^[A-Z]{3}$'
            AND NOT EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id)
            AND NOT EXISTS (SELECT 1 FROM payment_late_success l WHERE l."factId" = f.id)
          ORDER BY f."observedAt", f.id LIMIT $1`, [CAPTURE_RECONCILE_BATCH]);
      const ctx = jobContext('capture_reconciler'); // one run, one correlation id
      let recorded = 0;
      for (const r of rows) {
        recorded += await this.db.tx(async (q) => {
          const payment = (await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1 FOR UPDATE SKIP LOCKED', [r.paymentId])).rows[0];
          if (!payment) return 0; // held by another transaction: the next pass re-reads it
          return recordQualifyingLateSuccesses(q, { outbox: this.outbox, audit: this.audit }, payment, ctx, { onlyFactId: r.factId, actor: 'payment_capture_reconciler' });
        });
      }
      if (recorded > 0) this.logger.warn(`capture_reconcile_recorded lateSuccesses=${recorded} — a committed capture fact's lost processing was completed`);
      return { recorded };
    } finally {
      this.running = false;
    }
  }
}

@Injectable()
export class CaptureReconcilerService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly reconciler: CaptureReconciler) {}
  onApplicationBootstrap(): void {
    this.reconciler.start();
  }
  onModuleDestroy(): void {
    void this.reconciler.stop();
  }
  async beforeApplicationShutdown(): Promise<void> {
    await this.reconciler.stop();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.reconciler.stop();
  }
}

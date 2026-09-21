import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { runWithRequestContext } from '@nawara/service-kit';
import type { BillingConfig } from '../config/billing-config.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import { jobTransitionContext } from '../domain/actors.js';
import { PaymentRequestRepository, type ScanPosition } from '../invoices/payment-request.repository.js';
import { PAYMENT_CLIENT } from './payment-client.token.js';
import type { PaymentClient } from './payment-client.js';

/**
 * Settles `requested` payment requests that have gone stale with no terminal event (SDD 21.5): the only recovery
 * path for "Payment succeeded (or failed/cancelled/expired) but Billing missed the event," because the broker gives
 * no automatic retry-with-backoff of its own (a failed consumer goes straight to the dead-letter queue). A `sending`
 * row that never got a Payment answer is NOT this job's concern — `PaymentDispatcher`'s own claim query already
 * re-sends a stale `sending` row on its next pass (safe: the natural key makes a repeat create idempotent), so
 * nothing here duplicates that. Same start/stop shape as `PaymentDispatcher`/the kit's `OutboxRelay`.
 */
@Injectable()
export class PaymentReconciler {
  private timer?: NodeJS.Timeout;
  private running = false;
  /**
   * Where the previous full pass stopped. Requests Payment still reports as unpaid are never updated, so they stay at the head of
   * a `updatedAt` scan: resuming after the last row examined lets every later request be reached, one batch per pass, before the
   * scan starts over from the oldest. In memory on purpose: a restart merely begins again from the oldest row (nothing is skipped,
   * nothing is lost), and each request's outcome is decided by Payment's answer, never by this position.
   */
  private cursor: ScanPosition | null = null;
  private readonly logger = new Logger(PaymentReconciler.name);

  constructor(
    private readonly requests: PaymentRequestRepository,
    @Inject(PAYMENT_CLIENT) private readonly paymentClient: PaymentClient,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  start(intervalMs = this.config.reconcile.intervalMs): void {
    if (this.timer) return;
    // A whole-pass failure (for example the scan query) must not escape as an unhandled rejection: log it and let the next tick run.
    this.timer = setInterval(() => void this.reconcileOnce().catch((e) => this.logger.error(`payment_reconcile_pass_failure error=${e instanceof Error ? e.name : 'unknown'} — the next pass retries`)), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass. Exposed directly for tests (no need to wait on a real interval). */
  async reconcileOnce(staleRequestedMs = this.config.reconcile.staleRequestedMs, batchSize = 50): Promise<{ checked: number; settled: number }> {
    if (this.running) return { checked: 0, settled: 0 }; // a previous pass is still running; do not overlap
    this.running = true;
    try {
      const stale = await this.requests.findStaleRequested(batchSize, staleRequestedMs, this.cursor);
      // A short page means the end of the scan was reached: start over from the oldest next time.
      this.cursor = stale.length < batchSize ? null : stale[stale.length - 1]!.position;
      let settled = 0;
      for (const { id, paymentId, correlationId } of stale) {
        const ctx = jobTransitionContext('reconciliation', id, correlationId);
        // One request that cannot be reconciled (Payment unreachable, a genuine conflict) must never block the others.
        try {
          // Scopes the outbound call under the request's own correlation id (same reasoning as the dispatcher): a
          // background job has no ambient AsyncLocalStorage context, so without this `correlationHeaders()` sends nothing.
          const snapshot = await runWithRequestContext({ requestId: randomUUID(), correlationId }, () => this.paymentClient.getPayment(paymentId));
          if (!snapshot) {
            this.logger.warn(`payment_reconcile_failure request=${id} correlationId=${correlationId}: Payment no longer has payment ${paymentId} — needs manual reconciliation`);
            continue;
          }
          const result = await this.requests.applyReconciledSnapshot(snapshot, ctx);
          if (result === null) continue; // still created/pending at Payment: not stale enough to act on yet
          if (result.outcome === 'applied') {
            settled++;
            this.logger.log(`payment_reconcile_success request=${id} correlationId=${correlationId} paymentId=${paymentId}`);
          }
          if (result.outcome === 'conflict') this.logger.error(`payment_reconcile_failure request=${id} correlationId=${correlationId} reason=conflict detail=${result.detail} — needs manual review`);
          if (result.outcome === 'deferred') this.logger.warn(`payment_reconcile_deferred request=${id} correlationId=${correlationId} detail=${result.detail}`);
        } catch (e) {
          this.logger.warn(`payment_reconcile_failure request=${id} correlationId=${correlationId} reason=exception: ${e instanceof Error ? e.message : 'unknown error'}`);
        }
      }
      return { checked: stale.length, settled };
    } finally {
      this.running = false;
    }
  }
}

@Injectable()
export class PaymentReconcilerService implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly reconciler: PaymentReconciler) {}
  onApplicationBootstrap(): void {
    this.reconciler.start();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.reconciler.stop();
  }
}

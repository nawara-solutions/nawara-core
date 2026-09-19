import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { BillingConfig } from '../config/billing-config.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import { requestTransitionContext } from '../domain/actors.js';
import { PaymentRequestRepository } from '../invoices/payment-request.repository.js';
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
  private readonly logger = new Logger(PaymentReconciler.name);

  constructor(
    private readonly requests: PaymentRequestRepository,
    @Inject(PAYMENT_CLIENT) private readonly paymentClient: PaymentClient,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  start(intervalMs = this.config.reconcile.intervalMs): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.reconcileOnce(), intervalMs);
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
      const stale = await this.requests.findStaleRequested(batchSize, staleRequestedMs);
      let settled = 0;
      const ctx = requestTransitionContext({ type: 'system', id: null }); // `cause: reconciliation` is set below, per row
      for (const { id, paymentId } of stale) {
        // One request that cannot be reconciled (Payment unreachable, a genuine conflict) must never block the others.
        try {
          const snapshot = await this.paymentClient.getPayment(paymentId);
          if (!snapshot) {
            this.logger.warn(`payment request ${id}: Payment no longer has payment ${paymentId} — needs manual reconciliation`);
            continue;
          }
          const result = await this.requests.applyReconciledSnapshot(snapshot, { ...ctx, cause: { type: 'reconciliation', id } });
          if (result === null) continue; // still created/pending at Payment: not stale enough to act on yet
          if (result.outcome === 'applied') settled++;
          if (result.outcome === 'conflict') this.logger.error(`payment request ${id}: reconciliation found a conflict (${result.detail}) — needs manual review`);
        } catch (e) {
          this.logger.warn(`payment request ${id} could not be reconciled: ${e instanceof Error ? e.message : 'unknown error'}`);
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

import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import type { BillingConfig } from '../config/billing-config.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import { requestTransitionContext } from '../domain/actors.js';
import { buildPaymentRequestBody } from '../domain/payment-request-mapping.js';
import { PaymentRequestRepository } from '../invoices/payment-request.repository.js';
import { PAYMENT_CLIENT } from './payment-client.token.js';
import type { PaymentClient } from './payment-client.js';

/**
 * Translates a Billing `payment_request` into a call to Payment (SDD 21.1, 21.5). It owns none of Payment's business
 * logic, changes no Payment state directly, creates no Payment row itself, and duplicates no Payment idempotency
 * logic — it only builds the pure, already-defined mapping and calls the port. Same start/stop shape as the kit's
 * `OutboxRelay` and Payment's own background jobs (`AttemptResolver`, `ExpirySweeper`).
 */
@Injectable()
export class PaymentDispatcher {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly logger = new Logger(PaymentDispatcher.name);

  constructor(
    private readonly requests: PaymentRequestRepository,
    @Inject(PAYMENT_CLIENT) private readonly paymentClient: PaymentClient,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  start(intervalMs = this.config.dispatch.intervalMs): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.dispatchOnce(), intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass: claim, then call Payment for each claim OUTSIDE any transaction. Exposed directly for tests. */
  async dispatchOnce(staleSendingMs = this.config.dispatch.staleSendingMs, batchSize = this.config.dispatch.batchSize): Promise<{ dispatched: number }> {
    if (this.running) return { dispatched: 0 }; // a previous pass is still running; do not overlap
    this.running = true;
    try {
      const ctx = requestTransitionContext({ type: 'system', id: null });
      const claims = await this.requests.claimForDispatch(batchSize, staleSendingMs, ctx);
      let dispatched = 0;
      for (const claim of claims) {
        // One request that cannot be sent (a config fault, a rejection) must never block the ones behind it.
        try {
          const body = buildPaymentRequestBody(claim.invoice, claim.request);
          const outcome = await this.paymentClient.createPayment(body);
          if (outcome.kind === 'accepted') {
            await this.requests.markRequested(claim.request.id, outcome.snapshot.paymentId, ctx);
            dispatched++;
          } else if (outcome.kind === 'rejected') {
            this.logger.error(`payment request ${claim.request.id} rejected by Payment: ${outcome.code ?? 'no code'} — this is a Billing or configuration defect`);
            await this.requests.markRejected(claim.request.id, ctx);
          } else if (outcome.kind === 'auth_fault') {
            this.logger.error(`payment request ${claim.request.id}: Payment refused Billing's own service token (configuration fault) — will retry`);
            // stays `sending`; the next pass (or the reconciler) retries once the token is fixed
          }
          // 'transient': stays `sending`; the next pass retries the identical request (safe by the natural key)
        } catch (e) {
          this.logger.warn(`payment request ${claim.request.id} could not be dispatched: ${e instanceof Error ? e.message : 'unknown error'}`);
        }
      }
      return { dispatched };
    } finally {
      this.running = false;
    }
  }
}

@Injectable()
export class PaymentDispatcherService implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly dispatcher: PaymentDispatcher) {}
  onApplicationBootstrap(): void {
    this.dispatcher.start();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.dispatcher.stop();
  }
}

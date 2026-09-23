import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { runWithRequestContext, PollLoop, describeFailure, type DrainOutcome } from '@nawara/service-kit';
import type { BillingConfig } from '../config/billing-config.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import { jobTransitionContext, type TransitionContext } from '../domain/actors.js';
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
  // Stage 14.6: no overlapping passes, and a graceful stop that waits (bounded) for the pass in flight.
  // Stage 14.7: the failure's class, code and kind (a statement timeout, an unreachable database...), never its message; a bounded drain that ran out is reported.
  private readonly loop = new PollLoop(
    () => this.dispatchOnce(),
    (e) => this.logger.error(`payment_dispatch_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.logger.warn(`worker_drain_timeout worker=payment_dispatcher drainTimeoutMs=${ms} — shutdown proceeds; the interrupted pass's work is picked up again after restart`),
  );
  private running = false;
  private readonly logger = new Logger(PaymentDispatcher.name);

  constructor(
    private readonly requests: PaymentRequestRepository,
    @Inject(PAYMENT_CLIENT) private readonly paymentClient: PaymentClient,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  start(intervalMs = this.config.dispatch.intervalMs): void {
    // A whole-pass failure (for example the claim query) must not escape as an unhandled rejection: log it and let the next tick run.
    this.loop.start(intervalMs);
  }

  /** Stops scheduling passes and waits, bounded, for the one in flight (see `PollLoop`). */
  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  /** One pass: claim, then call Payment for each claim OUTSIDE any transaction. Exposed directly for tests. */
  async dispatchOnce(staleSendingMs = this.config.dispatch.staleSendingMs, batchSize = this.config.dispatch.batchSize): Promise<{ dispatched: number }> {
    if (this.running) return { dispatched: 0 }; // a previous pass is still running; do not overlap
    this.running = true;
    try {
      // Only `actor` is read out of this by `claimForDispatch`: it computes each claimed row's own cause/correlation id
      // internally, from that row's `correlationId` column, since a single batch-level id would erase per-request traceability.
      const passCtx = jobTransitionContext('dispatcher', null, `dispatch-pass:${randomUUID()}`);
      const claims = await this.requests.claimForDispatch(batchSize, staleSendingMs, passCtx);
      let dispatched = 0;
      for (const claim of claims) {
        const ctx: TransitionContext = { actor: passCtx.actor, cause: { type: 'dispatcher', id: claim.request.id }, correlationId: claim.correlationId };
        if (claim.wasStale) {
          this.logger.warn(`payment_dispatch_stale_recovery request=${claim.request.id} correlationId=${claim.correlationId} — retrying a send that never got an answer`);
        }
        // One request that cannot be sent (a config fault, a rejection) must never block the ones behind it.
        try {
          const body = buildPaymentRequestBody(claim.invoice, claim.request);
          // Scopes the outbound call under the request's own correlation id so `HttpPaymentClient`'s `correlationHeaders()`
          // (which otherwise reads nothing, since a background job has no ambient AsyncLocalStorage context) carries it
          // to payment-service — the gap the Stage 5 audit found (dispatcher → Payment hop lost the correlation id).
          const outcome = await runWithRequestContext({ requestId: randomUUID(), correlationId: claim.correlationId }, () => this.paymentClient.createPayment(body));
          if (outcome.kind === 'accepted') {
            await this.requests.markRequested(claim.request.id, outcome.snapshot.paymentId, ctx);
            this.logger.log(`payment_dispatch_success request=${claim.request.id} correlationId=${claim.correlationId} paymentId=${outcome.snapshot.paymentId}`);
            dispatched++;
          } else if (outcome.kind === 'rejected') {
            this.logger.error(`payment_dispatch_rejected request=${claim.request.id} correlationId=${claim.correlationId} code=${outcome.code ?? 'none'} — this is a Billing or configuration defect`);
            await this.requests.markRejected(claim.request.id, ctx);
          } else if (outcome.kind === 'auth_fault') {
            this.logger.error(`payment_dispatch_failure request=${claim.request.id} correlationId=${claim.correlationId} reason=auth_fault — Payment refused Billing's own service token (configuration fault); will retry`);
            // stays `sending`; the next pass (or the reconciler) retries once the token is fixed
          } else {
            this.logger.warn(`payment_dispatch_failure request=${claim.request.id} correlationId=${claim.correlationId} reason=transient — will retry (safe by the natural key)`);
          }
        } catch (e) {
          this.logger.warn(`payment_dispatch_failure request=${claim.request.id} correlationId=${claim.correlationId} reason=exception: ${e instanceof Error ? e.message : 'unknown error'}`);
        }
      }
      return { dispatched };
    } finally {
      this.running = false;
    }
  }
}

@Injectable()
export class PaymentDispatcherService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly dispatcher: PaymentDispatcher) {}
  onApplicationBootstrap(): void {
    this.dispatcher.start();
  }
  /**
   * Stage 15.5 (F-D): the drain STARTS at shutdown start (Nest runs every onModuleDestroy before any beforeApplicationShutdown), so the
   * service's workers drain concurrently instead of one module after another; `stop()` is idempotent and the later hooks await it.
   */
  onModuleDestroy(): void {
    void this.dispatcher.stop();
  }
  /** Drains BEFORE any onApplicationShutdown closes the database pool or the broker (Nest runs every beforeApplicationShutdown first). */
  async beforeApplicationShutdown(): Promise<void> {
    await this.dispatcher.stop();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.dispatcher.stop(); // idempotent: the same drain, already finished when Nest drives the shutdown
  }
}

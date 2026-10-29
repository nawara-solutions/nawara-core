import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, type DrainOutcome } from '@nawara/service-kit';
import { PAYMENT_REFUND_CLIENT, type PaymentRefundClient } from './payment-refund-client.js';
import { RefundAuthorizationService, type RelayRow } from './refund-authorization.service.js';
import { RefundCompletionService } from './refund-completion.service.js';
import { randomUUID } from 'node:crypto';

const BATCH_SIZE = 50;
const LEASE_SECONDS = 30;

/**
 * Core V2 S6b (register BIL-24, PAY-08; R6B-7, R6B-10): keeps each relay's mirror of Payment's refund attempt current, from Payment's
 * authoritative read, so Billing never depends on one HTTP response. A relay whose attempt id Payment neither holds nor refused stays
 * unconfirmed (an absent answer is never a refusal); only Payment's record decides. Read-only towards Payment; never completes a case.
 */
@Injectable()
export class RefundRelayReconciler {
  private readonly loop = new PollLoop(
    () => this.reconcileOnce(),
    (e) => this.logger.error(`refund_relay_reconcile_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.logger.warn(`worker_drain_timeout worker=refund_relay_reconciler drainTimeoutMs=${ms} — shutdown proceeds; resumed after restart`),
  );
  private running = false;
  private readonly logger = new Logger('BillingRefundRelayReconciler');

  constructor(
    private readonly db: DbService,
    private readonly relays: RefundAuthorizationService,
    @Inject(PAYMENT_REFUND_CLIENT) private readonly payment: PaymentRefundClient,
    private readonly completions: RefundCompletionService,
  ) {}

  start(intervalMs = 10_000): void {
    this.loop.start(intervalMs);
  }

  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  /** Core V2 S6c (R6C-9): open cases whose relay may have been consumed, completed from Payment's authoritative completion. */
  private async completeFromPayment(): Promise<number> {
    const { rows } = await this.db.query<{ id: string; paymentId: string }>(
      `SELECT c.id, c."paymentId" FROM refund_case c
        WHERE c.status = 'open' AND EXISTS (SELECT 1 FROM refund_authorization_relay r WHERE r."refundCaseId" = c.id
          AND (r."attemptStatus" IS NULL OR r."attemptStatus" NOT IN ('authorization_expired', 'authorization_refused', 'rejected')))
        ORDER BY c."openedAt", c.id LIMIT $1`, [BATCH_SIZE]);
    let completed = 0;
    for (const c of rows) {
      try {
        const z = (await this.payment.refunds(c.paymentId))?.authorizations.find((a) => a.refundCaseId === c.id && a.completedAt);
        if (!z) continue;
        const runId = randomUUID();
        const outcome = await this.completions.complete(
          { refundCaseId: c.id, refundAuthorizationId: z.refundAuthorizationId, refundAttemptId: z.refundAttemptId, paymentId: c.paymentId, approvedAmount: z.approvedAmount,
            currency: z.currency, completedAt: z.completedAt! },
          { kind: 'reconciliation' },
          { actor: { type: 'system', id: null }, cause: { type: 'reconciliation', id: runId }, correlationId: `reconcile:${runId}` },
        );
        if (outcome === 'completed') completed++;
      } catch (e) {
        this.logger.warn(`refund_case_completion_reconcile_failure refundCase=${c.id} ${describeFailure(e)} — retried on a later pass`);
      }
    }
    return completed;
  }

  /** One pass. Exposed directly for tests. */
  async reconcileOnce(): Promise<{ checked: number; changed: number }> {
    if (this.running) return { checked: 0, changed: 0 };
    this.running = true;
    try {
      const { rows } = await this.db.query<RelayRow>(
        `UPDATE refund_authorization_relay r SET "checkAfter" = now() + make_interval(secs => $2)
          WHERE r.id IN (SELECT id FROM refund_authorization_relay
                          WHERE ("attemptStatus" IS NULL OR "attemptStatus" NOT IN ('authorization_expired', 'authorization_refused', 'succeeded', 'discrepancy', 'rejected'))
                            AND ("checkAfter" IS NULL OR "checkAfter" <= now())
                          ORDER BY "requestedAt", id LIMIT $1 FOR UPDATE SKIP LOCKED)
          RETURNING r.*`,
        [BATCH_SIZE, LEASE_SECONDS],
      );
      let changed = 0;
      for (const relay of rows) {
        try {
          const refunds = await this.payment.refunds(relay.paymentId);
          const attempt = refunds?.attempts.find((a) => a.refundAttemptId === relay.id);
          const refusal = refunds?.refusals.find((r) => r.refundAttemptId === relay.id);
          if (!attempt && !refusal) {
            if (relay.attemptStatus === null) this.logger.warn(`refund_relay_unconfirmed relay=${relay.id} — Payment holds no attempt or refusal for it yet; stays unconfirmed`);
            continue;
          }
          const next = attempt ? { status: attempt.status as string, refusal: null } : { status: 'rejected', refusal: refusal!.code as string };
          if (next.status === relay.attemptStatus) continue;
          const after = await this.relays.mirror(relay.id, next.status, next.refusal);
          if (after.attemptStatus !== relay.attemptStatus) changed++;
        } catch (e) {
          this.logger.warn(`refund_relay_reconcile_failure relay=${relay.id} ${describeFailure(e)} — retried on a later pass`);
        }
      }
      changed += await this.completeFromPayment();
      return { checked: rows.length, changed };
    } finally {
      this.running = false;
    }
  }
}

@Injectable()
export class RefundRelayReconcilerService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly reconciler: RefundRelayReconciler) {}
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

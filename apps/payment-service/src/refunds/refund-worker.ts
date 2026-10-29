import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, type DrainOutcome } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import { jobContext, type EventContext } from '../events/payment-events.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import type { PaymentProvider, RefundDispatchResult } from '../providers/provider.port.js';
import { RECEIPT_AUTHORITY, type ReceiptAuthority } from './receipt-authority.js';
import { RefundAllocationService } from './refund-allocation.service.js';
import { RefundAttemptService } from './refund-attempt.service.js';
import { RefundEvidenceService } from './refund-evidence.service.js';
import { bindingOf, type RefundAttemptRow } from './refund.types.js';

const BATCH_SIZE = 50;
/** How long one claim on an attempt lasts: no other instance (or later pass) works on it meanwhile. Technical, no business meaning. */
export const REFUND_LEASE_MS = 5000;
/** An intent the request path may still be authorizing is left to it this long before the recovery lookup (never an expiry rule). */
export const AUTHORIZATION_RECOVERY_AFTER_MS = 30_000;
/** A submitted refund is asked about once it has been with the provider this long. */
const SUBMITTED_CHECK_AFTER_MS = 60_000;

/**
 * Core V2 S6b (register PAY-07; ADR-0067 decision 5; the Owner's R6B-3, R6B-4, R6B-9): the refund worker, asynchronous from the durable
 * intent. Each pass, per attempt it can claim (a lease, never a lock across a network call):
 *
 *   * `authorization_pending` past the request path's window: the AUTH-03 recovery lookup under the attempt's OWN reference and binding.
 *     A consumption found authorizes exactly this attempt; anything else (absent, unavailable) leaves it pending: a missing lookup result is
 *     never read as expiry or refusal, and no time margin is invented (R6B-9).
 *   * `authorized` / `dispatching`: the refund is sent to the provider with the STABLE key (the attempt id). `dispatching` is committed
 *     before the call, so a crash leaves an attempt that is only ever sent again with the same key. Accepted → `submitted`; the provider's
 *     definitive refusal → `failed`; anything ambiguous → `unknown`.
 *   * `unknown`: the provider's status first; a reported outcome is applied as evidence; `pending` waits; NO RECORD is never a failure: the
 *     same attempt is sent again with the same key, which the provider de-duplicates (R6B-4). Nothing times out.
 *   * `submitted` for a while: the provider's status, applied as evidence.
 */
@Injectable()
export class RefundWorker {
  private readonly loop = new PollLoop(
    () => this.drainOnce(),
    (e) => this.logger.error(`refund_worker_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.logger.warn(`worker_drain_timeout worker=refund_worker drainTimeoutMs=${ms} — shutdown proceeds; the interrupted pass's work is picked up again after restart`),
  );
  private running = false;
  private readonly logger = new Logger('PaymentRefundWorker');
  /** The windows above; tests shorten them (the timestamps they compare are immutable database times). */
  recoveryAfterMs = AUTHORIZATION_RECOVERY_AFTER_MS;
  submittedCheckAfterMs = SUBMITTED_CHECK_AFTER_MS;

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    @Inject(RECEIPT_AUTHORITY) private readonly receipts: ReceiptAuthority,
    @Inject(RefundAttemptService) private readonly attempts: RefundAttemptService,
    @Inject(RefundEvidenceService) private readonly evidence: RefundEvidenceService,
    @Inject(PaymentAudit) private readonly audit: PaymentAudit,
    @Inject(RefundAllocationService) private readonly allocations: RefundAllocationService,
  ) {}

  start(intervalMs = 5000): void {
    this.loop.start(intervalMs);
  }

  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  /** One pass. Exposed directly for tests. */
  async drainOnce(): Promise<{ worked: number }> {
    if (this.running) return { worked: 0 };
    this.running = true;
    try {
      const { rows } = await this.db.query<RefundAttemptRow>(
        `SELECT * FROM refund_attempt
          WHERE ((status = 'authorization_pending' AND "requestedAt" < now() - make_interval(secs => $1))
             OR status IN ('authorized', 'dispatching', 'unknown')
             OR (status = 'submitted' AND "submittedAt" < now() - make_interval(secs => $2)))
            AND ("workAfter" IS NULL OR "workAfter" <= now())
          ORDER BY "requestedAt", id LIMIT $3`,
        [this.recoveryAfterMs / 1000, this.submittedCheckAfterMs / 1000, BATCH_SIZE],
      );
      const ctx = jobContext('refund_worker');
      let worked = 0;
      for (const a of rows) {
        try {
          if (await this.work(a, ctx)) worked++;
        } catch (e) {
          const code = (e as { response?: { code?: string } })?.response?.code;
          this.logger.warn(`refund_worker_failure refundAttempt=${a.id} status=${a.status} ${code ? `reason=${code}` : describeFailure(e)} — left as is; retried on a later pass`);
        }
      }
      // Core V2 S6c (R6C-6): every verified refund fact still pending allocation (a crash, a technical failure), each with its own backoff
      for (const factId of await this.allocations.pendingFacts(BATCH_SIZE)) {
        if (await this.allocations.allocateWithRetry(factId, ctx)) worked++;
      }
      return { worked };
    } finally {
      this.running = false;
    }
  }

  private async work(a: RefundAttemptRow, ctx: EventContext): Promise<boolean> {
    if (!(await this.claim(a))) return false;
    if (a.status === 'authorization_pending') return this.recoverAuthorization(a, ctx);
    const provider = this.providers.tryGet(a.provider);
    if (!provider?.refund || !provider.fetchRefundStatus) {
      this.logger.warn(`refund_worker_provider_unavailable refundAttempt=${a.id} provider=${a.provider} — left unresolved`);
      return false;
    }
    if (a.status === 'authorized' || a.status === 'dispatching') return this.dispatch(a, provider, ctx);
    const status = await provider.fetchRefundStatus(a.id);
    if (status.kind === 'notFound' && a.status === 'unknown') return this.dispatch(a, provider, ctx); // the same key again (R6B-4)
    if (status.kind === 'pending' || status.kind === 'notFound') return false;
    await this.evidence.apply(a.id, status, ctx);
    return true;
  }

  /** One statement: another instance that claimed the attempt within the lease, or an attempt that moved on since the scan, is skipped. */
  private async claim(a: RefundAttemptRow): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE refund_attempt SET "workAfter" = now() + make_interval(secs => $3)
        WHERE id = $1 AND status = $2 AND ("workAfter" IS NULL OR "workAfter" <= now())`,
      [a.id, a.status, REFUND_LEASE_MS / 1000],
    );
    return rowCount === 1;
  }

  private async recoverAuthorization(a: RefundAttemptRow, ctx: EventContext): Promise<boolean> {
    const found = await this.receipts.lookup({ binding: bindingOf(a), consumeRef: a.id });
    if (found.kind === 'consumed') {
      await this.attempts.commitAuthorized(a.id, found.consumption, ctx);
      return true;
    }
    this.logger.warn(`refund_authorization_unresolved refundAttempt=${a.id} lookup=${found.kind}${found.kind === 'unresolved' ? ` reason=${found.reason}` : ''} — stays pending; only Auth's definitive answer to the same receipt, or a consumption found under this reference, ends it`);
    return false;
  }

  private async dispatch(a: RefundAttemptRow, provider: PaymentProvider, ctx: EventContext): Promise<boolean> {
    // `dispatching` is durable BEFORE the provider can learn the key: whatever happens next, this attempt is only ever re-sent with that key
    if (a.status === 'authorized') {
      const { rowCount } = await this.db.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1 AND status = 'authorized'`, [a.id]);
      if (rowCount !== 1) return false;
    }
    const { rows: tx } = await this.db.query<{ providerTransactionId: string | null }>(
      `SELECT "providerTransactionId" FROM payment_attempt WHERE id = $1`, [a.capturedAttemptId]);
    let result: RefundDispatchResult;
    try {
      result = await provider.refund!({
        refundAttemptId: a.id, idempotencyKey: a.id, paymentId: a.paymentId, capturedTransactionId: tx[0]?.providerTransactionId ?? a.capturedAttemptId,
        amount: Number(a.amount), currency: a.currency.trim(),
      });
    } catch (e) {
      this.logger.warn(`refund_dispatch_ambiguous refundAttempt=${a.id} ${describeFailure(e)} — the outcome is unknown; resent only with the same key`);
      result = { kind: 'ambiguous' };
    }
    await this.db.tx(async (q) => {
      const current = await this.attempts.lockAttempt(q, a.id);
      if (current.status !== 'dispatching' && current.status !== 'unknown') return; // evidence got there first: it wins
      if (result.kind === 'accepted') {
        await q.query(
          `UPDATE refund_attempt SET status = 'submitted', "providerRefundId" = COALESCE("providerRefundId", $2), "submittedAt" = now() WHERE id = $1`,
          [a.id, result.providerRefundId],
        );
      } else if (result.kind === 'rejected') {
        const code = /^[a-z][a-z0-9_]{0,63}$/.test(result.failureCode) ? result.failureCode : 'provider_failure';
        const { rows } = await q.query<RefundAttemptRow>(
          `UPDATE refund_attempt SET status = 'failed', "failureCode" = $2, "completedAt" = now(), "workAfter" = NULL WHERE id = $1 RETURNING *`, [a.id, code]);
        await this.audit.recordRefund(q, 'refund_attempt.failed', rows[0]!, await this.attempts.organizationOf(q, a.paymentId), ctx);
      } else if (current.status === 'dispatching') {
        await q.query(`UPDATE refund_attempt SET status = 'unknown' WHERE id = $1`, [a.id]);
      }
    });
    this.logger.log(`refund_dispatched refundAttempt=${a.id} answer=${result.kind}`);
    return true;
  }
}

@Injectable()
export class RefundWorkerService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly worker: RefundWorker) {}
  onApplicationBootstrap(): void {
    this.worker.start();
  }
  onModuleDestroy(): void {
    void this.worker.stop();
  }
  async beforeApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}

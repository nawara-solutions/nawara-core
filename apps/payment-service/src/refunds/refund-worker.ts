import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, type DrainOutcome } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import { jobContext, type EventContext } from '../events/payment-events.js';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import { evaluateRefundCapability, sameKeyResendAllowed } from '../providers/refund-capabilities.js';
import type { PaymentProvider, RefundDispatchResult } from '../providers/provider.port.js';
import { RECEIPT_AUTHORITY, type ReceiptAuthority } from './receipt-authority.js';
import { RefundAllocationService } from './refund-allocation.service.js';
import { RefundAttemptService } from './refund-attempt.service.js';
import { RefundEvidenceService } from './refund-evidence.service.js';
import { RefundSafetyService } from './refund-safety.service.js';
import { bindingOf, type RefundAttemptRow } from './refund.types.js';

const BATCH_SIZE = 50;
/** Core V2 D-R1A: the attempt states in which a provider failure can contradict the attempt's own verified refund fact (0036). */
const FAILURE_CONTRADICTABLE = new Set(['dispatching', 'submitted', 'unknown', 'succeeded', 'discrepancy', 'failed']);
const boundedFailureCode = (code: string): string => (/^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'provider_failure');
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
 *   * Core V2 D-R1A (the Owner's Q5): a SAME-KEY resend (`dispatching` again after a crash, or `unknown` answered "no record") happens only while
 *     a certified provider guarantee establishes that the provider still de-duplicates the key, measured from `authorizedAt` (no later than the
 *     first send). Absent, uncertified, expired, revoked or elapsed: nothing is sent; the attempt stays unresolved, one
 *     `idempotency_retention_unproven` escalation is kept, and the provider's status is still read and applied as evidence. The first send
 *     (`authorized`) is unchanged.
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
    @Inject(RefundSafetyService) private readonly safety: RefundSafetyService,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
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
            -- Core V2 DO-76 S1 (D-76-2): a held attempt is never picked up again: nothing releases, retries or abandons it
            AND NOT EXISTS (SELECT 1 FROM refund_safety_escalation h WHERE h."refundAttemptId" = refund_attempt.id AND h.kind = 'dispatch_held')
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
        if (await this.allocations.allocateWithRetry(factId, ctx)) {
          worked++;
          continue;
        }
        // Core V2 D-R3: a failed attempt's fact whose evidence decision never committed is decided here, exactly as its report would be, then allocated
        try {
          if (await this.evidence.decideUndecidedFailedAttemptFact(factId, ctx)) worked++;
        } catch (e) {
          this.logger.warn(`refund_failed_attempt_evidence_recovery_failure fact=${factId} ${describeFailure(e)} — the fact is kept pending; retried on a later pass`);
        }
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
    if (a.status === 'authorized') return this.dispatch(a, provider, ctx);
    if (a.status === 'dispatching') {
      // the key may already be at the provider: resent only under a certified retention guarantee (Q5), otherwise its status is only read
      const resend = await this.sameKeyResend(a, provider, ctx);
      if (resend.allowed) return this.dispatch(a, provider, ctx);
      return (await this.readStatusOnly(a, provider, ctx)) || resend.escalated;
    }
    const status = await provider.fetchRefundStatus(a.id);
    if (status.kind === 'notFound' && a.status === 'unknown') {
      const resend = await this.sameKeyResend(a, provider, ctx);
      if (resend.allowed) return this.dispatch(a, provider, ctx); // the same key again (R6B-4), within the certified retention (Q5)
      return resend.escalated;
    }
    if (status.kind === 'pending' || status.kind === 'notFound') return false;
    await this.evidence.apply(a.id, status, ctx);
    return true;
  }

  /** The provider's status of an attempt that may not be resent: a definitive answer is applied as evidence; `pending` and no record change nothing. */
  private async readStatusOnly(a: RefundAttemptRow, provider: PaymentProvider, ctx: EventContext): Promise<boolean> {
    const status = await provider.fetchRefundStatus!(a.id);
    if (status.kind === 'pending' || status.kind === 'notFound') return false;
    await this.evidence.apply(a.id, status, ctx);
    return true;
  }

  /**
   * Core V2 D-R1A (the Owner's Q5): whether the attempt's key may be sent AGAIN now. The provider's certified `idempotencyKeyRetention` (the reviewed
   * registry, database time) must cover the time since `authorizedAt`. When it does not, one `idempotency_retention_unproven` escalation is kept (with
   * its audit intent, under the attempt lock, only while the attempt still awaits that resend) and nothing is sent. Never a new key, never a failure.
   */
  private async sameKeyResend(a: RefundAttemptRow, provider: PaymentProvider, ctx: EventContext): Promise<{ allowed: boolean; escalated: boolean }> {
    const { rows } = await this.db.query<{ now: Date; elapsedMs: number | null }>(
      `SELECT now() AS now, (extract(epoch FROM now() - "authorizedAt") * 1000)::float8 AS "elapsedMs" FROM refund_attempt WHERE id = $1`, [a.id]);
    const now = rows[0]?.now ?? new Date(Number.NaN);
    const evaluation = evaluateRefundCapability(provider, 'idempotencyKeyRetention', { now, simulationEnvironment: this.config.simulation !== undefined && !this.config.isProduction });
    const decision = sameKeyResendAllowed(evaluation, rows[0]?.elapsedMs ?? null);
    if (decision.allowed) return { allowed: true, escalated: false };
    const escalation = await this.db.tx(async (q) => {
      const current = await this.attempts.lockAttempt(q, a.id);
      if (current.status !== 'dispatching' && current.status !== 'unknown') return null; // it moved on: nothing awaits a resend
      return this.safety.escalate(q, { kind: 'idempotency_retention_unproven', refundAttemptId: a.id, factId: null }, ctx);
    });
    if (escalation) {
      this.logger.error(`refund_resend_withheld refundAttempt=${a.id} payment=${a.paymentId} provider=${a.provider} status=${a.status} reason=${decision.reason} escalation=${escalation} — no certified idempotency guarantee covers a same-key resend; nothing is sent, the attempt stays unresolved for the Owner's review (D-R1 Q5)`);
    }
    return { allowed: false, escalated: escalation !== null };
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
    if (a.status === 'authorized' && !(await this.startDispatch(a, ctx))) return false;
    // Core V2 R6H-5: a capture-specific refund returns exactly its capture's provider transaction (an associated fact's attempt is only an anchor)
    const { rows: tx } = a.captureSpecific
      ? await this.db.query<{ providerTransactionId: string | null }>(`SELECT "providerTxnId" AS "providerTransactionId" FROM provider_transaction_fact WHERE id = $1`, [a.captureFactId])
      : await this.db.query<{ providerTransactionId: string | null }>(`SELECT "providerTransactionId" FROM payment_attempt WHERE id = $1`, [a.capturedAttemptId]);
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
    try {
      await this.decideDispatch(a, result, ctx);
    } catch (e) {
      // Core V2 D-R1A limit (OD-DR1-6): a provider's dispatch answer is held only in memory until this decision commits. An `accepted` or
      // ambiguous answer is recovered by the next status read; a definitive refusal for an attempt a concurrent success already moved on is not.
      // It is logged here, with its bounded code, as the only evidence left; durable dispatch responses are an open Owner decision
      if (result.kind === 'rejected') {
        this.logger.error(`refund_dispatch_refusal_unrecorded refundAttempt=${a.id} payment=${a.paymentId} code=${boundedFailureCode(result.failureCode)} ${describeFailure(e)} — the provider's definitive refusal could not be committed; if the attempt has moved on it is not observed again (D-R1 OD-DR1-6)`);
      }
      throw e;
    }
    this.logger.log(`refund_dispatched refundAttempt=${a.id} answer=${result.kind}`);
    return true;
  }

  /** The provider's dispatch answer, applied under the attempt lock in one transaction. */
  private async decideDispatch(a: RefundAttemptRow, result: RefundDispatchResult, ctx: EventContext): Promise<void> {
    await this.db.tx(async (q) => {
      const current = await this.attempts.lockAttempt(q, a.id);
      // Core V2 D-R1A (Q4): a definitive refusal is a provider failure too; when the attempt already has its own verified refund fact (a success
      // that arrived while this call was in flight), both observations are kept before anything else, exactly as for a reported failure
      if (result.kind === 'rejected' && FAILURE_CONTRADICTABLE.has(current.status)) {
        await this.evidence.preserveFailureAfterEvidence(q, current, boundedFailureCode(result.failureCode), ctx);
      }
      if (current.status !== 'dispatching' && current.status !== 'unknown') return; // evidence got there first: it wins
      if (result.kind === 'accepted') {
        await q.query(
          `UPDATE refund_attempt SET status = 'submitted', "providerRefundId" = COALESCE("providerRefundId", $2), "submittedAt" = now() WHERE id = $1`,
          [a.id, result.providerRefundId],
        );
      } else if (result.kind === 'rejected') {
        const code = boundedFailureCode(result.failureCode);
        const { rows } = await q.query<RefundAttemptRow>(
          `UPDATE refund_attempt SET status = 'failed', "failureCode" = $2, "completedAt" = now(), "workAfter" = NULL WHERE id = $1 RETURNING *`, [a.id, code]);
        await this.audit.recordRefund(q, 'refund_attempt.failed', rows[0]!, await this.attempts.organizationOf(q, a.paymentId), ctx);
      } else if (current.status === 'dispatching') {
        await q.query(`UPDATE refund_attempt SET status = 'unknown' WHERE id = $1`, [a.id]);
      }
    });
  }

  /**
   * Core V2 DO-76 S1 (the Owner's D-76-1, D-76-2): `authorized` -> `dispatching`, the one step after which the provider can learn the key, under the
   * payment's refund-dispatch lock (exclusive; refund fact writers hold it shared) and the payment row lock (associations), so the evidence read here is
   * complete and later evidence waits. Refund
   * evidence of this attempt's capture that already exists (the frozen 0022 rule `refund_capture_has_evidence`, through its fact list) can only be
   * money returned without this dispatch: the attempt is NOT sent and stays `authorized`, held by one append-only escalation (deduplicated per
   * attempt) with its audit intent in the same transaction. Nothing releases, retries, abandons, allocates or resolves it. The database refuses the
   * same transition independently (`refund_attempt_dispatch_hold`, migration 0032). Returns whether the attempt may be sent now.
   */
  private async startDispatch(a: RefundAttemptRow, ctx: EventContext): Promise<boolean> {
    const held = await this.db.tx(async (q) => {
      // the refund-dispatch lock FIRST (before any row lock: a fact writer holding it shared then needs only its attempt row), then payment, then attempt
      await q.query('SELECT pg_advisory_xact_lock(refund_dispatch_lock_key($1))', [a.paymentId]);
      const current = await this.attempts.lockAttempt(q, a.id);
      if (current.status !== 'authorized') return { dispatch: false as const };
      const { rows: evidence } = await q.query<{ factId: string }>(`SELECT e AS "factId" FROM refund_capture_evidence_facts($1) e LIMIT 1`, [current.captureFactId]);
      const { rows: hold } = await q.query<{ id: string }>(
        `SELECT id FROM refund_safety_escalation WHERE "refundAttemptId" = $1 AND kind = 'dispatch_held'`, [current.id]);
      if (!evidence[0] && !hold[0]) {
        await q.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1 AND status = 'authorized'`, [a.id]);
        return { dispatch: true as const };
      }
      if (hold[0] || !evidence[0]) return { dispatch: false as const }; // already held: never written twice
      const escalation = await this.safety.escalate(q, { kind: 'dispatch_held', refundAttemptId: current.id, factId: evidence[0].factId }, ctx);
      return { dispatch: false as const, escalation, factId: evidence[0].factId };
    });
    if ('escalation' in held && held.escalation) {
      this.logger.error(`refund_dispatch_held refundAttempt=${a.id} payment=${a.paymentId} evidenceFact=${held.factId} escalation=${held.escalation} — refund evidence of this capture exists before dispatch; nothing is sent, the attempt stays authorized for the Owner's review (DO-76)`);
    }
    return held.dispatch;
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

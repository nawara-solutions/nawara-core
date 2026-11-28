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
import { applyDispatchObservation, type DispatchDecisionDeps } from './refund-dispatch-decision.js';
import { RefundDispatchResponseService, classifyDispatch, type DispatchObservationRow } from './refund-dispatch-response.service.js';
import { RefundEvidenceService } from './refund-evidence.service.js';
import { RefundFinalityService, describeRefusal } from './refund-finality.service.js';
import { RefundSafetyService } from './refund-safety.service.js';
import { bindingOf, type RefundAttemptRow } from './refund.types.js';

const BATCH_SIZE = 50;
/** How long one claim on an attempt lasts: no other instance (or later pass) works on it meanwhile. Technical, no business meaning. */
export const REFUND_LEASE_MS = 5000;
/** An intent the request path may still be authorizing is left to it this long before the recovery lookup (never an expiry rule). */
export const AUTHORIZATION_RECOVERY_AFTER_MS = 30_000;
/** Core V2 D-R1B: how long a blocked `authorized` attempt leaves the scan before it is re-evaluated. Technical (no batch starvation); permits nothing. */
const BLOCKED_RECHECK_MS = 60_000;
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
 *   * Core V2 D-R1B (0037): nothing is sent, first time or again, while an earlier attempt of the same money may still pay
 *     (`RefundFinalityService.dispatchRefusal`, re-evaluated here; the database refuses the first send independently), nor again once this attempt has
 *     its own verified refund fact contradicted by a failure (OD-DR1-1). Its status is still read; nothing is released, retried or reassigned.
 *   * Core V2 D-R1D (0039; OD-DR1-6; the Owner's Q1, Q2): every send is recorded BEFORE the call (`refund_dispatch_send`), the provider's answer is
 *     stored in its own transaction BEFORE the decision (`refund_dispatch_observation`), and the decision records its exactly-once application under
 *     the attempt lock. An answer no decision applied (a crash, a failed decision transaction) is applied by RECOVERY, which since Core V2 D-R1E
 *     (0040, the A1 correction) is NOT part of this service: it runs as a separate process under the separate recovery database role, which has no
 *     finality authority (`RefundResponseRecovery`, `cli/refund-response-recovery.ts`). While an attempt has a stored answer not yet applied, it is
 *     not worked here (nothing is sent again, no status read) until that answer is applied. A send with no stored answer stays an UNKNOWN outcome: the call is not atomic with
 *     the database, so a database outage after the call cannot be closed here; status reads (the rules above) remain its only resolution.
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
    @Inject(RefundFinalityService) private readonly finality: RefundFinalityService,
    @Inject(RefundDispatchResponseService) private readonly responses: RefundDispatchResponseService,
  ) {
    this.decision = {
      audit, safety, responses, log: this.logger,
      finality: (q, current, code, ctx, observationId) => finality.recordIfCertified(q, current, 'dispatch_rejected', code, ctx, observationId),
    };
  }
  /** The dispatch's decision dependencies: the only holder of a finality recorder (Core V2 D-R1E). */
  private readonly decision: DispatchDecisionDeps;

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
      const ctx = jobContext('refund_worker');
      let worked = 0;
      const { rows } = await this.db.query<RefundAttemptRow>(
        `SELECT * FROM refund_attempt
          WHERE ((status = 'authorization_pending' AND "requestedAt" < now() - make_interval(secs => $1))
             OR status IN ('authorized', 'dispatching', 'unknown')
             OR (status = 'submitted' AND "submittedAt" < now() - make_interval(secs => $2)))
            AND ("workAfter" IS NULL OR "workAfter" <= now())
            -- Core V2 DO-76 S1 (D-76-2): a held attempt is never picked up again: nothing releases, retries or abandons it
            AND NOT EXISTS (SELECT 1 FROM refund_safety_escalation h WHERE h."refundAttemptId" = refund_attempt.id AND h.kind = 'dispatch_held')
            -- Core V2 D-R1D: a stored dispatch answer not yet applied is applied first (by its decision or by the separate recovery): nothing else meanwhile
            AND NOT EXISTS (SELECT 1 FROM refund_dispatch_observation o WHERE o."refundAttemptId" = refund_attempt.id
                             AND NOT EXISTS (SELECT 1 FROM refund_dispatch_application p WHERE p."observationId" = o.id))
          ORDER BY "requestedAt", id LIMIT $3`,
        [this.recoveryAfterMs / 1000, this.submittedCheckAfterMs / 1000, BATCH_SIZE],
      );
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
    if (await this.resendWithheld(a)) return { allowed: false, escalated: false };
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

  /**
   * Core V2 D-R1B: a resend is a dispatch too. Withheld while an earlier attempt may still pay (its certificate may have been revoked since the first
   * send), or once a failure contradicted this attempt's own verified refund fact (OD-DR1-1: it was refunded; its key is not sent again).
   */
  private async resendWithheld(a: RefundAttemptRow): Promise<boolean> {
    const reason = await this.db.tx(async (q) => {
      const current = await this.attempts.lockAttempt(q, a.id);
      if (await this.safety.escalationOf(q, a.id, 'failure_after_refund_evidence')) return 'own_refund_fact';
      const refusal = await this.finality.dispatchRefusal(q, current);
      return refusal ? describeRefusal(refusal) : null;
    });
    if (reason) this.logger.error(`refund_resend_blocked refundAttempt=${a.id} payment=${a.paymentId} ${reason} — its key is not sent again; its status is still read (D-R1B)`);
    return reason !== null;
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
    // `dispatching` and the send are durable BEFORE the provider can learn the key: whatever happens next, this attempt is only ever re-sent with that key
    const sendId = a.status === 'authorized' ? await this.startDispatch(a, ctx) : await this.recordResend(a);
    if (sendId === null) return false;
    // Core V2 R6H-5: a capture-specific refund returns exactly its capture's provider transaction (an associated fact's attempt is only an anchor)
    const { rows: tx } = a.captureSpecific
      ? await this.db.query<{ providerTransactionId: string | null }>(`SELECT "providerTxnId" AS "providerTransactionId" FROM provider_transaction_fact WHERE id = $1`, [a.captureFactId])
      : await this.db.query<{ providerTransactionId: string | null }>(`SELECT "providerTransactionId" FROM payment_attempt WHERE id = $1`, [a.capturedAttemptId]);
    let result: RefundDispatchResult | { kind: 'transport_error' };
    try {
      result = await provider.refund!({
        refundAttemptId: a.id, idempotencyKey: a.id, paymentId: a.paymentId, capturedTransactionId: tx[0]?.providerTransactionId ?? a.capturedAttemptId,
        amount: Number(a.amount), currency: a.currency.trim(),
      });
    } catch (e) {
      this.logger.warn(`refund_dispatch_ambiguous refundAttempt=${a.id} send=${sendId} ${describeFailure(e)} — the outcome is unknown; resent only with the same key`);
      result = { kind: 'transport_error' };
    }
    const answer = classifyDispatch(result);
    let observation: DispatchObservationRow;
    try {
      observation = await this.responses.observe(sendId, a.id, answer);
    } catch (e) {
      // Core V2 D-R1D: the external-call boundary. The answer could not be stored (the database is unavailable): it exists only in memory and this log.
      // The send stays without an observation (an UNKNOWN outcome, Owner-visible); nothing is decided from it; status reads remain its resolution
      this.logger.error(`refund_dispatch_response_unrecorded refundAttempt=${a.id} payment=${a.paymentId} send=${sendId} answer=${answer.classification}${answer.providerCode ? ` code=${answer.providerCode}` : ''} ${describeFailure(e)} — the outcome stays UNKNOWN; status reads resolve it (D-R1D)`);
      throw e;
    }
    try {
      await applyDispatchObservation(this.db, this.decision, observation, ctx);
    } catch (e) {
      this.logger.warn(`refund_dispatch_decision_deferred refundAttempt=${a.id} observation=${observation.id} answer=${observation.classification} ${describeFailure(e)} — the answer is stored; recovery applies it (D-R1D)`);
      throw e;
    }
    this.logger.log(`refund_dispatched refundAttempt=${a.id} send=${sendId} answer=${observation.classification}`);
    return true;
  }

  /** Core V2 D-R1D: a same-key resend the rules above permitted, recorded before the call while the attempt still awaits it; null when it moved on. */
  private async recordResend(a: RefundAttemptRow): Promise<string | null> {
    return this.db.tx(async (q) => {
      const current = await this.attempts.lockAttempt(q, a.id);
      if (current.status !== 'dispatching' && current.status !== 'unknown') return null;
      return this.responses.recordSend(q, current, 'same_key_resend');
    });
  }

  /**
   * Core V2 DO-76 S1 (the Owner's D-76-1, D-76-2): `authorized` -> `dispatching`, the one step after which the provider can learn the key, under the
   * payment's refund-dispatch lock (exclusive; refund fact writers hold it shared) and the payment row lock (associations), so the evidence read here is
   * complete and later evidence waits. Refund
   * evidence of this attempt's capture that already exists (the frozen 0022 rule `refund_capture_has_evidence`, through its fact list) can only be
   * money returned without this dispatch: the attempt is NOT sent and stays `authorized`, held by one append-only escalation (deduplicated per
   * attempt) with its audit intent in the same transaction. Nothing releases, retries, abandons, allocates or resolves it. The database refuses the
   * same transition independently (`refund_attempt_dispatch_hold`, migration 0032). Returns the send's id when the attempt may be sent now (Core V2
   * D-R1D: its first send is recorded in this transaction), else null.
   */
  private async startDispatch(a: RefundAttemptRow, ctx: EventContext): Promise<string | null> {
    const held = await this.db.tx(async (q) => {
      // the refund-dispatch lock FIRST (before any row lock: a fact writer holding it shared then needs only its attempt row), then payment, then attempt
      await q.query('SELECT pg_advisory_xact_lock(refund_dispatch_lock_key($1))', [a.paymentId]);
      const current = await this.attempts.lockAttempt(q, a.id);
      if (current.status !== 'authorized') return { dispatch: false as const };
      const { rows: evidence } = await q.query<{ factId: string }>(`SELECT e AS "factId" FROM refund_capture_evidence_facts($1) e LIMIT 1`, [current.captureFactId]);
      const { rows: hold } = await q.query<{ id: string }>(
        `SELECT id FROM refund_safety_escalation WHERE "refundAttemptId" = $1 AND kind = 'dispatch_held'`, [current.id]);
      if (!evidence[0] && !hold[0]) {
        // Core V2 D-R1B: re-evaluated at the dispatch, not only at creation. The attempt stays `authorized`: nothing is sent, released or reassigned
        const refusal = await this.finality.dispatchRefusal(q, current);
        if (refusal) {
          await q.query(`UPDATE refund_attempt SET "workAfter" = now() + make_interval(secs => $2) WHERE id = $1`, [a.id, BLOCKED_RECHECK_MS / 1000]);
          // Core V2 D-R1C (0038): one Owner-visible escalation per attempt and cause, with its audit intent, in THIS transaction. If it cannot be written
          // the whole transaction rolls back: the attempt stays authorized (never sent: the refusal stands) and the next pass decides and escalates again
          const escalation = await this.safety.escalate(q, { kind: 'dispatch_blocked', refundAttemptId: current.id, factId: null, competingAttemptId: refusal.blockerId,
            blockingCause: refusal.cause, blockingReason: refusal.reason }, ctx);
          return { dispatch: false as const, refusal: describeRefusal(refusal), escalation };
        }
        await q.query(`UPDATE refund_attempt SET status = 'dispatching' WHERE id = $1 AND status = 'authorized'`, [a.id]);
        return { dispatch: true as const, sendId: await this.responses.recordSend(q, current, 'first_send') };
      }
      if (hold[0] || !evidence[0]) return { dispatch: false as const }; // already held: never written twice
      const escalation = await this.safety.escalate(q, { kind: 'dispatch_held', refundAttemptId: current.id, factId: evidence[0].factId }, ctx);
      return { dispatch: false as const, escalation, factId: evidence[0].factId };
    });
    if ('factId' in held && held.escalation) { // a DO-76 hold only (a D-R1C refusal carries no fact; it is logged below)
      this.logger.error(`refund_dispatch_held refundAttempt=${a.id} payment=${a.paymentId} evidenceFact=${held.factId} escalation=${held.escalation} — refund evidence of this capture exists before dispatch; nothing is sent, the attempt stays authorized for the Owner's review (DO-76)`);
    }
    if ('refusal' in held && held.refusal) {
      this.logger.error(`refund_dispatch_blocked refundAttempt=${a.id} payment=${a.paymentId} ${held.refusal}${held.escalation ? ` escalation=${held.escalation}` : ''} — nothing is sent; the attempt stays authorized (D-R1B, D-R1C)`);
    }
    return 'sendId' in held && held.sendId ? held.sendId : null;
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

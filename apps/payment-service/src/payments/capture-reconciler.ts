import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, OutboxService, PollLoop, describeFailure, failureFacts, type DrainOutcome, type Queryable } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import { jobContext } from '../events/payment-events.js';
import { recordQualifyingLateSuccesses } from './late-success-at-finality.js';
import type { PaymentRow } from './payment.types.js';

/** S0-C12 item 7: one pass handles at most this many facts; the rest wait for the next pass (bounded work per pass). */
export const CAPTURE_RECONCILE_BATCH = 100;
/** S0-C12 item 15: per fact, at most this many processing attempts. */
export const CAPTURE_RECOVERY_MAX_ATTEMPTS = 12;
/** S0-C12 item 15: the wait after attempt n, for n = 1 to 11 (the 12th ends it): 4,094 seconds in all, about 68 minutes, following the 30-second pass. */
export const captureRecoveryWaitSeconds = (attempt: number): number => 2 ** attempt;
/** S0-C12 item 15: after the nth consecutive infrastructure failure, the worker pauses 30 seconds doubling to at most 15 minutes. */
export const captureInfrastructurePauseMs = (consecutive: number): number => Math.min(900_000, 30_000 * 2 ** (Math.max(consecutive, 1) - 1));

export type CaptureRecoveryFailure = 'infrastructure' | 'permanent' | 'transient' | 'unknown';
const INFRASTRUCTURE_KINDS = new Set(['db_connect_timeout', 'db_connection_lost', 'db_unavailable', 'db_auth_failed', 'network_unreachable']);
const TRANSIENT_STATES = new Set(['40001', '40P01', '55P03', '57014', '25P03']);
/**
 * S0-C12 item 15. Infrastructure: the database or its connections unavailable; it says nothing about the fact, so it consumes no attempt. Transient: may succeed
 * unchanged. Permanent: a database guard refusing a fact the selection still finds eligible, which a retry can't change. Anything else is unknown: retried, bounded.
 */
export function classifyCaptureRecoveryFailure(e: unknown): CaptureRecoveryFailure {
  const { code, kind } = failureFacts(e);
  if ((kind && INFRASTRUCTURE_KINDS.has(kind)) || (code && /^(08|53|57P)/.test(code))) return 'infrastructure';
  if (code && TRANSIENT_STATES.has(code)) return 'transient';
  if (code && code.startsWith('23')) return 'permanent';
  return 'unknown';
}

/** A fact the recovery pass may complete: the same rule as item 6, in SQL, so an ineligible fact never occupies a batch and never consumes an attempt. */
const ELIGIBLE = `f.kind = 'capture' AND p.status IN ('failed', 'cancelled', 'expired') AND trim(f.currency) ~ '^[A-Z]{3}$'
  AND NOT EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id)
  AND NOT EXISTS (SELECT 1 FROM payment_late_success l WHERE l."factId" = f.id)
  AND NOT EXISTS (SELECT 1 FROM provider_transaction_fact g WHERE g."attemptId" = f."attemptId" AND g.kind = 'capture' AND g.id <> f.id)`;

/**
 * Core V2 S0-C12 items 7 and 15 (register PAY-05 J, K): the durable, bounded, idempotent completion of the one window no transaction can close. FC-1 and V-2
 * commit a capture fact on its own BEFORE its processing; when that processing is lost (a crash, a failed transaction) on a payment that is, or
 * later becomes, `failed` / `cancelled` / `expired`, this pass records the late success that S0-C12 item 6 would have recorded.
 *   - Durable: it selects from committed records only (no queue to lose); an interrupted pass is simply re-run. Per-fact retry state survives a restart.
 *   - Bounded and fair: at most `CAPTURE_RECONCILE_BATCH` facts per pass, filtered BEFORE that limit to eligible, due, non-terminal facts: never-tried first, then
 *     oldest due. Each fact has its own transaction, so a failure never ends the pass for the others; a payment another transaction holds is skipped and costs nothing.
 *   - Idempotent: under the payment lock, through the same helper as the finality writers (no late success for a fact that has one; the fact's
 *     own observation key, `payment_late_success_once`, and its fact's key, `payment_late_success_one_per_fact`; the event and audit ids derived from
 *     the row). Concurrent passes serialize per payment.
 *   - Exhaustion is not abandonment: after 12 attempts the fact is marked, visible to the Owner, and stays; a provider redelivery still processes normally.
 *     Nothing here reactivates it (that needs a separate security contract decision).
 * It never settles, never reopens a final status, and never touches a contested fact, a non-ISO currency, an ambiguous attempt or a payment that is not final.
 */
@Injectable()
export class CaptureReconciler {
  private readonly loop = new PollLoop(
    () => this.reconcileOnce(),
    (e) => this.logger.error(`capture_reconcile_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.logger.warn(`worker_drain_timeout worker=capture_reconciler drainTimeoutMs=${ms} — shutdown proceeds; the interrupted pass's work is picked up again after restart`),
  );
  private running = false;
  private consecutiveInfrastructureFailures = 0;
  private pausedUntil = 0;
  private passes = 0;
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

  async reconcileOnce(): Promise<{ recorded: number; paused?: true }> {
    if (this.running) return { recorded: 0 };
    if (Date.now() < this.pausedUntil) return { recorded: 0, paused: true }; // no database work while paused: bounded resource use during an outage
    this.running = true;
    try {
      let rows: Array<{ factId: string; paymentId: string; attempts: number }>;
      try {
        rows = (await this.db.query<{ factId: string; paymentId: string; attempts: number }>(
          `SELECT f.id AS "factId", f."paymentId", COALESCE(s.attempts, 0) AS attempts
             FROM provider_transaction_fact f JOIN payment p ON p.id = f."paymentId" LEFT JOIN capture_recovery_state s ON s."factId" = f.id
            WHERE ${ELIGIBLE} AND (s."factId" IS NULL OR (s.status = 'active' AND s."workAfter" <= now()))
            ORDER BY s."factId" IS NOT NULL, COALESCE(s."workAfter", f."observedAt"), f.id LIMIT $1`, [CAPTURE_RECONCILE_BATCH])).rows;
      } catch (e) {
        // a pass that can't even read: no fact is involved, so no fact pays for it. Only an infrastructure failure pauses; anything else stays the job
        // error boundary's: logged by the loop, and the next pass runs
        if (classifyCaptureRecoveryFailure(e) !== 'infrastructure') throw e;
        this.infrastructureFailure(e);
        return { recorded: 0 };
      }
      const ctx = jobContext('capture_reconciler'); // one run, one correlation id
      let recorded = 0;
      for (const r of rows) {
        try {
          const outcome = await this.db.tx((q) => this.processFact(q, r.factId, r.paymentId, ctx));
          if (outcome === 'no_effect') await this.countAttempt(r.factId, r.attempts, 'no_effect', 'transient');
          else recorded += outcome;
        } catch (e) {
          const failure = classifyCaptureRecoveryFailure(e);
          if (failure === 'infrastructure') {
            this.infrastructureFailure(e);
            break; // the rest of this batch would fail the same way
          }
          this.logger.warn(`capture_reconcile_fact_failure fact=${r.factId} class=${failure} ${describeFailure(e)} — counted; the fact is kept`);
          await this.countAttempt(r.factId, r.attempts, failure === 'permanent' ? 'permanent_refusal' : failure === 'transient' ? 'transient_failure' : 'unknown_failure', failure);
        }
      }
      if (recorded > 0) this.logger.warn(`capture_reconcile_recorded lateSuccesses=${recorded} — a committed capture fact's lost processing was completed`);
      if (this.consecutiveInfrastructureFailures > 0 && Date.now() >= this.pausedUntil) this.recovered(); // this pass reached the database and no failure paused it
      await this.snapshot();
      return { recorded };
    } finally {
      this.running = false;
    }
  }

  private async processFact(q: Queryable, factId: string, paymentId: string, ctx: ReturnType<typeof jobContext>): Promise<number | 'no_effect'> {
    const payment = (await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1 FOR UPDATE SKIP LOCKED', [paymentId])).rows[0];
    if (!payment) return 0; // held by another transaction: the next pass re-reads it, and this costs no attempt
    const n = await recordQualifyingLateSuccesses(q, { outbox: this.outbox, audit: this.audit }, payment, ctx, { onlyFactId: factId, actor: 'payment_capture_reconciler' });
    if (n > 0) return n;
    // nothing written: either it stopped being eligible meanwhile (not a failure), or something unknown stands in its way, which must not loop for ever
    const { rows } = await q.query(`SELECT 1 FROM provider_transaction_fact f JOIN payment p ON p.id = f."paymentId" WHERE f.id = $1 AND ${ELIGIBLE}`, [factId]);
    return rows.length > 0 ? 'no_effect' : 0;
  }

  /** In its own statement, after the failed transaction ended. A lost write under-counts and retries; the fact is never lost. Competing passes can't double-count. */
  private async countAttempt(factId: string, seen: number, code: string, failure: Exclude<CaptureRecoveryFailure, 'infrastructure'>): Promise<void> {
    const attempts = seen + 1;
    const terminal = failure === 'permanent' ? 'refused' : attempts >= CAPTURE_RECOVERY_MAX_ATTEMPTS ? 'exhausted' : null;
    const wait = terminal ? null : captureRecoveryWaitSeconds(attempts);
    try {
      await this.db.query(
        `INSERT INTO capture_recovery_state ("factId", attempts, "workAfter", "lastFailure", status, "endedAt")
         VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(secs => $3::int) END, $4, $5, CASE WHEN $5 = 'active' THEN NULL ELSE now() END)
         ON CONFLICT ("factId") DO UPDATE SET attempts = EXCLUDED.attempts, "workAfter" = EXCLUDED."workAfter", "lastFailure" = EXCLUDED."lastFailure",
           status = EXCLUDED.status, "endedAt" = EXCLUDED."endedAt", "updatedAt" = now()
         WHERE capture_recovery_state.attempts = $6 AND capture_recovery_state.status = 'active'`,
        [factId, attempts, wait, code, terminal ?? 'active', seen]);
      if (terminal) this.logger.error(`capture_recovery_exhausted fact=${factId} status=${terminal} attempts=${attempts} lastFailure=${code} — no more automatic attempts; the fact is kept and visible to the Owner (PAY-12)`);
    } catch (e) {
      this.logger.warn(`capture_recovery_count_failure fact=${factId} ${describeFailure(e)} — not counted; the fact is retried`);
    }
  }

  private infrastructureFailure(e: unknown): void {
    this.consecutiveInfrastructureFailures++;
    const pauseMs = captureInfrastructurePauseMs(this.consecutiveInfrastructureFailures);
    this.pausedUntil = Date.now() + pauseMs;
    this.logger.error(`capture_reconcile_pass_failure consecutive=${this.consecutiveInfrastructureFailures} pauseMs=${pauseMs} ${describeFailure(e)} — no fact's attempt is consumed; recovery resumes by itself`);
  }

  private recovered(): void {
    this.logger.log(`capture_reconcile_recovered afterConsecutiveFailures=${this.consecutiveInfrastructureFailures}`);
    this.consecutiveInfrastructureFailures = 0;
    this.pausedUntil = 0;
  }

  /** Periodic, and whenever work is retrying or has ended: identifiers and counts only. */
  private async snapshot(): Promise<void> {
    if (++this.passes % 10 !== 0) return;
    const { rows } = await this.db.query<{ retrying: number; exhausted: number; refused: number; quarantined: number }>(
      `SELECT count(*) FILTER (WHERE s.status = 'active')::int AS retrying, count(*) FILTER (WHERE s.status = 'exhausted')::int AS exhausted, count(*) FILTER (WHERE s.status = 'refused')::int AS refused,
              (SELECT count(*)::int FROM provider_observation_quarantine) AS quarantined
         FROM capture_recovery_state s WHERE NOT EXISTS (SELECT 1 FROM payment_late_success l WHERE l."factId" = s."factId")`).catch(() => ({ rows: [] }));
    if (rows[0]) this.logger.log(`capture_reconcile_snapshot retrying=${rows[0].retrying} exhausted=${rows[0].exhausted} refused=${rows[0].refused} quarantined=${rows[0].quarantined}`);
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

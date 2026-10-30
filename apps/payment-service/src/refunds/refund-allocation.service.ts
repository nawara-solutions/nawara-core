import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, OutboxService, type Queryable } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import { refundCaseCompletedEvent, type EventContext } from '../events/payment-events.js';
import type { PaymentRow } from '../payments/payment.types.js';

/** A `refund_authorization` row (migration 0018). */
export interface RefundAuthorizationRow {
  id: string;
  refundAttemptId: string;
  paymentId: string;
  refundCaseId: string;
  producer: string;
  receiptId: string;
  approvedByUserId: string;
  approvedAmount: string;
  currency: string;
  allocatedIntended: string;
  completedAt: Date | null;
  createdAt: Date;
}

export type AllocationOutcome =
  | { kind: 'allocated'; intended: number; excess: number; completed: boolean }
  | { kind: 'already_allocated' }
  | { kind: 'blocked'; reason: 'contested' | 'currency_mismatch' | 'no_authorization' };

interface FactRow { id: string; kind: string; paymentId: string | null; refundAttemptId: string | null; amount: string; currency: string; associatedAuthorizationId: string | null }

/** The worker's bounded backoff for a technical allocation failure: 2^attempts seconds, at most one hour (R6C-6: never a tight loop). */
export const allocationBackoffSeconds = (attempts: number) => Math.min(3600, 2 ** Math.min(attempts, 12));

/**
 * Core V2 S6c refund allocation and financial completion (register PAY-07, EVT-02; S0 FC-1, FC-2, FC-3, DB-17, V-2, V-3; the Owner's R6C-1 to
 * R6C-11). DEVELOPMENT AND SIMULATION ONLY (a refund fact exists only where refunds are configured, never in production).
 *
 * One verified `refund` provider fact at a time, in its OWN transaction, separate from the fact's recording (FC-2, V-2: the fact survives any
 * allocation failure), with the frozen lock order: the payment row, then the authorization row.
 *
 *   * Eligibility (R6C-2, kept conservative under R6C-6): a fact contested by a contradicting observation, in another currency than its
 *     authorization, or whose attempt has no authorization, can never be allocated: it is recorded once in `refund_fact_allocation_block`
 *     (a permanent financial inconsistency, for S6h), and the fact is untouched. The attempt's own status (even `discrepancy`) never decides
 *     (R6C-4): allocation is fact-based.
 *   * Arithmetic (FC-2, R6C-2 Option A, R6C-5): against the fact's OWN attempt's authorization, `intended = min(amount, approvedAmount -
 *     allocatedIntended)`, `excess = amount - intended`; cumulative over distinct facts; 0 intended once the case or the payment is complete
 *     (V-3). The provider's observed amount is recorded unchanged. A redelivered fact is the same fact (`UNIQUE factId`): nothing new.
 *   * Completion (FC-3, R6C-7, R6C-8, R6C-11): when the counter reaches the approved amount, `completedAt` is set in the same transaction,
 *     with `refund.case_completed` (deterministic id per authorization) in the outbox and the audit intent `refund_authorization.completed`.
 *     Nothing else: no purchase, entitlement or obligation changes here (S6d), and Payment never calls Billing.
 */
@Injectable()
export class RefundAllocationService {
  private readonly log = new Logger('PaymentRefundAllocation');

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(PaymentAudit) private readonly audit: PaymentAudit,
  ) {}

  async allocate(factId: string, ctx: EventContext): Promise<AllocationOutcome> {
    const { rows: found } = await this.db.query<FactRow>(
      `SELECT f.id, f.kind, f."paymentId", f."refundAttemptId", f.amount, f.currency,
              (SELECT s."refundAuthorizationId" FROM provider_fact_association s WHERE s."factId" = f.id AND s.status = 'associated') AS "associatedAuthorizationId"
         FROM provider_transaction_fact f WHERE f.id = $1`, [factId]);
    const found0 = found[0];
    // Core V2 S6h (R6H-3, FC-2): an UNMATCHED refund fact is allocated only through its append-only association, against exactly the
    // authorization the Owner associated it with (its payment and attempt are that authorization's); the arithmetic below is unchanged
    const associated = found0 && found0.paymentId === null && found0.associatedAuthorizationId
      ? (await this.db.query<{ paymentId: string; refundAttemptId: string }>(
        `SELECT "paymentId", "refundAttemptId" FROM refund_authorization WHERE id = $1`, [found0.associatedAuthorizationId])).rows[0]
      : undefined;
    const fact = found0 && associated ? { ...found0, paymentId: associated.paymentId, refundAttemptId: associated.refundAttemptId } : found0;
    if (!fact || fact.kind !== 'refund' || !fact.refundAttemptId || !fact.paymentId) throw new Error('refund_allocation_not_a_refund_fact');
    const outcome = await this.db.tx(async (q) => {
      const { rows: pay } = await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1 FOR UPDATE', [fact.paymentId]); // FC-2 lock order: payment first
      const payment = pay[0]!;
      if ((await q.query(`SELECT 1 FROM refund_allocation WHERE "factId" = $1`, [fact.id])).rows.length > 0) return { kind: 'already_allocated' as const };
      const { rows: blocked } = await q.query<{ reason: 'contested' | 'currency_mismatch' | 'no_authorization' }>(
        `SELECT reason FROM refund_fact_allocation_block WHERE "factId" = $1`, [fact.id]);
      if (blocked[0]) return { kind: 'blocked' as const, reason: blocked[0].reason };
      const { rows: zs } = await q.query<RefundAuthorizationRow>(
        `SELECT * FROM refund_authorization WHERE "refundAttemptId" = $1 FOR UPDATE`, [fact.refundAttemptId]); // then the authorization
      const z = zs[0];
      const contested = (await q.query(`SELECT 1 FROM provider_transaction_fact_conflict WHERE "factId" = $1 LIMIT 1`, [fact.id])).rows.length > 0;
      const reason: 'contested' | 'currency_mismatch' | 'no_authorization' | null = !z ? 'no_authorization' : contested ? 'contested' : fact.currency !== z.currency.trim() ? 'currency_mismatch' : null;
      if (reason) {
        await q.query(`INSERT INTO refund_fact_allocation_block ("factId", reason) VALUES ($1, $2)`, [fact.id, reason]);
        return { kind: 'blocked' as const, reason };
      }
      // V-3: once the case or the payment is complete (through any authorization), nothing more is intended: it is all excess
      const { rows: done } = await q.query(
        `SELECT 1 FROM refund_authorization WHERE "completedAt" IS NOT NULL AND ("refundCaseId" = $1 OR "paymentId" = $2) LIMIT 1`, [z!.refundCaseId, z!.paymentId]);
      const amount = Number(fact.amount);
      const remaining = done.length > 0 ? 0 : Number(z!.approvedAmount) - Number(z!.allocatedIntended);
      const intended = Math.max(0, Math.min(amount, remaining));
      const excess = amount - intended;
      await q.query(
        `INSERT INTO refund_allocation ("factId", "refundAuthorizationId", "paymentId", "refundAttemptId", amount, currency, intended, excess)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [fact.id, z!.id, z!.paymentId, z!.refundAttemptId, amount, z!.currency, intended, excess],
      );
      let completed = false;
      if (intended > 0) {
        const { rows: after } = await q.query<RefundAuthorizationRow>(
          `UPDATE refund_authorization SET "allocatedIntended" = "allocatedIntended" + $2,
                  "completedAt" = CASE WHEN "allocatedIntended" + $2 = "approvedAmount" THEN now() ELSE NULL END
            WHERE id = $1 RETURNING *`,
          [z!.id, intended],
        );
        if (after[0]!.completedAt) {
          completed = true;
          await this.complete(q, after[0]!, payment, ctx);
        }
      }
      return { kind: 'allocated' as const, intended, excess, completed };
    });
    if (outcome.kind === 'blocked') this.log.warn(`refund_fact_allocation_blocked fact=${fact.id} reason=${outcome.reason} — kept pending for reconciliation (S6h); the fact is unchanged`);
    if (outcome.kind === 'allocated') {
      this.log.log(`refund_fact_allocated fact=${fact.id} intended=${outcome.intended} excess=${outcome.excess}${outcome.completed ? ' completed=true' : ''}`);
      if (outcome.excess > 0) this.log.warn(`refund_excess_recorded fact=${fact.id} excess=${outcome.excess} — money returned beyond the approved refund; kept for reconciliation (S6h)`);
    }
    return outcome;
  }

  /** FC-3 and R6C-8: the completion's event and audit intent, in the completion transaction; the event id is derived from the authorization. */
  private async complete(q: Queryable, z: RefundAuthorizationRow, payment: PaymentRow, ctx: EventContext): Promise<void> {
    await this.outbox.enqueue(q, refundCaseCompletedEvent({ ...z, completedAt: z.completedAt! }, payment, ctx));
    await this.audit.recordRefundCompletion(q, z, payment.organizationId, ctx);
    this.log.log(`refund_case_completed refundCase=${z.refundCaseId} authorization=${z.id} payment=${z.paymentId}`);
  }

  /**
   * The worker's side (R6C-6): one fact, with a technical failure recorded as a bounded backoff on its lease (never the fact). Returns whether
   * the fact left the pending set.
   */
  async allocateWithRetry(factId: string, ctx: EventContext): Promise<boolean> {
    try {
      await this.allocate(factId, ctx); // allocated, already allocated or permanently blocked: it leaves the pending set either way
      return true;
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      const failure = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? `pg_${code.toLowerCase()}` : 'technical_failure';
      await this.db.query(
        `INSERT INTO refund_fact_allocation_lease ("factId", attempts, "workAfter", "lastFailure") VALUES ($1, 1, now() + make_interval(secs => $2), $3)
         ON CONFLICT ("factId") DO UPDATE SET attempts = refund_fact_allocation_lease.attempts + 1,
           "workAfter" = now() + make_interval(secs => LEAST(3600, power(2, LEAST(refund_fact_allocation_lease.attempts + 1, 12)))), "lastFailure" = $3`,
        [factId, allocationBackoffSeconds(1), failure.slice(0, 64)],
      ).catch(() => undefined);
      this.log.warn(`refund_fact_allocation_retry fact=${factId} failure=${failure} — the fact is kept; retried with backoff`);
      return false;
    }
  }

  /** The verified refund facts not yet allocated nor blocked whose backoff has passed (R6C-6). */
  async pendingFacts(limit: number): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT f.id FROM provider_transaction_fact f
         LEFT JOIN refund_fact_allocation_lease l ON l."factId" = f.id
        WHERE f.kind = 'refund'
          -- Core V2 S6h (R6H-3): an unmatched refund fact waits for its association (it is a reconciliation item until then)
          AND (f."paymentId" IS NOT NULL OR EXISTS (SELECT 1 FROM provider_fact_association s WHERE s."factId" = f.id AND s.status = 'associated'))
          AND NOT EXISTS (SELECT 1 FROM refund_allocation a WHERE a."factId" = f.id)
          AND NOT EXISTS (SELECT 1 FROM refund_fact_allocation_block b WHERE b."factId" = f.id)
          AND (l."workAfter" IS NULL OR l."workAfter" <= now())
        ORDER BY f."observedAt", f.id LIMIT $1`,
      [limit],
    );
    return rows.map((r) => r.id);
  }
}

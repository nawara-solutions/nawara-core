import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import type { EventContext } from '../events/payment-events.js';
import { notFound } from '../errors.js';
import type { RefundStatusResult } from '../providers/provider.port.js';
import { RefundAttemptService } from './refund-attempt.service.js';
import type { RefundAttemptRow } from './refund.types.js';

/** The attempt states in which a provider outcome still applies: the refund was (or may have been) sent. */
const IN_FLIGHT = new Set(['dispatching', 'submitted', 'unknown']);

/**
 * Core V2 S6b (register PAY-05, PAY-07; S0 FC-1, V-2, [OD] D4; the Owner's R6B-4, R6B-5): applies the provider's refund evidence, which
 * reached Payment only through an authenticated channel (a signature-verified webhook or the provider's status read: `ctx` says which).
 *
 *   * A reported refund is a money movement: it is FIRST committed, in its own transaction, as an immutable `provider_transaction_fact` of kind
 *     `refund` bound to its attempt, payment, captured attempt and provider; it is never refused. An identical redelivery (or the same refund
 *     through the other channel) is the same fact; a contradicting observation never overwrites it and is kept once as a conflict.
 *   * Then, under the payment and attempt locks: an attempt in flight succeeds ONLY on a fact of exactly its amount and currency, under its own
 *     provider refund reference, with no contradiction; any other verified refund becomes `discrepancy` (never a silent full refund); a
 *     verified refund contradicting a provider-confirmed failure moves that failure to `discrepancy` too.
 *   * A provider-confirmed failure of an attempt in flight is `failed` (definitive; a new attempt needs a new authorization). `pending` and a
 *     missing record change nothing (R6B-4).
 *
 * Nothing here allocates, completes a case, reverses a purchase, touches an entitlement or creates an obligation (S6c, S6d).
 */
@Injectable()
export class RefundEvidenceService {
  private readonly log = new Logger('PaymentRefundEvidence');

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(PaymentAudit) private readonly audit: PaymentAudit,
    @Inject(RefundAttemptService) private readonly attempts: RefundAttemptService,
  ) {}

  /** The refund attempt a provider message names (its idempotency key or its provider refund reference), of THAT provider only. */
  async findByReference(providerId: string, reference: string): Promise<RefundAttemptRow | null> {
    const { rows } = await this.db.query<RefundAttemptRow>(
      `SELECT * FROM refund_attempt WHERE provider = $1 AND ("providerRefundId" = $2 OR id::text = $2)`, [providerId, reference]);
    return rows[0] ?? null;
  }

  async apply(refundAttemptId: string, status: RefundStatusResult, ctx: EventContext): Promise<RefundAttemptRow> {
    let fact: { id: string; matches: boolean } | null = null;
    if (status.kind === 'succeeded') fact = await this.recordRefundFact(refundAttemptId, status, ctx);
    if (status.kind === 'pending' || status.kind === 'notFound') {
      const { rows } = await this.db.query<RefundAttemptRow>('SELECT * FROM refund_attempt WHERE id = $1', [refundAttemptId]);
      if (!rows[0]) throw notFound();
      return rows[0];
    }
    return this.db.tx(async (q) => {
      const a = await this.attempts.lockAttempt(q, refundAttemptId);
      const organizationId = await this.attempts.organizationOf(q, a.paymentId);
      if (status.kind === 'succeeded') {
        if (!fact) return a; // unidentifiable evidence: refused loudly by recordRefundFact, nothing applied
        const exact = fact.matches && (a.providerRefundId === null || a.providerRefundId === status.providerRefundId);
        if (IN_FLIGHT.has(a.status) && exact) {
          const { rows } = await q.query<RefundAttemptRow>(
            `UPDATE refund_attempt SET status = 'succeeded', "succeededFactId" = $2, "providerRefundId" = COALESCE("providerRefundId", $3), "completedAt" = now(), "workAfter" = NULL
              WHERE id = $1 RETURNING *`,
            [a.id, fact.id, status.providerRefundId],
          );
          await this.audit.recordRefund(q, 'refund_attempt.succeeded', rows[0]!, organizationId, ctx);
          this.log.log(`refund_attempt_succeeded refundAttempt=${a.id} payment=${a.paymentId} fact=${fact.id}`);
          return rows[0]!;
        }
        if (IN_FLIGHT.has(a.status) || a.status === 'failed') {
          const { rows } = await q.query<RefundAttemptRow>(
            `UPDATE refund_attempt SET status = 'discrepancy', "providerRefundId" = COALESCE("providerRefundId", $2), "completedAt" = COALESCE("completedAt", now()), "workAfter" = NULL
              WHERE id = $1 RETURNING *`,
            [a.id, status.providerRefundId],
          );
          this.log.warn(`refund_attempt_discrepancy refundAttempt=${a.id} payment=${a.paymentId} fact=${fact.id} from=${a.status} — verified refund evidence that is not exactly this full refund; kept for reconciliation (S6h)`);
          return rows[0]!;
        }
        if (a.status !== 'succeeded' || !exact) {
          this.log.warn(`refund_evidence_unapplied refundAttempt=${a.id} status=${a.status} fact=${fact.id} — recorded as evidence only`);
        }
        return a;
      }
      // provider-confirmed failure
      if (IN_FLIGHT.has(a.status)) {
        const { rows } = await q.query<RefundAttemptRow>(
          `UPDATE refund_attempt SET status = 'failed', "failureCode" = $2, "completedAt" = now(), "workAfter" = NULL WHERE id = $1 RETURNING *`,
          [a.id, failureCode(status.failureCode)],
        );
        await this.audit.recordRefund(q, 'refund_attempt.failed', rows[0]!, organizationId, ctx);
        this.log.warn(`refund_attempt_failed refundAttempt=${a.id} payment=${a.paymentId} code=${rows[0]!.failureCode}`);
        return rows[0]!;
      }
      if (a.status === 'succeeded' || a.status === 'discrepancy') {
        this.log.warn(`refund_failure_contradicts_evidence refundAttempt=${a.id} status=${a.status} — a failure report after verified refund evidence; nothing changed`);
      }
      return a;
    });
  }

  /**
   * FC-1 for refunds: the provider's reported refund as an immutable fact, in its own transaction, before any processing. Returns the fact and
   * whether THIS observation is exactly the attempt's full refund (same attempt, amount and currency, and no contradiction of the stored fact).
   */
  private async recordRefundFact(refundAttemptId: string, s: Extract<RefundStatusResult, { kind: 'succeeded' }>, ctx: EventContext): Promise<{ id: string; matches: boolean } | null> {
    const { rows: found } = await this.db.query<RefundAttemptRow>('SELECT * FROM refund_attempt WHERE id = $1', [refundAttemptId]);
    const a = found[0];
    if (!a) throw notFound();
    if (!s.providerRefundId || !Number.isSafeInteger(s.amount) || s.amount < 1 || typeof s.currency !== 'string' || s.currency.length < 1 || s.currency.length > 16) {
      this.log.error(`refund_fact_unidentifiable refundAttempt=${a.id} provider=${a.provider} — malformed refund evidence is never a verified fact`);
      return null;
    }
    const webhookEventId = ctx.cause.type === 'webhook_event' ? ctx.cause.id : null;
    const source = webhookEventId ? 'webhook' : 'status_check';
    return this.db.tx(async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO provider_transaction_fact (provider, "providerTxnId", kind, "paymentId", "attemptId", "refundAttemptId", amount, currency, "liveMode", source, "webhookEventId", "providerOccurredAt")
         VALUES ($1, $2, 'refund', $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT ON CONSTRAINT provider_transaction_fact_identity DO NOTHING RETURNING id`,
        [a.provider, s.providerRefundId, a.paymentId, a.capturedAttemptId, a.id, s.amount, s.currency, a.liveMode, source, webhookEventId, s.providerOccurredAt ?? null],
      );
      const exactAmount = s.amount === Number(a.amount) && s.currency === a.currency.trim();
      if (rows[0]) return { id: rows[0].id, matches: exactAmount };
      const { rows: existing } = await q.query<{ id: string; refundAttemptId: string | null; paymentId: string; amount: string; currency: string }>(
        `SELECT id, "refundAttemptId", "paymentId", amount, currency FROM provider_transaction_fact WHERE provider = $1 AND "providerTxnId" = $2 AND kind = 'refund'`,
        [a.provider, s.providerRefundId],
      );
      const stored = existing[0]!;
      const same = stored.refundAttemptId === a.id && stored.paymentId === a.paymentId && Number(stored.amount) === s.amount && stored.currency === s.currency;
      if (!same) {
        await q.query(
          `INSERT INTO provider_transaction_fact_conflict ("factId", "paymentId", "attemptId", "refundAttemptId", provider, amount, currency, source, "webhookEventId")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT ON CONSTRAINT provider_transaction_fact_conflict_once DO NOTHING`,
          [stored.id, a.paymentId, a.capturedAttemptId, a.id, a.provider, s.amount, s.currency, source, webhookEventId],
        );
        this.log.warn(`provider_fact_conflict fact=${stored.id} refundAttempt=${a.id} provider=${a.provider} — a contradicting refund observation; kept for reconciliation, the fact is unchanged`);
      }
      const storedExact = stored.refundAttemptId === a.id && Number(stored.amount) === Number(a.amount) && stored.currency === a.currency.trim();
      return { id: stored.id, matches: same && storedExact };
    });
  }
}

/** A provider failure code, bounded to the stored grammar (never free text). */
function failureCode(code: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'provider_failure';
}

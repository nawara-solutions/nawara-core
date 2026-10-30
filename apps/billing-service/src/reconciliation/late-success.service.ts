import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import type { TransitionContext } from '../domain/actors.js';
import { applyRecoveryPayment } from '../recovery/recovery-ledger.js';
import { ReconciliationCases } from './reconciliation-cases.js';

/** Payment's verified late success, as its `payment.late_success.recorded` event (EVT-10) or its reconciliation read states it. */
export interface PaymentLateSuccess {
  lateSuccessId: string;
  paymentId: string;
  factId: string | null;
  amount: number;
  currency: string;
  paymentStatus: string;
  recordedAt: string;
}

export type LateSuccessOutcome = 'recorded' | 'duplicate' | 'binding_mismatch' | 'conflict';
export type LateSuccessSource = { kind: 'event'; eventId: string } | { kind: 'reconciliation' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const STATUSES = ['succeeded', 'failed', 'expired', 'cancelled'];

/**
 * Core V2 S6h-B (register EVT-10, BIL-33; S0 §3.4 L-1, L-2, §3.5; the Owner's R6H-4). DEVELOPMENT AND SIMULATION ONLY.
 *
 * `record`: Payment's VERIFIED success of a payment after it ended, once per late success and per provider fact (`payment_late_success`), only
 * for a payment Billing requested. The same statement again is a duplicate; another statement of it is a conflict (never applied, kept for
 * review). It is NEVER a `payment.succeeded`: the payment request keeps its terminal state and nothing is purchased. In the SAME transaction it
 * is classified by the request's OWN routing purpose:
 *   - `recovery_settlement`: a `recovery_payment` of the verified captured amount (every distinct verified success counts once), split by the
 *     database into the principal still outstanding and the surplus owed to the Organization; T3 ends only when the principal reaches the base;
 *   - anything else (an assisted settlement, a purchase, a non-entitlement sale): a `late_success` reconciliation case, resolved only by the
 *     completed capture-specific refund of that captured movement (R6H-5); no purchase, no entitlement, no obligation.
 */
@Injectable()
export class LateSuccessService {
  private readonly log = new Logger('BillingLateSuccesses');

  constructor(private readonly db: DbService, private readonly audit: BillingAudit, @Inject(ReconciliationCases) private readonly cases: ReconciliationCases) {}

  async record(l: PaymentLateSuccess, source: LateSuccessSource): Promise<LateSuccessOutcome> {
    if (![l.lateSuccessId, l.paymentId].every((v) => typeof v === 'string' && UUID.test(v)) || (l.factId !== null && (typeof l.factId !== 'string' || !UUID.test(l.factId)))
      || typeof l.amount !== 'number' || !Number.isSafeInteger(l.amount) || l.amount < 1 || typeof l.currency !== 'string' || !/^[A-Z]{3}$/.test(l.currency)
      || !STATUSES.includes(l.paymentStatus) || typeof l.recordedAt !== 'string' || !ISO.test(l.recordedAt)) return this.refused('binding_mismatch', l, 'malformed');
    const ctx: TransitionContext = source.kind === 'event'
      ? { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: source.eventId }, correlationId: `late-success:${l.lateSuccessId}` }
      : { actor: { type: 'system', id: null }, cause: { type: 'reconciliation', id: l.lateSuccessId }, correlationId: `late-success:${l.lateSuccessId}` };
    try {
      return await this.db.tx(async (q) => {
        const pr = (await q.query<{ id: string }>(`SELECT id FROM payment_request WHERE "paymentId" = $1 FOR UPDATE`, [l.paymentId])).rows[0];
        if (!pr) return this.refused('binding_mismatch', l, 'unknown_payment');
        const prior = (await q.query<{ paymentId: string; factId: string | null; amount: string; currency: string }>(
          `SELECT "paymentId", "factId", amount, trim(currency) AS currency FROM payment_late_success WHERE "lateSuccessId" = $1`, [l.lateSuccessId])).rows[0];
        if (prior) {
          const same = prior.paymentId === l.paymentId && prior.factId === l.factId && Number(prior.amount) === l.amount && prior.currency === l.currency;
          return same ? 'duplicate' : this.refused('conflict', l, 'another_statement');
        }
        await q.query(
          `INSERT INTO payment_late_success ("lateSuccessId", "paymentId", "paymentRequestId", "factId", amount, currency, "paymentStatus", "recordedAt", source, "eventId")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [l.lateSuccessId, l.paymentId, pr.id, l.factId, l.amount, l.currency, l.paymentStatus, l.recordedAt, source.kind, source.kind === 'event' ? source.eventId : null]);
        await this.classify(q, l.lateSuccessId, ctx);
        this.log.log(`late_success_recorded lateSuccess=${l.lateSuccessId} payment=${l.paymentId} source=${source.kind}`);
        return 'recorded' as const;
      });
    } catch (e) {
      if (isUniqueViolation(e)) return 'duplicate'; // a concurrent record of the same late success (the event and the reader), or of its fact
      throw e;
    }
  }

  /**
   * The classification of one recorded late success, once: its recovery payment, or its reconciliation case. Idempotent (a crash between the
   * record and its classification is completed by the reconciliation worker).
   */
  async classify(q: Queryable, lateSuccessId: string, ctx: TransitionContext): Promise<'recovery' | 'recovered' | 'case' | 'done'> {
    if ((await q.query(`SELECT 1 FROM recovery_payment WHERE "lateSuccessId" = $1`, [lateSuccessId])).rows.length > 0) return 'done';
    const l = (await q.query<{ paymentId: string; paymentRequestId: string; factId: string | null; amount: string; currency: string; invoiceId: string;
      purpose: string | null; obligationId: string | null }>(
      `SELECT l."paymentId", l."paymentRequestId", l."factId", l.amount, trim(l.currency) AS currency, pr."invoiceId", e.purpose, e."recoveryObligationId" AS "obligationId"
         FROM payment_late_success l JOIN payment_request pr ON pr.id = l."paymentRequestId" LEFT JOIN invoice_entitlement e ON e."invoiceId" = pr."invoiceId"
        WHERE l."lateSuccessId" = $1`, [lateSuccessId])).rows[0]!;
    if (l.purpose === 'recovery_settlement' && l.obligationId) {
      return applyRecoveryPayment(q, this.audit, { obligationId: l.obligationId, invoiceId: l.invoiceId, paymentRequestId: l.paymentRequestId, lateSuccessId,
        amount: l.amount, currency: l.currency }, ctx);
    }
    const opened = await this.cases.openForPayment(q, { caseType: 'late_success', evidenceKey: lateSuccessId, paymentRequestId: l.paymentRequestId,
      captureFactId: l.factId, amount: Number(l.amount), currency: l.currency, detail: l.purpose ?? 'unrouted' });
    return opened === null ? 'done' : 'case';
  }

  private refused(o: 'binding_mismatch' | 'conflict', l: PaymentLateSuccess, why: string): LateSuccessOutcome {
    const id = typeof l.lateSuccessId === 'string' && UUID.test(l.lateSuccessId) ? l.lateSuccessId : '[invalid]';
    this.log.error(`late_success_refused lateSuccess=${id} outcome=${o} reason=${why} — nothing changed; needs review`);
    return o;
  }
}

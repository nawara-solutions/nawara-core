import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import type { TransitionContext } from '../domain/actors.js';
import { applyRecoveryPayment } from '../recovery/recovery-ledger.js';
import { PAYMENT_REFUND_CLIENT, type CaptureReadOutcome, type PaymentRefundClient } from '../refunds/payment-refund-client.js';
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
/**
 * Core V2 S0-C12 D-1 with S0-C11 items 1 and 9: Payment's point-in-time statement about the capture an EQUAL recovery late success names, read
 * outside any transaction (not a lock). `verified`: uncontested and equal, so it may count; `contested` or `unverified` (Payment states it is not
 * that payment's capture, or states other figures): never counted, a refund-only case; absent (Payment unanswerable or an answer about something
 * else): nothing is decided, the reconciliation worker reads again.
 */
export type RecoveryCaptureEvidence = 'verified' | 'contested' | 'unverified';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const STATUSES = ['succeeded', 'failed', 'expired', 'cancelled'];
const TERMINAL_UNSUCCESSFUL = ['failed', 'expired', 'cancelled'];
/** Billing's final payment request states (its own record of Payment's outcome). */
const FINAL_REQUEST = ['paid', 'failed', 'cancelled', 'expired', 'rejected'];

/**
 * Core V2 S6h-B (register EVT-10, BIL-33; S0 §3.4 L-1, L-2, §3.5; the Owner's R6H-4). DEVELOPMENT AND SIMULATION ONLY.
 *
 * `record`: Payment's VERIFIED success of a payment after it ended, once per late success and per provider fact (`payment_late_success`), only
 * for a payment Billing requested. The same statement again is a duplicate; another statement of it is a conflict (never applied, kept for
 * review). It is NEVER a `payment.succeeded`: the payment request keeps its terminal state and nothing is purchased. In the SAME transaction it
 * is classified by the request's OWN routing purpose:
 *   - `recovery_settlement`: a `recovery_payment` of the verified captured amount (every distinct verified success counts once), split by the
 *     database into the principal still outstanding and the surplus owed to the Organization; T3 ends only when the principal reaches the base;
 *   - `assisted_settlement` (Core V2 S0-C8 item 1 b; register BIL-32 G, BIL-33 G; the Owner's LS-4, LS-5, LS-8): while Billing's payment
 *     request is not final, NOTHING is decided (the record waits; the reconciliation worker retries it: finality is never inferred). Once it
 *     is final, an ELIGIBLE late success (Payment's payment and Billing's request ended in the same `failed` / `cancelled` / `expired` state,
 *     the channel is `closed`, the capture fact is named, the amount and currency equal the invoice's total, and the invoice has no late
 *     settlement yet) is an `assistance_late_settlement` (`channel_closed`, `settledAt` = Payment's `recordedAt`) with its
 *     `late_assisted_settlement` case: the L-4 input, whose default resolution is the full refund of that capture (L-3). NO purchase, no
 *     entitlement, no obligation change (L-2). Any other assisted late success, and one already handled as a `late_success` case (LS-8),
 *     stays refund-only;
 *   - anything else (a purchase, a non-entitlement sale, an ineligible assisted success): a `late_success` reconciliation case, resolved only
 *     by the completed capture-specific refund of that captured movement (R6H-5); no purchase, no entitlement, no obligation.
 */
@Injectable()
export class LateSuccessService {
  private readonly log = new Logger('BillingLateSuccesses');

  constructor(private readonly db: DbService, private readonly audit: BillingAudit, @Inject(ReconciliationCases) private readonly cases: ReconciliationCases,
    @Inject(PAYMENT_REFUND_CLIENT) private readonly captures: PaymentRefundClient) {}

  /**
   * S0-C12 D-1: the evidence an EQUAL recovery late success needs before it may count; `undefined` for every other late success (none is read) and
   * when Payment cannot answer. Called before the classifying transaction, never inside it. `l` is the late success as recorded or as stated.
   */
  async recoveryEvidence(l: { lateSuccessId?: string; paymentId: string; factId: string | null; amount: number; currency: string }): Promise<RecoveryCaptureEvidence | undefined> {
    const r = (await this.db.query<{ purpose: string | null; total: string; currency: string }>(
      `SELECT e.purpose, i.total, trim(i.currency) AS currency FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId"
         LEFT JOIN invoice_entitlement e ON e."invoiceId" = pr."invoiceId" WHERE pr."paymentId" = $1`, [l.paymentId])).rows[0];
    if (!r || r.purpose !== 'recovery_settlement' || l.amount !== Number(r.total) || l.currency !== r.currency) return undefined;
    if (!l.factId) return 'unverified'; // S0-C11 item 1: no fact names it, so nothing verifies it
    let read: CaptureReadOutcome;
    try {
      read = await this.captures.capture(l.paymentId, l.factId);
    } catch {
      read = { kind: 'unknown', reason: 'error' };
    }
    if (read.kind === 'capture' && read.capture.paymentId === l.paymentId && read.capture.factId === l.factId) {
      if (read.capture.conflicted) return 'contested';
      return read.capture.amount === l.amount && read.capture.currency === l.currency ? 'verified' : 'unverified';
    }
    if (read.kind === 'not_found' && read.reason === 'capture_not_found') return 'unverified';
    this.log.warn(`late_success_recovery_evidence_unavailable lateSuccess=${l.lateSuccessId ?? '-'} payment=${l.paymentId} outcome=${read.kind}`
      + ' — nothing decided; the reconciliation worker reads Payment again');
    return undefined;
  }

  async record(l: PaymentLateSuccess, source: LateSuccessSource): Promise<LateSuccessOutcome> {
    if (![l.lateSuccessId, l.paymentId].every((v) => typeof v === 'string' && UUID.test(v)) || (l.factId !== null && (typeof l.factId !== 'string' || !UUID.test(l.factId)))
      || typeof l.amount !== 'number' || !Number.isSafeInteger(l.amount) || l.amount < 1 || typeof l.currency !== 'string' || !/^[A-Z]{3}$/.test(l.currency)
      || !STATUSES.includes(l.paymentStatus) || typeof l.recordedAt !== 'string' || !ISO.test(l.recordedAt)) return this.refused('binding_mismatch', l, 'malformed');
    const ctx: TransitionContext = source.kind === 'event'
      ? { actor: { type: 'system', id: null }, cause: { type: 'payment_event', id: source.eventId }, correlationId: `late-success:${l.lateSuccessId}` }
      : { actor: { type: 'system', id: null }, cause: { type: 'reconciliation', id: l.lateSuccessId }, correlationId: `late-success:${l.lateSuccessId}` };
    const evidence = await this.recoveryEvidence(l); // S0-C12 D-1: outside the transaction (not a lock)
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
        await this.classify(q, l.lateSuccessId, ctx, evidence);
        this.log.log(`late_success_recorded lateSuccess=${l.lateSuccessId} payment=${l.paymentId} source=${source.kind}`);
        return 'recorded' as const;
      });
    } catch (e) {
      if (isUniqueViolation(e)) return 'duplicate'; // a concurrent record of the same late success (the event and the reader), or of its fact
      throw e;
    }
  }

  /**
   * The classification of one recorded late success, once: its recovery payment, its late assisted settlement, or its reconciliation case; or
   * `deferred` while its assisted payment request is not final. Idempotent, under the payment request's row lock (a crash between the record
   * and its classification, or a deferral, is completed by the reconciliation worker). The database re-checks every condition (0043).
   */
  async classify(q: Queryable, lateSuccessId: string, ctx: TransitionContext, evidence?: RecoveryCaptureEvidence): Promise<'recovery' | 'recovered' | 'case' | 'late_settlement' | 'deferred' | 'done'> {
    if ((await q.query(`SELECT 1 FROM recovery_payment WHERE "lateSuccessId" = $1 UNION ALL SELECT 1 FROM assistance_late_settlement WHERE "lateSuccessId" = $1`,
      [lateSuccessId])).rows.length > 0) return 'done';
    const l = (await q.query<{ paymentId: string; paymentRequestId: string; factId: string | null; amount: string; currency: string; invoiceId: string;
      purpose: string | null; obligationId: string | null; assistanceRequestId: string | null; paymentStatus: string; recordedAt: Date; requestStatus: string;
      invoiceTotal: string; invoiceCurrency: string }>(
      `SELECT l."paymentId", l."paymentRequestId", l."factId", l.amount, trim(l.currency) AS currency, pr."invoiceId", e.purpose, e."recoveryObligationId" AS "obligationId",
              e."assistanceRequestId", l."paymentStatus", l."recordedAt", pr.status AS "requestStatus", i.total AS "invoiceTotal", trim(i.currency) AS "invoiceCurrency"
         FROM payment_late_success l JOIN payment_request pr ON pr.id = l."paymentRequestId" JOIN invoice i ON i.id = pr."invoiceId"
         LEFT JOIN invoice_entitlement e ON e."invoiceId" = pr."invoiceId"
        WHERE l."lateSuccessId" = $1 FOR UPDATE OF pr`, [lateSuccessId])).rows[0]!;
    // Core V2 S0-C12 D-1 (BIL-28 G): a recovery late success counts only for exactly the recovery invoice's total and currency, and only on Payment's
    // statement that its capture is uncontested (S0-C11 items 1, 9); an unequal, contested or unverified one is never counted: it falls through to a
    // refund-only `late_success` case below (D-B returns an unequal one); Payment unanswerable: nothing is decided yet (the worker reads again)
    const equalRecovery = l.purpose === 'recovery_settlement' && l.obligationId !== null
      && Number(l.amount) === Number(l.invoiceTotal) && l.currency === l.invoiceCurrency;
    if (equalRecovery && evidence === undefined) return 'deferred';
    if (equalRecovery && evidence === 'verified' && l.obligationId) {
      return applyRecoveryPayment(q, this.audit, { obligationId: l.obligationId, invoiceId: l.invoiceId, paymentRequestId: l.paymentRequestId, lateSuccessId,
        amount: l.amount, currency: l.currency }, ctx);
    }
    if (l.purpose === 'assisted_settlement' && l.assistanceRequestId) {
      // LS-8: one already handled as a refund-only case stays so
      if ((await q.query(`SELECT 1 FROM reconciliation_case WHERE "caseType" = 'late_success' AND "evidenceKey" = $1`, [lateSuccessId])).rows.length > 0) return 'done';
      if (!FINAL_REQUEST.includes(l.requestStatus)) return 'deferred'; // LS-5: never decided before Billing holds Payment's final outcome
      const lateSettlementId = await this.lateSettlement(q, lateSuccessId, { ...l, assistanceRequestId: l.assistanceRequestId });
      if (lateSettlementId) {
        await this.cases.openForPayment(q, { caseType: 'late_assisted_settlement', evidenceKey: lateSettlementId, paymentRequestId: l.paymentRequestId,
          paymentId: l.paymentId, captureFactId: l.factId, amount: Number(l.amount), currency: l.currency });
        this.log.log(`late_success_late_settlement lateSuccess=${lateSuccessId} lateSettlement=${lateSettlementId} — no purchase (L-2); refund by default (L-3)`);
        return 'late_settlement';
      }
    }
    const opened = await this.cases.openForPayment(q, { caseType: 'late_success', evidenceKey: lateSuccessId, paymentRequestId: l.paymentRequestId,
      captureFactId: l.factId, amount: Number(l.amount), currency: l.currency, detail: l.purpose ?? 'unrouted' });
    return opened === null ? 'done' : 'case';
  }

  /** S0-C8 item 1 (b), LS-4: the late assisted settlement of an ELIGIBLE late success (the first of its invoice), or null (refund-only). */
  private async lateSettlement(q: Queryable, lateSuccessId: string, l: { paymentRequestId: string; factId: string | null; amount: string; currency: string;
    invoiceId: string; assistanceRequestId: string; paymentStatus: string; recordedAt: Date; requestStatus: string; invoiceTotal: string; invoiceCurrency: string }): Promise<string | null> {
    if (l.factId === null || !TERMINAL_UNSUCCESSFUL.includes(l.paymentStatus) || l.requestStatus !== l.paymentStatus
      || Number(l.amount) !== Number(l.invoiceTotal) || l.currency !== l.invoiceCurrency) return null;
    const closed = (await q.query(`SELECT 1 FROM assistance_settlement_channel WHERE "invoiceId" = $1 AND "assistanceRequestId" = $2 AND "paymentRequestId" = $3 AND status = 'closed'`,
      [l.invoiceId, l.assistanceRequestId, l.paymentRequestId])).rows.length > 0;
    if (!closed || (await q.query(`SELECT 1 FROM assistance_late_settlement WHERE "invoiceId" = $1`, [l.invoiceId])).rows.length > 0) return null;
    return (await q.query<{ id: string }>(
      `INSERT INTO assistance_late_settlement ("assistanceRequestId", "invoiceId", "paymentRequestId", "lateSuccessId", reason, "settledAt")
       VALUES ($1, $2, $3, $4, 'channel_closed', $5) RETURNING id`, [l.assistanceRequestId, l.invoiceId, l.paymentRequestId, lateSuccessId, l.recordedAt])).rows[0]!.id;
  }

  private refused(o: 'binding_mismatch' | 'conflict', l: PaymentLateSuccess, why: string): LateSuccessOutcome {
    const id = typeof l.lateSuccessId === 'string' && UUID.test(l.lateSuccessId) ? l.lateSuccessId : '[invalid]';
    this.log.error(`late_success_refused lateSuccess=${id} outcome=${o} reason=${why} — nothing changed; needs review`);
    return o;
  }
}

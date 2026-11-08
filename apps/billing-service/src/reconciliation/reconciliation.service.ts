import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap, type OnApplicationShutdown, type OnModuleDestroy } from '@nestjs/common';
import { DbService, PollLoop, describeFailure, type DrainOutcome, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import type { TransitionContext } from '../domain/actors.js';
import { billingError, notFound } from '../domain/errors.js';
import { FRAUD_HOLD_RECEIPTS, type FraudHoldBinding, type FraudHoldReceipts, type ReceiptConsumption } from '../fraud-holds/fraud-hold-clients.js';
import { BILLING_MESSAGES } from '../messages.js';
import { OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import { RefundCommandIdempotency } from '../refunds/refund-idempotency.js';
import type { VerifiedRefundOwner } from '../refunds/refund-owner.guard.js';
import { LateSuccessService } from './late-success.service.js';
import { RefundEvidenceReader } from '../refunds/refund-evidence.js';
import { PAYMENT_REFUND_CLIENT, type CaptureReadOutcome, type PaymentRefundClient } from '../refunds/payment-refund-client.js';
import { PAYMENT_RECONCILIATION_CLIENT, type PaymentItem, type PaymentItemKind, type PaymentReconciliationClient } from './payment-reconciliation-client.js';
import { FinancialWorkerGate } from '../refunds/financial-safety.js';
import {
  ACKNOWLEDGEMENT_REASONS, CASE_TYPES, REVIEW_ONLY, ReconciliationCases, workerContext, type CaseType,
} from './reconciliation-cases.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const PAGE = 200;
const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const invalid = () => billingError(400, 'invalid_reconciliation_request', BILLING_MESSAGES.invalidReconciliationRequest);
const pgConstraint = (e: unknown) => (e as { constraint?: string } | null)?.constraint;

/**
 * Core V2 S0-C11 item 8 (BIL-33 I): the identity of the `capture_contradiction` case of one contested fact as observed under one payment. One-way and
 * stable: replays and retries open nothing twice, and it reveals neither input, so nothing correlates the cases of different Companies.
 */
export function captureContradictionKey(factId: string, observingPaymentId: string): string {
  const h = createHash('sha256').update(`billing.capture_contradiction\0${factId}\0${observingPaymentId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The deterministic Auth `consumeRef` of one write-off request: the same obligation and receipt are always the same consumption. */
export function writeOffConsumeRef(obligationId: string, secret: string): string {
  const h = createHash('sha256').update(`billing.recovery_write_off\0${obligationId}\0${secret}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface CaseRow {
  id: string; caseType: CaseType; evidenceKey: string; companyId: string; platformId: string | null; organizationId: string | null; paymentId: string | null;
  paymentRequestId: string | null; captureFactId: string | null; amount: string | null; currency: string | null; detail: string | null; openedAt: Date;
  l4Purchase: boolean | null;
  kind: string | null; refundCaseId: string | null; lossId: string | null; recoveryPaymentId: string | null; resolvedByUserId: string | null; reason: string | null;
  resolvedAt: Date | null;
}
const CASE_SELECT = `SELECT c.id, c."caseType", c."evidenceKey", c."companyId", c."platformId", c."organizationId", c."paymentId", c."paymentRequestId", c."captureFactId",
    c.amount, trim(c.currency) AS currency, c.detail, c."openedAt",
    -- S0-C11 item 7b: whether an L-4 purchase rests on the contested capture, derived when read (the case itself is never rewritten); only where the
    -- case may show its fact (the fact is the observing payment's own)
    -- both L-4 inputs through the application's recorded capture (S0-C11 provenance, BIL-32 J), and an earlier late-success purchase with no
    -- recorded provenance through its late success
    CASE WHEN c."caseType" = 'capture_contradiction' AND c."captureFactId" IS NOT NULL THEN (
      EXISTS (SELECT 1 FROM late_settlement_application a JOIN assistance_late_settlement l ON l.id = a."lateSettlementId" JOIN payment_request pr ON pr.id = l."paymentRequestId"
               WHERE a."captureFactId" = c."captureFactId" AND pr."paymentId" = c."paymentId")
      OR EXISTS (SELECT 1 FROM payment_late_success s JOIN subscription_purchase p ON p."lateSuccessId" = s."lateSuccessId"
                  WHERE s."factId" = c."captureFactId" AND s."paymentId" = c."paymentId")) END AS "l4Purchase",
    r.kind, r."refundCaseId", r."lossId", r."recoveryPaymentId", r."resolvedByUserId", r.reason, r."resolvedAt"
  FROM reconciliation_case c LEFT JOIN reconciliation_case_resolution r ON r."caseId" = c.id`;
const representCase = (c: CaseRow) => ({
  id: c.id, caseType: c.caseType, evidenceId: c.evidenceKey, companyId: c.companyId, platformId: c.platformId, organizationId: c.organizationId, paymentId: c.paymentId,
  paymentRequestId: c.paymentRequestId, captureFactId: c.captureFactId, amount: c.amount === null ? null : Number(c.amount), currency: c.currency, detail: c.detail,
  status: c.kind ? 'resolved' : 'open', reviewOnly: REVIEW_ONLY.includes(c.caseType), openedAt: iso(c.openedAt),
  ...(c.caseType === 'capture_contradiction' ? { l4Purchase: c.l4Purchase } : {}),
  resolution: c.kind ? { kind: c.kind, refundCaseId: c.refundCaseId, lossId: c.lossId, recoveryPaymentId: c.recoveryPaymentId,
    resolvedBy: c.resolvedByUserId ? { userId: c.resolvedByUserId } : null, reason: c.reason, resolvedAt: iso(c.resolvedAt) } : null,
});

/**
 * Core V2 S6h-B (register BIL-33, BIL-34; S0 FC-1, FC-4, FC-6, §3.4, §3.5; ADR-0044 B5, B9, B11; the Owner's R6H-1, R6H-2, R6H-4, R6H-6 to
 * R6H-10). DEVELOPMENT AND SIMULATION ONLY: the module is never mounted in production and every route refuses there too.
 *
 * The reconciliation WORKER (`drainOnce`, replay-safe; concurrent passes open nothing twice):
 *   1. Payment's evidence of Billing's own payments (PAY-12, `payment.reconciliation.read`): late successes (recorded and classified, also when
 *      their event was lost), over-returns (a case and the `over_return` loss of the allocation EXCESS, then the case resolved by that loss),
 *      refund discrepancies, authorizations Auth never answered (Q8: visible, never released), PARTIAL chargebacks (review only: no financial
 *      effect is invented) and captures no original refund can return. Payment unanswerable: nothing is inferred; the next pass reads again.
 *   2. Billing's own evidence, new and historical: unapplied late assisted settlements, recovery surpluses, paid sales with no routing record,
 *      second reversal causes, contradictory effects, partial chargebacks and refund/chargeback overlaps, and late successes recorded but not
 *      classified (a crash in between).
 *   3. The direct final-lost chargeback loss (FC-6): a FULL chargeback of a DIRECT purchase with its verified fact and no completed refund of
 *      the payment; with a completed refund the overlap is a case instead, never a second recognition.
 *   4. Each open case whose resolving evidence now exists is resolved by that evidence (the database checks it); nothing else resolves a case.
 */
@Injectable()
export class ReconciliationService {
  private readonly log = new Logger('BillingReconciliation');
  private readonly loop = new PollLoop(
    () => this.drainOnce(),
    (e) => this.log.error(`reconciliation_pass_failure ${describeFailure(e)} — the next pass retries`),
    (ms) => this.log.warn(`worker_drain_timeout worker=reconciliation_worker drainTimeoutMs=${ms} — resumed after restart`),
  );
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly audit: BillingAudit,
    private readonly cases: ReconciliationCases,
    private readonly lateSuccesses: LateSuccessService,
    private readonly idempotency: RefundCommandIdempotency,
    @Inject(PAYMENT_RECONCILIATION_CLIENT) private readonly payment: PaymentReconciliationClient,
    @Inject(PAYMENT_REFUND_CLIENT) private readonly captures: PaymentRefundClient,
    @Inject(FRAUD_HOLD_RECEIPTS) private readonly receipts: FraudHoldReceipts,
    @Inject(OWNER_AUTHORITY) private readonly owners: OwnerAuthority,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
    private readonly evidence: RefundEvidenceReader,
  ) {}

  start(intervalMs = 10_000): void {
    this.loop.start(intervalMs);
  }

  async stop(drainTimeoutMs?: number): Promise<DrainOutcome> {
    return this.loop.stop(drainTimeoutMs);
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the worker

  async drainOnce(): Promise<{ read: boolean; opened: number; resolved: number; losses: number }> {
    if (this.running) return { read: false, opened: 0, resolved: 0, losses: 0 };
    this.running = true;
    try {
      const tally = { read: true, opened: 0, resolved: 0, losses: 0 };
      try {
        await this.readPayment(tally);
      } catch (e) {
        tally.read = false;
        this.log.warn(`reconciliation_read_unavailable ${describeFailure(e)} — Billing's own evidence is still reconciled; the next pass reads again`);
      }
      await this.discoverLocal(tally);
      await this.recognizeChargebackLosses(tally);
      await this.resolveOpen(tally);
      await this.resolveChargebackReturned(tally);
      return tally;
    } finally {
      this.running = false;
    }
  }

  private async page(kind: PaymentItemKind, each: (i: PaymentItem) => Promise<void>): Promise<void> {
    let after: string | undefined;
    for (;;) {
      const items = await this.payment.items(kind, after, PAGE);
      for (const i of items) {
        // Core V2 S0-C12 item 9: an item of a kind no contract names for this read opens nothing; it is logged and stays at Payment
        if (i.otherKind !== undefined) {
          this.log.warn(`payment_item_other_kind requested=${kind} stated=${i.otherKind} item=${i.id} — no contract names it here; nothing opened`);
          continue;
        }
        await each(i);
      }
      if (items.length < PAGE) return;
      after = items[items.length - 1]!.id;
    }
  }

  private async readPayment(tally: { opened: number; losses: number }): Promise<void> {
    await this.page('late_success', async (i) => {
      if ((await this.db.query(`SELECT 1 FROM payment_late_success WHERE "lateSuccessId" = $1`, [i.id])).rows.length > 0) return;
      if (i.amount === null || i.currency === null) return;
      await this.lateSuccesses.record({ lateSuccessId: i.id, paymentId: i.paymentId, factId: i.factId, amount: i.amount, currency: i.currency,
        paymentStatus: typeof i.detail.paymentStatus === 'string' ? i.detail.paymentStatus : '', recordedAt: i.at ?? '' }, { kind: 'reconciliation' });
    });
    await this.page('over_return', async (i) => {
      if (!i.factId || i.amount === null || i.currency === null) return;
      const factId = i.factId;
      const amount = i.amount;
      const currency = i.currency;
      await this.db.tx(async (q) => {
        const caseId = await this.caseFor(q, { caseType: 'over_return', evidenceKey: factId, paymentId: i.paymentId, amount, currency }, tally);
        if (!caseId) return;
        const pr = (await q.query<{ sellerId: string; organizationId: string | null }>(
          `SELECT i."sellerId", i."organizationId" FROM payment_request r JOIN invoice i ON i.id = r."invoiceId" WHERE r."paymentId" = $1`, [i.paymentId])).rows[0]!;
        const loss = (await q.query<{ id: string }>(
          `INSERT INTO financial_loss (kind, "evidenceKey", "companyId", "organizationId", "paymentId", amount, currency) VALUES ('over_return', $1, $2, $3, $4, $5, $6)
           ON CONFLICT ON CONSTRAINT financial_loss_once DO NOTHING RETURNING id`, [factId, pr.sellerId, pr.organizationId, i.paymentId, amount, currency])).rows[0];
        if (loss) {
          tally.losses++;
          await this.audit.record(q, 'financial_loss.recorded', {
            organizationId: pr.organizationId, resource: { type: 'financial_loss', id: loss.id }, changes: { kind: 'over_return', amount, evidence_id: factId },
          }, workerContext(factId));
        }
        const id = loss?.id ?? (await q.query<{ id: string }>(`SELECT id FROM financial_loss WHERE kind = 'over_return' AND "evidenceKey" = $1`, [factId])).rows[0]!.id;
        await this.cases.resolve(q, caseId, 'loss_recognized', { lossId: id }, workerContext(factId));
      });
    });
    await this.page('refund_discrepancy', async (i) => {
      await this.db.tx(async (q) => this.caseFor(q, { caseType: 'refund_discrepancy', evidenceKey: i.id, paymentId: i.paymentId, captureFactId: i.factId,
        amount: i.amount, currency: i.currency }, tally));
    });
    await this.page('authorization_pending', async (i) => {
      if (i.detail.operation !== 'refund') return; // a dispute decision is the Owner's own Payment intent, not Billing's
      // Q8 (R6H-9): visible until a definitive outcome; never released on missing evidence
      if ((await this.db.query(`SELECT 1 FROM refund_authorization_relay WHERE id = $1`, [i.id])).rows.length === 0) return;
      await this.db.tx(async (q) => this.caseFor(q, { caseType: 'authorization_pending', evidenceKey: i.id, paymentId: i.paymentId, amount: i.amount, currency: i.currency }, tally));
    });
    await this.page('chargeback', async (i) => {
      // R6H-10: a PARTIAL chargeback is reviewed, never turned into a financial effect (no threshold is frozen)
      if (i.detail.partial !== true) return;
      const disputeId = typeof i.detail.disputeId === 'string' && UUID.test(i.detail.disputeId) ? i.detail.disputeId : i.id;
      await this.db.tx(async (q) => this.caseFor(q, { caseType: 'partial_chargeback', evidenceKey: disputeId, paymentId: i.paymentId, amount: i.amount, currency: i.currency,
        detail: 'provider_partial_chargeback' }, tally));
    });
    // Core V2 S0-C11 item 8 (BIL-33 I, tenant-isolation clarification): one visibility-only case per contested capture fact AND per observing payment
    // (a payment of Billing's own, as Payment's producer read is scoped), its Company from Billing's own payment request and invoice. Payment's
    // capture read tells whether the fact is that payment's own: only then does the case carry the fact and its figures. Otherwise it carries
    // only that payment's own observation (never the other payment, its Company, the fact's id or its figures). Refund contradictions are excluded.
    // Payment unanswerable: nothing is inferred; Payment's own item stays visible and the next pass reads again.
    await this.page('fact_conflict', async (i) => {
      if (!i.factId || i.detail.refundAttemptId) return;
      let read: CaptureReadOutcome;
      try {
        read = await this.captures.capture(i.paymentId, i.factId);
      } catch {
        read = { kind: 'unknown', reason: 'error' };
      }
      if (read.kind === 'unknown' || read.kind === 'ineligible_currency') return; // no figures to show: nothing inferred, as for any read that proves nothing
      const own = read.kind === 'capture' && read.capture.paymentId === i.paymentId && read.capture.factId === i.factId;
      if (read.kind === 'capture' && (!own || !read.capture.conflicted)) return; // Payment's answers disagree: proven nothing
      const factId = i.factId;
      await this.db.tx(async (q) => this.caseFor(q, own && read.kind === 'capture'
        ? { caseType: 'capture_contradiction', evidenceKey: captureContradictionKey(factId, i.paymentId), paymentId: i.paymentId, captureFactId: factId,
          amount: read.capture.amount, currency: read.capture.currency, detail: 'own_capture_contested' }
        : { caseType: 'capture_contradiction', evidenceKey: captureContradictionKey(factId, i.paymentId), paymentId: i.paymentId,
          amount: i.amount, currency: i.currency, detail: 'contradicts_capture_elsewhere' }, tally));
    });
    await this.page('capture_refund_unavailable', async (i) => {
      const reason = typeof i.detail.reason === 'string' ? i.detail.reason : '';
      if (reason === 'late_capture' || !i.factId) return; // a late capture is its late success's case
      await this.db.tx(async (q) => this.caseFor(q, { caseType: 'unmatched_capture', evidenceKey: i.factId!, paymentId: i.paymentId, captureFactId: i.factId,
        amount: i.amount, currency: i.currency, detail: /^[a-z_]{1,64}$/.test(reason) ? reason : null }, tally));
    });
  }

  private async caseFor(q: Queryable, c: Parameters<ReconciliationCases['openForPayment']>[1], tally: { opened: number }): Promise<string | null> {
    const opened = await this.cases.openForPayment(q, c);
    if (opened) {
      tally.opened++;
      return opened;
    }
    return (await q.query<{ id: string }>(`SELECT id FROM reconciliation_case WHERE "caseType" = $1 AND "evidenceKey" = $2`, [c.caseType, c.evidenceKey])).rows[0]?.id ?? null;
  }

  /** Billing's own unresolved evidence, new and historical: each row is opened once (ON CONFLICT), whatever pass sees it first. */
  private async discoverLocal(tally: { opened: number }): Promise<void> {
    const run = async (sql: string, build: (r: Record<string, any>) => Parameters<ReconciliationCases['openForPayment']>[1]) => {
      for (const r of (await this.db.query<Record<string, any>>(sql)).rows) {
        await this.db.tx(async (q) => this.caseFor(q, build(r), tally));
      }
    };
    const fresh = (type: CaseType, key: string) => `NOT EXISTS (SELECT 1 FROM reconciliation_case k WHERE k."caseType" = '${type}' AND k."evidenceKey" = ${key})`;
    // late successes recorded but never classified (a crash between the record and its classification), or deferred until their assisted
    // payment request is final (Core V2 S0-C8, LS-5: retried on every pass, never inferred)
    for (const r of (await this.db.query<{ lateSuccessId: string; paymentId: string; factId: string | null; amount: string; currency: string }>(
      `SELECT l."lateSuccessId", l."paymentId", l."factId", l.amount, trim(l.currency) AS currency FROM payment_late_success l
        WHERE NOT EXISTS (SELECT 1 FROM recovery_payment p WHERE p."lateSuccessId" = l."lateSuccessId")
          AND NOT EXISTS (SELECT 1 FROM assistance_late_settlement s WHERE s."lateSuccessId" = l."lateSuccessId")
          AND ${fresh('late_success', 'l."lateSuccessId"')}`)).rows) {
      const ctx: TransitionContext = { actor: { type: 'system', id: null }, cause: { type: 'reconciliation', id: r.lateSuccessId }, correlationId: `late-success:${r.lateSuccessId}` };
      // Core V2 S0-C12 D-1: an equal recovery late success needs Payment's capture evidence, read before the transaction (not a lock)
      const evidence = await this.lateSuccesses.recoveryEvidence({ lateSuccessId: r.lateSuccessId, paymentId: r.paymentId, factId: r.factId, amount: Number(r.amount),
        currency: r.currency });
      await this.db.tx(async (q) => {
        if (['case', 'late_settlement'].includes(await this.lateSuccesses.classify(q, r.lateSuccessId, ctx, evidence))) tally.opened++;
      });
    }
    // Core V2 S0-C8: a late settlement from Payment's late success names its capture (its refund is exactly that captured movement, BIL-23 H)
    await run(`SELECT s.id, s."paymentRequestId", r."paymentId", r.amount, trim(r.currency) AS currency, l."factId" FROM assistance_late_settlement s
        JOIN payment_request r ON r.id = s."paymentRequestId" LEFT JOIN payment_late_success l ON l."lateSuccessId" = s."lateSuccessId"
        WHERE NOT EXISTS (SELECT 1 FROM late_settlement_application a WHERE a."lateSettlementId" = s.id) AND ${fresh('late_assisted_settlement', 's.id')}`,
      (r) => ({ caseType: 'late_assisted_settlement', evidenceKey: r.id, paymentRequestId: r.paymentRequestId, paymentId: r.paymentId, captureFactId: r.factId,
        amount: Number(r.amount), currency: r.currency }));
    await run(`SELECT r.id, r."paymentId", r.amount, trim(r.currency) AS currency FROM payment_request r JOIN invoice i ON i.id = r."invoiceId"
        WHERE r.status = 'paid' AND NOT EXISTS (SELECT 1 FROM invoice_entitlement e WHERE e."invoiceId" = r."invoiceId") AND ${fresh('unrouted_settlement', 'r.id')}`,
      (r) => ({ caseType: 'unrouted_settlement', evidenceKey: r.id, paymentRequestId: r.id, paymentId: r.paymentId, amount: Number(r.amount), currency: r.currency }));
    await run(`SELECT s.id, s."paymentRequestId" FROM subscription_purchase s
        WHERE (SELECT count(*) FROM subscription_purchase_reversal_cause k WHERE k."purchaseId" = s.id) > 1 AND ${fresh('second_reversal_cause', 's.id')}`,
      (r) => ({ caseType: 'second_reversal_cause', evidenceKey: r.id, paymentRequestId: r.paymentRequestId, detail: 'second_reversal_cause' }));
    await run(`SELECT t."refundCaseId" AS id, c."paymentId" FROM refund_case_effect_attempt t JOIN refund_case c ON c.id = t."refundCaseId"
        WHERE t.state = 'review' AND ${fresh('contradictory_effect', 't."refundCaseId"')}`,
      (r) => ({ caseType: 'contradictory_effect', evidenceKey: r.id, paymentId: r.paymentId, detail: 'refund_effect_review' }));
    await run(`SELECT t."disputeId" AS id, l."paymentRequestId", t.reason FROM dispute_loss_effect_attempt t JOIN payment_dispute_loss l ON l."disputeId" = t."disputeId"
        WHERE t.state = 'review' AND t.reason <> 'partial_chargeback_threshold_open' AND ${fresh('contradictory_effect', 't."disputeId"')}`,
      (r) => ({ caseType: 'contradictory_effect', evidenceKey: r.id, paymentRequestId: r.paymentRequestId, detail: 'dispute_effect_review' }));
    await run(`SELECT x."disputeId" AS id, l."paymentRequestId", l."chargebackAmount" AS amount, trim(l.currency) AS currency FROM (
          SELECT "disputeId" FROM dispute_loss_effect_attempt WHERE reason = 'partial_chargeback_threshold_open'
          UNION SELECT "disputeId" FROM recovery_review WHERE reason = 'partial_chargeback'
          -- Core V2 S0-C9 item 5 (CB-4): a PARTIAL chargeback of an unsold late capture never resolves its case; it is reviewed here
          UNION SELECT e."disputeId" FROM dispute_loss_effect e JOIN payment_dispute_loss pl ON pl."disputeId" = e."disputeId"
            JOIN payment_late_success ls ON ls."factId" = pl."captureFactId"
           WHERE e.reason = 'late_capture_unsold' AND pl."chargebackAmount" < ls.amount) x
        JOIN payment_dispute_loss l ON l."disputeId" = x."disputeId" WHERE ${fresh('partial_chargeback', 'x."disputeId"')}`,
      (r) => ({ caseType: 'partial_chargeback', evidenceKey: r.id, paymentRequestId: r.paymentRequestId, amount: Number(r.amount), currency: r.currency, detail: 'partial_chargeback' }));
    // Core V2 S0-C10 item 7: an assisted loss reviewed as repeated (Constraint B) or above its capture's cap (Constraint A) is listed for the
    // Owner with the loss's own recorded figures, scoped by its payment request's Company; no resolution kind exists for it, so it stays open
    await run(`SELECT r."disputeId" AS id, l."paymentId", l."paymentRequestId", l."captureFactId", l."chargebackAmount" AS amount, c.currency, r.reason
        FROM recovery_review r JOIN payment_dispute_loss l ON l."disputeId" = r."disputeId" JOIN capture_loss_cap c ON c."disputeId" = r."disputeId"
        WHERE r.reason IN ('repeated_loss', 'chargeback_exceeds_capture') AND ${fresh('chargeback_loss_review', 'r."disputeId"')}`,
      (r) => ({ caseType: 'chargeback_loss_review', evidenceKey: r.id, paymentRequestId: r.paymentRequestId, paymentId: r.paymentId, captureFactId: r.captureFactId,
        amount: Number(r.amount), currency: r.currency, detail: r.reason }));
    // Core V2 S0-C9 item 6: a late capture refunded (completed) AND charged back: preserved for reconciliation, never `chargeback_returned`
    await run(`SELECT l."disputeId" AS id, l."paymentRequestId", l."chargebackAmount" AS amount, trim(l.currency) AS currency FROM payment_dispute_loss l
        WHERE l."captureBasis" = 'late_capture'
          AND EXISTS (SELECT 1 FROM refund_case r WHERE r."paymentId" = l."paymentId" AND r."captureFactId" = l."captureFactId" AND r.status = 'completed')
          AND ${fresh('chargeback_refund_overlap', 'l."disputeId"')}`,
      (r) => ({ caseType: 'chargeback_refund_overlap', evidenceKey: r.id, paymentRequestId: r.paymentRequestId, amount: Number(r.amount), currency: r.currency,
        detail: 'refund_and_chargeback' }));
    // Core V2 S0-C14 items 2, 8: every refund and chargeback overlap, on every capture basis and in any order (an assisted settling capture
    // included, DO-51; a direct write-off recorded first included, DO-50; an obligation opened first included, DO-52): decided from recorded facts
    await run(`SELECT l."disputeId" AS id, l."paymentRequestId", l."paymentId", l."captureFactId", l."chargebackAmount" AS amount, trim(l.currency) AS currency
        FROM payment_dispute_loss l WHERE billing_loss_overlap(l."disputeId") AND ${fresh('chargeback_refund_overlap', 'l."disputeId"')}`,
      (r) => ({ caseType: 'chargeback_refund_overlap', evidenceKey: r.id, paymentRequestId: r.paymentRequestId, paymentId: r.paymentId, captureFactId: r.captureFactId,
        amount: Number(r.amount), currency: r.currency, detail: 'refund_and_chargeback' }));
    await this.discoverWaiting(tally);
    await this.discoverExposure(tally);
    // recovery surpluses: owed to the Organization until resolved (R-2); the case is the Owner's visibility, the obligation's Company
    for (const r of (await this.db.query<{ id: string; amount: string; currency: string; companyId: string; platformId: string; organizationId: string }>(
      `SELECT s.id, s.amount, trim(s.currency) AS currency, o."companyId", o."platformId", s."organizationId" FROM recovery_surplus s JOIN recovery_obligation o ON o.id = s."obligationId"
        WHERE ${fresh('recovery_surplus', 's.id')}`)).rows) {
      await this.db.tx(async (q) => {
        if (await this.cases.open(q, { caseType: 'recovery_surplus', evidenceKey: r.id, amount: Number(r.amount), currency: r.currency },
          { companyId: r.companyId, platformId: r.platformId, organizationId: r.organizationId })) tally.opened++;
      });
    }
  }

  /**
   * Core V2 S0-C14 item 12 (BIL-33 M): one `chargeback_effect_waiting` case per loss whose automatic effect qualifies (an assisted capture's first
   * full loss within its cap whose purchase has no obligation; a direct purchase's committed reversal by a full settling-capture loss with no
   * write-off yet) but waits: a refund of its captured movement may still exist (a live local relay, or a fresh Payment read that does not prove
   * none can). Owner-only, never acknowledgeable; a partial, excess or repeated loss never had an effect to wait for. A clean read opens nothing:
   * the effect's own worker proceeds.
   */
  private async discoverWaiting(tally: { opened: number }): Promise<void> {
    const { rows } = await this.db.query<{ disputeId: string; paymentRequestId: string; paymentId: string; captureFactId: string | null; amount: string; currency: string }>(
      `SELECT l."disputeId", l."paymentRequestId", l."paymentId", l."captureFactId", l."chargebackAmount" AS amount, trim(l.currency) AS currency
         FROM payment_dispute_loss l JOIN dispute_loss_effect e ON e."disputeId" = l."disputeId"
        WHERE NOT billing_loss_effect_applied(l."disputeId") AND NOT billing_loss_overlap(l."disputeId")
          AND NOT EXISTS (SELECT 1 FROM reconciliation_case k WHERE k."caseType" = 'chargeback_effect_waiting' AND k."evidenceKey" = l."disputeId")
          AND ((e.reason = 'assisted_purchase_preserved'
                AND EXISTS (SELECT 1 FROM capture_loss_cap c WHERE c."disputeId" = l."disputeId" AND c."firstFull")
                AND NOT EXISTS (SELECT 1 FROM recovery_review r WHERE r."disputeId" = l."disputeId")
                AND NOT EXISTS (SELECT 1 FROM recovery_obligation o WHERE o."purchaseId" = e."purchaseId"))
            OR (e.outcome = 'reversed_purchase' AND l."captureBasis" = 'settling_capture'
                AND EXISTS (SELECT 1 FROM payment_request r JOIN subscription_purchase s ON s."paymentRequestId" = r.id AND s.purpose = 'direct_purchase'
                             WHERE r.id = l."paymentRequestId" AND l."chargebackAmount" = r.amount AND l."chargebackCurrency" = trim(r.currency))
                AND NOT EXISTS (SELECT 1 FROM financial_loss f WHERE f.kind = 'direct_chargeback_write_off' AND f."paymentId" = l."paymentId")))
        ORDER BY l."recordedAt", l."disputeId"`);
    for (const l of rows) {
      const verdict = await this.evidence.check(l.disputeId); // a fresh read, after the loss was committed, for this decision only
      if (verdict.clean) continue;
      await this.db.tx(async (q) => this.caseFor(q, { caseType: 'chargeback_effect_waiting', evidenceKey: l.disputeId, paymentRequestId: l.paymentRequestId,
        paymentId: l.paymentId, captureFactId: l.captureFactId, amount: Number(l.amount), currency: l.currency, detail: verdict.reason }, tally));
    }
  }

  /**
   * Core V2 S0-C15A items 1, 4 (BIL-33 N, DO-72): one `chargeback_refund_exposure` case per verified chargeback beside unresolved refund evidence of
   * its captured movement, whatever was acknowledged before: it comes from the facts, not from review state. The case's `detail` records what the
   * evidence proves at opening; a failed read still opens it. It moves nothing, and two workers open it once (`reconciliation_case_once`).
   */
  private async discoverExposure(tally: { opened: number }): Promise<void> {
    const { rows } = await this.db.query<{ disputeId: string; paymentRequestId: string; paymentId: string; captureFactId: string | null; amount: string; currency: string }>(
      `SELECT l."disputeId", l."paymentRequestId", l."paymentId", l."captureFactId", l."chargebackAmount" AS amount, trim(l."chargebackCurrency") AS currency
         FROM payment_dispute_loss l WHERE billing_loss_unresolved_exposure(l."disputeId")
          AND NOT EXISTS (SELECT 1 FROM reconciliation_case k WHERE k."caseType" = 'chargeback_refund_exposure' AND k."evidenceKey" = l."disputeId")
        ORDER BY l."recordedAt", l."disputeId"`);
    for (const l of rows) {
      const detail = await this.evidence.classifyExposure(l.disputeId);
      await this.db.tx(async (q) => this.caseFor(q, { caseType: 'chargeback_refund_exposure', evidenceKey: l.disputeId, paymentRequestId: l.paymentRequestId,
        paymentId: l.paymentId, captureFactId: l.captureFactId, amount: Number(l.amount), currency: l.currency, detail }, tally));
    }
  }

  /**
   * FC-6: the direct final-lost chargeback write-off, once per chargeback fact; with a completed refund of the payment, a case instead. Core V2
   * S0-C14 items 5, 6: the write-off also WAITS while a refund of the loss's captured movement may still exist (local relays, then a fresh Payment
   * read for this decision only); the database re-checks the local half (`financial_loss_refund_live`). Nothing is written while it waits.
   */
  private async recognizeChargebackLosses(tally: { opened: number; losses: number }): Promise<void> {
    const { rows } = await this.db.query<{ disputeId: string; paymentId: string; paymentRequestId: string; chargebackFactId: string; amount: string; currency: string;
      sellerId: string; organizationId: string | null; refunded: boolean }>(
      `SELECT l."disputeId", l."paymentId", l."paymentRequestId", l."chargebackFactId", l."chargebackAmount" AS amount, trim(r.currency) AS currency, i."sellerId", i."organizationId",
              EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentId" = l."paymentId" AND c.status = 'completed') AS refunded
         FROM payment_dispute_loss l JOIN payment_request r ON r.id = l."paymentRequestId" JOIN invoice i ON i.id = r."invoiceId"
        WHERE i."sellerType" = 'company' AND l."chargebackAmount" = r.amount AND l."chargebackCurrency" = trim(r.currency) AND l."captureBasis" = 'settling_capture'
          AND EXISTS (SELECT 1 FROM subscription_purchase s WHERE s."paymentRequestId" = r.id AND s.purpose = 'direct_purchase')
          AND NOT EXISTS (SELECT 1 FROM financial_loss f WHERE f.kind = 'direct_chargeback_write_off' AND f."evidenceKey" = l."chargebackFactId")
          AND NOT EXISTS (SELECT 1 FROM reconciliation_case k WHERE k."caseType" = 'chargeback_refund_overlap' AND k."evidenceKey" = l."disputeId")
          -- Core V2 S0-C10 item 4 (O-4): a write-off only for the loss whose committed effect reversed the purchase, once per capture; a loss in
          -- review never gets one, and a write-off waits for its reversal (the next pass after it)
          AND (EXISTS (SELECT 1 FROM refund_case c WHERE c."paymentId" = l."paymentId" AND c.status = 'completed')
               OR (EXISTS (SELECT 1 FROM dispute_loss_effect e WHERE e."disputeId" = l."disputeId" AND e.outcome = 'reversed_purchase')
                   AND NOT EXISTS (SELECT 1 FROM financial_loss f WHERE f.kind = 'direct_chargeback_write_off' AND f."paymentId" = l."paymentId")))`);
    for (const l of rows) {
      if (!l.refunded) {
        const verdict = await this.evidence.check(l.disputeId);
        if (!verdict.clean) {
          this.log.warn(`direct_write_off_waiting dispute=${l.disputeId} reason=${verdict.reason} — nothing recorded; the next pass decides again`);
          continue;
        }
      }
      try {
        await this.db.tx(async (q) => {
          if (l.refunded) {
            // the money was refunded AND charged back: preserved for reconciliation, never a second (or guessed) recognition
            await this.caseFor(q, { caseType: 'chargeback_refund_overlap', evidenceKey: l.disputeId, paymentRequestId: l.paymentRequestId, amount: Number(l.amount),
              currency: l.currency, detail: 'refund_and_chargeback' }, tally);
            return;
          }
          const loss = (await q.query<{ id: string }>(
            `INSERT INTO financial_loss (kind, "evidenceKey", "companyId", "organizationId", "paymentId", "disputeId", amount, currency)
             VALUES ('direct_chargeback_write_off', $1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`, // once per evidence, and once per capture (0049)
            [l.chargebackFactId, l.sellerId, l.organizationId, l.paymentId, l.disputeId, l.amount, l.currency])).rows[0];
          if (!loss) return;
          tally.losses++;
          await this.audit.record(q, 'financial_loss.recorded', {
            organizationId: l.organizationId, resource: { type: 'financial_loss', id: loss.id },
            changes: { kind: 'direct_chargeback_write_off', amount: Number(l.amount), evidence_id: l.chargebackFactId },
          }, workerContext(l.chargebackFactId));
        });
      } catch (e) {
        // a relay of the movement was recorded between the read and the insert: the database refused the write-off; it waits (V30)
        if (pgConstraint(e) !== 'financial_loss_refund_live') throw e;
        this.log.warn(`direct_write_off_waiting dispute=${l.disputeId} reason=relay_recorded_meanwhile — refused by the database; the next pass decides again`);
      }
    }
  }

  /** Every open case whose resolving evidence now exists is resolved by that evidence; nothing else resolves a case. */
  private async resolveOpen(tally: { resolved: number }): Promise<void> {
    const { rows } = await this.db.query<{ id: string; caseType: CaseType; evidenceKey: string; paymentId: string | null; captureFactId: string | null; ref: string | null; via: string | null }>(
      `SELECT c.id, c."caseType", c."evidenceKey", c."paymentId", c."captureFactId",
              CASE c."caseType"
                WHEN 'late_assisted_settlement' THEN coalesce(
                  (SELECT a.id::text FROM late_settlement_application a WHERE a."lateSettlementId" = c."evidenceKey"),
                  (SELECT r.id::text FROM refund_case r WHERE r."paymentId" = c."paymentId" AND r.status = 'completed' AND r.eligibility = 'late_assisted_settlement' LIMIT 1))
                WHEN 'recovery_surplus' THEN coalesce(
                  (SELECT 'refund' FROM recovery_surplus_refund x WHERE x."surplusId" = c."evidenceKey"),
                  (SELECT 'repaid' FROM recovery_surplus_confirmation x WHERE x."surplusId" = c."evidenceKey"))
                WHEN 'contradictory_effect' THEN coalesce(
                  (SELECT 'effect' FROM refund_case_effect e WHERE e."refundCaseId" = c."evidenceKey"),
                  (SELECT 'effect' FROM dispute_loss_effect e WHERE e."disputeId" = c."evidenceKey"))
                WHEN 'authorization_pending' THEN (SELECT 'definitive' FROM refund_authorization_relay r WHERE r.id = c."evidenceKey"
                  AND r."attemptStatus" IS NOT NULL AND r."attemptStatus" <> 'authorization_pending')
                -- Core V2 S0-C14 item 12: the effect exists, or else the completed refund of the loss's captured movement; otherwise it stays open
                WHEN 'chargeback_effect_waiting' THEN coalesce((SELECT 'effect' WHERE billing_loss_effect_applied(c."evidenceKey")),
                  billing_loss_completed_refund(c."evidenceKey")::text)
                -- Core V2 S0-C15A item 5: the completed refund of the same movement, once its overlap case exists; otherwise it stays open
                WHEN 'chargeback_refund_exposure' THEN (SELECT billing_loss_completed_refund(c."evidenceKey")::text
                  WHERE EXISTS (SELECT 1 FROM reconciliation_case k WHERE k."caseType" = 'chargeback_refund_overlap' AND k."evidenceKey" = c."evidenceKey"))
                ELSE (SELECT r.id::text FROM refund_case r WHERE r."paymentId" = c."paymentId" AND r.status = 'completed'
                  AND (c."captureFactId" IS NULL OR r."captureFactId" = c."captureFactId") LIMIT 1)
              END AS ref,
              CASE WHEN c."caseType" = 'late_assisted_settlement' AND EXISTS (SELECT 1 FROM late_settlement_application a WHERE a."lateSettlementId" = c."evidenceKey")
                THEN 'applied' END AS via
         FROM reconciliation_case c WHERE NOT EXISTS (SELECT 1 FROM reconciliation_case_resolution r WHERE r."caseId" = c.id)
          AND c."caseType" IN ('late_assisted_settlement', 'recovery_surplus', 'contradictory_effect', 'authorization_pending', 'late_success', 'unmatched_capture', 'unrouted_settlement',
            'chargeback_effect_waiting', 'chargeback_refund_exposure')`);
    for (const c of rows) {
      if (!c.ref) continue;
      const ctx = workerContext(c.evidenceKey);
      const done = await this.db.tx(async (q) => {
        switch (c.caseType) {
          case 'late_assisted_settlement':
            return c.via === 'applied' ? this.cases.resolve(q, c.id, 'late_settlement_applied', {}, ctx) : this.cases.resolve(q, c.id, 'refund_completed', { refundCaseId: c.ref! }, ctx);
          case 'recovery_surplus':
            return this.cases.resolve(q, c.id, c.ref === 'refund' ? 'surplus_refunded' : 'surplus_repaid', {}, ctx);
          case 'contradictory_effect':
            return this.cases.resolve(q, c.id, 'effect_applied', {}, ctx);
          case 'authorization_pending':
            return this.cases.resolve(q, c.id, 'authorization_resolved', {}, ctx);
          case 'chargeback_effect_waiting': // never `effect_applied` when nothing was applied (the database checks both)
            return c.ref === 'effect' ? this.cases.resolve(q, c.id, 'effect_applied', {}, ctx) : this.cases.resolve(q, c.id, 'refund_completed', { refundCaseId: c.ref! }, ctx);
          default:
            return this.cases.resolve(q, c.id, 'refund_completed', { refundCaseId: c.ref! }, ctx);
        }
      });
      if (done) tally.resolved++;
    }
  }

  /**
   * Core V2 S0-C9 item 5 (CB-4, an Owner-approved POLICY ADDITION; register BIL-33 H): the case of an UNSOLD late capture resolves as
   * `chargeback_returned` when Billing holds a verified late-capture loss of exactly that capture whose chargeback is the capture's FULL amount
   * in its currency, with no purchase from that late success and no live or completed refund case of that capture. Nothing is refunded, sold
   * or changed (the request keeps its obligation, violations and restrictions). The database re-checks every condition under the payment
   * request's lock; a refusal (a refund or an application won the race) leaves the case open. A partial chargeback never qualifies.
   */
  private async resolveChargebackReturned(tally: { resolved: number }): Promise<void> {
    const { rows } = await this.db.query<{ id: string; evidenceKey: string; disputeId: string }>(
      `SELECT c.id, c."evidenceKey", l."disputeId" FROM reconciliation_case c
         JOIN payment_dispute_loss l ON l."captureBasis" = 'late_capture' AND l."captureFactId" = c."captureFactId" AND l."paymentId" = c."paymentId"
         JOIN payment_late_success s ON s."factId" = l."captureFactId"
        WHERE c."caseType" IN ('late_assisted_settlement', 'late_success') AND c."captureFactId" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM reconciliation_case_resolution x WHERE x."caseId" = c.id)
          AND l."chargebackAmount" = s.amount AND l."chargebackCurrency" = trim(s.currency) AND l.currency = trim(s.currency)
          AND NOT EXISTS (SELECT 1 FROM subscription_purchase p WHERE p."lateSuccessId" = s."lateSuccessId")
        ORDER BY c."openedAt", c.id`);
    for (const c of rows) {
      try {
        if (await this.db.tx(async (q) => this.cases.resolve(q, c.id, 'chargeback_returned', { disputeId: c.disputeId }, workerContext(c.evidenceKey)))) {
          tally.resolved++;
          this.log.log(`reconciliation_chargeback_returned case=${c.id} dispute=${c.disputeId} — the provider returned the whole unsold capture; nothing refunded`);
        }
      } catch (e) {
        if (pgConstraint(e) !== 'reconciliation_case_resolution_evidence') throw e;
        this.log.warn(`reconciliation_chargeback_returned_refused case=${c.id} dispute=${c.disputeId} — its evidence no longer supports it (a refund or an application); kept open`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────── the Owner

  private refuseInProduction(): void {
    if (this.config.isProduction) throw notFound();
  }

  /** BIL-33: the Owner's Company's cases, keyset by id; `status` open | resolved; `type` one case type. */
  async list(owner: VerifiedRefundOwner, q: { status?: string; type?: string; after?: string; limit?: string }) {
    this.refuseInProduction();
    const limit = q.limit === undefined ? 100 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || (q.status !== undefined && !['open', 'resolved'].includes(q.status))
      || (q.type !== undefined && !(CASE_TYPES as readonly string[]).includes(q.type)) || (q.after !== undefined && !UUID.test(q.after))) throw invalid();
    const { rows } = await this.db.query<CaseRow>(
      `${CASE_SELECT} WHERE c."companyId" = $1 AND ($2::text IS NULL OR c."caseType" = $2) AND ($3::uuid IS NULL OR c.id > $3)
          AND ($4::text IS NULL OR ($4 = 'open') = (r."caseId" IS NULL)) ORDER BY c.id LIMIT $5`,
      [owner.companyId, q.type ?? null, q.after ?? null, q.status ?? null, limit]);
    const visible: CaseRow[] = [];
    for (const r of rows) if (await this.platformVisible(owner, r)) visible.push(r);
    return { items: visible.map(representCase) };
  }

  async read(owner: VerifiedRefundOwner, id: string) {
    this.refuseInProduction();
    return representCase(await this.ownedCase(owner, id));
  }

  /** R6H-2: the Owner acknowledges a REVIEW-ONLY case (a bounded reason; the evidence stays); every other type is refused. */
  async acknowledge(owner: VerifiedRefundOwner, key: string, id: string, body: Record<string, unknown>, ctx: TransitionContext) {
    this.refuseInProduction();
    for (const k of Object.keys(body)) if (k !== 'reason') throw invalid();
    if (typeof body.reason !== 'string' || !(ACKNOWLEDGEMENT_REASONS as readonly string[]).includes(body.reason)) throw invalid();
    const reason = body.reason;
    const c = await this.ownedCase(owner, id);
    try {
      return await this.acknowledgeIn(owner, key, id, reason, c, ctx);
    } catch (e) {
      // the overlap was recorded after the check: the database refused the acknowledgement (S0-C14 item 9)
      if (pgConstraint(e) === 'reconciliation_case_overlap_acknowledgement') throw billingError(409, 'reconciliation_case_in_overlap', BILLING_MESSAGES.reconciliationCaseInOverlap);
      // the evidence was recorded after the check: the database refused it too (S0-C15A item 6)
      if (pgConstraint(e) === 'reconciliation_case_exposure_acknowledgement') throw billingError(409, 'reconciliation_case_in_exposure', BILLING_MESSAGES.reconciliationCaseInExposure);
      throw e;
    }
  }

  private async acknowledgeIn(owner: VerifiedRefundOwner, key: string, id: string, reason: string, c: CaseRow, ctx: TransitionContext) {
    return this.idempotency.run(owner.userId, key, 'reconciliation_case.acknowledge', { id, reason }, async (q) => {
      if (!REVIEW_ONLY.includes(c.caseType)) throw billingError(409, 'reconciliation_case_not_acknowledgeable', BILLING_MESSAGES.reconciliationCaseNotAcknowledgeable);
      // Core V2 S0-C14 item 9: an overlap on the case's movement means money did move; the database refuses this reason too
      if (reason === 'reviewed_no_financial_effect' && (await q.query<{ o: boolean }>(`SELECT billing_case_movement_overlap($1) AS o`, [id])).rows[0]!.o) {
        throw billingError(409, 'reconciliation_case_in_overlap', BILLING_MESSAGES.reconciliationCaseInOverlap);
      }
      // Core V2 S0-C15A item 6: the database's own rule, called rather than restated
      if ((await q.query<{ r: boolean }>(`SELECT billing_acknowledgement_refused_by_exposure($1, $2) AS r`, [id, reason])).rows[0]!.r) {
        throw billingError(409, 'reconciliation_case_in_exposure', BILLING_MESSAGES.reconciliationCaseInExposure);
      }
      if (!(await this.cases.resolve(q, id, 'acknowledged', { userId: owner.userId, reason }, ctx))) {
        throw billingError(409, 'reconciliation_case_resolved', BILLING_MESSAGES.reconciliationCaseResolved);
      }
      return { status: 200, body: representCase((await q.query<CaseRow>(`${CASE_SELECT} WHERE c.id = $1`, [id])).rows[0]!) };
    });
  }

  /** BIL-34: the Owner's Company's losses, each with its append-only adjustments and its net amount (never clamped below zero by an edit). */
  async losses(owner: VerifiedRefundOwner) {
    this.refuseInProduction();
    const { rows } = await this.db.query<{ id: string; kind: string; evidenceKey: string; organizationId: string | null; paymentId: string | null; disputeId: string | null;
      obligationId: string | null; amount: string; currency: string; recordedByUserId: string | null; recordedAt: Date; adjustments: { amount: number; reason: string; recoveryPaymentId: string; recordedAt: string }[] }>(
      `SELECT f.id, f.kind, f."evidenceKey", f."organizationId", f."paymentId", f."disputeId", f."obligationId", f.amount, trim(f.currency) AS currency, f."recordedByUserId", f."recordedAt",
              coalesce((SELECT json_agg(json_build_object('amount', a.amount, 'reason', a.reason, 'recoveryPaymentId', a."recoveryPaymentId", 'recordedAt', a."recordedAt") ORDER BY a."recordedAt", a.id)
                          FROM financial_loss_adjustment a WHERE a."lossId" = f.id), '[]') AS adjustments
         FROM financial_loss f WHERE f."companyId" = $1 ORDER BY f."recordedAt", f.id`, [owner.companyId]);
    return {
      items: rows.map((f) => ({
        id: f.id, kind: f.kind, evidenceId: f.evidenceKey, organizationId: f.organizationId, paymentId: f.paymentId, disputeId: f.disputeId, obligationId: f.obligationId,
        amount: Number(f.amount), currency: f.currency, recordedBy: f.recordedByUserId ? { userId: f.recordedByUserId } : null, recordedAt: iso(f.recordedAt),
        adjustments: f.adjustments.map((a) => ({ ...a, amount: Number(a.amount) })),
        netAmount: Number(f.amount) + f.adjustments.reduce((s, a) => s + Number(a.amount), 0),
      })),
    };
  }

  /**
   * R6H-8 (BIL-34): `POST /billing/admin/recovery-obligations/:id/write-off {receiptSecret}`. The Owner of the obligation's Company (live, and its
   * Platform) recognizes the OUTSTANDING principal of an OPEN obligation as a loss, once, with Auth's dedicated `recovery_write_off` receipt
   * (factor-only step-up) bound to the Company, the obligation, its Organization, that amount and currency. Accounting only, never
   * forgiveness: the obligation stays open and T3 stays until verified recoveries reach the base; a later recovery adjusts the loss.
   */
  async writeOff(owner: VerifiedRefundOwner, obligationId: string, body: Record<string, unknown>, ctx: TransitionContext) {
    this.refuseInProduction();
    for (const k of Object.keys(body)) if (k !== 'receiptSecret') throw invalid();
    if (!UUID.test(obligationId) || typeof body.receiptSecret !== 'string' || !SECRET.test(body.receiptSecret)) throw invalid();
    const secret = body.receiptSecret;
    const o = (await this.db.query<{ id: string; organizationId: string; companyId: string; platformId: string; status: string; currency: string; outstanding: string }>(
      `SELECT id, "organizationId", "companyId", "platformId", status, trim(currency) AS currency, billing_recovery_outstanding(id) AS outstanding FROM recovery_obligation WHERE id = $1`,
      [obligationId])).rows[0];
    if (!o || o.companyId !== owner.companyId || !(await this.owners.platformAllowed(owner.bearer, o.platformId, AbortSignal.timeout(this.config.authTimeoutMs)))) throw notFound();
    const consumeRef = writeOffConsumeRef(obligationId, secret);
    const prior = await this.writtenOff(obligationId);
    if (prior) {
      if (prior.consumeRef === consumeRef) return { created: false, body: prior.body }; // the same request again: answered
      throw billingError(409, 'write_off_not_permitted', BILLING_MESSAGES.writeOffNotPermitted);
    }
    if (o.status !== 'open' || Number(o.outstanding) <= 0) throw billingError(409, 'write_off_not_permitted', BILLING_MESSAGES.writeOffNotPermitted);
    const binding: FraudHoldBinding = { operation: 'recovery_write_off', audience: 'billing-service', companyId: o.companyId, obligationId, organizationId: o.organizationId,
      amount: Number(o.outstanding), currency: o.currency };
    const consumption = await this.consume(binding, secret, consumeRef, owner);
    try {
      await this.db.tx(async (q) => {
        const loss = (await q.query<{ id: string }>(
          `INSERT INTO financial_loss (kind, "evidenceKey", "companyId", "organizationId", "obligationId", amount, currency, "recordedByUserId", "receiptId", "consumeRef")
           VALUES ('recovery_write_off', $1, $2, $3, $1, $4, $5, $6, $7, $8) RETURNING id`,
          [obligationId, o.companyId, o.organizationId, binding.amount, o.currency, owner.userId, consumption.receiptId, consumeRef])).rows[0]!;
        await this.audit.record(q, 'recovery_obligation.written_off', {
          organizationId: o.organizationId, resource: { type: 'recovery_obligation', id: obligationId }, changes: { amount: binding.amount },
        }, ctx);
        await this.audit.record(q, 'financial_loss.recorded', {
          organizationId: o.organizationId, resource: { type: 'financial_loss', id: loss.id }, changes: { kind: 'recovery_write_off', amount: binding.amount, evidence_id: obligationId },
        }, ctx);
      });
    } catch (e) {
      const c = pgConstraint(e);
      if (c === 'financial_loss_once' || c === 'financial_loss_receiptId_key' || c === 'financial_loss_consumeRef_key') {
        const again = await this.writtenOff(obligationId);
        if (again && again.consumeRef === consumeRef) return { created: false, body: again.body }; // a concurrent identical request recorded it
        throw billingError(409, 'write_off_not_permitted', BILLING_MESSAGES.writeOffNotPermitted);
      }
      // a verified recovery between the authorization and the record changed the outstanding amount: the receipt no longer matches it
      if (c === 'financial_loss_write_off') throw billingError(409, 'write_off_not_permitted', BILLING_MESSAGES.writeOffNotPermitted);
      throw e;
    }
    this.log.log(`recovery_written_off obligation=${obligationId} amount=${binding.amount}`);
    return { created: true, body: (await this.writtenOff(obligationId))!.body };
  }

  private async writtenOff(obligationId: string) {
    const f = (await this.db.query<{ id: string; amount: string; currency: string; receiptId: string; consumeRef: string; recordedByUserId: string; recordedAt: Date }>(
      `SELECT id, amount, trim(currency) AS currency, "receiptId", "consumeRef", "recordedByUserId", "recordedAt" FROM financial_loss
        WHERE kind = 'recovery_write_off' AND "evidenceKey" = $1`, [obligationId])).rows[0];
    if (!f) return null;
    const o = (await this.db.query<{ status: string }>(`SELECT status FROM recovery_obligation WHERE id = $1`, [obligationId])).rows[0]!;
    return {
      consumeRef: f.consumeRef,
      // the obligation stays as verified recoveries leave it (open until the principal reaches the base): a write-off never closes it
      body: { obligationId, lossId: f.id, amount: Number(f.amount), currency: f.currency, receiptId: f.receiptId, writtenOffBy: { userId: f.recordedByUserId },
        recordedAt: iso(f.recordedAt), obligationStatus: o.status },
    };
  }

  private async consume(binding: FraudHoldBinding, secret: string, consumeRef: string, owner: VerifiedRefundOwner): Promise<ReceiptConsumption> {
    let out;
    try {
      out = await this.receipts.consume({ secret, binding, consumeRef });
      if (out.kind === 'unresolved') {
        const found = await this.receipts.lookup({ binding, consumeRef }).catch(() => null);
        if (found) out = { kind: 'consumed' as const, consumption: found };
      }
    } catch {
      throw billingError(503, 'recovery_authorization_unavailable', BILLING_MESSAGES.recoveryAuthorizationUnavailable);
    }
    if (out.kind === 'refused' || (out.kind === 'consumed' && out.consumption.approvedByUserId !== owner.userId)) {
      throw billingError(409, 'recovery_authorization_refused', BILLING_MESSAGES.recoveryAuthorizationRefused);
    }
    if (out.kind === 'unresolved') throw billingError(503, 'recovery_authorization_unresolved', BILLING_MESSAGES.recoveryAuthorizationUnresolved);
    return out.consumption;
  }

  private async ownedCase(owner: VerifiedRefundOwner, id: string): Promise<CaseRow> {
    if (!UUID.test(id)) throw notFound();
    const c = (await this.db.query<CaseRow>(`${CASE_SELECT} WHERE c.id = $1`, [id])).rows[0];
    if (!c || c.companyId !== owner.companyId || !(await this.platformVisible(owner, c))) throw notFound();
    return c;
  }

  private async platformVisible(owner: VerifiedRefundOwner, c: CaseRow): Promise<boolean> {
    return c.platformId === null || this.owners.platformAllowed(owner.bearer, c.platformId, AbortSignal.timeout(this.config.authTimeoutMs));
  }
}

@Injectable()
export class ReconciliationWorkerService implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  /** Core V2 S0-C14 item 14: set at shutdown, so a gate opened late never starts a stopped worker. */
  private stopping = false;
  constructor(private readonly worker: ReconciliationService, private readonly gate: FinancialWorkerGate) {}
  /** Core V2 S0-C14 item 14: no pass before the financial reconciliation safety check passes (never after a mismatch); bootstrap is not blocked. */
  onApplicationBootstrap(): void {
    void this.gate.whenPassed().then(() => {
      if (!this.stopping) this.worker.start();
    });
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.worker.stop();
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.worker.stop();
  }
  async onApplicationShutdown(): Promise<void> {
    await this.worker.stop();
  }
}

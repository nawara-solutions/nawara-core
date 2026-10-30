import { Injectable } from '@nestjs/common';
import type { Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import type { TransitionContext } from '../domain/actors.js';

/** The reconciliation worker's system identity (Audit catalog: `reconciliation_case.*`, `financial_loss.recorded`). */
export const RECONCILIATION_WORKER = 'reconciliation_worker';

export const CASE_TYPES = ['late_assisted_settlement', 'recovery_surplus', 'late_success', 'unmatched_capture', 'unrouted_settlement', 'over_return',
  'refund_discrepancy', 'partial_chargeback', 'second_reversal_cause', 'contradictory_effect', 'authorization_pending', 'chargeback_refund_overlap'] as const;
export type CaseType = (typeof CASE_TYPES)[number];
/** R6H-2: the ONLY types the Owner may acknowledge: their evidence moves no money Billing could act on; every other type needs its evidence. */
export const REVIEW_ONLY: readonly CaseType[] = ['refund_discrepancy', 'partial_chargeback', 'second_reversal_cause'];
export const ACKNOWLEDGEMENT_REASONS = ['reviewed_no_financial_effect', 'provider_statement_reviewed', 'duplicate_evidence_reviewed'] as const;
export type ResolutionKind = 'refund_completed' | 'late_settlement_applied' | 'surplus_refunded' | 'surplus_repaid' | 'recovery_counted' | 'loss_recognized'
  | 'effect_applied' | 'authorization_resolved' | 'acknowledged';

export const workerContext = (id: string): TransitionContext => ({
  actor: { type: 'system', id: RECONCILIATION_WORKER }, cause: { type: 'sweep', id }, correlationId: `reconciliation:${id}`,
});

export interface CaseInput {
  caseType: CaseType;
  evidenceKey: string;
  paymentRequestId?: string | null;
  paymentId?: string | null;
  captureFactId?: string | null;
  amount?: number | null;
  currency?: string | null;
  detail?: string | null;
}

/**
 * Core V2 S6h-B (register BIL-33; the Owner's R6H-1, R6H-2). The one place reconciliation cases are opened and resolved, inside the caller's
 * transaction. Opening is deterministic per (type, evidence) and race-free (`ON CONFLICT DO NOTHING`): a concurrent or repeated sweeper opens
 * nothing twice, and the audit intent is written only by the insert that created the case. A resolution is append-only, and the DATABASE
 * refuses one its kind's evidence does not support (migration 0042).
 */
@Injectable()
export class ReconciliationCases {
  constructor(private readonly audit: BillingAudit) {}

  /** A case about one of Billing's payment requests: its Company, Platform and Organization are the invoice's own (a Company seller only). */
  async openForPayment(q: Queryable, c: CaseInput): Promise<string | null> {
    const pr = (await q.query<{ id: string; paymentId: string | null; sellerType: string; sellerId: string; organizationId: string | null; platforms: string[] | null }>(
      `SELECT pr.id, pr."paymentId", i."sellerType", i."sellerId", i."organizationId",
              (SELECT array_agg(DISTINCT p."platformId") FROM invoice_line l JOIN product p ON p.id = l."productId" WHERE l."invoiceId" = i.id) AS platforms
         FROM payment_request pr JOIN invoice i ON i.id = pr."invoiceId"
        WHERE ${c.paymentRequestId ? 'pr.id = $1' : 'pr."paymentId" = $1'}`, [c.paymentRequestId ?? c.paymentId])).rows[0];
    if (!pr || pr.sellerType !== 'company') return null; // no Company Owner exists to see it: kept as Billing's own evidence only
    const platformId = pr.platforms && pr.platforms.length === 1 ? pr.platforms[0]! : null;
    return this.open(q, { ...c, paymentRequestId: pr.id, paymentId: c.paymentId ?? pr.paymentId }, { companyId: pr.sellerId, platformId, organizationId: pr.organizationId });
  }

  async open(q: Queryable, c: CaseInput, scope: { companyId: string; platformId: string | null; organizationId: string | null }): Promise<string | null> {
    const ins = (await q.query<{ id: string }>(
      `INSERT INTO reconciliation_case ("caseType", "evidenceKey", "companyId", "platformId", "organizationId", "paymentId", "paymentRequestId", "captureFactId", amount, currency, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT ON CONSTRAINT reconciliation_case_once DO NOTHING RETURNING id`,
      [c.caseType, c.evidenceKey, scope.companyId, scope.platformId, scope.organizationId, c.paymentId ?? null, c.paymentRequestId ?? null, c.captureFactId ?? null,
        c.amount ?? null, c.amount ? c.currency : null, c.detail ?? null])).rows[0];
    if (!ins) return null;
    await this.audit.record(q, 'reconciliation_case.opened', {
      organizationId: scope.organizationId, resource: { type: 'reconciliation_case', id: ins.id },
      changes: { case_type: c.caseType, evidence_id: c.evidenceKey, ...(c.amount ? { amount: c.amount } : {}) },
    }, workerContext(c.evidenceKey));
    return ins.id;
  }

  /** Records a resolution once (a concurrent identical one is answered as already resolved); the database checks its evidence. */
  async resolve(q: Queryable, caseId: string, kind: ResolutionKind, refs: { refundCaseId?: string; lossId?: string; recoveryPaymentId?: string; userId?: string; reason?: string },
    ctx: TransitionContext): Promise<boolean> {
    const ins = (await q.query(
      `INSERT INTO reconciliation_case_resolution ("caseId", kind, "refundCaseId", "lossId", "recoveryPaymentId", "resolvedByUserId", reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT ("caseId") DO NOTHING RETURNING "caseId"`,
      [caseId, kind, refs.refundCaseId ?? null, refs.lossId ?? null, refs.recoveryPaymentId ?? null, refs.userId ?? null, refs.reason ?? null])).rows[0];
    if (!ins) return false;
    const c = (await q.query<{ organizationId: string | null }>(`SELECT "organizationId" FROM reconciliation_case WHERE id = $1`, [caseId])).rows[0]!;
    await this.audit.record(q, 'reconciliation_case.resolved', {
      organizationId: c.organizationId, resource: { type: 'reconciliation_case', id: caseId },
      changes: { resolution: kind, ...(refs.reason ? { reason: refs.reason as never } : {}) },
    }, ctx);
    return true;
  }
}

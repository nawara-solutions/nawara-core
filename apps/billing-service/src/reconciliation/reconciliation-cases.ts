import { Injectable } from '@nestjs/common';
import type { Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import type { TransitionContext } from '../domain/actors.js';

/** The reconciliation worker's system identity (Audit catalog: `reconciliation_case.*`, `financial_loss.recorded`). */
export const RECONCILIATION_WORKER = 'reconciliation_worker';

export const CASE_TYPES = ['late_assisted_settlement', 'recovery_surplus', 'late_success', 'unmatched_capture', 'unrouted_settlement', 'over_return',
  'refund_discrepancy', 'partial_chargeback', 'second_reversal_cause', 'contradictory_effect', 'authorization_pending', 'chargeback_refund_overlap',
  'capture_contradiction', // Core V2 S0-C11 item 8 (BIL-33 I): visibility only, never acknowledged, closed or resolved
  'chargeback_loss_review', // Core V2 S0-C10 item 7 (BIL-33 L): a repeated or excess assisted loss; never acknowledged, closed or resolved
  'chargeback_effect_waiting', // Core V2 S0-C14 item 12 (BIL-33 M): a loss effect waiting on a refund; resolved only by its evidence, never acknowledged
  'chargeback_refund_exposure', // Core V2 S0-C15A item 4 (BIL-33 N): a verified chargeback beside unresolved refund evidence; never acknowledged
  // Core V2 S0-C15B (BIL-33 O). INTERIM FAIL-CLOSED (B-D3): never acknowledged or resolved in this development and simulation phase, until P-2 and the FD
  // resolution decisions define the evidence that may close them; not a permanent business rule
  'refund_fact_contested', // a verified refund fact a provider observation contradicts (DO-57)
  'dispute_conflict_observed', // a preserved dispute conflict of the payment, redacted (DO-56)
  // Core V2 DO-73 (BIL-33 P). INTERIM FAIL-CLOSED, as S0-C15B's: a verified refund fact Payment could not allocate (currency_mismatch, no_authorization)
  'refund_fact_unallocated',
  // Core V2 DO-74 (BIL-33 Q). INTERIM FAIL-CLOSED, as S0-C15B's: a refund attempt's own observation contradicting a refund fact not of its payment; no figures
  'refund_observation_conflict'] as const;
export type CaseType = (typeof CASE_TYPES)[number];
/** R6H-2: the ONLY types the Owner may acknowledge: their evidence moves no money Billing could act on; every other type needs its evidence. */
export const REVIEW_ONLY: readonly CaseType[] = ['refund_discrepancy', 'partial_chargeback', 'second_reversal_cause'];
export const ACKNOWLEDGEMENT_REASONS = ['reviewed_no_financial_effect', 'provider_statement_reviewed', 'duplicate_evidence_reviewed'] as const;
export type ResolutionKind = 'refund_completed' | 'late_settlement_applied' | 'surplus_refunded' | 'surplus_repaid' | 'recovery_counted' | 'loss_recognized'
  | 'effect_applied' | 'authorization_resolved' | 'acknowledged'
  | 'chargeback_returned'; // Core V2 S0-C9 (CB-4, BIL-33 H): an unsold late capture fully charged back by the provider

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

  /**
   * Core V2 G2 (DO-75 V2 and V3; the Owner's G2 GO, package C): one append-only follow-up of an EXISTING case, for evidence Payment states after it —
   * a later observation of the same refund attempt (`refund_observation`) or a later contest of the same fact (`refund_contest`) — with one audit intent
   * (`reconciliation_case.evidence_followed_up`) when, and only when, the row is new. The case, its resolution and its opening evidence never change;
   * nothing is reopened, superseded, allocated, refunded or reversed (FDR-08 level A). The opening evidence itself, and a V3 case opened before 0057
   * (no recorded opening item), take none: nothing is written (the database refuses them too). The database checks the payment, attempt and fact.
   */
  async followUp(q: Queryable, f: { caseId: string; evidenceKind: 'refund_observation' | 'refund_contest'; evidenceRef: string; paymentId: string;
    refundAttemptId: string | null; factId: string | null; at: string | null }): Promise<boolean> {
    const opening = (await q.query<{ ref: string | null }>(
      `SELECT CASE WHEN $2 = 'refund_observation' THEN (SELECT e."observationId" FROM reconciliation_observation_evidence e WHERE e."caseId" = $1)
                   ELSE (SELECT o."evidenceRef" FROM reconciliation_case_opening_ref o WHERE o."caseId" = $1) END AS ref`, [f.caseId, f.evidenceKind])).rows[0]?.ref ?? null;
    if (opening === null || opening === f.evidenceRef) return false;
    const at = f.at !== null && !Number.isNaN(Date.parse(f.at)) ? f.at : null;
    const ins = (await q.query<{ id: string }>(
      `INSERT INTO reconciliation_case_followup ("caseId", "evidenceKind", "evidenceRef", "paymentId", "refundAttemptId", "factId", "itemObservedAt", "companyId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, '00000000-0000-0000-0000-000000000000') ON CONFLICT ON CONSTRAINT reconciliation_case_followup_once DO NOTHING RETURNING id`,
      [f.caseId, f.evidenceKind, f.evidenceRef, f.paymentId, f.refundAttemptId, f.factId, at])).rows[0];
    if (!ins) return false;
    const c = (await q.query<{ organizationId: string | null; resolved: boolean }>(
      `SELECT c."organizationId", EXISTS (SELECT 1 FROM reconciliation_case_resolution r WHERE r."caseId" = c.id) AS resolved FROM reconciliation_case c WHERE c.id = $1`,
      [f.caseId])).rows[0]!;
    await this.audit.record(q, 'reconciliation_case.evidence_followed_up', {
      organizationId: c.organizationId, resource: { type: 'reconciliation_case', id: f.caseId }, identity: ins.id,
      changes: { followup_id: ins.id, evidence_kind: f.evidenceKind, evidence_id: f.evidenceRef, after_resolution: c.resolved },
    }, workerContext(f.evidenceRef));
    return true;
  }

  /** Core V2 G2: the existing case of this type and evidence (and payment), or null — an absent case is never a reason to open or infer one. */
  async existing(q: Queryable, caseType: CaseType, evidenceKey: string, paymentId: string): Promise<string | null> {
    return (await q.query<{ id: string }>(
      `SELECT id FROM reconciliation_case WHERE "caseType" = $1 AND "evidenceKey" = $2 AND "paymentId" = $3`, [caseType, evidenceKey, paymentId])).rows[0]?.id ?? null;
  }

  /** Records a resolution once (a concurrent identical one is answered as already resolved); the database checks its evidence. */
  async resolve(q: Queryable, caseId: string, kind: ResolutionKind,
    refs: { refundCaseId?: string; lossId?: string; recoveryPaymentId?: string; disputeId?: string; userId?: string; reason?: string }, ctx: TransitionContext): Promise<boolean> {
    const ins = (await q.query(
      `INSERT INTO reconciliation_case_resolution ("caseId", kind, "refundCaseId", "lossId", "recoveryPaymentId", "disputeId", "resolvedByUserId", reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT ("caseId") DO NOTHING RETURNING "caseId"`,
      [caseId, kind, refs.refundCaseId ?? null, refs.lossId ?? null, refs.recoveryPaymentId ?? null, refs.disputeId ?? null, refs.userId ?? null, refs.reason ?? null])).rows[0];
    if (!ins) return false;
    const c = (await q.query<{ organizationId: string | null }>(`SELECT "organizationId" FROM reconciliation_case WHERE id = $1`, [caseId])).rows[0]!;
    await this.audit.record(q, 'reconciliation_case.resolved', {
      organizationId: c.organizationId, resource: { type: 'reconciliation_case', id: caseId },
      changes: { resolution: kind, ...(refs.reason ? { reason: refs.reason as never } : {}) },
    }, ctx);
    return true;
  }
}

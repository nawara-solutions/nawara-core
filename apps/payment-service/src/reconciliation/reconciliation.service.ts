import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, getRequestContext, pgConstraint, type AuthIdentity, type Queryable } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import { OWNER_COMPANY_AUTHORITY, type OwnerCompanyAuthority, type VerifiedOwner } from '../disputes/owner-company.authority.js';
import { notFound, operationNotPermitted, paymentError } from '../errors.js';
import type { EventContext } from '../events/payment-events.js';
import { PAYMENT_MESSAGES } from '../messages.js';
import { RECEIPT_AUTHORITY, type ReceiptAuthority, type ReceiptConsumption } from '../refunds/receipt-authority.js';
import { receiptDigest, type ProviderFactAssociateBinding } from '../refunds/refund.types.js';
import { UNMATCHED_FACT_AUTHORITY, type UnmatchedFactAuthority } from './unmatched-fact-authority.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
/** Q8 (R6H-9): an authorization intent this old with no definitive Auth answer is an unresolved item (fail closed; never released). */
export const AUTHORIZATION_PENDING_ITEM_AFTER_MINUTES = 15;

/**
 * Core V2 S6h (PAY-12; R6H-1, R6H-6): the reconciliation item kinds Payment exposes, each scoped through its payment. F-29 (PAY-12 G): an unmatched
 * fact has no payment, so no Company scope: it is no item kind for anyone until an approved authority and scope basis exists.
 */
export const ITEM_KINDS = [
  'fact_conflict', 'late_success', 'allocation_blocked', 'over_return', 'refund_discrepancy', 'authorization_pending', 'chargeback',
  'association', 'capture_refund_unavailable', 'capture_mismatch', 'multiple_captures', 'capture_recovery_exhausted', 'dispute_conflict',
  'dispute_conflict_presence',
  'refund_fact_contested', // Core V2 O-2 (PAY-12 M): the fact OWNER's view of its own contested refund fact (Owner and producer)
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
/** Core V2 S0-C12 items 14(f), 15 and S0-C13 Part A: `multiple_captures`, `capture_recovery_exhausted` and `dispute_conflict` are the Owner's alone; a service read never reaches them. */
const OWNER_ONLY_ITEM_KINDS: readonly ItemKind[] = ['multiple_captures', 'capture_recovery_exhausted', 'dispute_conflict'];
/**
 * Core V2 S0-C15B (B-D1): `dispute_conflict_presence` is the PRODUCER's alone: the redacted existence of one preserved dispute conflict of its own
 * payment (the observation's id, its payment and when it was observed). It never carries the reason, the notification, the dispute, a chargeback
 * reference or any figure: those stay in the Owner-only `dispute_conflict` item (S0-C13 Part A), whose id it shares so the Owner can cross-reference.
 */
const PRODUCER_ONLY_ITEM_KINDS: readonly ItemKind[] = ['dispute_conflict_presence'];
export const PRODUCER_ITEM_KINDS: readonly ItemKind[] = ITEM_KINDS.filter((k) => !OWNER_ONLY_ITEM_KINDS.includes(k));
export const OWNER_ITEM_KINDS: readonly ItemKind[] = ITEM_KINDS.filter((k) => !PRODUCER_ONLY_ITEM_KINDS.includes(k));

export type ItemScope = { kind: 'owner'; companyId: string } | { kind: 'producer'; producer: string };

export interface ReconciliationItem {
  kind: ItemKind;
  id: string;
  paymentId: string | null;
  paymentRequestId: string | null;
  producer: string | null;
  organizationId: string | null;
  purpose: string | null;
  factId: string | null;
  amount: number | null;
  currency: string | null;
  detail: Record<string, unknown>;
  at: string | null;
}

export interface AssociationRow {
  id: string; factId: string; targetType: 'payment' | 'refund_authorization'; paymentId: string; refundAuthorizationId: string | null; companyId: string;
  requestedByUserId: string; idempotencyKey: string; receiptDigest: string; status: string; refusal: string | null; receiptId: string | null;
  approvedByUserId: string | null; requestedAt: Date; associatedAt: Date | null;
}

const invalid = () => paymentError(400, 'invalid_reconciliation_request', PAYMENT_MESSAGES.invalidReconciliationRequest);
const refused = () => paymentError(409, 'provider_fact_association_refused', PAYMENT_MESSAGES.providerFactAssociationRefused);

/** Per kind: its rows (scope-filtered through the payment), keyed by `id` for keyset paging. `p` is the payment; `$1` the scope value. */
const ITEM_SQL: Record<ItemKind, string> = {
  fact_conflict: `SELECT c.id, c."paymentId", c."factId", c.amount, c.currency, c."observedAt" AS at,
      jsonb_build_object('attemptId', c."attemptId", 'refundAttemptId', c."refundAttemptId", 'source', c.source) AS detail
    FROM provider_transaction_fact_conflict c JOIN payment p ON p.id = c."paymentId"`,
  late_success: `SELECT l.id, l."paymentId", l."factId", l.amount, l.currency, l."recordedAt" AS at,
      jsonb_build_object('attemptId', l."attemptId", 'paymentStatus', l."paymentStatus", 'source', l.source) AS detail
    FROM payment_late_success l JOIN payment p ON p.id = l."paymentId"`,
  allocation_blocked: `SELECT f.id, coalesce(f."paymentId", s."paymentId") AS "paymentId", f.id AS "factId", f.amount, f.currency, b."blockedAt" AS at,
      jsonb_build_object('reason', b.reason) AS detail
    FROM refund_fact_allocation_block b JOIN provider_transaction_fact f ON f.id = b."factId"
    LEFT JOIN provider_fact_association s ON s."factId" = f.id AND s.status = 'associated'
    JOIN payment p ON p.id = coalesce(f."paymentId", s."paymentId")`,
  over_return: `SELECT r.id, r."paymentId", r."factId", r.excess AS amount, r.currency, r."allocatedAt" AS at,
      jsonb_build_object('refundAuthorizationId', r."refundAuthorizationId", 'factAmount', r.amount, 'intended', r.intended) AS detail
    FROM refund_allocation r JOIN payment p ON p.id = r."paymentId" WHERE r.excess > 0`,
  refund_discrepancy: `SELECT a.id, a."paymentId", a."succeededFactId" AS "factId", a.amount, a.currency, a."completedAt" AS at,
      jsonb_build_object('refundCaseId', a."refundCaseId") AS detail
    FROM refund_attempt a JOIN payment p ON p.id = a."paymentId" WHERE a.status = 'discrepancy'`,
  authorization_pending: `SELECT x.id, x."paymentId", NULL::uuid AS "factId", x.amount, x.currency, x.at, x.detail FROM (
      SELECT a.id, a."paymentId", a.amount, a.currency, a."requestedAt" AS at, jsonb_build_object('operation', 'refund', 'refundCaseId', a."refundCaseId") AS detail
        FROM refund_attempt a WHERE a.status = 'authorization_pending' AND a."requestedAt" < now() - make_interval(mins => ${AUTHORIZATION_PENDING_ITEM_AFTER_MINUTES})
      UNION ALL
      SELECT z.id, d."paymentId", NULL::bigint, NULL::text, z."requestedAt", jsonb_build_object('operation', 'dispute_decision', 'disputeId', z."disputeId")
        FROM payment_dispute_decision z JOIN payment_dispute d ON d.id = z."disputeId"
       WHERE z.status = 'authorization_pending' AND z."requestedAt" < now() - make_interval(mins => ${AUTHORIZATION_PENDING_ITEM_AFTER_MINUTES})
    ) x JOIN payment p ON p.id = x."paymentId"`,
  chargeback: `SELECT f.id, f."paymentId", f.id AS "factId", f.amount, f.currency, f."observedAt" AS at,
      jsonb_build_object('disputeId', f."disputeId", 'partial', f.amount < p.amount) AS detail
    FROM provider_transaction_fact f JOIN payment p ON p.id = f."paymentId" WHERE f.kind = 'chargeback'`,
  association: `SELECT s.id, s."paymentId", s."factId", f.amount, f.currency, s."associatedAt" AS at,
      jsonb_build_object('targetType', s."targetType", 'refundAuthorizationId', s."refundAuthorizationId", 'kind', f.kind) AS detail
    FROM provider_fact_association s JOIN provider_transaction_fact f ON f.id = s."factId" JOIN payment p ON p.id = s."paymentId" WHERE s.status = 'associated'`,
  // R6H-5: every verified capture the ORIGINAL-payment refund cannot return (the payment never succeeded with it, another attempt captured it,
  // the succeeded attempt has more than one capture, or it was associated later): visible exposure; its fact-specific refund route needs
  // the separate Auth contract change reported for S6h-P
  capture_refund_unavailable: `SELECT f.id, coalesce(f."paymentId", s."paymentId") AS "paymentId", f.id AS "factId", f.amount, f.currency, f."observedAt" AS at,
      jsonb_build_object('reason', CASE
        WHEN f."paymentId" IS NULL THEN 'associated_capture'
        WHEN p.status <> 'succeeded' THEN 'late_capture'
        WHEN f."attemptId" IS DISTINCT FROM p."succeededAttemptId" THEN 'other_attempt_capture'
        ELSE 'duplicate_capture' END) AS detail
    FROM provider_transaction_fact f
    LEFT JOIN provider_fact_association s ON s."factId" = f.id AND s.status = 'associated' AND s."targetType" = 'payment'
    JOIN payment p ON p.id = coalesce(f."paymentId", s."paymentId")
   WHERE f.kind = 'capture' AND (f."paymentId" IS NULL OR p.status <> 'succeeded' OR f."attemptId" IS DISTINCT FROM p."succeededAttemptId"
      OR (SELECT count(*) FROM provider_transaction_fact g WHERE g."paymentId" = p.id AND g."attemptId" = p."succeededAttemptId" AND g.kind = 'capture') > 1)`,
  // Core V2 S0-C12 items 5 and 8 (register PAY-12 I): a capture fact whose amount or currency differs from its payment and that is no late success:
  // while the payment is not final (N1; F-20), and, with an unrecognized currency, whatever its state (O-1). Read-only: it settles, finalizes,
  // reopens, refunds and grants nothing, and no Billing case reads it.
  capture_mismatch: `SELECT f.id, f."paymentId", f.id AS "factId", f.amount, f.currency, f."observedAt" AS at,
      jsonb_build_object('attemptId', f."attemptId", 'source', f.source, 'reason', CASE
        WHEN trim(f.currency) !~ '^[A-Z]{3}$' THEN 'unrecognized_currency'
        WHEN trim(f.currency) <> trim(p.currency) THEN 'currency_mismatch'
        ELSE 'amount_mismatch' END) AS detail
    FROM provider_transaction_fact f JOIN payment p ON p.id = f."paymentId"
   WHERE f.kind = 'capture' AND (f.amount <> p.amount OR trim(f.currency) <> trim(p.currency))
     AND NOT EXISTS (SELECT 1 FROM payment_late_success l WHERE l."factId" = f.id)
     AND (p.status NOT IN ('succeeded', 'failed', 'cancelled', 'expired') OR trim(f.currency) !~ '^[A-Z]{3}$')`,
  // Core V2 S0-C12 item 14(f): visibility only, derived at read: one row per capture fact of an ambiguous attempt, keyed by the fact. Nothing is stored, so a
  // replay adds no row and existing facts appear with no backfill. "Potentially equivalent" is S0-C11 item 3's derived observation, never a determination.
  multiple_captures: `SELECT f.id, f."paymentId", f.id AS "factId", f.amount, f.currency, f."observedAt" AS at,
      jsonb_build_object('attemptId', f."attemptId", 'source', f.source,
        'attemptCaptures', (SELECT count(*) FROM provider_transaction_fact g WHERE g."attemptId" = f."attemptId" AND g.kind = 'capture'),
        'contested', EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id),
        'lateSuccessId', (SELECT l.id FROM payment_late_success l WHERE l."factId" = f.id),
        'inReview', NOT EXISTS (SELECT 1 FROM payment_late_success l WHERE l."factId" = f.id),
        'potentiallyEquivalent', EXISTS (SELECT 1 FROM provider_transaction_fact g WHERE g."attemptId" = f."attemptId" AND g.kind = 'capture' AND g.id <> f.id
          AND g.amount = f.amount AND trim(g.currency) = trim(f.currency))) AS detail
    FROM provider_transaction_fact f JOIN payment p ON p.id = f."paymentId"
   WHERE f.kind = 'capture' AND EXISTS (SELECT 1 FROM provider_transaction_fact g WHERE g."attemptId" = f."attemptId" AND g.kind = 'capture' AND g.id <> f.id)`,
  // Core V2 S0-C12 item 15: a fact the recovery pass stopped retrying, until a late success names it: the fact is kept, and this is its visibility
  capture_recovery_exhausted: `SELECT f.id, f."paymentId", f.id AS "factId", f.amount, f.currency, s."endedAt" AS at,
      jsonb_build_object('attemptId', f."attemptId", 'status', s.status, 'attempts', s.attempts, 'lastFailure', s."lastFailure", 'firstFailedAt', s."firstFailedAt") AS detail
    FROM capture_recovery_state s JOIN provider_transaction_fact f ON f.id = s."factId" JOIN payment p ON p.id = f."paymentId"
   WHERE s.status <> 'active' AND NOT EXISTS (SELECT 1 FROM payment_late_success l WHERE l."factId" = f.id)`,
  // Core V2 S0-C13 Part A: exactly the rows the exposure's `conflicts` counts, the notification's own values. A dispute of another payment, possibly another
  // Company's, is never named. No resolution or status: being listed never means the exposure cleared. Never the raw body, headers or signature.
  dispute_conflict: `SELECT o.id, o."paymentId", NULL::uuid AS "factId", o.amount, o.currency, o."observedAt" AS at,
      jsonb_build_object('reason', o.reason, 'notificationKind', o.kind, 'attemptId', o."attemptId", 'providerDisputeId', o."providerDisputeId",
        'disputeId', (SELECT d.id FROM payment_dispute d WHERE d.id = o."disputeId" AND d."paymentId" = o."paymentId"),
        'chargeback', CASE WHEN o."chargebackTxnId" IS NULL THEN NULL ELSE jsonb_build_object('reference', o."chargebackTxnId", 'amount', o."chargebackAmount", 'currency', trim(o."chargebackCurrency")) END,
        'providerOccurredAt', o."providerOccurredAt") AS detail
    FROM payment_dispute_observation o JOIN payment p ON p.id = o."paymentId" WHERE o.disposition = 'conflict'`,
  // Core V2 O-2 (PAY-12 M; the Owner's O2-a, 2026-11-11): the FACT OWNER's view of its own verified refund fact that at least one provider observation
  // contradicts (any observer: this payment's own attempt, another payment's, possibly another Company's). One row per fact (EXISTS, never a join), keyed by
  // the fact: monotonic (facts and observations are append-only) and derived at read, so a contest of an old fact appears with no backfill. Ownership is
  // ONLY the fact's own `paymentId` and its own refund attempt: never a provider reference, never an association (an unmatched or associated fact has no
  // owner here while F-29 is locked). It carries ONLY the owner's own fact, figures, attempt and observedAt: no observation, observer, count, observation
  // time or provider reference. The one bit it discloses is that the owner's own fact is contested. Read-only: it allocates, associates or resolves nothing.
  refund_fact_contested: `SELECT f.id, f."paymentId", f.id AS "factId", f.amount, f.currency, f."observedAt" AS at,
      jsonb_build_object('refundAttemptId', f."refundAttemptId") AS detail
    FROM provider_transaction_fact f JOIN payment p ON p.id = f."paymentId"
   WHERE f.kind = 'refund' AND f."paymentId" IS NOT NULL AND f."refundAttemptId" IS NOT NULL
     AND EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id)`,
  // Core V2 S0-C15B (B-D1): the same rows as `dispute_conflict`, REDACTED for the producer: identity, payment and time only; no figure, no detail
  dispute_conflict_presence: `SELECT o.id, o."paymentId", NULL::uuid AS "factId", NULL::bigint AS amount, NULL::text AS currency, o."observedAt" AS at, '{}'::jsonb AS detail
    FROM payment_dispute_observation o JOIN payment p ON p.id = o."paymentId" WHERE o.disposition = 'conflict'`,
};

/**
 * Core V2 S6h-P (register PAY-12, PAY-13; S0 FC-1, FC-2, FC-5; the Owner's R6H-1, R6H-3, R6H-6, R6H-9, R6H-12). DEVELOPMENT AND SIMULATION ONLY.
 * - Items: Payment's own durable evidence that needs reconciliation, read-only, never derived into a new fact: contradicting observations, late successes, blocked allocations, over-returns, discrepancies,
 *   authorization intents still pending without a definitive Auth answer (Q8: fail closed, never released), chargebacks, associations and the
 *   captures no original-payment refund can return. Scoped through the payment: the Owner's Company, or the producer's own payments.
 * - Balances (FC-5): signed sums of verified facts per currency, never clamped; pending and unresolved movements kept apart.
 * - Association (PAY-13): the Owner of the destination's seller Company, an Auth `provider_fact_associate` receipt consumed once under the
 *   association's id, the database's own re-check of the fact and the destination. Append-only; the fact never changes.
 *   F-29 (PAY-13 H): refused for every Owner until an approved authority establishes whose money the fact is (`UnmatchedFactAuthority`).
 */
@Injectable()
export class ReconciliationService {
  private readonly log = new Logger('PaymentReconciliation');

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
    @Inject(PaymentAudit) private readonly audit: PaymentAudit,
    @Inject(OWNER_COMPANY_AUTHORITY) private readonly owners: OwnerCompanyAuthority,
    @Inject(RECEIPT_AUTHORITY) private readonly receipts: ReceiptAuthority,
    @Inject(UNMATCHED_FACT_AUTHORITY) private readonly unmatchedFacts: UnmatchedFactAuthority,
  ) {}

  /** The live Owner, and THEIR Company (Auth's answer for their own bearer, never a request value). */
  async owner(bearer: string, identity: AuthIdentity): Promise<VerifiedOwner> {
    if (identity.adminTier !== 'owner') throw operationNotPermitted();
    const o = await this.owners.owner(bearer, AbortSignal.timeout(this.config.authTimeoutMs));
    if (!o || o.userId !== identity.id.toLowerCase()) throw operationNotPermitted();
    return o;
  }

  /** One kind's items for a scope, by id (keyset). */
  async items(scope: ItemScope, kind: string, after: string | undefined, limit: number): Promise<ReconciliationItem[]> {
    if (!(ITEM_KINDS as readonly string[]).includes(kind) || (after !== undefined && !UUID.test(after)) || !Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid();
    if (scope.kind === 'producer' && !PRODUCER_ITEM_KINDS.includes(kind as ItemKind)) throw invalid(); // the same answer as a kind that does not exist
    if (scope.kind === 'owner' && !OWNER_ITEM_KINDS.includes(kind as ItemKind)) throw invalid(); // S0-C15B: the redacted producer item is no Owner kind
    const base = ITEM_SQL[kind as ItemKind];
    const scopeSql = scope.kind === 'owner' ? `p."sellerType" = 'company' AND p."sellerId" = $1` : `p.producer = $1`;
    const { rows } = await this.db.query<Record<string, any>>(
      `SELECT i.*, p."paymentRequestId", p.producer, p."organizationId", p.purpose FROM (${base}) i JOIN payment p ON p.id = i."paymentId"
        WHERE ${scopeSql} AND ($2::uuid IS NULL OR i.id > $2::uuid) ORDER BY i.id LIMIT $3`,
      [scope.kind === 'owner' ? scope.companyId : scope.producer, after ?? null, limit],
    );
    return rows.map((r) => ({
      kind: kind as ItemKind, id: r.id, paymentId: r.paymentId, paymentRequestId: r.paymentRequestId, producer: r.producer, organizationId: r.organizationId,
      purpose: r.purpose, factId: r.factId ?? null, amount: r.amount === null ? null : Number(r.amount), currency: r.currency ? String(r.currency).trim() : null,
      detail: r.detail ?? {}, at: iso(r.at),
    }));
  }

  /**
   * FC-5 (R6H-12): one payment's signed balance per currency, from verified facts only (its own, and those associated with it): captured,
   * refundedNet, chargebackNet and `netRetained = captured - refundedNet - chargebackNet`, which may be negative and is never clamped. In-flight
   * refund attempts and unresolved evidence are reported apart, never netted in.
   */
  async paymentBalance(owner: VerifiedOwner, paymentId: string) {
    if (!UUID.test(paymentId)) throw notFound();
    const p = (await this.db.query<{ id: string; currency: string; amount: string; status: string }>(
      `SELECT id, currency, amount, status FROM payment WHERE id = $1 AND "sellerType" = 'company' AND "sellerId" = $2`, [paymentId, owner.companyId])).rows[0];
    if (!p) throw notFound();
    const [currencies, pending, unresolved] = await Promise.all([
      this.db.query(`${BALANCE_FACTS} WHERE x."paymentId" = $1 GROUP BY x.currency ORDER BY x.currency`, [p.id]).then((r) => r.rows.map(balanceRow)),
      this.db.query(`SELECT trim(currency) AS currency, sum(amount)::bigint AS amount, count(*)::int AS attempts FROM refund_attempt
                      WHERE "paymentId" = $1 AND status IN ('authorization_pending', 'authorized', 'dispatching', 'submitted', 'unknown') GROUP BY trim(currency) ORDER BY 1`, [p.id])
        .then((r) => r.rows.map((x) => ({ currency: x.currency, amount: Number(x.amount), attempts: x.attempts }))),
      // `conflicts` counts provider FACT conflicts (capture and refund), unchanged; Core V2 S0-C15B (B-D7): `disputeConflicts` counts preserved dispute
      // conflicts apart (a chargeback stated only there is in no balance figure above)
      this.db.query<{ conflicts: number; disputeConflicts: number; blocked: number; discrepancies: number; late: number }>(
        `SELECT (SELECT count(*) FROM provider_transaction_fact_conflict WHERE "paymentId" = $1)::int AS conflicts,
                (SELECT count(*) FROM payment_dispute_observation WHERE "paymentId" = $1 AND disposition = 'conflict')::int AS "disputeConflicts",
                (SELECT count(*) FROM refund_fact_allocation_block b JOIN provider_transaction_fact f ON f.id = b."factId" WHERE f."paymentId" = $1)::int AS blocked,
                (SELECT count(*) FROM refund_attempt WHERE "paymentId" = $1 AND status = 'discrepancy')::int AS discrepancies,
                (SELECT count(*) FROM payment_late_success WHERE "paymentId" = $1)::int AS late`, [p.id]).then((r) => r.rows[0]!),
    ]);
    return { paymentId: p.id, paymentCurrency: p.currency.trim(), paymentAmount: Number(p.amount), paymentStatus: p.status, currencies, pendingRefunds: pending, unresolved };
  }

  /** FC-5 (R6H-12): the Owner's Company's signed balances, per currency (never summed across currencies). */
  async companyBalances(owner: VerifiedOwner) {
    const { rows } = await this.db.query(
      `${BALANCE_FACTS} JOIN payment p ON p.id = x."paymentId" WHERE p."sellerType" = 'company' AND p."sellerId" = $1 GROUP BY x.currency ORDER BY x.currency`, [owner.companyId]);
    return { companyId: owner.companyId, currencies: rows.map(balanceRow) };
  }

  /**
   * PAY-13 (R6H-3): `POST /payment/admin/provider-facts/:id/associations` `{targetType, targetId, receiptSecret}` + `Idempotency-Key`. (1) the
   * durable intent (its id is the receipt's consumeRef), re-checked by the database; (2) Auth consumes the `provider_fact_associate` receipt
   * for exactly this Company, fact (kind, amount, currency) and destination; (3) the association is recorded once, by the requesting Owner.
   * Anything short of Auth's definitive answer leaves the intent pending: the same request resumes it (AUTH-03 finds a lost consumption).
   */
  async associate(owner: VerifiedOwner, factId: string, key: string | undefined, input: { targetType?: unknown; targetId?: unknown; receiptSecret?: unknown }) {
    if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) throw paymentError(400, 'idempotency_key_required', PAYMENT_MESSAGES.idempotencyKeyRequired);
    const targetId = typeof input.targetId === 'string' ? input.targetId.toLowerCase() : '';
    if (!UUID.test(factId) || (input.targetType !== 'payment' && input.targetType !== 'refund_authorization') || !UUID.test(targetId)
      || typeof input.receiptSecret !== 'string' || !SECRET.test(input.receiptSecret) || Object.keys(input).some((k) => !['targetType', 'targetId', 'receiptSecret'].includes(k))) throw invalid();
    const targetType = input.targetType;
    const secret = input.receiptSecret;
    const digest = receiptDigest(secret);
    const fact = (await this.db.query<{ id: string; kind: 'capture' | 'refund' | 'chargeback'; amount: string; currency: string; paymentId: string | null; ownCompany: boolean }>(
      `SELECT f.id, f.kind, f.amount, f.currency, f."paymentId", (p."sellerType" = 'company' AND p."sellerId" = $2) AS "ownCompany"
         FROM provider_transaction_fact f LEFT JOIN payment p ON p.id = f."paymentId" WHERE f.id = $1`, [factId, owner.companyId])).rows[0];
    if (!fact) throw notFound();
    // F-29 (PAY-13 H), before any key, intent or receipt: an unmatched fact no approved authority places in this Owner's Company, and another
    // Company's matched fact, answer exactly as an unknown id does. A receipt or a replay of this request establishes nothing and spends nothing.
    if (fact.paymentId === null ? !this.unmatchedFacts.authorizes(owner, fact) : !fact.ownCompany) throw notFound();

    // (1) the intent, or the one this key already names
    const { intent, created } = await this.db.tx(async (q) => {
      const byKey = (await q.query<AssociationRow>(`SELECT * FROM provider_fact_association WHERE "requestedByUserId" = $1 AND "idempotencyKey" = $2`, [owner.userId, key])).rows[0];
      if (byKey) {
        const sameTarget = byKey.targetType === targetType && (targetType === 'payment' ? byKey.paymentId === targetId : byKey.refundAuthorizationId === targetId);
        if (byKey.factId !== fact.id || !sameTarget) throw paymentError(422, 'idempotency_key_reused', PAYMENT_MESSAGES.idempotencyKeyReused);
        if (byKey.receiptDigest !== digest) throw paymentError(409, 'provider_fact_association_conflict', PAYMENT_MESSAGES.providerFactAssociationConflict);
        return { intent: byKey, created: false };
      }
      if (fact.paymentId !== null) throw paymentError(409, 'provider_fact_matched', PAYMENT_MESSAGES.providerFactMatched);
      const dest = await this.destination(q, owner, targetType, targetId);
      try {
        const row = (await q.query<AssociationRow>(
          `INSERT INTO provider_fact_association (id, "factId", "targetType", "paymentId", "refundAuthorizationId", "companyId", "requestedByUserId", "idempotencyKey", "receiptDigest")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
          [randomUUID(), fact.id, targetType, dest.paymentId, dest.refundAuthorizationId, owner.companyId, owner.userId, key, digest])).rows[0]!;
        return { intent: row, created: true };
      } catch (e) {
        const c = pgConstraint(e);
        if (c === 'provider_fact_association_live') throw paymentError(409, 'fact_already_associated', PAYMENT_MESSAGES.factAlreadyAssociated);
        if (c === 'provider_fact_association_match' || c === 'provider_fact_association_company' || c === 'provider_fact_association_unmatched') {
          throw paymentError(409, 'provider_fact_association_invalid', PAYMENT_MESSAGES.providerFactAssociationInvalid);
        }
        throw e;
      }
    });
    if (intent.status === 'associated') return { association: intent, created: false };
    if (intent.status !== 'authorization_pending') throw refused();

    // (2) Auth consumes the receipt for exactly this binding, under the intent's id
    const binding: ProviderFactAssociateBinding = {
      operation: 'provider_fact_associate', audience: 'payment-service', companyId: owner.companyId, factId: fact.id, kind: fact.kind, amount: Number(fact.amount),
      currency: fact.currency.trim(), targetType, targetId,
    };
    let out = await this.receipts.consume({ secret, binding, consumeRef: intent.id });
    if (out.kind === 'conflict' || out.kind === 'unresolved') {
      const found = await this.receipts.lookup({ binding, consumeRef: intent.id }); // a consumption whose answer was lost
      if (found.kind === 'consumed') out = found;
    }
    // (3) the outcome Auth's answer proves; anything else leaves the intent pending (retry the same request)
    if (out.kind === 'consumed') return { association: await this.record(intent, out.consumption, owner), created };
    if (out.kind === 'refused' || out.kind === 'expired') {
      await this.db.query(
        `UPDATE provider_fact_association SET status = $2, refusal = $3 WHERE id = $1 AND status = 'authorization_pending'`,
        [intent.id, out.kind === 'expired' ? 'authorization_expired' : 'authorization_refused', out.kind === 'expired' ? 'receipt_expired' : out.code]);
      this.log.warn(`provider_fact_association_refused association=${intent.id} fact=${fact.id} reason=${out.kind === 'expired' ? 'receipt_expired' : out.code}`);
      throw refused();
    }
    this.log.warn(`provider_fact_association_unresolved association=${intent.id} fact=${fact.id} — the same request resumes it`);
    throw paymentError(503, 'provider_fact_association_unresolved', PAYMENT_MESSAGES.providerFactAssociationUnresolved);
  }

  /** The destination of an association, the Owner's Company's only (the collapsed 404 otherwise). */
  private async destination(q: Queryable, owner: VerifiedOwner, targetType: 'payment' | 'refund_authorization', targetId: string) {
    if (targetType === 'payment') {
      const p = (await q.query<{ id: string }>(`SELECT id FROM payment WHERE id = $1 AND "sellerType" = 'company' AND "sellerId" = $2`, [targetId, owner.companyId])).rows[0];
      if (!p) throw notFound();
      return { paymentId: p.id, refundAuthorizationId: null };
    }
    const z = (await q.query<{ id: string; paymentId: string }>(
      `SELECT z.id, z."paymentId" FROM refund_authorization z JOIN payment p ON p.id = z."paymentId" WHERE z.id = $1 AND p."sellerType" = 'company' AND p."sellerId" = $2`,
      [targetId, owner.companyId])).rows[0];
    if (!z) throw notFound();
    return { paymentId: z.paymentId, refundAuthorizationId: z.id };
  }

  private async record(intent: AssociationRow, c: ReceiptConsumption, owner: VerifiedOwner): Promise<AssociationRow> {
    // the approver is Auth's issuer of the receipt: it must be the Owner who asks. Anything else is refused and KEPT: the refusal is written
    // on its own (never inside a transaction this refusal then rolls back), so the intent leaves the fact's one live slot
    if (c.approvedByUserId.toLowerCase() !== owner.userId) {
      await this.db.query(`UPDATE provider_fact_association SET status = 'authorization_refused', refusal = 'approver_mismatch' WHERE id = $1 AND status = 'authorization_pending'`, [intent.id]);
      this.log.warn(`provider_fact_association_refused association=${intent.id} fact=${intent.factId} reason=approver_mismatch`);
      throw refused();
    }
    return this.db.tx(async (q) => {
      const row = (await q.query<AssociationRow>(
        `UPDATE provider_fact_association SET status = 'associated', "receiptId" = $2, "approvedByUserId" = $3 WHERE id = $1 AND status = 'authorization_pending' RETURNING *`,
        [intent.id, c.receiptId, c.approvedByUserId])).rows[0];
      if (!row) return (await q.query<AssociationRow>(`SELECT * FROM provider_fact_association WHERE id = $1`, [intent.id])).rows[0]!; // a concurrent repeat recorded it
      const org = (await q.query<{ organizationId: string | null }>(`SELECT "organizationId" FROM payment WHERE id = $1`, [row.paymentId])).rows[0]!.organizationId;
      await this.audit.recordAssociation(q, row, org, ownerContext(owner));
      this.log.log(`provider_fact_associated association=${row.id} fact=${row.factId} target=${row.targetType}:${row.refundAuthorizationId ?? row.paymentId}`);
      return row;
    });
  }
}

/** Every verified money fact of a payment (its own, and those associated with it), signed by direction; `x` is grouped by its payment. */
const BALANCE_FACTS = `SELECT trim(x.currency) AS currency,
       coalesce(sum(x.amount) FILTER (WHERE x.kind = 'capture'), 0)::bigint AS captured,
       coalesce(sum(x.amount) FILTER (WHERE x.kind = 'refund'), 0)::bigint AS refunded,
       coalesce(sum(x.amount) FILTER (WHERE x.kind = 'chargeback'), 0)::bigint AS chargeback
  FROM (SELECT f.kind, f.amount, f.currency, f."paymentId" FROM provider_transaction_fact f WHERE f."paymentId" IS NOT NULL
        UNION ALL
        SELECT f.kind, f.amount, f.currency, s."paymentId" FROM provider_fact_association s JOIN provider_transaction_fact f ON f.id = s."factId" WHERE s.status = 'associated') x`;

function balanceRow(r: Record<string, any>) {
  const captured = Number(r.captured);
  const refundedNet = Number(r.refunded);
  const chargebackNet = Number(r.chargeback);
  return { currency: r.currency, captured, refundedNet, chargebackNet, netRetained: captured - refundedNet - chargebackNet };
}

function ownerContext(owner: VerifiedOwner): EventContext {
  return { actor: { type: 'user', id: owner.userId }, cause: { type: 'request', id: getRequestContext()?.requestId ?? null }, userKind: 'owner' };
}

function iso(d: Date | string | null | undefined): string | null {
  return d ? new Date(d).toISOString() : null;
}

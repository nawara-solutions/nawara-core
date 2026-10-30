import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import type { PaymentConfig } from '../config/payment-config.js';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import type { EventContext } from '../events/payment-events.js';
import { notFound, paymentError, type ErrorCode } from '../errors.js';
import { IdempotencyService } from '../idempotency/idempotency.service.js';
import { PAYMENT_MESSAGES } from '../messages.js';
import type { PaymentRow } from '../payments/payment.types.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import { disputeExposure } from '../disputes/dispute.types.js';
import { RECEIPT_AUTHORITY, type ReceiptAuthority, type ReceiptConsumption } from './receipt-authority.js';
import { bindingOf, receiptDigest, type RefundAttemptRow, type RefundReason } from './refund.types.js';

/** PAY-07's request, normalised (`refund-input.ts`). The secret is held in memory for this request only. */
export interface RefundRequestInput {
  refundAttemptId: string;
  refundCaseId: string;
  amount: number;
  currency: string;
  reason: RefundReason;
  legalOverride: boolean;
  receiptSecret: string;
  /** Core V2 R6H-5: present exactly for a capture-specific refund (the one verified capture fact it returns, in full) */
  captureFactId?: string;
}

/** Core V2 R6H-5: how a verified capture relates to its payment (Payment's own evidence; Billing maps it to a refund-case basis). */
export type CaptureBasis = 'settling_capture' | 'duplicate_capture' | 'other_attempt_capture' | 'late_capture' | 'associated_capture';
export interface CaptureEvidence {
  factId: string;
  paymentId: string;
  provider: string;
  providerTxnId: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  basis: CaptureBasis;
  /** the attempt the refund facts are bound to: the fact's own, or (associated fact) the payment's first attempt with its provider */
  capturedAttemptId: string | null;
  conflicted: boolean;
  /** refund state of THIS captured money: none, in progress (an attempt that may still refund it), or already refunded / evidenced */
  refund: 'none' | 'in_progress' | 'refunded';
  observedAt: Date;
}

/** A refusal made before any attempt existed (R6B-10): permanent for this refund attempt id. */
export const REFUSAL_STATUS: Record<RefusalCode, number> = {
  payment_not_refundable: 409, refund_capture_unverified: 409, refund_amount_not_full: 422, refund_dispute_open: 409, refund_in_progress: 409,
  refund_already_recorded: 409, refund_case_completed: 409, refund_capture_not_eligible: 409,
};
/** Core V2 S6c (R6C-7; FC-3, V-3): `refund_case_completed` is the frozen refusal of every new attempt once the case's refund is complete. */
export type RefusalCode = 'payment_not_refundable' | 'refund_capture_unverified' | 'refund_amount_not_full' | 'refund_dispute_open' | 'refund_in_progress'
  | 'refund_already_recorded' | 'refund_case_completed' | 'refund_capture_not_eligible';
const REFUSAL_MESSAGE: Record<RefusalCode, keyof typeof PAYMENT_MESSAGES> = {
  payment_not_refundable: 'paymentNotRefundable', refund_capture_unverified: 'refundCaptureUnverified', refund_amount_not_full: 'refundAmountNotFull',
  refund_dispute_open: 'refundDisputeOpen', refund_in_progress: 'refundInProgress', refund_already_recorded: 'refundAlreadyRecorded',
  refund_case_completed: 'refundCaseCompleted', refund_capture_not_eligible: 'refundCaptureNotEligible',
};
export const refusalError = (code: RefusalCode) => paymentError(REFUSAL_STATUS[code], code, PAYMENT_MESSAGES[REFUSAL_MESSAGE[code]]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPERATION = 'refund_attempt.create';
/** Refunds return Nawara-sold, verified purchases or non-entitlement payments (S6a R6A-1); never an Organization subscription or a recovery. */
// Core V2 S6f (R6F-5 Path A): also a recovery settlement (Billing refunds one only when it is entirely surplus owed to the Organization)
const REFUNDABLE_PURPOSES = new Set(['direct_purchase', 'assisted_settlement', 'non_entitlement', 'recovery_settlement']);

export interface RefundRequestResult {
  attempt: RefundAttemptRow;
  created: boolean;
}

/**
 * Core V2 S6b refund attempts (register PAY-07; ADR-0067 decisions 3 to 7; S0 FC-1, FC-5, FC-7, §3.7; the Owner's R6B-1 to R6B-10).
 * DEVELOPMENT AND SIMULATION ONLY: the module is never mounted in production and every method refuses there too.
 *
 * ADR-0067 decision 5, in order: (1) Payment verifies the payment and its verified capture itself (R6B-2) and commits a DURABLE intent whose
 * id is the refund attempt id Billing chose, also the receipt `consumeRef` (F-13) and the provider idempotency key, bound to the receipt by a
 * digest (R6B-9); (2) it consumes the receipt at Auth (AUTH-02) with that reference; (3) it commits `authorized` with Auth's approver and
 * answers. Provider dispatch is asynchronous (`RefundWorker`). A refusal before the intent is permanent for that id
 * (`refund_attempt_refusal`). No transaction spans a network call; lock order is the payment row, then the attempt (SDD section 12).
 *
 * R6B-9: only Auth's DEFINITIVE answers end an authorization (`receipt_invalid`, `receipt_binding_invalid` → `authorization_refused`;
 * `receipt_expired` → `authorization_expired`). Anything else leaves the intent `authorization_pending`: the caller retries with the same
 * key and the SAME receipt (any other receipt is refused), and the refund worker recovers a lost consumption through AUTH-03. A missing
 * lookup result never ends an intent, and no time margin is invented.
 */
@Injectable()
export class RefundAttemptService {
  private readonly log = new Logger('PaymentRefunds');

  constructor(
    @Inject(DbService) private readonly db: DbService,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    @Inject(IdempotencyService) private readonly idempotency: IdempotencyService,
    @Inject(PaymentAudit) private readonly audit: PaymentAudit,
    @Inject(RECEIPT_AUTHORITY) private readonly receipts: ReceiptAuthority,
  ) {}

  assertEnabled(): void {
    if (!this.config.refunds || this.config.isProduction) throw notFound();
  }

  /** PAY-07: the durable intent (or the existing one), then its authorization. */
  async request(caller: string, key: string, paymentId: string, input: RefundRequestInput, ctx: EventContext): Promise<RefundRequestResult> {
    this.assertEnabled();
    // the replay fingerprint never covers the secret (D-A2 §12); everything that binds the attempt is in it
    const { receiptSecret, ...bound } = input;
    const requestHash = IdempotencyService.requestHash(OPERATION, `/payment/payments/${paymentId}/refunds`, bound);
    const digest = receiptDigest(receiptSecret);

    const known = await this.known(this.db, caller, key, requestHash, paymentId, input);
    if (known) return { attempt: await this.authorize(known, digest, receiptSecret, ctx), created: false };

    const outcome = await this.db.tx(async (q) => {
      const { rows } = await q.query<PaymentRow>('SELECT * FROM payment WHERE id = $1 FOR UPDATE', [paymentId]);
      const payment = rows[0];
      if (!payment || payment.producer !== caller) throw notFound(); // only the payment's own producer; no relation is no existence
      // a concurrent identical request may have won the lock first
      const raced = await this.known(q, caller, key, requestHash, paymentId, input);
      if (raced) return { kind: 'existing' as const, attempt: raced };
      const verdict = input.captureFactId ? await this.verifyCapture(q, payment, input, input.captureFactId) : await this.verify(q, payment, input);
      if ('refusal' in verdict) {
        await q.query(
          `INSERT INTO refund_attempt_refusal (id, "paymentId", producer, "refundCaseId", code) VALUES ($1, $2, $3, $4, $5)`,
          [input.refundAttemptId, paymentId, caller, input.refundCaseId, verdict.refusal],
        );
        await this.reserveKey(q, caller, key, requestHash, REFUSAL_STATUS[verdict.refusal], 'refund_attempt_refusal', input.refundAttemptId);
        return { kind: 'refused' as const, code: verdict.refusal };
      }
      const { rows: inserted } = await q.query<RefundAttemptRow>(
        `INSERT INTO refund_attempt (id, "paymentId", producer, "refundCaseId", "companyId", amount, currency, reason, "legalOverride", "captureFactId",
           "capturedAttemptId", provider, "liveMode", "receiptDigest", "captureSpecific")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, false, $13, $14) RETURNING *`,
        [input.refundAttemptId, paymentId, caller, input.refundCaseId, payment.sellerId, input.amount, input.currency, input.reason, input.legalOverride,
          verdict.captureFactId, verdict.capturedAttemptId, verdict.provider, digest, input.captureFactId !== undefined],
      );
      await this.reserveKey(q, caller, key, requestHash, 201, 'refund_attempt', input.refundAttemptId);
      return { kind: 'created' as const, attempt: inserted[0]! };
    });
    if (outcome.kind === 'refused') {
      this.log.warn(`refund_attempt_refused refundAttempt=${input.refundAttemptId} payment=${paymentId} reason=${outcome.code}`);
      throw refusalError(outcome.code);
    }
    this.log.log(`refund_attempt_intent refundAttempt=${input.refundAttemptId} payment=${paymentId} case=${input.refundCaseId}`);
    return { attempt: await this.authorize(outcome.attempt, digest, receiptSecret, ctx), created: outcome.kind === 'created' };
  }

  /**
   * The attempt or refusal this request already names, or null for a new one. The Idempotency-Key first (the same key with another request
   * is 422 `idempotency_key_reused`), then the attempt id itself (its permanent key): an id already used with different content, or for a
   * refusal of another payment, is 409 `refund_attempt_conflict`; a refused id answers its refusal again.
   */
  private async known(q: Queryable, caller: string, key: string, requestHash: string, paymentId: string, input: RefundRequestInput): Promise<RefundAttemptRow | null> {
    const { rows: keys } = await q.query<{ requestHash: string }>(
      `SELECT "requestHash" FROM idempotency_key WHERE caller = $1 AND operation = $2 AND key = $3`, [`service:${caller}`, OPERATION, key]);
    if (keys[0] && keys[0].requestHash !== requestHash) throw paymentError(422, 'idempotency_key_reused', PAYMENT_MESSAGES.idempotencyKeyReused);
    const { rows: refused } = await q.query<{ paymentId: string; producer: string; refundCaseId: string; code: RefusalCode }>(
      `SELECT "paymentId", producer, "refundCaseId", code FROM refund_attempt_refusal WHERE id = $1`, [input.refundAttemptId]);
    if (refused[0]) {
      const r = refused[0];
      if (r.paymentId !== paymentId || r.producer !== caller || r.refundCaseId !== input.refundCaseId) throw attemptConflict();
      throw refusalError(r.code);
    }
    const { rows } = await q.query<RefundAttemptRow>('SELECT * FROM refund_attempt WHERE id = $1', [input.refundAttemptId]);
    const a = rows[0];
    if (!a) {
      if (keys[0]) throw attemptConflict(); // a stored key always names a row that exists (same transaction); defensive
      return null;
    }
    const same = a.paymentId === paymentId && a.producer === caller && a.refundCaseId === input.refundCaseId && Number(a.amount) === input.amount
      && a.currency.trim() === input.currency && a.reason === input.reason && a.legalOverride === input.legalOverride
      && (a.captureSpecific ? a.captureFactId : undefined) === input.captureFactId; // R6H-5: an ordinary id is never reused for a capture, nor the reverse
    if (!same) throw attemptConflict();
    return a;
  }

  private async reserveKey(q: Queryable, caller: string, key: string, requestHash: string, status: number, resourceType: string, resourceId: string): Promise<void> {
    const r = await this.idempotency.reserve(q, { caller: `service:${caller}`, operation: OPERATION, key, requestHash, responseStatus: status, resourceType, resourceId });
    if (r.replay && r.resourceId !== resourceId) throw attemptConflict();
  }

  /**
   * R6B-2, under the payment's row lock: Payment's own evidence that the payment is refundable in full, independently of Billing. Every
   * refusal here is definitive for this attempt id (recorded by the caller).
   */
  private async verify(q: Queryable, p: PaymentRow, input: RefundRequestInput): Promise<{ refusal: RefusalCode } | Verified> {
    if (p.status !== 'succeeded' || p.settledMethod !== 'gateway' || p.sellerType !== 'company' || !UUID.test(p.sellerId) || p.liveMode !== false
      || !p.purpose || !REFUNDABLE_PURPOSES.has(p.purpose) || !p.succeededAttemptId) {
      return { refusal: 'payment_not_refundable' };
    }
    // Core V2 S6c (R6C-7; FC-3, V-3): a completed refund case (or a payment already refunded in full) refuses every new attempt, forever.
    // Core V2 R6H-5: "refunded in full" is an ORDINARY completed refund of the payment; a capture-specific one counts on its own capture (below)
    const { rows: completed } = await q.query(
      `SELECT 1 FROM refund_authorization WHERE "completedAt" IS NOT NULL AND ("refundCaseId" = $1 OR ("paymentId" = $2 AND NOT "captureSpecific")) LIMIT 1`, [input.refundCaseId, p.id]);
    if (completed.length > 0) return { refusal: 'refund_case_completed' };
    // the verified original capture (S4d): exactly one fact of the succeeded attempt, for the full amount, never contradicted. A capture
    // recorded before S4d has no fact and is never reconstructed: it stays on its reconciliation path (S6h).
    const { rows: facts } = await q.query<{ id: string; provider: string; amount: string; currency: string; contested: boolean }>(
      `SELECT f.id, f.provider, f.amount, f.currency,
              EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id) AS contested
         FROM provider_transaction_fact f WHERE f."attemptId" = $1 AND f."paymentId" = $2 AND f.kind = 'capture'`,
      [p.succeededAttemptId, p.id],
    );
    if (facts.length !== 1 || facts[0]!.contested || Number(facts[0]!.amount) !== Number(p.amount) || facts[0]!.currency !== p.currency.trim()) {
      return { refusal: 'refund_capture_unverified' };
    }
    const capture = facts[0]!;
    if (await this.captureRefunded(q, capture.id, 'completed')) return { refusal: 'refund_case_completed' }; // R6H-5: refunded on its own
    // Core V2 S6e-D (R6E-4; S0 D3, FC-5), for a NEW attempt only (one in flight keeps its own state), under the payment's row lock that dispute
    // ingestion also takes: Payment's own dispute exposure. An open dispute or a chargeback leaves less than the full amount: refused. An
    // exposure Payment cannot establish (a preserved conflict, a loss without its chargeback fact) is never read as zero: the transaction is
    // abandoned (503, nothing written; not a permanent refusal of this attempt id).
    const exposure = await disputeExposure(q, p.id);
    if (exposure.state === 'unresolved') throw paymentError(503, 'refund_dispute_unavailable', PAYMENT_MESSAGES.refundDisputeUnavailable);
    if (exposure.state === 'exposed') return { refusal: 'refund_dispute_open' };
    if (input.amount !== Number(p.amount) || input.currency !== p.currency.trim()) return { refusal: 'refund_amount_not_full' }; // no partial refund (D4)
    const provider = this.providers.tryGet(capture.provider);
    if (!provider?.capabilities.refunds || !provider.refund || !provider.fetchRefundStatus) return { refusal: 'payment_not_refundable' };
    // FC-5: any refund evidence, or any attempt that may still refund, leaves nothing a full refund could admit
    // Core V2 S6h (R6H-3): including an unmatched refund fact associated with this payment (its money was returned all the same)
    // Core V2 R6H-5: scoped to THIS captured money: evidence of an ordinary attempt (always on this capture) or of any attempt on this capture;
    // a capture-specific refund of ANOTHER capture of the payment returns other money and never blocks the sale's ordinary refund
    if (await this.captureRefunded(q, capture.id, 'evidence')) return { refusal: 'refund_already_recorded' };
    const { rows: live } = await q.query(
      `SELECT 1 FROM refund_attempt WHERE (("paymentId" = $1 AND NOT "captureSpecific") OR "captureFactId" = $2)
          AND status NOT IN ('authorization_expired', 'authorization_refused', 'failed') LIMIT 1`, [p.id, capture.id]);
    if (live.length > 0) return { refusal: 'refund_in_progress' };
    return { captureFactId: capture.id, provider: capture.provider, capturedAttemptId: p.succeededAttemptId };
  }

  /**
   * Core V2 R6H-5 (the Owner's decision, 2026-10-30), under the payment's row lock: Payment's own evidence that ONE verified capture of this
   * payment (matched, or an unmatched fact associated with it, S6h-P) may be refunded in full on its own. Billing decides the business basis
   * (a late, duplicate or unrouted capture); Payment decides the money: the capture is verified and uncontested, the amount and currency are the
   * capture's own, no refund of THIS captured money exists or is in flight, the payment's dispute exposure is clear, and a second capture of
   * the settling attempt is refunded only while another capture of that attempt stays unrefunded (the sale's money).
   */
  private async verifyCapture(q: Queryable, p: PaymentRow, input: RefundRequestInput, factId: string): Promise<{ refusal: RefusalCode } | Verified> {
    if (!['succeeded', 'failed', 'expired', 'cancelled'].includes(p.status) || p.sellerType !== 'company' || !UUID.test(p.sellerId) || p.liveMode !== false
      || !p.purpose || !REFUNDABLE_PURPOSES.has(p.purpose)) {
      return { refusal: 'payment_not_refundable' };
    }
    const { rows: completed } = await q.query(
      `SELECT 1 FROM refund_authorization WHERE "completedAt" IS NOT NULL AND ("refundCaseId" = $1 OR "captureFactId" = $2) LIMIT 1`, [input.refundCaseId, factId]);
    if (completed.length > 0) return { refusal: 'refund_case_completed' };
    const c = await this.captureEvidence(q, p, factId);
    if (!c || c.conflicted || !c.capturedAttemptId) return { refusal: 'refund_capture_unverified' };
    if (c.basis === 'duplicate_capture' && !(await this.anotherCaptureRemains(q, p, factId))) return { refusal: 'refund_capture_not_eligible' };
    const exposure = await disputeExposure(q, p.id);
    if (exposure.state === 'unresolved') throw paymentError(503, 'refund_dispute_unavailable', PAYMENT_MESSAGES.refundDisputeUnavailable);
    if (exposure.state === 'exposed') return { refusal: 'refund_dispute_open' };
    if (input.amount !== c.amount || input.currency !== c.currency) return { refusal: 'refund_amount_not_full' }; // the capture, in full (D4)
    const provider = this.providers.tryGet(c.provider);
    if (!provider?.capabilities.refunds || !provider.refund || !provider.fetchRefundStatus) return { refusal: 'payment_not_refundable' };
    if (c.refund === 'refunded') return { refusal: 'refund_already_recorded' };
    if (c.refund === 'in_progress') return { refusal: 'refund_in_progress' };
    return { captureFactId: c.factId, provider: c.provider, capturedAttemptId: c.capturedAttemptId };
  }

  /** R6H-5: another capture of the settling attempt stays unrefunded (no attempt that may refund it, no refund evidence of it). */
  private async anotherCaptureRemains(q: Queryable, p: PaymentRow, factId: string): Promise<boolean> {
    const { rows } = await q.query(
      `SELECT 1 FROM provider_transaction_fact g
        WHERE g."paymentId" = $1 AND g."attemptId" = $2 AND g.kind = 'capture' AND g.id <> $3
          AND NOT EXISTS (SELECT 1 FROM refund_attempt a WHERE a."captureFactId" = g.id AND a.status NOT IN ('authorization_expired', 'authorization_refused', 'failed'))
          AND NOT refund_capture_has_evidence(g.id) LIMIT 1`, [p.id, p.succeededAttemptId, factId]);
    return rows.length > 0;
  }

  /** R6H-5: whether THIS captured money was refunded (`completed`: a completed authorization on it) or has refund evidence (`evidence`). */
  private async captureRefunded(q: Queryable, factId: string, what: 'completed' | 'evidence'): Promise<boolean> {
    const sql = what === 'completed'
      ? `SELECT EXISTS (SELECT 1 FROM refund_authorization WHERE "completedAt" IS NOT NULL AND "captureFactId" = $1) AS hit`
      : `SELECT refund_capture_has_evidence($1) AS hit`;
    return (await q.query<{ hit: boolean }>(sql, [factId])).rows[0]!.hit;
  }

  /**
   * Core V2 R6H-5: one verified capture of `p`, as Payment's evidence states it, or null (not a capture of this payment: unknown, another
   * payment's, an unmatched fact not associated with it, or a refund / chargeback fact).
   */
  async captureEvidence(q: Queryable, p: PaymentRow, factId: string): Promise<CaptureEvidence | null> {
    const { rows } = await q.query<{ id: string; paymentId: string | null; attemptId: string | null; provider: string; providerTxnId: string; amount: string;
      currency: string; observedAt: Date; conflicted: boolean; associated: boolean; siblings: number }>(
      `SELECT f.id, f."paymentId", f."attemptId", f.provider, f."providerTxnId", f.amount, trim(f.currency) AS currency, f."observedAt",
              EXISTS (SELECT 1 FROM provider_transaction_fact_conflict c WHERE c."factId" = f.id) AS conflicted,
              EXISTS (SELECT 1 FROM provider_fact_association s WHERE s."factId" = f.id AND s.status = 'associated' AND s."targetType" = 'payment'
                        AND s."paymentId" = $2) AS associated,
              (SELECT count(*)::int FROM provider_transaction_fact g WHERE g."paymentId" = f."paymentId" AND g."attemptId" = f."attemptId" AND g.kind = 'capture') AS siblings
         FROM provider_transaction_fact f WHERE f.id = $1 AND f.kind = 'capture' AND f."liveMode" = false`, [factId, p.id]);
    const f = rows[0];
    if (!f || (f.paymentId !== p.id && !(f.paymentId === null && f.associated))) return null;
    let capturedAttemptId = f.attemptId;
    let basis: CaptureBasis;
    if (f.paymentId === null) {
      basis = 'associated_capture';
      capturedAttemptId = (await q.query<{ id: string }>(
        `SELECT id FROM payment_attempt WHERE "paymentId" = $1 AND provider = $2 ORDER BY "attemptNumber", id LIMIT 1`, [p.id, f.provider])).rows[0]?.id ?? null;
    } else if (p.status !== 'succeeded') basis = 'late_capture';
    else if (f.attemptId !== p.succeededAttemptId) basis = 'other_attempt_capture';
    else basis = f.siblings > 1 ? 'duplicate_capture' : 'settling_capture';
    const { rows: live } = await q.query(
      `SELECT 1 FROM refund_attempt WHERE "captureFactId" = $1 AND status NOT IN ('authorization_expired', 'authorization_refused', 'failed') LIMIT 1`, [f.id]);
    const refunded = (await this.captureRefunded(q, f.id, 'completed')) || (await this.captureRefunded(q, f.id, 'evidence'));
    // the settling capture of a succeeded payment is also returned by an ORDINARY refund of the payment
    const ordinary = basis === 'settling_capture' ? (await q.query<{ live: boolean; done: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM refund_attempt WHERE "paymentId" = $1 AND NOT "captureSpecific" AND status NOT IN ('authorization_expired', 'authorization_refused', 'failed')) AS live,
              EXISTS (SELECT 1 FROM refund_authorization WHERE "paymentId" = $1 AND NOT "captureSpecific" AND "completedAt" IS NOT NULL) AS done`, [p.id])).rows[0]!
      : { live: false, done: false };
    return {
      factId: f.id, paymentId: p.id, provider: f.provider, providerTxnId: f.providerTxnId, amount: Number(f.amount), currency: f.currency, paymentStatus: p.status,
      basis, capturedAttemptId, conflicted: f.conflicted, observedAt: f.observedAt,
      refund: refunded || ordinary.done ? 'refunded' : live.length > 0 || ordinary.live ? 'in_progress' : 'none',
    };
  }

  /** Core V2 R6H-5 (Billing's capture read, `payment.read`): one verified capture of the caller's own payment; 404 for anything else. */
  async capture(caller: string, paymentId: string, factId: string): Promise<CaptureEvidence> {
    this.assertEnabled();
    const { rows } = await this.db.query<PaymentRow>('SELECT * FROM payment WHERE id = $1', [paymentId]);
    const p = rows[0];
    if (!p || p.producer !== caller) throw notFound();
    const c = await this.captureEvidence(this.db, p, factId);
    if (!c) throw paymentError(404, 'capture_not_found', PAYMENT_MESSAGES.captureNotFound);
    return c;
  }

  /**
   * Steps (2) and (3) for an intent still `authorization_pending`, with the receipt presented now (the same receipt only); any later state is
   * returned as it is. Auth's answer decides: see the class comment.
   */
  private async authorize(a: RefundAttemptRow, digest: string, secret: string, ctx: EventContext): Promise<RefundAttemptRow> {
    if (a.status !== 'authorization_pending') return this.answer(a);
    if (a.receiptDigest !== digest) throw attemptConflict(); // never another receipt for this attempt (R6B-9)
    const binding = bindingOf(a);
    const outcome = await this.receipts.consume({ secret, binding, consumeRef: a.id });
    switch (outcome.kind) {
      case 'consumed':
        return this.answer(await this.commitAuthorized(a.id, outcome.consumption, ctx));
      case 'refused':
        return this.answer(await this.commitUnauthorized(a.id, 'authorization_refused', outcome.code));
      case 'expired':
        return this.answer(await this.commitUnauthorized(a.id, 'authorization_expired', 'receipt_expired'));
      default: {
        // `conflict` or an unresolved answer: only a consumption found under THIS reference and binding authorizes; nothing else ends it
        const found = await this.receipts.lookup({ binding, consumeRef: a.id });
        if (found.kind === 'consumed') return this.answer(await this.commitAuthorized(a.id, found.consumption, ctx));
        this.log.warn(`refund_authorization_unresolved refundAttempt=${a.id} reason=${outcome.kind === 'conflict' ? 'consume_ref_conflict' : outcome.reason} lookup=${found.kind}`);
        throw paymentError(503, 'refund_authorization_unresolved', PAYMENT_MESSAGES.refundAuthorizationUnresolved);
      }
    }
  }

  /** A terminal authorization outcome is answered as the error it is, on every replay too; any other state is the attempt itself. */
  private answer(a: RefundAttemptRow): RefundAttemptRow {
    if (a.status === 'authorization_refused') throw paymentError(409, 'refund_authorization_invalid', PAYMENT_MESSAGES.refundAuthorizationInvalid);
    if (a.status === 'authorization_expired') throw paymentError(409, 'refund_authorization_expired', PAYMENT_MESSAGES.refundAuthorizationExpired);
    if (a.status === 'authorization_pending') throw paymentError(503, 'refund_authorization_unresolved', PAYMENT_MESSAGES.refundAuthorizationUnresolved);
    return a;
  }

  /**
   * Commits Auth's consumption (the authorization commit point, F-11): `authorized`, the receipt, the approver from Auth's own answer (F-16)
   * and the audit intent, in one transaction. Idempotent: an attempt already authorized by this receipt is returned as it is.
   */
  async commitAuthorized(id: string, c: ReceiptConsumption, ctx: EventContext): Promise<RefundAttemptRow> {
    return this.db.tx(async (q) => {
      const a = await this.lockAttempt(q, id);
      if (a.status === 'authorization_pending') {
        const { rows } = await q.query<RefundAttemptRow>(
          `UPDATE refund_attempt SET status = 'authorized', "receiptId" = $2, "approvedByUserId" = $3, "consumedAt" = $4, "authorizedAt" = now(), "workAfter" = NULL
            WHERE id = $1 RETURNING *`,
          [id, c.receiptId, c.approvedByUserId, c.consumedAt],
        );
        // Core V2 S6c (R6C-1): the authorization allocations are counted against, created with the consumption it records
        await q.query(
          `INSERT INTO refund_authorization ("refundAttemptId", "paymentId", "refundCaseId", producer, "receiptId", "approvedByUserId", "approvedAmount", currency,
             "captureFactId", "captureSpecific")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, a.paymentId, a.refundCaseId, a.producer, c.receiptId, c.approvedByUserId, a.amount, a.currency, a.captureFactId, a.captureSpecific],
        );
        await this.audit.recordRefund(q, 'refund_attempt.authorized', rows[0]!, await this.organizationOf(q, a.paymentId), ctx);
        this.log.log(`refund_attempt_authorized refundAttempt=${id} payment=${a.paymentId}`);
        return rows[0]!;
      }
      if (a.receiptId !== c.receiptId) {
        // Auth says this reference consumed a receipt while Payment holds another outcome: never overwritten; an operator must reconcile it
        this.log.error(`refund_authorization_inconsistent refundAttempt=${id} status=${a.status} — Auth reports a consumption Payment did not record; left as is`);
      }
      return a;
    });
  }

  private async commitUnauthorized(id: string, status: 'authorization_refused' | 'authorization_expired', code: string): Promise<RefundAttemptRow> {
    return this.db.tx(async (q) => {
      const a = await this.lockAttempt(q, id);
      if (a.status !== 'authorization_pending') return a;
      const { rows } = await q.query<RefundAttemptRow>(
        `UPDATE refund_attempt SET status = $2, "authorizationRefusal" = $3, "completedAt" = now(), "workAfter" = NULL WHERE id = $1 RETURNING *`, [id, status, code]);
      this.log.warn(`refund_attempt_not_authorized refundAttempt=${id} status=${status} reason=${code}`);
      return rows[0]!;
    });
  }

  /** Lock order: the payment row, then the attempt (SDD section 12). */
  async lockAttempt(q: Queryable, id: string): Promise<RefundAttemptRow> {
    const { rows: u } = await q.query<{ paymentId: string }>('SELECT "paymentId" FROM refund_attempt WHERE id = $1', [id]);
    if (!u[0]) throw notFound();
    await q.query('SELECT 1 FROM payment WHERE id = $1 FOR UPDATE', [u[0].paymentId]);
    const { rows } = await q.query<RefundAttemptRow>('SELECT * FROM refund_attempt WHERE id = $1 FOR UPDATE', [id]);
    return rows[0]!;
  }

  async organizationOf(q: Queryable, paymentId: string): Promise<string | null> {
    const { rows } = await q.query<{ organizationId: string | null }>('SELECT "organizationId" FROM payment WHERE id = $1', [paymentId]);
    return rows[0]?.organizationId ?? null;
  }

  /** PAY-08: the attempts (and, for the producer, the refusals) of one payment, oldest first. */
  async listForPayment(paymentId: string, includeRefusals: boolean) {
    this.assertEnabled();
    const { rows: attempts } = await this.db.query<RefundAttemptRow>(`SELECT * FROM refund_attempt WHERE "paymentId" = $1 ORDER BY "requestedAt", id`, [paymentId]);
    const refusals = includeRefusals
      ? (await this.db.query<{ id: string; refundCaseId: string; code: string; refusedAt: Date }>(
          `SELECT id, "refundCaseId", code, "refusedAt" FROM refund_attempt_refusal WHERE "paymentId" = $1 ORDER BY "refusedAt", id`, [paymentId])).rows
      : null;
    // Core V2 S6c (R6C-12): the authorizations with their verified allocations; for the producer, the refund facts not (yet) allocated
    const { rows: authorizations } = await this.db.query<{ id: string; refundAttemptId: string; refundCaseId: string; approvedAmount: string; currency: string;
      allocatedIntended: string; completedAt: Date | null }>(
      `SELECT id, "refundAttemptId", "refundCaseId", "approvedAmount", currency, "allocatedIntended", "completedAt" FROM refund_authorization WHERE "paymentId" = $1 ORDER BY "createdAt", id`,
      [paymentId]);
    const { rows: allocations } = await this.db.query<{ refundAuthorizationId: string; factId: string; amount: string; currency: string; intended: string; excess: string; allocatedAt: Date }>(
      `SELECT "refundAuthorizationId", "factId", amount, currency, intended, excess, "allocatedAt" FROM refund_allocation WHERE "paymentId" = $1 ORDER BY "allocatedAt", id`, [paymentId]);
    const unallocated = includeRefusals
      ? (await this.db.query<{ factId: string; refundAttemptId: string; amount: string; currency: string; observedAt: Date; blockedReason: string | null }>(
          `SELECT f.id AS "factId", f."refundAttemptId", f.amount, f.currency, f."observedAt", b.reason AS "blockedReason"
             FROM provider_transaction_fact f LEFT JOIN refund_fact_allocation_block b ON b."factId" = f.id
            WHERE f."paymentId" = $1 AND f.kind = 'refund' AND NOT EXISTS (SELECT 1 FROM refund_allocation a WHERE a."factId" = f.id)
            ORDER BY f."observedAt", f.id`, [paymentId])).rows
      : null;
    return { attempts, refusals, authorizations, allocations, unallocated };
  }
}

/** What a verified request may insert: the capture it returns and the attempt its refund facts are bound to. */
interface Verified { captureFactId: string; provider: string; capturedAttemptId: string }

const attemptConflict = (): HttpException => paymentError(409, 'refund_attempt_conflict', PAYMENT_MESSAGES.refundAttemptConflict);

/** Typing aid for the controller's documented codes. */
export const REFUND_REQUEST_CODES: readonly ErrorCode[] = [
  'invalid_refund_request', 'payment_not_refundable', 'refund_capture_unverified', 'refund_amount_not_full', 'refund_dispute_open', 'refund_dispute_unavailable',
  'refund_in_progress', 'refund_already_recorded', 'refund_attempt_conflict', 'refund_authorization_invalid', 'refund_authorization_expired',
  'refund_authorization_unresolved', 'refund_case_completed', 'refund_capture_not_eligible',
];

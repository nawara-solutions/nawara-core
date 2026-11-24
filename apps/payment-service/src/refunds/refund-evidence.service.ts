import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import { PaymentAudit } from '../audit/payment-audit.js';
import type { EventContext } from '../events/payment-events.js';
import { notFound } from '../errors.js';
import type { RefundStatusResult } from '../providers/provider.port.js';
import { RefundAllocationService } from './refund-allocation.service.js';
import { RefundAttemptService } from './refund-attempt.service.js';
import { RefundFinalityService } from './refund-finality.service.js';
import { RefundSafetyService } from './refund-safety.service.js';
import type { RefundAttemptRow } from './refund.types.js';

/** The attempt states in which a provider outcome still applies: the refund was (or may have been) sent. */
const IN_FLIGHT = new Set(['dispatching', 'submitted', 'unknown']);

/**
 * Core V2 RLSC-1: the two uniqueness indexes that make `failed` -> `discrepancy` impossible while another attempt of the same payment (ordinary) or
 * capture (any) is effective (0017, 0022). Only THESE, raised by THAT transition, may take the exception path; any other error propagates.
 */
const ONE_EFFECTIVE_INDEXES = new Set(['refund_attempt_one_effective', 'refund_attempt_one_effective_capture']);
const isOneEffectiveCollision = (e: unknown): boolean => {
  const err = e as { code?: string; constraint?: string } | null;
  return err?.code === '23505' && typeof err.constraint === 'string' && ONE_EFFECTIVE_INDEXES.has(err.constraint);
};

/** What applying one provider status did: the attempt as it now stands, and the RLSC-1 exception the evidence was kept as (if any). */
export interface RefundEvidenceOutcome {
  attempt: RefundAttemptRow;
  failedAttemptEvidenceId: string | null;
}

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
 *   * A provider-confirmed failure of an attempt in flight is `failed` (a new attempt needs a new authorization, and, since Core V2 D-R1B, certified
 *     finality of this failure). Never for an attempt with its own verified refund fact (OD-DR1-1): both observations are kept and it stays in
 *     flight. `pending` and a missing record change nothing (R6B-4).
 *   * Core V2 RLSC-1 (0033): a `failed` attempt's own verified refund fact while ANOTHER attempt of the same payment and capture is effective
 *     cannot make it `discrepancy` (`refund_attempt_one_effective`, `refund_attempt_one_effective_capture`, both unchanged). It stays `failed` and
 *     the observation is kept once per fact as a `failed_attempt_refund_evidence` escalation with its audit intent, in this same transaction, so the
 *     notification can be acknowledged once that commits. Evidence for review: nothing is resolved, released, reversed or compensated.
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
    @Inject(RefundAllocationService) private readonly allocations: RefundAllocationService,
    @Inject(RefundSafetyService) private readonly safety: RefundSafetyService,
    @Inject(RefundFinalityService) private readonly finality: RefundFinalityService,
  ) {}

  /** The refund attempt a provider message names (its idempotency key or its provider refund reference), of THAT provider only. */
  async findByReference(providerId: string, reference: string): Promise<RefundAttemptRow | null> {
    const { rows } = await this.db.query<RefundAttemptRow>(
      `SELECT * FROM refund_attempt WHERE provider = $1 AND ("providerRefundId" = $2 OR id::text = $2)`, [providerId, reference]);
    return rows[0] ?? null;
  }

  async apply(refundAttemptId: string, status: RefundStatusResult, ctx: EventContext): Promise<RefundAttemptRow> {
    return (await this.applyWithOutcome(refundAttemptId, status, ctx)).attempt;
  }

  /** `apply`, also stating whether the evidence was kept as an RLSC-1 exception (the webhook records that as its outcome). */
  async applyWithOutcome(refundAttemptId: string, status: RefundStatusResult, ctx: EventContext): Promise<RefundEvidenceOutcome> {
    let fact: { id: string; matches: boolean } | null = null;
    if (status.kind === 'succeeded') fact = await this.recordRefundFact(refundAttemptId, status, ctx);
    const outcome = await this.applyStatus(refundAttemptId, status, fact, ctx);
    // Core V2 S6c (FC-2, R6C-6): allocation in its OWN transaction, after the fact and the attempt; a failure here never undoes either, the
    // refund worker retries the still-pending fact with backoff. RLSC-1 changes nothing here (OD-RLSC-1 open)
    if (fact) await this.allocations.allocateWithRetry(fact.id, ctx);
    return outcome;
  }

  private async applyStatus(refundAttemptId: string, status: RefundStatusResult, fact: { id: string; matches: boolean } | null, ctx: EventContext): Promise<RefundEvidenceOutcome> {
    const plain = (attempt: RefundAttemptRow): RefundEvidenceOutcome => ({ attempt, failedAttemptEvidenceId: null });
    if (status.kind === 'pending' || status.kind === 'notFound') {
      const { rows } = await this.db.query<RefundAttemptRow>('SELECT * FROM refund_attempt WHERE id = $1', [refundAttemptId]);
      if (!rows[0]) throw notFound();
      return plain(rows[0]);
    }
    return this.db.tx(async (q): Promise<RefundEvidenceOutcome> => {
      const a = await this.attempts.lockAttempt(q, refundAttemptId);
      const organizationId = await this.attempts.organizationOf(q, a.paymentId);
      if (status.kind === 'succeeded') {
        if (!fact) return plain(a); // unidentifiable evidence: refused loudly by recordRefundFact, nothing applied
        const exact = fact.matches && (a.providerRefundId === null || a.providerRefundId === status.providerRefundId);
        if (IN_FLIGHT.has(a.status) && exact) {
          const { rows } = await q.query<RefundAttemptRow>(
            `UPDATE refund_attempt SET status = 'succeeded', "succeededFactId" = $2, "providerRefundId" = COALESCE("providerRefundId", $3), "completedAt" = now(), "workAfter" = NULL
              WHERE id = $1 RETURNING *`,
            [a.id, fact.id, status.providerRefundId],
          );
          await this.audit.recordRefund(q, 'refund_attempt.succeeded', rows[0]!, organizationId, ctx);
          this.log.log(`refund_attempt_succeeded refundAttempt=${a.id} payment=${a.paymentId} fact=${fact.id}`);
          return plain(rows[0]!);
        }
        if (IN_FLIGHT.has(a.status) || a.status === 'failed') return this.decideUnexactOrFailed(q, a, fact.id, status.providerRefundId, ctx);
        if (a.status !== 'succeeded' || !exact) {
          this.log.warn(`refund_evidence_unapplied refundAttempt=${a.id} status=${a.status} fact=${fact.id} — recorded as evidence only`);
        }
        return plain(a);
      }
      // provider-confirmed failure
      // Core V2 D-R1A (the Owner's Q4): a failure reported for an attempt that already has its OWN verified refund fact contradicts that evidence. Both
      // observations are kept: the fact is never touched, and the failure is recorded once per attempt as a `failure_after_refund_evidence`
      // escalation with its audit intent, in this transaction. Core V2 D-R1B (OD-DR1-1): an attempt with its own verified fact never becomes
      // `failed`: it stays as it is (in flight, so it blocks a replacement), and the provider's success report still decides it.
      let preserved: string | null = null;
      if (IN_FLIGHT.has(a.status) || a.status === 'succeeded' || a.status === 'discrepancy' || a.status === 'failed') {
        preserved = await this.preserveFailureAfterEvidence(q, a, failureCode(status.failureCode), ctx);
      }
      if (IN_FLIGHT.has(a.status)) {
        if (preserved) return plain(a);
        await this.finality.recordIfCertified(q, a, 'provider_failed', failureCode(status.failureCode), ctx);
        const { rows } = await q.query<RefundAttemptRow>(
          `UPDATE refund_attempt SET status = 'failed', "failureCode" = $2, "completedAt" = now(), "workAfter" = NULL WHERE id = $1 RETURNING *`,
          [a.id, failureCode(status.failureCode)],
        );
        await this.audit.recordRefund(q, 'refund_attempt.failed', rows[0]!, organizationId, ctx);
        this.log.warn(`refund_attempt_failed refundAttempt=${a.id} payment=${a.paymentId} code=${rows[0]!.failureCode}`);
        return plain(rows[0]!);
      }
      if (a.status === 'succeeded' || a.status === 'discrepancy') {
        this.log.warn(`refund_failure_contradicts_evidence refundAttempt=${a.id} status=${a.status} — a failure report after verified refund evidence; nothing changed`);
      }
      return plain(a);
    });
  }

  /**
   * Core V2 D-R1A (Q4), in the caller's transaction under the payment and attempt locks: the attempt's earliest OWN verified refund fact, if any, and the
   * reported failure, kept once per attempt. Returns the escalation id (new or existing), or null when the attempt has no such fact. The database
   * re-validates the fact and the state (0036). Also used by the refund worker for a definitive dispatch refusal.
   */
  async preserveFailureAfterEvidence(q: Queryable, a: RefundAttemptRow, code: string, ctx: EventContext): Promise<string | null> {
    const { rows: own } = await q.query<{ id: string }>(
      `SELECT id FROM provider_transaction_fact WHERE kind = 'refund' AND "refundAttemptId" = $1 AND "paymentId" = $2 ORDER BY "observedAt", id LIMIT 1`, [a.id, a.paymentId]);
    if (!own[0]) return null;
    const created = await this.safety.escalate(q, { kind: 'failure_after_refund_evidence', refundAttemptId: a.id, factId: own[0].id, observedFailureCode: code }, ctx);
    const id = created ?? (await this.safety.escalationOf(q, a.id, 'failure_after_refund_evidence'));
    if (!id) throw new Error('refund_failure_after_evidence_unrecorded'); // never acknowledged without its row
    if (created) this.log.error(`refund_failure_after_refund_evidence refundAttempt=${a.id} payment=${a.paymentId} status=${a.status} fact=${own[0].id} code=${code} escalation=${id} — a provider failure contradicts verified refund evidence of this attempt; both kept for the Owner's review (D-R1 Q4)`);
    return id;
  }

  /**
   * The S6b / RLSC-1 decision for verified refund evidence that is not an in-flight attempt's exact success, in the caller's transaction under the
   * payment lock: a `failed` attempt's own fact is kept as a `failed_attempt_refund_evidence` escalation while another attempt is effective
   * (RLSC-1), otherwise the attempt becomes `discrepancy` (S6b). Shared, unchanged, by the provider's report (`applyStatus`) and, since Core V2
   * D-R3, by the refund worker for a stored fact whose decision never committed (`decideUndecidedFailedAttemptFact`).
   */
  private async decideUnexactOrFailed(q: Queryable, a: RefundAttemptRow, factId: string, providerRefundId: string, ctx: EventContext): Promise<RefundEvidenceOutcome> {
    // Core V2 RLSC-1: decided under the payment row lock (`lockAttempt`), the lock every refund attempt insert takes first
    if (a.status === 'failed') {
      const kept = await this.keepFailedAttemptEvidence(q, a, factId, ctx);
      if (kept) return { attempt: a, failedAttemptEvidenceId: kept };
      await q.query('SAVEPOINT rlsc1_failed_to_discrepancy');
    }
    let rows: RefundAttemptRow[];
    try {
      ({ rows } = await q.query<RefundAttemptRow>(
        `UPDATE refund_attempt SET status = 'discrepancy', "providerRefundId" = COALESCE("providerRefundId", $2), "completedAt" = COALESCE("completedAt", now()), "workAfter" = NULL
          WHERE id = $1 RETURNING *`,
        [a.id, providerRefundId],
      ));
    } catch (e) {
      // Core V2 RLSC-1 backstop: only the two named indexes, only for `failed` -> `discrepancy`; the savepoint undoes the failed UPDATE alone
      if (a.status !== 'failed' || !isOneEffectiveCollision(e)) throw e;
      await q.query('ROLLBACK TO SAVEPOINT rlsc1_failed_to_discrepancy');
      const kept = await this.keepFailedAttemptEvidence(q, a, factId, ctx);
      if (!kept) throw e; // not this attempt's own fact, or no competing attempt the database accepts: the original failure, unchanged
      return { attempt: a, failedAttemptEvidenceId: kept };
    }
    if (a.status === 'failed') await q.query('RELEASE SAVEPOINT rlsc1_failed_to_discrepancy');
    this.log.warn(`refund_attempt_discrepancy refundAttempt=${a.id} payment=${a.paymentId} fact=${factId} from=${a.status} — verified refund evidence that is not exactly this full refund; kept for reconciliation (S6h)`);
    return { attempt: rows[0]!, failedAttemptEvidenceId: null };
  }

  /**
   * Core V2 D-R3: the refund worker's recovery for a stored, verified, DIRECT refund fact of a `failed` attempt whose evidence decision never
   * committed (its notification's processing failed, possibly until its retries were exhausted). The SAME decision as the provider's report, from
   * the stored fact (its `providerTxnId` is the provider refund reference the report carried), under the same payment lock; then the unchanged
   * allocation. Returns whether a decision was made here. Nothing is decided when the attempt is not `failed` or the evidence already exists; a
   * failure leaves the fact pending (its lease already backed off) and is retried on a later pass.
   */
  async decideUndecidedFailedAttemptFact(factId: string, ctx: EventContext): Promise<boolean> {
    const { rows: facts } = await this.db.query<{ id: string; refundAttemptId: string; paymentId: string; providerTxnId: string }>(
      `SELECT id, "refundAttemptId", "paymentId", "providerTxnId" FROM provider_transaction_fact
        WHERE id = $1 AND kind = 'refund' AND "paymentId" IS NOT NULL AND "refundAttemptId" IS NOT NULL`, [factId]);
    const f = facts[0];
    if (!f) return false;
    const decided = await this.db.tx(async (q) => {
      const a = await this.attempts.lockAttempt(q, f.refundAttemptId);
      if (a.status !== 'failed' || a.paymentId !== f.paymentId) return false;
      if (await this.safety.failedAttemptEvidenceOf(q, f.id)) return false;
      await this.decideUnexactOrFailed(q, a, f.id, f.providerTxnId, ctx);
      return true;
    });
    if (decided) {
      this.log.warn(`refund_failed_attempt_evidence_recovered fact=${f.id} refundAttempt=${f.refundAttemptId} — the stored fact's evidence decision committed by the refund worker (D-R3)`);
      await this.allocations.allocateWithRetry(f.id, ctx);
    }
    return decided;
  }

  /**
   * Core V2 RLSC-1 (0033), in the caller's transaction under the payment lock: the `failed` attempt's OWN refund fact, while another attempt of the same
   * payment and capture is effective (exactly the rows the two `one_effective` indexes count), is kept once as a `failed_attempt_refund_evidence`
   * escalation with its audit intent; the attempt stays `failed`. A repeat finds the existing row (no second row, no second audit intent). Returns
   * null when the rule does not apply: the caller then takes the unchanged S6b path. The database re-validates everything it is given.
   */
  private async keepFailedAttemptEvidence(q: Queryable, a: RefundAttemptRow, factId: string, ctx: EventContext): Promise<string | null> {
    const existing = await this.safety.failedAttemptEvidenceOf(q, factId);
    if (existing) return existing;
    const { rows: own } = await q.query(
      `SELECT 1 FROM provider_transaction_fact WHERE id = $1 AND kind = 'refund' AND "refundAttemptId" = $2 AND "paymentId" = $3`, [factId, a.id, a.paymentId]);
    if (own.length === 0) return null;
    const { rows: competing } = await q.query<{ id: string }>(
      `SELECT c.id FROM refund_attempt c
        WHERE c.id <> $1 AND c.status NOT IN ('authorization_expired', 'authorization_refused', 'failed')
          AND ((c."paymentId" = $2 AND NOT c."captureSpecific" AND NOT $4::boolean) OR c."captureFactId" = $3)
        ORDER BY c."requestedAt", c.id LIMIT 1`,
      [a.id, a.paymentId, a.captureFactId, a.captureSpecific],
    );
    if (!competing[0]) return null;
    const id = (await this.safety.escalate(q, { kind: 'failed_attempt_refund_evidence', refundAttemptId: a.id, factId, competingAttemptId: competing[0].id }, ctx))
      ?? (await this.safety.failedAttemptEvidenceOf(q, factId));
    if (!id) throw new Error('refund_failed_attempt_evidence_unrecorded'); // never acknowledged without its row
    this.log.warn(`refund_failed_attempt_evidence refundAttempt=${a.id} payment=${a.paymentId} fact=${factId} competing=${competing[0].id} escalation=${id} — verified refund evidence of a FAILED attempt while another attempt is effective; the attempt stays failed; kept for the Owner's review (RLSC-1)`);
    return id;
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
      // Core V2 DO-76 S1: the payment's refund-dispatch lock SHARED, held to commit (0032 `refund_dispatch_lock_key`). The dispatch transition holds it
      // exclusively (`RefundWorker.startDispatch` and the 0032 guard), so this fact is either committed before that transition reads the evidence, or
      // written after `dispatching` is durable. Never a refusal: facts of one payment share it, and nothing but a dispatch transition delays it.
      await q.query('SELECT pg_advisory_xact_lock_shared(refund_dispatch_lock_key($1))', [a.paymentId]);
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
        const { rows: recorded } = await q.query<{ id: string }>(
          `INSERT INTO provider_transaction_fact_conflict ("factId", "paymentId", "attemptId", "refundAttemptId", provider, amount, currency, source, "webhookEventId")
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT ON CONSTRAINT provider_transaction_fact_conflict_once DO NOTHING RETURNING id`,
          [stored.id, a.paymentId, a.capturedAttemptId, a.id, a.provider, s.amount, s.currency, source, webhookEventId],
        );
        // Core V2 S0-C15B (B-D5): the same audit action as a capture contradiction, once per recorded observation (only the insert that created the
        // row writes it; the event id derives from the row), in this transaction. A replay of the same observation records nothing again.
        if (recorded[0]) {
          await this.audit.recordFactConflict(q, { id: recorded[0].id, factId: stored.id, paymentId: a.paymentId, attemptId: a.capturedAttemptId, refundAttemptId: a.id,
            source, amount: s.amount }, await this.attempts.organizationOf(q, a.paymentId), ctx);
        }
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

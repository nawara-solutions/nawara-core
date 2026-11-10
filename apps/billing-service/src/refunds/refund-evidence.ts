import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import { PAYMENT_REFUND_CLIENT, type AttemptStatus, type FailedAttemptEvidence, type PaymentRefundClient, type PaymentRefunds } from './payment-refund-client.js';

/**
 * Core V2 S0-C14 items 5 and 6 (register BIL-28 H, BIL-34 H): whether a verified loss's automatic effect (a recovery obligation or a direct
 * write-off) may proceed, or waits because a refund of the SAME captured movement may still exist.
 *
 * Two halves, and no lock spans them (item 6):
 *   - LOCAL: no relay of the movement may still produce a refund (the database re-checks this at the effect's own statement:
 *     `recovery_obligation_refund_live`, `financial_loss_refund_live`).
 *   - REMOTE: a Payment refunds read (PAY-08) STARTED AFTER the loss was committed in Billing and never reused across decisions shows no live
 *     attempt of the movement, no refund evidence of the movement, and no attempt Billing does not know. Anything Payment cannot answer, or
 *     answers without proof (404, a failure, a malformed answer, an answer without the producer's unallocated facts), is NOT clean: the effect
 *     waits. No timer ever resumes it.
 * What this does NOT guarantee: a refund reported by the provider after it confirmed a failure can still land after the effect commits. That
 * race cannot be prevented; it is detected (the overlap case, item 8) and nothing is undone.
 */

/** Payment's attempt states after which the attempt can no longer produce a refund, absent a later provider report (item 6 (b)). */
export const DEAD_ATTEMPT_STATUSES: readonly AttemptStatus[] = ['authorization_expired', 'authorization_refused', 'failed'];

export type RefundEvidenceReason =
  | 'relay_live' // a local relay of the movement may still produce a refund
  | 'payment_unavailable' // Payment did not answer, or answered something unparseable
  | 'payment_not_found' // Payment does not know Billing's own payment: proves nothing
  | 'unallocated_facts_unknown' // the answer does not carry the producer's unallocated refund facts
  | 'attempt_unknown_to_billing' // Payment holds an attempt (or refund evidence) Billing has no relay for
  | 'attempt_live' // an attempt of the movement is not dead at Payment
  | 'refund_evidence' // an allocation or an unallocated refund fact of the movement
  | 'refund_evidence_after_failure' // Core V2 R3: a failed attempt of the movement has credible refund evidence after its failure (a risk, never ownership)
  | 'failure_evidence_unknown'; // Core V2 R3: Payment states nothing usable about a failed attempt of the movement (absent, malformed, unknown, missing)

export type RefundEvidenceVerdict = { clean: true } | { clean: false; reason: RefundEvidenceReason };

/** One decision's evidence: the verdict and, when clean, what the effect's attestation records (Core V2 R3: when the read started, which failed relays it cleared). */
export type RefundEvidenceDecision = { clean: true; readStartedAt: Date; clearedByRead: string[] } | { clean: false; reason: RefundEvidenceReason };

/** Core V2 R3: the risk states Billing records durably as a marker. */
export const FAILURE_EVIDENCE_RISK = new Set(['unmatched_fact', 'notification_pending']);

/** Core V2 R3: the failed attempts of the loss's movement in Payment's answer (the relays an attestation must have cleared). */
export const failedOnMovement = (read: PaymentRefunds, relays: ReadonlyMap<string, boolean>): string[] =>
  read.attempts.filter((a) => a.refundAttemptId !== null && relays.get(a.refundAttemptId) === true && a.status === 'failed').map((a) => a.refundAttemptId!).sort();

/**
 * The pure judgement of one PAY-08 answer (item 6 (a)). `relays` maps every relay id Billing holds for the PAYMENT to whether its refund case
 * is on the loss's captured movement; a relay of another capture of the payment is known (so not "unknown"), and never blocks the effect.
 */
export function judgeRefundEvidence(read: PaymentRefunds | null, relays: ReadonlyMap<string, boolean>): RefundEvidenceVerdict {
  if (read === null) return { clean: false, reason: 'payment_not_found' };
  if (read.unallocatedFacts === null) return { clean: false, reason: 'unallocated_facts_unknown' };
  const onMovement = (attemptId: string | null): 'unknown' | boolean => (attemptId === null || !relays.has(attemptId) ? 'unknown' : relays.get(attemptId)!);
  for (const a of read.attempts) {
    const m = onMovement(a.refundAttemptId);
    if (m === 'unknown') return { clean: false, reason: 'attempt_unknown_to_billing' };
    if (m && !DEAD_ATTEMPT_STATUSES.includes(a.status)) return { clean: false, reason: 'attempt_live' };
  }
  for (const z of read.authorizations) {
    const m = onMovement(z.refundAttemptId);
    if (m === 'unknown') return { clean: false, reason: 'attempt_unknown_to_billing' };
    if (m && (z.allocations.length > 0 || z.completedAt !== null)) return { clean: false, reason: 'refund_evidence' };
  }
  for (const f of read.unallocatedFacts) {
    const m = onMovement(f.refundAttemptId);
    if (m === 'unknown') return { clean: false, reason: 'attempt_unknown_to_billing' };
    if (m) return { clean: false, reason: 'refund_evidence' };
  }
  // Core V2 R3: a failed attempt of the movement is dead only when Payment states `none` for it; a risk first, then anything unusable
  const failed = failedOnMovement(read, relays);
  if (failed.length > 0) {
    const evidence = Array.isArray(read.failedAttemptEvidence) ? read.failedAttemptEvidence : null;
    const stateOf = (id: string) => evidence?.find((e) => e.refundAttemptId === id)?.state;
    if (failed.some((id) => FAILURE_EVIDENCE_RISK.has(stateOf(id) ?? ''))) return { clean: false, reason: 'refund_evidence_after_failure' };
    if (failed.some((id) => stateOf(id) !== 'none')) return { clean: false, reason: 'failure_evidence_unknown' };
  }
  return { clean: true };
}

/**
 * Core V2 R3: Payment's positive risk for Billing's OWN relays of `paymentId`, as durable markers (one per relay, append-only, never cleared). Each in its own
 * transaction holding its relay FOR UPDATE, so an effect insert that share-locks the movement's relays sees it once committed. A relay Billing does not hold, or
 * whose mirror has not reached `failed` yet, is skipped (the next pass records it). Returns how many were newly recorded.
 */
export async function recordFailureEvidence(db: DbService, paymentId: string, entries: readonly FailedAttemptEvidence[] | 'malformed' | null | undefined,
  log?: Logger): Promise<number> {
  if (!Array.isArray(entries)) return 0;
  let recorded = 0;
  for (const e of entries) {
    if (!FAILURE_EVIDENCE_RISK.has(e.state)) continue;
    try {
      recorded += await db.tx(async (q: Queryable) => {
        const own = (await q.query(`SELECT 1 FROM refund_authorization_relay WHERE id = $1 AND "paymentId" = $2 FOR UPDATE`, [e.refundAttemptId, paymentId])).rows.length;
        if (!own) return 0;
        const r = await q.query(`INSERT INTO refund_relay_failure_evidence ("relayId", "paymentId", "firstState") VALUES ($1, $2, $3) ON CONFLICT ("relayId") DO NOTHING`,
          [e.refundAttemptId, paymentId, e.state]);
        return r.rowCount ?? 0;
      });
    } catch (err) {
      log?.warn(`refund_failure_evidence_unrecorded relay=${e.refundAttemptId} ${(err as { constraint?: string }).constraint ?? 'failed'} — recorded on a later pass`);
    }
  }
  return recorded;
}

/**
 * Core V2 S0-C15A item 4: what an exposure case may state about its refund evidence, recorded once at opening. `refund_money_verified` only when
 * Payment's fresh read shows a verified allocation on a relay of the loss's movement. Anything else (a discrepancy with no allocation, a
 * `refund_discrepancy` Billing holds no relay for, Payment unavailable) proves no money and stays `refund_evidence_unresolved`: the case still opens,
 * so the Owner sees it, and it claims only what is established.
 */
export type ExposureEvidenceClass = 'refund_money_verified' | 'refund_evidence_unresolved';

export function judgeExposureEvidence(read: PaymentRefunds | null, relays: ReadonlyMap<string, boolean>): ExposureEvidenceClass {
  if (read === null) return 'refund_evidence_unresolved';
  for (const z of read.authorizations) {
    if (relays.get(z.refundAttemptId) === true && z.allocations.some((a) => a.amount > 0)) return 'refund_money_verified';
  }
  return 'refund_evidence_unresolved';
}

@Injectable()
export class RefundEvidenceReader {
  private readonly log = new Logger('BillingRefundEvidence');
  constructor(
    private readonly db: DbService,
    @Inject(PAYMENT_REFUND_CLIENT) private readonly payment: PaymentRefundClient,
  ) {}

  /**
   * One decision's evidence for the loss of `disputeId`. The caller selected the loss from Billing's committed rows, so this read starts after
   * the loss was committed; its answer is used for this one decision only. The database still re-checks the local half at the effect's insert.
   */
  async check(disputeId: string): Promise<RefundEvidenceDecision> {
    const loss = (await this.db.query<{ paymentId: string; live: boolean }>(
      `SELECT l."paymentId", billing_loss_refund_live(l."disputeId") AS live FROM payment_dispute_loss l WHERE l."disputeId" = $1`, [disputeId])).rows[0];
    if (!loss) return { clean: false, reason: 'payment_not_found' };
    if (loss.live) return { clean: false, reason: 'relay_live' };
    const { rows } = await this.db.query<{ id: string; onMovement: boolean }>(
      `SELECT x.id, billing_refund_case_on_loss_movement(x."refundCaseId", $2) AS "onMovement" FROM refund_authorization_relay x WHERE x."paymentId" = $1`,
      [loss.paymentId, disputeId]);
    const relays = new Map(rows.map((r) => [r.id, r.onMovement]));
    let read: PaymentRefunds | null;
    const readStartedAt = new Date(); // Core V2 R3: the attestation's freshness (the read starts after the loss was committed: it was selected from Billing's rows)
    try {
      read = await this.payment.refunds(loss.paymentId);
    } catch {
      return { clean: false, reason: 'payment_unavailable' };
    }
    // Core V2 R3: a positive risk is recorded durably whatever this decision concludes (the reconciler records it too)
    if (read) await recordFailureEvidence(this.db, loss.paymentId, read.failedAttemptEvidence, this.log);
    const verdict = judgeRefundEvidence(read, relays);
    if (!verdict.clean) return verdict;
    // Core V2 R3: every relay of the movement that BILLING holds as failed must have been stated `none` by this read (Payment's answer may lag or omit
    // it): otherwise nothing is proven about it and the effect waits (the database's attestation guard would refuse it anyway)
    const clearedByRead = failedOnMovement(read!, relays);
    const localFailed = (await this.db.query<{ ids: string[] }>(`SELECT billing_loss_movement_failed_relays($1) AS ids`, [disputeId])).rows[0]!.ids;
    if (localFailed.some((id) => !clearedByRead.includes(id) || read!.failedAttemptEvidence === null)) return { clean: false, reason: 'failure_evidence_unknown' };
    return { clean: true, readStartedAt, clearedByRead };
  }

  /** S0-C15A item 4: the evidence class of the exposure of `disputeId`, from one fresh read. Any failure is `refund_evidence_unresolved`, never a refusal to open. */
  async classifyExposure(disputeId: string): Promise<ExposureEvidenceClass> {
    const loss = (await this.db.query<{ paymentId: string }>(`SELECT "paymentId" FROM payment_dispute_loss WHERE "disputeId" = $1`, [disputeId])).rows[0];
    if (!loss) return 'refund_evidence_unresolved';
    const { rows } = await this.db.query<{ id: string; onMovement: boolean }>(
      `SELECT x.id, billing_refund_case_on_loss_movement(x."refundCaseId", $2) AS "onMovement" FROM refund_authorization_relay x WHERE x."paymentId" = $1`,
      [loss.paymentId, disputeId]);
    try {
      return judgeExposureEvidence(await this.payment.refunds(loss.paymentId), new Map(rows.map((r) => [r.id, r.onMovement])));
    } catch {
      return 'refund_evidence_unresolved';
    }
  }
}

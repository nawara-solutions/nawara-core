import { Inject, Injectable } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
import { PAYMENT_REFUND_CLIENT, type AttemptStatus, type PaymentRefundClient, type PaymentRefunds } from './payment-refund-client.js';

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
  | 'refund_evidence'; // an allocation or an unallocated refund fact of the movement

export type RefundEvidenceVerdict = { clean: true } | { clean: false; reason: RefundEvidenceReason };

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
  return { clean: true };
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
  constructor(
    private readonly db: DbService,
    @Inject(PAYMENT_REFUND_CLIENT) private readonly payment: PaymentRefundClient,
  ) {}

  /**
   * One decision's evidence for the loss of `disputeId`. The caller selected the loss from Billing's committed rows, so this read starts after
   * the loss was committed; its answer is used for this one decision only. The database still re-checks the local half at the effect's insert.
   */
  async check(disputeId: string): Promise<RefundEvidenceVerdict> {
    const loss = (await this.db.query<{ paymentId: string; live: boolean }>(
      `SELECT l."paymentId", billing_loss_refund_live(l."disputeId") AS live FROM payment_dispute_loss l WHERE l."disputeId" = $1`, [disputeId])).rows[0];
    if (!loss) return { clean: false, reason: 'payment_not_found' };
    if (loss.live) return { clean: false, reason: 'relay_live' };
    const { rows } = await this.db.query<{ id: string; onMovement: boolean }>(
      `SELECT x.id, billing_refund_case_on_loss_movement(x."refundCaseId", $2) AS "onMovement" FROM refund_authorization_relay x WHERE x."paymentId" = $1`,
      [loss.paymentId, disputeId]);
    const relays = new Map(rows.map((r) => [r.id, r.onMovement]));
    let read: PaymentRefunds | null;
    try {
      read = await this.payment.refunds(loss.paymentId);
    } catch {
      return { clean: false, reason: 'payment_unavailable' };
    }
    return judgeRefundEvidence(read, relays);
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

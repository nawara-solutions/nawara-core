import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queryable } from '@nawara/service-kit';
import { PAYMENT_CONFIG } from '../config/payment-config.token.js';
import type { PaymentConfig } from '../config/payment-config.js';
import type { EventContext } from '../events/payment-events.js';
import { ProviderRegistry } from '../providers/provider-registry.js';
import {
  evaluateRefundCapability, failureFinalityOf, type RefundCapabilityContext, type RefundFailureFinalityRecord, type RefundFailureObservation,
} from '../providers/refund-capabilities.js';
import type { FailedAttemptEvidenceState } from './refund-attempt.service.js';
import type { RefundAttemptRow } from './refund.types.js';

/** Why one earlier attempt may still pay: the database's own decision, or the code registry's refusal of its finality evidence. */
export interface RefundBlocker {
  attemptId: string;
  captureFactId: string;
  status: string;
  reason: string;
}

/** The money a refund attempt would return. `attemptId` is the attempt itself, never its own blocker (null before it exists). */
export interface RefundTarget {
  attemptId: string | null;
  paymentId: string;
  captureFactId: string;
  captureSpecific: boolean;
}

interface ScopeRow {
  id: string;
  captureFactId: string;
  captureSpecific: boolean;
  status: string;
  provider: string;
  providerRefundId: string | null;
  mayStillPay: boolean;
  finality: RefundFailureFinalityRecord | null;
}

/**
 * Core V2 D-R1B (the Owner's GO of 2026-11-24; migration 0037): whether an earlier refund attempt of the same captured money may still pay, decided by
 * BOTH layers, fail closed:
 *   * the database (`refund_attempt_may_still_pay`): the finality evidence, its certificate in the migration-only mirror, in force NOW, not revoked;
 *   * the code registry (`failureFinalityOf`): the same evidence against this deployment's reviewed certificates and the adapter's declaration.
 * An attempt is out of the way only if both say so. The database refuses the insert and the dispatch independently (0037).
 *
 * LOCK ORDER (0037): callers hold the payment's dispatch lock (dispatch only), the payment row and the attempt row BEFORE this service takes the
 * capability lock, SHARED, held to the end of the transaction: no revocation can commit between a decision here and what it permits.
 * Nothing here releases, retries, reassigns or excuses an attempt; no caller or operator can assert finality (OD-DR1-5 NO-GO).
 */
@Injectable()
export class RefundFinalityService {
  private readonly log = new Logger('PaymentRefundFinality');

  constructor(
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
    @Inject(PAYMENT_CONFIG) private readonly config: PaymentConfig,
  ) {}

  /** The capability lock (shared), then the database's clock read after it. */
  private async context(q: Queryable): Promise<RefundCapabilityContext> {
    await q.query('SELECT pg_advisory_xact_lock_shared(refund_capability_lock_key())');
    const { rows } = await q.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    return { now: rows[0]?.now ?? new Date(Number.NaN), simulationEnvironment: this.config.simulation !== undefined && !this.config.isProduction };
  }

  /**
   * In the transaction that is about to move `a` (locked, in flight) to `failed` with `failureCode`: the finality evidence, only when the adapter's
   * certified capability covers this observation in the registry AND the database's mirror holds that exact certificate in force. Otherwise nothing is
   * written and the failure is recorded as before: an uncertified failure, which blocks a replacement. Never throws for a refusal.
   */
  async recordIfCertified(q: Queryable, a: RefundAttemptRow, observation: RefundFailureObservation, failureCode: string, ctx: EventContext): Promise<boolean> {
    const at = await this.context(q);
    const e = evaluateRefundCapability(this.providers.tryGet(a.provider), 'terminalFailureFinality', at);
    const refusal = !e.certified ? e.reason : e.grant.observations.includes(observation) ? null : 'observation_not_covered';
    if (refusal !== null || !e.certified) {
      this.log.log(`refund_failure_not_final refundAttempt=${a.id} payment=${a.paymentId} observation=${observation} reason=${refusal} — an uncertified failure; no replacement is permitted (D-R1B)`);
      return false;
    }
    const source = observation === 'dispatch_rejected' ? 'dispatch_response' : ctx.cause.type === 'webhook_event' ? 'webhook' : 'status_check';
    const { rowCount } = await q.query(
      `INSERT INTO refund_attempt_failure_finality ("refundAttemptId", "paymentId", "captureFactId", provider, "idempotencyKey", observation, "observationSource", "webhookEventId",
         "failureCode", "certificateId", "certificateVersion", "certificateFingerprint", "recordedAt")
       SELECT a.id, a."paymentId", a."captureFactId", a.provider, a.id::text, $2, $3, $4::uuid, $5, $6, $7, $8, clock_timestamp()
         FROM refund_attempt a
        WHERE a.id = $1 AND refund_capability_certificate_in_force($6, $7, $8, a.provider, $2, clock_timestamp()) AND NOT refund_capture_has_evidence(a."captureFactId")`,
      [a.id, observation, source, source === 'webhook' ? ctx.cause.id : null, failureCode, e.certificate.id, e.certificate.version, e.fingerprint]);
    if (rowCount === 1) return true;
    this.log.error(`refund_failure_finality_refused refundAttempt=${a.id} payment=${a.paymentId} certificate=${e.certificate.id}@${e.certificate.version} — the database does not hold this certificate in force, or the capture has refund evidence; recorded as an uncertified failure (D-R1B)`);
    return false;
  }

  /** Core V2 R3 (PAY-08 I): the evidence state of a failed attempt (see `RefundAttemptService.failedAttemptEvidence`); anything but `none` is never final. */
  async evidenceAfterFailure(q: Queryable, a: Pick<RefundAttemptRow, 'id' | 'provider' | 'providerRefundId'>): Promise<FailedAttemptEvidenceState> {
    if (a.providerRefundId === null) return 'none';
    if (this.providers.tryGet(a.provider)?.capabilities.refundReferenceScope !== 'provider') return 'unknown';
    const r = (await q.query<{ fact: { unmatched: boolean } | null; indexPending: boolean; malformed: boolean; notified: boolean }>(
      `SELECT (SELECT json_build_object('unmatched', f."paymentId" IS NULL AND f."refundAttemptId" IS NULL
                 AND NOT EXISTS (SELECT 1 FROM provider_fact_association s WHERE s."factId" = f.id))
                 FROM provider_transaction_fact f WHERE f.provider = $1 AND f."providerTxnId" = $2 AND f.kind = 'refund') AS fact,
              EXISTS (SELECT 1 FROM webhook_event w WHERE w.provider = $1 AND w."eventType" = 'refund.succeeded' AND w."evidenceIndex" = 'pending') AS "indexPending",
              EXISTS (SELECT 1 FROM webhook_event w WHERE w.provider = $1 AND w."eventType" = 'refund.succeeded' AND w."providerTransactionId" = $2
                       AND w."evidenceIndex" = 'reference_malformed') AS malformed,
              EXISTS (SELECT 1 FROM webhook_event w WHERE w.provider = $1 AND w."eventType" = 'refund.succeeded' AND w."providerTransactionId" = $2
                       AND w."evidenceIndex" = 'reference' AND w.outcome IS DISTINCT FROM 'refund_attempt:' || $3::text) AS notified`,
      [a.provider, a.providerRefundId, a.id])).rows[0]!;
    if (r.fact) return r.fact.unmatched ? 'unmatched_fact' : 'unknown';
    if (r.indexPending || r.malformed) return 'unknown';
    return r.notified ? 'notification_pending' : 'none';
  }

  /** Every attempt of the payment or the capture that may still pay (neither layer alone can clear one). */
  private async mayStillPay(q: Queryable, t: Pick<RefundTarget, 'attemptId' | 'paymentId' | 'captureFactId'>): Promise<Array<ScopeRow & { reason: string }>> {
    const at = await this.context(q);
    const { rows } = await q.query<ScopeRow>(
      `SELECT o.id, o."captureFactId", o."captureSpecific", o.status, o.provider, o."providerRefundId", refund_attempt_may_still_pay(o.id, clock_timestamp()) AS "mayStillPay",
              (SELECT jsonb_build_object('certificateId', n."certificateId", 'certificateVersion', n."certificateVersion", 'fingerprint', n."certificateFingerprint",
                        'observation', n.observation, 'failureCode', n."failureCode")
                 FROM refund_attempt_failure_finality n WHERE n."refundAttemptId" = o.id) AS finality
         FROM refund_attempt o
        WHERE (o."paymentId" = $1 OR o."captureFactId" = $2) AND ($3::uuid IS NULL OR o.id <> $3::uuid) AND o.status NOT IN ('authorization_expired', 'authorization_refused')
        ORDER BY o."requestedAt", o.id`,
      [t.paymentId, t.captureFactId, t.attemptId]);
    const out: Array<ScopeRow & { reason: string }> = [];
    for (const o of rows) {
      if (o.status !== 'failed') {
        out.push({ ...o, reason: o.status });
        continue;
      }
      const code = failureFinalityOf(o.finality, this.providers.tryGet(o.provider), at);
      if (!code.final) out.push({ ...o, reason: code.reason });
      else if (o.mayStillPay) out.push({ ...o, reason: 'database_refused' });
      else {
        const evidence = await this.evidenceAfterFailure(q, o); // ambiguous evidence under its own provider reference: not final
        if (evidence !== 'none') out.push({ ...o, reason: `evidence_${evidence}` });
      }
    }
    return out;
  }

  /** The earlier attempt that may still pay the target's money (the scopes of the one-effective indexes, 0022), or null. */
  async blocker(q: Queryable, t: RefundTarget): Promise<RefundBlocker | null> {
    const b = (await this.mayStillPay(q, t)).find((o) => o.captureFactId === t.captureFactId || (!t.captureSpecific && !o.captureSpecific));
    return b ? { attemptId: b.id, captureFactId: b.captureFactId, status: b.status, reason: b.reason } : null;
  }

  /**
   * R6H-5: whether another capture of the settling attempt surely stays unrefunded: no refund evidence of it and no attempt on it that may still pay
   * (a failed, uncertified attempt may).
   */
  async anotherCaptureRemains(q: Queryable, payment: { id: string; succeededAttemptId: string | null }, captureFactId: string, attemptId: string | null = null): Promise<boolean> {
    const paying = new Set((await this.mayStillPay(q, { attemptId, paymentId: payment.id, captureFactId })).map((o) => o.captureFactId));
    const { rows } = await q.query<{ id: string }>(
      `SELECT g.id FROM provider_transaction_fact g
        WHERE g."paymentId" = $1 AND g."attemptId" = $2 AND g.kind = 'capture' AND g.id <> $3 AND NOT refund_capture_has_evidence(g.id)`,
      [payment.id, payment.succeededAttemptId, captureFactId]);
    return rows.some((g) => !paying.has(g.id));
  }

  /**
   * Why `a` may not be sent (first time or again) now, or null: an earlier attempt that may still pay, or (R6H-5) the last capture of the settling
   * attempt because a FAILED attempt on another one may still pay. The caller holds the payment and attempt locks.
   *
   * Core V2 D-R1C (0038): the refusal names its cause. The DATABASE's refusal (0037 `refund_attempt_replacement_refusal`) is asked first, under the same
   * capability lock; when it refuses, the cause is `database_verified` and its blocker is the one the database counts. Otherwise a refusal of this layer
   * alone (the code registry, or R3 evidence) is `producer_derived`. The decision itself is unchanged from D-R1B: refused exactly when it was before.
   */
  async dispatchRefusal(q: Queryable, a: RefundAttemptRow): Promise<DispatchRefusal | null> {
    const target: RefundTarget = { attemptId: a.id, paymentId: a.paymentId, captureFactId: a.captureFactId, captureSpecific: a.captureSpecific };
    const paying = await this.mayStillPay(q, target);
    const reasonOf = (id: string) => boundedReason(paying.find((o) => o.id === id)?.reason ?? 'database_may_still_pay');
    const { rows: db } = await q.query<{ refusal: string | null }>(
      `SELECT refund_attempt_replacement_refusal($1, $2, $3, $4, clock_timestamp()) AS refusal`, [a.id, a.paymentId, a.captureFactId, a.captureSpecific]);
    if (db[0]?.refusal === 'refund_attempt_prior_may_still_pay') {
      const { rows } = await q.query<{ id: string; status: string }>(
        `SELECT o.id, o.status FROM refund_attempt o
          WHERE o.id <> $1 AND (o."captureFactId" = $3 OR (o."paymentId" = $2 AND NOT o."captureSpecific" AND NOT $4::boolean))
            AND refund_attempt_may_still_pay(o.id, clock_timestamp())
          ORDER BY o."requestedAt", o.id LIMIT 1`, [a.id, a.paymentId, a.captureFactId, a.captureSpecific]);
      if (rows[0]) return { cause: 'prior_may_still_pay', basis: 'database_verified', blockerId: rows[0].id, blockerStatus: rows[0].status, reason: reasonOf(rows[0].id) };
    }
    if (db[0]?.refusal === 'refund_attempt_last_capture_may_still_pay') {
      const { rows } = await q.query<{ id: string; status: string }>(
        `SELECT o.id, o.status FROM refund_attempt o
           JOIN provider_transaction_fact g ON g.id = o."captureFactId" AND g.kind = 'capture'
           JOIN provider_transaction_fact f ON f.id = $2 AND g."paymentId" = f."paymentId" AND g."attemptId" = f."attemptId" AND g.id <> f.id
          WHERE o.id <> $1 AND o.status = 'failed' AND refund_attempt_may_still_pay(o.id, clock_timestamp())
          ORDER BY o."requestedAt", o.id LIMIT 1`, [a.id, a.captureFactId]);
      if (rows[0]) return { cause: 'last_capture_may_still_pay', basis: 'database_verified', blockerId: rows[0].id, blockerStatus: rows[0].status, reason: reasonOf(rows[0].id) };
    }
    const producer = (scope: 'prior' | 'last_capture', o: { id: string; status: string; reason: string }): DispatchRefusal => ({
      cause: `${scope}_${o.reason.startsWith('evidence_') ? 'evidence_unresolved' : 'registry_not_final'}` as DispatchBlockingCause,
      basis: 'producer_derived', blockerId: o.id, blockerStatus: o.status, reason: boundedReason(o.reason),
    });
    const b = paying.find((o) => o.captureFactId === target.captureFactId || (!target.captureSpecific && !o.captureSpecific));
    if (b) return producer('prior', b);
    if (!a.captureSpecific) return null;
    const { rows } = await q.query<{ siblings: string[]; succeededAttemptId: string }>(
      `SELECT p."succeededAttemptId", ARRAY(SELECT g.id::text FROM provider_transaction_fact g WHERE g."paymentId" = p.id AND g."attemptId" = f."attemptId" AND g.kind = 'capture' AND g.id <> f.id) AS siblings
         FROM payment p JOIN provider_transaction_fact f ON f.id = $2 AND f."paymentId" = p.id AND f."attemptId" = p."succeededAttemptId"
        WHERE p.id = $1 AND p.status = 'succeeded'`, [a.paymentId, a.captureFactId]);
    const s = rows[0];
    if (!s || s.siblings.length === 0) return null;
    const failed = paying.find((o) => o.status === 'failed' && s.siblings.includes(o.captureFactId));
    if (!failed || (await this.anotherCaptureRemains(q, { id: a.paymentId, succeededAttemptId: s.succeededAttemptId }, a.captureFactId, a.id))) return null;
    return producer('last_capture', failed);
  }
}

/** Core V2 D-R1C (0038): the six causes of a refused dispatch. */
export type DispatchBlockingCause = 'prior_may_still_pay' | 'last_capture_may_still_pay' | 'prior_registry_not_final' | 'last_capture_registry_not_final'
  | 'prior_evidence_unresolved' | 'last_capture_evidence_unresolved';
export interface DispatchRefusal {
  cause: DispatchBlockingCause;
  /** `database_verified`: the database recomputes it at the escalation (0038); `producer_derived`: this layer's own decision, scope-checked only. */
  basis: 'database_verified' | 'producer_derived';
  blockerId: string;
  blockerStatus: string;
  reason: string;
}
export const describeRefusal = (r: DispatchRefusal): string => `refund_attempt_${r.cause} prior=${r.blockerId} status=${r.blockerStatus} reason=${r.reason} basis=${r.basis}`;
/** A reason code in the stored grammar (never free text). */
const boundedReason = (reason: string): string => (/^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : 'unclassified');

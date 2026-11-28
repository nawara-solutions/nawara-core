import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, describeFailure, type Queryable } from '@nawara/service-kit';
import type { RefundDispatchResult } from '../providers/provider.port.js';
import type { RefundAttemptRow } from './refund.types.js';

/** Core V2 D-R1D (0039): how Payment received the provider's answer to ONE send. `transport_error`: the call threw or timed out. */
export type DispatchClassification = 'accepted' | 'rejected' | 'ambiguous' | 'transport_error';
export type DispatchSendPurpose = 'first_send' | 'same_key_resend';
export type DispatchApplicationEffect = 'transitioned' | 'preserved_contradiction' | 'no_effect';

export interface DispatchObservationRow {
  id: string;
  sendId: string;
  refundAttemptId: string;
  classification: DispatchClassification;
  providerRefundId: string | null;
  providerCode: string | null;
  responseDigest: string;
  observedAt: Date;
}

/** The bounded code a rejection is recorded with (0036's rule, unchanged). */
export const boundedFailureCode = (code: string): string => (/^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'provider_failure');

/** The answer as it is stored: one classification, the accepted reference or the rejected code, nothing else. */
export const classifyDispatch = (result: RefundDispatchResult | { kind: 'transport_error' }): Pick<DispatchObservationRow, 'classification' | 'providerRefundId' | 'providerCode'> => {
  switch (result.kind) {
    case 'accepted':
      return { classification: 'accepted', providerRefundId: result.providerRefundId, providerCode: null };
    case 'rejected':
      return { classification: 'rejected', providerRefundId: null, providerCode: boundedFailureCode(result.failureCode) };
    case 'ambiguous':
      return { classification: 'ambiguous', providerRefundId: null, providerCode: null };
    default:
      return { classification: 'transport_error', providerRefundId: null, providerCode: null };
  }
};

/** Bounded in-process retries of the observation write (same send id: idempotent); a technical value, no business meaning. */
const OBSERVE_TRIES = 3;
const OBSERVE_BACKOFF_MS = 200;

/**
 * Core V2 D-R1D (OD-DR1-6; migration 0039; the Owner's Q1, Q2): the refund dispatch's durable evidence. EVIDENCE ONLY.
 *   * `recordSend`: before the provider call, in the transaction that permits it (it never proves the provider received the call).
 *   * `observe`: the provider's answer to that send, in its OWN transaction, before any decision: a database failure after this commits can no longer
 *     lose it. Idempotent per send; never overwritten.
 *   * `applicationOf` / `recordApplication`: the exactly-once effect of an observation, under the attempt lock, in the applying transaction.
 *   * `recoverable`: stored answers no transaction applied (a crash, a failed decision), older than the configured window; the refund worker applies
 *     them without calling the provider and never records finality for them.
 */
@Injectable()
export class RefundDispatchResponseService {
  private readonly log = new Logger('PaymentRefundDispatchResponses');

  constructor(@Inject(DbService) private readonly db: DbService) {}

  async recordSend(q: Queryable, a: Pick<RefundAttemptRow, 'id' | 'paymentId' | 'provider'>, purpose: DispatchSendPurpose): Promise<string> {
    const id = randomUUID();
    await q.query(
      `INSERT INTO refund_dispatch_send (id, "refundAttemptId", "paymentId", provider, "idempotencyKey", "sendNumber", purpose, "createdAt")
       VALUES ($1, $2::uuid, $3, $4, $2::text, 0, $5, clock_timestamp())`, // number and time are derived by the database
      [id, a.id, a.paymentId, a.provider, purpose]);
    return id;
  }

  /** The answer to one send, durable in its own transaction; the stored row (a repeat of the same answer returns it unchanged). Throws when it cannot be stored. */
  async observe(sendId: string, refundAttemptId: string, answer: ReturnType<typeof classifyDispatch>): Promise<DispatchObservationRow> {
    let failure: unknown;
    for (let i = 0; i < OBSERVE_TRIES; i++) {
      try {
        return await this.db.tx(async (q) => {
          await q.query(
            `INSERT INTO refund_dispatch_observation ("sendId", "refundAttemptId", classification, "providerRefundId", "providerCode", "responseDigest", "observedAt")
             VALUES ($1, $2, $3, $4, $5, repeat('0', 64), clock_timestamp()) ON CONFLICT ("sendId") DO NOTHING`, // digest and time are derived by the database
            [sendId, refundAttemptId, answer.classification, answer.providerRefundId, answer.providerCode]);
          const stored = (await q.query<DispatchObservationRow>(`SELECT * FROM refund_dispatch_observation WHERE "sendId" = $1`, [sendId])).rows[0]!;
          if (stored.classification !== answer.classification || stored.providerRefundId !== answer.providerRefundId || stored.providerCode !== answer.providerCode) {
            // one in-memory answer per send: impossible in correct code. The stored observation stands; nothing overwrites it
            this.log.error(`refund_dispatch_observation_mismatch send=${sendId} refundAttempt=${refundAttemptId} stored=${stored.classification} received=${answer.classification} — the stored observation is kept unchanged`);
          }
          return stored;
        });
      } catch (e) {
        failure = e;
        this.log.warn(`refund_dispatch_observation_retry send=${sendId} refundAttempt=${refundAttemptId} try=${i + 1} ${describeFailure(e)}`);
        if (i + 1 < OBSERVE_TRIES) await new Promise((r) => setTimeout(r, OBSERVE_BACKOFF_MS * (i + 1)));
      }
    }
    throw failure;
  }

  async applicationOf(q: Queryable, observationId: string): Promise<boolean> {
    return (await q.query(`SELECT 1 FROM refund_dispatch_application WHERE "observationId" = $1`, [observationId])).rows.length > 0;
  }

  async recordApplication(q: Queryable, o: DispatchObservationRow, effect: DispatchApplicationEffect, before: string, after: string, appliedBy: 'dispatch' | 'recovery'): Promise<void> {
    await q.query(
      `INSERT INTO refund_dispatch_application ("observationId", "refundAttemptId", effect, "attemptStatusBefore", "attemptStatusAfter", "appliedBy", "appliedAt")
       VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp())`, [o.id, o.refundAttemptId, effect, before, after, appliedBy]);
  }

  /** Stored answers no transaction applied, observed more than `afterMs` ago (database time), oldest first. */
  async recoverable(afterMs: number, limit: number): Promise<DispatchObservationRow[]> {
    return (await this.db.query<DispatchObservationRow>(
      `SELECT o.* FROM refund_dispatch_observation o
        WHERE NOT EXISTS (SELECT 1 FROM refund_dispatch_application p WHERE p."observationId" = o.id)
          AND o."observedAt" < now() - make_interval(secs => $1)
        ORDER BY o."observedAt", o.id LIMIT $2`, [afterMs / 1000, limit])).rows;
  }
}

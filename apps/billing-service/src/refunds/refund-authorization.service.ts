import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import type { TransitionContext } from '../domain/actors.js';
import { requestHash } from '../domain/canonical.js';
import { billingError, notFound } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';
import { PAYMENT_DISPUTE_EXPOSURE, type DisputeExposure } from './dispute-exposure.js';
import { PAYMENT_REFUND_CLIENT, type PaymentRefundClient, type RefundRelayOutcome } from './payment-refund-client.js';
import { RefundCaseService } from './refund-case.service.js';
import type { VerifiedRefundOwner } from './refund-owner.guard.js';

/** A relay as Billing records it (migration 0034). */
export interface RelayRow {
  id: string; refundCaseId: string; paymentId: string; requestedBy: string; idempotencyKey: string; requestHash: string;
  attemptStatus: string | null; refusal: string | null; requestedAt: Date; statusAt: Date | null;
}

/** The relay states proven to have ended without a consumed receipt: the only ones a cancellation tolerates (R6B-10). */
export const UNCONSUMED_FINAL = ['authorization_expired', 'authorization_refused', 'rejected'] as const;
/** The relay states that no longer hold the case: a new relay (with a new receipt) may start. */
export const NOT_EFFECTIVE = [...UNCONSUMED_FINAL, 'failed'] as const;

/**
 * Core V2 S6b (register BIL-24; ADR-0067 decision 5; S0 FC-3, V-3; the Owner's R6B-7, R6B-10). DEVELOPMENT AND SIMULATION ONLY.
 *
 * `POST /billing/admin/refund-cases/:id/authorizations {receiptSecret}`: the Owner of the case's Company and Platform (live) relays the Auth
 * receipt they obtained (AUTH-01, a factor step-up) to Payment. In order (R6B-10): (1) the Owner's live authority and the case; (2) the
 * case's refundable amount is Billing's own (S6a); (3) the dispute boundary; (4)-(6) under the case's row lock, one durable relay with a
 * refund attempt id Billing generates, and its audit intent, committed BEFORE Payment is called; (7) PAY-07 with Billing's own service token,
 * the binding fields taken from the case and the secret in memory only (F-12); (8) Payment's answer is mirrored only when it proves
 * something; an absent or ambiguous answer proves nothing and the relay stays unconfirmed, for the reconciler (PAY-08) or the Owner's retry;
 * (9) a retry with the same key resumes the same relay (the replay fingerprint never covers the secret).
 */
@Injectable()
export class RefundAuthorizationService {
  private readonly log = new Logger('BillingRefundAuthorization');

  constructor(
    private readonly db: DbService,
    private readonly cases: RefundCaseService,
    private readonly audit: BillingAudit,
    @Inject(PAYMENT_REFUND_CLIENT) private readonly payment: PaymentRefundClient,
    @Inject(PAYMENT_DISPUTE_EXPOSURE) private readonly disputes: DisputeExposure,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  async relay(owner: VerifiedRefundOwner, key: string, caseId: string, receiptSecret: string, ctx: TransitionContext) {
    if (this.config.isProduction) throw notFound();
    const c = await this.cases.authorizedCase(owner, caseId); // (1) live Owner, Company and Platform; the collapsed 404 otherwise
    const hash = requestHash({ operation: 'refund_case.authorize', caseId });
    let relay = await this.byKey(this.db, owner.userId, key, hash);
    let created = false;
    if (!relay) {
      // (3) the dispute boundary, outside any transaction, for a NEW relay only; fail closed
      if ((await this.disputes.status(c.paymentId, AbortSignal.timeout(this.config.authTimeoutMs))) !== 'none') {
        throw billingError(409, 'refund_dispute_open', BILLING_MESSAGES.refundDisputeOpen);
      }
      try {
        relay = await this.db.tx(async (q) => {
          await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing.refund_relay:' || $1 || ':' || $2, 0))`, [owner.userId, key]);
          const raced = await this.byKey(q, owner.userId, key, hash);
          if (raced) return raced;
          const current = (await q.query<{ status: string }>(`SELECT status FROM refund_case WHERE id = $1 FOR UPDATE`, [caseId])).rows[0]!;
          if (current.status === 'completed') throw billingError(409, 'refund_case_completed', BILLING_MESSAGES.refundCaseCompleted); // FC-3, V-3
          if (current.status !== 'open') throw billingError(409, 'refund_case_not_open', BILLING_MESSAGES.refundCaseNotOpen);
          const live = await q.query(`SELECT 1 FROM refund_authorization_relay WHERE "refundCaseId" = $1
              AND ("attemptStatus" IS NULL OR "attemptStatus" NOT IN ('authorization_expired', 'authorization_refused', 'failed', 'rejected'))`, [caseId]);
          if (live.rows.length > 0) throw billingError(409, 'refund_authorization_in_progress', BILLING_MESSAGES.refundAuthorizationInProgress);
          const id = randomUUID();
          const row = (await q.query<RelayRow>(
            `INSERT INTO refund_authorization_relay (id, "refundCaseId", "paymentId", "requestedBy", "idempotencyKey", "requestHash") VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [id, caseId, c.paymentId, owner.userId, key, hash])).rows[0]!;
          await this.audit.record(q, 'refund_case.authorization_relayed', {
            organizationId: c.organizationId, resource: { type: 'refund_case', id: caseId }, identity: id,
            changes: { payment_id: c.paymentId, refund_attempt_id: id, company_id: c.companyId, platform_id: c.platformId },
          }, ctx);
          return row;
        });
        created = true;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        relay = await this.byKey(this.db, owner.userId, key, hash);
        if (!relay) throw billingError(409, 'refund_authorization_in_progress', BILLING_MESSAGES.refundAuthorizationInProgress);
      }
    }
    // (7)-(9): only an unconfirmed or pending relay is sent (again); anything Payment already decided is answered from the mirror
    if (relay.attemptStatus === null || relay.attemptStatus === 'authorization_pending') {
      const outcome = await this.payment.relay(c.paymentId, `refund-relay:${relay.id}`, {
        refundAttemptId: relay.id, refundCaseId: caseId, amount: Number(c.amount), currency: c.currency, reason: c.reason, legalOverride: c.legalOverride,
        receiptSecret,
      });
      relay = await this.apply(relay.id, outcome);
      this.answerOutcome(outcome, relay);
    }
    this.answerStatus(relay);
    return { status: created ? 201 : 200, replayed: !created, body: await this.cases.read(owner, caseId) };
  }

  private async byKey(q: Queryable, ownerId: string, key: string, hash: string): Promise<RelayRow | null> {
    const r = (await q.query<RelayRow>(`SELECT * FROM refund_authorization_relay WHERE "requestedBy" = $1 AND "idempotencyKey" = $2`, [ownerId, key])).rows[0];
    if (r && r.requestHash !== hash) throw billingError(409, 'idempotency_key_conflict', BILLING_MESSAGES.idempotencyKeyConflict);
    return r ?? null;
  }

  /** Mirrors what Payment's answer proves; nothing else (an unknown answer leaves the relay exactly as it is). */
  async apply(id: string, outcome: RefundRelayOutcome): Promise<RelayRow> {
    const next = outcome.kind === 'attempt' ? { status: outcome.attempt.status as string, refusal: null }
      : outcome.kind === 'terminal' ? { status: outcome.status as string, refusal: null }
      : outcome.kind === 'refused' ? { status: 'rejected', refusal: outcome.code as string }
      : outcome.kind === 'pending' ? { status: 'authorization_pending', refusal: null }
      : null;
    if (!next) {
      if (outcome.kind === 'unknown') this.log.warn(`refund_relay_unconfirmed relay=${id} reason=${outcome.reason} — Payment's answer proves nothing; the reconciler reads Payment's state`);
      return (await this.db.query<RelayRow>(`SELECT * FROM refund_authorization_relay WHERE id = $1`, [id])).rows[0]!;
    }
    return this.mirror(id, next.status, next.refusal);
  }

  /** One conditional mirror update; a status Payment's attempt cannot reach from the stored one is refused by the database and kept as it was. */
  async mirror(id: string, status: string, refusal: string | null): Promise<RelayRow> {
    return this.db.tx(async (q) => {
      const current = (await q.query<RelayRow>(`SELECT * FROM refund_authorization_relay WHERE id = $1 FOR UPDATE`, [id])).rows[0]!;
      if (current.attemptStatus === status) return current;
      await q.query('SAVEPOINT refund_relay_mirror');
      try {
        return (await q.query<RelayRow>(`UPDATE refund_authorization_relay SET "attemptStatus" = $2, refusal = $3 WHERE id = $1 RETURNING *`, [id, status, refusal])).rows[0]!;
      } catch (e) {
        await q.query('ROLLBACK TO SAVEPOINT refund_relay_mirror');
        this.log.error(`refund_relay_mirror_refused relay=${id} from=${current.attemptStatus} to=${status} — ${(e as { constraint?: string }).constraint ?? 'refused'}; left as it was`);
        return current;
      }
    });
  }

  private answerOutcome(outcome: RefundRelayOutcome, relay: RelayRow): void {
    if (outcome.kind === 'conflict') throw billingError(409, 'refund_authorization_conflict', BILLING_MESSAGES.refundAuthorizationConflict);
    if (outcome.kind === 'unknown' && relay.attemptStatus === null) throw billingError(503, 'refund_payment_unavailable', BILLING_MESSAGES.refundPaymentUnavailable);
  }

  /** The relay's mirrored outcome as the Owner's answer: a terminal refusal is an error on every replay; the rest is the case. */
  private answerStatus(relay: RelayRow): void {
    switch (relay.attemptStatus) {
      case 'authorization_refused':
        throw billingError(409, 'refund_authorization_invalid', BILLING_MESSAGES.refundAuthorizationInvalid);
      case 'authorization_expired':
        throw billingError(409, 'refund_authorization_expired', BILLING_MESSAGES.refundAuthorizationExpired);
      case 'rejected':
        throw billingError(409, 'refund_rejected_by_payment', BILLING_MESSAGES.refundRejectedByPayment, { reason: relay.refusal ?? 'payment_not_refundable' });
      case 'authorization_pending':
        throw billingError(503, 'refund_authorization_unresolved', BILLING_MESSAGES.refundAuthorizationUnresolved);
      case null:
        throw billingError(503, 'refund_payment_unavailable', BILLING_MESSAGES.refundPaymentUnavailable);
      default:
    }
  }
}

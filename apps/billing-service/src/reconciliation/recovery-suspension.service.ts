import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { DbService, pgConstraint } from '@nawara/service-kit';
import { BillingAudit } from '../audit/billing-audit.js';
import { BILLING_CONFIG } from '../config/billing-config.token.js';
import type { BillingConfig } from '../config/billing-config.js';
import type { TransitionContext } from '../domain/actors.js';
import { billingError, notFound } from '../domain/errors.js';
import { FRAUD_HOLD_RECEIPTS, type FraudHoldBinding, type FraudHoldReceipts, type ReceiptConsumption } from '../fraud-holds/fraud-hold-clients.js';
import { BILLING_MESSAGES } from '../messages.js';
import { OWNER_AUTHORITY, type OwnerAuthority } from '../platforms/owner-authority.client.js';
import type { VerifiedRefundOwner } from '../refunds/refund-owner.guard.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const SUSPEND_REASON = 'refund_chargeback_overlap' as const;
const REVOKE_REASON = 'owner_reinstated_restriction' as const;

const invalid = () => billingError(400, 'invalid_recovery_request', BILLING_MESSAGES.invalidRecoveryRequest);
const notSuspendable = () => billingError(409, 'recovery_restriction_not_suspendable', BILLING_MESSAGES.recoveryRestrictionNotSuspendable);
const notActive = () => billingError(409, 'recovery_suspension_not_active', BILLING_MESSAGES.recoverySuspensionNotActive);

/**
 * The Auth `consumeRef` of a revocation: one per suspension (a repeated revocation reuses it, so Auth answers the same consumption). A
 * suspension's own consumeRef is its id, chosen before the receipt and bound into it, as a fraud-hold placement's is.
 */
export const revocationRef = (suspensionId: string): string => {
  const h = createHash('sha256').update(`billing.recovery_restriction_revoke\0${suspensionId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | (parseInt(h[16]!, 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

interface ObligationRow { id: string; organizationId: string; companyId: string; platformId: string; disputeId: string; status: string }
interface EventRow {
  id: string; suspensionId: string; kind: 'suspended' | 'revoked'; obligationId: string; organizationId: string; companyId: string; disputeId: string; refundCaseId: string;
  reasonCode: string; actorUserId: string; receiptId: string; consumeRef: string; recordedAt: Date;
}

/**
 * Core V2 S0-C14 WP C (S0 §1.5 S0-C14 items 10, 11, 13; register BIL-28 H, AUTH-01 H). DEVELOPMENT AND SIMULATION ONLY.
 *
 * The live Owner of an obligation's Company and Platform suspends T3 for ONE recovery obligation in a refund and chargeback overlap, with Auth's
 * `recovery_restriction_suspend` receipt bound to the Company, the suspension id (chosen before the receipt), the obligation, its Organization,
 * the loss's dispute, the completed refund case of the overlap and the closed reason code `refund_chargeback_overlap`; and revokes an active
 * suspension with `recovery_restriction_revoke` (`owner_reinstated_restriction`). Company, Organization, dispute and refund case come from
 * Billing's records, never from the request. Another Company's Owner, or a Platform the Owner may not act on: the collapsed 404.
 *
 * A suspension changes T3 for that obligation only. It never clears, forgives, writes off or resolves the debt; the collection freeze, the
 * overlap case, T1 and T2 stay. One active suspension per obligation; no expiry; no automatic revocation. The database re-derives eligibility
 * under the Organization lock (migration 0050). A retry of the same request (same suspension id and receipt) finds Auth's consumption by its
 * deterministic reference and records once; a second receipt for the same suspension id is refused by Auth (`consume_ref_conflict`).
 */
@Injectable()
export class RecoverySuspensionService {
  private readonly log = new Logger('BillingRecoverySuspension');

  constructor(
    private readonly db: DbService,
    private readonly audit: BillingAudit,
    @Inject(FRAUD_HOLD_RECEIPTS) private readonly receipts: FraudHoldReceipts,
    @Inject(OWNER_AUTHORITY) private readonly owners: OwnerAuthority,
    @Inject(BILLING_CONFIG) private readonly config: BillingConfig,
  ) {}

  /** The obligation, visible only to the live Owner of its Company and Platform (the collapsed 404 otherwise). */
  private async ownedObligation(owner: VerifiedRefundOwner, id: string): Promise<ObligationRow> {
    if (!UUID.test(id)) throw notFound();
    const o = (await this.db.query<ObligationRow>(`SELECT id, "organizationId", "companyId", "platformId", "disputeId", status FROM recovery_obligation WHERE id = $1`, [id])).rows[0];
    if (!o || o.companyId !== owner.companyId || !(await this.owners.platformAllowed(owner.bearer, o.platformId, AbortSignal.timeout(this.config.authTimeoutMs)))) throw notFound();
    return o;
  }

  private async event(suspensionId: string, kind: 'suspended' | 'revoked'): Promise<EventRow | undefined> {
    return (await this.db.query<EventRow>(`SELECT * FROM recovery_restriction_suspension_event WHERE "suspensionId" = $1 AND kind = $2`, [suspensionId, kind])).rows[0];
  }

  private body(e: EventRow, status: 'suspended' | 'revoked') {
    return { obligationId: e.obligationId, suspensionId: e.suspensionId, status, reasonCode: e.reasonCode, receiptId: e.receiptId, recordedBy: { userId: e.actorUserId },
      recordedAt: e.recordedAt.toISOString() };
  }

  /** `POST /billing/admin/recovery-obligations/:id/restriction-suspensions {suspensionId, receiptSecret}`. */
  async suspend(owner: VerifiedRefundOwner, obligationId: string, input: Record<string, unknown>, ctx: TransitionContext) {
    if (this.config.isProduction) throw notFound();
    for (const k of Object.keys(input)) if (k !== 'suspensionId' && k !== 'receiptSecret') throw invalid();
    const suspensionId = typeof input.suspensionId === 'string' ? input.suspensionId.toLowerCase() : '';
    if (!UUID.test(suspensionId) || typeof input.receiptSecret !== 'string' || !SECRET.test(input.receiptSecret)) throw invalid();
    const o = await this.ownedObligation(owner, obligationId);
    const prior = await this.event(suspensionId, 'suspended');
    if (prior) {
      if (prior.obligationId === o.id && prior.consumeRef === suspensionId) return { created: false, body: this.body(prior, 'suspended') }; // the same request again
      throw notSuspendable();
    }
    // eligibility, read before the receipt is spent (the database re-derives all of it at the insert, under the Organization lock)
    const e = (await this.db.query<{ refundCaseId: string | null; outstanding: string; suspended: boolean }>(
      `SELECT billing_loss_completed_refund($1) AS "refundCaseId", billing_recovery_outstanding($2) AS outstanding, billing_recovery_restriction_suspended($2) AS suspended`,
      [o.disputeId, o.id])).rows[0]!;
    if (o.status !== 'open' || Number(e.outstanding) <= 0 || !e.refundCaseId || e.suspended) throw notSuspendable();
    const binding: FraudHoldBinding = { operation: 'recovery_restriction_suspend', audience: 'billing-service', companyId: o.companyId, suspensionId, obligationId: o.id,
      organizationId: o.organizationId, disputeId: o.disputeId, refundCaseId: e.refundCaseId, reasonCode: SUSPEND_REASON };
    const consumption = await this.consume(binding, input.receiptSecret, suspensionId, owner);
    try {
      await this.db.tx(async (q) => {
        await q.query(`INSERT INTO recovery_restriction_suspension_event ("suspensionId", kind, "obligationId", "organizationId", "companyId", "disputeId", "refundCaseId",
          "reasonCode", "actorUserId", "receiptId", "consumeRef") VALUES ($1, 'suspended', $2, $3, $4, $5, $6, $7, $8, $9, $1)`,
          [suspensionId, o.id, o.organizationId, o.companyId, o.disputeId, e.refundCaseId, SUSPEND_REASON, owner.userId, consumption.receiptId]);
        await this.audit.record(q, 'recovery_restriction.suspended', {
          // the event id's identity is the suspension: an obligation may be suspended again after a revocation (S0-C14 WP D finding)
          organizationId: o.organizationId, resource: { type: 'recovery_obligation', id: o.id }, identity: suspensionId,
          changes: { suspension_id: suspensionId, dispute_id: o.disputeId, refund_case_id: e.refundCaseId!, reason_code: SUSPEND_REASON },
        }, ctx);
      });
    } catch (err) {
      const c = pgConstraint(err);
      if (c === 'recovery_restriction_suspension_event_once' || c === 'recovery_restriction_suspension_event_receiptId_key' || c === 'recovery_restriction_suspension_event_consumeRef_key') {
        const again = await this.event(suspensionId, 'suspended');
        if (again && again.obligationId === o.id && again.receiptId === consumption.receiptId) return { created: false, body: this.body(again, 'suspended') }; // a concurrent identical request
        throw notSuspendable();
      }
      // the obligation was recovered, the overlap evidence changed, or another suspension became active meanwhile (its receipt is spent, as with fraud holds)
      if (c === 'recovery_restriction_suspension_eligible' || c === 'recovery_restriction_suspension_active' || c === 'recovery_restriction_suspension_evidence') throw notSuspendable();
      throw err;
    }
    this.log.log(`recovery_restriction_suspended obligation=${o.id} suspension=${suspensionId} — T3 no longer applies to it; the debt, the freeze and the overlap case stay`);
    return { created: true, body: this.body((await this.event(suspensionId, 'suspended'))!, 'suspended') };
  }

  /** `POST /billing/admin/recovery-obligations/:id/restriction-suspensions/:suspensionId/revocation {receiptSecret}`. */
  async revoke(owner: VerifiedRefundOwner, obligationId: string, suspensionId: string, input: Record<string, unknown>, ctx: TransitionContext) {
    if (this.config.isProduction) throw notFound();
    for (const k of Object.keys(input)) if (k !== 'receiptSecret') throw invalid();
    if (typeof input.receiptSecret !== 'string' || !SECRET.test(input.receiptSecret)) throw invalid();
    const o = await this.ownedObligation(owner, obligationId);
    if (!UUID.test(suspensionId)) throw notActive();
    const s = await this.event(suspensionId, 'suspended');
    if (!s || s.obligationId !== o.id) throw notActive();
    const consumeRef = revocationRef(suspensionId);
    const prior = await this.event(suspensionId, 'revoked');
    if (prior) {
      if (prior.consumeRef === consumeRef && prior.actorUserId === owner.userId) return { created: false, body: this.body(prior, 'revoked') }; // the same request again
      throw notActive();
    }
    const binding: FraudHoldBinding = { operation: 'recovery_restriction_revoke', audience: 'billing-service', companyId: s.companyId, suspensionId, obligationId: o.id,
      organizationId: s.organizationId, disputeId: s.disputeId, refundCaseId: s.refundCaseId, reasonCode: REVOKE_REASON };
    const consumption = await this.consume(binding, input.receiptSecret, consumeRef, owner);
    try {
      await this.db.tx(async (q) => {
        await q.query(`INSERT INTO recovery_restriction_suspension_event ("suspensionId", kind, "obligationId", "organizationId", "companyId", "disputeId", "refundCaseId",
          "reasonCode", "actorUserId", "receiptId", "consumeRef") VALUES ($1, 'revoked', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [suspensionId, o.id, s.organizationId, s.companyId, s.disputeId, s.refundCaseId, REVOKE_REASON, owner.userId, consumption.receiptId, consumeRef]);
        await this.audit.record(q, 'recovery_restriction.suspension_revoked', {
          organizationId: s.organizationId, resource: { type: 'recovery_obligation', id: o.id }, identity: suspensionId, changes: { suspension_id: suspensionId, reason_code: REVOKE_REASON },
        }, ctx);
      });
    } catch (err) {
      const c = pgConstraint(err);
      if (c === 'recovery_restriction_suspension_event_once' || c === 'recovery_restriction_suspension_event_receiptId_key' || c === 'recovery_restriction_suspension_event_consumeRef_key') {
        const again = await this.event(suspensionId, 'revoked');
        if (again && again.receiptId === consumption.receiptId) return { created: false, body: this.body(again, 'revoked') };
        throw notActive();
      }
      if (c === 'recovery_restriction_suspension_revocation' || c === 'recovery_restriction_suspension_evidence') throw notActive();
      throw err;
    }
    this.log.log(`recovery_restriction_suspension_revoked obligation=${o.id} suspension=${suspensionId} — T3 applies again to new assistance requests only`);
    return { created: true, body: this.body((await this.event(suspensionId, 'revoked'))!, 'revoked') };
  }

  private async consume(binding: FraudHoldBinding, secret: string, consumeRef: string, owner: VerifiedRefundOwner): Promise<ReceiptConsumption> {
    let out;
    try {
      out = await this.receipts.consume({ secret, binding, consumeRef });
      if (out.kind === 'unresolved') {
        // a lost answer: the same reference finds the consumption Auth already made (a retry after an uncertain outcome)
        const found = await this.receipts.lookup({ binding, consumeRef }).catch(() => null);
        if (found) out = { kind: 'consumed' as const, consumption: found };
      }
    } catch {
      throw billingError(503, 'recovery_authorization_unavailable', BILLING_MESSAGES.recoveryAuthorizationUnavailable);
    }
    if (out.kind === 'refused' || (out.kind === 'consumed' && out.consumption.approvedByUserId !== owner.userId)) {
      throw billingError(409, 'recovery_authorization_refused', BILLING_MESSAGES.recoveryAuthorizationRefused);
    }
    if (out.kind === 'unresolved') throw billingError(503, 'recovery_authorization_unresolved', BILLING_MESSAGES.recoveryAuthorizationUnresolved);
    return out.consumption;
  }
}

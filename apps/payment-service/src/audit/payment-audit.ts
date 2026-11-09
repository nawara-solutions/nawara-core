import { Inject, Injectable } from '@nestjs/common';
import { AuditEventWriter, type AuditActor } from '@nawara/audit-contract';
import { OutboxService, type Queryable } from '@nawara/service-kit';
import { deterministicEventId } from '../events/deterministic-id.js';
import type { EventContext } from '../events/payment-events.js';
import type { PaymentRow } from '../payments/payment.types.js';

/** The ONE identity of this service as a producer: the outbox relay stamps it as `source`, the audit writer is bound to it (ADR-0049 A20). */
export const PAYMENT_SERVICE_NAME = 'payment-service';

/** The kit correlation grammar. A correlation id is navigation only (A33): one outside it is dropped, never a reason to fail a change. */
const CORRELATION = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Every Payment catalog action (Stage 18.7.1). `payment.succeeded` / `payment.failed` became wireable with catalog correction G1 (a
 * verified user's attempt sync and the attempt resolver are real settling paths).
 */
export type PaymentAuditAction = 'payment.created' | 'payment.cancelled' | 'payment.expired' | 'payment.succeeded' | 'payment.failed';
/** Core V2 S6b (R6B-7): the refund attempt actions (version 1, no trusted scope, no `approvedBy`: the approver stays on Payment's own row). */
export type RefundAuditAction = 'refund_attempt.authorized' | 'refund_attempt.failed' | 'refund_attempt.succeeded';
/** Core V2 S6e-D (R6E-8): the dispute actions (version 1, no trusted scope): provider observations by the verified webhook, Owner actions by the Owner. */
export type DisputeAuditAction = 'payment_dispute.opened' | 'payment_dispute.closed' | 'payment_dispute.evidence_added' | 'payment_dispute.decided';
/** Core V2 S6h (R6H-11): the Owner's association of an unmatched provider fact (version 1, no trusted scope). */
/** Core V2 S0-C13 Part A: a preserved conflict of a verified dispute notification (version 1, no trusted scope). */
export type DisputeConflictAuditAction = 'payment_dispute.conflict_recorded';
export type ReconciliationAuditAction = 'provider_fact.associated' | 'provider_fact_conflict.recorded';
/** Core V2 DO-73 (U-3): a verified refund fact permanently blocked from allocation, once per block row (version 1, no trusted scope). */
export type AllocationBlockAuditAction = 'refund_fact.allocation_blocked';
export type AllocationBlockReason = 'contested' | 'currency_mismatch' | 'no_authorization';
/** Core V2 S0-C12 item 10: late successes and wrong-amount capture facts (version 1, no trusted scope). */
export type CaptureAuditAction = 'payment_late_success.recorded' | 'payment_capture_mismatch.recorded';
/** S0-C12 item 10: the reason a capture fact differs from its payment (a code; the observed currency text never enters the audit record). */
export type CaptureMismatchReason = 'amount_mismatch' | 'currency_mismatch' | 'unrecognized_currency';
/** The system actor of a provider observation recorded by Payment: its channel, never whoever asked for a status read; or the reconciler. */
export type ObservationActor = 'payment_webhook' | 'payment_status_read' | 'payment_capture_reconciler';
export const observationActor = (source: string): ObservationActor => (source === 'webhook' ? 'payment_webhook' : 'payment_status_read');

/**
 * The catalog actor of a Payment transition, from Payment's own verified attribution (never a request value). A service caller is the
 * authenticated service-token caller; the expiry sweep and verified webhook processing are Payment's own processes. Anything else has
 * no catalog actor: a programming error that rolls the whole business transaction back (no evidence is ever guessed).
 */
export function auditActor(ctx: EventContext): AuditActor {
  if (ctx.actor.type === 'service' && ctx.actor.id) return { type: 'service', id: ctx.actor.id };
  if (ctx.actor.type === 'user' && ctx.actor.id && ctx.userKind) return { type: 'user', id: ctx.actor.id, userKind: ctx.userKind };
  if (ctx.actor.type === 'system' && ctx.cause.type === 'attempt_resolver') return { type: 'system', id: 'payment_attempt_resolver' };
  if (ctx.actor.type === 'system' && ctx.cause.type === 'expiry_sweep') return { type: 'system', id: 'payment_expiry_sweep' };
  if (ctx.actor.type === 'provider' && ctx.cause.type === 'webhook_event') return { type: 'system', id: 'payment_webhook' };
  if (ctx.actor.type === 'system' && ctx.cause.type === 'refund_worker') return { type: 'system', id: 'payment_refund_worker' }; // Core V2 S6b
  throw new Error(`payment_audit_actor_not_cataloged actor=${ctx.actor.type} cause=${ctx.cause.type}`);
}

/**
 * Writes the central audit intent of a Payment transition into the kit outbox ON THE TRANSITION'S TRANSACTION (`q`): the payment state
 * and its evidence commit or roll back together, and the relay delivers it after COMMIT (at least once). Only identifiers: the payment id
 * (resource) and the organization recorded on the payment row; never an amount, a party, a description, a reference or provider data.
 * The event id is derived from (payment, action): a retried transition writes the same event once.
 */
@Injectable()
export class PaymentAudit {
  private readonly writer: AuditEventWriter<Queryable>;

  constructor(@Inject(OutboxService) outbox: OutboxService) {
    this.writer = new AuditEventWriter({ sourceService: PAYMENT_SERVICE_NAME, outbox });
  }

  async record(q: Queryable, action: PaymentAuditAction, payment: PaymentRow, ctx: EventContext): Promise<void> {
    // payment.succeeded carries its one cataloged fact: how it was settled (the row's own settledMethod; only 'gateway' exists today).
    const changes = action === 'payment.succeeded' ? { changes: { settled_method: payment.settledMethod as 'gateway' } } : {};
    await this.writer.write(
      q,
      { action, actor: auditActor(ctx), organizationId: payment.organizationId, resource: { type: 'payment', id: payment.id }, outcome: 'succeeded', ...changes } as never,
      { eventId: deterministicEventId(payment.id, `audit.${action}`), ...(ctx.correlationId && CORRELATION.test(ctx.correlationId) ? { correlationId: ctx.correlationId } : {}) },
    );
  }

  /**
   * Core V2 S6b (R6B-7): the central audit intent of a refund attempt transition, on the transition's own transaction. Identifiers only (the
   * attempt is the resource; its payment, case and, for a success, its verified refund fact); never an amount, the receipt, its secret or the
   * approver (kept on Payment's row: `approvedBy` v2 is not granted). The event id is derived from (attempt, action): written once.
   */
  async recordRefund(q: Queryable, action: RefundAuditAction, attempt: { id: string; paymentId: string; refundCaseId: string; succeededFactId?: string | null },
    organizationId: string | null, ctx: EventContext): Promise<void> {
    const changes = action === 'refund_attempt.succeeded'
      ? { payment_id: attempt.paymentId, refund_case_id: attempt.refundCaseId, fact_id: attempt.succeededFactId as string }
      : { payment_id: attempt.paymentId, refund_case_id: attempt.refundCaseId };
    await this.writer.write(
      q,
      { action, actor: auditActor(ctx), organizationId, resource: { type: 'refund_attempt', id: attempt.id }, outcome: 'succeeded', changes } as never,
      { eventId: deterministicEventId(attempt.id, `audit.${action}`), ...(ctx.correlationId && CORRELATION.test(ctx.correlationId) ? { correlationId: ctx.correlationId } : {}) },
    );
  }

  /**
   * Core V2 S6c (R6C-11): the central audit intent of a refund case's financial completion (FC-3), in the completion transaction. Version 1,
   * no trusted scope, no `approvedBy`: identifiers only (the authorization is the resource; its payment, case and attempt as changes).
   */
  async recordRefundCompletion(q: Queryable, z: { id: string; paymentId: string; refundCaseId: string; refundAttemptId: string }, organizationId: string | null, ctx: EventContext): Promise<void> {
    await this.writer.write(
      q,
      { action: 'refund_authorization.completed', actor: auditActor(ctx), organizationId, resource: { type: 'refund_authorization', id: z.id }, outcome: 'succeeded',
        changes: { payment_id: z.paymentId, refund_case_id: z.refundCaseId, refund_attempt_id: z.refundAttemptId } } as never,
      { eventId: deterministicEventId(z.id, 'audit.refund_authorization.completed'), ...(ctx.correlationId && CORRELATION.test(ctx.correlationId) ? { correlationId: ctx.correlationId } : {}) },
    );
  }

  /**
   * Core V2 DO-73 (U-3): the audit intent of ONE allocation block, in the block row's own transaction (under the payment row lock). The block's key is the
   * fact (one row per fact, append-only), and the event id is derived from it: a second insert fails and rolls back with its intent, and a later
   * `already blocked` answer writes nothing. Identifiers, the reason code and the verified integer amount only: never the currency (the provider's
   * own unvalidated text), the provider refund id or the notification body. No backfill: a block recorded before this action has no record.
   */
  async recordAllocationBlock(q: Queryable, b: { factId: string; paymentId: string; refundAttemptId: string; reason: AllocationBlockReason; amount: number },
    organizationId: string | null, ctx: EventContext): Promise<void> {
    await this.writer.write(
      q,
      { action: 'refund_fact.allocation_blocked' satisfies AllocationBlockAuditAction, actor: auditActor(ctx), organizationId,
        resource: { type: 'provider_transaction_fact', id: b.factId }, outcome: 'succeeded',
        changes: { payment_id: b.paymentId, refund_attempt_id: b.refundAttemptId, reason: b.reason, amount: b.amount } } as never,
      { eventId: deterministicEventId(b.factId, 'audit.refund_fact.allocation_blocked'), ...(ctx.correlationId && CORRELATION.test(ctx.correlationId) ? { correlationId: ctx.correlationId } : {}) },
    );
  }

  /**
   * Core V2 S6e-D (R6E-8): the central audit intent of a dispute change, on its own transaction. Identifiers and codes only (the dispute is the
   * resource; its payment, and the outcome, file or decision); never an amount, evidence content, a receipt or its secret. The event id is
   * derived from (`idOf`, action): written once.
   */
  async recordDispute(q: Queryable, action: DisputeAuditAction, d: { id: string; paymentId: string }, organizationId: string | null, ctx: EventContext,
    extra: { outcome?: 'won' | 'lost'; fileId?: string; grantId?: string; decision?: 'contest' | 'accept' } = {}, idOf: string = d.id): Promise<void> {
    const changes: Record<string, unknown> = { payment_id: d.paymentId };
    if (extra.outcome) changes.outcome = extra.outcome;
    if (extra.fileId) changes.file_id = extra.fileId;
    if (extra.grantId) changes.grant_id = extra.grantId;
    if (extra.decision) changes.decision = extra.decision;
    await this.writer.write(
      q,
      { action, actor: auditActor(ctx), organizationId, resource: { type: 'payment_dispute', id: d.id }, outcome: 'succeeded', changes } as never,
      { eventId: deterministicEventId(idOf, `audit.${action}`), ...(ctx.correlationId && CORRELATION.test(ctx.correlationId) ? { correlationId: ctx.correlationId } : {}) },
    );
  }

  /**
   * Core V2 S6h (R6H-3, R6H-11): the association of an unmatched provider fact, in the association's transaction. Identifiers only (the fact, its
   * destination and the association); never an amount, a provider reference, a receipt or its secret. The event id is derived from the association.
   */
  /** Core V2 S0-C12 item 10: a recorded late success, in its row's transaction, once (its id keys the event). */
  async recordLateSuccess(q: Queryable, l: { id: string; factId: string; attemptId: string; amount: number; paymentStatus: string }, payment: PaymentRow,
    actor: ObservationActor, ctx: EventContext): Promise<void> {
    const matches = l.amount === Number(payment.amount);
    await this.writer.write(
      q,
      { action: 'payment_late_success.recorded' satisfies CaptureAuditAction, actor: { type: 'system', id: actor }, organizationId: payment.organizationId,
        resource: { type: 'payment_late_success', id: l.id }, outcome: 'succeeded',
        changes: { payment_id: payment.id, attempt_id: l.attemptId, fact_id: l.factId, observed_amount: l.amount, payment_status: l.paymentStatus,
          matches_payment: matches } } as never,
      { eventId: deterministicEventId(l.id, 'audit.payment_late_success.recorded'), ...(ctx.correlationId && CORRELATION.test(ctx.correlationId) ? { correlationId: ctx.correlationId } : {}) },
    );
  }

  /** Core V2 S0-C12 items 5, 8, 10: a wrong-amount capture fact, in the fact's own transaction, once (the fact's id keys the event). */
  async recordCaptureMismatch(q: Queryable, f: { factId: string; paymentId: string; attemptId: string; source: 'webhook' | 'status_check'; amount: number },
    reason: CaptureMismatchReason, organizationId: string | null, ctx: EventContext): Promise<void> {
    await this.writer.write(
      q,
      { action: 'payment_capture_mismatch.recorded' satisfies CaptureAuditAction, actor: { type: 'system', id: observationActor(f.source) }, organizationId,
        resource: { type: 'provider_transaction_fact', id: f.factId }, outcome: 'succeeded',
        changes: { payment_id: f.paymentId, attempt_id: f.attemptId, source: f.source, observed_amount: f.amount, reason } } as never,
      { eventId: deterministicEventId(f.factId, 'audit.payment_capture_mismatch.recorded'), ...(ctx.correlationId && CORRELATION.test(ctx.correlationId) ? { correlationId: ctx.correlationId } : {}) },
    );
  }

  /** Core V2 S0-C11 item 8: a contradiction of a recorded capture fact, in the conflict row's transaction, once (its id keys the event). */
  /**
   * Core V2 S0-C13 Part A: in the observation's own transaction, so a failed write leaves the notification retryable, and with an id derived from the
   * observation. Always the verified webhook's, on first delivery or on the retrier's last permitted processing. `disputeId` only when that dispute
   * belongs to this payment: another payment's, possibly another Company's, is never named.
   */
  async recordDisputeConflict(q: Queryable, o: { observationId: string; paymentId: string; attemptId: string; reason: string; kind: string; disputeId: string | null },
    organizationId: string | null, ctx: EventContext): Promise<void> {
    await this.writer.write(
      q,
      { action: 'payment_dispute.conflict_recorded' satisfies DisputeConflictAuditAction, actor: { type: 'system', id: 'payment_webhook' }, organizationId,
        resource: { type: 'payment_dispute_observation', id: o.observationId }, outcome: 'succeeded',
        changes: { payment_id: o.paymentId, attempt_id: o.attemptId, reason: o.reason, notification_kind: o.kind, ...(o.disputeId ? { dispute_id: o.disputeId } : {}) } } as never,
      { eventId: deterministicEventId(o.observationId, 'audit.payment_dispute.conflict_recorded'), ...(ctx.correlationId && CORRELATION.test(ctx.correlationId) ? { correlationId: ctx.correlationId } : {}) },
    );
  }

  async recordFactConflict(q: Queryable, c: { id: string; factId: string; paymentId: string; attemptId: string; refundAttemptId?: string; source: 'webhook' | 'status_check'; amount: number },
    organizationId: string | null, ctx: EventContext): Promise<void> {
    // a provider's observation, recorded by Payment: never attributed to whoever asked for the status read
    const actor = { type: 'system' as const, id: c.source === 'webhook' ? 'payment_webhook' : 'payment_status_read' };
    await this.writer.write(
      q,
      { action: 'provider_fact_conflict.recorded' satisfies ReconciliationAuditAction, actor, organizationId, resource: { type: 'provider_transaction_fact', id: c.factId }, outcome: 'succeeded',
        changes: { conflict_id: c.id, payment_id: c.paymentId, attempt_id: c.attemptId, ...(c.refundAttemptId ? { refund_attempt_id: c.refundAttemptId } : {}), source: c.source,
          observed_amount: c.amount } },
      { eventId: deterministicEventId(c.id, 'audit.provider_fact_conflict.recorded'), ...(ctx.correlationId && CORRELATION.test(ctx.correlationId) ? { correlationId: ctx.correlationId } : {}) },
    );
  }

  async recordAssociation(q: Queryable, a: { id: string; factId: string; targetType: string; paymentId: string; refundAuthorizationId: string | null },
    organizationId: string | null, ctx: EventContext): Promise<void> {
    // the destination's id (the payment, or the refund authorization) as `target_id`: a change key never names an authorization
    const changes: Record<string, unknown> = { target_type: a.targetType, target_id: a.refundAuthorizationId ?? a.paymentId, payment_id: a.paymentId, association_id: a.id };
    await this.writer.write(
      q,
      { action: 'provider_fact.associated' satisfies ReconciliationAuditAction, actor: auditActor(ctx), organizationId, resource: { type: 'provider_transaction_fact', id: a.factId }, outcome: 'succeeded', changes } as never,
      { eventId: deterministicEventId(a.id, 'audit.provider_fact.associated'), ...(ctx.correlationId && CORRELATION.test(ctx.correlationId) ? { correlationId: ctx.correlationId } : {}) },
    );
  }
}

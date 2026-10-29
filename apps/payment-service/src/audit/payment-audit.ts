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
}

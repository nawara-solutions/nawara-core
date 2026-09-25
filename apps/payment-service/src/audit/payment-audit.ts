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
}

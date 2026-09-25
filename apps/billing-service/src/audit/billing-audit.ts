import { Global, Inject, Injectable, Module } from '@nestjs/common';
import { AuditEventWriter, type AuditActor, type AuditChangesOf, type AuditEventInput } from '@nawara/audit-contract';
import { OutboxService, type Queryable } from '@nawara/service-kit';
import { deterministicEventId } from '../common/deterministic-id.js';
import type { TransitionContext } from '../domain/actors.js';

/** The ONE identity of this service as a producer: the outbox relay stamps it as `source`, the audit writer is bound to it. */
export const BILLING_SERVICE_NAME = 'billing-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The kit correlation grammar. A correlation id is navigation only (A33): one outside it is dropped, never a reason to fail a change. */
const CORRELATION = /^[A-Za-z0-9._:-]{8,128}$/;

export type BillingAuditAction =
  | 'subscription.activated' | 'subscription.renewed'
  | 'invoice.issued' | 'invoice.discarded' | 'invoice.paid'
  | 'payment_request.created' | 'payment_request.cancelled'
  | 'product.created' | 'product.archived' | 'price.created' | 'price.retired';

/**
 * The catalog actor of a Billing change, from Billing's own verified attribution (the `TransitionContext` the change already records in
 * `billing_transition`), never from a request value:
 * - a service caller: the authenticated service-token caller;
 * - a user caller: the Auth-verified user, with the kind Auth verified (`userKind`, set by the controller from the identity's admin tier);
 * - the Payment event consumer (`cause: payment_event`) and the reconciler (`cause: reconciliation`): Billing's own processes (A9).
 * Anything else has no catalog actor: a programming error that rolls the change back (no evidence is ever guessed).
 */
export function auditActor(ctx: TransitionContext): AuditActor {
  if (ctx.actor.type === 'service' && ctx.actor.id) return { type: 'service', id: ctx.actor.id };
  if (ctx.actor.type === 'user' && ctx.actor.id && ctx.actor.userKind) return { type: 'user', id: ctx.actor.id, userKind: ctx.actor.userKind };
  if (ctx.actor.type === 'system' && ctx.cause.type === 'payment_event') return { type: 'system', id: 'payment_event_consumer' };
  if (ctx.actor.type === 'system' && ctx.cause.type === 'reconciliation') return { type: 'system', id: 'payment_reconciler' };
  throw new Error(`billing_audit_actor_not_cataloged actor=${ctx.actor.type} cause=${ctx.cause.type}`);
}

/**
 * Central audit intent of Billing's catalog actions (Stage 18.7.2), written through `AuditEventWriter` into the kit outbox ON THE
 * CHANGE'S TRANSACTION (`q`): the change, its `billing_transition` history row (Billing's authority, unchanged) and this evidence copy
 * commit or roll back together. `organizationId` is always the persisted one (the invoice's, the subscription's, the product seller's) —
 * the caller of `record` passes it from rows it just read or wrote, never from a request. A change caused by a Payment event carries that
 * event's id as `causationId`. Event ids derive from the entity and the action (and the revision, for a repeatable one), so a retried
 * change writes its evidence once.
 */
@Injectable()
export class BillingAudit {
  private readonly writer: AuditEventWriter<Queryable>;

  constructor(@Inject(OutboxService) outbox: OutboxService) {
    this.writer = new AuditEventWriter({ sourceService: BILLING_SERVICE_NAME, outbox });
  }

  async record<A extends BillingAuditAction>(
    q: Queryable,
    action: A,
    fact: { organizationId: string | null; resource: { type: string; id: string }; changes?: AuditChangesOf<A>; identity?: string },
    ctx: TransitionContext,
  ): Promise<void> {
    const causationId = ctx.cause.type === 'payment_event' && ctx.cause.id && UUID.test(ctx.cause.id) ? ctx.cause.id : undefined;
    const input = {
      action,
      actor: auditActor(ctx),
      organizationId: fact.organizationId,
      resource: fact.resource,
      outcome: 'succeeded',
      ...(fact.changes ? { changes: fact.changes } : {}),
      ...(causationId ? { causationId } : {}),
    } as unknown as AuditEventInput<A>;
    await this.writer.write(q, input, {
      eventId: deterministicEventId(fact.resource.id, `audit.${action}`, ...(fact.identity ? [fact.identity] : [])),
      ...(ctx.correlationId && CORRELATION.test(ctx.correlationId) ? { correlationId: ctx.correlationId } : {}),
    });
  }
}

/** The seller organization of a product (catalog correction G4): the seller when it is an organization, otherwise null. */
export function sellerOrganization(seller: { sellerType: string; sellerId: string }): string | null {
  return seller.sellerType === 'organization' ? seller.sellerId : null;
}

@Global()
@Module({ providers: [BillingAudit], exports: [BillingAudit] })
export class BillingAuditModule {}

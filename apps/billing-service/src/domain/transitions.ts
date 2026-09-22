import type { Queryable } from '@nawara/service-kit';
import type { TransitionContext } from './actors.js';

export interface TransitionRecord {
  entityType: 'invoice' | 'payment_request' | 'subscription';
  entityId: string;
  from: string | null;
  to: string;
  /** The revision the entity has AFTER the change (creation is 0), exactly as the database set it. */
  revision: number;
  ctx: TransitionContext;
}

/**
 * Writes the Billing-local, append-only history row of a state change (BI-19). It MUST run in the SAME transaction as the change: a status
 * change without its history row cannot commit (a deferred constraint trigger refuses it), and a change with one commits or rolls back with it.
 */
export async function recordTransition(q: Queryable, t: TransitionRecord): Promise<void> {
  await q.query(
    `INSERT INTO billing_transition ("entityType", "entityId", "fromStatus", "toStatus", revision, "actorType", "actorId", "causeType", "causeId", "correlationId")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [t.entityType, t.entityId, t.from, t.to, t.revision, t.ctx.actor.type, t.ctx.actor.id, t.ctx.cause.type, t.ctx.cause.id, t.ctx.correlationId ?? null],
  );
}

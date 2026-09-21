import { Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import type { AuthGrantFacts } from './auth-grants-client.js';
import type { AdminAuthority } from './authorization-evaluator.js';

export interface AdminActorEventInput {
  actor: AuthGrantFacts;
  sessionFamily?: string;
  operation: string;
  targetType: 'company' | 'platform' | 'organization';
  targetId: string | null;
  correlationId?: string;
  outcome: 'succeeded' | 'denied' | 'failed';
  reason?: string;
  authority?: AdminAuthority;
}

/**
 * The durable actor record ADR-0042 decision 9 requires before Organization Service accepts human
 * writers in production: "who, performed what, on which resource, when, with which correlation id,
 * with what result." Append-only (migration 0005; the DB trigger, not this class, is the real
 * enforcement — this class only ever INSERTs). Every mutation AND every denial is recorded.
 *
 * A SUCCESS record is written with the mutation's own transaction (`q`), so the two commit or roll back together: a mutation
 * can never commit without its record, and a record can never exist for a mutation that did not commit. A DENIAL has no
 * mutation to be atomic with and is written on its own statement (`q` omitted); if it cannot be written, the request fails.
 */
@Injectable()
export class ActorRecordService {
  constructor(private readonly db: DbService) {}

  async record(e: AdminActorEventInput, q: Queryable = this.db): Promise<void> {
    await q.query(
      `INSERT INTO admin_actor_event (actor_user_id, actor_kind, session_family, operation, target_type, target_id, correlation_id, outcome, reason, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        e.actor.userId,
        e.actor.kind,
        e.sessionFamily ?? null,
        e.operation,
        e.targetType,
        e.targetId,
        e.correlationId ?? null,
        e.outcome,
        e.reason ?? null,
        JSON.stringify({ authority: e.authority ?? null }),
      ],
    );
  }
}

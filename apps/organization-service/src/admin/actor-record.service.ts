import { Injectable } from '@nestjs/common';
import { DbService } from '@nawara/service-kit';
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
 */
@Injectable()
export class ActorRecordService {
  constructor(private readonly db: DbService) {}

  async record(e: AdminActorEventInput): Promise<void> {
    await this.db.query(
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

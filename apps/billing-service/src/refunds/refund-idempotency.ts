import { Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import { requestHash } from '../domain/canonical.js';
import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';

export type RefundOperation = 'refund_case.open' | 'refund_case.cancel' | 'reconciliation_case.acknowledge'; // + Core V2 S6h-B

export interface RefundCommandResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Core V2 S6a: class-K idempotency (the D-10 pattern of the assistance commands), in `refund_command_idempotency`. One transaction per
 * command holds the effect and the (Owner, Idempotency-Key) record; the same key and command replays the stored outcome; any other command
 * with it is 409 `idempotency_key_conflict`; a refused command stores nothing. Records are permanent.
 */
@Injectable()
export class RefundCommandIdempotency {
  constructor(private readonly db: DbService) {}

  async run(actorUserId: string, key: string, operation: RefundOperation, request: Record<string, unknown>, command: (q: Queryable) => Promise<RefundCommandResult>): Promise<RefundCommandResult & { replayed: boolean }> {
    const hash = requestHash({ operation, request });
    return this.db.tx(async (q) => {
      await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing.refund_command:' || $1 || ':' || $2, 0))`, [actorUserId, key]);
      const stored = (await q.query<{ operation: string; requestHash: string; responseStatus: number; responseBody: Record<string, unknown> }>(
        `SELECT operation, "requestHash", "responseStatus", "responseBody" FROM refund_command_idempotency WHERE "actorUserId" = $1 AND "idempotencyKey" = $2`, [actorUserId, key])).rows[0];
      if (stored) {
        if (stored.operation !== operation || stored.requestHash !== hash) throw billingError(409, 'idempotency_key_conflict', BILLING_MESSAGES.idempotencyKeyConflict);
        return { status: stored.responseStatus, body: stored.responseBody, replayed: true };
      }
      const result = await command(q);
      await q.query(
        `INSERT INTO refund_command_idempotency ("actorUserId", "idempotencyKey", operation, "requestHash", "responseStatus", "responseBody") VALUES ($1, $2, $3, $4, $5, $6)`,
        [actorUserId, key, operation, hash, result.status, JSON.stringify(result.body)],
      );
      return { ...result, replayed: false };
    });
  }
}

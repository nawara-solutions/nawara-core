import { Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import { requestHash } from '../domain/canonical.js';
import { billingError } from '../domain/errors.js';
import { BILLING_MESSAGES } from '../messages.js';

export type AssistanceOperation =
  | 'assistance_request.create' | 'assistance_request.decline' | 'assistance_request.cash_collection'
  // Core V2 S5b: the settlement is a money command (class M, E-1): its record is never deleted either (permanent, >= the approved 90 days)
  | 'assistance_request.settlement' | 'cash_return_obligation.return'
  // Core V2 S5c (H-7): class K, permanent
  | 'cash_return_obligation.confirm' | 'assistance_request.dispute' | 'assistance_dispute.respond' | 'assistance_request.correct' | 'assistance_dispute.resolve';

export interface AssistanceCommandResult {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Core V2 S5a (D-10: class K, the S3f fee-command pattern). One transaction per command: the (actor, Idempotency-Key) record is written
 * with the command's own effect, so they commit or roll back together. The same actor and key with the SAME command (operation, path and
 * body) answers the stored outcome again (`replayed`), whatever has changed since; anything else is 409 `idempotency_key_conflict`. A
 * refused command stores nothing (a retry is evaluated afresh). Concurrent uses of one key are serialized by a transaction-scoped
 * advisory lock, so one effect only. Records are never deleted: retention is permanent (>= the approved 90 days).
 */
@Injectable()
export class AssistanceCommandIdempotency {
  constructor(private readonly db: DbService) {}

  /**
   * Core V2 S5c: the stored outcome of this actor's key for exactly this command, or null when the key is unused; 409
   * `idempotency_key_conflict` for another command. Read BEFORE an Owner's step-up is spent, so a replay never consumes a fresh proof.
   * `run` re-checks under the key lock, so a concurrent first use still yields one effect.
   */
  async stored(actorUserId: string, key: string, operation: AssistanceOperation, request: Record<string, unknown>): Promise<(AssistanceCommandResult & { replayed: true }) | null> {
    const { rows } = await this.db.query<{ operation: string; requestHash: string; responseStatus: number; responseBody: Record<string, unknown> }>(
      `SELECT operation, "requestHash", "responseStatus", "responseBody" FROM assistance_command_idempotency WHERE "actorUserId" = $1 AND "idempotencyKey" = $2`,
      [actorUserId, key],
    );
    const stored = rows[0];
    if (!stored) return null;
    if (stored.operation !== operation || stored.requestHash !== requestHash({ operation, request })) throw billingError(409, 'idempotency_key_conflict', BILLING_MESSAGES.idempotencyKeyConflict);
    return { status: stored.responseStatus, body: stored.responseBody, replayed: true };
  }

  async run(
    actorUserId: string,
    key: string,
    operation: AssistanceOperation,
    request: Record<string, unknown>,
    command: (q: Queryable) => Promise<AssistanceCommandResult>,
  ): Promise<AssistanceCommandResult & { replayed: boolean }> {
    const hash = requestHash({ operation, request });
    return this.db.tx(async (q) => {
      await q.query(`SELECT pg_advisory_xact_lock(hashtextextended('billing.assistance_command:' || $1 || ':' || $2, 0))`, [actorUserId, key]);
      const { rows } = await q.query<{ operation: string; requestHash: string; responseStatus: number; responseBody: Record<string, unknown> }>(
        `SELECT operation, "requestHash", "responseStatus", "responseBody" FROM assistance_command_idempotency WHERE "actorUserId" = $1 AND "idempotencyKey" = $2`,
        [actorUserId, key],
      );
      const stored = rows[0];
      if (stored) {
        if (stored.operation !== operation || stored.requestHash !== hash) throw billingError(409, 'idempotency_key_conflict', BILLING_MESSAGES.idempotencyKeyConflict);
        return { status: stored.responseStatus, body: stored.responseBody, replayed: true };
      }
      const result = await command(q);
      await q.query(
        `INSERT INTO assistance_command_idempotency ("actorUserId", "idempotencyKey", operation, "requestHash", "responseStatus", "responseBody") VALUES ($1, $2, $3, $4, $5, $6)`,
        [actorUserId, key, operation, hash, result.status, JSON.stringify(result.body)],
      );
      return { ...result, replayed: false };
    });
  }
}

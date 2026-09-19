import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import { paymentError } from '../errors.js';

export type ReserveResult = { replay: false } | { replay: true; responseStatus: number; resourceId: string };

/** Header-based idempotency (SDD section 4.7, 6) for operations without a natural key. */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  static requestHash(operation: string, resourcePath: string, body: unknown): string {
    return createHash('sha256').update(JSON.stringify({ operation, resourcePath, body })).digest('hex');
  }

  /**
   * Call inside the SAME transaction as the operation, before doing any state-changing work. Uses a SAVEPOINT
   * (Postgres aborts the whole transaction on the first failed statement, so a bare try/catch can't recover in
   * the same transaction) so the caller's own transaction is still usable afterward either way.
   */
  async reserve(
    q: Queryable,
    params: { caller: string; operation: string; key: string; requestHash: string; responseStatus: number; resourceType: string; resourceId: string; ttlHours: number },
  ): Promise<ReserveResult> {
    await q.query('SAVEPOINT idempotency_reserve');
    try {
      await q.query(
        `INSERT INTO idempotency_key(caller, operation, key, "requestHash", "responseStatus", "resourceType", "resourceId", "expiresAt")
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(hours => $8))`,
        [params.caller, params.operation, params.key, params.requestHash, params.responseStatus, params.resourceType, params.resourceId, params.ttlHours],
      );
      return { replay: false };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      await q.query('ROLLBACK TO SAVEPOINT idempotency_reserve');
      const { rows } = await q.query<{ requestHash: string; responseStatus: number; resourceId: string }>(
        `SELECT "requestHash", "responseStatus", "resourceId" FROM idempotency_key WHERE caller = $1 AND operation = $2 AND key = $3`,
        [params.caller, params.operation, params.key],
      );
      const existing = rows[0];
      if (existing.requestHash !== params.requestHash) {
        throw paymentError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
      }
      return { replay: true, responseStatus: existing.responseStatus, resourceId: existing.resourceId };
    }
  }
}

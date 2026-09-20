import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import { organizationError } from '../domain/errors.js';

export type IdempotentOperation = 'company.create' | 'platform.create' | 'organization.create';
export type ReserveResult = { replay: false } | { replay: true; resourceId: string };

const KEY = /^[A-Za-z0-9._:-]{8,128}$/;

/** `Idempotency-Key` is required on every resource-creating POST (ADR-0034): these entities have no natural key to fall back on. */
export function requireIdempotencyKey(header: string | undefined): string {
  if (typeof header !== 'string' || !KEY.test(header)) {
    throw organizationError(400, 'idempotency_key_required', 'A valid Idempotency-Key header (8 to 128 characters of A-Z a-z 0-9 . _ : -) is required.');
  }
  return header;
}

/** Header-based idempotency for the three creates. Same pattern as payment-service's, scoped to (calling service, operation, key). */
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DbService) private readonly db: DbService) {}

  static requestHash(operation: IdempotentOperation, body: unknown): string {
    return createHash('sha256').update(JSON.stringify({ operation, body })).digest('hex');
  }

  /**
   * Call inside the SAME transaction as the create, before any state-changing work: the key and the resource commit together or
   * not at all (a create that fails, for example on a missing parent, does not consume its key). A SAVEPOINT lets the caller's
   * transaction survive the unique violation on a replay. A concurrent request with the same key blocks on the unique index until
   * the first commits, then replays.
   */
  async reserve(q: Queryable, p: { caller: string; operation: IdempotentOperation; key: string; requestHash: string; resourceId: string }): Promise<ReserveResult> {
    await q.query('SAVEPOINT idempotency_reserve');
    try {
      await q.query(`INSERT INTO idempotency_key(caller, operation, key, "requestHash", "resourceId") VALUES ($1,$2,$3,$4,$5)`, [
        p.caller, p.operation, p.key, p.requestHash, p.resourceId,
      ]);
      return { replay: false };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      await q.query('ROLLBACK TO SAVEPOINT idempotency_reserve');
      const { rows } = await q.query<{ requestHash: string; resourceId: string }>(
        `SELECT "requestHash", "resourceId" FROM idempotency_key WHERE caller = $1 AND operation = $2 AND key = $3`,
        [p.caller, p.operation, p.key],
      );
      const existing = rows[0];
      if (!existing) throw e;
      if (existing.requestHash !== p.requestHash) {
        throw organizationError(422, 'idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
      }
      return { replay: true, resourceId: existing.resourceId };
    }
  }
}

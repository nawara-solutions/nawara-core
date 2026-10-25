import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import type { EvidenceGrantee, EvidencePurpose } from '../grants/evidence-purposes.js';
import type { FileRow, FileScope } from './file.repository.js';

/** OD-FILE F3: an explicit lifetime, 24 hours by default, at most 7 days (the schema enforces the same ceiling); never extended. */
export const GRANT_LIFETIME_DEFAULT_SECONDS = 24 * 3600;
export const GRANT_LIFETIME_MIN_SECONDS = 60;
export const GRANT_LIFETIME_MAX_SECONDS = 7 * 24 * 3600;

/** A `file_evidence_grant` row WITHOUT its idempotency data, plus `active` on the DATABASE clock (not revoked, not expired). */
export interface GrantRow {
  id: string;
  fileId: string;
  grantorService: string;
  granteeService: EvidenceGrantee;
  purpose: EvidencePurpose;
  caseRef: string;
  organizationId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  active: boolean;
}

const COLUMNS = `id, "fileId", "grantorService", "granteeService", purpose, "caseRef", "organizationId", "expiresAt", "revokedAt", "createdAt",
  ("revokedAt" IS NULL AND "expiresAt" > now()) AS active`;

/** The same columns, qualified, for a statement that joins `file`. */
const G_COLUMNS = `g.id, g."fileId", g."grantorService", g."granteeService", g.purpose, g."caseRef", g."organizationId", g."expiresAt",
  g."revokedAt", g."createdAt", (g."revokedAt" IS NULL AND g."expiresAt" > now()) AS active`;

export interface NewGrant {
  /** The grantor (the authenticated owner service) and the presented organization, exactly as for `FileRepository.findOwned`. */
  scope: FileScope;
  fileId: string;
  purpose: EvidencePurpose;
  granteeService: EvidenceGrantee;
  caseRef: string;
  lifetimeSeconds: number;
  idempotencyKey: string;
  requestHash: string;
}

export type IssueOutcome =
  | { kind: 'created'; grant: GrantRow }
  /** The grantor already used this Idempotency-Key: the recorded grant and its request hash (the caller tells a replay from a reuse). */
  | { kind: 'existing'; grant: GrantRow; requestHash: string }
  | { kind: 'not_found' } // not the grantor's file in that organization (or not a file at all): one answer
  | { kind: 'not_grantable'; file: FileRow }; // the grantor's file, but not AVAILABLE and attached

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function revive(raw: Record<string, unknown>): GrantRow {
  const g = raw as unknown as GrantRow & Record<string, unknown>;
  for (const k of ['expiresAt', 'revokedAt', 'createdAt'] as const) if (g[k] !== null) (g as Record<string, unknown>)[k] = new Date(g[k] as unknown as string);
  return g;
}

/**
 * The only writer and reader of `file_evidence_grant` (Core V2 S2-File.1, OD-FILE F1 to F3). Issuance and revocation are scoped to the
 * grantor (the authenticated owner service) and its presented organization: another service's grant, another organization's grant and a
 * missing grant are the same `undefined`. The schema re-checks every binding (owner, organization, AVAILABLE and attached, purpose and
 * grantee, lifetime) and keeps the row immutable except for its one revocation.
 */
@Injectable()
export class GrantRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Issues a grant, idempotently per (grantor, Idempotency-Key), in ONE transaction with `onCreated` (the audit intent), which runs only
   * when THIS call created the row. A key already used answers the recorded grant whatever its file's state now (a lost response is
   * recovered, never re-issued). Otherwise the file row is locked (`FOR SHARE`, serialized with a deletion request) and checked; a
   * concurrent issuance with the same key waits on the unique index and answers the winner's grant.
   */
  async issue(input: NewGrant, onCreated: (q: Queryable, grant: GrantRow) => Promise<void>): Promise<IssueOutcome> {
    if (!Number.isInteger(input.lifetimeSeconds) || input.lifetimeSeconds < GRANT_LIFETIME_MIN_SECONDS || input.lifetimeSeconds > GRANT_LIFETIME_MAX_SECONDS) {
      throw new Error(`a grant lives ${GRANT_LIFETIME_MIN_SECONDS}-${GRANT_LIFETIME_MAX_SECONDS} seconds`);
    }
    return this.db.tx(async (q) => {
      const existing = await this.byKey(q, input.scope.ownerService, input.idempotencyKey);
      if (existing) return existing;
      if (!UUID.test(input.fileId)) return { kind: 'not_found' };
      const { rows: files } = await q.query<FileRow>(
        `SELECT * FROM file WHERE id = $1 AND "ownerService" = $2 AND "organizationId" IS NOT DISTINCT FROM $3 FOR SHARE`,
        [input.fileId, input.scope.ownerService, input.scope.organizationId],
      );
      const file = files[0];
      if (!file) return { kind: 'not_found' };
      if (file.status !== 'AVAILABLE' || file.attachedAt === null) return { kind: 'not_grantable', file };
      const { rows } = await q.query<Record<string, unknown>>(
        `INSERT INTO file_evidence_grant (id, "fileId", "grantorService", "granteeService", purpose, "caseRef", "organizationId", "idempotencyKey",
           "requestHash", "expiresAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))
         ON CONFLICT ("grantorService", "idempotencyKey") DO NOTHING
         RETURNING ${COLUMNS}`,
        [randomUUID(), file.id, input.scope.ownerService, input.granteeService, input.purpose, input.caseRef, file.organizationId,
          input.idempotencyKey, input.requestHash, input.lifetimeSeconds],
      );
      if (!rows[0]) return (await this.byKey(q, input.scope.ownerService, input.idempotencyKey))!; // a concurrent issuance won
      const grant = revive(rows[0]);
      await onCreated(q, grant);
      return { kind: 'created', grant };
    });
  }

  /**
   * Revokes one of the grantor's grants in that organization, in ONE transaction with `onRevoked` (the audit intent), which runs only on
   * the active → revoked transition. Idempotent: an already revoked grant answers with its first revocation and writes nothing. An
   * expired grant can still be revoked (it records the grantor's decision; nothing it allowed changes).
   */
  async revoke(scope: FileScope, id: string, onRevoked: (q: Queryable, grant: GrantRow) => Promise<void>): Promise<{ grant: GrantRow; revoked: boolean } | undefined> {
    if (!UUID.test(id)) return undefined;
    return this.db.tx(async (q) => {
      const { rows } = await q.query<Record<string, unknown>>(
        `UPDATE file_evidence_grant SET "revokedAt" = now()
         WHERE id = $1 AND "grantorService" = $2 AND "organizationId" IS NOT DISTINCT FROM $3 AND "revokedAt" IS NULL
         RETURNING ${COLUMNS}`,
        [id, scope.ownerService, scope.organizationId],
      );
      if (rows[0]) {
        const grant = revive(rows[0]);
        await onRevoked(q, grant);
        return { grant, revoked: true };
      }
      const current = await q.query<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM file_evidence_grant WHERE id = $1 AND "grantorService" = $2 AND "organizationId" IS NOT DISTINCT FROM $3`,
        [id, scope.ownerService, scope.organizationId],
      );
      return current.rows[0] ? { grant: revive(current.rows[0]), revoked: false } : undefined;
    });
  }

  /**
   * The validation foundation of granted reads (S2-File.2; no route uses it yet): the grant, only when it is usable NOW by exactly this
   * grantee for exactly this purpose: not revoked, not expired (database clock), and its file still AVAILABLE, still the grantor's, in
   * the grant's organization. Anything else is the same `undefined`. `FOR SHARE` (inside the caller's transaction) holds off a concurrent
   * revocation until the use commits.
   */
  async findUsable(id: string, granteeService: string, purpose: EvidencePurpose, q: Queryable = this.db): Promise<GrantRow | undefined> {
    if (!UUID.test(id)) return undefined;
    const { rows } = await q.query<Record<string, unknown>>(
      `SELECT ${G_COLUMNS} FROM file_evidence_grant g
       JOIN file f ON f.id = g."fileId" AND f."ownerService" = g."grantorService" AND f."organizationId" IS NOT DISTINCT FROM g."organizationId"
       WHERE g.id = $1 AND g."granteeService" = $2 AND g.purpose = $3 AND g."revokedAt" IS NULL AND g."expiresAt" > now() AND f.status = 'AVAILABLE'
       FOR SHARE OF g`,
      [id, granteeService, purpose],
    );
    return rows[0] ? revive(rows[0]) : undefined;
  }

  private async byKey(q: Queryable, grantor: string, key: string): Promise<IssueOutcome | undefined> {
    const { rows } = await q.query<Record<string, unknown>>(
      `SELECT ${COLUMNS}, "requestHash" FROM file_evidence_grant WHERE "grantorService" = $1 AND "idempotencyKey" = $2`,
      [grantor, key],
    );
    if (!rows[0]) return undefined;
    const { requestHash, ...grant } = rows[0];
    return { kind: 'existing', grant: revive(grant), requestHash: requestHash as string };
  }
}

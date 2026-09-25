import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import { FILE_MEDIA_TYPES, type FileMediaType } from '../policy/media-types.js';
import type { FileRow, FileScope } from './file.repository.js';
import { FilePersistenceError } from './persistence-error.js';
import { assertTicketDigest, type TicketDigest } from './ticket-digest.js';

/** The frozen ticket lifetime bounds (F16: 60–300 s; the default is chosen in 17.6). The schema enforces the same bounds. */
export const TICKET_LIFETIME_MIN_SECONDS = 60;
export const TICKET_LIFETIME_MAX_SECONDS = 300;

export type TicketOperation = 'download' | 'upload';

/**
 * A `file_access_ticket` row WITHOUT its digest: the digest is only ever a lookup key inside a statement, so it cannot reach a log or a
 * response through a returned row.
 */
export interface TicketRow {
  id: string;
  operation: TicketOperation;
  fileId: string | null;
  issuedBy: string;
  organizationId: string | null;
  disposition: 'attachment' | 'inline' | null;
  maxBytes: string | null;
  mediaTypes: FileMediaType[] | null;
  attach: boolean | null;
  singleUse: boolean;
  useCount: number;
  usedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

const COLUMNS = `id, operation, "fileId", "issuedBy", "organizationId", disposition, "maxBytes", "mediaTypes", attach, "singleUse",
  "useCount", "usedAt", "revokedAt", "expiresAt", "createdAt"`;

export interface NewDownloadTicket {
  /** The issuer (the authenticated owner) and the file's organization, exactly as for `FileRepository.findOwned`. */
  scope: FileScope;
  fileId: string;
  tokenDigest: TicketDigest;
  lifetimeSeconds: number;
  singleUse: boolean;
  disposition: 'attachment' | 'inline';
}

export interface NewUploadTicket {
  scope: FileScope;
  tokenDigest: TicketDigest;
  lifetimeSeconds: number;
  maxBytes: number;
  mediaTypes: readonly FileMediaType[];
  /** Attach the created file on completion (SDD §3). */
  attach: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** JSON rows (to_jsonb) carry timestamps as strings: restore the Date fields of the row types. */
function reviveTicket(raw: Record<string, unknown>): TicketRow {
  const t = raw as unknown as TicketRow & Record<string, unknown>;
  for (const k of ['usedAt', 'revokedAt', 'expiresAt', 'createdAt'] as const) if (t[k] !== null) (t as Record<string, unknown>)[k] = new Date(t[k] as unknown as string);
  if (t.maxBytes !== null) t.maxBytes = String(t.maxBytes);
  return t;
}

function reviveFile(raw: Record<string, unknown>): FileRow {
  const f = raw as unknown as FileRow & Record<string, unknown>;
  for (const k of ['uploadExpiresAt', 'attachDeadline', 'attachedAt', 'createdAt', 'availableAt', 'deletionRequestedAt', 'deletedAt', 'updatedAt'] as const) {
    if (f[k] !== null) (f as Record<string, unknown>)[k] = new Date(f[k] as unknown as string);
  }
  if (f.sizeBytes !== null) f.sizeBytes = String(f.sizeBytes);
  return f;
}

function checkLifetime(seconds: number): void {
  if (!Number.isInteger(seconds) || seconds < TICKET_LIFETIME_MIN_SECONDS || seconds > TICKET_LIFETIME_MAX_SECONDS) {
    throw new Error(`a ticket lives ${TICKET_LIFETIME_MIN_SECONDS}-${TICKET_LIFETIME_MAX_SECONDS} seconds`);
  }
}

/**
 * The only writer and reader of `file_access_ticket` (SDD §11.1, F35 / F36). Stage 17.3 persists tickets; the token generation, the
 * issue and redemption routes and the file-status and caller-policy checks of a redemption are 17.5 / 17.6.
 *
 * Every lookup is by digest (redemption) or scoped to the issuer (revocation). No operation reveals WHY a ticket is unusable: an
 * unknown, expired, revoked or used-up ticket is the same `undefined`, answered later as one `ticket_invalid`.
 */
@Injectable()
export class TicketRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Records a download ticket for a file the issuer owns in that organization, or returns `undefined` when there is no such file
   * (the same answer as a missing file). The ownership check and the insert are ONE statement (no read-then-write gap); the schema
   * re-checks the binding.
   */
  async recordDownload(input: NewDownloadTicket, q: Queryable = this.db): Promise<TicketRow | undefined> {
    assertTicketDigest(input.tokenDigest);
    checkLifetime(input.lifetimeSeconds);
    if (!UUID.test(input.fileId)) return undefined;
    return this.insert(q,
      `INSERT INTO file_access_ticket (id, operation, "fileId", "issuedBy", "organizationId", "tokenDigest", disposition, "singleUse", "expiresAt")
       SELECT $1, 'download', f.id, f."ownerService", f."organizationId", $5, $6, $7, now() + make_interval(secs => $8)
       FROM file f WHERE f.id = $2 AND f."ownerService" = $3 AND f."organizationId" IS NOT DISTINCT FROM $4
       RETURNING ${COLUMNS}`,
      [randomUUID(), input.fileId, input.scope.ownerService, input.scope.organizationId, input.tokenDigest, input.disposition,
        input.singleUse, input.lifetimeSeconds]);
  }

  /** Records a single-use upload ticket: one intent (organization, size limit, types, attach flag), no file yet. */
  async recordUpload(input: NewUploadTicket, q: Queryable = this.db): Promise<TicketRow> {
    assertTicketDigest(input.tokenDigest);
    checkLifetime(input.lifetimeSeconds);
    if (input.mediaTypes.length === 0 || input.mediaTypes.some((t) => !(FILE_MEDIA_TYPES as readonly string[]).includes(t))) {
      throw new Error('an upload ticket names one or more allow-listed media types');
    }
    const row = await this.insert(q,
      `INSERT INTO file_access_ticket (id, operation, "issuedBy", "organizationId", "tokenDigest", "maxBytes", "mediaTypes", attach, "singleUse", "expiresAt")
       VALUES ($1, 'upload', $2, $3, $4, $5, $6, $7, true, now() + make_interval(secs => $8))
       RETURNING ${COLUMNS}`,
      [randomUUID(), input.scope.ownerService, input.scope.organizationId, input.tokenDigest, input.maxBytes, [...input.mediaTypes],
        input.attach, input.lifetimeSeconds]);
    return row!;
  }

  /**
   * Claims one use of a ticket, atomically: the conditions (not revoked, not expired on the database clock, not used up when
   * single-use) and the increment are ONE conditional UPDATE. Two concurrent claims of a single-use ticket serialize on the row lock
   * and PostgreSQL re-evaluates the condition for the second, so exactly one wins (READ COMMITTED is enough; no read-then-write).
   *
   * `undefined` for every unusable case alike. The redemption (17.6 / 17.5) then checks what lives outside the ticket: the file
   * (`FileRepository.findOwned` with the ticket's bindings; `AVAILABLE` for a download) and the issuer's current policy.
   */
  async claimUse(tokenDigest: TicketDigest, operation: TicketOperation, q: Queryable = this.db): Promise<TicketRow | undefined> {
    assertTicketDigest(tokenDigest);
    const { rows } = await q.query<TicketRow>(
      `UPDATE file_access_ticket SET "useCount" = "useCount" + 1, "usedAt" = COALESCE("usedAt", now())
       WHERE "tokenDigest" = $1 AND operation = $2 AND "revokedAt" IS NULL AND "expiresAt" > now() AND (NOT "singleUse" OR "useCount" = 0)
       RETURNING ${COLUMNS}`,
      [tokenDigest, operation],
    );
    return rows[0];
  }

  /**
   * Records the ONE file an upload ticket created (Stage 17.5), in the claim's transaction. The schema re-checks that the file is the
   * issuer's in the ticket's organization and that it is recorded once.
   */
  async bindCreatedFile(q: Queryable, ticketId: string, fileId: string): Promise<void> {
    const { rowCount } = await q.query(
      `UPDATE file_access_ticket SET "fileId" = $2 WHERE id = $1 AND operation = 'upload' AND "fileId" IS NULL`,
      [ticketId, fileId],
    );
    if (rowCount !== 1) throw new Error('upload ticket already bound to a file');
  }

  /**
   * An upload ticket that was ALREADY used and has created its file, while still valid (not revoked, not expired): the retry of a
   * completed redemption returns that file (SDD §11.1). Never consumes anything.
   */
  async findUsedUpload(tokenDigest: TicketDigest, q: Queryable = this.db): Promise<TicketRow | undefined> {
    assertTicketDigest(tokenDigest);
    const { rows } = await q.query<TicketRow>(
      `SELECT ${COLUMNS} FROM file_access_ticket
       WHERE "tokenDigest" = $1 AND operation = 'upload' AND "revokedAt" IS NULL AND "expiresAt" > now() AND "fileId" IS NOT NULL`,
      [tokenDigest],
    );
    return rows[0];
  }

  /**
   * Stage 17.6: claims one use of a DOWNLOAD ticket and returns it with its file, atomically. One statement checks the ticket (operation,
   * not revoked, not expired, not used up when single-use) AND its file (the bound file, still `AVAILABLE`, still the issuer's in the
   * ticket's organization): a ticket never outlives its file's availability, and a file leaving `AVAILABLE` is never served through
   * an old ticket. `undefined` for every refusal alike (`ticket_invalid`). A reusable ticket counts each use; a single-use ticket is
   * claimed once (concurrent claims serialize on the ticket row).
   */
  async claimDownload(tokenDigest: TicketDigest, q: Queryable = this.db): Promise<{ ticket: TicketRow; file: FileRow } | undefined> {
    assertTicketDigest(tokenDigest);
    const { rows } = await q.query<{ ticket: Record<string, unknown>; file: Record<string, unknown> }>(
      `WITH claimed AS (
         UPDATE file_access_ticket t SET "useCount" = t."useCount" + 1, "usedAt" = COALESCE(t."usedAt", now())
         FROM file f
         WHERE t."tokenDigest" = $1 AND t.operation = 'download' AND t."revokedAt" IS NULL AND t."expiresAt" > now()
           AND (NOT t."singleUse" OR t."useCount" = 0)
           AND f.id = t."fileId" AND f.status = 'AVAILABLE' AND f."ownerService" = t."issuedBy"
           AND f."organizationId" IS NOT DISTINCT FROM t."organizationId"
         RETURNING t.id, t.operation, t."fileId", t."issuedBy", t."organizationId", t.disposition, t."maxBytes", t."mediaTypes", t.attach,
           t."singleUse", t."useCount", t."usedAt", t."revokedAt", t."expiresAt", t."createdAt", to_jsonb(f.*) AS file
       )
       SELECT to_jsonb(claimed.*) - 'file' AS ticket, claimed.file AS file FROM claimed`,
      [tokenDigest],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { ticket: reviveTicket(row.ticket), file: reviveFile(row.file) };
  }

  /**
   * Revokes one of the owner's tickets (Stage 17.6 route): the issuer AND the ticket's organization must match. `true` when it has that
   * ticket (revoking twice is the same success: the first stamp stays); `false` for an unknown ticket, another issuer's or another
   * organization's, indistinguishably. Revocation stops FUTURE redemptions; a stream authorized before the commit may complete.
   */
  async revoke(scope: FileScope, ticketId: string, q: Queryable = this.db): Promise<boolean> {
    if (!UUID.test(ticketId)) return false;
    const { rows } = await q.query(
      `UPDATE file_access_ticket SET "revokedAt" = COALESCE("revokedAt", now())
       WHERE id = $1 AND "issuedBy" = $2 AND "organizationId" IS NOT DISTINCT FROM $3 RETURNING id`,
      [ticketId, scope.ownerService, scope.organizationId],
    );
    return rows.length === 1;
  }

  /**
   * Revokes every live ticket of a file. Takes the caller's transaction on purpose: the logical deletion (17.7) runs it in the SAME
   * transaction as the file's move to `DELETING`, so the tickets die with the file or not at all (SDD §11.1).
   */
  async revokeAllForFile(q: Queryable, fileId: string): Promise<number> {
    const { rowCount } = await q.query(
      `UPDATE file_access_ticket SET "revokedAt" = now() WHERE "fileId" = $1 AND "revokedAt" IS NULL`,
      [fileId],
    );
    return rowCount ?? 0;
  }

  private async insert(q: Queryable, sql: string, params: unknown[]): Promise<TicketRow | undefined> {
    try {
      return (await q.query<TicketRow>(sql, params)).rows[0];
    } catch (e) {
      if (isUniqueViolation(e, 'file_access_ticket_token_digest_unique')) throw new FilePersistenceError('ticket_digest_collision');
      throw e;
    }
  }
}

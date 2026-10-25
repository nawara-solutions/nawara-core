import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import { FILE_MEDIA_TYPES, type FileMediaType } from '../policy/media-types.js';
import { reviveFileRow, type FileRow, type FileScope } from './file.repository.js';
import { reviveGrantRow, type GrantRow } from './grant.repository.js';
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
  /** S2-File.2: the evidence grant a download ticket was issued from (its issuer is then the grantee), or null for an owner's ticket. */
  grantId: string | null;
  /** S2-File.4: a single-use download ticket's redemption (null: unused, or a multi-use / upload ticket). */
  redemption: TicketRedemption | null;
  leaseId: string | null;
  leaseUntil: Date | null;
}

/** S2-File.4: the redemption states of a single-use download ticket (migration 0007). */
export type TicketRedemption = 'reserved' | 'committed' | 'uncertain';

/** A settled (or settling) reservation, with the grant of a grant ticket (for its record). */
export interface LeasedTicket {
  ticket: TicketRow;
  grant?: GrantRow;
}

const COLUMNS = `id, operation, "fileId", "issuedBy", "organizationId", disposition, "maxBytes", "mediaTypes", attach, "singleUse",
  "useCount", "usedAt", "revokedAt", "expiresAt", "createdAt", "grantId", redemption, "leaseId", "leaseUntil"`;

/** S2-File.4: a settled ticket row `s` (never its digest) and, for a grant ticket, its grant without the idempotency data. */
const SETTLED = `SELECT to_jsonb(s.*) - 'tokenDigest' AS ticket,
  (SELECT to_jsonb(g.*) - 'idempotencyKey' - 'requestHash' FROM file_evidence_grant g WHERE g.id = s."grantId") AS grant FROM s`;

export interface NewDownloadTicket {
  /** The issuer (the authenticated owner) and the file's organization, exactly as for `FileRepository.findOwned`. */
  scope: FileScope;
  fileId: string;
  tokenDigest: TicketDigest;
  lifetimeSeconds: number;
  singleUse: boolean;
  disposition: 'attachment' | 'inline';
}

/** S2-File.2: a download ticket issued by a grantee from its evidence grant. */
export interface NewGrantDownloadTicket {
  grantId: string;
  fileId: string;
  /** The grantee (the authenticated caller); the grant must name it. */
  granteeService: string;
  tokenDigest: TicketDigest;
  /** The configured ticket lifetime; the ticket ends earlier when its grant does. */
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
  for (const k of ['usedAt', 'revokedAt', 'expiresAt', 'createdAt', 'leaseUntil'] as const) if (t[k] !== null && t[k] !== undefined) (t as Record<string, unknown>)[k] = new Date(t[k] as unknown as string);
  if (t.maxBytes !== null) t.maxBytes = String(t.maxBytes);
  return t;
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
   * Records a download ticket for an AVAILABLE file the issuer owns in that organization, or returns `undefined` otherwise (the same
   * answer as a missing file). The check and the insert are ONE statement (no read-then-write gap); the schema re-checks the binding.
   * Stage 17.7: `FOR SHARE` on the file row serializes it with a deletion (which updates the row): a ticket either commits before the
   * deletion (which then revokes it) or sees the file DELETING and is not created.
   */
  async recordDownload(input: NewDownloadTicket, q: Queryable = this.db): Promise<TicketRow | undefined> {
    assertTicketDigest(input.tokenDigest);
    checkLifetime(input.lifetimeSeconds);
    if (!UUID.test(input.fileId)) return undefined;
    return this.insert(q,
      `INSERT INTO file_access_ticket (id, operation, "fileId", "issuedBy", "organizationId", "tokenDigest", disposition, "singleUse", "expiresAt")
       SELECT $1, 'download', f.id, f."ownerService", f."organizationId", $5, $6, $7, now() + make_interval(secs => $8)
       FROM file f WHERE f.id = $2 AND f."ownerService" = $3 AND f."organizationId" IS NOT DISTINCT FROM $4 AND f.status = 'AVAILABLE'
       FOR SHARE OF f
       RETURNING ${COLUMNS}`,
      [randomUUID(), input.fileId, input.scope.ownerService, input.scope.organizationId, input.tokenDigest, input.disposition,
        input.singleUse, input.lifetimeSeconds]);
  }

  /**
   * S2-File.2: records a download ticket from an evidence grant, or `undefined` when the grant (named for this grantee and file, active)
   * or its file (AVAILABLE, the grantor's, in the grant's organization) does not hold, or when the grant ends within the minimum ticket
   * lifetime. The ticket expires at the earlier of its own lifetime and the grant's expiry: a ticket never extends a grant. One
   * statement under `FOR SHARE` of the grant and the file (a revocation or a deletion waits for it, then revokes the ticket); the schema
   * re-checks the binding.
   */
  async recordGrantDownload(input: NewGrantDownloadTicket, q: Queryable = this.db): Promise<TicketRow | undefined> {
    assertTicketDigest(input.tokenDigest);
    checkLifetime(input.lifetimeSeconds);
    if (!UUID.test(input.grantId) || !UUID.test(input.fileId)) return undefined;
    return this.insert(q,
      `INSERT INTO file_access_ticket (id, operation, "fileId", "issuedBy", "organizationId", "tokenDigest", disposition, "singleUse", "expiresAt", "grantId")
       SELECT $1, 'download', f.id, g."granteeService", g."organizationId", $5, $6, $7, LEAST(now() + make_interval(secs => $8), g."expiresAt"), g.id
       FROM file_evidence_grant g
       JOIN file f ON f.id = g."fileId" AND f."ownerService" = g."grantorService" AND f."organizationId" IS NOT DISTINCT FROM g."organizationId"
       WHERE g.id = $2 AND g."fileId" = $3 AND g."granteeService" = $4 AND g."revokedAt" IS NULL
         AND g."expiresAt" >= now() + make_interval(secs => $9) AND f.status = 'AVAILABLE'
       FOR SHARE OF g, f
       RETURNING ${COLUMNS}`,
      [randomUUID(), input.grantId, input.fileId, input.granteeService, input.tokenDigest, input.disposition, input.singleUse,
        input.lifetimeSeconds, TICKET_LIFETIME_MIN_SECONDS]);
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
   * claimed once (concurrent claims serialize on the ticket row). Stage 17.8: at most `maxUses` claims of any ticket (the reusable
   * download cap, F32), enforced by the same conditional UPDATE, so concurrent claims can never exceed it.
   */
  async claimDownload(tokenDigest: TicketDigest, q: Queryable = this.db, maxUses = 2_147_483_647, leaseSeconds = 60): Promise<{ ticket: TicketRow; file: FileRow; grant?: GrantRow } | undefined> {
    assertTicketDigest(tokenDigest);
    if (!Number.isSafeInteger(maxUses) || maxUses < 1) throw new Error('maxUses must be a positive integer');
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 60) throw new Error('a lease lasts 1-60 seconds');
    const { rows } = await q.query<{ ticket: Record<string, unknown>; file: Record<string, unknown>; grant: Record<string, unknown> | null }>(
      `WITH claimed AS (
         UPDATE file_access_ticket t SET
           -- S2-File.4: a single-use ticket is RESERVED (its use is counted when the reservation settles); a reusable one counts now.
           "useCount" = CASE WHEN t."singleUse" THEN t."useCount" ELSE t."useCount" + 1 END,
           "usedAt" = CASE WHEN t."singleUse" THEN t."usedAt" ELSE COALESCE(t."usedAt", now()) END,
           redemption = CASE WHEN t."singleUse" THEN 'reserved' END,
           "leaseId" = CASE WHEN t."singleUse" THEN gen_random_uuid() END,
           "leaseUntil" = CASE WHEN t."singleUse" THEN LEAST(now() + make_interval(secs => $3), t."expiresAt",
             COALESCE((SELECT g."expiresAt" FROM file_evidence_grant g WHERE g.id = t."grantId"), t."expiresAt")) END
         FROM file f
         WHERE t."tokenDigest" = $1 AND t.operation = 'download' AND t."revokedAt" IS NULL AND t."expiresAt" > now()
           AND (NOT t."singleUse" OR (t."useCount" = 0 AND t.redemption IS NULL)) AND t."useCount" < $2
           AND f.id = t."fileId" AND f.status = 'AVAILABLE' AND f."organizationId" IS NOT DISTINCT FROM t."organizationId"
           AND (
             (t."grantId" IS NULL AND f."ownerService" = t."issuedBy")
             -- S2-File.2: a grant ticket's issuer is the grantee; its grant must still name this file, issuer and organization and be
             -- active NOW (not revoked, not expired), and the file must still be the grantor's.
             OR (t."grantId" IS NOT NULL AND EXISTS (
               SELECT 1 FROM file_evidence_grant g
               WHERE g.id = t."grantId" AND g."fileId" = f.id AND g."granteeService" = t."issuedBy" AND g."grantorService" = f."ownerService"
                 AND g."organizationId" IS NOT DISTINCT FROM t."organizationId" AND g."revokedAt" IS NULL AND g."expiresAt" > now()))
           )
         RETURNING t.id, t.operation, t."fileId", t."issuedBy", t."organizationId", t.disposition, t."maxBytes", t."mediaTypes", t.attach,
           t."singleUse", t."useCount", t."usedAt", t."revokedAt", t."expiresAt", t."createdAt", t."grantId", t.redemption, t."leaseId", t."leaseUntil",
           to_jsonb(f.*) AS file,
           (SELECT to_jsonb(g.*) - 'idempotencyKey' - 'requestHash' FROM file_evidence_grant g WHERE g.id = t."grantId") AS grant
       )
       SELECT to_jsonb(claimed.*) - 'file' - 'grant' AS ticket, claimed.file AS file, claimed.grant AS grant FROM claimed`,
      [tokenDigest, maxUses, leaseSeconds],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { ticket: reviveTicket(row.ticket), file: reviveFileRow(row.file), grant: row.grant ? reviveGrantRow({ ...row.grant, active: true }) : undefined };
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
      // GREATEST: the deletion's transaction may have started (now()) before a ticket it waited for (FOR SHARE) was created.
      `UPDATE file_access_ticket SET "revokedAt" = GREATEST(now(), "createdAt") WHERE "fileId" = $1 AND "revokedAt" IS NULL`,
      [fileId],
    );
    return rowCount ?? 0;
  }

  /**
   * Stage 17.7, ticket retention (SDD §11.1: "expired rows are removed by the retention worker"): tickets expired more than
   * `retentionSeconds` ago, in a bounded batch. Live tickets are never touched (they have not expired).
   */
  async purgeExpired(retentionSeconds: number, limit: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `WITH old AS MATERIALIZED (
         SELECT id FROM file_access_ticket WHERE "expiresAt" < now() - make_interval(secs => $1) AND redemption IS DISTINCT FROM 'reserved'
         ORDER BY "expiresAt" LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM file_access_ticket t USING old WHERE t.id = old.id`,
      [retentionSeconds, limit],
    );
    return rowCount ?? 0;
  }

  // ─────────────────────────────────────────────────────────────────────────── S2-File.4: settling a single-use reservation

  /**
   * Settles THIS lease (the redemption that holds it, identified by its lease id): `committed` (the server finished writing the response;
   * also from `uncertain`, when the lease ran out first), `uncertain` (bytes may have been sent), or released back to unused (proven: no
   * header left the process). `undefined` when that lease is not in a state allowing it (already settled another way, or not this lease).
   */
  async settleLease(ticketId: string, leaseId: string, to: 'committed' | 'uncertain' | 'released', q: Queryable = this.db): Promise<LeasedTicket | undefined> {
    if (!UUID.test(ticketId) || !UUID.test(leaseId)) return undefined;
    const set = to === 'released'
      ? `redemption = NULL, "leaseId" = NULL, "leaseUntil" = NULL`
      : `redemption = '${to}', "useCount" = 1, "usedAt" = COALESCE("usedAt", GREATEST(now(), "createdAt"))`;
    const from = to === 'committed' ? `('reserved', 'uncertain')` : `('reserved')`;
    const { rows } = await q.query<{ ticket: Record<string, unknown>; grant: Record<string, unknown> | null }>(
      `WITH s AS (UPDATE file_access_ticket t SET ${set} WHERE t.id = $1 AND t."leaseId" = $2 AND t.redemption IN ${from} RETURNING t.*)
       ${SETTLED}`,
      [ticketId, leaseId],
    );
    return rows[0] ? leased(rows[0]) : undefined;
  }

  /**
   * After a refused claim: settles this ticket's reservation as `uncertain` if its lease ran out unsettled (a crash, a lost settlement:
   * fail closed), and tells whether a reservation is still in progress (another redemption is transferring it right now).
   */
  async afterRefusedClaim(tokenDigest: TicketDigest, q: Queryable = this.db): Promise<{ inProgress: boolean; settled?: LeasedTicket }> {
    assertTicketDigest(tokenDigest);
    const { rows } = await q.query<{ ticket: Record<string, unknown>; grant: Record<string, unknown> | null }>(
      `WITH s AS (
         UPDATE file_access_ticket t SET redemption = 'uncertain', "useCount" = 1, "usedAt" = COALESCE(t."usedAt", GREATEST(now(), t."createdAt"))
         WHERE t."tokenDigest" = $1 AND t.redemption = 'reserved' AND t."leaseUntil" <= now() RETURNING t.*
       )
       ${SETTLED}`,
      [tokenDigest],
    );
    if (rows[0]) return { inProgress: false, settled: leased(rows[0]) };
    const live = await q.query(`SELECT 1 FROM file_access_ticket WHERE "tokenDigest" = $1 AND redemption = 'reserved' AND "leaseUntil" > now()`, [tokenDigest]);
    return { inProgress: live.rows.length === 1 };
  }

  /** The settling sweep (the cleanup pass): reservations whose lease ran out unsettled become `uncertain`, a bounded batch. */
  async settleExpiredLeases(limit: number, q: Queryable = this.db): Promise<LeasedTicket[]> {
    const { rows } = await q.query<{ ticket: Record<string, unknown>; grant: Record<string, unknown> | null }>(
      `WITH due AS MATERIALIZED (
         SELECT id FROM file_access_ticket WHERE redemption = 'reserved' AND "leaseUntil" <= now() ORDER BY "leaseUntil" LIMIT $1 FOR UPDATE SKIP LOCKED
       ), s AS (
         UPDATE file_access_ticket t SET redemption = 'uncertain', "useCount" = 1, "usedAt" = COALESCE(t."usedAt", GREATEST(now(), t."createdAt"))
         FROM due WHERE t.id = due.id AND t.redemption = 'reserved' RETURNING t.*
       )
       ${SETTLED}`,
      [limit],
    );
    return rows.map(leased);
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

function leased(row: { ticket: Record<string, unknown>; grant: Record<string, unknown> | null }): LeasedTicket {
  return { ticket: reviveTicket(row.ticket), grant: row.grant ? reviveGrantRow({ ...row.grant, active: false }) : undefined };
}

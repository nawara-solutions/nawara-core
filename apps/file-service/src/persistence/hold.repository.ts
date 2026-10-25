import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DbService, type Queryable } from '@nawara/service-kit';
import type { FileRow, FileScope } from './file.repository.js';

/** A hold: its placement and, once released, its release time (from the append-only release row). */
export interface HoldRow {
  id: string;
  fileId: string;
  holderService: string;
  holdRef: string;
  organizationId: string | null;
  placedAt: Date;
  releasedAt: Date | null;
}

export type PlaceOutcome =
  | { kind: 'placed'; hold: HoldRow }
  | { kind: 'existing'; hold: HoldRow } // the same reference on the same file, still active: idempotent
  | { kind: 'released'; hold: HoldRow } // the same reference was placed and released: never resurrected
  | { kind: 'ref_conflict' } // the holder used this reference for another file
  | { kind: 'not_found' } // not the holder's file in that organization (or not a file at all): one answer
  | { kind: 'not_available'; file: FileRow }; // the holder's file, but not AVAILABLE

export type ReleaseOutcome = { kind: 'released'; hold: HoldRow; now: boolean } | { kind: 'not_found' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SELECT_HOLD = `SELECT h.id, h."fileId", h."holderService", h."holdRef", h."organizationId", h."placedAt", r."releasedAt"
  FROM file_hold h LEFT JOIN file_hold_release r ON r."holdId" = h.id`;

function revive(raw: HoldRow): HoldRow {
  return { ...raw, placedAt: new Date(raw.placedAt), releasedAt: raw.releasedAt === null ? null : new Date(raw.releasedAt) };
}

/**
 * The only writer and reader of `file_hold` / `file_hold_release` (Core V2 S2-File.3, OD-FILE F4). Every operation is scoped to the holder
 * (the authenticated owner service) and its presented organization; a hold is named by the holder's reference AND its file, so a
 * service can never release another service's hold, or another of its own holds, by mistake. The schema re-checks the placement's
 * binding and keeps both tables append-only; `file_hold_guard` refuses any move to deletion while a hold is active.
 */
@Injectable()
export class HoldRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Places a hold in ONE transaction with `onPlaced` (the audit intent), which runs only when THIS call created it. A reference already
   * used answers what it is (the same file and active: idempotent; released: never placed again; another file: a conflict). Otherwise
   * the file row is locked `FOR SHARE` (serialized with a deletion request) and must be the holder's AVAILABLE file; a concurrent
   * placement of the same reference waits on the unique index and answers the winner's hold.
   */
  async place(scope: FileScope, fileId: string, holdRef: string, onPlaced: (q: Queryable, hold: HoldRow) => Promise<void>): Promise<PlaceOutcome> {
    if (!UUID.test(fileId) || !UUID.test(holdRef)) return { kind: 'not_found' };
    return this.db.tx(async (q) => {
      const existing = await this.byRef(q, scope, holdRef, fileId);
      if (existing) return existing;
      const { rows: files } = await q.query<FileRow>(
        `SELECT * FROM file WHERE id = $1 AND "ownerService" = $2 AND "organizationId" IS NOT DISTINCT FROM $3 FOR SHARE`,
        [fileId, scope.ownerService, scope.organizationId],
      );
      const file = files[0];
      if (!file) return { kind: 'not_found' };
      if (file.status !== 'AVAILABLE') return { kind: 'not_available', file };
      const { rows } = await q.query<HoldRow>(
        `INSERT INTO file_hold (id, "fileId", "holderService", "holdRef", "organizationId") VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("holderService", "holdRef") DO NOTHING
         RETURNING id, "fileId", "holderService", "holdRef", "organizationId", "placedAt", NULL::timestamptz AS "releasedAt"`,
        [randomUUID(), file.id, scope.ownerService, holdRef, file.organizationId],
      );
      if (!rows[0]) return (await this.byRef(q, scope, holdRef, fileId))!; // a concurrent placement of this reference won
      const hold = revive(rows[0]);
      await onPlaced(q, hold);
      return { kind: 'placed', hold };
    });
  }

  /**
   * Releases exactly the holder's hold with this reference on this file in that organization, in ONE transaction with `onReleased`,
   * which runs only on the active → released transition. The release row's primary key makes two concurrent releases one: the second
   * waits and then answers the first's release. A rolled-back release leaves the hold active. Other holds are untouched.
   */
  async release(scope: FileScope, fileId: string, holdRef: string, onReleased: (q: Queryable, hold: HoldRow) => Promise<void>): Promise<ReleaseOutcome> {
    if (!UUID.test(fileId) || !UUID.test(holdRef)) return { kind: 'not_found' };
    return this.db.tx(async (q) => {
      const hold = await this.find(q, `h."holderService" = $1 AND h."holdRef" = $2 AND h."fileId" = $3 AND h."organizationId" IS NOT DISTINCT FROM $4`,
        [scope.ownerService, holdRef, fileId, scope.organizationId]);
      if (!hold) return { kind: 'not_found' };
      const { rows } = await q.query<{ releasedAt: Date }>(
        `INSERT INTO file_hold_release ("holdId") VALUES ($1) ON CONFLICT ("holdId") DO NOTHING RETURNING "releasedAt"`, [hold.id]);
      if (rows[0]) {
        const released = { ...hold, releasedAt: new Date(rows[0].releasedAt) };
        await onReleased(q, released);
        return { kind: 'released', hold: released, now: true };
      }
      return { kind: 'released', hold: (await this.find(q, 'h.id = $1', [hold.id]))!, now: false };
    });
  }

  /** The active holds of a file (none: it may be deleted). */
  async activeFor(fileId: string, q: Queryable = this.db): Promise<HoldRow[]> {
    if (!UUID.test(fileId)) return [];
    const { rows } = await q.query<HoldRow>(`${SELECT_HOLD} WHERE h."fileId" = $1 AND r."holdId" IS NULL ORDER BY h."placedAt", h.id`, [fileId]);
    return rows.map(revive);
  }

  private async byRef(q: Queryable, scope: FileScope, holdRef: string, fileId: string): Promise<PlaceOutcome | undefined> {
    const hold = await this.find(q, 'h."holderService" = $1 AND h."holdRef" = $2', [scope.ownerService, holdRef]);
    if (!hold) return undefined;
    if (hold.fileId !== fileId || hold.organizationId !== scope.organizationId) return { kind: 'ref_conflict' };
    return hold.releasedAt ? { kind: 'released', hold } : { kind: 'existing', hold };
  }

  private async find(q: Queryable, where: string, params: unknown[]): Promise<HoldRow | undefined> {
    const { rows } = await q.query<HoldRow>(`${SELECT_HOLD} WHERE ${where}`, params);
    return rows[0] ? revive(rows[0]) : undefined;
  }
}

import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DbService, isUniqueViolation, type Queryable } from '@nawara/service-kit';
import type { FileMediaType } from '../policy/media-types.js';
import { FilePersistenceError } from './persistence-error.js';
import { newStorageKey } from './storage-key.js';

export type FileStatus = 'UPLOADING' | 'VERIFYING' | 'AVAILABLE' | 'REJECTED' | 'FAILED' | 'DELETING' | 'DELETED';

/**
 * Who may see a file: the owner service (always the authenticated caller, or a ticket's issuer) and the file's organization (`null`
 * = a platform file). A lookup matches BOTH exactly, so a wrong owner, a wrong organization and a missing file are the same answer.
 */
export interface FileScope {
  ownerService: string;
  organizationId: string | null;
}

/** A `file` row (SDD §3). `storageKey` and `storageProvider` are internal: the API stages never expose them. */
export interface FileRow {
  id: string;
  ownerService: string;
  organizationId: string | null;
  createdBy: string | null;
  originalName: string | null;
  mediaType: FileMediaType | null;
  declaredMediaType: string | null;
  sizeBytes: string | null; // bigint: pg returns a string; the API stages convert within the 100 MiB ceiling
  sha256: string | null;
  storageProvider: string;
  storageKey: string;
  status: FileStatus;
  uploadExpiresAt: Date;
  attachDeadline: Date | null;
  attachedAt: Date | null;
  idempotencyKey: string | null;
  requestHash: string | null;
  failureCode: string | null;
  createdAt: Date;
  availableAt: Date | null;
  deletionRequestedAt: Date | null;
  deletedAt: Date | null;
  updatedAt: Date;
}

/** The metadata of a file about to receive its bytes. Every identity and placement value is derived here, never taken from a caller. */
export interface NewUpload {
  scope: FileScope;
  createdBy?: string | null;
  /** Already sanitized (SDD §8; the sanitizer is 17.5). The schema refuses an unsafe one. */
  originalName?: string | null;
  declaredMediaType?: string | null;
  /** Service uploads (SDD §10); ticket uploads have none. */
  idempotency?: { key: string; requestHash: string } | null;
  /** The configured adapter and key prefix (17.4); the key itself is generated here. */
  storage: { provider: string; keyPrefix: string };
  /** The upload lease: a crashed upload is recovered past it (17.5 / 17.7). */
  uploadLeaseSeconds: number;
  /** Temporary with a deadline (FILE_ATTACH_TTL, 17.5), or created attached (a service's own generated file, SDD §5.2). */
  attachment: { attached: true } | { deadlineSeconds: number };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The verified content of an accepted upload (Stage 17.5): detected type, counted size, computed SHA-256. */
export interface AcceptedContent {
  mediaType: FileMediaType;
  sizeBytes: number;
  sha256: string;
}

export type AttachOutcome = { kind: 'attached'; file: FileRow } | { kind: 'not_found' } | { kind: 'not_available' };

/**
 * The only writer and reader of `file`. Stage 17.3 holds the creation of the metadata row and the scoped read; Stage 17.5 the upload
 * completion, refusal and attach; deletion is 17.7. Each transition is a named, CONDITIONAL operation (`… WHERE status = 'UPLOADING'`),
 * never a generic update. The schema enforces the state machine, set-once content and immutability anyway.
 *
 * There is deliberately no unscoped lookup: a ticket redemption reads its file through `findOwned` with the ticket's own bindings
 * (issuer and organization), so no code path can read a file by id alone.
 */
@Injectable()
export class FileRepository {
  constructor(private readonly db: DbService) {}

  /** Inserts the `UPLOADING` row with a server-generated id and storage key, and the database clock for every timestamp. */
  async createUploading(input: NewUpload, q: Queryable = this.db): Promise<FileRow> {
    const id = randomUUID();
    const storageKey = newStorageKey(input.storage.keyPrefix, id);
    const attached = 'attached' in input.attachment;
    const deadlineSeconds = 'deadlineSeconds' in input.attachment ? input.attachment.deadlineSeconds : null;
    try {
      const { rows } = await q.query<FileRow>(
        `INSERT INTO file (id, "ownerService", "organizationId", "createdBy", "originalName", "declaredMediaType", "idempotencyKey",
           "requestHash", "storageProvider", "storageKey", "uploadExpiresAt", "attachDeadline", "attachedAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() + make_interval(secs => $11),
           CASE WHEN $12::double precision IS NULL THEN NULL ELSE now() + make_interval(secs => $12::double precision) END,
           CASE WHEN $13 THEN now() END)
         RETURNING *`,
        [id, input.scope.ownerService, input.scope.organizationId, input.createdBy ?? null, input.originalName ?? null,
          input.declaredMediaType ?? null, input.idempotency?.key ?? null, input.idempotency?.requestHash ?? null,
          input.storage.provider, storageKey, input.uploadLeaseSeconds, deadlineSeconds, attached],
      );
      return rows[0]!;
    } catch (e) {
      if (isUniqueViolation(e, 'file_idempotency_unique')) throw new FilePersistenceError('idempotency_key_in_use');
      throw e;
    }
  }

  /**
   * The live file (not FAILED / REJECTED) holding this owner's Idempotency-Key (SDD §10): the replay / conflict / in-progress decision.
   * Scoped to the owner by construction (the key is per caller).
   */
  async findLiveByIdempotencyKey(ownerService: string, idempotencyKey: string, q: Queryable = this.db): Promise<FileRow | undefined> {
    const { rows } = await q.query<FileRow>(
      `SELECT * FROM file WHERE "ownerService" = $1 AND "idempotencyKey" = $2 AND status NOT IN ('FAILED', 'REJECTED')`,
      [ownerService, idempotencyKey],
    );
    return rows[0];
  }

  /**
   * `UPLOADING` → `AVAILABLE` with the verified content, only after the bytes are stored (no scanner is configured, so `VERIFYING` is
   * skipped, SDD §5.1). `attach` records the attachment at the same time (an upload ticket's attach-on-completion flag). `undefined`
   * when the file is no longer `UPLOADING` (the transition happens at most once).
   */
  async completeUpload(id: string, content: AcceptedContent, attach: boolean, q: Queryable = this.db): Promise<FileRow | undefined> {
    const { rows } = await q.query<FileRow>(
      `UPDATE file SET status = 'AVAILABLE', "mediaType" = $2, "sizeBytes" = $3, sha256 = $4, "availableAt" = now(),
         "attachedAt" = CASE WHEN $5 AND "attachedAt" IS NULL THEN now() ELSE "attachedAt" END
       WHERE id = $1 AND status = 'UPLOADING' RETURNING *`,
      [id, content.mediaType, content.sizeBytes, content.sha256, attach],
    );
    return rows[0];
  }

  /** `UPLOADING` → `REJECTED` (the content was refused) or `FAILED` (the transfer failed), with a bounded machine code. */
  async refuseUpload(id: string, status: 'REJECTED' | 'FAILED', failureCode: string, q: Queryable = this.db): Promise<boolean> {
    const { rowCount } = await q.query(`UPDATE file SET status = $2, "failureCode" = $3 WHERE id = $1 AND status = 'UPLOADING'`, [id, status, failureCode]);
    return rowCount === 1;
  }

  /**
   * Marks the owner's file attached (SDD §5.2), idempotently: an already attached file is the same success. A file of another owner
   * or organization is `not_found`, indistinguishable from a missing one; a refused, failed or deleted file is `not_available`.
   */
  async attach(scope: FileScope, id: string, q: Queryable = this.db): Promise<AttachOutcome> {
    if (!UUID.test(id)) return { kind: 'not_found' };
    const { rows } = await q.query<FileRow>(
      `UPDATE file SET "attachedAt" = now()
       WHERE id = $1 AND "ownerService" = $2 AND "organizationId" IS NOT DISTINCT FROM $3 AND "attachedAt" IS NULL
         AND status IN ('UPLOADING', 'VERIFYING', 'AVAILABLE')
       RETURNING *`,
      [id, scope.ownerService, scope.organizationId],
    );
    if (rows[0]) return { kind: 'attached', file: rows[0] };
    const current = await this.findOwned(scope, id, q);
    if (!current) return { kind: 'not_found' };
    if (current.attachedAt) return { kind: 'attached', file: current };
    return { kind: 'not_available' };
  }

  /**
   * The file with this id IF it belongs to this owner in this organization; `undefined` otherwise, whatever the reason (missing,
   * another owner, another organization, not an id at all): the API answers one `404 file_not_found` (SDD §11).
   */
  async findOwned(scope: FileScope, id: string, q: Queryable = this.db): Promise<FileRow | undefined> {
    if (!UUID.test(id)) return undefined;
    const { rows } = await q.query<FileRow>(
      `SELECT * FROM file WHERE id = $1 AND "ownerService" = $2 AND "organizationId" IS NOT DISTINCT FROM $3`,
      [id, scope.ownerService, scope.organizationId],
    );
    return rows[0];
  }
}

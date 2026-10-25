import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { FileAudit } from '../audit/file-audit.js';
import type { FileConfig } from '../config/file-config.js';
import { FILE_CONFIG } from '../config/file-config.token.js';
import { FILE_MESSAGES } from '../messages.js';
import { HoldRepository, type HoldRow } from '../persistence/hold.repository.js';
import { FILE_NOT_FOUND, fileError, organizationHeader } from '../upload/upload-http.js';

/** What the holder sees of a hold. */
export interface HoldView {
  holdId: string;
  fileId: string;
  holdRef: string;
  organizationId: string | null;
  status: 'active' | 'released';
  placedAt: string;
  releasedAt: string | null;
}

export function holdView(h: HoldRow): HoldView {
  return {
    holdId: h.id, fileId: h.fileId, holdRef: h.holdRef, organizationId: h.organizationId, status: h.releasedAt ? 'released' : 'active',
    placedAt: h.placedAt.toISOString(), releasedAt: h.releasedAt?.toISOString() ?? null,
  };
}

/**
 * Core V2 S2-File.3 (register FIL-04 / FIL-05; OD-FILE F4): evidence holds, placed and released by the file's OWNER service only.
 *
 * - Authority: the caller is its authenticated service token, never a request value; it needs `hold` (deny by default). The file is
 *   looked up as the caller's own file in the presented organization (a foreign, missing or malformed id: one `404 file_not_found`);
 *   the hold takes the file's organization. Audit's legal-hold authority is not carried over (F4).
 * - Identity: the holder's `holdRef` (a uuid naming its preservation obligation) on that file. Placing it again is idempotent (`200`);
 *   using it for another file is `409 hold_ref_conflict`; placing a released reference is `409 hold_released` (never resurrected).
 * - Release: only that hold, by that holder (`404 hold_not_found` otherwise, including another service's hold); repeated: the first
 *   release; final. Other holds stay active.
 * - No expiry: a hold lasts until its holder releases it.
 * - Audit: `file.hold_placed` / `file.hold_released`, in the same transaction, only on the transition.
 */
@Injectable()
export class HoldService {
  private readonly logger = new Logger('FileHolds');

  constructor(
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
    private readonly holds: HoldRepository,
    @Inject(FileAudit) private readonly audit: FileAudit,
  ) {}

  async place(caller: string, req: Request, fileId: string, holdRef: string): Promise<{ created: boolean; hold: HoldView }> {
    const organizationId = this.authorize(caller, req);
    const outcome = await this.holds.place({ ownerService: caller, organizationId }, fileId, holdRef, (q, hold) => this.audit.holdPlaced(q, hold));
    switch (outcome.kind) {
      case 'not_found':
        throw FILE_NOT_FOUND();
      case 'not_available':
        if (outcome.file.status === 'DELETING' || outcome.file.status === 'DELETED') throw fileError(410, 'file_deleted', FILE_MESSAGES.fileDeleted);
        throw fileError(409, 'file_not_available', FILE_MESSAGES.fileNotAvailable);
      case 'ref_conflict':
        throw fileError(409, 'hold_ref_conflict', FILE_MESSAGES.holdRefConflict);
      case 'released':
        throw fileError(409, 'hold_released', FILE_MESSAGES.holdReleased);
      case 'existing':
        return { created: false, hold: holdView(outcome.hold) };
      case 'placed':
        this.logger.log(`file_hold_placed owner=${caller} hold=${outcome.hold.id} file=${outcome.hold.fileId}`);
        return { created: true, hold: holdView(outcome.hold) };
    }
  }

  async release(caller: string, req: Request, fileId: string, holdRef: string): Promise<HoldView> {
    const organizationId = this.authorize(caller, req);
    const outcome = await this.holds.release({ ownerService: caller, organizationId }, fileId, holdRef, (q, hold) => this.audit.holdReleased(q, hold));
    if (outcome.kind === 'not_found') throw fileError(404, 'hold_not_found', FILE_MESSAGES.noSuchHold);
    if (outcome.now) this.logger.log(`file_hold_released owner=${caller} hold=${outcome.hold.id} file=${outcome.hold.fileId}`);
    return holdView(outcome.hold);
  }

  /** Deny by default: `hold` is required; an organization only for a caller allowed to act for one. */
  private authorize(caller: string, req: Request): string | null {
    const policy = this.config.callerPolicy.of(caller);
    if (!policy?.operations.has('hold')) throw fileError(403, 'operation_not_allowed', FILE_MESSAGES.operationNotAllowed);
    const organizationId = organizationHeader(req);
    if (organizationId !== null && policy.organizations === 'none') throw fileError(403, 'organization_not_allowed', FILE_MESSAGES.organizationNotAllowed);
    return organizationId;
  }
}

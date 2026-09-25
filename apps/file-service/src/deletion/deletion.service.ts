import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import type { FileConfig } from '../config/file-config.js';
import { FILE_CONFIG } from '../config/file-config.token.js';
import { FileAudit } from '../audit/file-audit.js';
import { FileRepository } from '../persistence/file.repository.js';
import { FILE_NOT_FOUND, fileError, fileView, organizationHeader, type FileView } from '../upload/upload-http.js';

/**
 * Stage 17.7: deletion requested by the owner (SDD §5.1, §13; F17). Logical first: `AVAILABLE` → `DELETING` with every ticket revoked,
 * in one transaction; access stops when it commits; the bytes are removed asynchronously by the cleanup worker, which ends the row in
 * `DELETED` (a tombstone: rows are never hard-deleted). Idempotent: DELETING and DELETED answer the same `202`.
 */
@Injectable()
export class DeletionService {
  private readonly logger = new Logger('FileDeletion');

  constructor(
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
    private readonly files: FileRepository,
    @Inject(FileAudit) private readonly audit: FileAudit,
  ) {}

  async requestDeletion(caller: string, req: Request, id: string): Promise<FileView> {
    const policy = this.config.callerPolicy.of(caller);
    if (!policy?.operations.has('delete')) throw fileError(403, 'operation_not_allowed', 'Operation not allowed for this caller.');
    const organizationId = organizationHeader(req);
    if (organizationId !== null && policy.organizations === 'none') throw fileError(403, 'organization_not_allowed', 'This caller cannot act for an organization.');
    // The audit intent is written in the deletion's transaction, from the row it changed (its organization) and the authenticated caller.
    const outcome = await this.files.requestDeletion({ ownerService: caller, organizationId }, id, (q, file) => this.audit.deleted(q, file, caller));
    if (outcome.kind === 'not_found') throw FILE_NOT_FOUND(); // a foreign, missing or malformed id: the same answer
    if (outcome.kind === 'not_deletable') {
      // No cancellation of an upload in progress (V1); a refused or failed upload has no bytes and is already terminal.
      if (outcome.file.status === 'UPLOADING' || outcome.file.status === 'VERIFYING') throw fileError(409, 'upload_in_progress', 'The upload is still in progress.');
      throw fileError(409, 'file_not_available', 'The file has no content to delete.');
    }
    if (outcome.file.deletionRequestedAt && outcome.file.status === 'DELETING' && outcome.file.deleteAttempts === 0) {
      this.logger.log(`file_deletion_requested file=${outcome.file.id} owner=${caller}`);
    }
    return fileView(outcome.file);
  }
}

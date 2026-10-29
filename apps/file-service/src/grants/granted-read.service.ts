import { randomBytes } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DbService, type Queryable } from '@nawara/service-kit';
import { FileAudit } from '../audit/file-audit.js';
import type { FileConfig } from '../config/file-config.js';
import { FILE_CONFIG } from '../config/file-config.token.js';
import { DownloadService, type IssuedDownloadTicket } from '../download/download.service.js';
import { UsageLimiter } from '../limits/usage-limiter.js';
import { FILE_MESSAGES } from '../messages.js';
import type { FileRow } from '../persistence/file.repository.js';
import { GrantRepository, type GrantRow } from '../persistence/grant.repository.js';
import { ticketDigest } from '../persistence/ticket-digest.js';
import { TicketRepository } from '../persistence/ticket.repository.js';
import type { CallerPolicy } from '../policy/caller-policy.js';
import { FILE_NOT_FOUND, fileError, fileView, type FileView } from '../upload/upload-http.js';
import { grantorStillAllows } from './granted-access.js';

/**
 * Core V2 S2-File.2 (register FIL-02 / FIL-03; ADR-0048 Amendment 1): a grantee service's access to ONE file through ONE of its active
 * evidence grants, on routes of their own (the owner-only routes are unchanged and still answer the grantee `404`).
 *
 * At every request, in ONE transaction holding the grant and the file `FOR SHARE`: the caller is its authenticated service token and
 * holds `read_granted`; the grant names that caller as grantee, names exactly the requested file, has a purpose in the caller's CURRENT
 * `readPurposes`, is neither revoked nor expired (database clock); the file is still `AVAILABLE`, still the grantor's, in the grant's
 * organization; the grantor still holds `grant` for the purpose. Any failure is the same `404 file_not_found` (no oracle). No
 * organization, grantor, grantee or purpose is ever read from the request. The access is recorded (`file.granted_read`) in that same
 * transaction, before anything is returned or streamed: a failed record refuses the access.
 */
@Injectable()
export class GrantedReadService {
  private readonly logger = new Logger('FileGrantedRead');

  constructor(
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
    private readonly db: DbService,
    private readonly grants: GrantRepository,
    private readonly tickets: TicketRepository,
    private readonly usage: UsageLimiter,
    private readonly downloads: DownloadService,
    @Inject(FileAudit) private readonly audit: FileAudit,
  ) {}

  /**
   * Core V2 S6e-D (PAY-10; the Owner's R6E-3), additive: the grant the read went through (its id, purpose, case and expiry) beside the file, so
   * the grantee can bind the evidence to exactly the case it was granted for. Never the grantor's request, idempotency data or storage.
   */
  async metadata(caller: string, grantId: string, fileId: string): Promise<FileView & { grant: { id: string; purpose: string; caseRef: string; expiresAt: string } }> {
    const policy = this.policy(caller);
    const { file, grant } = await this.db.tx(async (q) => {
      const found = await this.authorize(q, caller, policy, grantId, fileId);
      await this.audit.grantedRead(q, found.grant, 'metadata');
      return found;
    });
    this.logger.log(`file_granted_read access=metadata grantee=${caller} grant=${grantId} file=${file.id}`);
    return { ...fileView(file), grant: { id: grant.id, purpose: grant.purpose, caseRef: grant.caseRef, expiresAt: new Date(grant.expiresAt).toISOString() } };
  }

  async content(caller: string, req: Request, res: Response, grantId: string, fileId: string): Promise<void> {
    const policy = this.policy(caller);
    await this.usage.admit('download', caller, null); // charged before the lookup: probing unknown grants spends budget too
    await this.downloads.grantedContent(req, res, async () => {
      const { file } = await this.db.tx(async (q) => {
        const found = await this.authorize(q, caller, policy, grantId, fileId);
        await this.audit.grantedRead(q, found.grant, 'content_authorized');
        return found;
      });
      this.logger.log(`file_granted_read access=content_authorized grantee=${caller} grant=${grantId} file=${file.id}`);
      return file;
    });
  }

  /**
   * A download ticket from the grant: bound to the grant, its file and organization; issued by (and revocable by) the grantee; expiring
   * at the earlier of the configured ticket lifetime and the grant's expiry (never extending the grant). Redemption re-checks the grant.
   * A grant ending within the minimum ticket lifetime is `409 grant_expiring`.
   */
  async issueTicket(caller: string, grantId: string, fileId: string, input: { disposition?: 'attachment' | 'inline'; singleUse?: boolean }): Promise<IssuedDownloadTicket> {
    const policy = this.policy(caller);
    await this.usage.admit('ticket', caller, null);
    const disposition = input.disposition ?? 'attachment';
    const token = randomBytes(32).toString('base64url'); // 256 bits, the owner tickets' format
    const row = await this.db.tx(async (q) => {
      const found = await this.authorize(q, caller, policy, grantId, fileId);
      // SDD §9: `inline` only for the image allow-list.
      if (disposition === 'inline' && !found.file.mediaType?.startsWith('image/')) throw fileError(422, 'disposition_not_allowed', FILE_MESSAGES.onlyImagesInline);
      const ticket = await this.tickets.recordGrantDownload({
        grantId: found.grant.id, fileId: found.file.id, granteeService: caller, tokenDigest: ticketDigest(token)!,
        lifetimeSeconds: this.config.upload.downloadTicketTtlSeconds, singleUse: input.singleUse ?? false, disposition,
      }, q);
      // Everything else was proved under the same locks: only the grant's remaining lifetime can refuse here.
      if (!ticket) throw fileError(409, 'grant_expiring', FILE_MESSAGES.grantExpiring);
      await this.audit.grantedRead(q, found.grant, 'ticket_issued');
      return ticket;
    });
    this.logger.log(`file_granted_read access=ticket_issued grantee=${caller} grant=${grantId} ticket=${row.id} single_use=${row.singleUse}`);
    return { ticketId: row.id, url: `${this.config.upload.publicBaseUrl}/file/t/${token}`, expiresAt: row.expiresAt.toISOString() };
  }

  private async authorize(q: Queryable, caller: string, policy: CallerPolicy, grantId: string, fileId: string): Promise<{ grant: GrantRow; file: FileRow }> {
    const found = await this.grants.findUsable({ grantId, fileId, granteeService: caller, purposes: policy.readPurposes ?? new Set() }, q);
    if (!found || !grantorStillAllows(this.config.callerPolicy, found.grant)) throw FILE_NOT_FOUND();
    return found;
  }

  /** Deny by default: `read_granted` is required before any lookup; a caller that lost it reads nothing more through any grant. */
  private policy(caller: string): CallerPolicy {
    const policy = this.config.callerPolicy.of(caller);
    if (!policy?.operations.has('read_granted')) throw fileError(403, 'operation_not_allowed', FILE_MESSAGES.operationNotAllowed);
    return policy;
  }
}

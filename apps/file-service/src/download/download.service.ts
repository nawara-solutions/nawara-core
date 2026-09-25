import { createHash, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { DbService } from '@nawara/service-kit';
import type { FileConfig } from '../config/file-config.js';
import { FILE_CONFIG } from '../config/file-config.token.js';
import { FileRepository, type FileRow, type FileScope } from '../persistence/file.repository.js';
import { FilePersistenceError } from '../persistence/persistence-error.js';
import { ticketDigest } from '../persistence/ticket-digest.js';
import { TicketRepository } from '../persistence/ticket.repository.js';
import type { CallerPolicy, FileOperation } from '../policy/caller-policy.js';
import type { FileMediaType } from '../policy/media-types.js';
import { isStorageError } from '../storage/storage-error.js';
import { STORAGE_PORT, type StoragePort, type StoredObjectStream } from '../storage/storage.port.js';
import { UsageLimiter, type UsageKind } from '../limits/usage-limiter.js';
import { RedemptionLimiter } from '../tickets/redemption-limiter.js';
import { FILE_NOT_FOUND, fileError, fileView, organizationHeader, sizeBucket, type FileView } from '../upload/upload-http.js';
import { contentDisposition } from './content-disposition.js';

export interface IssuedDownloadTicket {
  ticketId: string;
  /** `<FILE_PUBLIC_BASE_URL>/file/t/<token>`: returned once; only the token's SHA-256 digest is stored. */
  url: string;
  expiresAt: string;
}

class TicketNoLongerValid extends Error {}

/**
 * Verifies what is sent against the record without holding the object (Stage 17.8): counts the bytes (a body that runs over fails as
 * soon as it passes the size; one that ends short fails at its end) and recomputes the SHA-256, holding back ONLY the last chunk until
 * the digest matches the recorded `sha256` (the upload's `VerifiedBody` rule, one chunk of lag, no whole-file buffering).
 *
 * The exact guarantee: an integrity-mismatched download cannot COMPLETE successfully. The response is destroyed before its last chunk,
 * so the client always receives fewer bytes than `Content-Length` (and never a normal end of message). It is NOT a promise that no
 * altered byte is transmitted: every chunk before the last one has already been sent when the mismatch is found, so an alteration
 * outside the last chunk reaches the client inside a truncated response. At most `size - (last chunk)` body bytes are emitted; the last
 * chunk is at most the store stream's chunk size (64 KiB on the filesystem adapter; on S3, one HTTP read of the provider response). A
 * file that fits in one chunk emits nothing at all: the headers go out with the first body write, so the connection closes without a
 * response. The `ETag` (the recorded SHA-256) lets a client check what it got.
 */
export class ContentMismatch extends Error {}

export class VerifiedDownload extends Transform {
  bytes = 0;
  private held: Buffer | undefined;
  private readonly hash = createHash('sha256');

  constructor(
    private readonly expected: number,
    private readonly sha256: string,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > this.expected) return done(new ContentMismatch('stream_length'));
    this.hash.update(chunk);
    const release = this.held;
    this.held = chunk;
    done(null, release);
  }

  override _flush(done: TransformCallback): void {
    if (this.bytes !== this.expected) return done(new ContentMismatch('stream_length'));
    if (this.hash.digest('hex') !== this.sha256) return done(new ContentMismatch('digest_mismatch'));
    done(null, this.held);
  }
}

/**
 * The byte-read boundary (Stage 17.6; ADR-0048 §7, SDD §9, §11, §11.1):
 *
 * - Path A, trusted services (service token + caller policy): metadata and content of the caller's OWN files, looked up by id AND
 *   owner AND organization in one query (a foreign, missing or malformed id is the same `404 file_not_found`).
 * - Path B, clients: a short-lived download ticket issued by the owner after ITS business authorization; the ticket alone selects the
 *   file. Redemption is one atomic claim that re-checks the ticket and the file's binding and availability.
 *
 * Authorization always completes before the store is opened; bytes then stream store → response with backpressure (no buffering), a
 * client disconnect destroys the store stream, and only `AVAILABLE` files are ever served. File Service never calls Auth.
 */
@Injectable()
export class DownloadService {
  private readonly logger = new Logger('Download');

  constructor(
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
    private readonly files: FileRepository,
    private readonly tickets: TicketRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly db: DbService,
    private readonly redemptions: RedemptionLimiter,
    private readonly usage: UsageLimiter,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────────────────── path A: trusted services

  async metadata(caller: string, req: Request, id: string): Promise<FileView> {
    const file = await this.owned(caller, 'read', req, id);
    return fileView(file);
  }

  async serviceContent(caller: string, req: Request, res: Response, id: string): Promise<void> {
    const file = await this.owned(caller, 'read', req, id, 'download');
    assertDownloadable(file);
    await this.stream(file, 'attachment', req, res, 'service');
  }

  async issueDownloadTicket(caller: string, req: Request, id: string, input: { disposition?: 'attachment' | 'inline'; singleUse?: boolean }): Promise<IssuedDownloadTicket> {
    const file = await this.owned(caller, 'issue_ticket', req, id, 'ticket');
    assertDownloadable(file);
    const disposition = input.disposition ?? 'attachment';
    // SDD §9: `inline` only for the image allow-list, and only when the caller asks for it.
    if (disposition === 'inline' && !file.mediaType?.startsWith('image/')) throw fileError(422, 'disposition_not_allowed', 'Only images may be served inline.');
    const scope: FileScope = { ownerService: file.ownerService, organizationId: file.organizationId };
    for (let attempt = 0; ; attempt++) {
      const token = randomBytes(32).toString('base64url'); // 256 bits (F35), the Stage 17.5 format
      try {
        const row = await this.tickets.recordDownload({
          scope, fileId: file.id, tokenDigest: ticketDigest(token)!, lifetimeSeconds: this.config.upload.downloadTicketTtlSeconds,
          singleUse: input.singleUse ?? false, disposition
        });
        if (!row) {
          // Stage 17.7: the insert requires AVAILABLE under a share lock; a deletion committed in between is reported as what it is.
          const now = await this.files.findOwned(scope, file.id);
          if (!now) throw FILE_NOT_FOUND();
          assertDownloadable(now);
          throw fileError(409, 'file_not_available', 'The file is not available.');
        }
        this.logger.log(`file_download_ticket_issued owner=${caller} ticket=${row.id} single_use=${row.singleUse} ttl_s=${this.config.upload.downloadTicketTtlSeconds}`);
        return { ticketId: row.id, url: `${this.config.upload.publicBaseUrl}/file/t/${token}`, expiresAt: row.expiresAt.toISOString() };
      } catch (e) {
        if (e instanceof FilePersistenceError && e.code === 'ticket_digest_collision' && attempt < 2) continue;
        throw e;
      }
    }
  }

  /** Revokes one of the caller's tickets (upload or download) in its organization; idempotent; foreign / unknown → the same 404. */
  async revokeTicket(caller: string, req: Request, ticketId: string): Promise<void> {
    const policy = this.policy(caller, 'issue_ticket');
    const organizationId = this.organization(policy, organizationHeader(req));
    if (!(await this.tickets.revoke({ ownerService: caller, organizationId }, ticketId))) throw fileError(404, 'ticket_not_found', 'No such ticket.');
    this.logger.log(`file_ticket_revoked owner=${caller} ticket=${ticketId}`);
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────────── path B: tickets

  async redeem(token: string, req: Request, res: Response): Promise<void> {
    const { invalid } = await this.redemptions.admit(req); // a blocked client is refused for every ticket alike (no oracle)
    const digest = ticketDigest(token);
    if (!digest) throw await invalid();
    let claimed: Awaited<ReturnType<TicketRepository['claimDownload']>>;
    try {
      claimed = await this.db.tx(async (q) => {
        // Ticket + file binding + AVAILABLE + the use cap (Stage 17.8: a leaked reusable ticket is not an unlimited download), one statement.
        const c = await this.tickets.claimDownload(digest, q, this.config.limits.ticketMaxDownloads);
        if (!c) return undefined;
        const policy = this.config.callerPolicy.of(c.ticket.issuedBy);
        // The issuer must STILL hold `issue_ticket` (and its organization mode) now (SDD §11.1); otherwise roll back: nothing consumed.
        if (!policy?.operations.has('issue_ticket') || (c.ticket.organizationId !== null && policy.organizations === 'none')) throw new TicketNoLongerValid();
        return c;
      });
    } catch (e) {
      if (e instanceof TicketNoLongerValid) throw await invalid();
      throw e;
    }
    if (!claimed) throw await invalid();
    await this.stream(claimed.file, claimed.ticket.disposition ?? 'attachment', req, res, 'ticket');
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────── streaming

  /**
   * Opens the object (only now: authorization is complete), checks its size against the authoritative metadata, then streams it.
   * Errors before the first byte are normal HTTP errors; a failure after it can only end the connection (the client sees a body
   * shorter than its Content-Length).
   */
  private async stream(file: FileRow, disposition: 'attachment' | 'inline', req: Request, res: Response, route: 'service' | 'ticket'): Promise<void> {
    const started = performance.now();
    const media = file.mediaType as FileMediaType;
    const size = Number(file.sizeBytes);
    const log = (outcome: string, bytes: number) =>
      this.logger.log(`file_download route=${route} outcome=${outcome} file=${file.id} owner=${file.ownerService} media=${media} size=${sizeBucket(size)} bytes=${bytes} duration_ms=${Math.round(performance.now() - started)}`);
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) abort.abort(new Error('client_closed'));
    };
    res.once('close', onClose);
    req.once('close', onClose);

    let object: StoredObjectStream;
    try {
      object = await this.storage.get(file.storageKey, { signal: abort.signal });
    } catch (e) {
      res.off('close', onClose);
      req.off('close', onClose);
      log(isStorageError(e) ? e.code : abort.signal.aborted ? 'aborted' : 'storage_error', 0);
      throw this.readFailure(e, file);
    }
    if (object.sizeBytes !== size) {
      object.body.destroy();
      res.off('close', onClose);
      req.off('close', onClose);
      this.logger.warn(`file_storage_inconsistent file=${file.id} reason=size_mismatch`); // never serve bytes that contradict the record
      log('size_mismatch', 0);
      throw fileError(500, 'file_content_missing', 'The file content is not available.');
    }

    res.status(200);
    res.setHeader('Content-Type', media);
    res.setHeader('Content-Length', String(size));
    res.setHeader('Content-Disposition', contentDisposition(disposition, file.originalName, media));
    res.setHeader('ETag', `"${file.sha256}"`); // SDD §9: the SHA-256 of immutable content (no conditional GET in V1)
    res.setHeader('Accept-Ranges', 'none'); // no Range in V1 (SDD §9): a Range header is ignored and the full body is sent (RFC 9110)
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Referrer-Policy', 'no-referrer');
    // A ticket is a capability meant to be used by the product's client (possibly another origin, e.g. an inline image).
    if (route === 'ticket') res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setTimeout(this.config.upload.downloadIdleTimeoutMs, () => res.destroy()); // a client that stops reading is cut off

    const counter = new VerifiedDownload(size, file.sha256 as string);
    try {
      await pipeline(object.body, counter, res);
      log('ok', counter.bytes);
    } catch (e) {
      // Headers (and possibly bytes) are gone: the only safe end is closing the connection; the store stream is destroyed with it.
      if (!res.destroyed) res.destroy();
      // Classified by CAUSE: our own refusal of a short / long object, or a store failure mid-stream, is an integrity / storage failure
      // (destroying the response then also fires the close listener, so the signal alone cannot tell); only the client leaving is `aborted`.
      const failed = e instanceof ContentMismatch || isStorageError(e);
      if (e instanceof ContentMismatch) this.logger.warn(`file_storage_inconsistent file=${file.id} reason=${e.message}`);
      log(failed ? 'stream_failed' : abort.signal.aborted ? 'aborted' : 'stream_failed', counter.bytes);
    } finally {
      res.off('close', onClose);
      req.off('close', onClose);
    }
  }

  private readFailure(e: unknown, file: FileRow): HttpException {
    if (isStorageError(e)) {
      if (e.code === 'storage_not_found') {
        // The record says AVAILABLE but the object is gone: an integrity fault, reported (never auto-"repaired"; reconciliation is 17.7).
        this.logger.warn(`file_storage_inconsistent file=${file.id} reason=object_missing`);
        return fileError(500, 'file_content_missing', 'The file content is not available.');
      }
      if (e.code === 'storage_unavailable' || e.code === 'storage_timeout') return fileError(503, 'storage_unavailable', 'File storage is temporarily unavailable.');
      return fileError(500, 'storage_error', 'The file could not be read.');
    }
    return fileError(500, 'download_failed', 'The file could not be read.');
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────── helpers

  /**
   * The caller's own file in the presented organization, or `404 file_not_found` for anything else (no existence oracle). A `usage`
   * kind (Stage 17.8, F32) is charged after authorization and before the lookup, so a probe of foreign or missing ids spends budget too.
   */
  private async owned(caller: string, operation: FileOperation, req: Request, id: string, usage?: UsageKind): Promise<FileRow> {
    const policy = this.policy(caller, operation);
    const organizationId = this.organization(policy, organizationHeader(req));
    if (usage) await this.usage.admit(usage, caller, organizationId);
    const file = await this.files.findOwned({ ownerService: caller, organizationId }, id);
    if (!file) throw FILE_NOT_FOUND();
    return file;
  }

  private policy(caller: string, operation: FileOperation): CallerPolicy {
    const policy = this.config.callerPolicy.of(caller);
    if (!policy || !policy.operations.has(operation)) throw fileError(403, 'operation_not_allowed', 'Operation not allowed for this caller.');
    return policy;
  }

  private organization(policy: CallerPolicy, organizationId: string | null): string | null {
    if (organizationId !== null && policy.organizations === 'none') throw fileError(403, 'organization_not_allowed', 'This caller cannot act for an organization.');
    return organizationId;
  }
}

/** Only `AVAILABLE` files are served (SDD §5.1, §9). The owner learns why; nobody else ever reaches this check. */
function assertDownloadable(file: FileRow): void {
  if (file.status === 'AVAILABLE') return;
  if (file.status === 'DELETING' || file.status === 'DELETED') throw fileError(410, 'file_deleted', 'The file has been deleted.');
  throw fileError(409, 'file_not_available', 'The file is not available.');
}

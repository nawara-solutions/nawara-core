import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { DbService, RateLimitService } from '@nawara/service-kit';
import type { FileConfig } from '../config/file-config.js';
import { FILE_CONFIG } from '../config/file-config.token.js';
import { FileRepository, type FileRow } from '../persistence/file.repository.js';
import { FilePersistenceError } from '../persistence/persistence-error.js';
import { ticketDigest } from '../persistence/ticket-digest.js';
import { TicketRepository } from '../persistence/ticket.repository.js';
import type { CallerPolicy, FileOperation } from '../policy/caller-policy.js';
import type { FileMediaType } from '../policy/media-types.js';
import { STORAGE_PORT, type StoragePort } from '../storage/storage.port.js';
import { putDeadlineMs } from '../storage/streams.js';
import { decodeFileNameHeader } from './file-name.js';
import { ingest, UploadRefused } from './ingest.js';
import { declaredEssence } from './media-type.js';
import {
  attachHeader, contentDigest, declaredLength, FILE_NOT_FOUND, fileError, fileView, idempotencyKey, organizationHeader, refusalError,
  sizeBucket, TICKET_INVALID, uploadRequestHash, watchUpload, type FileView,
} from './upload-http.js';

export interface UploadResult {
  /** `false` for a replay (the same service upload, or the retry of a completed ticket): the body was not read or stored again. */
  created: boolean;
  file: FileView;
}

export interface IssuedUploadTicket {
  ticketId: string;
  /** `<FILE_PUBLIC_BASE_URL>/file/t/<token>`: the ONLY time the token exists outside the caller (only its digest is stored). */
  url: string;
  expiresAt: string;
}

/** Failed ticket redemptions per client (keyed address), per minute (F32). */
const TICKET_FAILURE_BUCKET = 'file_ticket_failures';

interface Receive {
  req: Request;
  file: FileRow;
  limit: number;
  allowed: ReadonlySet<FileMediaType>;
  declaredType?: string;
  fileName?: string;
  expectedSha256?: string;
  attach: boolean;
  declaredLength: number;
  route: 'service' | 'ticket';
}

class TicketNoLongerValid extends Error {}

/**
 * The upload lifecycle (Stage 17.5; ADR-0048, SDD §5, §7, §10, §11.1):
 *
 * - `issueUploadTicket`: a trusted service (service token, `issue_ticket`) gets a short-lived, single-use upload ticket bound to its
 *   intent (organization, size limit, types, attach flag). No file exists yet: the ticket creates one when redeemed.
 * - `redeemUploadTicket`: an untrusted client presents the ticket (no user token, no call to Auth). The ticket is CONSUMED by an atomic
 *   claim in the same transaction that creates the `UPLOADING` row and binds it to the ticket; the bytes then stream to the store.
 * - `serviceUpload`: a trusted service uploads its own bytes (`upload`), idempotent by Idempotency-Key + keyed request hash.
 * - `attach`: the owner marks its file attached (idempotent).
 *
 * The owner is ALWAYS the authenticated caller (or, for a ticket, the service that issued it); nothing in a request can set it.
 */
@Injectable()
export class UploadService {
  private readonly logger = new Logger('Upload');

  constructor(
    @Inject(FILE_CONFIG) private readonly config: FileConfig,
    private readonly files: FileRepository,
    private readonly tickets: TicketRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    private readonly db: DbService,
    private readonly limiter: RateLimitService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────────────────────────────── ticket issuance

  async issueUploadTicket(caller: string, input: { organizationId?: string | null; maxBytes: number; mediaTypes: FileMediaType[]; attach?: boolean }): Promise<IssuedUploadTicket> {
    const policy = this.policy(caller, 'issue_ticket');
    const organizationId = this.organization(policy, input.organizationId ?? null);
    if (input.maxBytes > policy.maxBytes!) throw fileError(403, 'max_bytes_not_allowed', 'maxBytes exceeds this caller\'s limit.');
    if (input.mediaTypes.some((t) => !policy.mediaTypes!.has(t))) throw fileError(403, 'media_type_not_allowed', 'A media type is not allowed for this caller.');
    for (let attempt = 0; ; attempt++) {
      const token = randomBytes(32).toString('base64url'); // 256 bits from the CSPRNG (F35)
      try {
        const row = await this.tickets.recordUpload({
          scope: { ownerService: caller, organizationId },
          tokenDigest: ticketDigest(token)!,
          lifetimeSeconds: this.config.upload.ticketTtlSeconds,
          maxBytes: input.maxBytes,
          mediaTypes: [...new Set(input.mediaTypes)],
          attach: input.attach ?? false,
        });
        this.logger.log(`file_upload_ticket_issued owner=${caller} ticket=${row.id} ttl_s=${this.config.upload.ticketTtlSeconds}`);
        return { ticketId: row.id, url: `${this.config.upload.publicBaseUrl}/file/t/${token}`, expiresAt: row.expiresAt.toISOString() };
      } catch (e) {
        if (e instanceof FilePersistenceError && e.code === 'ticket_digest_collision' && attempt < 2) continue; // 2^-256: draw again
        throw e;
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────── ticket redemption

  async redeemUploadTicket(token: string, req: Request): Promise<UploadResult> {
    const client = createHmac('sha256', this.config.upload.rateLimitKey).update(req.ip ?? req.socket.remoteAddress ?? 'unknown').digest('hex');
    const rule = { limit: this.config.upload.ticketFailureLimit, windowSec: 60 };
    // A client over its failure budget is refused for EVERY redemption (valid or not): no oracle, even while blocked.
    if (!(await this.limiter.peek(TICKET_FAILURE_BUCKET, client, rule)).allowed) throw fileError(429, 'rate_limited', 'Too many requests.');
    const invalid = async () => {
      await this.limiter.hit(TICKET_FAILURE_BUCKET, client, rule);
      return TICKET_INVALID();
    };

    const digest = ticketDigest(token);
    if (!digest) throw await invalid(); // not even the shape of a token: no database read
    const length = declaredLength(req);
    if (length > this.config.maxBytes) throw fileError(413, 'file_too_large', 'The file exceeds the size allowed for this upload.');
    const { fileName, declaredType } = this.declaration(req);

    let claimed: { file: FileRow; limit: number; allowed: ReadonlySet<FileMediaType>; attach: boolean; owner: string } | undefined;
    try {
      claimed = await this.db.tx(async (q) => {
        // THE consumption point: one conditional UPDATE (not revoked, not expired, operation upload, unused). A concurrent claim waits
        // on the row lock and then fails, so exactly one redemption ever proceeds.
        const ticket = await this.tickets.claimUse(digest, 'upload', q);
        if (!ticket) return undefined;
        const policy = this.config.callerPolicy.of(ticket.issuedBy);
        // The issuer must STILL hold `issue_ticket` (and its organization mode) in the current policy (SDD §11.1 bindings).
        if (!policy?.operations.has('issue_ticket') || (ticket.organizationId !== null && policy.organizations === 'none')) throw new TicketNoLongerValid();
        const allowed = new Set((ticket.mediaTypes ?? []).filter((t) => policy.mediaTypes?.has(t)));
        const limit = Math.min(this.config.maxBytes, policy.maxBytes ?? 0, Number(ticket.maxBytes));
        // Refused BEFORE anything is created: the transaction rolls back and the ticket stays unused (the client may retry correctly).
        if (length > limit) throw fileError(413, 'file_too_large', 'The file exceeds the size allowed for this upload.');
        const file = await this.files.createUploading({
          scope: { ownerService: ticket.issuedBy, organizationId: ticket.organizationId },
          originalName: fileName,
          declaredMediaType: declaredType,
          storage: { provider: this.storage.provider, keyPrefix: this.config.storage.keyPrefix },
          uploadLeaseSeconds: this.leaseSeconds(limit),
          attachment: { deadlineSeconds: this.config.upload.attachTtlSeconds },
        }, q);
        await this.tickets.bindCreatedFile(q, ticket.id, file.id);
        return { file, limit, allowed, attach: ticket.attach === true, owner: ticket.issuedBy };
      });
    } catch (e) {
      if (e instanceof TicketNoLongerValid) throw await invalid();
      throw e;
    }
    if (!claimed) return this.redemptionRetry(digest, invalid);
    const file = await this.receive({
      req, file: claimed.file, limit: claimed.limit, allowed: claimed.allowed, declaredType, fileName, attach: claimed.attach,
      declaredLength: length, route: 'ticket',
    });
    return { created: true, file: fileView(file) };
  }

  /**
   * A used ticket (SDD §10 / §11.1): the retry of a COMPLETED redemption returns the created file (the client lost the response);
   * one still in progress is `409 upload_in_progress`; anything else is `ticket_invalid`. Nothing is written.
   */
  private async redemptionRetry(digest: NonNullable<ReturnType<typeof ticketDigest>>, invalid: () => Promise<Error>): Promise<UploadResult> {
    const used = await this.tickets.findUsedUpload(digest);
    const file = used?.fileId ? await this.files.findOwned({ ownerService: used.issuedBy, organizationId: used.organizationId }, used.fileId) : undefined;
    if (file?.status === 'AVAILABLE' || file?.status === 'VERIFYING') return { created: false, file: fileView(file) };
    if (file?.status === 'UPLOADING') throw fileError(409, 'upload_in_progress', 'This upload is already in progress.');
    throw await invalid();
  }

  // ────────────────────────────────────────────────────────────────────────────────────────────────── service upload

  async serviceUpload(caller: string, req: Request): Promise<UploadResult> {
    const policy = this.policy(caller, 'upload');
    const organizationId = this.organization(policy, organizationHeader(req));
    const key = idempotencyKey(req);
    const length = declaredLength(req);
    const limit = Math.min(this.config.maxBytes, policy.maxBytes!);
    if (length > limit) throw fileError(413, 'file_too_large', 'The file exceeds the size allowed for this upload.');
    const { fileName, declaredType } = this.declaration(req);
    const expectedSha256 = contentDigest(req);
    const attach = attachHeader(req);
    const requestHash = uploadRequestHash(this.config.upload.requestHashKey, {
      organizationId, fileName: fileName ?? null, declaredType: declaredType ?? null, sizeBytes: length, sha256: expectedSha256 ?? null,
    });
    let file: FileRow;
    try {
      file = await this.files.createUploading({
        scope: { ownerService: caller, organizationId },
        originalName: fileName,
        declaredMediaType: declaredType,
        idempotency: { key, requestHash },
        storage: { provider: this.storage.provider, keyPrefix: this.config.storage.keyPrefix },
        uploadLeaseSeconds: this.leaseSeconds(limit),
        attachment: attach ? { attached: true } : { deadlineSeconds: this.config.upload.attachTtlSeconds },
      });
    } catch (e) {
      if (e instanceof FilePersistenceError && e.code === 'idempotency_key_in_use') return this.idempotentReplay(caller, key, requestHash);
      throw e;
    }
    const done = await this.receive({
      req, file, limit, allowed: policy.mediaTypes!, declaredType, fileName, expectedSha256, attach: false, declaredLength: length, route: 'service',
    });
    return { created: true, file: fileView(done) };
  }

  /** Same key + same declaration → the same file (bytes not read again); a different declaration → 422; still uploading → 409. */
  private async idempotentReplay(caller: string, key: string, requestHash: string): Promise<UploadResult> {
    const existing = await this.files.findLiveByIdempotencyKey(caller, key);
    if (!existing) throw fileError(409, 'upload_in_progress', 'This upload is being retried; try again.'); // it just failed: retryable
    if (!sameHash(existing.requestHash, requestHash)) throw fileError(422, 'idempotency_key_reused', 'This Idempotency-Key was used for a different upload.');
    if (existing.status === 'UPLOADING') throw fileError(409, 'upload_in_progress', 'This upload is already in progress.');
    return { created: false, file: fileView(existing) };
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────────── attach

  async attach(caller: string, req: Request, id: string): Promise<FileView> {
    const policy = this.policy(caller, 'attach');
    const organizationId = this.organization(policy, organizationHeader(req));
    const outcome = await this.files.attach({ ownerService: caller, organizationId }, id);
    if (outcome.kind === 'not_found') throw FILE_NOT_FOUND(); // another owner or organization looks exactly like a missing file
    if (outcome.kind === 'not_available') throw fileError(409, 'file_not_available', 'The file can no longer be attached.');
    return fileView(outcome.file);
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────── the bytes

  /**
   * Streams the request into the store and settles the row: `AVAILABLE` only after the store has published the complete object;
   * any refusal or failure → `REJECTED` / `FAILED` (a failed upload never appears available).
   */
  private async receive(r: Receive): Promise<FileRow> {
    const started = performance.now();
    const watch = watchUpload(r.req, this.config.upload.idleTimeoutMs);
    const log = (outcome: string, extra = '') =>
      this.logger.log(`file_upload route=${r.route} outcome=${outcome} file=${r.file.id} owner=${r.file.ownerService} duration_ms=${Math.round(performance.now() - started)}${extra}`);
    try {
      const accepted = await ingest({
        body: r.req, declaredLength: r.declaredLength, limit: r.limit, allowed: r.allowed, declaredType: r.declaredType, fileName: r.fileName,
        expectedSha256: r.expectedSha256, storage: this.storage, storageKey: r.file.storageKey, signal: watch.signal,
      });
      let done: FileRow | undefined;
      try {
        done = await this.files.completeUpload(r.file.id, accepted, r.attach);
      } catch (e) {
        await this.abandon(r.file, 'finalize_failed');
        log('finalize_failed');
        throw e; // an opaque 500: the object is removed (best effort) and the row marked FAILED (best effort; else the lease sweep)
      }
      if (!done) {
        await this.abandon(r.file, 'finalize_failed');
        log('finalize_failed');
        throw fileError(500, 'upload_failed', 'The upload could not be completed.');
      }
      log('available', ` media=${accepted.mediaType} size=${sizeBucket(accepted.sizeBytes)}`);
      return done;
    } catch (e) {
      if (!(e instanceof UploadRefused)) throw e;
      await this.files.refuseUpload(r.file.id, e.refusal.status, e.refusal.failureCode).catch(() => this.logger.warn(`file_upload_refuse_failed file=${r.file.id}`));
      if (e.refusal.failureCode === 'storage_timeout') await this.forget(r.file); // the PUT's outcome is unknown: remove it if it landed
      log(e.refusal.failureCode);
      throw refusalError(e);
    } finally {
      watch.release();
    }
  }

  /** After the object was stored but the row could not be finalized: remove the object and fail the row, both best effort. */
  private async abandon(file: FileRow, failureCode: string): Promise<void> {
    await this.forget(file);
    await this.files.refuseUpload(file.id, 'FAILED', failureCode).catch(() => this.logger.warn(`file_upload_refuse_failed file=${file.id}`));
  }

  /** Best-effort, bounded delete of an upload's object (idempotent: a missing object is fine). Leftovers: 17.7 reconciliation. */
  private async forget(file: FileRow): Promise<void> {
    await this.storage.delete(file.storageKey, { signal: AbortSignal.timeout(this.config.storage.requestTimeoutMs) }).catch(() =>
      this.logger.warn(`file_upload_object_cleanup_failed file=${file.id}`));
  }

  // ─────────────────────────────────────────────────────────────────────────────────────────────────────── helpers

  private policy(caller: string, operation: FileOperation): CallerPolicy {
    const policy = this.config.callerPolicy.of(caller);
    if (!policy || !policy.operations.has(operation)) throw fileError(403, 'operation_not_allowed', 'Operation not allowed for this caller.');
    return policy;
  }

  /** `none`: platform files only; `request`: the caller may assert an organization (or none, for a platform file). */
  private organization(policy: CallerPolicy, organizationId: string | null): string | null {
    if (organizationId !== null && policy.organizations === 'none') throw fileError(403, 'organization_not_allowed', 'This caller cannot act for an organization.');
    return organizationId;
  }

  /** The upload lease: the store's whole-transfer bound for this size, plus a margin (a crashed upload is swept after it, 17.7). */
  private leaseSeconds(limit: number): number {
    return Math.ceil(putDeadlineMs(limit, this.config.storage.requestTimeoutMs, this.config.storage.minThroughputBytesPerSecond) / 1000) + 60;
  }

  /** The untrusted declarations: a sanitized name (`X-File-Name`, percent-encoded UTF-8) and a declared type (a hint only). */
  private declaration(req: Request): { fileName?: string; declaredType?: string } {
    const name = decodeFileNameHeader(typeof req.headers['x-file-name'] === 'string' ? req.headers['x-file-name'] : undefined);
    if (name.malformed) throw fileError(400, 'validation_error', 'X-File-Name must be percent-encoded UTF-8.');
    const declaredType = declaredEssence(req.headers['content-type']);
    if (declaredType !== undefined && !/^[\x21-\x7e]{1,255}$/.test(declaredType)) throw fileError(400, 'validation_error', 'Content-Type is invalid.');
    return { fileName: name.name, declaredType };
  }
}

function sameHash(stored: string | null, computed: string): boolean {
  if (!stored) return false;
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(computed, 'hex');
  return a.length === 32 && b.length === 32 && timingSafeEqual(a, b);
}

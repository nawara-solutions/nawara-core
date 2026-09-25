import { createHmac } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { canonicalJson } from '@nawara/service-kit';
import type { FileRow } from '../persistence/file.repository.js';
import { REFUSALS, UploadRefused } from './ingest.js';

/** One stable error shape (the kit filter adds `statusCode`, `error`, `requestId`): a machine code, a generic message. */
export const fileError = (status: number, code: string, message: string) => new HttpException({ message, code }, status);

export const FILE_NOT_FOUND = () => fileError(404, 'file_not_found', 'No such file.');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Upload and ticket routes (Stage 17.5): `Connection: close` so an early answer (401, 411, 413, 415, `ticket_invalid`) never makes the
 * server read and discard a large unread body to keep the connection alive; `Cache-Control: no-store` because ticket URLs and file
 * metadata must not be cached (SDD §11.1; helmet already sends `Referrer-Policy: no-referrer`).
 */
export function uploadRouteHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Connection', 'close');
  res.setHeader('Cache-Control', 'no-store');
  next();
}

/** The byte count the client commits to (SDD §7: required). A chunked body without one is `411 length_required`. */
export function declaredLength(req: Request): number {
  const raw = req.headers['content-length'];
  if (raw === undefined || req.headers['transfer-encoding'] !== undefined) throw fileError(411, 'length_required', 'Content-Length is required.');
  if (!/^\d{1,15}$/.test(raw)) throw fileError(400, 'validation_error', 'Content-Length is invalid.');
  return Number(raw);
}

/** `X-Organization-Id`: an optional UUID (validated; the caller policy decides whether it may be sent). */
export function organizationHeader(req: Request): string | null {
  const raw = req.headers['x-organization-id'];
  if (raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !UUID.test(raw)) throw fileError(400, 'validation_error', 'X-Organization-Id must be a UUID.');
  return raw;
}

/** `Idempotency-Key` for a service upload: required, printable, at most 255 characters (the schema's rule). */
export function idempotencyKey(req: Request): string {
  const raw = req.headers['idempotency-key'];
  if (typeof raw !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(raw)) throw fileError(400, 'validation_error', 'Idempotency-Key is required (1-255 printable characters).');
  return raw;
}

/** `Content-Digest: sha-256=:<base64>:` (RFC 9530). Optional; other algorithms are ignored; a malformed SHA-256 value is refused. */
export function contentDigest(req: Request): string | undefined {
  const raw = req.headers['content-digest'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length > 1024) throw fileError(400, 'validation_error', 'Content-Digest is invalid.');
  const match = /(?:^|,)\s*sha-256=:([A-Za-z0-9+/]{43}=):\s*(?:,|$)/.exec(raw);
  if (!match) {
    if (/(?:^|,)\s*sha-256=/.test(raw)) throw fileError(400, 'validation_error', 'Content-Digest sha-256 is invalid.');
    return undefined;
  }
  return Buffer.from(match[1]!, 'base64').toString('hex');
}

/** `X-Attach: true` (a service creating a file it attaches at once, SDD §5.2); anything but `true` / `false` is refused. */
export function attachHeader(req: Request): boolean {
  const raw = req.headers['x-attach'];
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'true') return true;
  throw fileError(400, 'validation_error', 'X-Attach must be true or false.');
}

/**
 * The service-upload request hash (SDD §10, F22): HMAC-SHA-256 under FILE_REQUEST_HASH_KEY over the DECLARED metadata only
 * (organization, name, declared type, length, client digest), never the bytes. Keyed because declared metadata can be guessable.
 */
export function uploadRequestHash(key: Buffer, declared: { organizationId: string | null; fileName: string | null; declaredType: string | null; sizeBytes: number; sha256: string | null }): string {
  return createHmac('sha256', key).update(`nawara.file.upload.v1|${canonicalJson(declared)}`, 'utf8').digest('hex');
}

/**
 * Watches an upload's request: a client disconnect or `idleMs` without a byte aborts the signal with the matching refusal (the store
 * then publishes nothing). `release()` restores the socket and detaches the listeners.
 */
export function watchUpload(req: Request, idleMs: number): { signal: AbortSignal; release: () => void } {
  const controller = new AbortController();
  const onClose = () => {
    if (!req.complete) {
      controller.abort(REFUSALS.aborted());
      return;
    }
    // Stage 17.9: the client has sent every byte, so it can no longer be idle; the rest (the store accepting the tail) is bounded by
    // the store's own deadlines. Without this the socket timeout set below outlived the body: Node does not deliver a socket timeout
    // to a COMPLETE request, and with nobody listening it destroys the socket, so a slow store answered nothing after `idleMs`.
    req.setTimeout(0);
  };
  const onError = () => controller.abort(REFUSALS.aborted());
  req.once('close', onClose);
  req.once('error', onError);
  const onIdle = () => {
    // Stage 17.9: silence on the socket is not always the client's. When the store stops reading, backpressure leaves bytes UNREAD in
    // this request's buffer: the CLIENT is not idle, the store is, and the store's own idle bound (FILE_STORAGE_IDLE_TIMEOUT_MS, longer
    // than this one) ends the upload as `storage_timeout`. Re-arm instead of blaming the client. (Not `readableFlowing`: the pipeline
    // reads through an async iterator, which keeps the stream in paused mode whether or not anything is waiting.)
    if (req.readableLength > 0) {
      req.setTimeout(idleMs, onIdle);
      return;
    }
    controller.abort(REFUSALS.idle());
    req.destroy();
  };
  req.setTimeout(idleMs, onIdle);
  return {
    signal: controller.signal,
    release: () => {
      req.off('close', onClose);
      req.off('error', onError);
      req.setTimeout(0);
    },
  };
}

/** What an owner or an uploader sees of a file. Never the storage key, provider, idempotency data or failure internals. */
export interface FileView {
  id: string;
  status: string;
  organizationId: string | null;
  originalName: string | null;
  mediaType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  attachedAt: string | null;
  attachDeadline: string | null;
  createdAt: string;
  availableAt: string | null;
}

export function fileView(f: FileRow): FileView {
  return {
    id: f.id,
    status: f.status,
    organizationId: f.organizationId,
    originalName: f.originalName,
    mediaType: f.mediaType,
    sizeBytes: f.sizeBytes === null ? null : Number(f.sizeBytes),
    sha256: f.sha256,
    attachedAt: f.attachedAt?.toISOString() ?? null,
    attachDeadline: f.attachDeadline?.toISOString() ?? null,
    createdAt: f.createdAt.toISOString(),
    availableAt: f.availableAt?.toISOString() ?? null,
  };
}

export const refusalError = (e: UploadRefused) => fileError(e.refusal.http.status, e.refusal.http.code, e.refusal.http.message);

/** A bounded size bucket for logs (never the exact size of an identifiable file in a metric label). */
export function sizeBucket(bytes: number): string {
  if (bytes <= 100 * 1024) return 'le_100k';
  if (bytes <= 1024 * 1024) return 'le_1m';
  if (bytes <= 10 * 1024 * 1024) return 'le_10m';
  return 'gt_10m';
}

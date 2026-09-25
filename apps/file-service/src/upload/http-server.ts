import type { Server } from 'node:http';
import type { FileConfig } from '../config/file-config.js';
import { putDeadlineMs } from '../storage/streams.js';

/**
 * The server-wide request bound (Stage 17.5). Node's default `requestTimeout` (300 s for the WHOLE request) would cut a legitimate
 * FILE_MAX_BYTES upload on a slow link; it becomes the store's whole-transfer bound for the largest allowed file plus a margin. Stalled
 * uploads are cut much sooner by the per-upload idle timeout (FILE_UPLOAD_IDLE_TIMEOUT_MS); headers still have Node's 60 s.
 */
export function uploadRequestTimeoutMs(config: FileConfig): number {
  return putDeadlineMs(config.maxBytes, config.storage.requestTimeoutMs, config.storage.minThroughputBytesPerSecond) + 60_000;
}

/**
 * Stage 17.9: the socket inactivity bound of every connection. Node's default (`server.timeout` = 0) never closes a connection that
 * sends nothing at all: measured, 500 silent connections held 500 descriptors indefinitely, while a partial request line was closed
 * by `headersTimeout` (60 s) and an idle keep-alive by `keepAliveTimeout` (5 s). A silent socket now gets the same bound as a slow
 * header. Requests in flight are unaffected: uploads and downloads set their own per-request idle timers (which replace this one),
 * and nothing else waits on its socket longer than one database wait, which the bound covers.
 */
export const SILENT_SOCKET_GRACE_MS = 5_000;

/** Never shorter than one database wait (a pooled client + one statement), so a request waiting on the database is not cut. */
export function silentSocketTimeoutMs(headersTimeoutMs: number, config: FileConfig): number {
  return Math.max(headersTimeoutMs, config.db.connectionTimeoutMs + config.db.queryTimeoutMs) + SILENT_SOCKET_GRACE_MS;
}

export function configureHttpServer(server: Server, config: FileConfig): void {
  server.requestTimeout = uploadRequestTimeoutMs(config);
  server.timeout = silentSocketTimeoutMs(server.headersTimeout, config);
}

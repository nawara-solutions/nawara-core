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

export function configureHttpServer(server: Server, config: FileConfig): void {
  server.requestTimeout = uploadRequestTimeoutMs(config);
}

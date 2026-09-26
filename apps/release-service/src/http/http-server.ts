import type { Server } from 'node:http';
import type { ReleaseConfig } from '../config/release-config.js';

/**
 * The socket inactivity bound of every connection (the File / Audit convention): Node's default `server.timeout` (0) never closes a
 * connection that sends nothing, so a silent socket gets the same bound as a slow header, never shorter than one database wait.
 */
export const SILENT_SOCKET_GRACE_MS = 5_000;

export function silentSocketTimeoutMs(headersTimeoutMs: number, config: ReleaseConfig): number {
  return Math.max(headersTimeoutMs, config.db.connectionTimeoutMs + config.db.queryTimeoutMs) + SILENT_SOCKET_GRACE_MS;
}

export function configureHttpServer(server: Server, config: ReleaseConfig): void {
  server.timeout = silentSocketTimeoutMs(server.headersTimeout, config);
}

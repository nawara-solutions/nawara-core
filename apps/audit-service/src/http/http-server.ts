import type { Server } from 'node:http';
import type { AuditConfig } from '../config/audit-config.js';

/**
 * The socket inactivity bound of every connection (the File Service Stage 17.9 finding O-5, applied here from the start). Node's
 * default `server.timeout` (0) never closes a connection that sends nothing at all, while a partial request line is closed by
 * `headersTimeout` (60 s) and an idle keep-alive by `keepAliveTimeout` (5 s). A silent socket gets the same bound as a slow header,
 * never shorter than one database wait (a pooled client + one statement), so a request waiting on the database is not cut.
 * Node's other defaults are kept (headers 60 s, keep-alive 5 s, request 300 s: audit requests are small reads).
 */
export const SILENT_SOCKET_GRACE_MS = 5_000;

export function silentSocketTimeoutMs(headersTimeoutMs: number, config: AuditConfig): number {
  return Math.max(headersTimeoutMs, config.db.connectionTimeoutMs + config.db.queryTimeoutMs) + SILENT_SOCKET_GRACE_MS;
}

export function configureHttpServer(server: Server, config: AuditConfig): void {
  server.timeout = silentSocketTimeoutMs(server.headersTimeout, config);
}

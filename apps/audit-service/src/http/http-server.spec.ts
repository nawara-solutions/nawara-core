import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { loadAuditConfig } from '../config/audit-config.js';
import { SILENT_SOCKET_GRACE_MS, configureHttpServer, silentSocketTimeoutMs } from './http-server.js';

const config = (over: NodeJS.ProcessEnv = {}) => loadAuditConfig({ DATABASE_URL: 'postgres://audit_app:pw@db/audit', ...over });

describe('HTTP server bounds', () => {
  it('a silent socket is closed after the headers timeout, or one full database wait when that is longer, plus a grace', () => {
    expect(silentSocketTimeoutMs(60_000, config())).toBe(60_000 + SILENT_SOCKET_GRACE_MS); // 5 s + 35 s < 60 s
    expect(silentSocketTimeoutMs(60_000, config({ DB_CONNECTION_TIMEOUT_MS: '30000', DB_STATEMENT_TIMEOUT_MS: '60000', DB_QUERY_TIMEOUT_MS: '65000' }))).toBe(95_000 + SILENT_SOCKET_GRACE_MS);
  });

  it('is applied to the real server; the other Node defaults are kept', () => {
    const server = createServer();
    const headers = server.headersTimeout;
    const keepAlive = server.keepAliveTimeout;
    configureHttpServer(server, config());
    expect(server.timeout).toBe(65_000);
    expect(server.headersTimeout).toBe(headers);
    expect(server.keepAliveTimeout).toBe(keepAlive);
  });
});

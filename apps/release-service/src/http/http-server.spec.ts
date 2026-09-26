import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { loadReleaseConfig } from '../config/release-config.js';
import { SILENT_SOCKET_GRACE_MS, configureHttpServer, silentSocketTimeoutMs } from './http-server.js';

describe('the silent-socket bound', () => {
  it('is at least the header timeout and one database wait, plus a grace; the server gets it', () => {
    const config = loadReleaseConfig({ DATABASE_URL: 'postgres://release_app:x@db/release', RABBITMQ_URL: 'amqp://broker' });
    const expected = Math.max(60_000, config.db.connectionTimeoutMs + config.db.queryTimeoutMs) + SILENT_SOCKET_GRACE_MS;
    expect(silentSocketTimeoutMs(60_000, config)).toBe(expected);
    const server = createServer();
    configureHttpServer(server, config);
    expect(server.timeout).toBe(silentSocketTimeoutMs(server.headersTimeout, config));
  });
});

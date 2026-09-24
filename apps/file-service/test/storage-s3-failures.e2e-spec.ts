import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { S3Storage, type S3StorageOptions } from '../src/storage/s3-storage.js';
import { bodyOf, code, newKey, sig } from './support/storage-contract.js';

/**
 * Stage 17.4: storage outages at the protocol level, against controlled fake servers (deterministic; no S3 server needed): each ends
 * in a bounded time with a provider-neutral code, retries stay bounded (and never for a write), nothing leaks, the process lives on.
 */
describe('S3 adapter under storage outages (fake servers)', () => {
  const opts = (endpoint: string, over: Partial<S3StorageOptions> = {}): S3StorageOptions => ({
    endpoint, region: 'us-east-1', bucket: 'outage-bucket', accessKeyId: 'AKIDOUTAGE', secretAccessKey: 'outage-secret-not-real-000', forcePathStyle: true,
    connectTimeoutMs: 500, idleTimeoutMs: 1_000, requestTimeoutMs: 1_500, minThroughputBytesPerSecond: 65_536, maxAttempts: 3, ...over,
  });
  const elapsed = async (f: () => Promise<unknown>) => {
    const t0 = Date.now();
    const r = await f().catch((e: unknown) => e);
    return { r, ms: Date.now() - t0 };
  };
  const stores: S3Storage[] = [];
  const store = (endpoint: string, over: Partial<S3StorageOptions> = {}) => {
    const s = new S3Storage(opts(endpoint, over));
    stores.push(s);
    return s;
  };
  const consoleSpies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];

  let hits = 0;
  let status = 503;
  let s3Name = 'ServiceUnavailable';
  let http: Server;
  let httpUrl = '';
  let silent: TcpServer;
  let silentUrl = '';
  const sockets = new Set<Socket>();
  beforeAll(async () => {
    http = createServer((req: IncomingMessage, res: ServerResponse) => {
      hits += 1;
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'content-type': 'application/xml', 'x-amz-request-id': 'FAKE-REQUEST-ID-123' });
        res.end(req.method === 'HEAD' ? undefined : `<?xml version="1.0"?><Error><Code>${s3Name}</Code><Message>at bucket outage-bucket host 10.9.8.7</Message><RequestId>FAKE-REQUEST-ID-123</RequestId></Error>`);
      });
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    httpUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    silent = createTcpServer((socket) => {
      sockets.add(socket); // accepts the connection and never answers
      socket.on('error', () => undefined);
    });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', r));
    silentUrl = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    for (const s of stores) s.close();
    for (const s of sockets) s.destroy();
    await new Promise((r) => http.close(r));
    await new Promise((r) => silent.close(r));
  });

  it('connection refused: `storage_unavailable` for every operation, quickly', async () => {
    const closedPort = createTcpServer();
    await new Promise<void>((r) => closedPort.listen(0, '127.0.0.1', r));
    const port = (closedPort.address() as AddressInfo).port;
    await new Promise((r) => closedPort.close(r));
    const s = store(`http://127.0.0.1:${port}`);
    for (const op of <Array<() => Promise<unknown>>>[() => s.get(newKey(), { signal: sig() }), () => s.head(newKey(), { signal: sig() }), () => s.delete(newKey(), { signal: sig() }),
      () => s.put(newKey(), bodyOf(randomBytes(10)), { sizeBytes: 10, contentType: 'x', signal: sig() })]) {
      const { r, ms } = await elapsed(op);
      expect(code(r)).toBe('storage_unavailable');
      expect(ms).toBeLessThan(5_000);
    }
  });

  it('a server that accepts and never answers: `storage_timeout` within the deadline, for reads and writes', async () => {
    const s = store(silentUrl);
    for (const op of <Array<() => Promise<unknown>>>[() => s.get(newKey(), { signal: sig() }), () => s.head(newKey(), { signal: sig() }),
      () => s.put(newKey(), bodyOf(randomBytes(10)), { sizeBytes: 10, contentType: 'x', signal: sig() })]) {
      const { r, ms } = await elapsed(op);
      expect(code(r)).toBe('storage_timeout');
      expect(ms).toBeLessThan(4_000); // request deadline 1.5 s (+ bounded retry of the idempotent reads)
    }
  });

  it('5xx: idempotent operations retry a bounded number of times; a write is never retried (its body is a one-shot stream)', async () => {
    status = 503;
    s3Name = 'ServiceUnavailable';
    const s = store(httpUrl);
    hits = 0;
    expect(code(await s.get(newKey(), { signal: sig() }).catch((e: unknown) => e))).toBe('storage_unavailable');
    expect(hits).toBe(3); // FILE_STORAGE_MAX_ATTEMPTS
    hits = 0;
    expect(code(await s.delete(newKey(), { signal: sig() }).catch((e: unknown) => e))).toBe('storage_unavailable');
    expect(hits).toBe(3);
    hits = 0;
    expect(code(await s.put(newKey(), bodyOf(randomBytes(1000)), { sizeBytes: 1000, contentType: 'x', signal: sig() }).catch((e: unknown) => e))).toBe('storage_unavailable');
    expect(hits).toBe(1);
  });

  it('access denied: `storage_rejected`, not retried, and nothing of the provider (host, bucket, request id, message) in the error', async () => {
    status = 403;
    s3Name = 'AccessDenied';
    const s = store(httpUrl);
    hits = 0;
    const e = await s.get(newKey(), { signal: sig() }).catch((x: unknown) => x);
    expect(code(e)).toBe('storage_rejected');
    expect(hits).toBe(1);
    const visible = `${String(e)} ${JSON.stringify(e)} ${(e as Error).stack?.split('\n')[0]}`;
    for (const leak of ['outage-bucket', '10.9.8.7', 'FAKE-REQUEST-ID', '127.0.0.1', 'AKIDOUTAGE', 'outage-secret']) expect(visible).not.toContain(leak);
    expect((e as { cause?: unknown }).cause).toBeUndefined();
  });

  it('the process lives on and the SDK wrote nothing to the console', () => {
    expect(process.exitCode ?? 0).toBe(0);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ServiceUnavailableException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpAuthClient, runWithRequestContext } from '../src/index.js';

const seen: IncomingMessage[] = [];
let server: Server;
let base: string;
let mode: 'ok' | 'unauthorized' | 'error' | 'hang' | 'garbage' = 'ok';

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    if (mode === 'hang') return; // never answers
    if (mode === 'unauthorized') return void res.writeHead(401).end();
    if (mode === 'error') return void res.writeHead(500).end();
    res.setHeader('content-type', 'application/json');
    if (mode === 'garbage') return void res.end('{"unexpected":true}');
    if (req.url === '/auth/me') {
      return void res.end(JSON.stringify({ id: 'u1', adminTier: null, isActive: true, memberships: [{ id: 'm1', organization: { id: 'o1' }, platform: { id: 'p1' }, status: 'active', isOrganizationAdmin: false }] }));
    }
    if (req.url?.startsWith('/auth/platform-access/')) return void res.end(JSON.stringify({ platformId: 'p1', allowed: true }));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const client = () => new HttpAuthClient({ baseUrl: base, timeoutMs: 300 });

describe('HttpAuthClient (end-user identity comes from Auth, live)', () => {
  it('returns the identity and memberships Auth reports', async () => {
    mode = 'ok';
    const id = await client().getIdentity('user-bearer');
    expect(id).toMatchObject({ id: 'u1', isActive: true });
    expect(id?.memberships[0]).toMatchObject({ organization: { id: 'o1' }, status: 'active' });
    expect(await client().hasPlatformAccess('user-bearer', 'p1')).toBe(true);
  });

  it('sends ONLY the end user bearer to Auth (never a service credential) and forwards the correlation id', async () => {
    mode = 'ok';
    seen.length = 0;
    await runWithRequestContext({ requestId: 'req-12345678', correlationId: 'corr-12345678' }, () => client().getIdentity('user-bearer'));
    expect(seen[0].headers.authorization).toBe('Bearer user-bearer');
    expect(seen[0].headers['x-correlation-id']).toBe('corr-12345678');
    expect(Object.keys(seen[0].headers).filter((h) => /service|token/i.test(h))).toEqual([]);
  });

  it('treats an invalid token as "no identity" / "no access"', async () => {
    mode = 'unauthorized';
    expect(await client().getIdentity('bad')).toBeNull();
    expect(await client().hasPlatformAccess('bad', 'p1')).toBe(false);
  });

  it('fails CLOSED when Auth is unavailable, slow or answers nonsense', async () => {
    for (const m of ['error', 'hang', 'garbage'] as const) {
      mode = m;
      await expect(client().getIdentity('u'), m).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    await expect(new HttpAuthClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 }).getIdentity('u')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});

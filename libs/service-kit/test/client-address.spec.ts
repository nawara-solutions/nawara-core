import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createTestApp } from './support/app.js';
import { EnvReader, clientAddress, loadBaseConfig, loadTrustProxyHops, normalizeAddress, rateLimitClientAddress, rateLimitIdentity } from '../src/index.js';

const req = (peer: string, xff?: string | string[]) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as never;

describe('Stage 22 F3: the trusted client address (no client can choose it)', () => {
  it('hops=0: the TCP peer; a spoofed X-Forwarded-For is ignored', () => {
    expect(clientAddress(req('198.51.100.7'), 0)).toBe('198.51.100.7');
    expect(clientAddress(req('198.51.100.7', '1.2.3.4'), 0)).toBe('198.51.100.7');
    expect(clientAddress(req('198.51.100.7', '1.2.3.4, 203.0.113.7'), 0)).toBe('198.51.100.7');
  });

  it('hops=1: the entry our proxy appended (the rightmost), never the client-written one left of it', () => {
    expect(clientAddress(req('10.0.0.2', '203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientAddress(req('10.0.0.2', '1.2.3.4, 203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(clientAddress(req('10.0.0.2', ['1.2.3.4', '203.0.113.7']), 1)).toBe('203.0.113.7');
  });

  it('hops=2: the entry the OUTER trusted proxy appended, read from the right; the spoofed leftmost never wins', () => {
    expect(clientAddress(req('10.0.0.2', '1.2.3.4, 203.0.113.7, 198.51.100.9'), 2)).toBe('203.0.113.7');
    expect(clientAddress(req('10.0.0.2', '9.9.9.9, 1.2.3.4, 203.0.113.7, 198.51.100.9'), 2)).toBe('203.0.113.7');
    // a chain shorter than the hop count (the outer proxy was not on the path): its leftmost entry, appended by a trusted proxy
    expect(clientAddress(req('10.0.0.2', '203.0.113.7'), 2)).toBe('203.0.113.7');
  });

  it('agrees with Express reading the same chain with the same numeric trust proxy', async () => {
    for (const hops of [1, 2, 3]) {
      const app = express().set('trust proxy', hops).get('/', (r, s) => s.json({ express: r.ip, kit: clientAddress(r, hops) }));
      const r = await request(app).get('/').set('x-forwarded-for', '1.2.3.4, 203.0.113.7, 198.51.100.9');
      expect(r.body.kit).toBe(r.body.express);
    }
  });

  it('an unusable entry falls back to the peer (a shared, trusted bucket), never to client data', () => {
    for (const bad of [undefined, '', ' , ', 'not-an-ip', 'x'.repeat(3000), '1.2.3.4, not-an-ip']) expect(clientAddress(req('10.0.0.2', bad), 1)).toBe('10.0.0.2');
  });

  it('IPv4-mapped IPv6 is the IPv4 address (peer and forwarded); a port is stripped', () => {
    expect(normalizeAddress('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(clientAddress(req('::ffff:127.0.0.1'), 0)).toBe('127.0.0.1');
    expect(clientAddress(req('10.0.0.2', '::ffff:1.2.3.4'), 1)).toBe('1.2.3.4');
    expect(clientAddress(req('10.0.0.2', '203.0.113.7:4431'), 1)).toBe('203.0.113.7');
    expect(clientAddress(req('10.0.0.2', '[2001:db8:1:2::5]:443'), 1)).toBe('2001:db8:1:2::5');
  });

  it('the rate-limit identity counts IPv6 by /64 (rotating host bits does not multiply the budget); IPv4 unchanged', () => {
    expect(rateLimitIdentity('2001:db8:aaaa:bbbb:1::1')).toBe('2001:db8:aaaa:bbbb::/64');
    expect(rateLimitIdentity('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(rateLimitClientAddress(req('10.0.0.2', '1.2.3.4, [2001:db8:1:2::5]:443'), 1)).toBe('2001:db8:1:2::/64');
    expect(rateLimitClientAddress(req('198.51.100.7', '1.2.3.4'), 0)).toBe('198.51.100.7');
  });
});

describe('Stage 22 F3: TRUST_PROXY_HOPS configuration', () => {
  const hops = (env: NodeJS.ProcessEnv) => loadTrustProxyHops(new EnvReader(env));
  it('defaults to 0 (the peer); takes a bounded integer', () => {
    expect(hops({})).toBe(0);
    expect(hops({ TRUST_PROXY_HOPS: '0' })).toBe(0);
    expect(hops({ TRUST_PROXY_HOPS: '2' })).toBe(2);
    for (const bad of ['-1', '6', '1.5', 'all', 'true']) expect(() => hops({ TRUST_PROXY_HOPS: bad })).toThrow(/TRUST_PROXY_HOPS/);
  });
  it('the deprecated TRUST_PROXY=true is ONE hop, never every hop; TRUST_PROXY_HOPS wins when both are set', () => {
    expect(hops({ TRUST_PROXY: 'true' })).toBe(1);
    expect(hops({ TRUST_PROXY: 'false' })).toBe(0);
    expect(hops({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '2' })).toBe(2);
    expect(hops({ TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '0' })).toBe(0);
  });
  it('the base configuration carries the count and the derived flag', () => {
    expect(loadBaseConfig('probe-service', { TRUST_PROXY_HOPS: '2' })).toMatchObject({ trustProxyHops: 2, trustProxy: true });
    expect(loadBaseConfig('probe-service', {})).toMatchObject({ trustProxyHops: 0, trustProxy: false });
  });
});

describe('Stage 22 F3: configureApp gives Express the bounded count, never `trust proxy: true`', () => {
  it.each([[{}, false], [{ TRUST_PROXY_HOPS: '2' }, 2], [{ TRUST_PROXY: 'true' }, 1]] as const)('%j → trust proxy %s', async (env, expected) => {
    const t = await createTestApp({ env });
    try {
      expect(t.app.getHttpAdapter().getInstance().get('trust proxy')).toBe(expected);
    } finally {
      await t.app.close();
    }
  });
});

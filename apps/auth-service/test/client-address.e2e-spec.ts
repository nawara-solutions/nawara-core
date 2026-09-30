import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, type TestCtx } from './helpers/app.js';

/**
 * Stage 22 F3: Auth's throttles and audit use the kit's trusted client address. An X-Forwarded-For entry the client wrote never chooses
 * a bucket or the audited address; the entry our own proxy appended (TRUST_PROXY_HOPS, read from the right) does.
 */
describe('Stage 22 F3: the client address behind Auth throttling and audit', () => {
  const LIMIT = 3;
  let t: TestCtx | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  /** A failed login for a fresh, unknown identifier, so only the per-IP bucket (login_ip) can refuse it. */
  const failedLogin = (xff?: string) => {
    const r = t!.http.post('/auth/login');
    if (xff !== undefined) r.set('X-Forwarded-For', xff);
    return r.send({ email: `nobody-${randomUUID()}@f3.test`, password: 'not the password' });
  };
  const spoof = () => `${Math.floor(Math.random() * 223) + 1}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 254) + 1}`;

  it('TRUST_PROXY_HOPS=0: rotating a spoofed X-Forwarded-For does not escape the login_ip bucket (the peer is the client)', async () => {
    t = await createTestApp({ TRUST_PROXY_HOPS: '0', RATE_LOGIN_IP_LIMIT: String(LIMIT) });
    for (let i = 0; i < LIMIT; i++) expect((await failedLogin(spoof())).status).toBe(401);
    expect((await failedLogin(spoof())).status).toBe(429);
  });

  it('TRUST_PROXY_HOPS=1: a rotating client-written prefix does not escape the bucket of the address our proxy appended', async () => {
    t = await createTestApp({ TRUST_PROXY_HOPS: '1', RATE_LOGIN_IP_LIMIT: String(LIMIT) });
    for (let i = 0; i < LIMIT; i++) expect((await failedLogin(`${spoof()}, 203.0.113.7`)).status).toBe(401);
    expect((await failedLogin(`${spoof()}, 203.0.113.7`)).status).toBe(429);
  });

  it('TRUST_PROXY_HOPS=1: distinct real clients behind the proxy keep distinct buckets', async () => {
    t = await createTestApp({ TRUST_PROXY_HOPS: '1', RATE_LOGIN_IP_LIMIT: String(LIMIT) });
    for (const client of ['203.0.113.21', '203.0.113.22', '203.0.113.23']) {
      for (let i = 0; i < LIMIT; i++) expect((await failedLogin(`${spoof()}, ${client}`)).status).toBe(401);
    }
    expect((await failedLogin(`${spoof()}, 203.0.113.21`)).status).toBe(429); // and each is still bounded
  });

  it('the audited address is the trusted one, never the spoofed leftmost entry', async () => {
    t = await createTestApp({ TRUST_PROXY_HOPS: '1' });
    await failedLogin('1.2.3.4, 203.0.113.44').expect(401);
    const { rows } = await t.db.query(`SELECT ip FROM auth_audit_event WHERE type = 'auth.login' AND outcome = 'failure' ORDER BY "occurredAt" DESC LIMIT 1`);
    expect(rows[0].ip).toBe('203.0.113.44');
  });

  it('the deprecated TRUST_PROXY=true is one trusted hop: the leftmost entry no longer wins', async () => {
    t = await createTestApp({ TRUST_PROXY: 'true', RATE_LOGIN_IP_LIMIT: String(LIMIT) });
    for (let i = 0; i < LIMIT; i++) expect((await failedLogin(`${spoof()}, 203.0.113.8`)).status).toBe(401);
    expect((await failedLogin(`${spoof()}, 203.0.113.8`)).status).toBe(429);
  });
});

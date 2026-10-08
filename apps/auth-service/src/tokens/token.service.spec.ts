import { randomBytes } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../config/app-config.js';
import { TokenService } from './token.service.js';

const NOW = new Date('2026-10-08T12:00:00Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const ISS = 'nawara-auth';
const AUD = 'nawara';
const TTL = 900;
const key = () => new Uint8Array(randomBytes(32));
const clockAt = (d: Date) => ({ now: () => d });
const claims = { sub: 'u-1', role: 'member', sid: 's-1' };

const service = (jwt: Partial<AppConfig['jwt']>, now = NOW) =>
  new TokenService({ jwt: { issuer: ISS, audience: AUD, accessTtlSec: TTL, ...jwt } } as AppConfig, clockAt(now));

/** Resolves to `[status, code]` of the thrown HttpException, or 'accepted'. */
async function outcome(p: Promise<unknown>): Promise<[number, string] | 'accepted'> {
  try {
    await p;
    return 'accepted';
  } catch (e) {
    if (!(e instanceof HttpException)) throw e;
    return [e.getStatus(), (e.getResponse() as { code: string }).code];
  }
}
const INVALID: [number, string] = [401, 'invalid_token'];

/** A token signed outside the service: any header, any key, standard claims unless overridden. */
async function forge(k: Uint8Array, header: Record<string, unknown>, payload: Record<string, unknown> = { role: 'member', sid: 's-1' }, opts: { sub?: string | null; iss?: string; aud?: string; exp?: number } = {}) {
  const jwt = new SignJWT(payload).setProtectedHeader(header as never).setIssuedAt(NOW_S).setExpirationTime(opts.exp ?? NOW_S + 600)
    .setIssuer(opts.iss ?? ISS).setAudience(opts.aud ?? AUD);
  if (opts.sub !== null) jwt.setSubject(opts.sub ?? 'u-1');
  return jwt.sign(k);
}

/** A token with an arbitrary header and a correct HMAC-SHA-256 signature, built by hand (jose refuses some headers when signing). */
async function rawHs256(k: Uint8Array, header: Record<string, unknown>, payload: Record<string, unknown>): Promise<string> {
  const { createHmac } = await import('node:crypto');
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const input = `${enc(header)}.${enc(payload)}`;
  return `${input}.${createHmac('sha256', k).update(input).digest('base64url')}`;
}
const stdPayload = { sub: 'u-1', role: 'member', sid: 's-1', iss: ISS, aud: AUD, iat: NOW_S, exp: NOW_S + 600 };

/**
 * V2 A4.7 (A4 record §10.9): characterization of the legacy-only behaviour. Written against the pre-ring implementation and kept
 * unchanged by the key ring: a legacy-only configuration signs and verifies exactly as before.
 */
describe('V2 A4.7: TokenService characterization (legacy JWT_SECRET only)', () => {
  const k = key();
  const svc = service({ legacyKey: k, ring: new Map(), activeKeyId: 'legacy' });

  it('signs HS256 with the protected header exactly {"alg":"HS256"} (no kid, no typ)', async () => {
    const { accessToken } = await svc.sign(claims);
    expect(Buffer.from(accessToken.split('.')[0], 'base64url').toString()).toBe('{"alg":"HS256"}');
  });

  it('carries exactly sub, role, sid, iss, aud, iat and exp (adminTier only when given); expiresIn is the TTL', async () => {
    const { accessToken, expiresIn } = await svc.sign(claims);
    const { payload } = await jwtVerify(accessToken, k, { algorithms: ['HS256'], currentDate: NOW });
    expect(payload).toEqual({ role: 'member', sid: 's-1', sub: 'u-1', iss: ISS, aud: AUD, iat: NOW_S, exp: NOW_S + TTL });
    expect(expiresIn).toBe(TTL);
    const owner = await svc.sign({ ...claims, role: 'admin', adminTier: 'owner' });
    expect((await jwtVerify(owner.accessToken, k, { currentDate: NOW })).payload.adminTier).toBe('owner');
  });

  it('a plain jwtVerify with JWT_SECRET (a pre-ring image) accepts the token', async () => {
    const { accessToken } = await svc.sign(claims);
    await expect(jwtVerify(accessToken, k, { algorithms: ['HS256'], issuer: ISS, audience: AUD, currentDate: NOW })).resolves.toBeDefined();
  });

  it('clamps exp to the session ceiling, and refuses with session_expired once the ceiling has passed', async () => {
    const ceiling = new Date(NOW.getTime() + 120_000);
    const r = await svc.sign(claims, ceiling);
    expect(r.expiresIn).toBe(120);
    expect((await jwtVerify(r.accessToken, k, { currentDate: NOW })).payload.exp).toBe(NOW_S + 120);
    expect((await svc.sign(claims, new Date(NOW.getTime() + 3_600_000))).expiresIn).toBe(TTL);
    expect(await outcome(svc.sign(claims, NOW))).toEqual([401, 'session_expired']);
  });

  it('verifies its own token and returns the claims', async () => {
    const { accessToken } = await svc.sign({ ...claims, adminTier: 'operator', role: 'admin' });
    await expect(svc.verify(accessToken)).resolves.toMatchObject({ sub: 'u-1', role: 'admin', sid: 's-1', adminTier: 'operator', exp: NOW_S + TTL });
  });

  it('expiry: valid one second before exp, invalid_token at exp (no clock tolerance)', async () => {
    const { accessToken } = await svc.sign(claims);
    expect(await outcome(service({ legacyKey: k, ring: new Map(), activeKeyId: 'legacy' }, new Date((NOW_S + TTL - 1) * 1000)).verify(accessToken))).toBe('accepted');
    expect(await outcome(service({ legacyKey: k, ring: new Map(), activeKeyId: 'legacy' }, new Date((NOW_S + TTL) * 1000)).verify(accessToken))).toEqual(INVALID);
  });

  it('refuses alg none, HS384 and HS512 (even signed with JWT_SECRET), a wrong key, issuer or audience, and missing sub, sid or role', async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(stdPayload)).toString('base64url')}.`;
    const bad = [
      none,
      await forge(k, { alg: 'HS384' }),
      await forge(k, { alg: 'HS512' }),
      await forge(key(), { alg: 'HS256' }),
      await forge(k, { alg: 'HS256' }, undefined, { iss: 'evil' }),
      await forge(k, { alg: 'HS256' }, undefined, { aud: 'other' }),
      await forge(k, { alg: 'HS256' }, { role: 'member', sid: 's-1' }, { sub: null }),
      await forge(k, { alg: 'HS256' }, { role: 'member' }),
      await forge(k, { alg: 'HS256' }, { sid: 's-1' }),
      await forge(k, { alg: 'HS256' }, { role: 7, sid: 's-1' }),
      'not-a-jwt',
      '',
    ];
    for (const t of bad) expect(await outcome(svc.verify(t)), t).toEqual(INVALID);
    expect(await outcome(svc.verify(await forge(k, { alg: 'HS256' })))).toBe('accepted');
  });
});

/** V2 A4.7 (ADR-0058 rules 5 and 6, A4 record §10.4 to §10.7): the key ring. */
describe('V2 A4.7: TokenService key ring', () => {
  const legacy = key();
  const k1 = key();
  const k2 = key();
  const cfg = (legacyKey: Uint8Array | undefined, ring: Array<[string, Uint8Array]>, activeKeyId: string) => service({ legacyKey, ring: new Map(ring), activeKeyId });
  const headerOf = (t: string) => decodeProtectedHeader(t);

  it('an active ring key signs with exactly {"alg":"HS256","kid":"<id>"} and the token verifies', async () => {
    const svc = cfg(legacy, [['k1', k1]], 'k1');
    const { accessToken } = await svc.sign(claims);
    expect(Buffer.from(accessToken.split('.')[0], 'base64url').toString()).toBe('{"alg":"HS256","kid":"k1"}');
    await expect(jwtVerify(accessToken, k1, { currentDate: NOW })).resolves.toBeDefined();
    await expect(svc.verify(accessToken)).resolves.toMatchObject(claims);
  });

  it('active legacy with a ring configured: kid-less header, ring keys verify only', async () => {
    const svc = cfg(legacy, [['k1', k1]], 'legacy');
    const { accessToken } = await svc.sign(claims);
    expect(headerOf(accessToken)).toEqual({ alg: 'HS256' });
    expect(await outcome(svc.verify(await forge(k1, { alg: 'HS256', kid: 'k1' })))).toBe('accepted');
  });

  it('a kid-less token verifies with JWT_SECRET only, and is refused once JWT_SECRET is removed', async () => {
    const legacyToken = await forge(legacy, { alg: 'HS256' });
    expect(await outcome(cfg(legacy, [['k1', k1]], 'k1').verify(legacyToken))).toBe('accepted');
    expect(await outcome(cfg(undefined, [['k1', k1]], 'k1').verify(legacyToken))).toEqual(INVALID);
    // a kid-less token signed with a ring key is never tried against the ring
    expect(await outcome(cfg(legacy, [['k1', k1]], 'k1').verify(await forge(k1, { alg: 'HS256' })))).toEqual(INVALID);
    expect(await outcome(cfg(undefined, [['k1', k1]], 'k1').verify(await forge(k1, { alg: 'HS256' })))).toEqual(INVALID);
  });

  it('refuses an unknown, retired, reserved, malformed or non-string kid, and never falls back to another key', async () => {
    const svc = cfg(legacy, [['k1', k1], ['k2', k2]], 'k2');
    const refusedTokens = [
      await forge(k1, { alg: 'HS256', kid: 'k9' }), // unknown
      await forge(legacy, { alg: 'HS256', kid: 'k9' }), // unknown kid, signed with the legacy key: no fallback to legacy
      await forge(k2, { alg: 'HS256', kid: 'k9' }), // unknown kid, signed with the active key: no fallback to active
      await forge(legacy, { alg: 'HS256', kid: 'legacy' }),
      await forge(legacy, { alg: 'HS256', kid: 'LEGACY' }),
      await forge(legacy, { alg: 'HS256', kid: 'Legacy' }),
      await forge(k1, { alg: 'HS256', kid: 'bad id' }),
      await forge(k1, { alg: 'HS256', kid: 'x'.repeat(33) }),
      await forge(k1, { alg: 'HS256', kid: '' }),
      await forge(k1, { alg: 'HS256', kid: '__proto__' }),
      await forge(k1, { alg: 'HS256', kid: 'constructor' }),
      await rawHs256(k1, { alg: 'HS256', kid: 1 }, stdPayload),
      await rawHs256(k1, { alg: 'HS256', kid: ['k1'] }, stdPayload),
      await rawHs256(k1, { alg: 'HS256', kid: null }, stdPayload),
      await forge(k1, { alg: 'HS256', kid: 'k2' }), // k1-signed, labelled k2: verified with k2 only
      await forge(legacy, { alg: 'HS256', kid: 'k1' }), // legacy-signed, labelled with a ring kid
    ];
    for (const t of refusedTokens) expect(await outcome(svc.verify(t)), JSON.stringify(headerOf(t))).toEqual(INVALID);
    // the retired key: k1 removed from the ring
    const k1Token = await forge(k1, { alg: 'HS256', kid: 'k1' });
    expect(await outcome(svc.verify(k1Token))).toBe('accepted');
    expect(await outcome(cfg(legacy, [['k2', k2]], 'k2').verify(k1Token))).toEqual(INVALID);
  });

  it('downgrade: removing or changing the kid of a ring token invalidates it', async () => {
    const svc = cfg(legacy, [['k1', k1], ['k2', k2]], 'k1');
    const { accessToken } = await svc.sign(claims);
    const [, payload, sig] = accessToken.split('.');
    const reheader = (h: unknown) => `${Buffer.from(JSON.stringify(h)).toString('base64url')}.${payload}.${sig}`;
    expect(await outcome(svc.verify(reheader({ alg: 'HS256' })))).toEqual(INVALID);
    expect(await outcome(svc.verify(reheader({ alg: 'HS256', kid: 'k2' })))).toEqual(INVALID);
    expect(await outcome(svc.verify(reheader({ alg: 'HS512', kid: 'k1' })))).toEqual(INVALID);
  });

  it('algorithm confusion: none, HS384 and HS512 are refused even with a configured kid and key', async () => {
    const svc = cfg(legacy, [['k1', k1]], 'k1');
    const none = `${Buffer.from('{"alg":"none","kid":"k1"}').toString('base64url')}.${Buffer.from(JSON.stringify(stdPayload)).toString('base64url')}.`;
    for (const t of [none, await forge(k1, { alg: 'HS384', kid: 'k1' }), await forge(k1, { alg: 'HS512', kid: 'k1' }), await forge(legacy, { alg: 'HS512' })]) {
      expect(await outcome(svc.verify(t))).toEqual(INVALID);
    }
  });

  it('keys carried or referenced by the header (jwk, jku, x5u, x5c) are never used; an unknown crit is refused', async () => {
    const svc = cfg(legacy, [['k1', k1]], 'k1');
    const attacker = key();
    const jwk = { kty: 'oct', k: Buffer.from(attacker).toString('base64url') };
    for (const h of [{ jwk }, { jku: 'https://evil.invalid/jwks' }, { x5u: 'https://evil.invalid/c' }, { x5c: ['AAAA'] }]) {
      expect(await outcome(svc.verify(await rawHs256(attacker, { alg: 'HS256', ...h }, stdPayload)))).toEqual(INVALID);
      expect(await outcome(svc.verify(await rawHs256(attacker, { alg: 'HS256', kid: 'k1', ...h }, stdPayload)))).toEqual(INVALID);
    }
    expect(await outcome(svc.verify(await rawHs256(k1, { alg: 'HS256', kid: 'k1', crit: ['exp'], exp: 1 }, stdPayload)))).toEqual(INVALID);
    expect(await outcome(svc.verify(await rawHs256(k1, { alg: 'HS256', kid: 'k1' }, stdPayload)))).toBe('accepted');
  });

  it('claims, issuer, audience, expiry and the session ceiling are unchanged under a ring key', async () => {
    const svc = cfg(undefined, [['k1', k1]], 'k1');
    const r = await svc.sign({ ...claims, role: 'admin', adminTier: 'owner' }, new Date(NOW.getTime() + 60_000));
    expect(r.expiresIn).toBe(60);
    expect((await jwtVerify(r.accessToken, k1, { currentDate: NOW })).payload).toEqual({ role: 'admin', adminTier: 'owner', sid: 's-1', sub: 'u-1', iss: ISS, aud: AUD, iat: NOW_S, exp: NOW_S + 60 });
    for (const t of [await forge(k1, { alg: 'HS256', kid: 'k1' }, undefined, { iss: 'evil' }), await forge(k1, { alg: 'HS256', kid: 'k1' }, undefined, { aud: 'x' }),
      await forge(k1, { alg: 'HS256', kid: 'k1' }, undefined, { exp: NOW_S }), await forge(k1, { alg: 'HS256', kid: 'k1' }, { role: 'member' })]) {
      expect(await outcome(svc.verify(t))).toEqual(INVALID);
    }
  });

  /**
   * §10.6: a token minted at each step, checked against the configuration of each later step; and the image-rollback boundary (a plain
   * jwtVerify with JWT_SECRET stands for an image without the ring).
   */
  it('rotation steps 0 to 4, configuration rollback and the old-image rollback limit', async () => {
    const steps = [
      cfg(legacy, [], 'legacy'), // 0: ring-capable image, .env unchanged
      cfg(legacy, [['k1', k1]], 'legacy'), // 1: add the new key
      cfg(legacy, [['k1', k1]], 'k1'), // 2: activate it
      cfg(legacy, [['k1', k1]], 'k1'), // 3: wait
      cfg(undefined, [['k1', k1]], 'k1'), // 4: retire JWT_SECRET
    ];
    const minted = await Promise.all(steps.map(async (s) => (await s.sign(claims)).accessToken));
    for (let i = 0; i < steps.length; i++) {
      for (let j = i; j < steps.length; j++) {
        const expected = i <= 1 && j === 4 ? INVALID : 'accepted'; // legacy tokens die only when JWT_SECRET is removed
        expect(await outcome(steps[j].verify(minted[i])), `minted at ${i}, verified at ${j}`).toEqual(expected);
      }
    }
    // configuration rollback: from step 2 back to step 1 (active legacy, k1 kept) accepts both kinds of token
    expect(await outcome(steps[1].verify(minted[2]))).toBe('accepted');
    expect(await outcome(steps[1].verify(minted[0]))).toBe('accepted');
    // image rollback: a pre-ring verifier accepts tokens from steps 0 and 1, refuses every ring-signed token
    const oldImage = (t: string) => jwtVerify(t, legacy, { algorithms: ['HS256'], issuer: ISS, audience: AUD, currentDate: NOW });
    await expect(oldImage(minted[0])).resolves.toBeDefined();
    await expect(oldImage(minted[1])).resolves.toBeDefined();
    for (const t of minted.slice(2)) await expect(oldImage(t)).rejects.toThrow();
    // a later rotation between ring keys: k2 added, activated, k1 removed
    const k1Token = minted[2];
    const addK2 = cfg(undefined, [['k1', k1], ['k2', k2]], 'k1');
    const activeK2 = cfg(undefined, [['k1', k1], ['k2', k2]], 'k2');
    const k2Only = cfg(undefined, [['k2', k2]], 'k2');
    const k2Token = (await activeK2.sign(claims)).accessToken;
    expect(await outcome(addK2.verify(k2Token))).toBe('accepted');
    expect(await outcome(activeK2.verify(k1Token))).toBe('accepted');
    expect(await outcome(k2Only.verify(k2Token))).toBe('accepted');
    expect(await outcome(k2Only.verify(k1Token))).toEqual(INVALID);
  });
});

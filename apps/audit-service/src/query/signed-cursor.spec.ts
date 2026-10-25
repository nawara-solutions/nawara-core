import { HttpException } from '@nestjs/common';
import { createHmac, randomBytes } from 'node:crypto';
import { decodeSignedCursor, encodeSignedCursor, type CursorKeys } from './signed-cursor.js';

/** Core V2 S2-Audit.3 (OD-14): the scoped reads' cursor is authenticated, bound, expiring and carries a keyset position only. */
const keys = (over: Partial<CursorKeys> = {}): CursorKeys => ({ keys: new Map([['k1', randomBytes(32)]]), activeKeyId: 'k1', ttlSec: 900, ...over });
const POS = { occurredAtUs: '1761390000000000', id: '42' };
const FP = 'a'.repeat(24);
const NOW = Date.parse('2026-10-25T10:00:00.000Z');
const code = (f: () => unknown) => {
  try { f(); } catch (e) { return e instanceof HttpException ? (e.getResponse() as { code: string }).code : `unexpected ${String(e)}`; }
  return 'accepted';
};

describe('signed cursor (S2-Audit.3, OD-14)', () => {
  it('round-trips the keyset position for the same query, and carries nothing else', () => {
    const k = keys();
    const c = encodeSignedCursor(k, POS, FP, NOW);
    expect(decodeSignedCursor(k, c, FP, NOW + 1000)).toEqual(POS);
    const payload = JSON.parse(Buffer.from(c.split('.')[1]!, 'base64url').toString('utf8'));
    expect(Object.keys(payload).sort()).toEqual(['e', 'i', 'q', 't', 'v']); // position, fingerprint, expiry, version: no identity, no evidence
    expect(c.length).toBeLessThanOrEqual(512); // within the query grammar's bound
  });

  it('any alteration is refused, before the payload is interpreted: payload, MAC, key id, separators', () => {
    const k = keys();
    const c = encodeSignedCursor(k, POS, FP, NOW);
    const [kid, payload, mac] = c.split('.') as [string, string, string];
    const forged = Buffer.from(JSON.stringify({ v: 1, t: POS.occurredAtUs, i: '1', q: FP, e: 9_999_999_999 })).toString('base64url');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    for (const bad of [`${kid}.${forged}.${mac}`, `${kid}.${payload}.${flip(mac)}`, `${kid}.${flip(payload)}.${mac}`, `k2.${payload}.${mac}`, payload, `${kid}.${payload}`, `${c}.x`, '', 'x'.repeat(600)]) {
      expect(code(() => decodeSignedCursor(k, bad, FP, NOW)), bad.slice(0, 20)).toBe('invalid_cursor');
    }
  });

  it('expires: refused at and after its expiry; the TTL is the configured one', () => {
    const k = keys({ ttlSec: 60 });
    const c = encodeSignedCursor(k, POS, FP, NOW);
    expect(code(() => decodeSignedCursor(k, c, FP, NOW + 59_000))).toBe('accepted');
    expect(code(() => decodeSignedCursor(k, c, FP, NOW + 60_000))).toBe('invalid_cursor');
    expect(code(() => decodeSignedCursor(k, c, FP, NOW + 3_600_000))).toBe('invalid_cursor');
  });

  it('is bound to its query: another principal, scope, filter or window (another fingerprint) is refused', () => {
    const k = keys();
    expect(code(() => decodeSignedCursor(k, encodeSignedCursor(k, POS, FP, NOW), 'b'.repeat(24), NOW))).toBe('invalid_cursor');
  });

  it('a key rotation keeps the previous key verifying while the new one signs; a removed key no longer verifies; another ring never does', () => {
    const old = randomBytes(32);
    const before = keys({ keys: new Map([['k1', old]]), activeKeyId: 'k1' });
    const c = encodeSignedCursor(before, POS, FP, NOW);
    const during = keys({ keys: new Map([['k1', old], ['k2', randomBytes(32)]]), activeKeyId: 'k2' });
    expect(decodeSignedCursor(during, c, FP, NOW)).toEqual(POS);
    expect(encodeSignedCursor(during, POS, FP, NOW).startsWith('k2.')).toBe(true);
    expect(code(() => decodeSignedCursor(keys({ keys: new Map([['k2', randomBytes(32)]]), activeKeyId: 'k2' }), c, FP, NOW))).toBe('invalid_cursor');
    expect(code(() => decodeSignedCursor(keys(), c, FP, NOW))).toBe('invalid_cursor'); // same id, another key
  });

  it('a well-signed payload of the wrong shape is still refused', () => {
    const k = keys();
    const key = k.keys.get('k1')!;
    const sign = (obj: unknown) => {
      const p = Buffer.from(JSON.stringify(obj)).toString('base64url');
      return `k1.${p}.${createHmac('sha256', key).update(`nawara.audit.scoped-cursor.v1\nk1\n${p}`).digest('base64url')}`;
    };
    expect(code(() => decodeSignedCursor(k, sign({ v: 1, t: POS.occurredAtUs, i: POS.id, q: FP, e: 9_999_999_999 }), FP, NOW))).toBe('accepted');
    for (const bad of [{ v: 2, t: POS.occurredAtUs, i: POS.id, q: FP, e: 9_999_999_999 }, { v: 1, t: 'x', i: POS.id, q: FP, e: 9_999_999_999 },
      { v: 1, t: POS.occurredAtUs, i: '0', q: FP, e: 9_999_999_999 }, { v: 1, t: POS.occurredAtUs, i: POS.id, q: FP, e: '9' }, { v: 1, t: POS.occurredAtUs, i: POS.id, q: FP },
      { v: 1, t: POS.occurredAtUs, i: POS.id, q: FP, e: 9_999_999_999, extra: 1 }, [1]]) {
      expect(code(() => decodeSignedCursor(k, sign(bad), FP, NOW)), JSON.stringify(bad)).toBe('invalid_cursor');
    }
  });
});

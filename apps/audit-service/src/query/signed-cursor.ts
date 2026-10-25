import { createHmac, timingSafeEqual } from 'node:crypto';
import { AUDIT_MESSAGES } from '../messages.js';
import type { CursorPosition } from './query-model.js';
import { badRequest } from './query-params.js';

/**
 * Core V2 S2-Audit.3 (AUD-03, AUD-04; the Owner-approved OD-14 cursor requirements): the cursor of the scoped human reads. It is
 *
 *   `<kid>.<payload>.<mac>`  with  payload = base64url(JSON {v:1, t, i, q, e})  and  mac = base64url(HMAC-SHA-256(key[kid], DOMAIN ‖ kid ‖ payload))
 *
 * - AUTHENTICATED with a key ring dedicated to cursors (`AUDIT_CURSOR_KEYS`); the key id lets a rotation keep the previous key verifying.
 *   The MAC is checked (in constant time) BEFORE the payload is parsed: an altered cursor is never interpreted.
 * - BOUND to the query it came from: `q` is the digest of the verified principal, the server-built scope (Company / Platform), every filter
 *   and the window, so it cannot be replayed by another identity, for another scope, filter or window.
 * - EXPIRING: `e` is its expiry (epoch seconds, issue time + `AUDIT_CURSOR_TTL_SEC`).
 * - Carrying a keyset position only (`t` occurredAt in µs, `i` the internal row id): no evidence, no identifier of a person or scope, no
 *   secret. It confers NO authority: every page re-asks Auth and re-applies the scope (authority revalidated on every request).
 * Every refusal is the same `400 invalid_cursor` (malformed, unknown key, altered, expired, another query): nothing tells which.
 */
const DOMAIN = 'nawara.audit.scoped-cursor.v1';
const CURSOR = /^([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]{1,400})\.([A-Za-z0-9_-]{43})$/;
const DIGITS = /^-?\d{1,20}$/;
const ID = /^[1-9]\d{0,18}$/;
const FINGERPRINT = /^[0-9a-f]{24}$/;

export interface CursorKeys {
  keys: ReadonlyMap<string, Buffer>;
  activeKeyId: string;
  ttlSec: number;
}

const mac = (key: Buffer, kid: string, payload: string) => createHmac('sha256', key).update(`${DOMAIN}\n${kid}\n${payload}`).digest();

export function encodeSignedCursor(k: CursorKeys, position: CursorPosition, fingerprint: string, nowMs: number): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, t: position.occurredAtUs, i: position.id, q: fingerprint, e: Math.floor(nowMs / 1000) + k.ttlSec }), 'utf8').toString('base64url');
  return `${k.activeKeyId}.${payload}.${mac(k.keys.get(k.activeKeyId)!, k.activeKeyId, payload).toString('base64url')}`;
}

export function decodeSignedCursor(k: CursorKeys, raw: string, fingerprint: string, nowMs: number): CursorPosition {
  const bad = () => badRequest('invalid_cursor', AUDIT_MESSAGES.cursorInvalid);
  const m = CURSOR.exec(raw);
  if (!m) throw bad();
  const [, kid, payload, presented] = m as unknown as [string, string, string, string];
  const key = k.keys.get(kid);
  if (!key) throw bad();
  const expected = mac(key, kid, payload);
  const given = Buffer.from(presented, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw bad();
  const c = parsed as Record<string, unknown>;
  if (Object.keys(c).sort().join(',') !== 'e,i,q,t,v' || c.v !== 1) throw bad();
  if (typeof c.t !== 'string' || !DIGITS.test(c.t) || typeof c.i !== 'string' || !ID.test(c.i) || typeof c.q !== 'string' || !FINGERPRINT.test(c.q)) throw bad();
  if (typeof c.e !== 'number' || !Number.isSafeInteger(c.e) || c.e * 1000 <= nowMs) throw bad(); // expired
  if (c.q !== fingerprint) throw bad(); // another principal, scope, filter or window
  return { occurredAtUs: c.t, id: c.i };
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPublishedDevelopmentSecret } from '../src/index.js';
import { DEVELOPMENT_SECRET_FINGERPRINTS } from '../src/testing/index.js';

/** Values of the tracked root `.env.example`; never printed (assertions compare booleans and counts only). */
const template = new Map(readFileSync(new URL('../../../.env.example', import.meta.url), 'utf8').split('\n')
  .map((l) => /^([A-Z][A-Z0-9_]+)=(.*)$/.exec(l)).filter((m): m is RegExpExecArray => m !== null).map((m) => [m[1], m[2].trim()]));

/** Template variable → the runtime variable it feeds (docker-compose.yml) and how it is fingerprinted. */
const PUBLISHED: Array<[template: string, runtime: string, kind: 'key' | 'ring' | 'text']> = [
  ['AUTH_JWT_SECRET', 'JWT_SECRET', 'key'], ['AUTH_OPERATOR_CODE_PEPPER', 'OPERATOR_CODE_PEPPER', 'key'],
  ['AUTH_SECRET_KEY_PEPPER', 'SECRET_KEY_PEPPER', 'key'], ['AUTH_THROTTLE_KEY_PEPPER', 'THROTTLE_KEY_PEPPER', 'key'],
  ['AUTH_JOIN_CODE_PEPPER', 'JOIN_CODE_PEPPER', 'key'], ['AUTH_TOTP_KEY_K1', 'TOTP_ENCRYPTION_KEYS', 'key'],
  ['FILE_REQUEST_HASH_KEY', 'FILE_REQUEST_HASH_KEY', 'key'], ['FILE_RATE_LIMIT_KEY', 'FILE_RATE_LIMIT_KEY', 'key'],
  ['NOTIFICATION_SECRET_KEYS', 'NOTIFICATION_SECRET_KEYS', 'ring'], ['NOTIFICATION_REQUEST_HASH_KEY', 'NOTIFICATION_REQUEST_HASH_KEY', 'key'],
  ['NOTIFICATION_DESTINATION_LIMIT_KEY', 'NOTIFICATION_DESTINATION_LIMIT_KEY', 'key'], ['BILLING_TO_PAYMENT_TOKEN', 'PAYMENT_SERVICE_TOKEN', 'text'],
];
const material = (value: string, kind: 'key' | 'ring' | 'text'): Buffer | string =>
  kind === 'text' ? value : Buffer.from(kind === 'ring' ? value.slice(value.indexOf(':') + 1) : value, 'base64');

describe('V2 A2.1: the published development secret catalog (OD-A2-2)', () => {
  it('holds fingerprints only (SHA-256 hex), each labelled with the runtime variable it protects', () => {
    expect(DEVELOPMENT_SECRET_FINGERPRINTS.size).toBe(PUBLISHED.length);
    for (const [fingerprint, label] of DEVELOPMENT_SECRET_FINGERPRINTS) {
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(PUBLISHED.some(([, runtime]) => runtime === label)).toBe(true);
    }
    // no catalog source line carries a template value
    const source = readFileSync(new URL('../src/config/development-keys.ts', import.meta.url), 'utf8');
    for (const [name] of PUBLISHED) expect(source.includes(template.get(name)!)).toBe(false);
  });

  it('recognises every published development secret of .env.example (keys by decoded bytes, tokens by text)', () => {
    for (const [name, runtime, kind] of PUBLISHED) {
      expect(template.has(name), name).toBe(true);
      expect(isPublishedDevelopmentSecret(material(template.get(name)!, kind)), `${name} → ${runtime}`).toBe(true);
    }
  });

  it('matches a key by its bytes, whatever its spelling, and a token with surrounding whitespace', () => {
    const jwt = template.get('AUTH_JWT_SECRET')!;
    expect(isPublishedDevelopmentSecret(Buffer.from(jwt.replace(/=+$/, ''), 'base64'))).toBe(true);
    expect(isPublishedDevelopmentSecret(` ${template.get('BILLING_TO_PAYMENT_TOKEN')!}\n`)).toBe(true);
  });

  it('does not recognise anything else: fresh material, a key passed as text, a digest of a published value', () => {
    expect(isPublishedDevelopmentSecret(Buffer.alloc(32, 1))).toBe(false);
    expect(isPublishedDevelopmentSecret('a-fresh-token-that-was-never-published')).toBe(false);
    expect(isPublishedDevelopmentSecret(template.get('AUTH_JWT_SECRET')!)).toBe(false); // the base64 TEXT is not the key bytes
    expect(isPublishedDevelopmentSecret(createHash('sha256').update(template.get('BILLING_TO_PAYMENT_TOKEN')!).digest('hex'))).toBe(false);
  });

  it('keeps the three fingerprints Notification already refuses (migrated, not changed)', () => {
    const notification = readFileSync(new URL('../../../apps/notification-service/src/config/notification-config.ts', import.meta.url), 'utf8');
    const block = notification.slice(notification.indexOf('KNOWN_DEVELOPMENT_KEY_FINGERPRINTS = new Set')).split(']);')[0];
    const fingerprints = [...block.matchAll(/[0-9a-f]{64}/g)].map((m) => m[0]);
    expect(fingerprints.length).toBe(3);
    for (const f of fingerprints) expect(DEVELOPMENT_SECRET_FINGERPRINTS.has(f)).toBe(true);
  });
});

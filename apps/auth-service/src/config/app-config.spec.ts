import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './app-config.js';

const b64 = () => randomBytes(32).toString('base64');
const good = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test', DATABASE_URL: 'postgres://x', JWT_SECRET: b64(), OPERATOR_CODE_PEPPER: b64(), SECRET_KEY_PEPPER: b64(), THROTTLE_KEY_PEPPER: b64(),
  TOTP_ENCRYPTION_KEYS: `k1:${b64()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
});

describe('configuration and key management fail closed', () => {
  it('loads a complete, valid configuration', () => {
    const c = loadConfig(good());
    expect(c.secrets.totpKeys.get('k1')).toHaveLength(32);
    expect(c.stepUp.ttlSec).toBeLessThanOrEqual(900);
  });
  it.each(['JWT_SECRET', 'OPERATOR_CODE_PEPPER', 'SECRET_KEY_PEPPER', 'THROTTLE_KEY_PEPPER', 'TOTP_ENCRYPTION_KEYS', 'TOTP_ENCRYPTION_ACTIVE_KEY_ID', 'DATABASE_URL'])('refuses to start without %s (no default)', (name) => {
    const e = good(); delete e[name];
    expect(() => loadConfig(e)).toThrow(ConfigError);
  });
  it('refuses weak secrets and never echoes a secret value in the error', () => {
    const e = good(); e.JWT_SECRET = 'short-secret';
    try { loadConfig(e); throw new Error('no throw'); } catch (err) { expect((err as Error).message).not.toContain('short-secret'); expect(err).toBeInstanceOf(ConfigError); }
  });
  it('requires every secret to be distinct (domain separation)', () => {
    const e = good(); e.SECRET_KEY_PEPPER = e.JWT_SECRET;
    expect(() => loadConfig(e)).toThrow(/distinct/);
  });
  it('validates the TOTP key ring: 32-byte keys, and the active id must exist', () => {
    const e = good(); e.TOTP_ENCRYPTION_KEYS = `k1:${randomBytes(16).toString('base64')}`;
    expect(() => loadConfig(e)).toThrow(ConfigError);
    const f = good(); f.TOTP_ENCRYPTION_ACTIVE_KEY_ID = 'k2';
    expect(() => loadConfig(f)).toThrow(/ACTIVE_KEY_ID/);
    const g = good(); g.TOTP_ENCRYPTION_KEYS = `k1:${b64()},k2:${b64()}`; g.TOTP_ENCRYPTION_ACTIVE_KEY_ID = 'k2';
    expect(loadConfig(g).secrets.totpActiveKeyId).toBe('k2');
  });
  it('reads secrets from mounted files (NAME_FILE) so a secret manager never needs them in the environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-'));
    const f = join(dir, 'jwt'); const secret = b64(); writeFileSync(f, secret + '\n');
    const e = good(); delete e.JWT_SECRET; e.JWT_SECRET_FILE = f;
    expect(Buffer.from(loadConfig(e).jwt.secret).toString('base64')).toBe(secret);
  });
  it('production demands https WebAuthn origins, an RP id and a payment service token', () => {
    const p = { ...good(), NODE_ENV: 'production' };
    expect(() => loadConfig(p)).toThrow(/WEBAUTHN/);
    expect(() => loadConfig({ ...p, WEBAUTHN_RP_ID: 'a.test', WEBAUTHN_ORIGINS: 'http://a.test' })).toThrow(/https/);
    expect(() => loadConfig({ ...p, WEBAUTHN_RP_ID: 'a.test', WEBAUTHN_ORIGINS: 'https://a.test' })).toThrow(/PAYMENT_SERVICE_TOKEN/);
    expect(loadConfig({ ...p, WEBAUTHN_RP_ID: 'a.test', WEBAUTHN_ORIGINS: 'https://a.test', PAYMENT_SERVICE_TOKEN: 'x'.repeat(40) }).env).toBe('production');
  });
  it('a step-up can never be configured longer than the 15-minute database limit', () => {
    expect(() => loadConfig({ ...good(), STEP_UP_TTL_SEC: '901' })).toThrow(ConfigError);
    expect(loadConfig({ ...good(), STEP_UP_TTL_SEC: '900' }).stepUp.ttlSec).toBe(900);
  });
  it('rate limits are configurable and validated', () => {
    expect(loadConfig({ ...good(), RATE_OPERATOR_VERIFY_IDENTIFIER_LIMIT: '7' }).rate.operator_verify_identifier.limit).toBe(7);
    expect(() => loadConfig({ ...good(), RATE_LOGIN_IP_LIMIT: '0' })).toThrow(ConfigError);
  });
});

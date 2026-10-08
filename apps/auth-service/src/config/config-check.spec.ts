import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkConfig } from './config-check.js';

const b64 = () => randomBytes(32).toString('base64');
const good = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test', DATABASE_URL: 'postgres://x', JWT_SECRET: b64(), OPERATOR_CODE_PEPPER: b64(), SECRET_KEY_PEPPER: b64(), THROTTLE_KEY_PEPPER: b64(), JOIN_CODE_PEPPER: b64(),
  TOTP_ENCRYPTION_KEYS: `k1:${b64()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
});
const PROD_BASE = {
  NODE_ENV: 'production', DATABASE_URL: 'postgres://auth_app:pw@db:5432/auth', AUTH_EVENTS: 'off', RABBITMQ_URL: 'amqp://mq:5672',
  WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGINS: 'https://app.example.com',
};
const ring = (...entries: Array<[string, string]>) => entries.map(([id, k]) => `${id}:${k}`).join(',');
const template = (name: string) => readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`))!.slice(name.length + 1).trim();
const files = (map: Record<string, string>) => (p: string) => {
  if (!(p in map)) throw new Error('ENOENT');
  return map[p]!;
};

/** Every key value, decoded key and ring id of `env`: none may appear in the check's output. */
function sensitive(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const [name, v] of Object.entries(env)) {
    if (!v || !/(SECRET|PEPPER|KEYS|KEY_ID|DATABASE_URL|RABBITMQ_URL)/.test(name)) continue;
    out.push(v);
    for (const part of v.split(',')) {
      const [id, key] = part.includes(':') && !v.includes('://') ? part.split(':') : [undefined, part];
      if (id && id.length > 2) out.push(id);
      if (key && key.length >= 16) out.push(key, Buffer.from(key, 'base64').toString('hex'));
    }
  }
  // `legacy` is the reserved, public constant the rules themselves name; it is never a secret or a configured ring id
  return out.filter((v) => v.toLowerCase() !== 'legacy');
}

/** V2 A4.8 (A4 record §11): the configuration check reports a valid configuration and its JWT mode, never a value. */
describe('V2 A4.8: checkConfig (the deploy-time configuration check)', () => {
  const ok = (env: NodeJS.ProcessEnv, mode: RegExp, readFile?: (p: string) => string) => {
    const r = checkConfig(env, readFile);
    expect(r, r.line).toMatchObject({ ok: true, exitCode: 0 });
    expect(r.line).toMatch(/^configuration valid; JWT: /);
    expect(r.line).toMatch(mode);
    for (const s of sensitive(env)) expect(r.line).not.toContain(s);
    return r;
  };
  const refused = (env: NodeJS.ProcessEnv, message: RegExp, readFile?: (p: string) => string) => {
    const r = checkConfig(env, readFile);
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(r.line).toMatch(/^configuration invalid: /);
    expect(r.line.slice('configuration invalid: '.length)).toMatch(message);
    for (const s of sensitive(env)) expect(r.line).not.toContain(s);
    return r;
  };

  it('the four JWT modes, each summarised by kind and count only (no ring id, no value)', () => {
    const [k1, k2] = [b64(), b64()];
    const withRing = (active: string) => ({ ...good(), JWT_SIGNING_KEYS: ring(['k2026-10', k1], ['k2026-11', k2]), JWT_ACTIVE_KEY_ID: active });
    expect(ok(good(), /JWT: legacy only \(JWT_SECRET signs and verifies\)$/).line).toBe('configuration valid; JWT: legacy only (JWT_SECRET signs and verifies)');
    expect(ok(withRing('legacy'), /JWT: ring \(active: legacy, ring keys: 2, verification only\)$/).line).not.toMatch(/k2026/);
    expect(ok(withRing('k2026-11'), /JWT: ring \(active: a ring key, ring keys: 2, legacy key: kept\)$/).line).not.toMatch(/k2026/);
    expect(ok({ ...withRing('k2026-10'), JWT_SECRET: undefined }, /JWT: ring \(active: a ring key, ring keys: 2, legacy key: retired\)$/).line).not.toMatch(/k2026/);
  });

  it('validates the whole Auth configuration, not only JWT', () => {
    refused({ ...good(), DATABASE_URL: undefined }, /^DATABASE_URL is required$/);
    refused({ ...good(), OPERATOR_CODE_PEPPER: 'short' }, /^OPERATOR_CODE_PEPPER must /);
    refused({ ...good(), ...PROD_BASE, RABBITMQ_URL: undefined }, /^RABBITMQ_URL is required in production/);
    refused({ ...good(), NODE_ENV: 'staging' }, /^NODE_ENV must be one of/);
  });

  it('refuses every invalid pairing', () => {
    const k1 = b64();
    for (const base of [good(), { ...good(), JWT_SECRET: undefined }]) {
      refused({ ...base, JWT_SIGNING_KEYS: ring(['k1', k1]) }, /^JWT_SIGNING_KEYS and JWT_ACTIVE_KEY_ID must be set together$/);
      refused({ ...base, JWT_ACTIVE_KEY_ID: 'k1' }, /^JWT_SIGNING_KEYS and JWT_ACTIVE_KEY_ID must be set together$/);
    }
    refused({ ...good(), JWT_SECRET: undefined }, /^JWT_SECRET is required$/);
    refused({ ...good(), JWT_SECRET: undefined, JWT_SIGNING_KEYS: ring(['k1', k1]), JWT_ACTIVE_KEY_ID: 'legacy' }, /^JWT_ACTIVE_KEY_ID is legacy but JWT_SECRET is not set$/);
    refused({ ...good(), JWT_SIGNING_KEYS: ring(['k1', k1]), JWT_ACTIVE_KEY_ID: 'k9' }, /^JWT_ACTIVE_KEY_ID does not name a key in JWT_SIGNING_KEYS$/);
  });

  it('refuses invalid key formats and counts, reserved ids, and repeated or reused key material', () => {
    const [a, b] = [b64(), b64()];
    const r = (v: string, extra: NodeJS.ProcessEnv = {}) => ({ ...good(), JWT_SIGNING_KEYS: v, JWT_ACTIVE_KEY_ID: 'k1', ...extra });
    refused(r(a), /^JWT_SIGNING_KEYS must be "id:base64/);
    refused(r(`k1:${randomBytes(31).toString('base64')}`), /^JWT_SIGNING_KEYS must decode to at least 32 bytes$/);
    refused(r(`k1:${a}!`), /^JWT_SIGNING_KEYS must be standard base64/);
    refused(r(ring(['k1', a], ['k2', b], ['k3', b64()], ['k4', b64()])), /^JWT_SIGNING_KEYS must hold at most 3 keys$/);
    for (const id of ['legacy', 'LEGACY', 'Legacy']) refused(r(ring(['k1', a], [id, b])), /^JWT_SIGNING_KEYS must not use the reserved key id legacy$/);
    refused(r(ring(['k1', a], ['k1', b])), /^JWT_SIGNING_KEYS must not repeat a key id$/);
    refused(r(ring(['k1', a], ['k2', a])), /^JWT_SIGNING_KEYS must not repeat a key$/);
    const e = good();
    refused(r(ring(['k1', a], ['k2', e.JWT_SECRET!]), e), /^JWT_SIGNING_KEYS must differ from JWT_SECRET \(one key, one purpose\)$/);
    refused(r(ring(['k1', a], ['k2', e.JOIN_CODE_PEPPER!]), e), /^JOIN_CODE_PEPPER must differ from JWT_SIGNING_KEYS/);
    refused(r(ring(['k1', a], ['k2', e.TOTP_ENCRYPTION_KEYS!.split(':')[1]!]), e), /^TOTP_ENCRYPTION_KEYS must differ from JWT_SIGNING_KEYS/);
  });

  it('applies the production key rules: published development keys and non-random keys are refused', () => {
    const published = template('AUTH_JWT_SECRET');
    refused({ ...good(), ...PROD_BASE, JWT_SECRET: published }, /^JWT_SECRET is a published development key and is refused in production$/);
    refused({ ...good(), ...PROD_BASE, JWT_SIGNING_KEYS: ring(['k1', published]), JWT_ACTIVE_KEY_ID: 'k1' }, /^JWT_SIGNING_KEYS is a published development key/);
    refused({ ...good(), ...PROD_BASE, JWT_SIGNING_KEYS: ring(['k1', Buffer.alloc(32, 9).toString('base64')]), JWT_ACTIVE_KEY_ID: 'k1' }, /^JWT_SIGNING_KEYS does not look random/);
    ok({ ...good(), ...PROD_BASE }, /legacy only/);
  });

  it('reads NAME_FILE (JWT_SECRET_FILE, the ring and its active id) and refuses NAME together with NAME_FILE or an unreadable file', () => {
    const [secret, k1] = [b64(), b64()];
    ok({ ...good(), JWT_SECRET: undefined, JWT_SECRET_FILE: '/run/secrets/jwt' }, /legacy only/, files({ '/run/secrets/jwt': `${secret}\n` }));
    ok({ ...good(), JWT_SECRET: undefined, JWT_SIGNING_KEYS_FILE: '/run/s/ring', JWT_ACTIVE_KEY_ID_FILE: '/run/s/active' }, /legacy key: retired/,
      files({ '/run/s/ring': `k1:${k1}\n`, '/run/s/active': 'k1\n' }));
    refused({ ...good(), JWT_SECRET_FILE: '/run/secrets/jwt' }, /^set JWT_SECRET or JWT_SECRET_FILE, not both$/, files({ '/run/secrets/jwt': secret }));
    refused({ ...good(), JWT_SIGNING_KEYS: `k1:${k1}`, JWT_SIGNING_KEYS_FILE: '/run/s/ring', JWT_ACTIVE_KEY_ID: 'k1' }, /^set JWT_SIGNING_KEYS or JWT_SIGNING_KEYS_FILE, not both$/, files({ '/run/s/ring': `k1:${k1}` }));
    refused({ ...good(), JWT_SECRET: undefined, JWT_SECRET_FILE: '/run/secrets/missing' }, /^JWT_SECRET_FILE is set but the file cannot be read$/, files({}));
  });

  it('a file-read error is reported by variable name only, never with the underlying error text', () => {
    const bad = checkConfig({ ...good(), JWT_SECRET: undefined, JWT_SECRET_FILE: '/x' }, () => { throw new Error('s3cret-detail /x'); });
    expect(bad).toEqual({ ok: false, exitCode: 1, line: 'configuration invalid: JWT_SECRET_FILE is set but the file cannot be read' });
  });

  it('touches nothing beyond configuration: the module imports only the configuration loader and the kit', () => {
    const src = readFileSync(new URL('./config-check.ts', import.meta.url), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(['./app-config.js', '@nawara/service-kit']);
    expect(src).not.toMatch(/process\.env|NestFactory|DbService|\bpg\b|amqp|writeFile|randomBytes/);
    const cli = readFileSync(new URL('../cli/check-config.ts', import.meta.url), 'utf8');
    expect([...cli.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1])).toEqual(['../config/config-check.js']);
    expect(cli).not.toMatch(/NestFactory|AppModule|DbService|writeFile|randomBytes/);
  });
});

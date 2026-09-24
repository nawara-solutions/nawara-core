import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './app-config.js';

const b64 = () => randomBytes(32).toString('base64');
const good = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test', DATABASE_URL: 'postgres://x', JWT_SECRET: b64(), OPERATOR_CODE_PEPPER: b64(), SECRET_KEY_PEPPER: b64(), THROTTLE_KEY_PEPPER: b64(), JOIN_CODE_PEPPER: b64(),
  TOTP_ENCRYPTION_KEYS: `k1:${b64()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
});

describe('configuration and key management fail closed', () => {
  it('loads a complete, valid configuration', () => {
    const c = loadConfig(good());
    expect(c.secrets.totpKeys.get('k1')).toHaveLength(32);
    expect(c.stepUp.ttlSec).toBeLessThanOrEqual(900);
  });
  it.each(['JWT_SECRET', 'OPERATOR_CODE_PEPPER', 'SECRET_KEY_PEPPER', 'THROTTLE_KEY_PEPPER', 'JOIN_CODE_PEPPER', 'TOTP_ENCRYPTION_KEYS', 'TOTP_ENCRYPTION_ACTIVE_KEY_ID', 'DATABASE_URL'])('refuses to start without %s (no default)', (name) => {
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
  it('the join-code pepper is purpose-separated: it must differ from every other secret, and verification defaults to off', () => {
    for (const other of ['JWT_SECRET', 'OPERATOR_CODE_PEPPER', 'SECRET_KEY_PEPPER', 'THROTTLE_KEY_PEPPER']) {
      const e = good(); e.JOIN_CODE_PEPPER = e[other];
      expect(() => loadConfig(e)).toThrow(/distinct/);
    }
    expect(loadConfig(good()).onboarding.requireContactVerification).toBe(false);
    expect(loadConfig({ ...good(), REQUIRE_CONTACT_VERIFICATION: 'true' }).onboarding.requireContactVerification).toBe(true);
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
  it('production demands https WebAuthn origins and an RP id', () => {
    const p = { ...good(), NODE_ENV: 'production' };
    expect(() => loadConfig(p)).toThrow(/WEBAUTHN/);
    expect(() => loadConfig({ ...p, WEBAUTHN_RP_ID: 'a.test', WEBAUTHN_ORIGINS: 'http://a.test' })).toThrow(/https/);
    expect(loadConfig({ ...p, WEBAUTHN_RP_ID: 'a.test', WEBAUTHN_ORIGINS: 'https://a.test', AUTH_EVENTS: 'off' }).env).toBe('production');
  });
  it('a step-up can never be configured longer than the 15-minute database limit', () => {
    expect(() => loadConfig({ ...good(), STEP_UP_TTL_SEC: '901' })).toThrow(ConfigError);
    expect(loadConfig({ ...good(), STEP_UP_TTL_SEC: '900' }).stepUp.ttlSec).toBe(900);
  });
  it('rate limits are configurable and validated', () => {
    expect(loadConfig({ ...good(), RATE_OPERATOR_VERIFY_IDENTIFIER_LIMIT: '7' }).rate.operator_verify_identifier.limit).toBe(7);
    expect(() => loadConfig({ ...good(), RATE_LOGIN_IP_LIMIT: '0' })).toThrow(ConfigError);
  });
  it('CORS_ORIGINS fails closed: exact http(s) origins only, never a wildcard, path or bare host; empty means CORS off', () => {
    expect(loadConfig(good()).corsOrigins).toEqual([]);
    expect(loadConfig({ ...good(), CORS_ORIGINS: 'https://a.test, http://localhost:3000' }).corsOrigins).toEqual(['https://a.test', 'http://localhost:3000']);
    for (const bad of ['*', 'https://*.a.test', 'a.test', 'https://a.test/', 'https://a.test/path', 'ftp://a.test', 'null', 'https://a.test,*']) {
      expect(() => loadConfig({ ...good(), CORS_ORIGINS: bad }), bad).toThrow(ConfigError);
    }
  });
});

describe('runtime configuration is validated once and fails closed (Stage 14.3)', () => {
  const prod = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...good(), NODE_ENV: 'production', DATABASE_URL: 'postgres://auth_app:pw@db:5432/auth', AUTH_EVENTS: 'off',
    WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGINS: 'https://app.example.com', ...over,
  });

  it('accepts a production configuration that uses the least-privilege runtime role', () => {
    const c = loadConfig(prod());
    expect(c.databaseUrl).toBe('postgres://auth_app:pw@db:5432/auth');
    expect(c.events).toEqual({ enabled: false, rabbitmqUrl: undefined });
  });
  it.each(['postgres', 'root', 'auth', 'auth_migrator'])('refuses the %s database user in production (superuser / schema owner), without echoing the URL', (user) => {
    try { loadConfig(prod({ DATABASE_URL: `postgres://${user}:s3cret-value@db:5432/auth` })); throw new Error('no throw'); } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/least-privilege runtime role/);
      expect((err as Error).message).not.toContain('s3cret-value');
    }
  });
  it('allows any database user outside production (tests and local runs use an admin connection)', () => {
    expect(loadConfig({ ...good(), DATABASE_URL: 'postgres://postgres@localhost:5432/auth' }).databaseUrl).toContain('postgres@');
  });
  it.each(['not a url', 'mysql://u:p@h/db', 'http://h/db'])('refuses a malformed or non-PostgreSQL DATABASE_URL: %s', (url) => {
    expect(() => loadConfig({ ...good(), DATABASE_URL: url })).toThrow(ConfigError);
  });
  it('production with events enabled requires an explicit RABBITMQ_URL: no silent default broker or default credentials', () => {
    expect(() => loadConfig(prod({ AUTH_EVENTS: undefined }))).toThrow(/RABBITMQ_URL is required in production/);
    expect(loadConfig(prod({ AUTH_EVENTS: undefined, RABBITMQ_URL: 'amqps://u:p@broker:5671' })).events).toEqual({ enabled: true, rabbitmqUrl: 'amqps://u:p@broker:5671', confirmTimeoutMs: 5000 });
  });
  it('outside production, events enabled without RABBITMQ_URL keep the local development broker', () => {
    expect(loadConfig(good()).events).toEqual({ enabled: true, rabbitmqUrl: 'amqp://guest:guest@localhost:5672', confirmTimeoutMs: 5000 });
  });
  it('RABBITMQ_CONFIRM_TIMEOUT_MS (Stage 16.2) defaults to 5000 and is bounded (100-60000), like Billing and Payment', () => {
    expect(loadConfig({ ...good(), RABBITMQ_CONFIRM_TIMEOUT_MS: '2000' }).events.confirmTimeoutMs).toBe(2000);
    for (const bad of ['0', '99', '60001', 'abc', '1.5']) expect(() => loadConfig({ ...good(), RABBITMQ_CONFIRM_TIMEOUT_MS: bad })).toThrow(/RABBITMQ_CONFIRM_TIMEOUT_MS/);
    expect(loadConfig({ ...good(), AUTH_EVENTS: 'off', RABBITMQ_CONFIRM_TIMEOUT_MS: 'not validated when off' }).events.confirmTimeoutMs).toBeUndefined();
  });
  it.each(['http://broker:5672', 'broker:5672'])('refuses a RABBITMQ_URL that is not amqp:// or amqps://: %s', (url) => {
    expect(() => loadConfig({ ...good(), RABBITMQ_URL: url })).toThrow(/RABBITMQ_URL must be/);
  });
  it('AUTH_EVENTS=off disables events and ignores RABBITMQ_URL', () => {
    expect(loadConfig({ ...good(), AUTH_EVENTS: 'off', RABBITMQ_URL: 'not validated when off' }).events).toEqual({ enabled: false, rabbitmqUrl: undefined });
  });
  it('PORT and BASELINE_RATE_LIMIT_PER_MINUTE are validated integers with the previous defaults (3000, 100)', () => {
    const c = loadConfig(good());
    expect(c.port).toBe(3000);
    expect(c.baselineRateLimitPerMinute).toBe(100);
    expect(loadConfig({ ...good(), PORT: '8080', BASELINE_RATE_LIMIT_PER_MINUTE: '250' })).toMatchObject({ port: 8080, baselineRateLimitPerMinute: 250 });
    for (const bad of ['0', '70000', 'abc', '3.5']) expect(() => loadConfig({ ...good(), PORT: bad })).toThrow(/PORT/);
    for (const bad of ['0', 'abc']) expect(() => loadConfig({ ...good(), BASELINE_RATE_LIMIT_PER_MINUTE: bad })).toThrow(/BASELINE_RATE_LIMIT_PER_MINUTE/);
  });
});

describe('database runtime limits are validated (Stage 14.4)', () => {
  it('defaults: pool 10, connection 5 s, statement 30 s, idle in transaction 60 s', () => {
    expect(loadConfig(good()).db).toEqual({ poolMax: 10, connectionTimeoutMs: 5000, statementTimeoutMs: 30000, idleInTransactionTimeoutMs: 60000, queryTimeoutMs: 35000 });
  });
  it('accepts values inside the bounds', () => {
    const c = loadConfig({ ...good(), DB_POOL_MAX: '20', DB_CONNECTION_TIMEOUT_MS: '2000', DB_STATEMENT_TIMEOUT_MS: '15000', DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '120000' });
    expect(c.db).toEqual({ poolMax: 20, connectionTimeoutMs: 2000, statementTimeoutMs: 15000, idleInTransactionTimeoutMs: 120000, queryTimeoutMs: 20000 });
  });
  it.each([
    ['DB_POOL_MAX', '0'], ['DB_POOL_MAX', '101'], ['DB_POOL_MAX', 'ten'],
    ['DB_CONNECTION_TIMEOUT_MS', '0'], ['DB_CONNECTION_TIMEOUT_MS', '-1'], ['DB_CONNECTION_TIMEOUT_MS', '1.5'],
    ['DB_STATEMENT_TIMEOUT_MS', '0'], ['DB_STATEMENT_TIMEOUT_MS', '999'], ['DB_STATEMENT_TIMEOUT_MS', 'NaN'],
    ['DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', '0'], ['DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', '3600001'],
  ])('refuses %s=%s (zero, negative, fractional, non-numeric or unbounded values)', (name, value) => {
    expect(() => loadConfig({ ...good(), [name]: value })).toThrow(new RegExp(name));
  });
});

describe('client-side query deadline, same contract as the service-kit (Stage 15.2, I9)', () => {
  const db = (env: Record<string, string>) => loadConfig({ ...good(), ...env }).db;
  it('defaults to the statement timeout + 5 s, following a changed statement timeout', () => {
    expect(db({}).queryTimeoutMs).toBe(35000);
    expect(db({ DB_STATEMENT_TIMEOUT_MS: '1000' }).queryTimeoutMs).toBe(6000);
  });
  it('accepts an explicit value above the statement timeout, up to the bound', () => {
    expect(db({ DB_QUERY_TIMEOUT_MS: '30001' }).queryTimeoutMs).toBe(30001);
    expect(db({ DB_STATEMENT_TIMEOUT_MS: '600000', DB_QUERY_TIMEOUT_MS: '660000' }).queryTimeoutMs).toBe(660000);
  });
  it.each(['0', '-1', '999', '660001', '1.5', 'ten'])('refuses DB_QUERY_TIMEOUT_MS=%s', (value) => {
    expect(() => db({ DB_QUERY_TIMEOUT_MS: value })).toThrow(/DB_QUERY_TIMEOUT_MS must be an integer between 1000 and 660000/);
  });
  it.each([[{ DB_QUERY_TIMEOUT_MS: '30000' }], [{ DB_STATEMENT_TIMEOUT_MS: '60000', DB_QUERY_TIMEOUT_MS: '35000' }]])(
    'refuses a deadline that is not above the statement timeout: %o',
    (env) => {
      expect(() => db(env)).toThrow(/DB_QUERY_TIMEOUT_MS must be greater than DB_STATEMENT_TIMEOUT_MS/);
    },
  );
});

describe('HTTP drain deadline, same contract as the service-kit (Stage 15.5, F-A)', () => {
  const drain = (env: Record<string, string>) => loadConfig({ ...good(), ...env }).httpDrainTimeoutMs;
  it('defaults to 5 s and accepts a value inside 500-120000', () => {
    expect(drain({})).toBe(5000);
    expect(drain({ HTTP_DRAIN_TIMEOUT_MS: '120000' })).toBe(120000);
  });
  it.each(['0', '499', '120001', 'ten'])('refuses HTTP_DRAIN_TIMEOUT_MS=%s', (value) => {
    expect(() => drain({ HTTP_DRAIN_TIMEOUT_MS: value })).toThrow(/HTTP_DRAIN_TIMEOUT_MS/);
  });
});

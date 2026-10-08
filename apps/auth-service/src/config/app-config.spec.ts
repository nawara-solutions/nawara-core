import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    expect(() => loadConfig(e)).toThrow(/^SECRET_KEY_PEPPER must differ from JWT_SECRET \(one key, one purpose\)$/); // V2 A2.3: the variables are named
  });
  it('the join-code pepper is purpose-separated: it must differ from every other secret, and verification defaults to off', () => {
    for (const other of ['JWT_SECRET', 'OPERATOR_CODE_PEPPER', 'SECRET_KEY_PEPPER', 'THROTTLE_KEY_PEPPER']) {
      const e = good(); e.JOIN_CODE_PEPPER = e[other];
      expect(() => loadConfig(e)).toThrow(new RegExp(`^JOIN_CODE_PEPPER must differ from ${other} \\(one key, one purpose\\)$`));
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
    expect(Buffer.from(loadConfig(e).jwt.legacyKey!).toString('base64')).toBe(secret);
  });
  it('production demands https WebAuthn origins and an RP id', () => {
    const p = { ...good(), NODE_ENV: 'production' };
    expect(() => loadConfig(p)).toThrow(/WEBAUTHN/);
    expect(() => loadConfig({ ...p, WEBAUTHN_RP_ID: 'a.test', WEBAUTHN_ORIGINS: 'http://a.test' })).toThrow(/https/);
    expect(loadConfig({ ...p, WEBAUTHN_RP_ID: 'a.test', WEBAUTHN_ORIGINS: 'https://a.test', AUTH_EVENTS: 'off', RABBITMQ_URL: 'amqp://mq:5672' }).env).toBe('production');
  });
  it('a step-up can never be configured longer than the 15-minute database limit', () => {
    expect(() => loadConfig({ ...good(), STEP_UP_TTL_SEC: '901' })).toThrow(ConfigError);
    expect(loadConfig({ ...good(), STEP_UP_TTL_SEC: '900' }).stepUp.ttlSec).toBe(900);
  });
  it('V2 A12.4.3: LOG_LEVEL is read and validated like every other Core service: default info, a valid level honoured, anything else refused', () => {
    expect(loadConfig(good()).logLevel).toBe('info');
    for (const level of ['debug', 'info', 'warn', 'error']) expect(loadConfig({ ...good(), LOG_LEVEL: level }).logLevel).toBe(level);
    for (const bad of ['verbose', 'INFO', 'trace', 'everything']) {
      expect(() => loadConfig({ ...good(), LOG_LEVEL: bad })).toThrow(/LOG_LEVEL must be one of: debug, info, warn, error/);
    }
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
    ...good(), NODE_ENV: 'production', DATABASE_URL: 'postgres://auth_app:pw@db:5432/auth', AUTH_EVENTS: 'off', RABBITMQ_URL: 'amqp://mq:5672',
    WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGINS: 'https://app.example.com', ...over,
  });

  it('accepts a production configuration that uses the least-privilege runtime role', () => {
    const c = loadConfig(prod());
    expect(c.databaseUrl).toBe('postgres://auth_app:pw@db:5432/auth');
    expect(c.events).toEqual({ enabled: false });
    expect(c.audit).toEqual({ rabbitmqUrl: 'amqp://mq:5672', confirmTimeoutMs: 5000, heartbeatS: expect.any(Number) });
  });
  it('Stage 18.7.5: production requires RABBITMQ_URL for the central audit relay EVEN with AUTH_EVENTS=off, never echoing a value', () => {
    expect(() => loadConfig(prod({ RABBITMQ_URL: undefined }))).toThrow(/RABBITMQ_URL is required in production: the central audit relay/);
    expect(() => loadConfig(prod({ RABBITMQ_URL: '' }))).toThrow(/RABBITMQ_URL is required in production/);
    try { loadConfig(prod({ RABBITMQ_URL: 'http://u:s3cret-value@mq' })); throw new Error('no throw'); } catch (err) {
      expect((err as Error).message).toMatch(/RABBITMQ_URL must be/);
      expect((err as Error).message).not.toContain('s3cret-value');
    }
  });
  it('Stage 18.7.5: outside production the audit relay needs no broker (the in-memory bus); AUTH_EVENTS never changes the audit path', () => {
    expect(loadConfig({ ...good(), AUTH_EVENTS: 'off', RABBITMQ_URL: undefined }).audit.rabbitmqUrl).toBeUndefined();
    expect(loadConfig({ ...good(), AUTH_EVENTS: 'on', RABBITMQ_URL: 'amqp://mq:5672' }).audit.rabbitmqUrl).toBe('amqp://mq:5672');
    expect(loadConfig({ ...good(), AUTH_EVENTS: 'off', RABBITMQ_URL: 'amqp://mq:5672' }).audit.rabbitmqUrl).toBe('amqp://mq:5672');
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
  it('Stage 21.C.2: production requires RABBITMQ_URL (the one outbox relay), whatever AUTH_EVENTS says; AUTH_EVENTS only gates writing rows', () => {
    expect(() => loadConfig(prod({ AUTH_EVENTS: undefined, RABBITMQ_URL: undefined }))).toThrow(/RABBITMQ_URL is required in production/);
    expect(loadConfig(prod({ AUTH_EVENTS: undefined, RABBITMQ_URL: 'amqps://u:p@broker:5671' })).events).toEqual({ enabled: true });
    expect(loadConfig(prod({ AUTH_EVENTS: 'off', RABBITMQ_URL: 'amqps://u:p@broker:5671' })).events).toEqual({ enabled: false });
  });
  it('Stage 21.C.2: outside production, events are written by default (the relay uses the in-memory bus without a broker)', () => {
    expect(loadConfig(good()).events).toEqual({ enabled: true });
    expect(loadConfig({ ...good(), RABBITMQ_URL: undefined }).audit.rabbitmqUrl).toBeUndefined();
  });
  it('RABBITMQ_CONFIRM_TIMEOUT_MS (Stage 16.2) defaults to 5000 and is bounded (100-60000), like Billing and Payment; it bounds the one relay', () => {
    expect(loadConfig({ ...good(), RABBITMQ_CONFIRM_TIMEOUT_MS: '2000' }).audit.confirmTimeoutMs).toBe(2000);
    for (const bad of ['0', '99', '60001', 'abc', '1.5']) expect(() => loadConfig({ ...good(), RABBITMQ_CONFIRM_TIMEOUT_MS: bad })).toThrow(/RABBITMQ_CONFIRM_TIMEOUT_MS/);
    expect(() => loadConfig({ ...good(), AUTH_EVENTS: 'off', RABBITMQ_CONFIRM_TIMEOUT_MS: 'abc' })).toThrow(/RABBITMQ_CONFIRM_TIMEOUT_MS/);
    expect(loadConfig({ ...good(), AUTH_EVENTS: 'off', RABBITMQ_CONFIRM_TIMEOUT_MS: '2000' })).toMatchObject({ events: { enabled: false }, audit: { confirmTimeoutMs: 2000 } });
  });
  it.each(['http://broker:5672', 'broker:5672'])('refuses a RABBITMQ_URL that is not amqp:// or amqps://: %s', (url) => {
    expect(() => loadConfig({ ...good(), RABBITMQ_URL: url })).toThrow(/RABBITMQ_URL must be/);
  });
  it('AUTH_EVENTS=off stops writing domain-event rows only; RABBITMQ_URL is still validated, for the relay (Stage 18.7.5, 21.C.2)', () => {
    expect(loadConfig({ ...good(), AUTH_EVENTS: 'off', RABBITMQ_URL: 'amqp://mq:5672' }).events).toEqual({ enabled: false });
    expect(() => loadConfig({ ...good(), AUTH_EVENTS: 'off', RABBITMQ_URL: 'not a broker url' })).toThrow(/RABBITMQ_URL must be/);
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

  describe('Stage 21.C.2: AUTH_HIERARCHY_SOURCE and Auth\'s Organization Service credential (ADR-0040 decision 3: a configuration switch)', () => {
    const cred = { ORGANIZATION_SERVICE_URL: 'http://organization-service:3000', ORGANIZATION_SERVICE_TOKEN: 't'.repeat(43) };
    it('defaults to the local source with no client (today\'s behavior until the 21.x switch)', () => {
      expect(loadConfig(good()).hierarchy).toEqual({ source: 'local' });
    });
    it('organization-service needs the credential; the credential is a pair; only the two values are accepted', () => {
      expect(() => loadConfig({ ...good(), AUTH_HIERARCHY_SOURCE: 'organization-service' })).toThrow(/needs ORGANIZATION_SERVICE_URL/);
      expect(() => loadConfig({ ...good(), ORGANIZATION_SERVICE_URL: cred.ORGANIZATION_SERVICE_URL })).toThrow(/must be set together/);
      expect(() => loadConfig({ ...good(), AUTH_HIERARCHY_SOURCE: 'auth' })).toThrow(/must be "local" or "organization-service"/);
      expect(loadConfig({ ...good(), ...cred, AUTH_HIERARCHY_SOURCE: 'organization-service' }).hierarchy).toEqual({
        source: 'organization-service', client: { baseUrl: cred.ORGANIZATION_SERVICE_URL, token: cred.ORGANIZATION_SERVICE_TOKEN, timeoutMs: 2000 },
      });
      // the credential alone (a fresh environment's bootstrap, before the switch)
      expect(loadConfig({ ...good(), ...cred }).hierarchy.source).toBe('local');
    });
    it('a short token or a non-http URL is refused, never echoed', () => {
      for (const env of [{ ...cred, ORGANIZATION_SERVICE_TOKEN: 'short-s3cret' }, { ...cred, ORGANIZATION_SERVICE_URL: 'ftp://s3cret-host' }]) {
        try {
          loadConfig({ ...good(), ...env });
          throw new Error('no throw');
        } catch (e) {
          expect((e as Error).message).not.toMatch(/s3cret/);
        }
      }
    });
  });
});

describe('WebAuthn production configuration: the owner admin UI origin under the Nawara RP ID', () => {
  const prod = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    ...good(), NODE_ENV: 'production', DATABASE_URL: 'postgres://auth_app:pw@db:5432/auth', AUTH_EVENTS: 'off', RABBITMQ_URL: 'amqp://mq:5672',
    WEBAUTHN_RP_ID: 'nawara-solutions.com', WEBAUTHN_ORIGINS: 'https://admin.nawara-solutions.com', ...over,
  });

  it('accepts the owner decision: RP nawara-solutions.com, browser origin https://admin.nawara-solutions.com', () => {
    expect(loadConfig(prod()).webauthn).toEqual({ rpId: 'nawara-solutions.com', rpName: 'Nawara', origins: ['https://admin.nawara-solutions.com'] });
  });
  it('refuses to start without an RP ID or without origins', () => {
    expect(() => loadConfig(prod({ WEBAUTHN_RP_ID: undefined }))).toThrow(/WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS are required/);
    expect(() => loadConfig(prod({ WEBAUTHN_ORIGINS: undefined }))).toThrow(/WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS are required/);
    expect(() => loadConfig(prod({ WEBAUTHN_ORIGINS: ' , ' }))).toThrow(/WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS are required/);
  });
  it('refuses a plain http origin', () => {
    expect(() => loadConfig(prod({ WEBAUTHN_ORIGINS: 'http://admin.nawara-solutions.com' }))).toThrow(/https/);
  });
  it('refuses an origin outside the RP ID, including a look-alike suffix and a foreign RP', () => {
    for (const [rp, origin] of [
      ['nawara-solutions.com', 'https://evil.example'],
      ['nawara-solutions.com', 'https://evilnawara-solutions.com'],
      ['nawara-solutions.com', 'https://admin.nawara-solutions.com.evil.example'],
      ['hsalem-anwar.dev', 'https://admin.nawara-solutions.com'],
    ]) expect(() => loadConfig(prod({ WEBAUTHN_RP_ID: rp, WEBAUTHN_ORIGINS: origin })), `${rp} / ${origin}`).toThrow(/subdomain of it/);
  });
  it('refuses an origin that is not exact (a path or a trailing slash never matches a browser origin)', () => {
    for (const bad of ['https://admin.nawara-solutions.com/', 'https://admin.nawara-solutions.com/login']) {
      expect(() => loadConfig(prod({ WEBAUTHN_ORIGINS: bad })), bad).toThrow(/exact origins/);
    }
  });
  it('accepts the RP host itself, and several origins under the RP when intentionally configured', () => {
    expect(loadConfig(prod({ WEBAUTHN_ORIGINS: 'https://nawara-solutions.com' })).webauthn.origins).toEqual(['https://nawara-solutions.com']);
    expect(loadConfig(prod({ WEBAUTHN_ORIGINS: 'https://admin.nawara-solutions.com, https://owner.admin.nawara-solutions.com' })).webauthn.origins)
      .toEqual(['https://admin.nawara-solutions.com', 'https://owner.admin.nawara-solutions.com']);
  });
});

describe('V2 A2.3: targeted configuration hardening (OD-A2.3-1, OD-A2.3-2)', () => {
  const PROD_BASE = {
    DATABASE_URL: 'postgres://auth_app:pw@db:5432/auth', AUTH_EVENTS: 'off', RABBITMQ_URL: 'amqp://mq:5672',
    WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGINS: 'https://app.example.com',
  };
  const refused = (env: NodeJS.ProcessEnv, message: RegExp, ...secrets: string[]) => {
    let err: unknown;
    try {
      loadConfig(env);
    } catch (e) {
      err = e;
    }
    expect(err, JSON.stringify(Object.keys(env).filter((k) => !(k in good())))).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(message);
    for (const v of secrets) expect((err as Error).message).not.toContain(v);
  };
  /** A value of the tracked `.env.example`: a published development secret; never printed. */
  const template = (name: string) => readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`))!.slice(name.length + 1).trim();

  it('OD-A2.3-1: Auth\'s ConfigError is the kit\'s class (one identity for every configuration error)', async () => {
    const kit = await import('@nawara/service-kit');
    expect(ConfigError).toBe(kit.ConfigError);
  });

  it('OD-A2.3-2: an unset or blank NODE_ENV is production (the production rules then apply); only development, test and production are accepted', () => {
    const unset: NodeJS.ProcessEnv = { ...good(), ...PROD_BASE }; delete unset.NODE_ENV;
    expect(loadConfig(unset).env).toBe('production');
    expect(loadConfig({ ...good(), ...PROD_BASE, NODE_ENV: '  ' }).env).toBe('production'); // blank is unset (the kit's reading)
    refused({ ...good(), NODE_ENV: undefined, WEBAUTHN_RP_ID: undefined }, /WEBAUTHN_RP_ID and WEBAUTHN_ORIGINS are required in production/);
    for (const v of ['development', 'test']) expect(loadConfig({ ...good(), NODE_ENV: v }).env).toBe(v);
    expect(loadConfig({ ...good(), NODE_ENV: ' development ' }).env).toBe('development'); // surrounding whitespace removed
    for (const bad of ['prod', 'Production', 'PRODUCTION', 'dev', 'staging']) refused({ ...good(), NODE_ENV: bad }, /^NODE_ENV must be one of: development, test, production$/);
  });

  it('AUTH_EVENTS is exactly on (the default) or off; anything else is refused instead of silently meaning on', () => {
    expect(loadConfig(good()).events.enabled).toBe(true);
    expect(loadConfig({ ...good(), AUTH_EVENTS: 'on' }).events.enabled).toBe(true);
    expect(loadConfig({ ...good(), AUTH_EVENTS: 'off' }).events.enabled).toBe(false);
    expect(loadConfig({ ...good(), AUTH_EVENTS: ' off ' }).events.enabled).toBe(false); // surrounding whitespace removed
    for (const bad of ['true', 'false', '1', '0', 'yes', 'no', 'ON', 'OFF', 'Off', 'garbage']) refused({ ...good(), AUTH_EVENTS: bad }, /^AUTH_EVENTS must be one of: on, off$/, bad.length > 3 ? bad : '\u0000');
  });

  it('REQUIRE_CONTACT_VERIFICATION is exactly true or false (default false); an ambiguous value is refused instead of silently turning verification off', () => {
    expect(loadConfig(good()).onboarding.requireContactVerification).toBe(false);
    expect(loadConfig({ ...good(), REQUIRE_CONTACT_VERIFICATION: 'true' }).onboarding.requireContactVerification).toBe(true);
    expect(loadConfig({ ...good(), REQUIRE_CONTACT_VERIFICATION: 'false' }).onboarding.requireContactVerification).toBe(false);
    expect(loadConfig({ ...good(), REQUIRE_CONTACT_VERIFICATION: ' true ' }).onboarding.requireContactVerification).toBe(true);
    for (const bad of ['1', '0', 'yes', 'no', 'TRUE', 'FALSE', 'True', 'garbage']) {
      refused({ ...good(), REQUIRE_CONTACT_VERIFICATION: bad }, /^REQUIRE_CONTACT_VERIFICATION must be "true" or "false"$/);
    }
  });

  it('CORS_ORIGINS: the same exact-origin rule, and the error never repeats the rejected entry (a URL may carry credentials)', () => {
    const credentialed = 'https://user:password@example.invalid';
    refused({ ...good(), CORS_ORIGINS: `https://ok.test,${credentialed}` }, /^CORS_ORIGINS entries must be exact origins/, credentialed, 'password', 'user:');
    refused({ ...good(), CORS_ORIGINS: 'https://example.invalid/path?token=abc' }, /exact origins/, 'token=abc', '/path');
    expect(loadConfig({ ...good(), CORS_ORIGINS: ' https://a.test , http://localhost:3000 ' }).corsOrigins).toEqual(['https://a.test', 'http://localhost:3000']);
  });

  it.each(['JWT_SECRET', 'OPERATOR_CODE_PEPPER', 'SECRET_KEY_PEPPER', 'THROTTLE_KEY_PEPPER', 'JOIN_CODE_PEPPER'])(
    '%s is canonical standard base64 of at least 32 bytes, never echoed',
    (name) => {
      const valid = good()[name]!;
      for (const bad of [`${valid.slice(0, 10)}*${valid.slice(10)}`, `${valid.slice(0, 10)} ${valid.slice(10)}`, `${valid}=`, randomBytes(32).toString('base64url').replace(/^./, '-')]) {
        refused({ ...good(), [name]: bad }, new RegExp(`^${name} must be standard base64`), bad);
      }
      refused({ ...good(), [name]: randomBytes(31).toString('base64') }, new RegExp(`^${name} must decode to at least 32 bytes$`));
      expect(loadConfig({ ...good(), [name]: valid.replace(/=+$/, '') }).env).toBe('test'); // unpadded canonical is fine
    },
  );

  it.each([
    ['JWT_SECRET', 'AUTH_JWT_SECRET'], ['OPERATOR_CODE_PEPPER', 'AUTH_OPERATOR_CODE_PEPPER'], ['SECRET_KEY_PEPPER', 'AUTH_SECRET_KEY_PEPPER'],
    ['THROTTLE_KEY_PEPPER', 'AUTH_THROTTLE_KEY_PEPPER'], ['JOIN_CODE_PEPPER', 'AUTH_JOIN_CODE_PEPPER'],
  ])('production refuses the published development %s (and a non-random one); development keeps it', (name, templateName) => {
    const published = template(templateName);
    refused({ ...good(), ...PROD_BASE, NODE_ENV: 'production', [name]: published }, new RegExp(`^${name} is a published development key and is refused in production$`), published);
    refused({ ...good(), ...PROD_BASE, NODE_ENV: 'production', [name]: Buffer.alloc(32, 9).toString('base64') }, new RegExp(`^${name} does not look random and is refused in production$`));
    expect(loadConfig({ ...good(), [name]: published }).env).toBe('test');
  });

  it('TOTP_ENCRYPTION_KEYS: ids, exact size, canonical base64, no repeated id or key, an existing active id; published keys refused in production', () => {
    const [a, b] = [randomBytes(32).toString('base64'), randomBytes(32).toString('base64')];
    const ring = (keys: string, active = 'k1') => ({ ...good(), TOTP_ENCRYPTION_KEYS: keys, TOTP_ENCRYPTION_ACTIVE_KEY_ID: active });
    refused(ring(`k1:${a},k1:${b}`), /^TOTP_ENCRYPTION_KEYS must not repeat a key id$/, a, b); // was a silent overwrite
    refused(ring(`k1:${a},k2:${a}`), /^TOTP_ENCRYPTION_KEYS must not repeat a key$/, a);
    refused(ring(`k1:${a}`, 'k9'), /^TOTP_ENCRYPTION_ACTIVE_KEY_ID does not name a key in TOTP_ENCRYPTION_KEYS$/);
    // V2 A4.2: the kit's readKeyRing wording (approved change; Auth's former text was "id:base64(32 bytes)[,id:base64(32 bytes)]").
    refused(ring(`bad id:${a}`), /^TOTP_ENCRYPTION_KEYS must be "id:base64\[,id:base64\]" with ids of 1 to 32 letters, digits, _ or -$/, a);
    refused(ring(a), /^TOTP_ENCRYPTION_KEYS must be "id:base64/, a);
    refused(ring(`k1:${randomBytes(33).toString('base64')}`), /^TOTP_ENCRYPTION_KEYS must decode to exactly 32 bytes$/);
    refused(ring(`k1:${a}!`), /^TOTP_ENCRYPTION_KEYS must be standard base64/, a);
    const published = `k1:${template('AUTH_TOTP_KEY_K1')}`;
    refused({ ...ring(published), ...PROD_BASE, NODE_ENV: 'production' }, /^TOTP_ENCRYPTION_KEYS is a published development key and is refused in production$/, template('AUTH_TOTP_KEY_K1'));
    expect(loadConfig(ring(published)).secrets.totpKeys.get('k1')).toHaveLength(32); // development keeps it
    expect(loadConfig(ring(`k1:${a},k2:${b}`, 'k2')).secrets.totpActiveKeyId).toBe('k2');
    const e: NodeJS.ProcessEnv = { ...ring(`k1:${a}`), JWT_SECRET: a };
    refused(e, /^TOTP_ENCRYPTION_KEYS must differ from JWT_SECRET \(one key, one purpose\)$/, a); // cross-purpose separation kept
  });

  it.each(['auth', 'auth_admin', 'x_admin', 'postgres', 'auth_migrator'])('production refuses the %s database user (the kit rule plus Auth\'s owner role)', (user) => {
    refused({ ...good(), ...PROD_BASE, NODE_ENV: 'production', DATABASE_URL: `postgres://${user}:s3cret-value@db:5432/auth` }, /^DATABASE_URL must use the least-privilege runtime role in production/, 's3cret-value');
  });

  it('production accepts the runtime role auth_app; a malformed user encoding is a ConfigError, never echoing the URL', () => {
    expect(loadConfig({ ...good(), ...PROD_BASE, NODE_ENV: 'production' }).databaseUrl).toContain('auth_app');
    refused({ ...good(), ...PROD_BASE, NODE_ENV: 'production', DATABASE_URL: 'postgres://bad%E0%A4%A:s3cret-value@db:5432/auth' }, /^DATABASE_URL must be a valid URL with a percent-encoded user$/, 's3cret-value');
  });

  it('a NAME_FILE that cannot be read is a value-free ConfigError (the path never appears)', () => {
    const path = '/run/secrets/very-sensitive-jwt-location';
    refused({ ...good(), JWT_SECRET: undefined, JWT_SECRET_FILE: path }, /^JWT_SECRET_FILE is set but the file cannot be read$/, path, 'very-sensitive');
  });
});

/**
 * V2 A4.2 (A4 record §6): characterization of the configuration contract before the loader moves to the kit's `EnvReader`. Everything in
 * this block held before the conversion and must hold after it; the intended changes are in the next block.
 */
describe('V2 A4.2: configuration characterization (unchanged by the EnvReader conversion)', () => {
  const refused = (env: NodeJS.ProcessEnv, message: RegExp, ...secrets: string[]) => {
    let err: unknown;
    try {
      loadConfig(env);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(message);
    for (const v of secrets) expect((err as Error).message).not.toContain(v);
  };
  const secretFile = (content: string) => {
    const f = join(mkdtempSync(join(tmpdir(), 'a42-')), 'secret');
    writeFileSync(f, content);
    return f;
  };
  const cred = { ORGANIZATION_SERVICE_URL: 'http://organization:3000', ORGANIZATION_SERVICE_TOKEN: 'o'.repeat(48) };

  it('TRUST_PROXY=true is one hop, TRUST_PROXY_HOPS wins over it, nothing set is zero', () => {
    expect(loadConfig(good()).trustProxyHops).toBe(0);
    expect(loadConfig({ ...good(), TRUST_PROXY: 'false' }).trustProxyHops).toBe(0);
    expect(loadConfig({ ...good(), TRUST_PROXY: 'true' }).trustProxyHops).toBe(1);
    expect(loadConfig({ ...good(), TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '2' }).trustProxyHops).toBe(2);
    expect(loadConfig({ ...good(), TRUST_PROXY: 'true', TRUST_PROXY_HOPS: '0' }).trustProxyHops).toBe(0);
    refused({ ...good(), TRUST_PROXY_HOPS: '6' }, /^TRUST_PROXY_HOPS must be an integer between 0 and 5$/);
  });

  it.each(['JWT_SECRET', 'OPERATOR_CODE_PEPPER', 'SECRET_KEY_PEPPER', 'THROTTLE_KEY_PEPPER', 'JOIN_CODE_PEPPER'])(
    '%s from NAME_FILE (trailing newline) is byte-identical to the direct value',
    (name) => {
      const value = good()[name]!;
      const direct = loadConfig({ ...good(), [name]: value });
      const fromFile = loadConfig({ ...good(), [name]: undefined, [`${name}_FILE`]: secretFile(`${value}\n`) });
      const pick = (c: ReturnType<typeof loadConfig>) => (name === 'JWT_SECRET' ? Buffer.from(c.jwt.legacyKey!) : c.secrets[({
        OPERATOR_CODE_PEPPER: 'operatorCodePepper', SECRET_KEY_PEPPER: 'secretKeyPepper', THROTTLE_KEY_PEPPER: 'throttlePepper', JOIN_CODE_PEPPER: 'joinCodePepper',
      } as const)[name as 'OPERATOR_CODE_PEPPER']]);
      expect(pick(fromFile).equals(pick(direct))).toBe(true);
      expect(pick(direct).equals(Buffer.from(value, 'base64'))).toBe(true);
    },
  );

  it('the TOTP ring, its active id, the Organization token and the docs password are read from NAME_FILE too', () => {
    const key = b64();
    const c = loadConfig({
      ...good(), ...cred, TOTP_ENCRYPTION_KEYS: undefined, TOTP_ENCRYPTION_ACTIVE_KEY_ID: undefined, ORGANIZATION_SERVICE_TOKEN: undefined,
      TOTP_ENCRYPTION_KEYS_FILE: secretFile(`k7:${key}\n`), TOTP_ENCRYPTION_ACTIVE_KEY_ID_FILE: secretFile('k7\n'),
      ORGANIZATION_SERVICE_TOKEN_FILE: secretFile(`${'t'.repeat(40)}\n`), SWAGGER_PASSWORD_FILE: secretFile(`${'p'.repeat(20)}\n`),
    });
    expect(c.secrets.totpActiveKeyId).toBe('k7');
    expect(c.secrets.totpKeys.get('k7')!.equals(Buffer.from(key, 'base64'))).toBe(true);
    expect(c.hierarchy.client?.token).toBe('t'.repeat(40));
    expect(c.docs).toEqual({ username: 'docs', password: 'p'.repeat(20) });
  });

  it('JWT: HS256 material, issuer nawara-auth, audience nawara, access 900 s, refresh 14 days by default; each overridable', () => {
    const c = loadConfig(good());
    expect(c.jwt).toMatchObject({ issuer: 'nawara-auth', audience: 'nawara', accessTtlSec: 900 });
    expect(c.jwt.legacyKey!).toBeInstanceOf(Uint8Array);
    expect(c.jwt.legacyKey!).toHaveLength(32);
    expect(c.refreshTtlSec).toBe(14 * 86_400);
    expect(loadConfig({ ...good(), JWT_ISSUER: 'iss', JWT_AUDIENCE: 'aud', ACCESS_TOKEN_TTL_SEC: '600', REFRESH_TOKEN_TTL_SEC: '3600' }))
      .toMatchObject({ jwt: { issuer: 'iss', audience: 'aud', accessTtlSec: 600 }, refreshTtlSec: 3600 });
  });

  it('every default, including all 29 rate buckets', () => {
    const c = loadConfig(good());
    expect({ ...c, jwt: undefined, secrets: undefined, databaseUrl: undefined, metrics: undefined }).toEqual({
      env: 'test', logLevel: 'info', port: 3000, databaseUrl: undefined,
      db: { poolMax: 10, connectionTimeoutMs: 5000, statementTimeoutMs: 30000, idleInTransactionTimeoutMs: 60000, queryTimeoutMs: 35000 },
      bodyLimitKb: 100, // V2 A4.4: BODY_LIMIT_KB (OD-A4.4-4), the former effective limit
      httpDrainTimeoutMs: 5000, events: { enabled: true }, hierarchy: { source: 'local' },
      audit: { rabbitmqUrl: undefined, confirmTimeoutMs: 5000, heartbeatS: c.audit.heartbeatS },
      trustProxyHops: 0, corsOrigins: [], metrics: undefined, baselineRateLimitPerMinute: 100,
      jwt: undefined, refreshTtlSec: 1_209_600, bcryptCost: 12, secrets: undefined,
      totp: { issuer: 'Nawara', epochToleranceSec: 30 },
      webauthn: { rpId: 'localhost', rpName: 'Nawara', origins: ['http://localhost:3000'] },
      challengeTtlSec: 600, stepUp: { ttlSec: 300 },
      recovery: { cooldownSec: 86_400, requestTtlSec: 604_800, enrollmentTtlSec: 1800 },
      operator: { timezone: 'UTC', fallbackSessionSec: 28_800, confirmationTtlSec: 28_800 },
      rate: {
        login_ip: { limit: 60, windowSec: 900 }, login_identifier: { limit: 10, windowSec: 900 }, register_ip: { limit: 20, windowSec: 3600 },
        refresh_ip: { limit: 120, windowSec: 900 }, owner_verify_owner: { limit: 8, windowSec: 300 }, owner_verify_ip: { limit: 30, windowSec: 300 },
        step_up_owner: { limit: 10, windowSec: 300 }, step_up_ip: { limit: 30, windowSec: 300 }, factor_enroll_owner: { limit: 10, windowSec: 3600 },
        recovery_ip: { limit: 10, windowSec: 3600 }, recovery_identifier: { limit: 5, windowSec: 3600 },
        operator_request_identifier: { limit: 5, windowSec: 3600 }, operator_request_ip: { limit: 30, windowSec: 3600 },
        operator_verify_identifier: { limit: 10, windowSec: 900 }, operator_verify_ip: { limit: 40, windowSec: 900 },
        operator_verify_global: { limit: 600, windowSec: 60 }, operator_confirm_ip: { limit: 30, windowSec: 900 },
        join_code_resolve_ip: { limit: 20, windowSec: 900 }, join_code_resolve_global: { limit: 1000, windowSec: 60 },
        join_code_manage_actor: { limit: 30, windowSec: 3600 }, membership_op_actor: { limit: 120, windowSec: 900 },
        membership_join_user: { limit: 10, windowSec: 3600 }, contact_request_user: { limit: 5, windowSec: 3600 },
        contact_verify_user: { limit: 10, windowSec: 900 }, contact_verify_ip: { limit: 40, windowSec: 900 },
        invitation_resolve_ip: { limit: 15, windowSec: 900 }, invitation_resolve_global: { limit: 500, windowSec: 60 },
        invitation_accept_ip: { limit: 10, windowSec: 900 }, invitation_manage_actor: { limit: 20, windowSec: 3600 },
      },
      onboarding: { requireContactVerification: false, contactCodeTtlSec: 900, invitation: { minMinutes: 15, defaultMinutes: 1440, maxMinutes: 10_080 } },
      docs: { username: 'docs', password: undefined },
    });
    expect(Object.keys(c.rate)).toHaveLength(29);
    expect(c.secrets.totpActiveKeyId).toBe('k1');
  });

  // [variable, min, max]: each bound is accepted, one past it is refused with the same message; values are never echoed.
  const BOUNDS: Array<[string, number, number]> = [
    ['PORT', 1, 65_535], ['DB_POOL_MAX', 1, 100], ['DB_CONNECTION_TIMEOUT_MS', 100, 60_000], ['DB_STATEMENT_TIMEOUT_MS', 1000, 600_000],
    ['DB_IDLE_IN_TRANSACTION_TIMEOUT_MS', 1000, 3_600_000], ['RABBITMQ_CONFIRM_TIMEOUT_MS', 100, 60_000], ['BASELINE_RATE_LIMIT_PER_MINUTE', 1, 1_000_000],
    ['ACCESS_TOKEN_TTL_SEC', 30, 3600], ['REFRESH_TOKEN_TTL_SEC', 60, 90 * 86_400], ['BCRYPT_COST', 4, 15], ['TOTP_EPOCH_TOLERANCE_SEC', 0, 60],
    ['CHALLENGE_TTL_SEC', 30, 1800], ['STEP_UP_TTL_SEC', 30, 900], ['RECOVERY_COOLDOWN_SEC', 1, 30 * 86_400], ['RECOVERY_REQUEST_TTL_SEC', 60, 60 * 86_400],
    ['RECOVERY_ENROLLMENT_TTL_SEC', 60, 1800], ['OPERATOR_FALLBACK_SESSION_SEC', 60, 24 * 3600], ['OPERATOR_CONFIRMATION_TTL_SEC', 60, 7 * 86_400],
    ['CONTACT_CODE_TTL_SEC', 60, 3600], ['INVITATION_MIN_MINUTES', 1, 1440],
  ];
  it.each(BOUNDS)('%s is an integer between %d and %d', (name, min, max) => {
    expect(() => loadConfig({ ...good(), [name]: String(min) })).not.toThrow();
    expect(() => loadConfig({ ...good(), [name]: String(max) })).not.toThrow();
    for (const bad of [String(min - 1), String(max + 1), 'abc', '1.5']) refused({ ...good(), [name]: bad }, new RegExp(`^${name} must be an integer between ${min} and ${max}$`));
  });
  it('INVITATION_DEFAULT_MINUTES, INVITATION_MAX_MINUTES and ORGANIZATION_SERVICE_TIMEOUT_MS keep their bounds and ordering', () => {
    for (const name of ['INVITATION_DEFAULT_MINUTES', 'INVITATION_MAX_MINUTES']) {
      refused({ ...good(), [name]: '0' }, new RegExp(`^${name} must be an integer between 1 and 43200$`));
      refused({ ...good(), [name]: '43201' }, new RegExp(`^${name} must be an integer between 1 and 43200$`));
    }
    refused({ ...good(), INVITATION_MIN_MINUTES: '60', INVITATION_DEFAULT_MINUTES: '30' }, /^INVITATION_MIN_MINUTES <= INVITATION_DEFAULT_MINUTES <= INVITATION_MAX_MINUTES must hold$/);
    expect(loadConfig({ ...good(), INVITATION_DEFAULT_MINUTES: '43200', INVITATION_MAX_MINUTES: '43200' }).onboarding.invitation.maxMinutes).toBe(43_200);
    refused({ ...good(), ...cred, ORGANIZATION_SERVICE_TIMEOUT_MS: '99' }, /^ORGANIZATION_SERVICE_TIMEOUT_MS must be an integer between 100 and 10000$/);
    expect(loadConfig({ ...good(), ...cred, ORGANIZATION_SERVICE_TIMEOUT_MS: '10000' }).hierarchy.client?.timeoutMs).toBe(10_000);
  });
  it('every RATE_<BUCKET>_LIMIT (1-1000000) and RATE_<BUCKET>_WINDOW_SEC (1-86400) keeps its name and bounds', () => {
    for (const bucket of Object.keys(loadConfig(good()).rate)) {
      const n = bucket.toUpperCase();
      expect(loadConfig({ ...good(), [`RATE_${n}_LIMIT`]: '1000000', [`RATE_${n}_WINDOW_SEC`]: '86400' }).rate[bucket as 'login_ip']).toEqual({ limit: 1_000_000, windowSec: 86_400 });
      refused({ ...good(), [`RATE_${n}_LIMIT`]: '0' }, new RegExp(`^RATE_${n}_LIMIT must be an integer between 1 and 1000000$`));
      refused({ ...good(), [`RATE_${n}_WINDOW_SEC`]: '86401' }, new RegExp(`^RATE_${n}_WINDOW_SEC must be an integer between 1 and 86400$`));
    }
  });

  it('refusal messages are stable and never carry the value', () => {
    refused({ ...good(), JWT_SECRET: undefined }, /^JWT_SECRET is required$/);
    refused({ ...good(), TOTP_ENCRYPTION_ACTIVE_KEY_ID: undefined }, /^TOTP_ENCRYPTION_ACTIVE_KEY_ID is required$/);
    refused({ ...good(), DATABASE_URL: undefined }, /^DATABASE_URL is required$/);
    refused({ ...good(), DATABASE_URL: 'not a url s3cret' }, /^DATABASE_URL must be a valid URL$/, 's3cret');
    refused({ ...good(), DATABASE_URL: 'mysql://u:s3cret@h/db' }, /^DATABASE_URL must use postgres: or postgresql:$/, 's3cret');
    refused({ ...good(), RABBITMQ_URL: 'http://u:s3cret@mq' }, /^RABBITMQ_URL must be a valid amqp:\/\/ or amqps:\/\/ URL$/, 's3cret');
    refused({ ...good(), SWAGGER_PASSWORD: 'short-s3cret' }, /^SWAGGER_PASSWORD must be at least 16 characters$/, 'short-s3cret');
    refused({ ...good(), ...cred, ORGANIZATION_SERVICE_TOKEN: 'short-s3cret' }, /^ORGANIZATION_SERVICE_TOKEN must be at least 32 characters \(a generated service token\)$/, 'short-s3cret');
    refused({ ...good(), ORGANIZATION_SERVICE_TOKEN: cred.ORGANIZATION_SERVICE_TOKEN }, /^ORGANIZATION_SERVICE_URL and ORGANIZATION_SERVICE_TOKEN must be set together$/, cred.ORGANIZATION_SERVICE_TOKEN);
    refused({ ...good(), ...cred, ORGANIZATION_SERVICE_URL: 'ftp://u:s3cret@o' }, /^ORGANIZATION_SERVICE_URL must be a valid http:\/\/ or https:\/\/ URL$/, 's3cret');
    refused({ ...good(), AUTH_HIERARCHY_SOURCE: 'remote' }, /^AUTH_HIERARCHY_SOURCE must be "local" or "organization-service"$/);
    refused({ ...good(), DB_STATEMENT_TIMEOUT_MS: '40000', DB_QUERY_TIMEOUT_MS: '40000' }, /^DB_QUERY_TIMEOUT_MS must be greater than DB_STATEMENT_TIMEOUT_MS$/);
  });

  it('unknown and stale variables (PAYMENT_SERVICE_*, anything else) are ignored: the configuration is identical', () => {
    const base = good();
    expect(loadConfig({ ...base, PAYMENT_SERVICE_TOKEN: 'stale-token-value', PAYMENT_SERVICE_URL: 'http://payment:3000', SOMETHING_ELSE: 'x' })).toEqual(loadConfig(base));
  });

  it('a production configuration shaped like the deploy script\'s (direct values, TRUST_PROXY=true, AUTH_EVENTS=off) loads', () => {
    const c = loadConfig({
      NODE_ENV: 'production', DATABASE_URL: 'postgres://auth_app:pw@nawara-core-auth-db:5432/auth',
      JWT_SECRET: b64(), OPERATOR_CODE_PEPPER: b64(), SECRET_KEY_PEPPER: b64(), THROTTLE_KEY_PEPPER: b64(), JOIN_CODE_PEPPER: b64(),
      TOTP_ENCRYPTION_KEYS: `k1:${b64()}`, TOTP_ENCRYPTION_ACTIVE_KEY_ID: 'k1',
      WEBAUTHN_RP_ID: 'nawara-solutions.com', WEBAUTHN_ORIGINS: 'https://admin.nawara-solutions.com', WEBAUTHN_RP_NAME: 'Nawara',
      TRUST_PROXY: 'true', AUTH_EVENTS: 'off', RABBITMQ_URL: 'amqp://auth-service:pw@rabbitmq:5672', ...cred,
      WORK_TIMEZONE: 'Africa/Tunis', REQUIRE_CONTACT_VERIFICATION: 'false', SWAGGER_USERNAME: 'docs', SWAGGER_PASSWORD: 'f'.repeat(48),
      PAYMENT_SERVICE_TOKEN: 'stale', PAYMENT_SERVICE_URL: 'http://stale',
    });
    expect(c).toMatchObject({
      env: 'production', trustProxyHops: 1, events: { enabled: false }, operator: { timezone: 'Africa/Tunis' },
      webauthn: { rpId: 'nawara-solutions.com', rpName: 'Nawara', origins: ['https://admin.nawara-solutions.com'] },
      onboarding: { requireContactVerification: false }, docs: { username: 'docs' }, hierarchy: { source: 'local' },
    });
  });

  it('production keeps refusing low-entropy, duplicated and published keys, unsafe roles and foreign WebAuthn origins', () => {
    const prodEnv: NodeJS.ProcessEnv = { ...good(), NODE_ENV: 'production', DATABASE_URL: 'postgres://auth_app:pw@db:5432/auth', AUTH_EVENTS: 'off', RABBITMQ_URL: 'amqp://mq:5672', WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGINS: 'https://app.example.com' };
    expect(loadConfig(prodEnv).env).toBe('production');
    refused({ ...prodEnv, JWT_SECRET: Buffer.alloc(32, 7).toString('base64') }, /^JWT_SECRET does not look random and is refused in production$/);
    refused({ ...prodEnv, THROTTLE_KEY_PEPPER: prodEnv.JWT_SECRET }, /^THROTTLE_KEY_PEPPER must differ from JWT_SECRET \(one key, one purpose\)$/, prodEnv.JWT_SECRET!);
    refused({ ...prodEnv, DATABASE_URL: 'postgres://auth:s3cret@db:5432/auth' }, /^DATABASE_URL must use the least-privilege runtime role in production/, 's3cret');
    refused({ ...prodEnv, WEBAUTHN_ORIGINS: 'https://evil.test' }, /^every WEBAUTHN_ORIGINS host must be WEBAUTHN_RP_ID or a subdomain of it$/);
    refused({ ...prodEnv, WEBAUTHN_ORIGINS: 'http://app.example.com' }, /^WEBAUTHN_ORIGINS must be https:\/\/ origins in production$/);
    refused({ ...prodEnv, RABBITMQ_URL: undefined }, /^RABBITMQ_URL is required in production/);
  });
});

/** V2 A4.2: the intended changes of the `EnvReader` conversion (OD-A4-2, OD-A4-3 and the A4.2 owner decisions 1 to 4). */
describe('V2 A4.2: EnvReader conversion (intended changes)', () => {
  const refused = (env: NodeJS.ProcessEnv, message: RegExp, ...secrets: string[]) => {
    let err: unknown;
    try {
      loadConfig(env);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(message);
    for (const v of secrets) expect((err as Error).message).not.toContain(v);
  };
  const secretFile = (content: string) => {
    const f = join(mkdtempSync(join(tmpdir(), 'a42-')), 'value');
    writeFileSync(f, content);
    return f;
  };
  const cred = { ORGANIZATION_SERVICE_URL: 'http://organization:3000', ORGANIZATION_SERVICE_TOKEN: 'o'.repeat(48) };

  it.each([
    'JWT_SECRET', 'OPERATOR_CODE_PEPPER', 'SECRET_KEY_PEPPER', 'THROTTLE_KEY_PEPPER', 'JOIN_CODE_PEPPER', 'TOTP_ENCRYPTION_KEYS',
    'TOTP_ENCRYPTION_ACTIVE_KEY_ID', 'DATABASE_URL', 'RABBITMQ_URL', 'ORGANIZATION_SERVICE_TOKEN', 'SWAGGER_PASSWORD', 'PORT', 'JWT_ISSUER',
  ])('OD-A4-2: %s and its _FILE form together are refused (formerly the file won), naming neither value nor path', (name) => {
    const env: NodeJS.ProcessEnv = { ...good(), ...cred, RABBITMQ_URL: 'amqp://mq:5672', SWAGGER_PASSWORD: 'p'.repeat(20), PORT: '3000', JWT_ISSUER: 'iss' };
    const path = secretFile(env[name]!);
    refused({ ...env, [`${name}_FILE`]: path }, new RegExp(`^set ${name} or ${name}_FILE, not both$`), env[name]!, path);
  });

  it('DATABASE_URL_FILE and RABBITMQ_URL_FILE are read (newly supported) and validated like the direct values', () => {
    const c = loadConfig({
      ...good(), DATABASE_URL: undefined, DATABASE_URL_FILE: secretFile('postgres://auth_app:pw@db:5432/auth\n'),
      RABBITMQ_URL_FILE: secretFile('amqps://auth-service:pw@broker:5671\n'),
    });
    expect(c.databaseUrl).toBe('postgres://auth_app:pw@db:5432/auth');
    expect(c.audit.rabbitmqUrl).toBe('amqps://auth-service:pw@broker:5671');
    refused({ ...good(), DATABASE_URL: undefined, DATABASE_URL_FILE: secretFile('mysql://u:s3cret@h/db') }, /^DATABASE_URL must use postgres: or postgresql:$/, 's3cret');
    refused({ ...good(), RABBITMQ_URL_FILE: secretFile('http://u:s3cret@mq') }, /^RABBITMQ_URL must be a valid amqp:\/\/ or amqps:\/\/ URL$/, 's3cret');
    const missing = '/run/secrets/no-such-database-url';
    refused({ ...good(), DATABASE_URL: undefined, DATABASE_URL_FILE: missing }, /^DATABASE_URL_FILE is set but the file cannot be read$/, missing);
  });

  it('production applies the runtime-role rule to a DATABASE_URL read from DATABASE_URL_FILE', () => {
    const prodEnv: NodeJS.ProcessEnv = {
      ...good(), NODE_ENV: 'production', DATABASE_URL: undefined, AUTH_EVENTS: 'off', RABBITMQ_URL: 'amqp://mq:5672',
      WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGINS: 'https://app.example.com',
    };
    expect(loadConfig({ ...prodEnv, DATABASE_URL_FILE: secretFile('postgres://auth_app:pw@db:5432/auth') }).databaseUrl).toContain('auth_app');
    for (const user of ['auth', 'postgres', 'auth_migrator']) {
      refused({ ...prodEnv, DATABASE_URL_FILE: secretFile(`postgres://${user}:s3cret-value@db:5432/auth`) }, /^DATABASE_URL must use the least-privilege runtime role in production/, 's3cret-value');
    }
  });

  it('integers use the kit grammar: only signed decimals (1e3, 0x10, 5.0 and Infinity are refused); a blank value is the default', () => {
    for (const bad of ['1e3', '0x10', '5.0', 'Infinity', '1_000']) refused({ ...good(), PORT: bad }, /^PORT must be an integer between 1 and 65535$/);
    for (const bad of ['6e1', '6.0']) refused({ ...good(), RATE_LOGIN_IP_LIMIT: bad }, /^RATE_LOGIN_IP_LIMIT must be an integer between 1 and 1000000$/);
    expect(loadConfig({ ...good(), PORT: '+8080' }).port).toBe(8080);
    expect(loadConfig({ ...good(), PORT: ' 8080 ' }).port).toBe(8080);
    expect(loadConfig({ ...good(), PORT: '   ', ACCESS_TOKEN_TTL_SEC: ' ', TOTP_EPOCH_TOLERANCE_SEC: '  ' })).toMatchObject({ port: 3000, jwt: { accessTtlSec: 900 }, totp: { epochToleranceSec: 30 } });
  });

  it('a blank defaulted string is unset and takes its documented default (formerly an empty string was kept)', () => {
    const c = loadConfig({ ...good(), JWT_ISSUER: '', JWT_AUDIENCE: '  ', TOTP_ISSUER: '', WEBAUTHN_RP_NAME: ' ', WORK_TIMEZONE: '', AUTH_HIERARCHY_SOURCE: '' });
    expect(c.jwt).toMatchObject({ issuer: 'nawara-auth', audience: 'nawara' });
    expect(c).toMatchObject({ totp: { issuer: 'Nawara' }, webauthn: { rpName: 'Nawara' }, operator: { timezone: 'UTC' }, hierarchy: { source: 'local' } });
  });

  it('a direct secret is trimmed before validation (formerly refused as non-canonical); inner whitespace is still refused', () => {
    const v = good().JWT_SECRET!;
    expect(Buffer.from(loadConfig({ ...good(), JWT_SECRET: `  ${v}\n` }).jwt.legacyKey!).equals(Buffer.from(v, 'base64'))).toBe(true);
    expect(loadConfig({ ...good(), ...cred, ORGANIZATION_SERVICE_TOKEN: ` ${cred.ORGANIZATION_SERVICE_TOKEN} ` }).hierarchy.client?.token).toBe(cred.ORGANIZATION_SERVICE_TOKEN);
    refused({ ...good(), JWT_SECRET: `${v.slice(0, 10)} ${v.slice(10)}` }, /^JWT_SECRET must be standard base64/, v);
  });

  it('V2 A4.4 (OD-A4.4-4): BODY_LIMIT_KB is the kit\'s variable and rule: default 100, an integer between 1 and 10240', () => {
    expect(loadConfig(good()).bodyLimitKb).toBe(100);
    expect(loadConfig({ ...good(), BODY_LIMIT_KB: '1' }).bodyLimitKb).toBe(1);
    expect(loadConfig({ ...good(), BODY_LIMIT_KB: '10240' }).bodyLimitKb).toBe(10_240);
    for (const bad of ['0', '10241', '1e2', 'big']) refused({ ...good(), BODY_LIMIT_KB: bad }, /^BODY_LIMIT_KB must be an integer between 1 and 10240$/);
  });

  it('OD-A4-3: a test can still inject a file reader instead of the disk (the former SecretSource seam)', () => {
    const files: Record<string, string> = { '/virtual/jwt': `${good().JWT_SECRET}\n` };
    const c = loadConfig({ ...good(), JWT_SECRET: undefined, JWT_SECRET_FILE: '/virtual/jwt' }, (p) => {
      if (!(p in files)) throw new Error('ENOENT');
      return files[p]!;
    });
    expect(Buffer.from(c.jwt.legacyKey!).toString('base64')).toBe(files['/virtual/jwt']!.trim());
    refused({ ...good(), JWT_SECRET: undefined, JWT_SECRET_FILE: '/virtual/missing' }, /^JWT_SECRET_FILE is set but the file cannot be read$/, '/virtual/missing');
  });
});

/** V2 A4.7 (ADR-0058 rules 1 to 3, A4 record §10.3): the optional JWT signing-key ring and the legacy key. */
describe('V2 A4.7: JWT signing-key ring configuration', () => {
  const PROD_BASE = {
    DATABASE_URL: 'postgres://auth_app:pw@db:5432/auth', AUTH_EVENTS: 'off', RABBITMQ_URL: 'amqp://mq:5672',
    WEBAUTHN_RP_ID: 'example.com', WEBAUTHN_ORIGINS: 'https://app.example.com',
  };
  const refused = (env: NodeJS.ProcessEnv, message: RegExp, ...secrets: string[]) => {
    let err: unknown;
    try {
      loadConfig(env);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(message);
    for (const v of secrets) expect((err as Error).message).not.toContain(v);
  };
  const secretFile = (content: string) => {
    const f = join(mkdtempSync(join(tmpdir(), 'a47-')), 'secret');
    writeFileSync(f, content);
    return f;
  };
  const template = (name: string) => readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8').split('\n').find((l) => l.startsWith(`${name}=`))!.slice(name.length + 1).trim();
  const ring = (...entries: Array<[string, string]>) => entries.map(([id, k]) => `${id}:${k}`).join(',');
  const eq = (a: Uint8Array | undefined, b64value: string) => a !== undefined && Buffer.from(a).equals(Buffer.from(b64value, 'base64'));

  it('legacy only (an unchanged .env): JWT_SECRET signs and verifies, active id legacy, empty ring', () => {
    const e = good();
    const c = loadConfig(e);
    expect(c.jwt.activeKeyId).toBe('legacy');
    expect(c.jwt.ring.size).toBe(0);
    expect(eq(c.jwt.legacyKey, e.JWT_SECRET!)).toBe(true);
    expect(c.jwt.legacyKey).toBeInstanceOf(Uint8Array);
  });

  it('every row of the §10.3 table', () => {
    const [k1, k2] = [b64(), b64()];
    const noSecret = { ...good(), JWT_SECRET: undefined };
    // – – –: the existing refusal
    refused(noSecret, /^JWT_SECRET is required$/);
    // exactly one ring variable: refused, with or without JWT_SECRET
    for (const base of [good(), noSecret]) {
      refused({ ...base, JWT_SIGNING_KEYS: ring(['k1', k1]) }, /^JWT_SIGNING_KEYS and JWT_ACTIVE_KEY_ID must be set together$/, k1);
      refused({ ...base, JWT_ACTIVE_KEY_ID: 'k1' }, /^JWT_SIGNING_KEYS and JWT_ACTIVE_KEY_ID must be set together$/);
      refused({ ...base, JWT_ACTIVE_KEY_ID: 'legacy' }, /^JWT_SIGNING_KEYS and JWT_ACTIVE_KEY_ID must be set together$/);
    }
    // set, ring, legacy: JWT_SECRET signs; ring keys verify only
    const a = loadConfig({ ...good(), JWT_SIGNING_KEYS: ring(['k1', k1]), JWT_ACTIVE_KEY_ID: 'legacy' });
    expect(a.jwt.activeKeyId).toBe('legacy');
    expect(a.jwt.legacyKey).toBeDefined();
    expect(eq(a.jwt.ring.get('k1'), k1)).toBe(true);
    // –, ring, legacy: refused
    refused({ ...noSecret, JWT_SIGNING_KEYS: ring(['k1', k1]), JWT_ACTIVE_KEY_ID: 'legacy' }, /^JWT_ACTIVE_KEY_ID is legacy but JWT_SECRET is not set$/, k1);
    // set, ring, ring id: that key signs; JWT_SECRET still verifies kid-less tokens
    const b = loadConfig({ ...good(), JWT_SIGNING_KEYS: ring(['k1', k1], ['k2', k2]), JWT_ACTIVE_KEY_ID: 'k2' });
    expect(b.jwt.activeKeyId).toBe('k2');
    expect(b.jwt.legacyKey).toBeDefined();
    expect([...b.jwt.ring.keys()]).toEqual(['k1', 'k2']);
    // –, ring, ring id: legacy retired
    const c = loadConfig({ ...noSecret, JWT_SIGNING_KEYS: ring(['k1', k1]), JWT_ACTIVE_KEY_ID: 'k1' });
    expect(c.jwt.activeKeyId).toBe('k1');
    expect(c.jwt.legacyKey).toBeUndefined();
    expect(eq(c.jwt.ring.get('k1'), k1)).toBe(true);
    // any, ring, not legacy and not in the ring: refused
    for (const base of [good(), noSecret]) {
      for (const active of ['k9', 'K1', 'Legacy', 'LEGACY']) {
        refused({ ...base, JWT_SIGNING_KEYS: ring(['k1', k1]), JWT_ACTIVE_KEY_ID: active }, /^JWT_ACTIVE_KEY_ID does not name a key in JWT_SIGNING_KEYS$/, k1);
      }
    }
  });

  it('the reserved id legacy is refused as a ring id in any letter case, with or without JWT_SECRET', () => {
    const k1 = b64();
    for (const id of ['legacy', 'LEGACY', 'Legacy', 'lEgAcY']) {
      for (const active of [id, 'k1', 'legacy']) {
        refused({ ...good(), JWT_SIGNING_KEYS: ring(['k1', b64()], [id, k1]), JWT_ACTIVE_KEY_ID: active }, /^JWT_SIGNING_KEYS must not use the reserved key id legacy$/, k1);
      }
    }
  });

  it('key material: malformed entry, bad id, short or non-canonical key, repeated id or key, more than three keys', () => {
    const [a, b] = [b64(), b64()];
    const r = (v: string) => ({ ...good(), JWT_SIGNING_KEYS: v, JWT_ACTIVE_KEY_ID: 'k1' });
    refused(r(a), /^JWT_SIGNING_KEYS must be "id:base64\[,id:base64\]" with ids of 1 to 32 letters, digits, _ or -$/, a);
    refused(r(`bad id:${a}`), /^JWT_SIGNING_KEYS must be "id:base64/, a);
    refused(r(`${'k'.repeat(33)}:${a}`), /^JWT_SIGNING_KEYS must be "id:base64/, a);
    refused(r(`k1:${randomBytes(31).toString('base64')}`), /^JWT_SIGNING_KEYS must decode to at least 32 bytes$/);
    refused(r(`k1:${a}!`), /^JWT_SIGNING_KEYS must be standard base64/, a);
    refused(r(ring(['k1', a], ['k1', b])), /^JWT_SIGNING_KEYS must not repeat a key id$/, a, b);
    refused(r(ring(['k1', a], ['k2', a])), /^JWT_SIGNING_KEYS must not repeat a key$/, a);
    expect(loadConfig(r(ring(['k1', a], ['k2', b], ['k3', b64()]))).jwt.ring.size).toBe(3);
    refused(r(ring(['k1', a], ['k2', b], ['k3', b64()], ['k4', b64()])), /^JWT_SIGNING_KEYS must hold at most 3 keys$/, a, b);
    // JWT_SECRET keeps its own rules when the ring is configured
    refused({ ...r(ring(['k1', a])), JWT_SECRET: randomBytes(31).toString('base64') }, /^JWT_SECRET must decode to at least 32 bytes$/, a);
  });

  it('one key, one purpose: a ring key equal to JWT_SECRET, a pepper or a TOTP key is refused, naming variables only', () => {
    const e = good();
    const totpKey = e.TOTP_ENCRYPTION_KEYS!.split(':')[1];
    const withRing = (k: string) => ({ ...e, JWT_SIGNING_KEYS: ring(['k1', b64()], ['k2', k]), JWT_ACTIVE_KEY_ID: 'k1' });
    refused(withRing(e.JWT_SECRET!), /^JWT_SIGNING_KEYS must differ from JWT_SECRET \(one key, one purpose\)$/, e.JWT_SECRET!);
    for (const pepper of ['OPERATOR_CODE_PEPPER', 'SECRET_KEY_PEPPER', 'THROTTLE_KEY_PEPPER', 'JOIN_CODE_PEPPER']) {
      refused(withRing(e[pepper]!), new RegExp(`^${pepper} must differ from JWT_SIGNING_KEYS \\(one key, one purpose\\)$`), e[pepper]!);
    }
    refused(withRing(totpKey), /^TOTP_ENCRYPTION_KEYS must differ from JWT_SIGNING_KEYS \(one key, one purpose\)$/, totpKey);
    // with JWT_SECRET removed, the ring is still separated from every other purpose
    refused({ ...withRing(e.OPERATOR_CODE_PEPPER!), JWT_SECRET: undefined }, /^OPERATOR_CODE_PEPPER must differ from JWT_SIGNING_KEYS/, e.OPERATOR_CODE_PEPPER!);
  });

  it('production refuses a published development key and a non-random key in the ring', () => {
    const published = template('AUTH_JWT_SECRET');
    const prod = (k: string) => ({ ...good(), ...PROD_BASE, NODE_ENV: 'production', JWT_SIGNING_KEYS: ring(['k1', k]), JWT_ACTIVE_KEY_ID: 'k1' });
    refused(prod(published), /^JWT_SIGNING_KEYS is a published development key and is refused in production$/, published);
    refused(prod(Buffer.alloc(32, 9).toString('base64')), /^JWT_SIGNING_KEYS does not look random and is refused in production$/);
    expect(loadConfig(prod(b64())).jwt.activeKeyId).toBe('k1');
    expect(loadConfig({ ...good(), JWT_SIGNING_KEYS: ring(['k1', published]), JWT_ACTIVE_KEY_ID: 'k1' }).jwt.ring.size).toBe(1); // development accepts it
  });

  it('both ring variables accept NAME_FILE; NAME together with NAME_FILE is refused for each', () => {
    const k1 = b64();
    const c = loadConfig({ ...good(), JWT_SECRET: undefined, JWT_SIGNING_KEYS_FILE: secretFile(`k1:${k1}\n`), JWT_ACTIVE_KEY_ID_FILE: secretFile('k1\n') });
    expect(c.jwt.activeKeyId).toBe('k1');
    expect(eq(c.jwt.ring.get('k1'), k1)).toBe(true);
    const f = secretFile(`k1:${k1}`);
    refused({ ...good(), JWT_SIGNING_KEYS: `k1:${k1}`, JWT_SIGNING_KEYS_FILE: f, JWT_ACTIVE_KEY_ID: 'k1' }, /^set JWT_SIGNING_KEYS or JWT_SIGNING_KEYS_FILE, not both$/, k1);
    refused({ ...good(), JWT_SIGNING_KEYS: `k1:${k1}`, JWT_ACTIVE_KEY_ID: 'k1', JWT_ACTIVE_KEY_ID_FILE: secretFile('k1') }, /^set JWT_ACTIVE_KEY_ID or JWT_ACTIVE_KEY_ID_FILE, not both$/, k1);
    refused({ ...good(), JWT_SECRET: undefined, JWT_SIGNING_KEYS_FILE: '/nonexistent/a47', JWT_ACTIVE_KEY_ID: 'k1' }, /^JWT_SIGNING_KEYS_FILE is set but the file cannot be read$/);
  });

  it('surrounding whitespace is trimmed; a blank ring variable counts as unset', () => {
    const k1 = b64();
    expect(loadConfig({ ...good(), JWT_SIGNING_KEYS: ` k1:${k1} `, JWT_ACTIVE_KEY_ID: ' k1 ' }).jwt.activeKeyId).toBe('k1');
    expect(loadConfig({ ...good(), JWT_SIGNING_KEYS: '  ', JWT_ACTIVE_KEY_ID: ' ' }).jwt.activeKeyId).toBe('legacy');
    refused({ ...good(), JWT_SIGNING_KEYS: '  ', JWT_ACTIVE_KEY_ID: 'k1' }, /^JWT_SIGNING_KEYS and JWT_ACTIVE_KEY_ID must be set together$/);
  });
});

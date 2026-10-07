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
    expect(Buffer.from(loadConfig(e).jwt.secret).toString('base64')).toBe(secret);
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
    refused(ring(`bad id:${a}`), /^TOTP_ENCRYPTION_KEYS must be "id:base64\(32 bytes\)/, a);
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

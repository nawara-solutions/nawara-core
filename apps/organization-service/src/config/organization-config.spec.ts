import { generateServiceToken } from '@nawara/service-kit';
import { describe, expect, it } from 'vitest';
import { loadOrganizationConfig } from './organization-config.js';

const BASE = { NODE_ENV: 'test', DATABASE_URL: 'postgres://organization_app:pw@localhost:5433/organization', AUTH_SERVICE_URL: 'http://localhost:3001' };

/** Every message must name the variable and NEVER echo a value (a value may be a password, a token or a URL with credentials). */
const refusal = (env: NodeJS.ProcessEnv) => {
  try {
    loadOrganizationConfig(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected the configuration to be refused');
};

describe('loadOrganizationConfig', () => {
  it('loads from the minimal required environment, with only safe defaults', () => {
    const cfg = loadOrganizationConfig(BASE);
    expect(cfg.serviceName).toBe('organization-service');
    expect(cfg.port).toBe(3000);
    expect(cfg.serviceTokens).toEqual([]); // no callers registered: every call is refused
    expect(cfg.docs).toEqual({ username: 'docs', password: undefined });
    expect(cfg.corsOrigins).toEqual([]);
  });

  it('carries ONLY what this service uses: no broker, no outbound service token, no currencies (nothing to publish or price); the one bounded Auth dependency is the human-admin module\'s grant-facts/step-up client (ADR-0042 decision 6)', () => {
    expect(Object.keys(loadOrganizationConfig(BASE)).sort()).toEqual([
      'authServiceUrl', 'authTimeoutMs', 'bodyLimitKb', 'corsOrigins', 'databaseUrl', 'db', 'docs', 'isProduction', 'logLevel', 'nodeEnv', 'port', 'serviceName', 'servicePolicyRaw', 'serviceTokens', 'trustProxy',
    ]);
  });

  it('defaults to production behaviour when NODE_ENV is unset', () => {
    const env = { DATABASE_URL: 'postgres://organization_app:pw@localhost:5433/organization', AUTH_SERVICE_URL: 'http://localhost:3001' };
    expect(loadOrganizationConfig(env).isProduction).toBe(true);
  });

  it('requires AUTH_SERVICE_URL, and only an http(s) URL', () => {
    expect(refusal({ NODE_ENV: 'test', DATABASE_URL: BASE.DATABASE_URL })).toContain('AUTH_SERVICE_URL');
    expect(refusal({ ...BASE, AUTH_SERVICE_URL: 'ftp://auth' })).toContain('AUTH_SERVICE_URL');
    expect(refusal({ ...BASE, AUTH_SERVICE_URL: 'not a url' })).toContain('AUTH_SERVICE_URL');
  });

  it('AUTH_TIMEOUT_MS defaults to 3000ms and is bounded 100-30000', () => {
    expect(loadOrganizationConfig(BASE).authTimeoutMs).toBe(3000);
    expect(loadOrganizationConfig({ ...BASE, AUTH_TIMEOUT_MS: '5000' }).authTimeoutMs).toBe(5000);
    expect(refusal({ ...BASE, AUTH_TIMEOUT_MS: '50' })).toContain('AUTH_TIMEOUT_MS');
    expect(refusal({ ...BASE, AUTH_TIMEOUT_MS: '99999' })).toContain('AUTH_TIMEOUT_MS');
  });

  it('requires DATABASE_URL, and only a postgres URL', () => {
    expect(refusal({ NODE_ENV: 'test' })).toContain('DATABASE_URL');
    expect(refusal({ ...BASE, DATABASE_URL: 'mysql://u:p@h/db' })).toContain('DATABASE_URL');
    expect(refusal({ ...BASE, DATABASE_URL: 'not a url' })).toContain('DATABASE_URL');
  });

  it('refuses a superuser or schema-owner database role in production (ADR-0032), but not in development', () => {
    for (const user of ['postgres', 'root', 'organization_migrator']) {
      expect(refusal({ NODE_ENV: 'production', DATABASE_URL: `postgres://${user}:pw@h/organization`, AUTH_SERVICE_URL: BASE.AUTH_SERVICE_URL })).toContain('least-privilege');
      expect(loadOrganizationConfig({ NODE_ENV: 'development', DATABASE_URL: `postgres://${user}:pw@h/organization`, AUTH_SERVICE_URL: BASE.AUTH_SERVICE_URL }).databaseUrl).toContain(user);
    }
    expect(loadOrganizationConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://organization_app:pw@h/organization', AUTH_SERVICE_URL: BASE.AUTH_SERVICE_URL }).isProduction).toBe(true);
  });

  it('parses service tokens as <caller>:<digest>, keeps only digests, and refuses malformed entries', () => {
    const a = generateServiceToken();
    const b = generateServiceToken();
    const cfg = loadOrganizationConfig({ ...BASE, SERVICE_TOKENS: `billing-service:${a.digest},payment-service:${b.digest}` });
    expect(cfg.serviceTokens).toEqual([{ caller: 'billing-service', digest: a.digest }, { caller: 'payment-service', digest: b.digest }]);
    expect(JSON.stringify(cfg)).not.toContain(a.token);
    for (const bad of ['billing-service', 'billing-service:short', `:${a.digest}`, `billing-service:${a.token}`]) {
      expect(() => loadOrganizationConfig({ ...BASE, SERVICE_TOKENS: bad }), bad).toThrow();
    }
  });

  it('allows at most two tokens per caller (rotation), and never echoes a rejected value', () => {
    const [x, y, z] = [generateServiceToken(), generateServiceToken(), generateServiceToken()];
    const message = refusal({ ...BASE, SERVICE_TOKENS: `svc-a:${x.digest},svc-a:${y.digest},svc-a:${z.digest}` });
    expect(message).not.toContain(x.digest);
  });

  it('docs need a password of at least 16 characters, may come from a file, and are never echoed', () => {
    expect(loadOrganizationConfig({ ...BASE, SWAGGER_PASSWORD: 'a-long-enough-docs-password' }).docs.password).toBe('a-long-enough-docs-password');
    const msg = refusal({ ...BASE, SWAGGER_PASSWORD: 'too-short' });
    expect(msg).toContain('SWAGGER_PASSWORD');
    expect(msg).not.toContain('too-short');
  });

  it('refuses bad ports, log levels and CORS origins without echoing them', () => {
    expect(refusal({ ...BASE, PORT: '99999' })).toContain('PORT');
    expect(refusal({ ...BASE, LOG_LEVEL: 'chatty' })).toContain('LOG_LEVEL');
    expect(refusal({ ...BASE, CORS_ORIGINS: '*' })).toContain('CORS_ORIGINS');
  });

  it('never echoes the database password in a refusal', () => {
    const msg = refusal({ ...BASE, DATABASE_URL: 'mysql://user:hunter2-secret@h/db' });
    expect(msg).not.toContain('hunter2-secret');
  });
});

import { generateServiceToken } from '@nawara/service-kit';
import { describe, expect, it } from 'vitest';
import { loadBillingConfig } from './billing-config.js';

const BASE = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://billing_app:pw@localhost:5433/billing',
  AUTH_SERVICE_URL: 'http://localhost:3001',
  BILLING_SUPPORTED_CURRENCIES: 'TND',
  PAYMENT_SERVICE_URL: 'http://localhost:3002',
  PAYMENT_SERVICE_TOKEN: 'a'.repeat(32),
};

const PROD = { ...BASE, NODE_ENV: 'production', RABBITMQ_URL: 'amqp://guest:guest@localhost:5672' };

/** Every message must name the variable and NEVER echo a value (a value may be a password, a token or a URL with credentials). */
const refusal = (env: NodeJS.ProcessEnv) => {
  try {
    loadBillingConfig(env);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected the configuration to be refused');
};

describe('loadBillingConfig', () => {
  it('loads from the minimal required environment, with only safe defaults', () => {
    const cfg = loadBillingConfig(BASE);
    expect(cfg.serviceName).toBe('billing-service');
    expect(cfg.port).toBe(3000);
    expect(cfg.authTimeoutMs).toBe(3000);
    expect(cfg.rabbitmqUrl).toBeUndefined();
    expect(cfg.serviceTokens).toEqual([]);
    expect(cfg.docs).toEqual({ username: 'docs', password: undefined });
    expect(cfg.corsOrigins).toEqual([]); // CORS is off unless exact origins are listed
    expect(cfg.supportedCurrencies).toEqual(['TND']);
  });

  it('has NO code default for the supported currencies (B-005): a deployment must say', () => {
    const env: NodeJS.ProcessEnv = { ...BASE };
    delete env.BILLING_SUPPORTED_CURRENCIES;
    expect(refusal(env)).toContain('BILLING_SUPPORTED_CURRENCIES');
  });

  it('normalises the supported currency list (trimmed, upper-cased, de-duplicated) and refuses anything that is not an ISO code', () => {
    expect(loadBillingConfig({ ...BASE, BILLING_SUPPORTED_CURRENCIES: ' tnd, TND ,usd' }).supportedCurrencies).toEqual(['TND', 'USD']);
    for (const bad of ['TN', 'TNDD', 'T1D', ',', 'tnd;usd']) expect(refusal({ ...BASE, BILLING_SUPPORTED_CURRENCIES: bad })).toContain('BILLING_SUPPORTED_CURRENCIES');
  });

  it('carries only what each stage needs (currencies since Stage 2, rate limits since Stage 3, the Payment client/dispatch/reconcile settings since Stage 4)', () => {
    expect(Object.keys(loadBillingConfig(BASE)).sort()).toEqual([
      'authServiceUrl', 'authTimeoutMs', 'bodyLimitKb', 'corsOrigins', 'databaseUrl', 'dispatch', 'docs', 'isProduction', 'logLevel',
      'nodeEnv', 'paymentServiceToken', 'paymentServiceUrl', 'paymentTimeoutMs', 'port', 'rabbitmqUrl', 'rateLimits', 'reconcile',
      'serviceName', 'serviceTokens', 'supportedCurrencies', 'trustProxy',
    ]);
  });

  it('has safe default Payment client/dispatch/reconcile settings, tunable per deployment (technical values, no business meaning)', () => {
    const cfg = loadBillingConfig(BASE);
    expect(cfg.paymentServiceUrl).toBe('http://localhost:3002');
    expect(cfg.paymentServiceToken).toBe('a'.repeat(32));
    expect(cfg.paymentTimeoutMs).toBe(5000);
    expect(cfg.dispatch).toEqual({ intervalMs: 2000, batchSize: 50, staleSendingMs: 60_000 });
    expect(cfg.reconcile).toEqual({ intervalMs: 30_000, staleRequestedMs: 300_000 });
  });

  it('refuses a PAYMENT_SERVICE_TOKEN shorter than 32 characters, never echoing it', () => {
    const message = refusal({ ...BASE, PAYMENT_SERVICE_TOKEN: 'too-short' });
    expect(message).toContain('PAYMENT_SERVICE_TOKEN');
    expect(message).not.toContain('too-short');
  });

  it('has safe default rate limits, tunable per deployment (technical values, no business meaning)', () => {
    expect(loadBillingConfig(BASE).rateLimits).toEqual({ invoiceCreatePerMinute: 300, paymentRequestCreatePerMinute: 30 });
    expect(loadBillingConfig({ ...BASE, BILLING_RATE_LIMIT_INVOICE_CREATE_PER_MINUTE: '5', BILLING_RATE_LIMIT_PAYMENT_REQUEST_CREATE_PER_MINUTE: '7' }).rateLimits).toEqual({
      invoiceCreatePerMinute: 5,
      paymentRequestCreatePerMinute: 7,
    });
  });

  it.each(['DATABASE_URL', 'AUTH_SERVICE_URL', 'PAYMENT_SERVICE_URL', 'PAYMENT_SERVICE_TOKEN'])('refuses a missing %s', (name) => {
    const env: NodeJS.ProcessEnv = { ...BASE };
    delete env[name];
    expect(refusal(env)).toContain(name);
  });

  it.each([
    ['a non-URL DATABASE_URL', { DATABASE_URL: 'not a url' }, 'DATABASE_URL'],
    ['a DATABASE_URL that is not postgres', { DATABASE_URL: 'mysql://u:p@h/db' }, 'DATABASE_URL'],
    ['an AUTH_SERVICE_URL that is not http(s)', { AUTH_SERVICE_URL: 'ftp://auth' }, 'AUTH_SERVICE_URL'],
    ['a PAYMENT_SERVICE_URL that is not http(s)', { PAYMENT_SERVICE_URL: 'ftp://payment' }, 'PAYMENT_SERVICE_URL'],
    ['a PAYMENT_TIMEOUT_MS below the minimum', { PAYMENT_TIMEOUT_MS: '10' }, 'PAYMENT_TIMEOUT_MS'],
    ['a PORT out of range', { PORT: '70000' }, 'PORT'],
    ['an unknown NODE_ENV', { NODE_ENV: 'staging' }, 'NODE_ENV'],
    ['an unknown LOG_LEVEL', { LOG_LEVEL: 'verbose' }, 'LOG_LEVEL'],
    ['an AUTH_TIMEOUT_MS below the minimum', { AUTH_TIMEOUT_MS: '5' }, 'AUTH_TIMEOUT_MS'],
    ['a RABBITMQ_URL that is not amqp', { RABBITMQ_URL: 'http://broker' }, 'RABBITMQ_URL'],
    ['a wildcard CORS origin', { CORS_ORIGINS: '*' }, 'CORS_ORIGINS'],
    ['a malformed service token entry', { SERVICE_TOKENS: 'billing-caller-without-digest' }, 'SERVICE_TOKENS'],
    ['a SWAGGER_PASSWORD that is too short', { SWAGGER_PASSWORD: 'short' }, 'SWAGGER_PASSWORD'],
  ])('refuses %s', (_label, extra, name) => {
    expect(refusal({ ...BASE, ...extra })).toContain(name);
  });

  it('never echoes a value in an error message', () => {
    const secretUrl = 'mysql://admin:hunter2-very-secret@db.internal/x';
    const message = refusal({ ...BASE, DATABASE_URL: secretUrl });
    expect(message).not.toContain('hunter2');
    expect(message).not.toContain('admin');
    expect(refusal({ ...BASE, SWAGGER_PASSWORD: 'tiny-pw' })).not.toContain('tiny-pw');
  });

  it('parses service tokens through the kit (digest only, never a raw token)', () => {
    const { digest } = generateServiceToken();
    expect(loadBillingConfig({ ...BASE, SERVICE_TOKENS: `test-caller:${digest}` }).serviceTokens).toEqual([{ caller: 'test-caller', digest }]);
  });

  it('reads a secret from a mounted file (NAME_FILE) rather than the process environment', () => {
    const cfg = loadBillingConfig({ ...BASE, SWAGGER_PASSWORD_FILE: new URL('../../package.json', import.meta.url).pathname });
    expect(cfg.docs.password).toContain('billing-service'); // the file's content, trimmed
  });

  describe('production', () => {
    it('loads with the runtime role and a broker', () => {
      const cfg = loadBillingConfig(PROD);
      expect(cfg.isProduction).toBe(true);
      expect(cfg.rabbitmqUrl).toBe(PROD.RABBITMQ_URL);
    });

    it('defaults to production when NODE_ENV is unset (the safe behaviour is the default)', () => {
      const env: NodeJS.ProcessEnv = { ...PROD };
      delete env.NODE_ENV;
      expect(loadBillingConfig(env).isProduction).toBe(true);
    });

    it('refuses to run without a broker: the in-memory bus is for development and tests only', () => {
      const env: NodeJS.ProcessEnv = { ...PROD };
      delete env.RABBITMQ_URL;
      expect(refusal(env)).toContain('RABBITMQ_URL');
    });

    it.each(['postgres', 'root', 'billing_migrator', 'other_migrator'])('refuses the database user %s (a superuser or schema owner must never run the service)', (user) => {
      const message = refusal({ ...PROD, DATABASE_URL: `postgres://${user}:pw@db:5432/billing` });
      expect(message).toContain('DATABASE_URL');
      expect(message).not.toContain(user);
    });

    it('accepts the runtime role', () => {
      expect(loadBillingConfig({ ...PROD, DATABASE_URL: 'postgres://billing_app:pw@db:5432/billing' }).databaseUrl).toContain('billing_app');
    });

    it('does not apply the database-role rule outside production (local development uses whatever the developer has)', () => {
      expect(loadBillingConfig({ ...BASE, DATABASE_URL: 'postgres://postgres:pw@localhost:5433/billing' }).isProduction).toBe(false);
    });
  });
});

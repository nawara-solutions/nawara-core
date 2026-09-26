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

  it('R1: SUBSCRIPTION_GRACE_DAYS has NO code default either — undefined means this deployment offers no grace at all', () => {
    expect(loadBillingConfig(BASE).subscriptionGraceDays).toBeUndefined();
    expect(loadBillingConfig({ ...BASE, SUBSCRIPTION_GRACE_DAYS: '7' }).subscriptionGraceDays).toBe(7);
    expect(loadBillingConfig({ ...BASE, SUBSCRIPTION_GRACE_DAYS: '1' }).subscriptionGraceDays).toBe(1);
    expect(loadBillingConfig({ ...BASE, SUBSCRIPTION_GRACE_DAYS: '365' }).subscriptionGraceDays).toBe(365);
    for (const bad of ['0', '366', '-1', '3.5', 'seven', '']) {
      const cfg = { ...BASE, SUBSCRIPTION_GRACE_DAYS: bad };
      if (bad === '') expect(loadBillingConfig(cfg).subscriptionGraceDays).toBeUndefined(); // empty means unset, like every other optional value
      else expect(refusal(cfg)).toContain('SUBSCRIPTION_GRACE_DAYS');
    }
  });

  it('carries only what each stage needs (currencies since Stage 2, rate limits since Stage 3, the Payment client/dispatch/reconcile settings since Stage 4, caller admission since Stage 21.C.2)', () => {
    expect(Object.keys(loadBillingConfig(BASE)).sort()).toEqual([
      'authServiceUrl', 'authTimeoutMs', 'bodyLimitKb', 'corsOrigins', 'databaseUrl', 'db', 'dispatch', 'docs', 'httpDrainTimeoutMs', 'isProduction', 'logLevel',
      'nodeEnv', 'organizationReference', 'paymentEventRetry', 'paymentServiceToken', 'paymentServiceUrl', 'paymentTimeoutMs', 'port', 'rabbitmqConfirmTimeoutMs', 'rabbitmqHeartbeatS', 'rabbitmqUrl', 'rateLimits', 'reconcile',
      'serviceName', 'servicePolicy', 'serviceTokens', 'subscriptionGraceDays', 'supportedCurrencies', 'trustProxy',
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

  it('has the M-07 Payment event retry policy defaults (3 retries, 5 s) and accepts overrides', () => {
    expect(loadBillingConfig(BASE).paymentEventRetry).toEqual({ maxRetries: 3, delayMs: 5000 });
    expect(loadBillingConfig({ ...BASE, BILLING_PAYMENT_EVENT_RETRY_MAX: '2', BILLING_PAYMENT_EVENT_RETRY_DELAY_MS: '100' }).paymentEventRetry).toEqual({ maxRetries: 2, delayMs: 100 });
    expect(loadBillingConfig({ ...BASE, BILLING_PAYMENT_EVENT_RETRY_MAX: '0' }).paymentEventRetry.maxRetries).toBe(0); // 0 is valid: dead-letter on the first failure
    expect(loadBillingConfig({ ...BASE, BILLING_PAYMENT_EVENT_RETRY_MAX: '10', BILLING_PAYMENT_EVENT_RETRY_DELAY_MS: '300000' }).paymentEventRetry).toEqual({ maxRetries: 10, delayMs: 300_000 });
  });

  it.each([
    ['BILLING_PAYMENT_EVENT_RETRY_MAX', '-1'],
    ['BILLING_PAYMENT_EVENT_RETRY_MAX', '11'],
    ['BILLING_PAYMENT_EVENT_RETRY_MAX', '1.5'],
    ['BILLING_PAYMENT_EVENT_RETRY_MAX', 'many'],
    ['BILLING_PAYMENT_EVENT_RETRY_DELAY_MS', '99'],
    ['BILLING_PAYMENT_EVENT_RETRY_DELAY_MS', '0'],
    ['BILLING_PAYMENT_EVENT_RETRY_DELAY_MS', '300001'],
    ['BILLING_PAYMENT_EVENT_RETRY_DELAY_MS', 'NaN'],
  ])('refuses %s=%s, naming the variable', (name, value) => {
    expect(refusal({ ...BASE, [name]: value })).toContain(name);
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
    // Stage 15.8: a stale window shorter than two Payment timeouts would let another instance re-claim a request still being sent
    ['a stale-sending window shorter than twice the Payment timeout', { BILLING_DISPATCH_STALE_SENDING_MS: '9999', PAYMENT_TIMEOUT_MS: '5000' }, 'BILLING_DISPATCH_STALE_SENDING_MS'],
    ['a Payment timeout longer than half the default stale-sending window', { PAYMENT_TIMEOUT_MS: '30001' }, 'PAYMENT_TIMEOUT_MS'],
  ])('refuses %s', (_label, extra, name) => {
    expect(refusal({ ...BASE, ...extra })).toContain(name);
  });

  it('accepts a stale-sending window of exactly twice the Payment timeout (Stage 15.8 relationship)', () => {
    const cfg = loadBillingConfig({ ...BASE, BILLING_DISPATCH_STALE_SENDING_MS: '10000', PAYMENT_TIMEOUT_MS: '5000' });
    expect(cfg.dispatch.staleSendingMs).toBe(10_000);
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
    const policy = JSON.stringify({ callers: { 'test-caller': { operations: ['invoice.read'], allowedPlatforms: [] } } });
    expect(loadBillingConfig({ ...BASE, SERVICE_TOKENS: `test-caller:${digest}`, BILLING_SERVICE_POLICY: policy }).serviceTokens).toEqual([{ caller: 'test-caller', digest }]);
  });

  describe('BILLING_SERVICE_POLICY (Stage 21.C.2, ADR-0052; ADR-0042 A.3, Q5: no service caller is admitted in Core V1)', () => {
    it('the approved V1 configuration: no registered caller and no policy, an explicit empty admission (every service call refused)', () => {
      const cfg = loadBillingConfig(BASE);
      expect(cfg.serviceTokens).toEqual([]);
      expect(cfg.servicePolicy.size).toBe(0);
      expect(loadBillingConfig({ ...BASE, BILLING_SERVICE_POLICY: '{"callers":{}}' }).servicePolicy.size).toBe(0);
    });

    it('a registered token without a policy entry refuses to start; so does a policy entry without a token', () => {
      const { digest } = generateServiceToken();
      expect(() => loadBillingConfig({ ...BASE, SERVICE_TOKENS: `test-caller:${digest}` })).toThrow(/BILLING_SERVICE_POLICY is required/);
      expect(() => loadBillingConfig({ ...BASE, BILLING_SERVICE_POLICY: JSON.stringify({ callers: { 'product-backend': { operations: ['entitlement.read'], allowedPlatforms: [] } } }) })).toThrow(/no registered service token/);
    });

    it('operations come from Billing\'s closed vocabulary: no wildcard, no empty list, no duplicate', () => {
      const { digest } = generateServiceToken();
      const env = { ...BASE, SERVICE_TOKENS: `test-caller:${digest}` };
      const policy = (entry: unknown) => JSON.stringify({ callers: { 'test-caller': entry } });
      expect(() => loadBillingConfig({ ...env, BILLING_SERVICE_POLICY: policy({ operations: ['*'], allowedPlatforms: [] }) })).toThrow(/value other than/);
      expect(() => loadBillingConfig({ ...env, BILLING_SERVICE_POLICY: policy({ operations: [], allowedPlatforms: [] }) })).toThrow(/non-empty/);
      expect(() => loadBillingConfig({ ...env, BILLING_SERVICE_POLICY: policy({ operations: ['entitlement.read', 'entitlement.read'], allowedPlatforms: [] }) })).toThrow(/twice/);
    });
  });

  describe('Organization reference (Stage 21.C.2, ADR-0052 decision 3)', () => {
    const PROD = { ...BASE, NODE_ENV: 'production', RABBITMQ_URL: 'amqp://broker:5672', DATABASE_URL: 'postgres://billing_app:pw@db:5432/billing' };
    const fixture = JSON.stringify([{ organizationId: 'bbbbbbbb-0000-4000-8000-000000000001', platformId: 'aaaaaaaa-0000-4000-8000-000000000001', companyId: 'cccccccc-0000-4000-8000-000000000001' }]);
    const loadsOrRefuses = (env: NodeJS.ProcessEnv): string => {
      try {
        loadBillingConfig(env);
        return 'loaded';
      } catch (e) {
        return (e as Error).message;
      }
    };

    it('the fixture is impossible to enable in production', () => {
      expect(loadsOrRefuses({ ...PROD, ORGANIZATION_REFERENCE_FIXTURE: fixture })).toMatch(/refused in production/);
    });

    it('with no caller admitted (V1), production needs no Organization reference: nothing could ever name an Organization', () => {
      const r = loadsOrRefuses(PROD);
      expect(r).not.toMatch(/ORGANIZATION_SERVICE_URL/);
    });

    it('once a caller is admitted, production requires Billing\'s own Organization reference credential', () => {
      const { digest } = generateServiceToken();
      const admitted = { ...PROD, SERVICE_TOKENS: `test-caller:${digest}`, BILLING_SERVICE_POLICY: JSON.stringify({ callers: { 'test-caller': { operations: ['entitlement.read'], allowedPlatforms: [] } } }) };
      expect(loadsOrRefuses(admitted)).toMatch(/ORGANIZATION_SERVICE_URL and ORGANIZATION_REFERENCE_TOKEN are required in production/);
    });
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

  // Stage 14.6: bound on a RabbitMQ publisher confirm (a timeout fails the publish; the outbox keeps the event and retries it).
  it('RABBITMQ_CONFIRM_TIMEOUT_MS defaults to 5000 and is bounded (100-60000)', () => {
    expect(loadBillingConfig(BASE).rabbitmqConfirmTimeoutMs).toBe(5000);
    expect(loadBillingConfig({ ...BASE, RABBITMQ_CONFIRM_TIMEOUT_MS: '2000' }).rabbitmqConfirmTimeoutMs).toBe(2000);
    for (const bad of ['0', '99', '60001', 'abc', '1.5']) expect(() => loadBillingConfig({ ...BASE, RABBITMQ_CONFIRM_TIMEOUT_MS: bad })).toThrow(/RABBITMQ_CONFIRM_TIMEOUT_MS/);
  });

  // Stage 15.3 (I9): the heartbeat this service requests; 0 (off) is refused, so a silent broker is always detected by Core's own bound.
  it('RABBITMQ_HEARTBEAT_S defaults to 10 and is bounded (5-60); 0 is refused', () => {
    expect(loadBillingConfig(BASE).rabbitmqHeartbeatS).toBe(10);
    expect(loadBillingConfig({ ...BASE, RABBITMQ_HEARTBEAT_S: '5' }).rabbitmqHeartbeatS).toBe(5);
    expect(loadBillingConfig({ ...BASE, RABBITMQ_HEARTBEAT_S: '60' }).rabbitmqHeartbeatS).toBe(60);
    for (const bad of ['0', '4', '61', '-1', 'abc', '2.5']) expect(() => loadBillingConfig({ ...BASE, RABBITMQ_HEARTBEAT_S: bad })).toThrow(/RABBITMQ_HEARTBEAT_S must be an integer between 5 and 60/);
  });
});

import { describe, expect, it } from 'vitest';
import { loadPaymentConfig } from './payment-config.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://payment_app:pw@localhost:5433/payment',
  AUTH_SERVICE_URL: 'http://localhost:3001',
};

describe('loadPaymentConfig', () => {
  it('loads with sane defaults from the minimal required env', () => {
    const cfg = loadPaymentConfig(BASE_ENV);
    expect(cfg.serviceName).toBe('payment-service');
    expect(cfg.supportedCurrencies).toEqual(['TND']);
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.idempotencyTtlHours).toBe(24);
    expect(cfg.testProviderEnabled).toBe(false);
    expect(cfg.rabbitmqUrl).toBeUndefined();
    expect(cfg.serviceTokens).toEqual([]);
  });

  it('parses and upper-cases a configured currency list', () => {
    const cfg = loadPaymentConfig({ ...BASE_ENV, PAYMENT_SUPPORTED_CURRENCIES: 'tnd, usd ,EUR' });
    expect(cfg.supportedCurrencies).toEqual(['TND', 'USD', 'EUR']);
  });

  it('refuses the test provider switch in production', () => {
    expect(() => loadPaymentConfig({ ...BASE_ENV, NODE_ENV: 'production', PAYMENT_TEST_PROVIDER: 'true' })).toThrow(
      /PAYMENT_TEST_PROVIDER must not be enabled/,
    );
  });

  it('allows the test provider switch outside production', () => {
    const cfg = loadPaymentConfig({ ...BASE_ENV, PAYMENT_TEST_PROVIDER: 'true' });
    expect(cfg.testProviderEnabled).toBe(true);
  });

  it('requires AUTH_SERVICE_URL and DATABASE_URL', () => {
    expect(() => loadPaymentConfig({ NODE_ENV: 'test', DATABASE_URL: BASE_ENV.DATABASE_URL })).toThrow(/AUTH_SERVICE_URL/);
    expect(() => loadPaymentConfig({ NODE_ENV: 'test', AUTH_SERVICE_URL: BASE_ENV.AUTH_SERVICE_URL })).toThrow(/DATABASE_URL/);
  });

  it('parses SERVICE_TOKENS via the kit helper', () => {
    const digest = 'a'.repeat(64);
    const cfg = loadPaymentConfig({ ...BASE_ENV, SERVICE_TOKENS: `billing-service:${digest}` });
    expect(cfg.serviceTokens).toEqual([{ caller: 'billing-service', digest }]);
  });

  it('reads the baseline rate limits, with defaults, and refuses a nonsensical value', () => {
    const base = { ...BASE_ENV };
    expect(loadPaymentConfig(base).rateLimits).toEqual({ createPerMinute: 300, attemptPerMinute: 30 });
    expect(loadPaymentConfig({ ...base, PAYMENT_RATE_LIMIT_CREATE_PER_MINUTE: '5', PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE: '2' }).rateLimits).toEqual({ createPerMinute: 5, attemptPerMinute: 2 });
    expect(() => loadPaymentConfig({ ...base, PAYMENT_RATE_LIMIT_CREATE_PER_MINUTE: '0' })).toThrow();
    expect(() => loadPaymentConfig({ ...base, PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE: 'lots' })).toThrow();
  });

  describe('event bus configuration (audit finding M-03)', () => {
    const PROD = { ...BASE_ENV, NODE_ENV: 'production', RABBITMQ_URL: 'amqp://user:s3cret-pw@broker.internal:5672' };
    const refusal = (env: NodeJS.ProcessEnv): string => {
      try {
        loadPaymentConfig(env);
      } catch (e) {
        return (e as Error).message;
      }
      return '';
    };

    it('production with RABBITMQ_URL loads and keeps the URL', () => {
      expect(loadPaymentConfig(PROD).rabbitmqUrl).toBe(PROD.RABBITMQ_URL);
    });

    it('production WITHOUT RABBITMQ_URL is refused at configuration time, so the service cannot start on the in-memory bus', () => {
      const env: NodeJS.ProcessEnv = { ...PROD };
      delete env.RABBITMQ_URL;
      expect(refusal(env)).toMatch(/RABBITMQ_URL is required in production/);
      // an unset NODE_ENV defaults to production, so a forgotten variable in a real deployment fails the same way
      const noNodeEnv: NodeJS.ProcessEnv = { ...BASE_ENV };
      delete noNodeEnv.NODE_ENV;
      expect(refusal(noNodeEnv)).toMatch(/RABBITMQ_URL is required in production/);
    });

    it('an empty RABBITMQ_URL in production is not a configured broker', () => {
      expect(refusal({ ...PROD, RABBITMQ_URL: '' })).not.toBe('');
    });

    it('a RABBITMQ_URL that is not amqp(s) is refused, and the error never echoes the URL or its credentials', () => {
      const msg = refusal({ ...PROD, RABBITMQ_URL: 'http://user:s3cret-pw@broker.internal' });
      expect(msg).toContain('RABBITMQ_URL');
      expect(msg).not.toContain('s3cret-pw');
      expect(msg).not.toContain('broker.internal');
    });

    it('outside production an unset RABBITMQ_URL stays allowed (development and tests use the in-memory bus)', () => {
      for (const NODE_ENV of ['development', 'test']) expect(loadPaymentConfig({ ...BASE_ENV, NODE_ENV }).rabbitmqUrl).toBeUndefined();
    });
  });

  // Stage 14.3: parity with billing-service/organization-service configuration rules.
  const PROD_ENV = { ...BASE_ENV, NODE_ENV: 'production', RABBITMQ_URL: 'amqp://broker:5672' };

  it('accepts the least-privilege runtime role in production', () => {
    expect(loadPaymentConfig(PROD_ENV).databaseUrl).toBe(BASE_ENV.DATABASE_URL);
  });

  it.each(['postgres', 'root', 'payment_migrator'])('refuses the %s database user in production, without echoing the URL', (user) => {
    try {
      loadPaymentConfig({ ...PROD_ENV, DATABASE_URL: `postgres://${user}:s3cret-value@localhost:5433/payment` });
      throw new Error('no throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/least-privilege runtime role/);
      expect((err as Error).message).not.toContain('s3cret-value');
    }
  });

  it('allows any database user outside production (tests use an admin connection)', () => {
    expect(loadPaymentConfig({ ...BASE_ENV, DATABASE_URL: 'postgres://postgres:pw@localhost:5433/payment' }).databaseUrl).toContain('postgres:pw');
  });

  it.each(['not a url', 'ftp://auth:3000', 'auth-service:3000'])('refuses a malformed AUTH_SERVICE_URL: %s', (url) => {
    expect(() => loadPaymentConfig({ ...BASE_ENV, AUTH_SERVICE_URL: url })).toThrow(/AUTH_SERVICE_URL/);
  });

  it('SWAGGER_PASSWORD, when set, must be at least 16 characters (docs stay unmounted when unset)', () => {
    expect(() => loadPaymentConfig({ ...BASE_ENV, SWAGGER_PASSWORD: 'short' })).toThrow(/SWAGGER_PASSWORD must be at least 16/);
    expect(loadPaymentConfig({ ...BASE_ENV, SWAGGER_PASSWORD: 'x'.repeat(16) }).docs.password).toBe('x'.repeat(16));
    expect(loadPaymentConfig(BASE_ENV).docs.password).toBeUndefined();
  });

  it.each(['TN', 'TNDX', 'T1D', 'TND,US$'])('refuses a malformed PAYMENT_SUPPORTED_CURRENCIES entry: %s', (list) => {
    expect(() => loadPaymentConfig({ ...BASE_ENV, PAYMENT_SUPPORTED_CURRENCIES: list })).toThrow(/three-letter ISO 4217/);
  });

  it('de-duplicates the currency list and still refuses an empty one', () => {
    expect(loadPaymentConfig({ ...BASE_ENV, PAYMENT_SUPPORTED_CURRENCIES: 'tnd,TND, eur' }).supportedCurrencies).toEqual(['TND', 'EUR']);
    expect(() => loadPaymentConfig({ ...BASE_ENV, PAYMENT_SUPPORTED_CURRENCIES: ' , ' })).toThrow(/PAYMENT_SUPPORTED_CURRENCIES/);
  });

  // Stage 14.6: bound on a RabbitMQ publisher confirm (a timeout fails the publish; the outbox keeps the event and retries it).
  it('RABBITMQ_CONFIRM_TIMEOUT_MS defaults to 5000 and is bounded (100-60000)', () => {
    expect(loadPaymentConfig(BASE_ENV).rabbitmqConfirmTimeoutMs).toBe(5000);
    expect(loadPaymentConfig({ ...BASE_ENV, RABBITMQ_CONFIRM_TIMEOUT_MS: '2000' }).rabbitmqConfirmTimeoutMs).toBe(2000);
    for (const bad of ['0', '99', '60001', 'abc', '1.5']) expect(() => loadPaymentConfig({ ...BASE_ENV, RABBITMQ_CONFIRM_TIMEOUT_MS: bad })).toThrow(/RABBITMQ_CONFIRM_TIMEOUT_MS/);
  });
});

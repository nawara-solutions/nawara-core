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
});

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
});

import { describe, expect, it, vi } from 'vitest';

const captured: Array<Record<string, unknown>> = [];
vi.mock('@nawara/service-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nawara/service-kit')>();
  return {
    ...actual,
    // Records the options AppModule builds the production bus with; the real class is never constructed, so no broker is needed.
    RabbitMqEventBus: class {
      constructor(opts: Record<string, unknown>) {
        captured.push(opts);
      }
    },
  };
});

const { AppModule } = await import('./app.module.js');
const { loadBillingConfig } = await import('./config/billing-config.js');

const env = {
  NODE_ENV: 'test', DATABASE_URL: 'postgres://billing_app:pw@localhost:5433/billing', AUTH_SERVICE_URL: 'http://localhost:3001',
  BILLING_SUPPORTED_CURRENCIES: 'TND', PAYMENT_SERVICE_URL: 'http://localhost:3002', PAYMENT_SERVICE_TOKEN: 'a'.repeat(32),
  RABBITMQ_URL: 'amqp://guest:guest@localhost:5672',
};

describe('AppModule RabbitMQ wiring (M-07)', () => {
  it('builds the production bus with the configured Payment event retry policy', () => {
    captured.length = 0;
    AppModule.register(loadBillingConfig({ ...env, BILLING_PAYMENT_EVENT_RETRY_MAX: '2', BILLING_PAYMENT_EVENT_RETRY_DELAY_MS: '100' }));
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ url: env.RABBITMQ_URL, retry: { maxRetries: 2, delayMs: 100 } });
  });

  it('passes the defaults (3, 5000) when nothing is configured', () => {
    captured.length = 0;
    AppModule.register(loadBillingConfig(env));
    expect(captured[0]).toMatchObject({ retry: { maxRetries: 3, delayMs: 5000 } });
  });
});

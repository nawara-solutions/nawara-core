import { ConfigError, EnvReader, loadBaseConfig, parseServiceTokens, type BaseConfig, type ServiceTokenEntry } from '@nawara/service-kit';

/** payment-service configuration, layered on the kit's shared `BaseConfig` (SDD section 16). */
export interface PaymentConfig extends BaseConfig {
  databaseUrl: string;
  serviceTokens: ServiceTokenEntry[];
  authServiceUrl: string;
  authTimeoutMs: number;
  /** Unset means "use the in-memory event bus" (local/dev/test only); set means RabbitMQ. Required when `NODE_ENV=production`. */
  rabbitmqUrl?: string;
  /** ISO 4217 codes accepted for `payment.currency`. No code default: configuration only (O-10). */
  supportedCurrencies: string[];
  maxAttempts: number;
  idempotencyTtlHours: number;
  /** Refused when true and `isProduction` is also true (SDD section 13.2). */
  testProviderEnabled: boolean;
  returnUrlAllowlist: string[];
  /** Baseline abuse limits (SDD section 16): requests per minute per authenticated caller. Technical values, no business meaning. */
  rateLimits: { createPerMinute: number; attemptPerMinute: number };
  docs: { username: string; password?: string };
}

export function loadPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig {
  const reader = new EnvReader(env);
  const base = loadBaseConfig('payment-service', env, reader);
  const testProviderEnabled = reader.bool('PAYMENT_TEST_PROVIDER', false);
  if (testProviderEnabled && base.isProduction) {
    throw new ConfigError('PAYMENT_TEST_PROVIDER must not be enabled when NODE_ENV=production');
  }
  const rabbitmqUrl = reader.optional('RABBITMQ_URL');
  if (rabbitmqUrl !== undefined) reader.url('RABBITMQ_URL', ['amqp:', 'amqps:']);
  if (base.isProduction && rabbitmqUrl === undefined) {
    // Without a broker the service would fall back to the in-memory bus: the outbox relay would mark every event published while
    // nothing reaches Billing. A development convenience that must not survive into production (same rule as billing-service).
    throw new ConfigError('RABBITMQ_URL is required in production (the in-memory event bus is for development and tests only)');
  }
  const supportedCurrencies = (reader.optional('PAYMENT_SUPPORTED_CURRENCIES', 'TND') ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (supportedCurrencies.length === 0) throw new ConfigError('PAYMENT_SUPPORTED_CURRENCIES must list at least one currency code');
  return {
    ...base,
    databaseUrl: reader.url('DATABASE_URL', ['postgres:', 'postgresql:']),
    serviceTokens: parseServiceTokens(reader.get('SERVICE_TOKENS')),
    authServiceUrl: reader.required('AUTH_SERVICE_URL'),
    authTimeoutMs: reader.int('AUTH_TIMEOUT_MS', { default: 3000, min: 100, max: 30_000 }),
    rabbitmqUrl,
    supportedCurrencies,
    maxAttempts: reader.int('PAYMENT_MAX_ATTEMPTS', { default: 3, min: 1, max: 20 }),
    idempotencyTtlHours: reader.int('IDEMPOTENCY_TTL_HOURS', { default: 24, min: 1, max: 24 * 30 }),
    testProviderEnabled,
    returnUrlAllowlist: (reader.optional('PAYMENT_RETURN_URL_ALLOWLIST', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    rateLimits: {
      createPerMinute: reader.int('PAYMENT_RATE_LIMIT_CREATE_PER_MINUTE', { default: 300, min: 1, max: 100_000 }),
      attemptPerMinute: reader.int('PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE', { default: 30, min: 1, max: 100_000 }),
    },
    docs: { username: reader.optional('SWAGGER_USERNAME', 'docs') as string, password: reader.optional('SWAGGER_PASSWORD') },
  };
}

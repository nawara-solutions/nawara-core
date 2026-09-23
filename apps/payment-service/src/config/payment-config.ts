import { ConfigError, EnvReader, loadBaseConfig, parseServiceTokens, type BaseConfig, type ServiceTokenEntry } from '@nawara/service-kit';

/** payment-service configuration, layered on the kit's shared `BaseConfig` (SDD section 16). */
export interface PaymentConfig extends BaseConfig {
  databaseUrl: string;
  serviceTokens: ServiceTokenEntry[];
  authServiceUrl: string;
  authTimeoutMs: number;
  /** Unset means "use the in-memory event bus" (local/dev/test only); set means RabbitMQ. Required when `NODE_ENV=production`. */
  rabbitmqUrl?: string;
  /** `RABBITMQ_CONFIRM_TIMEOUT_MS` (default 5000, 100-60000): bound on a publisher confirm; past it the publish fails and the outbox retries it. */
  rabbitmqConfirmTimeoutMs: number;
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

/** Database users that must never run the service in production: the default superuser name and any schema-owner role (same rule as billing-service and organization-service). */
const FORBIDDEN_RUNTIME_DB_USER = /^(postgres|root|.+_migrator)$/;

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
  const databaseUrl = reader.url('DATABASE_URL', ['postgres:', 'postgresql:']);
  if (base.isProduction && FORBIDDEN_RUNTIME_DB_USER.test(decodeURIComponent(new URL(databaseUrl).username))) {
    // ADR-0032: the runtime role is DML-only. Refuse a superuser or schema-owner login rather than run with DDL rights.
    throw new ConfigError('DATABASE_URL must use the least-privilege runtime role in production, not a superuser or migrator role');
  }
  const supportedCurrencies = (reader.optional('PAYMENT_SUPPORTED_CURRENCIES', 'TND') ?? '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (supportedCurrencies.length === 0 || supportedCurrencies.some((c) => !/^[A-Z]{3}$/.test(c))) {
    throw new ConfigError('PAYMENT_SUPPORTED_CURRENCIES must list three-letter ISO 4217 codes, comma-separated');
  }
  return {
    ...base,
    databaseUrl,
    serviceTokens: parseServiceTokens(reader.get('SERVICE_TOKENS')),
    authServiceUrl: reader.url('AUTH_SERVICE_URL', ['http:', 'https:']),
    authTimeoutMs: reader.int('AUTH_TIMEOUT_MS', { default: 3000, min: 100, max: 30_000 }),
    rabbitmqUrl,
    rabbitmqConfirmTimeoutMs: reader.int('RABBITMQ_CONFIRM_TIMEOUT_MS', { default: 5_000, min: 100, max: 60_000 }),
    supportedCurrencies: [...new Set(supportedCurrencies)],
    maxAttempts: reader.int('PAYMENT_MAX_ATTEMPTS', { default: 3, min: 1, max: 20 }),
    idempotencyTtlHours: reader.int('IDEMPOTENCY_TTL_HOURS', { default: 24, min: 1, max: 24 * 30 }),
    testProviderEnabled,
    returnUrlAllowlist: (reader.optional('PAYMENT_RETURN_URL_ALLOWLIST', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    rateLimits: {
      createPerMinute: reader.int('PAYMENT_RATE_LIMIT_CREATE_PER_MINUTE', { default: 300, min: 1, max: 100_000 }),
      attemptPerMinute: reader.int('PAYMENT_RATE_LIMIT_ATTEMPT_PER_MINUTE', { default: 30, min: 1, max: 100_000 }),
    },
    docs: {
      username: reader.optional('SWAGGER_USERNAME', 'docs') as string,
      // A password that protects financial API documentation must not be trivial (same rule as billing-service and organization-service).
      password: reader.get('SWAGGER_PASSWORD') === undefined ? undefined : reader.secret('SWAGGER_PASSWORD', 16),
    },
  };
}

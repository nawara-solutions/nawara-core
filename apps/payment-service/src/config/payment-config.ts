import { ConfigError, EnvReader, loadBaseConfig, parseServiceTokens, type BaseConfig, type ServiceTokenEntry } from '@nawara/service-kit';

/** payment-service configuration, layered on the kit's shared `BaseConfig` (SDD section 16). */
export interface PaymentConfig extends BaseConfig {
  databaseUrl: string;
  serviceTokens: ServiceTokenEntry[];
  authServiceUrl: string;
  authTimeoutMs: number;
  /** Unset means "use the in-memory event bus" (local/dev/test); set means RabbitMQ. */
  rabbitmqUrl?: string;
  /** ISO 4217 codes accepted for `payment.currency`. No code default: configuration only (O-10). */
  supportedCurrencies: string[];
  maxAttempts: number;
  idempotencyTtlHours: number;
  /** Refused when true and `isProduction` is also true (SDD section 13.2). */
  testProviderEnabled: boolean;
  returnUrlAllowlist: string[];
  docs: { username: string; password?: string };
}

export function loadPaymentConfig(env: NodeJS.ProcessEnv = process.env): PaymentConfig {
  const reader = new EnvReader(env);
  const base = loadBaseConfig('payment-service', env, reader);
  const testProviderEnabled = reader.bool('PAYMENT_TEST_PROVIDER', false);
  if (testProviderEnabled && base.isProduction) {
    throw new ConfigError('PAYMENT_TEST_PROVIDER must not be enabled when NODE_ENV=production');
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
    rabbitmqUrl: reader.optional('RABBITMQ_URL'),
    supportedCurrencies,
    maxAttempts: reader.int('PAYMENT_MAX_ATTEMPTS', { default: 3, min: 1, max: 20 }),
    idempotencyTtlHours: reader.int('IDEMPOTENCY_TTL_HOURS', { default: 24, min: 1, max: 24 * 30 }),
    testProviderEnabled,
    returnUrlAllowlist: (reader.optional('PAYMENT_RETURN_URL_ALLOWLIST', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    docs: { username: reader.optional('SWAGGER_USERNAME', 'docs') as string, password: reader.optional('SWAGGER_PASSWORD') },
  };
}

import { ConfigError, EnvReader, loadBaseConfig, parseServiceTokens, type BaseConfig, type ServiceTokenEntry } from '@nawara/service-kit';

/**
 * billing-service configuration, layered on the kit's shared `BaseConfig` (SDD section 16 lists the settings a Core
 * service needs). Stage 1 carries ONLY what the foundation itself uses; every later stage adds its own values with the feature
 * that needs them (for example the Payment URL and token arrive with the Payment integration, Stage 4).
 */
export interface BillingConfig extends BaseConfig {
  /** Runtime connection: the least-privilege `billing_app` role (ADR-0032), never the schema owner or a superuser. */
  databaseUrl: string;
  /** Accepted callers, `<caller>:<sha256 digest>` (ADR-0033). May be empty: every service call is then refused. */
  serviceTokens: ServiceTokenEntry[];
  /** Live identity and membership: user bearers are sent to Auth ONLY (ADR-0033). */
  authServiceUrl: string;
  authTimeoutMs: number;
  /** Set means RabbitMQ; unset means the in-memory bus, which is refused in production (below). */
  rabbitmqUrl?: string;
  /** OpenAPI is mounted at /billing/docs behind basic auth, and only when a password is configured. */
  docs: { username: string; password?: string };
}

/** Database users that must never run the service in production: the default superuser name and any schema-owner role. */
const FORBIDDEN_RUNTIME_DB_USER = /^(postgres|root|.+_migrator)$/;

export function loadBillingConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const reader = new EnvReader(env);
  const base = loadBaseConfig('billing-service', env, reader);

  const databaseUrl = reader.url('DATABASE_URL', ['postgres:', 'postgresql:']);
  if (base.isProduction && FORBIDDEN_RUNTIME_DB_USER.test(decodeURIComponent(new URL(databaseUrl).username))) {
    // ADR-0032: the runtime role is DML-only. Refuse a superuser or schema-owner login rather than run with DDL rights.
    throw new ConfigError('DATABASE_URL must use the least-privilege runtime role in production, not a superuser or migrator role');
  }

  const rabbitmqUrl = reader.optional('RABBITMQ_URL');
  if (rabbitmqUrl !== undefined) reader.url('RABBITMQ_URL', ['amqp:', 'amqps:']);
  if (base.isProduction && rabbitmqUrl === undefined) {
    // The in-memory bus loses every event on restart: a development convenience that must not survive into production.
    throw new ConfigError('RABBITMQ_URL is required in production (the in-memory event bus is for development and tests only)');
  }

  return {
    ...base,
    databaseUrl,
    serviceTokens: parseServiceTokens(reader.get('SERVICE_TOKENS')),
    authServiceUrl: reader.url('AUTH_SERVICE_URL', ['http:', 'https:']),
    authTimeoutMs: reader.int('AUTH_TIMEOUT_MS', { default: 3000, min: 100, max: 30_000 }),
    rabbitmqUrl,
    docs: {
      username: reader.optional('SWAGGER_USERNAME', 'docs') as string,
      // A password that protects financial API documentation must not be trivial.
      password: reader.get('SWAGGER_PASSWORD') === undefined ? undefined : reader.secret('SWAGGER_PASSWORD', 16),
    },
  };
}
